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
import { useEffect, useRef } from "react";
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
// A layer reopened by its key may wait for its page to mount and load (H3): a longer check.
const KEYED_REOPEN_CHECK_MS = 2500;

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
      if (top.key) rememberBackClosed(top.id, top.key, top.depth);
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
    const key = id === null ? null : backClosed.get(id)?.key ?? null;
    if (id !== null) { forwardReopens.delete(id); backClosed.delete(id); }
    const history = lastEnv?.history ?? window.history;
    if (id !== null && (reopen || key)) {
      const adopt = { id, depth: readHistoryDepth(event.state), history };
      adopting = adopt;
      // The owner still mounted shows the layer itself; after the page remounted (Back went past
      // it, then Forward came back), the layer's key finds whoever opens it now (H3).
      if (reopen) reopen();
      else openByKey(key!);
      // The owner is gone (or showed nothing): step back off the sentinel after all.
      setTimeout(() => {
        if (adopting !== adopt) return;
        adopting = null;
        if (pendingOpen?.key === key) pendingOpen = null;
        if (layerIdOf(history.state) !== id) return;
        ignoreNextPop();
        history.back();
      }, reopen ? REOPEN_CHECK_MS : KEYED_REOPEN_CHECK_MS);
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
 * Whether opening a guarded dialog on the entry with `state` must push a sentinel: on every page entry,
 * at every width, unless one is already in place (D479). Before D479 only the landing entry (depth at
 * or below `landingDepth`) got one and deeper entries undid Back in place (D18), which left Forward
 * nothing to reopen. A layer opened over a layer's sentinel nests its own (D478).
 */
export function needsDialogSentinel(state: unknown, options: { landingDepth: number; active: boolean }) {
  return !options.active && !isDialogSentinelState(state);
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
type Entry = { id: string; depth: number; env: SentinelEnv; released: boolean; key?: string };
/** One open guarded layer, in the order they opened, and the sentinel it sits on (if any). */
type Layer = { env: SentinelEnv; entry: Entry | null; key?: string };

const layers: Layer[] = [];
const held: Entry[] = [];
// The forward entries Back closed layers off: sentinel id → the reopen its layer offered (or null).
const forwardReopens = new Map<string, (() => void) | null>();

// H3: the layers Back closed, by sentinel id, with the layer's key ("kind" or "kind:id"; never data
// beyond ids) and the sentinel's depth. Unlike `forwardReopens` it outlives the page that owned the
// layers: Back past the page and Forward again remounts it, and the key finds the opener mounted
// now (registerLayerOpener). Kept in module memory for this document only, capped, and cleared by
// an explicit close and by any push (which drops the forward entries).
const MAX_BACK_CLOSED = 50;
const backClosed = new Map<string, { key: string; depth: number }>();
const openers = new Map<string, (arg: string) => void>();
// A key Forward is reopening whose opener has not mounted yet (the page is still loading).
let pendingOpen: { key: string } | null = null;

function rememberBackClosed(id: string, key: string, depth: number) {
  backClosed.delete(id);
  backClosed.set(id, { key, depth });
  while (backClosed.size > MAX_BACK_CLOSED) backClosed.delete(backClosed.keys().next().value!);
}

function forgetBackClosedAbove(depth: number) {
  for (const [id, record] of backClosed) if (record.depth > depth) backClosed.delete(id);
}

const kindOf = (key: string) => key.split(":", 1)[0]!;
const argOf = (key: string) => key.includes(":") ? key.slice(key.indexOf(":") + 1) : "";

function openByKey(key: string) {
  const open = openers.get(kindOf(key));
  if (open) open(argOf(key));
  else pendingOpen = { key };
}

/**
 * Registers how the component mounted now opens the layers of one kind (H3), e.g. the report page
 * for "reports.changes", the Changes panel for "reports.versions". Forward onto the sentinel of a
 * layer Back closed calls it with the key's id part when the owner that offered the reopen is gone.
 * Returns the unregister function.
 */
export function registerLayerOpener(kind: string, open: (arg: string) => void) {
  openers.set(kind, open);
  if (pendingOpen && kindOf(pendingOpen.key) === kind) {
    const { key } = pendingOpen;
    pendingOpen = null;
    open(argOf(key));
  }
  return () => { if (openers.get(kind) === open) openers.delete(kind); };
}

/** registerLayerOpener while mounted. */
export function useLayerOpener(kind: string, open: (arg: string) => void) {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => registerLayerOpener(kind, (arg) => openRef.current(arg)), [kind]);
}
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
    const entry: Entry = { id, depth: adopting.depth, env: layer.env, released: false, key: layer.key };
    adopting = null;
    held.push(entry);
    layer.entry = entry;
    lastEnv = layer.env;
    return;
  }
  const top = held[held.length - 1];
  const overTop = top !== undefined && id === top.id && readHistoryDepth(state) === top.depth;
  if (top ? !overTop : !needsDialogSentinel(state, { landingDepth: layer.env.landingDepth(), active: false })) return;
  const entry: Entry = { id: newLayerId(), depth: readHistoryDepth(state) + 1, env: layer.env, released: false, key: layer.key };
  history.pushState(dialogSentinelState(state, entry.id), "", layer.env.href());
  // The push dropped every forward entry, and with them the layers Back had closed.
  backClosed.clear();
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
    // Closed by ×, Escape, or a choice: nothing above the entry under it is reopened any more (H3).
    forgetBackClosedAbove(top.depth - count);
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
  backClosed.clear();
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
export function acquireDialogSentinel(env: SentinelEnv = defaultSentinelEnv(), key?: string) {
  const layer: Layer = { env, entry: null, key };
  layers.push(layer);
  const top = held[held.length - 1];
  // A dialog replacing one that closed this tick takes over its sentinel.
  if (top?.released && top.env.history === env.history) {
    top.released = false;
    // The entry is this layer's now: Forward after Back past the page reopens it by its key (D480).
    top.key = key;
    layer.entry = top;
  } else {
    armLayer(layer);
  }
  let released = false;
  /**
   * L1: a Back button inside the layer steps the browser back off the layer's own sentinel, as browser
   * Back does, so Forward reopens the layer. False (nothing moved) when the layer's entry is not the
   * current top one (no sentinel, a move in flight, or a layer over it): the caller closes it instead.
   */
  const back = () => {
    const entry = layer.entry;
    if (released || !entry || entry.released || held[held.length - 1] !== entry || ignoring > 0 || popInFlight) return false;
    if (layerIdOf(env.history.state) !== entry.id) return false;
    env.history.back();
    return true;
  };
  return Object.assign(() => {
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
  }, { back });
}

