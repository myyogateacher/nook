import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { buildLanes, type LaneColumn } from "../shared/taskLanes";
import { parse, format } from "../shared/taskQuery";
import { formatRoute, routeFromLocation, type Route } from "../src/router";
import { parentTasksRoute, savedViewOf, tasksRoute, cardCloseAction, type TasksRoute } from "../src/tasksRoute";
import { DEFAULT_BOARD_QUERY, formatBoardViewSearch, hasFilterParam, withBoardQuery } from "../src/tasks/boardUrl";
import { boardLayoutOf, boardViewFilter, boardViewQueryText, composerStartFor, displayLayoutOf, savedBoardFilter } from "../src/tasks/views/boardViewModel";
import { composerDirty, emptyDraft } from "../src/tasks/composerDraft";
import { cardLaneKey, cardsByLane, faceOf, laneDrop, laneStatuses, nextOpenLane, withLaneMove } from "../src/tasks/home/laneModel";
import { formatMyWorkSearch, formatViewSearch, homeLanes, myWorkDefault, parseMyWorkSearch, parseViewSearch, sameHomeQuery, viewHomeQuery } from "../src/tasks/home/homeUrl";
import { QueryLanes } from "../src/tasks/home/QueryLanes";
import { installDom } from "./support/dom";
import type { QueriedCard, QueryLanes as LaneLayout, StatefulColumn } from "../src/tasks/home/homeApi";

/** Views that work like boards, on the client (lane VIEWS, docs/plan/TASK_VIEWS.md D635–D646). */

const B = "11111111-1111-4111-8111-111111111111";
const B2 = "22222222-2222-4222-8222-222222222222";
const V = "33333333-3333-4333-8333-333333333333";
const K = "44444444-4444-4444-8444-444444444444";
const C3 = "55555555-5555-4555-8555-555555555555";
const U2 = "66666666-6666-4666-8666-666666666666";
installDom("http://nook.test/tasks");

const route = (url: string) => routeFromLocation(new URL(`http://nook.test${url}`)) as TasksRoute;

describe("board view URLs (D636)", () => {
  test("/tasks/:b/views/:v parses and formats, with its card, full page, and Sprints sheet", () => {
    for (const url of [`/tasks/${B}/views/${V}`, `/tasks/${B}/views/${V}/card/${K}`, `/tasks/${B}/views/${V}/card/${K}/full`, `/tasks/${B}/views/${V}/sprints`, `/tasks/${B}/views/${V}?view=table`]) {
      const parsed = route(url);
      expect(parsed).toMatchObject({ app: "tasks", boardId: B, viewId: V });
      expect(formatRoute(parsed)).toBe(url);
    }
    expect(route(`/tasks/${B}/views/${V}/card/${K}`).cardId).toBe(K);
    expect(route(`/tasks/${B}/views/${V}/sprints`).sprints).toBe(true);
    // A malformed view id still opens the board.
    expect(route(`/tasks/${B}/views/nope`)).toMatchObject({ boardId: B, cardId: null });
    expect(route(`/tasks/${B}/views/nope`).viewId).toBeUndefined();
  });

  test("a q= is an unsaved change, even when empty; without one the view's own filter runs", () => {
    expect(route(`/tasks/${B}/views/${V}`).unsaved).toBeUndefined();
    const emptied = route(`/tasks/${B}/views/${V}?q=`);
    expect(emptied.unsaved).toBe(true);
    expect(formatRoute(emptied)).toBe(`/tasks/${B}/views/${V}?q=`);
    const changed = route(`/tasks/${B}/views/${V}?view=list&q=flag:blocked`);
    expect(changed).toMatchObject({ unsaved: true, query: { view: "list" } });
    expect(format(changed.query!.filter)).toBe("flag:blocked");
    expect(formatRoute(changed)).toBe(`/tasks/${B}/views/${V}?view=list&q=flag:blocked`);
    expect(hasFilterParam("?view=list")).toBe(false);
    expect(hasFilterParam("?assignee=me")).toBe(true);
    // A saved route never writes the filter, even if one is in its query object.
    expect(formatBoardViewSearch(withBoardQuery(DEFAULT_BOARD_QUERY, { filter: parse("flag:blocked").ok ? (parse("flag:blocked") as { query: never }).query : { terms: [] } }), false)).toBe("");
  });

  test("helpers keep the view: card, close, parent; a board view's parent is the views list", () => {
    const view = route(`/tasks/${B}/views/${V}?q=flag:blocked`);
    expect(savedViewOf(view)).toEqual({ viewId: V, unsaved: true });
    const card = tasksRoute(B, K, false, view.query, savedViewOf(view));
    expect(formatRoute(card)).toBe(`/tasks/${B}/views/${V}/card/${K}?q=flag:blocked`);
    const closed = cardCloseAction(card, 0, { urlAt: () => undefined });
    expect(closed.kind === "replace" && formatRoute(closed.route)).toBe(`/tasks/${B}/views/${V}?q=flag:blocked`);
    expect(formatRoute(parentTasksRoute(card)!)).toBe(`/tasks/${B}/views/${V}?q=flag:blocked`);
    expect(formatRoute(parentTasksRoute(route(`/tasks/${B}/views/${V}`))! as Route)).toBe("/tasks/views");
    expect(formatRoute(parentTasksRoute(route(`/tasks/${B}`))! as Route)).toBe("/tasks");
  });
});

