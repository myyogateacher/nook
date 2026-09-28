import { db, now } from "../db";
import { withResourceLock } from "../storage";
import { isReactionKey, REACTION_NAMES_MAX, type ReactionAggregate, type ReactionKey } from "../../shared/reactions";
import { reactionTarget } from "./targets";

/**
 * Reactions (WAVES_18-20_SMALL.md §3, D182–D190). Writes are idempotent set-state: `on` inserts
 * (already there → no change), off deletes (absent → no change), so a double tap or a retry never
 * flips twice (D184). No audit event, no notification, and the target's revision and updated_at are
 * untouched (D190).
 */
export class ReactionError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 429, message: string, readonly code?: string, readonly retryAfter?: number) {
    super(message);
  }
  body() {
    return { error: this.message, ...(this.code ? { code: this.code } : {}) };
  }
}

export const REACTION_RATE_LIMIT = 60;
export const REACTION_RATE_WINDOW_MS = 60_000;
const reactionWrites = new Map<string, number[]>();

/** Sliding window per user, in memory (one app instance per data directory), D188. Returns Retry-After seconds, or 0. */
function reactionRateLimited(userId: string, time = Date.now()) {
  const windowStart = time - REACTION_RATE_WINDOW_MS;
  if (reactionWrites.size > 1000) {
    for (const [key, stamps] of reactionWrites) if ((stamps[stamps.length - 1] ?? 0) <= windowStart) reactionWrites.delete(key);
  }
  const stamps = (reactionWrites.get(userId) ?? []).filter((stamp) => stamp > windowStart);
  if (stamps.length >= REACTION_RATE_LIMIT) {
    reactionWrites.set(userId, stamps);
    return Math.max(1, Math.ceil((stamps[0]! + REACTION_RATE_WINDOW_MS - time) / 1000));
  }
  stamps.push(time);
  reactionWrites.set(userId, stamps);
  return 0;
}

/** Test hook: forget the rate-limit history. */
export function resetReactionRateLimit() {
  reactionWrites.clear();
}

type AggregateRow = { target_id: string; emoji: string; count: number; reacted: 0 | 1; names: string | null };

/**
 * The aggregates for many targets of one kind in one GROUP BY (§3.4a), keyed by target id. Only for
 * targets the caller can already read: callers embed them in payloads they have authorised (T151).
 * Reactions of blocked accounts are kept but neither counted nor named while blocked.
 */
export function reactionAggregates(kind: string, userId: string, targetIds: readonly string[]) {
  const result = new Map<string, ReactionAggregate[]>();
  if (!targetIds.length) return result;
  // The inner ORDER BY feeds json_group_array oldest first, so the names are the earliest reactors.
  const rows = db.query(`
    SELECT r.target_id, r.emoji, COUNT(*) AS count,
           MAX(r.user_id = $userId) AS reacted,
           MIN(r.created_at) AS first_at,
           json_group_array(u.display_name) FILTER (WHERE r.user_id <> $userId) AS names
    FROM (SELECT target_id, emoji, user_id, created_at FROM reactions
          WHERE target_kind = $kind AND target_id IN (SELECT value FROM json_each($targetIds))
          ORDER BY created_at, user_id) r
    JOIN users u ON u.id = r.user_id AND u.disabled_at IS NULL
    GROUP BY r.target_id, r.emoji
    ORDER BY r.target_id, first_at, r.emoji`).all({ kind, userId, targetIds: JSON.stringify(targetIds) }) as AggregateRow[];
  for (const row of rows) {
    // A key dropped from the curated set later stays in the table but is not shown.
    if (!isReactionKey(row.emoji)) continue;
    const others = (row.names ? JSON.parse(row.names) : []) as string[];
    const list = result.get(row.target_id) ?? [];
    list.push({ emoji: row.emoji as ReactionKey, count: row.count, reacted: row.reacted === 1, names: others.slice(0, REACTION_NAMES_MAX), more: Math.max(0, others.length - REACTION_NAMES_MAX) });
    result.set(row.target_id, list);
  }
  return result;
}

/** `items` with each one's `reactions` for `kind` attached, from one aggregate query. */
export function withReactions<T extends { id: string }>(kind: string, userId: string, items: readonly T[]) {
  const aggregates = reactionAggregates(kind, userId, items.map((item) => item.id));
  return items.map((item) => ({ ...item, reactions: aggregates.get(item.id) ?? [] }));
}

const notFound = () => new ReactionError(404, "Not found");

/** Add (`on`) or remove the caller's `emoji` on a target. Returns that target's aggregates. */
export async function setReaction(userId: string, kind: string, targetId: string, emoji: string, on: boolean) {
  const target = reactionTarget(kind);
  if (!target) throw notFound();
  if (!isReactionKey(emoji)) throw new ReactionError(400, "Choose one of the listed reactions", "INVALID_EMOJI");
  const retryAfter = reactionRateLimited(userId);
  if (retryAfter) throw new ReactionError(429, "Slow down a little.", "RATE_LIMITED", retryAfter);
  const found = target.readable(targetId, userId);
  if (!found) throw notFound();
  if (!target.writable(targetId, userId)) throw new ReactionError(403, "Your team role is read-only", "ROLE_READ_ONLY");
  const write = () => {
    // Re-check under the lock: a board unshared or a card binned meanwhile is 404 (T151).
    if (!target.readable(targetId, userId)) throw notFound();
    if (on) {
      db.query("INSERT OR IGNORE INTO reactions (target_kind, target_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)").run(kind, targetId, userId, emoji, now());
    } else {
      db.query("DELETE FROM reactions WHERE target_kind = ? AND target_id = ? AND user_id = ? AND emoji = ?").run(kind, targetId, userId, emoji);
    }
    return { reactions: reactionAggregates(kind, userId, [targetId]).get(targetId) ?? [] };
  };
  return found.lockKey ? withResourceLock(found.lockKey, async () => write()) : write();
}
