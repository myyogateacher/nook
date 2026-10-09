import { describe, expect, test } from "bun:test";
import { createUser, db, request } from "./support/harness";
import { insertNote } from "./support/collections";
import {
  addCalendarMember, api, attachmentsFolderOf, calendarWithEvent, contentStatus, filesList, link, listOn, metadataStatus, shareCalendar, unlink, upload, uploadAttachment, userWithRole
} from "./support/attachments";

const { syncDerivedLinks, linkAttachment, hostReadable } = await import("../server/attachments/service");
const { HOSTS, HOST_KINDS, LINK_TABLE_HOSTS } = await import("../server/attachments/hosts");
const { storedBytes } = await import("../server/documents");

/**
 * Uploads everywhere U0: the host registry's access rules (T340, T341, D394, D396). A document is
 * readable through its own Files sharing, or through a live link from a live host the viewer can read,
 * in single reads only; links never widen lists, and only the document's owner links it.
 */

const now = () => new Date().toISOString();
/** Moves a row to the Bin (or back) the way the module does: deleted_at and purge_after together. */
const binRow = (table: string, id: string) => db.query(`UPDATE ${table} SET deleted_at = ?, purge_after = ? WHERE id = ?`).run(now(), new Date(Date.now() + 30 * 86_400_000).toISOString(), id);
const unbinRow = (table: string, id: string) => db.query(`UPDATE ${table} SET deleted_at = NULL, purge_after = NULL WHERE id = ?`).run(id);

describe("the host registry", () => {
  test("every kind is registered once, link-table hosts are the generated branch, and links of unknown kinds grant nothing", async () => {
    expect([...HOST_KINDS].sort()).toEqual(["card", "chat_message", "event", "note", "row", "whiteboard"]);
    expect(LINK_TABLE_HOSTS.map((spec) => spec.kind).sort()).toEqual(["chat_message", "event", "note", "whiteboard"]);
    for (const kind of HOST_KINDS) {
      const spec = HOSTS[kind];
      expect(spec.kind).toBe(kind);
      expect(spec.caps.perHost).toBeGreaterThan(0);
      // Declared hosts must say who links and unlinks; the others never take generic links.
      expect({ kind, declared: spec.linking === "declared", canLink: typeof spec.canLink === "function", canUnlink: typeof spec.canUnlink === "function" })
        .toEqual({ kind, declared: spec.linking === "declared", canLink: spec.linking === "declared", canUnlink: spec.linking === "declared" });
    }
    expect(HOSTS.event.caps.perHost).toBe(20);
    expect(HOSTS.note.caps.perHost).toBe(100);
    expect(HOSTS.chat_message.caps.perHost).toBe(5);

    const owner = await createUser("Registry owner");
    const reader = await createUser("Registry reader");
    const documentId = await uploadAttachment(owner);
    // A link under a kind nobody registered (say, a future "message") opens nothing.
    db.query("INSERT INTO attachment_links (host_kind, host_id, document_id, linked_by, created_at) VALUES ('message', ?, ?, ?, ?)").run(crypto.randomUUID(), documentId, owner.userId, now());
    expect(await contentStatus(reader, documentId)).toBe(404);
  });
});

