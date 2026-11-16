import { expect, test } from "bun:test";
import { format, parse, type TaskQuery } from "../shared/taskQuery";
import { applyBoardQuery, boardData, BOARD_REGISTRIES, dueGroupOf, filterBoardCards, FILTER_FIELDS, GROUP_DIMENSIONS, sortBoardCards, termValues, textTerm, withoutTerm, withTermValues, withText, type BoardCard, type BoardContext, type BoardData, type GroupDimension } from "../src/tasks/boardQuery";
import { DEFAULT_BOARD_QUERY, parseBoardSearch, type BoardQuery } from "../src/tasks/boardUrl";
import type { CardSummary } from "../src/tasks/tasksApi";

// WAVE_13_TASK_CARD_UX.md §4.5 (one pipeline, two registries), §4.6, §7 `tests/boardQuery.test.ts`.
const me = "11111111-1111-4111-8111-111111111111";
const asha = "22222222-2222-4222-8222-222222222222";
const ben = "33333333-3333-4333-8333-333333333333";
const todo = "aaaaaaaa-0000-4000-8000-000000000001";
const doing = "aaaaaaaa-0000-4000-8000-000000000002";
const done = "aaaaaaaa-0000-4000-8000-000000000003";
const backend = "bbbbbbbb-0000-4000-8000-000000000001";
const design = "bbbbbbbb-0000-4000-8000-000000000002";

const person = (id: string, name: string) => ({ id, display_name: name, can_read: 1 as const });
function card(id: string, change: Partial<CardSummary> & Record<string, unknown> = {}): CardSummary {
  return {
    id, board_id: "b", column_id: todo, position: 1, title: id, has_description: 0, revision: 1, created_by: me, creator_name: "Me",
    due_on: null, assignees: [], assignee_id: null, assignee_name: null, comment_count: 0, attachment_count: 0,
    created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z", ...change
  } as CardSummary;
}

const column = (id: string, name: string, position: number) => ({ id, board_id: "b", name, position, is_done: 0 as 0 | 1, created_at: "", updated_at: "" });
const board: BoardData = boardData({
  columns: [{ ...column(done, "Done", 3072), is_done: 1 }, column(todo, "To do", 1024), column(doing, "Doing", 2048)],
  tags: [{ id: backend, name: "Backend", color: "blue" }, { id: design, name: "Design", color: "pink" }],
  cards: [
    card("login", { title: "Fix login", position: 1, assignees: [person(asha, "Asha"), person(ben, "Ben")], tag_ids: [backend, design], flags: [], priority: "urgent", due_on: "2026-09-25", description_excerpt: "Crème brûlée recipe", relation_count: 2, open_blockers: 1 }),
    card("docs", { title: "Écrire docs", position: 2, assignees: [person(me, "Pat")], tag_ids: [design], due_on: "2026-09-26", created_at: "2026-09-03T00:00:00.000Z" }),
    card("api", { title: "api keys", column_id: doing, position: 1, flags: ["blocked", "on_hold"], priority: "low", due_on: "2026-09-27", due_time: "23:30", due_tz: "Pacific/Kiritimati", due_at: "2026-09-27T09:30:00.000Z", relation_count: 1, open_blockers: 0 }),
    card("ship", { title: "Ship", column_id: done, position: 1, assignees: [person(ben, "Ben")], due_on: "2026-10-10", updated_at: "2026-09-20T00:00:00.000Z" }),
    card("idea", { title: "Idea", column_id: doing, position: 2 })
  ]
});
// Saturday 26 September 2026 at 12:00 UTC, viewer in UTC.
const context: BoardContext = { userId: me, today: "2026-09-26", now: Date.parse("2026-09-26T12:00:00.000Z"), timeZone: "UTC" };
const ids = (cards: readonly BoardCard[]) => cards.map((item) => item.id);
const run = (search: string, change: Partial<BoardContext> = {}) => ids(applyBoardQuery(board, parseBoardSearch(search), { ...context, ...change }).cards);

test("boardData fills the optional payload fields and orders columns", () => {
  const plain = boardData({ columns: [column(todo, "To do", 1)], cards: [card("x", { assignees: undefined })] });
  expect(plain.cards[0]).toMatchObject({ description_excerpt: "", tag_ids: [], flags: [], assignees: [] });
  expect(plain.tags).toEqual([]);
  expect(board.columns.map((item) => item.name)).toEqual(["To do", "Doing", "Done"]);
});

