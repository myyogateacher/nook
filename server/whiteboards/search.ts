import { db, now } from "../db";
import { buildFtsQuery, cleanIndexText, HIT_END, HIT_START, toSegments, type Segment } from "../search";
import { readableDocumentPredicate } from "../documentAccess";
import { sceneTexts, whiteboardDisplayName, type CanonicalScene } from "../../shared/whiteboardScene";

/**
 * Whiteboard search (whiteboard plan D204, T171): a mapping table and an FTS5 table like
 * Collections (D57). The title is the board's name without its suffix; the body is the text of its
 * text elements (the original text when wrapped) and its frame names, capped at 64 KiB. Rows are
 * written in the transaction of each save and rename; binned boards stay indexed so a restore finds
 * them again, and the query filters them out. Purge cascades the mapping, and a trigger the FTS row.
 */
export const WHITEBOARD_INDEX_BODY_BYTES = 64 * 1024;

const deleteMapping = db.query("DELETE FROM whiteboard_search WHERE document_id = ?");
const insertMapping = db.query("INSERT INTO whiteboard_search (document_id, source_sha256, indexed_at) VALUES (?, ?, ?)");
const insertFts = db.query("INSERT INTO whiteboard_fts (rowid, title, body) VALUES (?, ?, ?)");

export const isWhiteboard = (documentId: string) => Boolean(db.query("SELECT 1 FROM whiteboards WHERE document_id = ?").get(documentId));

function truncateBytes(value: string, maxBytes: number) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/�$/, "");
}

/** The body a scene is indexed with (pure). */
export function whiteboardSearchBody(scene: CanonicalScene) {
  const { texts, frameNames } = sceneTexts(scene);
  return truncateBytes(cleanIndexText([...frameNames, ...texts.map((item) => item.text)].join("\n")), WHITEBOARD_INDEX_BODY_BYTES);
}

/** Replaces a board's index entry. Call inside the transaction that wrote the scene. */
export function indexWhiteboard(documentId: string, name: string, scene: CanonicalScene, sourceSha256: string) {
  deleteMapping.run(documentId);
  const mapping = Number(insertMapping.run(documentId, sourceSha256, now()).lastInsertRowid);
  insertFts.run(mapping, cleanIndexText(whiteboardDisplayName(name)), whiteboardSearchBody(scene));
}

/** A rename changes only the title (called inside the rename transaction; a no-op for other files). */
export function renameWhiteboardIndex(documentId: string, name: string) {
  db.query("UPDATE whiteboard_fts SET title = ? WHERE rowid = (SELECT id FROM whiteboard_search WHERE document_id = ?)")
    .run(cleanIndexText(whiteboardDisplayName(name)), documentId);
}

export type WhiteboardSearchHit = { id: string; name: string; title: Segment[]; snippet: Segment[]; owner_name: string; is_owner: 0 | 1; updated_at: string };

const SNIPPET_TOKENS = 16;
const searchQuery = db.query(`
  SELECT d.id, d.name, u.display_name AS owner_name, CASE WHEN d.owner_id = $userId THEN 1 ELSE 0 END AS is_owner, d.updated_at,
         highlight(whiteboard_fts, 0, $hitStart, $hitEnd) AS title_marked,
         snippet(whiteboard_fts, 1, $hitStart, $hitEnd, '…', ${SNIPPET_TOKENS}) AS snippet_marked
  FROM whiteboard_fts
  JOIN whiteboard_search s ON s.id = whiteboard_fts.rowid
  JOIN documents d ON d.id = s.document_id AND d.purpose = 'file' AND d.purge_started_at IS NULL
  JOIN whiteboards w ON w.document_id = d.id
  JOIN users u ON u.id = d.owner_id
  WHERE whiteboard_fts MATCH $query AND ${readableDocumentPredicate}
  ORDER BY bm25(whiteboard_fts, 8.0, 1.0), d.updated_at DESC
  LIMIT $limit
`);

/** Boards the caller can read that match `q`. The ACL is part of the query, before LIMIT (T171). */
export function searchWhiteboards(userId: string, q: string, limit: number) {
  const query = buildFtsQuery(q);
  if (query === null) return { results: [] as WhiteboardSearchHit[], truncated: false };
  const rows = searchQuery.all({ userId, query, hitStart: HIT_START, hitEnd: HIT_END, limit: limit + 1 }) as Array<Omit<WhiteboardSearchHit, "title" | "snippet"> & { title_marked: string; snippet_marked: string }>;
  const results = rows.slice(0, limit).map(({ title_marked, snippet_marked, ...row }): WhiteboardSearchHit => ({
    ...row, name: whiteboardDisplayName(row.name), title: toSegments(title_marked), snippet: toSegments(snippet_marked)
  }));
  return { results, truncated: rows.length > limit };
}

/** Matching board ids (for MCP list_whiteboards `query`), ACL applied, best first. */
export function matchingWhiteboardIds(userId: string, q: string, limit: number) {
  return searchWhiteboards(userId, q, limit).results.map((hit) => hit.id);
}
