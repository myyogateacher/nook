import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { format, parse } from "../shared/taskQuery";
import { formatRoute, parseRoute, sameRoute } from "../src/router";
import { parentTasksRoute, tasksBackAction, tasksHomeRoute, tasksRoute } from "../src/tasksRoute";
import type { QueriedCard, TaskView } from "../src/tasks/home/homeApi";
import { homeChipLabel, withHomeTerm } from "../src/tasks/home/HomeFilterBar";
import { dueBucket, groupResults, refNames, RESTRICTED_BOARD, stateLanes } from "../src/tasks/home/homeResults";
import { HomeSegments } from "../src/tasks/home/HomeSegments";
import { formatMyWorkSearch, formatViewSearch, isSelectiveQuery, myWorkDefault, parseMyWorkSearch, parseViewSearch, sameHomeQuery, serverGroup, viewHomeQuery, withAssigneeMe } from "../src/tasks/home/homeUrl";
import { MyWork, statePreset } from "../src/tasks/home/MyWork";
import { QueryResults } from "../src/tasks/home/QueryResults";
import { TasksHome } from "../src/tasks/home/TasksHome";
import { ColumnStateField } from "../src/tasks/views/ColumnStateField";
import { announceViewsChanged, onViewsChanged, ownedViewActions, validateViewName, viewNameHint, viewRoleAccess, viewUndoBody } from "../src/tasks/views/viewActions";
import { ViewPage } from "../src/tasks/views/ViewPage";
import { RoleContext, useRole } from "../src/team/roleAccess";
import type { Role } from "../src/team/teamRoles";
import { ViewsList } from "../src/tasks/views/ViewsList";

const viewId = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const boardId = "4f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const otherBoard = "5f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const cardId = "a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";
const me = "b1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";
const ann = "c1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";
const noop = () => undefined;

const q = (text: string) => {
  const result = parse(text, { lenient: true });
  if (!result.ok) throw new Error("bad query");
  return result.query;
};

test("the home segments are routes: /tasks/my, /tasks/views, /tasks/views/new, and /tasks/views/:id", () => {
  expect(parseRoute("/tasks/my")).toEqual(tasksHomeRoute({ section: "my" }));
  expect(parseRoute("/tasks/views")).toEqual(tasksHomeRoute({ section: "views" }));
  expect(parseRoute("/tasks/views/new")).toEqual(tasksHomeRoute({ section: "view", viewId: "new" }));
  expect(parseRoute(`/tasks/views/${viewId.toUpperCase()}`)).toEqual(tasksHomeRoute({ section: "view", viewId }));
  // Malformed ids or extra segments fall back to the list; boards are untouched.
  expect(parseRoute("/tasks/views/not-a-view")).toEqual(tasksHomeRoute({ section: "views" }));
  expect(parseRoute(`/tasks/views/${viewId}/extra`)).toEqual(tasksHomeRoute({ section: "views" }));
  expect(parseRoute(`/tasks/${boardId}`)).toEqual(tasksRoute(boardId));
  expect(parseRoute("/tasks")).toEqual(tasksRoute());
  for (const path of ["/tasks/my", "/tasks/views", "/tasks/views/new", `/tasks/views/${viewId}`]) expect(formatRoute(parseRoute(path))).toBe(path);
  // A board wins over a stray home value, and a bad view id never formats.
  expect(formatRoute({ app: "tasks", boardId, cardId: null, home: { section: "my" } })).toBe(`/tasks/${boardId}`);
  expect(formatRoute(tasksHomeRoute({ section: "view", viewId: "../x" }))).toBe("/tasks/views");
});

test("My work keeps its query only when it differs from the default, and always carries assignee:me (Q11)", () => {
  expect(formatMyWorkSearch(myWorkDefault())).toBe("");
  expect(parseMyWorkSearch("")).toEqual(myWorkDefault());
  const table = { ...myWorkDefault(), layout: "table" as const };
  expect(formatMyWorkSearch(table)).toBe("?layout=table");
  expect(formatRoute(parseRoute("/tasks/my", "?layout=table&sort=updated"))).toBe("/tasks/my?layout=table&sort=updated");
  // "All states": only assignee:me is left, which still differs from the default.
  const all = { ...myWorkDefault(), filter: withHomeTerm(myWorkDefault().filter, "state", []) };
  expect(formatMyWorkSearch(all)).toBe("?q=assignee:me");
  expect(parseMyWorkSearch("?q=assignee:me").filter).toEqual(all.filter);
  // A link naming someone else still runs as assignee:me; negated assignees stay.
  expect(format(parseMyWorkSearch(`?q=assignee:${ann}`).filter)).toBe("assignee:me");
  expect(format(withAssigneeMe(q(`-assignee:${ann} flag:urgent`)))).toBe(`assignee:me -assignee:${ann} flag:urgent`);
  // Bad values fall back without throwing.
  expect(parseMyWorkSearch("?layout=grid&group=planet&sort=%%")).toEqual(myWorkDefault());
});

