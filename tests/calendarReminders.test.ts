import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const reminders = await import("../server/calendar/reminders");
const { listUpcoming } = await import("../server/calendar/service");
const { runSweep } = await import("../server/sweeper");

// Everything is scheduled five years ahead of the current year (Y, C12) and dispatched with a fake
// clock, so the server's real 30 s dispatcher (running on today's clock) never touches these rows.
const Y = new Date().getUTCFullYear() + 5;
const at = (value: string) => Date.parse(value);
const MINUTE = 60_000;

async function json<T>(response: Response) {
  return (await response.json()) as T;
}

const send = (session: Session, method: string, path: string, body?: unknown) =>
  request(path, { method, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) }, session);

async function newCalendar(session: Session, name = "Reminders") {
  const response = await send(session, "POST", "/calendars", { name });
  expect(response.status).toBe(201);
  return (await json<{ calendar: { id: string } }>(response)).calendar.id;
}

async function newEvent(session: Session, calendarId: string, body: Record<string, unknown> = {}) {
  const response = await send(session, "POST", `/calendars/${calendarId}/events`, { title: "Checkup", allDay: false, startLocal: `${Y}-03-10T09:00`, tz: "UTC", durationMinutes: 30, ...body });
  expect(response.status).toBe(201);
  return (await json<{ event: { id: string; revision: number } }>(response)).event;
}

async function addReminder(session: Session, body: Record<string, unknown>) {
  return send(session, "POST", "/reminders", { tz: "UTC", ...body });
}

async function reminderId(session: Session, body: Record<string, unknown>) {
  const response = await addReminder(session, body);
  expect(response.status).toBe(201);
  return (await json<{ reminder: { id: string; nextFireAt: string } }>(response)).reminder;
}

const reminderRow = (id: string) => db.query("SELECT next_fire_at, claimed_at, last_fired_at FROM reminders WHERE id = ?").get(id) as { next_fire_at: string | null; claimed_at: string | null; last_fired_at: string | null } | null;
const notificationsFor = (userId: string) => db.query("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at").all(userId) as Array<{ id: string; reminder_id: string; event_id: string | null; late: number; occurrence_start: string | null }>;

async function share(owner: Session, calendarId: string, shareRole: "viewer" | "editor", users: Session[]) {
  expect((await send(owner, "PUT", `/calendars/${calendarId}/sharing`, { visibility: users.length ? "selected" : "private", shareRole, userIds: users.map((user) => user.userId) })).status).toBe(200);
}

