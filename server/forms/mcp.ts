import * as z from "zod/v4";
import { db } from "../db";
import { defineTool, McpToolError, notFound, BIN_BUCKETS, BIN_DESCRIPTION, restoreResult, type McpKeyContext, type McpToolSpec } from "../mcpToolKit";
import { restoreItem } from "../bin";
import { keyFilter, keyReach } from "../keyResources";
import { config } from "../config";
import { ownedNote } from "../access";
import { checksum, storage, withNoteLock } from "../storage";
import { writeDraftLocked } from "../noteDrafts";
import { neutralizeWhiteboardEmbeds } from "../../shared/whiteboardEmbed";
import { exportCsv } from "../questions/service";
import { audit } from "../db";
import {
  binForm, createForm, createPoll, createTimePoll, deleteFormResponse, duplicateForm, editableSet, FormError, formDetail, formRow, formSummary, getFormResponse,
  listForms, listResponses, parseFilter, publishForm, respondView, retractVote, saveFormDraft, setFormStatus, submitMemberResponse, updateFormSettings, type FormRow
} from "./service";
import { finalizeTimePoll } from "./finalize";
import { searchForms } from "./registry";
import { embedMarkdown } from "../../shared/embeds";
import { formPath, FORM_AUDIENCES, FORM_DISPLAYS, FORM_KINDS, FORM_STATUSES, FORM_TEMPLATES, LIMIT_PER, RESULTS_VISIBILITIES } from "../../shared/forms";

/**
 * Forms over MCP and REST v1 (docs/plan/WORKSPACE_MODULES.md §D.1 "MCP", §B.15, D814): the same
 * services as the app. Reads need `forms:read`, writes `forms:write`; deleting needs `bin:write` too
 * (D172). Every tool naming a form is checked against a key's chosen forms (missing, unreadable, and
 * outside the key look the same: NOT_FOUND, T205); lists narrow by the key's reach before LIMIT.
 * Votes are one per person (T522) and count against the write limit.
 */

const formRef = z.string().min(1).max(300).describe("The form's id, short id, or in-app URL");
const iso = z.string().max(40).nullable();

function wrap<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof FormError) {
      const code = error.status === 404 ? "NOT_FOUND" : error.status === 409 ? (error.code === "FORM_CHANGED" ? "CARD_CHANGED" : "INVALID") : error.code === "READ_ONLY" ? "READ_ONLY" : error.code === "OWNER_ONLY" ? "OWNER_ONLY" : "INVALID";
      throw new McpToolError(code as never, error.message, { formCode: error.code, ...(error.details ?? {}) });
    }
    throw error;
  }
}
async function wrapAsync<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { return wrap(() => { throw error; }); }
}

const brief = (row: FormRow, userId: string) => {
  const detail = formDetail(row, userId);
  return { ...detail, url: `${config.appOrigin}${detail.href}` };
};

const listShape = z.object({ items: z.array(z.record(z.string(), z.unknown())), nextCursor: z.string().nullable() });

const settingsInput = {
  title: z.string().max(200).optional(), description: z.string().max(20_000).optional(),
  audience: z.enum(FORM_AUDIENCES).optional().describe("Who may answer: workspace (members), selected (audienceUsers/audienceGroups), or public (also anyone with the public link, created in the app)"),
  audienceUsers: z.array(z.string().uuid()).max(200).optional(), audienceGroups: z.array(z.string().uuid()).max(50).optional(),
  anonymous: z.boolean().optional(), limitPer: z.enum(LIMIT_PER).optional(), allowEdit: z.boolean().optional(), resultsVisibility: z.enum(RESULTS_VISIBILITIES).optional(),
  display: z.enum(FORM_DISPLAYS).optional(), opensAt: iso.optional(), closesAt: iso.optional(), maxResponses: z.number().int().min(1).max(100_000).nullable().optional(), verifyEmail: z.boolean().optional()
};

