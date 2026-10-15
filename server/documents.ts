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
import { createDocumentWriter, DocumentIntegrityError, openObjectForRead, removeObject } from "./documentStorage";
import { diskBytesNeeded, StorageUnavailableError, type ObjectWriter } from "./objectStore";
import { SNIFF_BYTES, sniff } from "./mimeSniff";
import { withResourceLock } from "./storage";
import { purgeAfterFrom } from "./bin";
import { documentPatchSchema, parseJson, sanitizeDisplayName, sharingSchema, uuid } from "./validation";
import { mailShared, shareMembers } from "./mail/triggers";
import { GUEST_SHARE_DISABLED, legacyGuestShareBlocked, writeDirectShares } from "./access/shares";
import { whiteboardFileName } from "../shared/whiteboardScene";
import { isWhiteboard, renameWhiteboardIndex } from "./whiteboards/search";
import { renameDocumentIndex, scheduleDocumentIndex } from "./documentSearch";
import { sourceAccessChangedHook } from "./knowledge/hooks";
import { isHostKind } from "./attachments/hosts";
import { ensureSystemFolder, isSystemFolder, SYSTEM_FOLDER_BODY, SYSTEM_FOLDER_MESSAGE } from "./attachments/service";
import { logger } from "./log";

const slog = logger("files");

const MAX_CONCURRENT_UPLOADS = 3;
const MULTIPART_OVERHEAD_BYTES = 65_536;
const DEFAULT_UPLOAD_IDLE_TIMEOUT_MS = 30_000;
let uploadIdleTimeoutMs = DEFAULT_UPLOAD_IDLE_TIMEOUT_MS;

/** Test hook: shortens the upload inactivity watchdog. Pass null to restore the default. */
export function setUploadIdleTimeoutForTests(ms: number | null) {
  uploadIdleTimeoutMs = ms ?? DEFAULT_UPLOAD_IDLE_TIMEOUT_MS;
}

class UploadError extends Error {
  constructor(readonly status: 400 | 401 | 404 | 408 | 409 | 411 | 413 | 429 | 503 | 507, readonly body: Record<string, unknown>) {
    super(String(body.error));
  }
}

const fileTooLarge = () => new UploadError(413, { error: "File is too large", code: "FILE_TOO_LARGE", limitBytes: config.maxUploadBytes });
const badPart = (error = "Upload exactly one file part named file") => new UploadError(400, { error });
/** The object store (S3) failed: the upload is not the client's fault, and nothing was kept. */
const storageUnavailable = (error: StorageUnavailableError) => error.code === "Busy"
  ? new UploadError(503, { error: "Too many uploads are going to file storage. Retry in a moment.", code: "STORAGE_BUSY", retryAfter: 5 })
  : new UploadError(503, { error: "File storage is unavailable. Try again later.", code: "STORAGE_UNAVAILABLE", retryAfter: 5 });

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

/**
 * Bytes that count against the quota: every document the user owns, live or binned, plus the
 * snapshots and thumbnails of their whiteboards (§6, review L8; a board's `size_bytes` is its
 * current scene), and each distinct picture their chats keep from tools (chat_tool_images, review M2).
 */
export const storedBytes = (userId: string) =>
  (db.query(`SELECT COALESCE((SELECT SUM(size_bytes) FROM documents WHERE owner_id = $userId), 0)
    + COALESCE((SELECT SUM(s.size_bytes) FROM whiteboard_snapshots s JOIN documents d ON d.id = s.document_id WHERE d.owner_id = $userId), 0)
    + COALESCE((SELECT SUM(length(w.thumb_png)) FROM whiteboards w JOIN documents d ON d.id = w.document_id WHERE d.owner_id = $userId AND w.thumb_png IS NOT NULL), 0)
    + COALESCE((SELECT SUM(size_bytes) FROM (SELECT DISTINCT r.sha256, r.size_bytes FROM chat_tool_images r JOIN chats c ON c.id = r.chat_id WHERE c.owner_id = $userId)), 0) AS total`).get({ userId }) as { total: number }).total;

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

