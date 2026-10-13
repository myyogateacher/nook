import { describe, expect, test } from "bun:test";
import "./support/harness";

const { chQuery, ChError, queryIdFor } = await import("../server/reports/clickhouse");
const { classify, queryTreeTables, wrapSelect } = await import("../server/reports/sqlGuard");

/**
 * Against a real ClickHouse (Wave 45): set CLICKHOUSE_TEST_URL (an http://127.0.0.1:<port>/ the
 * harness's AGENT_ALLOWED_PRIVATE_HOSTS allows), and optionally CLICKHOUSE_TEST_USER /
 * CLICKHOUSE_TEST_PASSWORD (default user `default`, no password). Skipped otherwise. It proves the
 * per-query settings are accepted, the LIMIT wrap and the row cap behave, EXPLAIN QUERY TREE prints
 * what `queryTreeTables` parses, and readonly=2 refuses a write.
 */

const url = process.env.CLICKHOUSE_TEST_URL;
const target = { url: url ?? "http://127.0.0.1:8123/", username: process.env.CLICKHOUSE_TEST_USER ?? "default", password: process.env.CLICKHOUSE_TEST_PASSWORD ?? null, database: "system", timeoutS: 20, maxRows: 100 };

describe.skipIf(!url)("a real ClickHouse (CLICKHOUSE_TEST_URL)", () => {
  test("the settings are accepted and the wrap caps rows at max + 1", async () => {
    const sql = classify("SELECT number FROM numbers(1000) -- all of them").sql;
    const result = await chQuery(target, wrapSelect(sql, 100), { queryId: queryIdFor("live", crypto.randomUUID().slice(0, 8)) });
    expect(result.columns).toEqual([{ name: "number", type: "UInt64" }]);
    expect(result.rows.length).toBe(101);
    expect(result.rowsRead).toBeGreaterThan(0);
  });

  test("EXPLAIN QUERY TREE names the tables and table functions the analyzer resolved", async () => {
    const result = await chQuery(target, "EXPLAIN QUERY TREE SELECT count() FROM system.one AS a JOIN numbers(3) AS b ON 1", { queryId: queryIdFor("live", "tree") });
    const tree = queryTreeTables(result.rows.map((row) => String(row[0])).join("\n"));
    expect(tree.tables).toContainEqual({ db: "system", table: "one" });
    expect(tree.functions).toContain("numbers");
  });

  test("readonly=2 refuses a write, whatever the user's grants", async () => {
    const error = await chQuery(target, "CREATE TABLE IF NOT EXISTS default.nook_should_not_exist (x UInt8) ENGINE = Memory", { queryId: queryIdFor("live", "write") }).catch((reason) => reason);
    expect(error).toBeInstanceOf(ChError);
    expect(error.chName === "READONLY" || error.chName === "ACCESS_DENIED").toBe(true);
  });
});
