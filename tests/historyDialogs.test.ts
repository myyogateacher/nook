import { afterEach, expect, test } from "bun:test";
import { acquireDialogSentinel, defaultSentinelEnv, dialogSentinelState, holdDialogSentinel, isDialogSentinelState, needsDialogSentinel, readLandingEntry, offerDialogReopen, popStateClosedDialog, registerHistoryDialogGuard, resetHistoryDialogsForTests, takeDialogSentinelEntry, undoDialogPop, whenHistorySettled } from "../src/historyDialogs";
import { createDialogGuard } from "../src/ui/useHistoryDialogGuard";
import { guardDialogPop } from "../src/calendar/hooks";
import { readHistoryDepth, withHistoryDepth } from "../src/appShellNavigation";

// The module keeps its layers and sentinels across tests; each test starts clean.
afterEach(() => { resetHistoryDialogsForTests(); });

test("the window env reads the landing depth, at every width (A1)", () => {
  const holder = globalThis as { window?: unknown };
  const previous = holder.window;
  holder.window = { history: { state: null }, location: { href: "https://nook.test/inbox/routines" }, matchMedia: () => ({ matches: false }) };
  try {
    expect(defaultSentinelEnv().href()).toBe("https://nook.test/inbox/routines");
    expect(typeof defaultSentinelEnv().landingDepth()).toBe("number");
  } finally {
    holder.window = previous;
  }
});

test("every dropdown popup and the routine sheet are their own history layers at every width (2i, A2)", async () => {
  const pane = await Bun.file(new URL("../src/inbox/RoutinesPane.tsx", import.meta.url)).text();
  expect(pane).toContain("useHistoryDialogGuard(true, onClose);");
  expect(pane).not.toContain("DesktopHistoryLayers");
  expect(pane).toContain("useDialogFocus(sheetRef)");
  expect(pane).toContain("onKeyDown={trapTabKey}");
  const listbox = await Bun.file(new URL("../src/ui/Listbox.tsx", import.meta.url)).text();
  const popup = listbox.slice(listbox.indexOf("function DropdownPopup"), listbox.indexOf("function DropdownSheet"));
  expect(popup).toContain("useHistoryDialogGuard(true, onClose, { reopen: null })");
  const css = await Bun.file(new URL("../src/ui/ui.css", import.meta.url)).text();
  expect(css).toContain(".ui-chip-remove { width: 44px; height: 44px;");
  // The sort menus of Notes and Files are dropdowns too.
  for (const file of ["../src/App.tsx", "../src/files/FilesApp.tsx"]) {
    const source = await Bun.file(new URL(file, import.meta.url)).text();
    expect(source).toContain("useHistoryDialogGuard(sortOpen, () => setSortOpen(false))");
  }
});

test("a sentinel is pushed for a dialog opened on any page entry, at any width (A1, D479)", () => {
  // A fresh load or deep link: the landing entry is at depth 0.
  expect(needsDialogSentinel(null, { landingDepth: 0, active: false })).toBe(true);
  expect(needsDialogSentinel({ "mynotes.depth": 0 }, { landingDepth: 0, active: false })).toBe(true);
  // A reload of an entry the page had pushed (depth 3): its entry below is another document now.
  expect(needsDialogSentinel({ "mynotes.depth": 3 }, { landingDepth: 3, active: false })).toBe(true);
  expect(needsDialogSentinel({ "mynotes.depth": 1 }, { landingDepth: 3, active: false })).toBe(true);
  // D479: entries this page pushed get one too (D18 used to push nothing there and undo Back in place).
  expect(needsDialogSentinel({ "mynotes.depth": 2 }, { landingDepth: 0, active: false })).toBe(true);
  expect(needsDialogSentinel({ "mynotes.depth": 4 }, { landingDepth: 3, active: false })).toBe(true);
  // Never a second one for the same layer, nor one on a sentinel (a nested layer goes through acquire).
  expect(needsDialogSentinel(null, { landingDepth: 0, active: true })).toBe(false);
  expect(needsDialogSentinel(dialogSentinelState(null), { landingDepth: 0, active: false })).toBe(false);
});

test("the landing entry is read once at load; a reloaded sentinel loses its hint (A1)", () => {
  const replaced: unknown[] = [];
  const history = { state: dialogSentinelState(withHistoryDepth({ route: "tasks" }, 2)) as unknown, replaceState(state: unknown) { replaced.push(state); this.state = state; } };
  expect(readLandingEntry(history as unknown as History, "https://nook.test/tasks")).toBe(3);
  expect(replaced).toEqual([{ route: "tasks", "mynotes.depth": 3 }]);
  expect(isDialogSentinelState(history.state)).toBe(false);
  // An ordinary entry is left alone.
  const plain = { state: null as unknown, replaceState() { throw new Error("not expected"); } };
  expect(readLandingEntry(plain as unknown as History)).toBe(0);
  expect(readLandingEntry(undefined)).toBe(0);
});

