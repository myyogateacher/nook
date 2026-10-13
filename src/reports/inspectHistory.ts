import { readHistoryDepth } from "../appShellNavigation";
import { dialogPopDirection, holdDialogSentinel, undoDialogPop } from "../historyDialogs";

/**
 * The inspect sheet's tabs as history steps (plan wave 47, D18/D69 parity): opening the sheet is one
 * layer (useHistoryDialogGuard), and each tab the person moves to is a step inside it. Browser Back
 * first unwinds the tabs, newest first, then closes the sheet; Forward does nothing inside the sheet.
 * Like every dialog in Nook the steps push no history entries: the guard below, registered after the
 * sheet's own guard (so asked first), steps back and undoes the browser's move, and on the landing
 * entry (a deep link) it keeps the dialog sentinel in place so the next Back still lands in the sheet.
 */

export const INSPECT_TABS = ["query", "data", "mapping", "provenance"] as const;
export type InspectTab = typeof INSPECT_TABS[number];

export const INSPECT_TAB_LABELS: Record<InspectTab, string> = { query: "Query", data: "Data", mapping: "Mapping", provenance: "Provenance" };

/** Moving to `tab` adds a step unless it is already the current one. */
export const pushTab = (stack: readonly InspectTab[], tab: InspectTab): InspectTab[] => stack[stack.length - 1] === tab ? [...stack] : [...stack, tab];
/** One step back; the first tab stays. */
export const popTab = (stack: readonly InspectTab[]): InspectTab[] => stack.length > 1 ? stack.slice(0, -1) : [...stack];

type TabGuardOptions = {
  steps: () => number;
  stepBack: () => void;
  /** The depth of the entry the sheet was opened on. */
  openDepth: () => number;
  undo?: typeof undoDialogPop;
};

/** The guard for the sheet's tab steps: true when it handled the popstate (the sheet stays open). */
export function createTabStepGuard(options: TabGuardOptions) {
  return (poppedState: unknown): boolean => {
    if (options.steps() <= 1) return false;
    // Back off the dialog sentinel: step back and keep the sentinel under the sheet.
    if (holdDialogSentinel()) {
      options.stepBack();
      return true;
    }
    const direction = dialogPopDirection(options.openDepth(), readHistoryDepth(poppedState));
    if (!direction) return false;
    if (direction === "back") options.stepBack();
    (options.undo ?? undoDialogPop)(direction);
    return true;
  };
}
