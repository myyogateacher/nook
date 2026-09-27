import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { PRESETS } from "../shared/boardStructure";
import { focusIntoDialog } from "../src/files/Dialog";
import { addOnce, CardBreadcrumb, SubtasksSection } from "../src/tasks/CardHierarchySection";
import { boardData, treeRows } from "../src/tasks/boardQuery";
import { activeFilterCount } from "../src/tasks/home/HomeResultsPane";
import { movedMessage } from "../src/tasks/home/ResultMoveSheet";
import { SprintCompleteDialog } from "../src/tasks/SprintCompleteDialog";
import { sprintFilterConflict } from "../src/tasks/sprintModel";
import type { BoardColumn, CardDetail, CardSummary, SprintSummary } from "../src/tasks/tasksApi";
import type { CardHierarchyContext } from "../src/tasks/useBoardHierarchy";

// The v0.9.0 delegated-QA polish findings, rendered with react-dom/server and pure helpers.
const epics = PRESETS.epic_story_subtask.structure;
const column = (id: string, position: number, isDone = false): BoardColumn => ({ id, board_id: "b", name: id, position, is_done: isDone ? 1 : 0, created_at: "", updated_at: "" });
const columns = [column("todo", 1024), column("done", 2048, true)];
function card(id: string, level: number, parent: string | null, title = id): CardSummary {
  return {
    id, board_id: "b", column_id: "todo", position: 1, title, has_description: 0, revision: 1, created_by: null, creator_name: null, due_on: null,
    assignee_id: null, assignee_name: null, comment_count: 0, attachment_count: 0, created_at: "", updated_at: "", level, parent_card_id: parent
  };
}
const cards = [card("e", 0, null, "Alpha"), card("s", 1, "e", "Login"), card("t", 2, "s", "Button")];
const context: CardHierarchyContext = {
  structure: epics, cards, columns, openCard: () => undefined, setChildDone: async () => undefined,
  addChild: async () => true, composeChild: () => undefined, detachChild: async () => undefined
};
const detail = (summary: CardSummary) => ({ ...summary, description: "" }) as unknown as CardDetail;

