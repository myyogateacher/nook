import { useEffect, useRef } from "react";

/**
 * Friction 7: an agent's draft can be published from the Inbox while its note is open in the
 * editor, which then kept showing Draft and Publish. While a note is open the app re-reads it every
 * 30 seconds and when the window regains focus, and refreshes the editor once the note was
 * published elsewhere, unless there are local edits not saved yet (their save reports the change).
 */

export const PUBLISH_WATCH_MS = 30_000;

export type WatchedNote = { id: string; current_version: number; hasDraft: boolean; draftMcpKeyName: string | null };

/** What a re-read means for the open editor: nothing, or a refresh with the toast to show. */
export function publishedElsewhere(open: WatchedNote, fetched: WatchedNote, localEdits: boolean): { refresh: false } | { refresh: true; toast: string } {
  if (localEdits || fetched.id !== open.id || !open.hasDraft) return { refresh: false };
  if (fetched.current_version <= open.current_version || fetched.hasDraft) return { refresh: false };
  // The draft the agent wrote is what an Inbox approval publishes.
  return { refresh: true, toast: open.draftMcpKeyName ? `Published by ${open.draftMcpKeyName} via the Inbox` : "Published in another window" };
}

/**
 * Re-reads the open note on an interval and on window focus. `check` does the fetch and compare;
 * it is skipped while the tab is hidden and never overlaps itself.
 */
export function usePublishWatch(noteId: string | null, check: () => Promise<void>, intervalMs = PUBLISH_WATCH_MS) {
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    if (!noteId) return undefined;
    let running = false;
    const run = () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      void checkRef.current().catch(() => undefined).finally(() => { running = false; });
    };
    const timer = window.setInterval(run, intervalMs);
    window.addEventListener("focus", run);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", run); };
  }, [noteId, intervalMs]);
}