async function writeFilePart(stream: Readable & { truncated?: boolean }, filename: string, writer: ObjectWriter, onChunk?: (size: number) => void): Promise<ReceivedFile> {
  try {
    const hash = createHash("sha256");
    const head = new Uint8Array(SNIFF_BYTES);
    let headLength = 0;
    let size = 0;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      size += chunk.byteLength;
      // May throw to stop early (a raw body longer than declared); the finally closes the handle.
      onChunk?.(size);
      hash.update(chunk);
      if (headLength < SNIFF_BYTES) {
        const take = Math.min(SNIFF_BYTES - headLength, chunk.byteLength);
        head.set(chunk.subarray(0, take), headLength);
        headLength += take;
      }
      await writer.write(chunk);
    }
    if (stream.truncated || size > config.maxUploadBytes) throw fileTooLarge();
    return { filename, size, sha256: hash.digest("hex"), head: head.subarray(0, headLength) };
  } catch (error) {
    throw error instanceof StorageUnavailableError ? storageUnavailable(error) : error;
  }
}

/**
 * Streams exactly one multipart file part into a staged object writer. Nothing but the first
 * SNIFF_BYTES (and, on S3, about one upload part) is kept in memory; writes are awaited, so the
 * request body is only read as fast as the store accepts it.
 */
function receiveSingleFile(request: Request, writer: ObjectWriter): Promise<ReceivedFile> {
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
            slog.error("Upload teardown step failed", teardownError);
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
      filePromise = writeFilePart(stream, info.filename ?? "", writer);
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

type UploadMeta = { folderId: string | null; purpose: string; uploadKey: string | null; name: string };

/**
 * Commits a received staging file as a document: sniff (never the client's type), move into the
 * store, then one transaction with the T80 block re-check, the idempotency replay, the folder and
 * quota re-checks, the insert, and the audit row. Shared by the web multipart upload and the MCP
 * paths (Wave 19, D176), so both keep exactly these rules. `markCommitted` runs once the staging
 * file has moved, after which the caller must not discard it.
 */
async function commitReceived(userId: string, id: string, writer: ObjectWriter, received: ReceivedFile, meta: UploadMeta, markCommitted: () => void) {
  const { folderId, purpose, uploadKey, name } = meta;
  const quota = config.userStorageQuotaBytes;
  const { mimeType, previewKind } = sniff(received.head, name, received.size);
  // The object first, then the row; a failed row removes the object again.
  try {
    await writer.commit();
  } catch (error) {
    throw error instanceof StorageUnavailableError ? storageUnavailable(error) : error;
  }
  markCommitted();

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
    await removeObject(id).catch((error) => slog.error("Could not remove an uncommitted upload; the sweeper will", error));
    const uniqueRace = uploadKey && (error as { code?: string }).code?.includes("CONSTRAINT")
      && db.query("SELECT 1 FROM documents WHERE owner_id = ? AND upload_key = ?").get(userId, uploadKey);
    if (!uniqueRace) throw error;
    outcome = { replayOf: (db.query("SELECT id FROM documents WHERE owner_id = ? AND upload_key = ?").get(userId, uploadKey) as { id: string }).id };
  }
  if ("replayOf" in outcome) {
    await removeObject(id).catch((error) => slog.error("Could not remove an uncommitted upload; the sweeper will", error));
    const replay = replayFor(userId, uploadKey!);
    if (!replay || replay.deleted) throw new UploadError(409, { error: "This upload was already stored and has since been deleted", code: "IDEMPOTENCY_KEY_USED" });
    return { document: replay.document, replay: true };
  }
  // Lane FTS: the Files search index reads the new text in the background.
  scheduleDocumentIndex();
  return { document: ownedDocumentSummary(id, userId)!, replay: false };
}

/**
 * Streams a raw body (no multipart) into staging with the web upload's inactivity watchdog. The
 * body must be exactly `expectedBytes` long: longer stops at once, shorter fails after it ends.
 */
async function receiveRaw(source: Readable, writer: ObjectWriter, expectedBytes: number, signal?: AbortSignal): Promise<ReceivedFile> {
  let failure: UploadError | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const fail = (error: UploadError) => {
    failure ??= error;
    source.destroy();
  };
  const arm = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => fail(new UploadError(408, { error: "The upload stalled", code: "UPLOAD_TIMEOUT" })), uploadIdleTimeoutMs);
  };
  const onAbort = () => fail(badPart("The upload was interrupted"));
  const sizeMismatch = () => new UploadError(400, { error: "The body length does not match the declared size", code: "SIZE_MISMATCH" });
  signal?.addEventListener("abort", onAbort, { once: true });
  arm();
  try {
    const received = await writeFilePart(source, "", writer, (size) => {
      arm();
      if (size > expectedBytes) throw sizeMismatch();
    });
    if (failure) throw failure;
    if (received.size !== expectedBytes) throw sizeMismatch();
    return received;
  } catch (error) {
    if (failure) throw failure;
    if (error instanceof UploadError) throw error;
    throw badPart("The upload was interrupted");
  } finally {
    if (idle) clearTimeout(idle);
    signal?.removeEventListener("abort", onAbort);
  }
}

