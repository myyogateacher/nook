import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { addCalendarMember, api, calendarWithEvent, contentStatus, defaultFolderOf, documentRow, link, listOn, shareCalendar, unlink, upload, uploadAttachment, userWithRole } from "./support/attachments";
import { addRow, call as collections, newCollection, shareCollection } from "./support/collections";
import { makeKey } from "./support/mcpClient";

const { resetUndoTickets, UNDO_TICKET_TTL_MS, removedLink } = await import("../server/attachments/undoTickets");

/**
 * Undo for removing an attachment (POST /api/attachments/relink): the host's edit rule, the document
 * rule (own file, or a link the caller just removed), the Bin round trip, positions, idempotency, and
 * the rate limit, for events, cards, rows, and chat messages; notes are refused (their Undo is the editor's).
 */


const relink = (session: Session, body: Record<string, unknown>) => api(session, "POST", "/attachments/relink", body);
const deletedAt = (id: string) => documentRow(id)?.deleted_at ?? null;
const tasks = (session: Session, method: string, path: string, body?: unknown) => api(session, method, `/tasks${path}`, body);

async function filesItem(session: Session, name = "spec.txt") {
  const result = await upload(session, name, "The spec", { folderId: defaultFolderOf(session.userId) });
  expect(result.status).toBe(201);
  return result.id;
}

