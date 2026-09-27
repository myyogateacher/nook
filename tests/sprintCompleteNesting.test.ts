import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { popStateClosedDialog, registerHistoryDialogGuard } from "../src/historyDialogs";
import { createDialogGuard } from "../src/ui/useHistoryDialogGuard";

/**
 * Review L6b: a dialog nested over a sheet has its own history guard, so Back (or Cancel) closes
 * only the dialog and the sheet is still there; the next Back closes the sheet. Since the sprint
 * list moved to the Sprints sheet (a route), Complete there is the board's own guarded dialog.
 */

test("Back with Complete sprint open over Board settings closes only the dialog; the next Back closes the settings", () => {
  const state = { settings: true, complete: true };
  const undos: number[] = [];
  const guard = (key: keyof typeof state) => createDialogGuard({
    isOpen: () => state[key], markClosed: () => { state[key] = false; }, close: () => { state[key] = false; },
    openDepth: () => 2, undo: (direction) => { undos.push(direction === "back" ? 1 : -1); }
  });
  // Registration order is opening order: the board's settings guard, then the nested one.
  const unregisterSettings = registerHistoryDialogGuard(guard("settings"));
  const unregisterComplete = registerHistoryDialogGuard(guard("complete"));
  try {
    expect(popStateClosedDialog({ state: { "mynotes.depth": 1 } })).toBe(true);
    expect(state).toEqual({ settings: true, complete: false });
    expect(popStateClosedDialog({ state: { "mynotes.depth": 1 } })).toBe(true);
    expect(state).toEqual({ settings: false, complete: false });
    expect(undos).toEqual([1, 1]);
  } finally {
    unregisterComplete();
    unregisterSettings();
  }
});

test("the Sprints sheet (a route) opens Complete as the board's guarded dialog and leaves Escape to it", () => {
  const board = readFileSync(new URL("../src/tasks/BoardView.tsx", import.meta.url), "utf8");
  // Sprints moved out of Board settings (operator 2026-09-27): the sheet's Complete is the board's dialog.
  expect(board).toContain('onComplete={(sprint) => openDialog({ kind: "completeSprint", sprintId: sprint.id })}');
  expect(board).toContain("useHistoryDialogGuard(dialog !== null, closeDialog)");
  expect(board).toContain("<SprintsSheet boardName={board.name} onClose={onCloseSprints} suspended={dialog !== null}>");
  expect(board).not.toContain("setSettingsCompleteId");
  const sheet = readFileSync(new URL("../src/tasks/SprintsSheet.tsx", import.meta.url), "utf8");
  expect(sheet).toMatch(/event\.key !== "Escape" \|\| event\.defaultPrevented \|\| suspended/);
});
