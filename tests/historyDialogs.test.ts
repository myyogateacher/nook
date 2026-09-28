import { expect, test } from "bun:test";
import { acquireDialogSentinel, defaultSentinelEnv, dialogSentinelState, isDialogSentinelState, needsDialogSentinel, offerDialogReopen, popStateClosedDialog, registerHistoryDialogGuard, takeDialogSentinelEntry, undoDialogPop, whenHistorySettled } from "../src/historyDialogs";
import { createDialogGuard } from "../src/ui/useHistoryDialogGuard";

test("a desktop-layered dialog holds the depth-0 sentinel at every width (2i)", () => {
  const holder = globalThis as { window?: unknown };
  const previous = holder.window;
  holder.window = { history: {}, location: { href: "https://nook.test/inbox/routines" }, matchMedia: () => ({ matches: false }) };
  try {
    expect(defaultSentinelEnv(false).phone()).toBe(false);
    expect(defaultSentinelEnv(true).phone()).toBe(true);
    expect(defaultSentinelEnv(true).href()).toBe("https://nook.test/inbox/routines");
  } finally {
    holder.window = previous;
  }
});

test("the routine sheet and the dropdowns inside it keep their own desktop history layers (2i)", async () => {
  const pane = await Bun.file(new URL("../src/inbox/RoutinesPane.tsx", import.meta.url)).text();
  expect(pane).toContain("useHistoryDialogGuard(true, onClose, { desktop: true })");
  expect(pane).toContain("<DesktopHistoryLayers.Provider value={true}>");
  expect(pane).toContain("useDialogFocus(sheetRef)");
  expect(pane).toContain("onKeyDown={trapTabKey}");
  const listbox = await Bun.file(new URL("../src/ui/Listbox.tsx", import.meta.url)).text();
  expect(listbox).toContain("useHistoryDialogGuard(useContext(DesktopHistoryLayers), onClose)");
  const css = await Bun.file(new URL("../src/ui/ui.css", import.meta.url)).text();
  expect(css).toContain(".ui-chip-remove { width: 44px; height: 44px;");
});

test("a sentinel is pushed only for a phone dialog opened at depth 0", () => {
  expect(needsDialogSentinel(null, { phone: true, active: false })).toBe(true);
  expect(needsDialogSentinel({ "mynotes.depth": 0 }, { phone: true, active: false })).toBe(true);
  // D18 unchanged: deeper entries push nothing, nor does the desktop, nor a second dialog.
  expect(needsDialogSentinel({ "mynotes.depth": 2 }, { phone: true, active: false })).toBe(false);
  expect(needsDialogSentinel(null, { phone: false, active: false })).toBe(false);
  expect(needsDialogSentinel(null, { phone: true, active: true })).toBe(false);
  expect(needsDialogSentinel(dialogSentinelState(null), { phone: true, active: false })).toBe(false);
});

test("the sentinel keeps the entry's state one level deeper with the dialog hint", () => {
  const state = dialogSentinelState({ route: "home" });
  expect(state).toEqual({ route: "home", "mynotes.dialog": true, "mynotes.depth": 1 });
  expect(isDialogSentinelState(state)).toBe(true);
  expect(isDialogSentinelState({ route: "home" })).toBe(false);
});

function fakeHistory(initial: unknown) {
  const entries: unknown[] = [initial];
  let index = 0;
  const history = {
    get state() { return entries[index]; },
    pushState(state: unknown) { entries.splice(index + 1, entries.length, state); index += 1; },
    back() { index -= 1; }
  };
  return { history, env: { history: history as unknown as History, href: () => "https://nook.test/", phone: () => true } };
}

test("closing the dialog by other means pops the sentinel and ignores that popstate", async () => {
  const { history, env } = fakeHistory({ route: "home" });
  const release = acquireDialogSentinel(env);
  expect(isDialogSentinelState(history.state)).toBe(true);
  // A second dialog replacing the first keeps the same sentinel.
  const second = acquireDialogSentinel(env);
  release();
  await Bun.sleep(5);
  expect(isDialogSentinelState(history.state)).toBe(true);
  second();
  await Bun.sleep(5);
  expect(history.state).toEqual({ route: "home" });
  // The popstate caused by history.back() is not a route change.
  expect(popStateClosedDialog({ state: history.state })).toBe(true);
  expect(popStateClosedDialog({ state: history.state })).toBe(false);
});

