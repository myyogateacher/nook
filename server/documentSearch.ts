import { db, now, type DocumentRow } from "./db";
import { buildFtsQuery, cleanIndexText, HIT_END, HIT_START, toSegments, type Segment } from "./search";
import { readableDocumentPredicate } from "./documentAccess";
import { StorageUnavailableError } from "./objectStore";
import { logger } from "./log";

const slog = logger("search");

/**
 * The Files full-text index (lane FTS, migration 060): the name and text of every Files document
 * except whiteboards (they have their own index, D204).
 *
 * - **What is indexed.** The name always. The body only for text files of at most 1 MiB (the
 *   `read_document_text` limit), read exactly as that tool reads them (integrity and UTF-8 checks),
 *   so local and S3 storage index the same. The body is capped at `DOCUMENT_INDEX_LIMITS.bodyBytes`.
 * - **Sync.** Files content never changes after upload, so a row is current while its
 *   `source_sha256` equals the document's `sha256`. Upload queues the indexer; rename rewrites the
 *   title in its own transaction; Bin and restore change nothing (queries filter binned documents);
 *   a purge cascades the row and a trigger the FTS row.
 * - **The indexer** is one background loop: batches of stale documents, newest first, at most
 *   `batchDocs` documents and `batchBytes` read per batch, a pause between batches. It never blocks
 *   boot. A file whose read hits storage trouble waits `retryMs` while the others go on; three in a
 *   row stop the loop until then (the store is down). A file that is not UTF-8 text or fails its
 *   integrity check is indexed by name only (`unreadable`).
 * - **Backfill.** After migration 060 every existing document is stale, so the first pass after boot
 *   is the backfill. `documentIndexReady()` turns true once a pass finds nothing stale; until then
 *   "Pick from Nook" keeps its bounded scan (server/reports/nookFileSearch.ts).
 * - **Logs** say counts, never names or text.
 */
export const DOCUMENT_INDEX_LIMITS = { bodyBytes: 256 * 1024, batchDocs: 50, batchBytes: 8 * 1024 * 1024, pauseMs: 25, retryMs: 60_000, textMaxBytes: 1024 * 1024 };

/** How the indexer reads a document's text (tests swap it to simulate storage trouble). */
export const documentIndexDeps = {
  async readText(document: DocumentRow): Promise<string> {
    // Loaded when used: mcpTools imports most of the server.
    const { readDocumentText } = await import("./mcpTools");
    return readDocumentText(document);
  }
};

const notWhiteboard = "NOT EXISTS (SELECT 1 FROM whiteboards wb WHERE wb.document_id = d.id)";

const staleQuery = db.query(`
  SELECT d.* FROM documents d LEFT JOIN document_search s ON s.document_id = d.id
  WHERE d.purpose = 'file' AND d.purge_started_at IS NULL AND ${notWhiteboard}
    AND (s.id IS NULL OR s.source_sha256 <> d.sha256)
  ORDER BY d.updated_at DESC, d.id DESC LIMIT ?`);
const currentSha = db.query("SELECT sha256, name FROM documents WHERE id = ? AND purge_started_at IS NULL");
const deleteMapping = db.query("DELETE FROM document_search WHERE document_id = ?");
const insertMapping = db.query("INSERT INTO document_search (document_id, source_sha256, body_state, indexed_at) VALUES (?, ?, ?, ?)");
const insertFts = db.query("INSERT INTO document_fts (rowid, title, body) VALUES (?, ?, ?)");

function truncateBytes(value: string, maxBytes: number) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/�$/, "");
}

type BodyState = "text" | "none" | "unreadable";

/** Replaces a document's index row, unless it changed or was purged since it was read. */
function writeRow(documentId: string, sha256: string, state: BodyState, body: string) {
  return db.transaction(() => {
    const live = currentSha.get(documentId) as { sha256: string; name: string } | null;
    if (!live || live.sha256 !== sha256) return false;
    deleteMapping.run(documentId);
    const rowid = Number(insertMapping.run(documentId, sha256, state, now()).lastInsertRowid);
    insertFts.run(rowid, cleanIndexText(live.name), body);
    return true;
  })();
}

/** A rename rewrites the title. Call inside the rename transaction (a no-op until the row exists). */
export function renameDocumentIndex(documentId: string, name: string) {
  db.query("UPDATE document_fts SET title = ? WHERE rowid = (SELECT id FROM document_search WHERE document_id = ?)").run(cleanIndexText(name), documentId);
}

