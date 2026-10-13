import { describe, expect, test } from "bun:test";
import { createUser, db, type Session } from "./support/harness";
import { api, contentStatus, upload, uploadAttachment } from "./support/attachments";

const { backfillNoteLinks } = await import("../server/noteAttachments");

/**
 * v0.35.0 security review M1 (T350): a person's file becomes readable through a note only when they
 * put it there or confirmed it. An editor who plants the owner's private file in the shared draft
 * never shares it: the owner's next publish asks first (409 CONFIRM_REQUIRED), and the boot backfill
 * never links a reference an editor introduced.
 */

const chip = (id: string, name = "x.txt") => `[📎 ${name}](/files/${id})`;
const linksOf = (noteId: string) => (db.query("SELECT document_id FROM attachment_links WHERE host_kind = 'note' AND host_id = ? ORDER BY position").all(noteId) as Array<{ document_id: string }>).map((row) => row.document_id);
const versionOf = (noteId: string) => (db.query("SELECT current_version FROM notes WHERE id = ?").get(noteId) as { current_version: number }).current_version;

async function save(session: Session, noteId: string, markdown: string) {
  const note = (await api(session, "GET", `/notes/${noteId}`)).body.note;
  const saved = await api(session, "PUT", `/notes/${noteId}/draft`, { revision: note.draft_revision ?? null, markdown });
  expect(saved.status).toBe(200);
  return saved.body.revision as number;
}

async function publish(session: Session, noteId: string, markdown: string, confirmAttachments?: string[]) {
  const revision = await save(session, noteId, markdown);
  return api(session, "POST", `/notes/${noteId}/publish`, { revision, ...(confirmAttachments ? { confirmAttachments } : {}) });
}

async function sharedNote(owner: Session, editor: Session, reader: Session) {
  const noteId = (await api(owner, "POST", "/notes", {})).body.note.id as string;
  expect((await api(owner, "PUT", `/notes/${noteId}/sharing`, { visibility: "selected", userIds: [editor.userId, reader.userId] })).status).toBe(200);
  db.query("UPDATE note_shares SET level = 'edit' WHERE note_id = ? AND user_id = ?").run(noteId, editor.userId);
  expect((await publish(owner, noteId, "# Team page")).status).toBe(200);
  return noteId;
}

