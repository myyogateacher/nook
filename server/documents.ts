import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import busboy from "busboy";
import type { Context, Hono, Next } from "hono";
import { config } from "./config";
import { audit, db, ensureDefaultFolder, now } from "./db";
import type { AppEnv } from "./auth";
import { contentDisposition, parseRange } from "./contentHeaders";
import { listReadableDocuments, ownedDocument, ownedDocumentSummary, ownedFileDocument, readableDocument, readableDocumentSummary, type DocumentSummary } from "./documentAccess";
import { commitStaged, createStagingFile, discardStaged, DocumentIntegrityError, openObjectForRead, removeObject } from "./documentStorage";
import { SNIFF_BYTES, sniff } from "./mimeSniff";
import { withResourceLock } from "./storage";
import { purgeAfterFrom } from "./bin";
import { documentPatchSchema, parseJson, sanitizeDisplayName, sharingSchema, uuid } from "./validation";
import { mailShared, shareMembers } from "./mail/triggers";

const MAX_CONCURRENT_UPLOADS = 3;
const MULTIPART_OVERHEAD_BYTES = 65_536;
const DEFAULT_UPLOAD_IDLE_TIMEOUT_MS = 30_000;
let uploadIdleTimeoutMs = DEFAULT_UPLOAD_IDLE_TIMEOUT_MS;

/** Test hook: shortens the upload inactivity watchdog. Pass null to restore the default. */
export function setUploadIdleTimeoutForTests(ms: number | null) {
  uploadIdleTimeoutMs = ms ?? DEFAULT_UPLOAD_IDLE_TIMEOUT_MS;
}

class UploadError extends Error {
  constructor(readonly status: 400 | 401 | 404 | 408 | 411 | 413 | 507, readonly body: Record<string, unknown>) {
    super(String(body.error));
  }
}

const fileTooLarge = () => new UploadError(413, { error: "File is too large", code: "FILE_TOO_LARGE", limitBytes: config.maxUploadBytes });
const badPart = (error = "Upload exactly one file part named file") => new UploadError(400, { error });

/** In-flight upload slots and quota reservations per user. Single process only. */
const inFlight = new Map<string, { count: number; reservedBytes: number }>();

function acquireSlot(userId: string) {
  const entry = inFlight.get(userId) ?? { count: 0, reservedBytes: 0 };
  if (entry.count >= MAX_CONCURRENT_UPLOADS) return null;
  entry.count += 1;
  inFlight.set(userId, entry);
  let reserved = 0;
  let released = false;
  return {
    reserve(bytes: number) {
      entry.reservedBytes += bytes;
      reserved += bytes;
    },
    otherReservations: () => entry.reservedBytes - reserved,
    release() {
      if (released) return;
      released = true;
      entry.count -= 1;
      entry.reservedBytes -= reserved;
      if (entry.count === 0) inFlight.delete(userId);
    }
  };
}

/** Bytes that count against the quota: every document the user owns, live or binned. */
export const storedBytes = (userId: string) =>
  (db.query("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM documents WHERE owner_id = ?").get(userId) as { total: number }).total;

/** The quota picture shown on Today: stored bytes (as the quota counts them), the binned part, and the quota (null = unlimited). */
export function storageUsage(userId: string) {
  const binnedBytes = (db.query("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM documents WHERE owner_id = ? AND deleted_at IS NOT NULL").get(userId) as { total: number }).total;
  return { usedBytes: storedBytes(userId), binnedBytes, quotaBytes: config.userStorageQuotaBytes > 0 ? config.userStorageQuotaBytes : null };
}

const ownsFolder = (folderId: string, userId: string) => Boolean(db.query("SELECT 1 FROM folders WHERE id = ? AND owner_id = ?").get(folderId, userId));

function replayFor(userId: string, uploadKey: string) {
  const existing = db.query("SELECT id, deleted_at FROM documents WHERE owner_id = ? AND upload_key = ?").get(userId, uploadKey) as { id: string; deleted_at: string | null } | null;
  if (!existing) return null;
  if (existing.deleted_at) return { deleted: true as const };
  return { document: ownedDocumentSummary(existing.id, userId)! };
}