export type DocumentIndexPass = { indexed: number; unreadable: number; deferred: number; read: number; storageDown: boolean; more: boolean };

/** Documents whose read failed with storage trouble, and when to try them again (in memory: a restart retries at once). */
const deferred = new Map<string, number>();
/** Storage failures in a row that mean the store itself is down: the loop stops instead of trying every file. */
const STORAGE_DOWN_AFTER = 3;

/** One batch of the indexer (exported for tests). */
export async function indexDocumentsOnce(nowMs = Date.now()): Promise<DocumentIndexPass> {
  const limits = DOCUMENT_INDEX_LIMITS;
  for (const [id, at] of deferred) if (at <= nowMs) deferred.delete(id);
  const rows = (staleQuery.all(limits.batchDocs + deferred.size + 1) as DocumentRow[]).filter((row) => !deferred.has(row.id));
  const pass: DocumentIndexPass = { indexed: 0, unreadable: 0, deferred: 0, read: 0, storageDown: false, more: rows.length > limits.batchDocs };
  let failuresInRow = 0;
  for (const row of rows.slice(0, limits.batchDocs)) {
    const readable = row.preview_kind === "text" && row.size_bytes <= limits.textMaxBytes;
    if (readable && pass.read > 0 && pass.read + row.size_bytes > limits.batchBytes) { pass.more = true; break; }
    let state: BodyState = "none";
    let body = "";
    if (readable) {
      pass.read += row.size_bytes;
      try {
        body = cleanIndexText(truncateBytes(await documentIndexDeps.readText(row), limits.bodyBytes));
        state = "text";
        failuresInRow = 0;
      } catch (error) {
        const unavailable = error instanceof StorageUnavailableError || (error as { code?: string }).code === "STORAGE_UNAVAILABLE";
        if (unavailable) {
          // This file waits; the others go on, unless the store looks down altogether.
          deferred.set(row.id, nowMs + limits.retryMs);
          pass.deferred += 1;
          failuresInRow += 1;
          if (failuresInRow >= STORAGE_DOWN_AFTER) { pass.storageDown = true; pass.more = true; break; }
          continue;
        }
        state = "unreadable";
        failuresInRow = 0;
      }
    }
    if (!writeRow(row.id, row.sha256, state, body)) { pass.more = true; continue; }
    if (state === "unreadable") pass.unreadable += 1;
    else pass.indexed += 1;
  }
  return pass;
}

let worker: Promise<void> | null = null;
let again = false;
let ready = false;
let retry: ReturnType<typeof setTimeout> | null = null;
let idleWaiters: Array<() => void> = [];
const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function retryLater() {
  if (retry) clearTimeout(retry);
  retry = setTimeout(() => { retry = null; scheduleDocumentIndex(); }, DOCUMENT_INDEX_LIMITS.retryMs);
  retry.unref?.();
}

