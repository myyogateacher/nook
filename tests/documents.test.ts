import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUser, dataDir, db, origin, port, request, type Session } from "./support/harness";

const documentStorage = await import("../server/documentStorage");
const { runSweep } = await import("../server/sweeper");
const { now } = await import("../server/db");

const documentsDir = join(dataDir, "documents");
const objectsDir = join(documentsDir, "objects");
const stagingDir = join(documentsDir, ".staging");
const objectPath = (id: string) => join(objectsDir, id);

function insertDocumentRow(ownerId: string, id: string, size: number, extra: { folderId?: string | null; name?: string } = {}) {
  const timestamp = now();
  db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'application/octet-stream', 'none', ?, ?, ?, ?)`)
    .run(id, ownerId, extra.folderId ?? null, extra.name ?? "fixture.bin", size, "0".repeat(64), timestamp, timestamp);
}

type UploadedDocument = Record<string, unknown> & { id: string; name: string; folder_id: string | null; mime_type: string; preview_kind: string; size_bytes: number; visibility: string };
const encoder = new TextEncoder();
const MAX_UPLOAD = 4_194_304;

function upload(session: Session, content: string | Uint8Array, filename: string, options: { folderId?: string; key?: string; field?: string; type?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  const form = new FormData();
  form.append(options.field ?? "file", new Blob([content], { type: options.type ?? "application/octet-stream" }), filename);
  const query = options.folderId === undefined ? "" : `?folderId=${options.folderId}`;
  const headers: Record<string, string> = { ...options.headers };
  if (options.key) headers["Idempotency-Key"] = options.key;
  return request(`/files${query}`, { method: "POST", body: form, headers, signal: options.signal }, session);
}

async function uploadOk(session: Session, content: string | Uint8Array, filename: string, options: Parameters<typeof upload>[3] = {}) {
  const response = await upload(session, content, filename, options);
  expect(response.status).toBe(201);
  return ((await response.json()) as { document: UploadedDocument }).document;
}

const boundary = "mynotes-test-boundary";
function multipart(parts: Array<{ name: string; filename?: string; content: string }>) {
  let body = "";
  for (const part of parts) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename === undefined ? "" : `; filename="${part.filename}"`}\r\n`;
    if (part.filename !== undefined) body += "Content-Type: application/octet-stream\r\n";
    body += `\r\n${part.content}\r\n`;
  }
  return `${body}--${boundary}--\r\n`;
}
const multipartType = `multipart/form-data; boundary=${boundary}`;

/** A multipart body that declares 100 kB, sends the part header and some bytes, then stalls until aborted. */
function stalledUpload(session: Session, controller: AbortController) {
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.bin"\r\n\r\n${"x".repeat(8192)}`);
  const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(head); }, pull: () => new Promise<void>(() => undefined) });
  return request("/files", { method: "POST", body, signal: controller.signal, headers: { "Content-Type": multipartType, "Content-Length": "100000" }, duplex: "half" } as RequestInit, session)
    .catch((error: Error) => error.name);
}

const listDir = (path: string) => existsSync(path) ? readdirSync(path) : [];
async function waitFor(condition: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(10);
  }
}

async function folderFor(session: Session, name: string) {
  const response = await request("/folders", { method: "POST", body: JSON.stringify({ name, parentId: null }) }, session);
  expect(response.status).toBe(201);
  return ((await response.json()) as { folder: { id: string } }).folder.id;
}

const defaultFolderOf = (userId: string) => (db.query("SELECT id FROM folders WHERE owner_id = ? AND is_default = 1").get(userId) as { id: string }).id;

async function writeObject(id: string, content: Uint8Array) {
  const { handle } = await documentStorage.createStagingFile(id);
  await handle.write(content);
  await handle.close();
  await documentStorage.commitStaged(id);
}

describe("document storage", () => {
  test("stages and commits objects under their UUID with private modes", async () => {
    const id = crypto.randomUUID();
    const { handle, path } = await documentStorage.createStagingFile(id);
    expect(path).toBe(join(stagingDir, `${id}.part`));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await handle.write(new TextEncoder().encode("hello"));
    await handle.close();
    await expect(documentStorage.createStagingFile(id)).rejects.toThrow();
    await documentStorage.commitStaged(id);
    expect(existsSync(path)).toBe(false);
    expect(statSync(objectPath(id)).mode & 0o777).toBe(0o600);
    expect(statSync(objectsDir).mode & 0o777).toBe(0o700);
    expect(statSync(stagingDir).mode & 0o777).toBe(0o700);
    expect(statSync(documentsDir).mode & 0o777).toBe(0o700);

    const opened = await documentStorage.openObjectForRead(id, 5);
    expect(opened.size).toBe(5);
    await opened.handle.close();
    await expect(documentStorage.openObjectForRead(id, 6)).rejects.toBeInstanceOf(documentStorage.DocumentIntegrityError);
    await documentStorage.removeObject(id);
    await documentStorage.removeObject(id);
    await expect(documentStorage.openObjectForRead(id, 5)).rejects.toBeInstanceOf(documentStorage.DocumentIntegrityError);
    await documentStorage.discardStaged(id);
  });

  test("rejects ids that are not UUIDs before building a path", async () => {
    for (const id of ["../mynotes.sqlite", "not-a-uuid", `${crypto.randomUUID()}/x`]) {
      await expect(documentStorage.createStagingFile(id)).rejects.toThrow("Invalid document id");
      await expect(documentStorage.openObjectForRead(id, 0)).rejects.toThrow("Invalid document id");
      await expect(documentStorage.removeObject(id)).rejects.toThrow("Invalid document id");
    }
  });
});

describe("document sweeper", () => {
  test("removes stale staging files and orphaned objects only", async () => {
    await runSweep();
    const owner = await createUser("Sweeper owner");
    const hourAgo = (Date.now() - 2 * 3_600_000) / 1000;

    const stale = crypto.randomUUID();
    const fresh = crypto.randomUUID();
    for (const id of [stale, fresh]) {
      const { handle } = await documentStorage.createStagingFile(id);
      await handle.close();
    }
    utimesSync(join(stagingDir, `${stale}.part`), hourAgo, hourAgo);

    const orphan = crypto.randomUUID();
    const freshOrphan = crypto.randomUUID();
    const live = crypto.randomUUID();
    await writeObject(orphan, new Uint8Array([1, 2, 3]));
    await writeObject(freshOrphan, new Uint8Array([1]));
    await writeObject(live, new Uint8Array([4, 5]));
    insertDocumentRow(owner.userId, live, 2);
    utimesSync(objectPath(orphan), hourAgo, hourAgo);
    utimesSync(objectPath(live), hourAgo, hourAgo);
    const stray = join(objectsDir, "notes.txt");
    writeFileSync(stray, "not a document", { mode: 0o600 });
    utimesSync(stray, hourAgo, hourAgo);

    const counts = await runSweep();
    expect(counts).not.toBeNull();
    expect(counts!.stagingRemoved).toBeGreaterThanOrEqual(1);
    expect(counts!.orphansRemoved).toBeGreaterThanOrEqual(1);
    expect(counts!.ignored).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(stagingDir, `${stale}.part`))).toBe(false);
    expect(existsSync(join(stagingDir, `${fresh}.part`))).toBe(true);
    expect(existsSync(objectPath(orphan))).toBe(false);
    expect(existsSync(objectPath(freshOrphan))).toBe(true);
    expect(existsSync(objectPath(live))).toBe(true);
    expect(existsSync(stray)).toBe(true);

    await documentStorage.discardStaged(fresh);
    await documentStorage.removeObject(freshOrphan);
    rmSync(stray);
  });

  test("boot mode also removes staging files left by an earlier process", async () => {
    await runSweep();
    const leftover = crypto.randomUUID();
    mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stagingDir, `${leftover}.part`), "partial", { mode: 0o600 });
    const tenMinutesAgo = (Date.now() - 600_000) / 1000;
    utimesSync(join(stagingDir, `${leftover}.part`), tenMinutesAgo, tenMinutesAgo);
    expect((await runSweep())!.stagingRemoved).toBe(0);
    expect(existsSync(join(stagingDir, `${leftover}.part`))).toBe(true);
    // At boot, staging files last modified before this process started are removed regardless of age.
    const beforeStart = (performance.timeOrigin - 1000) / 1000;
    utimesSync(join(stagingDir, `${leftover}.part`), beforeStart, beforeStart);
    expect((await runSweep({ boot: true }))!.stagingRemoved).toBe(1);
    expect(existsSync(join(stagingDir, `${leftover}.part`))).toBe(false);
  });
});

