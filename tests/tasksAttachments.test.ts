import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

function upload(session: Session, query: string, name = "shot.png", content: Uint8Array | string = PNG) {
  const form = new FormData();
  form.append("file", new Blob([content]), name);
  return request(`/files${query}`, { method: "POST", body: form }, session);
}

async function uploadAttachment(session: Session, name = "shot.png") {
  const response = await upload(session, "?purpose=task_attachment", name);
  expect(response.status).toBe(201);
  return ((await response.json()) as { document: { id: string; folder_id: string | null } }).document;
}

const content = (session: Session, id: string) => request(`/files/${id}/content`, {}, session);
const deletedAt = (id: string) => (db.query("SELECT deleted_at FROM documents WHERE id = ?").get(id) as { deleted_at: string | null }).deleted_at;

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const other = await createUser(`${label} other`);
  const stranger = await createUser(`${label} stranger`);
  const created = await call(owner, "POST", "/boards", { name: `${label} board` });
  const boardId = created.body.board.id as string;
  const columnId = created.body.columns[0].id as string;
  expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId, other.userId] })).status).toBe(200);
  const card = (await call(owner, "POST", `/boards/${boardId}/cards`, { columnId, title: "With files" })).body.card as { id: string };
  return { owner, member, other, stranger, boardId, columnId, cardId: card.id };
}

