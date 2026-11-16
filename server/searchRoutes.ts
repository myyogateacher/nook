import type { Hono } from "hono";
import { readableNotePredicate, visibleNoteFolderIdExpression } from "./access";
import type { AppEnv } from "./auth";
import { db } from "./db";
import { buildFtsQuery, HIT_END, HIT_START, MAX_QUERY_LENGTH, toSegments, type Segment } from "./search";
import { searchCollectionRows, type RowSearchHit } from "./collections/search";
import { searchWhiteboards, type WhiteboardSearchHit } from "./whiteboards/search";
import { searchDocuments, type DocumentSearchHit } from "./documentSearch";
import { searchReports } from "./reports/search";
import { searchEvents } from "./calendar/search";
import { CARD_SEARCH_QUERY_MAX, searchCards } from "./tasks/cardSearch";
import { readableCollectionPredicate } from "./collections/access";
import { listChats } from "./agents/chats";
import { mayChatNow } from "./agents/status";
import { cardPath, collectionPath, collectionRowPath, documentPath, notePath, reportPath, whiteboardPath } from "./friendlyPaths";
import { uuid } from "./validation";
import { NO_FILTER, type SqlFilter } from "./keyResources";
import { BUILTIN_SEARCH_SCOPES, registeredSearchScopes, scopeAllowed, searchScope } from "./searchRegistry";
import { ALL_SEARCH_PER_SCOPE, type SearchItemRef, type SearchSection } from "../shared/workspaceSearch";
import type { Role } from "./team/roles";

/** A hit's highlighted segments as plain text. */
const plain = (segments: readonly Segment[]) => segments.map((segment) => segment.text).join("");

/**
 * Every built-in hit also carries `ref: { kind, id, title, href }` (D1342): one shape the ⌘K palette
 * and the link picker read for every scope, added beside each scope's own fields (nothing removed).
 * A note's href slugs its published title, never the owner's draft title (notePath, D1343, T680).
 */
type WithRef<T> = T & { ref: SearchItemRef };
const withRef = <T extends object>(ref: (hit: T) => SearchItemRef) => (hit: T): WithRef<T> => ({ ...hit, ref: ref(hit) });
const noteRef = withRef((hit: NoteSearchHit) => ({ kind: "note", id: hit.id, title: plain(hit.title) || "Untitled", href: notePath(hit.id) }));
const fileRef = withRef((hit: DocumentSearchHit) => ({ kind: "document", id: hit.id, title: hit.name, href: documentPath(hit.id) }));
const whiteboardRef = withRef((hit: WhiteboardSearchHit) => ({ kind: "whiteboard", id: hit.id, title: hit.name.replace(/\.excalidraw$/i, ""), href: whiteboardPath(hit.id) }));
const rowRef = withRef((hit: RowSearchHit) => ({ kind: "row", id: hit.rowId, title: plain(hit.title) || `Row in ${hit.collectionName}`, href: collectionRowPath(hit.collectionId, hit.rowId) }));
const reportRef = withRef((hit: { id: string; title: string; updatedAt: string }) => ({ kind: "report", id: hit.id, title: hit.title, href: reportPath(hit.id) }));

/** A built-in result list with its refs. */
const refs = <T extends object>(found: { results: T[]; truncated: boolean }, add: (hit: T) => WithRef<T>) => ({ ...found, results: found.results.map(add) });

/**
 * Cards for `scope=cards` (D1341): the relation picker's search (titles, or a card key), over live
 * cards on boards the caller can read, before LIMIT (T95). Each hit is the picker's own shape plus
 * `kind`, `href`, and `ref`.
 */
function searchCardHits(userId: string, q: string, limit: number) {
  const text = q.trim().slice(0, CARD_SEARCH_QUERY_MAX);
  if (!text) return { results: [], truncated: false };
  const found = searchCards(userId, text, { limit });
  return {
    results: found.results.map((hit) => {
      const href = cardPath(hit.board_id, hit.id);
      return { ...hit, kind: "card" as const, href, ref: { kind: "card" as const, id: hit.id, title: hit.title, href } };
    }),
    truncated: found.truncated
  };
}