describe("document uploads", () => {
  test("stores the bytes under the UUID with private modes and a sanitized name", async () => {
    const owner = await createUser("Upload owner");
    const content = "# Plan\nhello \u00e9";
    const document = await uploadOk(owner, content, " q3:final\u202E\u200B.md ", { type: "text/html" });
    expect(document.name).toBe("q3-final.md");
    expect(document.mime_type).toBe("text/plain; charset=utf-8");
    expect(document.preview_kind).toBe("text");
    expect(document.size_bytes).toBe(Buffer.byteLength(content));
    expect(document.folder_id).toBe(defaultFolderOf(owner.userId));
    expect(document.is_owner).toBe(1);
    expect(document.visibility).toBe("private");
    for (const hidden of ["sha256", "upload_key", "path", "deleted_at", "purge_after", "deleted_by", "purge_started_at"]) expect(document).not.toHaveProperty(hidden);

    const row = db.query("SELECT * FROM documents WHERE id = ?").get(document.id) as { sha256: string; size_bytes: number; owner_id: string };
    expect(row.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(row.owner_id).toBe(owner.userId);
    expect(readFileSync(objectPath(document.id), "utf8")).toBe(content);
    expect(statSync(objectPath(document.id)).mode & 0o777).toBe(0o600);
    expect(statSync(objectsDir).mode & 0o777).toBe(0o700);
    expect(listDir(objectsDir).filter((name) => name.includes("q3"))).toEqual([]);
    expect(listDir(objectsDir)).toContain(document.id);

    const traversal = await request("/files", { method: "POST", body: multipart([{ name: "file", filename: "../../etc/passwd", content: "x" }]), headers: { "Content-Type": multipartType } }, owner);
    expect(traversal.status).toBe(201);
    const traversalDocument = ((await traversal.json()) as { document: UploadedDocument }).document;
    expect(traversalDocument.name).toBe("passwd");
    expect(existsSync(objectPath(traversalDocument.id))).toBe(true);
    const unnamed = await request("/files", { method: "POST", body: multipart([{ name: "file", filename: "...", content: "x" }]), headers: { "Content-Type": multipartType } }, owner);
    expect(((await unnamed.json()) as { document: UploadedDocument }).document.name).toBe("Untitled");
    expect(listDir(stagingDir).filter((name) => name.startsWith(document.id))).toEqual([]);

    const auditRow = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'document.upload' AND metadata_json LIKE ?").get(`%${document.id}%`) as { metadata_json: string };
    expect(JSON.parse(auditRow.metadata_json)).toEqual({ documentId: document.id, size: document.size_bytes, mimeType: "text/plain; charset=utf-8" });
  });

  test("uploads into owned folders only", async () => {
    const owner = await createUser("Folder owner");
    const other = await createUser("Folder other");
    const projects = await folderFor(owner, "Projects");
    expect((await uploadOk(owner, "a", "a.txt", { folderId: projects })).folder_id).toBe(projects);
    const shared = await folderFor(other, "Shared in");
    await request(`/folders/${shared}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "all_users", userIds: [] }) }, other);
    expect((await upload(owner, "a", "a.txt", { folderId: shared })).status).toBe(404);
    await request(`/folders/${shared}`, { method: "DELETE", body: "{}" }, other);
    expect((await upload(owner, "a", "a.txt", { folderId: defaultFolderOf(other.userId) })).status).toBe(404);
    expect((await upload(owner, "a", "a.txt", { folderId: "not-a-uuid" })).status).toBe(400);
  });

  test("rejects a declared Content-Length over the limit before reading the body", async () => {
    const owner = await createUser("Declared size");
    const socket = await new Promise<string>((resolve, reject) => {
      let received = "";
      Bun.connect({
        hostname: "localhost",
        port,
        socket: {
          open(connection) {
            connection.write([
              "POST /api/files HTTP/1.1",
              `Host: localhost:${port}`,
              `Origin: ${origin}`,
              `Cookie: ${owner.cookie}`,
              `X-CSRF-Token: ${owner.csrf}`,
              `Content-Type: ${multipartType}`,
              `Content-Length: ${MAX_UPLOAD + 70_000}`,
              "",
              ""
            ].join("\r\n"));
          },
          data(connection, data) {
            received += data.toString();
            if (received.includes("}")) {
              connection.end();
              resolve(received);
            }
          },
          error: (_connection, error) => reject(error),
          close: () => resolve(received)
        }
      }).catch(reject);
    });
    expect(socket).toStartWith("HTTP/1.1 413");
    expect(socket).toContain('"code":"FILE_TOO_LARGE"');
    expect(socket).toContain(`"limitBytes":${MAX_UPLOAD}`);
  });

  test("rejects a file that overflows the limit while streaming and keeps nothing", async () => {
    const owner = await createUser("Streamed size");
    const before = { staging: listDir(stagingDir).length, objects: listDir(objectsDir).length };
    const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n\r\n`);
    // Declared just under the early-413 threshold, but the file part itself exceeds the limit.
    const declared = MAX_UPLOAD + 60_000;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (sent === 0) {
          stream.enqueue(head);
          sent = head.byteLength;
        }
        if (sent >= declared) return stream.close();
        const size = Math.min(65_536, declared - sent);
        stream.enqueue(new Uint8Array(size).fill(0x61));
        sent += size;
      }
    });
    const response = await request("/files", { method: "POST", body, headers: { "Content-Type": multipartType, "Content-Length": String(declared) }, duplex: "half" } as RequestInit, owner);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "File is too large", code: "FILE_TOO_LARGE", limitBytes: MAX_UPLOAD });
    await waitFor(() => listDir(stagingDir).length === before.staging);
    expect(listDir(objectsDir).length).toBe(before.objects);
    expect(db.query("SELECT COUNT(*) AS count FROM documents WHERE owner_id = ?").get(owner.userId)).toEqual({ count: 0 });
  });

  test("accepts a file of exactly the limit", async () => {
    const owner = await createUser("Exact size");
    const document = await uploadOk(owner, new Uint8Array(MAX_UPLOAD), "exact.bin");
    expect(document.size_bytes).toBe(MAX_UPLOAD);
  });

  test("requires exactly one file part named file", async () => {
    const owner = await createUser("Part rules");
    const send = (body: string, type = multipartType) => request("/files", { method: "POST", body, headers: { "Content-Type": type } }, owner);
    const twoFiles = await send(multipart([{ name: "file", filename: "a.txt", content: "a" }, { name: "file", filename: "b.txt", content: "b" }]));
    expect(twoFiles.status).toBe(400);
    expect((await send(multipart([{ name: "file", filename: "a.txt", content: "a" }, { name: "note", content: "hi" }]))).status).toBe(400);
    expect((await send(multipart([{ name: "note", content: "hi" }, { name: "file", filename: "a.txt", content: "a" }]))).status).toBe(400);
    expect((await send(multipart([{ name: "upload", filename: "a.txt", content: "a" }]))).status).toBe(400);
    expect((await send(multipart([]))).status).toBe(400);
    expect((await send("garbage", "multipart/form-data")).status).toBe(400);
    expect((await send("plain", "text/plain")).status).toBe(415);
    expect((await request("/files", { method: "POST", body: JSON.stringify({ file: "x" }) }, owner)).status).toBe(415);
    expect(db.query("SELECT COUNT(*) AS count FROM documents WHERE owner_id = ?").get(owner.userId)).toEqual({ count: 0 });
    expect(listDir(stagingDir).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  test("rejects multipart bodies on every other mutation route", async () => {
    const owner = await createUser("Multipart elsewhere");
    const body = multipart([{ name: "file", filename: "a.txt", content: "a" }]);
    for (const [method, path] of [["POST", "/folders"], ["POST", "/notes"], ["POST", "/files/extra"], ["PUT", "/files"], ["POST", "/files/"]] as const) {
      const response = await request(path, { method, body, headers: { "Content-Type": multipartType } }, owner);
      expect(response.status).toBe(415);
    }
  });

  test("enforces session, Origin, and CSRF on uploads", async () => {
    const owner = await createUser("Upload guards");
    const form = () => {
      const data = new FormData();
      data.append("file", new Blob(["a"]), "a.txt");
      return data;
    };
    expect((await fetch(`${origin}/api/files`, { method: "POST", body: form(), headers: { Origin: origin } })).status).toBe(401);
    expect((await fetch(`${origin}/api/files`, { method: "POST", body: form(), headers: { Origin: origin, Cookie: owner.cookie } })).status).toBe(403);
    expect((await fetch(`${origin}/api/files`, { method: "POST", body: form(), headers: { Origin: "https://attacker.example", Cookie: owner.cookie, "X-CSRF-Token": owner.csrf } })).status).toBe(403);
    expect((await fetch(`${origin}/api/files`, { method: "POST", body: form(), headers: { Cookie: owner.cookie, "X-CSRF-Token": owner.csrf } })).status).toBe(403);
    expect((await fetch(`${origin}/api/files`, { method: "POST", body: form(), headers: { Origin: origin, Cookie: owner.cookie, "X-CSRF-Token": "wrong" } })).status).toBe(403);
  });

  test("applies the TOTP setup gate to document routes", async () => {
    const probe = Bun.spawnSync(["bun", "--no-env-file", join(import.meta.dir, "support", "totpRequiredProbe.ts")], { stdout: "pipe", stderr: "pipe" });
    const output = probe.stdout.toString().trim().split("\n").at(-1) ?? "";
    expect(JSON.parse(output)).toEqual({
      upload: { status: 403, code: "TOTP_SETUP_REQUIRED" },
      list: { status: 403, code: "TOTP_SETUP_REQUIRED" },
      content: { status: 403, code: "TOTP_SETUP_REQUIRED" }
    });
  }, 20_000);

  test("refuses uploads over the quota, counting binned documents", async () => {
    const owner = await createUser("Quota owner");
    const quota = 12_582_912;
    const filler = crypto.randomUUID();
    insertDocumentRow(owner.userId, filler, quota - 100);
    const full = await upload(owner, new Uint8Array(1000), "more.bin");
    expect(full.status).toBe(507);
    expect(((await full.json()) as { code: string }).code).toBe("QUOTA_EXCEEDED");
    const timestamp = now();
    db.query("UPDATE documents SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ?").run(timestamp, owner.userId, timestamp, filler);
    expect((await upload(owner, new Uint8Array(1000), "more.bin")).status).toBe(507);
    db.query("DELETE FROM documents WHERE id = ?").run(filler);
    await uploadOk(owner, new Uint8Array(1000), "fits.bin");
  });

  test("allows three concurrent uploads per user and releases slots after aborts", async () => {
    const owner = await createUser("Concurrent uploader");
    const other = await createUser("Concurrent other");
    const baseline = listDir(stagingDir).length;
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const pending = controllers.map((controller) => stalledUpload(owner, controller));
    await waitFor(() => listDir(stagingDir).length >= baseline + 3);
    const fourth = await upload(owner, "a", "a.txt");
    expect(fourth.status).toBe(429);
    expect(((await fourth.json()) as { code: string }).code).toBe("TOO_MANY_UPLOADS");
    await uploadOk(other, "a", "a.txt");
    for (const controller of controllers) controller.abort();
    expect(await Promise.all(pending)).toEqual(["AbortError", "AbortError", "AbortError"]);
    await waitFor(() => listDir(stagingDir).length === baseline);
    const after = await upload(owner, "b", "b.txt");
    expect(after.status).toBe(201);
    expect(db.query("SELECT COUNT(*) AS count FROM documents WHERE owner_id = ? AND name = 'slow.bin'").get(owner.userId)).toEqual({ count: 0 });
  });

  test("replays an Idempotency-Key per user without storing new bytes", async () => {
    const owner = await createUser("Idempotent owner");
    const other = await createUser("Idempotent other");
    const key = crypto.randomUUID();
    const first = await uploadOk(owner, "same bytes", "same.txt", { key });
    const objectsBefore = listDir(objectsDir).length;
    const replay = await upload(owner, "same bytes", "same.txt", { key });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { document: UploadedDocument; idempotentReplay: boolean };
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.document.id).toBe(first.id);
    expect(listDir(objectsDir).length).toBe(objectsBefore);
    expect(db.query("SELECT COUNT(*) AS count FROM documents WHERE owner_id = ? AND upload_key = ?").get(owner.userId, key)).toEqual({ count: 1 });
    const separate = await uploadOk(other, "same bytes", "same.txt", { key });
    expect(separate.id).not.toBe(first.id);
    expect((await upload(owner, "x", "x.txt", { key: "not-a-uuid" })).status).toBe(400);
  });

  test("a client abort mid-upload leaves no row and no staging file", async () => {
    const owner = await createUser("Abort owner");
    const baseline = listDir(stagingDir).length;
    const controller = new AbortController();
    const pending = stalledUpload(owner, controller);
    await waitFor(() => listDir(stagingDir).length > baseline);
    controller.abort();
    expect(await pending).toBe("AbortError");
    await waitFor(() => listDir(stagingDir).length === baseline);
    expect(db.query("SELECT COUNT(*) AS count FROM documents WHERE owner_id = ?").get(owner.userId)).toEqual({ count: 0 });
  });

  test("streams a near-limit upload without buffering it in memory", async () => {
    const owner = await createUser("Memory owner");
    const size = 3_900_000;
    const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="near-limit.bin"\r\n\r\n`);
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const chunk = new Uint8Array(16_384).fill(0x62);
    let sent = -1;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (sent < 0) {
          stream.enqueue(head);
          sent = 0;
        } else if (sent >= size) {
          stream.enqueue(tail);
          stream.close();
        } else {
          const bytes = Math.min(chunk.byteLength, size - sent);
          stream.enqueue(chunk.subarray(0, bytes));
          sent += bytes;
        }
      }
    });
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    let peak = before;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 2);
    const length = head.byteLength + size + tail.byteLength;
    const response = await request("/files", { method: "POST", body, headers: { "Content-Type": multipartType, "Content-Length": String(length) }, duplex: "half" } as RequestInit, owner);
    clearInterval(sampler);
    peak = Math.max(peak, process.memoryUsage().rss);
    expect(response.status).toBe(201);
    expect(((await response.json()) as { document: UploadedDocument }).document.size_bytes).toBe(size);
    const growth = peak - before;
    console.info(`RSS during a ${size}-byte streamed upload: before ${before} bytes, peak ${peak} bytes, growth ${growth} bytes`);
    // At this size RSS noise (heap growth in multi-MiB steps) is as large as the file, so this
    // is a logged measurement with a loose bound; the large-upload measurement is in the
    // commit that added streaming uploads.
    expect(growth).toBeLessThan(32 * 1_048_576);
  });
});

const json = async <T>(response: Response) => (await response.json()) as T;
const shareFolder = (session: Session, folderId: string, visibility: string, userIds: string[] = []) =>
  request(`/folders/${folderId}/sharing`, { method: "PUT", body: JSON.stringify({ visibility, userIds }) }, session);
const shareDocument = (session: Session, id: string, visibility: string, userIds: string[] = []) =>
  request(`/files/${id}/sharing`, { method: "PUT", body: JSON.stringify({ visibility, userIds }) }, session);
const patchDocument = (session: Session, id: string, body: unknown) =>
  request(`/files/${id}`, { method: "PATCH", body: JSON.stringify(body) }, session);
const deleteDocument = (session: Session, id: string) => request(`/files/${id}`, { method: "DELETE", body: "{}" }, session);

describe("document metadata and access", () => {
  test("notes and documents follow the same share matrix", async () => {
    const owner = await createUser("Matrix owner");
    const folderReader = await createUser("Matrix folder reader");
    const itemReader = await createUser("Matrix item reader");
    const unrelated = await createUser("Matrix unrelated");
    // T84: a guest is never in an all-users audience; one shared with by name still reads.
    const guest = await createUser("Matrix guest");
    const namedGuest = await createUser("Matrix named guest");
    db.query("UPDATE users SET role = 'guest' WHERE id IN (?, ?)").run(guest.userId, namedGuest.userId);
    const viewers = { owner, folderReader, itemReader, unrelated, guest, namedGuest };

    const sharedFolder = await folderFor(owner, "Matrix shared");
    expect((await shareFolder(owner, sharedFolder, "selected", [folderReader.userId, namedGuest.userId])).status).toBe(200);
    const everyoneFolder = await folderFor(owner, "Matrix everyone");
    expect((await shareFolder(owner, everyoneFolder, "all_users")).status).toBe(200);
    const privateFolder = await folderFor(owner, "Matrix private");
    const subfolderResponse = await request("/folders", { method: "POST", body: JSON.stringify({ name: "Matrix child", parentId: sharedFolder }) }, owner);
    const subfolder = (await json<{ folder: { id: string } }>(subfolderResponse)).folder.id;

    type Scenario = { name: string; folderId: string; sharing?: { visibility: string; userIds: string[] }; readers: Array<keyof typeof viewers> };
    const scenarios: Scenario[] = [
      { name: "inherits a selected folder", folderId: sharedFolder, readers: ["owner", "folderReader", "namedGuest"] },
      { name: "inherits an all-users folder", folderId: everyoneFolder, readers: ["owner", "folderReader", "itemReader", "unrelated"] },
      { name: "private override in a shared folder", folderId: sharedFolder, sharing: { visibility: "private", userIds: [] }, readers: ["owner"] },
      { name: "selected override in a private folder", folderId: privateFolder, sharing: { visibility: "selected", userIds: [itemReader.userId, namedGuest.userId] }, readers: ["owner", "itemReader", "namedGuest"] },
      { name: "all-users override in a private folder", folderId: privateFolder, sharing: { visibility: "all_users", userIds: [] }, readers: ["owner", "folderReader", "itemReader", "unrelated"] },
      { name: "subfolder of a shared folder", folderId: subfolder, readers: ["owner"] }
    ];

    for (const scenario of scenarios) {
      const noteResponse = await request("/notes", { method: "POST", body: JSON.stringify({ folderId: scenario.folderId }) }, owner);
      const noteId = (await json<{ note: { id: string } }>(noteResponse)).note.id;
      const document = await uploadOk(owner, "matrix", "matrix.txt", { folderId: scenario.folderId });
      if (scenario.sharing) {
        expect((await request(`/notes/${noteId}/sharing`, { method: "PUT", body: JSON.stringify(scenario.sharing) }, owner)).status).toBe(200);
        expect((await shareDocument(owner, document.id, scenario.sharing.visibility, scenario.sharing.userIds)).status).toBe(200);
      }
      for (const [label, viewer] of Object.entries(viewers)) {
        const expected = scenario.readers.includes(label as keyof typeof viewers);
        const noteStatus = (await request(`/notes/${noteId}/versions`, {}, viewer)).status;
        const documentStatus = (await request(`/files/${document.id}`, {}, viewer)).status;
        const noteListed = (await json<{ notes: Array<{ id: string }> }>(await request("/notes", {}, viewer))).notes.some((item) => item.id === noteId);
        const documentListed = (await json<{ documents: Array<{ id: string }> }>(await request("/files", {}, viewer))).documents.some((item) => item.id === document.id);
        const observed = { scenario: scenario.name, viewer: label, noteStatus, documentStatus, noteListed, documentListed };
        expect(observed).toEqual({ scenario: scenario.name, viewer: label, noteStatus: expected ? 200 : 404, documentStatus: expected ? 200 : 404, noteListed: expected, documentListed: expected });
      }
    }
    // Leave no all-users folder behind for other test files.
    await request(`/folders/${everyoneFolder}`, { method: "DELETE", body: "{}" }, owner);
  }, 30_000);

  test("masks folder placement and override state for recipients", async () => {
    const owner = await createUser("Mask owner");
    const folderReader = await createUser("Mask folder reader");
    const itemReader = await createUser("Mask item reader");
    const shared = await folderFor(owner, "Mask shared");
    await shareFolder(owner, shared, "selected", [folderReader.userId]);
    const hidden = await folderFor(owner, "Mask hidden");
    const inherited = await uploadOk(owner, "a", "inherited.txt", { folderId: shared });
    const direct = await uploadOk(owner, "b", "direct.txt", { folderId: hidden });
    await shareDocument(owner, direct.id, "selected", [itemReader.userId]);

    const viaFolder = (await json<{ document: UploadedDocument }>(await request(`/files/${inherited.id}`, {}, folderReader))).document;
    expect(viaFolder).toMatchObject({ folder_id: shared, is_owner: 0, visibility: "selected", sharing_override: 0, owner_name: "Mask owner" });
    const viaShare = (await json<{ document: UploadedDocument }>(await request(`/files/${direct.id}`, {}, itemReader))).document;
    expect(viaShare).toMatchObject({ folder_id: null, is_owner: 0, visibility: "selected", sharing_override: 0 });
    const ownerView = (await json<{ document: UploadedDocument }>(await request(`/files/${direct.id}`, {}, owner))).document;
    expect(ownerView).toMatchObject({ folder_id: hidden, is_owner: 1, sharing_override: 1 });
    const listed = (await json<{ documents: UploadedDocument[] }>(await request("/files", {}, itemReader))).documents.find((item) => item.id === direct.id)!;
    expect(listed.folder_id).toBeNull();
    for (const hiddenKey of ["sha256", "upload_key", "deleted_at", "purge_after"]) expect(listed).not.toHaveProperty(hiddenKey);
    const inFolder = (await json<{ documents: UploadedDocument[] }>(await request(`/files?folderId=${shared}`, {}, owner))).documents;
    expect(inFolder.map((item) => item.id)).toEqual([inherited.id]);
    expect((await request("/files?folderId=bad", {}, owner)).status).toBe(400);
    expect((await request("/files/not-a-uuid", {}, owner)).status).toBe(400);

    const sharing = await json<{ visibility: string; users: Array<{ id: string }> }>(await request(`/files/${direct.id}/sharing`, {}, owner));
    expect(sharing.visibility).toBe("selected");
    expect(sharing.users.map((user) => user.id)).toEqual([itemReader.userId]);
    expect((await json<{ visibility: string }>(await request(`/files/${inherited.id}/sharing`, {}, owner))).visibility).toBe("inherit");
  });

  test("recipients cannot rename, move, share, or delete", async () => {
    const owner = await createUser("Readonly owner");
    const reader = await createUser("Readonly reader");
    const document = await uploadOk(owner, "a", "shared.txt");
    await shareDocument(owner, document.id, "selected", [reader.userId]);
    const readerFolder = defaultFolderOf(reader.userId);
    expect((await request(`/files/${document.id}`, {}, reader)).status).toBe(200);
    expect((await patchDocument(reader, document.id, { name: "mine.txt" })).status).toBe(404);
    expect((await patchDocument(reader, document.id, { folderId: readerFolder })).status).toBe(404);
    expect((await shareDocument(reader, document.id, "all_users")).status).toBe(404);
    expect((await request(`/files/${document.id}/sharing`, {}, reader)).status).toBe(404);
    expect((await deleteDocument(reader, document.id)).status).toBe(404);
    const row = db.query("SELECT name, folder_id, deleted_at FROM documents WHERE id = ?").get(document.id);
    expect(row).toEqual({ name: "shared.txt", folder_id: defaultFolderOf(owner.userId), deleted_at: null });
  });

  test("validates sharing like notes", async () => {
    const owner = await createUser("Share rules owner");
    const reader = await createUser("Share rules reader");
    const document = await uploadOk(owner, "a", "a.txt");
    expect((await shareDocument(owner, document.id, "selected", [])).status).toBe(400);
    expect((await shareDocument(owner, document.id, "selected", [owner.userId])).status).toBe(400);
    expect((await shareDocument(owner, document.id, "selected", [crypto.randomUUID()])).status).toBe(400);
    expect((await shareDocument(owner, document.id, "everyone")).status).toBe(400);
    expect((await shareDocument(owner, document.id, "selected", [reader.userId])).status).toBe(200);
    expect((await shareDocument(owner, document.id, "inherit")).status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS count FROM document_shares WHERE document_id = ?").get(document.id)).toEqual({ count: 0 });
    expect(db.query("SELECT sharing_override FROM documents WHERE id = ?").get(document.id)).toEqual({ sharing_override: 0 });
  });

  test("renames with display-name validation and keeps the sniffed type", async () => {
    const owner = await createUser("Rename owner");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const document = await uploadOk(owner, png, "photo.png");
    expect(document.preview_kind).toBe("image");
    const renamed = await patchDocument(owner, document.id, { name: "page‮.html" });
    expect(renamed.status).toBe(200);
    expect((await json<{ document: UploadedDocument }>(renamed)).document).toMatchObject({ name: "page.html", mime_type: "image/png", preview_kind: "image" });
    expect((await patchDocument(owner, document.id, { name: "  " })).status).toBe(400);
    expect((await patchDocument(owner, document.id, { name: ".." })).status).toBe(400);
    expect((await patchDocument(owner, document.id, { name: `${"a".repeat(256)}` })).status).toBe(400);
    expect((await patchDocument(owner, document.id, {})).status).toBe(400);
    expect((await patchDocument(owner, document.id, { name: "a", extra: 1 })).status).toBe(400);
    expect((await patchDocument(owner, crypto.randomUUID(), { name: "a" })).status).toBe(404);
  });

  test("moves only into owned folders and reports the new effective visibility", async () => {
    const owner = await createUser("Move owner");
    const other = await createUser("Move other");
    const document = await uploadOk(owner, "a", "a.txt");
    expect(document.visibility).toBe("private");
    const shared = await folderFor(owner, "Move shared");
    await shareFolder(owner, shared, "selected", [other.userId]);
    const moved = await patchDocument(owner, document.id, { folderId: shared });
    expect(moved.status).toBe(200);
    expect((await json<{ document: UploadedDocument }>(moved)).document).toMatchObject({ folder_id: shared, visibility: "selected" });
    expect((await request(`/files/${document.id}`, {}, other)).status).toBe(200);

    const othersShared = await folderFor(other, "Other shared");
    await shareFolder(other, othersShared, "selected", [owner.userId]);
    expect((await patchDocument(owner, document.id, { folderId: othersShared })).status).toBe(404);
    const toNone = await patchDocument(owner, document.id, { folderId: null });
    expect((await json<{ document: UploadedDocument }>(toNone)).document).toMatchObject({ folder_id: null, visibility: "private" });
    expect((await request(`/files/${document.id}`, {}, other)).status).toBe(404);
  });

  test("deleting a folder leaves its documents live, private, and unfiled", async () => {
    const owner = await createUser("Folder delete owner");
    const reader = await createUser("Folder delete reader");
    const folder = await folderFor(owner, "Doomed");
    await shareFolder(owner, folder, "selected", [reader.userId]);
    const document = await uploadOk(owner, "a", "a.txt", { folderId: folder });
    expect((await request(`/files/${document.id}`, {}, reader)).status).toBe(200);
    expect((await request(`/folders/${folder}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    const after = (await json<{ document: UploadedDocument }>(await request(`/files/${document.id}`, {}, owner))).document;
    expect(after).toMatchObject({ folder_id: null, visibility: "private" });
    expect((await request(`/files/${document.id}`, {}, reader)).status).toBe(404);
  });

  test("soft delete moves a document to the Bin and hides it everywhere", async () => {
    const owner = await createUser("Delete owner");
    const reader = await createUser("Delete reader");
    const document = await uploadOk(owner, "a", "a.txt");
    await shareDocument(owner, document.id, "selected", [reader.userId]);
    expect((await request(`/files/${document.id}`, {}, reader)).status).toBe(200);
    const before = Date.now();
    const deleted = await deleteDocument(owner, document.id);
    expect(deleted.status).toBe(200);
    const body = await json<{ ok: boolean; purgeAfter: string }>(deleted);
    expect(body.ok).toBe(true);
    const purgeAfter = new Date(body.purgeAfter).getTime();
    expect(purgeAfter).toBeGreaterThanOrEqual(before + 30 * 86_400_000 - 1000);
    expect(purgeAfter).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000 + 1000);
    const row = db.query("SELECT deleted_by, purge_after, purge_started_at FROM documents WHERE id = ?").get(document.id);
    expect(row).toEqual({ deleted_by: owner.userId, purge_after: body.purgeAfter, purge_started_at: null });
    // Share rows and bytes are retained so a restore brings sharing back as it was.
    expect(db.query("SELECT COUNT(*) AS count FROM document_shares WHERE document_id = ?").get(document.id)).toEqual({ count: 1 });
    expect(existsSync(objectPath(document.id))).toBe(true);

    const again = await json<{ ok: boolean; alreadyDeleted: boolean; purgeAfter: string }>(await deleteDocument(owner, document.id));
    expect(again).toEqual({ ok: true, alreadyDeleted: true, purgeAfter: body.purgeAfter });
    for (const viewer of [owner, reader]) {
      expect((await request(`/files/${document.id}`, {}, viewer)).status).toBe(404);
      const listed = (await json<{ documents: Array<{ id: string }> }>(await request("/files", {}, viewer))).documents;
      expect(listed.some((item) => item.id === document.id)).toBe(false);
    }
    expect((await patchDocument(owner, document.id, { name: "b.txt" })).status).toBe(404);
    expect((await shareDocument(owner, document.id, "private")).status).toBe(404);
    expect((await deleteDocument(reader, document.id)).status).toBe(404);
    expect((await deleteDocument(owner, crypto.randomUUID())).status).toBe(404);
  });

  test("audits document changes without filenames", async () => {
    const owner = await createUser("Audit owner");
    const secretName = "audit-secret-name-7f3a.txt";
    const document = await uploadOk(owner, "a", secretName);
    await patchDocument(owner, document.id, { name: "audit-secret-rename-7f3a.txt" });
    const folder = await folderFor(owner, "Audit folder");
    await patchDocument(owner, document.id, { folderId: folder });
    await shareDocument(owner, document.id, "all_users");
    await deleteDocument(owner, document.id);
    const events = db.query("SELECT event_type, note_id, metadata_json FROM audit_log WHERE metadata_json LIKE ? ORDER BY created_at, rowid")
      .all(`%${document.id}%`) as Array<{ event_type: string; note_id: string | null; metadata_json: string }>;
    expect(events.map((event) => event.event_type)).toEqual(["document.upload", "document.rename", "document.move", "document.sharing_changed", "document.delete"]);
    expect(events.every((event) => event.note_id === null)).toBe(true);
    expect(JSON.parse(events[2]!.metadata_json)).toEqual({ documentId: document.id, folderId: folder });
    expect(JSON.parse(events[3]!.metadata_json)).toEqual({ documentId: document.id, visibility: "all_users", recipientCount: 0 });
    const leaked = db.query("SELECT COUNT(*) AS count FROM audit_log WHERE metadata_json LIKE '%audit-secret%'").get();
    expect(leaked).toEqual({ count: 0 });
  });
});

