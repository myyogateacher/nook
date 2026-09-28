// D18: browser Back/Forward while an in-app dialog or sheet is open only closes it. Dialogs push no
// history entry, so the open app registers a guard that closes its dialog and then undoes the
// browser's move with history.go(), whose own popstate is ignored once. Every popstate handler asks
// first, so the first one to see the event runs the guard and the others skip it. Listener order on
// window is registration order, which is why this is a shared check instead of a capture-phase listener.
//
// The one exception is an entry at depth 0 on a phone (a fresh load of `/` or a deep link): there is
// no in-app entry below it, so Back would leave Nook before any popstate could close the dialog.
// Opening a guarded dialog there pushes one sentinel entry (same URL, depth 1, a `mynotes.dialog`
// hint); Back pops it and only closes the dialog, and closing the dialog any other way pops it again
// with history.back(), whose popstate is ignored. A dialog opened before that popstate lands gets its
// sentinel once it has (the pop cannot be cancelled), and an in-app navigation from the sentinel
// replaces it instead of pushing a second entry on top (takeDialogSentinelEntry).
import { useEffect } from "react";
import { readHistoryDepth, withHistoryDepth } from "./appShellNavigation";
import { isMobileViewport } from "./mobileNavigation";

/** Receives the state of the entry the browser moved to; returns true when it closed a dialog. */
type DialogGuard = (poppedState: unknown) => boolean;

// A stack: the app on screen registers one guard, and shared chrome (the notification bell's
// popover) may register another. The newest guard is asked first; the first to close a dialog wins.
const guards: DialogGuard[] = [];
let ignoring = 0;
let ignoreTimer: ReturnType<typeof setTimeout> | null = null;
const consumed = new WeakSet<object>();
// While a popstate left the depth-0 sentinel, guards close their dialog but must not undo the move.
let suppressUndo = 0;
// Friction 12: Back from the sentinel leaves it as the forward entry. Forward onto it reopens the layer
// Back closed when that layer's owner offered a way to (offerDialogReopen); otherwise the move is
// undone, so the sentinel is never a dead entry that the next Back has to step through.
let closingFromSentinel = false;
let offeredReopen: (() => void) | null = null;
let reopenOnForward: (() => void) | null = null;
const REOPEN_CHECK_MS = 300;

/**
 * Called by a guard as it closes its layer: when that close came from Back off the sentinel, Forward
 * onto the sentinel calls `reopen` to show the layer again. Any other close ignores the offer.
 */
export function offerDialogReopen(reopen: () => void) {
  if (closingFromSentinel) offeredReopen = reopen;
}

// Set when a busy (blocked) layer refused a Back off the sentinel: it stays open, so it needs the
// sentinel back, or the next Back would leave the dialog's entry.
let heldFromSentinel = false;

/** Called by a blocked guard that kept its layer open: a Back off the sentinel pushes the sentinel again. */
export function holdDialogSentinel() {
  if (closingFromSentinel) heldFromSentinel = true;
}

/** Registers a guard for the dialogs of the app on screen (or shared chrome). Returns the unregister function. */
export function registerHistoryDialogGuard(next: DialogGuard) {
  guards.push(next);
  return () => {
    const index = guards.lastIndexOf(next);
    if (index >= 0) guards.splice(index, 1);
  };
}

function runGuards(state: unknown) {
  for (let index = guards.length - 1; index >= 0; index -= 1) if (guards[index]!(state)) return true;
  return false;
}