describe("events (T340 matrix)", () => {
  test("owner, editor, viewer, team viewer, guest by name, stranger, and blocked; binned host, binned file, unshare, unlink", async () => {
    const owner = await createUser("Event owner");
    const editor = await createUser("Event editor");
    const viewer = await createUser("Event viewer");
    const teamViewer = await userWithRole("Event team viewer", "viewer");
    const guest = await userWithRole("Event guest", "guest");
    const everyoneGuest = await userWithRole("Event other guest", "guest");
    const stranger = await createUser("Event stranger");
    const blocked = await createUser("Event blocked");
    const { calendarId, eventId } = await calendarWithEvent(owner);
    const documentId = await uploadAttachment(owner);

    // Unlinked, it is the owner's alone.
    for (const session of [editor, viewer, stranger]) expect(await contentStatus(session, documentId)).toBe(404);
    expect((await link(owner, "event", eventId, { documentId })).status).toBe(201);
    // Still only the owner: the calendar is private.
    expect(await contentStatus(viewer, documentId)).toBe(404);

    await shareCalendar(owner, calendarId, "selected", [editor.userId, viewer.userId, teamViewer.userId, blocked.userId], "viewer");
    addCalendarMember(calendarId, editor.userId, "edit");
    addCalendarMember(calendarId, guest.userId, "view");
    for (const session of [owner, editor, viewer, teamViewer, guest]) {
      expect({ who: session.email, content: await contentStatus(session, documentId), metadata: await metadataStatus(session, documentId) }).toEqual({ who: session.email, content: 200, metadata: 200 });
    }
    for (const session of [stranger, everyoneGuest]) expect(await contentStatus(session, documentId)).toBe(404);
    // Never in anyone's lists (T40): Files shows the owner's own Attachments folder only.
    expect(await filesList(viewer)).not.toContain(documentId);
    expect(await filesList(owner)).toContain(documentId);
    const headers = (await request(`/files/${documentId}/content`, {}, viewer)).headers;
    expect(headers.get("cache-control")).toContain("no-store");

    // A blocked account reads nothing.
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(now(), blocked.userId);
    expect(await contentStatus(blocked, documentId)).not.toBe(200);

    // Everyone signed in: guests are never part of it (only by name).
    await shareCalendar(owner, calendarId, "all_users");
    expect(await contentStatus(stranger, documentId)).toBe(200);
    expect(await contentStatus(everyoneGuest, documentId)).toBe(404);
    await shareCalendar(owner, calendarId, "selected", [viewer.userId]);
    expect(await contentStatus(stranger, documentId)).toBe(404);
    expect(await contentStatus(viewer, documentId)).toBe(200);

    // A binned event, then a binned calendar, revoke at once; restoring brings it back.
    binRow("events", eventId);
    expect(await contentStatus(viewer, documentId)).toBe(404);
    expect(hostReadable("event", eventId, owner.userId)).toBe(false);
    unbinRow("events", eventId);
    expect(await contentStatus(viewer, documentId)).toBe(200);
    binRow("calendars", calendarId);
    expect(await contentStatus(viewer, documentId)).toBe(404);
    unbinRow("calendars", calendarId);
    expect(await contentStatus(viewer, documentId)).toBe(200);

    // A file in its owner's Bin is unreadable for everyone, and listed as removed (D409).
    binRow("documents", documentId);
    expect(await contentStatus(viewer, documentId)).toBe(404);
    expect(await contentStatus(owner, documentId)).toBe(404);
    const listed = await listOn(viewer, "event", eventId);
    expect(listed.body.attachments).toEqual([expect.objectContaining({ documentId, removed: true })]);
    expect(JSON.stringify(listed.body)).not.toContain("agenda.txt");
    unbinRow("documents", documentId);

    // Unshare revokes; the list itself is the host's 404.
    await shareCalendar(owner, calendarId, "private");
    expect(await contentStatus(viewer, documentId)).toBe(404);
    expect((await listOn(viewer, "event", eventId)).status).toBe(404);
    await shareCalendar(owner, calendarId, "selected", [viewer.userId]);
    expect((await unlink(owner, "event", eventId, documentId)).status).toBe(200);
    expect(await contentStatus(viewer, documentId)).toBe(404);
  });

  test("owner-only linking (T341): someone else's file is the same 404 as a missing one; readers and team viewers cannot link", async () => {
    const owner = await createUser("Link owner");
    const editor = await createUser("Link editor");
    const viewer = await createUser("Link viewer");
    const teamViewer = await userWithRole("Link team viewer", "viewer");
    const stranger = await createUser("Link stranger");
    const { calendarId, eventId } = await calendarWithEvent(owner);
    await shareCalendar(owner, calendarId, "selected", [editor.userId, viewer.userId, teamViewer.userId], "viewer");
    addCalendarMember(calendarId, editor.userId, "edit");
    const ownersFile = await uploadAttachment(owner, "owners.txt");
    const editorsFile = await uploadAttachment(editor, "editors.txt");
    const strangersFile = await uploadAttachment(stranger, "strangers.txt");

    const refused = await link(editor, "event", eventId, { documentId: ownersFile });
    expect(refused).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    expect((await link(editor, "event", eventId, { documentId: crypto.randomUUID() })).body).toEqual(refused.body);
    // The editor's own file links, and the calendar's owner can then open it.
    expect((await link(editor, "event", eventId, { documentId: editorsFile })).status).toBe(201);
    expect(await contentStatus(owner, editorsFile)).toBe(200);
    // Linking again is idempotent for the owner of the file.
    expect(await link(editor, "event", eventId, { documentId: editorsFile })).toMatchObject({ status: 200, body: { created: false } });

    expect((await link(viewer, "event", eventId, { documentId: await uploadAttachment(viewer, "v.txt") })).body.code).toBe("READ_ONLY");
    expect((await link(teamViewer, "event", eventId, { documentId: ownersFile })).body.code).toBe("ROLE_READ_ONLY");
    expect((await link(stranger, "event", eventId, { documentId: strangersFile })).status).toBe(404);
    expect(await contentStatus(stranger, strangersFile)).toBe(200);
    expect(await contentStatus(viewer, strangersFile)).toBe(404);

    // Unlink: a viewer cannot; the linker can; the calendar owner can remove anyone's.
    expect((await unlink(viewer, "event", eventId, editorsFile)).status).toBe(403);
    expect((await unlink(owner, "event", eventId, editorsFile)).status).toBe(200);

    // Parts, unknown kinds, and malformed ids.
    expect((await link(owner, "event", eventId, { documentId: ownersFile, partId: "comment-1" })).body.code).toBe("INVALID");
    expect((await link(owner, "robot", eventId, { documentId: ownersFile })).status).toBe(404);
    expect((await link(owner, "event", "not-a-uuid", { documentId: ownersFile })).status).toBe(404);
  });

  test("a file from Files needs the confirm (D396), the cap holds (D400), and an attachment counts once toward quota", async () => {
    const owner = await createUser("Confirm owner");
    const { eventId } = await calendarWithEvent(owner);
    const second = await calendarWithEvent(owner, "Second calendar");
    const filesItem = await upload(owner, "spec.txt", "the spec");
    expect(filesItem.status).toBe(201);
    const needs = await link(owner, "event", eventId, { documentId: filesItem.id });
    expect(needs).toMatchObject({ status: 409, body: { code: "CONFIRM_REQUIRED", documentName: "spec.txt" } });
    expect(needs.body.error).toContain("People who can open this event will be able to open spec.txt");
    expect((await link(owner, "event", eventId, { documentId: filesItem.id, confirmed: true })).status).toBe(201);
    // Whiteboards are never attachable.
    const board = await api(owner, "POST", "/whiteboards", { name: "Board" });
    expect((await link(owner, "event", eventId, { documentId: board.body.whiteboard.id, confirmed: true })).status).toBe(404);

    const before = storedBytes(owner.userId);
    const shared = await uploadAttachment(owner, "twice.txt", "x".repeat(1000));
    const after = storedBytes(owner.userId);
    expect(after - before).toBe(1000);
    expect((await link(owner, "event", eventId, { documentId: shared })).status).toBe(201);
    expect((await link(owner, "event", second.eventId, { documentId: shared })).status).toBe(201);
    expect(storedBytes(owner.userId)).toBe(after);

    // The 20-per-event cap.
    const capped = await calendarWithEvent(owner, "Capped");
    for (let index = 0; index < 20; index += 1) {
      const id = crypto.randomUUID();
      db.query("INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, purpose, created_at, updated_at) VALUES (?, ?, ?, 'x.txt', 'text/plain', 'text', 1, ?, 'file', ?, ?)")
        .run(id, owner.userId, attachmentsFolderOf(owner.userId), "0".repeat(64), now(), now());
      db.query("INSERT INTO attachment_links (host_kind, host_id, document_id, position, linked_by, created_at) VALUES ('event', ?, ?, ?, ?, ?)").run(capped.eventId, id, index, owner.userId, now());
    }
    expect((await link(owner, "event", capped.eventId, { documentId: shared })).body).toMatchObject({ code: "LIMIT_REACHED", limit: 20 });
  });
});