describe("publish (review M1)", () => {
  test("an editor plants the owner's private file; the owner's next publish asks first and shares nothing until confirmed", async () => {
    const owner = await createUser("inj owner");
    const editor = await createUser("inj editor");
    const reader = await createUser("inj reader");
    // The owner's private Files item (Default folder), shared with the editor only.
    const secret = (await upload(owner, "salaries.txt", "salary table")).id;
    expect((await api(owner, "PUT", `/files/${secret}/sharing`, { visibility: "selected", userIds: [editor.userId] })).status).toBe(200);
    expect(await contentStatus(editor, secret)).toBe(200);
    expect(await contentStatus(reader, secret)).toBe(404);
    const noteId = await sharedNote(owner, editor, reader);

    // The editor appends a chip pointing at the owner's file; their own publish links nothing (T350).
    const planted = `# Team page\n\n${chip(secret, "notes.txt")}`;
    const byEditor = await publish(editor, noteId, planted);
    expect(byEditor.status).toBe(200);
    expect(byEditor.body.skippedAttachments).toBe(1);
    expect(await contentStatus(reader, secret)).toBe(404);

    // The owner fixes a typo and publishes: 409 CONFIRM_REQUIRED, naming the file and the audience; nothing published.
    const before = versionOf(noteId);
    const asked = await publish(owner, noteId, planted.replace("Team page", "Team page."));
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ code: "CONFIRM_REQUIRED", files: [{ id: secret, name: "salaries.txt" }], audience: { visibility: "selected", people: 2, groups: 0 } });
    expect(versionOf(noteId)).toBe(before);
    expect(linksOf(noteId)).toEqual([]);
    expect(await contentStatus(reader, secret)).toBe(404);

    // A confirm for some other id changes nothing.
    expect((await api(owner, "POST", `/notes/${noteId}/publish`, { confirmAttachments: [crypto.randomUUID()] })).status).toBe(409);
    // Confirmed explicitly: published and shared through the note.
    const confirmed = await api(owner, "POST", `/notes/${noteId}/publish`, { confirmAttachments: [secret.toUpperCase()] });
    expect(confirmed.status).toBe(200);
    expect(linksOf(noteId)).toEqual([secret]);
    expect(await contentStatus(reader, secret)).toBe(200);
    // Already linked: later publishes keep it without asking again.
    expect((await publish(owner, noteId, `${planted}\n\nMore`)).status).toBe(200);
    expect(linksOf(noteId)).toEqual([secret]);
  }, 30_000);

  test("the owner's own Attachments-folder upload still links silently; someone else's file is never linked", async () => {
    const owner = await createUser("inj silent owner");
    const editor = await createUser("inj silent editor");
    const reader = await createUser("inj silent reader");
    const noteId = await sharedNote(owner, editor, reader);
    const picture = await uploadAttachment(owner, "photo.txt", "a photo", "note");
    const theirs = (await upload(editor, "theirs.txt", "theirs")).id;
    const published = await publish(owner, noteId, `# Team page\n\n${chip(picture, "photo.txt")}\n\n${chip(theirs)}`);
    expect(published.status).toBe(200);
    expect(published.body.skippedAttachments).toBe(1);
    expect(linksOf(noteId)).toEqual([picture]);
    expect(await contentStatus(reader, picture)).toBe(200);
    expect(await contentStatus(reader, theirs)).toBe(404);
  }, 30_000);

  test("an approved agent draft asks the same way: it stays pending until the owner confirms", async () => {
    const { createApiKey } = await import("../server/apiKeys");
    const { invokeMcpToolForTests } = await import("../server/mcpTools");
    const owner = await createUser("inj approve owner");
    const reader = await createUser("inj approve reader");
    const noteId = (await api(owner, "POST", "/notes", {})).body.note.id as string;
    expect((await api(owner, "PUT", `/notes/${noteId}/sharing`, { visibility: "selected", userIds: [reader.userId] })).status).toBe(200);
    expect((await publish(owner, noteId, "# Plan")).status).toBe(200);
    const secret = (await upload(owner, "plan.txt", "private plan")).id;
    const key = createApiKey(owner.userId, { name: "Drafter", surfaces: "mcp", grants: [
      { module: "notes", permission: "draft", resourceKind: null, resourceId: null },
      { module: "inbox", permission: "write", resourceKind: null, resourceId: null }
    ], expiresInDays: 30 }).id;
    const submitted = await invokeMcpToolForTests("submit_proposals", { proposals: [{ kind: "note_draft", title: "Plan", rationale: "update", payload: { noteId, markdown: `# Plan\n\n${chip(secret, "plan.txt")}`, baseRevision: null } }] }, key);
    const proposalId = JSON.parse(submitted.content[0]!.text).results[0].proposalId as string;
    const asked = await api(owner, "POST", `/inbox/proposals/${proposalId}/approve`, {});
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ code: "CONFIRM_REQUIRED", status: "pending", files: [{ id: secret, name: "plan.txt" }] });
    expect((db.query("SELECT status FROM proposals WHERE id = ?").get(proposalId) as { status: string }).status).toBe("pending");
    // Bulk approval leaves it pending too.
    const bulk = await api(owner, "POST", "/inbox/proposals/bulk", { action: "approve", ids: [proposalId] });
    expect(bulk.body.results[0]).toMatchObject({ status: "pending", code: "CONFIRM_REQUIRED" });
    expect(await contentStatus(reader, secret)).toBe(404);
    const approved = await api(owner, "POST", `/inbox/proposals/${proposalId}/approve`, { confirmAttachments: [secret] });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("applied");
    expect(await contentStatus(reader, secret)).toBe(200);
  }, 30_000);
});

