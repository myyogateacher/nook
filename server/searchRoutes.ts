import type { Hono } from "hono";
import { readableNotePredicate, visibleNoteFolderIdExpression } from "./access";
import type { AppEnv } from "./auth";
import { db } from "./db";
import { buildFtsQuery, HIT_END, HIT_START, MAX_QUERY_LENGTH, toSegments, type Segment } from "./search";
import { searchCollectionRows } from "./collections/search";
import { searchWhiteboards } from "./whiteboards/search";
import { uuid } from "./validation";
import { NO_FILTER, type SqlFilter } from "./keyResources";

/** docs/plan/API_CONTRACTS.md § Search. */
export type NoteSearchHit = {
  id: string;
  source: "published" | "draft";
  title: Segment[];
  snippet: Segment[];
  folder_id: string | null;
  owner_name: string;
  is_owner: 0 | 1;
  visibility: "private" | "selected" | "all_users";
  updated_at: string;
};

export const SEARCH_RATE_LIMIT = 20;
export const SEARCH_RATE_WINDOW_MS = 10_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SNIPPET_TOKENS = 16;
const ELLIPSIS = "…";

const searchRequests = new Map<string, number[]>();

/** Sliding window per user, in memory (one app instance per data directory). */
function searchRateLimited(userId: string, time = Date.now()) {
  const windowStart = time - SEARCH_RATE_WINDOW_MS;
  if (searchRequests.size > 1000) {
    for (const [key, stamps] of searchRequests) if ((stamps[stamps.length - 1] ?? 0) <= windowStart) searchRequests.delete(key);
  }
  const stamps = (searchRequests.get(userId) ?? []).filter((stamp) => stamp > windowStart);
  if (stamps.length >= SEARCH_RATE_LIMIT) {
    searchRequests.set(userId, stamps);
    return Math.max(1, Math.ceil((stamps[0]! + SEARCH_RATE_WINDOW_MS - time) / 1000));
  }
  stamps.push(time);
  searchRequests.set(userId, stamps);
  return 0;
}

/** Test hook: forget the rate-limit history. */
export function resetSearchRateLimit() {
  searchRequests.clear();
}

/**
 * The live ACL is applied inside the query, before LIMIT (T28): a draft row
 * only for its owner; a published row only for readers, and never for the
 * owner while they have a draft (GET /api/notes/:id returns the draft then).
 * folder_id is masked exactly as in GET /api/notes.
 */
const folderIdExpression = visibleNoteFolderIdExpression;

const searchSql = (folderFilter: string) => `
  SELECT n.id, r.kind AS source,
         highlight(note_fts, 0, $hitStart, $hitEnd) AS title_marked,
         snippet(note_fts, 1, $hitStart, $hitEnd, $ellipsis, $snippetTokens) AS snippet_marked,
         ${folderIdExpression} AS folder_id,
         u.display_name AS owner_name,
         CASE WHEN n.owner_id = $userId THEN 1 ELSE 0 END AS is_owner,
         CASE WHEN n.sharing_override = 0 THEN COALESCE(f.visibility, 'private') ELSE n.visibility END AS visibility,
         n.updated_at
  FROM note_fts
  JOIN note_search_rows r ON r.id = note_fts.rowid
  JOIN notes n ON n.id = r.note_id
  JOIN users u ON u.id = n.owner_id
  LEFT JOIN folders f ON f.id = n.folder_id
  WHERE note_fts MATCH $query
    AND n.deleted_at IS NULL
    AND (
      (r.kind = 'draft' AND n.owner_id = $userId AND n.draft_revision IS NOT NULL)
      OR (r.kind = 'published' AND n.current_version > 0
          AND NOT (n.owner_id = $userId AND n.draft_revision IS NOT NULL)
          AND ${readableNotePredicate})
    )
    ${folderFilter}
  ORDER BY bm25(note_fts, 8.0, 1.0), n.updated_at DESC
  LIMIT $limit
`;

const queries = {
  all: db.query(searchSql("")),
  shared: db.query(searchSql("AND n.owner_id <> $userId")),
  folder: db.query(searchSql(`AND ${folderIdExpression} = $folderId`))
};

type SearchRow = Omit<NoteSearchHit, "title" | "snippet"> & { title_marked: string; snippet_marked: string };

export function searchNotes(userId: string, q: string, options: { folder: "all" | "shared" | string; limit: number }) {
  const query = buildFtsQuery(q);
  if (query === null) return { results: [] as NoteSearchHit[], truncated: false };
  const params = {
    userId,
    query,
    hitStart: HIT_START,
    hitEnd: HIT_END,
    ellipsis: ELLIPSIS,
    snippetTokens: SNIPPET_TOKENS,
    limit: options.limit + 1
  };
  const rows = (options.folder === "all"
    ? queries.all.all(params)
    : options.folder === "shared"
      ? queries.shared.all(params)
      : queries.folder.all({ ...params, folderId: options.folder })) as SearchRow[];
  const results = rows.slice(0, options.limit).map(({ title_marked, snippet_marked, ...row }): NoteSearchHit => ({
    ...row,
    title: toSegments(title_marked),
    snippet: toSegments(snippet_marked)
  }));
  return { results, truncated: rows.length > options.limit };
}