test("the inline add keeps its input enabled and refuses a second add while one is saving (QA FAIL-3)", async () => {
  const markup = renderToStaticMarkup(<SubtasksSection card={detail(cards[1]!)} context={context} idPrefix="c" />);
  const input = markup.slice(markup.indexOf('<input id="c-add-child"'), markup.indexOf("/>", markup.indexOf('<input id="c-add-child"')));
  expect(input).toContain('placeholder="Add subtask…"');
  expect(input).not.toContain("disabled");

  const flag = { current: false };
  let calls = 0;
  let release!: () => void;
  const first = addOnce(flag, () => new Promise<boolean>((resolve) => { calls += 1; release = () => resolve(true); }));
  expect(await addOnce(flag, async () => { calls += 1; return true; })).toBeNull();
  release();
  expect(await first).toBe(true);
  expect(calls).toBe(1);
  // Free again once the first add settles, even when it fails.
  await expect(addOnce(flag, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  expect(await addOnce(flag, async () => false)).toBe(false);
});

test("phone targets are at least 44 px, and the breadcrumb's accessible name separates level and title (QA FAIL-6)", () => {
  const markup = renderToStaticMarkup(<CardBreadcrumb card={detail(cards[2]!)} context={context} />);
  expect(markup).toContain('<small>Epic</small><span class="sr-only">: </span>Alpha');
  const phone = (file: string) => {
    const css = readFileSync(new URL(file, import.meta.url), "utf8");
    return css.split("@media (max-width: 760px)").slice(1).join("\n");
  };
  const tasks = phone("../src/tasks/tasks.css");
  expect(tasks).toContain(".task-parent-chip { min-height: 44px;");
  expect(tasks).toContain(".task-breadcrumb button { min-height: 44px; }");
  expect(tasks).toContain(".task-subtask .icon-button, .task-settings-panel header .icon-button { width: 44px; height: 44px; }");
  expect(tasks).toContain(".task-card-field .ui-chip-remove { width: 44px; height: 44px;");
  expect(phone("../src/tasks/home/home.css")).toContain(".task-view-header .task-back { width: 44px; height: 44px; }");
  expect(phone("../src/tasks/boardViews.css")).toContain(".task-filter-chip-remove { width: 44px; height: 44px;");
});

test("a modal takes focus on open unless a child already has it; the board settings sheet uses it (QA FAIL-5)", () => {
  const focused: string[] = [];
  const element = (name: string, hidden = false) => ({ name, hasAttribute: (attribute: string) => attribute === "hidden" && hidden, focus: () => { focused.push(name); } });
  const close = element("close");
  const container = (children: ReturnType<typeof element>[], inside: unknown[] = []) => ({
    contains: (node: unknown) => inside.includes(node), querySelectorAll: () => children, focus: () => { focused.push("container"); }
  }) as unknown as Parameters<typeof focusIntoDialog>[0];
  const gear = { name: "gear" } as unknown as Element;
  focusIntoDialog(container([element("skip", true), close]), gear);
  expect(focused).toEqual(["close"]);
  // An autoFocus child already inside keeps focus.
  focusIntoDialog(container([close], [close]), close as unknown as Element);
  expect(focused).toEqual(["close"]);
  focusIntoDialog(container([]), gear);
  expect(focused).toEqual(["close", "container"]);
  const sheet = readFileSync(new URL("../src/tasks/BoardSettingsSheet.tsx", import.meta.url), "utf8");
  expect(sheet).toContain("useDialogFocus(panelRef);");
  expect(sheet).toMatch(/<aside ref=\{panelRef\} tabIndex=\{-1\}[^>]*role="dialog" aria-modal="true"[^>]*onKeyDown=\{trapTabKey\}/);
  const dialog = readFileSync(new URL("../src/files/Dialog.tsx", import.meta.url), "utf8");
  expect(dialog).toContain("useDialogFocus(sectionRef);");
});

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const sprintRow = (id: string, name: string, state: SprintSummary["state"]): SprintSummary => ({
  id, board_id: "b", name, goal: "", start_on: null, end_on: null, state, is_active: state === "active", position: 1024,
  completed_at: null, card_count: 0, done_count: 0, created_at: "", updated_at: ""
});

test("polish: Move-to toast, tree toggle counts, action toasts, titles, and the nested Set-parent guard", () => {
  expect(movedMessage("Done", "Done")).toBe("Moved to Done");
  expect(movedMessage("Review", "In progress")).toBe("Moved to Review (In progress)");
  const data = boardData({ columns, cards, board: { structure: epics } });
  expect(treeRows(data.cards).map((row) => [row.card.id, row.childCount, row.descendantCount])).toEqual([["e", 1, 2], ["s", 1, 1], ["t", 0, 0]]);
  expect(source("../src/tasks/BoardTable.tsx")).toContain("the ${descendantCount} ${descendantCount === 1 ? \"card\" : \"cards\"} under");
  expect(source("../src/tasks/TasksApp.tsx")).toContain("toast.action || toast.selectable ? 15000 : 3200");
  expect(source("../src/tasks/BoardView.tsx")).toContain("useTasksTitle(board ? `${openCardTitle ? `${openCardTitle} · ` : \"\"}${board.name} · Tasks` : null);");
  expect(source("../src/tasks/MoveCardSheet.tsx")).toContain("useHistoryDialogGuard(picking, () => setPicking(false));");
  expect(source("../src/tasks/home/home.css")).toContain(".task-view-actions .primary-button:disabled {");
});

test("polish: the empty sprint's Complete dialog says so and focuses Cancel", () => {
  const empty = sprintRow("11111111-1111-4111-8111-111111111111", "Sprint 1", "active");
  const html = renderToStaticMarkup(<SprintCompleteDialog sprint={empty} sprints={[empty]} cards={[]} columns={columns} workLevel={0}
    name="Task" plural="Tasks" childPlural={null} today="2026-09-27" onComplete={async () => undefined} onCancel={() => undefined} />);
  expect(html).toContain("This sprint has no tasks.");
  expect(html).not.toContain("Every task in it is done");
  expect(html).toMatch(/<button type="button" class="secondary-button"[^>]*>Cancel<\/button>/);
  expect(source("../src/tasks/SprintCompleteDialog.tsx")).toContain('className="secondary-button" autoFocus onClick={onCancel}');
});

test("polish: a sprint filter that disagrees with the header switcher is explained", () => {
  const one = sprintRow("11111111-1111-4111-8111-111111111111", "Sprint 1", "active");
  const two = sprintRow("22222222-2222-4222-8222-222222222222", "Sprint 2", "planned");
  const term = (values: string[], negate = false) => [{ key: "sprint" as const, negate, values }];
  const selection = { kind: "sprint" as const, sprint: one };
  expect(sprintFilterConflict(term([two.id]), selection, [one, two])).toBe("Showing Sprint 2 cards within Sprint 1 — clear one");
  expect(sprintFilterConflict(term(["next"]), selection, [one, two])).toBe("Showing Sprint 2 cards within Sprint 1 — clear one");
  expect(sprintFilterConflict(term(["current"]), selection, [one, two])).toBeNull();
  expect(sprintFilterConflict(term([one.id, two.id]), selection, [one, two])).toBeNull();
  expect(sprintFilterConflict(term([one.id]), { kind: "backlog" }, [one, two])).toBe("Showing Sprint 1 cards within the backlog — clear one");
  expect(sprintFilterConflict(term([two.id]), { kind: "all" }, [one, two])).toBeNull();
  expect(sprintFilterConflict(term([two.id], true), selection, [one, two])).toBeNull();
});

test("polish: My work folds group, sort, and filters behind one Filters button on phones (friction 7)", () => {
  expect(activeFilterCount([{ key: "assignee" }, { key: "state" }, { key: "board" }, { key: "tag" }], ["assignee"], ["state"])).toBe(2);
  const pane = source("../src/tasks/home/HomeResultsPane.tsx");
  expect(pane).toContain('className="secondary-button task-home-filters-toggle" aria-expanded={filtersOpen}');
  expect(pane.indexOf("{above}")).toBeLessThan(pane.indexOf("<BoardViewSwitch"));
  const css = source("../src/tasks/home/home.css");
  const [desktop, phone] = [css.split("@media (max-width: 760px)")[0]!, css.split("@media (max-width: 760px)").slice(1).join("")];
  expect(desktop).toContain(".task-home-filters-toggle { display: none; }");
  expect(phone).toContain(".task-home-pane:not(.filters-open) .task-home-collapsible { display: none; }");
  expect(desktop).toContain(".task-home-state-select { display: none; }");
  expect(phone).toContain(".task-home-states { display: none; }");
  expect(source("../src/tasks/home/MyWork.tsx")).toContain('<Select<string> variant="chip" label="State"');
});
