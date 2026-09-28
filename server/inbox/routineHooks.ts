import { db, now } from "../db";

/**
 * The two places outside the inbox that touch routines, kept free of other imports so the MCP
 * runner and the team service can call them without an import cycle.
 */

const countCall = db.query(`UPDATE routine_runs SET tool_calls = tool_calls + 1 WHERE id = (
    SELECT id FROM routine_runs WHERE key_id = ? AND status = 'running' AND lease_expires_at > ? ORDER BY started_at DESC, rowid DESC LIMIT 1)`);

/**
 * D160, T134: while a key holds an open run, each of its admitted tool calls adds one to that
 * run's `tool_calls` (the newest open run when the key holds several). One indexed UPDATE, only for
 * the calling key, and it stops at the lease end. The client never reports the count.
 */
export function countRunToolCall(keyId: string, nowMs = Date.now()) {
  countCall.run(keyId, new Date(nowMs).toISOString());
}

/** D152: a user demoted to a read-only role has their routines paused (they can resume after a promotion). */
export function pauseRoutinesOf(userId: string) {
  return db.query("UPDATE routines SET enabled = 0, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND enabled = 1").run(now(), userId).changes;
}