test("Back from the sentinel only closes the dialog, without undoing the move", async () => {
  const { history, env } = fakeHistory(null);
  let open = true;
  const unregister = registerHistoryDialogGuard(() => {
    if (!open) return false;
    open = false;
    return false; // Depths 0 and 0: direction unknown.
  });
  const release = acquireDialogSentinel(env);
  history.back();
  expect(popStateClosedDialog({ state: history.state })).toBe(true);
  expect(open).toBe(false);
  release();
  await Bun.sleep(5);
  // Nothing more to pop: a later, real navigation goes through.
  expect(history.state).toBeNull();
  expect(popStateClosedDialog({ state: null })).toBe(false);
  unregister();
});

// Like a browser: history.back() only moves (and updates state) when its popstate is delivered.
function asyncHistory(initial: unknown) {
  const entries: unknown[] = [initial];
  let index = 0;
  let pending = 0;
  const history = {
    get state() { return entries[index]; },
    pushState(state: unknown) { entries.splice(index + 1, entries.length, state); index += 1; },
    replaceState(state: unknown) { entries[index] = state; },
    back() { pending += 1; }
  };
  const deliver = () => {
    expect(pending).toBeGreaterThan(0);
    pending -= 1;
    index -= 1;
    return popStateClosedDialog({ state: entries[index] });
  };
  return { history, deliver, entries: () => entries.slice(0, index + 1), env: { history: history as unknown as History, href: () => "https://nook.test/", phone: () => true } };
}

test("a dialog opened before the sentinel's pop lands gets a sentinel once it has", async () => {
  const { history, deliver, entries, env } = asyncHistory({ route: "home" });
  const first = acquireDialogSentinel(env);
  first();
  await Bun.sleep(5);
  // history.back() is on its way; the state still reads the old sentinel.
  expect(isDialogSentinelState(history.state)).toBe(true);
  const second = acquireDialogSentinel(env);
  expect(entries()).toHaveLength(2);
  // The pop lands (ignored), then the new dialog's sentinel is pushed.
  expect(deliver()).toBe(true);
  expect(entries()).toEqual([{ route: "home" }, dialogSentinelState({ route: "home" })]);
  // Back now only closes the second dialog.
  let open = true;
  const unregister = registerHistoryDialogGuard(() => { open = false; return false; });
  history.back();
  expect(deliver()).toBe(true);
  expect(open).toBe(false);
  second();
  await Bun.sleep(5);
  expect(entries()).toEqual([{ route: "home" }]);
  unregister();
});

test("Back that closes the inner of two stacked dialogs re-arms the sentinel for the outer one", async () => {
  const { history, deliver, entries, env } = asyncHistory({ route: "collection", "mynotes.depth": 0 });
  const outer = acquireDialogSentinel(env);
  const inner = acquireDialogSentinel(env);
  expect(entries()).toHaveLength(2);
  let innerOpen = true;
  const unregister = registerHistoryDialogGuard(() => { if (!innerOpen) return false; innerOpen = false; return false; });
  // Back pops the sentinel and closes only the inner dialog (a dropdown sheet over a sheet).
  history.back();
  expect(deliver()).toBe(true);
  expect(innerOpen).toBe(false);
  inner();
  // The outer dialog is still open, so it holds a fresh sentinel: the next Back closes it in place.
  expect(entries()).toEqual([{ route: "collection", "mynotes.depth": 0 }, dialogSentinelState({ route: "collection", "mynotes.depth": 0 })]);
  unregister();
  outer();
  await Bun.sleep(5);
  expect(deliver()).toBe(true);
  expect(entries()).toEqual([{ route: "collection", "mynotes.depth": 0 }]);
});

test("an in-app navigation from the sentinel replaces it instead of stacking on it", async () => {
  const { history, entries, env } = asyncHistory({ route: "home", "mynotes.depth": 0 });
  const release = acquireDialogSentinel(env);
  expect(takeDialogSentinelEntry({ route: "home" })).toBe(false);
  // The app's navigation asks first, then replaces the sentinel at its depth.
  expect(takeDialogSentinelEntry(history.state)).toBe(true);
  history.replaceState({ route: "note", "mynotes.depth": 1 });
  expect(entries()).toEqual([{ route: "home", "mynotes.depth": 0 }, { route: "note", "mynotes.depth": 1 }]);
  // Asked again (or with no sentinel held), it is an ordinary push.
  expect(takeDialogSentinelEntry(history.state)).toBe(false);
  release();
  await Bun.sleep(5);
  // Closing the dialog pops nothing: the new route stays.
  expect(entries()).toHaveLength(2);
  expect(popStateClosedDialog({ state: history.state })).toBe(false);
});

