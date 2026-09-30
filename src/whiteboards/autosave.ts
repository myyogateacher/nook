/**
 * The whiteboard autosave state machine (whiteboard plan §8.2, D194, T167). Pure: the canvas feeds
 * it events and runs the timers and requests it asks for.
 *
 *   idle → dirty (an edit) → saving → idle | dirty (edited while saving) | conflict (409)
 *        | offline (network error or 5xx: retry with backoff 2 s → 30 s) | rejected (400 or 413)
 *
 * Only one save is in flight. A save starts 1.5 s after the last edit, and at the latest 5 s after
 * the oldest unsaved one while edits keep coming (QA D4). An edit during `saving` re-arms the timer
 * once it returns, with the new base revision. A conflict waits for the person (Reload latest or
 * Save mine as a copy); a rejection keeps the local copy and waits for the next edit.
 *
 * Data-loss invariants (QA D1–D3, E1), by provenance rather than content: a scene is captured as an
 * edit only from a real editor change after the loaded scene is in the editor and before teardown
 * begins (`mayCaptureEdit`); only such a capture, with unsaved work, is ever saved or kept as the
 * pending copy (`maySendCapture`), whatever it holds, so a board the person emptied is saved like
 * any other edit (the server keeps the replaced scene as a safety snapshot); and an empty pending
 * copy that did not come from a recorded edit is never applied silently (`pendingCopyAction`).
 */

export const AUTOSAVE_DEBOUNCE_MS = 1500;
export const AUTOSAVE_MAX_WAIT_MS = 5000;
export const PENDING_WRITE_MS = 500;
export const RETRY_MIN_MS = 2000;
export const RETRY_MAX_MS = 30_000;
export const THUMBNAIL_IDLE_MS = 3000;
export const LEAVE_FLUSH_MS = 3000;

export type AutosaveStatus = "idle" | "dirty" | "saving" | "conflict" | "offline" | "rejected";

export type AutosaveState = {
  status: AutosaveStatus;
  /** The server revision the next save is based on. */
  baseRevision: number;
  /** A local counter bumped on every edit, and the edit the server last confirmed. */
  editVersion: number;
  savedVersion: number;
  /** The edit a save in flight carries. */
  savingVersion: number | null;
  /** The server's revision after a 409. */
  serverRevision: number | null;
  retryMs: number;
  message: string | null;
  /** When the oldest unsaved edit happened (ms), for the maximum wait; null when nothing is unsaved. */
  firstUnsavedAt: number | null;
  /** Live elements in the scene the server last confirmed (loaded or saved). */
  savedLive: number;
};

export type AutosaveEvent =
  /** A user-visible change reported by the editor while it was mounted and loaded. */
  | { type: "edited"; at: number }
  | { type: "saveStarted" }
  | { type: "saved"; revision: number; at: number; live: number }
  | { type: "conflict"; revision: number }
  /** A network error or 5xx; or 429 with the server's Retry-After and a message (review L11). */
  | { type: "failed"; retryAfterMs?: number; message?: string }
  | { type: "rejected"; message: string }
  /** A refused save the canvas fixed (review M1: pictures no longer shared were removed): save again now. */
  | { type: "retry" }
  /** On load, after Reload latest, or after a copy was saved: start over from the server's scene. */
  | { type: "reset"; revision: number; live: number };

export const initialAutosave = (revision: number, live = 0): AutosaveState => ({
  status: "idle", baseRevision: revision, editVersion: 0, savedVersion: 0, savingVersion: null, serverRevision: null, retryMs: 0, message: null,
  firstUnsavedAt: null, savedLive: live
});

const hasUnsaved = (state: AutosaveState) => state.editVersion > state.savedVersion;

export function autosaveReducer(state: AutosaveState, event: AutosaveEvent): AutosaveState {
  switch (event.type) {
    case "edited": {
      const editVersion = state.editVersion + 1;
      const firstUnsavedAt = state.firstUnsavedAt ?? event.at;
      // A conflict stays until the person chooses; saving keeps going and re-arms when it returns.
      if (state.status === "conflict" || state.status === "saving" || state.status === "offline") return { ...state, editVersion, firstUnsavedAt };
      return { ...state, editVersion, firstUnsavedAt, status: "dirty", message: null };
    }
    case "saveStarted":
      if (state.status === "conflict" || state.status === "saving" || !hasUnsaved(state)) return state;
      return { ...state, status: "saving", savingVersion: state.editVersion };
    case "saved": {
      if (state.status !== "saving") return state;
      const savedVersion = state.savingVersion ?? state.savedVersion;
      const next = { ...state, baseRevision: event.revision, savedVersion, savingVersion: null, retryMs: 0, message: null, savedLive: event.live };
      // Edits made while saving are the new oldest unsaved ones.
      return hasUnsaved(next) ? { ...next, status: "dirty", firstUnsavedAt: event.at } : { ...next, status: "idle", firstUnsavedAt: null };
    }
    case "conflict":
      return { ...state, status: "conflict", savingVersion: null, serverRevision: event.revision };
    case "failed": {
      const backoff = state.retryMs ? Math.min(RETRY_MAX_MS, state.retryMs * 2) : RETRY_MIN_MS;
      return { ...state, status: "offline", savingVersion: null, retryMs: Math.max(backoff, Math.min(event.retryAfterMs ?? 0, 5 * RETRY_MAX_MS)), message: event.message ?? null };
    }
    case "rejected":
      return { ...state, status: "rejected", savingVersion: null, message: event.message };
    case "retry":
      if (state.status !== "saving" && state.status !== "rejected") return state;
      return { ...state, status: hasUnsaved(state) ? "dirty" : "idle", savingVersion: null, retryMs: 0, message: null };
    case "reset":
      return { ...initialAutosave(event.revision, event.live), editVersion: state.editVersion, savedVersion: state.editVersion };
  }
}