/** Appends an embed line to the owner's note draft (D835 neutral word); never publishes. */
async function embedInNote(noteId: string, line: string, key: McpKeyContext) {
  return withNoteLock(noteId, async () => {
    const note = ownedNote(noteId, key.userId);
    if (!note) throw notFound();
    let text = "";
    if (note.draft_revision !== null) {
      const markdown = await storage.readDraft(note.id);
      if (!note.draft_checksum || checksum(markdown) !== note.draft_checksum) throw new McpToolError("INTERNAL", "Draft content failed integrity verification");
      text = neutralizeWhiteboardEmbeds(markdown);
    } else if (note.current_version > 0) {
      const { readPublishedMarkdown } = await import("../mcpTools");
      text = (await readPublishedMarkdown(note.id, note.current_version)).markdown;
    }
    const next = text.trim() ? `${text.replace(/\s+$/, "")}\n\n${line}` : line;
    if (Buffer.byteLength(next, "utf8") > config.maxMarkdownBytes) throw new McpToolError("TOO_LARGE", "The note is too large to add the poll");
    const saved = await writeDraftLocked(note, key.userId, next, key.keyId);
    if (!saved) throw new McpToolError("DRAFT_CHANGED", "The note changed; try again");
    return { noteId, draftRevision: saved.revision };
  });
}

