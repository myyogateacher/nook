import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { registerTestModule, TEST_KIND, unregisterTestModule } from "./support/workspaceTestModule";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { readMcpResource } = await import("../server/mcpTools");
const { mentionMarkdown } = await import("../shared/itemActivity");
const { syncMentions } = await import("../server/links/service");
const { parseWorkRef } = await import("../shared/workRefs");

/**
 * Work links, refs, item activity, comments, mentions, and undo (docs/plan/WORKSPACE_MODULES.md §B.4,
 * §B.5, D804, D805, D813, T501, T512): links need edit on side A and read on side B; a side the viewer
 * cannot read is hidden (kind only, no title or id); activity records both sides; comments notify the
 * people they mention who can read the item; a delete gives an undo ticket only its author can use.
 */

let owner: Session;
let reader: Session;
let outsider: Session;
let widgetId: string;
let privateWidgetId: string;
let noteId: string;

const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, ...(body === undefined && method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }) }, session);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json as Record<string, any> };
};

beforeAll(async () => {
  registerTestModule();
  owner = await createUser("Links owner");
  reader = await createUser("Links reader");
  outsider = await createUser("Links outsider");
  widgetId = (await api(owner, "POST", "/test-widgets", { name: "Shared widget", shared: true })).body.id;
  privateWidgetId = (await api(owner, "POST", "/test-widgets", { name: "Private widget" })).body.id;
  noteId = (await api(owner, "POST", "/notes", {})).body.note.id;
});
afterAll(() => unregisterTestModule());

