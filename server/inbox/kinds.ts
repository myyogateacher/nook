import * as z from "zod/v4";
import { ownedNote, readableNote } from "../access";
import { readableEvent, editableCalendar, readableCalendar } from "../calendar/access";
import { calendarTools } from "../calendar/mcpTools";
import { CalendarError, getEvent } from "../calendar/service";
import { readableCollection, readableRow } from "../collections/access";
import { collectionTools, presentRow } from "../collections/mcpTools";
import { CollectionError, getRow, schemaOf } from "../collections/service";
import { config } from "../config";
import { audit, db, type NoteRow } from "../db";
import { McpToolError, notFound, type McpKeyContext, type McpToolSpec } from "../mcpToolKit";
import type { McpScope } from "../mcpScopes";
import { appendMarkdownBlock } from "./text";
import { createDraftNote, DraftActionError, publishDraft, writeDraftLocked } from "../noteDrafts";
import { checksum, storage, withNoteLock } from "../storage";
import { readableBoard, readableCard } from "../tasks/access";
import { taskTools } from "../tasks/mcpTools";
import { cardDetail, listColumns, TaskError } from "../tasks/service";
import { sprintNames } from "../tasks/sprintData";
import { listBoardTags } from "../tasks/tags";
import { noteRef, type NoteDraftPayload } from "./noteDraftProposals";

/**
 * Proposal kinds (docs/plan/research/2026-09-28-agent-inbox-routines.md §4.2, D148–D151).
 *
 * Each kind mirrors one MCP write tool and reuses it: the tool's own input schema validates the
 * payload at submit, and at approve the tool's handler runs again, as the approver, through the
 * module's service (ACL, role, CAS, caps). So validation happens twice (D148) and there is one
 * code path per change. A kind needs its module's READ scope, never the write scope (D151);
 * note_draft needs notes:write-draft because the draft is written at once (D149).
 *
 * Previews are computed at read time, for the viewer, through the module's own read functions.
 * A target the viewer cannot read gives `{restricted: true}` (T126).
 */

export const PROPOSAL_KINDS = ["note_draft", "card_create", "card_update", "card_comment", "event_create", "event_update", "row_create", "row_update"] as const;
export type ProposalKind = typeof PROPOSAL_KINDS[number];
export type TargetType = "note" | "folder" | "board" | "card" | "calendar" | "event" | "collection" | "row";

export type ProposalRef = { type: "note" | "card" | "event" | "row"; id: string; href: string };
export type PreviewField = { name: string; before: string | null; after: string | null };
export type ProposalPreview =
  | { restricted: true }
  | { fields: PreviewField[] }
  /**
   * `base` is what the agent's changes are measured against (Friction 2): the draft recorded just
   * before the agent wrote (a person's unsaved-to-publish text, migration 027), else the published
   * version. `baseKind` says which. `published` stays for older clients.
   */
  | { markdown: { published: string; base: string; baseKind: "draft" | "published"; draft: string; draftChanged: boolean } };

export type StoredProposal = {
  kind: ProposalKind; payload: Record<string, unknown>; key_id: string | null; key_name: string; target_id: string;
  /** note_draft only (migration 027): the draft just before the agent wrote, while the proposal is pending. */
  base_state?: "none" | "draft" | null; base_draft_markdown?: string | null;
};

type SubmitResult = { targetType: TargetType; targetId: string; payload: Record<string, unknown>; proposalId?: string };

type KindDef = {
  /** The module scope a key needs, besides inbox:write (D151). */
  scope: McpScope;
  label: string;
  /** Validates the payload as the key's owner and checks the target is readable (NOT_FOUND otherwise). */
  submit: (key: McpKeyContext, payload: unknown) => Promise<SubmitResult>;
  /** Applies as `approverId`; throws McpToolError when the module refuses (the proposal then fails). */
  apply: (approverId: string, proposal: StoredProposal) => Promise<ProposalRef>;
  preview: (viewerId: string, proposal: StoredProposal) => Promise<ProposalPreview> | ProposalPreview;
  /** Nook's own name for the target, for the viewer, or null when they cannot read it. */
  targetLabel: (viewerId: string, proposal: StoredProposal) => string | null;
  /** A one-line digest of what changes ("Due, Tags"), computed from the payload alone. */
  digest: (payload: Record<string, unknown>) => string;
  /** The in-app path of the target, built from ids only; only sent when the viewer can read it. */
  targetHref: (proposal: StoredProposal) => string | null;
};

