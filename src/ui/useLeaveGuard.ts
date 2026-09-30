import { useEffect, useRef } from "react";
import { readHistoryDepth } from "../appShellNavigation";
import { dialogPopDirection, holdDialogSentinel, registerHistoryDialogGuard, undoDialogPop, useDialogSentinel, whenHistorySettled, type PopDirection } from "../historyDialogs";

/**
 * A page that holds something leaving would lose (Team → Integrations: a key shown only once, review
 * R4). While `active`, browser Back or Forward is undone, like a guarded dialog's (D18), and
 * `onAttempt` is told which way the browser tried to go, to ask first; the caller repeats the move
 * with history.go() once the person chose to leave and `active` is false. On the entry the page was
 * loaded on it holds the dialog sentinel (historyDialogs.ts), at every width, so Back never leaves
 * Nook before asking. Dialogs opened over the page register later and are asked first.
 */
export function useLeaveGuard(active: boolean, onAttempt: (direction: PopDirection) => void) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const attemptRef = useRef(onAttempt);
  attemptRef.current = onAttempt;
  const depthRef = useRef(0);
  const wasActiveRef = useRef(false);
  if (active && !wasActiveRef.current) depthRef.current = typeof window === "undefined" ? 0 : readHistoryDepth(window.history.state);
  wasActiveRef.current = active;
  useDialogSentinel(active);
  useEffect(() => active ? whenHistorySettled(() => { depthRef.current = readHistoryDepth(window.history.state); }) : undefined, [active]);
  useEffect(() => {
    if (!active) return undefined;
    return registerHistoryDialogGuard((poppedState) => {
      if (!activeRef.current) return false;
      const direction = dialogPopDirection(depthRef.current, readHistoryDepth(poppedState));
      if (direction) undoDialogPop(direction);
      // Back off the sentinel: the page stays, so the sentinel goes back under it.
      holdDialogSentinel();
      attemptRef.current(direction ?? "back");
      return true;
    });
  }, [active]);
}

/** The history.go() delta that repeats a move the leave guard undid. */
export const repeatDelta = (direction: PopDirection) => direction === "back" ? -1 : 1;