test("each filter field, with me and none, OR within a field and AND across fields", () => {
  expect(run("")).toEqual(["login", "docs", "api", "idea", "ship"]);
  expect(run("?assignee=me")).toEqual(["docs"]);
  expect(run(`?assignee=${ben}`)).toEqual(["login", "ship"]);
  expect(run("?assignee=none")).toEqual(["api", "idea"]);
  expect(run(`?assignee=me&assignee=${asha}`)).toEqual(["login", "docs"]);
  expect(run(`?tag=${design}`)).toEqual(["login", "docs"]);
  expect(run("?tag=none")).toEqual(["api", "idea", "ship"]);
  expect(run("?flag=on_hold&flag=urgent")).toEqual(["login", "api"]);
  // Urgent is a priority now (D1310): "login" has no flag; priority filters OR their values (D1315).
  expect(run("?flag=none")).toEqual(["login", "docs", "idea", "ship"]);
  expect(run("?q=priority:urgent,low")).toEqual(["login", "api"]);
  expect(run("?q=priority:none")).toEqual(["docs", "idea", "ship"]);
  expect(run("?q=-priority:none")).toEqual(["login", "api"]);
  expect(run(`?column=${doing}`)).toEqual(["api", "idea"]);
  expect(run("?rel=any")).toEqual(["login", "api"]);
  expect(run("?rel=blocked")).toEqual(["login"]);
  expect(run("?rel=none")).toEqual(["docs", "idea", "ship"]);
  expect(run("?due=before:2026-09-27")).toEqual(["login", "docs"]);
  // Values of one term OR; terms AND.
  expect(run("?due=after:2026-09-26&due=before:2026-10-10")).toEqual(["login", "docs", "api", "ship"]);
  expect(run("?q=due:>2026-09-26 due:<2026-10-10")).toEqual(["api"]);
  expect(run("?due=none")).toEqual(["idea"]);
  // AND across fields.
  expect(run(`?tag=${design}&assignee=me`)).toEqual(["docs"]);
  expect(run(`?tag=${design}&flag=blocked`)).toEqual([]);
  // A tag id no card carries matches nothing (it renders as "Unknown tag").
  expect(run("?tag=bbbbbbbb-0000-4000-8000-00000000ffff")).toEqual([]);
});

test("text matches the title and excerpt, ignoring case and accents", () => {
  expect(run("?q=ECRIRE")).toEqual(["docs"]);
  expect(run("?q=creme brulee")).toEqual(["login"]);
  expect(run("?q=KEYS")).toEqual(["api"]);
  expect(run("?q=zzz")).toEqual([]);
});

test("relative due windows compare the card's date with the viewer's today", () => {
  // api is due 23:30 on the 27th at UTC+14 (the 27th 09:30 UTC).
  expect(run("?due=overdue")).toEqual(["login"]);
  expect(run("?due=today")).toEqual(["docs"]);
  // week is today and the next six days; next-week the seven after.
  expect(run("?due=week")).toEqual(["docs", "api"]);
  expect(run("?q=due:next-week")).toEqual([]);
  expect(run("?q=due:next-week", { today: "2026-09-28" })).toEqual(["ship"]);
  expect(run("?due=today", { today: "2026-09-27" })).toEqual(["api"]);
  // Once its instant passed, a timed card is overdue even on its own day.
  expect(run("?due=overdue", { now: Date.parse("2026-09-27T10:00:00.000Z"), today: "2026-09-27" })).toEqual(["login", "docs", "api"]);
  // A date-only card is due today until midnight, then overdue.
  expect(dueGroupOf(board.cards[1]!, board, context)).toBe("today");
  expect(dueGroupOf(board.cards[1]!, board, { ...context, today: "2026-09-27" })).toBe("overdue");
  expect(run("?due=overdue&due=none")).toEqual(["login", "idea"]);
  expect(run("?due=today&due=after:2026-10-01")).toEqual(["docs", "ship"]);
});

