import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { buildCalendar, escapeText, eventLines, foldLine, MAX_FEED_EVENTS } = await import("../server/calendar/ics");
const { FEED_ADDRESS_CAP, FEED_FAILURES_PER_MINUTE, FEED_HOURLY_LIMIT, feedFailureLimited, feedLimiterSizes, findFeed, isFeedRequest, resetFeedLimits } = await import("../server/calendar/feeds");
type IcsEvent = import("../server/calendar/ics").IcsEvent;

beforeEach(() => resetFeedLimits());

const send = (session: Session, method: string, path: string, body?: unknown) =>
  request(path, { method, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) }, session);

async function body<T = Record<string, any>>(response: Response) {
  return (await response.json()) as T;
}

async function newCalendar(session: Session, name = "Family") {
  const response = await send(session, "POST", "/calendars", { name, color: "green" });
  expect(response.status).toBe(201);
  return (await body<{ calendar: { id: string } }>(response)).calendar.id;
}

async function share(owner: Session, calendarId: string, shareRole: "viewer" | "editor", users: Session[]) {
  expect((await send(owner, "PUT", `/calendars/${calendarId}/sharing`, { visibility: users.length ? "selected" : "private", shareRole, userIds: users.map((user) => user.userId) })).status).toBe(200);
}

async function newEvent(session: Session, calendarId: string, overrides: Record<string, unknown> = {}) {
  const response = await send(session, "POST", `/calendars/${calendarId}/events`, { title: "Dentist", allDay: false, startLocal: "2026-05-04T09:00", tz: "Europe/Berlin", durationMinutes: 60, ...overrides });
  expect(response.status).toBe(201);
  return (await body<{ event: { id: string; revision: number } }>(response)).event;
}

async function createFeed(session: Session, calendarId: string, detail: "busy" | "full" = "full") {
  const response = await send(session, "POST", `/calendars/${calendarId}/feeds`, { detail });
  expect(response.status).toBe(201);
  return body<{ feed: { id: string; prefix: string; detail: string }; token: string; url: string }>(response);
}

/** Fetches a feed with no session cookie and no Origin, as a phone calendar would. */
const fetchFeed = (calendarId: string, token: string, method = "GET") => fetch(`${origin}/api/calendars/${calendarId}/feed.ics?token=${encodeURIComponent(token)}`, { method });

async function expectUniform404(response: Response) {
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ error: "Not found" });
}

/** Unfolds and splits ICS text into content lines. */
const icsLines = (text: string) => text.replace(/\r\n /g, "").split("\r\n").filter(Boolean);

const baseEvent = (overrides: Partial<IcsEvent> = {}): IcsEvent => ({
  id: "3f2a9c1e-1111-4222-8333-444455556666", title: "Dentist", description: "", location: "", all_day: 0,
  start_date: null, end_date: null, start_local: "2026-05-04T09:00", tz: "Europe/Berlin", duration_minutes: 60,
  rrule_json: null, exdates_json: "[]", created_at: "2026-05-01T10:00:00.000Z", updated_at: "2026-05-02T11:30:00.000Z", ...overrides
});

