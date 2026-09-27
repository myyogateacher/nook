import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { formatRoute, routeFromLocation } from "../src/router";
import { boardSprintsRoute, parentTasksRoute } from "../src/tasksRoute";
import { MANAGE_SPRINTS_OPTION, NEW_SPRINT_OPTION, SprintBar, sprintSwitcherOptions } from "../src/tasks/SprintBar";
import { endForDuration, initialNewSprintDraft, NewSprintDialog, NewSprintForm, startTodayDates } from "../src/tasks/NewSprintForm";
import { SprintDefaultsSection, sprintDefaultsFromDraft, sprintDefaultsSummary } from "../src/tasks/SprintDefaultsSection";
import { SprintCompleteDialog } from "../src/tasks/SprintCompleteDialog";
import { CardSprintField } from "../src/tasks/SprintField";
import { SprintSettingsSection } from "../src/tasks/SprintSettingsSection";
import type { BoardColumn, CardDetail, CardSummary, SprintSummary } from "../src/tasks/tasksApi";

/** Sprint UI (17B, research §7.2, §7.3, §7.5), rendered to static markup. */

const noop = () => undefined;
const asyncNoop = async () => undefined;
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const sprint = (id: string, name: string, state: SprintSummary["state"], extra: Partial<SprintSummary> = {}): SprintSummary => ({
  id, board_id: "b", name, goal: "", start_on: null, end_on: null, state, is_active: state === "active", position: 1024, completed_at: null,
  card_count: 0, done_count: 0, created_at: "", updated_at: "", ...extra
});
const SPRINTS = [sprint(S1, "Sprint 12", "active", { start_on: "2026-09-21", end_on: "2026-10-01", card_count: 3 }), sprint(S2, "Sprint 13", "planned")];
const columns: BoardColumn[] = [
  { id: "todo", board_id: "b", name: "To do", position: 1, is_done: 0, created_at: "", updated_at: "" },
  { id: "done", board_id: "b", name: "Done", position: 2, is_done: 1, created_at: "", updated_at: "" }
];
const card = (id: string, column: string, extra: Partial<CardSummary> = {}): CardSummary => ({
  id, board_id: "b", column_id: column, position: 1, title: id, has_description: 0, revision: 1, created_by: null, creator_name: null, due_on: null,
  assignee_id: null, assignee_name: null, comment_count: 0, attachment_count: 0, created_at: "", updated_at: "", level: 0, parent_card_id: null, sprint_id: null, ...extra
});
const CARDS = [card("a", "todo", { sprint_id: S1 }), card("b", "done", { sprint_id: S1 }), card("c", "todo", { sprint_id: S1 }), card("sub", "todo", { level: 1, parent_card_id: "a", sprint_id: S1 })];
const STRUCTURE = { levels: [{ name: "Task", plural: "Tasks" }, { name: "Subtask", plural: "Subtasks" }], workLevel: 0, sprints: true };

test("the sprint bar shows the sprint, its timing, work-level progress, and the owner's Complete", () => {
  const html = renderToStaticMarkup(<SprintBar sprints={SPRINTS} selection={{ kind: "sprint", sprint: SPRINTS[0]! }} cards={CARDS} columns={columns} workLevel={0}
    name="Task" plural="Tasks" today="2026-09-27" owner onSelect={noop} onStart={noop} onComplete={noop} />);
  expect(html).toContain("Sprint 12");
  expect(html).toContain("4 days left");
  expect(html).toContain("1 of 3 done");
  expect(html).toContain("Complete…");
  expect(html).not.toContain("<select");
  // Members see the progress but not the owner actions; a planned sprint offers Start only with none active.
  const member = renderToStaticMarkup(<SprintBar sprints={SPRINTS} selection={{ kind: "sprint", sprint: SPRINTS[0]! }} cards={CARDS} columns={columns} workLevel={0}
    name="Task" plural="Tasks" today="2026-09-27" owner={false} onSelect={noop} onStart={noop} onComplete={noop} />);
  expect(member).not.toContain("Complete…");
  const planned = renderToStaticMarkup(<SprintBar sprints={[SPRINTS[1]!]} selection={{ kind: "sprint", sprint: SPRINTS[1]! }} cards={[]} columns={columns} workLevel={0}
    name="Task" plural="Tasks" today="2026-09-27" owner onSelect={noop} onStart={noop} onComplete={noop} />);
  expect(planned).toContain("Start sprint");
  expect(planned).toContain("No tasks yet");
  const backlog = renderToStaticMarkup(<SprintBar sprints={SPRINTS} selection={{ kind: "backlog" }} cards={[card("d", "todo")]} columns={columns} workLevel={0}
    name="Task" plural="Tasks" today="2026-09-27" owner onSelect={noop} onStart={noop} onComplete={noop} />);
  expect(backlog).toContain("1 task not in a sprint");
});

