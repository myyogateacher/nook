import { expect, test } from "bun:test";
import { PUSHED_OVER_KEY, stepBackIfPushedOver } from "../src/App";
import { leaveUploadsRequest } from "../src/files/FilesApp";

// Final carry-overs, from the end-user QA: Q1 (browser Back leaving Files during uploads asks first)
// and Q2 (deleting the item on screen does not leave a duplicate entry for Back to repeat).

const read = (path: string) => Bun.file(new URL(`../src/${path}`, import.meta.url)).text();

test("Q2: an entry pushed over the list steps back onto it; anything else is replaced in place", () => {
  const history = (state: unknown) => {
    const calls: string[] = [];
    return { calls, value: { state, back: () => { calls.push("back"); } } };
  };
  const pushed = history({ [PUSHED_OVER_KEY]: "/files", "mynotes.depth": 3 });
  expect(stepBackIfPushedOver("/files", pushed.value)).toBe(true);
  expect(pushed.calls).toEqual(["back"]);
  for (const state of [{ [PUSHED_OVER_KEY]: "/files/folder/x", "mynotes.depth": 3 }, { "mynotes.depth": 3 }, { [PUSHED_OVER_KEY]: "/files", "mynotes.depth": 0 }, null]) {
    const other = history(state);
    expect(stepBackIfPushedOver("/files", other.value)).toBe(false);
    expect(other.calls).toEqual([]);
  }
});

test("Q2: pushes record the URL they were pushed over; Notes and Files leave a removed item that way", async () => {
  const app = await read("App.tsx");
  expect(app).toContain("window.history.pushState(withHistoryDepth({ ...state, [PUSHED_OVER_KEY]: locationUrl(window.location) }, depth + 1), \"\", url);");
  expect(app).toContain("if (options.removed && stepBackIfPushedOver(formatRoute(route))) return;");
  expect(app).toContain('navigate(notesRoute(selectedFolder, null), { panel: "notes", replace: true, removed: true });');
  expect(await read("files/FilesApp.tsx")).toContain('navigate(filesRoute(folder, null), { replace: true, removed: true, filesPanel: "files" });');
});

test("Q1: browser Back or Forward out of Files during uploads is undone and asks; leaving cancels, then repeats the move once", async () => {
  expect(leaveUploadsRequest(1)).toMatchObject({ title: "Leave Files?", confirmLabel: "Leave and cancel", message: "An upload is still in progress and will be canceled if you leave." });
  expect(leaveUploadsRequest(3).message).toBe("3 uploads are still in progress and will be canceled if you leave.");
  const files = await read("files/FilesApp.tsx");
  const guard = files.slice(files.indexOf("const leavingRef = useRef(false);"), files.indexOf("}), [askLeave]);"));
  expect(guard).toContain('if (parseRoute(window.location.pathname).app === "files") return false;');
  expect(guard).toContain("undoDialogPop(direction);");
  expect(guard).toContain("for (const controller of controllersRef.current.values()) controller.abort();");
  expect(guard).toContain('window.history.go(direction === "back" ? -1 : 1);');
  // No beforeunload prompt: closing the tab is not guarded.
  expect(files).not.toContain("beforeunload");
});