describe("notes (D408, the G1 regression), chat messages, whiteboards, cards, and rows", () => {
  test("a directly shared note's recipient opens its derived images; drafts grant nothing; nobody else's file is linked", async () => {
    const owner = await createUser("Note owner");
    const recipient = await createUser("Note recipient");
    const other = await createUser("Note other");
    const noteId = insertNote(owner.userId, "Shared note");
    db.query("UPDATE notes SET visibility = 'selected' WHERE id = ?").run(noteId);
    db.query("INSERT INTO note_shares (note_id, user_id, created_at, level) VALUES (?, ?, ?, 'view')").run(noteId, recipient.userId, now());
    const image = await uploadAttachment(owner, "photo.png", "png-ish", "note");
    const othersImage = await uploadAttachment(other, "theirs.png", "png-ish", "note");
    expect(await contentStatus(recipient, image)).toBe(404);

    const synced = syncDerivedLinks("note", noteId, owner.userId, [image, othersImage]);
    expect(synced).toEqual({ linked: [image], unlinked: [], skipped: [othersImage] });
    expect(await contentStatus(recipient, image)).toBe(200);
    expect(await contentStatus(recipient, othersImage)).toBe(404);
    // Declared links are refused for a derived host.
    expect((await link(owner, "note", noteId, { documentId: image })).body.code).toBe("LINKS_DERIVED");
    // An unpublished note grants nothing.
    db.query("UPDATE notes SET current_version = 0 WHERE id = ?").run(noteId);
    expect(await contentStatus(recipient, image)).toBe(404);
    db.query("UPDATE notes SET current_version = 1 WHERE id = ?").run(noteId);
    expect(await contentStatus(recipient, image)).toBe(200);
    // Removing the reference removes the link; the file is not binned by it.
    expect(syncDerivedLinks("note", noteId, owner.userId, []).unlinked).toEqual([image]);
    expect(await contentStatus(recipient, image)).toBe(404);
    expect(await contentStatus(owner, image)).toBe(200);
    // A purged note leaves no links (the 046 trigger).
    syncDerivedLinks("note", noteId, owner.userId, [image]);
    db.query("DELETE FROM notes WHERE id = ?").run(noteId);
    expect(db.query("SELECT COUNT(*) AS count FROM attachment_links WHERE host_id = ?").get(noteId)).toEqual({ count: 0 });
  });

  test("chat messages: the owner, someone it is shared with on the branch on screen only, never guests", async () => {
    const owner = await createUser("Chat owner");
    const sharee = await createUser("Chat sharee");
    const guest = await userWithRole("Chat guest", "guest");
    const chatId = crypto.randomUUID();
    const [m1, m2, m3] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    db.query("INSERT INTO chats (id, owner_id, agent_id, title, active_leaf_id, visibility, created_at, updated_at) VALUES (?, ?, NULL, 'Chat', ?, 'selected', ?, ?)").run(chatId, owner.userId, m2, now(), now());
    const message = db.query("INSERT INTO chat_messages (id, chat_id, parent_id, role, content, author_id, created_at) VALUES (?, ?, ?, ?, 'x', ?, ?)");
    message.run(m1, chatId, null, "user", owner.userId, now());
    message.run(m2, chatId, m1, "assistant", null, now());
    message.run(m3, chatId, m1, "user", owner.userId, now());
    for (const user of [sharee, guest]) db.query("INSERT INTO agent_access (resource_kind, resource_id, user_id, level, created_at) VALUES ('chat', ?, ?, 'view', ?)").run(chatId, user.userId, now());
    const onBranch = await uploadAttachment(owner, "on.txt", "on", "chat_message");
    const offBranch = await uploadAttachment(owner, "off.txt", "off", "chat_message");
    expect(linkAttachment(owner.userId, "chat_message", m1, { documentId: onBranch }).created).toBe(true);
    expect(linkAttachment(owner.userId, "chat_message", m3, { documentId: offBranch }).created).toBe(true);
    // Only the owner's own user messages take files.
    expect((await link(owner, "chat_message", m2, { documentId: onBranch })).body.code).toBe("INVALID");
    expect((await link(sharee, "chat_message", m1, { documentId: await uploadAttachment(sharee, "s.txt", "s", "chat_message") })).status).toBe(404);

    expect(await contentStatus(sharee, onBranch)).toBe(200);
    expect(await contentStatus(sharee, offBranch)).toBe(404);
    expect(await contentStatus(guest, onBranch)).toBe(404);
    binRow("chats", chatId);
    expect(await contentStatus(sharee, onBranch)).toBe(404);
    unbinRow("chats", chatId);
    // A purged message leaves no links (the 046 trigger).
    db.query("DELETE FROM chat_messages WHERE id = ?").run(m3);
    expect(db.query("SELECT COUNT(*) AS count FROM attachment_links WHERE host_id = ?").get(m3)).toEqual({ count: 0 });
  });

  test("whiteboards (Q4, for U4b): pictures the board's owner owns follow the board's own sharing", async () => {
    const owner = await createUser("Board owner");
    const sharee = await createUser("Board sharee");
    const board = (await api(owner, "POST", "/whiteboards", { name: "Plan" })).body.whiteboard.id as string;
    const picture = await uploadAttachment(owner, "pic.png", "png", "whiteboard");
    syncDerivedLinks("whiteboard", board, owner.userId, [picture]);
    expect(await contentStatus(sharee, picture)).toBe(404);
    expect((await api(owner, "PUT", `/files/${board}/sharing`, { visibility: "selected", userIds: [sharee.userId] })).status).toBe(200);
    expect(await contentStatus(sharee, picture)).toBe(200);
    expect((await api(owner, "PUT", `/files/${board}/sharing`, { visibility: "inherit", userIds: [] })).status).toBe(200);
    expect(await contentStatus(sharee, picture)).toBe(404);
  });

  test("cards and rows are listed through the registry and keep their own link routes", async () => {
    const owner = await createUser("Card host owner");
    const reader = await createUser("Card host reader");
    const created = await api(owner, "POST", "/tasks/boards", { name: "Host board" });
    const boardId = created.body.board.id as string;
    const card = (await api(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId: created.body.columns[0].id, title: "Card" })).body.card.id as string;
    const form = new FormData();
    form.append("file", new Blob(["spec"]), "spec.txt");
    const uploaded = await request("/files?purpose=task_attachment", { method: "POST", body: form }, owner);
    const documentId = ((await uploaded.json()) as { document: { id: string } }).document.id;
    expect((await api(owner, "POST", `/tasks/cards/${card}/attachments`, { documentId })).status).toBeLessThan(300);
    expect((await listOn(owner, "card", card)).body.attachments.map((item: { documentId: string }) => item.documentId)).toEqual([documentId]);
    expect((await listOn(reader, "card", card)).status).toBe(404);
    expect((await link(owner, "card", card, { documentId })).body.code).toBe("HOST_MANAGED");
  });
});

describe("usage (D409)", () => {
  test("the owner sees where a file is used; anyone else gets the 404", async () => {
    const owner = await createUser("Usage owner");
    const other = await createUser("Usage other");
    const { eventId } = await calendarWithEvent(owner, "Usage calendar");
    const documentId = await uploadAttachment(owner);
    expect((await api(owner, "GET", `/files/${documentId}/usage`)).body).toEqual({ uses: [], hiddenCount: 0, total: 0 });
    await link(owner, "event", eventId, { documentId });
    expect((await api(owner, "GET", `/files/${documentId}/usage`)).body).toEqual({ uses: [{ hostKind: "event", hostId: eventId, title: "Planning" }], hiddenCount: 0, total: 1 });
    expect((await api(other, "GET", `/files/${documentId}/usage`)).status).toBe(404);
    // Deleting a linked Attachments file from Files is allowed (D409); the host lists it as removed.
    expect((await api(owner, "DELETE", `/files/${documentId}`)).status).toBe(200);
    expect((await listOn(owner, "event", eventId)).body.attachments).toEqual([expect.objectContaining({ documentId, removed: true })]);
  });
});
