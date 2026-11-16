import { describe, expect, test } from "bun:test";
import {
  canonicalize,
  cardFilterFromQuery,
  decodeFilterParams,
  dueWindow,
  encodeFilterParams,
  format,
  parse,
  queryFromCardFilter,
  scopedBoardId,
  TASK_QUERY_LIMITS,
  validateQuery,
  type TaskQuery
} from "../shared/taskQuery";

/** The shared task filter grammar (research 2026-09-26 §10.3, §11.2 `tests/taskQuery.test.ts`). Pure: no server. */

const A = "0b6c1c7e-2f7a-4d8e-9a51-7b0e0d6f1a01";
const B = "0b6c1c7e-2f7a-4d8e-9a51-7b0e0d6f1a02";
const C = "0b6c1c7e-2f7a-4d8e-9a51-7b0e0d6f1a03";

const ok = (input: string, options = {}) => {
  const result = parse(input, options);
  if (!result.ok) throw new Error(`expected ${input} to parse: ${result.error.message}`);
  return result.query;
};
const fail = (input: string, options = {}) => {
  const result = parse(input, options);
  if (result.ok) throw new Error(`expected ${input} to fail`);
  return result.error;
};
const canon = (input: string) => format(ok(input));

describe("parse and format", () => {
  test("keys, OR values, AND terms, and negation", () => {
    expect(ok("assignee:me state:todo,doing due:overdue,week")).toEqual({
      terms: [
        { key: "state", negate: false, values: ["todo", "doing"] },
        { key: "assignee", negate: false, values: ["me"] },
        { key: "due", negate: false, values: ["overdue", "week"] }
      ]
    });
    expect(ok("-state:done").terms).toEqual([{ key: "state", negate: true, values: ["done"] }]);
    expect(ok("")).toEqual({ terms: [] });
    expect(ok("   ")).toEqual({ terms: [] });
  });

  test("the canonical form orders keys, puts positive before negated, sorts and dedupes values", () => {
    expect(canon(`due:week,overdue -state:done state:doing,todo,doing ASSIGNEE:ME board:${B.toUpperCase()}`))
      .toBe(`board:${B} state:todo,doing -state:done assignee:me due:overdue,week`);
    expect(canon(`assignee:${B},none,me,${A}`)).toBe(`assignee:me,none,${A},${B}`);
    expect(canon("flag:none,on_hold,urgent")).toBe("flag:urgent,on_hold,none");
    expect(canon("due:>2026-10-02,2026-10-01,<2026-10-01,today")).toBe("due:today,2026-10-01,<2026-10-01,>2026-10-02");
    // Exact duplicate terms collapse; distinct terms of one key stay separate (they AND).
    expect(canon("state:todo state:todo")).toBe("state:todo");
    expect(canon(`assignee:me assignee:${A}`)).toBe(`assignee:${A} assignee:me`);
  });

  test("round-trips: parse(format(q)) is q, and format is idempotent", () => {
    const inputs = [
      `board:${A} column:${B} -tag:"Needs design",none flag:blocked "invoice" -"draft copy"`,
      `creator:me assignee:none due:none has:relation,blocked -has:blocked`,
      `tag:"say \\"hi\\"" "back\\\\slash"`,
      `due:before:2026-10-01 due:after:2026-01-31`
    ];
    for (const input of inputs) {
      const once = canon(input);
      expect(format(ok(once))).toBe(once);
      expect(ok(once)).toEqual(ok(input));
    }
    expect(canon("due:before:2026-10-01 due:after:2026-01-31")).toBe("due:<2026-10-01 due:>2026-01-31");
  });

  test("text: quoted phrases, bare words, negation, NFC, and quoting on output", () => {
    expect(ok('"monthly invoice" draft -"old"').terms).toEqual([
      { key: "text", negate: false, values: ["draft"] },
      { key: "text", negate: false, values: ["monthly invoice"] },
      { key: "text", negate: true, values: ["old"] }
    ]);
    expect(canon("invoice")).toBe('"invoice"');
    expect(ok('"café"').terms[0]!.values[0]).toBe("café");
    expect(canon('tag:"a,b"')).toBe('tag:"a,b"');
    // A lone dash is text, not negation.
    expect(ok("- x").terms.map((term) => term.values[0])).toEqual(["-", "x"]);
  });

  test("tags: ids, names (case-insensitive dedupe), and none", () => {
    expect(ok(`tag:${A.toUpperCase()},Backend,backend,none`).terms[0]!.values).toEqual(["none", A, "Backend"]);
    expect(fail(`tag:"${"x".repeat(41)}"`).code).toBe("FILTER_INVALID");
  });

  test("an unknown key is echoed back at most 40 characters long", () => {
    expect(fail("owner:me").message).toBe("Unknown filter owner:");
    const long = fail(`${"k".repeat(1500)}:x`);
    expect(long).toMatchObject({ code: "FILTER_INVALID", position: 0 });
    expect(long.message).toBe(`Unknown filter ${"k".repeat(40)}…:`);
  });

  test("errors carry a code and the character position", () => {
    expect(fail("state:todo owner:me")).toMatchObject({ code: "FILTER_INVALID", position: 11 });
    expect(fail("state:later")).toMatchObject({ code: "FILTER_INVALID", position: 6 });
    expect(fail("state:todo,,done")).toMatchObject({ code: "FILTER_INVALID", position: 11 });
    expect(fail("assignee:bob")).toMatchObject({ code: "FILTER_INVALID", position: 9 });
    expect(fail("board:me")).toMatchObject({ code: "FILTER_INVALID" });
    expect(fail("creator:none")).toMatchObject({ code: "FILTER_INVALID" });
    expect(fail("due:2026-02-30")).toMatchObject({ code: "FILTER_INVALID", position: 4 });
    expect(fail("due:1899-12-31")).toMatchObject({ code: "FILTER_INVALID" });
    expect(fail('"open quote')).toMatchObject({ code: "FILTER_INVALID", position: 0 });
    expect(fail('"a"b')).toMatchObject({ code: "FILTER_INVALID", position: 3 });
    expect(fail('ab"c')).toMatchObject({ code: "FILTER_INVALID", position: 2 });
    expect(fail("state:")).toMatchObject({ code: "FILTER_INVALID", position: 6 });
    expect(fail("text:hello")).toMatchObject({ code: "FILTER_INVALID", position: 0 });
    expect(fail("state:todo\u0007")).toMatchObject({ code: "FILTER_INVALID" });
    expect(fail(`"${"x".repeat(101)}"`)).toMatchObject({ code: "FILTER_INVALID" });
  });

  test("the sprint key (17B): current, next, none (backlog), and ids, in canonical form", () => {
    expect(format(ok(`sprint:${A.toUpperCase()},next,backlog,current`))).toBe(`sprint:current,next,none,${A}`);
    expect(format(ok("sprint:BACKLOG"))).toBe("sprint:none");
    expect(format(ok("level:work -sprint:none due:today state:todo"))).toBe("state:todo due:today -sprint:none level:work");
    expect(fail("sprint:later")).toMatchObject({ code: "FILTER_INVALID", position: 7 });
    expect(fail("state:todo sprint:")).toMatchObject({ code: "FILTER_INVALID" });
  });

  test("hierarchy keys (17A): parent, level, and has:subtasks parse to canonical form", () => {
    expect(format(ok(`has:subtasks level:2,WORK parent:${A.toUpperCase()},none state:todo`)))
      .toBe(`state:todo parent:none,${A} level:work,2 has:subtasks`);
    expect(format(ok("-has:subtasks,relation"))).toBe("-has:relation,subtasks");
    expect(fail("parent:someone")).toMatchObject({ code: "FILTER_INVALID", position: 7 });
    expect(fail("level:3")).toMatchObject({ code: "FILTER_INVALID" });
    expect(fail("level:top")).toMatchObject({ code: "FILTER_INVALID" });
  });

  test("caps: length, terms, and values per term", () => {
    expect(fail("x".repeat(TASK_QUERY_LIMITS.length + 1))).toMatchObject({ code: "FILTER_INVALID", position: TASK_QUERY_LIMITS.length });
    const twenty = Array.from({ length: 20 }, (_, index) => `w${index}`).join(" ");
    expect(ok(twenty).terms).toHaveLength(20);
    expect(fail(`${twenty} w20`)).toMatchObject({ code: "FILTER_INVALID", position: twenty.length + 1 });
    const ids = Array.from({ length: 21 }, (_, index) => `0b6c1c7e-2f7a-4d8e-9a51-7b0e0d6f1a${String(index).padStart(2, "0")}`);
    expect(ok(`assignee:${ids.slice(0, 20).join(",")}`).terms[0]!.values).toHaveLength(20);
    expect(fail(`assignee:${ids.join(",")}`)).toMatchObject({ code: "FILTER_INVALID" });
  });

  test("scope: column needs exactly one positive board, or a board-scoped caller", () => {
    expect(fail(`column:${A}`)).toMatchObject({ code: "FILTER_SCOPE", position: 0 });
    expect(fail(`board:${A},${B} column:${C}`)).toMatchObject({ code: "FILTER_SCOPE", position: 80 });
    expect(fail(`-board:${A} column:${C}`)).toMatchObject({ code: "FILTER_SCOPE" });
    expect(fail(`board:${A} board:${B} column:${C}`)).toMatchObject({ code: "FILTER_SCOPE" });
    expect(ok(`board:${A} column:${C}`).terms).toHaveLength(2);
    expect(ok(`column:${C}`, { boardScoped: true }).terms).toHaveLength(1);
    expect(scopedBoardId(ok(`board:${A} state:todo`))).toBe(A);
    expect(scopedBoardId(ok(`board:${A},${B}`))).toBeNull();
    expect(scopedBoardId(ok("state:todo"))).toBeNull();
  });

  test("lenient mode drops bad terms and values and truncates at the caps", () => {
    expect(format(ok(`owner:me state:todo,later "unclosed`, { lenient: true }))).toBe("state:todo");
    expect(format(ok(`column:${A} state:done`, { lenient: true }))).toBe("state:done");
    expect(ok(Array.from({ length: 25 }, (_, index) => `w${index}`).join(" "), { lenient: true }).terms).toHaveLength(20);
    expect(format(ok("sprint:someday level:9 state:doing", { lenient: true }))).toBe("state:doing");
  });

  test("canonicalize and validateQuery re-check hand-built queries", () => {
    expect(canonicalize("due:week  assignee:me")).toEqual({ ok: true, query: "assignee:me due:week" });
    expect(canonicalize("oops:1")).toMatchObject({ ok: false, error: { code: "FILTER_INVALID" } });
    const built: TaskQuery = { terms: [{ key: "state", negate: false, values: ["todo", "sometime"] }] };
    expect(validateQuery(built)).toMatchObject({ ok: false, error: { code: "FILTER_INVALID" } });
    expect(validateQuery({ terms: [{ key: "text", negate: false, values: ['a "b" c'] }] })).toEqual({ ok: true, query: { terms: [{ key: "text", negate: false, values: ['a "b" c'] }] } });
  });
});

