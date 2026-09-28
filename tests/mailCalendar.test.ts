import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const mail = await import("../server/mail");
const { runMailDispatch } = await import("../server/mail/dispatcher");
const reminders = await import("../server/calendar/reminders");
const { utcToZoned } = await import("../server/calendar/recurrence");

/**
 * Calendar mail (outbound email §A.2 #22, #24): reminders by email fire in the reminders
 * dispatcher's transaction and bypass quiet hours (D242); email-only reminders keep the bell but
 * skip push; event changed and cancelled mails go to readers with a reminder on the event (D238),
 * coalesced per event, never to the actor, and not for a muted calendar.
 */

type Sent = Parameters<import("../server/mail").MailTransport>[0];
let sent: Sent[] = [];
const MINUTE = 60_000;

beforeEach(() => {
  sent = [];
  mail.resetMailLimits();
  reminders.resetReminderDeferrals();
  db.query("DELETE FROM mail_outbox").run();
  mail.setMailTransportForTests(async (message) => { sent.push(message); return { id: `msg_${sent.length}` }; });
});
afterEach(() => mail.setMailTransportForTests(null));

async function person(label: string, verified = true) {
  const session = await createUser(label);
  if (verified) db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), session.userId);
  return session;
}
async function call(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}
/** A local start `hours` from now in UTC, on the minute. */
const localIn = (hours: number) => utcToZoned(Math.ceil((Date.now() + hours * 3_600_000) / MINUTE) * MINUTE, "UTC").slice(0, 16);

async function calendarWithEvent(owner: Session, readers: Session[], hours = 26, location = "Room 2") {
  const calendar = (await call(owner, "POST", "/calendars", { name: "Team calendar" })).body.calendar;
  if (readers.length) await call(owner, "PUT", `/calendars/${calendar.id}/sharing`, { visibility: "selected", shareRole: "editor", userIds: readers.map((reader) => reader.userId) });
  const event = (await call(owner, "POST", `/calendars/${calendar.id}/events`, { title: "Design review", allDay: false, startLocal: localIn(hours), tz: "UTC", durationMinutes: 30, location })).body.event;
  db.query("DELETE FROM mail_outbox").run();
  return { calendarId: calendar.id as string, event: event as { id: string; revision: number } };
}

