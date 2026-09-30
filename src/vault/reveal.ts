import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Revealed values and the clipboard (vault plan T187). A revealed value hides again after 30
 * seconds and whenever the tab is hidden; it lives only in React state (never in storage, the URL,
 * the title, or a toast). Copying writes to the clipboard and, 30 seconds later, clears it when the
 * page still has focus and the clipboard still holds that value (best effort: clipboard managers may
 * keep a copy, and the UI says so).
 */

export const REVEAL_MS = 30_000;
export const CLIPBOARD_CLEAR_MS = 30_000;

export type Revealed = { value: string; comment: string | null; version: number };
export const cellKey = (secretId: string, envId: string) => `${secretId}:${envId}`;

export function useRevealedValues(hideAfterMs = REVEAL_MS) {
  const [revealed, setRevealed] = useState<Record<string, Revealed>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const hide = useCallback((key: string) => {
    const timer = timers.current.get(key);
    if (timer) clearTimeout(timer);
    timers.current.delete(key);
    setRevealed((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const hideAll = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    setRevealed((current) => Object.keys(current).length ? {} : current);
  }, []);

  const show = useCallback((key: string, value: Revealed) => {
    const previous = timers.current.get(key);
    if (previous) clearTimeout(previous);
    timers.current.set(key, setTimeout(() => hide(key), hideAfterMs));
    setRevealed((current) => ({ ...current, [key]: value }));
  }, [hide, hideAfterMs]);

  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === "hidden") hideAll(); };
    document.addEventListener("visibilitychange", onVisibility);
    const pending = timers.current;
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, [hideAll]);

  return { revealed, show, hide, hideAll };
}

let clearTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Copies `text`, then 30 s later clears the clipboard, but only when the page still has focus and
 * the clipboard still holds exactly `text`: something the person copied afterwards is never wiped.
 * When the browser refuses to read the clipboard (no permission, no `readText`), it is left alone.
 */
export async function copySecret(text: string, clipboard: Pick<Clipboard, "writeText"> & Partial<Pick<Clipboard, "readText">> | undefined = typeof navigator === "undefined" ? undefined : navigator.clipboard, clearAfterMs = CLIPBOARD_CLEAR_MS) {
  if (!clipboard) throw new Error("Copying is not available in this browser");
  await clipboard.writeText(text);
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    clearTimer = null;
    if (typeof document === "undefined" || !document.hasFocus() || typeof clipboard.readText !== "function") return;
    void (async () => {
      try {
        if (await clipboard.readText!() === text) await clipboard.writeText("");
      } catch {
        // Reading was refused: leave the clipboard as it is.
      }
    })();
  }, clearAfterMs);
}

/** The words for a masked value, for screen readers: the bullets are hidden. */
export const MASK = "••••••••";