describe("reminders API", () => {
  test("validates input, is private to its creator, and refuses unreadable events (IDOR)", async () => {
    const owner = await createUser("Reminder owner");
    const viewer = await createUser("Reminder viewer");
    const stranger = await createUser("Reminder stranger");
    const calendarId = await newCalendar(owner);
    await share(owner, calendarId, "viewer", [viewer]);
    const event = await newEvent(owner, calendarId);

    const mine = await reminderId(owner, { eventId: event.id, offsetMinutes: 15 });
    expect(mine.nextFireAt).toBe(`${Y}-03-10T08:45:00.000Z`);
    // Viewers may set their own reminders on events they can read.
    const theirs = await reminderId(viewer, { eventId: event.id, offsetMinutes: 15 });
    expect((await addReminder(stranger, { eventId: event.id, offsetMinutes: 15 })).status).toBe(404);
    expect((await addReminder(owner, { eventId: crypto.randomUUID(), offsetMinutes: 15 })).status).toBe(404);

    for (const body of [
      { eventId: event.id, offsetMinutes: 40_321 },
      { eventId: event.id, offsetMinutes: -1441 },
      { eventId: event.id, offsetMinutes: 1.5 },
      { eventId: event.id, offsetMinutes: 10, tz: "Mars/Olympus" },
      { eventId: "nope", offsetMinutes: 10 },
      { title: "", fireAt: `${Y}-01-01T09:00` },
      { title: "Call", fireAt: `${Y}-02-30T09:00` },
      { title: "Call", fireAt: "2020-01-01T09:00" },
      { title: "Bad\u0007", fireAt: `${Y}-01-01T09:00` },
      { title: "Both", fireAt: `${Y}-01-01T09:00`, eventId: event.id, offsetMinutes: 5 }
    ]) {
      expect((await addReminder(owner, body)).status).toBe(400);
    }
    const duplicate = await addReminder(owner, { eventId: event.id, offsetMinutes: 15 });
    expect(duplicate.status).toBe(409);
    expect((await json<{ code: string }>(duplicate)).code).toBe("REMINDER_EXISTS");
    // An event in the past with no repeat has nothing left to remind about.
    const past = await newEvent(owner, calendarId, { startLocal: "2020-01-01T09:00" });
    expect((await addReminder(owner, { eventId: past.id, offsetMinutes: 5 })).status).toBe(400);

    const ownerList = await json<{ reminders: Array<{ id: string }> }>(await send(owner, "GET", `/reminders?eventId=${event.id}`));
    expect(ownerList.reminders.map((item) => item.id)).toEqual([mine.id]);
    expect((await json<{ reminders: unknown[] }>(await send(stranger, "GET", "/reminders"))).reminders).toEqual([]);
    expect((await send(owner, "GET", "/reminders?eventId=nope")).status).toBe(400);
    expect((await send(owner, "DELETE", `/reminders/${theirs.id}`)).status).toBe(404);
    expect((await send(viewer, "DELETE", `/reminders/${theirs.id}`)).status).toBe(200);
    expect((await send(viewer, "DELETE", `/reminders/${theirs.id}`)).status).toBe(404);
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'reminder.create' AND actor_id = ?").get(owner.userId) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toEqual({ reminderId: mine.id, eventId: event.id });
  });

  test("caps: 10 per event per user, 500 upcoming standalone per user", async () => {
    const user = await createUser("Reminder caps");
    const calendarId = await newCalendar(user);
    const event = await newEvent(user, calendarId);
    for (let offset = 0; offset < 10; offset += 1) await reminderId(user, { eventId: event.id, offsetMinutes: offset * 5 });
    const over = await addReminder(user, { eventId: event.id, offsetMinutes: 500 });
    expect(over.status).toBe(409);
    expect((await json<{ code: string }>(over)).code).toBe("LIMIT_REACHED");

    const insert = db.query(`INSERT INTO reminders (id, user_id, title, tz, next_fire_at, created_at) VALUES (?, ?, 'Bulk', 'UTC', '${Y}-06-01T00:00:00.000Z', ?)`);
    db.transaction(() => { for (let index = 0; index < 500; index += 1) insert.run(crypto.randomUUID(), user.userId, new Date().toISOString()); })();
    const standalone = await addReminder(user, { title: "One more", fireAt: `${Y}-06-02T09:00` });
    expect(standalone.status).toBe(409);
    expect((await json<{ code: string }>(standalone)).code).toBe("LIMIT_REACHED");
    // Fired ones no longer count.
    db.query("UPDATE reminders SET next_fire_at = NULL WHERE user_id = ? AND title = 'Bulk' AND rowid IN (SELECT rowid FROM reminders WHERE user_id = ? AND title = 'Bulk' LIMIT 1)").run(user.userId, user.userId);
    expect((await addReminder(user, { title: "One more", fireAt: `${Y}-06-02T09:00` })).status).toBe(201);
    db.query("DELETE FROM reminders WHERE user_id = ?").run(user.userId);
  });
});

