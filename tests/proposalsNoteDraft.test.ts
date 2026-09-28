import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { createMcpApiKey } = await import("../server/mcp");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
type McpScope = import("../server/mcpScopes").McpScope;

/**
 * note_draft proposals are pointers to an MCP-written draft (agent inbox D149, T38, T130): approve
 * publishes exactly the recorded revision, reject discards only a matching one, and drafts written
 * by plain update_note_draft or create_note appear in the inbox too.
 */

beforeEach(() => resetMcpLimits());

type Key = { id: string; token: string };
const makeKey = (session: Session, scopes: McpScope[], name = "writer"): Key => {
  const key = createMcpApiKey(session.userId, name, scopes);
  return { id: key.id, token: key.token };
};

let rpcId = 0;
async function callTool(key: Key, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } })
  });
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  const body = JSON.parse(json) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
  return { isError: body.result!.isError === true, value: JSON.parse(body.result!.content![0]!.text) as Record<string, any> };
}

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

async function publishedNote(owner: Session, markdown: string) {
  const created = await api(owner, "POST", "/notes", {});
  const noteId = created.body.note.id as string;
  const saved = await api(owner, "PUT", `/notes/${noteId}/draft`, { markdown, revision: created.body.note.draft_revision });
  expect((await api(owner, "POST", `/notes/${noteId}/publish`, { revision: saved.body.revision })).status).toBe(200);
  return noteId;
}

const pendingFor = (noteId: string) => db.query("SELECT id, status, payload, title FROM proposals WHERE target_id = ? ORDER BY rowid").all(noteId) as Array<{ id: string; status: string; payload: string; title: string }>;

