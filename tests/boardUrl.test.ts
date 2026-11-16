import { expect, test } from "bun:test";
import { format, TASK_QUERY_LIMITS } from "../shared/taskQuery";
import { isRouteMonth } from "../src/router";
import { DEFAULT_BOARD_QUERY, formatBoardSearch, hasBoardFilter, isBoardMonth, isDefaultBoardQuery, parseBoardSearch } from "../src/tasks/boardUrl";

// WAVE_13_TASK_CARD_UX.md §4.6 (URL state), §7 `tests/boardUrl.test.ts`, T102. The filters are the
// one task grammar (shared/taskQuery.ts, 17C) carried as `q=`; this module owns the presentation keys.
const user = "a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";
const tag = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const column = "4f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

test("the default query formats as no query string at all", () => {
  expect(formatBoardSearch(DEFAULT_BOARD_QUERY)).toBe("");
  expect(isDefaultBoardQuery(parseBoardSearch(""))).toBe(true);
  expect(isDefaultBoardQuery(parseBoardSearch("?view=board&cal=month&q="))).toBe(true);
  expect(hasBoardFilter(parseBoardSearch("?q=flag:urgent"))).toBe(true);
});

test("presentation keys and the canonical q round-trip in a fixed order with readable : and ,", () => {
  const search = `?q=flag:urgent,blocked assignee:me&view=table&sort=due:desc&month=2026-10&cal=agenda&group=tag`;
  const query = parseBoardSearch(search);
  expect(query.view).toBe("table");
  expect(query.group).toBe("tag");
  expect(query.sort).toEqual({ field: "due", direction: "desc" });
  expect(query.cal).toBe("agenda");
  expect(query.month).toBe("2026-10");
  expect(format(query.filter)).toBe("assignee:me flag:urgent,blocked");
  const canonical = formatBoardSearch(query);
  expect(canonical).toBe("?view=table&group=tag&sort=due:desc&cal=agenda&month=2026-10&q=assignee:me+flag:urgent,blocked");
  expect(formatBoardSearch(parseBoardSearch(canonical))).toBe(canonical);
  // Term order in the input never changes the output.
  expect(formatBoardSearch(parseBoardSearch("?q=flag:blocked,urgent assignee:me"))).toBe(formatBoardSearch(parseBoardSearch("?q=assignee:me flag:urgent,blocked")));
});

test("the older per-key parameters still read, and are written back as one q", () => {
  const query = parseBoardSearch(`?assignee=${user}&assignee=me&tag=${tag.toUpperCase()}&due=overdue&due=before:2026-10-01&column=${column}&rel=blocked&view=list`);
  expect(formatBoardSearch(query)).toBe(`?view=list&q=column:${column}+assignee:me,${user}+tag:${tag}+due:overdue,%3C2026-10-01+has:blocked`);
  expect(format(parseBoardSearch("?rel=none").filter)).toBe("-has:relation");
});

test("invalid values and unknown keys are dropped, never thrown", () => {
  const query = parseBoardSearch("?view=kanban&group=owner&sort=title:up&cal=week&month=2026-13&assignee=bob&assignee=me&tag=%00x&flag=spicy&due=yesterday&column=none&rel=parent&evil=<script>&__proto__=1");
  expect({ ...query, filter: format(query.filter) }).toEqual({ ...DEFAULT_BOARD_QUERY, filter: "assignee:me" });
  expect(format(parseBoardSearch("?q=nonsense:key flag:urgent due:2026-02-30").filter)).toBe("priority:urgent");
  expect(parseBoardSearch("?month=1899-12").month).toBeNull();
  expect(parseBoardSearch("?month=2026-07").month).toBe("2026-07");
  expect(parseBoardSearch("%%%&&=&view").view).toBe("board");
  expect(parseBoardSearch(`?view=table&${"x=1&".repeat(2000)}`).view).toBe("board");
  // The month rule is the router's.
  for (const value of ["2026-01", "1900-01", "2200-12", "2201-01", "1899-12", "2026-1", "x"]) expect(isBoardMonth(value)).toBe(isRouteMonth(value));
});

test("the grammar's limits bound what a URL can carry", () => {
  const many = Array.from({ length: 30 }, (_, index) => `${index.toString(16).padStart(8, "0")}-4d5a-4b6c-8d7e-9f0a1b2c3d4e`).join(",");
  expect(parseBoardSearch(`?q=tag:${many}`).filter.terms[0]!.values).toHaveLength(TASK_QUERY_LIMITS.values);
  const terms = Array.from({ length: 30 }, (_, index) => `"w${index}"`).join(" ");
  expect(parseBoardSearch(`?q=${encodeURIComponent(terms)}`).filter.terms).toHaveLength(TASK_QUERY_LIMITS.terms);
  // A text term over 100 characters is dropped, a control character drops its term.
  expect(parseBoardSearch(`?q=${"é".repeat(150)}`).filter.terms).toEqual([]);
  expect(parseBoardSearch("?q=%22a%07b%22 flag:urgent").filter.terms.map((term) => term.key)).toEqual(["priority"]);
});

test("hostile text stays text inside its parameter", () => {
  const hostile = parseBoardSearch(`?q=${encodeURIComponent('"<img src=x onerror=alert(1)>"')}`);
  expect(hostile.filter.terms).toEqual([{ key: "text", negate: false, values: ["<img src=x onerror=alert(1)>"] }]);
  const encoded = formatBoardSearch(hostile);
  expect(encoded.startsWith("?q=%22%3Cimg+src%3Dx+onerror%3Dalert%281%29%3E%22")).toBe(true);
  expect(format(parseBoardSearch(encoded).filter)).toBe('"<img src=x onerror=alert(1)>"');
});