export type StoreRawOptions = {
  userId: string;
  /** Already sanitized with sanitizeDisplayName(…, "upload"). */
  name: string;
  folderId: string | null;
  purpose: "file";
  /** Makes retries idempotent (the web upload's Idempotency-Key; the MCP upload ticket id). */
  uploadKey: string | null;
  expectedBytes: number;
  /** When set, the received bytes must hash to it (hex), or nothing is committed (HASH_MISMATCH). */
  sha256?: string;
};

/**
 * Stores a raw byte stream as a document through the web upload's pipeline (Wave 19, D176): the
 * idempotent replay, the per-user upload slots and quota reservations, the quota and free-disk
 * checks, sniffing, the T80 re-check, and the audit row. Answers the web upload's statuses and
 * bodies: 201 `{document}`, 200 `{document, idempotentReplay: true}`, or an error.
 */
export async function storeRawUpload(source: Readable, options: StoreRawOptions, signal?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }> {
  const { userId, uploadKey, expectedBytes } = options;
  if (uploadKey) {
    const replay = replayFor(userId, uploadKey);
    if (replay?.deleted) return { status: 409, body: { error: "This upload was already stored and has since been deleted", code: "IDEMPOTENCY_KEY_USED" } };
    if (replay) return { status: 200, body: { document: replay.document, idempotentReplay: true } };
  }
  if (expectedBytes > config.maxUploadBytes) return { status: 413, body: fileTooLarge().body };
  if (options.folderId !== null && !ownsFolder(options.folderId, userId)) return { status: 404, body: { error: "Folder not found" } };
  const slot = acquireSlot(userId);
  if (!slot) return { status: 429, body: { error: "Too many uploads in progress. Wait for one to finish.", code: "TOO_MANY_UPLOADS" } };
  const id = crypto.randomUUID();
  const writer = createDocumentWriter(id);
  let committed = false;
  try {
    const quota = config.userStorageQuotaBytes;
    if (quota > 0 && storedBytes(userId) + slot.otherReservations() + expectedBytes > quota) {
      return { status: 507, body: { error: "Storage quota exceeded", code: "QUOTA_EXCEEDED" } };
    }
    slot.reserve(expectedBytes);
    // MIN_FREE_DISK_BYTES protects the data volume (SQLite always; the bytes too when they land there).
    const disk = await statfs(config.dataDir);
    if (disk.bavail * disk.bsize < diskBytesNeeded(expectedBytes)) return { status: 507, body: { error: "Storage is full", code: "DISK_FULL" } };
    const received = await receiveRaw(source, writer, expectedBytes, signal);
    if (options.sha256 && received.sha256 !== options.sha256.toLowerCase()) {
      return { status: 400, body: { error: "The received bytes do not match the declared SHA-256", code: "HASH_MISMATCH" } };
    }
    const result = await commitReceived(userId, id, writer, received, { folderId: options.folderId, purpose: options.purpose, uploadKey, name: options.name }, () => { committed = true; });
    return result.replay ? { status: 200, body: { document: result.document, idempotentReplay: true } } : { status: 201, body: { document: result.document } };
  } catch (error) {
    if (error instanceof UploadError) return { status: error.status, body: error.body };
    throw error;
  } finally {
    slot.release();
    if (!committed) await writer.discard().catch((error) => slog.error("Could not discard staged upload", error));
    // The row is committed (or there is none): the orphan sweep may judge the object again (review M1).
    writer.release();
  }
}

function uploadResponse(c: Context<AppEnv>, document: DocumentSummary, replay: boolean) {
  return replay ? c.json({ document, idempotentReplay: true }, 200) : c.json({ document }, 201);
}

