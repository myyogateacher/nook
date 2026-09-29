import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { config } from "../config";
import { audit, db, ensureDefaultFolder, now } from "../db";
import { documentSummarySelect, readableDocumentPredicate, type DocumentSummary } from "../documentAccess";
import { DocumentIntegrityError, openObjectForRead, removeObject, writeObject } from "../documentStorage";
import { storedBytes } from "../documents";
import { withResourceLock } from "../storage";
import { sanitizeDisplayName } from "../validation";
import { canWriteContent } from "../team/userRole";
import {
  canonicalSceneJson, emptyScene, validateScene, whiteboardFileName, WHITEBOARD_MAX_SCENE_BYTES, WHITEBOARD_MIME,
  type CanonicalScene, type SceneErrorCode
} from "../../shared/whiteboardScene";
import { indexWhiteboard } from "./search";

/**
 * Whiteboards on Files (docs/plan/research/2026-09-28-whiteboard-module.md §6, §8, D192–D194,
 * D200). A board is a `documents` row (purpose 'file', MIME application/vnd.excalidraw+json, a name
 * ending in `.excalidraw`) plus a `whiteboards` row. Its bytes are a copy-on-write object per save,
 * named by `whiteboards.object_id`, never by the document id. Access is the Files predicate
 * (readable to read, owner to write); anything missing or forbidden is 404 (T168).
 */

export const WHITEBOARD_NAME_MAX = 200;
export const THUMBNAIL_MAX_BYTES = 128 * 1024;
export const THUMBNAIL_MAX_SIDE = 2048;
const SAVE_AUDIT_INTERVAL_MS = 10 * 60_000;
const LIST_LIMIT = 500;

export class WhiteboardError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 415 | 507, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "WhiteboardError";
  }
}

const notFound = () => new WhiteboardError(404, "NOT_FOUND", "Whiteboard not found");

export type WhiteboardSummary = DocumentSummary & {
  kind: "whiteboard";
  revision: number;
  elementCount: number;
  hasThumbnail: boolean;
  thumbRevision: number | null;
  /** Only the owner edits (D195, D275), and only while their role writes. */
  canEdit: boolean;
};

type BoardColumns = { revision: number; element_count: number; has_thumb: 0 | 1; thumb_revision: number | null };

const summarySelect = documentSummarySelect.replace(
  "FROM documents d JOIN users u ON u.id = d.owner_id",
  ", w.revision, w.element_count, w.thumb_png IS NOT NULL AS has_thumb, w.thumb_revision FROM documents d JOIN whiteboards w ON w.document_id = d.id JOIN users u ON u.id = d.owner_id"
);

function toSummary(row: DocumentSummary & BoardColumns, userId: string): WhiteboardSummary {
  const { revision, element_count, has_thumb, thumb_revision, ...document } = row;
  return {
    ...document, kind: "whiteboard", revision, elementCount: element_count, hasThumbnail: has_thumb === 1, thumbRevision: thumb_revision,
    canEdit: document.is_owner === 1 && canWriteContent(userId)
  };
}

/** A live board `userId` can read (the Files list predicate), or null. */
export function readableWhiteboard(documentId: string, userId: string) {
  const row = db.query(`${summarySelect} WHERE d.id = $documentId AND d.purpose = 'file' AND ${readableDocumentPredicate}`).get({ documentId, userId }) as (DocumentSummary & BoardColumns) | null;
  return row ? toSummary(row, userId) : null;
}

/** Boards `userId` can read: all, the ones others shared, or one folder. At most 500, newest edit first. */
export function listWhiteboards(userId: string, folder: "all" | "shared" | string, options: { limit?: number; ids?: readonly string[] } = {}) {
  const folderFilter = folder === "all" ? "" : folder === "shared" ? "AND d.owner_id <> $userId" : "AND d.folder_id = $folderId";
  const rows = db.query(`${summarySelect} WHERE d.purpose = 'file' AND ${readableDocumentPredicate} ${folderFilter}
    ORDER BY d.updated_at DESC, d.id LIMIT $limit`)
    .all({ userId, limit: Math.min(options.limit ?? LIST_LIMIT, LIST_LIMIT), ...(folder !== "all" && folder !== "shared" ? { folderId: folder } : {}) }) as Array<DocumentSummary & BoardColumns>;
  return rows.map((row) => toSummary(row, userId));
}

type OwnedBoard = { id: string; owner_id: string; name: string; size_bytes: number; sha256: string; revision: number; object_id: string; thumb_revision: number | null };

