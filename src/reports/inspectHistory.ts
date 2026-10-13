import { readHistoryDepth, withHistoryDepth } from "../appShellNavigation";

/**
 * The inspect sheet's tabs as real history steps (plan wave 47; Back/Forward parity, a standing rule).
 *
 * Opening the sheet is a dialog layer like any other (useHistoryDialogGuard: no entry of its own, or
 * the dialog sentinel on a landing entry). Each tab the person moves to then pushes one entry on top
 * of the entry the sheet sits on (the base), one level deeper, carrying `mynotes.inspect` (which sheet,
 * which tab, which step). Back and Forward move through those entries and the guard below, registered
 * after the sheet's own guard (so asked first), shows the tab the entry names; reaching the base
 * shows the first tab. Only a Back from the base reaches the sheet's guard, which closes the sheet and
 * undoes the move, so Back never leaves the app.
 *
 * The entries also carry the dialog hint (`mynotes.dialog`), so historyDialogs.ts treats them like
 * the sentinel: a move between them is never mistaken for "Back off the sentinel", and Forward onto a
 * stale one after the sheet closed steps straight back off it. Closing the sheet any other way (×,
 * Escape, the scrim) first goes back to the base (`history.go(-step)`), then closes, so no tab entry
 * is left behind the page.
 */

export const INSPECT_TABS = ["query", "data", "mapping", "provenance"] as const;
export type InspectTab = typeof INSPECT_TABS[number];

export const INSPECT_TAB_LABELS: Record<InspectTab, string> = { query: "Query", data: "Data", mapping: "Mapping", provenance: "Provenance" };

const MARK = "mynotes.inspect";
const DIALOG_HINT = "mynotes.dialog";

type Mark = { sheet: string; tab: InspectTab; step: number };

/** The inspect mark of a history state, if it has one. */
export function inspectMark(state: unknown): Mark | null {
  if (!state || typeof state !== "object") return null;
  const mark = (state as Record<string, unknown>)[MARK] as Partial<Mark> | undefined;
  if (!mark || typeof mark.sheet !== "string" || typeof mark.step !== "number" || !INSPECT_TABS.includes(mark.tab as InspectTab)) return null;
  return mark as Mark;
}

type HistoryLike = Pick<History, "state" | "pushState" | "go">;

type Options = {
  history: HistoryLike;
  href: () => string;
  initialTab: InspectTab;
  /** Shows a tab (the state the entry the browser landed on names). */
  show: (tab: InspectTab, step: number) => void;
  /** Closes the sheet for real. */
  close: () => void;
  /** How long a close waits for its go(-step) to land before closing anyway. */
  closeWaitMs?: number;
};

/** One sheet's tab history: `select` pushes, `back` steps, `requestClose` unwinds then closes, `guard` answers popstate. */
export function createInspectTabHistory(options: Options) {
  const sheet = crypto.randomUUID();
  let step = 0;
  let baseDepth: number | null = null;
  let closing: ReturnType<typeof setTimeout> | null = null;

  const finishClose = () => {
    if (closing) clearTimeout(closing);
    closing = null;
    options.close();
  };

  return {
    sheet,
    step: () => step,
    /** Moves to `tab` as a new history entry (no entry when it is already shown). */
    select(tab: InspectTab, current: InspectTab) {
      if (tab === current || closing) return;
      const state = options.history.state;
      const depth = readHistoryDepth(state);
      if (baseDepth === null || step === 0) baseDepth = depth - step;
      const base = state && typeof state === "object" ? { ...(state as Record<string, unknown>) } : {};
      step += 1;
      options.history.pushState(withHistoryDepth({ ...base, [DIALOG_HINT]: true, [MARK]: { sheet, tab, step } }, depth + 1), "", options.href());
      options.show(tab, step);
    },
    /** The sheet's own Back button: the browser's Back, so Forward can redo it. */
    back() {
      if (step > 0) options.history.go(-1);
    },
    /** ×, Escape, the scrim: back to the base entry first, then close. */
    requestClose() {
      if (step === 0) return finishClose();
      if (closing) return;
      closing = setTimeout(finishClose, options.closeWaitMs ?? 1000);
      options.history.go(-step);
    },
    /** For historyDialogs' guard stack: true when the popstate only moved between this sheet's tabs. */
    guard(poppedState: unknown): boolean {
      const mark = inspectMark(poppedState);
      if (mark && mark.sheet === sheet) {
        step = mark.step;
        options.show(mark.tab, mark.step);
        return true;
      }
      if (baseDepth !== null && readHistoryDepth(poppedState) === baseDepth && (step > 0 || closing)) {
        step = 0;
        options.show(options.initialTab, 0);
        if (closing) finishClose();
        return true;
      }
      return false;
    }
  };
}