describe("the board view's filter (D635, D637, D638)", () => {
  const parsed = (text: string) => { const result = parse(text, { boardScoped: true }); if (!result.ok) throw new Error(text); return result.query; };

  test("runs the view's terms without its board term, and stores them with it", () => {
    const query = parsed(`board:${B} assignee:me -flag:blocked`);
    expect(format(boardViewFilter(query, B))).toBe("assignee:me -flag:blocked");
    expect(format(savedBoardFilter({ query: format(query) }, B))).toBe("assignee:me -flag:blocked");
    // Another board's term is not this board's: it stays (and matches nothing in memory).
    expect(format(boardViewFilter(parsed(`board:${B2} state:todo`), B))).toBe(`board:${B2} state:todo`);
    expect(boardViewQueryText(B, parsed("flag:blocked"))).toBe(`board:${B} flag:blocked`);
    expect(boardViewQueryText(B, parsed(`board:${B} flag:blocked`))).toBe(`board:${B} flag:blocked`);
  });

  test("layouts map between the board and the saved display; the calendar keeps the saved one", () => {
    expect(boardLayoutOf({ layout: "table" })).toBe("table");
    expect(boardLayoutOf({ layout: "board" })).toBe("board");
    expect(boardLayoutOf(undefined)).toBe("board");
    expect(displayLayoutOf("calendar", "list")).toBe("list");
    expect(displayLayoutOf("calendar", undefined)).toBe("board");
    expect(displayLayoutOf("table", "list")).toBe("table");
  });

  test("New card starts from single-value positive terms; prefilled fields are not a change", () => {
    const columns = [
      { id: "c1", board_id: B, name: "Backlog", position: 1, is_done: 0, state: "todo", wip_limit: null, created_at: "", updated_at: "" },
      { id: "c2", board_id: B, name: "Doing", position: 2, is_done: 0, state: "doing", wip_limit: null, created_at: "", updated_at: "" },
      { id: C3, board_id: B, name: "Done", position: 3, is_done: 1, state: "done", wip_limit: null, created_at: "", updated_at: "" }
    ] as StatefulColumn[];
    const board = {
      columns, userId: "u1", userName: "Asha",
      tags: [{ id: "t1", board_id: B, name: "Design", color: "blue" as const, card_count: 0 }],
      people: [{ id: U2, display_name: "Ben", can_read: 1 as const }],
      sprints: [{ id: "s1", state: "active" } as never]
    };
    const start = composerStartFor(parsed("state:doing assignee:me tag:design flag:blocked sprint:current"), board);
    expect(start).toEqual({ columnId: "c2", prefill: { assignees: [{ id: "u1", display_name: "Asha", can_read: 1 }], tagIds: ["t1"], flags: ["blocked"] }, sprintId: "s1" });
    expect(composerStartFor(parsed(`column:${C3} assignee:${U2}`), board)).toMatchObject({ columnId: C3, prefill: { assignees: [{ id: U2 }] } });
    // Several values, negations, unknown people: nothing to prefill.
    expect(composerStartFor(parsed("state:todo,doing -flag:blocked assignee:none"), board)).toEqual({ columnId: null, prefill: {} });
    expect(composerStartFor(parsed("sprint:none"), board).sprintId).toBeNull();

    const draft = emptyDraft("c2", {}, start.prefill);
    expect(composerDirty(draft, start.prefill)).toBe(false);
    expect(composerDirty({ ...draft, flags: [] }, start.prefill)).toBe(true);
    expect(composerDirty(draft)).toBe(true);
    expect(composerDirty(emptyDraft("c2"))).toBe(false);
  });
});