const GLOBAL_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const SANDBOX_CSP = "default-src 'none'; sandbox";
const content = (session: Session | undefined, id: string, options: { query?: string; headers?: Record<string, string>; method?: string; signal?: AbortSignal } = {}) =>
  request(`/files/${id}/content${options.query ?? ""}`, { method: options.method ?? "GET", headers: options.headers, signal: options.signal }, session);

function expectStrictHeaders(response: Response, csp = SANDBOX_CSP) {
  expect(response.headers.get("content-security-policy")).toBe(csp);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
}

function openDescriptorsFor(path: string) {
  let count = 0;
  for (const fd of readdirSync("/proc/self/fd")) {
    try {
      if (readlinkSync(`/proc/self/fd/${fd}`) === path) count += 1;
    } catch {
      // The descriptor closed while listing.
    }
  }
  return count;
}

describe("document content", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

  test("serves authenticated content with the exact header set", async () => {
    const owner = await createUser("Content owner");
    const reader = await createUser("Content reader");
    const unrelated = await createUser("Content unrelated");
    const document = await uploadOk(owner, png, "Photo été.png");
    await shareDocument(owner, document.id, "selected", [reader.userId]);
    const row = db.query("SELECT sha256, updated_at FROM documents WHERE id = ?").get(document.id) as { sha256: string; updated_at: string };

    const download = await content(owner, document.id);
    expect(download.status).toBe(200);
    expectStrictHeaders(download);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toBe(`attachment; filename="Photo _t_.png"; filename*=UTF-8''Photo%20%C3%A9t%C3%A9.png`);
    // Bun sends streamed bodies chunked and drops Content-Length; when present it must be exact.
    expect([null, String(png.byteLength)]).toContain(download.headers.get("content-length"));
    expect(download.headers.get("accept-ranges")).toBe("bytes");
    expect(download.headers.get("etag")).toBe(`"${row.sha256}"`);
    expect(download.headers.get("last-modified")).toBe(new Date(row.updated_at).toUTCString());
    expect(download.headers.get("permissions-policy")).toBeNull();
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(png);

    const inline = await content(reader, document.id, { query: "?disposition=inline" });
    expect(inline.status).toBe(200);
    expectStrictHeaders(inline);
    expect(inline.headers.get("content-type")).toBe("image/png");
    expect(inline.headers.get("content-disposition")).toStartWith("inline; ");
    await inline.arrayBuffer();

    expect((await content(unrelated, document.id)).status).toBe(404);
    const anonymous = await content(undefined, document.id);
    expect(anonymous.status).toBe(401);
    expectStrictHeaders(anonymous);
    const missing = await content(owner, crypto.randomUUID());
    expect(missing.status).toBe(404);
    expectStrictHeaders(missing);
    const malformed = await content(owner, "not-a-uuid");
    expect(malformed.status).toBe(400);
    expectStrictHeaders(malformed);
    expect((await content(owner, document.id, { query: "?disposition=bogus" })).headers.get("content-disposition")).toStartWith("attachment; ");
  });

  test("keeps the global CSP everywhere else", async () => {
    const owner = await createUser("Global CSP owner");
    const document = await uploadOk(owner, "a", "a.txt");
    for (const response of [
      await request("/health"),
      await request("/files", {}, owner),
      await request(`/files/${document.id}`, {}, owner),
      await request(`/files/${document.id}/content/extra`, {}, owner),
      await request(`/files/${document.id}/content`, { method: "POST", body: "{}" }, owner),
      await fetch(`${origin}/`),
      await fetch(`${origin}/files/${document.id}`)
    ]) {
      expect(response.headers.get("content-security-policy")).toBe(GLOBAL_CSP);
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    }
  });

  test("forces attachment for documents without an inline preview and uses the PDF policy for PDFs", async () => {
    const owner = await createUser("Disposition owner");
    const html = await uploadOk(owner, "<!doctype html><script>alert(1)</script>", "page.html", { type: "text/html" });
    expect(html.preview_kind).toBe("none");
    const forced = await content(owner, html.id, { query: "?disposition=inline" });
    expectStrictHeaders(forced);
    expect(forced.headers.get("content-type")).toBe("application/octet-stream");
    expect(forced.headers.get("content-disposition")).toStartWith("attachment; ");
    await forced.arrayBuffer();

    const pdf = await uploadOk(owner, "%PDF-1.7\n%âã\n", "doc.pdf");
    const inlinePdf = await content(owner, pdf.id, { query: "?disposition=inline" });
    expectStrictHeaders(inlinePdf, "default-src 'none'; frame-ancestors 'none'");
    expect(inlinePdf.headers.get("content-type")).toBe("application/pdf");
    await inlinePdf.arrayBuffer();
    const pdfDownload = await content(owner, pdf.id);
    expectStrictHeaders(pdfDownload);
    await pdfDownload.arrayBuffer();

    const text = await uploadOk(owner, "plain words", "notes.md");
    const inlineText = await content(owner, text.id, { query: "?disposition=inline" });
    expect(inlineText.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expectStrictHeaders(inlineText);
    expect(await inlineText.text()).toBe("plain words");
  });

  test("supports single byte ranges, If-Range, and HEAD", async () => {
    const owner = await createUser("Range owner");
    const body = "0123456789abcdefghij";
    const document = await uploadOk(owner, body, "range.txt");
    const etag = `"${(db.query("SELECT sha256 FROM documents WHERE id = ?").get(document.id) as { sha256: string }).sha256}"`;
    const ranged = async (range: string, extra: Record<string, string> = {}) => {
      const response = await content(owner, document.id, { headers: { Range: range, ...extra } });
      return { status: response.status, contentRange: response.headers.get("content-range"), length: response.headers.get("content-length"), body: await response.text(), response };
    };

    const first = await ranged("bytes=0-9");
    expect(first).toMatchObject({ status: 206, contentRange: "bytes 0-9/20", body: "0123456789" });
    expect([null, "10"]).toContain(first.length);
    expectStrictHeaders(first.response);
    expect(await ranged("bytes=-5")).toMatchObject({ status: 206, contentRange: "bytes 15-19/20", body: "fghij" });
    expect(await ranged("bytes=15-")).toMatchObject({ status: 206, contentRange: "bytes 15-19/20", body: "fghij" });
    expect(await ranged("bytes=18-500")).toMatchObject({ status: 206, contentRange: "bytes 18-19/20", body: "ij" });
    expect(await ranged("bytes=20-")).toMatchObject({ status: 416, contentRange: "bytes */20", body: "" });
    expect(await ranged("bytes=-0")).toMatchObject({ status: 416, contentRange: "bytes */20" });
    expect(await ranged("bytes=0-1,4-5")).toMatchObject({ status: 200, contentRange: null, body });
    expect(await ranged("items=0-1")).toMatchObject({ status: 200, body });
    expect(await ranged("bytes=5-2")).toMatchObject({ status: 200, body });
    expect(await ranged("bytes=0-3", { "If-Range": '"stale"' })).toMatchObject({ status: 200, body });
    expect(await ranged("bytes=0-3", { "If-Range": new Date().toUTCString() })).toMatchObject({ status: 200, body });
    expect(await ranged("bytes=0-3", { "If-Range": etag })).toMatchObject({ status: 206, body: "0123" });

    const head = await content(owner, document.id, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("20");
    expectStrictHeaders(head);
    expect(await head.text()).toBe("");
    const headRange = await content(owner, document.id, { method: "HEAD", headers: { Range: "bytes=2-3" } });
    expect(headRange.status).toBe(206);
    expect(headRange.headers.get("content-range")).toBe("bytes 2-3/20");
    expect(await headRange.text()).toBe("");

    const empty = await uploadOk(owner, "", "empty.txt");
    const emptyFull = await content(owner, empty.id);
    expect(emptyFull.status).toBe(200);
    expect(await emptyFull.text()).toBe("");
    const emptyRange = await content(owner, empty.id, { headers: { Range: "bytes=0-0" } });
    expect(emptyRange.status).toBe(416);
    expect(emptyRange.headers.get("content-range")).toBe("bytes */0");
    expect(openDescriptorsFor(objectPath(document.id))).toBe(0);
    expect(openDescriptorsFor(objectPath(empty.id))).toBe(0);
  });

  test("returns 404 for binned documents, including to the owner", async () => {
    const owner = await createUser("Binned content owner");
    const reader = await createUser("Binned content reader");
    const document = await uploadOk(owner, "a", "a.txt");
    await shareDocument(owner, document.id, "all_users");
    await (await content(reader, document.id)).text();
    await deleteDocument(owner, document.id);
    expect((await content(owner, document.id)).status).toBe(404);
    expect((await content(reader, document.id)).status).toBe(404);
    expect((await content(owner, document.id, { method: "HEAD" })).status).toBe(404);
  });

  test("fails closed with 500 on integrity errors", async () => {
    const owner = await createUser("Integrity owner");
    const secret = "outside secret bytes";
    const outside = join(dataDir, "outside-target.txt");
    writeFileSync(outside, secret, { mode: 0o600 });

    const linked = await uploadOk(owner, secret, "linked.txt");
    rmSync(objectPath(linked.id));
    symlinkSync(outside, objectPath(linked.id));
    const symlinkResponse = await content(owner, linked.id);
    expect(symlinkResponse.status).toBe(500);
    expectStrictHeaders(symlinkResponse);
    const symlinkBody = await symlinkResponse.text();
    expect(symlinkBody).toBe(JSON.stringify({ error: "Something went wrong" }));
    expect(symlinkBody).not.toContain(secret);

    const truncated = await uploadOk(owner, "twelve bytes", "truncated.txt");
    writeFileSync(objectPath(truncated.id), "short");
    expect((await content(owner, truncated.id)).status).toBe(500);
    expect((await content(owner, truncated.id, { method: "HEAD" })).status).toBe(500);

    const missing = await uploadOk(owner, "gone", "missing.txt");
    rmSync(objectPath(missing.id));
    expect((await content(owner, missing.id)).status).toBe(500);
    rmSync(objectPath(linked.id));
    rmSync(outside);
  });

  test("closes the file descriptor when the client aborts a download", async () => {
    const owner = await createUser("Abort download owner");
    const document = await uploadOk(owner, new Uint8Array(3_000_000).fill(0x63), "large.bin");
    const path = objectPath(document.id);
    const controller = new AbortController();
    const response = await content(owner, document.id, { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    expect(openDescriptorsFor(path)).toBe(1);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await waitFor(() => openDescriptorsFor(path) === 0);

    const complete = await content(owner, document.id);
    expect((await complete.arrayBuffer()).byteLength).toBe(3_000_000);
    await waitFor(() => openDescriptorsFor(path) === 0);
  });
});

const { config } = await import("../server/config");

/** A multipart upload whose body is held after the part header until `release()` is called. */
function gatedUpload(session: Session, filename: string, size: number, headers: Record<string, string> = {}) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  let step = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      if (step === 0) {
        stream.enqueue(head);
        stream.enqueue(new Uint8Array(1024).fill(0x64));
      } else if (step === 1) {
        await gate;
        stream.enqueue(new Uint8Array(size - 1024).fill(0x64));
      } else {
        stream.enqueue(tail);
        stream.close();
      }
      step += 1;
    }
  });
  const length = head.byteLength + size + tail.byteLength;
  const response = request("/files", { method: "POST", body, headers: { "Content-Type": multipartType, "Content-Length": String(length), ...headers }, duplex: "half" } as RequestInit, session);
  return { response, release };
}

