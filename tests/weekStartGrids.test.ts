import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { monthGridDays, weekdayLabels, weekdayLabelsFrom } from "../src/calendarRoute";
import { headerRows, initialRange, mondayOf, rangeHolding, weekStartOn } from "../src/tasks/timelinePlacement";

/** D1383: every in-app week and month grid starts on the viewer's "Week starts on" (Monday by default). */

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

describe("month grid days", () => {
  test("Monday stays the default; Sunday and Saturday weeks start on their own day", () => {
    // November 2026 starts on a Sunday.
    expect(monthGridDays("2026-11")[0]).toBe("2026-10-26");
    expect(monthGridDays("2026-11", 1)).toEqual(monthGridDays("2026-11"));
    expect(monthGridDays("2026-11", 0)[0]).toBe("2026-11-01");
    expect(monthGridDays("2026-11", 6)[0]).toBe("2026-10-31");
    for (const start of [0, 1, 6] as const) {
      for (const month of ["2026-02", "2026-03", "2026-08", "2027-01"]) {
        const days = monthGridDays(month, start);
        expect(days).toHaveLength(42);
        expect(weekday(days[0]!)).toBe(start);
        expect(days).toContain(`${month}-01`);
        expect(days.indexOf(`${month}-01`)).toBeLessThan(7);
      }
    }
  });

  test("the column headings follow the week start", () => {
    expect(weekdayLabels).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(weekdayLabelsFrom(0)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    expect(weekdayLabelsFrom(6)).toEqual(["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"]);
  });

  test("Calendar's month view loads and draws the same grid from the viewer's week start; the shared grid reads it too", () => {
    const month = source("calendar/MonthView.tsx");
    expect(month).toContain("const { weekStart } = useUnitPreferences();");
    expect(month).toContain("monthGridDays(month, weekStart)");
    expect(month).toContain("weekStart={weekStart}");
    const grid = source("ui/calendarGrid/MonthGrid.tsx");
    expect(grid).toContain("const weekStart = props.weekStart ?? prefs.weekStart;");
    expect(grid).toContain("weekdayLabelsFrom(weekStart)");
  });
});

describe("loading the preference", () => {
  test("the units store reads the endpoint's own shape (it used to read a `preferences` key that is never sent)", async () => {
    const { unitsFromBody } = await import("../src/ui/units");
    expect(unitsFromBody({ weekStart: 0, durationFormat: "colon", bareDuration: "hours", revision: 3 })).toEqual({ weekStart: 0, durationFormat: "colon", bareDuration: "hours" });
    expect(unitsFromBody({ revision: 0 })).toEqual({ weekStart: 1, durationFormat: "hm", bareDuration: "minutes" });
    expect(unitsFromBody({ preferences: { weekStart: 6 } })).toEqual({ weekStart: 6, durationFormat: "hm", bareDuration: "minutes" });
  });
});

describe("booking slot pickers in the app", () => {
  test("Book time and Reschedule pass the viewer's week start", () => {
    for (const file of ["bookings/BookTimeSheet.tsx", "bookings/BookingDetail.tsx"]) {
      const text = source(file);
      expect(text).toContain("const { weekStart } = useUnitPreferences();");
      expect(text).toContain("tz={tz} onTz={setTz} weekStart={weekStart}");
    }
    expect(source("bookings/SlotPicker.tsx")).toContain("weekStart?: 0 | 1 | 6;");
  });
});

describe("the board timeline", () => {
  test("weeks start on the week start: the first range, its growth, and Quarter's week columns", () => {
    expect(mondayOf("2026-11-15")).toBe("2026-11-09");
    expect(weekStartOn("2026-11-15", 0)).toBe("2026-11-15");
    expect(weekStartOn("2026-11-16", 6)).toBe("2026-11-14");
    expect(weekday(initialRange("2026-11-16", "quarter", 0).from)).toBe(0);
    expect(weekday(initialRange("2026-11-16", "quarter").from)).toBe(1);
    const range = { from: "2026-11-01", days: 70 };
    expect(weekday(rangeHolding(range, "2026-11-02", 10, 0).range.from)).toBe(0);
    const sunday = headerRows(range, "quarter", "2026-11-16", 0, 69, 0).bottom;
    expect(sunday.slice(1).every((tick) => weekday(tick.key) === 0)).toBe(true);
    expect(sunday.length).toBeGreaterThan(5);
    const monday = headerRows(range, "quarter", "2026-11-16", 0, 69).bottom;
    expect(monday.slice(1).every((tick) => weekday(tick.key) === 1)).toBe(true);
  });
});
