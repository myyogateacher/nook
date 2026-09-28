import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openerTarget } from "../src/calendar/hooks";

// QA 0.12 item 3: Escape on the Calendars sheet or the reminder sheet handed focus to the page body,
// and closing the Share panel that replaces the Calendars sheet left focus on the sheet's Close.

type Fake = { name: string; isConnected: boolean; focus: () => void };
const fake = (name: string, isConnected = true): Fake => ({ name, isConnected, focus: () => undefined });

test("focus goes back to the opener while it is on the page, else its namesake, else the fallback", () => {
  const toolbar = fake("Calendars");
  expect(openerTarget({ element: toolbar, label: null, fallback: null }, () => null)).toBe(toolbar);
  // The Share button unmounted with the Calendars sheet; the re-mounted sheet has one with the same name.
  const remounted = fake("Share Team");
  const queries: string[] = [];
  const find = (selector: string) => { queries.push(selector); return selector === '[aria-label="Share Team"]' ? remounted : null; };
  expect(openerTarget({ element: fake("Share Team", false), label: "Share Team", fallback: null }, find)).toBe(remounted);
  // A name with a quote stays a valid selector.
  openerTarget({ element: null, label: 'Share "Ops"', fallback: null }, find);
  expect(queries.at(-1)).toBe('[aria-label="Share \\"Ops\\""]');
  // The Add reminder button has no aria-label: the layer's fallback selector finds it.
  const add = fake("Add reminder");
  expect(openerTarget({ element: fake("Add reminder", false), label: null, fallback: ".calendar-link-add" }, (selector) => selector === ".calendar-link-add" ? add : null)).toBe(add);
  expect(openerTarget({ element: null, label: null, fallback: null }, () => add)).toBeNull();
  expect(openerTarget(null, () => add)).toBeNull();
});

test("the Calendars sheet, reminder sheet, and the layers that replace the Calendars sheet each return focus", () => {
  const source = readFileSync(new URL("../src/calendar/CalendarApp.tsx", import.meta.url), "utf8");
  expect(source).toContain("useReturnFocus(calendarsOpen);");
  expect(source).toContain('useReturnFocus(reminderPicker !== null, ".calendar-link-add");');
  expect(source).toContain("useReturnFocus(sharing !== null);");
  expect(source).toContain("useReturnFocus(feeds !== null);");
  const hooks = readFileSync(new URL("../src/calendar/hooks.ts", import.meta.url), "utf8");
  // After the layer (and any sheet under it) has mounted and taken its first focus.
  expect(hooks).toMatch(/window\.requestAnimationFrame\(\(\) => \{\s+openerTarget\(opener,/);
});