describe("reminders by email", () => {
  test("the channel is stored and listed; email needs a verified address", async () => {
    const unverified = await person("Reminder Unverified", false);
    const { event } = await calendarWithEvent(unverified, []);
    const refused = await call(unverified, "POST", "/reminders", { eventId: event.id, offsetMinutes: 15, tz: "UTC", channels: "email" });
    expect(refused).toMatchObject({ status: 409, body: { code: "EMAIL_UNVERIFIED" } });
    db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), unverified.userId);
    const created = await call(unverified, "POST", "/reminders", { eventId: event.id, offsetMinutes: 15, tz: "UTC", channels: "push_email" });
    expect(created.status).toBe(201);
    expect(created.body.reminder.channels).toBe("push_email");
    expect((await call(unverified, "POST", "/reminders", { eventId: event.id, offsetMinutes: 30, tz: "UTC" })).body.reminder.channels).toBe("push");
    expect((await call(unverified, "POST", "/reminders", { eventId: event.id, offsetMinutes: 60, tz: "UTC", channels: "sms" })).status).toBe(400);
    const listed = (await call(unverified, "GET", `/reminders?eventId=${event.id}`)).body.reminders as Array<{ channels: string }>;
    expect(listed.map((item) => item.channels).sort()).toEqual(["push", "push_email"]);
  });

  test("fires into the outbox in the dispatcher's transaction; the mail deep-links to the event and ignores quiet hours", async () => {
    const user = await person("Reminder Email");
    const { event } = await calendarWithEvent(user, [], 3);
    // Quiet hours all day long: reminders are time-bound and never held (D242).
    await call(user, "PUT", "/mail/settings", { enabled: true, categories: { assignments: true, comments: true, sharing: true, proposals: true, sprints: false, bin: false, reminders: true }, digest: "off", digestLocalTime: "08:00", quietHours: { start: "00:00", end: "23:30" }, tz: "UTC", revision: 0 });
    const reminder = (await call(user, "POST", "/reminders", { eventId: event.id, offsetMinutes: 60, tz: "Europe/Berlin", channels: "email" })).body.reminder;
    const pushes: Array<{ userId: string; push?: boolean }> = [];
    const stop = reminders.onNotification((created) => pushes.push(...created));
    try {
      const fireMs = Date.parse(reminder.nextFireAt);
      reminders.runDispatch({ nowMs: fireMs + 1000 });
      const row = db.query("SELECT template, class, category, payload, not_before FROM mail_outbox WHERE user_id = ?").get(user.userId) as { template: string; class: string; category: string; payload: string; not_before: string };
      expect(row).toMatchObject({ template: "calendar.reminder", class: "reminders", category: "reminders" });
      // Ids and instants only (T226): no title or place in the outbox.
      expect(row.payload).not.toContain("Design review");
      expect(row.payload).not.toContain("Room 2");
      // Email only: the bell entry is made, the push skipped.
      expect(pushes.filter((item) => item.userId === user.userId)).toEqual([expect.objectContaining({ push: false })]);
      await runMailDispatch({ nowMs: fireMs + 2000 });
      const [message] = sent.filter((item) => item.to === user.email);
      expect(message!.subject).toStartWith("Reminder: ‘Design review’ at ");
      expect(message!.subject).toContain("(Europe/Berlin)");
      expect(message!.subject).not.toContain("(late)");
      expect(message!.text).toContain(`/calendar/event/${event.id}`);
      expect(message!.headers?.["List-Unsubscribe"]).toContain("/api/mail/unsubscribe?t=");
    } finally {
      stop();
    }
  });

  test("push-only reminders queue no mail; the reminders switch off skips; a late send says so", async () => {
    const user = await person("Reminder Switch");
    const { event } = await calendarWithEvent(user, [], 3);
    const push = (await call(user, "POST", "/reminders", { eventId: event.id, offsetMinutes: 60, tz: "UTC" })).body.reminder;
    reminders.runDispatch({ nowMs: Date.parse(push.nextFireAt) + 1000 });
    expect(db.query("SELECT COUNT(*) AS count FROM mail_outbox WHERE user_id = ?").get(user.userId)).toEqual({ count: 0 });
    const both = (await call(user, "POST", "/reminders", { eventId: event.id, offsetMinutes: 30, tz: "UTC", channels: "push_email" })).body.reminder;
    const fireMs = Date.parse(both.nextFireAt);
    reminders.runDispatch({ nowMs: fireMs + 20 * MINUTE });
    await runMailDispatch({ nowMs: fireMs + 21 * MINUTE });
    expect(sent.at(-1)!.subject).toEndWith("(late)");
    await call(user, "PUT", "/mail/settings", { enabled: true, categories: { assignments: true, comments: true, sharing: true, proposals: true, sprints: false, bin: false, reminders: false }, digest: "off", digestLocalTime: "08:00", quietHours: null, tz: "UTC", revision: 0 });
    const third = (await call(user, "POST", "/reminders", { eventId: event.id, offsetMinutes: 15, tz: "UTC", channels: "email" })).body.reminder;
    reminders.runDispatch({ nowMs: Date.parse(third.nextFireAt) + 1000 });
    await runMailDispatch({ nowMs: Date.parse(third.nextFireAt) + 2000 });
    expect(db.query("SELECT status, skip_reason FROM mail_outbox WHERE user_id = ? AND status = 'skipped'").all(user.userId)).toEqual([{ status: "skipped", skip_reason: "prefs_off" }]);
  });

  test("a standalone reminder mails its own title and opens the notifications", async () => {
    const user = await person("Reminder Standalone");
    const fireAt = localIn(2);
    const reminder = (await call(user, "POST", "/reminders", { title: "Call the bank", fireAt, tz: "UTC", channels: "email" })).body.reminder;
    reminders.runDispatch({ nowMs: Date.parse(reminder.nextFireAt) + 1000 });
    await runMailDispatch({ nowMs: Date.parse(reminder.nextFireAt) + 2000 });
    const message = sent.find((item) => item.to === user.email)!;
    expect(message.subject).toStartWith("Reminder: ‘Call the bank’");
    expect(message.text).toContain("/notifications");
  });
});

