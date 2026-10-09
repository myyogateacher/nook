import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { addCalendarMember, api, attachmentsFolderOf, calendarWithEvent, documentRow, link, shareCalendar, unlink, upload, uploadAttachment } from "./support/attachments";

const { sweepOrphanedAttachments, missingAttachmentTriggers, ATTACHMENT_TRIGGERS, UNLINKED_GRACE_MS } = await import("../server/attachments/sweep");
const { registerAttachmentReferenceChecker, resetReferenceCacheForTests } = await import("../server/attachments/references");
const { syncDerivedLinks } = await import("../server/attachments/service");

/**
 * U0 review fixes: the owner may always withdraw their own file (M1), the orphan sweep keeps files
 * that drafts, note versions, or whiteboards still reference (M3), the system folder's name never
 * clashes with an ordinary "Attachments" folder (L1), and the 046 trigger self-check (L3).
 */

beforeEach(() => resetReferenceCacheForTests());

const longAgo = () => new Date(Date.now() - UNLINKED_GRACE_MS - 3_600_000).toISOString();
const backdate = (id: string) => db.query("UPDATE documents SET created_at = ?, updated_at = ? WHERE id = ?").run(longAgo(), longAgo(), id);
const linkCount = (id: string) => (db.query("SELECT COUNT(*) AS count FROM attachment_links WHERE document_id = ?").get(id) as { count: number }).count;

async function editorSetup(label: string) {
  const owner = await createUser(`${label} calendar owner`);
  const editor = await createUser(`${label} editor`);
  const { calendarId, eventId } = await calendarWithEvent(owner);
  await shareCalendar(owner, calendarId, "selected", [editor.userId], "editor");
  addCalendarMember(calendarId, editor.userId, "edit");
  return { owner, editor, calendarId, eventId };
}