describe("card attachments", () => {
  test("attachment uploads have no folder, are never listed in Files, and reject unknown purposes", async () => {
    const owner = await createUser("Attachment uploader");
    const document = await uploadAttachment(owner);
    expect(document.folder_id).toBeNull();
    expect((db.query("SELECT purpose FROM documents WHERE id = ?").get(document.id) as { purpose: string }).purpose).toBe("task_attachment");
    const listed = (await (await request("/files", {}, owner)).json()) as { documents: Array<{ id: string }> };
    expect(listed.documents.some((item) => item.id === document.id)).toBe(false);
    const defaultFolder = (db.query("SELECT id FROM folders WHERE owner_id = ? AND is_default = 1").get(owner.userId) as { id: string }).id;
    expect((await upload(owner, `?purpose=task_attachment&folderId=${defaultFolder}`)).status).toBe(400);
    expect((await upload(owner, "?purpose=board_attachment")).status).toBe(400);
    // The uploader can read their own attachment.
    expect((await content(owner, document.id)).status).toBe(200);
  });

  test("linking makes the file readable to the board, never to strangers, and only the owner can link", async () => {
    const { owner, member, other, stranger, cardId } = await setup("Attach access");
    const document = await uploadAttachment(member);
    expect((await content(owner, document.id)).status).toBe(404);
    // Someone else's document, and a regular Files document, cannot be linked.
    expect((await call(owner, "POST", `/cards/${cardId}/attachments`, { documentId: document.id })).status).toBe(404);
    const filesUpload = await upload(member, "", "notes.txt", "plain");
    const filesDocument = ((await filesUpload.json()) as { document: { id: string } }).document;
    expect((await call(member, "POST", `/cards/${cardId}/attachments`, { documentId: filesDocument.id })).status).toBe(404);
    expect((await call(stranger, "POST", `/cards/${cardId}/attachments`, { documentId: document.id })).status).toBe(404);

    const linked = await call(member, "POST", `/cards/${cardId}/attachments`, { documentId: document.id });
    expect(linked.status).toBe(201);
    expect(linked.body.attachment).toMatchObject({ document_id: document.id, card_id: cardId, comment_id: null, linked_by: member.userId, name: "shot.png", preview_kind: "image" });
    expect((await call(member, "POST", `/cards/${cardId}/attachments`, { documentId: document.id })).status).toBe(200);
    expect((await call(other, "POST", `/cards/${cardId}/attachments`, { documentId: document.id })).status).toBe(404);

    const read = await content(other, document.id);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    expect((await request(`/files/${document.id}`, {}, owner)).status).toBe(200);
    expect((await content(stranger, document.id)).status).toBe(404);
    // Never listed in Files, even for readers through the board.
    const listed = (await (await request("/files", {}, other)).json()) as { documents: Array<{ id: string }> };
    expect(listed.documents.some((item) => item.id === document.id)).toBe(false);
    const card = await call(owner, "GET", `/cards/${cardId}`);
    expect(card.body.attachments.map((item: { document_id: string }) => item.document_id)).toEqual([document.id]);
    expect(card.body.card.attachment_count).toBe(1);
  });

  test("access ends as soon as the member is removed, the card is binned, or the comment is deleted", async () => {
    const { owner, member, other, boardId, columnId, cardId } = await setup("Attach revoke");
    const document = await uploadAttachment(owner);
    await call(owner, "POST", `/cards/${cardId}/attachments`, { documentId: document.id });
    expect((await content(member, document.id)).status).toBe(200);
    await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [other.userId] });
    expect((await content(member, document.id)).status).toBe(404);
    expect((await content(other, document.id)).status).toBe(200);
    await call(owner, "DELETE", `/cards/${cardId}`);
    expect((await content(other, document.id)).status).toBe(404);
    // Binning the card keeps the link (restore brings it back) and the file.
    expect(deletedAt(document.id)).toBeNull();

    const second = (await call(owner, "POST", `/boards/${boardId}/cards`, { columnId, title: "Comment files" })).body.card as { id: string };
    const viaComment = await uploadAttachment(other);
    const comment = await call(other, "POST", `/cards/${second.id}/comments`, { body: "See attached", attachmentIds: [viaComment.id] });
    expect(comment.status).toBe(201);
    const view = await call(owner, "GET", `/cards/${second.id}`);
    expect(view.body.attachments).toEqual([expect.objectContaining({ document_id: viaComment.id, comment_id: comment.body.comment.id })]);
    expect((await content(owner, viaComment.id)).status).toBe(200);
    // The board owner deletes the comment: the link goes and the file moves to its uploader's Bin.
    expect((await call(owner, "DELETE", `/comments/${comment.body.comment.id}`)).status).toBe(200);
    expect((await content(owner, viaComment.id)).status).toBe(404);
    expect(deletedAt(viaComment.id)).toBeTruthy();
    const bin = (await (await request("/bin", {}, other)).json()) as { items: Array<{ id: string }> };
    expect(bin.items.some((item) => item.id === viaComment.id)).toBe(true);
  });

  test("a comment may only attach the author's own files, within its caps", async () => {
    const { owner, member, cardId } = await setup("Comment files");
    const mine = await uploadAttachment(member);
    const theirs = await uploadAttachment(owner);
    expect((await call(member, "POST", `/cards/${cardId}/comments`, { body: "x", attachmentIds: [theirs.id] })).status).toBe(404);
    // The failed comment was not stored.
    expect((await call(owner, "GET", `/cards/${cardId}`)).body.comments).toEqual([]);
    const own = (await call(member, "POST", `/cards/${cardId}/comments`, { body: "mine" })).body.comment as { id: string };
    const foreignComment = (await call(owner, "POST", `/cards/${cardId}/comments`, { body: "owner's" })).body.comment as { id: string };
    expect((await call(member, "POST", `/cards/${cardId}/attachments`, { documentId: mine.id, commentId: foreignComment.id })).status).toBe(404);
    expect((await call(member, "POST", `/cards/${cardId}/attachments`, { documentId: mine.id, commentId: own.id })).status).toBe(201);

    const many = [];
    for (let index = 0; index < 11; index += 1) many.push(crypto.randomUUID());
    expect((await call(member, "POST", `/cards/${cardId}/comments`, { body: "too many", attachmentIds: many })).status).toBe(400);
    const timestamp = new Date().toISOString();
    const insertDocument = db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, purpose, created_at, updated_at)
      VALUES (?, ?, NULL, 'f.bin', 'application/octet-stream', 'none', 1, ?, 'task_attachment', ?, ?)`);
    const ten = Array.from({ length: 10 }, () => {
      const id = crypto.randomUUID();
      insertDocument.run(id, member.userId, "0".repeat(64), timestamp, timestamp);
      return id;
    });
    const refused = await call(member, "POST", `/cards/${cardId}/comments`, { body: "ten files", attachmentIds: ten });
    expect(refused.status).toBe(201);
    const eleventh = crypto.randomUUID();
    insertDocument.run(eleventh, member.userId, "0".repeat(64), timestamp, timestamp);
    const commentFull = refused.body.comment.id as string;
    const capped = await call(member, "POST", `/cards/${cardId}/attachments`, { documentId: eleventh, commentId: commentFull });
    expect(capped.status).toBe(409);
    expect(capped.body.code).toBe("LIMIT_REACHED");
  });

  test("attachments linked in the same millisecond list in linking order, whatever their random ids", async () => {
    const { owner, cardId } = await setup("Attach ties");
    const timestamp = new Date().toISOString();
    const insertDocument = db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, purpose, created_at, updated_at)
      VALUES (?, ?, NULL, 'f.bin', 'application/octet-stream', 'none', 1, ?, 'task_attachment', ?, ?)`);
    const link = db.query("INSERT INTO card_attachments (card_id, document_id, linked_by, created_at) VALUES (?, ?, ?, ?)");
    // Each later link gets a smaller document id, so a document-id tie-break would reverse them.
    const ids = Array.from({ length: 3 }, () => crypto.randomUUID()).sort().reverse();
    for (const id of ids) {
      insertDocument.run(id, owner.userId, "0".repeat(64), timestamp, timestamp);
      link.run(cardId, id, owner.userId, timestamp);
    }
    const card = await call(owner, "GET", `/cards/${cardId}`);
    expect(card.body.attachments.map((item: { document_id: string }) => item.document_id)).toEqual(ids);
  });

  test("a card holds at most 50 attachments", async () => {
    const { owner, cardId } = await setup("Attach cap");
    const timestamp = new Date().toISOString();
    const insertDocument = db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, purpose, created_at, updated_at)
      VALUES (?, ?, NULL, 'f.bin', 'application/octet-stream', 'none', 1, ?, 'task_attachment', ?, ?)`);
    const link = db.query("INSERT INTO card_attachments (card_id, document_id, linked_by, created_at) VALUES (?, ?, ?, ?)");
    for (let index = 0; index < 50; index += 1) {
      const id = crypto.randomUUID();
      insertDocument.run(id, owner.userId, "0".repeat(64), timestamp, timestamp);
      link.run(cardId, id, owner.userId, timestamp);
    }
    const extra = await uploadAttachment(owner);
    const refused = await call(owner, "POST", `/cards/${cardId}/attachments`, { documentId: extra.id });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("LIMIT_REACHED");
  });

  test("unlinking is for the linker or the board owner; the last unlink moves the file to the Bin", async () => {
    const { owner, member, other, boardId, columnId, cardId } = await setup("Attach unlink");
    const document = await uploadAttachment(member);
    const second = (await call(owner, "POST", `/boards/${boardId}/cards`, { columnId, title: "Second" })).body.card as { id: string };
    await call(member, "POST", `/cards/${cardId}/attachments`, { documentId: document.id });
    await call(member, "POST", `/cards/${second.id}/attachments`, { documentId: document.id });
    const forbidden = await call(other, "DELETE", `/cards/${cardId}/attachments/${document.id}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe("LINKER_ONLY");
    const first = await call(owner, "DELETE", `/cards/${cardId}/attachments/${document.id}`);
    expect(first.body).toEqual({ ok: true, movedToBin: false });
    expect(deletedAt(document.id)).toBeNull();
    expect((await content(other, document.id)).status).toBe(200);
    const last = await call(member, "DELETE", `/cards/${second.id}/attachments/${document.id}`);
    expect(last.body).toEqual({ ok: true, movedToBin: true });
    expect(deletedAt(document.id)).toBeTruthy();
    expect((db.query("SELECT deleted_by FROM documents WHERE id = ?").get(document.id) as { deleted_by: string }).deleted_by).toBe(member.userId);
    expect((await content(other, document.id)).status).toBe(404);
    expect((await call(member, "DELETE", `/cards/${second.id}/attachments/${document.id}`)).status).toBe(404);
    // A binned file cannot be linked again.
    expect((await call(member, "POST", `/cards/${cardId}/attachments`, { documentId: document.id })).status).toBe(404);
  });

  test("audits links with ids only", async () => {
    const { member, cardId, boardId } = await setup("Attach audit");
    const document = await uploadAttachment(member, "secret-plan.png");
    await call(member, "POST", `/cards/${cardId}/attachments`, { documentId: document.id });
    await call(member, "DELETE", `/cards/${cardId}/attachments/${document.id}`);
    const events = db.query("SELECT event_type, metadata_json FROM audit_log WHERE actor_id = ? AND (event_type LIKE 'task.attachment_%' OR event_type = 'document.delete') ORDER BY created_at, rowid").all(member.userId) as Array<{ event_type: string; metadata_json: string }>;
    expect(events.map((event) => event.event_type)).toEqual(["task.attachment_link", "document.delete", "task.attachment_unlink"]);
    for (const event of events) expect(event.metadata_json).not.toContain("secret");
    expect(JSON.parse(events[0]!.metadata_json)).toEqual({ boardId, cardId, documentId: document.id });
  });
});