test("Back that closes a nested sheet at depth 1 keeps the URL and the forward entry", async () => {
  // A fresh `/` (depth 0), then /calendar (depth 1): no sentinel, D18 closes dialogs by undoing the move.
  const entries: unknown[] = [{ route: "home", "mynotes.depth": 0 }, { route: "calendar", "mynotes.depth": 1 }];
  let index = 1;
  const moves: number[] = [];
  const history = {
    get state() { return entries[index]; },
    pushState(state: unknown) { entries.splice(index + 1, entries.length, state); index += 1; },
    back() { moves.push(-1); }
  };
  const env = { history: history as unknown as History, href: () => "https://nook.test/", phone: () => true };
  // Moves land (and fire popstate) only when delivered, like a browser.
  const deliver = () => { index += moves.shift()!; return popStateClosedDialog({ state: entries[index] }); };
  const dialog = acquireDialogSentinel(env);
  const sheet = acquireDialogSentinel(env);
  expect(entries).toHaveLength(2);
  let sheetOpen = true;
  const unregister = registerHistoryDialogGuard(() => {
    if (!sheetOpen) return false;
    sheetOpen = false;
    // The dropdown guard undoes Back with history.go(1), still in flight when the sheet releases.
    undoDialogPop("back", (delta) => moves.push(delta));
    return true;
  });
  history.back();
  expect(deliver()).toBe(true);
  expect(sheetOpen).toBe(false);
  expect(index).toBe(0);
  sheet();
  // The release must not push a sentinel over `/` and drop /calendar.
  expect(entries).toEqual([{ route: "home", "mynotes.depth": 0 }, { route: "calendar", "mynotes.depth": 1 }]);
  expect(deliver()).toBe(true);
  expect(history.state).toEqual({ route: "calendar", "mynotes.depth": 1 });
  unregister();
  dialog();
  await Bun.sleep(5);
  expect(entries).toHaveLength(2);
  expect(index).toBe(1);
});

test("Back that closes the inner of two stacked dialogs above depth 0 lets the undo land, with no sentinel", () => {
  // Board (depth 0), then a card (depth 1) with Manage tags and a colour sheet open over it.
  const entries: unknown[] = [{ route: "board", "mynotes.depth": 0 }, { route: "card", "mynotes.depth": 1 }];
  let index = 1;
  const history = {
    get state() { return entries[index]; },
    pushState(state: unknown) { entries.splice(index + 1, entries.length, state); index += 1; },
    back() { index -= 1; }
  };
  const env = { history: history as unknown as History, href: () => "https://nook.test/", phone: () => true };
  const outer = acquireDialogSentinel(env);
  const inner = acquireDialogSentinel(env);
  expect(entries).toHaveLength(2);
  let innerOpen = true;
  let undo = 0;
  const unregister = registerHistoryDialogGuard(() => {
    if (!innerOpen) return false;
    innerOpen = false;
    undoDialogPop("back", (delta) => { undo = delta; });
    return true;
  });
  // Back: the browser shows the board entry until the guard's history.go(1) lands.
  history.back();
  expect(popStateClosedDialog({ state: history.state })).toBe(true);
  expect(undo).toBe(1);
  // The inner sheet unmounts meanwhile: no sentinel may be pushed over the board entry.
  inner();
  expect(entries).toEqual([{ route: "board", "mynotes.depth": 0 }, { route: "card", "mynotes.depth": 1 }]);
  // The undo lands (ignored) on the card, which needs no sentinel at depth 1.
  index += 1;
  expect(popStateClosedDialog({ state: history.state })).toBe(true);
  expect(entries).toHaveLength(2);
  expect(history.state).toEqual({ route: "card", "mynotes.depth": 1 });
  unregister();
  outer();
});

