import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { EventSheet } from "../src/calendar/EventSheet";
import type { CalendarSummary } from "../src/calendar/calendarApi";
import type { EventForm } from "../src/calendar/calendarFormat";

// Operator QA 0.9.2: the New event sheet was a narrow 460 px dialog on a laptop. From 1100 px it is
// min(880px, 90vw) with two columns; 761–1099 px min(720px, 94vw) in one; phones keep the full-screen sheet.

const css = readFileSync(new URL("../src/calendar/calendar.css", import.meta.url), "utf8");
const noop = () => undefined;
const form = { title: "Standup", allDay: false, startDate: "2026-09-28", startTime: "09:00", endDate: "2026-09-28", endTime: "09:30", tz: "Europe/Berlin", location: "", description: "", repeat: null } as unknown as EventForm;
const calendar = (id: string, name: string) => ({ id, owner_id: "u", owner_name: "Asha", is_owner: 1, role: "owner", name, color: "blue" }) as unknown as CalendarSummary;

function sheet(mode: "create" | "edit") {
  return renderToStaticMarkup(<EventSheet mode={mode} form={form} calendars={[calendar("c1", "Work"), calendar("c2", "Home")]} calendarId="c1" busy={false} error={null} conflict={false}
    onChange={noop} onCalendarChange={noop} onRepeat={noop} onSave={noop} onReload={noop} onClose={noop} />);
}

test("the event sheet groups the dates on the left and the calendar, Location, and Notes on the right", () => {
  for (const mode of ["create", "edit"] as const) {
    const html = sheet(mode);
    // Both the new and the existing-event sheet are this component, with the same width class.
    expect(html).toContain('class="file-dialog file-dialog-sheet calendar-event-dialog"');
    const when = html.indexOf('class="calendar-event-when"');
    const details = html.indexOf('class="calendar-event-details"');
    expect(when).toBeGreaterThan(0);
    expect(details).toBeGreaterThan(when);
    const left = html.slice(when, details);
    for (const text of ["Title", "All day", "Starts", "Ends", "Time zone: Europe/Berlin", "Repeat"]) expect(left).toContain(text);
    const right = html.slice(details, html.indexOf("file-dialog-actions"));
    for (const text of ["Location", "Notes"]) expect(right).toContain(text);
    expect(right).toContain("calendar-event-notes");
    if (mode === "create") expect(right).toContain("calendar-event-calendar");
    else expect(html).not.toContain("calendar-event-calendar");
  }
});

test("the event sheet's widths: 720 px from 761 px, 880 px and two columns from 1100 px, 92vh, never transformed", () => {
  expect(css).toContain(".calendar-event-when, .calendar-event-details { display: contents; }");
  // One column keeps the calendar right after the title.
  expect(css).toContain(".calendar-event-title { order: -2; }");
  expect(css).toContain(".calendar-event-calendar { order: -1; }");
  expect(css).toContain("@media (min-width: 761px) {\n  .file-dialog.calendar-event-dialog { width: min(720px, 94vw); max-height: min(92vh, calc(100dvh - 32px)); }\n");
  const wide = css.slice(css.indexOf("@media (min-width: 1100px) {\n  .file-dialog.calendar-event-dialog"));
  expect(wide).toContain(".file-dialog.calendar-event-dialog { width: min(880px, 90vw); }");
  expect(wide).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)");
  expect(wide).toContain(".calendar-event-notes { flex: 1;");
  expect(/calendar-event[^{]*\{[^}]*transform/.test(css)).toBe(false);
});