describe("M1: a file's owner can always withdraw it", () => {
  test("after their level drops to view, and after the calendar is unshared (then only { ok })", async () => {
    const { owner, editor, calendarId, eventId } = await editorSetup("M1 levels");
    const first = await uploadAttachment(editor, "first.txt");
    const second = await uploadAttachment(editor, "second.txt");
    for (const documentId of [first, second]) expect((await link(editor, "event", eventId, { documentId })).status).toBe(201);

    addCalendarMember(calendarId, editor.userId, "view");
    // Now a reader: linking is refused, withdrawing their own file is not.
    expect((await link(editor, "event", eventId, { documentId: await uploadAttachment(editor, "third.txt") })).body.code).toBe("READ_ONLY");
    expect(await unlink(editor, "event", eventId, first)).toEqual({ status: 200, body: { ok: true, documentBinned: true } });

    await shareCalendar(owner, calendarId, "private");
    // Cannot read the event any more: the answer says nothing about it.
    const usage = await api(editor, "GET", `/files/${second}/usage`);
    expect(usage.body).toEqual({ uses: [], hidden: [{ hostKind: "event", hostId: eventId }], hiddenCount: 1, total: 1 });
    expect(await unlink(editor, "event", eventId, second)).toEqual({ status: 200, body: { ok: true } });
    expect(linkCount(second)).toBe(0);
    expect(documentRow(second)!.deleted_at).not.toBeNull();
    // Gone is gone: a second try is the 404.
    expect((await unlink(editor, "event", eventId, second)).status).toBe(404);
  });

  test("a team viewer withdraws their own file; nobody withdraws someone else's that way", async () => {
    const { owner, editor, calendarId, eventId } = await editorSetup("M1 role");
    const mine = await uploadAttachment(editor, "mine.txt");
    const owners = await uploadAttachment(owner, "owners.txt");
    await link(editor, "event", eventId, { documentId: mine });
    await link(owner, "event", eventId, { documentId: owners });
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(editor.userId);
    expect((await unlink(editor, "event", eventId, owners)).body.code).toBe("READ_ONLY");
    expect((await unlink(editor, "event", eventId, mine)).status).toBe(200);
    const stranger = await createUser("M1 stranger");
    expect((await unlink(stranger, "event", eventId, owners)).status).toBe(404);
    expect(linkCount(owners)).toBe(1);
    void calendarId;
  });

  test("every host kind: a chat message, a derived note, and a card (module host)", async () => {
    const owner = await createUser("M1 kinds owner");
    const other = await createUser("M1 kinds other");
    const at = new Date().toISOString();
    // A note someone else owns, published, that derived a link to the owner's file and was then unshared.
    const noteId = crypto.randomUUID();
    db.query("INSERT INTO notes (id, owner_id, folder_id, title, current_version, created_at, updated_at) VALUES (?, ?, NULL, 'Theirs', 1, ?, ?)").run(noteId, other.userId, at, at);
    const inNote = await uploadAttachment(owner, "in-note.txt", "x", "note");
    db.query("INSERT INTO attachment_links (host_kind, host_id, document_id, linked_by, created_at) VALUES ('note', ?, ?, ?, ?)").run(noteId, inNote, owner.userId, at);
    expect(await unlink(owner, "note", noteId, inNote)).toEqual({ status: 200, body: { ok: true } });
    // Someone else's chat message (a link left from before, say).
    const chatId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    db.query("INSERT INTO chats (id, owner_id, agent_id, title, active_leaf_id, created_at, updated_at) VALUES (?, ?, NULL, 'Chat', ?, ?, ?)").run(chatId, other.userId, messageId, at, at);
    db.query("INSERT INTO chat_messages (id, chat_id, parent_id, role, content, author_id, created_at) VALUES (?, ?, NULL, 'user', 'x', ?, ?)").run(messageId, chatId, other.userId, at);
    const inChat = await uploadAttachment(owner, "in-chat.txt", "x", "chat_message");
    db.query("INSERT INTO attachment_links (host_kind, host_id, document_id, linked_by, created_at) VALUES ('chat_message', ?, ?, ?, ?)").run(messageId, inChat, owner.userId, at);
    expect((await unlink(owner, "chat_message", messageId, inChat)).status).toBe(200);
    // A card on a board the owner was removed from.
    const created = await api(other, "POST", "/tasks/boards", { name: "Their board" });
    const card = (await api(other, "POST", `/tasks/boards/${created.body.board.id}/cards`, { columnId: created.body.columns[0].id, title: "Card" })).body.card.id as string;
    const onCard = await uploadAttachment(owner, "on-card.txt", "x", "card");
    db.query("INSERT INTO card_attachments (card_id, document_id, linked_by, created_at) VALUES (?, ?, ?, ?)").run(card, onCard, owner.userId, at);
    expect(await unlink(owner, "card", card, onCard)).toEqual({ status: 200, body: { ok: true } });
    expect(db.query("SELECT COUNT(*) AS count FROM card_attachments WHERE document_id = ?").get(onCard)).toEqual({ count: 0 });
    // Non-owners still go through the host's own routes.
    expect((await unlink(other, "card", card, onCard)).status).toBe(409);
  });
});