/** An MCP search hit (D32): published text only, plain strings, no scores. */
export type PublishedSearchHit = {
  id: string;
  title: string;
  snippet: string;
  version: number;
  folder_id: string | null;
  owner_name: string;
  is_owner: 0 | 1;
  updated_at: string;
};

/**
 * Published rows only, for every reader including the owner (whose draft is
 * never searched here). The title is the published version's, not the
 * draft-derived `notes.title`. Snippets carry no markers, so the text is
 * plain. The same live ACL applies before LIMIT.
 */
const publishedSearchSql = (keyCondition: string) => `
  SELECT n.id, v.title, n.current_version AS version,
         snippet(note_fts, 1, '', '', $ellipsis, $snippetTokens) AS snippet,
         ${folderIdExpression} AS folder_id,
         u.display_name AS owner_name,
         CASE WHEN n.owner_id = $userId THEN 1 ELSE 0 END AS is_owner,
         n.updated_at
  FROM note_fts
  JOIN note_search_rows r ON r.id = note_fts.rowid AND r.kind = 'published'
  JOIN notes n ON n.id = r.note_id
  JOIN note_versions v ON v.note_id = n.id AND v.version_number = n.current_version
  JOIN users u ON u.id = n.owner_id
  LEFT JOIN folders f ON f.id = n.folder_id
  WHERE note_fts MATCH $query
    AND n.deleted_at IS NULL AND n.current_version > 0
    AND ${readableNotePredicate}
    AND ($folderId IS NULL OR ${folderIdExpression} = $folderId)
    AND ${keyCondition}
  ORDER BY bm25(note_fts, 8.0, 1.0), n.updated_at DESC
  LIMIT $limit
`;
const publishedSearch = db.query(publishedSearchSql("1"));

/**
 * `keyScope` (Wave 34): an API key limited to chosen notes or folders passes its filter over
 * `n.id` and `n.folder_id`, applied before the LIMIT so results and `truncated` only count them.
 */
export function searchPublishedNotes(userId: string, q: string, options: { folderId: string | null; limit: number; keyScope?: SqlFilter }) {
  const query = buildFtsQuery(q);
  if (query === null) return { results: [] as PublishedSearchHit[], truncated: false };
  const scope = options.keyScope ?? NO_FILTER;
  const statement = scope.sql === "1" ? publishedSearch : db.query(publishedSearchSql(scope.sql));
  const rows = statement.all({
    ...scope.params,
    userId,
    query,
    folderId: options.folderId,
    ellipsis: ELLIPSIS,
    snippetTokens: SNIPPET_TOKENS,
    limit: options.limit + 1
  }) as PublishedSearchHit[];
  return { results: rows.slice(0, options.limit), truncated: rows.length > options.limit };
}

const invalid = (detail: string) => ({ error: "Invalid request", details: [detail] });

export function registerSearchRoutes(app: Hono<AppEnv>) {
  app.get("/api/search", (c) => {
    const userId = c.get("user").id;
    const retryAfter = searchRateLimited(userId);
    if (retryAfter) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Too many searches. Try again in a moment.", code: "RATE_LIMITED" }, 429);
    }
    const q = c.req.query("q") ?? "";
    const scope = c.req.query("scope") ?? "notes";
    const folder = c.req.query("folder") ?? "all";
    const limitParam = c.req.query("limit");
    if (q.length > MAX_QUERY_LENGTH) return c.json(invalid(`q must be at most ${MAX_QUERY_LENGTH} characters`), 400);
    if (scope !== "notes" && scope !== "collections" && scope !== "whiteboards") return c.json(invalid("scope must be notes, collections, or whiteboards"), 400);
    const limit = limitParam === undefined ? DEFAULT_LIMIT : Number(limitParam);
    if (!/^\d+$/.test(limitParam ?? "20") || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return c.json(invalid(`limit must be an integer from 1 to ${MAX_LIMIT}`), 400);
    }
    // Whiteboards (Wave 23, D204): names and text elements of boards the caller can read (T171).
    if (scope === "whiteboards") return c.json(searchWhiteboards(userId, q, limit));
    if (scope === "collections") {
      // Collection rows (Wave 11): `collection` is all or one collection id; the ACL is in the query.
      const collection = (c.req.query("collection") ?? "all").toLowerCase();
      if (collection !== "all" && !uuid.safeParse(collection).success) return c.json(invalid("collection must be all or a collection id"), 400);
      return c.json(searchCollectionRows(userId, q, { collection, limit }));
    }
    if (folder !== "all" && folder !== "shared" && !uuid.safeParse(folder).success) return c.json(invalid("folder must be all, shared, or a folder id"), 400);
    return c.json(searchNotes(userId, q, { folder, limit }));
  });
}
