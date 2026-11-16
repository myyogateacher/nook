import { describe, expect, test } from "bun:test";
import { db } from "./support/harness";
import { parse } from "../shared/taskQuery";

const { compileTaskQuery, readableOtherBoardPredicate } = await import("../server/tasks/query");
const { readableBoardPredicate } = await import("../server/tasks/access");

/** The grammar-to-SQL compiler binds every value (research 2026-09-26 §11.2 `cardQuerySql`, T117). */

const context = { userId: "11111111-1111-4111-8111-111111111111", today: "2026-09-26", nowTime: "10:30" };
const compile = (input: string) => {
  const parsed = parse(input);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return compileTaskQuery(parsed.query, context);
};

describe("compileTaskQuery", () => {
  test("values only ever appear as named parameters", () => {
    const hostile = [
      `"'); DROP TABLE cards; --"`,
      `tag:"x' OR 1=1 --","Robert'); --"`,
      `"%_\\\\"`,
      `-"a\\"b" board:22222222-2222-4222-8222-222222222222 column:33333333-3333-4333-8333-333333333333`
    ];
    for (const input of hostile) {
      const { where, params } = compile(input);
      for (const value of Object.values(params)) if (typeof value === "string" && value.length > 2) expect(where).not.toContain(value);
      expect(where).not.toContain("DROP");
      expect(where).not.toContain("Robert");
      // Placeholders are $userId, $f<n>; every $f<n> is bound.
      for (const name of where.match(/\$[A-Za-z]\w*/g) ?? []) expect(Object.keys(params)).toContain(name.slice(1));
    }
  });

  test("every key compiles to SQL SQLite accepts", () => {
    const { where, params } = compile([
      "board:22222222-2222-4222-8222-222222222222 column:33333333-3333-4333-8333-333333333333",
      "state:todo,done -state:doing assignee:me,none,44444444-4444-4444-8444-444444444444 creator:me",
      "tag:none,Backend,55555555-5555-4555-8555-555555555555 flag:urgent,blocked,none priority:high,none -priority:low",
      "due:overdue,today,week,next-week,none,2026-01-01,<2026-01-01,>2026-01-01 has:relation,blocked -has:blocked \"x\""
    ].join(" "));
    const sql = `SELECT k.id FROM cards k JOIN boards b ON b.id = k.board_id JOIN board_columns col ON col.id = k.column_id WHERE ${where}`;
    expect(() => db.query(`EXPLAIN ${sql}`).all(params)).not.toThrow();
    expect(compile("")).toEqual({ where: "1", params: { userId: context.userId } });
  });

  test("negated terms keep rows whose field is NULL", () => {
    expect(compile("-due:overdue").where).toStartWith("NOT COALESCE(");
  });

  test("the other-board predicate is the readable predicate on alias ob", () => {
    expect(readableOtherBoardPredicate).toBe(readableBoardPredicate.replaceAll("b.deleted_at", "ob.deleted_at").replaceAll("b.owner_id", "ob.owner_id")
      .replaceAll("b.visibility", "ob.visibility").replaceAll("= b.id", "= ob.id"));
    expect(readableOtherBoardPredicate).not.toMatch(/(^|[^o])b\.(id|owner_id|visibility|deleted_at)/);
  });
});