test("the sentinel keeps the entry's state one level deeper with the dialog hint", () => {
  const state = dialogSentinelState({ route: "home" });
  expect(state).toEqual({ route: "home", "mynotes.dialog": true, "mynotes.depth": 1 });
  expect(isDialogSentinelState(state)).toBe(true);
  expect(isDialogSentinelState({ route: "home" })).toBe(false);
});

/** A sentinel over `base`, whatever its layer id. */
const sentinelOf = (base: unknown) => expect.objectContaining(dialogSentinelState(base));

function fakeHistory(initial: unknown) {
  const entries: unknown[] = [initial];
  let index = 0;
  const history = {
    get state() { return entries[index]; },
    pushState(state: unknown) { entries.splice(index + 1, entries.length, state); index += 1; },
    back() { index -= 1; }
  };
  return { history, env: { history: history as unknown as History, href: () => "https://nook.test/", landingDepth: () => 0 } };
}

test("closing the dialog by other means pops the sentinel and ignores that popstate", async () => {
  const { history, env } = fakeHistory({ route: "home" });
  const release = acquireDialogSentinel(env);
  expect(isDialogSentinelState(history.state)).toBe(true);
  // A second dialog replacing the first keeps the same sentinel (React runs the old layer's cleanup first).
  release();
  const second = acquireDialogSentinel(env);
  expect(history.state).toMatchObject({ route: "home", "mynotes.depth": 1 });
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
  return { history, deliver, entries: () => entries.slice(0, index + 1), env: { history: history as unknown as History, href: () => "https://nook.test/", landingDepth: () => 0 } };
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
  expect(entries()).toEqual([{ route: "home" }, sentinelOf({ route: "home" })]);
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

test("Back that closes the inner of two stacked dialogs leaves the outer one on its own sentinel (D478)", async () => {
  const { history, deliver, entries, env } = asyncHistory({ route: "collection", "mynotes.depth": 0 });
  const outer = acquireDialogSentinel(env);
  const inner = acquireDialogSentinel(env);
  // Each layer sits on its own sentinel.
  expect(entries()).toHaveLength(3);
  let innerOpen = true;
  const unregister = registerHistoryDialogGuard(() => { if (!innerOpen) return false; innerOpen = false; return false; });
  // Back pops the sentinel and closes only the inner dialog (a dropdown sheet over a sheet).
  history.back();
  expect(deliver()).toBe(true);
  expect(innerOpen).toBe(false);
  inner();
  // The outer dialog is still open on its own sentinel: the next Back closes it in place.
  expect(entries()).toEqual([{ route: "collection", "mynotes.depth": 0 }, sentinelOf({ route: "collection", "mynotes.depth": 0 })]);
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

test("on a pushed entry each layer sits on its own sentinel; Back closes the top one and moves no further (D479)", async () => {
  // A fresh `/` (depth 0), then /calendar (depth 1): the dialog and the sheet over it each push a sentinel.
  const entries: unknown[] = [{ route: "home", "mynotes.depth": 0 }, { route: "calendar", "mynotes.depth": 1 }];
  let index = 1;
  const moves: number[] = [];
  const history = {
    get state() { return entries[index]; },
    pushState(state: unknown) { entries.splice(index + 1, entries.length, state); index += 1; },
    back() { moves.push(-1); }
  };
  const env = { history: history as unknown as History, href: () => "https://nook.test/", landingDepth: () => 0 };
  // Moves land (and fire popstate) only when delivered, like a browser.
  const deliver = () => { index += moves.shift()!; return popStateClosedDialog({ state: entries[index] }); };
  const dialog = acquireDialogSentinel(env);
  const sheet = acquireDialogSentinel(env);
  expect(entries).toHaveLength(4);
  let sheetOpen = true;
  const unregister = registerHistoryDialogGuard(() => {
    if (!sheetOpen) return false;
    sheetOpen = false;
    // The sheet's guard asks for the old undo: off a sentinel it is never made.
    undoDialogPop("back", (delta) => moves.push(delta));
    return true;
  });
  history.back();
  expect(deliver()).toBe(true);
  expect(sheetOpen).toBe(false);
  expect(moves).toEqual([]);
  sheet();
  // On the dialog's sentinel over /calendar: /home and /calendar are untouched, the sheet's entry is ahead.
  expect(index).toBe(2);
  expect(entries.slice(0, 2)).toEqual([{ route: "home", "mynotes.depth": 0 }, { route: "calendar", "mynotes.depth": 1 }]);
  expect(entries).toHaveLength(4);
  unregister();
  // Closing the dialog by other means pops its sentinel (ignored): back on /calendar.
  dialog();
  await Bun.sleep(5);
  expect(deliver()).toBe(true);
  expect(history.state).toEqual({ route: "calendar", "mynotes.depth": 1 });
});

test("Back that closes the inner of two stacked dialogs above depth 0 leaves the outer one on its sentinel (D479)", async () => {
  // Board (depth 0), then a card (depth 1) with Manage tags and a colour sheet open over it.
  const entries: unknown[] = [{ route: "board", "mynotes.depth": 0 }, { route: "card", "mynotes.depth": 1 }];
  let index = 1;
  const history = {
    get state() { return entries[index]; },
    pushState(state: unknown) { entries.splice(index + 1, entries.length, state); index += 1; },
    back() { index -= 1; }
  };
  const env = { history: history as unknown as History, href: () => "https://nook.test/", landingDepth: () => 0 };
  const outer = acquireDialogSentinel(env);
  const inner = acquireDialogSentinel(env);
  expect(entries).toHaveLength(4);
  let innerOpen = true;
  let undo = 0;
  const unregister = registerHistoryDialogGuard(() => {
    if (!innerOpen) return false;
    innerOpen = false;
    undoDialogPop("back", (delta) => { undo = delta; });
    return true;
  });
  history.back();
  expect(popStateClosedDialog({ state: history.state })).toBe(true);
  // Off a sentinel: no undo, and the outer layer's sentinel is where Back landed.
  expect(undo).toBe(0);
  inner();
  expect(index).toBe(2);
  expect(isDialogSentinelState(history.state)).toBe(true);
  expect(entries.slice(0, 2)).toEqual([{ route: "board", "mynotes.depth": 0 }, { route: "card", "mynotes.depth": 1 }]);
  unregister();
  outer();
  await Bun.sleep(5);
  expect(history.state).toEqual({ route: "card", "mynotes.depth": 1 });
  // The ignored pop of the outer sentinel.
  expect(popStateClosedDialog({ state: history.state })).toBe(true);
});

test("a guard handing Back over to a prompt at depth 1 keeps the board entry; the prompt gets its own sentinel (D479)", async () => {
  // A fresh /tasks (depth 0), then a board (depth 1) with New card open on its own sentinel.
  const entries: unknown[] = [{ route: "tasks", "mynotes.depth": 0 }, { route: "board", "mynotes.depth": 1 }];
  let index = 1;
  const moves: number[] = [];
  const history = {
    get state() { return entries[index]; },
    pushState(state: unknown) { entries.splice(index + 1, entries.length, state); index += 1; },
    back() { moves.push(-1); }
  };
  const env = { history: history as unknown as History, href: () => "https://nook.test/tasks", landingDepth: () => 0 };
  // Moves land (and fire popstate) only when delivered, like a browser.
  const deliver = () => { index += moves.shift()!; return popStateClosedDialog({ state: entries[index] }); };
  const composer = acquireDialogSentinel(env);
  expect(entries).toHaveLength(3);
  let promptDepth = -1;
  let prompt: (() => void) | null = null;
  let handedOver = false;
  const unregister = registerHistoryDialogGuard(() => {
    if (handedOver) return false;
    handedOver = true;
    // CardComposer (and CardDialog's unsaved description): Back swaps the closing guard for the
    // Discard prompt's guard in the same tick.
    undoDialogPop("back", (delta) => moves.push(delta));
    composer();
    prompt = acquireDialogSentinel(env);
    whenHistorySettled(() => { promptDepth = (history.state as Record<string, number>)["mynotes.depth"]!; });
    return true;
  });
  history.back();
  expect(deliver()).toBe(true);
  // No undo off a sentinel; the prompt pushed its own sentinel over the board and read its depth.
  expect(moves).toEqual([]);
  expect(index).toBe(2);
  expect(entries.slice(0, 2)).toEqual([{ route: "tasks", "mynotes.depth": 0 }, { route: "board", "mynotes.depth": 1 }]);
  expect(isDialogSentinelState(history.state)).toBe(true);
  expect(promptDepth).toBe(2);
  unregister();
  prompt!();
  await Bun.sleep(5);
  expect(deliver()).toBe(true);
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
    replaceState(state: unknown) { entries[index] = state; },
    back() { moves.push(-1); },
    forward() { moves.push(1); },
    go(delta: number) { moves.push(delta); }
  };
  const deliver = () => {
    const delta = moves.shift();
    expect(delta).toBeDefined();
    index += delta!;
    return popStateClosedDialog({ state: entries[index] });
  };
  return { history, deliver, index: () => index, entries, pending: () => moves.length, env: { history: history as unknown as History, href: () => "https://nook.test/calendar", landingDepth: () => 0 } };
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
  expect(entries).toEqual([base, sentinelOf(base)]);
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
  expect(keys).toContain("<HistoryDialogReopen.Provider value={dialog && reopenOnForward ? () => setDialog(dialog) : null}>");
  // Team → Integrations turns the reopen off, like its other sheets (Wave 36 review Q-L1).
  expect(keys).toContain("reopenOnForward = true");
  const hook = await Bun.file(new URL("../src/ui/useHistoryDialogGuard.ts", import.meta.url)).text();
  expect(hook).toContain("reopenRef.current = options.reopen === undefined ? ownerReopen : options.reopen;");
  // A dropdown inside a key dialog never offers the dialog's reopen as its own (D478).
  const listbox = await Bun.file(new URL("../src/ui/Listbox.tsx", import.meta.url)).text();
  expect(listbox.match(/useHistoryDialogGuard\(true, onClose, \{ reopen: null \}\)/g)).toHaveLength(2);
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
  expect(entries).toEqual([base, sentinelOf(base)]);
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

// A1: a tab where the page was loaded on `entries[landing]`. Entries before it belong to another
// site or document: a move onto one leaves the page (no popstate), which `left` records. Moves by
// the app (back, go) land when delivered, like a browser; `userBack` and `userForward` are the
// browser's buttons.
function tab(entries: unknown[], landing: number) {
  let index = entries.length - 1;
  const moves: number[] = [];
  let left = false;
  const history = {
    get state() { return entries[index]; },
    pushState(state: unknown) { entries.splice(index + 1, entries.length, state); index += 1; },
    replaceState(state: unknown) { entries[index] = state; },
    back() { moves.push(-1); }
  };
  const landingDepth = readHistoryDepth(entries[landing]);
  const env = { history: history as unknown as History, href: () => "https://nook.test/team/groups", landingDepth: () => landingDepth };
  const move = (delta: number) => {
    index += delta;
    if (index < landing) { left = true; return false; }
    return popStateClosedDialog({ state: entries[index] });
  };
  const deliverAll = async () => { await Bun.sleep(5); while (moves.length) move(moves.shift()!); };
  return {
    env, history, entries, index: () => index, left: () => left, deliverAll,
    userBack: () => move(-1),
    userForward: () => move(1),
    go: (delta: number) => { moves.push(delta); }
  };
}

/** One layer as useHistoryDialogGuard mounts it; closing unmounts it after the popstate handler, as React commits. */
function layer(harness: ReturnType<typeof tab>, name: string, closed: string[]) {
  let open = true;
  let depth = readHistoryDepth(harness.history.state);
  const release = acquireDialogSentinel(harness.env);
  const cancel = whenHistorySettled(() => { depth = readHistoryDepth(harness.history.state); });
  let unregister = () => undefined as void;
  const unmount = () => { release(); cancel(); unregister(); };
  unregister = registerHistoryDialogGuard(createDialogGuard({
    isOpen: () => open, markClosed: () => { open = false; }, close: () => { closed.push(name); queueMicrotask(unmount); },
    openDepth: () => depth, undo: (direction) => undoDialogPop(direction, harness.go)
  }));
  return { isOpen: () => open, close: () => { open = false; unmount(); } };
}

for (const [label, entries] of [
  ["a fresh load", [withHistoryDepth({ route: "groups" }, 0)]],
  ["a deep link opened after another site", [{ site: "elsewhere" }, null]],
  ["a reload of an entry the page had pushed", [{ site: "elsewhere" }, withHistoryDepth({ route: "tasks" }, 2), withHistoryDepth({ route: "tasks" }, 3)]]
] as const) {
  test(`${label}: one Back closes the open dialog and stays; with none open, Back leaves (A1)`, async () => {
    const harness = tab([...entries], entries.length - 1);
    const closed: string[] = [];
    const landingIndex = harness.index();
    layer(harness, "new group", closed);
    expect(isDialogSentinelState(harness.history.state)).toBe(true);
    expect(harness.userBack()).toBe(true);
    await harness.deliverAll();
    expect(closed).toEqual(["new group"]);
    expect(harness.index()).toBe(landingIndex);
    expect(harness.left()).toBe(false);
    // Forward onto the sentinel with nothing to reopen steps back off it: no dead entry.
    expect(harness.userForward()).toBe(true);
    await harness.deliverAll();
    expect(harness.index()).toBe(landingIndex);
    // No dialog open: Back is an ordinary Back and leaves the page (no history trap).
    harness.userBack();
    expect(harness.left()).toBe(true);
  });
}

test("in-app navigation: a dialog on a pushed entry takes a sentinel; Back closes it in place, never leaving (A1, D479)", async () => {
  const harness = tab([withHistoryDepth({ route: "home" }, 0)], 0);
  harness.history.pushState(withHistoryDepth({ route: "tasks" }, 1));
  const closed: string[] = [];
  layer(harness, "share", closed);
  expect(harness.entries).toHaveLength(3);
  expect(isDialogSentinelState(harness.history.state)).toBe(true);
  expect(harness.userBack()).toBe(true);
  expect(closed).toEqual(["share"]);
  await harness.deliverAll();
  expect(harness.index()).toBe(1);
  expect(harness.left()).toBe(false);
  // Forward onto the sentinel of a layer with no reopen steps straight back off it.
  expect(harness.userForward()).toBe(true);
  await harness.deliverAll();
  expect(harness.index()).toBe(1);
});

test("nested layers on the landing entry: each Back closes only the top one, then Back leaves (A1, A2)", async () => {
  const harness = tab([null], 0);
  const closed: string[] = [];
  layer(harness, "sheet", closed);
  layer(harness, "dropdown", closed);
  // Each layer sits on its own sentinel (D478).
  expect(harness.entries).toHaveLength(3);
  expect(harness.userBack()).toBe(true);
  await harness.deliverAll();
  expect(closed).toEqual(["dropdown"]);
  // The sheet still open is on its own sentinel.
  expect(isDialogSentinelState(harness.history.state)).toBe(true);
  expect(harness.userBack()).toBe(true);
  await harness.deliverAll();
  expect(closed).toEqual(["dropdown", "sheet"]);
  expect(harness.index()).toBe(0);
  harness.userBack();
  expect(harness.left()).toBe(true);
});

test("nested layers on a pushed entry: Back closes the dropdown, then the sheet, and the page stays (A2)", async () => {
  const harness = tab([withHistoryDepth({ route: "home" }, 0)], 0);
  harness.history.pushState(withHistoryDepth({ route: "board" }, 1));
  const closed: string[] = [];
  layer(harness, "sheet", closed);
  layer(harness, "dropdown", closed);
  // D479: each layer has its own sentinel over the board entry.
  expect(harness.entries).toHaveLength(4);
  expect(harness.userBack()).toBe(true);
  await harness.deliverAll();
  expect(closed).toEqual(["dropdown"]);
  expect(harness.index()).toBe(2);
  expect(harness.userBack()).toBe(true);
  await harness.deliverAll();
  expect(closed).toEqual(["dropdown", "sheet"]);
  expect(harness.index()).toBe(1);
  expect(harness.left()).toBe(false);
});

test("a dialog closed by its own button on the landing entry pops its sentinel; Back then leaves (A1)", async () => {
  const harness = tab([null], 0);
  const dialog = layer(harness, "rename", []);
  expect(harness.entries).toHaveLength(2);
  dialog.close();
  await harness.deliverAll();
  expect(harness.index()).toBe(0);
  harness.userBack();
  expect(harness.left()).toBe(true);
});

// v0.13.0 fix C1: a dialog opened from a settings-style dialog is a layer above it.
test("Board settings → Share board on the landing entry: Back closes the sheet, then settings, then leaves (C1)", async () => {
  const harness = tab([{ site: "elsewhere" }, withHistoryDepth({ route: "board" }, 0)], 1);
  const closed: string[] = [];
  const settings = layer(harness, "settings", closed);
  layer(harness, "access", closed);
  expect(harness.userBack()).toBe(true);
  await harness.deliverAll();
  expect(closed).toEqual(["access"]);
  expect(settings.isOpen()).toBe(true);
  // Settings still open holds a fresh sentinel, so the next Back stays in Nook.
  expect(isDialogSentinelState(harness.history.state)).toBe(true);
  expect(harness.userBack()).toBe(true);
  await harness.deliverAll();
  expect(closed).toEqual(["access", "settings"]);
  expect(harness.left()).toBe(false);
  harness.userBack();
  expect(harness.left()).toBe(true);
});

test("Board settings → Share board with unsaved changes: Back asks first, Keep editing keeps both layers (C1, B4)", async () => {
  const harness = tab([withHistoryDepth({ route: "board" }, 0)], 0);
  const closed: string[] = [];
  const settings = layer(harness, "settings", closed);
  const access = layer(harness, "access", closed);
  // The sheet's dirty guard (its own layer while dirty): Back hands over to the Discard / Keep
  // editing prompt, which React mounts in the same commit that unmounts the dirty guard.
  const asked: string[] = [];
  layer(harness, "discard?", asked);
  expect(harness.userBack()).toBe(true);
  await Bun.sleep(1);
  expect(asked).toEqual(["discard?"]);
  const prompt = layer(harness, "prompt", closed);
  await harness.deliverAll();
  expect(closed).toEqual([]);
  expect(isDialogSentinelState(harness.history.state)).toBe(true);
  // Back on the prompt is Keep editing: the sheet and settings stay, and Back still stays in Nook.
  expect(harness.userBack()).toBe(true);
  await harness.deliverAll();
  expect(closed).toEqual(["prompt"]);
  expect(prompt.isOpen()).toBe(false);
  expect(access.isOpen() && settings.isOpen()).toBe(true);
  expect(harness.left()).toBe(false);
  expect(isDialogSentinelState(harness.history.state)).toBe(true);
  expect(harness.userBack()).toBe(true);
  await harness.deliverAll();
  expect(closed).toEqual(["prompt", "access"]);
  expect(harness.userBack()).toBe(true);
  await harness.deliverAll();
  expect(closed).toEqual(["prompt", "access", "settings"]);
  harness.userBack();
  expect(harness.left()).toBe(true);
});

test("Calendars sheet → Share on the landing entry: one guard closes only the Access layer, then the sheet (C1)", async () => {
  const harness = tab([{ site: "elsewhere" }, withHistoryDepth({ route: "calendar" }, 0)], 1);
  const shown = ["calendars", "sharing"];
  let release: (() => void) | null = acquireDialogSentinel(harness.env);
  const unregister = registerHistoryDialogGuard((state) => shown.length > 0 && guardDialogPop(0, state, (forced) => {
    // CalendarApp: a forced Back off the sentinel with a layer over the Calendars sheet closes that layer only.
    if (forced && shown.length > 1 && holdDialogSentinel()) { shown.pop(); return "keep"; }
    shown.length = 0;
    release?.();
    release = null;
  }, () => undefined, (direction) => undoDialogPop(direction, harness.go)));
  expect(harness.userBack()).toBe(true);
  await harness.deliverAll();
  expect(shown).toEqual(["calendars"]);
  expect(isDialogSentinelState(harness.history.state)).toBe(true);
  expect(harness.userBack()).toBe(true);
  await harness.deliverAll();
  expect(shown).toEqual([]);
  expect(harness.left()).toBe(false);
  unregister();
  await Bun.sleep(5);
  harness.userBack();
  expect(harness.left()).toBe(true);
});

test("Board settings stays mounted under the dialogs it opens; the Calendars sheet keeps its layer (C1)", async () => {
  const board = await Bun.file(new URL("../src/tasks/BoardView.tsx", import.meta.url)).text();
  expect(board).toContain("useHistoryDialogGuard(overSettings, backToSettings, {");
  // D478: Forward reopens Board settings, then the layer over it (never Move to Bin).
  expect(board).toContain("if (overSettingsNow && dialog.kind !== \"deleteBoard\") lastSettingsLayerRef.current = dialog;");
  expect(board).toContain(`{(dialog?.kind === "settings" || overSettings) && board && <BoardSettingsSheet`);
  expect(board).toContain("suspended={overSettings}");
  expect(board).toContain(`onShare={() => openOverSettings("share")}`);
  expect(board).toMatch(/<AccessSheet kind="board" id=\{board\.id\} title=\{board\.name\} onClose=\{closeLayer\} onSaved=\{\(\) => \{\n\s+closeLayer\(\);/);
  const calendar = await Bun.file(new URL("../src/calendar/CalendarApp.tsx", import.meta.url)).text();
  expect(calendar).toContain(`if (forced && calendarsOpen && (sharing || feeds || pendingConfirm?.kind === "deleteCalendar") && holdDialogSentinel())`);
});

test("the Due picker adds no layer of its own: its dropdown popup or sheet is the one layer (C2)", async () => {
  const due = await Bun.file(new URL("../src/tasks/DuePicker.tsx", import.meta.url)).text();
  expect(due).not.toContain("useHistoryDialogGuard");
  expect(due).toContain("<DropdownSurface sheet={sheet}");
});

// D478: one sentinel per layer, and a stack of reopens for Forward.

/** A guarded layer as useHistoryDialogGuard mounts it, with a reopen; closing unmounts it after the popstate, as React commits. */
function stackLayer(harness: ReturnType<typeof twoWayHistory>, name: string, log: string[], options: { reopen?: boolean; busy?: () => boolean } = {}) {
  let open = false;
  let teardown: (() => void) | null = null;
  const unmount = () => { teardown?.(); teardown = null; };
  const show = () => {
    if (open) return;
    open = true;
    log.push(`open ${name}`);
    const release = acquireDialogSentinel(harness.env);
    let depth = readHistoryDepth(harness.history.state);
    const cancel = whenHistorySettled(() => { depth = readHistoryDepth(harness.history.state); });
    const unregister = registerHistoryDialogGuard(createDialogGuard({
      isOpen: () => open, markClosed: () => { open = false; }, close: () => { log.push(`close ${name}`); queueMicrotask(unmount); },
      openDepth: () => depth, blocked: options.busy, undo: (direction) => undoDialogPop(direction, (delta) => harness.history.go(delta)),
      reopen: () => options.reopen === false ? null : show
    }));
    teardown = () => { release(); cancel(); unregister(); };
  };
  return { show, isOpen: () => open, close: () => { if (!open) return; open = false; log.push(`× ${name}`); unmount(); } };
}

async function settleAll(harness: ReturnType<typeof twoWayHistory>) {
  for (let round = 0; round < 10; round += 1) {
    await Bun.sleep(5);
    if (harness.pending() === 0) return;
    while (harness.pending() > 0) harness.deliver();
  }
}

test("nested layers: each Back closes the top one; Forward reopens them in order, each on its own entry (D478)", async () => {
  const base = { route: "reports", "mynotes.depth": 0 };
  const harness = twoWayHistory(base);
  const log: string[] = [];
  const changes = stackLayer(harness, "changes", log);
  const versions = stackLayer(harness, "versions", log);
  changes.show();
  versions.show();
  expect(harness.entries).toHaveLength(3);
  expect(harness.index()).toBe(2);
  // Back closes Versions, then Changes; the page stays on its own entry.
  harness.history.back();
  expect(harness.deliver()).toBe(true);
  await settleAll(harness);
  expect([changes.isOpen(), versions.isOpen()]).toEqual([true, false]);
  expect(harness.index()).toBe(1);
  harness.history.back();
  expect(harness.deliver()).toBe(true);
  await settleAll(harness);
  expect(changes.isOpen()).toBe(false);
  expect(harness.index()).toBe(0);
  expect(harness.entries).toHaveLength(3);
  // Forward reopens Changes on its entry, then Versions on the next, with no new entries.
  harness.history.forward();
  expect(harness.deliver()).toBe(true);
  await settleAll(harness);
  expect([changes.isOpen(), versions.isOpen()]).toEqual([true, false]);
  harness.history.forward();
  expect(harness.deliver()).toBe(true);
  await settleAll(harness);
  expect([changes.isOpen(), versions.isOpen()]).toEqual([true, true]);
  expect(harness.index()).toBe(2);
  expect(harness.entries).toHaveLength(3);
  // And Back still closes one layer at a time.
  harness.history.back();
  harness.deliver();
  await settleAll(harness);
  harness.history.back();
  harness.deliver();
  await settleAll(harness);
  expect([changes.isOpen(), versions.isOpen()]).toEqual([false, false]);
  expect(harness.index()).toBe(0);
  expect(log).toEqual(["open changes", "open versions", "close versions", "close changes", "open changes", "open versions", "close versions", "close changes"]);
  expect(popStateClosedDialog({ state: base })).toBe(false);
});

test("Back from the inner layer, then Forward: only the inner layer comes back (D478)", async () => {
  const base = { route: "tasks", "mynotes.depth": 0 };
  const harness = twoWayHistory(base);
  const log: string[] = [];
  const card = stackLayer(harness, "card", log);
  const picker = stackLayer(harness, "picker", log);
  card.show();
  picker.show();
  harness.history.back();
  harness.deliver();
  await settleAll(harness);
  harness.history.forward();
  expect(harness.deliver()).toBe(true);
  await settleAll(harness);
  expect([card.isOpen(), picker.isOpen()]).toEqual([true, true]);
  expect(harness.index()).toBe(2);
  picker.close();
  card.close();
  await settleAll(harness);
  expect(harness.index()).toBe(0);
  expect(popStateClosedDialog({ state: base })).toBe(false);
});

test("a layer closed with × is not reopened: Forward onto its entry steps back off it (D478)", async () => {
  const base = { route: "reports", "mynotes.depth": 0 };
  const harness = twoWayHistory(base);
  const log: string[] = [];
  const changes = stackLayer(harness, "changes", log);
  const versions = stackLayer(harness, "versions", log);
  changes.show();
  versions.show();
  // × pops Versions' sentinel (an ignored move).
  versions.close();
  await settleAll(harness);
  expect(harness.index()).toBe(1);
  // Back closes Changes; Forward reopens it; Forward onto Versions' old entry steps straight back.
  harness.history.back();
  harness.deliver();
  await settleAll(harness);
  harness.history.forward();
  harness.deliver();
  await settleAll(harness);
  expect(changes.isOpen()).toBe(true);
  harness.history.forward();
  expect(harness.deliver()).toBe(true);
  await settleAll(harness);
  expect(versions.isOpen()).toBe(false);
  expect(harness.index()).toBe(1);
  // A layer whose owner offers no reopen (a confirm) is stepped over the same way.
  const confirm = stackLayer(harness, "confirm", log, { reopen: false });
  confirm.show();
  expect(harness.index()).toBe(2);
  harness.history.back();
  harness.deliver();
  await settleAll(harness);
  harness.history.forward();
  harness.deliver();
  await settleAll(harness);
  expect(confirm.isOpen()).toBe(false);
  expect(harness.index()).toBe(1);
  changes.close();
  await settleAll(harness);
  expect(harness.index()).toBe(0);
  expect(popStateClosedDialog({ state: base })).toBe(false);
});

test("Back off a busy inner layer keeps it on a fresh sentinel; the outer one keeps its own (D478)", async () => {
  const base = { route: "reports", "mynotes.depth": 0 };
  const harness = twoWayHistory(base);
  const log: string[] = [];
  let busy = true;
  const changes = stackLayer(harness, "changes", log);
  const versions = stackLayer(harness, "versions", log, { busy: () => busy });
  changes.show();
  versions.show();
  harness.history.back();
  expect(harness.deliver()).toBe(true);
  await settleAll(harness);
  expect(versions.isOpen()).toBe(true);
  expect(harness.index()).toBe(2);
  expect(isDialogSentinelState(harness.history.state)).toBe(true);
  busy = false;
  harness.history.back();
  harness.deliver();
  await settleAll(harness);
  expect([changes.isOpen(), versions.isOpen()]).toEqual([true, false]);
  harness.history.forward();
  harness.deliver();
  await settleAll(harness);
  expect(versions.isOpen()).toBe(true);
  versions.close();
  changes.close();
  await settleAll(harness);
  expect(harness.index()).toBe(0);
  expect(popStateClosedDialog({ state: base })).toBe(false);
});

test("closing both layers at once pops both sentinels in one move (D478)", async () => {
  const base = { route: "reports", "mynotes.depth": 0 };
  const harness = twoWayHistory(base);
  const log: string[] = [];
  const changes = stackLayer(harness, "changes", log);
  const versions = stackLayer(harness, "versions", log);
  changes.show();
  versions.show();
  versions.close();
  changes.close();
  await Bun.sleep(5);
  expect(harness.pending()).toBe(1);
  expect(harness.deliver()).toBe(true);
  expect(harness.index()).toBe(0);
  expect(popStateClosedDialog({ state: base })).toBe(false);
});

test("an in-app navigation from a nested sentinel replaces it; the one below is the page's entry again (D478)", async () => {
  const base = { route: "reports", "mynotes.depth": 0 };
  const harness = twoWayHistory(base);
  const log: string[] = [];
  const changes = stackLayer(harness, "changes", log);
  const versions = stackLayer(harness, "versions", log);
  changes.show();
  versions.show();
  expect(takeDialogSentinelEntry(harness.history.state)).toBe(true);
  harness.history.replaceState({ route: "note", "mynotes.depth": 2 });
  versions.close();
  changes.close();
  await settleAll(harness);
  expect(harness.index()).toBe(2);
  // Back onto the sentinel left below: an ordinary entry of the report now, shown by the routes.
  harness.history.back();
  expect(harness.deliver()).toBe(false);
  expect(isDialogSentinelState(harness.history.state)).toBe(false);
  expect(harness.history.state).toEqual({ route: "reports", "mynotes.depth": 1 });
  expect(popStateClosedDialog({ state: base })).toBe(false);
});

test("inspect tab entries over a nested sentinel stay with the inspect guard (D478)", async () => {
  const base = { route: "reports", "mynotes.depth": 0 };
  const harness = twoWayHistory(base);
  const log: string[] = [];
  const sheet = stackLayer(harness, "inspect", log);
  sheet.show();
  const tabs: string[] = [];
  // A tab entry over the sheet's sentinel, like createInspectTabHistory pushes.
  const sentinel = harness.history.state as Record<string, unknown>;
  harness.history.pushState(withHistoryDepth({ ...sentinel, "mynotes.inspect": { tab: "data" } }, 2));
  const unregister = registerHistoryDialogGuard((state) => {
    const mark = (state as Record<string, unknown> | null)?.["mynotes.inspect"];
    if (mark) { tabs.push("data"); return true; }
    if (readHistoryDepth(state) === 1 && tabs[tabs.length - 1] !== "query") { tabs.push("query"); return true; }
    return false;
  });
  harness.history.back();
  expect(harness.deliver()).toBe(true);
  expect(tabs).toEqual(["query"]);
  expect(sheet.isOpen()).toBe(true);
  harness.history.forward();
  expect(harness.deliver()).toBe(true);
  expect(tabs).toEqual(["query", "data"]);
  unregister();
  sheet.close();
  await settleAll(harness);
});