describe("ICS output", () => {
  test("escapes TEXT and neutralises CR and LF so a value cannot start a property", () => {
    expect(escapeText("a\\b;c,d")).toBe("a\\\\b\\;c\\,d");
    expect(escapeText("one\r\ntwo\rthree\nfour")).toBe("one\\ntwo\\nthree\\nfour");
    expect(escapeText("bell\u0007tab\tnul\u0000")).toBe("belltab\tnul");
    const lines = eventLines(baseEvent({ title: "Party\r\nATTENDEE:mailto:evil@example.test", location: "Room\nORGANIZER:x", description: "Line 1\r\nEND:VEVENT\r\nBEGIN:VEVENT" }), "full");
    expect(lines.some((line) => line.startsWith("ATTENDEE") || line.startsWith("ORGANIZER"))).toBe(false);
    expect(lines.filter((line) => line === "END:VEVENT").length).toBe(1);
    expect(lines).toContain("SUMMARY:Party\\nATTENDEE:mailto:evil@example.test");
    const text = buildCalendar("Home", [baseEvent({ title: "x\r\nATTENDEE:mailto:evil@example.test" })], "full");
    expect(text.split("\r\n").some((line) => line.startsWith("ATTENDEE"))).toBe(false);
    // No bare CR or LF anywhere: every line ends in CRLF.
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  test("folds at 75 octets without splitting UTF-8 sequences", () => {
    const long = `SUMMARY:${"é".repeat(100)}${"a".repeat(80)}`;
    const folded = foldLine(long);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const [index, part] of parts.entries()) {
      expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(75);
      if (index > 0) expect(part.startsWith(" ")).toBe(true);
      // Each physical line is valid UTF-8 on its own.
      expect(Buffer.from(part, "utf8").toString("utf8")).toBe(part);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(long);
    expect(foldLine("SHORT:line")).toBe("SHORT:line");
    const text = buildCalendar("Home", [baseEvent({ description: "word ".repeat(200) })], "full");
    for (const line of text.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
  });

  test("timed and all-day events, RRULE, EXDATE, and UID", () => {
    const timed = eventLines(baseEvent({ rrule_json: JSON.stringify({ freq: "weekly", interval: 2, byDay: ["MO", "WE"], until: "2026-06-30" }), exdates_json: JSON.stringify(["2026-05-06"]) }), "full");
    expect(timed).toContain("UID:3f2a9c1e-1111-4222-8333-444455556666@nook");
    expect(timed).toContain("DTSTART;TZID=Europe/Berlin:20260504T090000");
    expect(timed).toContain("DURATION:PT60M");
    // UNTIL is UTC with a TZID start: 23:59:59 in Berlin (CEST, +2) on the until day.
    expect(timed).toContain("RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=MO;BYDAY=MO,WE;UNTIL=20260630T215959Z");
    expect(timed).toContain("EXDATE;TZID=Europe/Berlin:20260506T090000");
    expect(timed).toContain("DTSTAMP:20260502T113000Z");
    const allDay = eventLines(baseEvent({ all_day: 1, start_local: null, tz: null, duration_minutes: null, start_date: "2026-12-24", end_date: "2026-12-27", rrule_json: JSON.stringify({ freq: "yearly", interval: 1, count: 5 }), exdates_json: JSON.stringify(["2027-12-24"]) }), "full");
    expect(allDay).toContain("DTSTART;VALUE=DATE:20261224");
    expect(allDay).toContain("DTEND;VALUE=DATE:20261227");
    expect(allDay).toContain("RRULE:FREQ=YEARLY;INTERVAL=1;COUNT=5");
    expect(allDay).toContain("EXDATE;VALUE=DATE:20271224");
    const untilAllDay = eventLines(baseEvent({ all_day: 1, start_local: null, tz: null, duration_minutes: null, start_date: "2026-01-31", end_date: "2026-02-01", rrule_json: JSON.stringify({ freq: "monthly", interval: 1, until: "2026-12-31" }) }), "full");
    expect(untilAllDay).toContain("RRULE:FREQ=MONTHLY;INTERVAL=1;UNTIL=20261231");
  });

  test("busy sends only times and 'Busy'; the calendar is capped at 5000 events", () => {
    const busy = eventLines(baseEvent({ title: "Therapy", location: "Clinic", description: "Private" }), "busy");
    expect(busy).toContain("SUMMARY:Busy");
    expect(busy.join("\n")).not.toMatch(/Therapy|Clinic|Private|LOCATION|DESCRIPTION/);
    expect(buildCalendar("Secret name", [], "busy")).not.toContain("Secret name");
    const many = Array.from({ length: MAX_FEED_EVENTS + 3 }, (_, index) => baseEvent({ id: `id-${index}` }));
    expect(buildCalendar("Home", many, "busy").match(/BEGIN:VEVENT/g)!.length).toBe(MAX_FEED_EVENTS);
  });

  test("only GET or HEAD of the exact feed path skips the session", () => {
    const path = "/api/calendars/3f2a9c1e-1111-4222-8333-444455556666/feed.ics";
    expect(isFeedRequest("GET", path)).toBe(true);
    expect(isFeedRequest("HEAD", path)).toBe(true);
    expect(isFeedRequest("POST", path)).toBe(false);
    expect(isFeedRequest("GET", `${path}/x`)).toBe(false);
    expect(isFeedRequest("GET", "/api/calendars/3f2a9c1e-1111-4222-8333-444455556666/feeds")).toBe(false);
    expect(isFeedRequest("GET", "/api/calendars/../events/feed.ics")).toBe(false);
    expect(isFeedRequest("GET", "/api/calendars/not-a-uuid/feed.ics")).toBe(false);
  });
});

describe("calendar feeds API", () => {
  test("links made in the same millisecond list newest first, whatever their random ids", async () => {
    const owner = await createUser("Feed tie owner");
    const calendarId = await newCalendar(owner);
    const createdAt = new Date().toISOString();
    // The newer link gets the larger id, so the old ascending-id tie-break would list it last.
    const insert = db.query("INSERT INTO calendar_feeds (id, calendar_id, user_id, token_hash, token_prefix, detail, created_at) VALUES (?, ?, ?, ?, 'nookfeed_tie', 'busy', ?)");
    insert.run("00000000-0000-4000-8000-000000000000", calendarId, owner.userId, "a".repeat(64), createdAt);
    insert.run("ffffffff-0000-4000-8000-000000000000", calendarId, owner.userId, "b".repeat(64), createdAt);
    const listed = await body<{ feeds: Array<{ id: string }> }>(await send(owner, "GET", `/calendars/${calendarId}/feeds`));
    expect(listed.feeds.map((feed) => feed.id)).toEqual(["ffffffff-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000000"]);
  });

  test("readers create, list, and revoke their own links; strangers get 404; the cap is five", async () => {
    const owner = await createUser("Feed owner");
    const viewer = await createUser("Feed viewer");
    const editor = await createUser("Feed editor");
    const stranger = await createUser("Feed stranger");
    const calendarId = await newCalendar(owner);
    await share(owner, calendarId, "viewer", [viewer, editor]);

    const mine = await createFeed(owner, calendarId, "busy");
    expect(mine.token).toMatch(/^nookfeed_[A-Za-z0-9_-]{43}$/);
    expect(mine.url).toBe(`${origin}/api/calendars/${calendarId}/feed.ics?token=${mine.token}`);
    expect(mine.feed.prefix).toBe(mine.token.slice(0, 13));
    const theirs = await createFeed(viewer, calendarId, "full");
    await createFeed(editor, calendarId);

    // Stored only as a hash.
    const stored = db.query("SELECT token_hash, token_prefix FROM calendar_feeds WHERE id = ?").get(mine.feed.id) as { token_hash: string; token_prefix: string };
    expect(stored.token_hash).toBe(new Bun.CryptoHasher("sha256").update(mine.token).digest("hex"));
    expect(JSON.stringify(db.query("SELECT * FROM calendar_feeds").all())).not.toContain(mine.token);

    // Lists show only the caller's own links, never the token.
    const listed = await body<{ feeds: Array<{ id: string }> }>(await send(owner, "GET", `/calendars/${calendarId}/feeds`));
    expect(listed.feeds.map((feed) => feed.id)).toEqual([mine.feed.id]);
    expect(JSON.stringify(listed)).not.toContain(mine.token);
    expect((await body<{ feeds: Array<{ id: string }> }>(await send(viewer, "GET", `/calendars/${calendarId}/feeds`))).feeds.map((feed) => feed.id)).toEqual([theirs.feed.id]);

    // Strangers: 404 on list and create. Bad detail: 400.
    expect((await send(stranger, "GET", `/calendars/${calendarId}/feeds`)).status).toBe(404);
    expect((await send(stranger, "POST", `/calendars/${calendarId}/feeds`, { detail: "busy" })).status).toBe(404);
    expect((await send(owner, "POST", `/calendars/${calendarId}/feeds`, { detail: "everything" })).status).toBe(400);

    // IDOR: nobody revokes someone else's link.
    expect((await send(owner, "DELETE", `/feeds/${theirs.feed.id}`)).status).toBe(404);
    expect((await send(stranger, "DELETE", `/feeds/${mine.feed.id}`)).status).toBe(404);
    expect((await fetchFeed(calendarId, theirs.token)).status).toBe(200);

    // Five live links per user per calendar; revoking frees a slot.
    for (let index = 1; index < 5; index += 1) await createFeed(owner, calendarId);
    const over = await send(owner, "POST", `/calendars/${calendarId}/feeds`, { detail: "busy" });
    expect(over.status).toBe(409);
    expect((await body(over)).code).toBe("LIMIT_REACHED");
    expect((await send(owner, "DELETE", `/feeds/${mine.feed.id}`)).status).toBe(200);
    expect((await send(owner, "DELETE", `/feeds/${mine.feed.id}`)).status).toBe(404);
    await createFeed(owner, calendarId);

    // Audit rows hold ids only.
    const audits = db.query("SELECT event_type, metadata_json FROM audit_log WHERE event_type LIKE 'calendar.feed_%' AND actor_id = ?").all(owner.userId) as Array<{ event_type: string; metadata_json: string }>;
    expect(audits.some((row) => row.event_type === "calendar.feed_revoked")).toBe(true);
    for (const row of audits) expect(Object.keys(JSON.parse(row.metadata_json)).sort()).toEqual(["calendarId", "feedId"]);
  });

  test("the feed is served without a session, with calendar headers, and full shows details", async () => {
    const owner = await createUser("Feed serve");
    const calendarId = await newCalendar(owner, "Serve");
    await newEvent(owner, calendarId, { title: "Party, with; friends", location: "Home", description: "Bring\ncake" });
    const { token } = await createFeed(owner, calendarId, "full");
    const response = await fetchFeed(calendarId, token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("set-cookie")).toBeNull();
    const text = await response.text();
    const lines = icsLines(text);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("SUMMARY:Party\\, with\\; friends");
    expect(lines).toContain("LOCATION:Home");
    expect(lines).toContain("DESCRIPTION:Bring\\ncake");
    expect(lines).toContain("X-WR-CALNAME:Serve");
    expect((await fetchFeed(calendarId, token, "HEAD")).status).toBe(200);
    // Other methods on the feed path still need a session.
    expect((await fetch(`${origin}/api/calendars/${calendarId}/feed.ics?token=${token}`, { method: "POST" })).status).toBe(401);
  });

  test("busy feeds hide titles, places, descriptions, and the calendar name", async () => {
    const owner = await createUser("Feed busy");
    const calendarId = await newCalendar(owner, "Therapy calendar");
    await newEvent(owner, calendarId, { title: "Therapy session", location: "Clinic", description: "Notes" });
    const { token } = await createFeed(owner, calendarId, "busy");
    const text = await (await fetchFeed(calendarId, token)).text();
    expect(text).toContain("SUMMARY:Busy");
    expect(text).not.toMatch(/Therapy|Clinic|Notes/);
  });

  test("every failure is the same 404: bad, revoked, other calendar, binned, lost access, disabled", async () => {
    const owner = await createUser("Feed 404 owner");
    const member = await createUser("Feed 404 member");
    const calendarId = await newCalendar(owner, "Shared");
    const otherId = await newCalendar(owner, "Other");
    await share(owner, calendarId, "viewer", [member]);
    await newEvent(owner, calendarId);
    const ownerFeed = await createFeed(owner, calendarId);
    const memberFeed = await createFeed(member, calendarId);
    expect((await fetchFeed(calendarId, memberFeed.token)).status).toBe(200);

    await expectUniform404(await fetch(`${origin}/api/calendars/${calendarId}/feed.ics`));
    await expectUniform404(await fetchFeed(calendarId, "nookfeed_short"));
    await expectUniform404(await fetchFeed(calendarId, `nookfeed_${"A".repeat(43)}`));
    // A path that is not a feed path at all stays behind the session middleware.
    expect((await fetchFeed("not-a-uuid", ownerFeed.token)).status).toBe(401);
    // A token only opens its own calendar.
    await expectUniform404(await fetchFeed(otherId, ownerFeed.token));

    // The creator loses access: the member is unshared.
    await share(owner, calendarId, "viewer", []);
    await expectUniform404(await fetchFeed(calendarId, memberFeed.token));
    expect((await fetchFeed(calendarId, ownerFeed.token)).status).toBe(200);

    // Revoked.
    const revokedFeed = await createFeed(owner, calendarId);
    expect((await send(owner, "DELETE", `/feeds/${revokedFeed.feed.id}`)).status).toBe(200);
    await expectUniform404(await fetchFeed(calendarId, revokedFeed.token));

    // Binned calendar, then restored.
    expect((await send(owner, "DELETE", `/calendars/${calendarId}`)).status).toBe(200);
    await expectUniform404(await fetchFeed(calendarId, ownerFeed.token));
    expect((await send(owner, "POST", `/bin/calendar/${calendarId}/restore`)).status).toBe(200);
    expect((await fetchFeed(calendarId, ownerFeed.token)).status).toBe(200);

    // Disabled creator.
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), owner.userId);
    await expectUniform404(await fetchFeed(calendarId, ownerFeed.token));
  });

  test("60 fetches per hour per token, then 429 with Retry-After; last_used_at is written at most every 10 minutes", async () => {
    const owner = await createUser("Feed limit");
    const calendarId = await newCalendar(owner, "Limited");
    const { token, feed } = await createFeed(owner, calendarId, "busy");
    const other = await createFeed(owner, calendarId, "busy");
    expect(db.query("SELECT last_used_at FROM calendar_feeds WHERE id = ?").get(feed.id)).toEqual({ last_used_at: null });
    for (let index = 0; index < FEED_HOURLY_LIMIT; index += 1) expect((await fetchFeed(calendarId, token)).status).toBe(200);
    const limited = await fetchFeed(calendarId, token);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another token has its own budget.
    expect((await fetchFeed(calendarId, other.token)).status).toBe(200);

    const first = (db.query("SELECT last_used_at FROM calendar_feeds WHERE id = ?").get(feed.id) as { last_used_at: string }).last_used_at;
    expect(first).toBeTruthy();
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();
    db.query("UPDATE calendar_feeds SET last_used_at = ? WHERE id = ?").run(stale, feed.id);
    resetFeedLimits();
    await fetchFeed(calendarId, token);
    expect(db.query("SELECT last_used_at FROM calendar_feeds WHERE id = ?").get(feed.id)).toEqual({ last_used_at: stale });
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    db.query("UPDATE calendar_feeds SET last_used_at = ? WHERE id = ?").run(old, feed.id);
    await fetchFeed(calendarId, token);
    expect((db.query("SELECT last_used_at FROM calendar_feeds WHERE id = ?").get(feed.id) as { last_used_at: string }).last_used_at > old).toBe(true);
  });

  test("unknown tokens are limited per client address, never tracked per token, and live tokens keep working", async () => {
    const owner = await createUser("Feed flood");
    const calendarId = await newCalendar(owner, "Flooded");
    const { token } = await createFeed(owner, calendarId, "busy");
    const random = () => `nookfeed_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    for (let index = 0; index < FEED_FAILURES_PER_MINUTE; index += 1) expect((await fetchFeed(calendarId, random())).status).toBe(404);
    const limited = await fetchFeed(calendarId, random());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await fetchFeed(calendarId, "nookfeed_short")).status).toBe(429);
    expect((await fetchFeed(calendarId, token)).status).toBe(200);
    expect(feedLimiterSizes()).toEqual({ feeds: 1, addresses: 1 });

    // A flood of random tokens from many addresses holds bounded memory and stays fast.
    resetFeedLimits();
    for (let index = 0; index < 200; index += 1) expect(findFeed(calendarId, random())).toBeNull();
    // The limiter itself (the part that once scanned its whole map) stays well under a millisecond per request.
    const started = performance.now();
    for (let index = 0; index < 5000; index += 1) feedFailureLimited(`10.0.${index >> 8}.${index & 255}`);
    expect(performance.now() - started).toBeLessThan(50);
    expect(feedLimiterSizes()).toEqual({ feeds: 0, addresses: FEED_ADDRESS_CAP });
  });

  test("the token never reaches the logs or the audit log", async () => {
    const owner = await createUser("Feed logs");
    const calendarId = await newCalendar(owner, "Logged");
    const captured: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((method) => console[method]);
    for (const method of methods) console[method] = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
    let token = "";
    try {
      const created = await createFeed(owner, calendarId);
      token = created.token;
      await fetchFeed(calendarId, token);
      await fetchFeed(calendarId, `${token.slice(0, -1)}x`);
      await send(owner, "DELETE", `/feeds/${created.feed.id}`);
      await fetchFeed(calendarId, token);
    } finally {
      methods.forEach((method, index) => { console[method] = originals[index]!; });
    }
    expect(captured.join("\n")).not.toContain(token.slice(9));
    const audit = JSON.stringify(db.query("SELECT * FROM audit_log").all());
    expect(audit).not.toContain(token);
    expect(audit).not.toContain(token.slice(0, 13));
  });

  test("with TOTP required, a token created from a gated session still works without a session", () => {
    const probe = Bun.spawnSync(["bun", "--no-env-file", join(import.meta.dir, "support", "feedTotpProbe.ts")], { stdout: "pipe", stderr: "pipe" });
    const output = probe.stdout.toString().trim().split("\n").at(-1) ?? "";
    expect(probe.exitCode).toBe(0);
    expect(JSON.parse(output)).toEqual({ ungatedCreate: 403, gatedCreate: 201, feed: 200, feedType: "text/calendar; charset=utf-8", noSessionList: 401 });
  });
});