describe("due windows", () => {
  test("relative keywords resolve from the viewer's today", () => {
    expect(dueWindow("today", "2026-12-30")).toEqual({ kind: "range", from: "2026-12-30", to: "2026-12-30" });
    expect(dueWindow("week", "2026-12-30")).toEqual({ kind: "range", from: "2026-12-30", to: "2027-01-05" });
    expect(dueWindow("next-week", "2026-12-30")).toEqual({ kind: "range", from: "2027-01-06", to: "2027-01-12" });
    expect(dueWindow("overdue", "2026-03-01")).toEqual({ kind: "overdue", before: "2026-03-01" });
    expect(dueWindow("none", "2026-03-01")).toEqual({ kind: "none" });
    expect(dueWindow("<2026-02-01", "2026-03-01")).toEqual({ kind: "before", date: "2026-02-01" });
    expect(dueWindow(">2026-02-01", "2026-03-01")).toEqual({ kind: "after", date: "2026-02-01" });
    expect(dueWindow("2024-02-29", "2026-03-01")).toEqual({ kind: "range", from: "2024-02-29", to: "2024-02-29" });
  });
});

describe("URL codec", () => {
  test("q carries the canonical grammar and other parameters are kept", () => {
    const params = encodeFilterParams(ok("due:week assignee:me"), new URLSearchParams("view=table&assignee=me&tag=x&sort=due"));
    expect(params.toString()).toBe("view=table&sort=due&q=assignee%3Ame+due%3Aweek");
    expect(format(decodeFilterParams(params))).toBe("assignee:me due:week");
    expect(encodeFilterParams({ terms: [] }, new URLSearchParams("q=x&view=list")).toString()).toBe("view=list");
  });

  test("Wave 13 per-key parameters still decode, leniently, and AND with q", () => {
    const query = decodeFilterParams(new URLSearchParams(
      `assignee=me&assignee=${A}&tag=${B},Backend&flag=urgent&flag=nope&due=before:2026-10-01&rel=blocked&q=invoice&column=${C}&board=${A}&mystery=1`
    ));
    expect(format(query)).toBe(`board:${A} column:${C} assignee:me,${A} tag:${B},Backend priority:urgent due:<2026-10-01 has:blocked "invoice"`);
    expect(format(decodeFilterParams(new URLSearchParams("rel=any")))).toBe("has:relation");
    expect(format(decodeFilterParams(new URLSearchParams("rel=none")))).toBe("-has:relation");
    // Without one board, column is dropped rather than failing the whole URL.
    expect(format(decodeFilterParams(new URLSearchParams(`column=${C}&state=done`)))).toBe("state:done");
    expect(format(decodeFilterParams(new URLSearchParams(`column=${C}`), { boardScoped: true }))).toBe(`column:${C}`);
    expect(decodeFilterParams(new URLSearchParams("q=%22unclosed"))).toEqual({ terms: [] });
  });
});

describe("bridges to the Wave 13 structured filter", () => {
  test("queryFromCardFilter writes the canonical grammar and cardFilterFromQuery reads it back", () => {
    const filter = { assignees: ["me", "none"], tags: [A.toUpperCase()], flags: ["urgent" as const], due: { before: "2026-10-01", after: "2026-09-01", none: true }, columns: [B], text: " invoice " };
    const text = format(queryFromCardFilter(filter));
    expect(text).toBe(`column:${B} assignee:me,none tag:${A} priority:urgent due:none,<2026-10-01 due:none,>2026-09-01 "invoice"`);
    const parsed = parse(text, { boardScoped: true });
    expect(parsed.ok && cardFilterFromQuery(parsed.query)).toEqual({ columns: [B], assignees: ["me", "none"], tags: [A], priorities: ["urgent"], due: { before: "2026-10-01", after: "2026-09-01", none: true }, text: "invoice" });
    expect(format(queryFromCardFilter({ due: { none: true } }))).toBe("due:none");
    expect(format(queryFromCardFilter({}))).toBe("");
    expect(cardFilterFromQuery({ terms: [] })).toEqual({});
  });
});
