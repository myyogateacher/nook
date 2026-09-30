import { db } from "../db";
import { readableBoardPredicate } from "./access";
import { NO_FILTER, type SqlFilter } from "../keyResources";

/**
 * Card search for the relation picker (WAVE_13_TASK_CARD_UX.md D106, T95). Not full-text search:
 * a case-insensitive `instr` match on titles (so `%` and `_` are literal), over live cards on live
 * boards the caller can read. The readable predicate runs before LIMIT, and only titles, board
 * names, and column names are returned.
 */
export const CARD_SEARCH_QUERY_MAX = 100;
export const CARD_SEARCH_LIMIT_MAX = 20;
export const CARD_SEARCH_RATE_LIMIT = 20;
export const CARD_SEARCH_RATE_WINDOW_MS = 10_000;

export type CardSearchHit = { id: string; board_id: string; board_name: string; title: string; column_name: string; is_done: 0 | 1 };

/**
 * Order: cards on `boardId` first (a hint only; it never widens or narrows the readable set), then
 * titles that start with `q`, then the most recently updated.
 */
/** `keyScope` (Wave 34): an API key limited to chosen boards, over `k.board_id`, applied before the LIMIT. */
export function searchCards(userId: string, q: string, options: { boardId?: string | null; excludeCardId?: string | null; limit?: number; keyScope?: SqlFilter } = {}) {
  const keyScope = options.keyScope ?? NO_FILTER;
  const limit = options.limit ?? CARD_SEARCH_LIMIT_MAX;
  const rows = db.query(`
    SELECT k.id, k.board_id, b.name AS board_name, k.title, c.name AS column_name, c.is_done
    FROM cards k JOIN boards b ON b.id = k.board_id JOIN board_columns c ON c.id = k.column_id
    WHERE k.deleted_at IS NULL AND ${readableBoardPredicate}
      AND instr(lower(k.title), lower($q)) > 0
      AND ($excludeCardId IS NULL OR k.id <> $excludeCardId)
      AND ${keyScope.sql}
    ORDER BY CASE WHEN k.board_id = $boardId THEN 0 ELSE 1 END, CASE WHEN instr(lower(k.title), lower($q)) = 1 THEN 0 ELSE 1 END,
             k.updated_at DESC, k.id
    LIMIT $limit`).all({ ...keyScope.params, userId, q, boardId: options.boardId ?? null, excludeCardId: options.excludeCardId ?? null, limit: limit + 1 }) as CardSearchHit[];
  return { results: rows.slice(0, limit), truncated: rows.length > limit };
}

const searchRequests = new Map<string, number[]>();

/**
 * The same sliding window as `/api/search` (20 per 10 s per user, in memory), in its own bucket so
 * typing in a picker does not use up notes search. Returns seconds to wait, or 0.
 */
export function cardSearchRateLimited(userId: string, time = Date.now()) {
  const windowStart = time - CARD_SEARCH_RATE_WINDOW_MS;
  if (searchRequests.size > 1000) {
    for (const [key, stamps] of searchRequests) if ((stamps[stamps.length - 1] ?? 0) <= windowStart) searchRequests.delete(key);
  }
  const stamps = (searchRequests.get(userId) ?? []).filter((stamp) => stamp > windowStart);
  if (stamps.length >= CARD_SEARCH_RATE_LIMIT) {
    searchRequests.set(userId, stamps);
    return Math.max(1, Math.ceil((stamps[0]! + CARD_SEARCH_RATE_WINDOW_MS - time) / 1000));
  }
  stamps.push(time);
  searchRequests.set(userId, stamps);
  return 0;
}

/** Test hook: forget the card search rate-limit history. */
export function resetCardSearchRateLimit() {
  searchRequests.clear();
}