async function handleUpload(c: Context<AppEnv>) {
  const userId = c.get("user").id;
  // Every upload is a Files document (D390). The older `?purpose=task_attachment` and
  // `?purpose=collection_attachment` (hidden attachments until 047, uploads everywhere U8) are still
  // accepted from older clients and mean `?attachTo=card` and `?attachTo=row`.
  const purposeParam = c.req.query("purpose");
  if (purposeParam !== undefined && purposeParam !== "file" && purposeParam !== "task_attachment" && purposeParam !== "collection_attachment") {
    return c.json({ error: "Invalid request", details: ["purpose must be file, task_attachment, or collection_attachment"] }, 400);
  }
  const purpose = "file";
  const legacyAttach = purposeParam === "task_attachment" || purposeParam === "collection_attachment";
  const folderParam = c.req.query("folderId");
  if (legacyAttach && folderParam !== undefined) return c.json({ error: "Invalid request", details: ["Attachments have no folder"] }, 400);
  // Uploads everywhere (D390, D391): `?attachTo=<host kind>` stores an ordinary Files document in the
  // uploader's Attachments folder, created on first use; the caller then links it to the host.
  const attachTo = c.req.query("attachTo");
  if (attachTo !== undefined) {
    if (!isHostKind(attachTo)) return c.json({ error: "Invalid request", details: ["attachTo must be a host kind such as event, note, card, row, or chat_message"] }, 400);
    if (purposeParam !== undefined || folderParam !== undefined) return c.json({ error: "Invalid request", details: ["attachTo takes no purpose or folderId"] }, 400);
  }
  const toAttachments = attachTo !== undefined || legacyAttach;
  const folderId = toAttachments ? ensureSystemFolder(userId) : folderParam === undefined ? ensureDefaultFolder(userId) : uuid.parse(folderParam);
  if (!ownsFolder(folderId, userId)) return c.json({ error: "Folder not found" }, 404);
  // T342: nothing is uploaded into a system folder directly; attachments arrive through attachTo.
  if (!toAttachments && isSystemFolder(folderId)) return c.json(SYSTEM_FOLDER_BODY, 400);

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
  const writer = createDocumentWriter(id);
  let committed = false;
  try {
    const expectedBytes = Math.min(declaredLength, config.maxUploadBytes);
    const quota = config.userStorageQuotaBytes;
    if (quota > 0 && storedBytes(userId) + slot.otherReservations() + expectedBytes > quota) {
      return c.json({ error: "Storage quota exceeded", code: "QUOTA_EXCEEDED" }, 507);
    }
    slot.reserve(expectedBytes);
    const disk = await statfs(config.dataDir);
    if (disk.bavail * disk.bsize < diskBytesNeeded(expectedBytes)) {
      return c.json({ error: "Storage is full", code: "DISK_FULL" }, 507);
    }

    const received = await receiveSingleFile(c.req.raw, writer);
    const name = sanitizeDisplayName(received.filename, "upload")!;
    const result = await commitReceived(userId, id, writer, received, { folderId, purpose, uploadKey, name }, () => { committed = true; });
    return uploadResponse(c, result.document, result.replay);
  } catch (error) {
    if (error instanceof UploadError) {
      if (error.status === 503) c.header("Retry-After", "5");
      return c.json(error.body, error.status);
    }
    throw error;
  } finally {
    slot.release();
    if (!committed) await writer.discard().catch((error) => slog.error("Could not discard staged upload", error));
    // The row is committed (or there is none): the orphan sweep may judge the object again (review M1).
    writer.release();
  }
}

/** Matches exactly the content route, whose security headers are set here instead of by secureHeaders. */
const contentPath = /^\/api\/files\/[^/]+\/content$/;
/** Whiteboard thumbnails (Wave 23, D200, T169) get the same strict header set. */
const thumbnailPath = /^\/api\/whiteboards\/[^/]+\/thumbnail$/;
export const isContentRequest = (method: string, path: string) => (method === "GET" || method === "HEAD") && (contentPath.test(path) || thumbnailPath.test(path));

const SANDBOX_CSP = "default-src 'none'; sandbox";
const PDF_CSP = "default-src 'none'; frame-ancestors 'none'";
/** A thumbnail may be revalidated by its ETag instead of downloaded again (D200); everything else is never stored. */
export const REVALIDATE_CACHE = "private, no-cache";

export function applyContentSecurityHeaders(headers: Headers, csp = SANDBOX_CSP) {
  const cache = headers.get("Cache-Control") === REVALIDATE_CACHE ? REVALIDATE_CACHE : "private, no-store";
  headers.set("Content-Security-Policy", csp);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Cache-Control", cache);
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

/** A whiteboard's current scene object with the size, hash, and time that describe it, or null for any other document. */
function whiteboardObject(documentId: string) {
  const row = db.query(`SELECT w.object_id, d.size_bytes, d.sha256, d.updated_at FROM whiteboards w JOIN documents d ON d.id = w.document_id WHERE w.document_id = ?`)
    .get(documentId) as { object_id: string; size_bytes: number; sha256: string; updated_at: string } | null;
  return row ? { objectId: row.object_id, row: { size_bytes: row.size_bytes, sha256: row.sha256, updated_at: row.updated_at } } : null;
}

function contentError(status: 400 | 404 | 500 | 503, error: string, code?: string) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (status === 503) headers.set("Retry-After", "5");
  applyContentSecurityHeaders(headers);
  return new Response(JSON.stringify(code ? { error, code } : { error }), { status, headers });
}