type ReceivedFile = { filename: string; size: number; sha256: string; head: Uint8Array };

async function writeFilePart(stream: Readable & { truncated?: boolean }, filename: string, id: string): Promise<ReceivedFile> {
  const { handle } = await createStagingFile(id);
  try {
    const hash = createHash("sha256");
    const head = new Uint8Array(SNIFF_BYTES);
    let headLength = 0;
    let size = 0;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      size += chunk.byteLength;
      hash.update(chunk);
      if (headLength < SNIFF_BYTES) {
        const take = Math.min(SNIFF_BYTES - headLength, chunk.byteLength);
        head.set(chunk.subarray(0, take), headLength);
        headLength += take;
      }
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
        offset += bytesWritten;
      }
    }
    if (stream.truncated || size > config.maxUploadBytes) throw fileTooLarge();
    await handle.sync();
    return { filename, size, sha256: hash.digest("hex"), head: head.subarray(0, headLength) };
  } finally {
    await handle.close();
  }
}

/**
 * Streams exactly one multipart file part into staging. Nothing but the first
 * SNIFF_BYTES is kept in memory; file writes are awaited, so the request body
 * is only read as fast as the disk accepts it.
 */
function receiveSingleFile(request: Request, id: string): Promise<ReceivedFile> {
  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      // busboy emits partsLimit when the count *reaches* the limit and skips later parts
      // silently, so allow two parts and treat reaching two as an extra part. fileSize is
      // limit + 1 because busboy flags a file that reaches the limit exactly as truncated.
      limits: { files: 1, fields: 0, parts: 2, fileSize: config.maxUploadBytes + 1, headerPairs: 20, fieldNameSize: 100 },
      defParamCharset: "utf8"
    });
  } catch {
    return Promise.reject(badPart("Malformed multipart request"));
  }
  if (!request.body) return Promise.reject(badPart("Missing file part"));
  const source = Readable.fromWeb(request.body as unknown as NodeWebReadableStream<Uint8Array>);

  return new Promise<ReceivedFile>((resolve, reject) => {
    let settled = false;
    let fileStream: Readable | null = null;
    let filePromise: Promise<ReceivedFile> | null = null;
    let sourceEnded = false;
    // Watchdog: fail when no body bytes arrive for the idle timeout. Besides stalled clients this
    // covers a body Bun stops delivering without ending or erroring the stream. The pending timer
    // also keeps the pipeline reachable, so the staging FileHandle is closed here, never by GC.
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(new UploadError(408, { error: "The upload stalled", code: "UPLOAD_TIMEOUT" })), uploadIdleTimeoutMs);
    };
    const disarmWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      disarmWatchdog();
      const failure = error instanceof UploadError ? error : badPart("The upload was interrupted or malformed");
      // Tear down after the current busboy callback returns: busboy keeps using its part
      // state after emitting events such as "limit", so destroying it synchronously throws.
      queueMicrotask(() => {
        // Each step is guarded: a throw here would be uncaught and take the process down.
        const guarded = (step: () => void) => {
          try {
            step();
          } catch (teardownError) {
            console.error("Upload teardown step failed", teardownError instanceof Error ? teardownError.name : "Unknown error");
          }
        };
        guarded(() => source.unpipe(parser));
        guarded(() => source.destroy());
        guarded(() => fileStream?.destroy());
        guarded(() => parser.destroy());
        // Wait for the staging handle to close before the caller discards the file.
        void (filePromise ?? Promise.resolve()).catch(() => undefined).finally(() => reject(failure));
      });
    };

    parser.on("file", (field, stream, info) => {
      // Errors on part streams surface through fail(); never leave them unhandled.
      stream.on("error", () => undefined);
      // busboy keeps parsing the chunk it is in after destroy(); never start a file after failing.
      if (settled) {
        stream.resume();
        return;
      }
      if (filePromise || field !== "file") {
        stream.resume();
        fail(badPart());
        return;
      }
      fileStream = stream;
      // Fail as soon as the part exceeds the limit instead of skipping the rest of the body.
      stream.on("limit", () => fail(fileTooLarge()));
      filePromise = writeFilePart(stream, info.filename ?? "", id);
      filePromise.catch(fail);
    });
    parser.on("field", () => fail(badPart()));
    parser.on("fieldsLimit", () => fail(badPart()));
    parser.on("filesLimit", () => fail(badPart()));
    parser.on("partsLimit", () => fail(badPart()));
    parser.on("error", () => fail(badPart("Malformed multipart request")));
    parser.on("close", () => {
      if (settled) return;
      if (!filePromise) return fail(badPart("Missing file part"));
      filePromise.then((received) => {
        if (settled) return;
        settled = true;
        disarmWatchdog();
        resolve(received);
      }, fail);
    });
    source.on("data", armWatchdog);
    source.on("end", () => { sourceEnded = true; });
    // A body stream that closes without ending was cut off; busboy would never see its end.
    source.on("close", () => { if (!sourceEnded) fail(badPart("The upload was interrupted")); });
    source.on("error", fail);
    request.signal.addEventListener("abort", () => fail(badPart("The upload was interrupted")), { once: true });
    armWatchdog();
    source.pipe(parser);
  });
}

