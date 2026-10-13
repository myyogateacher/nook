import { describe, expect, test } from "bun:test";
import { createUser, db, type Session } from "./support/harness";
import { api, calendarWithEvent, contentStatus, link, upload, uploadAttachment } from "./support/attachments";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { createWhiteboard } = await import("../server/whiteboards/service");
type Grant = import("../server/keyGrants").Grant;

/**
 * v0.35.0 security review M2 (T354): an API or MCP key never widens a file's reach beyond what its
 * grants cover. A key derives (or makes) a link only to its owner's Attachments-folder file that is
 * not attached anywhere the key cannot reach, unless its files:read covers the file; it never gets a
 * confirm; and it never sees the owner's own file through a host on other terms.
 */

const chip = (id: string, name = "x.txt") => `[📎 ${name}](/files/${id})`;
const all = (module: Grant["module"], permission: Grant["permission"]): Grant => ({ module, permission, resourceKind: null, resourceId: null });
const onDocument = (id: string): Grant => ({ module: "files", permission: "read", resourceKind: "document", resourceId: id });
const makeKey = (session: Session, grants: Grant[]) => createApiKey(session.userId, { name: "Agent", surfaces: "both", grants, expiresInDays: 30 }).id;
const NOTES = [all("notes", "read"), all("notes", "draft"), all("notes", "publish")];
async function tool(keyId: string, name: string, args: Record<string, unknown>) {
  const result = await invokeMcpToolForTests(name, args, keyId);
  return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
}
const linksOf = (kind: string, hostId: string) => (db.query("SELECT document_id FROM attachment_links WHERE host_kind = ? AND host_id = ? ORDER BY position").all(kind, hostId) as Array<{ document_id: string }>).map((row) => row.document_id);

async function sharedNote(owner: Session, reader: Session) {
  const noteId = (await api(owner, "POST", "/notes", {})).body.note.id as string;
  expect((await api(owner, "PUT", `/notes/${noteId}/sharing`, { visibility: "selected", userIds: [reader.userId] })).status).toBe(200);
  return noteId;
}

async function publishAsKey(key: string, noteId: string, markdown: string) {
  const first = (await tool(key, "get_note_draft", { noteId })).value;
  const draft = (await tool(key, "update_note_draft", { noteId, baseRevision: first.revision, markdown })).value;
  await tool(key, "get_note_draft", { noteId });
  return tool(key, "publish_note_draft", { noteId, revision: draft.revision });
}

async function cardOf(owner: Session) {
  const board = await api(owner, "POST", "/tasks/boards", { name: "Private board" });
  return (await api(owner, "POST", `/tasks/boards/${board.body.board.id}/cards`, { columnId: board.body.columns[0].id, title: "Card" })).body.card.id as string;
}
const linkToCard = (cardId: string, documentId: string, userId: string) =>
  db.query("INSERT INTO card_attachments (card_id, document_id, linked_by, created_at) VALUES (?, ?, ?, ?)").run(cardId, documentId, userId, new Date().toISOString());

