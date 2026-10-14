import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { assertQueryTreeAllowed, GuardError, queryTreeTables } from "../server/reports/sqlGuard";
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