test("a view's URL query is an unsaved override that always names its layout, group, and sort", () => {
  expect(parseViewSearch("")).toBeUndefined();
  const override = { layout: "list" as const, group: "none" as const, sort: "due" as const, filter: { terms: [] } };
  expect(formatViewSearch(override)).toBe("?layout=list&group=none&sort=due");
  expect(parseViewSearch(formatViewSearch(override))).toEqual(override);
  const route = parseRoute(`/tasks/views/${viewId}`, `?layout=board&group=state&sort=title&q=board:${boardId}+state:done`);
  expect(formatRoute(route)).toBe(`/tasks/views/${viewId}?layout=board&group=state&sort=title&q=board:${boardId}+state:done`);
  expect(sameRoute(route, parseRoute(formatRoute(route)))).toBe(true);
  const saved = viewHomeQuery({ query: `state:done board:${boardId}`, display: { layout: "board", group: "state", sort: "title" } });
  if (route.app !== "tasks" || route.home?.section !== "view" || !route.home.query) throw new Error("no override");
  expect(sameHomeQuery(route.home.query, saved)).toBe(true);
  expect(viewHomeQuery({ query: "", display: { layout: "grid", group: "x", sort: "y" } })).toEqual({ layout: "list", group: "none", sort: "due", filter: { terms: [] } });
});

test("Back steps view → views list → board list → Home, and never leaves Nook", () => {
  const view = tasksHomeRoute({ section: "view", viewId });
  expect(parentTasksRoute(view)).toEqual(tasksHomeRoute({ section: "views" }));
  expect(parentTasksRoute(tasksHomeRoute({ section: "views" }))).toEqual(tasksRoute());
  expect(parentTasksRoute(tasksHomeRoute({ section: "my" }))).toEqual(tasksRoute());
  expect(tasksBackAction(view, 0)).toEqual({ kind: "replace", route: tasksHomeRoute({ section: "views" }) });
  expect(tasksBackAction(view, 2)).toEqual({ kind: "history" });
  expect(tasksBackAction(tasksRoute(), 0)).toEqual({ kind: "home" });
  // A card opened from a view is its board's card URL (the view entry stays below it).
  expect(formatRoute(tasksRoute(boardId, cardId))).toBe(`/tasks/${boardId}/card/${cardId}`);
});

test("a view needs a positive key other than text before it runs (Q11)", () => {
  expect(isSelectiveQuery(q(""))).toBe(false);
  expect(isSelectiveQuery(q("\"invoice\""))).toBe(false);
  expect(isSelectiveQuery(q("-state:done"))).toBe(false);
  expect(isSelectiveQuery(q(`board:${boardId}`))).toBe(true);
  expect(isSelectiveQuery(q("flag:urgent \"invoice\""))).toBe(true);
  expect(serverGroup("assignee")).toBe("none");
  expect(serverGroup("due")).toBe("due");
});

function card(id: string, change: Partial<QueriedCard> = {}): QueriedCard {
  return {
    id, board_id: boardId, board_name: "Web", column_id: "col", column_name: "Doing", column_state: "doing", is_done: 0, position: 1, title: `Card ${id}`,
    description_excerpt: "", revision: 1, created_by: me, creator_name: "Me", due_on: null, due_time: null, due_tz: null, due_at: null,
    assignees: [], tags: [], flags: [], created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...change
  };
}

