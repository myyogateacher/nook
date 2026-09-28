import { useEffect, useRef, useState } from "react";
import { readHistoryDepth } from "../appShellNavigation";
import { dialogPopDirection, registerHistoryDialogGuard, undoDialogPop, useDialogSentinel } from "../historyDialogs";

/** Tracks a CSS media query (the phone layout below 761 px, as everywhere in Nook). */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export const PHONE_QUERY = "(max-width: 760px)";

/** What `onBack(true)` may return: "keep" when the user chose to stay on the open dialog. */
export type ForcedBackResult = "keep" | void;
type OnBack = (forced: boolean) => ForcedBackResult;

/**
 * One popstate while a dialog is open (see useDialogBackGuard). Returns true when the move was
 * handled here, so the route handlers must not follow it.
 */
export function guardDialogPop(openDepth: number, poppedState: unknown, onBack: OnBack, restoreUrl: () => void, undo: typeof undoDialogPop = undoDialogPop) {
  const direction = dialogPopDirection(openDepth, readHistoryDepth(poppedState));
  if (!direction) {
    if (onBack(true) !== "keep") return false;
    // L4: the user kept an edited sheet, so put the dialog's URL back on the entry moved to.
    restoreUrl();
    return true;
  }
  onBack(false);
  undo(direction);
  return true;
}

/**
 * D69 for the Calendar: dialogs and sheets push no history entry. While any is open, browser Back
 * or Forward calls `onBack` (which closes the top dialog) and the browser's move is undone with
 * history.go(). The event sheet's layers guard themselves (EventSheet.tsx). When the direction cannot be told,
 * `onBack(true)` must close everything and the route handlers follow the browser, unless it
 * returns "keep": then the dialog stays and its URL is restored with replaceState.
 */
export function useDialogBackGuard(active: boolean, onBack: OnBack) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const depthRef = useRef(0);
  const openEntryRef = useRef<{ url: string; state: unknown }>({ url: "", state: null });
  const wasActiveRef = useRef(false);
  if (active && !wasActiveRef.current && typeof window !== "undefined") {
    depthRef.current = readHistoryDepth(window.history.state);
    openEntryRef.current = { url: `${window.location.pathname}${window.location.search}${window.location.hash}`, state: window.history.state };
  }
  wasActiveRef.current = active;
  useDialogSentinel(active);
  useEffect(() => registerHistoryDialogGuard((poppedState) => {
    if (!activeRef.current) return false;
    return guardDialogPop(depthRef.current, poppedState, (forced) => onBackRef.current(forced), () => {
      window.history.replaceState(openEntryRef.current.state, "", openEntryRef.current.url);
    });
  }), []);
}

/** What had focus when a layer opened, so it gets focus back when the layer closes (the routine sheet's pattern, 2j). */
export type Opener = { element: HTMLElement | null; label: string | null; fallback: string | null };

type FocusTarget = Pick<HTMLElement, "isConnected" | "focus">;

export function captureOpener(active: Element | null, fallback: string | null = null): Opener {
  const element = active && typeof HTMLElement !== "undefined" && active instanceof HTMLElement && active !== document.body ? active : null;
  return { element, label: element?.getAttribute("aria-label") ?? null, fallback };
}

/**
 * Where focus goes back to: the opener while it is still on the page; else a control with its
 * accessible name (the Share button in the Calendars sheet, which re-mounts once the Share panel
 * that replaced it closes); else the layer's fallback selector.
 */
export function openerTarget<T extends FocusTarget>(opener: { element: T | null; label: string | null; fallback: string | null } | null, find: (selector: string) => T | null): T | null {
  if (!opener) return null;
  if (opener.element?.isConnected) return opener.element;
  if (opener.label) {
    const byLabel = find(`[aria-label="${opener.label.replace(/["\\]/g, "\\$&")}"]`);
    if (byLabel) return byLabel;
  }
  return opener.fallback ? find(opener.fallback) : null;
}

/**
 * Hands focus back to the layer's opener when `open` turns false (Escape, Close, Back, or a pick),
 * after the layer has unmounted and any layer under it has taken its first focus, so focus never
 * falls to the page body. `fallback` names a control to use when the opener is gone.
 */
export function useReturnFocus(open: boolean, fallback: string | null = null) {
  const openerRef = useRef<Opener | null>(null);
  const capturedRef = useRef(false);
  if (open && !capturedRef.current && typeof document !== "undefined") openerRef.current = captureOpener(document.activeElement, fallback);
  capturedRef.current = open;
  const shownRef = useRef(false);
  useEffect(() => {
    if (open) {
      shownRef.current = true;
      return;
    }
    if (!shownRef.current) return;
    shownRef.current = false;
    const opener = openerRef.current;
    window.requestAnimationFrame(() => {
      openerTarget(opener, (selector) => document.querySelector<HTMLElement>(selector))?.focus();
    });
  }, [open]);
}