const stagedCount = () => listDir(stagingDir).filter((name) => name.endsWith(".part")).length;
const ownerObjectsOnDisk = (userId: string) =>
  (db.query("SELECT id FROM documents WHERE owner_id = ?").all(userId) as Array<{ id: string }>).filter((row) => existsSync(objectPath(row.id))).length;

describe("upload limit races", () => {
  test("refuses an upload with 507 DISK_FULL when free space would drop below the floor", async () => {
    const owner = await createUser("Disk full owner");
    const baseline = { staging: stagedCount(), objects: listDir(objectsDir).length };
    const previous = config.minFreeDiskBytes;
    config.minFreeDiskBytes = Number.MAX_SAFE_INTEGER;
    try {
      const response = await upload(owner, "some bytes", "disk.txt");
      expect(response.status).toBe(507);
      expect(await response.json()).toEqual({ error: "Storage is full", code: "DISK_FULL" });
    } finally {
      config.minFreeDiskBytes = previous;
    }
    expect(stagedCount()).toBe(baseline.staging);
    expect(listDir(objectsDir).length).toBe(baseline.objects);
    expect(db.query("SELECT COUNT(*) AS count FROM documents WHERE owner_id = ?").get(owner.userId)).toEqual({ count: 0 });
    // The slot and reservation were released: a normal upload still works.
    await uploadOk(owner, "some bytes", "disk.txt");
  });

  test("parallel uploads never exceed the quota together", async () => {
    const owner = await createUser("Parallel quota owner");
    const quota = config.userStorageQuotaBytes;
    const used = 5 * 1_048_576;
    insertDocumentRow(owner.userId, crypto.randomUUID(), used);
    const size = 3 * 1_048_576;
    const responses = await Promise.all([1, 2, 3].map((index) => upload(owner, new Uint8Array(size).fill(index), `part-${index}.bin`)));
    const statuses = responses.map((response) => response.status);
    const accepted = statuses.filter((status) => status === 201).length;
    expect(accepted).toBeGreaterThanOrEqual(1);
    expect(used + accepted * size).toBeLessThanOrEqual(quota);
    for (const response of responses) {
      const body = (await response.json()) as { code?: string };
      if (response.status !== 201) {
        expect(response.status).toBe(507);
        expect(body.code).toBe("QUOTA_EXCEEDED");
      }
    }
    const stored = (db.query("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM documents WHERE owner_id = ?").get(owner.userId) as { total: number }).total;
    expect(stored).toBe(used + accepted * size);
    expect(stored).toBeLessThanOrEqual(quota);
    expect(ownerObjectsOnDisk(owner.userId)).toBe(accepted);
    await waitFor(() => stagedCount() === 0);
  });

  test("the in-transaction quota re-check rejects an upload overtaken by other usage", async () => {
    const owner = await createUser("Overtaken quota owner");
    const quota = config.userStorageQuotaBytes;
    insertDocumentRow(owner.userId, crypto.randomUUID(), quota - 4 * 1_048_576);
    const objectsBefore = listDir(objectsDir).length;
    const size = 3 * 1_048_576;
    const pending = gatedUpload(owner, "overtaken.bin", size);
    await waitFor(() => stagedCount() > 0);
    // Usage grows while the upload streams (the pre-check already admitted it).
    insertDocumentRow(owner.userId, crypto.randomUUID(), 2 * 1_048_576);
    pending.release();
    const response = await pending.response;
    expect(response.status).toBe(507);
    expect(((await response.json()) as { code: string }).code).toBe("QUOTA_EXCEEDED");
    expect(listDir(objectsDir).length).toBe(objectsBefore);
    expect(db.query("SELECT COUNT(*) AS count FROM documents WHERE owner_id = ? AND name = 'overtaken.bin'").get(owner.userId)).toEqual({ count: 0 });
    await waitFor(() => stagedCount() === 0);
  });

  test("two concurrent uploads with one Idempotency-Key keep one document", async () => {
    const owner = await createUser("Concurrent key owner");
    const key = crypto.randomUUID();
    const objectsBefore = listDir(objectsDir).length;
    const first = gatedUpload(owner, "twin.bin", 200_000, { "Idempotency-Key": key });
    const second = gatedUpload(owner, "twin.bin", 200_000, { "Idempotency-Key": key });
    // Both requests are past the pre-stream replay check before either can insert.
    await waitFor(() => stagedCount() >= 2);
    first.release();
    second.release();
    const responses = await Promise.all([first.response, second.response]);
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ document: UploadedDocument; idempotentReplay?: boolean }>));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(bodies[0]!.document.id).toBe(bodies[1]!.document.id);
    expect(bodies.filter((body) => body.idempotentReplay === true)).toHaveLength(1);
    expect(db.query("SELECT COUNT(*) AS count FROM documents WHERE owner_id = ? AND upload_key = ?").get(owner.userId, key)).toEqual({ count: 1 });
    expect(listDir(objectsDir).length).toBe(objectsBefore + 1);
    expect(existsSync(objectPath(bodies[0]!.document.id))).toBe(true);
    await waitFor(() => stagedCount() === 0);
  });
});

