import { useEffect } from "react";
import { ApiError, onApiRecovered } from "../api";
import { canonicalSceneJson, type CanonicalScene } from "../../shared/whiteboardScene";
import { pendingSyncAction } from "./autosave";
import { sceneForLoad } from "./historyGuard";
import { clearPending, listPendingBoards, readPending, type PendingEntry } from "./pendingStore";
import { getWhiteboard, saveWhiteboardScene, type SaveResult, type WhiteboardSummary } from "./whiteboardsApi";

/**
 * QA E5: the background sync of pending copies. A stroke drawn offline stays in the on-device
 * pending copy when its board is closed; once the app is open and online (on start, on the `online`
 * event, and when the whiteboards list is shown) each copy the board's next open would apply
 * silently (an edit on the server's current revision) is sent through the usual CAS save, one at a
 * time. A 409 leaves it for the next open, where it is offered; a 429 or a network error stops the
 * run until the next trigger. Never for a board a canvas has open (the canvas owns its copy), never
 * after the person signed out or another one signed in, and never while offline.
 */

export type SyncDeps = {
  listBoards: () => Promise<string[]>;
  readPending: (boardId: string) => Promise<PendingEntry | null>;
  /** The board as the server has it; throws ApiError (404 or 403 when it is gone or unreadable). */
  getBoard: (boardId: string) => Promise<{ whiteboard: Pick<WhiteboardSummary, "revision" | "canEdit">; scene: CanonicalScene }>;
  save: (boardId: string, baseRevision: number, scene: CanonicalScene) => Promise<SaveResult>;
  clear: (boardId: string) => Promise<void>;
  /** Still signed in as the same person, and online. */
  isCurrent: () => boolean;
  /** A canvas has this board open. */
  isOpen: (boardId: string) => boolean;
  /** A pause between two saves, so a device with many copies stays well inside the save limit. */
  wait?: (ms: number) => Promise<void>;
};

/** The gap between two saves of one run (the server allows 120 saves a minute per person, shared with open canvases). */
export const SYNC_GAP_MS = 1000;

export type SyncResult = { sent: string[]; cleared: string[]; kept: string[]; stopped: null | "rate-limited" | "offline" | "signed-out" };

const liveCount = (scene: CanonicalScene) => scene.elements.length;

export async function syncPendingCopies(deps: SyncDeps): Promise<SyncResult> {
  const result: SyncResult = { sent: [], cleared: [], kept: [], stopped: null };
  if (!deps.isCurrent()) return { ...result, stopped: "signed-out" };
  const boards = await deps.listBoards();
  for (const boardId of boards) {
    if (!deps.isCurrent()) return { ...result, stopped: "signed-out" };
    if (deps.isOpen(boardId)) { result.kept.push(boardId); continue; }
    const pending = await deps.readPending(boardId);
    const pendingScene = pending ? sceneForLoad(pending.scene) : null;
    if (!pending || !pendingScene) { result.kept.push(boardId); continue; }
    let server: Awaited<ReturnType<SyncDeps["getBoard"]>>;
    try {
      server = await deps.getBoard(boardId);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 429) return { ...result, stopped: "rate-limited" };
      if (reason instanceof ApiError && reason.status < 500) { result.kept.push(boardId); continue; }
      return { ...result, stopped: "offline" };
    }
    const serverScene = sceneForLoad(server.scene);
    const action = serverScene
      ? pendingSyncAction(
        { baseRevision: pending.baseRevision, live: liveCount(pendingScene), content: canonicalSceneJson(pendingScene), origin: pending.origin },
        { revision: server.whiteboard.revision, live: liveCount(serverScene), content: canonicalSceneJson(serverScene), canEdit: server.whiteboard.canEdit }
      )
      : "keep";
    if (action === "keep") { result.kept.push(boardId); continue; }
    if (action === "clear") { await deps.clear(boardId); result.cleared.push(boardId); continue; }
    // The person may have signed out, or opened this board, while the board was read.
    if (!deps.isCurrent()) return { ...result, stopped: "signed-out" };
    if (deps.isOpen(boardId)) { result.kept.push(boardId); continue; }
    try {
      await deps.save(boardId, pending.baseRevision, pendingScene);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 429) return { ...result, stopped: "rate-limited" };
      if (reason instanceof ApiError && reason.status < 500) { result.kept.push(boardId); continue; }
      return { ...result, stopped: "offline" };
    }
    // Cleared only if no newer copy was written meanwhile.
    const now = await deps.readPending(boardId);
    if (now && now.savedAt === pending.savedAt) await deps.clear(boardId);
    result.sent.push(boardId);
    await deps.wait?.(SYNC_GAP_MS);
  }
  return result;
}

