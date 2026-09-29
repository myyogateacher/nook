import { expect, test } from "bun:test";

// C12: fixtures that must lie in the future are dated from the current year (`Y`), as
// tests/mcpCalendar.test.ts is, instead of pinned to 2030–2032, which would start failing then.
const FILES = ["calendarReminders", "push", "team", "calendarBudget", "writeGate", "mcpCalendar"];

test("the reminder, push, team, calendar budget, and read-only role fixtures carry no pinned future year", async () => {
  const pinned: string[] = [];
  for (const name of FILES) {
    const source = await Bun.file(new URL(`./${name}.test.ts`, import.meta.url)).text();
    source.split("\n").forEach((line, index) => {
      // 2099 is the calendar budget's "never" sentinel, not a date that comes due.
      for (const match of line.matchAll(/\b(20[2-9]\d)-\d\d-\d\d/g)) if (Number(match[1]) >= 2027 && match[1] !== "2099") pinned.push(`tests/${name}.test.ts:${index + 1} ${match[0]}`);
    });
  }
  expect(pinned).toEqual([]);
});
