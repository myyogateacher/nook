import { describe, expect, test } from "bun:test";
import { createUser, db, type Session } from "./support/harness";
import { addCalendarMember, api, calendarWithEvent, defaultFolderOf, link, listOn, shareCalendar, unlink, upload, uploadAttachment } from "./support/attachments";
import { addRow, call as collections, newCollection, shareCollection } from "./support/collections";

const { linkChanged, recordRemovedLink, removedLink, UNDO_TICKET_TTL_MS } = await import("../server/attachments/undoTickets");
const { relinkAttachment } = await import("../server/attachments/relink");
const { withBoardLock } = await import("../server/tasks/service");

/**
 * The v0.36.0 review of POST /api/attachments/relink. M1: an Undo record is the undo of the latest
 * removal only; any later link change (by anyone, by any path) ends it, and it lasts 60 s. L1:
 * without a record, the client's part is held to the ordinary link rule (a card comment must be the
 * caller's own; a row field must be a file field of a row the caller may edit).
 */

const relink = (session: Session, body: Record<string, unknown>) => api(session, "POST", "/attachments/relink", body);
const tasks = (session: Session, method: string, path: string, body?: unknown) => api(session, method, `/tasks${path}`, body);

async function managedEvent(label: string) {
  const owner = await createUser(`${label} owner`);
  const manager = await createUser(`${label} manager`);
  const { calendarId, eventId } = await calendarWithEvent(owner);
  await shareCalendar(owner, calendarId, "selected", [manager.userId], "viewer");
  addCalendarMember(calendarId, manager.userId, "edit");
  db.query("UPDATE calendar_members SET level = 'manage' WHERE calendar_id = ? AND user_id = ?").run(calendarId, manager.userId);
  return { owner, manager, eventId };
}