test("the close dialog counts done and unfinished tasks and offers the next sprint, the backlog, and a new sprint", () => {
  const html = renderToStaticMarkup(<SprintCompleteDialog sprint={SPRINTS[0]!} sprints={SPRINTS} cards={CARDS} columns={columns} workLevel={0}
    name="Task" plural="Tasks" childPlural="Subtasks" today="2026-09-27" onComplete={asyncNoop} onCancel={noop} />);
  expect(html).toContain("Complete Sprint 12");
  expect(html).toContain("1 done");
  expect(html).toContain("2 not done");
  expect(html).toContain("Move the 2 unfinished tasks to");
  expect(html).toContain("Sprint 13");
  expect(html).toContain("Subtasks follow their tasks.");
  expect(html).not.toContain("<select");
});

test("the card's Sprint field: a select on the work level, read-only below it, hidden on boards without sprints", () => {
  const task = { ...card("a", "todo", { sprint_id: S1 }), description: "" } as CardDetail;
  const editable = renderToStaticMarkup(<CardSprintField card={task} structure={STRUCTURE} cards={CARDS} sprints={SPRINTS} idPrefix="x" saving={false} onSave={async () => true} />);
  expect(editable).toContain("Sprint");
  expect(editable).toContain("Sprint 12");
  expect(editable).toContain('role="combobox"');
  const subtask = { ...CARDS[3]!, description: "" } as CardDetail;
  const inherited = renderToStaticMarkup(<CardSprintField card={subtask} structure={STRUCTURE} cards={CARDS} sprints={SPRINTS} idPrefix="x" saving={false} onSave={async () => true} />);
  expect(inherited).toContain("Sprint 12");
  expect(inherited).toContain("(from its task)");
  expect(inherited).not.toContain('role="combobox"');
  expect(renderToStaticMarkup(<CardSprintField card={task} structure={{ ...STRUCTURE, sprints: false }} cards={CARDS} sprints={SPRINTS} idPrefix="x" saving={false} onSave={async () => true} />)).toBe("");
});

test("the Sprints sheet lists sprints for everyone and gives the owner New, Start, Complete, Edit, and Delete", () => {
  const props = { boardId: "b", sprints: SPRINTS, today: "2026-09-27", plural: "Tasks", onCreate: async () => null, onUpdate: async () => true, onStart: asyncNoop, onDelete: asyncNoop, onComplete: noop };
  const owner = renderToStaticMarkup(<SprintSettingsSection {...props} owner />);
  expect(owner).toContain("New sprint");
  // "Complete" never truncates on a phone; the full label is its accessible name (QA 0.9.2).
  expect(owner).toContain('aria-label="Complete Sprint 12…"');
  expect(owner).toContain("</svg>Complete</button>");
  expect(owner).toContain("Edit Sprint 12");
  expect(owner).toContain("Delete Sprint 13");
  // Sprint 13 cannot start while Sprint 12 is active.
  expect(owner).not.toContain(">Start<");
  const member = renderToStaticMarkup(<SprintSettingsSection {...props} owner={false} />);
  expect(member).toContain("Sprint 12");
  expect(member).not.toContain("New sprint");
  expect(member).toContain("Only the owner adds, starts, and completes sprints");
});

// ---- New sprint, the switcher's entries, the idle prompt, and Sprint defaults (operator 2026-09-27) ----

const count = () => ({ total: 0, done: 0, doing: 0, todo: 0 });

test("the switcher ends with New sprint… (owner) and Manage sprints…; picking one opens it instead of filtering", () => {
  const owner = sprintSwitcherOptions({ sprints: SPRINTS, count, owner: true, newSprint: true, manage: true }).map((option) => option.value);
  expect(owner.slice(-2)).toEqual([NEW_SPRINT_OPTION, MANAGE_SPRINTS_OPTION]);
  const member = sprintSwitcherOptions({ sprints: SPRINTS, count, owner: false, newSprint: true, manage: true }).map((option) => option.value);
  expect(member).not.toContain(NEW_SPRINT_OPTION);
  expect(member[member.length - 1]).toBe(MANAGE_SPRINTS_OPTION);
  const source = readFileSync(new URL("../src/tasks/SprintBar.tsx", import.meta.url), "utf8");
  expect(source).toContain("if (value === NEW_SPRINT_OPTION) onNewSprint?.();");
  expect(source).toContain("else if (value === MANAGE_SPRINTS_OPTION) onManage?.();");
});

