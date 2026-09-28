import { createContext, useContext, useEffect, useRef } from "react";
import { readHistoryDepth } from "../appShellNavigation";
import { dialogPopDirection, holdDialogSentinel, offerDialogReopen, registerHistoryDialogGuard, undoDialogPop, useDialogSentinel, whenHistorySettled } from "../historyDialogs";

type Guard = (poppedState: unknown) => boolean;

// Shared by Tasks, Today, and the dropdown sheets (src/ui). Tasks nests guards (the board's
// dialogs, the card view's unsaved-description prompt, a confirm inside the card), and a dropdown
// sheet opens over a Calendar or Collections sheet. historyDialogs.ts keeps registered guards as a
// stack and asks the newest first, so each open piece registers its own guard and the innermost one
// closes first.

/**
 * The guard for one open dialog: it runs `close` once, then undoes the browser's move back to the
 * entry at `openDepth`. `isOpen` and `markClosed` let a stale guard (already closed) pass the event on.
 * While `blocked` returns true (a request in flight) Back and Forward are undone and the dialog stays
 * open, as Escape does then; the guard stays armed for the next press and no reopen is offered.
 */
export function createDialogGuard(options: { isOpen: () => boolean; markClosed: () => void; close: () => void; openDepth: () => number; undo?: typeof undoDialogPop; blocked?: () => boolean; reopen?: () => (() => void) | null }): Guard {
  return (poppedState) => {
    if (!options.isOpen()) return false;
    if (options.blocked?.()) {
      const direction = dialogPopDirection(options.openDepth(), readHistoryDepth(poppedState));
      if (direction) (options.undo ?? undoDialogPop)(direction);
      // Back off the phone sentinel: the layer stays open, so the sentinel goes back under it.
      holdDialogSentinel();
      return true;
    }
    options.markClosed();
    options.close();
    // Back off the phone sentinel: Forward onto it shows this layer again (historyDialogs.ts).
    const reopen = options.reopen?.();
    if (reopen) offerDialogReopen(reopen);
    const direction = dialogPopDirection(options.openDepth(), readHistoryDepth(poppedState));
    // Direction unknown: let the route handlers follow the browser instead of leaving a stale URL.
    if (!direction) return false;
    (options.undo ?? undoDialogPop)(direction);
    return true;
  };
}

/**
 * D18 and D69: browser Back or Forward while `open` only runs `close` (closing a dialog or sheet, or
 * asking whether to discard changes). Dialogs push no history entry, so the browser's move is undone
 * with history.go(). At depth 0 on a phone the dialog holds the sentinel entry (historyDialogs.ts).
 * Same contract as FilesApp.
 */
/**
 * Inside a provider set to true, guarded dialogs and desktop dropdown popups keep their own history
 * layer at every width (the depth-0 sentinel is held on desktop too), so Back closes one layer at a
 * time: the dropdown, then a confirm, then the sheet (2i, the Inbox routine sheet).
 */
export const DesktopHistoryLayers = createContext(false);

/**
 * How the owner of a layer shows it again, for guarded layers rendered inside (the key dialogs): after
 * Back closed the layer off the phone sentinel, Forward calls it instead of landing on a dead entry.
 * The `reopen` option of useHistoryDialogGuard wins over it.
 */
export const HistoryDialogReopen = createContext<(() => void) | null>(null);

export function useHistoryDialogGuard(open: boolean, close: () => void, options: { desktop?: boolean; blocked?: boolean; reopen?: () => void } = {}) {
  const inLayers = useContext(DesktopHistoryLayers);
  const ownerReopen = useContext(HistoryDialogReopen);
  const reopenRef = useRef<(() => void) | null>(null);
  reopenRef.current = options.reopen ?? ownerReopen;
  const desktop = options.desktop ?? inLayers;
  const openRef = useRef(open);
  openRef.current = open;
  const closeRef = useRef(close);
  closeRef.current = close;
  const blockedRef = useRef(options.blocked ?? false);
  blockedRef.current = options.blocked ?? false;
  // The depth of the entry the dialog was opened on, to tell Back from Forward.
  const depthRef = useRef(0);
  const wasOpenRef = useRef(false);
  if (open && !wasOpenRef.current) depthRef.current = typeof window === "undefined" ? 0 : readHistoryDepth(window.history.state);
  wasOpenRef.current = open;
  useDialogSentinel(open, desktop);
  // Opened while another guard's undo is in flight (a composer handing Back over to its discard
  // prompt): the entry is the one the undo lands on, so read the depth once it has.
  useEffect(() => open ? whenHistorySettled(() => { depthRef.current = readHistoryDepth(window.history.state); }) : undefined, [open]);
  useEffect(() => {
    if (!open) return undefined;
    return registerHistoryDialogGuard(createDialogGuard({
      isOpen: () => openRef.current,
      markClosed: () => { openRef.current = false; },
      close: () => closeRef.current(),
      openDepth: () => depthRef.current,
      blocked: () => blockedRef.current,
      reopen: () => reopenRef.current
    }));
  }, [open]);
}