/** Boards a canvas has open right now; the sync leaves their copies to the canvas. */
const openBoards = new Map<string, number>();
export function markBoardOpen(boardId: string) {
  openBoards.set(boardId, (openBoards.get(boardId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (openBoards.get(boardId) ?? 1) - 1;
    if (count > 0) openBoards.set(boardId, count);
    else openBoards.delete(boardId);
  };
}
export const isBoardOpen = (boardId: string) => openBoards.has(boardId);

/** Fired after the sync saved at least one board, so a list on screen can refresh. */
export const PENDING_SYNCED_EVENT = "nook:whiteboards-synced";

/**
 * QA F1: the timer while pending copies exist. 30 s after a run that sent something; after a run
 * that could not (offline, 429, or only copies that wait for their board's next open) the delay
 * doubles, up to 5 minutes. No timer when nothing is pending or nobody is signed in.
 */
export const SYNC_TIMER_MS = 30_000;
export const SYNC_TIMER_MAX_MS = 5 * 60_000;
export function nextSyncTimer(result: Pick<SyncResult, "sent" | "stopped">, pendingLeft: number, streak: number): { delay: number | null; streak: number } {
  if (result.stopped === "signed-out" || pendingLeft === 0) return { delay: null, streak: 0 };
  if (result.sent.length > 0 && result.stopped === null) return { delay: SYNC_TIMER_MS, streak: 0 };
  const next = streak + 1;
  return { delay: Math.min(SYNC_TIMER_MAX_MS, SYNC_TIMER_MS * 2 ** (next - 1)), streak: next };
}

let running: Promise<SyncResult> | null = null;
let again: (() => SyncDeps) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let streak = 0;

/** Stops the timer (sign-out, or another person signed in). */
export function stopPendingSyncTimer() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  streak = 0;
}

async function scheduleNext(makeDeps: () => SyncDeps, deps: SyncDeps, result: SyncResult) {
  let pendingLeft = 0;
  try { pendingLeft = deps.isCurrent() ? (await deps.listBoards()).length : 0; } catch { pendingLeft = 0; }
  // A newer run may have started meanwhile; it schedules for itself.
  if (running) return;
  const next = nextSyncTimer(result, pendingLeft, streak);
  if (timer !== null) clearTimeout(timer);
  timer = null;
  streak = next.streak;
  if (next.delay !== null) timer = setTimeout(() => { timer = null; void requestPendingSync(makeDeps); }, next.delay);
}

/**
 * Runs the sync, at most one at a time: a trigger while one runs asks for one more run after it
 * (with the deps of the newest trigger), never a second one in parallel. Each run then sets the
 * timer for the next (QA F1).
 */
export function requestPendingSync(makeDeps: () => SyncDeps): Promise<SyncResult> | null {
  if (running) {
    again = makeDeps;
    return running;
  }
  if (timer !== null) { clearTimeout(timer); timer = null; }
  const deps = makeDeps();
  running = syncPendingCopies(deps)
    .catch((): SyncResult => ({ sent: [], cleared: [], kept: [], stopped: "offline" }))
    .then((result) => {
      running = null;
      if (result.sent.length > 0 && typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PENDING_SYNCED_EVENT, { detail: { ids: result.sent } }));
      const next = again;
      again = null;
      // The queued trigger runs unless the network or the rate limit stopped this one (the timer retries then).
      if (next && result.stopped !== "offline" && result.stopped !== "rate-limited") void requestPendingSync(next);
      else void scheduleNext(makeDeps, deps, result);
      return result;
    });
  return running;
}

/**
 * QA F1: every event that may mean the network (or the person) is back runs the sync, so it never
 * depends on one event some browsers never fire: `online`, the tab becoming visible, the window
 * regaining focus, and the first successful API response after a failed one. Returns the remover.
 */
export function installSyncTriggers(target: Pick<Window, "addEventListener" | "removeEventListener">, doc: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">, run: () => void, recovered: (listener: () => void) => () => void = onApiRecovered) {
  const onVisible = () => { if (doc.visibilityState === "visible") run(); };
  target.addEventListener("online", run);
  target.addEventListener("focus", run);
  doc.addEventListener("visibilitychange", onVisible);
  const stopRecovered = recovered(run);
  return () => {
    target.removeEventListener("online", run);
    target.removeEventListener("focus", run);
    doc.removeEventListener("visibilitychange", onVisible);
    stopRecovered();
  };
}

/** Who is signed in, as the app shell says (usePendingWhiteboardSync); null when nobody is. */
let signedInUser: string | null = null;
export const setPendingSyncUser = (userId: string | null) => { signedInUser = userId; };

/** The real deps for `userId`: every step checks that `userId` is still the one signed in. */
export function pendingSyncDeps(userId: string): SyncDeps {
  return {
    listBoards: () => listPendingBoards(userId),
    readPending: (boardId) => readPending(userId, boardId),
    getBoard: (boardId) => getWhiteboard(boardId),
    save: (boardId, baseRevision, scene) => saveWhiteboardScene(boardId, baseRevision, scene),
    clear: (boardId) => clearPending(userId, boardId),
    // Not navigator.onLine: it can stay false after the network is back (QA F1); a failed request stops the run instead.
    isCurrent: () => signedInUser === userId,
    isOpen: isBoardOpen,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  };
}

/**
 * The app shell's triggers (QA E5, F1): when someone is signed in, on start, and on every event in
 * `installSyncTriggers`; each run sets the timer while copies are pending. The whiteboards list asks
 * for a run too, each time it is shown. Signing out stops the timer.
 */
export function usePendingWhiteboardSync(userId: string | null) {
  // Set while rendering too: the whiteboards list (a child, whose effects run first) may start a run.
  if (userId) setPendingSyncUser(userId);
  useEffect(() => {
    if (!userId) return undefined;
    setPendingSyncUser(userId);
    const run = () => { void requestPendingSync(() => pendingSyncDeps(userId)); };
    run();
    const remove = installSyncTriggers(window, document, run);
    return () => { remove(); stopPendingSyncTimer(); setPendingSyncUser(null); };
  }, [userId]);
}
