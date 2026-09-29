import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const mail = await import("../server/mail");
const { runMailDispatch } = await import("../server/mail/dispatcher");
const { clampDigestTime, nextDigestAt, scheduleDigests } = await import("../server/mail/digest");
const { createUnsubscribeToken } = await import("../server/mail/unsubscribe");
const { readEmailPrefs } = await import("../server/mail/prefs");
const { utcToZoned } = await import("../server/calendar/recurrence");

/**
 * The digest (outbound email §A.2 #28, D241, D248): its schedule in the person's zone across DST
 * changes, the tick that queues it once and moves on, content read at send time as the recipient
 * with deep links, never an empty one, and the one-click link that turns it off.
 */

type Sent = Parameters<import("../server/mail").MailTransport>[0];
let sent: Sent[] = [];
const iso = (ms: number) => new Date(ms).toISOString();
const at = (value: string) => Date.parse(value);
const CATEGORIES = { assignments: true, comments: true, sharing: true, proposals: true, sprints: false, bin: false, reminders: true };

beforeEach(() => {
  sent = [];
  mail.resetMailLimits();
  db.query("DELETE FROM mail_outbox").run();
  mail.setMailTransportForTests(async (message) => { sent.push(message); return { id: `msg_${sent.length}` }; });
});
afterEach(() => mail.setMailTransportForTests(null));
// The suite shares one database: a digest left scheduled would be queued, and sent, by any later
// file's dispatch tick at a fake clock past it.
const people: string[] = [];
afterAll(() => {
  db.query("UPDATE email_prefs SET digest = 'off', next_digest_at = NULL WHERE user_id IN (SELECT value FROM json_each(?))").run(JSON.stringify(people));
});

async function person(label: string) {
  const session = await createUser(label);
  people.push(session.userId);
  db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), session.userId);
  return session;
}
async function call(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}
const saveDigest = (session: Session, digest: "off" | "daily" | "weekly", time: string, tz: string, extra: Record<string, unknown> = {}) =>
  call(session, "PUT", "/mail/settings", { enabled: true, categories: CATEGORIES, digest, digestLocalTime: time, quietHours: null, tz, revision: readEmailPrefs(session.userId).revision, ...extra });