export const formsMcpTools: McpToolSpec[] = [
  defineTool({
    name: "list_forms", title: "List forms",
    description: "Forms, polls, and time polls the user can read results of or answer. tab: mine, shared (others' forms shared with the user), answer (open forms the user has not answered), or all.",
    scopes: ["forms:read"], access: { mode: "list", lists: ["form"] }, write: false,
    inputSchema: z.object({ tab: z.enum(["mine", "shared", "answer", "all"]).default("all"), kind: z.enum(FORM_KINDS).optional(), status: z.enum(FORM_STATUSES).optional(), q: z.string().max(200).optional(), cursor: z.string().max(300).nullish(), limit: z.number().int().min(1).max(100).default(50) }),
    outputSchema: listShape,
    handler: (args, key) => listForms(key.userId, { ...args, extra: keyFilter(key, "forms:read", { form: "f.id" }) })
  }),
  defineTool({
    name: "search_forms", title: "Search forms",
    description: "Full-text search over form titles, descriptions, and question titles (never answers).",
    scopes: ["forms:read"], access: { mode: "list", lists: ["form"] }, write: false,
    inputSchema: z.object({ q: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).default(20) }),
    handler: ({ q, limit }, key) => {
      const reach = keyReach(key, "forms:read");
      const allowed = reach === "all" ? null : new Set(reach === null ? [] : [...(reach.kinds.get("form") ?? [])]);
      return { items: searchForms(key.userId, q, limit).filter((item) => !allowed || allowed.has(item.id)) };
    }
  }),
  defineTool({
    name: "get_form", title: "Get a form",
    description: "A form's settings and questions: the published version, and the draft when it differs (edit level). Readers of results only.",
    scopes: ["forms:read"], access: { mode: "items", items: [{ arg: "formId", kind: "form" }] }, write: false,
    inputSchema: z.object({ formId: formRef }),
    handler: ({ formId }, key) => wrap(() => {
      const row = formRow(formId);
      if (!row || row.deleted_at !== null) throw notFound("Form");
      const detail = brief(row, key.userId);
      if (detail.level === null) {
        // A respondent sees what answering needs (no results).
        const view = respondView(key.userId, row.id);
        return { form: view.form, questions: view.set, closedReason: view.closedReason, results: view.results };
      }
      const editable = ["owner", "manage", "edit"].includes(detail.level) ? editableSet(row.id) : null;
      const view = respondView(key.userId, row.id);
      return { form: detail, questions: view.set, draft: editable?.hasDraft ? editable.set : null };
    })
  }),
  defineTool({
    name: "create_form", title: "Create a form",
    description: "Creates a form, poll, or time poll from questions (shared/questions QuestionSet: { version: 1, questions, sections, logic, endings }, or just a questions array) or a template. Forms start as a draft unless publish is true; polls and time polls open at once. Use create_poll / create_time_poll for quick ones.",
    scopes: ["forms:write"], access: { mode: "global" }, write: true,
    inputSchema: z.object({ kind: z.enum(FORM_KINDS).default("form"), title: z.string().max(200).optional(), description: z.string().max(20_000).optional(), template: z.enum(FORM_TEMPLATES).optional(), questions: z.unknown().optional(), publish: z.boolean().optional() }),
    handler: (args, key) => wrap(() => ({ form: brief(createForm(key.userId, { ...args, questions: args.questions as never }), key.userId) }))
  }),
  defineTool({
    name: "update_form", title: "Update a form's settings",
    description: "Changes a form's title, description, audience, anonymity, limits, close date, results visibility, or display. Partial; pass expectedRevision to refuse a stale write (CARD_CHANGED). status: open or closed.",
    scopes: ["forms:write"], access: { mode: "items", items: [{ arg: "formId", kind: "form" }], related: ["audienceUsers", "audienceGroups"] }, write: true,
    inputSchema: z.object({ formId: formRef, ...settingsInput, status: z.enum(["open", "closed"]).optional(), expectedRevision: z.number().int().optional() }),
    handler: ({ formId, status, expectedRevision, ...patch }, key) => wrap(() => {
      let row = Object.keys(patch).length ? updateFormSettings(key.userId, formId, patch, expectedRevision) : formRow(formId);
      if (!row) throw notFound("Form");
      if (status) row = setFormStatus(key.userId, row.id, status);
      return { form: brief(row, key.userId) };
    })
  }),
  defineTool({
    name: "update_form_questions", title: "Replace a form's questions",
    description: "Replaces the form's draft questions (validated; ids of published questions must keep their type). publish: true publishes them as a new version at once; old responses keep the version they answered.",
    scopes: ["forms:write"], access: { mode: "items", items: [{ arg: "formId", kind: "form" }] }, write: true,
    inputSchema: z.object({ formId: formRef, questions: z.unknown(), publish: z.boolean().default(false) }),
    handler: ({ formId, questions, publish }, key) => wrap(() => {
      const set = Array.isArray(questions) ? { version: 1, questions, sections: [], logic: [], endings: [] } : questions;
      const saved = saveFormDraft(key.userId, formId, set);
      const row = publish && saved.hasDraft ? publishForm(key.userId, formId) : formRow(formId)!;
      return { form: brief(row, key.userId), hasDraft: !publish && saved.hasDraft };
    })
  }),
  defineTool({
    name: "set_form_status", title: "Open or close a form",
    description: "open publishes nothing new: it opens a published form (reopening a closed one clears a passed close date or a reached limit); closed stops responses.",
    scopes: ["forms:write"], access: { mode: "items", items: [{ arg: "formId", kind: "form" }] }, write: true,
    inputSchema: z.object({ formId: formRef, status: z.enum(["open", "closed"]) }),
    handler: ({ formId, status }, key) => wrap(() => ({ form: brief(setFormStatus(key.userId, formId, status), key.userId) }))
  }),
  defineTool({
    name: "duplicate_form", title: "Duplicate a form",
    description: "Copies a form's questions and settings into a new draft form the user owns (no responses).",
    scopes: ["forms:write"], access: { mode: "items", items: [{ arg: "formId", kind: "form" }] }, write: true,
    inputSchema: z.object({ formId: formRef }),
    handler: ({ formId }, key) => wrap(() => ({ form: brief(duplicateForm(key.userId, formId), key.userId) }))
  }),
  defineTool({
    name: "bin_form", title: "Delete a form",
    description: `Moves a form (with its responses) to the Bin. ${BIN_DESCRIPTION}`,
    scopes: ["forms:write"], alsoRequires: ["bin:write"], buckets: BIN_BUCKETS, access: { mode: "items", items: [{ arg: "formId", kind: "form" }] }, write: true,
    annotations: { destructiveHint: true },
    inputSchema: z.object({ formId: formRef }),
    handler: ({ formId }, key) => wrap(() => { const row = binForm(key.userId, formId); return { binned: true, formId: row.id }; })
  }),
  defineTool({
    name: "restore_form", title: "Restore a form from the Bin",
    description: "Restores a form you own or binned from the Bin, with its responses. Its public link stays off until you turn it on again.",
    scopes: ["forms:write"], alsoRequires: ["bin:write"], access: { mode: "items", items: [{ arg: "formId", kind: "form" }] }, write: true,
    inputSchema: z.object({ formId: z.string().uuid() }).strict(),
    // D1385: the restore every bin_* tool's description promises, through the module's Bin provider.
    handler: async ({ formId }, key) => restoreResult(await restoreItem("form", formId.toLowerCase(), key.userId), "Form")
  }),
  defineTool({
    name: "list_responses", title: "List a form's responses",
    description: "Submitted responses, newest first, with answers by question id and the respondent's name (Anonymous on anonymous forms, dates only). Filter by one chosen option (question + option).",
    scopes: ["forms:read"], access: { mode: "items", items: [{ arg: "formId", kind: "form" }] }, write: false,
    inputSchema: z.object({ formId: formRef, question: z.string().max(16).optional(), option: z.string().max(64).optional(), cursor: z.string().max(300).nullish(), limit: z.number().int().min(1).max(100).default(50) }),
    outputSchema: z.object({ items: z.array(z.record(z.string(), z.unknown())), nextCursor: z.string().nullable(), total: z.number() }),
    handler: ({ formId, question, option, cursor, limit }, key) => wrap(() => listResponses(key.userId, formId, parseFilter({ question, option }), cursor ?? null, limit))
  }),
  defineTool({
    name: "get_response", title: "Get one response",
    description: "One response with the question set version it answered.",
    scopes: ["forms:read"], access: { mode: "items", items: [{ arg: "formId", kind: "form" }, { arg: "responseId", kind: "response" }] }, write: false,
    inputSchema: z.object({ formId: formRef, responseId: z.string().uuid() }),
    handler: ({ formId, responseId }, key) => wrap(() => getFormResponse(key.userId, formId, responseId))
  }),
  defineTool({
    name: "drop_response", title: "Delete a response",
    description: "Deletes one response at once (the person can undo in the app for 10 minutes). Needs edit on the form.",
    scopes: ["forms:write"], access: { mode: "items", items: [{ arg: "formId", kind: "form" }, { arg: "responseId", kind: "response" }] }, write: true,
    annotations: { destructiveHint: true },
    inputSchema: z.object({ formId: formRef, responseId: z.string().uuid() }),
    handler: ({ formId, responseId }, key) => wrap(() => { deleteFormResponse(key.userId, formId, responseId); return { deleted: true }; })
  }),
  defineTool({
    name: "bulk_drop_responses", title: "Delete several responses",
    description: "Deletes up to 100 responses of one form, all or nothing (dryRun: true lists what would go). Needs edit on the form.",
    scopes: ["forms:write"], access: { mode: "items", items: [{ arg: "formId", kind: "form" }], related: ["responseIds"] }, write: true,
    annotations: { destructiveHint: true },
    inputSchema: z.object({ formId: formRef, responseIds: z.array(z.string().uuid()).min(1).max(100), dryRun: z.boolean().default(false) }),
    handler: ({ formId, responseIds, dryRun }, key) => wrap(() => {
      const row = formRow(formId);
      if (!row) throw notFound("Form");
      const ids = [...new Set(responseIds.map((id) => id.toLowerCase()))];
      const found = db.query(`SELECT id FROM responses WHERE host_kind = 'form' AND host_id = ? AND id IN (${ids.map(() => "?").join(",")})`).all(row.id, ...ids) as Array<{ id: string }>;
      if (found.length !== ids.length) throw new McpToolError("NOT_FOUND", "One or more responses are not on this form");
      getFormResponse(key.userId, row.id, ids[0]!);
      if (dryRun) return { dryRun: true, wouldDelete: ids.length };
      db.transaction(() => { for (const id of ids) deleteFormResponse(key.userId, row.id, id); })();
      return { deleted: ids.length };
    })
  }),
  defineTool({
    name: "get_form_summary", title: "Summarize a form's results",
    description: "Per-question aggregates (choice counts, averages and medians, NPS, top words, time-slot votes), the completion funnel, and responses per day. Filter by one chosen option.",
    scopes: ["forms:read"], access: { mode: "items", items: [{ arg: "formId", kind: "form" }] }, write: false,
    inputSchema: z.object({ formId: formRef, question: z.string().max(16).optional(), option: z.string().max(64).optional() }),
    handler: ({ formId, question, option }, key) => wrap(() => formSummary(key.userId, formId, parseFilter({ question, option })))
  }),
  defineTool({
    name: "export_responses", title: "Export responses as CSV",
    description: "Every submitted response as CSV text (one column per question; cells that start with = + - @ are prefixed with ' so spreadsheets never run them). At most 1 MiB; larger exports are refused (download from the app).",
    scopes: ["forms:read"], access: { mode: "items", items: [{ arg: "formId", kind: "form" }] }, write: false,
    inputSchema: z.object({ formId: formRef }),
    handler: ({ formId }, key) => wrap(() => {
      const summary = formSummary(key.userId, formId);
      void summary;
      const row = formRow(formId)!;
      const csv = exportCsv({ kind: "form", id: row.id }, {}, { identity: row.anonymous === 0, dayOnly: row.anonymous === 1 });
      if (Buffer.byteLength(csv, "utf8") > 1_048_576) throw new McpToolError("TOO_LARGE", "The export is larger than 1 MiB; download it from the app");
      audit(key.userId, null, "forms.export", { formId: row.id, bytes: csv.length, keyId: key.keyId });
      return { csv };
    })
  }),
  defineTool({
    name: "submit_response", title: "Answer a form",
    description: "Submits a response as the key's owner (forms they may answer in the app; answers by question id, the shapes of shared/questions AnswerValue). One per person unless the form allows more; a form with editing on replaces the earlier response when responseId is given.",
    scopes: ["forms:write"], access: { mode: "items", items: [{ arg: "formId", kind: "form" }], related: ["responseId"] }, write: true,
    inputSchema: z.object({ formId: formRef, answers: z.record(z.string().max(16), z.unknown()), responseId: z.string().uuid().nullish() }),
    handler: ({ formId, answers, responseId }, key) => wrap(() => {
      const outcome = submitMemberResponse(key.userId, formId, { answers, responseId }, "mcp");
      return { responseId: outcome.response.id, updated: !outcome.created, ending: outcome.ending };
    })
  }),
  defineTool({
    name: "create_poll", title: "Create a poll",
    description: "Creates and opens a poll (one question, 2–20 options). embedIn a note the user owns appends the poll to the note's draft as a live card (never publishes). Returns embedMarkdown to place it elsewhere (a card description).",
    scopes: ["forms:write"], access: { mode: "global", related: ["embedIn"] }, write: true,
    inputSchema: z.object({
      question: z.string().min(1).max(200), options: z.array(z.string().min(1).max(200)).min(2).max(20), multiple: z.boolean().default(false), anonymous: z.boolean().default(false),
      closesAt: iso.optional(), resultsVisibility: z.enum(RESULTS_VISIBILITIES).default("live"), embedIn: z.object({ kind: z.literal("note"), id: z.string().uuid() }).optional()
    }),
    handler: async ({ embedIn, ...input }, key) => wrapAsync(async () => {
      const row = createPoll(key.userId, input);
      const embed = embedMarkdown("poll", formPath(row.title, row.short_id));
      const embedded = embedIn ? await embedInNote(embedIn.id, embed, key) : null;
      return { form: brief(row, key.userId), embedMarkdown: embed, ...(embedded ? { embeddedIn: embedded } : {}) };
    })
  }),
  defineTool({
    name: "vote_poll", title: "Vote on a poll",
    description: "Votes as the key's owner: optionIds are option ids (one for a single-choice poll). A named poll replaces the earlier vote; clear: true removes it.",
    scopes: ["forms:write"], access: { mode: "items", items: [{ arg: "formId", kind: "form" }], related: ["optionIds"] }, write: true,
    inputSchema: z.object({ formId: formRef, optionIds: z.array(z.string().max(16)).max(20).default([]), clear: z.boolean().default(false) }),
    handler: ({ formId, optionIds, clear }, key) => wrap(() => {
      const view = respondView(key.userId, formId);
      if (view.form.kind !== "poll" || !view.set) throw new McpToolError("INVALID", "That is not a poll");
      if (clear) { retractVote(key.userId, formId); return { cleared: true }; }
      const question = view.set.questions.find((item) => item.type === "single_choice" || item.type === "multi_choice")!;
      const answer = question.type === "multi_choice" ? { options: optionIds } : optionIds[0];
      const outcome = submitMemberResponse(key.userId, formId, { answers: { [question.id]: answer } }, "mcp");
      return { voted: true, updated: !outcome.created, results: respondView(key.userId, formId).results };
    })
  }),
  defineTool({
    name: "create_time_poll", title: "Find a time",
    description: "Creates and opens a time poll: proposed slots (UTC ISO start/end, up to 60), participants vote yes / if need be / no. participants (user ids) are the people who may answer; omit for the whole workspace.",
    scopes: ["forms:write"], access: { mode: "global", related: ["participants", "calendarId"] }, write: true,
    inputSchema: z.object({ title: z.string().min(1).max(200), description: z.string().max(20_000).optional(), slots: z.array(z.object({ start: z.string().max(40), end: z.string().max(40) })).min(1).max(60), participants: z.array(z.string().uuid()).max(200).optional(), allowMaybe: z.boolean().default(true), closesAt: iso.optional(), calendarId: z.string().uuid().nullable().optional() }),
    handler: ({ participants, ...input }, key) => wrap(() => ({ form: brief(createTimePoll(key.userId, { ...input, ...(participants?.length ? { audience: "selected" as const, audienceUsers: participants } : {}) }), key.userId) }))
  }),
  defineTool({
    name: "finalize_time_poll", title: "Pick the time of a time poll",
    description: "Picks one proposed slot: creates the event in calendarId (a calendar the user can edit), closes the poll, notifies the participants, and emails outside voters who left an email. tz is the zone the event is written in.",
    scopes: ["forms:write"], access: { mode: "items", items: [{ arg: "formId", kind: "form" }], related: ["slotId", "calendarId", "inviteUserIds"] }, write: true,
    inputSchema: z.object({ formId: formRef, slotId: z.string().max(16), calendarId: z.string().uuid().nullable().optional(), tz: z.string().max(64).optional(), inviteUserIds: z.array(z.string().uuid()).max(100).optional(), emailGuests: z.boolean().default(true) }),
    handler: async ({ formId, ...input }, key) => wrapAsync(async () => {
      const result = await finalizeTimePoll(key.userId, formId, input);
      return { form: brief(result.form, key.userId), eventId: result.eventId, emailed: result.emailed, when: result.when };
    })
  })
];

// create_form is offered as the form_create proposal kind (Wave 3, D1047).
export const FORMS_AGENT_ALLOWED = ["list_forms", "search_forms", "get_form", "list_responses", "get_response", "get_form_summary", "export_responses", "submit_response", "create_poll", "vote_poll", "create_form"] as const;
export const FORMS_AGENT_NEVER = ["update_form", "update_form_questions", "set_form_status", "duplicate_form", "bin_form", "drop_response", "bulk_drop_responses", "create_time_poll", "finalize_time_poll"] as const;