describe("note_draft proposals", () => {
  test("submit writes the draft at once; approve publishes exactly that revision", async () => {
    const owner = await createUser("Draft inbox");
    const noteId = await publishedNote(owner, "# Weekly\n\nOld line");
    const key = makeKey(owner, ["inbox:write", "notes:write-draft"]);
    const result = await callTool(key, "submit_proposals", { proposals: [{ kind: "note_draft", title: "Weekly summary", rationale: "New week", payload: { noteId, markdown: "# Weekly\n\nNew line", baseRevision: null } }] });
    const [item] = result.value.results;
    expect(item.status).toBe("pending");
    const note = await api(owner, "GET", `/notes/${noteId}`);
    expect(note.body.note.markdown).toBe("# Weekly\n\nNew line");
    expect(note.body.note.draftMcpKeyName).toBe("writer");
    expect(pendingFor(noteId).map((row) => [row.status, row.title])).toEqual([["pending", "Weekly summary"]]);

    const detail = await api(owner, "GET", `/inbox/proposals/${item.proposalId}`);
    // No draft before the agent wrote: its changes are measured against the published version.
    expect(detail.body.proposal.preview).toEqual({ markdown: { published: "# Weekly\n\nOld line", base: "# Weekly\n\nOld line", baseKind: "published", draft: "# Weekly\n\nNew line", draftChanged: false } });

    const approved = await api(owner, "POST", `/inbox/proposals/${item.proposalId}/approve`, {});
    expect(approved.body).toMatchObject({ status: "applied", ref: { type: "note", id: noteId, href: `/notes/${noteId}` } });
    const after = await api(owner, "GET", `/notes/${noteId}`);
    expect(after.body.note.current_version).toBe(2);
    expect(after.body.note.hasDraft).toBe(false);
    expect(after.body.note.draftMcpKeyName).toBeNull();
    const publish = db.query("SELECT metadata_json FROM audit_log WHERE note_id = ? AND event_type = 'note.publish' ORDER BY rowid DESC LIMIT 1").get(noteId) as { metadata_json: string };
    expect(JSON.parse(publish.metadata_json)).toMatchObject({ version: 2, via: "proposal", proposalId: item.proposalId });
  });

  test("a human edit after the agent's draft makes approve fail with DRAFT_CHANGED", async () => {
    const owner = await createUser("Draft edited");
    const noteId = await publishedNote(owner, "Base");
    const key = makeKey(owner, ["inbox:write", "notes:write-draft"]);
    const [item] = (await callTool(key, "submit_proposals", { proposals: [{ kind: "note_draft", title: "Agent", payload: { noteId, markdown: "Agent text", baseRevision: null } }] })).value.results;
    const saved = await api(owner, "PUT", `/notes/${noteId}/draft`, { markdown: "Agent text, edited by me", revision: 1 });
    expect(saved.status).toBe(200);
    expect((await api(owner, "GET", `/inbox/proposals/${item.proposalId}`)).body.proposal.preview.markdown.draftChanged).toBe(true);
    const failed = await api(owner, "POST", `/inbox/proposals/${item.proposalId}/approve`, {});
    expect(failed.body).toMatchObject({ status: "failed", code: "DRAFT_CHANGED" });
    expect((await api(owner, "GET", `/notes/${noteId}`)).body.note.current_version).toBe(1);
  });

  test("reject discards only a matching revision; a stale reject keeps the draft", async () => {
    const owner = await createUser("Draft rejected");
    const noteId = await publishedNote(owner, "Base");
    const key = makeKey(owner, ["inbox:write", "notes:write-draft"]);
    const [first] = (await callTool(key, "submit_proposals", { proposals: [{ kind: "note_draft", title: "Agent", payload: { noteId, markdown: "Agent text", baseRevision: null } }] })).value.results;
    const rejected = await api(owner, "POST", `/inbox/proposals/${first.proposalId}/reject`, { reason: "Not now" });
    expect(rejected.body).toEqual({ id: first.proposalId, status: "rejected", draft: "discarded", draftDiscarded: true });
    expect((await api(owner, "GET", `/notes/${noteId}`)).body.note.hasDraft).toBe(false);

    const [second] = (await callTool(key, "submit_proposals", { proposals: [{ kind: "note_draft", title: "Again", payload: { noteId, markdown: "Agent again", baseRevision: null } }] })).value.results;
    const note = await api(owner, "GET", `/notes/${noteId}`);
    await api(owner, "PUT", `/notes/${noteId}/draft`, { markdown: "Mine now", revision: note.body.note.draft_revision });
    const stale = await api(owner, "POST", `/inbox/proposals/${second.proposalId}/reject`, {});
    expect(stale.body).toEqual({ id: second.proposalId, status: "rejected", draft: "kept", draftDiscarded: false });
    const kept = await api(owner, "GET", `/notes/${noteId}`);
    expect(kept.body.note.markdown).toBe("Mine now");
  });

  test("plain update_note_draft and create_note are proposals too; a newer draft supersedes the older one", async () => {
    const owner = await createUser("Draft plain");
    const noteId = await publishedNote(owner, "Base");
    const key = makeKey(owner, ["notes:write-draft"]);
    const first = await callTool(key, "update_note_draft", { noteId, markdown: "One", baseRevision: null });
    expect(first.isError).toBe(false);
    const second = await callTool(key, "update_note_draft", { noteId, markdown: "Two", baseRevision: first.value.revision });
    expect(second.isError).toBe(false);
    expect(pendingFor(noteId).map((row) => row.status)).toEqual(["superseded", "pending"]);
    expect(JSON.parse(pendingFor(noteId)[1]!.payload)).toEqual({ noteId, revision: second.value.revision, created: false });
    const created = await callTool(key, "create_note", { markdown: "# Fresh idea\n\nBody" });
    expect(pendingFor(created.value.noteId).map((row) => [row.status, row.title])).toEqual([["pending", "Fresh idea"]]);
    // A human save leaves the proposal pending (the draft still holds the agent's text until publish or discard).
    await api(owner, "PUT", `/notes/${noteId}/draft`, { markdown: "Two, tidied", revision: second.value.revision });
    expect(pendingFor(noteId).map((row) => row.status)).toEqual(["superseded", "pending"]);

    // Publishing in the editor resolves it: applied when it published that revision, superseded otherwise.
    const note = await api(owner, "GET", `/notes/${noteId}`);
    expect((await api(owner, "POST", `/notes/${noteId}/publish`, { revision: note.body.note.draft_revision })).status).toBe(200);
    expect(db.query("SELECT status, result_code FROM proposals WHERE id = ?").get(pendingFor(noteId)[1]!.id)).toEqual({ status: "superseded", result_code: "DRAFT_CHANGED" });
    const fresh = await api(owner, "GET", `/notes/${created.value.noteId}`);
    expect((await api(owner, "POST", `/notes/${created.value.noteId}/publish`, { revision: fresh.body.note.draft_revision })).status).toBe(200);
    expect(db.query("SELECT status, result_code, reviewed_by FROM proposals WHERE target_id = ?").get(created.value.noteId)).toEqual({ status: "applied", result_code: "PUBLISHED_IN_EDITOR", reviewed_by: owner.userId });

    // Discarding in the editor rejects the pending one.
    const again = await callTool(key, "update_note_draft", { noteId, markdown: "Three", baseRevision: null });
    expect(again.isError).toBe(false);
    expect((await api(owner, "DELETE", `/notes/${noteId}/draft`, {})).status).toBe(200);
    expect(db.query("SELECT status, result_code FROM proposals WHERE target_id = ? ORDER BY rowid DESC LIMIT 1").get(noteId)).toEqual({ status: "rejected", result_code: "DISCARDED_IN_EDITOR" });
  });

  test("note_draft needs notes:write-draft, never publishes on submit, and the Today section replaces Drafts from agents", async () => {
    const owner = await createUser("Draft scopes");
    const noteId = await publishedNote(owner, "Base");
    const readOnly = makeKey(owner, ["inbox:write", "notes:read"]);
    const [refused] = (await callTool(readOnly, "submit_proposals", { proposals: [{ kind: "note_draft", title: "X", payload: { noteId, markdown: "X", baseRevision: null } }] })).value.results;
    expect(refused.code).toBe("SCOPE_REQUIRED");
    expect((await api(owner, "GET", `/notes/${noteId}`)).body.note.hasDraft).toBe(false);
    // A new note in someone else's folder is NOT_FOUND; a stale base revision is DRAFT_CHANGED.
    const writer = makeKey(owner, ["inbox:write", "notes:write-draft", "today:read", "inbox:read"]);
    const [stale] = (await callTool(writer, "submit_proposals", { proposals: [{ kind: "note_draft", title: "X", payload: { noteId, markdown: "X", baseRevision: 7 } }] })).value.results;
    expect(stale.code).toBe("DRAFT_CHANGED");
    const [created] = (await callTool(writer, "submit_proposals", { proposals: [{ kind: "note_draft", title: "Idea", payload: { markdown: "# Idea\n\nText" } }] })).value.results;
    expect(created.status).toBe("pending");

    const today = await api(owner, "GET", "/today?tz=UTC");
    expect(today.body.sections.agentDrafts).toBeUndefined();
    expect(today.body.sections.proposals.items.map((item: { title: string }) => item.title)).toContain("Idea");
    expect(today.body.sections.proposals.href).toBe("/inbox");
    const mcpToday = await callTool(writer, "get_today", { tz: "UTC" });
    expect(mcpToday.value.sections.proposals.items.map((item: { id: string }) => item.id)).toEqual([created.proposalId]);
    expect(mcpToday.value.sections.agentDrafts).toBeUndefined();
  });
});

