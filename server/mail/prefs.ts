import { z } from "zod";
import { audit, db, now } from "../db";
import { isValidTimeZone, utcToZoned, zonedToUtc } from "../calendar/recurrence";
import { MAIL_CATEGORIES, type MailCategory } from "./templates/types";
import { clampDigestTime, refreshDigestSchedule } from "./digest";

/**
 * Email preferences (docs/plan/research/2026-09-28-outbound-email.md §B.1, D247, D248). They gate
 * sending only, never access (T97). No row means the defaults (revision 0); the row is created on
 * the first save, with a compare-and-swap on `revision` like user_preferences.
 */

export type EmailPrefs = {
  enabled: boolean;
  categories: Record<MailCategory, boolean>;
  digest: "off" | "daily" | "weekly";
  digestLocalTime: string;
  quietStart: string | null;
  quietEnd: string | null;
  tz: string;
  unsubEpoch: number;
  revision: number;
  updatedAt: string | null;
  /** When the next digest goes (UTC), or null when it is off. */
  nextDigestAt: string | null;
};

export const DEFAULT_CATEGORIES: Record<MailCategory, boolean> = { assignments: true, comments: true, sharing: true, proposals: true, sprints: false, bin: false, reminders: true };

type Row = { enabled: number; categories: string; digest: EmailPrefs["digest"]; digest_local_time: string; quiet_start: string | null; quiet_end: string | null; tz: string; unsub_epoch: number; revision: number; updated_at: string; next_digest_at: string | null };

export function readEmailPrefs(userId: string): EmailPrefs {
  const row = db.query("SELECT * FROM email_prefs WHERE user_id = ?").get(userId) as Row | null;
  if (!row) return { enabled: true, categories: { ...DEFAULT_CATEGORIES }, digest: "off", digestLocalTime: "08:00", quietStart: null, quietEnd: null, tz: "UTC", unsubEpoch: 0, revision: 0, updatedAt: null, nextDigestAt: null };
  let stored: Record<string, unknown> = {};
  try { stored = JSON.parse(row.categories) as Record<string, unknown>; } catch { /* the CHECK keeps it valid JSON */ }
  const categories = Object.fromEntries(MAIL_CATEGORIES.map((category) => [category, typeof stored[category] === "number" || typeof stored[category] === "boolean" ? Boolean(stored[category]) : DEFAULT_CATEGORIES[category]])) as Record<MailCategory, boolean>;
  return {
    enabled: row.enabled === 1,
    categories,
    digest: row.digest,
    digestLocalTime: row.digest_local_time,
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    tz: isValidTimeZone(row.tz) ? row.tz : "UTC",
    unsubEpoch: row.unsub_epoch,
    revision: row.revision,
    updatedAt: row.updated_at,
    nextDigestAt: row.digest === "off" ? null : row.next_digest_at
  };
}

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time such as 07:30");

export const emailPrefsPutSchema = z.object({
  enabled: z.boolean(),
  categories: z.object(Object.fromEntries(MAIL_CATEGORIES.map((category) => [category, z.boolean()])) as Record<MailCategory, z.ZodBoolean>).strict(),
  /** Off (D248 default), daily, or weekly on Mondays, at digestLocalTime in tz. */
  digest: z.enum(["off", "daily", "weekly"]),
  digestLocalTime: clock,
  quietHours: z.object({ start: clock, end: clock }).strict().refine((value) => value.start !== value.end, "Quiet hours need a start and an end that differ").nullable(),
  tz: z.string().min(1).max(64).refine(isValidTimeZone, "Unknown time zone"),
  revision: z.number().int().nonnegative()
}).strict();

export type EmailPrefsInput = z.infer<typeof emailPrefsPutSchema>;
export type EmailPrefsWrite = { ok: true; prefs: EmailPrefs } | { ok: false; current: EmailPrefs };

