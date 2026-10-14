import { db } from "../db";
import { KNOWLEDGE_BOUNDS, RRF_K, type KnowledgeHit, type SourceKind } from "../../shared/knowledge";
import { assertBudget, chargeUsage } from "../agents/runs";
import { connectionFor } from "../agents/providers";
import { AgentError } from "../agents/status";
import { blobToVector, embedTexts, takesDimensions } from "./embed";
import { canReadSource, kbChangingModel, kbProvider, MODEL_CHANGING_NOTICE, ownerIsActive, PROVIDER_REMOVED_NOTICE, type KbRow } from "./service";
import { recheckLater } from "./index";
import { logger } from "../log";

const slog = logger("knowledge");

/**
 * Search (plan §9, D368; Wave 44 "AC-E"): brute-force cosine over each base's vectors (a dot product,
 * since every vector is unit length) fused with FTS5 BM25 over the chunks' heading and text by
 * reciprocal rank fusion (k = 60), top `k` (5 by default, 8 at most). No sqlite-vec (a native
 * extension); 10,000 × 512 is about 5 M multiply-adds, a few milliseconds in Bun.
 *
 * Vectors are loaded lazily per base into one `Float32Array` and kept in an LRU of 128 MiB across
 * bases, keyed by the base's revision: indexing, removing a source, or anything else that changes
 * the chunks moves the revision, and the next search reloads.
 *
 * The query is embedded with the base's own provider and model (charged to whoever searches, after
 * the same budget check as a run). When that fails, the budget is used up, or the base's provider
 * was removed (M3: never the default instead), that group answers from BM25 alone, and the whole
 * search reports `mode: "keyword"` (L6).
 *
 * 2026-10-08: a base moving to another embedding model answers from BM25 alone, with a notice, until
 * every waiting source is embedded again (`kbChangingModel`), so the vectors of two models are never
 * ranked together; no query embedding is made for it. Chunks without a vector (the change's copies,
 * or a source that failed during it) are never loaded into the vector matrix.
 *
 * Wave 44 fixes: a base whose owner is blocked answers nothing (M2), and a hit whose note or file
 * the base's owner can no longer read is dropped before it is returned (M1); its source is marked
 * `unavailable` afterwards, outside the search.
 */

type Matrix = { kbId: string; revision: number; dims: number; ids: Int32Array; vectors: Float32Array; bytes: number };

/** The cache's bound and counters, on an object so tests can shrink it and watch it. */
export const knowledgeCache = { maxBytes: 128 * 1024 * 1024, loads: 0 };
const cache = new Map<string, Matrix>();
let cachedBytes = 0;

function evict(kbId: string) {
  const entry = cache.get(kbId);
  if (!entry) return;
  cache.delete(kbId);
  cachedBytes -= entry.bytes;
}

/** Drops a base's vectors (purge); a changed revision also does it on the next search. */
export const forgetKnowledgeVectors = (kbId: string) => evict(kbId);
export const knowledgeCacheState = () => ({ bases: [...cache.keys()], bytes: cachedBytes });
export function resetKnowledgeCacheForTests() {
  cache.clear();
  cachedBytes = 0;
  knowledgeCache.loads = 0;
}

/** The base's vectors at its current revision, from the cache or loaded now. */
export function vectorsOf(kb: Pick<KbRow, "id" | "revision" | "dims">): Matrix {
  const hit = cache.get(kb.id);
  if (hit && hit.revision === kb.revision && hit.dims === kb.dims) {
    cache.delete(kb.id);
    cache.set(kb.id, hit);
    return hit;
  }
  evict(kb.id);
  // Only vectors of the base's own size (2026-10-08: never a chunk without one, never another size).
  const rows = db.query("SELECT id, embedding FROM kb_chunks WHERE kb_id = ? AND length(embedding) = ? ORDER BY id").all(kb.id, kb.dims * 4) as Array<{ id: number; embedding: Uint8Array }>;
  const ids = new Int32Array(rows.length);
  const vectors = new Float32Array(rows.length * kb.dims);
  rows.forEach((row, index) => {
    ids[index] = row.id;
    blobToVector(row.embedding, vectors, index * kb.dims);
  });
  const entry: Matrix = { kbId: kb.id, revision: kb.revision, dims: kb.dims, ids, vectors, bytes: vectors.byteLength + ids.byteLength };
  knowledgeCache.loads += 1;
  cache.set(kb.id, entry);
  cachedBytes += entry.bytes;
  // Least recently used first (Map order), but never the one just loaded.
  for (const key of cache.keys()) {
    if (cachedBytes <= knowledgeCache.maxBytes || key === kb.id) break;
    evict(key);
  }
  return entry;
}

