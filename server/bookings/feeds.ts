import { hkdfSync } from "node:crypto";
import { audit, db, now } from "../db";
import { config } from "../config";
import { logger } from "../log";
import { openSecret, sealSecret } from "../agents/secrets";
import { egressFetch, EgressError, readEgressText, checkEgressUrl } from "../agents/egress";
import { workspaceKey } from "../public/secret";
import { cancelSchedules, upsertSchedule } from "../schedules/service";
import { icsBusy, ICS_MAX_BYTES, type BusyInterval } from "./icsParse";
import { zonedToUtc } from "../../shared/calendarRecurrence";

const slog = logger("bookings");

/**
 * Outside busy feeds (§G.1 Q1, D1008–D1010, T584–T586): each host adds private ICS addresses (Google's
 * "Secret address in iCal format", Outlook's published ICS). The URL is a credential:
 *
 * - Sealed at rest (AES-256-GCM through server/agents/secrets.ts' envelope) under a key derived with
 *   HKDF from AGENT_SECRETS_KEY when it is set, else from the workspace key (DATA_DIR) (D1009). Reads
 *   return only a hint (`calendar.google.com/…a1B2`); nothing returns, logs, or audits the URL.
 * - Fetched only through the egress guard (https, no private addresses unless allowlisted, no
 *   redirects, 2 MiB, 10 s), on a schedule (`bookings.feed_refresh`, every 30 minutes) and on demand
 *   before slots are offered when the cache is older than FEED_FRESH_MS (D1010).
 * - The cache keeps busy intervals only (no titles) for the next 400 days.
 */

export const MAX_FEEDS_PER_USER = 5;
export const FEED_FRESH_MS = 5 * 60_000;
export const FEED_REFRESH_MINUTES = 30;
const FEED_WINDOW_DAYS = 400;
const CAPS = { maxBytes: ICS_MAX_BYTES, firstByteMs: 8_000, idleMs: 8_000, totalMs: 10_000 };

let derived: Buffer | null = null;
function feedKey(): Buffer {
  if (derived) return derived;
  const base = config.agents.key ?? workspaceKey();
  derived = Buffer.from(hkdfSync("sha256", base, Buffer.from("nook-bookings"), Buffer.from("ics-feed-urls"), 32));
  return derived;
}

export class FeedError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string, readonly code: string) { super(message); }
}

export type FeedSummary = { id: string; label: string; hint: string; lastFetchedAt: string | null; status: "new" | "ok" | "error"; error: string | null; busyCount: number };
type FeedRow = { id: string; user_id: string; label: string; url_ct: string; url_hint: string; busy_json: string; last_fetched_at: string | null; last_status: "new" | "ok" | "error"; last_error: string | null };

const summary = (row: FeedRow): FeedSummary => ({
  id: row.id, label: row.label, hint: row.url_hint, lastFetchedAt: row.last_fetched_at, status: row.last_status, error: row.last_error,
  busyCount: (JSON.parse(row.busy_json) as unknown[]).length
});

/** A hint that never reveals the secret path: the host and the last four characters. */
export function urlHint(url: URL) {
  const tail = url.toString().replace(/\/+$/, "").slice(-4);
  return `${url.host}/…${tail}`.slice(0, 120);
}

export function listFeeds(userId: string): FeedSummary[] {
  return (db.query("SELECT * FROM booking_feeds WHERE user_id = ? ORDER BY created_at").all(userId) as FeedRow[]).map(summary);
}