test("a guard handing Back over to a prompt at depth 1 keeps the board entry and its forward entry", async () => {
  // A fresh /tasks (depth 0), then a board (depth 1) with New card open: no sentinel (D18).
  const entries: unknown[] = [{ route: "tasks", "mynotes.depth": 0 }, { route: "board", "mynotes.depth": 1 }];
  let index = 1;
  const moves: number[] = [];
  const history = {
    get state() { return entries[index]; },
    pushState(state: unknown) { entries.splice(index + 1, entries.length, state); index += 1; },
    back() { moves.push(-1); }
  };
  const env = { history: history as unknown as History, href: () => "https://nook.test/tasks", phone: () => true };
  // Moves land (and fire popstate) only when delivered, like a browser.
  const deliver = () => { index += moves.shift()!; return popStateClosedDialog({ state: entries[index] }); };
  const composer = acquireDialogSentinel(env);
  expect(entries).toHaveLength(2);
  let promptDepth = -1;
  let prompt: (() => void) | null = null;
  let handedOver = false;
  const unregister = registerHistoryDialogGuard(() => {
    if (handedOver) return false;
    handedOver = true;
    // CardComposer (and CardDialog's unsaved description): Back undoes the move, then the same tick
    // swaps the closing guard for the Discard prompt's guard.
    undoDialogPop("back", (delta) => moves.push(delta));
    composer();
    prompt = acquireDialogSentinel(env);
    whenHistorySettled(() => { promptDepth = (history.state as Record<string, number>)["mynotes.depth"]!; });
    return true;
  });
  history.back();
  expect(deliver()).toBe(true);
  expect(index).toBe(0);
  // The undo is in flight: nothing is pushed over /tasks, and the prompt's depth is not read yet.
  expect(entries).toEqual([{ route: "tasks", "mynotes.depth": 0 }, { route: "board", "mynotes.depth": 1 }]);
  expect(promptDepth).toBe(-1);
  // The undo lands (ignored) on the board: still no sentinel at depth 1, and the prompt reads depth 1.
  expect(deliver()).toBe(true);
  expect(index).toBe(1);
  expect(entries).toHaveLength(2);
  expect(promptDepth).toBe(1);
  unregister();
  prompt!();
  await Bun.sleep(5);
  expect(entries).toHaveLength(2);
  expect(history.state).toEqual({ route: "board", "mynotes.depth": 1 });
  // A later, real popstate goes through.
  expect(popStateClosedDialog({ state: entries[0] })).toBe(false);
});

test("whenHistorySettled runs at once with no ignored move in flight; a cancelled waiter never runs", () => {
  let ran = 0;
  whenHistorySettled(() => { ran += 1; });
  expect(ran).toBe(1);
  undoDialogPop("back", () => undefined);
  const cancel = whenHistorySettled(() => { ran += 1; });
  cancel();
  expect(popStateClosedDialog({ state: null })).toBe(true);
  expect(ran).toBe(1);
});

// Like a browser with a forward stack: back() and forward() move when their popstate is delivered.
function twoWayHistory(initial: unknown) {
  const entries: unknown[] = [initial];
  let index = 0;
  const moves: number[] = [];
  const history = {
    get state() { return entries[index]; },
    pushState(state: unknown) { entries.splice(index + 1, entries.length, state); index += 1; },
    back() { moves.push(-1); },
    forward() { moves.push(1); }
  };
  const deliver = () => {
    const delta = moves.shift();
    expect(delta).toBeDefined();
    index += delta!;
    return popStateClosedDialog({ state: entries[index] });
  };
  return { history, deliver, index: () => index, entries, pending: () => moves.length, env: { history: history as unknown as History, href: () => "https://nook.test/calendar", phone: () => true } };
}

test("phone Forward after Back closed a sheet off the sentinel reopens it, and Back closes it again (Friction 12)", async () => {
  const base = { route: "calendar", "mynotes.depth": 0 };
  const { history, deliver, index, entries, pending, env } = twoWayHistory(base);
  let open = false;
  let release: (() => void) | null = null;
  const show = () => { open = true; release = acquireDialogSentinel(env); };
  const unregister = registerHistoryDialogGuard(createDialogGuard({
    isOpen: () => open,
    markClosed: () => undefined,
    close: () => { open = false; release?.(); },
    openDepth: () => 1,
    reopen: () => show
  }));
  show();
  expect(entries).toEqual([base, dialogSentinelState(base)]);
  // Back pops the sentinel and closes the sheet in place.
  history.back();
  expect(deliver()).toBe(true);
  expect(open).toBe(false);
  await Bun.sleep(5);
  expect(pending()).toBe(0);
  // Forward lands on the sentinel again: the sheet reopens on it, and no second sentinel is pushed.
  history.forward();
  expect(deliver()).toBe(true);
  expect(open).toBe(true);
  expect(index()).toBe(1);
  expect(entries).toHaveLength(2);
  // The next Back is not a dead step: it closes the sheet again, still in Calendar.
  history.back();
  expect(deliver()).toBe(true);
  expect(open).toBe(false);
  expect(index()).toBe(0);
  await Bun.sleep(5);
  expect(pending()).toBe(0);
  unregister();
  // A real navigation later goes through.
  expect(popStateClosedDialog({ state: base })).toBe(false);
});

