import { db } from "../db";
import { isValidTimeZone, utcToZoned, zonedToUtc } from "../calendar/recurrence";
import { listUpcoming } from "../calendar/service";
import { readableBoardPredicate } from "../tasks/access";
import { dueAt as dueAtOf } from "../tasks/dueTime";
import { mailEnabled } from "../mail";
import { enqueueMail } from "./outbox";
import { readEmailPrefs, type EmailPrefs } from "./prefs";
import { sharedItem, type Recipient, type Resolution } from "./resolve";
import type { SharedKind } from "./templates/activity";
import type { DigestCard, DigestEvent, DigestShared } from "./templates/digest";

/**
 * The digest (docs/plan/research/2026-09-28-outbound-email.md §A.2 #28, §B.1, D241, D248): off by
 * default; daily, or weekly on Mondays, at the person's local time in their stored zone.
 *
 * - `nextDigestAt` is the first local HH:MM (a Monday, for weekly) after an instant, converted with
 *   the zone's offset on that day: a time in a spring-forward gap moves forward by the gap, and in
 *   a fall-back overlap the earlier instant wins, so each local day gets exactly one digest.
 * - The mail tick queues a `digest.summary` row for everyone due and moves `next_digest_at` on in
 *   the same transaction, so a restart never sends two. A digest missed while the server was down
 *   goes out once, late, and the schedule resumes from now.
 * - The content is read at send time as the recipient (T226): their own cards overdue or due soon
 *   (not done, on boards they can read), their next events, proposals awaiting them (key names and
 *   counts only, T233), and what was newly shared with them by name since the last digest (the
 *   share log, re-checked). An empty digest is skipped, never sent (D241).
 */

const DAY = 86_400_000;
export const DIGEST_BATCH = 50;
/** Cards due within this many days count as due soon (daily: today and tomorrow; weekly: the week). */
export const DUE_SOON_DAYS = { daily: 1, weekly: 7 } as const;
export const UPCOMING_EVENT_DAYS = 7;
export const DIGEST_LIST_MAX = 20;

function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
const weekday = (date: string) => new Date(`${date}T00:00:00.000Z`).getUTCDay();

/** The first digest instant strictly after `afterMs` for these preferences, or null when off. */
export function nextDigestAt(prefs: Pick<EmailPrefs, "digest" | "digestLocalTime" | "tz">, afterMs: number): number | null {
  if (prefs.digest === "off") return null;
  const tz = isValidTimeZone(prefs.tz) ? prefs.tz : "UTC";
  let date = utcToZoned(afterMs, tz).slice(0, 10);
  // Two weeks of days always holds a match (a Monday, and a day whose local time is still ahead).
  for (let step = 0; step < 15; step += 1, date = addDays(date, 1)) {
    if (prefs.digest === "weekly" && weekday(date) !== 1) continue;
    const at = zonedToUtc(`${date}T${prefs.digestLocalTime}`, tz);
    if (at > afterMs) return at;
  }
  return null;
}

/** The digest time moved out of quiet hours to their end (B.1: the server clamps it). */
export function clampDigestTime(time: string, quietStart: string | null, quietEnd: string | null) {
  if (!quietStart || !quietEnd) return time;
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  const at = minutes(time);
  const start = minutes(quietStart);
  const end = minutes(quietEnd);
  const inside = start < end ? at >= start && at < end : at >= start || at < end;
  return inside ? quietEnd : time;
}

/** Recomputes `next_digest_at` after a preferences change (or clears it when the digest is off). */
export function refreshDigestSchedule(userId: string, nowMs = Date.now()) {
  const prefs = readEmailPrefs(userId);
  const next = nextDigestAt(prefs, nowMs);
  db.query("UPDATE email_prefs SET next_digest_at = ? WHERE user_id = ?").run(next === null ? null : new Date(next).toISOString(), userId);
  return next;
}

