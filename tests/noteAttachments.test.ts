import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { api, contentStatus, upload, uploadAttachment } from "./support/attachments";

const { backfillNoteLinks } = await import("../server/noteAttachments");
const { resetReferenceCacheForTests } = await import("../server/attachments/references");
const { sweepOrphanedAttachments } = await import("../server/attachments/sweep");
const { backfillWhiteboardLinks, resetWhiteboardLimitsForTests } = await import("../server/whiteboards/service");
const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");

/**
 * Uploads everywhere U4 and U4b (plan D408, T350, Q4, G1): a published note's files and a board's
 * pictures are linked from their content, so the note's readers and the board's readers open them,
 * whatever the files' own sharing. Only the publisher's (the board owner's) own files are linked;
 * drafts grant nothing; Bin, purge, and version restore follow the published text.
 */

retireUsersAfterFile();
beforeAll(async () => {
  const admin = await createUser("U4 file admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
});
beforeEach(() => {
  resetWhiteboardLimitsForTests();
  resetMcpLimits();
});

type Json = Record<string, any>;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwHxkzEC0AAPVGD/Hh+ukpAAAAAElFTkSuQmCC", "base64");
const image = (id: string, alt = "photo.png") => `![${alt}](/api/files/${id}/content?disposition=inline)`;
const chip = (id: string, name = "report.pdf") => `[📎 ${name}](/files/${id})`;
const linksOf = (noteId: string) => (db.query("SELECT document_id FROM attachment_links WHERE host_kind = 'note' AND host_id = ? ORDER BY position").all(noteId) as Array<{ document_id: string }>).map((row) => row.document_id);

async function newNote(owner: Session) {
  const created = await api(owner, "POST", "/notes", {});
  expect(created.status).toBe(201);
  return created.body.note.id as string;
}

async function writeDraft(session: Session, noteId: string, markdown: string) {
  const note = (await api(session, "GET", `/notes/${noteId}`)).body.note as Json;
  const saved = await api(session, "PUT", `/notes/${noteId}/draft`, { revision: note.draft_revision ?? null, markdown });
  expect(saved.status).toBe(200);
  return saved.body.revision as number;
}

async function publish(session: Session, noteId: string, markdown: string, confirmAttachments?: string[]) {
  const revision = await writeDraft(session, noteId, markdown);
  const published = await api(session, "POST", `/notes/${noteId}/publish`, { revision, ...(confirmAttachments ? { confirmAttachments } : {}) });
  expect(published.status).toBe(200);
  return published.body as Json;
}

/** Shares one note directly (its folder stays private): the G1 case. */
async function shareDirectly(owner: Session, noteId: string, userIds: string[]) {
  expect((await api(owner, "PUT", `/notes/${noteId}/sharing`, { visibility: "selected", userIds })).status).toBe(200);
}

describe("notes (U4, G1)", () => {
  test("a direct recipient opens the images and files of the published note; the draft grants nothing", async () => {
    const owner = await createUser("U4 note owner");
    const recipient = await createUser("U4 note recipient");
    const noteId = await newNote(owner);
    await shareDirectly(owner, noteId, [recipient.userId]);
    const picture = (await upload(owner, "photo.png", PNG, { attachTo: "note" })).id;
    const pdf = await uploadAttachment(owner, "report.txt", "Quarterly report", "note");

    // A draft with both: nothing for the recipient (the note is not even published).
    await writeDraft(owner, noteId, `# Trip\n\n${image(picture)}\n\n${chip(pdf, "report.txt")}`);
    expect(await contentStatus(recipient, picture)).toBe(404);
    expect(await contentStatus(recipient, pdf)).toBe(404);

    // Published: both open for the recipient, as files of the note.
    const published = await publish(owner, noteId, `# Trip\n\n${image(picture)}\n\n${chip(pdf, "report.txt")}`);
    expect(published.skippedAttachments).toBeUndefined();
    expect(linksOf(noteId)).toEqual([picture, pdf]);
    expect(await contentStatus(recipient, picture)).toBe(200);
    expect(await contentStatus(recipient, pdf)).toBe(200);
    // Never in the recipient's Files list (T340).
    const files = (await api(recipient, "GET", "/files")).body.documents as Json[];
    expect(files.map((document) => document.id)).not.toContain(picture);

    // A new image in the next draft stays the owner's until it is published.
    const later = (await upload(owner, "later.png", PNG, { attachTo: "note" })).id;
    await writeDraft(owner, noteId, `# Trip\n\n${image(picture)}\n\n${image(later, "later.png")}`);
    expect(await contentStatus(recipient, later)).toBe(404);
    expect(await contentStatus(recipient, pdf)).toBe(200);
    await api(owner, "POST", `/notes/${noteId}/publish`, { revision: (await api(owner, "GET", `/notes/${noteId}`)).body.note.draft_revision });
    expect(await contentStatus(recipient, later)).toBe(200);
    // The chip left the published text: its link went with it.
    expect(await contentStatus(recipient, pdf)).toBe(404);
    expect(await contentStatus(owner, pdf)).toBe(200);

    // Unsharing the note revokes at once.
    expect((await api(owner, "PUT", `/notes/${noteId}/sharing`, { visibility: "private", userIds: [] })).status).toBe(200);
    expect(await contentStatus(recipient, picture)).toBe(404);
  }, 30_000);

  test("only the publisher's own files are linked: an editor's own file yes, someone else's file id never (T350)", async () => {
    const owner = await createUser("U4 link owner");
    const editor = await createUser("U4 link editor");
    const reader = await createUser("U4 link reader");
    const stranger = await createUser("U4 link stranger");
    const noteId = await newNote(owner);
    await shareDirectly(owner, noteId, [editor.userId, reader.userId]);
    db.query("UPDATE note_shares SET level = 'edit' WHERE note_id = ? AND user_id = ?").run(noteId, editor.userId);
    const ownersFile = await uploadAttachment(owner, "owner.txt", "owner", "note");
    const editorsFile = await uploadAttachment(editor, "editor.txt", "editor", "note");
    const strangersFile = await uploadAttachment(stranger, "secret.txt", "secret", "note");
    const strangersPlain = (await upload(stranger, "plain.txt", "plain")).id;

    await publish(owner, noteId, `${chip(ownersFile, "owner.txt")}`);
    const byEditor = await publish(editor, noteId, `${chip(ownersFile, "owner.txt")}\n\n${chip(editorsFile, "editor.txt")}\n\n${chip(strangersFile, "secret.txt")}\n\n${image(strangersPlain)}`);
    expect(byEditor.skippedAttachments).toBe(2);
    expect(linksOf(noteId).sort()).toEqual([ownersFile, editorsFile].sort());
    // The owner's file stays linked although the editor published; the editor's own file is linked.
    for (const session of [owner, reader]) expect(await contentStatus(session, editorsFile)).toBe(200);
    expect(await contentStatus(reader, ownersFile)).toBe(200);
    // Nobody reaches the stranger's files through the note, not even the publisher.
    for (const session of [owner, editor, reader]) {
      expect(await contentStatus(session, strangersFile)).toBe(404);
      expect(await contentStatus(session, strangersPlain)).toBe(404);
    }

    // The same trick by the owner of a note: someone else's id grants nothing.
    const thief = await createUser("U4 link thief");
    const ownNote = await newNote(thief);
    expect((await publish(thief, ownNote, chip(strangersFile, "secret.txt"))).skippedAttachments).toBe(1);
    expect(await contentStatus(thief, strangersFile)).toBe(404);
    expect(linksOf(ownNote)).toEqual([]);
    // A reader cannot publish at all.
    expect((await api(reader, "PUT", `/notes/${noteId}/draft`, { revision: null, markdown: chip(strangersFile) })).status).toBe(404);
  }, 30_000);

  test("version restore, Bin, restore from the Bin, and purge follow the published text", async () => {
    const owner = await createUser("U4 lifecycle owner");
    const recipient = await createUser("U4 lifecycle recipient");
    const noteId = await newNote(owner);
    await shareDirectly(owner, noteId, [recipient.userId]);
    const picture = (await upload(owner, "v1.png", PNG, { attachTo: "note" })).id;

    await publish(owner, noteId, `# v1\n\n${image(picture)}`);
    await publish(owner, noteId, "# v2\n\nNo picture");
    expect(await contentStatus(recipient, picture)).toBe(404);
    // Restoring version 1 makes a draft: still nothing until it is published.
    expect((await api(owner, "POST", `/notes/${noteId}/versions/1/restore`, {})).status).toBe(200);
    expect(await contentStatus(recipient, picture)).toBe(404);
    const draft = (await api(owner, "GET", `/notes/${noteId}`)).body.note as Json;
    expect((await api(owner, "POST", `/notes/${noteId}/publish`, { revision: draft.draft_revision })).status).toBe(200);
    expect(await contentStatus(recipient, picture)).toBe(200);

    // The Bin: links are kept but grant nothing; restoring brings them back.
    expect((await api(owner, "DELETE", `/notes/${noteId}`)).status).toBe(200);
    expect(await contentStatus(recipient, picture)).toBe(404);
    expect(await contentStatus(owner, picture)).toBe(200);
    expect(linksOf(noteId)).toEqual([picture]);
    expect((await api(owner, "POST", `/bin/note/${noteId}/restore`, {})).status).toBe(200);
    expect(await contentStatus(recipient, picture)).toBe(200);

    // Purged: the links go, and the orphaned upload goes to its owner's Bin with the next sweep.
    expect((await api(owner, "DELETE", `/notes/${noteId}`)).status).toBe(200);
    expect((await api(owner, "DELETE", `/bin/note/${noteId}`)).status).toBe(200);
    expect(linksOf(noteId)).toEqual([]);
    db.query("UPDATE documents SET created_at = ?, updated_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", picture);
    resetReferenceCacheForTests();
    await sweepOrphanedAttachments();
    expect((db.query("SELECT deleted_at FROM documents WHERE id = ?").get(picture) as { deleted_at: string | null }).deleted_at).not.toBeNull();
  }, 30_000);

  test("existing notes are backfilled once with the owner's own files; draft uploads survive the sweep; own binned files are reported and restored", async () => {
    const owner = await createUser("U4 backfill owner");
    const recipient = await createUser("U4 backfill recipient");
    const other = await createUser("U4 backfill other");
    const noteId = await newNote(owner);
    await shareDirectly(owner, noteId, [recipient.userId]);
    // An image stored the old way (an ordinary Files item in the note's folder) and someone else's.
    const old = (await upload(owner, "old.png", PNG)).id;
    const others = (await upload(other, "others.png", PNG)).id;
    // The owner confirms their Files item (review M1); the version is theirs, so the backfill may link it.
    await publish(owner, noteId, `${image(old)}\n\n${image(others)}`, [old]);
    // As before U4: no links.
    db.query("DELETE FROM attachment_links WHERE host_kind = 'note' AND host_id = ?").run(noteId);
    expect(await contentStatus(recipient, old)).toBe(404);

    // The boot run already happened (and is not repeated); a forced run links the owner's image only.
    expect(await backfillNoteLinks()).toBeNull();
    const first = await backfillNoteLinks({ force: true });
    expect(first!.linked).toBeGreaterThanOrEqual(1);
    expect(linksOf(noteId)).toEqual([old]);
    expect(await contentStatus(recipient, old)).toBe(200);
    expect(await contentStatus(recipient, others)).toBe(404);
    const again = await backfillNoteLinks({ force: true });
    expect(linksOf(noteId)).toEqual([old]);
    expect(again!.failed).toBe(0);

    // A draft upload older than a day survives the orphan sweep while the draft shows it (U0's
    // reference check, review M3); an unreferenced one of the same age goes to the Bin.
    const draftNote = await newNote(owner);
    const kept = (await upload(owner, "draft.png", PNG, { attachTo: "note" })).id;
    const stray = (await upload(owner, "stray.png", PNG, { attachTo: "note" })).id;
    await writeDraft(owner, draftNote, `# Draft\n\n${image(kept)}`);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    db.query(`UPDATE documents SET created_at = ?, updated_at = ? WHERE id IN (?, ?)`).run(twoDaysAgo, twoDaysAgo, kept, stray);
    resetReferenceCacheForTests();
    await sweepOrphanedAttachments();
    const deleted = (id: string) => (db.query("SELECT deleted_at FROM documents WHERE id = ?").get(id) as { deleted_at: string | null }).deleted_at;
    expect(deleted(kept)).toBeNull();
    expect(deleted(stray)).not.toBeNull();

    // Publishing a note that shows one of your binned files reports it; restoring it and syncing links it
    // without a new version (POST …/attachments/sync, the caller's own files only).
    await shareDirectly(owner, draftNote, [recipient.userId]);
    const published = await publish(owner, draftNote, `# Draft\n\n${image(kept)}\n\n${image(stray, "stray.png")}`);
    expect(published.binnedAttachments).toEqual([stray]);
    expect(published.skippedAttachments).toBe(1);
    expect(await contentStatus(recipient, stray)).toBe(404);
    expect((await api(owner, "POST", `/bin/document/${stray}/restore`, {})).status).toBe(200);
    const synced = await api(owner, "POST", `/notes/${draftNote}/attachments/sync`, {});
    expect(synced.body).toMatchObject({ linked: 1, skippedAttachments: 0, binnedAttachments: [] });
    expect(await contentStatus(recipient, stray)).toBe(200);
    // Nobody else can sync: a reader gets 404, and a stranger's sync links nothing of theirs.
    expect((await api(recipient, "POST", `/notes/${draftNote}/attachments/sync`, {})).status).toBe(404);
    expect((await api(other, "POST", `/notes/${draftNote}/attachments/sync`, {})).status).toBe(404);
    // A file that is already linked and then binned is reported too (it shows broken just the same).
    expect((await api(owner, "DELETE", `/files/${kept}`, {})).status).toBe(200);
    const again2 = await publish(owner, draftNote, `# Draft v2\n\n${image(kept)}\n\n${image(stray, "stray.png")}`);
    expect(again2.binnedAttachments).toEqual([kept]);
  }, 30_000);

  test("MCP: read_note lists the note's files as the reader may open them; publish_note_draft reports skipped files", async () => {
    const owner = await createUser("U4 mcp owner");
    const reader = await createUser("U4 mcp reader");
    const other = await createUser("U4 mcp other");
    const noteId = await newNote(owner);
    await shareDirectly(owner, noteId, [reader.userId]);
    const file = await uploadAttachment(owner, "notes.txt", "Meeting notes", "note");
    const foreign = await uploadAttachment(other, "foreign.txt", "nope", "note");
    await publish(owner, noteId, `# Notes\n\n${chip(file, "notes.txt")}`);

    const readKey = createApiKey(reader.userId, { name: "Reader", surfaces: "mcp", grants: [{ module: "notes", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 90 }).id;
    const read = JSON.parse((await invokeMcpToolForTests("read_note", { noteId }, readKey)).content[0]!.text) as Json;
    expect(read.attachments).toEqual([{ id: file, name: "notes.txt", mimeType: expect.any(String), sizeBytes: 13 }]);
    const text = await invokeMcpToolForTests("read_attachment_text", { hostKind: "note", hostId: noteId, documentId: file }, readKey);
    expect(text.isError).toBeFalsy();
    expect(text.content[0]!.text).toContain("Meeting notes");

    const publishKey = createApiKey(owner.userId, { name: "Publisher", surfaces: "mcp", grants: [{ module: "notes", permission: "publish", resourceKind: null, resourceId: null }, { module: "notes", permission: "draft", resourceKind: null, resourceId: null }], expiresInDays: 90 }).id;
    const draft = JSON.parse((await invokeMcpToolForTests("update_note_draft", { noteId, baseRevision: null, markdown: `# Notes\n\n${chip(file, "notes.txt")}\n\n${chip(foreign, "foreign.txt")}` }, publishKey)).content[0]!.text) as Json;
    await invokeMcpToolForTests("get_note_draft", { noteId }, publishKey);
    const published = await invokeMcpToolForTests("publish_note_draft", { noteId, revision: draft.revision }, publishKey);
    expect(published.isError).toBeFalsy();
    expect(JSON.parse(published.content[0]!.text)).toMatchObject({ skippedAttachments: 1 });
    expect(await contentStatus(reader, foreign)).toBe(404);
  }, 30_000);
});

describe("whiteboards (U4b, Q4: pictures follow board sharing)", () => {
  const imageEl = (id: string, fileId: string) => ({ id, type: "image", x: 0, y: 50, width: 64, height: 64, angle: 0, strokeColor: "transparent", backgroundColor: "transparent", fileId, status: "pending", scale: [1, 1], version: 1 });
  const sceneWith = (ids: string[]) => ({
    type: "excalidraw", version: 2, source: "test", appState: {},
    elements: ids.map((id, index) => imageEl(`img${index}`, id)),
    files: Object.fromEntries(ids.map((id) => [id, { id, mimeType: "image/png", nookDocumentId: id }]))
  });
  const boardLinks = (boardId: string) => (db.query("SELECT document_id FROM attachment_links WHERE host_kind = 'whiteboard' AND host_id = ?").all(boardId) as Array<{ document_id: string }>).map((row) => row.document_id).sort();

  test("the owner's pictures open for everyone who can open the board; others' stay per viewer; unshare and Bin revoke", async () => {
    const owner = await createUser("U4b board owner");
    const reader = await createUser("U4b board reader");
    const other = await createUser("U4b board other");
    const board = (await api(owner, "POST", "/whiteboards", { name: "Plan" })).body.whiteboard.id as string;
    const mine = (await upload(owner, "mine.png", PNG, { attachTo: "whiteboard" })).id;
    const legacy = (await upload(owner, "legacy.png", PNG)).id;
    const theirs = (await upload(other, "theirs.png", PNG)).id;
    expect((await api(other, "PUT", `/files/${theirs}/sharing`, { visibility: "selected", userIds: [owner.userId] })).status).toBe(200);

    expect((await api(owner, "PUT", `/whiteboards/${board}/scene`, { baseRevision: 1, scene: sceneWith([mine, legacy, theirs]) })).status).toBe(200);
    expect(boardLinks(board)).toEqual([mine, legacy].sort());
    for (const id of [mine, legacy, theirs]) expect(await contentStatus(reader, id)).toBe(404);
    expect((await api(owner, "PUT", `/files/${board}/sharing`, { visibility: "selected", userIds: [reader.userId] })).status).toBe(200);
    expect(await contentStatus(reader, mine)).toBe(200);
    expect(await contentStatus(reader, legacy)).toBe(200);
    expect(await contentStatus(reader, theirs)).toBe(404);

    // MCP read_whiteboard names the shared pictures.
    const key = createApiKey(reader.userId, { name: "Board reader", surfaces: "mcp", grants: [{ module: "whiteboards", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 90 }).id;
    const read = JSON.parse((await invokeMcpToolForTests("read_whiteboard", { id: board }, key)).content[0]!.text) as Json;
    expect(read.attachments.map((item: Json) => item.id).sort()).toEqual([mine, legacy].sort());

    // A picture removed from the board stops following it.
    expect((await api(owner, "PUT", `/whiteboards/${board}/scene`, { baseRevision: 2, scene: sceneWith([mine]) })).status).toBe(200);
    expect(await contentStatus(reader, legacy)).toBe(404);
    // Unshare, then the Bin, revoke.
    expect((await api(owner, "PUT", `/files/${board}/sharing`, { visibility: "private" })).status).toBe(200);
    expect(await contentStatus(reader, mine)).toBe(404);
    expect((await api(owner, "PUT", `/files/${board}/sharing`, { visibility: "selected", userIds: [reader.userId] })).status).toBe(200);
    expect(await contentStatus(reader, mine)).toBe(200);
    expect((await api(owner, "DELETE", `/files/${board}`)).status).toBe(200);
    expect(await contentStatus(reader, mine)).toBe(404);
    expect(boardLinks(board)).toEqual([mine]);
  }, 30_000);

  test("existing boards are backfilled once; a recipient's copy never links the owner's pictures", async () => {
    const owner = await createUser("U4b backfill owner");
    const reader = await createUser("U4b backfill reader");
    const board = (await api(owner, "POST", "/whiteboards", { name: "Old board" })).body.whiteboard.id as string;
    const picture = (await upload(owner, "old.png", PNG)).id;
    expect((await api(owner, "PUT", `/whiteboards/${board}/scene`, { baseRevision: 1, scene: sceneWith([picture]) })).status).toBe(200);
    db.query("DELETE FROM attachment_links WHERE host_kind = 'whiteboard' AND host_id = ?").run(board);
    expect((await api(owner, "PUT", `/files/${board}/sharing`, { visibility: "selected", userIds: [reader.userId] })).status).toBe(200);
    expect(await contentStatus(reader, picture)).toBe(404);
    expect(await backfillWhiteboardLinks()).toBeNull();
    await backfillWhiteboardLinks({ force: true });
    expect(boardLinks(board)).toEqual([picture]);
    expect(await contentStatus(reader, picture)).toBe(200);

    const copy = await api(reader, "POST", `/whiteboards/${board}/duplicate`, {});
    expect(copy.status).toBe(201);
    expect(boardLinks(copy.body.whiteboard.id)).toEqual([]);
  }, 30_000);
});

