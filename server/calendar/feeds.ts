import { createHash, randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { clientAddress } from "../clientAddress";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { config, isEmailAllowed, isOriginAllowed } from "../config";
import { audit, db, now } from "../db";
import { parseJson, uuid } from "../validation";
import { readableCalendar } from "./access";
import { buildCalendar, MAX_FEED_EVENTS, type FeedDetail, type IcsEvent } from "./ics";

/**
 * Revocable read-only iCalendar feeds (docs/plan/WAVES_10-12.md D66, §4.3, T64, T65, T70).
 *
 * A reader of a calendar mints up to five tokens for it, each `busy` or `full`. The token is
 * returned once and stored only as a SHA-256 hash with a short display prefix. The feed route
 * is the only `/api` path outside the session and TOTP middleware (`isFeedRequest`, an exact
 * pattern), and every fetch re-checks that the token's creator can still read the calendar.
 * Any failure is the same 404. Tokens are never logged or audited: audit rows carry ids only.
 */

export const MAX_FEEDS_PER_USER_CALENDAR = 5;
export const FEED_HOURLY_LIMIT = 60;
export const FEED_TOUCH_INTERVAL_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;
const TOKEN_PREFIX = "nookfeed_";

const feedPath = /^\/api\/calendars\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/feed\.ics$/;
const tokenPattern = /^nookfeed_[A-Za-z0-9_-]{43}$/;

/** The one request that skips requireAuth and the TOTP gate: GET or HEAD of a feed path, nothing else. */
export const isFeedRequest = (method: string, path: string) => (method === "GET" || method === "HEAD") && feedPath.test(path);

export const hashFeedToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class FeedError extends Error {
  constructor(public status: 404 | 409, message: string, public code?: string) {
    super(message);
  }
}

type FeedRow = { id: string; calendar_id: string; user_id: string; token_prefix: string; detail: FeedDetail; created_at: string; last_used_at: string | null };
export type FeedSummary = { id: string; calendarId: string; prefix: string; detail: FeedDetail; createdAt: string; lastUsedAt: string | null };

const summary = (row: FeedRow): FeedSummary => ({ id: row.id, calendarId: row.calendar_id, prefix: row.token_prefix, detail: row.detail, createdAt: row.created_at, lastUsedAt: row.last_used_at });

function readable(calendarId: string, userId: string) {
  const calendar = readableCalendar(calendarId, userId);
  if (!calendar) throw new FeedError(404, "Calendar not found");
  return calendar;
}

/**
 * The caller's live tokens for one calendar they can read (never anyone else's), newest first.
 * Links made in the same millisecond share `created_at`; rowid (insertion order) breaks the tie.
 */
export function listFeeds(userId: string, calendarId: string) {
  readable(calendarId, userId);
  const rows = db.query(`SELECT id, calendar_id, user_id, token_prefix, detail, created_at, last_used_at FROM calendar_feeds
      WHERE calendar_id = ? AND user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC`).all(calendarId, userId) as FeedRow[];
  return { feeds: rows.map(summary) };
}

/** The URL a subscriber fetches: on the origin the request came from when it is one of ours. */
export function feedUrl(calendarId: string, token: string, requestOrigin?: string | null) {
  const base = requestOrigin && isOriginAllowed(requestOrigin) ? requestOrigin : config.appOrigin;
  return `${base}/api/calendars/${calendarId}/feed.ics?token=${token}`;
}

export function createFeed(userId: string, calendarId: string, detail: FeedDetail, requestOrigin?: string | null) {
  readable(calendarId, userId);
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = crypto.randomUUID();
  const createdAt = now();
  db.transaction(() => {
    const count = (db.query("SELECT COUNT(*) AS count FROM calendar_feeds WHERE calendar_id = ? AND user_id = ? AND revoked_at IS NULL").get(calendarId, userId) as { count: number }).count;
    if (count >= MAX_FEEDS_PER_USER_CALENDAR) throw new FeedError(409, `You can have at most ${MAX_FEEDS_PER_USER_CALENDAR} feed links for one calendar. Revoke one first.`, "LIMIT_REACHED");
    db.query("INSERT INTO calendar_feeds (id, calendar_id, user_id, token_hash, token_prefix, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, calendarId, userId, hashFeedToken(token), token.slice(0, TOKEN_PREFIX.length + 4), detail, createdAt);
    audit(userId, null, "calendar.feed_created", { feedId: id, calendarId });
  })();
  const row = db.query("SELECT id, calendar_id, user_id, token_prefix, detail, created_at, last_used_at FROM calendar_feeds WHERE id = ?").get(id) as FeedRow;
  return { feed: summary(row), token, url: feedUrl(calendarId, token, requestOrigin) };
}

/** Revokes one of the caller's own tokens. Someone else's token, or an unknown one, is 404. */
export function revokeFeed(userId: string, feedId: string) {
  const row = db.query("SELECT calendar_id FROM calendar_feeds WHERE id = ? AND user_id = ? AND revoked_at IS NULL").get(feedId, userId) as { calendar_id: string } | null;
  if (!row) throw new FeedError(404, "Feed not found");
  db.query("UPDATE calendar_feeds SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(now(), feedId, userId);
  audit(userId, null, "calendar.feed_revoked", { feedId, calendarId: row.calendar_id });
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Feed fetches

type Window = { count: number; resetAt: number };

/**
 * Two bounded limiters. A live token has 60 fetches per hour, keyed by its feed id, so only tokens
 * that exist ever get an entry. A request whose token is unknown, revoked, or otherwise fails counts
 * against its client address (30 per minute); past that, failures from that address answer 429
 * instead of 404 while live tokens keep working (behind a local proxy every client shares one
 * address, and an attacker must not lock subscribers out). Both maps are capped and evict their
 * least recently used entry, so a flood of random tokens or addresses holds a fixed amount of memory.
 */
export const FEED_FAILURES_PER_MINUTE = 30;
export const FEED_WINDOW_CAP = 10_000;
export const FEED_ADDRESS_CAP = 1_000;
const MINUTE_MS = 60_000;
const feedWindows = new Map<string, Window>();
const addressWindows = new Map<string, Window>();

/** A fixed window from `map`, moved to the most recent end and evicting the oldest past `cap`. */
function touchWindow(map: Map<string, Window>, key: string, length: number, cap: number, time: number) {
  let window = map.get(key);
  if (window) map.delete(key);
  if (!window || window.resetAt <= time) window = { count: 0, resetAt: time + length };
  map.set(key, window);
  if (map.size > cap) map.delete(map.keys().next().value!);
  return window;
}

const retryAfterSeconds = (window: Window, time: number) => Math.max(1, Math.ceil((window.resetAt - time) / 1000));

/** 60 fetches per hour per live feed. Returns seconds to wait, or 0. */
export function feedRateLimited(feedId: string, time = Date.now()) {
  const window = touchWindow(feedWindows, feedId, HOUR_MS, FEED_WINDOW_CAP, time);
  if (window.count >= FEED_HOURLY_LIMIT) return retryAfterSeconds(window, time);
  window.count += 1;
  return 0;
}

/** Counts a failed fetch from `address`. Returns seconds to wait once it is over its budget, or 0. */
export function feedFailureLimited(address: string, time = Date.now()) {
  const window = touchWindow(addressWindows, address, MINUTE_MS, FEED_ADDRESS_CAP, time);
  window.count += 1;
  return window.count > FEED_FAILURES_PER_MINUTE ? retryAfterSeconds(window, time) : 0;
}

/** Test hooks. */
export function resetFeedLimits() {
  feedWindows.clear();
  addressWindows.clear();
}
export const feedLimiterSizes = () => ({ feeds: feedWindows.size, addresses: addressWindows.size });

type LiveFeed = { id: string; calendar_id: string; user_id: string; detail: FeedDetail; last_used_at: string | null; email: string };

/**
 * The live feed for a token, or null for a malformed, unknown, or revoked token, another calendar's
 * token, or a disabled or no-longer-allowed creator. renderFeed's null covers a binned calendar or a
 * creator who can no longer read it. The caller answers every null with the same 404.
 */
export function findFeed(calendarId: string, token: string) {
  if (!tokenPattern.test(token)) return null;
  const feed = db.query(`SELECT f.id, f.calendar_id, f.user_id, f.detail, f.last_used_at, u.email FROM calendar_feeds f JOIN users u ON u.id = f.user_id
      WHERE f.token_hash = ? AND f.revoked_at IS NULL AND u.disabled_at IS NULL`).get(hashFeedToken(token)) as LiveFeed | null;
  if (!feed || feed.calendar_id !== calendarId.toLowerCase() || !isEmailAllowed(feed.email)) return null;
  return feed;
}

/** The calendar text for a live feed from findFeed, or null when its creator can no longer read the calendar. */
export function renderFeed(feed: LiveFeed, nowMs = Date.now()) {
  // Live access: the creator must still be able to read the calendar (T64).
  const calendar = readableCalendar(feed.calendar_id, feed.user_id);
  if (!calendar) return null;
  if (!feed.last_used_at || nowMs - Date.parse(feed.last_used_at) >= FEED_TOUCH_INTERVAL_MS) {
    db.query("UPDATE calendar_feeds SET last_used_at = ? WHERE id = ?").run(new Date(nowMs).toISOString(), feed.id);
  }
  // The most recent series first, so the cap drops the oldest finished events.
  const events = db.query(`SELECT id, title, description, location, all_day, start_date, end_date, start_local, tz, duration_minutes,
        rrule_json, exdates_json, created_at, updated_at
      FROM events WHERE calendar_id = ? AND deleted_at IS NULL
      ORDER BY COALESCE(series_end_utc, '9999') DESC, start_utc DESC, id LIMIT ?`).all(feed.calendar_id, MAX_FEED_EVENTS) as IcsEvent[];
  return buildCalendar(calendar.name, events, feed.detail);
}

// ---------------------------------------------------------------------------
// Routes

const feedCreateSchema = z.object({ detail: z.enum(["busy", "full"]) }).strict();

function respond(c: Context<AppEnv>, operation: () => unknown, status: 200 | 201 = 200) {
  try {
    return c.json(operation() as Record<string, unknown>, status);
  } catch (error) {
    if (error instanceof FeedError) return c.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    throw error;
  }
}

const notFound = () => new Response(JSON.stringify({ error: "Not found" }), {
  status: 404,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});

const tooMany = (retryAfter: number) => new Response(JSON.stringify({ error: "Too many requests for this feed" }), {
  status: 429,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": String(retryAfter) }
});

/** The socket's peer address (never a forwarded header, which any client can set). */


/** docs/plan/API_CONTRACTS.md § Calendar feeds. */
export function registerFeedRoutes(app: Hono<AppEnv>) {
  // Token-authenticated; isFeedRequest keeps it outside requireAuth and the TOTP gate.
  app.get("/api/calendars/:calendarId/feed.ics", (c) => {
    const calendarId = c.req.param("calendarId");
    const token = c.req.query("token") ?? "";
    const failed = () => {
      const retryAfter = feedFailureLimited(clientAddress(c));
      return retryAfter ? tooMany(retryAfter) : notFound();
    };
    const feed = uuid.safeParse(calendarId).success ? findFeed(calendarId, token) : null;
    if (!feed) return failed();
    const retryAfter = feedRateLimited(feed.id);
    if (retryAfter) return tooMany(retryAfter);
    const body = renderFeed(feed);
    if (body === null) return failed();
    c.header("Cache-Control", "private, no-store");
    c.header("Content-Type", "text/calendar; charset=utf-8");
    c.header("Content-Disposition", "inline; filename=\"calendar.ics\"");
    return c.body(body, 200);
  });

  app.get("/api/calendars/:calendarId/feeds", (c) => {
    const calendarId = uuid.parse(c.req.param("calendarId")).toLowerCase();
    return respond(c, () => listFeeds(c.get("user").id, calendarId));
  });

  app.post("/api/calendars/:calendarId/feeds", async (c) => {
    const calendarId = uuid.parse(c.req.param("calendarId")).toLowerCase();
    const body = await parseJson(c.req.raw, feedCreateSchema);
    return respond(c, () => createFeed(c.get("user").id, calendarId, body.detail, c.req.header("Origin")), 201);
  });

  app.delete("/api/feeds/:feedId", (c) => {
    const feedId = uuid.parse(c.req.param("feedId")).toLowerCase();
    return respond(c, () => revokeFeed(c.get("user").id, feedId));
  });
}