test("results group by due bucket, state, assignee (listed in each), and tag name across boards", () => {
  const today = "2026-09-27";
  expect(dueBucket({ due_on: "2026-09-20" }, today)).toBe("overdue");
  expect(dueBucket({ due_on: today }, today)).toBe("today");
  expect(dueBucket({ due_on: "2026-10-03" }, today)).toBe("week");
  expect(dueBucket({ due_on: "2026-10-04" }, today)).toBe("later");
  expect(dueBucket({ due_on: null }, today)).toBe("none");
  const cards = [
    card("1", { due_on: "2026-10-10", assignees: [{ id: me, display_name: "Pat", can_read: 1 }, { id: ann, display_name: "Ann", can_read: 1 }], tags: [{ id: "t1", name: "UI", color: "blue" }] }),
    card("2", { due_on: "2026-09-01", board_id: otherBoard, board_name: "Home", column_state: "todo", tags: [{ id: "t2", name: "ui", color: "red" }] }),
    card("3", { column_state: "done", is_done: 1 })
  ];
  expect(groupResults(cards, "due", { today, userId: me }).map((group) => [group.label, group.items.length])).toEqual([["Overdue", 1], ["Later", 1], ["No due date", 1]]);
  expect(groupResults(cards, "state", { today, userId: me }).map((group) => group.label)).toEqual(["To do", "In progress", "Done"]);
  const people = groupResults(cards, "assignee", { today, userId: me });
  expect(people.map((group) => group.label)).toEqual(["Ann", "Pat (you)", "No assignee"]);
  expect(people[0]!.items[0]!.also).toEqual(["Pat (you)"]);
  expect(groupResults(cards, "tag", { today, userId: me }).map((group) => [group.label, group.items.length])).toEqual([["UI", 2], ["No tag", 1]]);
  expect(stateLanes(cards).map((lane) => lane.cards.length)).toEqual([1, 1, 1]);
});

test("filter chips name restricted ids only as restricted (T116)", () => {
  const names = refNames({ boards: [{ id: boardId, name: "Web" }, { id: otherBoard, restricted: true }], columns: [], tags: [], users: [{ id: ann, display_name: "Ann" }] },
    { boards: new Map([[otherBoard, "Leaked name"]]), userId: me });
  expect(homeChipLabel(q(`board:${otherBoard},${boardId}`).terms[0]!, names)).toBe(`Board is Web, ${RESTRICTED_BOARD}`);
  expect(homeChipLabel(q(`board:${otherBoard}`).terms[0]!, names)).toBe("Board is Restricted board");
  expect(homeChipLabel(q(`board:${boardId}`).terms[0]!, names)).toBe("Board is Web");
  expect(homeChipLabel(q(`assignee:${ann},me`).terms[0]!, names)).toBe("Assignee is Me, Ann");
  expect(homeChipLabel(q("-state:done").terms[0]!, names)).toBe("State is not Done");
  expect(homeChipLabel(q("due:overdue").terms[0]!, names)).toBe("Overdue");
  expect(names.user("d1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d")).toBe("Unknown person");
});

test("the home filter bar reads the 17A/17B keys in canonical order, and never names a sprint or parent id", () => {
  const names = refNames(undefined, { userId: me });
  const query = q(`has:subtasks level:work sprint:current,none parent:none board:${boardId}`);
  expect(query.terms.map((term) => term.key)).toEqual(["board", "sprint", "parent", "level", "has"]);
  expect(homeChipLabel(query.terms[1]!, names)).toBe("Sprint is Current sprint, Backlog");
  expect(homeChipLabel(query.terms[2]!, names)).toBe("Parent is No parent");
  expect(homeChipLabel(query.terms[3]!, names)).toBe("Level is Work level");
  expect(homeChipLabel(query.terms[4]!, names)).toBe("Has subtasks");
  expect(homeChipLabel(q(`sprint:${otherBoard}`).terms[0]!, names)).toBe("Sprint is a sprint");
  expect(homeChipLabel(q(`-parent:${otherBoard}`).terms[0]!, names)).toBe("Parent is not a parent card");
  expect(withHomeTerm(q("state:todo has:relation"), "sprint", ["next"]).terms.map((term) => term.key)).toEqual(["state", "sprint", "has"]);
});

test("the segments mark the current one, and My work shows its state chips and locked assignee", () => {
  const segments = renderToStaticMarkup(<HomeSegments active="my" onSelect={noop} />);
  expect(segments).toContain('aria-label="Tasks sections"');
  expect(segments).toMatch(/aria-current="page"[^>]*>.*My work/);
  const markup = renderToStaticMarkup(<MyWork userId={me} query={undefined} onQuery={noop} directory={{ boards: [], users: [] }} notify={noop} onOpenCard={noop} onOpenView={noop} />);
  expect(markup).toContain('role="radiogroup" aria-label="State"');
  expect(markup).toMatch(/aria-checked="true"[^>]*>Open</);
  expect(markup).toContain("Assignee is Me");
  expect(markup).not.toContain("Remove filter: Assignee is Me");
  // The default needs no "Save as view".
  expect(markup).not.toContain("Save as view");
  expect(statePreset(myWorkDefault())).toBe("open");
  expect(statePreset({ ...myWorkDefault(), filter: q("assignee:me") })).toBe("all");
});

