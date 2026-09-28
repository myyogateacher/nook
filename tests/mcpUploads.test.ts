import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { api, auditRows, call, errorCode, makeKey, ok, toolNames, type Key } from "./support/mcpClient";

const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { chargeUploadBytes, DAILY_UPLOAD_BYTES_PER_USER, expireUploadTicketForTests, resetUploadTickets } = await import("../server/mcpFileTools");

beforeEach(() => {
  resetMcpLimits();
  resetUploadTickets();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const documentRow = (id: string) => db.query("SELECT folder_id, purpose, preview_kind, mime_type, size_bytes, upload_key, deleted_at FROM documents WHERE id = ?").get(id) as Record<string, any> | null;
const defaultFolder = (session: Session) => (db.query("SELECT id FROM folders WHERE owner_id = ? AND is_default = 1").get(session.userId) as { id: string } | null)?.id;

function put(key: Pick<Key, "token">, uploadId: string, body: Uint8Array, headers: Record<string, string> = {}) {
  return fetch(`${origin}/mcp/uploads/${uploadId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "application/octet-stream", ...headers },
    body
  });
}

describe("create_text_file (D176a)", () => {
  test("stores private text, refuses NUL and oversize text, and audits with the key", async () => {
    const owner = await createUser("Text file owner");
    const other = await createUser("Text file other");
    const key = makeKey(owner, ["files:write"]);
    expect(await toolNames(makeKey(owner, ["files:read"]))).not.toContain("create_text_file");
    const stored = await ok(key, "create_text_file", { name: "report.md", text: "# Report\n\nAll good." });
    expect(stored.document).toMatchObject({ name: "report.md", preview_kind: "text" });
    expect(documentRow(stored.document.id)).toMatchObject({ folder_id: defaultFolder(owner), purpose: "file", preview_kind: "text" });
    expect(auditRows(owner.userId, "document.upload").at(-1)).toMatchObject({ documentId: stored.document.id, via: "mcp", keyId: key.id });
    expect(await errorCode(key, "create_text_file", { name: "bad.txt", text: "a\u0000b" })).toBe("INVALID");
    expect(await errorCode(key, "create_text_file", { name: "bad.txt", text: "lone \ud800 surrogate" })).toBe("INVALID");
    expect(await errorCode(key, "create_text_file", { name: "big.txt", text: "x".repeat(1_048_577) })).toBe("TOO_LARGE");
    const foreign = (await api(other, "POST", "/folders", { name: "Other's" })).body.folder.id as string;
    expect(await errorCode(key, "create_text_file", { name: "sneak.txt", text: "hi", folderId: foreign })).toBe("NOT_FOUND");
    // Read it back through the read tool.
    const reader = makeKey(owner, ["files:read"]);
    expect((await ok(reader, "read_document_text", { documentId: stored.document.id })).text).toBe("# Report\n\nAll good.");
  });

  test("a task attachment has no folder and links to a card", async () => {
    const owner = await createUser("Text attachment owner");
    const key = makeKey(owner, ["files:write", "tasks:write"]);
    const created = await api(owner, "POST", "/tasks/boards", { name: "Attach board" });
    const cardId = (await api(owner, "POST", `/tasks/boards/${created.body.board.id}/cards`, { columnId: created.body.columns[0].id, title: "Card" })).body.card.id as string;
    const stored = await ok(key, "create_text_file", { name: "notes.csv", text: "a,b\n1,2\n", purpose: "task_attachment" });
    expect(documentRow(stored.document.id)).toMatchObject({ folder_id: null, purpose: "task_attachment" });
    expect(await errorCode(key, "create_text_file", { name: "x.txt", text: "x", purpose: "task_attachment", folderId: defaultFolder(owner)! })).toBe("INVALID");
    expect((await ok(key, "link_attachment", { cardId, documentId: stored.document.id })).alreadyLinked).toBe(false);
  });
});

describe("ticketed uploads (D176b, T146)", () => {
  test("begin, PUT with the same key, finish; a retried PUT is an idempotent replay", async () => {
    const owner = await createUser("Upload happy");
    const key = makeKey(owner, ["files:write"]);
    const begun = await ok(key, "begin_upload", { name: "pixel.png", sizeBytes: PNG.byteLength, sha256: sha(PNG) });
    expect(begun).toMatchObject({ method: "PUT", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(PNG.byteLength) } });
    expect(begun.uploadUrl).toBe(`${origin}/mcp/uploads/${begun.uploadId}`);
    expect(await errorCode(key, "finish_upload", { uploadId: begun.uploadId })).toBe("UPLOAD_PENDING");
    const first = await put(key, begun.uploadId, PNG);
    expect(first.status).toBe(201);
    const document = ((await first.json()) as { document: { id: string } }).document;
    expect(documentRow(document.id)).toMatchObject({ preview_kind: "image", mime_type: "image/png", upload_key: begun.uploadId, folder_id: defaultFolder(owner) });
    const again = await put(key, begun.uploadId, PNG);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ idempotentReplay: true, document: { id: document.id } });
    expect((await ok(key, "finish_upload", { uploadId: begun.uploadId })).document.id).toBe(document.id);
    expect(auditRows(owner.userId, "document.upload").filter((row) => row.documentId === document.id)).toEqual([expect.objectContaining({ via: "mcp", keyId: key.id })]);
    // The ticket is used up.
    expect(await errorCode(key, "finish_upload", { uploadId: begun.uploadId })).toBe("NOT_FOUND");
  });

  test("an invalid key is 401, another key's ticket is 404, and the URL alone is useless", async () => {
    const owner = await createUser("Upload wrong key");
    const key = makeKey(owner, ["files:write"]);
    const otherKey = makeKey(owner, ["files:write"]);
    const begun = await ok(key, "begin_upload", { name: "pixel.png", sizeBytes: PNG.byteLength, sha256: sha(PNG) });
    expect((await put({ token: `mynotes_${"x".repeat(43)}` }, begun.uploadId, PNG)).status).toBe(401);
    expect((await fetch(`${origin}/mcp/uploads/${begun.uploadId}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: PNG })).status).toBe(401);
    expect((await put(otherKey, begun.uploadId, PNG)).status).toBe(404);
    expect(await errorCode(otherKey, "finish_upload", { uploadId: begun.uploadId })).toBe("NOT_FOUND");
    // A key without files:write cannot upload even with the right ticket id.
    const readOnly = makeKey(owner, ["files:read"]);
    expect((await put(readOnly, begun.uploadId, PNG)).status).toBe(403);
    expect(await errorCode(key, "finish_upload", { uploadId: begun.uploadId })).toBe("UPLOAD_PENDING");
  });

  test("a body of another length is 400 and can be retried; a wrong type is 400", async () => {
    const owner = await createUser("Upload length");
    const key = makeKey(owner, ["files:write"]);
    const begun = await ok(key, "begin_upload", { name: "pixel.png", sizeBytes: PNG.byteLength, sha256: sha(PNG) });
    expect(await (await put(key, begun.uploadId, PNG.subarray(0, 10))).json()).toMatchObject({ code: "SIZE_MISMATCH" });
    expect((await put(key, begun.uploadId, PNG, { "Content-Type": "image/png" })).status).toBe(400);
    expect((await put(key, begun.uploadId, PNG)).status).toBe(201);
  });

  test("a hash mismatch commits nothing and finish_upload reports HASH_MISMATCH", async () => {
    const owner = await createUser("Upload hash");
    const key = makeKey(owner, ["files:write"]);
    const begun = await ok(key, "begin_upload", { name: "pixel.png", sizeBytes: PNG.byteLength, sha256: "0".repeat(64) });
    const response = await put(key, begun.uploadId, PNG);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "HASH_MISMATCH" });
    expect(db.query("SELECT 1 FROM documents WHERE upload_key = ?").get(begun.uploadId)).toBeNull();
    expect((await put(key, begun.uploadId, PNG)).status).toBe(409);
    expect(await errorCode(key, "finish_upload", { uploadId: begun.uploadId })).toBe("HASH_MISMATCH");
  });

  test("an expired ticket is UPLOAD_EXPIRED, at most three are open per key, and oversize is TOO_LARGE", async () => {
    const owner = await createUser("Upload expiry");
    const key = makeKey(owner, ["files:write"]);
    const begun = await ok(key, "begin_upload", { name: "pixel.png", sizeBytes: PNG.byteLength, sha256: sha(PNG) });
    expireUploadTicketForTests(begun.uploadId);
    expect((await put(key, begun.uploadId, PNG)).status).toBe(404);
    expect(await errorCode(key, "finish_upload", { uploadId: begun.uploadId })).toBe("UPLOAD_EXPIRED");
    for (let index = 0; index < 3; index += 1) await ok(key, "begin_upload", { name: `f${index}.png`, sizeBytes: 10, sha256: sha(PNG) });
    expect(await errorCode(key, "begin_upload", { name: "f4.png", sizeBytes: 10, sha256: sha(PNG) })).toBe("LIMIT_REACHED");
    expect(await errorCode(makeKey(owner, ["files:write"]), "begin_upload", { name: "huge.bin", sizeBytes: 64 * 1024 * 1024, sha256: sha(PNG) })).toBe("TOO_LARGE");
  });

  test("open tickets reserve the daily byte budget; failure and expiry release it; commit re-checks (L3)", async () => {
    const owner = await createUser("Upload budget");
    const key = makeKey(owner, ["files:write"]);
    chargeUploadBytes(owner.userId, DAILY_UPLOAD_BYTES_PER_USER - 100);
    const body = new Uint8Array(90).fill(7);
    const first = await ok(key, "begin_upload", { name: "blob.bin", sizeBytes: 90, sha256: "0".repeat(64) });
    expect(await errorCode(key, "begin_upload", { name: "blob.bin", sizeBytes: 90, sha256: "0".repeat(64) })).toBe("RATE_LIMITED");
    expect(await errorCode(key, "begin_upload", { name: "blob.bin", sizeBytes: 90, sha256: "0".repeat(64) })).toBe("RATE_LIMITED");
    // The first fails (hash mismatch): its reservation is released.
    expect((await put(key, first.uploadId, body)).status).toBe(400);
    const second = await ok(key, "begin_upload", { name: "blob.bin", sizeBytes: 90, sha256: "0".repeat(64) });
    expect(await errorCode(key, "begin_upload", { name: "blob.bin", sizeBytes: 90, sha256: "0".repeat(64) })).toBe("RATE_LIMITED");
    // Expiry releases it too.
    expireUploadTicketForTests(second.uploadId);
    const third = await ok(key, "begin_upload", { name: "blob.bin", sizeBytes: 90, sha256: sha(body) });
    // Commit re-checks: charged bytes that grew meanwhile refuse the PUT, and nothing is stored.
    chargeUploadBytes(owner.userId, 20);
    const refused = await put(key, third.uploadId, body);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(db.query("SELECT 1 FROM documents WHERE upload_key = ?").get(third.uploadId)).toBeNull();
    // The refused ticket stays open (retryable) and still holds its reservation.
    expect(await errorCode(key, "begin_upload", { name: "blob.bin", sizeBytes: 1, sha256: "0".repeat(64) })).toBe("RATE_LIMITED");
  });

  test("quota: refused at begin when it cannot fit, and 507 at commit when it filled up meanwhile", async () => {
    const owner = await createUser("Upload quota");
    const key = makeKey(owner, ["files:write"]);
    const begun = await ok(key, "begin_upload", { name: "pixel.png", sizeBytes: PNG.byteLength, sha256: sha(PNG) });
    const filler = crypto.randomUUID();
    const now = new Date().toISOString();
    db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, purpose, created_at, updated_at)
      VALUES (?, ?, NULL, 'filler.bin', 'application/octet-stream', 'none', ?, ?, 'file', ?, ?)`).run(filler, owner.userId, 12_582_912, "0".repeat(64), now, now);
    try {
      expect(await errorCode(key, "begin_upload", { name: "more.png", sizeBytes: PNG.byteLength, sha256: sha(PNG) })).toBe("QUOTA_EXCEEDED");
      const response = await put(key, begun.uploadId, PNG);
      expect(response.status).toBe(507);
      expect(db.query("SELECT 1 FROM documents WHERE upload_key = ?").get(begun.uploadId)).toBeNull();
    } finally {
      db.query("DELETE FROM documents WHERE id = ?").run(filler);
    }
  });

  test("an owner blocked after begin_upload gets 401 and nothing is committed (T80)", async () => {
    const owner = await createUser("Upload blocked");
    const key = makeKey(owner, ["files:write"]);
    const begun = await ok(key, "begin_upload", { name: "pixel.png", sizeBytes: PNG.byteLength, sha256: sha(PNG) });
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), owner.userId);
    try {
      expect((await put(key, begun.uploadId, PNG)).status).toBe(401);
      expect(db.query("SELECT 1 FROM documents WHERE upload_key = ?").get(begun.uploadId)).toBeNull();
    } finally {
      db.query("UPDATE users SET disabled_at = NULL WHERE id = ?").run(owner.userId);
    }
  });
});

describe("rename_file and move_file (D177, T147)", () => {
  test("renames owned files; a move that would change the audience of an inheriting file is AUDIENCE_CHANGE", async () => {
    const owner = await createUser("Move owner");
    const reader = await createUser("Move reader");
    const key = makeKey(owner, ["files:write"]);
    const file = (await ok(key, "create_text_file", { name: "plan.md", text: "# Plan" })).document as { id: string };
    expect((await ok(key, "rename_file", { documentId: file.id, name: "plan-v2.md" })).document.name).toBe("plan-v2.md");
    const privateFolder = (await ok(key, "create_folder", { name: "Private stuff" })).folder.id as string;
    const sharedFolder = (await ok(key, "create_folder", { name: "Shared stuff" })).folder.id as string;
    expect((await api(owner, "PUT", `/folders/${sharedFolder}/sharing`, { visibility: "selected", userIds: [reader.userId] })).status).toBe(200);
    // Private to private keeps the audience.
    expect((await ok(key, "move_file", { documentId: file.id, folderId: privateFolder })).document.folder_id).toBe(privateFolder);
    expect(await errorCode(key, "move_file", { documentId: file.id, folderId: sharedFolder })).toBe("AUDIENCE_CHANGE");
    expect(documentRow(file.id)!.folder_id).toBe(privateFolder);
    // With its own sharing the file moves freely.
    expect((await api(owner, "PUT", `/files/${file.id}/sharing`, { visibility: "private", userIds: [] })).status).toBe(200);
    expect((await ok(key, "move_file", { documentId: file.id, folderId: sharedFolder })).document.folder_id).toBe(sharedFolder);
    expect(auditRows(owner.userId, "document.move").at(-1)).toMatchObject({ documentId: file.id, via: "mcp", keyId: key.id });
    // Someone else's file, even one they can read, is NOT_FOUND.
    const readerKey = makeKey(reader, ["files:write"]);
    expect(await errorCode(readerKey, "rename_file", { documentId: file.id, name: "mine.md" })).toBe("NOT_FOUND");
    // The HTTP route still moves without the audience rule.
    const other = (await ok(key, "create_text_file", { name: "web.md", text: "web" })).document as { id: string };
    expect((await request(`/files/${other.id}`, { method: "PATCH", body: JSON.stringify({ folderId: sharedFolder }) }, owner)).status).toBe(200);
  });

  test("files:write lists the file tools, and no key lists a base64 or delete tool", async () => {
    const owner = await createUser("File tools list");
    const names = await toolNames(makeKey(owner, ["files:write"]));
    expect(names).toEqual(expect.arrayContaining(["begin_upload", "create_folder", "create_text_file", "finish_upload", "move_file", "rename_file"]));
    expect(names.some((name) => /base64|delete|share/.test(name))).toBe(false);
    expect((await call(makeKey(owner, ["files:read"]), "begin_upload", { name: "x", sizeBytes: 1, sha256: "0".repeat(64) })).value.code).toBe("SCOPE_REQUIRED");
  });
});
