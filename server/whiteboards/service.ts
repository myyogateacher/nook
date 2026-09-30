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
  canonicalSceneJson, emptyScene, validateScene, whiteboardDisplayName, whiteboardFileName, WHITEBOARD_MAX_SCENE_BYTES, WHITEBOARD_MIME,
  type CanonicalScene, type SceneErrorCode
} from "../../shared/whiteboardScene";
import { indexWhiteboard } from "./search";
import { avatarUrlFor } from "../avatars";

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
  constructor(readonly status: 400 | 404 | 409 | 413 | 415 | 429 | 507, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "WhiteboardError";
  }
}

const notFound = () => new WhiteboardError(404, "NOT_FOUND", "Whiteboard not found");

/**
 * Per-user fixed one-minute windows (review L8, L11). Autosave writes at most once per 1.5 s per
 * board (40 a minute) and a thumbnail at most once a minute per board plus one on leave, so these
 * are only reached by several busy boards at once or by a script: 30 new boards, 120 scene saves,
 * and 30 thumbnails a minute. A refused request costs nothing; the client keeps its pending copy and
 * retries after `retryAfter`.
 */
export const WHITEBOARD_LIMITS = { create: 30, save: 120, thumbnail: 30 } as const;
type LimitName = keyof typeof WHITEBOARD_LIMITS;
const windows = new Map<string, { count: number; resetAt: number }>();

function charge(name: LimitName, userId: string, nowMs = Date.now()) {
  if (windows.size > 5000) for (const [key, window] of windows) if (window.resetAt <= nowMs) windows.delete(key);
  const key = `${name}:${userId}`;
  let window = windows.get(key);
  if (!window || window.resetAt <= nowMs) {
    window = { count: 0, resetAt: nowMs + 60_000 };
    windows.set(key, window);
  }
  if (window.count >= WHITEBOARD_LIMITS[name]) {
    throw new WhiteboardError(429, "RATE_LIMITED", "Too many whiteboard changes. Try again in a minute.", { retryAfter: Math.max(1, Math.ceil((window.resetAt - nowMs) / 1000)) });
  }
  window.count += 1;
}

/** Test hook: forget the whiteboard rate windows. */
export function resetWhiteboardLimitsForTests() {
  windows.clear();
}

export type WhiteboardSummary = DocumentSummary & {
  kind: "whiteboard";
  revision: number;
  elementCount: number;
  hasThumbnail: boolean;
  thumbRevision: number | null;
  /** Only the owner edits (D195, D275), and only while their role writes. */
  canEdit: boolean;
  /** The owner's safety snapshots (0 for everyone else) and when the newest was taken. */
  snapshotCount: number;
  snapshotAt: string | null;
  /** The owner's picture (the same-origin avatar route, Wave 35), or null. */
  ownerAvatarUrl: string | null;
  /** Wave 36 (D287): the owner is an integration (its keys created the board); shown with a badge. */
  ownerIsIntegration: boolean;
};

type BoardColumns = { revision: number; element_count: number; has_thumb: 0 | 1; thumb_revision: number | null; snapshot_count: number; snapshot_at: string | null; owner_avatar_id: string | null; owner_kind: string };

/** Safety snapshots are the owner's: others always see 0 (and no time). */
const SNAPSHOT_COLUMNS = `CASE WHEN d.owner_id = $userId THEN (SELECT COUNT(*) FROM whiteboard_snapshots ws WHERE ws.document_id = d.id) ELSE 0 END AS snapshot_count,
  CASE WHEN d.owner_id = $userId THEN (SELECT MAX(ws.created_at) FROM whiteboard_snapshots ws WHERE ws.document_id = d.id) ELSE NULL END AS snapshot_at,
  u.avatar_id AS owner_avatar_id, u.kind AS owner_kind`;

const summarySelect = documentSummarySelect.replace(
  "FROM documents d JOIN users u ON u.id = d.owner_id",
  `, w.revision, w.element_count, w.thumb_png IS NOT NULL AS has_thumb, w.thumb_revision, ${SNAPSHOT_COLUMNS} FROM documents d JOIN whiteboards w ON w.document_id = d.id JOIN users u ON u.id = d.owner_id`
);

