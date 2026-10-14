import { db, type DocumentRow } from "../db";
import { readableDocumentPredicate } from "../documentAccess";
import { ReportError } from "./errors";
import { logger, shortId } from "../log";
import type { NookFileHit, NookFileSearch } from "../../shared/reportsGenerate";

const slog = logger("reports");

/**
 * K4: "Pick from Nook" searches the text of Files documents, not only their names. Files content has
 * no search index (note_fts covers notes; knowledge bases index only the files added to one), so this
 * is a bounded scan instead of an index, without a migration:
 *
 * - **Access** is exactly `read_document_text`'s for the B4 doc source (`listableDocument`): the Files
 *   list predicate (ownership or Files sharing, never a card, row, or other host link), `purpose =
 *   'file'`, not binned; text only (`preview_kind = 'text'`), at most 1 MiB, read with the same
 *   integrity and UTF-8 checks. Whiteboards are left out.
 * - **Match**: every word of the query (case-insensitive) in the name or the text. A name match needs
 *   no read. The answer has the id, name, owner, and a short plain snippet around the first word.
 * - **Caps, per request**: the newest 100 candidates after the cursor, 8 MiB read, 20 hits. `next` is
 *   a cursor (updated_at and id, newest first) when candidates remain; the client asks again for more.
 * - **Rate**: 10 requests per 10 s per person (each may read megabytes).
 * - **Logs**: one line (scanned, read bytes, hits, ms), never the query or the text.
 */

/** The caps (tests lower `scan` and `hits` to page through a few files). */
export const NOOK_FILE_SEARCH_LIMITS = { scan: 100, bytes: 8 * 1024 * 1024, hits: 20, queryChars: 200, perWindow: 10, windowMs: 10_000, snippet: 160 };

type Cursor = { at: string; id: string };
const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify([cursor.at, cursor.id])).toString("base64url");
function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown[];
    if (typeof at === "string" && typeof id === "string" && at.length <= 40 && /^[0-9a-f-]{36}$/.test(id)) return { at, id };
  } catch { /* invalid */ }
  throw new ReportError(400, "INVALID", "That search cursor is not valid");
}

const requests = new Map<string, number[]>();
function rateLimited(userId: string, time = Date.now()): boolean {
  const start = time - NOOK_FILE_SEARCH_LIMITS.windowMs;
  if (requests.size > 1000) for (const [key, stamps] of requests) if ((stamps.at(-1) ?? 0) <= start) requests.delete(key);
  const stamps = (requests.get(userId) ?? []).filter((stamp) => stamp > start);
  const limited = stamps.length >= NOOK_FILE_SEARCH_LIMITS.perWindow;
  if (!limited) stamps.push(time);
  requests.set(userId, stamps);
  return limited;
}
/** Test hook: forget the rate-limit history. */
export const resetNookFileSearchRate = () => requests.clear();

const candidatesSql = `
  SELECT d.*, u.display_name AS owner_name FROM documents d JOIN users u ON u.id = d.owner_id
  WHERE ${readableDocumentPredicate} AND d.purpose = 'file' AND d.preview_kind = 'text' AND d.size_bytes <= $maxBytes
    AND NOT EXISTS (SELECT 1 FROM whiteboards wk WHERE wk.document_id = d.id)
    AND ($at IS NULL OR d.updated_at < $at OR (d.updated_at = $at AND d.id < $id))
  ORDER BY d.updated_at DESC, d.id DESC LIMIT $limit`;

/** A plain one-line snippet of `text` around `index` (no markup; the client shows it as text). */
function snippetAt(text: string, index: number, length: number): string {
  const half = Math.floor(NOOK_FILE_SEARCH_LIMITS.snippet / 2);
  const start = Math.max(0, index - half);
  const end = Math.min(text.length, index + length + half);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

/** One page of Files text documents `userId` can read whose name or text has every word of `query`. */
export async function searchNookFiles(userId: string, query: string, cursorValue?: string | null): Promise<NookFileSearch> {
  const words = query.toLowerCase().slice(0, NOOK_FILE_SEARCH_LIMITS.queryChars).split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) return { results: [], next: null };
  const cursor = decodeCursor(cursorValue);
  if (rateLimited(userId)) throw new ReportError(429, "RATE_LIMITED", "Too many file searches. Try again in a moment.");
  // Loaded when used, as nookSource.ts does (mcpTools imports most of the server).
  const { MCP_MAX_TEXT_BYTES, readDocumentText } = await import("../mcpTools");
  const started = performance.now();
  const rows = db.query(candidatesSql).all({ userId, maxBytes: MCP_MAX_TEXT_BYTES, at: cursor?.at ?? null, id: cursor?.id ?? null, limit: NOOK_FILE_SEARCH_LIMITS.scan + 1 }) as Array<DocumentRow & { owner_name: string }>;
  const results: NookFileHit[] = [];
  let read = 0;
  let scanned = 0;
  let last: Cursor | null = null;
  for (const row of rows.slice(0, NOOK_FILE_SEARCH_LIMITS.scan)) {
    if (results.length >= NOOK_FILE_SEARCH_LIMITS.hits) break;
    if (read > 0 && read + row.size_bytes > NOOK_FILE_SEARCH_LIMITS.bytes) break;
    scanned += 1;
    last = { at: row.updated_at, id: row.id };
    const name = row.name.toLowerCase();
    const hit = (matched: NookFileHit["matched"], snippet: string | null): NookFileHit => ({ id: row.id, name: row.name, ownerName: row.owner_name, isOwner: row.owner_id === userId, updatedAt: row.updated_at, matched, snippet });
    if (words.every((word) => name.includes(word))) { results.push(hit("name", null)); continue; }
    let text: string;
    try {
      read += row.size_bytes;
      text = await readDocumentText(row);
    } catch {
      continue; // Not UTF-8 text, or storage trouble: not a hit (read_document_text would refuse it too).
    }
    const lower = text.toLowerCase();
    if (!words.every((word) => name.includes(word) || lower.includes(word))) continue;
    const first = words.map((word) => lower.indexOf(word)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
    results.push(hit("text", snippetAt(text, first, words[0]!.length)));
  }
  const more = scanned < rows.length;
  slog.info("Nook file search", { user: shortId(userId), scanned, bytes: read, hits: results.length, more, ms: Math.round(performance.now() - started) });
  return { results, next: more && last ? encodeCursor(last) : null };
}