/** True when this popstate only closed a dialog (or undid that move), so the caller must not restore a route for it. */
export function popStateClosedDialog(event: { state?: unknown }) {
  if (consumed.has(event)) return true;
  if (ignoring > 0) {
    ignoring -= 1;
    consumed.add(event);
    if (pendingSentinelPop) resolveSentinelPop();
    if (ignoring === 0) flushSettled();
    return true;
  }
  if (sentinelActive && !isDialogSentinelState(event.state)) {
    // Back from the sentinel onto the dialog's own entry: close the dialog and stay there.
    sentinelActive = false;
    suppressUndo += 1;
    closingFromSentinel = true;
    offeredReopen = null;
    heldFromSentinel = false;
    try { runGuards(event.state); } finally { suppressUndo -= 1; closingFromSentinel = false; }
    reopenOnForward = offeredReopen;
    offeredReopen = null;
    if (heldFromSentinel) {
      heldFromSentinel = false;
      reopenOnForward = null;
      if (lastSentinelEnv) pushSentinelIfNeeded(lastSentinelEnv);
    }
    consumed.add(event);
    return true;
  }
  if (!sentinelActive && openDialogs === 0 && isDialogSentinelState(event.state)) {
    // Forward onto a sentinel whose layer is closed: reopen that layer on it, or step back off it.
    consumed.add(event);
    const reopen = reopenOnForward;
    reopenOnForward = null;
    const history = lastSentinelEnv?.history ?? window.history;
    if (reopen) {
      sentinelActive = true;
      reopen();
      // The owner is gone (or showed nothing): step back off the sentinel after all.
      setTimeout(() => {
        if (!sentinelActive || openDialogs > 0 || !isDialogSentinelState(history.state)) return;
        sentinelActive = false;
        ignoreNextPop();
        history.back();
      }, REOPEN_CHECK_MS);
    } else {
      ignoreNextPop();
      history.back();
    }
    return true;
  }
  reopenOnForward = null;
  if (!runGuards(event.state)) return false;
  consumed.add(event);
  return true;
}

export type PopDirection = "back" | "forward";

/**
 * Which way the browser moved, from the `mynotes.depth` of the entry the dialog was opened on and of
 * the entry it moved to. Null when the depths match and the direction cannot be told.
 */
export function dialogPopDirection(openDepth: number, poppedDepth: number): PopDirection | null {
  if (poppedDepth < openDepth) return "back";
  if (poppedDepth > openDepth) return "forward";
  return null;
}

/** The history.go() delta that returns to the entry the dialog was opened on. */
export const undoPopDelta = (direction: PopDirection) => direction === "back" ? 1 : -1;

function ignoreNextPop() {
  ignoring += 1;
  // A move that never fires popstate must not swallow a later, real one.
  if (ignoreTimer) clearTimeout(ignoreTimer);
  ignoreTimer = setTimeout(() => { ignoring = 0; ignoreTimer = null; pendingSentinelPop = null; flushSettled(); }, 1000);
}

// Callbacks waiting for an ignored move (an undo's history.go or the sentinel's history.back) to land.
const settleWaiters = new Set<() => void>();

function flushSettled() {
  const waiting = [...settleWaiters];
  settleWaiters.clear();
  for (const callback of waiting) callback();
}

/**
 * Runs `callback` once no ignored move is in flight: now, or when its popstate lands. A dialog that
 * opens while an undo is on its way (one guard handing over to a prompt in the same tick) reads
 * history.state then, not while it still names the entry Back landed on. Returns the cancel function.
 */
export function whenHistorySettled(callback: () => void) {
  if (ignoring === 0) { callback(); return () => undefined; }
  settleWaiters.add(callback);
  return () => { settleWaiters.delete(callback); };
}

/** Moves back to the dialog's entry and ignores the popstate that move causes. */
export function undoDialogPop(direction: PopDirection, go: (delta: number) => void = (delta) => window.history.go(delta)) {
  if (suppressUndo > 0) return;
  ignoreNextPop();
  go(undoPopDelta(direction));
}

const dialogHintKey = "mynotes.dialog";

/** True for the entry pushed under a dialog opened at depth 0. */
export function isDialogSentinelState(state: unknown) {
  return Boolean(state && typeof state === "object" && (state as Record<string, unknown>)[dialogHintKey] === true);
}

/**
 * Whether opening a guarded dialog on the entry with `state` must push a sentinel: only on a phone,
 * only at depth 0, and only when no sentinel is already in place. Deeper entries keep D18 (no entry).
 */
export function needsDialogSentinel(state: unknown, options: { phone: boolean; active: boolean }) {
  return options.phone && !options.active && readHistoryDepth(state) === 0 && !isDialogSentinelState(state);
}

/** The sentinel entry's state: the current entry's state, one level deeper, with the dialog hint. */
export function dialogSentinelState(state: unknown) {
  const base = state && typeof state === "object" ? state as Record<string, unknown> : {};
  return withHistoryDepth({ ...base, [dialogHintKey]: true }, readHistoryDepth(state) + 1);
}

