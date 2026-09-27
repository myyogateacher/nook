import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { aLevel, parentRequired, parentRequiredMessage, PRESETS } from "../shared/boardStructure";
import { CardParentFields, SubtasksSection } from "../src/tasks/CardHierarchySection";
import { composerError, composerParentError } from "../src/tasks/composerDraft";
import type { BoardColumn, CardDetail, CardSummary } from "../src/tasks/tasksApi";
import type { CardHierarchyContext } from "../src/tasks/useBoardHierarchy";

// A subtask needs its parent (operator QA 0.9.1): no "No task" chip, a prompt when empty, and a
// clear notice for one restored without its parent (D130).

const sprintTasks = PRESETS.sprint_task_subtask.structure;
const epics = PRESETS.epic_story_subtask.structure;
const column = (id: string, position: number, isDone = false): BoardColumn => ({ id, board_id: "b", name: id, position, is_done: isDone ? 1 : 0, created_at: "", updated_at: "" });
const columns = [column("todo", 1024), column("done", 2048, true)];
function card(id: string, level: number, parent: string | null, title = id): CardSummary {
  return {
    id, board_id: "b", column_id: "todo", position: 1, title, has_description: 0, revision: 1, created_by: null, creator_name: null, due_on: null,
    assignee_id: null, assignee_name: null, comment_count: 0, attachment_count: 0, created_at: "", updated_at: "", level, parent_card_id: parent, child_count: 0
  } as CardSummary;
}
const detail = (summary: CardSummary) => ({ ...summary, description: "" }) as unknown as CardDetail;
const contextFor = (structure: typeof epics, cards: CardSummary[]): CardHierarchyContext => ({
  structure, cards, columns, openCard: () => undefined, setChildDone: async () => undefined,
  addChild: async () => true, composeChild: () => undefined, detachChild: async () => undefined
});
const fields = (structure: typeof epics, cards: CardSummary[], target: CardSummary) =>
  renderToStaticMarkup(<CardParentFields card={detail(target)} context={contextFor(structure, cards)} idPrefix="c" saving={false} onSave={async () => true} />);

test("a parent is required below the work level only, with the words the field and the server use", () => {
  expect([0, 1].map((level) => parentRequired(sprintTasks, level))).toEqual([false, true]);
  expect([0, 1, 2].map((level) => parentRequired(epics, level))).toEqual([false, false, true]);
  expect(parentRequired(PRESETS.flat.structure, 0)).toBe(false);
  expect(parentRequiredMessage(sprintTasks, 1)).toBe("Pick the task this subtask belongs to");
  expect([aLevel(epics, 0), aLevel(sprintTasks, 0)]).toEqual(["an epic", "a task"]);
});

test("the parent field never shows a No task chip: empty, it prompts Choose a task…", () => {
  const cards = [card("t1", 0, null, "Checkout"), card("s1", 1, "t1", "Button"), card("loose", 1, null, "Loose")];
  const withParent = fields(sprintTasks, cards, cards[1]!);
  expect(withParent).toContain('<span class="ui-chip-label">Checkout</span>');
  expect(withParent).not.toMatch(/No task/);
  const empty = fields(sprintTasks, cards, cards[2]!);
  expect(empty).not.toContain("ui-chip-label");
  expect(empty).not.toMatch(/No task/);
  expect(empty).toContain('placeholder="Choose a task…"');
  // An orphan story on an Epic board: optional, so no notice, just the prompt.
  const story = card("st", 1, null, "Orphan story");
  const orphan = fields(epics, [card("e1", 0, null, "Epic"), story], story);
  expect(orphan).toContain('placeholder="Choose an epic…"');
  expect(orphan).not.toContain("task-parent-note");
});

test("a subtask without its parent (restored from the Bin) says so, with Choose a task and Make it a task", () => {
  const cards = [card("t1", 0, null, "Checkout"), card("loose", 1, null, "Loose")];
  const markup = fields(sprintTasks, cards, cards[1]!);
  expect(markup).toContain('class="task-parent-note detached" role="status"');
  expect(markup).toContain("<strong>Detached subtask</strong> — choose a task or change its level.");
  expect(markup).toMatch(/>Choose a task<\/button>/);
  expect(markup).toMatch(/>Make it a task<\/button>/);
  // A subtask with a parent has no notice.
  expect(fields(sprintTasks, [...cards, card("s1", 1, "t1")], card("s1", 1, "t1"))).not.toContain("task-parent-note");
});

test("the Subtasks list offers Make it a task instead of Remove from parent for a subtask", () => {
  const cards = [card("t1", 0, null, "Checkout"), card("s1", 1, "t1", "Button")];
  const markup = renderToStaticMarkup(<SubtasksSection card={detail(cards[0]!)} context={contextFor(sprintTasks, cards)} idPrefix="c" />);
  expect(markup).toContain('aria-label="Make “Button” a task" title="Make it a task"');
  expect(markup).not.toContain("Remove from parent");
  // Stories under an epic can still leave it (a parent is optional there).
  const tree = [card("e1", 0, null, "Epic"), card("st", 1, "e1", "Story")];
  expect(renderToStaticMarkup(<SubtasksSection card={detail(tree[0]!)} context={contextFor(epics, tree)} idPrefix="c" />)).toContain('title="Remove from parent"');
});

test("the composer asks for the parent before Create, and maps the server's PARENT_REQUIRED to the same field", () => {
  expect(composerParentError(sprintTasks, { level: 1, parentId: null })).toEqual({ field: "parent", message: "Pick the task this subtask belongs to." });
  expect(composerParentError(sprintTasks, { level: 1, parentId: "t1" })).toBeNull();
  expect(composerParentError(sprintTasks, { level: null, parentId: null })).toBeNull();
  expect(composerParentError(epics, { level: 1, parentId: null })).toBeNull();
  expect(composerError({ status: 400, code: "PARENT_REQUIRED", message: "Pick the task this subtask belongs to, or make it a task" }, undefined))
    .toEqual({ field: "parent", message: "Pick the task this subtask belongs to, or make it a task" });
});