test("Forward onto a sentinel with nothing to reopen steps back off it, so Back is never dead (Friction 12)", async () => {
  const base = { route: "settings", "mynotes.depth": 0 };
  const { history, deliver, index, pending, env } = twoWayHistory(base);
  // Closed with Escape: the release pops the sentinel (ignored), leaving it as the forward entry.
  const release = acquireDialogSentinel(env);
  release();
  await Bun.sleep(5);
  expect(deliver()).toBe(true);
  expect(index()).toBe(0);
  history.forward();
  expect(deliver()).toBe(true);
  // Stepped straight back, and that move is ignored too.
  expect(pending()).toBe(1);
  expect(deliver()).toBe(true);
  expect(index()).toBe(0);
  // An offer outside a Back off the sentinel is ignored.
  offerDialogReopen(() => { throw new Error("never"); });
  history.forward();
  expect(deliver()).toBe(true);
  expect(deliver()).toBe(true);
  expect(index()).toBe(0);
  expect(popStateClosedDialog({ state: base })).toBe(false);
});

test("a reopen whose owner shows nothing steps back off the sentinel after a moment", async () => {
  const base = { route: "calendar", "mynotes.depth": 0 };
  const { history, deliver, index, pending, env } = twoWayHistory(base);
  let open = true;
  let release: (() => void) | null = acquireDialogSentinel(env);
  const unregister = registerHistoryDialogGuard(createDialogGuard({
    isOpen: () => open, markClosed: () => undefined, close: () => { open = false; release?.(); release = null; }, openDepth: () => 1,
    reopen: () => () => undefined
  }));
  history.back();
  expect(deliver()).toBe(true);
  await Bun.sleep(5);
  history.forward();
  expect(deliver()).toBe(true);
  expect(index()).toBe(1);
  expect(pending()).toBe(0);
  await Bun.sleep(350);
  expect(pending()).toBe(1);
  expect(deliver()).toBe(true);
  expect(index()).toBe(0);
  unregister();
  expect(popStateClosedDialog({ state: base })).toBe(false);
});

test("the Calendar and the key dialogs offer their layer back to Forward (Friction 12)", async () => {
  const calendar = await Bun.file(new URL("../src/calendar/CalendarApp.tsx", import.meta.url)).text();
  expect(calendar).toMatch(/if \(calendarsOpen \|\| sharing \|\| feeds \|\| picker \|\| reminderPicker\) offerDialogReopen\(/);
  const keys = await Bun.file(new URL("../src/keys/KeysSettings.tsx", import.meta.url)).text();
  expect(keys).toContain("<HistoryDialogReopen.Provider value={dialog ? () => setDialog(dialog) : null}>");
  const hook = await Bun.file(new URL("../src/ui/useHistoryDialogGuard.ts", import.meta.url)).text();
  expect(hook).toContain("reopenRef.current = options.reopen ?? ownerReopen;");
});

test("phone Back off the sentinel while a dialog is busy keeps it open, puts the sentinel back, and offers no reopen", async () => {
  const base = { route: "settings", "mynotes.depth": 0 };
  const { history, deliver, index, entries, pending, env } = twoWayHistory(base);
  let open = true;
  let busy = true;
  let reopened = 0;
  let release: (() => void) | null = acquireDialogSentinel(env);
  const unregister = registerHistoryDialogGuard(createDialogGuard({
    isOpen: () => open, markClosed: () => undefined, close: () => { open = false; release?.(); release = null; }, openDepth: () => 0,
    blocked: () => busy,
    reopen: () => () => { reopened += 1; }
  }));
  history.back();
  expect(deliver()).toBe(true);
  // Still open, and the sentinel is pushed again under it.
  expect(open).toBe(true);
  expect(index()).toBe(1);
  expect(entries).toEqual([base, dialogSentinelState(base)]);
  expect(pending()).toBe(0);
  // Once idle, Back closes it and Forward reopens it.
  busy = false;
  history.back();
  expect(deliver()).toBe(true);
  expect(open).toBe(false);
  await Bun.sleep(5);
  history.forward();
  expect(deliver()).toBe(true);
  expect(reopened).toBe(1);
  unregister();
  await Bun.sleep(350);
  while (pending() > 0) deliver();
  expect(popStateClosedDialog({ state: base })).toBe(false);
});
