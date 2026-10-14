// D18: browser Back/Forward while an in-app dialog or sheet is open only closes it. Dialogs push no
// history entry, so the open app registers a guard that closes its dialog and then undoes the
// browser's move with history.go(), whose own popstate is ignored once. Every popstate handler asks
// first, so the first one to see the event runs the guard and the others skip it. Listener order on
// window is registration order, which is why this is a shared check instead of a capture-phase listener.
//
// The undo only works when the entry below belongs to this document: one this page pushed itself.
// The entry the page was loaded on (a fresh load, a deep link, a reload, or a Back or Forward that
// loaded the page again) has no such entry below it, at any width: Back would leave Nook, or load the
// page below from scratch, before any popstate could close the dialog. Opening a guarded dialog on an
// entry at or below the depth of that landing entry pushes a sentinel entry (same URL, one level
// deeper, a `mynotes.dialog` hint and a `mynotes.layer` id); Back pops it and only closes the dialog,
// and closing the dialog any other way pops it again with history.back(), whose popstate is ignored.
// A dialog opened before that popstate lands gets its sentinel once it has (the pop cannot be
// cancelled), and an in-app navigation from the sentinel replaces it instead of pushing a second entry
// on top (takeDialogSentinelEntry).
//
// D478: sentinels form a stack, one per layer. A guarded layer opened over a layer that holds a
// sentinel pushes its own, one level deeper, so each layer owns the entry it sits on. Back off the top
// sentinel closes the top layer and leaves its entry as a forward entry, remembering the reopen the
// layer offered (offerDialogReopen) under that entry's id. Forward onto it calls that reopen and the
// layer that opens adopts the entry; Forward again does the same for the next layer up. A layer closed
// any other way (×, Escape, a choice) pops its entry with no reopen, so Forward steps straight back
// off it (no dead entry).
import { useEffect } from "react";
import { readHistoryDepth, withHistoryDepth } from "./appShellNavigation";

/** Receives the state of the entry the browser moved to; returns true when it closed a dialog. */
type DialogGuard = (poppedState: unknown) => boolean;

// A stack: the app on screen registers one guard, and shared chrome (the notification bell's
// popover) may register another. The newest guard is asked first; the first to close a dialog wins.
const guards: DialogGuard[] = [];
let ignoring = 0;
let ignoreTimer: ReturnType<typeof setTimeout> | null = null;
const consumed = new WeakSet<object>();
// While a popstate left a sentinel, guards close their dialog but must not undo the move.
let suppressUndo = 0;
// Friction 12, D478: Back from a sentinel leaves it as a forward entry. Forward onto it reopens the
// layer Back closed when that layer's owner offered a way to (offerDialogReopen); otherwise the move
// is undone, so a sentinel is never a dead entry that the next Back has to step through.
let closingFromSentinel = false;
let offeredReopen: (() => void) | null = null;
const REOPEN_CHECK_MS = 300;

/**
 * Called by a guard as it closes its layer: when that close came from Back off the layer's sentinel,
 * Forward onto that sentinel calls `reopen` to show the layer again. Any other close ignores the offer.
 */
export function offerDialogReopen(reopen: () => void) {
  if (closingFromSentinel) offeredReopen = reopen;
}

// Set when a busy (blocked) layer refused a Back off the sentinel: it stays open, so it needs the
// sentinel back, or the next Back would leave the dialog's entry.
let heldFromSentinel = false;

/**
 * Called by a guard that kept a layer open (a blocked one, or one that closed only the layer over
 * another): a Back off the sentinel pushes the sentinel again. True when this is such a Back.
 */
