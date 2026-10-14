import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { assertQueryTreeAllowed, classify, GuardError, qualifiedColumnHint, queryTreeTables } from "../server/reports/sqlGuard";
import { fakeQueryTree } from "./support/fakeClickhouse";

/**
 * `EXPLAIN QUERY TREE` output captured from a real ClickHouse 26.6.8.7 (tests/fixtures/clickhouse-26.6:
 * `<name>.sql` is the statement, `<name>.txt` the tree as JSONCompact rows read, one line each;
 * `user_q*.txt` are reports' generated queries that 26.6 refused before the fix). The guard parses every
 * one; the allowlist is `myt.*` on default database `myt`; `other.secrets` stands for a table off it.
 */
const DIR = new URL("./fixtures/clickhouse-26.6/", import.meta.url);
const tree = (name: string) => readFileSync(new URL(`${name}.txt`, DIR), "utf8");
const ALLOW = ["myt.*"];
const verdict = (name: string, statementClass: "select" | "metadata" = "select") => {
  try {
    assertQueryTreeAllowed(queryTreeTables(tree(name)), ALLOW, "myt", statementClass);
    return "ok";
  } catch (error) {
    return error instanceof GuardError ? error.code : String(error);
  }
};

const EXPECTED: Record<string, { tables: string[]; functions?: string[]; verdict: string; statementClass?: "metadata" }> = {
  final: { tables: ["myt.myt_chat_escalation"], verdict: "ok" },
  sample: { tables: ["myt.events"], verdict: "ok" },
  sample_offset: { tables: ["myt.events"], verdict: "ok" },
  prewhere: { tables: ["myt.events"], verdict: "ok" },
  with_array: { tables: ["myt.myt_chat_escalation"], verdict: "ok" },
  with_cte: { tables: ["myt.myt_chat_escalation"], verdict: "ok" },
  subquery_final: { tables: ["myt.myt_chat_escalation"], verdict: "ok" },
  in_subquery: { tables: ["myt.events", "myt.events"], verdict: "ok" },
  in_list: { tables: ["myt.events"], verdict: "ok" },
  in_table: { tables: ["myt.events", "myt.events"], verdict: "ok" },
  join: { tables: ["myt.events", "myt.myt_chat_escalation"], verdict: "ok" },
  left_join: { tables: ["myt.events", "myt.myt_chat_escalation"], verdict: "ok" },
  comma_join: { tables: ["myt.events", "myt.myt_chat_escalation"], verdict: "ok" },
  array_join: { tables: ["myt.events"], verdict: "ok" },
  union_all: { tables: ["myt.events", "myt.myt_chat_escalation"], verdict: "ok" },
  argmax_countif: { tables: ["myt.myt_chat_escalation"], verdict: "ok" },
  window: { tables: ["myt.events"], verdict: "ok" },
  numbers: { tables: [], functions: ["numbers"], verdict: "ok" },
  backticks: { tables: ["myt.myt_chat_escalation"], verdict: "ok" },
  system_columns: { tables: ["system.columns"], verdict: "ok", statementClass: "metadata" },
  other_db: { tables: ["other.secrets"], verdict: "NOT_ALLOWED_TABLE" },
  url: { tables: [], functions: ["url"], verdict: "BANNED_FUNCTION" },
  s3: { tables: [], functions: ["s3"], verdict: "BANNED_FUNCTION" },
  remote: { tables: [], functions: ["remote"], verdict: "BANNED_FUNCTION" },
  // Lane F: format() the string function is a FUNCTION node (allowed); the table function a TABLE_FUNCTION node (refused).
  format_string: { tables: ["myt.events"], verdict: "ok" },
  format_table: { tables: [], functions: ["format"], verdict: "BANNED_FUNCTION" },
  user_q2: { tables: ["myt.myt_chat_escalation"], verdict: "ok" },
  user_q3: { tables: ["myt.myt_chat_escalation"], verdict: "ok" }
};