test("with no active sprint the bar says so and offers the owner Start Sprint 1 and New sprint; members see the words only", () => {
  const planned = [sprint(S1, "Sprint 1", "planned", { start_on: "2026-09-27", end_on: "2026-10-10" })];
  const props = { sprints: planned, selection: { kind: "backlog" } as const, cards: [], columns, workLevel: 0, name: "Task", plural: "Tasks", today: "2026-09-27", onSelect: noop, onStart: noop, onComplete: noop, onNewSprint: noop, onManage: noop };
  const owner = renderToStaticMarkup(<SprintBar {...props} owner />);
  expect(owner).toContain("No active sprint");
  expect(owner).toContain("Start Sprint 1");
  expect(owner).toContain("New sprint");
  expect(owner).not.toContain("not in a sprint");
  const member = renderToStaticMarkup(<SprintBar {...props} owner={false} />);
  expect(member).toContain("No active sprint");
  expect(member).not.toContain("Start Sprint 1");
  expect(member).not.toContain(">New sprint<");
});

test("New sprint: the name, start, and Duration come from the board's defaults; Custom shows the end date", () => {
  const draft = initialNewSprintDraft([], "2026-09-27", { days: 14, start: "next", name: "Sprint {n}" });
  expect(draft).toEqual({ name: "Sprint 1", startOn: "2026-09-27", endOn: "2026-10-10", duration: "14" });
  expect(initialNewSprintDraft([], "2026-09-27", { days: 10, start: "today" })).toMatchObject({ duration: "custom", endOn: "2026-10-06" });
  // No defaults: as long as the latest sprint (two weeks without one).
  expect(initialNewSprintDraft([], "2026-09-27", null)).toMatchObject({ duration: "14", endOn: "2026-10-10" });
  // Duration → end date; Custom keeps the typed end.
  expect(endForDuration("2026-09-28", "7", "")).toBe("2026-10-04");
  expect(endForDuration("2026-09-28", "28", "")).toBe("2026-10-25");
  expect(endForDuration("2026-09-28", "custom", "2026-10-02")).toBe("2026-10-02");

  const form = (canStart: boolean) => renderToStaticMarkup(<NewSprintDialog boardName="Web app" sprints={[]} today="2026-09-27" defaults={{ days: 14, start: "next", name: "Sprint {n}" }}
    canStart={canStart} onSubmit={async () => true} onCancel={noop} />);
  const html = form(true);
  expect(html).toContain("New sprint");
  expect(html).toContain('value="Sprint 1"');
  expect(html).toContain("Duration");
  expect(html).toContain("2 weeks");
  expect(html).toContain("Create and start");
  expect(html).toContain(">Create<");
  expect(html).toContain("Cancel");
  expect(html).not.toContain("<select");
  // The end date input shows only for Custom.
  expect(html).not.toContain('value="2026-10-10"');
  expect(form(false)).not.toContain("Create and start");
  const custom = renderToStaticMarkup(<NewSprintForm sprints={[]} today="2026-09-27" defaults={{ days: 10, start: "today" }} canStart onSubmit={async () => true} onCancel={noop} />);
  expect(custom).toContain('value="2026-10-06"');
});