function toSummary(row: DocumentSummary & BoardColumns, userId: string): WhiteboardSummary {
  const { revision, element_count, has_thumb, thumb_revision, snapshot_count, snapshot_at, owner_avatar_id, owner_kind, ...document } = row;
  return {
    ...document, kind: "whiteboard", revision, elementCount: element_count, hasThumbnail: has_thumb === 1, thumbRevision: thumb_revision,
    snapshotCount: snapshot_count, snapshotAt: snapshot_at, ownerAvatarUrl: avatarUrlFor(document.owner_id, owner_avatar_id), ownerIsIntegration: owner_kind === "service",
    canEdit: document.is_owner === 1 && canWriteContent(userId)
  };
}

/** A live board `userId` can read (the Files list predicate), or null. */
export function readableWhiteboard(documentId: string, userId: string) {
  const row = db.query(`${summarySelect} WHERE d.id = $documentId AND d.purpose = 'file' AND ${readableDocumentPredicate}`).get({ documentId, userId }) as (DocumentSummary & BoardColumns) | null;
  return row ? toSummary(row, userId) : null;
}

/**
 * Lists are driven from `whiteboards` (review L12): CROSS JOIN keeps SQLite from scanning every
 * live document and probing for a board row; each board is one primary-key lookup into documents.
 */
const listSelect = documentSummarySelect.replace(
  "FROM documents d JOIN users u ON u.id = d.owner_id",
  `, w.revision, w.element_count, w.thumb_png IS NOT NULL AS has_thumb, w.thumb_revision, ${SNAPSHOT_COLUMNS} FROM whiteboards w CROSS JOIN documents d ON d.id = w.document_id JOIN users u ON u.id = d.owner_id`
);

/** List orders (QA Q6), as the Files list names them. The cursor carries the sort it was made for. */
export const WHITEBOARD_SORTS = ["updated-desc", "updated-asc", "name-asc", "name-desc"] as const;
export type WhiteboardSort = (typeof WHITEBOARD_SORTS)[number];
const SORT_SQL: Record<"updated-desc" | "updated-asc", { key: string; order: string; after: string }> = {
  "updated-desc": { key: "d.updated_at", order: "d.updated_at DESC, d.id", after: "(d.updated_at < $cursorKey OR (d.updated_at = $cursorKey AND d.id > $cursorId))" },
  "updated-asc": { key: "d.updated_at", order: "d.updated_at ASC, d.id", after: "(d.updated_at > $cursorKey OR (d.updated_at = $cursorKey AND d.id > $cursorId))" }
};

/**
 * QA E6: names sort as the Files list sorts them: natural ("Board 2" before "Board 10") and
 * case-insensitive, on the name people see (without ".excalidraw"), so "Name" comes before
 * "Name (copy)". Ties go by id. SQLite has no such collation, so name orders sort in the server.
 */
const nameCollator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
export function compareBoardNames(left: { name: string; id: string }, right: { name: string; id: string }, direction: "asc" | "desc" = "asc") {
  const byName = nameCollator.compare(whiteboardDisplayName(left.name), whiteboardDisplayName(right.name));
  if (byName !== 0) return direction === "asc" ? byName : -byName;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

type ListCursor = { sort: WhiteboardSort; key: string; id: string };
export const encodeListCursor = (cursor: ListCursor) => Buffer.from(JSON.stringify([cursor.sort, cursor.key, cursor.id])).toString("base64url");
export function decodeListCursor(value: string | undefined | null, sort: WhiteboardSort): ListCursor | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString());
    if (Array.isArray(parsed) && parsed.length === 3 && parsed[0] === sort && typeof parsed[1] === "string" && typeof parsed[2] === "string" && parsed[1].length <= 1100 && parsed[2].length <= 40) {
      return { sort, key: parsed[1], id: parsed[2] };
    }
  } catch {
    // fall through
  }
  throw new WhiteboardError(400, "INVALID_CURSOR", "cursor is not valid");
}

/**
 * Boards `userId` can read: all, the ones others shared, or one folder, newest edit first, in pages
 * of at most 500 with a keyset cursor (review L7). `ids` narrows to chosen boards in SQL, before
 * the page cut, so a chosen-board key sees its boards however old they are.
 */