/** A new explicit share, for the next digest's "Shared with you" (ids only; kept 30 days). */
export function logShare(userId: string, kind: SharedKind, itemId: string, actorId: string | null, nowMs = Date.now()) {
  if (!mailEnabled()) return;
  db.query("INSERT INTO mail_share_log (id, user_id, kind, item_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), userId, kind, itemId, actorId, new Date(nowMs).toISOString());
}

/**
 * From the mail tick: queues a digest for everyone whose time has come and moves their schedule
 * on. Blocked and unverified accounts only move on (the dispatcher would skip them anyway).
 */
export function scheduleDigests(nowMs = Date.now()) {
  if (!mailEnabled()) return 0;
  const due = db.query(`SELECT p.user_id, p.next_digest_at, p.last_digest_at, u.disabled_at, u.email_verified_at FROM email_prefs p JOIN users u ON u.id = p.user_id
      WHERE p.digest <> 'off' AND p.next_digest_at IS NOT NULL AND p.next_digest_at <= ? ORDER BY p.next_digest_at LIMIT ?`)
    .all(new Date(nowMs).toISOString(), DIGEST_BATCH) as Array<{ user_id: string; next_digest_at: string; last_digest_at: string | null; disabled_at: string | null; email_verified_at: string | null }>;
  let queued = 0;
  for (const row of due) {
    db.transaction(() => {
      const prefs = readEmailPrefs(row.user_id);
      const next = nextDigestAt(prefs, nowMs);
      const moved = db.query("UPDATE email_prefs SET next_digest_at = ?, last_digest_at = ? WHERE user_id = ? AND next_digest_at = ?")
        .run(next === null ? null : new Date(next).toISOString(), new Date(nowMs).toISOString(), row.user_id, row.next_digest_at).changes;
      if (moved !== 1 || row.disabled_at !== null || row.email_verified_at === null) return;
      const periodMs = (prefs.digest === "weekly" ? 7 : 1) * DAY;
      // "Shared with you" covers the time since the last digest, at most two periods back.
      const since = Math.max(row.last_digest_at ? Date.parse(row.last_digest_at) : nowMs - periodMs, nowMs - 2 * periodMs);
      if (enqueueMail({ userId: row.user_id, template: "digest.summary", payload: { period: prefs.digest, since: new Date(since).toISOString(), scheduledFor: row.next_digest_at }, coalesceKey: `digest.summary:${row.user_id}`, nowMs })) queued += 1;
    })();
  }
  return queued;
}

type CardRow = { cardId: string; boardId: string; boardName: string; title: string; dueOn: string; dueTime: string | null; dueTz: string | null };

/** The digest's content for `recipient` at `nowMs` (§D.6: read now, as them). */
export function resolveDigest(payload: Record<string, unknown>, recipient: Recipient, nowMs: number): Resolution {
  const prefs = readEmailPrefs(recipient.id);
  const period = payload.period === "weekly" ? "weekly" : "daily";
  const tz = prefs.tz;
  const today = utcToZoned(nowMs, tz).slice(0, 10);
  const horizon = addDays(today, DUE_SOON_DAYS[period]);

  // Own cards (assigned to the recipient), live, not done, on readable boards, overdue or due soon.
  const cardRows = db.query(`SELECT k.id AS cardId, b.id AS boardId, b.name AS boardName, k.title, k.due_on AS dueOn, k.due_time AS dueTime, k.due_tz AS dueTz
      FROM cards k JOIN boards b ON b.id = k.board_id JOIN board_columns col ON col.id = k.column_id
      WHERE k.deleted_at IS NULL AND col.is_done = 0 AND k.due_on IS NOT NULL AND k.due_on <= $horizon AND ${readableBoardPredicate}
        AND EXISTS (SELECT 1 FROM card_assignees ca WHERE ca.card_id = k.id AND ca.user_id = $userId)
      ORDER BY k.due_on, k.due_time IS NULL, k.due_time, k.id LIMIT $limit`).all({ userId: recipient.id, horizon, limit: DIGEST_LIST_MAX + 1 }) as CardRow[];
  const cards: DigestCard[] = cardRows.slice(0, DIGEST_LIST_MAX).map((row) => {
    const dueAt = dueAtOf({ due_on: row.dueOn, due_time: row.dueTime, due_tz: row.dueTz });
    return { boardId: row.boardId, cardId: row.cardId, title: row.title, boardName: row.boardName, dueOn: row.dueOn, dueAt, overdue: dueAt !== null ? nowMs > Date.parse(dueAt) : row.dueOn < today };
  });
  const cardsTotal = cardRows.length > DIGEST_LIST_MAX
    ? (db.query(`SELECT COUNT(*) AS count FROM cards k JOIN boards b ON b.id = k.board_id JOIN board_columns col ON col.id = k.column_id
        WHERE k.deleted_at IS NULL AND col.is_done = 0 AND k.due_on IS NOT NULL AND k.due_on <= $horizon AND ${readableBoardPredicate}
          AND EXISTS (SELECT 1 FROM card_assignees ca WHERE ca.card_id = k.id AND ca.user_id = $userId)`).get({ userId: recipient.id, horizon }) as { count: number }).count
    : cards.length;

  // Upcoming events on readable calendars, the next 7 local days.
  const upcoming = listUpcoming(recipient.id, tz, UPCOMING_EVENT_DAYS, nowMs);
  const events: DigestEvent[] = upcoming.items.map((item) => ({ eventId: item.eventId, title: item.title, allDay: item.allDay, start: item.start, date: item.date }));

  // Proposals awaiting: key names and counts only (T233).
  const keys = db.query(`SELECT key_name AS name, COUNT(*) AS count FROM proposals WHERE owner_id = ? AND status = 'pending'
      GROUP BY COALESCE(key_id, key_name) ORDER BY count DESC, key_name LIMIT 20`).all(recipient.id) as Array<{ name: string; count: number }>;
  const proposals = keys.length ? { keys, total: keys.reduce((sum, key) => sum + key.count, 0) } : null;

  // Newly shared by name since the last digest, still readable now.
  const since = typeof payload.since === "string" ? payload.since : new Date(nowMs - DAY).toISOString();
  const logged = db.query(`SELECT l.kind, l.item_id, u.display_name AS actor FROM mail_share_log l LEFT JOIN users u ON u.id = l.actor_id
      WHERE l.user_id = ? AND l.created_at > ? ORDER BY l.created_at DESC LIMIT 200`).all(recipient.id, since) as Array<{ kind: SharedKind; item_id: string; actor: string | null }>;
  const seen = new Set<string>();
  const shared: DigestShared[] = [];
  for (const row of logged) {
    const key = `${row.kind}:${row.item_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = sharedItem(row.kind, row.item_id, recipient.id);
    if (item) shared.push({ ...item, actor: row.actor });
  }

  // D241: never an empty digest.
  if (!cards.length && !events.length && !proposals && !shared.length) return { skip: "empty" };
  return {
    data: {
      period, date: today, cards, cardsTotal, events, eventsMore: upcoming.more, proposals,
      shared: shared.slice(0, DIGEST_LIST_MAX), sharedTotal: shared.length
    }
  };
}