test("the home renders Boards with segments, and the views list starts loading", () => {
  const boards = renderToStaticMarkup(<TasksHome userId={me} home={undefined} onHome={noop} onOpenBoard={noop} onOpenBoardId={noop} onOpenCard={noop} onBack={noop} notify={noop} />);
  expect(boards).toContain('<h1 id="tasks-title">Tasks</h1>');
  expect(boards).toContain("Loading boards…");
  expect(boards).toContain('aria-label="Tasks sections"');
  const views = renderToStaticMarkup(<ViewsList onOpen={noop} onNew={noop} />);
  expect(views).toContain("Loading views…");
  // The toolbar's New view waits for the list: an empty list offers it in the empty state instead.
  expect(views).not.toContain("New view");
});

test("results show Load more with a cursor and the loaded count", () => {
  const cards = [card("1", { tags: [{ id: "t1", name: "UI", color: "blue" }] }), card("2")];
  const markup = renderToStaticMarkup(<QueryResults cards={cards} layout="list" group="board" today="2026-09-27" userId={me} total={140} nextCursor="next" loadingMore={false}
    onLoadMore={noop} onOpenCard={noop} onMoveCard={noop} emptyText="Nothing" />);
  expect(markup).toContain(">Load more</button>");
  expect(markup).toContain("2 of 140 cards");
  expect(markup).toContain("Move “Card 1”");
  const lanes = renderToStaticMarkup(<QueryResults cards={cards} layout="board" group="none" today="2026-09-27" userId={me} nextCursor={null} loadingMore={false}
    onLoadMore={noop} onOpenCard={noop} onMoveCard={noop} emptyText="Nothing" />);
  expect(lanes).toContain("To do");
  expect(lanes).not.toContain("Load more");
  const table = renderToStaticMarkup(<QueryResults cards={cards} layout="table" group="none" today="2026-09-27" userId={me} nextCursor={null} loadingMore={false}
    onLoadMore={noop} onOpenCard={noop} onMoveCard={noop} emptyText="Nothing" />);
  expect(table).toContain('aria-label="Cards table"');
  expect(renderToStaticMarkup(<QueryResults cards={[]} layout="list" group="none" today="2026-09-27" userId={me} nextCursor={null} loadingMore={false}
    onLoadMore={noop} onOpenCard={noop} onMoveCard={noop} emptyText="Nothing here" />)).toContain("Nothing here");
});

test("the column menu shows the column's state, derived from is_done on older payloads", () => {
  const column = { id: "c1", board_id: boardId, name: "Review", position: 2, is_done: 0 as const, created_at: "", updated_at: "" };
  expect(renderToStaticMarkup(<ColumnStateField column={{ ...column, state: "todo" } as typeof column} onChanged={noop} onError={noop} />)).toContain("To do");
  expect(renderToStaticMarkup(<ColumnStateField column={column} onChanged={noop} onError={noop} />)).toContain("In progress");
  expect(renderToStaticMarkup(<ColumnStateField column={{ ...column, is_done: 1 }} onChanged={noop} onError={noop} />)).toContain("Done");
});

test("view names follow the server rule, and Undo re-creates the same body", () => {
  expect(validateViewName("  Urgent  ")).toEqual({ ok: true, name: "Urgent", changed: true });
  expect(validateViewName("Urgent", "Urgent")).toEqual({ ok: true, name: "Urgent", changed: false });
  expect(validateViewName(" ").ok).toBe(false);
  expect(validateViewName("x".repeat(81)).ok).toBe(false);
  expect(validateViewName("bad\u0007").ok).toBe(false);
  expect(viewUndoBody({ name: "A", query: "flag:urgent", display: { layout: "table", group: "none", sort: "due" } })).toEqual({ name: "A", query: "flag:urgent", display: { layout: "table", group: "none", sort: "due" } });
});