function uploadResponse(c: Context<AppEnv>, document: DocumentSummary, replay: boolean) {
  return replay ? c.json({ document, idempotentReplay: true }, 200) : c.json({ document }, 201);
}

async function handleUpload(c: Context<AppEnv>) {
  const userId = c.get("user").id;
  // Attachments (WAVES_7-9.md §7, WAVES_10-12.md D58) have no folder and never appear in Files;
  // they become readable to a board or collection once linked to one of its cards or rows.
  const purposeParam = c.req.query("purpose");
  if (purposeParam !== undefined && purposeParam !== "file" && purposeParam !== "task_attachment" && purposeParam !== "collection_attachment") {
    return c.json({ error: "Invalid request", details: ["purpose must be file, task_attachment, or collection_attachment"] }, 400);
  }
  const purpose = purposeParam ?? "file";
  const folderParam = c.req.query("folderId");
  if (purpose !== "file" && folderParam !== undefined) return c.json({ error: "Invalid request", details: ["Attachments have no folder"] }, 400);
  const folderId = purpose !== "file" ? null : folderParam === undefined ? ensureDefaultFolder(userId) : uuid.parse(folderParam);
  if (folderId !== null && !ownsFolder(folderId, userId)) return c.json({ error: "Folder not found" }, 404);

  const keyHeader = c.req.header("Idempotency-Key");
  const uploadKey = keyHeader === undefined ? null : uuid.safeParse(keyHeader.trim().toLowerCase()).data ?? null;
  if (keyHeader !== undefined && !uploadKey) return c.json({ error: "Idempotency-Key must be a UUID" }, 400);
  if (uploadKey) {
    const replay = replayFor(userId, uploadKey);
    if (replay?.deleted) return c.json({ error: "This upload was already stored and has since been deleted", code: "IDEMPOTENCY_KEY_USED" }, 409);
    if (replay) return uploadResponse(c, replay.document, true);
  }

  // A declared length is required: it bounds the body Bun delivers, and without it an
  // oversized chunked body can hit Bun's own cap and never reach an end the parser sees.
  const lengthHeader = c.req.header("Content-Length")?.trim();
  const declaredLength = lengthHeader !== undefined && /^\d{1,16}$/.test(lengthHeader) ? Number(lengthHeader) : null;
  if (declaredLength === null || !Number.isSafeInteger(declaredLength)) {
    return c.json({ error: "Content-Length is required for uploads", code: "LENGTH_REQUIRED" }, 411);
  }
  if (declaredLength > config.maxUploadBytes + MULTIPART_OVERHEAD_BYTES) {
    return c.json(fileTooLarge().body, 413);
  }

  const slot = acquireSlot(userId);
  if (!slot) return c.json({ error: "Too many uploads in progress. Wait for one to finish.", code: "TOO_MANY_UPLOADS" }, 429);
  const id = crypto.randomUUID();
  let committed = false;
  try {
    const expectedBytes = Math.min(declaredLength, config.maxUploadBytes);
    const quota = config.userStorageQuotaBytes;
    if (quota > 0 && storedBytes(userId) + slot.otherReservations() + expectedBytes > quota) {
      return c.json({ error: "Storage quota exceeded", code: "QUOTA_EXCEEDED" }, 507);
    }
    slot.reserve(expectedBytes);
    const disk = await statfs(config.dataDir);
    if (disk.bavail * disk.bsize < config.minFreeDiskBytes + expectedBytes) {
      return c.json({ error: "Storage is full", code: "DISK_FULL" }, 507);
    }

    const received = await receiveSingleFile(c.req.raw, id);
    const name = sanitizeDisplayName(received.filename, "upload")!;
    const { mimeType, previewKind } = sniff(received.head, name, received.size);
    await commitStaged(id);
    committed = true;

    let outcome: { replayOf: string } | { created: true };
    try {
      outcome = db.transaction(() => {
        // T80: an upload that authenticated before its owner was blocked must not commit after it.
        if (!db.query("SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL").get(userId)) throw new UploadError(401, { error: "Authentication required" });
        if (uploadKey) {
          const existing = db.query("SELECT id FROM documents WHERE owner_id = ? AND upload_key = ?").get(userId, uploadKey) as { id: string } | null;
          if (existing) return { replayOf: existing.id };
        }
        if (folderId !== null && !ownsFolder(folderId, userId)) throw new UploadError(404, { error: "Folder not found" });
        if (quota > 0 && storedBytes(userId) + received.size > quota) throw new UploadError(507, { error: "Storage quota exceeded", code: "QUOTA_EXCEEDED" });
        const timestamp = now();
        db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, upload_key, purpose, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, userId, folderId, name, mimeType, previewKind, received.size, received.sha256, uploadKey, purpose, timestamp, timestamp);
        audit(userId, null, "document.upload", { documentId: id, size: received.size, mimeType, ...(purpose === "file" ? {} : { purpose }) });
        return { created: true as const };
      })();
    } catch (error) {
      await removeObject(id);
      const uniqueRace = uploadKey && (error as { code?: string }).code?.includes("CONSTRAINT")
        && db.query("SELECT 1 FROM documents WHERE owner_id = ? AND upload_key = ?").get(userId, uploadKey);
      if (!uniqueRace) throw error;
      outcome = { replayOf: (db.query("SELECT id FROM documents WHERE owner_id = ? AND upload_key = ?").get(userId, uploadKey) as { id: string }).id };
    }
    if ("replayOf" in outcome) {
      await removeObject(id);
      const replay = replayFor(userId, uploadKey!);
      if (!replay || replay.deleted) return c.json({ error: "This upload was already stored and has since been deleted", code: "IDEMPOTENCY_KEY_USED" }, 409);
      return uploadResponse(c, replay.document, true);
    }
    return uploadResponse(c, ownedDocumentSummary(id, userId)!, false);
  } catch (error) {
    if (error instanceof UploadError) return c.json(error.body, error.status);
    throw error;
  } finally {
    slot.release();
    if (!committed) await discardStaged(id).catch(() => console.error("Could not discard staged upload"));
  }
}

