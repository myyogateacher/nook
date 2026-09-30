import { db } from "../db";
import { VaultError } from "./access";

/**
 * Vault rate limits (vault plan §7, T194, T195): reveals and value reads 300 per 10 minutes per
 * person, writes 300 per 10 minutes. Counters live in SQLite (`vault_rate_limits`), so a restart
 * does not reset them. Each bucket is a sliding window estimated from the current and previous fixed
 * windows (the previous one weighted by how much of it still overlaps). A refused request costs
 * nothing and gets 429 `RATE_LIMITED` with `retryAfterSeconds`. Wave 27 adds the per-key buckets.
 */
export const VAULT_LIMITS = {
  read: { limit: 300, windowMs: 10 * 60_000 },
  write: { limit: 300, windowMs: 10 * 60_000 }
} as const;
export type VaultLimit = keyof typeof VAULT_LIMITS;

type Row = { window_start: number; count: number; previous_count: number };

export function chargeVault(kind: VaultLimit, subject: string, cost = 1, nowMs = Date.now()) {
  const { limit, windowMs } = VAULT_LIMITS[kind];
  const bucket = `${kind}:${subject}`;
  const windowStart = Math.floor(nowMs / windowMs) * windowMs;
  db.transaction(() => {
    const row = db.query("SELECT window_start, count, previous_count FROM vault_rate_limits WHERE bucket = ?").get(bucket) as Row | null;
    let count = 0;
    let previous = 0;
    if (row && row.window_start === windowStart) {
      count = row.count;
      previous = row.previous_count;
    } else if (row && row.window_start === windowStart - windowMs) {
      previous = row.count;
    }
    const overlap = 1 - (nowMs - windowStart) / windowMs;
    const estimate = previous * overlap + count;
    if (estimate + cost > limit) {
      // At worst the current window has to end before the estimate drops enough.
      const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000));
      throw new VaultError(429, "RATE_LIMITED", "Too many vault requests. Try again later.", { retryAfterSeconds });
    }
    db.query(`INSERT INTO vault_rate_limits (bucket, window_start, count, previous_count) VALUES (?, ?, ?, ?)
      ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = excluded.count, previous_count = excluded.previous_count`)
      .run(bucket, windowStart, count + cost, previous);
  })();
}

/** Test hook. */
export function resetVaultLimitsForTests() {
  db.exec("DELETE FROM vault_rate_limits");
}