describe("EXPLAIN QUERY TREE from ClickHouse 26.6 (real fixtures)", () => {
  test("every captured fixture has an expectation", () => {
    const names = readdirSync(DIR).filter((file) => file.endsWith(".txt")).map((file) => file.slice(0, -4)).sort();
    expect(names).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [name, expected] of Object.entries(EXPECTED)) {
    test(`${name}: tables, table functions, and the verdict`, () => {
      const parsed = queryTreeTables(tree(name));
      expect(parsed.tables.map((ref) => `${ref.db}.${ref.table}`).sort()).toEqual([...expected.tables].sort());
      expect(parsed.functions).toEqual(expected.functions ?? []);
      expect(verdict(name, expected.statementClass)).toBe(expected.verdict);
    });
  }

  test("a system table outside the metadata class is refused", () => {
    expect(verdict("system_columns")).toBe("BANNED_TABLE");
  });

  test("FINAL and sample fields in the real format; anything ambiguous still refuses", () => {
    const refused = (text: string) => { try { queryTreeTables(text); return "parsed"; } catch (error) { return error instanceof GuardError ? error.code : "other"; } };
    expect(queryTreeTables("    TABLE id: 3, alias: __table1, table_name: myt.t, final: 1").tables).toEqual([{ db: "myt", table: "t" }]);
    expect(queryTreeTables("    TABLE id: 3, alias: __table1, table_name: myt.t, final: 0, sample_size: 1 / 10, sample_offset: 1 / 2").tables).toEqual([{ db: "myt", table: "t" }]);
    expect(queryTreeTables("    TABLE id: 3, alias: __table1, table_name: myt.t, is_global: 1").tables).toEqual([{ db: "myt", table: "t" }]);
    expect(refused("    TABLE id: 3, alias: __table1, table_name: myt.t, final: 1, final: 1")).toBe("UNSUPPORTED_SYNTAX");
    expect(refused("    TABLE id: 3, alias: __table1, table_name: myt.t, final: 1, x")).toBe("UNSUPPORTED_SYNTAX");
    expect(refused("    TABLE id: 3, alias: __table1, table_name: myt.t, final: (1)")).toBe("UNSUPPORTED_SYNTAX");
    expect(refused("    TABLE id: 3, alias: __table1, table_name: myt.a b, final: 1")).toBe("UNSUPPORTED_SYNTAX");
  });

  test("a refusal the guard cannot parse says it is Nook's limitation, not a SQL error", () => {
    try {
      queryTreeTables("    TABLE id: 3, alias: __table1, table_name: myt.a.b");
      throw new Error("parsed");
    } catch (error) {
      expect((error as GuardError).message).toContain("This is a Nook guard limitation, not a SQL error");
    }
  });

  test("the fake ClickHouse prints FINAL the way 26.6 does", () => {
    expect(fakeQueryTree("SELECT * FROM myt.t FINAL", "myt")).toContain("table_name: myt.t, final: 1");
    expect(fakeQueryTree("SELECT * FROM myt.t AS x FINAL WHERE 1", "myt")).toContain("table_name: myt.t, final: 1");
    expect(fakeQueryTree("SELECT * FROM myt.t WHERE 1", "myt")).not.toContain("final");
  });
});

describe("format(): the string function, not the table function (ClickHouse 26.6 fixtures)", () => {
  const sql = (name: string) => readFileSync(new URL(`${name}.sql`, DIR), "utf8").trim();
  test("the string function passes the lexer and the tree; the table function is refused by both", () => {
    expect(queryTreeTables(tree("format_string")).calls).toContain("format");
    expect(classify(sql("format_string")).class).toBe("select");
    expect(() => classify(sql("format_table"))).toThrow(expect.objectContaining({ code: "BANNED_FUNCTION" }));
    // Other banned functions are still refused as FUNCTION nodes.
    expect(() => assertQueryTreeAllowed({ tables: [], functions: [], calls: ["hostName"] }, ALLOW, "myt", "select")).toThrow(expect.objectContaining({ code: "BANNED_FUNCTION" }));
  });
});

describe("tree-check errors that name a qualified column (ClickHouse 26.6 error fixtures)", () => {
  const sql = (name: string) => readFileSync(new URL(`${name}.sql`, DIR), "utf8").trim();
  const error = (name: string) => readFileSync(new URL(`${name}.error`, DIR), "utf8").trim();
  // The allowlisted catalog: myt.events (id, d, tags, v) and myt.myt_chat_escalation (id, route, status, ...).
  const CATALOG: Record<string, string[]> = { "myt.events": ["id", "d", "tags", "v"], "myt.myt_chat_escalation": ["id", "route", "status", "outcome"] };
  const withColumn = (column: string) => Object.entries(CATALOG).filter(([, columns]) => columns.includes(column)).map(([table]) => table);
  const hint = (name: string) => qualifiedColumnHint(error(name), sql(name), withColumn);

  test("a column of another allowlisted table: says where it is", () => {
    expect(hint("error_alias_column")).toBe("ClickHouse could not resolve e.route: e does not name a table with a column route here. route is a column of myt.myt_chat_escalation; check which table e stands for");
  });

  test("NOT_AN_AGGREGATE on e.id: add it to GROUP BY or aggregate it", () => {
    expect(hint("error_not_aggregate")).toBe("e.id is not under an aggregate function and not in GROUP BY: add it to GROUP BY, or wrap it in an aggregate such as any(e.id)");
  });

  test("an unknown alias of a real column names the allowlisted tables that have it", () => {
    expect(hint("error_unknown_alias")).toBe("ClickHouse could not resolve x.id: x does not name a table with a column id here. id is a column of myt.events, myt.myt_chat_escalation; check which table x stands for");
  });

  test("no hint (the generic message) when the column is on no allowlisted table, or the author did not write the name", () => {
    expect(hint("error_typo_column")).toBeNull();
    expect(qualifiedColumnHint(error("error_alias_column"), "SELECT route FROM myt.events", withColumn)).toBeNull();
    // ClickHouse's own suggestions ("Maybe you meant") never reach the hint.
    expect(hint("error_unknown_alias")).not.toContain("Maybe");
    expect(qualifiedColumnHint("Code: 60. DB::Exception: Unknown table expression identifier 'secret.t'. (UNKNOWN_TABLE)", "SELECT * FROM secret.t", withColumn)).toBeNull();
  });

  test("backticked parts are the same name", () => {
    expect(qualifiedColumnHint(error("error_alias_column"), "SELECT `e`.`route` FROM myt.events AS e", withColumn)).toContain("route is a column of myt.myt_chat_escalation");
  });
});