/** A live board owned by `userId` (not binned, not being purged), or null. */
function ownedBoard(documentId: string, userId: string) {
  return db.query(`SELECT d.id, d.owner_id, d.name, d.size_bytes, d.sha256, w.revision, w.object_id, w.thumb_revision
    FROM documents d JOIN whiteboards w ON w.document_id = d.id
    WHERE d.id = ? AND d.owner_id = ? AND d.deleted_at IS NULL AND d.purge_started_at IS NULL AND d.purpose = 'file'`).get(documentId, userId) as OwnedBoard | null;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encoder = new TextEncoder();
const lockKey = (id: string) => `document:${id}`;

/** The canonical bytes of a scene the validator accepted, or a 400/413 error. */
export function prepareScene(input: unknown) {
  const result = validateScene(input);
  if (!result.ok) throw new WhiteboardError(400, result.code, result.message);
  const bytes = encoder.encode(canonicalSceneJson(result.scene));
  if (bytes.byteLength > WHITEBOARD_MAX_SCENE_BYTES) throw new WhiteboardError(413, "SCENE_TOO_LARGE", "This whiteboard is too large to save");
  return { scene: result.scene, stats: result.stats, bytes, sha256: sha256(bytes) };
}

async function ensureDiskSpace(bytes: number) {
  const disk = await statfs(config.dataDir);
  if (disk.bavail * disk.bsize < config.minFreeDiskBytes + bytes) throw new WhiteboardError(507, "DISK_FULL", "Storage is full");
}

function checkQuota(userId: string, delta: number) {
  const quota = config.userStorageQuotaBytes;
  if (quota > 0 && storedBytes(userId) + delta > quota) throw new WhiteboardError(507, "QUOTA_EXCEEDED", "Storage quota exceeded");
}

/** The name as stored: §6.4 rules, 1–200 characters before the suffix, always ending in `.excalidraw`. */
export function whiteboardStoredName(input: string) {
  const cleaned = sanitizeDisplayName(input, "rename");
  if (!cleaned || [...cleaned].length > WHITEBOARD_NAME_MAX) throw new WhiteboardError(400, "INVALID_NAME", `Enter a name of 1 to ${WHITEBOARD_NAME_MAX} characters`);
  const stored = sanitizeDisplayName(whiteboardFileName(cleaned), "rename");
  if (!stored) throw new WhiteboardError(400, "INVALID_NAME", "Enter a shorter name");
  return stored;
}

function replay(userId: string, uploadKey: string) {
  const existing = db.query("SELECT id, deleted_at FROM documents WHERE owner_id = ? AND upload_key = ?").get(userId, uploadKey) as { id: string; deleted_at: string | null } | null;
  if (!existing) return null;
  const board = existing.deleted_at ? null : readableWhiteboard(existing.id, userId);
  if (!board) throw new WhiteboardError(409, "IDEMPOTENCY_KEY_USED", "This whiteboard was already created and has since been deleted");
  return board;
}

/**
 * POST /api/whiteboards and MCP create_whiteboard: an empty board in an owned folder (Default when
 * none is given). `uploadKey` makes a retry return the same board.
 */
export async function createWhiteboard(userId: string, input: { name: string; folderId?: string | null; uploadKey?: string | null; via?: { keyId: string } }) {
  const name = whiteboardStoredName(input.name);
  const uploadKey = input.uploadKey ?? null;
  if (uploadKey) {
    const existing = replay(userId, uploadKey);
    if (existing) return { whiteboard: existing, replay: true };
  }
  const folderId = input.folderId ?? ensureDefaultFolder(userId);
  if (!db.query("SELECT 1 FROM folders WHERE id = ? AND owner_id = ?").get(folderId, userId)) throw new WhiteboardError(404, "NOT_FOUND", "Folder not found");
  const prepared = prepareScene(emptyScene());
  checkQuota(userId, prepared.bytes.byteLength);
  await ensureDiskSpace(prepared.bytes.byteLength);
  const documentId = crypto.randomUUID();
  const objectId = crypto.randomUUID();
  await writeObject(objectId, prepared.bytes);
  let replayOf: string | null = null;
  try {
    db.transaction(() => {
      // T80: a request that authenticated before its owner was blocked must not commit after it.
      if (!db.query("SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL").get(userId)) throw new WhiteboardError(404, "NOT_FOUND", "Whiteboard not found");
      if (uploadKey) {
        const existing = db.query("SELECT id FROM documents WHERE owner_id = ? AND upload_key = ?").get(userId, uploadKey) as { id: string } | null;
        if (existing) {
          replayOf = existing.id;
          return;
        }
      }
      checkQuota(userId, prepared.bytes.byteLength);
      const timestamp = now();
      db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, upload_key, purpose, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'none', ?, ?, ?, 'file', ?, ?)`)
        .run(documentId, userId, folderId, name, WHITEBOARD_MIME, prepared.bytes.byteLength, prepared.sha256, uploadKey, timestamp, timestamp);
      db.query("INSERT INTO whiteboards (document_id, revision, object_id, element_count, text_bytes, created_at, updated_at) VALUES (?, 1, ?, 0, 0, ?, ?)")
        .run(documentId, objectId, timestamp, timestamp);
      indexWhiteboard(documentId, name, prepared.scene, prepared.sha256);
      if (input.via) audit(userId, null, "mcp.whiteboard_create", { via: "mcp", keyId: input.via.keyId, documentId, folderId });
      else audit(userId, null, "whiteboard.create", { documentId, folderId });
    })();
  } catch (error) {
    await removeObject(objectId);
    throw error;
  }
  if (replayOf) {
    await removeObject(objectId);
    return { whiteboard: replay(userId, uploadKey!)!, replay: true };
  }
  return { whiteboard: readableWhiteboard(documentId, userId)!, replay: false };
}

/** The current scene's canonical bytes, re-reading once when a save replaced the object meanwhile (§6). */
async function readSceneBytes(documentId: string): Promise<{ bytes: Uint8Array; revision: number }> {
  const read = () => db.query("SELECT w.object_id, w.revision, d.size_bytes FROM whiteboards w JOIN documents d ON d.id = w.document_id WHERE w.document_id = ?")
    .get(documentId) as { object_id: string; revision: number; size_bytes: number } | null;
  let row = read();
  if (!row) throw notFound();
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { handle } = await openObjectForRead(row.object_id, row.size_bytes);
      try {
        return { bytes: new Uint8Array(await handle.readFile()), revision: row.revision };
      } finally {
        await handle.close();
      }
    } catch (error) {
      const again = attempt === 0 && error instanceof DocumentIntegrityError ? read() : null;
      if (!again || again.object_id === row.object_id) throw error;
      row = again;
    }
  }
}

/** GET /api/whiteboards/:id: the board and its scene (validated again on the way out, T160). */
export async function readWhiteboard(documentId: string, userId: string) {
  if (!readableWhiteboard(documentId, userId)) throw notFound();
  const { bytes } = await readSceneBytes(documentId);
  // The summary is read after the bytes, so its revision is never older than the scene.
  const whiteboard = readableWhiteboard(documentId, userId);
  if (!whiteboard) throw notFound();
  const result = validateScene(JSON.parse(new TextDecoder().decode(bytes)));
  if (!result.ok) throw new Error("Stored whiteboard scene failed validation");
  return { whiteboard, scene: result.scene };
}

/** Save audits are coalesced to one row per board per ten minutes (§8). Single process only. */
const lastSaveAudit = new Map<string, number>();

function auditSave(userId: string, documentId: string, revision: number) {
  const time = Date.now();
  const last = lastSaveAudit.get(documentId);
  if (last !== undefined && time - last < SAVE_AUDIT_INTERVAL_MS) return;
  if (lastSaveAudit.size > 5000) lastSaveAudit.clear();
  lastSaveAudit.set(documentId, time);
  audit(userId, null, "whiteboard.save", { documentId, revision });
}

export type SaveResult = { revision: number; savedAt: string; sha256: string; sizeBytes: number; unchanged?: true };

/**
 * PUT /api/whiteboards/:id/scene (§8.1): validate outside the lock, then under the document lock
 * check the owner and the revision (409 REVISION_CONFLICT), skip an identical scene, check the
 * quota delta, write a new object, and switch to it in one transaction with the index. The old
 * object is removed after the commit; a crash in between leaves an orphan the sweeper removes.
 */
export async function saveScene(documentId: string, userId: string, baseRevision: number, input: unknown): Promise<SaveResult> {
  const prepared = prepareScene(input);
  return withResourceLock(lockKey(documentId), async () => {
    const board = ownedBoard(documentId, userId);
    if (!board) throw notFound();
    if (board.revision !== baseRevision) throw new WhiteboardError(409, "REVISION_CONFLICT", "This whiteboard changed on another device", { revision: board.revision });
    if (board.sha256 === prepared.sha256) {
      return { revision: board.revision, savedAt: now(), sha256: board.sha256, sizeBytes: board.size_bytes, unchanged: true as const };
    }
    const delta = prepared.bytes.byteLength - board.size_bytes;
    checkQuota(userId, delta);
    await ensureDiskSpace(prepared.bytes.byteLength);
    const objectId = crypto.randomUUID();
    await writeObject(objectId, prepared.bytes);
    const savedAt = now();
    try {
      db.transaction(() => {
        checkQuota(userId, delta);
        const moved = db.query(`UPDATE whiteboards SET revision = revision + 1, object_id = ?, element_count = ?, text_bytes = ?, updated_at = ?
          WHERE document_id = ? AND revision = ?`).run(objectId, prepared.stats.elementCount, prepared.stats.textBytes, savedAt, documentId, baseRevision);
        if (moved.changes !== 1) throw new WhiteboardError(409, "REVISION_CONFLICT", "This whiteboard changed on another device", { revision: board.revision });
        db.query("UPDATE documents SET size_bytes = ?, sha256 = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
          .run(prepared.bytes.byteLength, prepared.sha256, savedAt, documentId, userId);
        indexWhiteboard(documentId, board.name, prepared.scene, prepared.sha256);
      })();
    } catch (error) {
      await removeObject(objectId);
      throw error;
    }
    await removeObject(board.object_id).catch(() => console.error("Could not remove a superseded whiteboard object; the sweeper will"));
    auditSave(userId, documentId, baseRevision + 1);
    return { revision: baseRevision + 1, savedAt, sha256: prepared.sha256, sizeBytes: prepared.bytes.byteLength };
  });
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG by its signature and IHDR chunk, at most 2048×2048 (T169). Never decoded further. */
export function checkThumbnail(bytes: Uint8Array) {
  if (bytes.byteLength > THUMBNAIL_MAX_BYTES) throw new WhiteboardError(413, "THUMBNAIL_TOO_LARGE", "The thumbnail is too large");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isPng = bytes.byteLength >= 33 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)
    && view.getUint32(8) === 13 && String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) === "IHDR";
  if (!isPng) throw new WhiteboardError(415, "NOT_PNG", "Thumbnails must be PNG images");
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1 || width > THUMBNAIL_MAX_SIDE || height > THUMBNAIL_MAX_SIDE) throw new WhiteboardError(415, "NOT_PNG", "The thumbnail is too big");
}

/** PUT …/thumbnail (D200): the owner's PNG of revision `revision`; a stale or future revision is ignored. */
export async function putThumbnail(documentId: string, userId: string, revision: number, bytes: Uint8Array) {
  checkThumbnail(bytes);
  return withResourceLock(lockKey(documentId), async () => {
    const board = ownedBoard(documentId, userId);
    if (!board) throw notFound();
    if (revision > board.revision || (board.thumb_revision !== null && revision < board.thumb_revision)) return { stored: false };
    db.query("UPDATE whiteboards SET thumb_png = ?, thumb_revision = ?, thumb_sha256 = ? WHERE document_id = ?").run(bytes, revision, sha256(bytes), documentId);
    return { stored: true };
  });
}

/** GET …/thumbnail: the PNG and its hash for a reader, or null (no board, no access, or no thumbnail). */
export function readThumbnail(documentId: string, userId: string) {
  if (!readableWhiteboard(documentId, userId)) return null;
  const row = db.query("SELECT thumb_png, thumb_sha256 FROM whiteboards WHERE document_id = ? AND thumb_png IS NOT NULL").get(documentId) as { thumb_png: Uint8Array; thumb_sha256: string } | null;
  return row ? { bytes: row.thumb_png, sha256: row.thumb_sha256 } : null;
}

/** The newest boards `userId` can read, for Today's `whiteboardsRecent` (titles and times only). */
export function recentWhiteboards(userId: string, limit: number) {
  return listWhiteboards(userId, "all", { limit });
}

/**
 * Boot reconcile (§6, D204): rebuild index rows whose source hash no longer matches the board (or
 * that are missing), reading at most `budget` scenes per run. Logs counts only.
 */
export async function reconcileWhiteboardSearchIndex(budget = 200) {
  const counts = { indexed: 0, removed: 0, unreadable: 0 };
  counts.removed += db.query("DELETE FROM whiteboard_fts WHERE rowid NOT IN (SELECT id FROM whiteboard_search)").run().changes;
  const stale = db.query(`SELECT d.id, d.name, d.sha256 FROM whiteboards w JOIN documents d ON d.id = w.document_id
    LEFT JOIN whiteboard_search s ON s.document_id = d.id
    WHERE d.purge_started_at IS NULL AND (s.id IS NULL OR s.source_sha256 <> d.sha256 OR NOT EXISTS (SELECT 1 FROM whiteboard_fts f WHERE f.rowid = s.id))
    ORDER BY d.id LIMIT ?`).all(budget) as Array<{ id: string; name: string; sha256: string }>;
  for (const board of stale) {
    try {
      const { bytes } = await readSceneBytes(board.id);
      const result = validateScene(JSON.parse(new TextDecoder().decode(bytes)));
      if (!result.ok) throw new Error("invalid");
      db.transaction(() => indexWhiteboard(board.id, board.name, result.scene, sha256(bytes)))();
      counts.indexed += 1;
    } catch {
      counts.unreadable += 1;
    }
  }
  if (counts.indexed || counts.removed || counts.unreadable) console.info(`Whiteboard search index: ${counts.indexed} indexed, ${counts.removed} removed, ${counts.unreadable} unreadable`);
  return counts;
}

export type { CanonicalScene, SceneErrorCode };