async function handleContent(c: Context<AppEnv>) {
  const parsedId = uuid.safeParse(c.req.param("id"));
  if (!parsedId.success) return contentError(400, "Invalid request");
  const id = parsedId.data;
  let document = readableDocument(id, c.get("user").id);
  if (!document) return contentError(404, "File not found");

  let opened: Awaited<ReturnType<typeof openObjectForRead>>;
  try {
    // A whiteboard's bytes are its current scene object (D193): read the object id with the size and
    // hash in one query, and re-read once when a save replaced the object in between (§6).
    const board = whiteboardObject(id);
    if (board) {
      document = { ...document, ...board.row };
      try {
        opened = await openObjectForRead(board.objectId, board.row.size_bytes);
      } catch (error) {
        const again = error instanceof DocumentIntegrityError ? whiteboardObject(id) : null;
        if (!again || again.objectId === board.objectId) throw error;
        document = { ...document, ...again.row };
        opened = await openObjectForRead(again.objectId, again.row.size_bytes);
      }
    } else {
      opened = await openObjectForRead(id, document.size_bytes);
    }
  } catch (error) {
    const reason = error instanceof DocumentIntegrityError ? error.reason : error instanceof StorageUnavailableError ? error.code : error instanceof Error ? error.name : "unknown";
    slog.error(`Document content ${error instanceof StorageUnavailableError ? "storage" : "integrity"} error`, { reason, doc: id.slice(0, 8), err: error });
    // S3 storage (review L1): an unreachable store is retryable; a missing or wrong-sized object fails closed.
    if (error instanceof StorageUnavailableError) return contentError(503, "File storage is unavailable. Try again later.", "STORAGE_UNAVAILABLE");
    return contentError(500, "Something went wrong");
  }

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

    // The stream owns the object from here: it closes on end, error, or cancel (client abort).
    return new Response(opened.stream(start, end), { status, headers });
  } finally {
    await opened.close();
  }
}

const notFound = (c: Context<AppEnv>) => c.json({ error: "File not found" }, 404);
const withDocumentLock = <T>(id: string, operation: () => Promise<T>) => withResourceLock(`document:${id}`, operation);

export class DocumentPatchError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string, readonly code?: "AUDIENCE_CHANGE" | "SYSTEM_FOLDER") {
    super(message);
    this.name = "DocumentPatchError";
  }
}

/** The audience a folder gives inheriting files: its visibility and, for `selected`, its recipients. */
function folderAudience(folderId: string | null) {
  if (folderId === null) return "private";
  const folder = db.query("SELECT visibility FROM folders WHERE id = ?").get(folderId) as { visibility: string } | null;
  if (!folder || folder.visibility === "private") return "private";
  if (folder.visibility === "all_users") return "all_users";
  const users = db.query("SELECT user_id, level FROM folder_shares WHERE folder_id = ? ORDER BY user_id").all(folderId) as Array<{ user_id: string; level: string }>;
  // Groups count too (Wave 32): the same people with a different group grant is a different audience.
  const groups = db.query("SELECT group_id, level FROM group_grants WHERE resource_kind = 'folder' AND resource_id = ? ORDER BY group_id").all(folderId) as Array<{ group_id: string; level: string }>;
  return `selected:${users.map((user) => `${user.user_id}=${user.level}`).join(",")}|${groups.map((group) => `${group.group_id}=${group.level}`).join(",")}`;
}

/**
 * Renames and/or moves one of the caller's Files documents (PATCH /api/files/:id and the MCP
 * rename_file and move_file tools). `refuseAudienceChange` (MCP, D177, T147) refuses a move that
 * would change who can see the file: it inherits its folder's sharing and the two folders' audiences
 * differ. A file with its own sharing moves freely.
 */