export function listWhiteboardsPage(userId: string, folder: "all" | "shared" | string, options: { limit?: number; cursor?: string | null; ids?: readonly string[]; sort?: WhiteboardSort } = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? LIST_LIMIT, LIST_LIMIT));
  const sort = options.sort ?? "updated-desc";
  const cursor = decodeListCursor(options.cursor, sort);
  const folderFilter = folder === "all" ? "" : folder === "shared" ? "AND d.owner_id <> $userId" : "AND d.folder_id = $folderId";
  const idFilter = options.ids ? "AND d.id IN (SELECT value FROM json_each($ids))" : "";
  const scope = {
    userId,
    ...(folder !== "all" && folder !== "shared" ? { folderId: folder } : {}),
    ...(options.ids ? { ids: JSON.stringify(options.ids) } : {})
  };
  if (sort === "name-asc" || sort === "name-desc") {
    const direction = sort === "name-asc" ? "asc" : "desc";
    // Names and ids only (SQLite flattens the subquery and skips the unused columns), sorted here.
    const all = (db.query(`SELECT id, name FROM (${listSelect} WHERE d.purpose = 'file' AND ${readableDocumentPredicate} ${folderFilter} ${idFilter})`)
      .all(scope) as Array<{ id: string; name: string }>).sort((left, right) => compareBoardNames(left, right, direction));
    const start = cursor ? all.findIndex((board) => compareBoardNames(board, { name: cursor.key, id: cursor.id }, direction) > 0) : 0;
    const slice = start < 0 ? [] : all.slice(start, start + limit + 1);
    const pageIds = slice.slice(0, limit).map((board) => board.id);
    const rows = pageIds.length === 0 ? [] : db.query(`${listSelect} WHERE d.purpose = 'file' AND ${readableDocumentPredicate} AND d.id IN (SELECT value FROM json_each($pageIds))`)
      .all({ userId, pageIds: JSON.stringify(pageIds) }) as Array<DocumentSummary & BoardColumns>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const page = pageIds.flatMap((id) => { const row = byId.get(id); return row ? [toSummary(row, userId)] : []; });
    const last = slice.length > limit ? slice[limit - 1] : undefined;
    return { whiteboards: page, nextCursor: last ? encodeListCursor({ sort, key: last.name, id: last.id }) : null };
  }
  const order = SORT_SQL[sort];
  const cursorFilter = cursor ? `AND ${order.after}` : "";
  const select = listSelect.replace(" FROM whiteboards w CROSS JOIN", `, ${order.key} AS sort_key FROM whiteboards w CROSS JOIN`);
  const rows = db.query(`${select} WHERE d.purpose = 'file' AND ${readableDocumentPredicate} ${folderFilter} ${idFilter} ${cursorFilter}
    ORDER BY ${order.order} LIMIT $limit`)
    .all({
      ...scope, limit: limit + 1,
      ...(cursor ? { cursorKey: cursor.key, cursorId: cursor.id } : {})
    }) as Array<DocumentSummary & BoardColumns & { sort_key: string }>;
  const lastRow = rows.length > limit ? rows[limit - 1] : undefined;
  const page = rows.slice(0, limit).map(({ sort_key: _sortKey, ...row }) => toSummary(row, userId));
  return { whiteboards: page, nextCursor: lastRow ? encodeListCursor({ sort, key: lastRow.sort_key, id: lastRow.id }) : null };
}

/** The first page (Today, tests): see listWhiteboardsPage. */
export const listWhiteboards = (userId: string, folder: "all" | "shared" | string, options: { limit?: number; ids?: readonly string[] } = {}) =>
  listWhiteboardsPage(userId, folder, options).whiteboards;

type OwnedBoard = { id: string; owner_id: string; name: string; size_bytes: number; sha256: string; revision: number; object_id: string; element_count: number; thumb_revision: number | null };