describe("notes (review M2)", () => {
  test("a notes-only key can neither read nor share the user's private Files item by publishing a note that references it", async () => {
    const owner = await createUser("esc owner");
    const reader = await createUser("esc reader");
    const secret = (await upload(owner, "payroll.txt", "TOP SECRET payroll")).id;
    const noteId = await sharedNote(owner, reader);
    const key = makeKey(owner, NOTES);
    expect((await tool(key, "read_document_text", { documentId: secret })).isError).toBe(true);

    const published = await publishAsKey(key, noteId, `# hi\n\n${chip(secret)}`);
    expect(published.isError).toBe(false);
    expect(published.value.skippedAttachments).toBe(1);
    expect(linksOf("note", noteId)).toEqual([]);
    const text = await tool(key, "read_attachment_text", { hostKind: "note", hostId: noteId, documentId: secret });
    expect(text.isError).toBe(true);
    expect(text.value.code).toBe("NOT_FOUND");
    expect(JSON.stringify(text.value)).not.toContain("TOP SECRET");
    expect(await contentStatus(reader, secret)).toBe(404);
  }, 30_000);

  test("a key links an Attachments upload, but not one attached where it cannot reach, unless files:read covers it", async () => {
    const owner = await createUser("esc attach owner");
    const reader = await createUser("esc attach reader");
    const noteId = await sharedNote(owner, reader);
    const fresh = await uploadAttachment(owner, "fresh.txt", "fresh", "note");
    const onEvent = await uploadAttachment(owner, "event.txt", "event only", "event");
    const { eventId } = await calendarWithEvent(owner, "Private calendar");
    expect((await link(owner, "event", eventId, { documentId: onEvent })).status).toBe(201);

    const notesKey = makeKey(owner, NOTES);
    const published = await publishAsKey(notesKey, noteId, `# hi\n\n${chip(fresh)}\n\n${chip(onEvent)}`);
    expect(published.value.skippedAttachments).toBe(1);
    expect(linksOf("note", noteId)).toEqual([fresh]);
    expect(await contentStatus(reader, onEvent)).toBe(404);
    // A key that may read the file through Files may link it.
    const widerKey = makeKey(owner, [...NOTES, onDocument(onEvent)]);
    const again = await publishAsKey(widerKey, noteId, `# hi!\n\n${chip(fresh)}\n\n${chip(onEvent)}`);
    expect(again.value.skippedAttachments).toBeUndefined();
    expect(linksOf("note", noteId)).toEqual([fresh, onEvent]);
  }, 30_000);

  test("list_attachments, read_attachment_text, and read_note hide the owner's files the key could not have linked", async () => {
    const owner = await createUser("esc list owner");
    const reader = await createUser("esc list reader");
    const other = await createUser("esc list other");
    const noteId = await sharedNote(owner, reader);
    const ownFiles = (await upload(owner, "budget.txt", "own Files item")).id;
    const onEvent = await uploadAttachment(owner, "event.txt", "event only", "event");
    const { eventId } = await calendarWithEvent(owner, "Private calendar 2");
    expect((await link(owner, "event", eventId, { documentId: onEvent })).status).toBe(201);
    const fresh = await uploadAttachment(owner, "fresh.txt", "fresh", "note");
    // The person publishes in Nook and confirms their Files item.
    const note = (await api(owner, "GET", `/notes/${noteId}`)).body.note;
    const saved = await api(owner, "PUT", `/notes/${noteId}/draft`, { revision: note.draft_revision ?? null, markdown: `# m\n\n${chip(ownFiles)}\n\n${chip(onEvent)}\n\n${chip(fresh)}` });
    expect((await api(owner, "POST", `/notes/${noteId}/publish`, { revision: saved.body.revision, confirmAttachments: [ownFiles] })).status).toBe(200);
    expect(linksOf("note", noteId).sort()).toEqual([ownFiles, onEvent, fresh].sort());

    const key = makeKey(owner, [all("notes", "read")]);
    const listed = await tool(key, "list_attachments", { hostKind: "note", hostId: noteId });
    expect(listed.value.attachments.map((item: { id: string }) => item.id)).toEqual([fresh]);
    expect((await tool(key, "read_attachment_text", { hostKind: "note", hostId: noteId, documentId: ownFiles })).value.code).toBe("NOT_FOUND");
    expect((await tool(key, "read_attachment_text", { hostKind: "note", hostId: noteId, documentId: onEvent })).value.code).toBe("NOT_FOUND");
    expect((await tool(key, "read_attachment_text", { hostKind: "note", hostId: noteId, documentId: fresh })).value.text).toBe("fresh");
    expect((await tool(key, "read_note", { noteId })).value.attachments.map((item: { id: string }) => item.id)).toEqual([fresh]);
    // A key with files:read over them sees them.
    const filesKey = makeKey(owner, [all("notes", "read"), all("files", "read")]);
    expect((await tool(filesKey, "list_attachments", { hostKind: "note", hostId: noteId })).value.attachments).toHaveLength(3);
    // Someone else reading through their own key is a reader like any other: they see what the note shares.
    expect((await api(owner, "PUT", `/notes/${noteId}/sharing`, { visibility: "selected", userIds: [reader.userId, other.userId] })).status).toBe(200);
    const readerKey = makeKey(other, [all("notes", "read")]);
    expect((await tool(readerKey, "read_attachment_text", { hostKind: "note", hostId: noteId, documentId: ownFiles })).value.text).toBe("own Files item");
  }, 30_000);
});