describe("the dispatcher", () => {
  test("fires exactly once at the due time and advances a repeating event to its next occurrence", async () => {
    const user = await createUser("Dispatch once");
    const calendarId = await newCalendar(user);
    const event = await newEvent(user, calendarId, { title: "Standup", repeat: { freq: "daily", interval: 1 } });
    const reminder = await reminderId(user, { eventId: event.id, offsetMinutes: 15 });

    expect(reminders.runDispatch({ nowMs: at(`${Y}-03-10T08:44:00Z`) })?.notified ?? 0).toBe(0);
    expect(notificationsFor(user.userId)).toEqual([]);
    reminders.runDispatch({ nowMs: at(`${Y}-03-10T08:45:10Z`) });
    reminders.runDispatch({ nowMs: at(`${Y}-03-10T08:45:40Z`) });
    const fired = notificationsFor(user.userId);
    expect(fired.length).toBe(1);
    expect(fired[0]).toMatchObject({ reminder_id: reminder.id, event_id: event.id, late: 0, occurrence_start: `${Y}-03-10T09:00:00.000Z` });
    expect(reminderRow(reminder.id)).toMatchObject({ next_fire_at: `${Y}-03-11T08:45:00.000Z`, claimed_at: null, last_fired_at: `${Y}-03-10T08:45:10.000Z` });

    const listed = await json<{ items: Array<{ id: string; title: string; href: string; late: boolean; read: boolean }>; unreadCount: number }>(await send(user, "GET", "/notifications?unread=1"));
    expect(listed.unreadCount).toBe(1);
    expect(listed.items).toMatchObject([{ id: fired[0]!.id, title: "Standup", href: `/calendar/event/${event.id}`, late: false, read: false }]);
    // Titles are resolved live.
    expect((await send(user, "PATCH", `/events/${event.id}`, { title: "Daily standup", revision: event.revision })).status).toBe(200);
    expect((await json<{ items: Array<{ title: string }> }>(await send(user, "GET", "/notifications"))).items[0]!.title).toBe("Daily standup");
  });

  test("a reminder missed while down fires once, marked late, when under 24 hours late; over 24 hours it is skipped", async () => {
    const user = await createUser("Dispatch late");
    const calendarId = await newCalendar(user);
    const daily = await newEvent(user, calendarId, { title: "Pills", startLocal: `${Y}-04-01T08:00`, repeat: { freq: "daily", interval: 1 } });
    const lateReminder = await reminderId(user, { eventId: daily.id, offsetMinutes: 0 });
    // Down for 3 days minus a bit: the 04-01 occurrence is 70 h late and skipped; nothing piles up.
    const counts = reminders.runDispatch({ nowMs: at(`${Y}-04-04T06:00:00Z`) });
    expect(counts?.skipped).toBeGreaterThanOrEqual(1);
    expect(notificationsFor(user.userId)).toEqual([]);
    // It advanced past now, to the next occurrence that has not started.
    expect(reminderRow(lateReminder.id)?.next_fire_at).toBe(`${Y}-04-04T08:00:00.000Z`);

    // 3 hours late: fires once, marked late, and advances.
    reminders.runDispatch({ nowMs: at(`${Y}-04-04T11:00:00Z`) });
    reminders.runDispatch({ nowMs: at(`${Y}-04-04T11:00:30Z`) });
    const fired = notificationsFor(user.userId);
    expect(fired.length).toBe(1);
    expect(fired[0]!.late).toBe(1);
    expect(reminderRow(lateReminder.id)?.next_fire_at).toBe(`${Y}-04-05T08:00:00.000Z`);
    expect((await json<{ items: Array<{ late: boolean }> }>(await send(user, "GET", "/notifications"))).items[0]!.late).toBe(true);
  });

  test("losing access deletes the reminder at fire time; a binned event goes dormant and wakes on restore", async () => {
    const owner = await createUser("Dispatch access owner");
    const viewer = await createUser("Dispatch access viewer");
    const calendarId = await newCalendar(owner);
    await share(owner, calendarId, "viewer", [viewer]);
    const event = await newEvent(owner, calendarId, { startLocal: `${Y}-05-01T09:00` });
    const viewerReminder = await reminderId(viewer, { eventId: event.id, offsetMinutes: 30 });
    const ownerReminder = await reminderId(owner, { eventId: event.id, offsetMinutes: 30 });
    await share(owner, calendarId, "viewer", []);

    expect((await send(owner, "DELETE", `/events/${event.id}`)).status).toBe(200);
    reminders.runDispatch({ nowMs: at(`${Y}-05-01T08:30:05Z`) });
    expect(reminderRow(viewerReminder.id)).toBeNull();
    expect(notificationsFor(viewer.userId)).toEqual([]);
    expect(reminderRow(ownerReminder.id)?.next_fire_at).toBeNull();
    expect(notificationsFor(owner.userId)).toEqual([]);
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'reminder.removed_access_lost' AND actor_id = ?").get(viewer.userId) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toEqual({ reminderId: viewerReminder.id, eventId: event.id });

    expect((await send(owner, "POST", `/bin/event/${event.id}/restore`)).status).toBe(200);
    expect(reminderRow(ownerReminder.id)?.next_fire_at).toBe(`${Y}-05-01T08:30:00.000Z`);
  });

  test("editing an event reschedules its reminders", async () => {
    const user = await createUser("Dispatch reschedule");
    const calendarId = await newCalendar(user);
    const event = await newEvent(user, calendarId, { startLocal: `${Y}-06-01T09:00` });
    const reminder = await reminderId(user, { eventId: event.id, offsetMinutes: 60 });
    expect((await send(user, "PATCH", `/events/${event.id}`, { startLocal: `${Y}-06-02T14:00`, revision: event.revision })).status).toBe(200);
    expect(reminderRow(reminder.id)?.next_fire_at).toBe(`${Y}-06-02T13:00:00.000Z`);
    // All-day events use the reminder's zone: 09:00 on the day is -540.
    const allDay = await newEvent(user, calendarId, { allDay: true, startLocal: undefined, tz: undefined, durationMinutes: undefined, startDate: `${Y}-06-10`, endDate: `${Y}-06-11` });
    const morning = await reminderId(user, { eventId: allDay.id, offsetMinutes: -540, tz: "Asia/Kolkata" });
    expect(morning.nextFireAt).toBe(`${Y}-06-10T03:30:00.000Z`);
  });

  test("standalone reminders fire with their own title and then stop", async () => {
    const user = await createUser("Dispatch standalone");
    const reminder = await reminderId(user, { title: "Call the plumber", fireAt: `${Y}-07-01T10:00`, tz: "Europe/Berlin" });
    expect(reminder.nextFireAt).toBe(`${Y}-07-01T08:00:00.000Z`);
    reminders.runDispatch({ nowMs: at(`${Y}-07-01T08:00:20Z`) });
    const listed = await json<{ items: Array<{ title: string; href: string }> }>(await send(user, "GET", "/notifications"));
    expect(listed.items).toMatchObject([{ title: "Call the plumber", href: "/notifications" }]);
    expect(reminderRow(reminder.id)?.next_fire_at).toBeNull();
    expect((await json<{ reminders: unknown[] }>(await send(user, "GET", "/reminders"))).reminders).toEqual([]);
  });

  test("at most 60 notifications per user per hour", async () => {
    const user = await createUser("Dispatch hourly");
    const insert = db.query("INSERT INTO notifications (id, user_id, created_at) VALUES (?, ?, ?)");
    for (let index = 0; index < 60; index += 1) insert.run(crypto.randomUUID(), user.userId, new Date(at(`${Y}-08-01T09:30:00Z`) + index * MINUTE / 2).toISOString());
    const reminder = await reminderId(user, { title: "Over the limit", fireAt: `${Y}-08-01T10:00`, tz: "UTC" });
    const counts = reminders.runDispatch({ nowMs: at(`${Y}-08-01T10:00:05Z`) });
    expect(counts?.limited).toBeGreaterThanOrEqual(1);
    expect(notificationsFor(user.userId).length).toBe(60);
    // L1: deferred, not dropped: next_fire_at is kept and the claim released.
    expect(reminderRow(reminder.id)).toMatchObject({ next_fire_at: `${Y}-08-01T10:00:00.000Z`, claimed_at: null, last_fired_at: null });
    const audits = db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = 'reminder.rate_limited'").all(user.userId) as Array<{ metadata_json: string }>;
    expect(audits.map((row) => JSON.parse(row.metadata_json))).toEqual([{ deferred: 1, limit: 60 }]);
    // Still full a tick later: left out of the due query until the oldest notification ages out.
    reminders.runDispatch({ nowMs: at(`${Y}-08-01T10:00:35Z`) });
    expect(notificationsFor(user.userId).length).toBe(60);
    expect(reminderRow(reminder.id)?.next_fire_at).toBe(`${Y}-08-01T10:00:00.000Z`);
    // 09:30 + 1 h: the window has room again, and the reminder fires (late).
    reminders.runDispatch({ nowMs: at(`${Y}-08-01T10:30:05Z`) });
    expect(notificationsFor(user.userId).filter((row) => row.reminder_id === reminder.id)).toMatchObject([{ late: 1 }]);
    expect(reminderRow(reminder.id)?.next_fire_at).toBeNull();
  });
});

