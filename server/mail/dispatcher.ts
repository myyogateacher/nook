import { config } from "../config";
import { db } from "../db";
import { mailEnabled, sendMail } from "../mail";
import { suppressionOf, sweepSoftBounces } from "./suppression";
import { appLink, paths } from "./links";
import { prefsAllow, quietHoursEnd, readEmailPrefs } from "./prefs";
import { isTemplateName, renderTemplate, TEMPLATES, type TemplateName } from "./registry";
import { resolvePayload, type Recipient } from "./resolve";
import type { MailCategory, MailClass } from "./templates/types";
import { createUnsubscribeToken } from "./unsubscribe";
import { scheduleBinExpiry } from "./laterMail";
import { scheduleDigests } from "./digest";

/**
 * The mail dispatcher (docs/plan/research/2026-09-28-outbound-email.md §D.1–D.3), on the reminders
 * pattern: a 30 s unref'd timer, one tick at a time. Each due row is claimed (`sending`), re-checked
 * against the recipient's state at send time (blocked, unverified, suppressed, preferences, quiet
 * hours, stale), held when a durable cap is full, resolved and rendered, and sent with the row's
 * stable idempotency key. Failures retry with backoff and end as `dead`.
 */

export const MAIL_TICK_MS = 30_000;
export const MAIL_BATCH = 50;
/** Durable caps (§D.2), counted from the outbox so a restart cannot reset them. */
export const MAIL_CAPS = { activityHour: 12, activityDay: 60, securityHour: 10, instanceReserve: 0.1 } as const;
export const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000] as const;
export const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length;
/** Activity older than this at send time is noise after an outage (D.3). */
export const STALE_AFTER_MS = 24 * 3_600_000;
/** Security mail sent this late says "(delayed)". */
export const SECURITY_DELAYED_AFTER_MS = 3_600_000;
/** A `sending` claim older than this is left from a crash and goes back to `queued` on boot. */
export const CLAIM_TIMEOUT_MS = 2 * 60_000;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

type Row = {
  id: string; user_id: string | null; template: string; class: MailClass; category: MailCategory | null; payload: string;
  idempotency_key: string; attempts: number; not_before: string; created_at: string;
};
type UserState = { id: string; email: string; display_name: string; role: string; disabled_at: string | null; email_verified_at: string | null };

export type TickCounts = { sent: number; skipped: number; held: number; retried: number; dead: number; suppressed: number };

let random = Math.random;
/** Test hook: a fixed jitter source. */
export function setMailJitterForTests(source: (() => number) | null) {
  random = source ?? Math.random;
}

/** Terminal states drop the payload (dead rows keep their ids for an admin Retry) and the address (§B.3). */
function finish(id: string, status: "sent" | "skipped" | "suppressed" | "dead", extra: { skipReason?: string; providerId?: string; errorCode?: string; nowMs: number; attempt?: boolean }) {
  db.query(`UPDATE mail_outbox SET status = ?, skip_reason = ?, provider_id = COALESCE(?, provider_id), error_code = COALESCE(?, error_code),
      sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END, attempts = attempts + ?, payload = CASE WHEN ? = 'dead' THEN payload ELSE '{}' END, to_address = NULL, claimed_at = NULL WHERE id = ?`)
    .run(status, extra.skipReason ?? null, extra.providerId ?? null, extra.errorCode ?? null, status, iso(extra.nowMs), extra.attempt ? 1 : 0, status, id);
}

function requeue(id: string, notBeforeMs: number, extra: { attempt?: boolean; errorCode?: string | null } = {}) {
  db.query("UPDATE mail_outbox SET status = 'queued', claimed_at = NULL, not_before = ?, attempts = attempts + ?, error_code = COALESCE(?, error_code) WHERE id = ?")
    .run(iso(notBeforeMs), extra.attempt ? 1 : 0, extra.errorCode ?? null, id);
}

const countSent = (sql: string, ...params: Array<string | number>) => (db.query(sql).get(...params) as { count: number; oldest: string | null });

/** When a full cap frees a slot, or null when there is room (§D.2). */
function capHold(row: Row, nowMs: number): number | null {
  const instance = countSent("SELECT COUNT(*) AS count, MIN(sent_at) AS oldest FROM mail_outbox WHERE status = 'sent' AND sent_at > ?", iso(nowMs - DAY));
  const limit = config.mail.dailyLimit;
  const privileged = row.class === "security" || row.class === "account";
  // Security and account mail keep 10% of the instance's day for themselves.
  const ceiling = privileged ? limit : Math.floor(limit * (1 - MAIL_CAPS.instanceReserve));
  if (instance.count >= ceiling && instance.oldest) return Date.parse(instance.oldest) + DAY;
  if (row.user_id === null) return null;
  if (row.class === "security") {
    const hour = countSent("SELECT COUNT(*) AS count, MIN(sent_at) AS oldest FROM mail_outbox WHERE user_id = ? AND class = 'security' AND status = 'sent' AND sent_at > ?", row.user_id, iso(nowMs - HOUR));
    return hour.count >= MAIL_CAPS.securityHour && hour.oldest ? Date.parse(hour.oldest) + HOUR : null;
  }
  if (row.class === "account") return null;
  const sql = "SELECT COUNT(*) AS count, MIN(sent_at) AS oldest FROM mail_outbox WHERE user_id = ? AND class IN ('activity','reminders','digest') AND status = 'sent' AND sent_at > ?";
  const hour = countSent(sql, row.user_id, iso(nowMs - HOUR));
  if (hour.count >= MAIL_CAPS.activityHour && hour.oldest) return Date.parse(hour.oldest) + HOUR;
  const day = countSent(sql, row.user_id, iso(nowMs - DAY));
  if (day.count >= MAIL_CAPS.activityDay && day.oldest) return Date.parse(day.oldest) + DAY;
  return null;
}