/** Checks the URL's shape (the egress guard runs again on every fetch). webcal:// is read as https://. */
export function feedUrl(value: string): URL {
  const text = value.trim().replace(/^webcals?:\/\//i, "https://");
  if (text.length > 2048) throw new FeedError(400, "That address is too long", "INVALID");
  try {
    return checkEgressUrl(text);
  } catch (error) {
    throw new FeedError(400, error instanceof EgressError ? error.message.replace("endpoint", "calendar address") : "Enter the calendar's secret ICS address", "INVALID");
  }
}

export function addFeed(userId: string, input: { label: string; url: string }): FeedSummary {
  const url = feedUrl(input.url);
  const count = (db.query("SELECT COUNT(*) AS count FROM booking_feeds WHERE user_id = ?").get(userId) as { count: number }).count;
  if (count >= MAX_FEEDS_PER_USER) throw new FeedError(409, `At most ${MAX_FEEDS_PER_USER} outside calendars`, "LIMIT_REACHED");
  const id = Bun.randomUUIDv7();
  const label = input.label.trim().slice(0, 80) || url.host;
  db.transaction(() => {
    db.query("INSERT INTO booking_feeds (id, user_id, label, url_ct, url_hint, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, userId, label, sealSecret("server", id, url.toString(), feedKey()), urlHint(url), now());
    upsertSchedule({ kind: "booking_feed", id }, "bookings.feed_refresh", { everyMinutes: FEED_REFRESH_MINUTES }, {}, { userId });
    audit(userId, null, "bookings.feed_add", { feedId: id });
  })();
  return summary(db.query("SELECT * FROM booking_feeds WHERE id = ?").get(id) as FeedRow);
}

export function removeFeed(userId: string, feedId: string) {
  const removed = db.transaction(() => {
    // RETURNING, not `.changes`: bun:sqlite's `.changes` also counts the rows the delete cascades to
    // (the feed's busy intervals), so a feed that had been fetched read as "not found" (404).
    const removed = db.query("DELETE FROM booking_feeds WHERE id = ? AND user_id = ? RETURNING id").all(feedId, userId).length;
    if (removed) {
      cancelSchedules({ kind: "booking_feed", id: feedId });
      audit(userId, null, "bookings.feed_remove", { feedId });
    }
    return removed === 1;
  })();
  if (!removed) throw new FeedError(404, "Calendar not found", "NOT_FOUND");
}

const inFlight = new Map<string, Promise<void>>();

/** Fetches one feed now and stores its busy intervals (or the error). Never throws. */
export function refreshFeed(feedId: string, nowMs = Date.now()): Promise<void> {
  const running = inFlight.get(feedId);
  if (running) return running;
  const job = (async () => {
    const row = db.query("SELECT * FROM booking_feeds WHERE id = ?").get(feedId) as FeedRow | null;
    if (!row) return;
    const tz = (db.query("SELECT tz FROM booking_profiles WHERE user_id = ?").get(row.user_id) as { tz: string } | null)?.tz ?? "UTC";
    let status: "ok" | "error" = "ok";
    let error: string | null = null;
    let busy: BusyInterval[] | null = null;
    try {
      const url = openSecret("server", row.id, row.url_ct, feedKey());
      const response = await egressFetch(url, { method: "GET", headers: { Accept: "text/calendar, text/plain;q=0.5" } }, CAPS);
      if (response.status !== 200) {
        response.cancel();
        throw new EgressError("NETWORK", `The calendar answered ${response.status}`);
      }
      const text = await readEgressText(response, CAPS.maxBytes);
      if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2048))) throw new EgressError("NETWORK", "That address did not return a calendar");
      busy = icsBusy(text, nowMs - 86_400_000, nowMs + FEED_WINDOW_DAYS * 86_400_000, tz).intervals;
    } catch (caught) {
      status = "error";
      error = caught instanceof EgressError ? caught.message.replace(/endpoint/g, "calendar") : "The calendar could not be read";
      slog.warn(`Busy feed refresh failed: feed=${row.id.slice(0, 8)} code=${caught instanceof EgressError ? caught.code : "other"}`);
    }
    const timestamp = new Date(nowMs).toISOString();
    if (busy) db.query("UPDATE booking_feeds SET busy_json = ?, last_fetched_at = ?, last_status = 'ok', last_error = NULL WHERE id = ?").run(JSON.stringify(busy.map((item) => item.allDay && item.dates ? [item.start, item.end, 1, item.dates[0], item.dates[1]] : [item.start, item.end, item.allDay ? 1 : 0])), timestamp, row.id);
    else db.query("UPDATE booking_feeds SET last_fetched_at = ?, last_status = ?, last_error = ? WHERE id = ?").run(timestamp, status, error!.slice(0, 200), row.id);
  })().finally(() => inFlight.delete(feedId));
  inFlight.set(feedId, job);
  return job;
}

/** Refreshes the users' feeds whose cache is older than FEED_FRESH_MS (on demand before slots, D1010); waits at most `waitMs`. */
export async function refreshStaleFeeds(userIds: readonly string[], nowMs = Date.now(), waitMs = 4000) {
  if (!userIds.length) return;
  const rows = db.query(`SELECT id, last_fetched_at FROM booking_feeds WHERE user_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(userIds)) as Array<{ id: string; last_fetched_at: string | null }>;
  const stale = rows.filter((row) => !row.last_fetched_at || nowMs - Date.parse(row.last_fetched_at) > FEED_FRESH_MS);
  if (!stale.length) return;
  const all = Promise.all(stale.map((row) => refreshFeed(row.id, nowMs)));
  await Promise.race([all, new Promise((resolve) => setTimeout(resolve, waitMs))]);
}

/**
 * Cached outside busy time of a user overlapping [fromMs, toMs); all-day blocks only when asked. An
 * all-day block covers its dates in `tz` (the schedule's zone, as the host's Nook calendars' all-day
 * events do, audit 2 D1128); a block cached before dates were kept stays as it was stored.
 */
export function feedBusy(userId: string, fromMs: number, toMs: number, includeAllDay: boolean, tz?: string): BusyInterval[] {
  const out: BusyInterval[] = [];
  for (const row of db.query("SELECT busy_json FROM booking_feeds WHERE user_id = ?").all(userId) as Array<{ busy_json: string }>) {
    for (const entry of JSON.parse(row.busy_json) as Array<[number, number, number, string?, string?]>) {
      let [start, end] = entry;
      const allDay = entry[2] === 1;
      if (allDay && !includeAllDay) continue;
      if (allDay && tz && entry[3] && entry[4]) {
        try { [start, end] = [zonedToUtc(`${entry[3]}T00:00`, tz), zonedToUtc(`${entry[4]}T00:00`, tz)]; } catch { /* the stored instants stay */ }
      }
      if (end <= fromMs || start >= toMs) continue;
      out.push({ start, end, allDay });
    }
  }
  return out;
}

/** Test hook: forget the derived key (a test that swaps the workspace key). */
export const resetFeedKeyForTests = () => { derived = null; };
