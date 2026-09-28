import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { emailChannelHint, EVENT_OVER_MESSAGE, eventSeries, nextReminderFire, PASSED_MESSAGE, ReminderPicker, SERIES_OVER_MESSAGE } from "../src/calendar/EventReminders";

// Operator QA 0.9.2: on a past event every "Remind me" option was offered and picking one failed
// with a red line. Options whose time has passed are disabled with a hint, and an event with no
// upcoming occurrence shows a notice and Close instead. The server stays the source of truth.

const noop = () => undefined;
const pick = async () => undefined;
const NOW = Date.parse("2026-09-27T10:00:00Z");
const timed = (startLocal: string, repeat: unknown = null) => ({
  all_day: false, start_date: null, end_date: null, start_local: startLocal, tz: "UTC", duration_minutes: 30, repeat, exdates: []
}) as never;
const picker = (event: unknown, existing: number[] = []) => renderToStaticMarkup(<ReminderPicker allDay={false} existing={existing} event={event as never} timeZone="UTC" nowMs={NOW} onPick={pick} onClose={noop} />);
const rows = (html: string) => [...html.matchAll(/<li><button type="button" class="move-option( calendar-reminder-passed)?"( disabled="")?[^>]*>.*?<span>([^<]+)(?:<small>([^<]+)<\/small>)?<\/span>/g)]
  .map((match) => `${match[3]}${match[2] ? " [disabled]" : ""}${match[4] ? ` (${match[4]})` : ""}`);

test("the offsets are a list of items that each hold a button, not buttons posing as items (Friction 10)", () => {
  const html = picker(timed("2026-09-27T12:00"));
  expect(html).toContain('<ul class="move-list calendar-reminder-offsets" aria-label="When"><li><button type="button" class="move-option"');
  expect(html).not.toContain('role="listitem"');
  expect(html).not.toContain('role="list"');
  expect(rows(html)).toHaveLength(9);
  const css = readFileSync(new URL("../src/calendar/calendar.css", import.meta.url), "utf8");
  expect(css).toContain(".calendar-reminder-offsets { margin: 0; list-style: none; }");
});

test("a past one-off event: a notice and Close instead of the list", () => {
  const html = picker(timed("2026-09-10T09:00"));
  expect(html).toContain(EVENT_OVER_MESSAGE);
  expect(html).toContain("This event has already happened, so there is nothing to remind you about.");
  expect(html).toContain(">Close</button>");
  expect(html).not.toContain('aria-label="When"');
  expect(html).toContain("calendar-reminder-dialog");
});

test("an event in two hours: 5 minutes before is offered, 1 day before has already passed", () => {
  const event = timed("2026-09-27T12:00");
  const html = picker(event, [15]);
  const list = rows(html);
  expect(list).toContain("5 minutes before");
  expect(list).toContain("2 hours before");
  expect(list).toContain("15 minutes before [disabled] (Already set)");
  expect(list).toContain("1 day before [disabled] (Already passed)");
  expect(list).toContain("1 week before [disabled] (Already passed)");
  expect(list.filter((row) => row.includes("Already passed"))).toHaveLength(2);
  expect(html).not.toContain(EVENT_OVER_MESSAGE);
  const series = eventSeries(event)!;
  expect(nextReminderFire(series, 5, "UTC", NOW)).toBe(Date.parse("2026-09-27T11:55:00Z"));
  expect(nextReminderFire(series, 1440, "UTC", NOW)).toBeNull();
});

test("a repeating event: a passed lead moves to the next occurrence; an ended series says so", () => {
  // Weekly on Sundays from 6 September at 10:30: today's 10:30 is in half an hour, so 1 hour before
  // (09:30, passed) and 1 day before fire for next week's instead; nothing is disabled.
  const weekly = timed("2026-09-06T10:30", { freq: "weekly", interval: 1 });
  const series = eventSeries(weekly)!;
  expect(nextReminderFire(series, 60, "UTC", NOW)).toBe(Date.parse("2026-10-04T09:30:00Z"));
  expect(nextReminderFire(series, 10, "UTC", NOW)).toBe(Date.parse("2026-09-27T10:20:00Z"));
  const html = picker(weekly);
  expect(rows(html).some((row) => row.includes("disabled"))).toBe(false);
  // Three times in all, the last on 20 September: over.
  const ended = picker(timed("2026-09-06T10:30", { freq: "weekly", interval: 1, count: 3 }));
  expect(ended).toContain(SERIES_OVER_MESSAGE);
  expect(ended).toContain("This series has ended.");
  expect(ended).not.toContain('aria-label="When"');
});

test("the server's refusal reads the same way, and the sheet is wider on desktop", () => {
  const source = readFileSync(new URL("../src/calendar/EventReminders.tsx", import.meta.url), "utf8");
  expect(source).toContain('const NO_UPCOMING_TIME = "This event has no upcoming time for that reminder";');
  expect(source).toContain("setError(PASSED_MESSAGE);");
  expect(PASSED_MESSAGE).toBe("That reminder time has already passed.");
  const server = readFileSync(new URL("../server/calendar/reminders.ts", import.meta.url), "utf8");
  expect(server).toContain('"This event has no upcoming time for that reminder"');
  const css = readFileSync(new URL("../src/calendar/calendar.css", import.meta.url), "utf8");
  expect(css).toContain(".file-dialog.calendar-reminder-dialog { width: min(560px, 94vw); max-height: min(92vh, calc(100dvh - 32px)); }");
  // Without the event (older callers) every option is offered.
  expect(renderToStaticMarkup(<ReminderPicker allDay={false} existing={[]} onPick={pick} onClose={noop} />)).not.toContain("Already passed");
});

test("Remind me by (Wave 29): email is offered only with a verified address and the switches on", () => {
  const prefs = { enabled: true, categories: { assignments: true, comments: true, sharing: true, proposals: true, sprints: false, bin: false, reminders: true } } as never;
  const ready = { configured: true, verified: true, suppressed: false, prefs };
  expect(emailChannelHint(ready)).toBeNull();
  expect(emailChannelHint({ ...ready, verified: false })).toContain("Verify your email");
  expect(emailChannelHint({ ...ready, configured: false })).toBe("Email is off on this Nook.");
  expect(emailChannelHint({ ...ready, suppressed: true })).toContain("bounced");
  const unverified = renderToStaticMarkup(<ReminderPicker allDay={false} existing={[]} timeZone="UTC" nowMs={NOW} onPick={pick} onClose={noop} emailSettings={{ ...ready, verified: false }} />);
  expect(unverified).toContain("Remind me by");
  expect(unverified).toContain("Verify your email address in Settings → Notifications to get reminders by email.");
  const fine = renderToStaticMarkup(<ReminderPicker allDay={false} existing={[]} timeZone="UTC" nowMs={NOW} onPick={pick} onClose={noop} emailSettings={ready} />);
  expect(fine).not.toContain("calendar-reminder-channel-hint");
});