/** Whether a save should start now (the timer, a retry, or a flush fired). */
export const shouldSave = (state: AutosaveState) => (state.status === "dirty" || state.status === "offline") && hasUnsaved(state);

/**
 * How long until the next save should start, or null for none: 1.5 s after the last edit, but never
 * later than 5 s after the oldest unsaved one (QA D4); offline, the retry backoff.
 */
export function nextSaveDelay(state: AutosaveState, now: number): number | null {
  if (!hasUnsaved(state)) return null;
  if (state.status === "offline") return state.retryMs;
  if (state.status !== "dirty") return null;
  const maxWait = state.firstUnsavedAt === null ? AUTOSAVE_MAX_WAIT_MS : state.firstUnsavedAt + AUTOSAVE_MAX_WAIT_MS - now;
  return Math.max(0, Math.min(AUTOSAVE_DEBOUNCE_MS, maxWait));
}

/** Whether leaving now could lose work (the leave flush cares). */
export const hasPendingWork = (state: AutosaveState) => state.status === "dirty" || state.status === "saving" || state.status === "offline" || (state.status === "rejected" && hasUnsaved(state)) || (state.status === "conflict" && hasUnsaved(state));

/**
 * How the scene the canvas holds was captured (QA E1): `edit` is a real editor change while the
 * editor was mounted and showed the loaded scene; `load` is the scene as loaded (or the editor's own
 * report of it); `server` is a scene shown from the server (Reload latest, a restore).
 */
export type CaptureOrigin = "edit" | "load" | "server";
export type Capture = { origin: CaptureOrigin; live: number };

/** Where the canvas is in its life: the loaded scene is in the editor (`ready`), teardown has begun. */
export type CaptureGate = { loaded: boolean; ready: boolean; tearingDown: boolean };

/**
 * Whether an editor change may be captured as an edit: only after the loaded scene is in the editor
 * and before teardown begins. A teardown (whose editor reports an empty scene) never produces one.
 */
export const mayCaptureEdit = (gate: CaptureGate) => gate.loaded && gate.ready && !gate.tearingDown;

/**
 * Whether the captured scene may be saved (the 1.5 s timer, the 5 s maximum wait, the leave flush)
 * or written to the on-device pending copy: it came from a real edit and the server has not
 * confirmed that edit yet. Its content does not matter: an empty board from a real edit is an edit.
 */
export const maySendCapture = (state: AutosaveState, capture: Capture | null) => capture !== null && capture.origin === "edit" && hasUnsaved(state);

/** The header's save status. */
export function autosaveLabel(state: AutosaveState): string {
  switch (state.status) {
    case "idle": return "Saved";
    case "dirty": return "Unsaved changes";
    case "saving": return "Saving…";
    case "offline": return state.message ?? "Offline, kept on this device";
    case "conflict": return "Conflict";
    case "rejected": return "Not saved";
  }
}

/**
 * A pending copy as the open decision sees it: its base revision, live element count, canonical
 * JSON, and whether it was written from a recorded edit (copies from before QA E1 carry no origin).
 */
export type PendingCopy = { baseRevision: number; live: number; content: string; origin?: CaptureOrigin };
export type ServerScene = { revision: number; live: number; content: string };

/**
 * D210: what to do with a pending local copy when a board opens.
 * - The same content as the server's: it was saved after all, so discard it (QA Q8).
 * - Empty over a board with elements and not from a recorded edit: only offered (QA D2).
 * - Based on the server's revision: apply it silently (it was never saved), empty or not (QA E1d).
 * - Any other base: the board changed since, so offer it as a copy.
 */
export function pendingCopyAction(pending: PendingCopy | null, server: ServerScene): "none" | "discard" | "apply" | "offer" {
  if (!pending) return "none";
  if (pending.content === server.content) return "discard";
  if (pending.live === 0 && server.live > 0 && pending.origin !== "edit") return "offer";
  return pending.baseRevision === server.revision ? "apply" : "offer";
}

/**
 * QA E5: what the background sync does with one pending copy, given the board as the server has it
 * now (null when it is gone or unreadable). A copy with the server's content is cleared; a copy the
 * open would apply silently (an edit on the server's current revision) is sent through the usual CAS
 * save; anything else stays for the next open, where it is applied or offered.
 */
export function pendingSyncAction(pending: PendingCopy, server: (ServerScene & { canEdit: boolean }) | null): "send" | "clear" | "keep" {
  if (!server || !server.canEdit) return "keep";
  if (pending.content === server.content) return "clear";
  return pendingCopyAction(pending, server) === "apply" ? "send" : "keep";
}

/** What the canvas held when a restore (or another server replacement) started: its edit counter and change key. */
export type SceneMark = { editVersion: number; key: string | null };

/**
 * Review M2: whether the person changed the board between `before` and `after`. A server scene
 * (a restored version) is shown only over an unchanged canvas; otherwise the local scene is kept
 * (pending copy, conflict choice) instead of being replaced.
 */
export const changedSince = (before: SceneMark, after: SceneMark) => before.editVersion !== after.editVersion || before.key !== after.key;