export function holdDialogSentinel() {
  if (closingFromSentinel) heldFromSentinel = true;
  return closingFromSentinel;
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
    if (ignoring === 0) settle();
    return true;
  }
  const top = held[held.length - 1];
  if (top && readHistoryDepth(event.state) < top.depth) {
    // Back off the top sentinel: close the top layer and stay on the entry below (the page, or the
    // sentinel of the layer under it). The sentinel left behind is the forward entry.
    held.pop();
    const owner = layers.find((layer) => layer.entry === top);
    if (owner) owner.entry = null;
    suppressUndo += 1;
    closingFromSentinel = true;
    offeredReopen = null;
    heldFromSentinel = false;
    try { runGuards(event.state); } finally { suppressUndo -= 1; closingFromSentinel = false; }
    const reopen = offeredReopen;
    offeredReopen = null;
    if (heldFromSentinel) {
      // The layer stayed open: it takes a sentinel again (the forward entry goes).
      heldFromSentinel = false;
      armLayers();
    } else {
      forwardReopens.set(top.id, reopen);
    }
    consumed.add(event);
    return true;
  }
  const id = layerIdOf(event.state);
  if (id !== null && stranded.has(id)) {
    // A sentinel an in-app navigation left below itself (it replaced only the top one): an ordinary
    // entry of the page under the dialogs now, so the route handlers show it.
    stranded.delete(id);
    stripDialogHint(id);
    forwardReopens.clear();
    return false;
  }
  if (isDialogSentinelState(event.state) && (id !== null ? !held.some((entry) => entry.id === id) : layers.length === 0 && held.length === 0)) {
    // A sentinel whose layer is closed (Forward onto it): reopen that layer on it, or step back off it.
    consumed.add(event);
    const reopen = id === null ? null : forwardReopens.get(id) ?? null;
    if (id !== null) forwardReopens.delete(id);
    const history = lastEnv?.history ?? window.history;
    if (reopen && id !== null) {
      const adopt = { id, depth: readHistoryDepth(event.state), history };
      adopting = adopt;
      reopen();
      // The owner is gone (or showed nothing): step back off the sentinel after all.
      setTimeout(() => {
        if (adopting !== adopt) return;
        adopting = null;
        if (layerIdOf(history.state) !== id) return;
        ignoreNextPop();
        history.back();
      }, REOPEN_CHECK_MS);
    } else {
      ignoreNextPop();
      history.back();
    }
    return true;
  }
  forwardReopens.clear();
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
  ignoreTimer = setTimeout(() => { ignoring = 0; ignoreTimer = null; settle(); }, 1000);
}

// Callbacks waiting for an ignored move (an undo's history.go or the sentinel's history.back) to land.
const settleWaiters = new Set<() => void>();