test("New sprint with a planned sprint and none active (QA 0.9.2): Create and start starts today; the form offers the planned one", () => {
  const defaults = { days: 14, start: "next" as const, name: "Sprint {n}" };
  const planned = [sprint(S1, "Sprint 1", "planned", { start_on: "2026-09-27", end_on: "2026-10-10" })];
  // The form suggests the sprint after Sprint 1 …
  const draft = initialNewSprintDraft(planned, "2026-09-27", defaults);
  expect(draft).toMatchObject({ name: "Sprint 2", startOn: "2026-10-11", endOn: "2026-10-24", duration: "14" });
  // … but a sprint started now starts today and keeps the chosen length.
  expect(startTodayDates(draft, "2026-09-27")).toEqual({ startOn: "2026-09-27", endOn: "2026-10-10" });
  expect(startTodayDates({ ...draft, duration: "7" }, "2026-09-27")).toEqual({ startOn: "2026-09-27", endOn: "2026-10-03" });
  expect(startTodayDates({ ...draft, duration: "custom", startOn: "2026-10-11", endOn: "2026-10-15" }, "2026-09-27")).toEqual({ startOn: "2026-09-27", endOn: "2026-10-01" });

  const dialog = (sprints: SprintSummary[], canStart: boolean) => renderToStaticMarkup(<NewSprintDialog boardName="Web app" sprints={sprints} today="2026-09-27" defaults={defaults}
    canStart={canStart} onSubmit={async () => true} onCancel={noop} onStartPlanned={noop} />);
  const hinted = dialog(planned, true);
  expect(hinted).toContain("Sprint 1 is planned — start it instead?");
  expect(hinted).toContain('<button type="button" class="task-link-button">Start Sprint 1</button>');
  expect(hinted).toContain("Create and start");
  // No planned sprint, or one is active: no hint.
  expect(dialog([], true)).not.toContain("is planned");
  expect(dialog(SPRINTS, false)).not.toContain("is planned");
  // The form's source saves today's dates for Create and start.
  const source = readFileSync(new URL("../src/tasks/NewSprintForm.tsx", import.meta.url), "utf8");
  expect(source).toContain("const dates = start ? startTodayDates(draft, today) : { startOn: draft.startOn, endOn: draft.endOn };");
});

test("Board settings → Sprint defaults: the owner edits duration, start, and pattern; members read them; both reach Manage sprints", () => {
  const defaults = { days: 14, start: "next" as const, name: "Sprint {n}" };
  const owner = renderToStaticMarkup(<SprintDefaultsSection defaults={defaults} owner onSave={async () => true} onManage={noop} />);
  expect(owner).toContain("Sprint defaults");
  expect(owner).toContain("Default duration");
  expect(owner).toContain("2 weeks");
  expect(owner).toContain("Start on");
  expect(owner).toContain("The day after the previous sprint");
  expect(owner).toContain('value="Sprint {n}"');
  expect(owner).toContain("Save defaults");
  expect(owner).toContain("Manage sprints");
  expect(owner).not.toContain("<select");
  const member = renderToStaticMarkup(<SprintDefaultsSection defaults={defaults} owner={false} onSave={async () => true} onManage={noop} />);
  expect(member).toContain("New sprints last 2 weeks, start the day after the previous sprint, and are named like Sprint 1.");
  expect(member).not.toContain("Save defaults");
  expect(member).toContain("Manage sprints");
  expect(sprintDefaultsSummary(null)).toContain("as long as the latest one");
  // Custom days are bounded 1–60; an empty pattern means none.
  expect(sprintDefaultsFromDraft({ duration: "custom", days: "61", start: "next", name: "" }).ok).toBe(false);
  expect(sprintDefaultsFromDraft({ duration: "custom", days: "10", start: "fri", name: "" })).toEqual({ ok: true, defaults: { days: 10, start: "fri" } });
  expect(sprintDefaultsFromDraft({ duration: "21", days: "21", start: "next", name: "Sprint" }).ok).toBe(false);
});

test("/tasks/:b/sprints parses, formats with the board's query, and its parent is the board", () => {
  const board = "11111111-1111-4111-8111-111111111111";
  const route = routeFromLocation({ pathname: `/tasks/${board}/sprints`, search: "?view=table" } as Location);
  expect(route).toMatchObject({ app: "tasks", boardId: board, cardId: null, sprints: true });
  expect(formatRoute(route)).toBe(`/tasks/${board}/sprints?view=table`);
  expect(formatRoute(boardSprintsRoute(board))).toBe(`/tasks/${board}/sprints`);
  const parent = parentTasksRoute(boardSprintsRoute(board));
  expect(parent && formatRoute(parent)).toBe(`/tasks/${board}`);
  const longer = routeFromLocation({ pathname: `/tasks/${board}/sprints/extra`, search: "" } as Location);
  expect(longer).toMatchObject({ boardId: board, cardId: null });
  expect((longer as { sprints?: true }).sprints).toBeUndefined();
});

test("Board settings no longer lists sprints; its Save structure is a padded, right-aligned primary button", () => {
  const view = readFileSync(new URL("../src/tasks/BoardView.tsx", import.meta.url), "utf8");
  expect(view).toContain("sprintsSection={<SprintDefaultsSection");
  expect(view).not.toContain("sprintsSection={<SprintSettingsSection");
  const css = readFileSync(new URL("../src/tasks/tasks.css", import.meta.url), "utf8");
  expect(css).toContain(".task-settings-actions button { min-height: 40px; margin: 0; padding: 0 16px;");
  expect(css).toContain(".task-settings-actions { display: flex; justify-content: flex-end;");
});