/** The `limit` best chunks of one base for a unit query vector, by cosine (dot product). */
export function cosineTop(matrix: Matrix, query: Float32Array, limit: number): Array<{ id: number; score: number }> {
  const { dims, ids, vectors } = matrix;
  if (query.length !== dims) return [];
  const scores: Array<{ id: number; score: number }> = [];
  for (let row = 0; row < ids.length; row += 1) {
    let dot = 0;
    const base = row * dims;
    for (let index = 0; index < dims; index += 1) dot += vectors[base + index]! * query[index]!;
    scores.push({ id: ids[row]!, score: dot });
  }
  scores.sort((left, right) => right.score - left.score || left.id - right.id);
  return scores.slice(0, limit);
}

/** The FTS5 query for a free-text query: its words, each quoted, OR-ed (so punctuation never breaks the syntax). */
export function ftsQuery(query: string): string | null {
  const words = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 1 || /\p{N}/u.test(word)))].slice(0, 32);
  return words.length ? words.map((word) => `"${word}"`).join(" OR ") : null;
}

/** The `limit` best chunks of the bases by BM25 (the heading weighs twice the text). */
export function keywordTop(kbIds: readonly string[], query: string, limit: number): number[] {
  const match = ftsQuery(query);
  if (!match || kbIds.length === 0) return [];
  const rows = db.query(`SELECT f.rowid AS id FROM kb_chunk_fts f JOIN kb_chunks c ON c.id = f.rowid
    WHERE kb_chunk_fts MATCH $match AND c.kb_id IN (SELECT value FROM json_each($kbs)) ORDER BY bm25(kb_chunk_fts, 2.0, 1.0), f.rowid LIMIT $limit`)
    .all({ match, kbs: JSON.stringify(kbIds), limit }) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

/** Reciprocal rank fusion (k = 60): Σ 1 / (60 + rank), ranks from 1. */
export function fuse(lists: ReadonlyArray<readonly number[]>, k = RRF_K): Array<{ id: number; score: number; ranks: Array<number | null> }> {
  const scores = new Map<number, { score: number; ranks: Array<number | null> }>();
  lists.forEach((list, which) => {
    list.forEach((id, index) => {
      const entry = scores.get(id) ?? { score: 0, ranks: lists.map(() => null) };
      entry.score += 1 / (k + index + 1);
      entry.ranks[which] = index + 1;
      scores.set(id, entry);
    });
  });
  return [...scores.entries()].map(([id, entry]) => ({ id, ...entry })).sort((left, right) => right.score - left.score || left.id - right.id);
}

export type RawHit = {
  chunkId: number; kbId: string; heading: string | null; text: string; score: number; ranks: { vector: number | null; keyword: number | null };
  source: { id: string; kind: SourceKind; refId: string | null; title: string };
};
export type SearchOutcome = { hits: RawHit[]; mode: "hybrid" | "keyword"; notice?: string };
/** Who pays for the query's embedding: the person searching (and the calling key over MCP or the API). */
export type SearchPayer = { userId: string; keyId?: string };

const CANDIDATES = 50;

/**
 * Searches the bases (already checked by the caller: live, and open to whoever asked). Each group
 * of bases that share a provider, model, and size gets one query embedding.
 */
export async function searchBases(all: readonly KbRow[], query: string, k: number, payer: SearchPayer, signal?: AbortSignal): Promise<SearchOutcome> {
  const text = query.trim().slice(0, KNOWLEDGE_BOUNDS.queryChars);
  const limit = Math.max(1, Math.min(KNOWLEDGE_BOUNDS.k.max, Math.floor(k) || KNOWLEDGE_BOUNDS.k.default));
  // M2: a blocked owner's bases answer nothing.
  const kbs = all.filter((kb) => ownerIsActive(kb.owner_id));
  if (!text || kbs.length === 0) return { hits: [], mode: "hybrid" };
  const vectorHits: Array<{ id: number; score: number }> = [];
  let vectorFailed = false;
  let providerRemoved = false;
  let changingModel = false;
  const groups = new Map<string, KbRow[]>();
  for (const kb of kbs) {
    if (kb.chunk_count === 0) continue;
    // 2026-10-08: mid-change, keywords only (never two embedding spaces in one search).
    if (kbChangingModel(kb.id)) {
      vectorFailed = true;
      changingModel = true;
      continue;
    }
    const key = `${kb.provider_id ?? ""}|${kb.embedding_model}|${kb.dims}`;
    groups.set(key, [...(groups.get(key) ?? []), kb]);
  }
  for (const group of groups.values()) {
    const first = group[0]!;
    // M3: the base's own provider or none (never the current default): keyword-only, with a note.
    const provider = kbProvider(first);
    if (!provider) {
      vectorFailed = true;
      providerRemoved = true;
      continue;
    }
    try {
      const connection = connectionFor(provider.id, null);
      const result = await embedTexts(connection, first.embedding_model, takesDimensions(first.embedding_model) ? first.dims : null, [text], {
        beforeBatch: () => assertBudget(payer.userId),
        afterBatch: (tokens) => chargeUsage(payer.userId, `kb:${first.id}`, { promptTokens: tokens, completionTokens: 0, estimated: false }, 0, payer.keyId ?? ""),
        signal
      });
      const query = result.vectors[0]!;
      for (const kb of group) vectorHits.push(...cosineTop(vectorsOf(kb), query, CANDIDATES));
    } catch (error) {
      if (signal?.aborted) throw error;
      // Keyword-only for this group: the provider failed, refused, or the budget is used up.
      vectorFailed = true;
      if (!(error instanceof AgentError) && !(error instanceof Error && error.name === "ProviderError")) slog.error("Knowledge query embedding failed", error);
    }
  }
  vectorHits.sort((left, right) => right.score - left.score || left.id - right.id);
  const vectorIds = vectorHits.slice(0, CANDIDATES).map((hit) => hit.id);
  const keywordIds = keywordTop(kbs.map((kb) => kb.id), text, CANDIDATES);
  const fused = fuse([vectorIds, keywordIds]);
  const notice = providerRemoved ? PROVIDER_REMOVED_NOTICE : changingModel ? MODEL_CHANGING_NOTICE : null;
  const outcome = (hits: RawHit[]): SearchOutcome => ({ hits, mode: vectorFailed ? "keyword" : "hybrid", ...(notice ? { notice } : {}) });
  if (fused.length === 0) return outcome([]);
  const rows = db.query(`SELECT c.id, c.kb_id, c.heading, c.text, s.id AS source_id, s.kind, s.ref_id, s.title FROM kb_chunks c JOIN kb_sources s ON s.id = c.source_id
    WHERE c.id IN (SELECT value FROM json_each($ids))`).all({ ids: JSON.stringify(fused.map((hit) => hit.id)) }) as Array<{ id: number; kb_id: string; heading: string | null; text: string; source_id: string; kind: SourceKind; ref_id: string | null; title: string }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const owners = new Map(kbs.map((kb) => [kb.id, kb.owner_id]));
  // M1: a handful of distinct sources per search, each checked once against its base's owner.
  const readable = new Map<string, boolean>();
  const stale: Array<{ kind: "note" | "document"; refId: string }> = [];
  const hits: RawHit[] = [];
  for (const hit of fused) {
    if (hits.length >= limit) break;
    const row = byId.get(hit.id);
    if (!row) continue;
    if (row.kind !== "text") {
      const owner = owners.get(row.kb_id)!;
      const key = `${owner}:${row.kind}:${row.ref_id}`;
      if (!readable.has(key)) {
        const open = canReadSource(owner, row.kind, row.ref_id);
        readable.set(key, open);
        if (!open && row.ref_id) stale.push({ kind: row.kind, refId: row.ref_id });
      }
      if (!readable.get(key)) continue;
    }
    hits.push({ chunkId: row.id, kbId: row.kb_id, heading: row.heading, text: row.text, score: Math.round(hit.score * 1e6) / 1e6, ranks: { vector: hit.ranks[0] ?? null, keyword: hit.ranks[1] ?? null }, source: { id: row.source_id, kind: row.kind, refId: row.ref_id, title: row.title } });
  }
  recheckLater(stale);
  return outcome(hits);
}

/**
 * QA LOW-2: the heading path as someone who cannot open the source sees it. A note's own title (its
 * H1, the path's first segment when it equals the source's title) is dropped; the sub-headings stay.
 */
export function headingFor(heading: string | null, sourceTitle: string, open: boolean): string | null {
  if (open || !heading) return heading;
  const segments = heading.split(" › ");
  if (segments[0]!.trim().toLowerCase() !== sourceTitle.trim().toLowerCase()) return heading;
  const rest = segments.slice(1).join(" › ");
  return rest || null;
}

/**
 * Hits as a reader sees them (plan §9, T320): the text always (it was published into the base on
 * purpose), but a note's or file's id and title only when `readerId` can open it now. Pasted text
 * keeps its title (it lives only in the base).
 */
export function presentHits(hits: readonly RawHit[], readerId: string, names: ReadonlyMap<string, string>): KnowledgeHit[] {
  const readable = new Map<string, boolean>();
  return hits.map((hit) => {
    const key = `${hit.source.kind}:${hit.source.refId}`;
    if (!readable.has(key)) readable.set(key, canReadSource(readerId, hit.source.kind, hit.source.refId));
    const open = readable.get(key)!;
    const source: KnowledgeHit["source"] = hit.source.kind === "text" ? { kind: "text", title: hit.source.title } : open ? { kind: hit.source.kind, id: hit.source.refId!, title: hit.source.title } : { kind: hit.source.kind };
    return { kb: { id: hit.kbId, name: names.get(hit.kbId) ?? "" }, heading: hit.source.kind === "text" ? hit.heading : headingFor(hit.heading, hit.source.title, open), source, text: hit.text.length > KNOWLEDGE_BOUNDS.hitTextChars ? `${hit.text.slice(0, KNOWLEDGE_BOUNDS.hitTextChars - 1)}…` : hit.text, score: hit.score, ranks: hit.ranks };
  });
}
