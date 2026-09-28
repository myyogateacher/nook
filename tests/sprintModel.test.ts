import { describe, expect, test } from "bun:test";
import { applyBoardQuery, boardData, FILTER_FIELDS, termValueLabel, type BoardContext } from "../src/tasks/boardQuery";
import { DEFAULT_BOARD_QUERY, formatBoardSearch, parseBoardSearch, withBoardQuery } from "../src/tasks/boardUrl";
import {
  carryOverSprint,
  effectiveSprints,
  newSprintDefaults,
  orderSprints,
  resolveSprintSelection,
  selectionTerm,
  sprintDateRange,
  sprintProgress,
  sprintQueryValue,
  sprintTiming
} from "../src/tasks/sprintModel";
import { createBody, emptyDraft } from "../src/tasks/composerDraft";
import { tasksRoute } from "../src/tasksRoute";
import { formatRoute } from "../src/router";
import type { BoardColumn, CardSummary, SprintSummary } from "../src/tasks/tasksApi";

/** Sprints on the board (17B, research §7.3, §7.5): the selection, the URL, the scoping term, and the counts. Pure. */

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S0 = "00000000-0000-4000-8000-000000000000";
const STRUCTURE = { levels: [{ name: "Task", plural: "Tasks" }, { name: "Subtask", plural: "Subtasks" }], workLevel: 0, sprints: true };

const sprint = (id: string, state: SprintSummary["state"], extra: Partial<SprintSummary> = {}): SprintSummary => ({
  id, board_id: "b", name: `Sprint ${id[0]}`, goal: "", start_on: null, end_on: null, state, is_active: state === "active", position: 1024,
  completed_at: state === "completed" ? "2026-09-01T00:00:00.000Z" : null, card_count: 0, done_count: 0, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z", ...extra
});
const SPRINTS = [sprint(S1, "active", { start_on: "2026-09-21", end_on: "2026-10-04" }), sprint(S2, "planned", { position: 2048 }), sprint(S0, "completed")];

const columns: BoardColumn[] = [
  { id: "todo", board_id: "b", name: "To do", position: 1, is_done: 0, created_at: "", updated_at: "" },
  { id: "doing", board_id: "b", name: "Doing", position: 2, is_done: 0, created_at: "", updated_at: "" },
  { id: "done", board_id: "b", name: "Done", position: 3, is_done: 1, created_at: "", updated_at: "" }
];
const card = (id: string, column: string, extra: Partial<CardSummary> = {}): CardSummary => ({
  id, board_id: "b", column_id: column, position: 1, title: id, has_description: 0, revision: 1, created_by: null, creator_name: null, due_on: null,
  assignee_id: null, assignee_name: null, comment_count: 0, attachment_count: 0, created_at: "", updated_at: "", level: 0, parent_card_id: null, sprint_id: null, ...extra
});
const CARDS = [
  card("a", "todo", { sprint_id: S1 }),
  card("b", "done", { sprint_id: S1 }),
  card("a-sub", "todo", { level: 1, parent_card_id: "a", sprint_id: null }),
  card("c", "doing", { sprint_id: S2 }),
  card("d", "todo"),
  card("loose-sub", "doing", { level: 1 })
];
const context: BoardContext = { userId: "u", today: "2026-09-27", now: Date.parse("2026-09-27T12:00:00Z"), timeZone: "UTC" };