const { setUploadIdleTimeoutForTests } = await import("../server/documents");

function openStagingDescriptors() {
  let count = 0;
  for (const fd of readdirSync("/proc/self/fd")) {
    try {
      if (readlinkSync(`/proc/self/fd/${fd}`).startsWith(stagingDir)) count += 1;
    } catch {
      // The descriptor closed while listing.
    }
  }
  return count;
}

describe("upload body lifecycle", () => {
  test("requires Content-Length and answers 411 before staging anything", async () => {
    const owner = await createUser("Length required owner");
    const baseline = stagedCount();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(encoder.encode(multipart([{ name: "file", filename: "a.txt", content: "a" }])));
          stream.close();
        }
      });
      const response = await request("/files", { method: "POST", body, headers: { "Content-Type": multipartType }, duplex: "half" } as RequestInit, owner);
      expect(response.status).toBe(411);
      expect(await response.json()).toEqual({ error: "Content-Length is required for uploads", code: "LENGTH_REQUIRED" });
    }
    expect(stagedCount()).toBe(baseline);
    // Four refusals did not use up the three upload slots.
    await uploadOk(owner, "a", "after.txt");
  });

  test("a chunked body past Bun's transport cap leaves the server healthy", async () => {
    const owner = await createUser("Transport cap owner");
    const baseline = stagedCount();
    const chunk = new Uint8Array(100_000);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(stream) {
          if (sent === 0) stream.enqueue(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n\r\n`));
          // Well past Bun's cap of max(MAX_UPLOAD_BYTES, 2.1 MB) + 1 MiB in the harness.
          if (sent > 7_000_000) return stream.close();
          stream.enqueue(chunk);
          sent += chunk.byteLength;
        }
      });
      const outcome = await request("/files", { method: "POST", body, headers: { "Content-Type": multipartType }, duplex: "half" } as RequestInit, owner)
        .then((response) => response.status, () => "connection closed");
      expect([411, 413, "connection closed"]).toContain(outcome);
    }
    Bun.gc(true);
    await Bun.sleep(50);
    expect((await request("/health")).status).toBe(200);
    expect(stagedCount()).toBe(baseline);
    expect(openStagingDescriptors()).toBe(0);
    await uploadOk(owner, "still works", "after.txt");
  });

  test("the inactivity watchdog fails a stalled upload and closes its staging file", async () => {
    const owner = await createUser("Stalled upload owner");
    const baseline = stagedCount();
    setUploadIdleTimeoutForTests(300);
    const controllers: AbortController[] = [];
    try {
      const started = Date.now();
      const responses = await Promise.all([1, 2, 3].map(() => {
        const controller = new AbortController();
        controllers.push(controller);
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="stalled.bin"\r\n\r\n${"s".repeat(4096)}`));
          },
          pull: () => new Promise<void>(() => undefined)
        });
        return request("/files", { method: "POST", body, signal: controller.signal, headers: { "Content-Type": multipartType, "Content-Length": "200000" }, duplex: "half" } as RequestInit, owner);
      }));
      expect(Date.now() - started).toBeLessThan(5000);
      for (const response of responses) {
        expect(response.status).toBe(408);
        expect(await response.json()).toEqual({ error: "The upload stalled", code: "UPLOAD_TIMEOUT" });
      }
      await waitFor(() => stagedCount() === baseline);
      expect(openStagingDescriptors()).toBe(0);
      expect(db.query("SELECT COUNT(*) AS count FROM documents WHERE owner_id = ?").get(owner.userId)).toEqual({ count: 0 });
      // All three slots were released.
      await uploadOk(owner, "after the stall", "after.txt");
      expect((await request("/health")).status).toBe(200);
    } finally {
      setUploadIdleTimeoutForTests(null);
      for (const controller of controllers) controller.abort();
    }
  });
});