/** Matches exactly the content route, whose security headers are set here instead of by secureHeaders. */
const contentPath = /^\/api\/files\/[^/]+\/content$/;
export const isContentRequest = (method: string, path: string) => (method === "GET" || method === "HEAD") && contentPath.test(path);

const SANDBOX_CSP = "default-src 'none'; sandbox";
const PDF_CSP = "default-src 'none'; frame-ancestors 'none'";

function applyContentSecurityHeaders(headers: Headers, csp = SANDBOX_CSP) {
  headers.set("Content-Security-Policy", csp);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Cache-Control", "private, no-store");
}

/**
 * Stands in for the global secureHeaders middleware on the content route, so
 * that every response there (including 401/403/404/500 from earlier
 * middleware) carries the strict header set. The route's own CSP wins.
 */
export async function contentRouteSecurityHeaders(c: Context, next: Next) {
  await next();
  const csp = c.res.headers.get("Content-Security-Policy") === PDF_CSP ? PDF_CSP : SANDBOX_CSP;
  applyContentSecurityHeaders(c.res.headers, csp);
}

function contentError(status: 400 | 404 | 500, error: string) {
  const headers = new Headers({ "Content-Type": "application/json" });
  applyContentSecurityHeaders(headers);
  return new Response(JSON.stringify({ error }), { status, headers });
}