describe("M3: the orphan sweep keeps referenced files", () => {
  async function orphan(owner: Session, name: string) {
    const id = await uploadAttachment(owner, name, "png-ish", "note");
    backdate(id);
    return id;
  }

  test("a note draft, a stored published version, and a whiteboard scene each keep a file; an unreferenced one goes", async () => {
    const owner = await createUser("M3 owner");
    const inDraft = await orphan(owner, "draft.png");
    const inVersion = await orphan(owner, "version.png");
    const unreferenced = await orphan(owner, "nothing.png");

    const draftNote = (await api(owner, "POST", "/notes", { folderId: null })).body.note.id as string;
    expect((await api(owner, "PUT", `/notes/${draftNote}/draft`, { markdown: `# Draft\n\n![x](/api/files/${inDraft}/content)`, revision: 1 })).status).toBe(200);
    const published = (await api(owner, "POST", "/notes", { folderId: null })).body.note.id as string;
    await api(owner, "PUT", `/notes/${published}/draft`, { markdown: `# Old\n\n![x](/api/files/${inVersion.toUpperCase()}/content)`, revision: 1 });
    expect((await api(owner, "POST", `/notes/${published}/publish`, {})).status).toBe(200);
    // The next draft drops the image: only the stored version still has it.
    const detail = await api(owner, "GET", `/notes/${published}`);
    await api(owner, "PUT", `/notes/${published}/draft`, { markdown: "# New", revision: detail.body.note.draft_revision ?? 1 });

    await sweepOrphanedAttachments();
    expect(documentRow(inDraft)!.deleted_at).toBeNull();
    expect(documentRow(inVersion)!.deleted_at).toBeNull();
    expect(documentRow(unreferenced)!.deleted_at).not.toBeNull();
  });

  test("whiteboard scenes keep their pictures, a registered checker keeps what it names, and a failing checker keeps everything", async () => {
    const owner = await createUser("M3 board owner");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwHxkzEC0AAPVGD/Hh+ukpAAAAAElFTkSuQmCC", "base64");
    const picture = await uploadAttachment(owner, "pic.png", png, "whiteboard");
    const board = (await api(owner, "POST", "/whiteboards", { name: "Board" })).body.whiteboard;
    const element = { id: "img0", type: "image", x: 0, y: 50, width: 64, height: 64, angle: 0, strokeColor: "transparent", backgroundColor: "transparent", fileId: picture, status: "pending", scale: [1, 1], version: 1 };
    const saved = await api(owner, "PUT", `/whiteboards/${board.id}/scene`, { baseRevision: board.revision ?? 1, scene: { type: "excalidraw", version: 2, source: "test", elements: [element], appState: {}, files: { [picture]: { id: picture, mimeType: "image/png", nookDocumentId: picture } } } });
    expect(saved.status).toBe(200);
    backdate(picture);
    const named = await orphan(owner, "named.png");
    const unregister = registerAttachmentReferenceChecker("test", async (candidates) => new Set([...candidates].filter((id) => id === named)));
    await sweepOrphanedAttachments();
    unregister();
    expect(documentRow(picture)!.deleted_at).toBeNull();
    expect(documentRow(named)!.deleted_at).toBeNull();

    const kept = await orphan(owner, "kept.png");
    const failing = registerAttachmentReferenceChecker("failing", async () => { throw new Error("unavailable"); });
    await sweepOrphanedAttachments();
    failing();
    expect(documentRow(kept)!.deleted_at).toBeNull();
  });

  test("syncDerivedLinks reports the actor's referenced files that are in their Bin", async () => {
    const owner = await createUser("M3 sync owner");
    const noteId = crypto.randomUUID();
    const at = new Date().toISOString();
    db.query("INSERT INTO notes (id, owner_id, folder_id, title, current_version, created_at, updated_at) VALUES (?, ?, NULL, 'N', 1, ?, ?)").run(noteId, owner.userId, at, at);
    const live = await uploadAttachment(owner, "live.png", "x", "note");
    const binned = await uploadAttachment(owner, "binned.png", "x", "note");
    expect((await api(owner, "DELETE", `/files/${binned}`)).status).toBe(200);
    expect(syncDerivedLinks("note", noteId, owner.userId, [live, binned])).toEqual({ linked: [live], unlinked: [], skipped: [binned], binned: [binned] });
  });
});

describe("L1 and L3", () => {
  test("an existing root folder named Attachments makes the system folder “Attachments (Nook)”", async () => {
    const owner = await createUser("L1 owner");
    expect((await api(owner, "POST", "/folders", { name: "attachments", parentId: null })).status).toBe(201);
    await uploadAttachment(owner);
    expect((db.query("SELECT name FROM folders WHERE id = ?").get(attachmentsFolderOf(owner.userId)!) as { name: string }).name).toBe("Attachments (Nook)");
    const plain = await createUser("L1 plain");
    await uploadAttachment(plain);
    expect((db.query("SELECT name FROM folders WHERE id = ?").get(attachmentsFolderOf(plain.userId)!) as { name: string }).name).toBe("Attachments");
    void upload;
  });

  test("the boot self-check finds every 046 trigger", () => {
    expect(ATTACHMENT_TRIGGERS.length).toBe(13);
    expect(missingAttachmentTriggers()).toEqual([]);
    void request;
  });
});
