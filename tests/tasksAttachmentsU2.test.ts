import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { api, attachmentsFolderOf, contentStatus, defaultFolderOf, documentRow, filesList, upload } from "./support/attachments";
import { call, errorCode, makeKey, ok } from "./support/mcpClient";

const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { generatedCommentBody, isGeneratedCommentBody } = await import("../shared/commentFiles");

beforeEach(() => resetMcpLimits());

/**
 * Uploads everywhere U2 (plan §6 U2; D390, D395, D396, D397, D409; operator decisions Q2, Q12): card
 * and comment attachments as Attachments-folder files, the owner's own Files items behind a confirm
 * (relaxing D179), files-only comments, comment edits that add files, the Bin, and the MCP tools.
 */

const tasks = (session: Session, method: string, path: string, body?: unknown) => api(session, method, `/tasks${path}`, body);

async function board(label: string) {
  const owner = await createUser(`u2 ${label} owner`);
  const member = await createUser(`u2 ${label} member`);
  const stranger = await createUser(`u2 ${label} stranger`);
  const created = await tasks(owner, "POST", "/boards", { name: `${label} board` });
  expect(created.status).toBe(201);
  const boardId = created.body.board.id as string;
  const columnId = created.body.columns[0].id as string;
  expect((await tasks(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  const card = (await tasks(owner, "POST", `/boards/${boardId}/cards`, { columnId, title: `${label} card` })).body.card as { id: string };
  return { owner, member, stranger, boardId, columnId, cardId: card.id };
}

/** An upload made to attach to a card: an ordinary Files document in the uploader's Attachments folder. */
async function cardUpload(session: Session, name = "shot.png", content: string | Uint8Array = "image bytes") {
  const result = await upload(session, name, content, { attachTo: "card" });
  expect(result.status).toBe(201);
  return result.id;
}

async function filesItem(session: Session, name = "spec.txt", content = "The spec") {
  const result = await upload(session, name, content, { folderId: defaultFolderOf(session.userId) });
  expect(result.status).toBe(201);
  return result.id;
}

const deletedAt = (id: string) => documentRow(id)?.deleted_at ?? null;

describe("U2: generated bodies (Q12)", () => {
  test("one file is named, several are counted, and only a comment that still has files reads as files-only", () => {
    expect(generatedCommentBody(["screen.png"])).toBe("📎 screen.png");
    expect(generatedCommentBody(["a.png", "b.pdf", "c.txt"])).toBe("📎 3 files");
    expect(isGeneratedCommentBody("📎 screen.png", { count: 1, names: ["screen.png"] })).toBe(true);
    expect(isGeneratedCommentBody("📎 3 files", { count: 2, names: ["a.png", "b.pdf"] })).toBe(true);
    expect(isGeneratedCommentBody("📎 screen.png", { count: 0, names: [] })).toBe(false);
    expect(isGeneratedCommentBody("📎 see the other one", { count: 1, names: ["screen.png"] })).toBe(false);
    expect(isGeneratedCommentBody("Looks good", { count: 1, names: ["screen.png"] })).toBe(false);
  });
});

describe("U2: card attachments from the Attachments folder", () => {
  test("an upload with attachTo=card links, reads for board readers only, and stays out of their Files", async () => {
    const { owner, member, stranger, boardId, cardId } = await board("Folder");
    const documentId = await cardUpload(member, "photo.jpg");
    expect(documentRow(documentId)).toMatchObject({ purpose: "file", folder_id: attachmentsFolderOf(member.userId) });
    expect(await contentStatus(owner, documentId)).toBe(404);
    const linked = await tasks(member, "POST", `/cards/${cardId}/attachments`, { documentId });
    expect(linked.status).toBe(201);
    expect(linked.body.attachment).toMatchObject({ document_id: documentId, name: "photo.jpg", removed: 0 });
    expect(await contentStatus(owner, documentId)).toBe(200);
    expect(await contentStatus(stranger, documentId)).toBe(404);
    // The uploader finds it in Files; a board reader never sees it listed.
    expect(await filesList(member)).toContain(documentId);
    expect(await filesList(owner)).not.toContain(documentId);
    // Unsharing the board ends the reader's access at once (T340).
    expect((await tasks(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "private", userIds: [] })).status).toBe(200);
    expect(await contentStatus(owner, documentId)).toBe(200);
    expect((await tasks(owner, "GET", `/cards/${cardId}`)).body.attachments).toHaveLength(1);
  });

  test("a card holds 50 and a comment 10, counting Attachments-folder files", async () => {
    const { owner, cardId } = await board("Caps");
    const ids = [];
    for (let index = 0; index < 11; index += 1) ids.push(await cardUpload(owner, `f${index}.txt`, `file ${index}`));
    const tooMany = await tasks(owner, "POST", `/cards/${cardId}/comments`, { body: "", attachmentIds: ids });
    expect(tooMany.status).toBe(400);
    const ten = await tasks(owner, "POST", `/cards/${cardId}/comments`, { body: "", attachmentIds: ids.slice(0, 10) });
    expect(ten.status).toBe(201);
    const capped = await tasks(owner, "POST", `/cards/${cardId}/attachments`, { documentId: ids[10], commentId: ten.body.comment.id });
    expect(capped.status).toBe(409);
    expect(capped.body.code).toBe("LIMIT_REACHED");
    const now = new Date().toISOString();
    const folderId = attachmentsFolderOf(owner.userId);
    const insert = db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, purpose, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'application/octet-stream', 'none', 1, ?, 'file', ?, ?)`);
    const link = db.query("INSERT INTO card_attachments (card_id, document_id, linked_by, created_at) VALUES (?, ?, ?, ?)");
    for (let index = 0; index < 40; index += 1) {
      const id = crypto.randomUUID();
      insert.run(id, owner.userId, folderId, `bulk-${index}.bin`, "0".repeat(64), now, now);
      link.run(cardId, id, owner.userId, now);
    }
    const full = await tasks(owner, "POST", `/cards/${cardId}/attachments`, { documentId: ids[10] });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("LIMIT_REACHED");
  });
});

describe("U2: the owner's own Files items (Q2, D396 relaxing D179)", () => {
  test("need the confirm, are the owner's only, and are never binned by link changes", async () => {
    const { owner, member, stranger, cardId } = await board("From Files");
    const spec = await filesItem(member, "spec.txt");
    const theirs = await filesItem(owner, "owner-only.txt");
    // Without the confirm: 409 with the file's name, and nothing is linked.
    const refused = await tasks(member, "POST", `/cards/${cardId}/attachments`, { documentId: spec });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "CONFIRM_REQUIRED", documentName: "spec.txt" });
    expect(await contentStatus(owner, spec)).toBe(404);
    // Someone else's file is the same 404 as a missing one, confirmed or not (T341).
    expect((await tasks(member, "POST", `/cards/${cardId}/attachments`, { documentId: theirs, confirmed: true })).status).toBe(404);
    expect((await tasks(member, "POST", `/cards/${cardId}/attachments`, { documentId: crypto.randomUUID(), confirmed: true })).status).toBe(404);

    const linked = await tasks(member, "POST", `/cards/${cardId}/attachments`, { documentId: spec, confirmed: true });
    expect(linked.status).toBe(201);
    expect(await contentStatus(owner, spec)).toBe(200);
    expect(await contentStatus(stranger, spec)).toBe(404);
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = 'task.attachment_link' ORDER BY rowid DESC LIMIT 1").get(member.userId) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({ documentId: spec, fromFiles: true });
    // It stays in its folder; removing it from the card never bins it.
    expect(documentRow(spec)?.folder_id).toBe(defaultFolderOf(member.userId));
    const removed = await tasks(member, "DELETE", `/cards/${cardId}/attachments/${spec}`);
    expect(removed.body).toEqual({ ok: true, movedToBin: false });
    expect(deletedAt(spec)).toBeNull();
    expect(await contentStatus(owner, spec)).toBe(404);
  });

  test("a comment takes a confirmed Files item; the new-card form takes one with attachmentsConfirmed", async () => {
    const { owner, member, boardId, columnId, cardId } = await board("From Files comment");
    const spec = await filesItem(member, "notes.md", "# Notes");
    expect((await tasks(member, "POST", `/cards/${cardId}/comments`, { body: "See", attachmentIds: [spec] })).body.code).toBe("CONFIRM_REQUIRED");
    expect((await tasks(owner, "GET", `/cards/${cardId}`)).body.comments).toEqual([]);
    const posted = await tasks(member, "POST", `/cards/${cardId}/comments`, { body: "See", attachmentIds: [spec], confirmed: true });
    expect(posted.status).toBe(201);
    const fresh = await cardUpload(member, "draft.png");
    const otherSpec = await filesItem(member, "plan.txt");
    const refused = await tasks(member, "POST", `/boards/${boardId}/cards`, { columnId, title: "New", attachmentIds: [fresh, otherSpec] });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("CONFIRM_REQUIRED");
    const created = await tasks(member, "POST", `/boards/${boardId}/cards`, { columnId, title: "New", attachmentIds: [fresh, otherSpec], attachmentsConfirmed: true });
    expect(created.status).toBe(201);
    const view = await tasks(owner, "GET", `/cards/${created.body.card.id}`);
    expect(view.body.attachments.map((item: { document_id: string }) => item.document_id).sort()).toEqual([fresh, otherSpec].sort());
    // An upload already on a card cannot seed another new card; a Files item can be on several.
    expect((await tasks(member, "POST", `/boards/${boardId}/cards`, { columnId, title: "Again", attachmentIds: [fresh] })).body.code).toBe("ATTACHMENT_LINKED");
    expect((await tasks(member, "POST", `/boards/${boardId}/cards`, { columnId, title: "Again", attachmentIds: [otherSpec], attachmentsConfirmed: true })).status).toBe(201);
  });
});

describe("U2: files-only comments (D397, Q12) and adding files while editing", () => {
  test("a comment with files and no text stores the generated body; without files it is refused", async () => {
    const { owner, member, cardId } = await board("Files only");
    expect((await tasks(member, "POST", `/cards/${cardId}/comments`, { body: "   " })).status).toBe(400);
    expect((await tasks(member, "POST", `/cards/${cardId}/comments`, {})).status).toBe(400);
    const shot = await cardUpload(member, "screenshot.png");
    const one = await tasks(member, "POST", `/cards/${cardId}/comments`, { attachmentIds: [shot] });
    expect(one.status).toBe(201);
    expect(one.body.comment.body).toBe("📎 screenshot.png");
    const two = await tasks(member, "POST", `/cards/${cardId}/comments`, { body: "", attachmentIds: [await cardUpload(member, "a.pdf"), await cardUpload(member, "b.pdf")] });
    expect(two.body.comment.body).toBe("📎 2 files");
    // Files that are on the card already would leave the comment empty: refused, nothing stored.
    const count = (await tasks(owner, "GET", `/cards/${cardId}`)).body.comments.length;
    const again = await tasks(member, "POST", `/cards/${cardId}/comments`, { body: "", attachmentIds: [shot] });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ATTACHMENT_LINKED");
    expect((await tasks(owner, "GET", `/cards/${cardId}`)).body.comments).toHaveLength(count);
    // Text with files keeps the text.
    const texted = await tasks(member, "POST", `/cards/${cardId}/comments`, { body: "Repro", attachmentIds: [await cardUpload(member, "c.png")] });
    expect(texted.body.comment.body).toBe("Repro");
  });

  test("the author adds files while editing (≤ 10); a generated body follows; blank text needs files", async () => {
    const { owner, member, cardId } = await board("Edit files");
    const first = await cardUpload(member, "first.png");
    const comment = (await tasks(member, "POST", `/cards/${cardId}/comments`, { attachmentIds: [first] })).body.comment as { id: string; body: string };
    expect(comment.body).toBe("📎 first.png");
    const second = await cardUpload(member, "second.png");
    expect((await tasks(owner, "PATCH", `/comments/${comment.id}`, { attachmentIds: [second] })).status).toBe(403);
    const edited = await tasks(member, "PATCH", `/comments/${comment.id}`, { attachmentIds: [second] });
    expect(edited.status).toBe(200);
    expect(edited.body.comment.body).toBe("📎 2 files");
    expect(edited.body.comment.edited_at).toBeTruthy();
    const view = await tasks(owner, "GET", `/cards/${cardId}`);
    expect(view.body.attachments.filter((item: { comment_id: string }) => item.comment_id === comment.id)).toHaveLength(2);
    // Writing text replaces the generated body; blanking it again regenerates it.
    expect((await tasks(member, "PATCH", `/comments/${comment.id}`, { body: "Two shots" })).body.comment.body).toBe("Two shots");
    expect((await tasks(member, "PATCH", `/comments/${comment.id}`, { body: "" })).body.comment.body).toBe("📎 2 files");
    // A text-only comment cannot be blanked.
    const plain = (await tasks(member, "POST", `/cards/${cardId}/comments`, { body: "Words" })).body.comment as { id: string };
    expect((await tasks(member, "PATCH", `/comments/${plain.id}`, { body: " " })).status).toBe(400);
    expect((await tasks(member, "PATCH", `/comments/${plain.id}`, {})).status).toBe(400);
    // The per-comment cap applies to edits too.
    const more = [];
    for (let index = 0; index < 9; index += 1) more.push(await cardUpload(member, `m${index}.txt`, `m${index}`));
    const capped = await tasks(member, "PATCH", `/comments/${comment.id}`, { attachmentIds: more });
    expect(capped.status).toBe(409);
    expect(capped.body.code).toBe("LIMIT_REACHED");
    expect((await tasks(member, "PATCH", `/comments/${comment.id}`, { attachmentIds: more.slice(0, 8) })).status).toBe(200);
  });
});

describe("U2: the file's owner may always withdraw it (U0 review M1)", () => {
  test("below edit through Tasks, and after losing the board through the generic route; others stay refused", async () => {
    const { owner, member, boardId, cardId } = await board("Owner unlink");
    const mine = await cardUpload(member, "mine.png");
    const other = await cardUpload(member, "other.png");
    await tasks(member, "POST", `/cards/${cardId}/attachments`, { documentId: mine });
    await tasks(member, "POST", `/cards/${cardId}/attachments`, { documentId: other });
    const ownerFile = await cardUpload(owner, "owner.png");
    await tasks(owner, "POST", `/cards/${cardId}/attachments`, { documentId: ownerFile });
    db.query("UPDATE board_members SET level = 'comment' WHERE board_id = ? AND user_id = ?").run(boardId, member.userId);
    // Someone else's file at comment level: refused.
    expect((await tasks(member, "DELETE", `/cards/${cardId}/attachments/${ownerFile}`)).status).toBe(403);
    expect((await tasks(member, "DELETE", `/cards/${cardId}/attachments/${mine}`)).body).toEqual({ ok: true, movedToBin: true });
    // Unshared entirely: the generic route still withdraws it, telling nothing about the card.
    expect((await tasks(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "private", userIds: [] })).status).toBe(200);
    expect((await tasks(member, "DELETE", `/cards/${cardId}/attachments/${other}`)).status).toBe(404);
    const withdrawn = await api(member, "DELETE", `/attachments/card/${cardId}/${other}`);
    expect(withdrawn.status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS count FROM card_attachments WHERE card_id = ?").get(cardId)).toEqual({ count: 1 });
  });
});

describe("U2: Bin (D395, D409)", () => {
  test("deleting a comment bins its Attachments-folder files but never a linked Files item", async () => {
    const { owner, member, cardId } = await board("Comment bin");
    const upload1 = await cardUpload(member, "bug.png");
    const spec = await filesItem(member, "keep.txt");
    const comment = (await tasks(member, "POST", `/cards/${cardId}/comments`, { body: "", attachmentIds: [upload1, spec], confirmed: true })).body.comment as { id: string };
    expect((await tasks(owner, "DELETE", `/comments/${comment.id}`)).status).toBe(200);
    expect(deletedAt(upload1)).toBeTruthy();
    expect(deletedAt(spec)).toBeNull();
    expect(await contentStatus(owner, upload1)).toBe(404);
    expect(await contentStatus(owner, spec)).toBe(404);
  });

  test("binning the card hides its files; restore brings them back; purge bins Attachments-folder files only", async () => {
    const { owner, member, cardId } = await board("Card bin");
    const shot = await cardUpload(owner, "card.png");
    const spec = await filesItem(owner, "owner-spec.txt");
    await tasks(owner, "POST", `/cards/${cardId}/attachments`, { documentId: shot });
    await tasks(owner, "POST", `/cards/${cardId}/attachments`, { documentId: spec, confirmed: true });
    expect(await contentStatus(member, shot)).toBe(200);
    expect((await tasks(owner, "DELETE", `/cards/${cardId}`)).status).toBe(200);
    expect(await contentStatus(member, shot)).toBe(404);
    expect(deletedAt(shot)).toBeNull();
    expect((await api(owner, "POST", `/bin/card/${cardId}/restore`, {})).status).toBe(200);
    expect(await contentStatus(member, shot)).toBe(200);
    expect(await contentStatus(member, spec)).toBe(200);
    expect((await tasks(owner, "DELETE", `/cards/${cardId}`)).status).toBe(200);
    expect((await api(owner, "DELETE", `/bin/card/${cardId}`)).status).toBe(200);
    expect(deletedAt(shot)).toBeTruthy();
    expect(deletedAt(spec)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM card_attachments WHERE card_id = ?").get(cardId)).toEqual({ count: 0 });
  });

  test("a purge audits document.delete only for files it really binned (no stale .changes after the cascade)", async () => {
    const { owner, cardId } = await board("Purge audit");
    const spec = await filesItem(owner, "stays.txt");
    const legacy = await upload(owner, "legacy.png", "png bytes", {});
    // An older hidden upload that its owner already binned (still linked, as after a D409-style delete).
    const hidden = db.query("SELECT id FROM documents WHERE id = ?").get(legacy.id) ? legacy.id : "";
    db.query("UPDATE documents SET purpose = 'task_attachment', folder_id = NULL WHERE id = ?").run(hidden);
    await tasks(owner, "POST", `/cards/${cardId}/attachments`, { documentId: hidden });
    await tasks(owner, "POST", `/cards/${cardId}/attachments`, { documentId: spec, confirmed: true });
    const binnedAt = new Date().toISOString();
    db.query("UPDATE documents SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ?").run(binnedAt, owner.userId, binnedAt, hidden);
    const before = (db.query("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'document.delete'").get() as { count: number }).count;
    // The comment path too: deleting a comment cascades its links, then nothing is binned.
    const viaComment = await filesItem(owner, "comment-spec.txt");
    const comment = (await tasks(owner, "POST", `/cards/${cardId}/comments`, { body: "", attachmentIds: [viaComment], confirmed: true })).body.comment as { id: string };
    expect((await tasks(owner, "DELETE", `/comments/${comment.id}`)).status).toBe(200);
    expect(deletedAt(viaComment)).toBeNull();
    expect((await tasks(owner, "DELETE", `/cards/${cardId}`)).status).toBe(200);
    expect((await api(owner, "DELETE", `/bin/card/${cardId}`)).status).toBe(200);
    const after = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'document.delete' ORDER BY rowid DESC LIMIT ?").all(
      (db.query("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'document.delete'").get() as { count: number }).count - before) as Array<{ metadata_json: string }>;
    expect(after).toEqual([]);
    expect(deletedAt(spec)).toBeNull();
    expect(deletedAt(hidden)).toBe(binnedAt);
  });

  test("a linked file deleted from Files shows as removed until its owner restores it", async () => {
    const { owner, member, cardId } = await board("Removed");
    const shot = await cardUpload(member, "gone.png");
    await tasks(member, "POST", `/cards/${cardId}/attachments`, { documentId: shot });
    expect((await request(`/files/${shot}`, { method: "DELETE", body: "{}" }, member)).status).toBe(200);
    const view = await tasks(owner, "GET", `/cards/${cardId}`);
    expect(view.body.attachments).toEqual([expect.objectContaining({ document_id: shot, removed: 1, name: "", size_bytes: 0 })]);
    expect(await contentStatus(owner, shot)).toBe(404);
    const key = makeKey(owner, ["tasks:read"]);
    const card = await ok(key, "get_card", { cardId });
    expect(card.attachments).toEqual([]);
    expect(card.files).toEqual([{ id: shot, removed: true, commentId: null }]);
    expect((await api(member, "POST", `/bin/document/${shot}/restore`, {})).status).toBe(200);
    expect(documentRow(shot)?.folder_id).toBe(attachmentsFolderOf(member.userId));
    expect((await tasks(owner, "GET", `/cards/${cardId}`)).body.attachments[0]).toMatchObject({ name: "gone.png", removed: 0 });
    expect(await contentStatus(owner, shot)).toBe(200);
  });
});

describe("U2: MCP and REST", () => {
  test("comment_on_card attaches the user's uploads, with or without text", async () => {
    const { owner, member, cardId } = await board("MCP comment");
    const key = makeKey(member, ["tasks:write", "files:write"]);
    const stored = await ok(key, "create_text_file", { name: "log.txt", text: "trace", purpose: "attachment" });
    const documentId = (stored.document?.id ?? stored.id) as string;
    expect(documentRow(documentId)?.folder_id).toBe(attachmentsFolderOf(member.userId));
    const posted = await ok(key, "comment_on_card", { cardId, attachmentIds: [documentId] });
    expect(posted.comment).toMatchObject({ body: "📎 log.txt", attachmentIds: [documentId] });
    expect(await errorCode(key, "comment_on_card", { cardId, body: "" })).toBe("INVALID");
    // Someone else's file is NOT_FOUND; a Files item needs link_attachment's confirm.
    const theirs = await cardUpload(owner, "theirs.txt");
    expect(await errorCode(key, "comment_on_card", { cardId, body: "x", attachmentIds: [theirs] })).toBe("NOT_FOUND");
    const spec = await filesItem(member, "spec.md", "# Spec");
    const refused = await call(key, "comment_on_card", { cardId, body: "x", attachmentIds: [spec] });
    expect(refused.value).toMatchObject({ code: "INVALID", reason: "CONFIRM_REQUIRED" });
    // A reader reads it back through the generic tool, with the card's read scope.
    const readKey = makeKey(owner, ["tasks:read"]);
    const files = (await ok(readKey, "get_card", { cardId })).files as Array<{ id: string; name: string; commentId: string }>;
    expect(files).toEqual([expect.objectContaining({ id: documentId, name: "log.txt", commentId: posted.comment.id })]);
    expect((await ok(readKey, "read_attachment_text", { hostKind: "card", hostId: cardId, documentId })).text).toBe("trace");
  });

  test("link_attachment takes uploads, and a Files item only with confirmed and Read files over it", async () => {
    const { member, cardId } = await board("MCP link");
    const spec = await filesItem(member, "brief.txt");
    const tasksOnly = makeKey(member, ["tasks:write"]);
    expect(await errorCode(tasksOnly, "link_attachment", { cardId, documentId: spec, confirmed: true })).toBe("NOT_FOUND");
    const withFiles = makeKey(member, ["tasks:write", "files:read"]);
    expect((await call(withFiles, "link_attachment", { cardId, documentId: spec })).value).toMatchObject({ code: "INVALID", reason: "CONFIRM_REQUIRED" });
    const linked = await ok(withFiles, "link_attachment", { cardId, documentId: spec, confirmed: true });
    expect(linked).toMatchObject({ alreadyLinked: false, attachment: { documentId: spec, name: "brief.txt" } });
    const upload2 = await cardUpload(member, "photo.png");
    expect((await ok(tasksOnly, "link_attachment", { cardId, documentId: upload2 })).alreadyLinked).toBe(false);
  });

  test("the generic list route refuses card links (HOST_MANAGED) but lists the card's files for its readers", async () => {
    const { owner, member, stranger, cardId } = await board("Generic");
    const shot = await cardUpload(member, "g.png");
    await tasks(member, "POST", `/cards/${cardId}/attachments`, { documentId: shot });
    const listed = await api(owner, "GET", `/attachments/card/${cardId}`);
    expect(listed.status).toBe(200);
    expect(listed.body.attachments).toEqual([expect.objectContaining({ documentId: shot, name: "g.png", removed: false })]);
    expect((await api(stranger, "GET", `/attachments/card/${cardId}`)).status).toBe(404);
    expect((await api(member, "POST", `/attachments/card/${cardId}`, { documentId: shot })).body.code).toBe("HOST_MANAGED");
  });
});