describe("work links", () => {
  test("parseWorkRef reads keys, friendly and UUID paths, and kind:id; it grants nothing", () => {
    expect(parseWorkRef("MYT-12")).toEqual({ kind: "card", ref: "MYT-12", by: "key" });
    expect(parseWorkRef("/goals/grow-mrr-3f9x2ab01k")).toEqual({ kind: "goal", ref: "3f9x2ab01k", by: "short_id" });
    expect(parseWorkRef("/contacts/companies/acme-3f9x2ab01k")).toEqual({ kind: "company", ref: "3f9x2ab01k", by: "short_id" });
    expect(parseWorkRef("https://nook.example/notes/eng/release-3f9x2ab01k", ["https://nook.example"])).toEqual({ kind: "note", ref: "3f9x2ab01k", by: "short_id" });
    expect(parseWorkRef("https://evil.example/notes/release-3f9x2ab01k", ["https://nook.example"])).toBeNull();
    expect(parseWorkRef("/tasks/MYT/views/v1/card/MYT-3")).toEqual({ kind: "card", ref: "MYT-3", by: "key" });
    expect(parseWorkRef("goal:3f9x2ab01k")).toEqual({ kind: "goal", ref: "3f9x2ab01k", by: "short_id" });
    expect(parseWorkRef("/notes/shared")).toBeNull();
  });

  test("create needs edit on A and read on B; duplicates are 409; the unreadable side is hidden; delete needs edit on a side", async () => {
    // The reader can read the shared widget (comment level) but not edit it, and cannot read the note.
    expect((await api(reader, "POST", "/links", { a: { kind: TEST_KIND, id: widgetId }, b: { kind: "note", id: noteId }, relation: "relates" })).status).toBe(404);
    expect((await api(reader, "POST", "/links", { a: { kind: TEST_KIND, id: widgetId }, b: { kind: TEST_KIND, id: widgetId }, relation: "relates" })).status).toBe(403);
    expect((await api(outsider, "POST", "/links", { a: { kind: TEST_KIND, id: privateWidgetId }, b: { kind: "note", id: noteId }, relation: "relates" })).status).toBe(404);
    const created = await api(owner, "POST", "/links", { a: { kind: TEST_KIND, id: widgetId }, b: { kind: "note", id: noteId }, relation: "contributes" });
    expect(created).toMatchObject({ status: 201, body: { link: { a_kind: TEST_KIND, b_kind: "note", relation: "contributes" } } });
    expect((await api(owner, "POST", "/links", { a: { kind: TEST_KIND, id: widgetId }, b: { kind: "note", id: noteId }, relation: "contributes" })).body.code).toBe("EXISTS");
    // The owner sees the note; the reader sees "an item you can't open" (kind only, T501).
    const mine = await api(owner, "GET", `/links?kind=${TEST_KIND}&id=${widgetId}`);
    expect(mine.body.links).toEqual([expect.objectContaining({ relation: "contributes", direction: "out", source: "work_links", other: expect.objectContaining({ kind: "note", id: noteId, href: expect.stringMatching(/^\/notes\//) }) })]);
    const theirs = await api(reader, "GET", `/links?kind=${TEST_KIND}&id=${widgetId}`);
    expect(theirs.body.links).toEqual([expect.objectContaining({ other: { kind: "note", hidden: true } })]);
    expect(JSON.stringify(theirs.body)).not.toContain(noteId);
    expect((await api(outsider, "GET", `/links?kind=${TEST_KIND}&id=${privateWidgetId}`)).status).toBe(404);
    expect((await api(owner, "GET", `/links?kind=note&id=${noteId}`)).body.links).toEqual([expect.objectContaining({ direction: "in", other: expect.objectContaining({ kind: TEST_KIND, id: widgetId }) })]);
    // Activity on the widget side names the note for its readers (D1390), and by its kind word only for the rest.
    const activity = await api(owner, "GET", `/items/${TEST_KIND}/${widgetId}/activity`);
    expect(activity.body.entries).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "linked", payload: expect.objectContaining({ item: { id: noteId, kind: "note", label: "New note" } }) })]));
    const readerActivity = await api(reader, "GET", `/items/${TEST_KIND}/${widgetId}/activity`);
    expect(readerActivity.body.entries).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "linked", payload: expect.objectContaining({ item: { kind: "note", label: "Note" } }) })]));
    expect(JSON.stringify(readerActivity.body)).not.toContain(noteId);
    expect((await api(reader, "DELETE", `/links/${created.body.link.id}`)).status).toBe(403);
    expect((await api(owner, "DELETE", `/links/${created.body.link.id}`)).status).toBe(204);
    expect((await api(owner, "GET", `/links?kind=${TEST_KIND}&id=${widgetId}`)).body.links).toEqual([]);
  });

  test("refs resolve for readers only; summaries hide what the viewer cannot read; mentions sync from text", async () => {
    expect((await api(owner, "GET", `/refs/resolve?ref=${encodeURIComponent(`note:${noteId}`)}`)).body.summary).toMatchObject({ kind: "note", id: noteId });
    expect((await api(reader, "GET", `/refs/resolve?ref=${encodeURIComponent(`note:${noteId}`)}`)).status).toBe(404);
    const summaries = await api(reader, "POST", "/refs/summaries", { refs: [{ kind: "note", id: noteId }, { kind: TEST_KIND, id: widgetId }] });
    expect(summaries.body.summaries).toEqual([{ kind: "note", hidden: true }, expect.objectContaining({ kind: TEST_KIND, title: "Shared widget" })]);
    db.transaction(() => syncMentions({ kind: TEST_KIND as never, id: widgetId }, `See note:${noteId} and nothing else`, owner.userId))();
    expect(db.query("SELECT b_kind, b_id, relation, created_via FROM work_links WHERE a_id = ?").all(widgetId)).toEqual([{ b_kind: "note", b_id: noteId, relation: "mentions", created_via: "system" }]);
    db.transaction(() => syncMentions({ kind: TEST_KIND as never, id: widgetId }, "No refs now", owner.userId))();
    expect(db.query("SELECT 1 FROM work_links WHERE a_id = ?").all(widgetId)).toEqual([]);
  });

  test("purging a note removes its links (086 triggers)", async () => {
    const note = (await api(owner, "POST", "/notes", {})).body.note.id as string;
    expect((await api(owner, "POST", "/links", { a: { kind: TEST_KIND, id: widgetId }, b: { kind: "note", id: note }, relation: "relates" })).status).toBe(201);
    db.query("DELETE FROM notes WHERE id = ?").run(note);
    expect(db.query("SELECT 1 FROM work_links WHERE b_id = ?").all(note)).toEqual([]);
  });
});