describe("sprint selection and URL", () => {
  test("the default is the active sprint, else the backlog; unknown ids fall back; flat boards have none", () => {
    expect(resolveSprintSelection(null, SPRINTS, STRUCTURE)).toMatchObject({ kind: "sprint", sprint: { id: S1 } });
    expect(resolveSprintSelection(S2, SPRINTS, STRUCTURE)).toMatchObject({ kind: "sprint", sprint: { id: S2 } });
    expect(resolveSprintSelection(S0, SPRINTS, STRUCTURE)).toMatchObject({ kind: "sprint", sprint: { id: S0, state: "completed" } });
    expect(resolveSprintSelection("backlog", SPRINTS, STRUCTURE)).toEqual({ kind: "backlog" });
    expect(resolveSprintSelection("all", SPRINTS, STRUCTURE)).toEqual({ kind: "all" });
    expect(resolveSprintSelection("33333333-3333-4333-8333-333333333333", SPRINTS, STRUCTURE)).toMatchObject({ kind: "sprint", sprint: { id: S1 } });
    expect(resolveSprintSelection(null, SPRINTS.filter((item) => item.state !== "active"), STRUCTURE)).toEqual({ kind: "backlog" });
    expect(resolveSprintSelection(S1, SPRINTS, { ...STRUCTURE, sprints: false })).toBeNull();
    // The default needs no URL value.
    expect(sprintQueryValue(S1, SPRINTS)).toBeNull();
    expect(sprintQueryValue("backlog", SPRINTS)).toBe("backlog");
    expect(sprintQueryValue("backlog", [])).toBeNull();
    expect(sprintQueryValue(S2, SPRINTS)).toBe(S2);
  });

  test("?sprint= round-trips with the other board keys, drops bad values, and rides along to card routes", () => {
    const query = withBoardQuery(DEFAULT_BOARD_QUERY, { view: "table", sprint: S2 });
    expect(formatBoardSearch(query)).toBe(`?view=table&sprint=${S2}`);
    expect(parseBoardSearch(`?sprint=${S2.toUpperCase()}&view=table`)).toMatchObject({ view: "table", sprint: S2 });
    expect(parseBoardSearch("?sprint=backlog").sprint).toBe("backlog");
    expect(parseBoardSearch("?sprint=ALL").sprint).toBe("all");
    expect(parseBoardSearch("?sprint=current").sprint).toBeNull();
    expect(parseBoardSearch("?sprint=<script>").sprint).toBeNull();
    // `sprint` is presentation, not a filter: the grammar never reads it.
    expect(parseBoardSearch("?sprint=backlog").filter.terms).toEqual([]);
    expect(formatBoardSearch(withBoardQuery(DEFAULT_BOARD_QUERY, { sprint: null }))).toBe("");
    const boardId = "44444444-4444-4444-8444-444444444444";
    const cardId = "55555555-5555-4555-8555-555555555555";
    expect(formatRoute(tasksRoute(boardId, cardId, false, withBoardQuery(DEFAULT_BOARD_QUERY, { sprint: "backlog" })))).toBe(`/tasks/${boardId}/card/${cardId}?sprint=backlog`);
  });
});

describe("scoping the board to a sprint", () => {
  test("subtasks take their work-level parent's sprint; cards above the work level and loose subtasks have none", () => {
    const derived = new Map(effectiveSprints(CARDS, 0).map((item) => [item.id, item.sprint_id]));
    expect(derived.get("a-sub")).toBe(S1);
    expect(derived.get("loose-sub")).toBeNull();
    expect(derived.get("c")).toBe(S2);
    const epics = effectiveSprints([card("epic", "todo", { level: 0, sprint_id: S1 }), card("story", "todo", { level: 1, parent_card_id: "epic", sprint_id: S2 }), card("sub", "todo", { level: 2, parent_card_id: "story" })], 1);
    expect(epics.map((item) => item.sprint_id)).toEqual([null, S2, S2]);
  });

  test("the selection term runs through the board pipeline; All cards adds none", () => {
    const data = boardData({ columns, cards: CARDS, board: { structure: STRUCTURE }, sprints: SPRINTS });
    const run = (value: string | null) => {
      const term = selectionTerm(resolveSprintSelection(value, SPRINTS, STRUCTURE));
      return applyBoardQuery(data, { ...DEFAULT_BOARD_QUERY, filter: { terms: term ? [term] : [] } }, context).cards.map((item) => item.id).sort();
    };
    expect(run(null)).toEqual(["a", "a-sub", "b"]);
    expect(run(S2)).toEqual(["c"]);
    expect(run("backlog")).toEqual(["d", "loose-sub"]);
    expect(run("all")).toHaveLength(CARDS.length);
    // The filter bar's own sprint field, and `sprint:current`/`next` against the board's sprints.
    const typed = (text: string) => applyBoardQuery(data, parseBoardSearch(`?q=${encodeURIComponent(text)}`), context).cards.map((item) => item.id).sort();
    expect(typed("sprint:current")).toEqual(["a", "a-sub", "b"]);
    expect(typed("sprint:next,none")).toEqual(["c", "d", "loose-sub"]);
    expect(typed("-sprint:none")).toEqual(["a", "a-sub", "b", "c"]);
    expect(FILTER_FIELDS.sprint!.available!(data)).toBe(true);
    expect(FILTER_FIELDS.sprint!.available!(boardData({ columns, cards: CARDS }))).toBe(false);
    expect(FILTER_FIELDS.sprint!.optionsFor(data, context).map((option) => option.value)).toEqual([S1, S2, S0, "none"]);
    expect(termValueLabel("sprint", S2, data, context)).toBe(SPRINTS[1]!.name);
    expect(termValueLabel("sprint", "none", data, context)).toBe("the backlog");
  });

  test("progress counts work-level cards of the sprint (or the backlog) by column state, no subtasks", () => {
    const cards = effectiveSprints(CARDS, 0);
    expect(sprintProgress(cards, columns, S1, 0)).toEqual({ total: 2, done: 1, doing: 1, todo: 0 });
    expect(sprintProgress(cards, columns, S2, 0)).toEqual({ total: 1, done: 0, doing: 1, todo: 0 });
    // Without column states (an older payload) open columns count as in progress.
    expect(sprintProgress(cards, columns, null, 0)).toEqual({ total: 1, done: 0, doing: 1, todo: 0 });
    const stated = columns.map((column, index) => ({ ...column, state: (["todo", "doing", "done"] as const)[index] }));
    expect(sprintProgress(cards, stated, S1, 0)).toEqual({ total: 2, done: 1, doing: 0, todo: 1 });
  });
});