async function sharedBoard(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const created = await tasks(owner, "POST", "/boards", { name: `${label} board` });
  const boardId = created.body.board.id as string;
  const columnId = created.body.columns[0].id as string;
  expect((await tasks(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  db.query("UPDATE board_members SET level = 'edit' WHERE board_id = ? AND user_id = ?").run(boardId, member.userId);
  const cardId = (await tasks(owner, "POST", `/boards/${boardId}/cards`, { columnId, title: `${label} card` })).body.card.id as string;
  return { owner, member, boardId, cardId };
}

describe("v036 review proofs", () => {
  test("P1: a stale Undo ticket cannot override the file owner's later, deliberate removal", async () => {
    const { owner, manager, eventId } = await managedEvent("P1");
    const spec = (await upload(owner, "plan.txt", "private plan", { folderId: defaultFolderOf(owner.userId) })).id as string;
    expect((await link(owner, "event", eventId, { documentId: spec, confirmed: true })).status).toBe(201);

    expect((await unlink(manager, "event", eventId, spec)).status).toBe(200);
    expect((await link(owner, "event", eventId, { documentId: spec, confirmed: true })).status).toBe(201);
    expect((await unlink(owner, "event", eventId, spec)).status).toBe(200);

    const replay = await relink(manager, { hostKind: "event", hostId: eventId, documentId: spec });
    expect(replay.status).toBe(404);
    expect((await listOn(owner, "event", eventId)).body.attachments).toHaveLength(0);
  });

  test("P2: without a record, relink does not attach the caller's file under someone else's comment", async () => {
    const { owner, member, cardId } = await sharedBoard("P2");
    expect((await tasks(owner, "POST", `/cards/${cardId}/comments`, { body: "Owner's comment" })).status).toBe(201);
    const commentId = (db.query("SELECT id FROM card_comments WHERE card_id = ?").get(cardId) as { id: string }).id;

    const memberFile = (await upload(member, "m.txt", "member file", { attachTo: "card" })).id as string;
    expect((await tasks(member, "POST", `/cards/${cardId}/attachments`, { documentId: memberFile, commentId })).status).toBe(404);

    const result = await relink(member, { hostKind: "card", hostId: cardId, documentId: memberFile, partId: commentId });
    expect(result.status).not.toBe(200);
    const row = db.query("SELECT comment_id FROM card_attachments WHERE card_id = ? AND document_id = ?").get(cardId, memberFile) as { comment_id: string } | null;
    expect(row?.comment_id ?? null).not.toBe(commentId);
  });
});

describe("M1: records end when the link changes", () => {
  test("the owner linking the file again ends the manager's record at once (event)", async () => {
    const { owner, manager, eventId } = await managedEvent("Relink again");
    const file = (await upload(owner, "agenda.txt", "agenda", { folderId: defaultFolderOf(owner.userId) })).id as string;
    expect((await link(owner, "event", eventId, { documentId: file, confirmed: true })).status).toBe(201);
    expect((await unlink(manager, "event", eventId, file)).status).toBe(200);
    expect(removedLink(manager.userId, "event", eventId, file)).not.toBeNull();

    expect((await link(owner, "event", eventId, { documentId: file, confirmed: true })).status).toBe(201);
    expect(removedLink(manager.userId, "event", eventId, file)).toBeNull();
  });

  test("the owner's own Undo (relink without a record) also ends the manager's record", async () => {
    const { owner, manager, eventId } = await managedEvent("Relink by owner");
    const file = await uploadAttachment(owner, "minutes.txt");
    expect((await link(owner, "event", eventId, { documentId: file })).status).toBe(201);
    expect((await unlink(manager, "event", eventId, file)).status).toBe(200);
    expect((await relink(owner, { hostKind: "event", hostId: eventId, documentId: file })).body.relinked).toBe(true);
    expect(removedLink(manager.userId, "event", eventId, file)).toBeNull();
    // The owner removes it again on purpose: the manager has nothing to put back.
    expect((await unlink(owner, "event", eventId, file)).status).toBe(200);
    expect((await relink(manager, { hostKind: "event", hostId: eventId, documentId: file })).status).toBe(404);
  });

  test("a removal by someone else replaces every older record for that link", () => {
    const hostId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const link = { partId: null, position: 0, linkedBy: a, createdAt: new Date().toISOString(), binned: false };
    recordRemovedLink(a, "event", hostId, documentId, link);
    expect(removedLink(a, "event", hostId, documentId)).not.toBeNull();
    recordRemovedLink(b, "event", hostId, documentId, link);
    expect(removedLink(a, "event", hostId, documentId)).toBeNull();
    expect(removedLink(b, "event", hostId, documentId)).not.toBeNull();
    // Any change (made by anyone, by any path) ends it too; ids are case-insensitive.
    linkChanged("event", hostId.toUpperCase(), documentId.toUpperCase());
    expect(removedLink(b, "event", hostId, documentId)).toBeNull();
  });

  test("a card link made through a comment, and a comment delete, end the records on that card", async () => {
    const { owner, member, cardId } = await sharedBoard("Card change");
    const file = (await upload(member, "c.txt", "card file", { folderId: defaultFolderOf(member.userId) })).id as string;
    expect((await tasks(member, "POST", `/cards/${cardId}/attachments`, { documentId: file, confirmed: true })).status).toBe(201);
    // The board owner removes the member's file: the owner's record.
    expect((await tasks(owner, "DELETE", `/cards/${cardId}/attachments/${file}`)).status).toBe(200);
    expect(removedLink(owner.userId, "card", cardId, file)).not.toBeNull();
    // The member attaches it again with a comment (another create path).
    expect((await tasks(member, "POST", `/cards/${cardId}/comments`, { body: "Back", attachmentIds: [file], confirmed: true })).status).toBe(201);
    expect(removedLink(owner.userId, "card", cardId, file)).toBeNull();
    // The member deletes the comment (its link goes with it), then the owner's old Undo cannot bring it back.
    const commentId = (db.query("SELECT id FROM card_comments WHERE card_id = ?").get(cardId) as { id: string }).id;
    expect((await tasks(member, "DELETE", `/comments/${commentId}`)).status).toBe(200);
    expect((await relink(owner, { hostKind: "card", hostId: cardId, documentId: file })).status).toBe(404);
  });

  test("a row link made again ends the remover's record", async () => {
    const owner = await createUser("Row change owner");
    const editor = await createUser("Row change editor");
    const collection = await newCollection(owner, { name: "Docs", fields: [{ name: "Item", type: "text" }, { name: "Doc", type: "file" }] });
    const field = collection.fields[1]!;
    const row = await addRow(owner, collection.id, { [collection.fields[0]!.id]: "One" });
    await shareCollection(owner, collection.id, "selected", [editor.userId], "editor");
    const file = (await upload(editor, "r.txt", "row file", { folderId: defaultFolderOf(editor.userId) })).id as string;
    expect((await collections(editor, "POST", `/rows/${row.id}/attachments`, { documentId: file, fieldId: field.id, confirmed: true })).status).toBe(201);
    expect((await collections(owner, "DELETE", `/rows/${row.id}/attachments/${file}`)).status).toBe(200);
    expect(removedLink(owner.userId, "row", row.id, file)).not.toBeNull();
    expect((await collections(editor, "POST", `/rows/${row.id}/attachments`, { documentId: file, fieldId: field.id, confirmed: true })).status).toBe(201);
    expect(removedLink(owner.userId, "row", row.id, file)).toBeNull();
  });

  test("a record lasts 60 seconds", () => {
    expect(UNDO_TICKET_TTL_MS).toBe(60_000);
    const hostId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const nowMs = Date.now();
    recordRemovedLink(userId, "event", hostId, documentId, { partId: null, position: 0, linkedBy: null, createdAt: new Date(nowMs).toISOString(), binned: false }, nowMs);
    expect(removedLink(userId, "event", hostId, documentId, nowMs + 10_000)).not.toBeNull();
    expect(removedLink(userId, "event", hostId, documentId, nowMs + 59_999)).not.toBeNull();
    expect(removedLink(userId, "event", hostId, documentId, nowMs + 60_000)).toBeNull();
  });

  test("each removal gets a new generation", () => {
    const hostId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const link = { partId: null, position: 0, linkedBy: null, createdAt: new Date().toISOString(), binned: false };
    recordRemovedLink(userId, "event", hostId, documentId, link);
    const first = removedLink(userId, "event", hostId, documentId)!.generation;
    recordRemovedLink(userId, "event", hostId, documentId, link);
    expect(removedLink(userId, "event", hostId, documentId)!.generation).toBeGreaterThan(first);
  });

  test("a link change while the Undo waits for the board's lock is seen: no relink", async () => {
    const { owner, member, boardId, cardId } = await sharedBoard("Card race");
    const file = (await upload(member, "race.txt", "race", { attachTo: "card" })).id as string;
    expect((await tasks(member, "POST", `/cards/${cardId}/attachments`, { documentId: file })).status).toBe(201);
    expect((await tasks(owner, "DELETE", `/cards/${cardId}/attachments/${file}`)).status).toBe(200);
    expect(removedLink(owner.userId, "card", cardId, file)).not.toBeNull();

    let pending!: Promise<unknown>;
    await withBoardLock(boardId, async () => {
      pending = relinkAttachment(owner.userId, { hostKind: "card", hostId: cardId, documentId: file }).then(() => "relinked", (error: { status?: number }) => error.status);
      await Bun.sleep(5);
      // Meanwhile the member links it again and withdraws it (the link's generation moves on).
      linkChanged("card", cardId, file);
    });
    expect(await pending).toBe(404);
    expect(db.query("SELECT 1 FROM card_attachments WHERE card_id = ? AND document_id = ?").get(cardId, file)).toBeNull();
  });
});

describe("L1: without a record, the client's part follows the link rules", () => {
  test("cards: the caller's own comment is fine; someone else's is a 404; no part appends to the card", async () => {
    const { owner, member, cardId } = await sharedBoard("Card part");
    expect((await tasks(member, "POST", `/cards/${cardId}/comments`, { body: "Mine" })).status).toBe(201);
    expect((await tasks(owner, "POST", `/cards/${cardId}/comments`, { body: "Theirs" })).status).toBe(201);
    const commentOf = (authorId: string) => (db.query("SELECT id FROM card_comments WHERE card_id = ? AND author_id = ?").get(cardId, authorId) as { id: string }).id;
    const own = commentOf(member.userId);
    const theirs = commentOf(owner.userId);

    const first = (await upload(member, "a.txt", "a", { attachTo: "card" })).id as string;
    const refused = await relink(member, { hostKind: "card", hostId: cardId, documentId: first, partId: theirs });
    expect(refused.status).toBe(404);
    expect(db.query("SELECT 1 FROM card_attachments WHERE card_id = ? AND document_id = ?").get(cardId, first)).toBeNull();

    expect((await relink(member, { hostKind: "card", hostId: cardId, documentId: first, partId: own })).body.relinked).toBe(true);
    expect((db.query("SELECT comment_id FROM card_attachments WHERE card_id = ? AND document_id = ?").get(cardId, first) as { comment_id: string }).comment_id).toBe(own);

    const second = (await upload(member, "b.txt", "b", { attachTo: "card" })).id as string;
    expect((await relink(member, { hostKind: "card", hostId: cardId, documentId: second })).body.relinked).toBe(true);
    expect((db.query("SELECT comment_id FROM card_attachments WHERE card_id = ? AND document_id = ?").get(cardId, second) as { comment_id: string | null }).comment_id).toBeNull();
  });

  test("cards: with a record, the removed link's own comment comes back even when it is someone else's", async () => {
    const { owner, cardId } = await sharedBoard("Card part record");
    const file = (await upload(owner, "o.txt", "o", { attachTo: "card" })).id as string;
    expect((await tasks(owner, "POST", `/cards/${cardId}/comments`, { body: "With file", attachmentIds: [file] })).status).toBe(201);
    const commentId = (db.query("SELECT id FROM card_comments WHERE card_id = ?").get(cardId) as { id: string }).id;
    expect((await tasks(owner, "DELETE", `/cards/${cardId}/attachments/${file}`)).status).toBe(200);
    expect((await relink(owner, { hostKind: "card", hostId: cardId, documentId: file, partId: crypto.randomUUID() })).body.relinked).toBe(true);
    expect((db.query("SELECT comment_id FROM card_attachments WHERE card_id = ? AND document_id = ?").get(cardId, file) as { comment_id: string }).comment_id).toBe(commentId);
  });

  test("rows: only a file field of a row the caller may edit", async () => {
    const owner = await createUser("Row part owner");
    const editor = await createUser("Row part editor");
    const viewer = await createUser("Row part viewer");
    const collection = await newCollection(owner, { name: "Parts", fields: [{ name: "Item", type: "text" }, { name: "Doc", type: "file" }] });
    const [text, fileField] = [collection.fields[0]!, collection.fields[1]!];
    const row = await addRow(owner, collection.id, { [text.id]: "One" });
    await shareCollection(owner, collection.id, "selected", [editor.userId, viewer.userId], "editor");
    db.query("UPDATE collection_members SET level = 'view' WHERE collection_id = ? AND user_id = ?").run(collection.id, viewer.userId);

    const mine = (await upload(editor, "e.txt", "e", { attachTo: "row" })).id as string;
    const body = (partId: string | undefined) => ({ hostKind: "row", hostId: row.id, documentId: mine, ...(partId === undefined ? {} : { partId }) });
    for (const partId of [text.id, crypto.randomUUID(), undefined]) {
      const refused = await relink(editor, body(partId));
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("FIELD_GONE");
    }
    const viewerFile = (await upload(viewer, "v.txt", "v", { attachTo: "row" })).id as string;
    expect((await relink(viewer, { hostKind: "row", hostId: row.id, documentId: viewerFile, partId: fileField.id })).status).toBe(403);
    expect(db.query("SELECT COUNT(*) AS count FROM collection_row_attachments WHERE row_id = ?").get(row.id)).toEqual({ count: 0 });

    expect((await relink(editor, body(fileField.id))).body.relinked).toBe(true);
    expect((db.query("SELECT field_id FROM collection_row_attachments WHERE row_id = ? AND document_id = ?").get(row.id, mine) as { field_id: string }).field_id).toBe(fileField.id);
  });
});