const backoff = (attempt: number) => {
  const base = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]!;
  return Math.round(base * (0.8 + random() * 0.4));
};

/** Handles one claimed row. Returns what happened, for the tick's counts. */
async function handle(row: Row, nowMs: number): Promise<keyof TickCounts> {
  if (!isTemplateName(row.template) || row.template === "team.invite" || row.user_id === null) {
    finish(row.id, "dead", { errorCode: "unknown_template", nowMs });
    return "dead";
  }
  const template: TemplateName = row.template;
  const user = db.query("SELECT id, email, display_name, role, disabled_at, email_verified_at FROM users WHERE id = ? AND kind = 'person'").get(row.user_id) as UserState | null;
  // An integration (D287) is never mailed: the outbox refuses it, and a row that got in anyway is dropped here.
  if (!user) {
    finish(row.id, "skipped", { skipReason: "no_user", nowMs });
    return "skipped";
  }
  const security = row.class === "security";
  // T230: a blocked account gets its security mail (blocked, unblocked, signed out) and nothing else.
  if (user.disabled_at !== null && !security) return skip(row, "blocked", nowMs);
  // A bounced or complaining address gets security mail only (§B.4); a soft bounce holds it back for a while.
  const suppression = security ? null : suppressionOf(user.email, nowMs);
  if (suppression) {
    finish(row.id, "suppressed", { skipReason: suppression.reason === "soft" ? "soft_bounce" : "suppressed", nowMs });
    return "suppressed";
  }
  // D244/D245: unverified addresses get only the verification mail and security mail.
  if (user.email_verified_at === null && !security && template !== "account.verify") return skip(row, "unverified", nowMs);
  const prefs = readEmailPrefs(user.id);
  if (!prefsAllow(prefs, row.class, row.category)) return skip(row, "prefs_off", nowMs);
  if (row.class === "activity") {
    const quietEnd = quietHoursEnd(prefs, nowMs);
    if (quietEnd !== null) {
      requeue(row.id, quietEnd);
      return "held";
    }
    if (nowMs - Date.parse(row.created_at) > STALE_AFTER_MS) return skip(row, "stale", nowMs);
  }
  const hold = capHold(row, nowMs);
  if (hold !== null) {
    requeue(row.id, Math.max(hold, nowMs + 1000));
    return "held";
  }

  const recipient: Recipient = { id: user.id, email: user.email, displayName: user.display_name, role: user.role, tz: prefs.tz };
  const resolved = resolvePayload(template, JSON.parse(row.payload) as Record<string, unknown>, recipient, nowMs);
  if ("skip" in resolved) return skip(row, resolved.skip, nowMs);
  const data = security && nowMs - Date.parse(row.created_at) > SECURITY_DELAYED_AFTER_MS ? { ...(resolved.data as object), delayed: true } : resolved.data;

  // Activity and reminders mail can be switched off by category from the mail itself (B.2).
  const switchable = (row.class === "activity" || row.class === "reminders") && row.category !== null;
  // The digest's link turns the digest off (B.2).
  const token = switchable ? await createUnsubscribeToken(user.id, row.category!) : row.class === "digest" ? await createUnsubscribeToken(user.id, "digest") : null;
  const rendered = renderTemplate(template, data, {
    instanceName: config.mail.instanceName,
    tz: prefs.tz,
    unsubscribeHref: token ? appLink(paths.unsubscribePage(token)) : undefined
  });
  // RFC 8058 one-click unsubscribe, on activity, reminders, and digest mail (never security or account, B.2).
  const headers = token ? { "List-Unsubscribe": `<${appLink(paths.unsubscribeApi(token))}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined;
  const outcome = await sendMail({ to: user.email, subject: rendered.subject, text: rendered.text, html: rendered.html, headers }, {
    purpose: template,
    senderId: null,
    recipient: "user",
    idempotencyKey: row.idempotency_key
  });
  if (outcome.sent) {
    finish(row.id, "sent", { providerId: outcome.id.slice(0, 64), nowMs, attempt: true });
    return "sent";
  }
  if (outcome.reason === "rate_limited") {
    requeue(row.id, nowMs + 5 * 60_000);
    return "held";
  }
  if (outcome.reason === "not_configured") {
    requeue(row.id, nowMs + 10 * 60_000);
    return "held";
  }
  if (!outcome.retryable || row.attempts + 1 >= MAX_ATTEMPTS) {
    finish(row.id, "dead", { errorCode: outcome.code, nowMs, attempt: true });
    if (!outcome.retryable) console.error(`Mail dead: purpose=${template} error=${outcome.code}`);
    return "dead";
  }
  requeue(row.id, nowMs + backoff(row.attempts), { attempt: true, errorCode: outcome.code });
  return "retried";
}

function skip(row: Row, reason: string, nowMs: number): keyof TickCounts {
  finish(row.id, "skipped", { skipReason: reason, nowMs });
  return "skipped";
}

let ticking = false;

/**
 * One tick at `nowMs` (tests pass a fake clock). Single-flight: a tick that starts while another
 * runs returns null. At most MAIL_BATCH rows per tick.
 */
export async function runMailDispatch(options: { nowMs?: number } = {}): Promise<TickCounts | null> {
  if (ticking || !mailEnabled()) return null;
  ticking = true;
  const counts: TickCounts = { sent: 0, skipped: 0, held: 0, retried: 0, dead: 0, suppressed: 0 };
  try {
    const nowMs = options.nowMs ?? Date.now();
    // Scheduled mail is queued first, so a due digest or Bin reminder goes out in the same tick.
    try {
      scheduleDigests(nowMs);
      scheduleBinExpiry(nowMs);
    } catch (error) {
      console.error(`Mail scheduling failed: error=${error instanceof Error ? error.name : "Unknown"}`);
    }
    const due = db.query("SELECT * FROM mail_outbox WHERE status = 'queued' AND not_before <= ? ORDER BY not_before, created_at LIMIT ?").all(iso(nowMs), MAIL_BATCH) as Row[];
    for (const row of due) {
      const claimed = db.query("UPDATE mail_outbox SET status = 'sending', claimed_at = ? WHERE id = ? AND status = 'queued'").run(iso(nowMs), row.id);
      if (claimed.changes !== 1) continue;
      try {
        counts[await handle(row, nowMs)] += 1;
      } catch (error) {
        // A resolver or renderer bug must not wedge the queue: the row retries, then dies.
        console.error(`Mail row failed: purpose=${row.template} error=${error instanceof Error ? error.name : "Unknown"}`);
        if (row.attempts + 1 >= MAX_ATTEMPTS) finish(row.id, "dead", { errorCode: "internal", nowMs, attempt: true });
        else requeue(row.id, nowMs + backoff(row.attempts), { attempt: true, errorCode: "internal" });
        counts.retried += 1;
      }
    }
  } finally {
    ticking = false;
  }
  if (counts.sent || counts.dead || counts.retried) console.info(`Mail: ${counts.sent} sent, ${counts.skipped} skipped, ${counts.held} held, ${counts.retried} retrying, ${counts.dead} dead`);
  return counts;
}

/** Releases claims left by a crash mid-send (the idempotency key makes the resend safe). */
export function releaseStaleClaims(nowMs = Date.now()) {
  return db.query("UPDATE mail_outbox SET status = 'queued', claimed_at = NULL WHERE status = 'sending' AND (claimed_at IS NULL OR claimed_at < ?)").run(iso(nowMs - CLAIM_TIMEOUT_MS)).changes;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Starts the 30 s dispatcher next to the reminders one. */
export function startMailDispatcher() {
  if (timer) return;
  releaseStaleClaims();
  // The test suite drives ticks itself (runMailDispatch with a fake clock), so no timer races it.
  if (process.env.NODE_ENV === "test") return;
  timer = setInterval(() => {
    runMailDispatch().catch((error) => console.error("Mail dispatch failed", error instanceof Error ? error.name : "Unknown error"));
  }, MAIL_TICK_MS);
  timer.unref();
}

/** Sweeper step (§B.3): delivered history after 30 days, failures after 90; used or expired tokens after 7. */
export function sweepMail(nowMs = Date.now()) {
  const outbox = db.query("DELETE FROM mail_outbox WHERE (status IN ('sent','skipped','suppressed') AND created_at < ?) OR (status IN ('dead','failed') AND created_at < ?)")
    .run(iso(nowMs - 30 * DAY), iso(nowMs - 90 * DAY)).changes;
  const tokens = db.query("DELETE FROM auth_tokens WHERE (used_at IS NOT NULL AND used_at < ?) OR expires_at < ?").run(iso(nowMs - 7 * DAY), iso(nowMs - 7 * DAY)).changes;
  const events = db.query("DELETE FROM mail_webhook_events WHERE received_at < ?").run(iso(nowMs - 7 * DAY)).changes;
  const softBounces = sweepSoftBounces(nowMs);
  const shareLog = db.query("DELETE FROM mail_share_log WHERE created_at < ?").run(iso(nowMs - 30 * DAY)).changes;
  return { outbox, tokens, events, softBounces, shareLog };
}

/** Runs a tick soon after an enqueue the user is waiting for (verify, test). The test suite ticks itself. */
export function kickMailDispatch() {
  if (process.env.NODE_ENV === "test") return;
  setTimeout(() => { runMailDispatch().catch(() => undefined); }, 0);
}
