import { audit, db } from "../db";
import { addressHash } from "../mail";

/**
 * Bounce and complaint suppression (docs/plan/research/2026-09-28-outbound-email.md §B.4, T229).
 *
 * - A hard bounce, a spam complaint, or Resend's own suppression puts the address hash in
 *   `mail_suppressions`: Nook stops every non-security mail to it until the owner presses "Try
 *   again" (security mail still goes, since it protects the account).
 * - A soft (transient) bounce only counts. SOFT_BOUNCE_LIMIT of them within SOFT_BOUNCE_WINDOW_MS
 *   suppress non-security mail for SOFT_SUPPRESS_MS; after that it clears itself.
 *
 * Only hashes are stored: never the address, the subject, or the provider's bounce text.
 */

export const SOFT_BOUNCE_LIMIT = 3;
export const SOFT_BOUNCE_WINDOW_MS = 7 * 86_400_000;
export const SOFT_SUPPRESS_MS = 3 * 86_400_000;
/** "Try again" works once a day per account (§B.4). */
export const CLEAR_PER_DAY = 1;

export type SuppressionReason = "bounce" | "complaint" | "manual" | "soft";
export type SuppressionState = { reason: SuppressionReason; since: string; until: string | null } | null;

const iso = (ms: number) => new Date(ms).toISOString();

/** Whether (and why) non-security mail to this address is held back at `nowMs`. */
export function suppressionOf(address: string, nowMs = Date.now()): SuppressionState {
  const hash = addressHash(address);
  const hard = db.query("SELECT reason, created_at FROM mail_suppressions WHERE address_hash = ?").get(hash) as { reason: "bounce" | "complaint" | "manual"; created_at: string } | null;
  if (hard) return { reason: hard.reason, since: hard.created_at, until: null };
  const soft = db.query("SELECT last_at, suppressed_until FROM mail_soft_bounces WHERE address_hash = ? AND suppressed_until IS NOT NULL AND suppressed_until > ?").get(hash, iso(nowMs)) as { last_at: string; suppressed_until: string } | null;
  return soft ? { reason: "soft", since: soft.last_at, until: soft.suppressed_until } : null;
}

/** A hard bounce, complaint, or provider suppression. Idempotent: the first reason stays. */
export function suppressHash(hash: string, reason: "bounce" | "complaint", eventId: string | null, nowMs = Date.now()) {
  return db.query("INSERT OR IGNORE INTO mail_suppressions (address_hash, reason, provider_event_id, created_at) VALUES (?, ?, ?, ?)")
    .run(hash, reason, eventId?.slice(0, 100) ?? null, iso(nowMs)).changes === 1;
}

/** Counts one soft bounce; the SOFT_BOUNCE_LIMIT-th within the window suppresses for SOFT_SUPPRESS_MS. */
export function recordSoftBounce(hash: string, nowMs = Date.now()) {
  return db.transaction(() => {
    const row = db.query("SELECT count, first_at FROM mail_soft_bounces WHERE address_hash = ?").get(hash) as { count: number; first_at: string } | null;
    const fresh = !row || Date.parse(row.first_at) <= nowMs - SOFT_BOUNCE_WINDOW_MS;
    const count = fresh ? 1 : row.count + 1;
    const until = count >= SOFT_BOUNCE_LIMIT ? iso(nowMs + SOFT_SUPPRESS_MS) : null;
    db.query(`INSERT INTO mail_soft_bounces (address_hash, count, first_at, last_at, suppressed_until) VALUES ($hash, $count, $at, $at, $until)
        ON CONFLICT(address_hash) DO UPDATE SET count = $count, first_at = CASE WHEN $fresh THEN $at ELSE first_at END, last_at = $at,
          suppressed_until = COALESCE($until, suppressed_until)`)
      .run({ hash, count, at: iso(nowMs), until, fresh: fresh ? 1 : 0 });
    return { count, suppressed: until !== null };
  })();
}

/**
 * "Try again" (Settings → Email): the owner clears their own address's suppression, once a day.
 * Returns "cleared", "none" (nothing to clear), or "limited".
 */
export function clearOwnSuppression(userId: string, nowMs = Date.now()): "cleared" | "none" | "limited" {
  const user = db.query("SELECT email FROM users WHERE id = ?").get(userId) as { email: string } | null;
  if (!user) return "none";
  const state = suppressionOf(user.email, nowMs);
  if (!state) return "none";
  const recent = (db.query("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ? AND event_type = 'mail.suppression_cleared' AND created_at > ?")
    .get(userId, iso(nowMs - 86_400_000)) as { count: number }).count;
  if (recent >= CLEAR_PER_DAY) return "limited";
  const hash = addressHash(user.email);
  db.transaction(() => {
    db.query("DELETE FROM mail_suppressions WHERE address_hash = ?").run(hash);
    db.query("DELETE FROM mail_soft_bounces WHERE address_hash = ?").run(hash);
    audit(userId, null, "mail.suppression_cleared", { reason: state.reason });
  })();
  return "cleared";
}

/** Sweeper step: soft-bounce counters idle for a window and not holding mail back. */
export function sweepSoftBounces(nowMs = Date.now()) {
  return db.query("DELETE FROM mail_soft_bounces WHERE last_at < ? AND (suppressed_until IS NULL OR suppressed_until < ?)")
    .run(iso(nowMs - SOFT_BOUNCE_WINDOW_MS), iso(nowMs)).changes;
}