/** Events for `scope=events` (D1341): titles on calendars the caller can read (server/calendar/search.ts). */
const searchEventHits = (userId: string, q: string, limit: number) =>
  refs(searchEvents(userId, q, limit), withRef((hit) => ({ kind: "event", id: hit.id, title: hit.title, href: hit.href })));

/**
 * Collections by name (D1342), for the All scope's Collections section ahead of its row hits: live
 * collections the caller can read (their list's predicate), case-insensitive `instr`, before LIMIT.
 */
function searchCollectionNames(userId: string, q: string, limit: number) {
  const query = q.trim().toLowerCase().slice(0, 200);
  if (!query) return [];
  const rows = db.query(`SELECT c.id, c.name, c.updated_at FROM collections c WHERE ${readableCollectionPredicate} AND instr(lower(c.name), $q) > 0
    ORDER BY (lower(c.name) = $q) DESC, (instr(lower(c.name), $q) = 1) DESC, c.updated_at DESC, c.id LIMIT $limit`).all({ userId, q: query, limit }) as Array<{ id: string; name: string; updated_at: string }>;
  return rows.map((row) => {
    const href = collectionPath(row.id);
    return { kind: "collection" as const, id: row.id, title: row.name, href, updatedAt: row.updated_at, ref: { kind: "collection" as const, id: row.id, title: row.name, href } };
  });
}

/**
 * The caller's own chats (D1341) whose title or messages match, as `GET /api/chats?q=` lists them
 * (owner-scoped inside the FTS stage); never chats shared with them. Only for a role that may chat
 * while Chat is set up, as every /api/chats route.
 */
function searchChatHits(userId: string, role: Role, q: string, limit: number) {
  if (!q.trim() || !mayChatNow(role)) return { results: [], truncated: false };
  const chats = listChats(userId, { q: q.slice(0, 200), limit: limit + 1 });
  return {
    results: chats.slice(0, limit).map((chat) => {
      const title = chat.title || "Untitled chat";
      const href = `/chat/${chat.id}`;
      return { kind: "chat" as const, id: chat.id, title, href, agentName: chat.agentName, updatedAt: chat.updatedAt, ref: { kind: "chat" as const, id: chat.id, title, href } };
    }),
    truncated: chats.length > limit
  };
}

/**
 * `scope=all` (docs/plan/WORKSPACE_MODULES.md §B.12): every built-in scope and every registered module
 * scope the caller has, the top results of each under its header. A scope that fails errors only its
 * own section. Each scope runs its own access predicate (nothing new is reachable through All).
 * D1341 adds cards, events, and the caller's own chats; D1342 collection names ahead of row hits.
 */