describe("relink: events", () => {
  test("stranger 404, viewer 403, team viewer 403, editor and owner put it back; Bin round trip; same position; idempotent", async () => {
    const owner = await createUser("Relink event owner");
    const editor = await createUser("Relink event editor");
    const viewer = await createUser("Relink event viewer");
    const stranger = await createUser("Relink event stranger");
    const teamViewer = await userWithRole("Relink event team viewer", "viewer");
    const { calendarId, eventId } = await calendarWithEvent(owner);
    await shareCalendar(owner, calendarId, "selected", [editor.userId, viewer.userId, teamViewer.userId], "viewer");
    addCalendarMember(calendarId, editor.userId, "edit");
    addCalendarMember(calendarId, teamViewer.userId, "edit");
    // A manager may remove anyone's file from the calendar's events.
    db.query("UPDATE calendar_members SET level = 'manage' WHERE calendar_id = ? AND user_id = ?").run(calendarId, editor.userId);

    const first = await uploadAttachment(owner, "first.txt");
    const second = await uploadAttachment(owner, "second.txt");
    const third = await uploadAttachment(owner, "third.txt");
    for (const documentId of [first, second, third]) expect((await link(owner, "event", eventId, { documentId })).status).toBe(201);

    // The owner removes the middle one: it goes to their Bin.
    const removed = await unlink(owner, "event", eventId, second);
    expect(removed.body.documentBinned).toBe(true);
    expect(deletedAt(second)).not.toBeNull();

    const body = { hostKind: "event", hostId: eventId, documentId: second };
    expect((await relink(stranger, body)).status).toBe(404);
    expect((await relink(viewer, body)).status).toBe(403);
    // A team viewer is stopped by the role write gate whatever the calendar says.
    expect((await relink(teamViewer, body)).status).toBe(403);
    expect(deletedAt(second)).not.toBeNull();

    // The owner's Undo: out of the Bin and back in the middle.
    const undone = await relink(owner, body);
    expect(undone.status).toBe(200);
    expect(undone.body).toEqual({ relinked: true, restored: true });
    expect(deletedAt(second)).toBeNull();
    const listed = await listOn(owner, "event", eventId);
    expect(listed.body.attachments.map((item: { documentId: string }) => item.documentId)).toEqual([first, second, third]);
    expect(await contentStatus(viewer, second)).toBe(200);

    // Idempotent: again changes nothing.
    expect((await relink(owner, body)).body).toEqual({ relinked: false, restored: false });
    expect((await listOn(owner, "event", eventId)).body.attachments).toHaveLength(3);

    // A manager removes the owner's file (it goes to the owner's Bin): the editor cannot restore it.
    expect((await unlink(editor, "event", eventId, first)).body.documentBinned).toBe(true);
    const blocked = await relink(editor, { hostKind: "event", hostId: eventId, documentId: first });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("IN_OWNERS_BIN");
    expect(deletedAt(first)).not.toBeNull();
    // The owner may (their own file; no record of theirs, so it goes at the end).
    expect((await relink(owner, { hostKind: "event", hostId: eventId, documentId: first })).body).toEqual({ relinked: true, restored: true });
    expect((await listOn(owner, "event", eventId)).body.attachments.map((item: { documentId: string }) => item.documentId)).toEqual([second, third, first]);
  });

  test("someone else's file comes back only through the remover's own record; a Files item needs that record (D396)", async () => {
    const owner = await createUser("Relink files owner");
    const editor = await createUser("Relink files editor");
    const { calendarId, eventId } = await calendarWithEvent(owner);
    await shareCalendar(owner, calendarId, "selected", [editor.userId], "viewer");
    addCalendarMember(calendarId, editor.userId, "edit");
    db.query("UPDATE calendar_members SET level = 'manage' WHERE calendar_id = ? AND user_id = ?").run(calendarId, editor.userId);
    const spec = await filesItem(owner);
    expect((await link(owner, "event", eventId, { documentId: spec, confirmed: true })).status).toBe(201);

    // The manager removes it (a Files item is never binned) and undoes: their record allows it.
    expect((await unlink(editor, "event", eventId, spec)).body.documentBinned).toBe(false);
    expect(removedLink(editor.userId, "event", eventId, spec)).not.toBeNull();
    expect((await relink(editor, { hostKind: "event", hostId: eventId, documentId: spec })).body).toEqual({ relinked: true, restored: false });
    expect(removedLink(editor.userId, "event", eventId, spec)).toBeNull();
    const link0 = db.query("SELECT linked_by FROM attachment_links WHERE host_kind = 'event' AND host_id = ? AND document_id = ?").get(eventId, spec) as { linked_by: string };
    expect(link0.linked_by).toBe(owner.userId);

    // Without a record (expired, or none): someone else's file is a 404, the owner's Files item a confirm.
    expect((await unlink(editor, "event", eventId, spec)).status).toBe(200);
    resetUndoTickets();
    expect((await relink(editor, { hostKind: "event", hostId: eventId, documentId: spec })).status).toBe(404);
    const confirm = await relink(owner, { hostKind: "event", hostId: eventId, documentId: spec });
    expect(confirm.status).toBe(409);
    expect(confirm.body.code).toBe("CONFIRM_REQUIRED");

    // A file the caller never removed (another person's) is a 404, like a missing one.
    const other = await uploadAttachment(owner, "other.txt");
    expect((await relink(editor, { hostKind: "event", hostId: eventId, documentId: other })).status).toBe(404);
    expect((await relink(editor, { hostKind: "event", hostId: eventId, documentId: crypto.randomUUID() })).status).toBe(404);

    // A record expires.
    expect((await link(owner, "event", eventId, { documentId: spec, confirmed: true })).status).toBe(201);
    expect((await unlink(editor, "event", eventId, spec)).status).toBe(200);
    expect(removedLink(editor.userId, "event", eventId, spec, Date.now() + UNDO_TICKET_TTL_MS + 1)).toBeNull();
  });

  test("a Files item deleted on purpose stays in the Bin; the cap holds; notes and whiteboards are refused; bad input is 400", async () => {
    const owner = await createUser("Relink edge owner");
    const { eventId } = await calendarWithEvent(owner);
    const spec = await filesItem(owner);
    expect((await link(owner, "event", eventId, { documentId: spec, confirmed: true })).status).toBe(201);
    expect((await unlink(owner, "event", eventId, spec)).status).toBe(200);
    expect((await api(owner, "DELETE", `/files/${spec}`, {})).status).toBe(200);
    const inBin = await relink(owner, { hostKind: "event", hostId: eventId, documentId: spec });
    expect(inBin.status).toBe(409);
    expect(inBin.body.code).toBe("IN_BIN");

    const derived = await relink(owner, { hostKind: "note", hostId: crypto.randomUUID(), documentId: spec });
    expect(derived.status).toBe(409);
    expect(derived.body.code).toBe("LINKS_DERIVED");
    expect((await relink(owner, { hostKind: "whiteboard", hostId: crypto.randomUUID(), documentId: spec })).body.code).toBe("LINKS_DERIVED");
    expect((await relink(owner, { hostKind: "message", hostId: eventId, documentId: spec })).status).toBe(400);
    expect((await relink(owner, { hostKind: "event", hostId: "nope", documentId: spec })).status).toBe(400);
    expect((await relink(owner, { hostKind: "event", hostId: eventId, documentId: spec, extra: 1 })).status).toBe(400);

    // The cap (20 per event) counts what came back meanwhile.
    const kept = await uploadAttachment(owner, "kept.txt");
    expect((await link(owner, "event", eventId, { documentId: kept })).status).toBe(201);
    expect((await unlink(owner, "event", eventId, kept)).status).toBe(200);
    for (let index = 0; index < 20; index += 1) {
      const filler = await uploadAttachment(owner, `filler-${index}.txt`);
      expect((await link(owner, "event", eventId, { documentId: filler })).status).toBe(201);
    }
    const full = await relink(owner, { hostKind: "event", hostId: eventId, documentId: kept });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("LIMIT_REACHED");
    // Nothing was restored by the refusal.
    expect(deletedAt(kept)).not.toBeNull();
  });

  test("keys never reach the route, and it is rate limited per account", async () => {
    const owner = await createUser("Relink key owner");
    const { eventId } = await calendarWithEvent(owner);
    const key = makeKey(owner, ["calendar:write", "files:write"]);
    const documentId = await uploadAttachment(owner);
    expect((await link(owner, "event", eventId, { documentId })).status).toBe(201);
    expect((await unlink(owner, "event", eventId, documentId)).status).toBe(200);
    const body = JSON.stringify({ hostKind: "event", hostId: eventId, documentId });
    const withKey = await request("/attachments/relink", { method: "POST", body, headers: { Authorization: `Bearer ${key.token}` } });
    expect(withKey.status).toBe(401);
    const restV1 = await request("/v1/attachments/relink", { method: "POST", body, headers: { Authorization: `Bearer ${key.token}` } });
    expect(restV1.status).not.toBe(200);
    expect(deletedAt(documentId)).not.toBeNull();

    let limited = 0;
    for (let index = 0; index < 32; index += 1) {
      if ((await relink(owner, { hostKind: "event", hostId: eventId, documentId: crypto.randomUUID() })).status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe("relink: cards", () => {
  async function board(label: string) {
    const owner = await createUser(`Relink ${label} owner`);
    const member = await createUser(`Relink ${label} member`);
    const stranger = await createUser(`Relink ${label} stranger`);
    const created = await tasks(owner, "POST", "/boards", { name: `${label} board` });
    expect(created.status).toBe(201);
    const boardId = created.body.board.id as string;
    const columnId = created.body.columns[0].id as string;
    expect((await tasks(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
    const card = (await tasks(owner, "POST", `/boards/${boardId}/cards`, { columnId, title: `${label} card` })).body.card as { id: string };
    return { owner, member, stranger, boardId, cardId: card.id };
  }
  const cardFiles = async (session: Session, cardId: string) => ((await tasks(session, "GET", `/cards/${cardId}`)).body.attachments as Array<{ document_id: string; comment_id: string | null }>);

  test("owner Undo restores from the Bin in the same order; reader 403, stranger 404; idempotent", async () => {
    const { owner, member, stranger, boardId, cardId } = await board("card");
    const ids: string[] = [];
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      const id = (await upload(owner, name, name, { attachTo: "card" })).id;
      expect((await tasks(owner, "POST", `/cards/${cardId}/attachments`, { documentId: id })).status).toBe(201);
      ids.push(id);
      await Bun.sleep(3);
    }
    expect((await tasks(owner, "DELETE", `/cards/${cardId}/attachments/${ids[1]}`)).body.movedToBin).toBe(true);
    const body = { hostKind: "card", hostId: cardId, documentId: ids[1] };
    expect((await relink(stranger, body)).status).toBe(404);
    // The member reads the board but cannot edit it (a board shares as view by default).
    db.query("UPDATE board_members SET level = 'view' WHERE board_id = ? AND user_id = ?").run(boardId, member.userId);
    expect((await relink(member, body)).status).toBe(403);
    expect(deletedAt(ids[1]!)).not.toBeNull();

    expect((await relink(owner, body)).body).toEqual({ relinked: true, restored: true });
    expect(deletedAt(ids[1]!)).toBeNull();
    expect((await cardFiles(owner, cardId)).map((item) => item.document_id)).toEqual(ids);
    expect((await relink(owner, body)).body).toEqual({ relinked: false, restored: false });
  });

  test("a comment's file comes back with its comment, and not once the comment is deleted", async () => {
    const { owner, cardId } = await board("comment");
    const documentId = (await upload(owner, "note.txt", "note", { attachTo: "card" })).id;
    const comment = await tasks(owner, "POST", `/cards/${cardId}/comments`, { body: "See file", attachmentIds: [documentId] });
    expect(comment.status).toBe(201);
    const commentId = (comment.body.comment?.id ?? (db.query("SELECT id FROM card_comments WHERE card_id = ?").get(cardId) as { id: string }).id) as string;
    expect((await tasks(owner, "DELETE", `/cards/${cardId}/attachments/${documentId}`)).status).toBe(200);
    expect((await relink(owner, { hostKind: "card", hostId: cardId, documentId })).body.relinked).toBe(true);
    expect((await cardFiles(owner, cardId)).find((item) => item.document_id === documentId)?.comment_id).toBe(commentId);

    expect((await tasks(owner, "DELETE", `/cards/${cardId}/attachments/${documentId}`)).status).toBe(200);
    db.query("DELETE FROM card_comments WHERE id = ?").run(commentId);
    const gone = await relink(owner, { hostKind: "card", hostId: cardId, documentId });
    expect(gone.status).toBe(409);
    expect(gone.body.code).toBe("COMMENT_GONE");
  });
});

describe("relink: rows", () => {
  test("viewer 403, stranger 404, editor's own file back in the same field from the Bin, as a row write; idempotent", async () => {
    const owner = await createUser("Relink row owner");
    const editor = await createUser("Relink row editor");
    const viewer = await createUser("Relink row viewer");
    const stranger = await createUser("Relink row stranger");
    const collection = await newCollection(owner, { name: "Receipts", fields: [{ name: "Item", type: "text" }, { name: "Receipt", type: "file" }] });
    const receipt = collection.fields[1]!;
    const row = await addRow(owner, collection.id, { [collection.fields[0]!.id]: "Fridge" });
    await shareCollection(owner, collection.id, "selected", [editor.userId, viewer.userId], "editor");
    db.query("UPDATE collection_members SET level = 'view' WHERE collection_id = ? AND user_id = ?").run(collection.id, viewer.userId);

    const documentId = (await upload(editor, "receipt.txt", "receipt", { attachTo: "row" })).id;
    expect((await collections(editor, "POST", `/rows/${row.id}/attachments`, { documentId, fieldId: receipt.id })).status).toBe(201);
    const removed = await collections(editor, "DELETE", `/rows/${row.id}/attachments/${documentId}`);
    expect(removed.body.documentBinned).toBe(true);
    const revision = removed.body.row.revision as number;

    const body = { hostKind: "row", hostId: row.id, documentId };
    expect((await relink(stranger, body)).status).toBe(404);
    expect((await relink(viewer, body)).status).toBe(403);
    // The collection's owner removed nothing: someone else's file in its owner's Bin.
    expect((await relink(owner, body)).status).toBe(404);

    expect((await relink(editor, body)).body).toEqual({ relinked: true, restored: true });
    expect(deletedAt(documentId)).toBeNull();
    const after = await collections(editor, "GET", `/rows/${row.id}`);
    expect(after.body.row.files[receipt.id].map((file: { id: string }) => file.id)).toEqual([documentId]);
    expect(after.body.row.revision).toBe(revision + 1);
    expect((await relink(editor, body)).body).toEqual({ relinked: false, restored: false });
  });
});

describe("relink: chat messages", () => {
  test("only the chat's owner, on their own message", async () => {
    const owner = await createUser("Relink chat owner");
    const stranger = await createUser("Relink chat stranger");
    const chatId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    db.query("INSERT INTO chats (id, owner_id, title, created_at, updated_at, active_leaf_id) VALUES (?, ?, 'Chat', ?, ?, ?)").run(chatId, owner.userId, timestamp, timestamp, messageId);
    db.query("INSERT INTO chat_messages (id, chat_id, parent_id, role, author_id, content, created_at) VALUES (?, ?, NULL, 'user', ?, 'Hello', ?)").run(messageId, chatId, owner.userId, timestamp);
    const documentId = await uploadAttachment(owner, "photo.txt", "photo", "chat_message");
    expect((await link(owner, "chat_message", messageId, { documentId })).status).toBe(201);
    expect((await unlink(owner, "chat_message", messageId, documentId)).body.documentBinned).toBe(true);
    expect((await relink(stranger, { hostKind: "chat_message", hostId: messageId, documentId })).status).toBe(404);
    expect((await relink(owner, { hostKind: "chat_message", hostId: messageId, documentId })).body).toEqual({ relinked: true, restored: true });
  });
});