describe("event changed or cancelled", () => {
  test("a new time mails readers with a reminder, coalesced, never the actor; a change undone sends nothing", async () => {
    const owner = await person("Change Owner");
    const reader = await person("Change Reader");
    const bystander = await person("Change Bystander");
    const { event } = await calendarWithEvent(owner, [reader, bystander]);
    await call(reader, "POST", "/reminders", { eventId: event.id, offsetMinutes: 15, tz: "UTC" });
    await call(owner, "POST", "/reminders", { eventId: event.id, offsetMinutes: 15, tz: "UTC" });
    // A title-only change is not a change of plan.
    let revision = (await call(owner, "PATCH", `/events/${event.id}`, { revision: event.revision, title: "Design review (v2)" })).body.event.revision as number;
    expect(db.query("SELECT COUNT(*) AS count FROM mail_outbox").get()).toEqual({ count: 0 });
    revision = (await call(owner, "PATCH", `/events/${event.id}`, { revision, startLocal: localIn(28) })).body.event.revision;
    revision = (await call(owner, "PATCH", `/events/${event.id}`, { revision, location: "Room 4" })).body.event.revision;
    const rows = db.query("SELECT user_id, template, payload FROM mail_outbox").all() as Array<{ user_id: string; template: string; payload: string }>;
    expect(rows.map((row) => [row.user_id, row.template])).toEqual([[reader.userId, "calendar.event_changed"]]);
    await runMailDispatch({ nowMs: Date.now() + 11 * MINUTE });
    const message = sent.find((item) => item.to === reader.email)!;
    expect(message.subject).toStartWith("‘Design review (v2)’ changed: now ");
    expect(message.text).toContain("Place Room 4");
    expect(message.text).toContain(`/calendar/event/${event.id}`);
    // Changed and changed back within the window: skipped as nothing to say.
    const back = localIn(28);
    revision = (await call(owner, "PATCH", `/events/${event.id}`, { revision, startLocal: localIn(30) })).body.event.revision;
    await call(owner, "PATCH", `/events/${event.id}`, { revision, startLocal: back });
    await runMailDispatch({ nowMs: Date.now() + 11 * MINUTE });
    expect(db.query("SELECT status, skip_reason FROM mail_outbox WHERE status <> 'sent'").all()).toEqual([{ status: "skipped", skip_reason: "empty" }]);
  });

  test("a move to the Bin mails a cancellation; far-off events and muted calendars send nothing", async () => {
    const owner = await person("Cancel Owner");
    const reader = await person("Cancel Reader");
    const soon = await calendarWithEvent(owner, [reader]);
    await call(reader, "POST", "/reminders", { eventId: soon.event.id, offsetMinutes: 15, tz: "UTC" });
    expect((await call(owner, "DELETE", `/events/${soon.event.id}`)).status).toBe(200);
    await runMailDispatch({ nowMs: Date.now() + 11 * MINUTE });
    const cancelled = sent.find((item) => item.to === reader.email)!;
    expect(cancelled.subject).toBe("‘Design review’ was cancelled");
    expect(cancelled.text).toContain("/calendar\n");

    const far = await calendarWithEvent(owner, [reader], 24 * 20);
    await call(reader, "POST", "/reminders", { eventId: far.event.id, offsetMinutes: 15, tz: "UTC" });
    await call(owner, "PATCH", `/events/${far.event.id}`, { revision: far.event.revision, startLocal: localIn(24 * 21) });
    const muted = await calendarWithEvent(owner, [reader]);
    await call(reader, "POST", "/reminders", { eventId: muted.event.id, offsetMinutes: 15, tz: "UTC" });
    await call(reader, "PUT", `/mail/mutes/calendar/${muted.calendarId}`);
    await call(owner, "PATCH", `/events/${muted.event.id}`, { revision: muted.event.revision, location: "Elsewhere" });
    expect(db.query("SELECT COUNT(*) AS count FROM mail_outbox WHERE status = 'queued'").get()).toEqual({ count: 0 });
  });
});