/** Queues the indexer: on upload, at boot (the backfill), and from the sweeper. */
export function scheduleDocumentIndex() {
  again = true;
  if (worker) return;
  if (retry) { clearTimeout(retry); retry = null; }
  worker = (async () => {
    const totals = { indexed: 0, unreadable: 0, deferred: 0, read: 0 };
    const started = performance.now();
    let down = false;
    try {
      while (again && !down) {
        again = false;
        let pass: DocumentIndexPass;
        do {
          pass = await indexDocumentsOnce();
          totals.indexed += pass.indexed;
          totals.unreadable += pass.unreadable;
          totals.deferred += pass.deferred;
          totals.read += pass.read;
          if (pass.storageDown) break;
          if (pass.more) await pause(DOCUMENT_INDEX_LIMITS.pauseMs);
        } while (pass.more);
        if (pass.storageDown) {
          slog.warn("Files search index paused: storage is unavailable");
          down = true;
          again = false;
          break;
        }
        // Everything readable is indexed; files waiting on storage are retried below.
        ready = true;
      }
    } catch (error) {
      slog.error("Files search indexing failed", error);
      again = false;
    } finally {
      worker = null;
      if (down || deferred.size > 0) retryLater();
      if (totals.indexed + totals.unreadable + totals.deferred > 20 || totals.deferred > 0 || (!ready && totals.indexed > 0)) {
        slog.info("Files search index", { ...totals, ms: Math.round(performance.now() - started) });
      }
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  })();
}

/** Resolves once the indexer is idle (tests). */
export function whenDocumentIndexIdle(): Promise<void> {
  if (!worker) return Promise.resolve();
  return new Promise((resolve) => { idleWaiters.push(resolve); });
}

/** Whether the backfill has finished once (until then "Pick from Nook" keeps its bounded scan). */
export const documentIndexReady = () => ready;

/** Test hook: back to the state right after boot. */
export function resetDocumentIndexForTests(state: { ready: boolean }) {
  ready = state.ready;
  deferred.clear();
  if (retry) { clearTimeout(retry); retry = null; }
}

export type DocumentSearchRow = {
  id: string; name: string; folder_id: string | null; mime_type: string; size_bytes: number; preview_kind: string;
  owner_id: string; owner_name: string; is_owner: 0 | 1; updated_at: string; title_marked: string; snippet_marked: string;
};
export type DocumentSearchHit = {
  id: string; name: string; title: Segment[]; snippet: Segment[]; folder_id: string | null; mime_type: string; size_bytes: number;
  owner_name: string; is_owner: 0 | 1; updated_at: string;
};

const SNIPPET_TOKENS = 16;
const searchSql = (textOnly: boolean) => `
  SELECT d.id, d.name, d.folder_id, d.mime_type, d.size_bytes, d.preview_kind, d.owner_id, u.display_name AS owner_name,
         CASE WHEN d.owner_id = $userId THEN 1 ELSE 0 END AS is_owner, d.updated_at,
         highlight(document_fts, 0, $hitStart, $hitEnd) AS title_marked,
         snippet(document_fts, 1, $hitStart, $hitEnd, '…', ${SNIPPET_TOKENS}) AS snippet_marked
  FROM document_fts
  JOIN document_search s ON s.id = document_fts.rowid
  JOIN documents d ON d.id = s.document_id AND d.purpose = 'file' AND d.purge_started_at IS NULL AND d.sha256 = s.source_sha256
  JOIN users u ON u.id = d.owner_id
  WHERE document_fts MATCH $query AND ${readableDocumentPredicate} AND ${notWhiteboard}
    ${textOnly ? "AND d.preview_kind = 'text' AND d.size_bytes <= $maxBytes AND s.body_state <> 'unreadable'" : ""}
  ORDER BY bm25(document_fts, 8.0, 1.0), d.updated_at DESC, d.id DESC
  LIMIT $limit OFFSET $offset`;
const searchQueries = { all: db.query(searchSql(false)), text: db.query(searchSql(true)) };

/**
 * Files the caller can list in Files (the `read_document_text` access: ownership or Files sharing,
 * never a card, row, or other host link) whose name or text matches `q`, best first. The ACL is
 * part of the query, before LIMIT. `textOnly` keeps the files `read_document_text` can read.
 */
export function searchDocumentRows(userId: string, q: string, options: { limit: number; offset?: number; textOnly?: boolean }) {
  const query = buildFtsQuery(q);
  if (query === null) return { rows: [] as DocumentSearchRow[], truncated: false };
  const rows = (options.textOnly ? searchQueries.text : searchQueries.all).all({
    userId, query, hitStart: HIT_START, hitEnd: HIT_END, limit: options.limit + 1, offset: options.offset ?? 0,
    ...(options.textOnly ? { maxBytes: DOCUMENT_INDEX_LIMITS.textMaxBytes } : {})
  }) as DocumentSearchRow[];
  return { rows: rows.slice(0, options.limit), truncated: rows.length > options.limit };
}

/** `GET /api/search?scope=files`: the hits with highlighted name and snippet segments (never HTML). */
export function searchDocuments(userId: string, q: string, limit: number) {
  const { rows, truncated } = searchDocumentRows(userId, q, { limit });
  const results = rows.map((row): DocumentSearchHit => ({
    id: row.id, name: row.name, title: toSegments(row.title_marked), snippet: toSegments(row.snippet_marked), folder_id: row.folder_id,
    mime_type: row.mime_type, size_bytes: row.size_bytes, owner_name: row.owner_name, is_owner: row.is_owner, updated_at: row.updated_at
  }));
  return { results, truncated };
}