describe("comments, mentions, and undo", () => {
  test("readers list, comment-level writes, mentions notify readers only, and undo is the deleter's alone", async () => {
    const mention = `${mentionMarkdown("Links reader", reader.userId)} and ${mentionMarkdown("Links outsider", outsider.userId)} please look`;
    // The test module maps its kind to no workspace module, so mention notifications are covered with a contact below; here the rules.
    const added = await api(reader, "POST", `/items/${TEST_KIND}/${widgetId}/comments`, { body: "Reader comment" });
    expect(added.status).toBe(201);
    const ownerComment = await api(owner, "POST", `/items/${TEST_KIND}/${widgetId}/comments`, { body: mention });
    const reply = await api(reader, "POST", `/items/${TEST_KIND}/${widgetId}/comments`, { body: "A reply", parentId: ownerComment.body.comment.id });
    expect(reply.body.comment.parentId).toBe(ownerComment.body.comment.id);
    expect((await api(outsider, "GET", `/items/${TEST_KIND}/${privateWidgetId}/comments`)).status).toBe(404);
    expect((await api(outsider, "POST", `/items/${TEST_KIND}/${privateWidgetId}/comments`, { body: "x" })).status).toBe(404);
    const listed = await api(reader, "GET", `/items/${TEST_KIND}/${widgetId}/comments`);
    expect(listed.body.comments.map((comment: { body: string }) => comment.body)).toEqual(["Reader comment", mention, "A reply"]);
    // Only the author edits.
    expect((await api(owner, "PATCH", `/items/${TEST_KIND}/${widgetId}/comments/${added.body.comment.id}`, { body: "Edited by owner" })).status).toBe(403);
    expect((await api(reader, "PATCH", `/items/${TEST_KIND}/${widgetId}/comments/${added.body.comment.id}`, { body: "Edited" })).body.comment.body).toBe("Edited");
    // The owner deletes their comment that has a reply: it stays as "deleted"; the undo ticket is theirs only.
    const deleted = await api(owner, "DELETE", `/items/${TEST_KIND}/${widgetId}/comments/${ownerComment.body.comment.id}`);
    expect(deleted.status).toBe(200);
    expect((await api(reader, "GET", `/items/${TEST_KIND}/${widgetId}/comments`)).body.comments.find((comment: { id: string }) => comment.id === ownerComment.body.comment.id)).toMatchObject({ deleted: true, body: "" });
    expect((await api(reader, "POST", `/undo/${deleted.body.undoTicket}`, {})).status).toBe(404);
    expect((await api(owner, "POST", `/undo/${deleted.body.undoTicket}`, {})).body).toMatchObject({ restored: 1, kind: "item_comment" });
    expect((await api(owner, "POST", `/undo/${deleted.body.undoTicket}`, {})).status).toBe(404);
    expect((await api(reader, "GET", `/items/${TEST_KIND}/${widgetId}/comments`)).body.comments.find((comment: { id: string }) => comment.id === ownerComment.body.comment.id)).toMatchObject({ deleted: false, body: mention });
    // A comment without replies is removed outright; undo inserts it again.
    const lone = await api(reader, "DELETE", `/items/${TEST_KIND}/${widgetId}/comments/${reply.body.comment.id}`);
    expect(db.query("SELECT 1 FROM item_comments WHERE id = ?").get(reply.body.comment.id)).toBeNull();
    expect((await api(reader, "POST", `/undo/${lone.body.undoTicket}`, {})).status).toBe(200);
    expect(db.query("SELECT 1 FROM item_comments WHERE id = ?").get(reply.body.comment.id)).not.toBeNull();
  });
});

describe("cross-module MCP tools (§B.15)", () => {
  test("a forms key reaches the module's items through resolve_ref, list_links, comments, and activity; nothing it cannot read", async () => {
    const forms = createApiKey(owner.userId, { name: "Forms work key", surfaces: "both", grants: [{ module: "forms", permission: "write", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const call = async (name: string, args: unknown, keyId = forms.id) => {
      const result = await invokeMcpToolForTests(name, args, keyId);
      return { isError: result.isError ?? false, value: JSON.parse(result.content[0]!.text) as Record<string, any>, structured: result.structuredContent };
    };
    // A note needs notes:read too: NOT_FOUND, without naming it.
    const note = await call("resolve_ref", { ref: `note:${noteId}` });
    expect(note.value.code).toBe("NOT_FOUND");
    const commented = await call("comment_on_item", { item: { kind: TEST_KIND, id: widgetId }, body: "Via MCP" });
    expect(commented.isError).toBe(true); // the test kind is not in the MCP enum of kinds: refused as invalid
    const both = createApiKey(owner.userId, { name: "Forms and notes", surfaces: "both", grants: [{ module: "forms", permission: "read", resourceKind: null, resourceId: null }, { module: "notes", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const resolved = await call("resolve_ref", { ref: `note:${noteId}` }, both.id);
    expect(resolved).toMatchObject({ isError: false, value: { summary: { kind: "note", id: noteId } } });
    expect(resolved.structured).toMatchObject({ summary: { kind: "note", id: noteId } });
    const datasets = await call("list_datasets", {}, both.id);
    expect(datasets.value.datasets.map((item: { id: string }) => item.id)).toContain("test.widgets");
    const queried = await call("query_dataset", { dataset: "test.widgets", measures: [{ fn: "count" }] }, both.id);
    expect(queried.value.rows[0][0]).toBeGreaterThanOrEqual(2);
    // The tasks datasets need tasks:read on the key.
    expect((await call("query_dataset", { dataset: "tasks.cards", measures: [{ fn: "count" }] }, both.id)).value.code).toBe("NOT_FOUND");
    expect(await readMcpResource("note", noteId, both.id)).toMatchObject({ kind: "note", id: noteId });
    expect(await readMcpResource("note", noteId, forms.id)).toBeNull();
  });
});