const lane = (board: string, id: string, name: string, state: LaneColumn["state"], position: number, extra: Partial<LaneColumn> = {}): LaneColumn =>
  ({ id, board_id: board, name, state, position, wip_limit: null, card_count: 1, ...extra });
const columnsA = [lane("a", "a1", "To do", "todo", 1), lane("a", "a2", "Doing", "doing", 2, { wip_limit: 3, card_count: 3 }), lane("a", "a3", "Done", "done", 3)];
const columnsB = [lane("b", "b1", "To do", "todo", 1), lane("b", "b2", "Review", "doing", 2), lane("b", "b3", "Done", "done", 3)];
const queried = (id: string, board: "a" | "b", column: LaneColumn, extra: Partial<QueriedCard> = {}): QueriedCard => ({
  id, board_id: board, board_name: board === "a" ? "Alpha" : "Beta", column_id: column.id, column_name: column.name, column_state: column.state, is_done: column.state === "done" ? 1 : 0,
  position: 1, title: `Card ${id}`, description_excerpt: "", revision: 1, created_by: null, creator_name: null, due_on: null, due_time: null, due_tz: null, due_at: null,
  assignees: [], tags: [], flags: [], created_at: "", updated_at: "", board_level: "edit", ...extra
});
function layoutOf(mode: "columns" | "state", cards: QueriedCard[]): LaneLayout {
  const built = buildLanes(mode, [...columnsA, ...columnsB]);
  const laneCounts = Object.fromEntries(built.lanes.map((item) => [item.key, 0]));
  for (const card of cards) laneCounts[cardLaneKey({ lanes: built.mode }, card)] += 1;
  return { lanes: built.mode, columns: built.lanes, laneCounts };
}

