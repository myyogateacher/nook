import { db } from "../db";
import { mailEnabled, recipientHash } from "../mail";
import { quietHoursEnd, readEmailPrefs } from "./prefs";
import { TEMPLATES, type TemplateName } from "./registry";

/**
 * The mail outbox (docs/plan/research/2026-09-28-outbound-email.md §D.1). `enqueueMail` is a plain
 * synchronous insert, so a module calls it inside the transaction of the action that caused it: a
 * rolled-back action leaves no row, and a crash never loses a committed one. The network send
 * happens later, in the dispatcher tick (server/mail/dispatcher.ts).
 *
 * The payload holds ids and counts only, never rendered HTML, titles, or tokens (D.5, T226).
 * Nothing is queued while email is off.
 */

export const PAYLOAD_MAX_IDS = 50;
/** Coalescing windows (§D.1): the first row waits this long, and later events merge into it. */
export const WINDOW_MS = { activity: 10 * 60_000, proposals: 60 * 60_000, roleChange: 10 * 60_000 } as const;
/** At most one proposals mail per 3 hours (D240). */
export const PROPOSALS_MIN_GAP_MS = 3 * 3_600_000;

export type Payload = Record<string, unknown>;

export type EnqueueInput = {
  userId: string;
  template: TemplateName;
  payload: Payload;
  /** Rows with the same key merge while queued; the window is a max wait, never extended. */
  coalesceKey?: string;
  windowMs?: number;
  /** Merges a new payload into the queued one (defaults to replacing it). */
  merge?: (queued: Payload, incoming: Payload) => Payload;
  /** Earliest send (proposals' 3 h gap). */
  notBeforeMs?: number;
  nowMs?: number;
};

/** Unique ids, newest last, capped (a coalesced payload stays small). */
export function mergeIds(queued: unknown, incoming: unknown, max = PAYLOAD_MAX_IDS) {
  const list = [...(Array.isArray(queued) ? queued : []), ...(Array.isArray(incoming) ? incoming : [])].filter((item): item is string => typeof item === "string");
  return [...new Set(list)].slice(-max);
}

/**
 * Queues one mail for a user, or merges it into a queued one with the same coalesce key. Returns
 * the row id, or null when email is off or the user does not exist. Call inside the action's
 * transaction.
 */
export function enqueueMail(input: EnqueueInput): string | null {
  if (!mailEnabled()) return null;
  const definition = TEMPLATES[input.template];
  // Integrations (D287) never receive mail: their address is a synthetic `.invalid` one.
  const user = db.query("SELECT email FROM users WHERE id = ? AND kind = 'person'").get(input.userId) as { email: string } | null;
  if (!user) return null;
  const nowMs = input.nowMs ?? Date.now();
  if (input.coalesceKey) {
    const queued = db.query("SELECT id, payload FROM mail_outbox WHERE coalesce_key = ? AND status = 'queued' ORDER BY created_at LIMIT 1").get(input.coalesceKey) as { id: string; payload: string } | null;
    if (queued) {
      const merged = input.merge ? input.merge(JSON.parse(queued.payload) as Payload, input.payload) : input.payload;
      db.query("UPDATE mail_outbox SET payload = ? WHERE id = ? AND status = 'queued'").run(JSON.stringify(merged), queued.id);
      return queued.id;
    }
  }
  let notBefore = Math.max(nowMs + (input.windowMs ?? 0), input.notBeforeMs ?? 0);
  // Quiet hours hold activity mail until they end (B.1); coalescing continues meanwhile.
  if (definition.class === "activity") {
    const quietEnd = quietHoursEnd(readEmailPrefs(input.userId), notBefore);
    if (quietEnd !== null) notBefore = Math.max(notBefore, quietEnd);
  }
  const id = crypto.randomUUID();
  const createdAt = new Date(nowMs).toISOString();
  db.query(`INSERT INTO mail_outbox (id, user_id, to_hash, template, class, category, coalesce_key, payload, idempotency_key, not_before, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.userId, recipientHash(user.email), input.template, definition.class, "category" in definition ? definition.category ?? null : null, input.coalesceKey ?? null,
      JSON.stringify(input.payload), id, new Date(notBefore).toISOString(), createdAt);
  return id;
}

/**
 * Records a mail that was sent synchronously (an invite, D254) in the outbox, for the Email log. The
 * address and payload are never kept: the row holds the recipient hash and the outcome only.
 */
export function logSentMail(input: { template: TemplateName; to: string; outcome: { sent: true; id: string } | { sent: false; reason: string; code?: string }; nowMs?: number }) {
  const id = crypto.randomUUID();
  const at = new Date(input.nowMs ?? Date.now()).toISOString();
  const definition = TEMPLATES[input.template];
  const sent = input.outcome.sent;
  const error = input.outcome.sent ? null : (input.outcome.code ?? input.outcome.reason).slice(0, 40);
  db.query(`INSERT INTO mail_outbox (id, user_id, to_hash, template, class, payload, idempotency_key, status, attempts, not_before, provider_id, error_code, created_at, sent_at)
    VALUES (?, NULL, ?, ?, ?, '{}', ?, ?, 1, ?, ?, ?, ?, ?)`)
    .run(id, recipientHash(input.to), input.template, definition.class, id, sent ? "sent" : "failed", at, input.outcome.sent ? input.outcome.id.slice(0, 64) : null, error, at, sent ? at : null);
  return id;
}