describe("digest schedule (zones and DST)", () => {
  test("daily at a local time, in fixed and DST zones", () => {
    expect(iso(nextDigestAt({ digest: "daily", digestLocalTime: "08:00", tz: "UTC" }, at("2026-09-28T07:59:00Z"))!)).toBe("2026-09-28T08:00:00.000Z");
    expect(iso(nextDigestAt({ digest: "daily", digestLocalTime: "08:00", tz: "UTC" }, at("2026-09-28T08:00:00Z"))!)).toBe("2026-09-29T08:00:00.000Z");
    // Asia/Kolkata is +05:30 all year.
    expect(iso(nextDigestAt({ digest: "daily", digestLocalTime: "08:00", tz: "Asia/Kolkata" }, at("2026-09-28T00:00:00Z"))!)).toBe("2026-09-28T02:30:00.000Z");
    // New York leaves daylight time on 1 Nov 2026: 08:00 is 12:00Z before and 13:00Z after.
    expect(iso(nextDigestAt({ digest: "daily", digestLocalTime: "08:00", tz: "America/New_York" }, at("2026-10-31T13:00:00Z"))!)).toBe("2026-11-01T13:00:00.000Z");
    expect(iso(nextDigestAt({ digest: "daily", digestLocalTime: "08:00", tz: "America/New_York" }, at("2026-10-30T11:00:00Z"))!)).toBe("2026-10-30T12:00:00.000Z");
    expect(nextDigestAt({ digest: "off", digestLocalTime: "08:00", tz: "UTC" }, Date.now())).toBeNull();
  });

  test("a time in the spring-forward gap moves forward; in the fall-back overlap the earlier instant wins; one per local day", () => {
    // Berlin skips 02:00–03:00 on 28 Mar 2027: 02:30 becomes 03:30 CEST (01:30Z).
    expect(iso(nextDigestAt({ digest: "daily", digestLocalTime: "02:30", tz: "Europe/Berlin" }, at("2027-03-27T12:00:00Z"))!)).toBe("2027-03-28T01:30:00.000Z");
    // Berlin repeats 02:00–03:00 on 25 Oct 2026: 02:30 is first at 00:30Z (CEST).
    expect(iso(nextDigestAt({ digest: "daily", digestLocalTime: "02:30", tz: "Europe/Berlin" }, at("2026-10-24T12:00:00Z"))!)).toBe("2026-10-25T00:30:00.000Z");
    // Chaining from each send gives exactly one digest per local date through both changes.
    for (const [start, tz] of [["2026-10-20T00:00:00Z", "Europe/Berlin"], ["2027-03-24T00:00:00Z", "Europe/Berlin"], ["2026-10-28T00:00:00Z", "America/New_York"]] as const) {
      let cursor = at(start);
      const dates: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        cursor = nextDigestAt({ digest: "daily", digestLocalTime: "02:30", tz }, cursor)!;
        dates.push(utcToZoned(cursor, tz).slice(0, 10));
      }
      expect(new Set(dates).size).toBe(10);
      for (let index = 1; index < dates.length; index += 1) expect(Date.parse(`${dates[index]}T00:00:00Z`) - Date.parse(`${dates[index - 1]}T00:00:00Z`)).toBe(86_400_000);
    }
  });

  test("weekly goes on Mondays at the local time", () => {
    // 2026-09-28 is a Monday.
    expect(iso(nextDigestAt({ digest: "weekly", digestLocalTime: "09:00", tz: "Europe/Berlin" }, at("2026-09-28T06:00:00Z"))!)).toBe("2026-09-28T07:00:00.000Z");
    expect(iso(nextDigestAt({ digest: "weekly", digestLocalTime: "09:00", tz: "Europe/Berlin" }, at("2026-09-28T07:00:00Z"))!)).toBe("2026-10-05T07:00:00.000Z");
    // Across the October change the Monday after is at 08:00Z (CET).
    expect(iso(nextDigestAt({ digest: "weekly", digestLocalTime: "09:00", tz: "Europe/Berlin" }, at("2026-10-20T00:00:00Z"))!)).toBe("2026-10-26T08:00:00.000Z");
  });

  test("a digest time inside quiet hours moves to their end", () => {
    expect(clampDigestTime("06:00", "22:00", "07:30")).toBe("07:30");
    expect(clampDigestTime("23:00", "22:00", "07:30")).toBe("07:30");
    expect(clampDigestTime("08:00", "22:00", "07:30")).toBe("08:00");
    expect(clampDigestTime("13:00", "12:00", "14:00")).toBe("14:00");
    expect(clampDigestTime("08:00", null, null)).toBe("08:00");
  });
});