export async function patchDocument(userId: string, id: string, input: { name?: string; folderId?: string | null }, options: { refuseAudienceChange?: boolean } = {}) {
  return withDocumentLock(id, async () => {
    const document = ownedFileDocument(id, userId);
    if (!document) throw new DocumentPatchError(404, "File not found");
    let name: string | null = null;
    if (input.name !== undefined) {
      name = sanitizeDisplayName(input.name, "rename");
      if (!name) throw new DocumentPatchError(400, "Enter a name of 1 to 255 bytes that is not . or ..");
      // A whiteboard keeps its `.excalidraw` suffix when the new name drops it (§8); lists hide it anyway.
      if (isWhiteboard(id)) {
        name = sanitizeDisplayName(whiteboardFileName(name), "rename");
        if (!name) throw new DocumentPatchError(400, "Enter a shorter name");
      }
    }
    const moving = input.folderId !== undefined;
    if (input.folderId && !db.query("SELECT 1 FROM folders WHERE id = ? AND owner_id = ?").get(input.folderId, userId)) {
      throw new DocumentPatchError(404, "Folder not found");
    }
    // T342, D392: files may leave a system folder, never enter one (an upload with attachTo puts them there).
    if (input.folderId && input.folderId !== document.folder_id && isSystemFolder(input.folderId)) throw new DocumentPatchError(400, SYSTEM_FOLDER_MESSAGE, "SYSTEM_FOLDER");
    if (moving && options.refuseAudienceChange && document.sharing_override === 0 && folderAudience(document.folder_id) !== folderAudience(input.folderId ?? null)) {
      throw new DocumentPatchError(409, "Moving this file would change who can see it", "AUDIENCE_CHANGE");
    }
    db.transaction(() => {
      db.query(`UPDATE documents SET name = COALESCE(?, name), folder_id = CASE WHEN ? THEN ? ELSE folder_id END, updated_at = ?
        WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`)
        .run(name, moving ? 1 : 0, input.folderId ?? null, now(), id, userId);
      if (name !== null) audit(userId, null, "document.rename", { documentId: id });
      if (name !== null) renameWhiteboardIndex(id, name);
      if (name !== null) renameDocumentIndex(id, name);
      if (moving) audit(userId, null, "document.move", { documentId: id, folderId: input.folderId ?? null });
    })();
    // A file that uses its folder's access may change audience with the move (Wave 44 fixes, M1).
    if (moving) sourceAccessChangedHook({ kind: "document", ids: [id] });
    return ownedDocumentSummary(id, userId)!;
  });
}

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
    try {
      return c.json({ document: await patchDocument(userId, id, body) });
    } catch (error) {
      if (error instanceof DocumentPatchError) return c.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
      throw error;
    }
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
    if (body.visibility === "selected" && legacyGuestShareBlocked("document", id, uniqueIds.map((recipientId) => ({ userId: recipientId, level: "view" as const })))) return c.json(GUEST_SHARE_DISABLED, 400);
    return withDocumentLock(id, async () => {
      if (!ownedFileDocument(id, userId)) return notFound(c);
      db.transaction(() => {
        const before = shareMembers("document_shares", "document_id", id);
        // Files stay view-only (D275); group grants are left as they are.
        writeDirectShares("document", id, body.visibility === "selected" ? uniqueIds.map((recipientId) => ({ userId: recipientId, level: "view" as const })) : []);
        if (body.visibility === "selected") {
          // "Shared with you" mail (outbound email #25).
          mailShared(userId, "file", id, before, uniqueIds);
        }
        const visibility = body.visibility === "inherit" ? "private" : body.visibility;
        db.query("UPDATE documents SET visibility = ?, sharing_override = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
          .run(visibility, body.visibility === "inherit" ? 0 : 1, now(), id, userId);
        audit(userId, null, "document.sharing_changed", { documentId: id, visibility: body.visibility, recipientCount: uniqueIds.length });
      })();
      sourceAccessChangedHook({ kind: "document", ids: [id] });
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
      // A file still on cards, rows, or other hosts may be deleted (D409; it replaced the hidden
      // attachments' 409 ATTACHMENT_LINKED, gone with them in 047): its links stay, hosts show "File
      // removed", and a restore brings it back. Files asks first, naming the uses (GET /api/files/:id/usage).
      const deletedAt = new Date();
      const purgeAfter = purgeAfterFrom(deletedAt);
      db.transaction(() => {
        db.query("UPDATE documents SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
          .run(deletedAt.toISOString(), userId, purgeAfter, id, userId);
        audit(userId, null, "document.delete", { documentId: id });
      })();
      // Wave 44 fixes (M1): a binned file's passages leave every knowledge base at once.
      sourceAccessChangedHook({ kind: "document", ids: [id] });
      return c.json({ ok: true, purgeAfter });
    });
  });
}
