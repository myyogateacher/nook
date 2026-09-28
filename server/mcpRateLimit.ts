/**
 * MCP limits (docs/plan/WAVES_7-9.md §4.2, T36), in memory: one app instance
 * per data directory, and a restart only resets the windows.
 *
 * Every tool call counts against `call`; writes also count against `write`;
 * some writes also count against a daily bucket. Each bucket is enforced per
 * key and, with higher limits, per user across all of their keys, so minting
 * more keys does not multiply the budget. A call is admitted only if every
 * bucket it touches has room, and then all of them are charged, so a refused
 * call costs nothing.
 */
export type McpLimitBucket = "call" | "write" | "create_note" | "task_write" | "event_write" | "reminder_write" | "row_write" | "proposal_write" | "run_start";
type Limit = { limit: number; windowMs: number };

const MINUTE = 60_000;
const DAY = 86_400_000;

export const MCP_LIMITS: Record<McpLimitBucket, Limit> = {
  call: { limit: 120, windowMs: MINUTE },
  write: { limit: 30, windowMs: MINUTE },
  create_note: { limit: 200, windowMs: DAY },
  // create_card, update_card, move_card, comment_on_card, and link_cards (tasks:write).
  task_write: { limit: 500, windowMs: DAY },
  // create_event and update_event (calendar:write), and create_reminder (WAVES_10-12.md §4.5).
  event_write: { limit: 200, windowMs: DAY },
  reminder_write: { limit: 100, windowMs: DAY },
  // create_row and update_row (collections:write, WAVES_10-12.md §3.5).
  row_write: { limit: 500, windowMs: DAY },
  // Every item submit_proposals checks (agent inbox D155, section 7.3).
  proposal_write: { limit: 200, windowMs: DAY },
  // start_run (agent inbox Wave 22, section 7.3; T133).
  run_start: { limit: 48, windowMs: DAY }
};

/** Per user, across every key. Buckets without an entry are limited per key only. */
export const MCP_USER_LIMITS: Partial<Record<McpLimitBucket, Limit>> = {
  call: { limit: 1000, windowMs: MINUTE },
  write: { limit: 60, windowMs: MINUTE },
  create_note: { limit: 400, windowMs: DAY },
  task_write: { limit: 1000, windowMs: DAY },
  event_write: { limit: 400, windowMs: DAY },
  reminder_write: { limit: 200, windowMs: DAY },
  row_write: { limit: 1000, windowMs: DAY },
  proposal_write: { limit: 400, windowMs: DAY },
  run_start: { limit: 200, windowMs: DAY }
};

type Window = { count: number; resetAt: number };
const windows = new Map<string, Window>();

function sweep(time: number) {
  if (windows.size < 5000) return;
  for (const [key, window] of windows) if (window.resetAt <= time) windows.delete(key);
}

/**
 * Charges `buckets` for the key and, when `userId` is given, for its user.
 * Returns 0 when admitted, otherwise the seconds until the fullest blocking
 * bucket resets (fixed windows).
 */
export function consumeMcpLimits(subject: { keyId: string; userId?: string }, buckets: readonly McpLimitBucket[], time = Date.now()) {
  sweep(time);
  const charges: Array<{ key: string; limit: Limit }> = [];
  for (const bucket of buckets) {
    charges.push({ key: `key:${subject.keyId}:${bucket}`, limit: MCP_LIMITS[bucket] });
    const userLimit = MCP_USER_LIMITS[bucket];
    if (subject.userId && userLimit) charges.push({ key: `user:${subject.userId}:${bucket}`, limit: userLimit });
  }
  const current = charges.map(({ key, limit }) => {
    let window = windows.get(key);
    if (!window || window.resetAt <= time) {
      window = { count: 0, resetAt: time + limit.windowMs };
      windows.set(key, window);
    }
    return { window, limit };
  });
  const blocked = current.filter(({ window, limit }) => window.count >= limit.limit);
  if (blocked.length) return Math.max(...blocked.map(({ window }) => Math.max(1, Math.ceil((window.resetAt - time) / 1000))));
  for (const { window } of current) window.count += 1;
  return 0;
}

/** Test hook: forget every window. */
export function resetMcpLimits() {
  windows.clear();
}