describe("notifications API", () => {
  test("lists, filters, and marks only the caller's notifications; hrefs are same-origin id paths", async () => {
    const alice = await createUser("Notify Alice");
    const bob = await createUser("Notify Bob");
    const calendarId = await newCalendar(alice);
    const event = await newEvent(alice, calendarId, { startLocal: `${Y}-09-01T09:00` });
    const insert = db.query("INSERT INTO notifications (id, user_id, event_id, created_at) VALUES (?, ?, ?, ?)");
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    ids.forEach((id, index) => insert.run(id, alice.userId, event.id, new Date(Date.now() - (3 - index) * MINUTE).toISOString()));
    const bobs = crypto.randomUUID();
    insert.run(bobs, bob.userId, event.id, new Date().toISOString());

    // Bob cannot read Alice's calendar, so his row names no title and links nowhere specific.
    const bobList = await json<{ items: Array<{ id: string; title: string; href: string }> }>(await send(bob, "GET", "/notifications"));
    expect(bobList.items).toEqual([expect.objectContaining({ id: bobs, title: "An event you can no longer open", href: "/notifications" })]);

    const list = await json<{ items: Array<{ id: string }>; unreadCount: number }>(await send(alice, "GET", "/notifications?limit=2"));
    expect(list.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect(list.unreadCount).toBe(3);
    for (const query of ["limit=0", "limit=51", "limit=x", "unread=maybe"]) expect((await send(alice, "GET", `/notifications?${query}`)).status).toBe(400);

    const marked = await send(alice, "POST", "/notifications/read", { ids: [ids[0], bobs] });
    expect(await json(marked)).toEqual({ ok: true, updated: 1 });
    expect((db.query("SELECT read_at FROM notifications WHERE id = ?").get(bobs) as { read_at: string | null }).read_at).toBeNull();
    expect((await json<{ items: Array<{ id: string }> }>(await send(alice, "GET", "/notifications?unread=1"))).items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect((await send(alice, "POST", "/notifications/read", { ids: Array.from({ length: 101 }, () => crypto.randomUUID()) })).status).toBe(400);
    expect((await send(alice, "POST", "/notifications/read", { ids: [] })).status).toBe(400);
    expect((await send(alice, "POST", "/notifications/read", { all: false })).status).toBe(400);
    expect(await json(await send(alice, "POST", "/notifications/read", { all: true }))).toEqual({ ok: true, updated: 2 });
    expect((await json<{ unreadCount: number }>(await send(alice, "GET", "/notifications"))).unreadCount).toBe(0);
    expect((await json<{ unreadCount: number }>(await send(bob, "GET", "/notifications"))).unreadCount).toBe(1);

    expect(reminders.notificationHref(event.id)).toBe(`/calendar/event/${event.id}`);
    for (const hostile of ["javascript:alert(1)", "//evil.example", "../../x", `${event.id}/../../evil`, null]) expect(reminders.notificationHref(hostile)).toBe("/notifications");
  });

  test("notifications made in the same millisecond list newest first, whatever their random ids", async () => {
    const user = await createUser("Notify tie");
    const createdAt = new Date().toISOString();
    // The newer row gets the larger id, so the old ascending-id tie-break would list it last.
    const insert = db.query("INSERT INTO notifications (id, user_id, created_at) VALUES (?, ?, ?)");
    insert.run("00000000-0000-4000-8000-000000000000", user.userId, createdAt);
    insert.run("ffffffff-0000-4000-8000-000000000000", user.userId, createdAt);
    const listed = await json<{ items: Array<{ id: string }> }>(await send(user, "GET", "/notifications"));
    expect(listed.items.map((item) => item.id)).toEqual(["ffffffff-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000000"]);
  });

  test("the sweeper deletes notifications older than 30 days", async () => {
    const user = await createUser("Notify sweep");
    const old = crypto.randomUUID();
    const recent = crypto.randomUUID();
    db.query("INSERT INTO notifications (id, user_id, created_at) VALUES (?, ?, ?)").run(old, user.userId, new Date(Date.now() - 31 * 86_400_000).toISOString());
    db.query("INSERT INTO notifications (id, user_id, created_at) VALUES (?, ?, ?)").run(recent, user.userId, new Date().toISOString());
    await runSweep();
    expect(db.query("SELECT 1 FROM notifications WHERE id = ?").get(old)).toBeNull();
    expect(db.query("SELECT 1 FROM notifications WHERE id = ?").get(recent)).toBeTruthy();
  });
});

test("listUpcoming returns the next unfinished occurrences, at most 10 with a more flag", async () => {
  const user = await createUser("Upcoming user");
  const calendarId = await newCalendar(user);
  await newEvent(user, calendarId, { title: "Hourly-ish", startLocal: `${Y}-10-01T08:00`, repeat: { freq: "daily", interval: 1 } });
  await newEvent(user, calendarId, { title: "Finished", startLocal: `${Y}-10-01T06:00` });
  const now = at(`${Y}-10-01T07:00:00Z`);
  const upcoming = listUpcoming(user.userId, "UTC", 14, now);
  expect(upcoming.items.length).toBe(10);
  expect(upcoming.more).toBe(true);
  expect(upcoming.items[0]).toMatchObject({ title: "Hourly-ish", start: `${Y}-10-01T08:00:00.000Z` });
  expect(upcoming.items.some((item) => item.title === "Finished")).toBe(false);
  expect(listUpcoming(user.userId, "UTC", 2, now)).toMatchObject({ more: false });
  expect(() => listUpcoming(user.userId, "Nowhere/City", 7, now)).toThrow();
});
