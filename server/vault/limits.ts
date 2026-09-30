import { db } from "../db";
import { VaultError, type VaultActor } from "./access";

/**
 * Vault rate limits (vault plan §7, T194, T195): reveals and value reads 300 per 10 minutes per
 * person, writes 300 per 10 minutes, exports 10 an hour, and failed protected-environment
 * re-authentication attempts 10 per 10 minutes per session (Wave 26). Counters live in SQLite (`vault_rate_limits`), so a restart
 * does not reset them. Each bucket is a sliding window estimated from the current and previous fixed
 * windows (the previous one weighted by how much of it still overlaps). A refused request costs
 * nothing and gets 429 `RATE_LIMITED` with `retryAfterSeconds`.
 *
 * Wave 27 adds per-key buckets for `nkv_` keys (T183, T191, T192), lower than a person's: reads 20 a
 * minute and 1,000 an hour, writes 10 a minute and 200 a day, and value reads over MCP 60 an hour
 * (the plan's §7.1 cap, since those values leave the host). A key's calls charge only the key's
 * buckets, so a busy CI job cannot lock its creator out of the app. A refusal is a `KeyLimitError`;
 * the REST and MCP layers record the `key.vault.limited` alert when they see one.
 */
export const VAULT_LIMITS = {
  read: { limit: 300, windowMs: 10 * 60_000 },
  write: { limit: 300, windowMs: 10 * 60_000 },
  /** Exports (§7): 10 an hour per person, each one a whole environment in plaintext. */
  export: { limit: 10, windowMs: 60 * 60_000 },
  /** Failed re-authentication attempts for protected environments (D226): 10 per 10 minutes per session. */
  reauth: { limit: 10, windowMs: 10 * 60_000 },
  /** Per vault key (Wave 27): value, comment, and version reads. */
  keyRead: { limit: 20, windowMs: 60_000 },
  keyReadHour: { limit: 1000, windowMs: 60 * 60_000 },
  /** Per vault key: secrets created and values written. */
  keyWrite: { limit: 10, windowMs: 60_000 },
  keyWriteDay: { limit: 200, windowMs: 24 * 60 * 60_000 },
  /** Per vault key: values read over MCP (T191), on top of the read buckets. */
  keyMcpValue: { limit: 60, windowMs: 60 * 60_000 }
} as const;
export type VaultLimit = keyof typeof VAULT_LIMITS;

type Row = { window_start: number; count: number; previous_count: number };

/** A per-key vault limit refused a key's call (the caller records the alert, then answers 429). */
export class KeyLimitError extends VaultError {
  constructor(readonly keyId: string, readonly bucket: VaultLimit, retryAfterSeconds: number) {
    super(429, "RATE_LIMITED", "Too many vault requests for this API key. Try again later.", { retryAfterSeconds });
    this.name = "KeyLimitError";
  }
}

type Charge = { kind: VaultLimit; subject: string; cost: number };

/**
 * Checks every charge first and applies them only when all fit, in one transaction, so a refused
 * request costs nothing in any bucket. Returns the first bucket that refused (with the wait) or null.
 */
function chargeAll(charges: readonly Charge[], nowMs: number): { kind: VaultLimit; retryAfterSeconds: number } | null {
  return db.transaction(() => {
    const planned: Array<{ bucket: string; windowStart: number; count: number; previous: number; cost: number }> = [];
    for (const { kind, subject, cost } of charges) {
      const { limit, windowMs } = VAULT_LIMITS[kind];
      const bucket = `${kind}:${subject}`;
      const windowStart = Math.floor(nowMs / windowMs) * windowMs;
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
      if (estimate + Math.max(cost, 1) > limit) {
        // At worst the current window has to end before the estimate drops enough.
        return { kind, retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000)) };
      }
      planned.push({ bucket, windowStart, count, previous, cost });
    }
    for (const plan of planned) {
      if (plan.cost === 0) continue;
      db.query(`INSERT INTO vault_rate_limits (bucket, window_start, count, previous_count) VALUES (?, ?, ?, ?)
        ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = excluded.count, previous_count = excluded.previous_count`)
        .run(plan.bucket, plan.windowStart, plan.count + plan.cost, plan.previous);
    }
    return null;
  })();
}

/**
 * Charges `cost` to the `kind:subject` bucket, or 429 when that would pass the limit. With `cost` 0
 * it only checks that one more would still fit (the re-authentication limit peeks first and charges
 * failures only).
 */
export function chargeVault(kind: VaultLimit, subject: string, cost = 1, nowMs = Date.now()) {
  const refused = chargeAll([{ kind, subject, cost }], nowMs);
  if (refused) throw new VaultError(429, "RATE_LIMITED", "Too many vault requests. Try again later.", { retryAfterSeconds: refused.retryAfterSeconds });
}

/**
 * Charges a read or a write to whoever acts: a person's own bucket for a session, the key's buckets
 * for a vault key (never its creator's, T183). `mcpValue` adds the MCP value-read bucket (T191).
 */
export function chargeActor(actor: VaultActor, kind: "read" | "write", cost = 1, options: { mcpValue?: boolean } = {}, nowMs = Date.now()) {
  if (actor.kind === "session") return chargeVault(kind, actor.userId, cost, nowMs);
  const charges: Charge[] = kind === "read"
    ? [{ kind: "keyRead", subject: actor.keyId, cost }, { kind: "keyReadHour", subject: actor.keyId, cost }]
    : [{ kind: "keyWrite", subject: actor.keyId, cost }, { kind: "keyWriteDay", subject: actor.keyId, cost }];
  if (options.mcpValue) charges.push({ kind: "keyMcpValue", subject: actor.keyId, cost });
  const refused = chargeAll(charges, nowMs);
  if (refused) throw new KeyLimitError(actor.keyId, refused.kind, refused.retryAfterSeconds);
}

/** Test hook. */
export function resetVaultLimitsForTests() {
  db.exec("DELETE FROM vault_rate_limits");
}