type SentinelHistory = Pick<History, "state" | "pushState" | "back">;
type SentinelEnv = { history: SentinelHistory; href: () => string; phone: () => boolean };
let openDialogs = 0;
let sentinelActive = false;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
// Set while the history.back() that pops the sentinel has not fired its popstate yet: the env of the
// release, and whether a dialog opened meanwhile and still wants a sentinel.
let pendingSentinelPop: { env: SentinelEnv } | null = null;
// The env the last sentinel was pushed on (the window's history, or a test's).
let lastSentinelEnv: SentinelEnv | null = null;

function pushSentinelIfNeeded(env: SentinelEnv) {
  if (openDialogs > 0 && needsDialogSentinel(env.history.state, { phone: env.phone(), active: sentinelActive })) {
    env.history.pushState(dialogSentinelState(env.history.state), "", env.href());
    sentinelActive = true;
    lastSentinelEnv = env;
    reopenOnForward = null;
  }
}

/** The sentinel's pop landed: a dialog opened while it was on its way gets its own sentinel now. */
function resolveSentinelPop() {
  const pending = pendingSentinelPop!;
  pendingSentinelPop = null;
  pushSentinelIfNeeded(pending.env);
}

/**
 * Called by an in-app navigation about to push an entry. True when the current entry is the dialog
 * sentinel: the navigation must replace it (keeping its depth) rather than push on top, and the
 * sentinel is no longer held, so closing the dialog later pops nothing.
 */
export function takeDialogSentinelEntry(state: unknown) {
  if (!sentinelActive || !isDialogSentinelState(state)) return false;
  sentinelActive = false;
  return true;
}

/**
 * Marks a guarded dialog open. The first one opened at depth 0 on a phone pushes the sentinel; the
 * returned release pops it once the last dialog closed by any means other than Back. The pop waits a
 * tick so a dialog that replaces another keeps the same sentinel.
 */
export function acquireDialogSentinel(env: SentinelEnv = defaultSentinelEnv(false)) {
  openDialogs += 1;
  if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
  // history.state still reads the old sentinel (or, while a guard's undo is in flight, the entry Back
  // landed on) until that pop lands; resolveSentinelPop pushes then. Pushing now would drop the
  // dialog's own entry from the forward stack and leave the undo nowhere to go.
  if (openDialogs === 1 && !pendingSentinelPop) {
    if (ignoring === 0) pushSentinelIfNeeded(env);
    else pendingSentinelPop = { env };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openDialogs = Math.max(0, openDialogs - 1);
    if (openDialogs > 0) {
      // Back from the sentinel closed only the innermost of stacked dialogs (a dropdown sheet over
      // a sheet): the ones still open need a sentinel again, or the next Back would leave Nook.
      // Not while an undo (history.go) is in flight: history.state still reads the entry Back
      // landed on, and pushing there would drop the dialog's own entry from the forward stack.
      if (!pendingSentinelPop && ignoring === 0) pushSentinelIfNeeded(env);
      return;
    }
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      if (openDialogs > 0 || !sentinelActive) return;
      sentinelActive = false;
      // An in-app navigation pushed past the sentinel: it is an ordinary entry now.
      if (!isDialogSentinelState(env.history.state)) return;
      ignoreNextPop();
      pendingSentinelPop = { env };
      env.history.back();
    }, 0);
  };
}

/**
 * The window's history. `desktop` opts a dialog into the sentinel at every width (2i): the Inbox
 * routine sheet and the dropdowns inside it, so a deep link's Back closes one layer at a time there too.
 */
export function defaultSentinelEnv(desktop: boolean): SentinelEnv {
  return { history: window.history, href: () => window.location.href, phone: () => desktop || (typeof window.matchMedia === "function" && isMobileViewport()) };
}

/** Holds the depth-0 sentinel while `open` (see acquireDialogSentinel); `desktop` holds it at every width. */
export function useDialogSentinel(open: boolean, desktop = false) {
  useEffect(() => open ? acquireDialogSentinel(defaultSentinelEnv(desktop)) : undefined, [open, desktop]);
}