test("Undo of a deleted view refreshes the views list without a reload (QA FAIL-1)", () => {
  const target = new EventTarget();
  let loads = 0;
  const stop = onViewsChanged(() => { loads += 1; }, target);
  announceViewsChanged(target);
  expect(loads).toBe(1);
  stop();
  announceViewsChanged(target);
  expect(loads).toBe(1);
  const list = readFileSync(new URL("../src/tasks/views/ViewsList.tsx", import.meta.url), "utf8");
  expect(list).toContain("onViewsChanged(() => { void load(); })");
  const page = readFileSync(new URL("../src/tasks/views/ViewPage.tsx", import.meta.url), "utf8");
  expect(page).toMatch(/createView\(body\)\.then\(\(\{ view: restored \}\) => \{\s*announceViewsChanged\(\);/);
});

test("views follow the Team role (Wave 15, Q12): viewers save private views, guests save none, read-only roles never share", () => {
  const as = (role: Role | undefined, node: React.ReactNode) => renderToStaticMarkup(<RoleContext.Provider value={role}>{node}</RoleContext.Provider>);
  function Access() {
    const access = viewRoleAccess(useRole());
    return <span data-create={String(access.canCreate)} data-share={String(access.canShare)} />;
  }
  expect(as("admin", <Access />)).toBe(`<span data-create="true" data-share="true"></span>`);
  expect(as("member", <Access />)).toBe(`<span data-create="true" data-share="true"></span>`);
  expect(as(undefined, <Access />)).toBe(`<span data-create="true" data-share="true"></span>`);
  expect(as("viewer", <Access />)).toBe(`<span data-create="true" data-share="false"></span>`);
  expect(as("guest", <Access />)).toBe(`<span data-create="false" data-share="false"></span>`);
  expect(viewNameHint(false)).not.toContain("share");
  // A read-only owner changes a view only while it is private, and may withdraw a share.
  expect(ownedViewActions(true, "all_users")).toEqual({ edit: true, share: true, withdraw: false });
  expect(ownedViewActions(false, "private")).toEqual({ edit: true, share: false, withdraw: false });
  expect(ownedViewActions(false, "selected")).toEqual({ edit: false, share: false, withdraw: true });
  expect(ownedViewActions(false, "all_users")).toEqual({ edit: false, share: false, withdraw: true });

  const saved = { id: "v1", name: "Urgent", owner_id: me, owner_name: "Me", is_owner: 1, visibility: "private", query: "", display: { layout: "list" },
    position: 1, revision: 1, created_at: "", updated_at: "" } as unknown as TaskView;
  const lists = { mine: [saved], shared: [], everyone: [], truncated: false };
  const newViewButtons = (html: string) => html.split(">New view</").length - 1;
  const list = (role: Role) => as(role, <ViewsList onOpen={noop} onNew={noop} initialLists={lists} />);
  for (const role of ["admin", "member", "viewer"] as const) expect(newViewButtons(list(role))).toBe(1);
  expect(list("guest")).not.toContain("New view");
  // An empty list shows New view once, in the empty state, not again in the toolbar.
  const empty = (role: Role) => as(role, <ViewsList onOpen={noop} onNew={noop} initialLists={{ mine: [], shared: [], everyone: [], truncated: false }} />);
  expect(newViewButtons(empty("member"))).toBe(1);
  expect(empty("member")).not.toContain("task-home-toolbar");
  expect(empty("guest")).not.toContain("New view");

  const newView = (role: Role) => as(role, <ViewPage userId={me} viewId="new" query={undefined} onQuery={noop} directory={{ boards: [], users: [] }} notify={noop}
    onOpenCard={noop} onOpenView={noop} onBack={noop} onMissing={noop} onDeleted={noop} />);
  for (const role of ["member", "viewer"] as const) expect(newView(role)).toContain("Save view");
  expect(newView("guest")).not.toContain("Save view");
  // A guest's New view is read only: no + Filter.
  expect(newView("viewer")).toContain("+ Filter");
  expect(newView("guest")).not.toContain("+ Filter");

  const filtered = { ...myWorkDefault(), filter: q("assignee:me state:done") };
  const myWork = (role: Role) => as(role, <MyWork userId={me} query={filtered} onQuery={noop} directory={{ boards: [], users: [] }} notify={noop} onOpenCard={noop} onOpenView={noop} />);
  for (const role of ["member", "viewer"] as const) expect(myWork(role)).toContain("Save as view");
  expect(myWork("guest")).not.toContain("Save as view");
});

test("the Tasks home keeps one vertical rhythm under the segments", () => {
  const css = readFileSync(new URL("../src/tasks/home/home.css", import.meta.url), "utf8");
  // Block-level segments, so the 16 px gap is the same above and below 760 px.
  expect(css).toContain(".task-home-segments { display: flex; width: fit-content; max-width: 100%; margin: 0 0 16px;");
  expect(css).toContain(".task-home-segments + .tasks-section-label { margin-top: 0; }");
  expect(css).toContain(".task-views > .task-home-toolbar { margin-bottom: 12px; }");
  expect(css).toContain(".task-home-pane { display: grid; gap: 12px;");
});