/**
 * Tests only: forget every guard, layer, sentinel, reopen, and ignored move (module state outlives a
 * test). tests/support/dom.tsx calls it after every client test, so one that fails mid-way (its
 * dialog never unmounted, its guard still registered) cannot steer the next file's Back.
 */
export function resetHistoryDialogsForTests() {
  guards.length = 0;
  closingFromSentinel = false;
  offeredReopen = null;
  heldFromSentinel = false;
  lastEnv = null;
  layers.length = 0;
  held.length = 0;
  forwardReopens.clear();
  backClosed.clear();
  openers.clear();
  pendingOpen = null;
  stranded.clear();
  adopting = null;
  ignoring = 0;
  popInFlight = false;
  suppressUndo = 0;
  if (ignoreTimer) clearTimeout(ignoreTimer);
  if (releaseTimer) clearTimeout(releaseTimer);
  ignoreTimer = null;
  releaseTimer = null;
  settleWaiters.clear();
}

/** The window's history, and the depth of the entry this page was loaded on. */
export function defaultSentinelEnv(): SentinelEnv {
  return { history: window.history, href: () => window.location.href, landingDepth: () => landingDepth };
}

/** Holds a sentinel while `open` when the dialog opened on the landing entry or over another layer's (see acquireDialogSentinel). */
export function useDialogSentinel(open: boolean, key?: string) {
  const keyRef = useRef(key);
  keyRef.current = key;
  const backRef = useRef<(() => boolean) | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const release = acquireDialogSentinel(defaultSentinelEnv(), keyRef.current);
    backRef.current = release.back;
    return () => { if (backRef.current === release.back) backRef.current = null; release(); };
  }, [open]);
  /** Steps back off this layer's sentinel (see acquireDialogSentinel's `back`); false when it could not. */
  return () => backRef.current?.() ?? false;
}

if (typeof window !== "undefined" && window.history) {
  try { readLandingEntry(window.history, window.location?.href); } catch { /* No history to read (a test's stand-in window). */ }
}