test("the grammar-only terms run in memory: negation, tag names, state, creator, has", () => {
  expect(run("?q=-flag:urgent")).toEqual(["docs", "api", "idea", "ship"]);
  expect(run("?q=-due:overdue")).toEqual(["docs", "api", "idea", "ship"]);
  expect(run("?q=tag:backend")).toEqual(["login"]);
  expect(run(`?q=${encodeURIComponent('tag:"DESIGN"')}`)).toEqual(["login", "docs"]);
  expect(run("?q=state:done")).toEqual(["ship"]);
  expect(run("?q=-state:done")).toEqual(["login", "docs", "api", "idea"]);
  expect(run("?q=creator:me")).toEqual(["login", "docs", "api", "idea", "ship"]);
  expect(run("?q=has:blocked")).toEqual(["login"]);
  expect(run("?q=has:relation -has:blocked")).toEqual(["api"]);
  // The structured path and the in-memory matcher agree wherever both apply.
  for (const text of [`assignee:me,${ben}`, `tag:${design}`, "flag:none", "due:<2026-09-27,none", `column:${doing}`, '"login"']) {
    const parsed = parse(text, { boardScoped: true });
    if (!parsed.ok) throw new Error(text);
    const structured = ids(filterBoardCards(board, parsed.query, context));
    const negatedTwice = ids(filterBoardCards(board, { terms: [...parsed.query.terms, { key: "flag", negate: true, values: ["on_hold"] }] }, context));
    expect(negatedTwice).toEqual(structured.filter((id) => id !== "api"));
  }
});

test("each grouping dimension; a card with two assignees or tags appears in each group", () => {
  const groups = (group: string) => applyBoardQuery(board, { ...DEFAULT_BOARD_QUERY, view: "list", group: group as BoardQuery["group"] }, context).groups!;
  const shape = (group: string) => groups(group).map((item) => [item.label, ids(item.items.map((entry) => entry.card))]);
  expect(shape("column")).toEqual([["To do", ["login", "docs"]], ["Doing", ["api", "idea"]], ["Done", ["ship"]]]);
  expect(shape("assignee")).toEqual([["Asha", ["login"]], ["Ben", ["login", "ship"]], ["Pat (you)", ["docs"]], ["No assignee", ["api", "idea"]]]);
  expect(shape("tag")).toEqual([["Backend", ["login"]], ["Design", ["login", "docs"]], ["No tag", ["api", "idea", "ship"]]]);
  expect(shape("flag")).toEqual([["Blocked", ["api"]], ["On hold", ["api"]], ["No flag", ["login", "docs", "idea", "ship"]]]);
  expect(shape("priority")).toEqual([["Urgent", ["login"]], ["Low", ["api"]], ["No priority", ["docs", "idea", "ship"]]]);
  expect(shape("due")).toEqual([["Overdue", ["login"]], ["Today", ["docs"]], ["Next 7 days", ["api"]], ["Later", ["ship"]], ["No date", ["idea"]]]);
  // "also in …" names the card's other groups.
  expect(groups("assignee")[0]!.items[0]!.also).toEqual(["Ben"]);
  expect(groups("tag")[1]!.items[0]!.also).toEqual(["Backend"]);
  // Empty columns still show; filters apply before grouping.
  const filtered = applyBoardQuery(board, { ...parseBoardSearch("?flag=urgent"), view: "list" }, context).groups!;
  expect(filtered.map((item) => [item.label, item.items.length])).toEqual([["To do", 1], ["Doing", 0], ["Done", 0]]);
  // Other views get no groups.
  expect(applyBoardQuery(board, { ...DEFAULT_BOARD_QUERY, view: "table" }, context).groups).toBeNull();
});