/** No ignored move is in flight any more: layers that waited get their sentinels, then the waiters run. */
function settle() {
  popInFlight = false;
  armLayers();
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
const layerKey = "mynotes.layer";

/** True for an entry pushed over the page for a dialog opened there (a sentinel). */
export function isDialogSentinelState(state: unknown) {
  return Boolean(state && typeof state === "object" && (state as Record<string, unknown>)[dialogHintKey] === true);
}

/** The id of the sentinel an entry is (or sits on, for the inspect sheet's tab entries); null for none. */
export function layerIdOf(state: unknown): string | null {
  if (!isDialogSentinelState(state)) return null;
  const id = (state as Record<string, unknown>)[layerKey];
  return typeof id === "string" ? id : null;
}

function withoutDialogHint(state: unknown) {
  const rest = { ...(state as Record<string, unknown>) };
  delete rest[dialogHintKey];
  delete rest[layerKey];
  return rest;
}

/**
 * The depth of the entry this document was loaded on. Every entry this page pushed since is deeper
 * (pushes go one level down from the current entry), so an entry at or below it may have another
 * document, or another site, right below it.
 */
let landingDepth = 0;

/**
 * Reads the landing entry when the page loads (once, at import). A reload of a sentinel entry drops
 * its hint: no dialog holds it any more, and it is the landing entry now.
 */
export function readLandingEntry(history: Pick<History, "state" | "replaceState"> | undefined, href = "") {
  if (!history) return 0;
  landingDepth = readHistoryDepth(history.state);
  if (isDialogSentinelState(history.state)) history.replaceState(withoutDialogHint(history.state), "", href);
  return landingDepth;
}

/**
 * Whether opening a guarded dialog on the entry with `state` must push a sentinel: when the entry is
 * not one this page pushed (its depth is at or below `landingDepth`, the landing entry's), at every
 * width, and only when no sentinel is already in place. Deeper entries keep D18 (no entry: the undo
 * moves back onto them within the page). A layer opened over a layer's sentinel nests its own (D478).
 */
export function needsDialogSentinel(state: unknown, options: { landingDepth: number; active: boolean }) {
  return !options.active && !isDialogSentinelState(state) && readHistoryDepth(state) <= options.landingDepth;
}

/** The sentinel entry's state: the current entry's state, one level deeper, with the dialog hint and the layer's id. */
export function dialogSentinelState(state: unknown, id?: string) {
  const base = state && typeof state === "object" ? state as Record<string, unknown> : {};
  const next: Record<string, unknown> = { ...base, [dialogHintKey]: true };
  if (id === undefined) delete next[layerKey];
  else next[layerKey] = id;
  return withHistoryDepth(next, readHistoryDepth(state) + 1);
}

type SentinelHistory = Pick<History, "state" | "pushState" | "back"> & Partial<Pick<History, "go" | "replaceState">>;
type SentinelEnv = { history: SentinelHistory; href: () => string; landingDepth: () => number };
/** One sentinel entry this page pushed and still holds, bottom to top in `held`. */
type Entry = { id: string; depth: number; env: SentinelEnv; released: boolean };
/** One open guarded layer, in the order they opened, and the sentinel it sits on (if any). */
type Layer = { env: SentinelEnv; entry: Entry | null };

const layers: Layer[] = [];
const held: Entry[] = [];
// The forward entries Back closed layers off: sentinel id → the reopen its layer offered (or null).
const forwardReopens = new Map<string, (() => void) | null>();
// Forward landed on a closed layer's sentinel and called its reopen: the next layer to open takes it.
let adopting: { id: string; depth: number; history: SentinelHistory } | null = null;
// Sentinels an in-app navigation left below the one it replaced (takeDialogSentinelEntry).
const stranded = new Set<string>();
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
// Set while the history.back() that pops released sentinels has not fired its popstate yet.
let popInFlight = false;
// The env the last sentinel was pushed on (the window's history, or a test's).
let lastEnv: SentinelEnv | null = null;
let nextId = 0;

function newLayerId() {
  nextId += 1;
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `${random}-${nextId}`;
}

function stripDialogHint(id: string) {
  const history = lastEnv?.history ?? (typeof window === "undefined" ? null : window.history);
  if (!history?.replaceState || layerIdOf(history.state) !== id) return;
  const href = lastEnv?.href() ?? window.location.href;
  history.replaceState(withoutDialogHint(history.state), "", href);
}

/**
 * Gives `layer` its sentinel when it needs one: the entry Forward is reopening it on, a new sentinel
 * over the top one (a layer over a layer), or the first one over the landing entry. Waits while an
 * ignored move is in flight: history.state still names the entry Back landed on, and pushing there
 * would drop the dialog's own entry from the forward stack (settle arms it then).
 */
function armLayer(layer: Layer) {
  if (layer.entry || ignoring > 0 || popInFlight) return;
  const { history } = layer.env;
  const state = history.state;
  const id = layerIdOf(state);
  if (adopting && id === adopting.id && history === adopting.history) {
    const entry: Entry = { id, depth: adopting.depth, env: layer.env, released: false };
    adopting = null;
    held.push(entry);
    layer.entry = entry;
    lastEnv = layer.env;
    return;
  }
  const top = held[held.length - 1];
  const overTop = top !== undefined && id === top.id && readHistoryDepth(state) === top.depth;
  if (top ? !overTop : !needsDialogSentinel(state, { landingDepth: layer.env.landingDepth(), active: false })) return;
  const entry: Entry = { id: newLayerId(), depth: readHistoryDepth(state) + 1, env: layer.env, released: false };
  history.pushState(dialogSentinelState(state, entry.id), "", layer.env.href());
  held.push(entry);
  layer.entry = entry;
  lastEnv = layer.env;
  // The push dropped every forward entry.
  forwardReopens.clear();
  adopting = null;
}

/** Every open layer without a sentinel that needs one gets it, bottom to top. */
function armLayers() {
  for (const layer of [...layers]) armLayer(layer);
}

/** Pops the released sentinels at the top of the stack (one history move), once the tick is over. */
function scheduleRelease() {
  if (releaseTimer) return;
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    let count = 0;
    while (held.length > count && held[held.length - 1 - count]!.released) count += 1;
    if (count === 0) return;
    const top = held[held.length - 1]!;
    const { history } = top.env;
    const onTop = layerIdOf(history.state) === top.id;
    held.splice(held.length - count, count);
    // An in-app navigation (or a move) went past the sentinels: they are ordinary entries now.
    if (!onTop) return;
    ignoreNextPop();
    popInFlight = true;
    if (count === 1 || !history.go) history.back();
    else history.go(-count);
  }, 0);
}

