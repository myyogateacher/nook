import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readHistoryDepth, withHistoryDepth } from "../src/appShellNavigation";
import { acquireDialogSentinel, isDialogSentinelState, popStateClosedDialog, registerHistoryDialogGuard, undoDialogPop, whenHistorySettled } from "../src/historyDialogs";
import { createDialogGuard } from "../src/ui/useHistoryDialogGuard";

// The Calendar's event sheet, its Repeat sheet, and its Discard prompt are shown one at a time, and
// each holds useHistoryDialogGuard while mounted (EventSheet.tsx). This drives the same primitives in
// the hook's effect order to pin the Back sequence: Repeat → form → prompt → form, never leaving.

type Layer = "form" | "repeat" | "prompt";

function calendarHistory(initial: unknown[], phone: boolean) {
  const entries = [...initial];
  let index = entries.length - 1;
  const moves: number[] = [];
  const history = {
    get state() { return entries[index]; },
    pushState(state: unknown) { entries.splice(index + 1, entries.length, state); index += 1; },
    back() { moves.push(-1); }
  };
  const env = { history: history as unknown as History, href: () => "https://nook.test/calendar", landingDepth: () => phone ? 0 : -1 };
  const go = (delta: number) => { moves.push(delta); };
  // A move lands (and fires popstate) only when delivered, like a browser.
  const deliver = () => { index += moves.shift()!; return popStateClosedDialog({ state: entries[index] }); };
  const userBack = () => { index -= 1; return popStateClosedDialog({ state: entries[index] }); };
  return { entries, history, env, go, deliver, userBack, moves, index: () => index };
}

/** Mounts one layer the way useHistoryDialogGuard does; returns its unmount. */
function mountLayer(harness: ReturnType<typeof calendarHistory>, close: () => void) {
  let open = true;
  let depth = readHistoryDepth(harness.history.state);
  const release = acquireDialogSentinel(harness.env);
  const cancel = whenHistorySettled(() => { depth = readHistoryDepth(harness.history.state); });
  const unregister = registerHistoryDialogGuard(createDialogGuard({
    isOpen: () => open, markClosed: () => { open = false; }, close, openDepth: () => depth,
    undo: (direction) => undoDialogPop(direction, harness.go)
  }));
  return () => { release(); cancel(); unregister(); };
}

/** CalendarApp's state for the three layers: which one is on screen, and the draft it keeps. */
function eventSheetApp(harness: ReturnType<typeof calendarHistory>) {
  const closed: Layer[] = [];
  const app = { layer: "form" as Layer | null, draft: "Dentist", unmount: (() => undefined) as () => void };
  const show = (next: Layer | null) => {
    // React commits the swap after the popstate handler: the old layer's effects clean up first.
    app.unmount();
    app.layer = next;
    app.unmount = next ? mountLayer(harness, () => { closed.push(next); pending = next === "repeat" ? "form" : next === "form" ? "prompt" : "form"; }) : () => undefined;
  };
  let pending: Layer | null = null;
  const commit = () => { if (pending) { const next = pending; pending = null; show(next); } };
  show("form");
  return { app, closed, show, commit };
}

test("phone at depth 0: Back closes Repeat, then asks, then keeps editing, and never leaves Calendar", async () => {
  const harness = calendarHistory([withHistoryDepth({ route: "calendar" }, 0)], true);
  const { app, closed, show, commit } = eventSheetApp(harness);
  expect(harness.entries).toHaveLength(2);
  expect(isDialogSentinelState(harness.history.state)).toBe(true);
  // Repeat… replaces the form and keeps the same sentinel.
  show("repeat");
  await Bun.sleep(5);
  expect(harness.entries).toHaveLength(2);
  expect(harness.index()).toBe(1);

  for (const expected of ["repeat", "form", "prompt"] as const) {
    // Back pops the sentinel: only the layer on top closes, and the next one gets a sentinel again.
    expect(harness.userBack()).toBe(true);
    expect(closed.at(-1)).toBe(expected);
    commit();
    expect(app.layer).toBe(expected === "form" ? "prompt" : "form");
    expect(harness.index()).toBe(1);
    expect(isDialogSentinelState(harness.history.state)).toBe(true);
    expect(harness.moves).toEqual([]);
  }
  // Cancel on the prompt (or Back) kept the draft, and Calendar is still the page under the sheet.
  expect(app.draft).toBe("Dentist");
  expect(harness.entries[0]).toEqual({ route: "calendar", "mynotes.depth": 0 });
  // Closing the form by other means pops the sentinel, and that popstate is not a route change.
  show(null);
  await Bun.sleep(5);
  expect(harness.moves).toEqual([-1]);
  expect(harness.deliver()).toBe(true);
  expect(harness.index()).toBe(0);
});

test("desktop above depth 0: each Back is undone and closes one layer, with no sentinel", async () => {
  const harness = calendarHistory([withHistoryDepth({ route: "agenda" }, 0), withHistoryDepth({ route: "month" }, 1)], false);
  const { app, closed, show, commit } = eventSheetApp(harness);
  show("repeat");
  await Bun.sleep(5);
  for (const expected of ["repeat", "form", "prompt"] as const) {
    expect(harness.userBack()).toBe(true);
    expect(closed.at(-1)).toBe(expected);
    // The guard undid the move; the next layer mounts while that undo is in flight.
    expect(harness.moves).toEqual([1]);
    commit();
    expect(harness.deliver()).toBe(true);
    expect(harness.index()).toBe(1);
    expect(harness.entries).toHaveLength(2);
  }
  expect(app.layer).toBe("form");
  show(null);
  await Bun.sleep(5);
  expect(harness.moves).toEqual([]);
  // A later, real popstate goes through to the routes.
  expect(popStateClosedDialog({ state: harness.entries[0] })).toBe(false);
});

test("the Calendar asks in the app, never with a native confirm", () => {
  for (const file of ["../src/calendar/EventSheet.tsx", "../src/calendar/CalendarApp.tsx", "../src/calendar/hooks.ts"]) {
    expect(readFileSync(new URL(file, import.meta.url), "utf8")).not.toMatch(/window\.confirm|\bconfirm\(/);
  }
  const sheet = readFileSync(new URL("../src/calendar/EventSheet.tsx", import.meta.url), "utf8");
  expect(sheet.match(/useHistoryDialogGuard\(true, /g)).toHaveLength(3);
});