describe("lanes on the client (D640–D646)", () => {
  const cards = [queried("k1", "a", columnsA[0]!), queried("k2", "b", columnsB[0]!), queried("k3", "b", columnsB[1]!, { board_level: "view" })];
  const layout = layoutOf("columns", cards);
  const named = (label: string) => layout.columns.find((item) => item.label === label)!;

  test("cards sit in their merged lane; a move updates the card, the lane counts, and the columns' counts", () => {
    const byLane = cardsByLane(layout, cards);
    expect([...byLane.entries()].map(([key, items]) => [key, items.map((item) => item.id)])).toEqual([
      ["c:todo:to do", ["k1", "k2"]], ["c:doing:doing", []], ["c:doing:review", ["k3"]], ["c:done:done", []]
    ]);
    const target = named("Done").columns.find((item) => item.board_id === "b")!;
    const moved = withLaneMove({ cards, lanes: layout }, "k2", target);
    expect(moved.cards.find((item) => item.id === "k2")).toMatchObject({ column_id: "b3", column_name: "Done", column_state: "done", is_done: 1, archived_at: null });
    expect(moved.lanes!.laneCounts).toMatchObject({ "c:todo:to do": 1, "c:done:done": 1 });
    expect(moved.lanes!.columns.flatMap((item) => item.columns).find((item) => item.id === "b3")!.card_count).toBe(2);
    expect(moved.lanes!.columns.flatMap((item) => item.columns).find((item) => item.id === "b1")!.card_count).toBe(0);
  });

  test("refusals say why: no such column on the card's board, a full column, a board the viewer cannot edit", () => {
    expect(laneDrop(layout, named("Review"), cards[0]!, true)).toMatchObject({ refusal: "NO_COLUMN", message: "Alpha has no Review column" });
    expect(laneDrop(layout, named("Doing"), cards[0]!, true)).toMatchObject({ refusal: "COLUMN_FULL", message: "“Doing” is full (limit 3). Move a card out of it first." });
    expect(laneDrop(layout, named("Done"), cards[2]!, false)).toMatchObject({ refusal: "READ_ONLY", message: "You can't change cards on Beta" });
    expect(laneDrop(layout, named("Done"), cards[1]!, true)).toMatchObject({ columnId: "b3" });
    // Alt+→ skips lanes that refuse: Alpha's To do card goes past the full Doing and the missing Review to Done.
    expect(nextOpenLane(layout, 0, 1, cards[0]!, true)).toMatchObject({ index: 3, drop: { columnId: "a3" } });
    expect(nextOpenLane(layout, 0, -1, cards[0]!, true)).toBeNull();
  });

  test("the lane card shows its board and reads as a board card", () => {
    const face = faceOf(queried("k9", "a", columnsA[0]!, { tags: [{ id: "t1", name: "Design", color: "blue" }], description_excerpt: "Notes" }));
    expect(face.card).toMatchObject({ tag_ids: ["t1"], has_description: 1, comment_count: 0 });
    expect(face.tags[0]).toMatchObject({ id: "t1", name: "Design" });
    expect(laneStatuses(layout.columns).map((status) => status.kind)).toEqual(["todo", "doing", "doing", "done"]);
  });

  test("renders board columns with the true counts, collapse, strips, refusal hints, and no drag for read-only cards", () => {
    const noop = () => undefined;
    const props = { cards, layout, today: "2026-10-23", onToggleCollapsed: noop, onOpenCard: noop, onMoveCard: noop, onDropCard: noop, onRefused: noop };
    const counted = { ...layout, laneCounts: { ...layout.laneCounts, "c:todo:to do": 7 } };
    const html = renderToStaticMarkup(<QueryLanes {...props} layout={counted} collapsed={new Set(["c:done:done"])} phone={false} />);
    expect(html).toContain('aria-label="2 loaded of 7 cards"');
    expect(html).toContain(">2 · 7</b>");
    expect(html).toContain('aria-label="Collapse Review"');
    expect(html).toContain('aria-label="Expand Done, 0 cards"');
    expect(html).toContain('class="task-column task-lane collapsed"');
    expect(html).toContain("Alpha");
    // k3 is on a board the viewer only views: not draggable, no Move.
    expect(html).toMatch(/data-card-id="k3" draggable="false"/);
    expect(html).toMatch(/data-card-id="k1" draggable="true"/);
    expect(html).not.toContain("Move “Card k3”");
    expect(html).toContain("Move “Card k1”");
    // Phones: tabs and pages, no drag; a collapsed lane keeps its page.
    const phone = renderToStaticMarkup(<QueryLanes {...props} collapsed={new Set(["c:done:done"])} phone />);
    expect(phone).toContain('aria-label="Lanes"');
    expect(phone).toContain("Collapsed</span>");
    expect(phone).not.toContain('draggable="true"');
  });
});

describe("lanes in the home URL and the saved display (D640)", () => {
  test("lanes=state round-trips; columns is the default and left out", () => {
    const state = parseMyWorkSearch("?lanes=state&layout=board");
    expect(homeLanes(state)).toBe("state");
    expect(formatMyWorkSearch(state)).toBe("?layout=board&lanes=state");
    expect(formatMyWorkSearch(myWorkDefault())).toBe("");
    const view = parseViewSearch(`?layout=board&group=none&sort=due&lanes=state&q=board:${B}`)!;
    expect(formatViewSearch(view)).toBe(`?layout=board&group=none&sort=due&lanes=state&q=board:${B}`);
    expect(homeLanes(viewHomeQuery({ query: "", display: { layout: "board", group: "none", sort: "due", lanes: "state" } }))).toBe("state");
    expect(sameHomeQuery(view, { ...view, lanes: undefined })).toBe(false);
  });
});