const cardHref = (cardId: unknown) => {
  const row = db.query("SELECT board_id FROM cards WHERE id = ?").get(lower(cardId)) as { board_id: string } | null;
  return row ? `/tasks/${row.board_id}/card/${lower(cardId)}` : null;
};
const rowHref = (rowId: unknown) => {
  const row = db.query("SELECT collection_id FROM collection_rows WHERE id = ?").get(lower(rowId)) as { collection_id: string } | null;
  return row ? `/collections/${row.collection_id}/row/${lower(rowId)}` : null;
};

const tool = (name: string): McpToolSpec => {
  const spec = [...taskTools, ...calendarTools, ...collectionTools].find((item) => item.name === name);
  if (!spec) throw new Error(`MCP tool ${name} is not registered`);
  return spec;
};

function parsed(spec: McpToolSpec, payload: unknown): Record<string, unknown> {
  const result = spec.inputSchema.safeParse(payload ?? {});
  if (!result.success) throw new McpToolError("INVALID", "Invalid payload", { details: result.error.issues.map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`) });
  return result.data as Record<string, unknown>;
}

/** Maps module errors thrown by read checks to NOT_FOUND / INVALID, the way the MCP tools do. */
function readCheck<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof TaskError || error instanceof CalendarError || error instanceof CollectionError) {
      throw new McpToolError(error.status === 404 ? "NOT_FOUND" : "INVALID", error.message);
    }
    throw error;
  }
}

/** The approver runs the tool's handler as themselves; the key id marks "Changed by key" badges. */
function approverKey(approverId: string, proposal: StoredProposal): McpKeyContext {
  if (!proposal.key_id) throw new McpToolError("NOT_FOUND", "The key that suggested this change no longer exists");
  // Rows of revoked keys persist; a revoked key never acts, even through its owner's approve (M1).
  if (db.query("SELECT 1 FROM mcp_api_keys WHERE id = ? AND revoked_at IS NOT NULL").get(proposal.key_id)) throw new McpToolError("NOT_FOUND", "The key that suggested this change was revoked");
  return { keyId: proposal.key_id, userId: approverId, name: proposal.key_name, scopes: [] };
}

const lower = (value: unknown) => typeof value === "string" ? value.toLowerCase() : "";

// --- Formatting ---------------------------------------------------------------

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length ? value.map((item) => text(item) ?? "").join(", ") : null;
  return JSON.stringify(value);
}

/**
 * Assignee names for a preview. Only people who could be assigned on the board resolve (active
 * and able to open it, as `requireAssignableUser` checks): an agent's payload cannot turn a
 * stranger's or a blocked account's id into their name (review L4). Anyone else is "Unknown person".
 */
const userNames = (ids: readonly string[], boardId: string) => {
  if (!ids.length) return [];
  const rows = db.query(`SELECT id, display_name FROM users WHERE id IN (SELECT value FROM json_each(?)) AND disabled_at IS NULL`)
    .all(JSON.stringify(ids.map((id) => id.toLowerCase()))) as Array<{ id: string; display_name: string }>;
  const names = new Map(rows.filter((row) => readableBoard(boardId, row.id)).map((row) => [row.id, row.display_name]));
  return ids.map((id) => names.get(id.toLowerCase()) ?? "Unknown person");
};

const cardTitleFor = (cardId: unknown, viewerId: string) => typeof cardId === "string" ? readableCard(cardId.toLowerCase(), viewerId)?.card.title ?? "A card you cannot open" : null;

const CARD_FIELDS: Array<[string, string]> = [["title", "Title"], ["description", "Description"], ["dueOn", "Due date"], ["dueTime", "Due time"], ["dueTz", "Time zone"],
  ["assigneeIds", "Assignees"], ["tags", "Tags"], ["flags", "Flags"], ["parentId", "Parent"], ["level", "Level"], ["sprintId", "Sprint"]];

function cardValue(field: string, value: unknown, boardId: string, viewerId: string): string | null {
  if (value === null || value === undefined) return null;
  if (field === "assigneeIds") return text(userNames(value as string[], boardId));
  if (field === "parentId") return cardTitleFor(value, viewerId);
  if (field === "sprintId") return sprintNames(boardId).get(lower(value)) ?? "Unknown sprint";
  return text(value);
}

function cardDigest(payload: Record<string, unknown>) {
  return CARD_FIELDS.filter(([field]) => payload[field] !== undefined).map(([, label]) => label).join(", ");
}

// --- Tasks --------------------------------------------------------------------

const createCard = tool("create_card");
const updateCard = tool("update_card");
const commentOnCard = tool("comment_on_card");

function cardRef(result: unknown): ProposalRef {
  const card = (result as { card: { id: string; board_id: string } }).card;
  return { type: "card", id: card.id, href: `/tasks/${card.board_id}/card/${card.id}` };
}

const tasksKinds = {
  card_create: {
    scope: "tasks:read",
    label: "Create card",
    submit: async (key, payload) => {
      const data = parsed(createCard, payload);
      const boardId = lower(data.boardId);
      if (!readableBoard(boardId, key.userId)) throw notFound("Board");
      if (!listColumns(boardId).some((column) => column.id === lower(data.columnId))) throw notFound("Column");
      return { targetType: "board", targetId: boardId, payload: data };
    },
    apply: async (approverId, proposal) => cardRef(await createCard.handler(parsed(createCard, proposal.payload), approverKey(approverId, proposal))),
    preview: (viewerId, proposal) => {
      const boardId = lower(proposal.payload.boardId);
      const board = readableBoard(boardId, viewerId);
      if (!board) return { restricted: true };
      const column = listColumns(boardId).find((item) => item.id === lower(proposal.payload.columnId));
      return {
        fields: [
          { name: "Board", before: null, after: board.name },
          { name: "Column", before: null, after: column?.name ?? "A column that no longer exists" },
          ...CARD_FIELDS.filter(([field]) => proposal.payload[field] !== undefined)
            .map(([field, name]) => ({ name, before: null, after: cardValue(field, proposal.payload[field], boardId, viewerId) }))
        ]
      };
    },
    targetLabel: (viewerId, proposal) => {
      const board = readableBoard(lower(proposal.payload.boardId), viewerId);
      if (!board) return null;
      const column = listColumns(board.id).find((item) => item.id === lower(proposal.payload.columnId));
      return column ? `${board.name} › ${column.name}` : board.name;
    },
    digest: (payload) => `New card${payload.dueOn ? `, due ${String(payload.dueOn)}` : ""}`,
    targetHref: (proposal) => `/tasks/${lower(proposal.payload.boardId)}`
  },
  card_update: {
    scope: "tasks:read",
    label: "Update card",
    submit: async (key, payload) => {
      const data = parsed(updateCard, payload);
      const cardId = lower(data.cardId);
      if (!readableCard(cardId, key.userId)) throw notFound("Card");
      if (!CARD_FIELDS.some(([field]) => data[field] !== undefined)) throw new McpToolError("INVALID", "The proposal changes nothing");
      return { targetType: "card", targetId: cardId, payload: data };
    },
    apply: async (approverId, proposal) => cardRef(await updateCard.handler(parsed(updateCard, proposal.payload), approverKey(approverId, proposal))),
    preview: (viewerId, proposal) => {
      const found = readableCard(lower(proposal.payload.cardId), viewerId);
      const card = found ? cardDetail(found.card.id) : null;
      if (!found || !card) return { restricted: true };
      const tags = new Map(listBoardTags(card.board_id).map((tag) => [tag.id, tag.name]));
      const before: Record<string, unknown> = {
        title: card.title, dueOn: card.due_on, dueTime: card.due_time, dueTz: card.due_tz, assigneeIds: card.assignees.map((assignee) => assignee.id),
        tags: card.tag_ids.map((id) => tags.get(id) ?? id), flags: card.flags, parentId: card.parent_card_id, level: card.level, sprintId: card.sprint_id
      };
      return {
        fields: CARD_FIELDS.filter(([field]) => proposal.payload[field] !== undefined).map(([field, name]) => ({
          name, before: cardValue(field, before[field], card.board_id, viewerId), after: cardValue(field, proposal.payload[field], card.board_id, viewerId)
        }))
      };
    },
    targetLabel: (viewerId, proposal) => readableCard(lower(proposal.payload.cardId), viewerId)?.card.title ?? null,
    digest: cardDigest,
    targetHref: (proposal) => cardHref(proposal.payload.cardId)
  },
  card_comment: {
    scope: "tasks:read",
    label: "Comment on card",
    submit: async (key, payload) => {
      const data = parsed(commentOnCard, payload);
      const cardId = lower(data.cardId);
      if (!readableCard(cardId, key.userId)) throw notFound("Card");
      if (Buffer.byteLength(String(data.body), "utf8") > 8192) throw new McpToolError("TOO_LARGE", "A proposed comment is limited to 8 KiB");
      return { targetType: "card", targetId: cardId, payload: data };
    },
    apply: async (approverId, proposal) => {
      const result = await commentOnCard.handler(parsed(commentOnCard, proposal.payload), approverKey(approverId, proposal)) as { comment: { card_id: string } };
      const boardId = (db.query("SELECT board_id FROM cards WHERE id = ?").get(result.comment.card_id) as { board_id: string }).board_id;
      return { type: "card", id: result.comment.card_id, href: `/tasks/${boardId}/card/${result.comment.card_id}` };
    },
    preview: (viewerId, proposal) => {
      const found = readableCard(lower(proposal.payload.cardId), viewerId);
      if (!found) return { restricted: true };
      return { fields: [{ name: "Card", before: null, after: found.card.title }, { name: "Comment", before: null, after: text(proposal.payload.body) }] };
    },
    targetLabel: (viewerId, proposal) => readableCard(lower(proposal.payload.cardId), viewerId)?.card.title ?? null,
    digest: () => "New comment",
    targetHref: (proposal) => cardHref(proposal.payload.cardId)
  }
} satisfies Record<string, KindDef>;

// --- Calendar -----------------------------------------------------------------

const createEventTool = tool("create_event");
const updateEventTool = tool("update_event");
const EVENT_FIELDS: Array<[string, string]> = [["title", "Title"], ["allDay", "All day"], ["start", "Start"], ["end", "End"], ["durationMinutes", "Duration (minutes)"],
  ["tz", "Time zone"], ["repeat", "Repeats"], ["location", "Location"], ["description", "Description"]];

const eventRef = (result: unknown): ProposalRef => {
  const eventId = (result as { eventId: string }).eventId;
  return { type: "event", id: eventId, href: `/calendar/event/${eventId}` };
};

const calendarKinds = {
  event_create: {
    scope: "calendar:read",
    label: "Create event",
    submit: async (key, payload) => {
      const data = parsed(createEventTool, payload);
      const calendarId = lower(data.calendarId);
      if (!readableCalendar(calendarId, key.userId)) throw notFound("Calendar");
      if (!editableCalendar(calendarId, key.userId)) throw new McpToolError("READ_ONLY", "This calendar is read-only for you");
      return { targetType: "calendar", targetId: calendarId, payload: data };
    },
    apply: async (approverId, proposal) => eventRef(await createEventTool.handler(parsed(createEventTool, proposal.payload), approverKey(approverId, proposal))),
    preview: (viewerId, proposal) => {
      const calendar = readableCalendar(lower(proposal.payload.calendarId), viewerId);
      if (!calendar) return { restricted: true };
      return {
        fields: [{ name: "Calendar", before: null, after: calendar.name },
          ...EVENT_FIELDS.filter(([field]) => proposal.payload[field] !== undefined).map(([field, name]) => ({ name, before: null, after: text(proposal.payload[field]) }))]
      };
    },
    targetLabel: (viewerId, proposal) => readableCalendar(lower(proposal.payload.calendarId), viewerId)?.name ?? null,
    digest: (payload) => `New event, ${String(payload.start ?? "")}`.replace(/, $/, ""),
    targetHref: () => "/calendar"
  },
  event_update: {
    scope: "calendar:read",
    label: "Update event",
    submit: async (key, payload) => {
      const data = parsed(updateEventTool, payload);
      const eventId = lower(data.eventId);
      if (!readableEvent(eventId, key.userId)) throw notFound("Event");
      if (!EVENT_FIELDS.some(([field]) => data[field] !== undefined)) throw new McpToolError("INVALID", "The proposal changes nothing");
      return { targetType: "event", targetId: eventId, payload: data };
    },
    apply: async (approverId, proposal) => eventRef(await updateEventTool.handler(parsed(updateEventTool, proposal.payload), approverKey(approverId, proposal))),
    preview: (viewerId, proposal) => {
      const found = readableEvent(lower(proposal.payload.eventId), viewerId);
      if (!found) return { restricted: true };
      const { event } = readCheck(() => getEvent(viewerId, found.event.id));
      const before: Record<string, unknown> = {
        title: event.title, allDay: event.all_day, start: event.all_day ? event.start_date : event.start_local, end: event.all_day ? event.end_date : null,
        durationMinutes: event.duration_minutes, tz: event.tz, repeat: event.repeat, location: event.location, description: event.description
      };
      return { fields: EVENT_FIELDS.filter(([field]) => proposal.payload[field] !== undefined).map(([field, name]) => ({ name, before: text(before[field]), after: text(proposal.payload[field]) })) };
    },
    targetLabel: (viewerId, proposal) => readableEvent(lower(proposal.payload.eventId), viewerId)?.event.title ?? null,
    digest: (payload) => EVENT_FIELDS.filter(([field]) => payload[field] !== undefined).map(([, label]) => label).join(", "),
    targetHref: (proposal) => `/calendar/event/${lower(proposal.payload.eventId)}`
  }
} satisfies Record<string, KindDef>;

// --- Collections --------------------------------------------------------------

const createRowTool = tool("create_row");
const updateRowTool = tool("update_row");

const rowRef = (result: unknown): ProposalRef => {
  const rowId = (result as { rowId: string }).rowId;
  const row = db.query("SELECT collection_id FROM collection_rows WHERE id = ?").get(rowId) as { collection_id: string };
  return { type: "row", id: rowId, href: `/collections/${row.collection_id}/row/${rowId}` };
};

/** Proposed values keyed by the field's current name where the reference is a field id. */
function namedValues(collectionId: string, viewerId: string, values: Record<string, unknown>) {
  const collection = readableCollection(collectionId, viewerId);
  const fields = collection ? schemaOf(collection).fields : [];
  return Object.entries(values).map(([reference, value]) => {
    const field = fields.find((item) => item.name === reference) ?? fields.find((item) => item.id === reference);
    return { name: field?.name ?? reference, value };
  });
}

const collectionKinds = {
  row_create: {
    scope: "collections:read",
    label: "Create row",
    submit: async (key, payload) => {
      const data = parsed(createRowTool, payload);
      const collectionId = lower(data.collectionId);
      if (!readableCollection(collectionId, key.userId)) throw notFound("Collection");
      return { targetType: "collection", targetId: collectionId, payload: data };
    },
    apply: async (approverId, proposal) => rowRef(await createRowTool.handler(parsed(createRowTool, proposal.payload), approverKey(approverId, proposal))),
    preview: (viewerId, proposal) => {
      const collectionId = lower(proposal.payload.collectionId);
      const collection = readableCollection(collectionId, viewerId);
      if (!collection) return { restricted: true };
      return {
        fields: [{ name: "Collection", before: null, after: collection.name },
          ...namedValues(collectionId, viewerId, proposal.payload.values as Record<string, unknown>).map(({ name, value }) => ({ name, before: null, after: text(value) }))]
      };
    },
    targetLabel: (viewerId, proposal) => readableCollection(lower(proposal.payload.collectionId), viewerId)?.name ?? null,
    digest: (payload) => `New row, ${Object.keys(payload.values as object).length} value${Object.keys(payload.values as object).length === 1 ? "" : "s"}`,
    targetHref: (proposal) => `/collections/${lower(proposal.payload.collectionId)}`
  },
  row_update: {
    scope: "collections:read",
    label: "Update row",
    submit: async (key, payload) => {
      const data = parsed(updateRowTool, payload);
      const rowId = lower(data.rowId);
      if (!readableRow(rowId, key.userId)) throw notFound("Row");
      if (!Object.keys(data.values as object).length) throw new McpToolError("INVALID", "The proposal changes nothing");
      return { targetType: "row", targetId: rowId, payload: data };
    },
    apply: async (approverId, proposal) => rowRef(await updateRowTool.handler(parsed(updateRowTool, proposal.payload), approverKey(approverId, proposal))),
    preview: (viewerId, proposal) => {
      const found = readableRow(lower(proposal.payload.rowId), viewerId);
      if (!found) return { restricted: true };
      const { row } = readCheck(() => getRow(viewerId, found.row.id));
      const current = presentRow(schemaOf(found.collection), row).values as Record<string, unknown>;
      return {
        fields: namedValues(found.collection.id, viewerId, proposal.payload.values as Record<string, unknown>)
          .map(({ name, value }) => ({ name, before: text(current[name]), after: text(value) }))
      };
    },
    targetLabel: (viewerId, proposal) => {
      const found = readableRow(lower(proposal.payload.rowId), viewerId);
      if (!found) return null;
      const { row } = readCheck(() => getRow(viewerId, found.row.id));
      return `${found.collection.name} › ${row.title || "Untitled"}`;
    },
    digest: (payload) => Object.keys(payload.values as object).join(", "),
    targetHref: (proposal) => rowHref(proposal.payload.rowId)
  }
} satisfies Record<string, KindDef>;

// --- Notes (D149) -------------------------------------------------------------

export const noteDraftPayloadSchema = z.object({
  noteId: z.string().uuid().optional().describe("A note the user owns; omit to propose a new note"),
  folderId: z.string().uuid().optional().describe("For a new note: a folder the user owns; defaults to their Default folder"),
  markdown: z.string().describe("The draft Markdown, or the text to append"),
  mode: z.enum(["replace", "append"]).default("replace"),
  baseRevision: z.number().int().nonnegative().nullable().optional().describe("For an existing note: the revision from get_note_draft (null when there was no draft)")
}).strict();

async function readPublished(note: NoteRow) {
  if (note.current_version < 1) return "";
  const metadata = db.query("SELECT checksum FROM note_versions WHERE note_id = ? AND version_number = ?").get(note.id, note.current_version) as { checksum: string } | null;
  const markdown = await storage.readVersion(note.id, note.current_version);
  if (!metadata || checksum(markdown) !== metadata.checksum) throw new McpToolError("INTERNAL", "Note content failed integrity verification");
  return markdown;
}

async function readDraftText(note: NoteRow) {
  const markdown = await storage.readDraft(note.id);
  if (!note.draft_checksum || checksum(markdown) !== note.draft_checksum) throw new McpToolError("INTERNAL", "Draft content failed integrity verification");
  return markdown;
}

function assertMarkdownSize(markdown: string) {
  if (Buffer.byteLength(markdown, "utf8") > config.maxMarkdownBytes) throw new McpToolError("TOO_LARGE", `Notes are limited to ${config.maxMarkdownBytes} bytes of Markdown`);
}

const draftPayload = (value: Record<string, unknown>) => value as unknown as NoteDraftPayload;

const noteKinds = {
  note_draft: {
    scope: "notes:write-draft",
    label: "Note draft",
    submit: async (key, payload) => {
      const result = noteDraftPayloadSchema.safeParse(payload ?? {});
      if (!result.success) throw new McpToolError("INVALID", "Invalid payload", { details: result.error.issues.map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`) });
      const data = result.data;
      assertMarkdownSize(data.markdown);
      if (!data.noteId) {
        if (data.markdown.trim() === "") throw new McpToolError("INVALID", "markdown must not be blank");
        if (data.folderId && !db.query("SELECT 1 FROM folders WHERE id = ? AND owner_id = ?").get(data.folderId.toLowerCase(), key.userId)) throw notFound("Folder");
        const created = await createDraftNote(key.userId, data.folderId?.toLowerCase() ?? null, data.markdown, { keyId: key.keyId });
        return { targetType: "note", targetId: created.id, payload: { noteId: created.id, revision: created.revision, created: true }, proposalId: created.proposalId };
      }
      const noteId = data.noteId.toLowerCase();
      return withNoteLock(noteId, async () => {
        const note = ownedNote(noteId, key.userId);
        if (!note) throw notFound();
        const changed = () => new McpToolError("DRAFT_CHANGED", "The draft changed since baseRevision. Read it again with get_note_draft.", { currentRevision: note.draft_revision });
        if ((data.baseRevision ?? null) !== note.draft_revision) throw changed();
        const base = note.draft_revision !== null ? await readDraftText(note) : await readPublished(note);
        const next = data.mode === "append" ? appendMarkdownBlock(base, data.markdown) : data.markdown;
        assertMarkdownSize(next);
        const saved = await writeDraftLocked(note, key.userId, next, key.keyId);
        if (!saved) throw changed();
        audit(key.userId, noteId, "mcp.note_draft_update", { via: "mcp", keyId: key.keyId, mode: data.mode, revision: saved.revision });
        return { targetType: "note", targetId: noteId, payload: { noteId, revision: saved.revision, created: note.current_version === 0 }, proposalId: saved.proposalId };
      });
    },
    apply: async (approverId, proposal) => {
      const { noteId, revision } = draftPayload(proposal.payload);
      try {
        await publishDraft(approverId, noteId, revision);
      } catch (error) {
        if (error instanceof DraftActionError) {
          const code = error.status === 404 ? "NOT_FOUND" : error.body.code === "DRAFT_CHANGED" || error.body.code === "NO_DRAFT" ? "DRAFT_CHANGED" : "INVALID";
          throw new McpToolError(code, error.message);
        }
        throw error;
      }
      return noteRef(noteId);
    },
    preview: async (viewerId, proposal) => {
      const { noteId, revision } = draftPayload(proposal.payload);
      const note = ownedNote(noteId, viewerId);
      if (!note) return { restricted: true };
      const published = await readPublished(note);
      const recorded = proposal.base_state === "draft" && typeof proposal.base_draft_markdown === "string";
      const base = recorded ? proposal.base_draft_markdown! : published;
      const baseKind = recorded ? "draft" as const : "published" as const;
      if (note.draft_revision === null) return { markdown: { published, base, baseKind, draft: published, draftChanged: true } };
      return { markdown: { published, base, baseKind, draft: await readDraftText(note), draftChanged: note.draft_revision !== revision } };
    },
    targetLabel: (viewerId, proposal) => {
      const note = readableNote(draftPayload(proposal.payload).noteId, viewerId);
      return note && note.owner_id === viewerId && note.deleted_at === null ? note.title || "Untitled" : null;
    },
    digest: (payload) => draftPayload(payload).created ? "New note" : "Draft changes",
    targetHref: (proposal) => `/notes/${lower(draftPayload(proposal.payload).noteId)}`
  }
} satisfies Record<string, KindDef>;

export const PROPOSAL_KIND_DEFS: Record<ProposalKind, KindDef> = { ...noteKinds, ...tasksKinds, ...calendarKinds, ...collectionKinds };

export const isProposalKind = (value: unknown): value is ProposalKind => typeof value === "string" && (PROPOSAL_KINDS as readonly string[]).includes(value);

/** Tool schemas the MCP `submit_proposals` description can point at. */
export const KIND_TOOL: Record<Exclude<ProposalKind, "note_draft">, string> = {
  card_create: "create_card", card_update: "update_card", card_comment: "comment_on_card",
  event_create: "create_event", event_update: "update_event", row_create: "create_row", row_update: "update_row"
};