describe("sprint words and defaults", () => {
  test("dates, timing, and order", () => {
    expect(sprintDateRange({ start_on: "2026-09-21", end_on: "2026-10-04" })).toMatch(/Sep 21.+Oct 4/);
    expect(sprintDateRange({ start_on: null, end_on: null })).toBe("");
    expect(sprintTiming({ state: "active", start_on: "2026-09-21", end_on: "2026-10-01" }, "2026-09-27")).toBe("4 days left");
    expect(sprintTiming({ state: "active", start_on: null, end_on: "2026-09-28" }, "2026-09-27")).toBe("1 day left");
    expect(sprintTiming({ state: "active", start_on: null, end_on: "2026-09-27" }, "2026-09-27")).toBe("Ends today");
    expect(sprintTiming({ state: "active", start_on: null, end_on: "2026-09-25" }, "2026-09-27")).toBe("Ended 2 days ago");
    expect(sprintTiming({ state: "planned", start_on: "2026-10-01", end_on: null }, "2026-09-27")).toBe("Starts in 4 days");
    expect(sprintTiming({ state: "completed", start_on: null, end_on: null }, "2026-09-27")).toBe("Completed");
    const newer = sprint(S0, "completed", { completed_at: "2026-09-20T00:00:00.000Z" });
    expect(orderSprints([SPRINTS[2]!, SPRINTS[1]!, newer, SPRINTS[0]!].filter((item, index, list) => list.findIndex((other) => other.id === item.id) === index)).map((item) => item.state))
      .toEqual(["active", "planned", "completed"]);
  });

  test("a new sprint follows the latest one; the close dialog's new sprint follows the one completing", () => {
    expect(newSprintDefaults([], "2026-09-27")).toEqual({ name: "Sprint 1", startOn: "2026-09-27", endOn: "2026-10-10" });
    const running = sprint(S1, "active", { name: "Sprint 12", start_on: "2026-09-21", end_on: "2026-10-04" });
    expect(newSprintDefaults([running], "2026-09-27")).toEqual({ name: "Sprint 13", startOn: "2026-10-05", endOn: "2026-10-18" });
    // Completing early starts the new sprint today, not after the unused end date (QA NOTE-a).
    expect(carryOverSprint(running, "2026-09-27")).toEqual({ name: "Sprint 13", startOn: "2026-09-27", endOn: "2026-10-10" });
    expect(carryOverSprint(running, "2026-10-04")).toEqual({ name: "Sprint 13", startOn: "2026-10-05", endOn: "2026-10-18" });
    expect(carryOverSprint(running, "2026-10-09")).toEqual({ name: "Sprint 13", startOn: "2026-10-09", endOn: "2026-10-22" });
    // After sprints completed early, the New sprint form starts today; an open one is still followed.
    const closed = sprint(S0, "completed", { name: "Sprint 12", start_on: "2026-09-21", end_on: "2026-10-04" });
    expect(newSprintDefaults([closed], "2026-09-27")).toEqual({ name: "Sprint 13", startOn: "2026-09-27", endOn: "2026-10-10" });
    expect(newSprintDefaults([closed, sprint(S1, "planned", { name: "Sprint 13", start_on: "2026-09-28", end_on: "2026-10-11" })], "2026-09-27"))
      .toEqual({ name: "Sprint 14", startOn: "2026-10-12", endOn: "2026-10-25" });
  });

  test("the composer sends a sprint only when one is chosen", () => {
    expect(createBody(emptyDraft("todo", { sprintId: S1 }), "Task")).toEqual({ columnId: "todo", title: "Task", sprintId: S1 });
    expect(createBody(emptyDraft("todo"), "Task")).toEqual({ columnId: "todo", title: "Task" });
  });

  test("the composer always sends the sprint, so the Backlog stays the backlog (Friction 3)", async () => {
    // The server puts an omitted sprintId on the active sprint; the composer's null means the backlog.
    const source = await Bun.file(new URL("../src/tasks/CardComposer.tsx", import.meta.url)).text();
    expect(source).toContain("{ ...createBody({ ...current, sprintId: planned }, check.name), sprintId: planned }");
    const hierarchy = await Bun.file(new URL("../src/tasks/useBoardHierarchy.ts", import.meta.url)).text();
    expect(hierarchy).toContain("parentId: parent.id, sprintId: null");
  });
});