/** A live board owned by `userId` (not binned, not being purged), or null. */
function ownedBoard(documentId: string, userId: string) {
  return db.query(`SELECT d.id, d.owner_id, d.name, d.size_bytes, d.sha256, w.revision, w.object_id, w.element_count, w.thumb_revision
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
  charge("create", userId);
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
type SceneRow = { object_id: string; revision: number; element_count: number; size_bytes: number; updated_at: string };

/**
 * The current scene's bytes together with the revision, count, and time that belong to THOSE bytes,
 * from one row read (review H1): a save that commits while the file is read never relabels an older
 * scene with its newer revision, which would let the next save pass the CAS and overwrite it.
 */
async function readSceneBytes(documentId: string): Promise<{ bytes: Uint8Array; revision: number; row: SceneRow }> {
  const read = () => db.query(`SELECT w.object_id, w.revision, w.element_count, d.size_bytes, d.updated_at
    FROM whiteboards w JOIN documents d ON d.id = w.document_id WHERE w.document_id = ?`).get(documentId) as SceneRow | null;
  let row = read();
  if (!row) throw notFound();
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { handle } = await openObjectForRead(row.object_id, row.size_bytes);
      try {
        return { bytes: new Uint8Array(await handle.readFile()), revision: row.revision, row };
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
  const { bytes, row } = await readSceneBytes(documentId);
  // Access is checked again after the read; the revision, count, size, and time are the bytes' own.
  const current = readableWhiteboard(documentId, userId);
  if (!current) throw notFound();
  const whiteboard: WhiteboardSummary = { ...current, revision: row.revision, elementCount: row.element_count, size_bytes: row.size_bytes, updated_at: row.updated_at };
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

export type SaveResult = { revision: number; savedAt: string; sha256: string; sizeBytes: number; unchanged?: true; snapshotKept?: true };

/**
 * PUT /api/whiteboards/:id/scene (§8.1): validate outside the lock, then under the document lock
 * check the owner and the revision (409 REVISION_CONFLICT), skip an identical scene, check the
 * quota delta, write a new object, and switch to it in one transaction with the index. The old
 * object is removed after the commit; a crash in between leaves an orphan the sweeper removes.
 */
/** Safety snapshots kept per board (QA D1–D3 defence in depth); they count toward the quota. */
export const SAFETY_SNAPSHOTS = 5;

/**
 * Whether a save from `before` to `after` live elements keeps the scene it replaces as a snapshot:
 * a board emptied, or a board of 10 or more elements losing more than half of them.
 */
export const keepsSafetySnapshot = (before: number, after: number) => (before > 0 && after === 0) || (before >= 10 && after < before / 2);

export async function saveScene(documentId: string, userId: string, baseRevision: number, input: unknown, options: { keepSnapshot?: boolean } = {}): Promise<SaveResult> {
  charge("save", userId);
  const prepared = prepareScene(input);
  return withResourceLock(lockKey(documentId), async () => {
    const board = ownedBoard(documentId, userId);
    if (!board) throw notFound();
    if (board.revision !== baseRevision) throw new WhiteboardError(409, "REVISION_CONFLICT", "This whiteboard changed on another device", { revision: board.revision });
    if (board.sha256 === prepared.sha256) {
      return { revision: board.revision, savedAt: now(), sha256: board.sha256, sizeBytes: board.size_bytes, unchanged: true as const };
    }
    // A save that empties a board, or drops more than half of a big one, keeps the replaced scene
    // as a snapshot the owner can restore (the old object stays instead of being removed).
    const keep = options.keepSnapshot === true || keepsSafetySnapshot(board.element_count, prepared.stats.elementCount);
    const delta = prepared.bytes.byteLength - (keep ? 0 : board.size_bytes);
    checkQuota(userId, delta);
    await ensureDiskSpace(prepared.bytes.byteLength);
    const objectId = crypto.randomUUID();
    await writeObject(objectId, prepared.bytes);
    const savedAt = now();
    let dropped: string[] = [];
    try {
      db.transaction(() => {
        // T80: a save that authenticated before its owner was blocked must not commit after it.
        if (!db.query("SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL").get(userId)) throw notFound();
        checkQuota(userId, delta);
        const moved = db.query(`UPDATE whiteboards SET revision = revision + 1, object_id = ?, element_count = ?, text_bytes = ?, updated_at = ?
          WHERE document_id = ? AND revision = ?`).run(objectId, prepared.stats.elementCount, prepared.stats.textBytes, savedAt, documentId, baseRevision);
        if (moved.changes !== 1) throw new WhiteboardError(409, "REVISION_CONFLICT", "This whiteboard changed on another device", { revision: board.revision });
        db.query("UPDATE documents SET size_bytes = ?, sha256 = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
          .run(prepared.bytes.byteLength, prepared.sha256, savedAt, documentId, userId);
        indexWhiteboard(documentId, board.name, prepared.scene, prepared.sha256);
        if (keep) {
          db.query(`INSERT INTO whiteboard_snapshots (id, document_id, revision, object_id, size_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (document_id, revision) DO NOTHING`)
            .run(crypto.randomUUID(), documentId, board.revision, board.object_id, board.size_bytes, board.sha256, savedAt);
          const old = db.query(`SELECT id, object_id FROM whiteboard_snapshots WHERE document_id = ? ORDER BY created_at DESC, revision DESC LIMIT -1 OFFSET ?`)
            .all(documentId, SAFETY_SNAPSHOTS) as Array<{ id: string; object_id: string }>;
          for (const row of old) db.query("DELETE FROM whiteboard_snapshots WHERE id = ?").run(row.id);
          dropped = old.map((row) => row.object_id);
          audit(userId, null, "whiteboard.snapshot", { documentId, revision: board.revision, elementsBefore: board.element_count, elementsAfter: prepared.stats.elementCount });
        }
      })();
    } catch (error) {
      await removeObject(objectId);
      throw error;
    }
    if (!keep) await removeObject(board.object_id).catch(() => console.error("Could not remove a superseded whiteboard object; the sweeper will"));
    for (const object of dropped) await removeObject(object).catch(() => console.error("Could not remove a dropped whiteboard snapshot; the sweeper will"));
    auditSave(userId, documentId, baseRevision + 1);
    return { revision: baseRevision + 1, savedAt, sha256: prepared.sha256, sizeBytes: prepared.bytes.byteLength, ...(keep ? { snapshotKept: true as const } : {}) };
  });
}

/** The newest safety snapshot of an owned board, or null. */
export function newestSnapshot(documentId: string, userId: string) {
  if (!ownedBoard(documentId, userId)) return null;
  return db.query("SELECT id, revision, object_id, size_bytes, created_at FROM whiteboard_snapshots WHERE document_id = ? ORDER BY created_at DESC, revision DESC LIMIT 1")
    .get(documentId) as { id: string; revision: number; object_id: string; size_bytes: number; created_at: string } | null;
}

/**
 * POST …/restore-previous: the owner saves the newest snapshot as a NEW revision through the usual
 * CAS (409 on a stale base); the scene it replaces is kept as the newest snapshot, so nothing is lost.
 */
async function readSnapshotScene(snapshot: { object_id: string; size_bytes: number }): Promise<unknown> {
  const { handle } = await openObjectForRead(snapshot.object_id, snapshot.size_bytes);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * GET …/previous-version (QA E6): what "Restore previous version" would switch to, so its dialog can
 * say how many shapes each version has. The owner's only; 404 NO_SNAPSHOT when there is none.
 */
export async function previousVersion(documentId: string, userId: string) {
  const snapshot = newestSnapshot(documentId, userId);
  if (!snapshot) throw new WhiteboardError(404, "NO_SNAPSHOT", "There is no earlier version to restore");
  const scene = await readSnapshotScene(snapshot);
  const elements = scene && typeof scene === "object" && Array.isArray((scene as { elements?: unknown }).elements) ? (scene as { elements: Array<{ isDeleted?: unknown }> }).elements : [];
  return { revision: snapshot.revision, createdAt: snapshot.created_at, elementCount: elements.filter((element) => element?.isDeleted !== true).length };
}

export async function restorePreviousVersion(documentId: string, userId: string, baseRevision: number) {
  const snapshot = newestSnapshot(documentId, userId);
  if (!snapshot) throw new WhiteboardError(404, "NO_SNAPSHOT", "There is no earlier version to restore");
  const scene = await readSnapshotScene(snapshot);
  // What is on the board now is kept too, so a restore can itself be undone the same way.
  const saved = await saveScene(documentId, userId, baseRevision, scene, { keepSnapshot: true });
  audit(userId, null, "whiteboard.restore_snapshot", { documentId, fromRevision: snapshot.revision, revision: saved.revision });
  return { ...saved, restoredFrom: { revision: snapshot.revision, createdAt: snapshot.created_at } };
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
  charge("thumbnail", userId);
  checkThumbnail(bytes);
  return withResourceLock(lockKey(documentId), async () => {
    const board = ownedBoard(documentId, userId);
    if (!board) throw notFound();
    if (revision > board.revision || (board.thumb_revision !== null && revision < board.thumb_revision)) return { stored: false };
    const previous = (db.query("SELECT COALESCE(length(thumb_png), 0) AS size FROM whiteboards WHERE document_id = ?").get(documentId) as { size: number }).size;
    checkQuota(userId, bytes.byteLength - previous);
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
export function recentWhiteboards(userId: string, limit: number, ids?: readonly string[]) {
  return listWhiteboards(userId, "all", { limit, ...(ids ? { ids } : {}) });
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