async function handleContent(c: Context<AppEnv>) {
  const parsedId = uuid.safeParse(c.req.param("id"));
  if (!parsedId.success) return contentError(400, "Invalid request");
  const id = parsedId.data;
  const document = readableDocument(id, c.get("user").id);
  if (!document) return contentError(404, "File not found");

  let opened: Awaited<ReturnType<typeof openObjectForRead>>;
  try {
    opened = await openObjectForRead(id, document.size_bytes);
  } catch (error) {
    const reason = error instanceof DocumentIntegrityError ? error.reason : error instanceof Error ? error.name : "unknown";
    console.error(`Document content integrity error (${reason}) for document ${id}`);
    return contentError(500, "Something went wrong");
  }

  let keepHandle = false;
  try {
    const inline = c.req.query("disposition") === "inline" && document.preview_kind !== "none";
    const etag = `"${document.sha256}"`;
    const headers = new Headers({
      "Content-Type": inline ? document.mime_type : "application/octet-stream",
      "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", document.name),
      "Accept-Ranges": "bytes",
      ETag: etag,
      "Last-Modified": new Date(document.updated_at).toUTCString()
    });
    applyContentSecurityHeaders(headers, inline && document.preview_kind === "pdf" ? PDF_CSP : SANDBOX_CSP);

    const size = opened.size;
    const ifRange = c.req.header("If-Range");
    const range = ifRange !== undefined && ifRange !== etag ? { kind: "none" as const } : parseRange(c.req.header("Range"), size);
    if (range.kind === "unsatisfiable") {
      headers.set("Content-Range", `bytes */${size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    const start = range.kind === "range" ? range.start : 0;
    const end = range.kind === "range" ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    const status = range.kind === "range" ? 206 : 200;
    if (range.kind === "range") headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(length));
    if (c.req.raw.method === "HEAD" || length === 0) return new Response(null, { status, headers });

    // The read stream owns the handle from here: it closes on end, error, or cancel (client abort).
    const stream = opened.handle.createReadStream({ start, end, highWaterMark: 65_536 });
    keepHandle = true;
    const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, { status, headers });
  } finally {
    if (!keepHandle) await opened.handle.close();
  }
}

const notFound = (c: Context<AppEnv>) => c.json({ error: "File not found" }, 404);
const withDocumentLock = <T>(id: string, operation: () => Promise<T>) => withResourceLock(`document:${id}`, operation);

export function registerDocumentRoutes(app: Hono<AppEnv>) {
  app.post("/api/files", handleUpload);

  app.get("/api/files", (c) => {
    const folderId = c.req.query("folderId");
    return c.json({ documents: listReadableDocuments(c.get("user").id, folderId === undefined ? null : uuid.parse(folderId)) });
  });

  app.on(["GET", "HEAD"], "/api/files/:id/content", handleContent);

  app.get("/api/files/:id", (c) => {
    const id = uuid.parse(c.req.param("id"));
    const document = readableDocumentSummary(id, c.get("user").id);
    return document ? c.json({ document }) : notFound(c);
  });

  app.patch("/api/files/:id", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const userId = c.get("user").id;
    const body = await parseJson(c.req.raw, documentPatchSchema);
    return withDocumentLock(id, async () => {
      if (!ownedFileDocument(id, userId)) return notFound(c);
      let name: string | null = null;
      if (body.name !== undefined) {
        name = sanitizeDisplayName(body.name, "rename");
        if (!name) return c.json({ error: "Enter a name of 1 to 255 bytes that is not . or .." }, 400);
      }
      const moving = body.folderId !== undefined;
      if (body.folderId && !db.query("SELECT 1 FROM folders WHERE id = ? AND owner_id = ?").get(body.folderId, userId)) {
        return c.json({ error: "Folder not found" }, 404);
      }
      db.transaction(() => {
        db.query(`UPDATE documents SET name = COALESCE(?, name), folder_id = CASE WHEN ? THEN ? ELSE folder_id END, updated_at = ?
          WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`)
          .run(name, moving ? 1 : 0, body.folderId ?? null, now(), id, userId);
        if (name !== null) audit(userId, null, "document.rename", { documentId: id });
        if (moving) audit(userId, null, "document.move", { documentId: id, folderId: body.folderId ?? null });
      })();
      return c.json({ document: ownedDocumentSummary(id, userId)! });
    });
  });

  app.get("/api/files/:id/sharing", (c) => {
    const id = uuid.parse(c.req.param("id"));
    const document = ownedFileDocument(id, c.get("user").id);
    if (!document) return notFound(c);
    const users = db.query("SELECT u.id, u.display_name FROM document_shares s JOIN users u ON u.id = s.user_id WHERE s.document_id = ? ORDER BY u.display_name")
      .all(id);
    return c.json({ visibility: document.sharing_override ? document.visibility : "inherit", users });
  });

  app.put("/api/files/:id/sharing", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const userId = c.get("user").id;
    if (!ownedFileDocument(id, userId)) return notFound(c);
    const body = await parseJson(c.req.raw, sharingSchema);
    if (body.userIds.includes(userId)) return c.json({ error: "The owner cannot be added as a recipient" }, 400);
    const uniqueIds = [...new Set(body.userIds)];
    if (body.visibility === "selected" && uniqueIds.length === 0) return c.json({ error: "Select at least one user" }, 400);
    if (uniqueIds.length) {
      const placeholders = uniqueIds.map(() => "?").join(",");
      const validUsers = db.query(`SELECT id FROM users WHERE disabled_at IS NULL AND id IN (${placeholders})`).all(...uniqueIds);
      if (validUsers.length !== uniqueIds.length) return c.json({ error: "One or more users were not found" }, 400);
    }
    return withDocumentLock(id, async () => {
      if (!ownedFileDocument(id, userId)) return notFound(c);
      db.transaction(() => {
        const before = shareMembers("document_shares", "document_id", id);
        db.query("DELETE FROM document_shares WHERE document_id = ?").run(id);
        if (body.visibility === "selected") {
          const statement = db.query("INSERT INTO document_shares (document_id, user_id, created_at) VALUES (?, ?, ?)");
          for (const recipientId of uniqueIds) statement.run(id, recipientId, now());
          // "Shared with you" mail (outbound email #25).
          mailShared(userId, "file", id, before, uniqueIds);
        }
        const visibility = body.visibility === "inherit" ? "private" : body.visibility;
        db.query("UPDATE documents SET visibility = ?, sharing_override = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
          .run(visibility, body.visibility === "inherit" ? 0 : 1, now(), id, userId);
        audit(userId, null, "document.sharing_changed", { documentId: id, visibility: body.visibility, recipientCount: uniqueIds.length });
      })();
      return c.json({ ok: true });
    });
  });

  app.delete("/api/files/:id", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const userId = c.get("user").id;
    return withDocumentLock(id, async () => {
      const document = ownedDocument(id, userId, { includeDeleted: true });
      if (!document) return notFound(c);
      if (document.deleted_at) return c.json({ ok: true, alreadyDeleted: true, purgeAfter: document.purge_after });
      // An attachment is removed from its cards (Tasks) or rows (Collections), which bins it once nothing uses it.
      if (document.purpose !== "file" && db.query("SELECT 1 FROM card_attachments WHERE document_id = ?").get(id)) {
        return c.json({ error: "Remove this file from its cards first", code: "ATTACHMENT_LINKED" }, 409);
      }
      if (document.purpose !== "file" && db.query("SELECT 1 FROM collection_row_attachments WHERE document_id = ?").get(id)) {
        return c.json({ error: "Remove this file from its rows first", code: "ATTACHMENT_LINKED" }, 409);
      }
      const deletedAt = new Date();
      const purgeAfter = purgeAfterFrom(deletedAt);
      db.transaction(() => {
        db.query("UPDATE documents SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
          .run(deletedAt.toISOString(), userId, purgeAfter, id, userId);
        audit(userId, null, "document.delete", { documentId: id });
      })();
      return c.json({ ok: true, purgeAfter });
    });
  });
}