export function writeEmailPrefs(userId: string, input: EmailPrefsInput, nowMs = Date.now()): EmailPrefsWrite {
  const timestamp = now();
  // B.1: the digest never lands inside quiet hours; the server moves it to their end.
  input = { ...input, digestLocalTime: clampDigestTime(input.digestLocalTime, input.quietHours?.start ?? null, input.quietHours?.end ?? null) };
  const categories = JSON.stringify(Object.fromEntries(MAIL_CATEGORIES.map((category) => [category, input.categories[category] ? 1 : 0])));
  const values = [input.enabled ? 1 : 0, categories, input.digest, input.digestLocalTime, input.quietHours?.start ?? null, input.quietHours?.end ?? null, input.tz, timestamp];
  return db.transaction((): EmailPrefsWrite => {
    const before = db.query("SELECT digest, digest_local_time, tz, next_digest_at FROM email_prefs WHERE user_id = ?").get(userId) as { digest: string; digest_local_time: string; tz: string; next_digest_at: string | null } | null;
    const changes = input.revision === 0
      ? db.query(`INSERT OR IGNORE INTO email_prefs (user_id, enabled, categories, digest, digest_local_time, quiet_start, quiet_end, tz, updated_at, revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(userId, ...values).changes
      : db.query(`UPDATE email_prefs SET enabled = ?, categories = ?, digest = ?, digest_local_time = ?, quiet_start = ?, quiet_end = ?, tz = ?, updated_at = ?,
          revision = revision + 1 WHERE user_id = ? AND revision = ?`).run(...values, userId, input.revision).changes;
    if (changes === 0) return { ok: false, current: readEmailPrefs(userId) };
    // The schedule moves only when the digest itself changed, so saving another switch at 07:59 keeps 08:00.
    const scheduleChanged = !before || before.digest !== input.digest || before.digest_local_time !== input.digestLocalTime || before.tz !== input.tz || (input.digest !== "off" && before.next_digest_at === null);
    if (scheduleChanged) refreshDigestSchedule(userId, nowMs);
    const prefs = readEmailPrefs(userId);
    audit(userId, null, "mail.prefs_update", { enabled: prefs.enabled, categories: prefs.categories, quietHours: prefs.quietStart !== null, digest: prefs.digest, revision: prefs.revision });
    return { ok: true, prefs };
  })();
}

/**
 * Turns one category off from an unsubscribe link (B.2). Creates the row with defaults when there is
 * none. Idempotent; returns whether anything changed.
 */
export function turnCategoryOff(userId: string, category: MailCategory | "digest") {
  const timestamp = now();
  if (category === "digest") return db.transaction(() => {
    const current = readEmailPrefs(userId);
    if (current.digest === "off") return false;
    db.query("UPDATE email_prefs SET digest = 'off', next_digest_at = NULL, updated_at = ?, revision = revision + 1 WHERE user_id = ?").run(timestamp, userId);
    audit(userId, null, "mail.unsubscribed", { category });
    return true;
  })();
  return db.transaction(() => {
    const current = readEmailPrefs(userId);
    if (!current.categories[category]) return false;
    const categories = JSON.stringify(Object.fromEntries(MAIL_CATEGORIES.map((key) => [key, key === category ? 0 : current.categories[key] ? 1 : 0])));
    if (current.revision === 0) db.query("INSERT INTO email_prefs (user_id, categories, updated_at) VALUES (?, ?, ?)").run(userId, categories, timestamp);
    else db.query("UPDATE email_prefs SET categories = ?, updated_at = ?, revision = revision + 1 WHERE user_id = ?").run(categories, timestamp, userId);
    audit(userId, null, "mail.unsubscribed", { category });
    return true;
  })();
}

/** Whether mail of this class and category may go to someone with these preferences (security and account always may). */
export function prefsAllow(prefs: EmailPrefs, mailClass: string, category: MailCategory | null) {
  if (mailClass === "security" || mailClass === "account") return true;
  if (!prefs.enabled) return false;
  // Turned off since it was queued.
  if (mailClass === "digest") return prefs.digest !== "off";
  return category ? prefs.categories[category] : true;
}

const minutesOf = (clockValue: string) => Number(clockValue.slice(0, 2)) * 60 + Number(clockValue.slice(3, 5));

/**
 * When quiet hours are on at `nowMs` in the user's zone, the UTC instant they end; else null. The
 * window may wrap midnight (22:00–07:30). DST is handled by converting the local end time with the
 * zone's offset on that day.
 */
export function quietHoursEnd(prefs: Pick<EmailPrefs, "quietStart" | "quietEnd" | "tz">, nowMs: number): number | null {
  if (!prefs.quietStart || !prefs.quietEnd) return null;
  const local = utcToZoned(nowMs, prefs.tz);
  const minute = minutesOf(local.slice(11, 16));
  const start = minutesOf(prefs.quietStart);
  const end = minutesOf(prefs.quietEnd);
  const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!inside) return null;
  const today = local.slice(0, 10);
  // The end falls today when it is later in the day than now, else tomorrow.
  const endDate = minute < end ? today : nextDate(today);
  return zonedToUtc(`${endDate}T${prefs.quietEnd}`, prefs.tz);
}

function nextDate(date: string) {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}