async function searchAll(userId: string, role: Role, q: string): Promise<{ sections: SearchSection[] }> {
  const limit = ALL_SEARCH_PER_SCOPE;
  const builtins: Array<{ scope: string; label: string; run: () => { results: unknown[]; truncated: boolean } }> = [
    { scope: "notes", label: "Notes", run: () => refs(searchNotes(userId, q, { folder: "all", limit }), noteRef) },
    { scope: "cards", label: "Tasks", run: () => searchCardHits(userId, q, limit) },
    { scope: "events", label: "Calendar", run: () => searchEventHits(userId, q, limit) },
    { scope: "files", label: "Files", run: () => refs(searchDocuments(userId, q, limit), fileRef) },
    { scope: "whiteboards", label: "Whiteboards", run: () => refs(searchWhiteboards(userId, q, limit), whiteboardRef) },
    { scope: "collections", label: "Collections", run: () => {
      const named = searchCollectionNames(userId, q, limit);
      const rows = refs(searchCollectionRows(userId, q, { collection: "all", limit }), rowRef);
      return { results: [...named, ...rows.results].slice(0, limit), truncated: rows.truncated || named.length + rows.results.length > limit };
    } },
    ...(role === "guest" ? [] : [
      { scope: "reports", label: "Reports", run: () => refs(searchReports(userId, q, limit), reportRef) },
      { scope: "chats", label: "Chat", run: () => searchChatHits(userId, role, q, limit) }
    ])
  ];
  const modules = registeredSearchScopes().filter((def) => scopeAllowed(def, role));
  const sections: SearchSection[] = [];
  for (const builtin of builtins) {
    try {
      const { results, truncated } = builtin.run();
      sections.push({ scope: builtin.scope, label: builtin.label, results, truncated });
    } catch {
      sections.push({ scope: builtin.scope, label: builtin.label, results: [], truncated: false, error: "This section could not be searched" });
    }
  }
  for (const def of modules) {
    try {
      const { results, truncated } = await def.search({ userId, role, q, limit });
      sections.push({ scope: def.scope, label: def.label, results: results.slice(0, limit), truncated: truncated || results.length > limit });
    } catch {
      sections.push({ scope: def.scope, label: def.label, results: [], truncated: false, error: "This section could not be searched" });
    }
  }
  return { sections };
}

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
  app.get("/api/search", async (c) => {
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
    const registered = searchScope(scope);
    const builtin = (BUILTIN_SEARCH_SCOPES as readonly string[]).includes(scope);
    if (!builtin && scope !== "all" && !registered) {
      return c.json(invalid("scope must be all, notes, cards, events, collections, whiteboards, reports, files, chats, or a module's scope"), 400);
    }
    const limit = limitParam === undefined ? DEFAULT_LIMIT : Number(limitParam);
    if (!/^\d+$/.test(limitParam ?? "20") || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return c.json(invalid(`limit must be an integer from 1 to ${MAX_LIMIT}`), 400);
    }
    const role = c.get("user").role;
    if (scope === "all") return c.json(await searchAll(userId, role, q));
    // Workspace modules (§B.12): the module's own search, with its own access predicate.
    if (registered) return c.json(scopeAllowed(registered, role) ? await registered.search({ userId, role, q, limit }) : { results: [], truncated: false });
    // Cards (D1341): titles or a card key on boards the caller can read (the relation picker's search, T95).
    if (scope === "cards") return c.json(searchCardHits(userId, q, limit));
    // Events (D1341): titles on calendars the caller can read (T61).
    if (scope === "events") return c.json(searchEventHits(userId, q, limit));
    // Chats (D1341): the caller's own only; guests and roles that may not chat get nothing.
    if (scope === "chats") return c.json(role === "guest" ? { results: [], truncated: false } : searchChatHits(userId, role, q, limit));
    // Whiteboards (Wave 23, D204): names and text elements of boards the caller can read (T171).
    if (scope === "whiteboards") return c.json(refs(searchWhiteboards(userId, q, limit), whiteboardRef));
    // Files (lane FTS, 060): names and text of Files documents the caller can list, as read_document_text allows.
    if (scope === "files") return c.json(refs(searchDocuments(userId, q, limit), fileRef));
    // Analytics reports (Wave 45, D418): titles only, the caller's own; guests have no Reports module.
    if (scope === "reports") return c.get("user").role === "guest" ? c.json({ results: [], truncated: false }) : c.json(refs(searchReports(userId, q, limit), reportRef));
    if (scope === "collections") {
      // Collection rows (Wave 11): `collection` is all or one collection id; the ACL is in the query.
      const collection = (c.req.query("collection") ?? "all").toLowerCase();
      if (collection !== "all" && !uuid.safeParse(collection).success) return c.json(invalid("collection must be all or a collection id"), 400);
      return c.json(refs(searchCollectionRows(userId, q, { collection, limit }), rowRef));
    }
    if (folder !== "all" && folder !== "shared" && !uuid.safeParse(folder).success) return c.json(invalid("folder must be all, shared, or a folder id"), 400);
    return c.json(refs(searchNotes(userId, q, { folder, limit }), noteRef));
  });
}