describe("document purpose", () => {
  test("attachments (purpose other than file) never appear in Files lists or the Files Bin filter", async () => {
    const owner = await createUser("Purpose owner");
    const folderId = defaultFolderOf(owner.userId);
    const kept = await uploadOk(owner, "a Files item", "kept.txt");
    const timestamp = now();
    const insert = db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, created_at, updated_at, purpose, deleted_at, purge_after)
      VALUES (?, ?, ?, ?, 'image/png', 'image', 1, ?, ?, ?, ?, ?, ?)`);
    const attachmentId = crypto.randomUUID();
    const foldered = crypto.randomUUID();
    const binned = crypto.randomUUID();
    insert.run(attachmentId, owner.userId, null, "attachment.png", "0".repeat(64), timestamp, timestamp, "task_attachment", null, null);
    // Even a stray attachment with a folder stays out of Files.
    insert.run(foldered, owner.userId, folderId, "collection.png", "0".repeat(64), timestamp, timestamp, "collection_attachment", null, null);
    insert.run(binned, owner.userId, null, "binned.png", "0".repeat(64), timestamp, timestamp, "task_attachment", timestamp, timestamp);

    const all = (await (await request("/files", {}, owner)).json()) as { documents: Array<{ id: string; is_owner: number }> };
    // Other tests share documents with all users; only this owner's own rows matter here.
    expect(all.documents.filter((document) => document.is_owner === 1).map((document) => document.id)).toEqual([kept.id]);
    const inFolder = (await (await request(`/files?folderId=${folderId}`, {}, owner)).json()) as { documents: Array<{ id: string }> };
    expect(inFolder.documents.map((document) => document.id)).toEqual([kept.id]);
    const binFiles = (await (await request("/bin?type=document", {}, owner)).json()) as { items: Array<{ id: string }> };
    expect(binFiles.items.map((item) => item.id)).not.toContain(binned);
  });

  test("uploads accept only the file, task_attachment, and collection_attachment purposes", async () => {
    const owner = await createUser("Purpose uploader");
    const form = () => {
      const body = new FormData();
      body.append("file", new Blob(["x"]), "x.txt");
      return body;
    };
    for (const purpose of ["system", "board_attachment", ""]) {
      const response = await request(`/files?purpose=${purpose}`, { method: "POST", body: form() }, owner);
      expect(response.status).toBe(400);
    }
    expect((await request("/files?purpose=file", { method: "POST", body: form() }, owner)).status).toBe(201);
    expect((await request("/files?purpose=task_attachment", { method: "POST", body: form() }, owner)).status).toBe(201);

    // Collection attachments are stored outside every folder (Wave 11, D58).
    expect((await request(`/files?purpose=collection_attachment&folderId=${crypto.randomUUID()}`, { method: "POST", body: form() }, owner)).status).toBe(400);
    const attachment = await request("/files?purpose=collection_attachment", { method: "POST", body: form() }, owner);
    expect(attachment.status).toBe(201);
    const stored = db.query("SELECT folder_id, purpose FROM documents WHERE id = ?").get(((await attachment.json()) as { document: { id: string } }).document.id);
    expect(stored).toEqual({ folder_id: null, purpose: "collection_attachment" });
    expect(db.query("SELECT COUNT(*) AS count FROM documents WHERE owner_id = ?").get(owner.userId)).toEqual({ count: 3 });
    expect(db.query("SELECT purpose, folder_id IS NULL AS unfiled FROM documents WHERE owner_id = ? ORDER BY purpose").all(owner.userId)).toEqual([
      { purpose: "collection_attachment", unfiled: 1 },
      { purpose: "file", unfiled: 0 },
      { purpose: "task_attachment", unfiled: 1 }
    ]);
  });
});
