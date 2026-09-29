import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { EVENT_CREATES_PER_MINUTE, listOccurrences, reconcileEventNextOccurrences, resetEventCreateLimit } from "../server/calendar/service";
import { rangeFor } from "../server/calendar/recurrence";

// Fixture dates sit a few years ahead of the current year (C12), so they never fall into the past.
const Y = new Date().getUTCFullYear() + 5;

const send = (session: Session, method: string, path: string, body?: unknown) =>
  request(path, { method, body: body === undefined ? "{}" : JSON.stringify(body) }, session);

async function newCalendar(session: Session) {
  const response = await send(session, "POST", "/calendars", { name: "Budget", color: "green" });
  expect(response.status).toBe(201);
  return ((await response.json()) as { calendar: { id: string } }).calendar.id;
}

const timed = (overrides: Record<string, unknown> = {}) => ({ title: "Standup", allDay: false, startLocal: "2026-05-04T09:00", tz: "UTC", durationMinutes: 15, ...overrides });
const nextColumns = (eventId: string) => db.query("SELECT next_occurrence_utc, next_occurrence_from FROM events WHERE id = ?").get(eventId) as { next_occurrence_utc: string | null; next_occurrence_from: string | null };

/** Legacy rows the write-time checks now refuse: yearly every 99 years from 1901 (1901, 2000, 2099). */
function insertPathological(calendarId: string, count: number) {
  const insert = db.query(`INSERT INTO events (id, calendar_id, title, all_day, start_date, end_date, start_utc, series_end_utc, rrule_json, created_at, updated_at)
    VALUES (?, ?, 'Rare', 1, '1901-01-01', '1901-01-02', '1901-01-01T00:00:00.000Z', NULL, '{"freq":"yearly","interval":99}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  db.transaction(() => { for (let index = 0; index < count; index += 1) insert.run(crypto.randomUUID(), calendarId); })();
}

describe("range API work budget (T66)", () => {
  test("write-time checks refuse pathological rules", async () => {
    const user = await createUser("Budget rules");
    const calendarId = await newCalendar(user);
    const post = (body: unknown) => send(user, "POST", `/calendars/${calendarId}/events`, body);
    expect((await post(timed({ startLocal: "1901-01-01T09:00", repeat: { freq: "yearly", interval: 99 } }))).status).toBe(400);
    expect((await post(timed({ startLocal: "2101-01-01T09:00", repeat: { freq: "daily", interval: 1 } }))).status).toBe(400);
    expect((await post(timed({ repeat: { freq: "monthly", interval: 99, count: 730 } }))).status).toBe(400);
    expect((await post(timed({ repeat: { freq: "yearly", interval: 1, count: 12 } }))).status).toBe(400);
    expect((await post(timed({ repeat: { freq: "yearly", interval: 1, count: 10 } }))).status).toBe(201);
    // A one-off event may still be in the distant past.
    expect((await post(timed({ startLocal: "1901-01-01T09:00" }))).status).toBe(201);
  });

  test("event creation is limited to 60 a minute per user", async () => {
    resetEventCreateLimit();
    const user = await createUser("Budget rate");
    const calendarId = await newCalendar(user);
    for (let index = 0; index < EVENT_CREATES_PER_MINUTE; index += 1) {
      expect((await send(user, "POST", `/calendars/${calendarId}/events`, timed({ title: `E${index}` }))).status).toBe(201);
    }
    const limited = await send(user, "POST", `/calendars/${calendarId}/events`, timed());
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED" });
    const other = await createUser("Budget rate other");
    expect((await send(other, "POST", `/calendars/${await newCalendar(other)}/events`, timed())).status).toBe(201);
    resetEventCreateLimit();
  });

  test("writes store the next-occurrence bound and timing updates refresh it", async () => {
    resetEventCreateLimit();
    const user = await createUser("Budget bound");
    const calendarId = await newCalendar(user);
    const created = await send(user, "POST", `/calendars/${calendarId}/events`, timed({ startLocal: `${Y - 1}-01-07T09:00`, repeat: { freq: "weekly", interval: 1 } }));
    const event = ((await created.json()) as { event: { id: string; revision: number } }).event;
    expect(nextColumns(event.id).next_occurrence_utc).toBe(`${Y - 1}-01-07T09:00:00.000Z`);
    const patched = await send(user, "PATCH", `/events/${event.id}`, { startLocal: `${Y}-01-06T10:00`, revision: event.revision });
    expect(patched.status).toBe(200);
    expect(nextColumns(event.id).next_occurrence_utc).toBe(`${Y}-01-06T10:00:00.000Z`);
    // A write that bumps the revision without refreshing the bound makes it stale: the row is
    // expanded again, and the boot reconcile recomputes it.
    db.query(`UPDATE events SET start_local = '${Y - 1}-06-03T10:00', start_utc = '${Y - 1}-06-03T10:00:00.000Z', revision = revision + 1 WHERE id = ?`).run(event.id);
    const listed = listOccurrences(user.userId, rangeFor(`${Y - 1}-06-01`, `${Y - 1}-06-08`, "UTC"), [calendarId]);
    expect(listed.occurrences.map((item) => item.date)).toEqual([`${Y - 1}-06-03`]);
    await reconcileEventNextOccurrences();
    expect(nextColumns(event.id).next_occurrence_utc).toBe(`${Y - 1}-06-03T10:00:00.000Z`);
  });

  test("at the 1000-instance cap the soonest occurrences are kept, whatever the series order (L3)", async () => {
    resetEventCreateLimit();
    const user = await createUser("Budget soonest");
    const calendarId = await newCalendar(user);
    for (let index = 0; index < 11; index += 1) {
      const response = await send(user, "POST", `/calendars/${calendarId}/events`, timed({ title: `Daily ${index}`, startLocal: "2026-01-01T08:00", repeat: { freq: "daily", interval: 1 } }));
      expect(response.status).toBe(201);
    }
    // Starts after every daily series, so it comes last in series-start order.
    expect((await send(user, "POST", `/calendars/${calendarId}/events`, timed({ title: "Early bird", startLocal: "2026-01-02T07:00" }))).status).toBe(201);
    const result = listOccurrences(user.userId, rangeFor("2026-01-01", "2026-04-11", "UTC"), [calendarId]);
    expect(result.truncated).toBe(true);
    expect(result.occurrences.length).toBe(1000);
    expect(result.occurrences.some((item) => item.title === "Early bird")).toBe(true);
    const starts = result.occurrences.map((item) => item.start);
    expect(starts).toEqual([...starts].sort());
    // The dropped ones are the latest: 1000 kept of 1101 ends on day 91 (2026-04-01).
    expect(starts.at(-1)!.slice(0, 10)).toBe("2026-04-01");
    resetEventCreateLimit();
  });

  test("20k events without an occurrence in range cost well under 50 ms", async () => {
    resetEventCreateLimit();
    const user = await createUser("Budget timing");
    const calendarId = await newCalendar(user);
    const visible = await send(user, "POST", `/calendars/${calendarId}/events`, timed({ startLocal: "2026-05-04T09:00", repeat: { freq: "weekly", interval: 1 } }));
    expect(visible.status).toBe(201);
    insertPathological(calendarId, 19_999);
    expect(await reconcileEventNextOccurrences()).toBeGreaterThanOrEqual(19_999);
    expect(nextColumns((db.query("SELECT id FROM events WHERE calendar_id = ? AND title = 'Rare' LIMIT 1").get(calendarId) as { id: string }).id).next_occurrence_utc)
      .toBe("2099-01-01T00:00:00.000Z");

    // June of next year: the bounds were computed from now, so the range must lie ahead of it.
    const year = new Date().getUTCFullYear() + 1;
    const range = rangeFor(`${year}-06-01`, `${year}-07-01`, "UTC");
    const mondays = Array.from({ length: 30 }, (_, index) => new Date(Date.UTC(year, 5, index + 1)))
      .filter((day) => day.getUTCDay() === 1).map((day) => day.toISOString().slice(0, 10));
    listOccurrences(user.userId, range, [calendarId]);
    const started = performance.now();
    const result = listOccurrences(user.userId, range, [calendarId]);
    const elapsed = performance.now() - started;
    expect(result.truncated).toBe(false);
    expect(mondays.length).toBeGreaterThanOrEqual(4);
    expect(result.occurrences.map((item) => item.date)).toEqual(mondays);
    expect(elapsed).toBeLessThan(50);

    // A range before the bounds were computed cannot use them; the row budget caps the work.
    const past = listOccurrences(user.userId, rangeFor("2000-01-01", "2000-01-10", "UTC"), [calendarId]);
    expect(past.truncated).toBe(true);
    expect(past.occurrences.length).toBe(1000);
    db.query("DELETE FROM events WHERE calendar_id = ?").run(calendarId);
  }, 30_000);
});