describe("digest delivery", () => {
  test("saving a cadence schedules it; the tick queues one digest, moves on, and sends deep links", async () => {
    const user = await person("Digest Daily");
    const saved = await saveDigest(user, "daily", "08:00", "Asia/Kolkata");
    expect(saved.status).toBe(200);
    expect(saved.body.prefs.digest).toBe("daily");
    const next = Date.parse(saved.body.prefs.nextDigestAt);
    expect(next).toBe(nextDigestAt({ digest: "daily", digestLocalTime: "08:00", tz: "Asia/Kolkata" }, next - 1)!);
    // Content: an own card due today, an event tomorrow.
    const board = await call(user, "POST", "/tasks/boards", { name: "Digest board" });
    const today = utcToZoned(next, "Asia/Kolkata").slice(0, 10);
    const card = (await call(user, "POST", `/tasks/boards/${board.body.board.id}/cards`, { columnId: board.body.columns[0].id, title: "Ship the digest", assigneeIds: [user.userId], dueOn: today })).body.card;
    const calendar = (await call(user, "POST", "/calendars", { name: "Digest calendar" })).body.calendar;
    const event = (await call(user, "POST", `/calendars/${calendar.id}/events`, { title: "Digest review", allDay: false, startLocal: utcToZoned(next + 26 * 3_600_000, "UTC"), tz: "UTC", durationMinutes: 30 })).body.event;
    db.query("DELETE FROM mail_outbox").run();

    await runMailDispatch({ nowMs: next - 60_000 });
    expect(sent).toEqual([]);
    await runMailDispatch({ nowMs: next + 1000 });
    const message = sent.find((item) => item.to === user.email)!;
    expect(message.subject).toStartWith("Your day in Nook: ");
    expect(message.text).toContain(`/tasks/${board.body.board.id}/card/${card.id}`);
    expect(message.text).toContain(`/calendar/event/${event.id}`);
    expect(message.headers?.["List-Unsubscribe"]).toContain("/api/mail/unsubscribe?t=");
    expect(Date.parse(readEmailPrefs(user.userId).nextDigestAt!)).toBe(nextDigestAt({ digest: "daily", digestLocalTime: "08:00", tz: "Asia/Kolkata" }, next + 1000)!);
    // The same moment again queues nothing more.
    expect(scheduleDigests(next + 2000)).toBe(0);
    expect(db.query("SELECT COUNT(*) AS count FROM mail_outbox WHERE user_id = ? AND template = 'digest.summary'").get(user.userId)).toEqual({ count: 1 });
  });

  test("an empty digest is skipped; off by default; the one-click link turns it off", async () => {
    const quiet = await person("Digest Empty");
    expect(readEmailPrefs(quiet.userId)).toMatchObject({ digest: "off", nextDigestAt: null });
    const saved = await saveDigest(quiet, "weekly", "07:00", "UTC");
    const next = Date.parse(saved.body.prefs.nextDigestAt);
    expect(new Date(next).getUTCDay()).toBe(1);
    await runMailDispatch({ nowMs: next + 1000 });
    expect(sent.filter((item) => item.to === quiet.email)).toEqual([]);
    expect(db.query("SELECT status, skip_reason FROM mail_outbox WHERE user_id = ?").get(quiet.userId)).toEqual({ status: "skipped", skip_reason: "empty" });
    const token = await createUnsubscribeToken(quiet.userId, "digest");
    const response = await request(`/mail/unsubscribe?t=${token}`, { method: "POST", body: "" });
    expect(response.status).toBe(200);
    expect(readEmailPrefs(quiet.userId)).toMatchObject({ digest: "off", nextDigestAt: null });
  });

  test("shared with you since the last digest, re-checked at send time; lost access drops the item", async () => {
    const owner = await person("Digest Sharer");
    const reader = await person("Digest Reader");
    const saved = await saveDigest(reader, "daily", "09:00", "UTC");
    const next = Date.parse(saved.body.prefs.nextDigestAt);
    const kept = (await call(owner, "POST", "/tasks/boards", { name: "Kept board" })).body.board;
    const lost = (await call(owner, "POST", "/tasks/boards", { name: "Revoked board" })).body.board;
    for (const board of [kept, lost]) await call(owner, "PUT", `/tasks/boards/${board.id}/sharing`, { visibility: "selected", userIds: [reader.userId] });
    await call(owner, "PUT", `/tasks/boards/${lost.id}/sharing`, { visibility: "private", userIds: [] });
    db.query("DELETE FROM mail_outbox").run();
    await runMailDispatch({ nowMs: next + 1000 });
    const message = sent.find((item) => item.to === reader.email)!;
    expect(message.text).toContain("Kept board");
    expect(message.text).toContain("from Digest Sharer");
    expect(message.text).not.toContain("Revoked board");
    expect(message.text).toContain(`/tasks/${kept.id}`);
  });

  test("the digest never lands in quiet hours: the saved time moves to their end", async () => {
    const user = await person("Digest Quiet");
    const saved = await saveDigest(user, "daily", "06:00", "Europe/Berlin", { quietHours: { start: "22:00", end: "07:30" } });
    expect(saved.body.prefs.digestLocalTime).toBe("07:30");
    expect(utcToZoned(Date.parse(saved.body.prefs.nextDigestAt), "Europe/Berlin").slice(11, 16)).toBe("07:30");
  });
});