describe("boot backfill (review M1)", () => {
  test("links the owner's Attachments files and Files items the owner introduced; never one an editor introduced", async () => {
    const owner = await createUser("bf owner");
    const editor = await createUser("bf editor");
    const reader = await createUser("bf reader");
    const noteId = await sharedNote(owner, editor, reader);
    const ownPasted = (await upload(owner, "pasted.txt", "an old paste")).id;
    const attachment = await uploadAttachment(owner, "att.txt", "attachment", "note");
    const planted = (await upload(owner, "private.txt", "private")).id;
    // v2 by the owner introduces their own Files item (confirmed), v3 by the editor plants another,
    // v4 by the owner (confirming it, as pre-0.35 owners never had to) keeps everything.
    expect((await publish(owner, noteId, `# Team\n\n${chip(ownPasted)}`, [ownPasted])).status).toBe(200);
    expect((await publish(editor, noteId, `# Team\n\n${chip(ownPasted)}\n\n${chip(planted)}`)).status).toBe(200);
    expect((await publish(owner, noteId, `# Team.\n\n${chip(ownPasted)}\n\n${chip(planted)}\n\n${chip(attachment)}`, [planted])).status).toBe(200);
    // As before 0.35: no links at all.
    db.query("DELETE FROM attachment_links WHERE host_kind = 'note' AND host_id = ?").run(noteId);

    const counts = await backfillNoteLinks({ force: true });
    expect(counts!.failed).toBe(0);
    expect(counts!.withheld).toBeGreaterThanOrEqual(1);
    expect(linksOf(noteId).sort()).toEqual([ownPasted, attachment].sort());
    expect(await contentStatus(reader, ownPasted)).toBe(200);
    expect(await contentStatus(reader, attachment)).toBe(200);
    expect(await contentStatus(reader, planted)).toBe(404);
    // The owner's next publish asks about the planted file.
    const next = await publish(owner, noteId, `# Team!\n\n${chip(ownPasted)}\n\n${chip(planted)}\n\n${chip(attachment)}`);
    expect(next.status).toBe(409);
    expect(next.body.files).toEqual([{ id: planted, name: "private.txt" }]);
  }, 30_000);
});

describe("whiteboards (review M1)", () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwHxkzEC0AAPVGD/Hh+ukpAAAAAElFTkSuQmCC", "base64");
  const sceneOf = (ids: string[]) => ({
    type: "excalidraw", version: 2, source: "test", appState: {},
    elements: ids.map((id, index) => ({ id: `img${index}`, type: "image", x: 0, y: index * 70, width: 64, height: 64, angle: 0, strokeColor: "transparent", backgroundColor: "transparent", fileId: id, status: "pending", scale: [1, 1], version: 1 })),
    files: Object.fromEntries(ids.map((id) => [id, { id, mimeType: "image/png", nookDocumentId: id }]))
  });
  const boardLinks = (boardId: string) => (db.query("SELECT document_id FROM attachment_links WHERE host_kind = 'whiteboard' AND host_id = ?").all(boardId) as Array<{ document_id: string }>).map((row) => row.document_id);

  test("only the owner saves a board; a copy by someone else never links their Files picture someone else placed", async () => {
    const owner = await createUser("wb owner");
    const other = await createUser("wb other");
    // The other person's private Files picture, shared with the owner, who places it on their board.
    const theirs = (await upload(other, "theirs.png", PNG)).id;
    expect((await api(other, "PUT", `/files/${theirs}/sharing`, { visibility: "selected", userIds: [owner.userId] })).status).toBe(200);
    const mine = (await upload(owner, "mine.png", PNG)).id;
    const board = (await api(owner, "POST", "/whiteboards", { name: "Board" })).body.whiteboard;
    expect((await api(owner, "PUT", `/files/${board.id}/sharing`, { visibility: "selected", userIds: [other.userId] })).status).toBe(200);
    const saved = await api(owner, "PUT", `/whiteboards/${board.id}/scene`, { baseRevision: board.revision ?? 1, scene: sceneOf([mine, theirs]) });
    expect(saved.status).toBe(200);
    // The owner placed their own picture: it follows the board. The other person's never does (T350).
    expect(boardLinks(board.id)).toEqual([mine]);
    // A reader cannot save the board (the guard behind the non-owner policy).
    expect((await api(other, "PUT", `/whiteboards/${board.id}/scene`, { baseRevision: saved.body.revision, scene: sceneOf([theirs]) })).status).toBe(404);
    // The other person copies it: their own Files picture, which the owner placed, is not linked to the copy.
    const copy = await api(other, "POST", `/whiteboards/${board.id}/duplicate`, {});
    expect(copy.status).toBe(201);
    expect(boardLinks(copy.body.whiteboard.id)).toEqual([]);
  }, 30_000);
});