/**
 * Review H1: rejecting an agent's note draft never loses the person's own draft. The proposal
 * records the draft from before the agent's write; reject restores it, discards only an agent-only
 * draft of a published note, never bins a never-published note, and leaves a draft edited since.
 */
describe("note_draft reject keeps the person's draft (H1)", () => {
  const noteRow = (noteId: string) => db.query("SELECT draft_revision, current_version, deleted_at, draft_mcp_key_id FROM notes WHERE id = ?").get(noteId) as {
    draft_revision: number | null; current_version: number; deleted_at: string | null; draft_mcp_key_id: string | null;
  };
  const effectOf = async (owner: Session, proposalId: string) => (await api(owner, "GET", `/inbox/proposals/${proposalId}`)).body.proposal.rejectEffect;

  test("append over a human draft of a published note: reject restores the human draft as a new revision", async () => {
    const owner = await createUser("H1 append");
    const noteId = await publishedNote(owner, "# Plan\n\nv1");
    const human = await api(owner, "PUT", `/notes/${noteId}/draft`, { markdown: "# Plan\n\nv1\n\nMy unpublished thoughts", revision: null });
    expect(human.body.revision).toBe(1);
    const key = makeKey(owner, ["inbox:write", "notes:write-draft"]);
    const [item] = (await callTool(key, "submit_proposals", { proposals: [{ kind: "note_draft", title: "Add line", payload: { noteId, mode: "append", markdown: "Agent line", baseRevision: 1 } }] })).value.results;
    expect((await api(owner, "GET", `/notes/${noteId}`)).body.note.markdown).toBe("# Plan\n\nv1\n\nMy unpublished thoughts\n\nAgent line");
    expect(await effectOf(owner, item.proposalId)).toBe("restore");
    // Friction 2: the preview measures the agent's changes against the person's draft, so their own
    // unpublished line is not shown as the agent's.
    const preview = (await api(owner, "GET", `/inbox/proposals/${item.proposalId}`)).body.proposal.preview;
    expect(preview.markdown).toMatchObject({ published: "# Plan\n\nv1", base: "# Plan\n\nv1\n\nMy unpublished thoughts", baseKind: "draft" });
    const { lineDiff } = await import("../src/diff/lineDiff");
    const added = lineDiff(preview.markdown.base, preview.markdown.draft).filter((line) => line.kind === "add").map((line) => line.text);
    expect(added).toContain("Agent line");
    expect(added).not.toContain("My unpublished thoughts");

    const rejected = await api(owner, "POST", `/inbox/proposals/${item.proposalId}/reject`, {});
    expect(rejected.body).toEqual({ id: item.proposalId, status: "rejected", draft: "restored", draftDiscarded: false });
    const note = (await api(owner, "GET", `/notes/${noteId}`)).body.note;
    expect(note.markdown).toBe("# Plan\n\nv1\n\nMy unpublished thoughts");
    expect(note.hasDraft).toBe(true);
    expect(note.draftMcpKeyName).toBeNull();
    expect(noteRow(noteId)).toMatchObject({ draft_revision: 3, current_version: 1, deleted_at: null, draft_mcp_key_id: null });
    const restored = db.query("SELECT metadata_json FROM audit_log WHERE note_id = ? AND event_type = 'inbox.draft_restored'").get(noteId) as { metadata_json: string };
    expect(JSON.parse(restored.metadata_json)).toMatchObject({ proposalId: item.proposalId, revision: 3, fromRevision: 1 });
    // The kept text is dropped from the resolved proposal.
    expect(db.query("SELECT base_draft_markdown FROM proposals WHERE id = ?").get(item.proposalId)).toEqual({ base_draft_markdown: null });
  });

  test("a chain of agent writes over a human draft still restores the human draft", async () => {
    const owner = await createUser("H1 chain");
    const noteId = await publishedNote(owner, "Base");
    await api(owner, "PUT", `/notes/${noteId}/draft`, { markdown: "Mine", revision: null });
    const key = makeKey(owner, ["notes:write-draft"]);
    const first = await callTool(key, "update_note_draft", { noteId, markdown: "One", baseRevision: 1, mode: "append" });
    const second = await callTool(key, "update_note_draft", { noteId, markdown: "Two", baseRevision: first.value.revision, mode: "append" });
    expect(second.isError).toBe(false);
    const pending = pendingFor(noteId).find((row) => row.status === "pending")!;
    expect((await api(owner, "POST", `/inbox/proposals/${pending.id}/reject`, {})).body.draft).toBe("restored");
    expect((await api(owner, "GET", `/notes/${noteId}`)).body.note.markdown).toBe("Mine");
  });

  test("never-published notes are never binned: a human draft is restored, an agent-created note stays", async () => {
    const owner = await createUser("H1 unpublished");
    const created = await api(owner, "POST", "/notes", {});
    const noteId = created.body.note.id as string;
    const human = await api(owner, "PUT", `/notes/${noteId}/draft`, { markdown: "# Idea\n\nHuman text", revision: created.body.note.draft_revision });
    const key = makeKey(owner, ["inbox:write", "notes:write-draft"]);
    const [item] = (await callTool(key, "submit_proposals", { proposals: [{ kind: "note_draft", title: "More", payload: { noteId, mode: "append", markdown: "Agent line", baseRevision: human.body.revision } }] })).value.results;
    expect(await effectOf(owner, item.proposalId)).toBe("restore");
    expect((await api(owner, "POST", `/inbox/proposals/${item.proposalId}/reject`, {})).body.draft).toBe("restored");
    expect(noteRow(noteId).deleted_at).toBeNull();
    expect((await api(owner, "GET", `/notes/${noteId}`)).body.note.markdown).toBe("# Idea\n\nHuman text");

    // A note the agent created: reject keeps the note and its draft, and only resolves the proposal.
    const [fresh] = (await callTool(key, "submit_proposals", { proposals: [{ kind: "note_draft", title: "New", payload: { markdown: "# Agent note\n\nBody" } }] })).value.results;
    const agentNoteId = (db.query("SELECT target_id FROM proposals WHERE id = ?").get(fresh.proposalId) as { target_id: string }).target_id;
    expect(await effectOf(owner, fresh.proposalId)).toBe("keep");
    expect((await api(owner, "POST", `/inbox/proposals/${fresh.proposalId}/reject`, {})).body).toEqual({ id: fresh.proposalId, status: "rejected", draft: "kept", draftDiscarded: false });
    expect(noteRow(agentNoteId)).toMatchObject({ deleted_at: null, draft_revision: 1, current_version: 0 });
    expect((await api(owner, "GET", `/notes/${agentNoteId}`)).body.note.markdown).toBe("# Agent note\n\nBody");
  });

  test("a published note with no earlier draft: reject discards only the agent's draft", async () => {
    const owner = await createUser("H1 no draft");
    const noteId = await publishedNote(owner, "Published");
    const key = makeKey(owner, ["inbox:write", "notes:write-draft"]);
    const [item] = (await callTool(key, "submit_proposals", { proposals: [{ kind: "note_draft", title: "Rewrite", payload: { noteId, markdown: "Agent rewrite", baseRevision: null } }] })).value.results;
    expect(await effectOf(owner, item.proposalId)).toBe("discard");
    expect((await api(owner, "POST", `/inbox/proposals/${item.proposalId}/reject`, {})).body.draft).toBe("discarded");
    expect(noteRow(noteId)).toMatchObject({ draft_revision: null, current_version: 1, deleted_at: null });
    expect((await api(owner, "GET", `/notes/${noteId}`)).body.note.markdown).toBe("Published");
  });

  test("a draft edited after the agent wrote stays exactly as it is", async () => {
    const owner = await createUser("H1 edited");
    const noteId = await publishedNote(owner, "Published");
    await api(owner, "PUT", `/notes/${noteId}/draft`, { markdown: "Mine", revision: null });
    const key = makeKey(owner, ["inbox:write", "notes:write-draft"]);
    const [item] = (await callTool(key, "submit_proposals", { proposals: [{ kind: "note_draft", title: "Add", payload: { noteId, mode: "append", markdown: "Agent", baseRevision: 1 } }] })).value.results;
    await api(owner, "PUT", `/notes/${noteId}/draft`, { markdown: "Mine\n\nAgent\n\nMy edit on top", revision: 2 });
    expect(await effectOf(owner, item.proposalId)).toBe("keep");
    expect((await api(owner, "POST", `/inbox/proposals/${item.proposalId}/reject`, {})).body.draft).toBe("kept");
    expect(noteRow(noteId)).toMatchObject({ draft_revision: 3, current_version: 1, deleted_at: null });
    expect((await api(owner, "GET", `/notes/${noteId}`)).body.note.markdown).toBe("Mine\n\nAgent\n\nMy edit on top");
  });

  test("a proposal recorded before migration 027 (unknown base) keeps the draft", async () => {
    const owner = await createUser("H1 legacy");
    const noteId = await publishedNote(owner, "Published");
    const key = makeKey(owner, ["notes:write-draft"]);
    await callTool(key, "update_note_draft", { noteId, markdown: "Agent", baseRevision: null });
    const pending = pendingFor(noteId).find((row) => row.status === "pending")!;
    db.query("UPDATE proposals SET base_state = NULL WHERE id = ?").run(pending.id);
    expect((await api(owner, "POST", `/inbox/proposals/${pending.id}/reject`, {})).body.draft).toBe("kept");
    expect((await api(owner, "GET", `/notes/${noteId}`)).body.note.markdown).toBe("Agent");
  });
});