/**
 * Called by an in-app navigation about to push an entry. True when the current entry is the top
 * dialog sentinel: the navigation must replace it (keeping its depth) rather than push on top, and no
 * sentinel is held any more, so closing the dialogs later pops nothing. Sentinels below it stay in
 * the history as entries of the page under the dialogs.
 */
export function takeDialogSentinelEntry(state: unknown) {
  const top = held[held.length - 1];
  if (!top || !isDialogSentinelState(state) || layerIdOf(state) !== top.id) return false;
  for (const entry of held.slice(0, -1)) stranded.add(entry.id);
  held.length = 0;
  for (const layer of layers) layer.entry = null;
  forwardReopens.clear();
  return true;
}

/**
 * Runs `callback` once every guarded dialog has closed and its sentinel entry (if one was pushed on
 * the landing entry) has been popped, so a navigation that replaces the current entry replaces the
 * page's own entry rather than the sentinel (QA L6: leaving a vault from its settings on a deep link
 * left a duplicate entry). Waits at most a few ticks for the release, then for the history to settle.
 */
export function afterDialogsReleased(callback: () => void, schedule: (step: () => void) => void = (step) => { setTimeout(step, 0); }) {
  let tries = 0;
  const step = () => {
    if ((layers.length > 0 || releaseTimer !== null || popInFlight) && tries < 20) {
      tries += 1;
      schedule(step);
      return;
    }
    whenHistorySettled(callback);
  };
  schedule(step);
}

/**
 * Marks a guarded dialog open. A dialog opened on the landing entry, or over a layer that holds a
 * sentinel, pushes its own sentinel; the returned release pops it once the dialog closed by any means
 * other than Back. The pop waits a tick so a dialog that replaces another keeps the same sentinel.
 */
export function acquireDialogSentinel(env: SentinelEnv = defaultSentinelEnv()) {
  const layer: Layer = { env, entry: null };
  layers.push(layer);
  const top = held[held.length - 1];
  // A dialog replacing one that closed this tick takes over its sentinel.
  if (top?.released && top.env.history === env.history) {
    top.released = false;
    layer.entry = top;
  } else {
    armLayer(layer);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const index = layers.indexOf(layer);
    if (index >= 0) layers.splice(index, 1);
    const entry = layer.entry;
    layer.entry = null;
    if (entry && held.includes(entry)) {
      entry.released = true;
      scheduleRelease();
      return;
    }
    // Back off a sentinel closed only the innermost of stacked dialogs while another kept the
    // entry (a dropdown sheet over a sheet): the ones still open need a sentinel again, or the next
    // Back would leave Nook.
    armLayers();
  };
}

/** The window's history, and the depth of the entry this page was loaded on. */
export function defaultSentinelEnv(): SentinelEnv {
  return { history: window.history, href: () => window.location.href, landingDepth: () => landingDepth };
}

/** Holds a sentinel while `open` when the dialog opened on the landing entry or over another layer's (see acquireDialogSentinel). */
export function useDialogSentinel(open: boolean) {
  useEffect(() => open ? acquireDialogSentinel(defaultSentinelEnv()) : undefined, [open]);
}

if (typeof window !== "undefined" && window.history) {
  try { readLandingEntry(window.history, window.location?.href); } catch { /* No history to read (a test's stand-in window). */ }
}