describe("whiteboards, calendar, and tasks (review M2)", () => {
  test("create_whiteboard's picture links follow the key's reach", async () => {
    const owner = await createUser("esc board owner");
    const fresh = await uploadAttachment(owner, "fresh.png", "png-ish", "whiteboard");
    const onEvent = await uploadAttachment(owner, "event.png", "png-ish", "event");
    const ownFiles = (await upload(owner, "files.png", "png-ish")).id;
    const { eventId } = await calendarWithEvent(owner, "Board calendar");
    expect((await link(owner, "event", eventId, { documentId: onEvent })).status).toBe(201);
    const keyId = makeKey(owner, [all("whiteboards", "write")]);
    const key: import("../server/mcpToolKit").McpKeyContext = { keyId, userId: owner.userId, name: "Agent", scopes: ["whiteboards:write"], grants: [all("whiteboards", "write")] };
    const file = (id: string) => ({ id, nookDocumentId: id, mimeType: "image/png" });
    const image = (id: string, index: number) => ({ id: `img${index}`, type: "image", x: 0, y: index * 70, width: 64, height: 64, angle: 0, strokeColor: "transparent", backgroundColor: "transparent", fileId: id, status: "pending", scale: [1, 1], version: 1 });
    const scene = { type: "excalidraw", version: 2, source: "test", elements: [fresh, onEvent, ownFiles].map(image), appState: {}, files: { [fresh]: file(fresh), [onEvent]: file(onEvent), [ownFiles]: file(ownFiles) } };
    // The service call the tool makes, with a scene (the tool itself creates empty boards).
    db.query("UPDATE documents SET mime_type = 'image/png', preview_kind = 'image' WHERE id IN (?, ?, ?)").run(fresh, onEvent, ownFiles);
    const { prepareScene } = await import("../server/whiteboards/service");
    const prepared = prepareScene(scene);
    const { whiteboard } = await createWhiteboard(owner.userId, { name: "Board", scene: prepared.scene, key });
    expect(linksOf("whiteboard", whiteboard.id)).toEqual([fresh]);
  }, 30_000);

  test("attach_file_to_event refuses an upload already attached to a card the key cannot reach", async () => {
    const owner = await createUser("esc event owner");
    const { eventId } = await calendarWithEvent(owner, "Agent calendar");
    const cardId = await cardOf(owner);
    const onCard = await uploadAttachment(owner, "card.txt", "card only", "card");
    linkToCard(cardId, onCard, owner.userId);
    const fresh = await uploadAttachment(owner, "fresh.txt", "fresh", "event");
    const key = makeKey(owner, [all("calendar", "write")]);
    expect((await tool(key, "attach_file_to_event", { eventId, documentId: onCard })).value.code).toBe("NOT_FOUND");
    expect((await tool(key, "attach_file_to_event", { eventId, documentId: fresh })).isError).toBe(false);
    // A key that reaches the card (tasks:read) or the file (files:read) may.
    expect((await tool(makeKey(owner, [all("calendar", "write"), all("tasks", "read")]), "attach_file_to_event", { eventId, documentId: onCard })).isError).toBe(false);
  }, 30_000);

  test("link_attachment and comment_on_card refuse an upload attached to an event the key cannot reach", async () => {
    const owner = await createUser("esc task owner");
    const cardId = await cardOf(owner);
    const onEvent = await uploadAttachment(owner, "event.txt", "event only", "event");
    const { eventId } = await calendarWithEvent(owner, "Hidden calendar");
    expect((await link(owner, "event", eventId, { documentId: onEvent })).status).toBe(201);
    const fresh = await uploadAttachment(owner, "fresh.txt", "fresh", "card");
    const key = makeKey(owner, [all("tasks", "write")]);
    expect((await tool(key, "link_attachment", { cardId, documentId: onEvent })).value.code).toBe("NOT_FOUND");
    expect((await tool(key, "comment_on_card", { cardId, body: "see", attachmentIds: [onEvent] })).value.code).toBe("NOT_FOUND");
    expect((await tool(key, "link_attachment", { cardId, documentId: fresh })).isError).toBe(false);
    expect((await tool(makeKey(owner, [all("tasks", "write"), onDocument(onEvent)]), "link_attachment", { cardId, documentId: onEvent })).isError).toBe(false);
  }, 30_000);
});