test("table sorts are stable and tie-break on board order; empty values sort last both ways", () => {
  const sort = (value: string) => ids(sortBoardCards(board.cards, board, parseBoardSearch(`?sort=${value}`).sort));
  expect(sort("title:asc")).toEqual(["api", "docs", "login", "idea", "ship"]);
  expect(sort("title:desc")).toEqual(["ship", "idea", "login", "docs", "api"]);
  expect(sort("column:asc")).toEqual(["login", "docs", "api", "idea", "ship"]);
  expect(sort("column:desc")).toEqual(["ship", "idea", "api", "docs", "login"]);
  expect(sort("due:asc")).toEqual(["login", "docs", "api", "ship", "idea"]);
  expect(sort("due:desc")).toEqual(["ship", "api", "docs", "login", "idea"]);
  expect(sort("assignees:asc")).toEqual(["login", "ship", "docs", "api", "idea"]);
  expect(sort("assignees:desc")).toEqual(["docs", "ship", "login", "api", "idea"]);
  expect(sort("tags:asc")).toEqual(["login", "docs", "api", "idea", "ship"]);
  expect(sort("tags:desc")).toEqual(["docs", "login", "api", "idea", "ship"]);
  expect(sort("flags:asc")).toEqual(["api", "login", "docs", "idea", "ship"]);
  // D1316: Urgent first; cards without a priority last both ways.
  expect(sort("priority:asc")).toEqual(["login", "api", "docs", "idea", "ship"]);
  expect(sort("priority:desc")).toEqual(["api", "login", "docs", "idea", "ship"]);
  expect(sort("created:desc")).toEqual(["docs", "login", "api", "idea", "ship"]);
  expect(sort("updated:desc")).toEqual(["ship", "login", "docs", "api", "idea"]);
});

test("the filter bar edits one positive term per field and keeps the query canonical", () => {
  let query: TaskQuery = { terms: [] };
  query = withTermValues(query, "tag", [design, "none"]);
  query = withTermValues(query, "flag", ["on_hold"]);
  query = withText(query, "  login  ");
  expect(format(query)).toBe(`tag:none,${design} flag:on_hold "login"`);
  expect(format(withTermValues(query, "priority", ["low", "urgent"]))).toBe(`tag:none,${design} priority:urgent,low flag:on_hold "login"`);
  // The legacy Urgent flag alone is the Urgent priority (D1313).
  expect(format(withTermValues(query, "flag", ["urgent"]))).toBe(`tag:none,${design} priority:urgent "login"`);
  expect(termValues(query, "tag")).toEqual(["none", design]);
  expect(textTerm(query)).toBe("login");
  query = withTermValues(query, "flag", []);
  expect(format(query)).toBe(`tag:none,${design} "login"`);
  // A negated term from a shared URL is kept when the positive one changes, and removed by index.
  const parsed = parse("-flag:needs_review flag:blocked", { boardScoped: true });
  if (!parsed.ok) throw new Error("parse");
  expect(format(withTermValues(parsed.query, "flag", ["on_hold"]))).toBe("flag:on_hold -flag:needs_review");
  expect(format(withoutTerm(parsed.query, 1))).toBe("flag:blocked");
  expect(format(withText(query, ""))).toBe(`tag:none,${design}`);
  expect(FILTER_FIELDS.assignee!.optionsFor(board, context).map((option) => option.label)).toEqual(["Me", "Asha", "Ben", "No assignee"]);
  expect(FILTER_FIELDS.tag!.labelFor("bbbbbbbb-0000-4000-8000-00000000ffff", board, context)).toBe("Unknown tag");
  expect(FILTER_FIELDS.due!.labelFor("<2026-10-01", board, context)).toBe(`before ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 9, 1)))}`);
  expect(Object.keys(GROUP_DIMENSIONS)).toEqual(["column", "assignee", "tag", "priority", "flag", "parent", "due"]);
});

test("hierarchy readiness: a stub `parent` dimension and filter plug in without code changes", () => {
  const parentOf: Record<string, string> = { login: "epic", docs: "epic", api: "infra" };
  const parent: GroupDimension = {
    label: "Parent",
    keysFor: (item) => [parentOf[item.id] ?? "none"],
    labelFor: (key) => key === "none" ? "No parent" : key,
    order: (keys) => [...keys].sort()
  };
  const registries = {
    groups: { ...BOARD_REGISTRIES.groups, parent },
    filters: { ...BOARD_REGISTRIES.filters, parent: { ...FILTER_FIELDS.column!, label: "Parent", param: "parent", match: (item: BoardCard, values: readonly string[]) => values.includes(parentOf[item.id] ?? "none") } }
  };
  const result = applyBoardQuery(board, { ...DEFAULT_BOARD_QUERY, view: "list", group: "parent" as BoardQuery["group"], extra: { parent: ["epic", "none"] } }, context, registries);
  expect(result.groups!.map((item) => [item.label, ids(item.items.map((entry) => entry.card))])).toEqual([["epic", ["login", "docs"]], ["No parent", ["idea", "ship"]]]);
});