describe("never-linked attachments", () => {
  test("the sweeper bins task attachments with no link after 24 hours, in batches of 100", async () => {
    const { runSweep } = await import("../server/sweeper");
    const { sweepUnlinkedAttachments } = await import("../server/tasks/attachments");
    const { owner, cardId } = await setup("Unlinked sweep");
    const stale = await uploadAttachment(owner, "stale.png");
    const fresh = await uploadAttachment(owner, "fresh.png");
    const linked = await uploadAttachment(owner, "linked.png");
    await call(owner, "POST", `/cards/${cardId}/attachments`, { documentId: linked.id });
    const filesResponse = await upload(owner, "", "plain.txt", "plain");
    const plainFile = ((await filesResponse.json()) as { document: { id: string } }).document;
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
    for (const id of [stale.id, linked.id, plainFile.id]) db.query("UPDATE documents SET created_at = ? WHERE id = ?").run(old, id);

    await runSweep();
    expect(deletedAt(stale.id)).toBeTruthy();
    expect((db.query("SELECT deleted_by FROM documents WHERE id = ?").get(stale.id) as { deleted_by: string | null }).deleted_by).toBeNull();
    expect(deletedAt(fresh.id)).toBeNull();
    expect(deletedAt(linked.id)).toBeNull();
    expect(deletedAt(plainFile.id)).toBeNull();
    const bin = (await (await request("/bin", {}, owner)).json()) as { items: Array<{ id: string; attachment: boolean }> };
    expect(bin.items.find((item) => item.id === stale.id)).toMatchObject({ attachment: true });
    // With an injected clock a day later, the fresh one goes too.
    expect(sweepUnlinkedAttachments({ nowMs: Date.now() + 25 * 3_600_000 })).toBeGreaterThanOrEqual(1);
    expect(deletedAt(fresh.id)).toBeTruthy();
    const event = db.query("SELECT actor_id, metadata_json FROM audit_log WHERE event_type = 'document.delete' AND metadata_json LIKE ?").get(`%${stale.id}%`) as { actor_id: string | null; metadata_json: string };
    expect(event.actor_id).toBeNull();
    expect(JSON.parse(event.metadata_json)).toEqual({ documentId: stale.id, reason: "attachment_never_linked" });
  });

  test("one run bins at most 100", async () => {
    const { sweepUnlinkedAttachments } = await import("../server/tasks/attachments");
    const owner = await createUser("Unlinked batch");
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const insert = db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, purpose, created_at, updated_at)
      VALUES (?, ?, NULL, 'f.bin', 'application/octet-stream', 'none', 1, ?, 'task_attachment', ?, ?)`);
    db.transaction(() => { for (let index = 0; index < 105; index += 1) insert.run(crypto.randomUUID(), owner.userId, "0".repeat(64), old, old); })();
    // Other tests may leave their own stale rows; only this owner's are counted.
    let runs = 0;
    const live = () => (db.query("SELECT COUNT(*) AS count FROM documents WHERE owner_id = ? AND deleted_at IS NULL").get(owner.userId) as { count: number }).count;
    expect(sweepUnlinkedAttachments()).toBeLessThanOrEqual(100);
    runs += 1;
    while (live() > 0 && runs < 5) { sweepUnlinkedAttachments(); runs += 1; }
    expect(live()).toBe(0);
    expect(runs).toBeGreaterThanOrEqual(2);
  });
});

describe("Files routes and attachments", () => {
  test("rename, move, and sharing return 404 for attachments; delete needs the file unlinked", async () => {
    const { owner, stranger, cardId } = await setup("Files routes");
    const linked = await uploadAttachment(owner, "linked.png");
    const loose = await uploadAttachment(owner, "loose.png");
    await call(owner, "POST", `/cards/${cardId}/attachments`, { documentId: linked.id });
    const defaultFolder = (db.query("SELECT id FROM folders WHERE owner_id = ? AND is_default = 1").get(owner.userId) as { id: string }).id;
    const files = (method: string, path: string, body?: unknown) => request(`/files${path}`, { method, body: JSON.stringify(body ?? {}) }, owner);

    expect((await files("PATCH", `/${linked.id}`, { name: "renamed.png" })).status).toBe(404);
    expect((await files("PATCH", `/${linked.id}`, { folderId: defaultFolder })).status).toBe(404);
    expect((await files("PUT", `/${linked.id}/sharing`, { visibility: "all_users", userIds: [] })).status).toBe(404);
    expect((await request(`/files/${linked.id}/sharing`, {}, owner)).status).toBe(404);
    expect(db.query("SELECT name, folder_id, sharing_override FROM documents WHERE id = ?").get(linked.id)).toEqual({ name: "linked.png", folder_id: null, sharing_override: 0 });
    expect((await content(stranger, linked.id)).status).toBe(404);

    const refused = await files("DELETE", `/${linked.id}`);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("ATTACHMENT_LINKED");
    expect(deletedAt(linked.id)).toBeNull();
    // An unlinked attachment may be binned directly.
    expect((await files("DELETE", `/${loose.id}`)).status).toBe(200);
    expect(deletedAt(loose.id)).toBeTruthy();
  });

  test("discarding a composer upload bins it for its uploader only, and it restores into Files (T100)", async () => {
    const { owner, member, stranger } = await setup("Discard");
    const discarded = await uploadAttachment(member, "draft.png");
    // Nobody else can discard (or probe) someone's upload: 404 like a missing id.
    const missing = await request(`/files/${crypto.randomUUID()}`, { method: "DELETE", body: "{}" }, owner);
    expect(missing.status).toBe(404);
    const missingBody = await missing.json();
    for (const session of [owner, stranger]) {
      const refused = await request(`/files/${discarded.id}`, { method: "DELETE", body: "{}" }, session);
      expect(refused.status).toBe(404);
      expect(await refused.json()).toEqual(missingBody);
    }
    expect(deletedAt(discarded.id)).toBeNull();
    // The uploader discards it: it moves to their Bin as an attachment, and a second discard is idempotent.
    const binned = await request(`/files/${discarded.id}`, { method: "DELETE", body: "{}" }, member);
    expect(binned.status).toBe(200);
    expect(deletedAt(discarded.id)).toBeTruthy();
    expect(((await (await request(`/files/${discarded.id}`, { method: "DELETE", body: "{}" }, member)).json()) as { alreadyDeleted?: boolean }).alreadyDeleted).toBe(true);
    const bin = (await (await request("/bin", {}, member)).json()) as { items: Array<{ id: string; attachment: boolean }> };
    expect(bin.items.find((item) => item.id === discarded.id)).toMatchObject({ attachment: true });
    // Restoring an unlinked upload makes it an ordinary Files item.
    expect((await request(`/bin/document/${discarded.id}/restore`, { method: "POST", body: "{}" }, member)).status).toBe(200);
    expect(db.query("SELECT purpose, deleted_at FROM documents WHERE id = ?").get(discarded.id)).toMatchObject({ purpose: "file", deleted_at: null });
  });

  test("sharing rows on an attachment never widen its audience", async () => {
    const { owner, stranger } = await setup("Stale sharing");
    const document = await uploadAttachment(owner, "old.png");
    // As an attachment could have been shared before this fix.
    db.query("UPDATE documents SET sharing_override = 1, visibility = 'all_users' WHERE id = ?").run(document.id);
    expect((await content(stranger, document.id)).status).toBe(404);
    expect((await request(`/files/${document.id}`, {}, stranger)).status).toBe(404);
    expect((await content(owner, document.id)).status).toBe(200);
  });
});
