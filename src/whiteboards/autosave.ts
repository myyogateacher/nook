/**
 * The whiteboard autosave state machine (whiteboard plan §8.2, D194, T167). Pure: the canvas feeds
 * it events and runs the timers and requests it asks for.
 *
 *   idle → dirty (an edit) → saving → idle | dirty (edited while saving) | conflict (409)
 *        | offline (network error or 5xx: retry with backoff 2 s → 30 s) | rejected (400 or 413)
 *
 * Only one save is in flight. An edit during `saving` re-arms the debounce once it returns, with the
 * new base revision. A conflict waits for the person (Reload latest or Save mine as a copy); a
 * rejection keeps the local copy and waits for the next edit.
 */

export const AUTOSAVE_DEBOUNCE_MS = 1500;
export const RETRY_MIN_MS = 2000;
export const RETRY_MAX_MS = 30_000;
export const THUMBNAIL_INTERVAL_MS = 60_000;
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
};

export type AutosaveEvent =
  | { type: "edited" }
  | { type: "saveStarted" }
  | { type: "saved"; revision: number }
  | { type: "conflict"; revision: number }
  /** A network error or 5xx; or 429 with the server's Retry-After and a message (review L11). */
  | { type: "failed"; retryAfterMs?: number; message?: string }
  | { type: "rejected"; message: string }
  /** After Reload latest (or a copy was saved): start over from the server's revision, nothing unsaved. */
  | { type: "reset"; revision: number };

export const initialAutosave = (revision: number): AutosaveState => ({
  status: "idle", baseRevision: revision, editVersion: 0, savedVersion: 0, savingVersion: null, serverRevision: null, retryMs: 0, message: null
});

const hasUnsaved = (state: AutosaveState) => state.editVersion > state.savedVersion;

export function autosaveReducer(state: AutosaveState, event: AutosaveEvent): AutosaveState {
  switch (event.type) {
    case "edited": {
      const editVersion = state.editVersion + 1;
      // A conflict stays until the person chooses; saving keeps going and re-arms when it returns.
      if (state.status === "conflict" || state.status === "saving") return { ...state, editVersion };
      if (state.status === "offline") return { ...state, editVersion };
      return { ...state, editVersion, status: "dirty", message: null };
    }
    case "saveStarted":
      if (state.status === "conflict" || state.status === "saving" || !hasUnsaved(state)) return state;
      return { ...state, status: "saving", savingVersion: state.editVersion };
    case "saved": {
      if (state.status !== "saving") return state;
      const savedVersion = state.savingVersion ?? state.savedVersion;
      const next = { ...state, baseRevision: event.revision, savedVersion, savingVersion: null, retryMs: 0, message: null };
      return { ...next, status: hasUnsaved(next) ? "dirty" : "idle" };
    }
    case "conflict":
      return { ...state, status: "conflict", savingVersion: null, serverRevision: event.revision };
    case "failed": {
      const backoff = state.retryMs ? Math.min(RETRY_MAX_MS, state.retryMs * 2) : RETRY_MIN_MS;
      return { ...state, status: "offline", savingVersion: null, retryMs: Math.max(backoff, Math.min(event.retryAfterMs ?? 0, 5 * RETRY_MAX_MS)), message: event.message ?? null };
    }
    case "rejected":
      return { ...state, status: "rejected", savingVersion: null, message: event.message };
    case "reset":
      return { ...initialAutosave(event.revision), editVersion: state.editVersion, savedVersion: state.editVersion };
  }
}

/** Whether a save should start now (the debounce, a retry, or a flush fired). */
export const shouldSave = (state: AutosaveState) => (state.status === "dirty" || state.status === "offline") && hasUnsaved(state);

/** Whether leaving now could lose work (the tab-close prompt and the leave flush care). */
export const hasPendingWork = (state: AutosaveState) => state.status === "dirty" || state.status === "saving" || state.status === "offline" || (state.status === "rejected" && hasUnsaved(state)) || (state.status === "conflict" && hasUnsaved(state));

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

export type PendingCopy = { baseRevision: number; savedAt: string };

/**
 * D210: what to do with a pending local copy when a board opens. Its base is the server's revision:
 * apply it silently (it was never saved). Any other base: the board changed since, so offer it as a
 * copy. No copy: nothing.
 */
export function pendingCopyAction(pending: PendingCopy | null, serverRevision: number): "none" | "apply" | "offer" {
  if (!pending) return "none";
  return pending.baseRevision === serverRevision ? "apply" : "offer";
}
