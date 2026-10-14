import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse } from "./support/fakeClickhouse";
import { retireUsersAfterFile } from "./support/retireUsers";
import errorsFixture from "./fixtures/clickhouse-26.6/errors.json";

const { repairHint, finalNote, closestNames } = await import("../server/reports/repairHints");
const { parseChError } = await import("../server/reports/clickhouse");
const { runGuarded, adHocQueryId } = await import("../server/reports/runner");
const { asReportError } = await import("../server/reports/errors");
const { syncSchema } = await import("../server/reports/schemaCatalog");
const { datasourceRow } = await import("../server/reports/datasources");

/**
 * E3: ClickHouse error repair hints, from error texts captured from a real ClickHouse 26.6
 * (tests/fixtures/clickhouse-26.6/errors.json; the tables are the eval cases' peerdb_orders and
 * refund_dates). A hint names catalog tables and columns and the query's own identifiers only, and it
 * reaches the model even when the guard's tree check withholds ClickHouse's text (review M2).
 */

retireUsersAfterFile();

const fake = startFakeClickhouse(0);
let admin: Session;
let datasourceId = "";
const fixture = (name: string) => errorsFixture.errors.find((item) => item.name === name)!;

beforeAll(async () => {
  admin = await createUser("Repair admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  fake.state.tables = [
    { db: "eval_peerdb_orders", name: "orders", engine: "ReplacingMergeTree(_peerdb_version)", partition_key: "toYYYYMM(created_at)", sorting_key: "id",
      columns: ["id", "customer_id", "status", "amount", "created_at", "_peerdb_synced_at", "_peerdb_is_deleted", "_peerdb_version"].map((name) => ({ name, type: name === "status" ? "LowCardinality(String)" : name === "amount" ? "Decimal(12, 2)" : "Int64" })) },
    { db: "eval_refund_dates", name: "orders", engine: "MergeTree", sorting_key: "ordered_at, order_id", columns: [{ name: "order_id", type: "UInt64" }, { name: "ordered_at", type: "DateTime" }, { name: "amount", type: "Decimal(12, 2)" }] },
    { db: "eval_refund_dates", name: "refunds", engine: "MergeTree", sorting_key: "refunded_at, refund_id", columns: [{ name: "refund_id", type: "UInt64" }, { name: "order_id", type: "UInt64" }, { name: "refunded_at", type: "DateTime" }, { name: "refund_amount", type: "Decimal(12, 2)" }] }
  ];
  const response = await request("/reports/admin/datasources", { method: "POST", body: JSON.stringify({ name: `Repair ${crypto.randomUUID().slice(0, 6)}`, url: fake.url, username: "nook_ro", password: "pw", database: "eval_peerdb_orders", allowlist: ["eval_peerdb_orders", "eval_refund_dates"] }) }, admin);
  expect(response.status).toBe(201);
  datasourceId = ((await response.json()) as { datasource: { id: string } }).datasource.id;
  await syncSchema(datasourceId);
});
afterAll(() => fake.stop());

function hintFor(name: string, sql = fixture(name).sql) {
  const parsed = parseChError(fixture(name).text, 500);
  return repairHint({ chName: parsed.chName, chCode: parsed.chCode, message: parsed.message }, sql, datasourceRow(datasourceId));
}

describe("repair hints from ClickHouse 26.6 errors", () => {
  test("the fixtures parse to their codes", () => {
    const codes = Object.fromEntries(errorsFixture.errors.map((item) => [item.name, parseChError(item.text, 500).chName]));
    expect(codes).toEqual({
      unknown_column: "UNKNOWN_IDENTIFIER", unknown_column_qualified: "UNKNOWN_IDENTIFIER", unknown_table: "UNKNOWN_TABLE", unknown_database: "UNKNOWN_DATABASE",
      illegal_type: "ILLEGAL_TYPE_OF_ARGUMENT", illegal_types_minus: "ILLEGAL_TYPE_OF_ARGUMENT", no_common_type: "NO_COMMON_TYPE", cannot_parse_text: "CANNOT_PARSE_TEXT",
      cannot_parse_datetime: "CANNOT_PARSE_DATETIME", aggregate_in_where: "ILLEGAL_AGGREGATION", not_an_aggregate: "NOT_AN_AGGREGATE", illegal_final: "ILLEGAL_FINAL",
      memory_limit: "MEMORY_LIMIT_EXCEEDED", too_many_rows: "TOO_MANY_ROWS", timeout: "TIMEOUT_EXCEEDED"
    });
    // 159 is the time limit: parseChError makes it a TIMEOUT error.
    expect(parseChError(fixture("timeout").text, 500)).toMatchObject({ code: "TIMEOUT", chCode: 159 });
  });

  test("unknown names: the closest real columns and tables from the catalog", () => {
    expect(hintFor("unknown_column")).toStartWith("A column or function name is not one of eval_peerdb_orders.orders; the closest columns are amount");
    expect(hintFor("unknown_column_qualified")).toStartWith("A column or function name is not one of eval_peerdb_orders.orders; the closest columns are amount");
    expect(hintFor("unknown_table")).toStartWith("There is no allowlisted table eval_peerdb_orders.order; the closest tables are eval_peerdb_orders.orders");
    expect(hintFor("unknown_database")).toStartWith("There is no allowlisted table eval_peerdb_order; the closest tables are ");
    expect(hintFor("unknown_database")).toContain("eval_peerdb_orders.orders");
    expect(closestNames("order_amount", ["amount", "order_id", "refund_amount", "created_at"])).toEqual(["amount", "order_id", "refund_amount"]);
  });

  test("types, parsing, aggregates, limits, and FINAL", () => {
    expect(hintFor("illegal_type")).toStartWith("A value has the wrong type (String passed to sum). Cast it: toFloat64(x)");
    expect(hintFor("illegal_types_minus")).toStartWith("A value has the wrong type");
    expect(hintFor("no_common_type")).toStartWith("A value has the wrong type");
    expect(hintFor("cannot_parse_text")).toStartWith("A string could not be read as a date or number.");
    expect(hintFor("cannot_parse_datetime")).toContain("toDate('2026-09-01')");
    expect(hintFor("aggregate_in_where")).toStartWith("An aggregate function is in WHERE. Filter groups in HAVING");
    expect(hintFor("not_an_aggregate")).toStartWith("amount is neither in GROUP BY nor inside an aggregate. Add amount to GROUP BY, or aggregate it (any(amount)");
    expect(hintFor("memory_limit")).toContain("eval_peerdb_orders.orders is partitioned by toYYYYMM(created_at) and sorted by (id)");
    expect(hintFor("too_many_rows")).toStartWith("The query read or kept too much. Narrow it: filter on the partition and sorting keys");
    expect(hintFor("timeout")).toStartWith("The query ran past the time limit.");
    expect(hintFor("illegal_final")).toBe("FINAL works only on Replacing, Collapsing, Summing, and Aggregating MergeTree tables; remove it from eval_refund_dates.orders (MergeTree).");
  });

  test("FINAL guidance from the catalog's engine, and nothing for a clean query", () => {
    const row = datasourceRow(datasourceId);
    expect(finalNote("SELECT sum(amount) FROM eval_peerdb_orders.orders WHERE status = 'paid'", row)).toBe("eval_peerdb_orders.orders is a ReplacingMergeTree: rows repeat until merged, so read it with FINAL (FROM eval_peerdb_orders.orders FINAL) and exclude deleted rows (_peerdb_is_deleted = 0).");
    expect(finalNote("SELECT sum(amount) FROM eval_peerdb_orders.orders FINAL WHERE _peerdb_is_deleted = 0", row)).toBeNull();
    expect(finalNote("SELECT sum(o.amount) FROM eval_peerdb_orders.orders AS o FINAL", row)).toBeNull();
    // Any other hint carries the note too.
    expect(hintFor("not_an_aggregate")).toContain("Also: eval_peerdb_orders.orders is a ReplacingMergeTree");
    expect(hintFor("not_an_aggregate", "SELECT 1")).toBe("A selected column is neither in GROUP BY nor inside an aggregate. Add it to GROUP BY, or aggregate it (any(x), sum(x), max(x)).");
  });

  test("never echoes a name the query does not contain", () => {
    const hint = repairHint({ chName: "UNKNOWN_TABLE", chCode: 60, message: "Unknown table expression identifier 'secret_db.payroll' in scope SELECT 1. Maybe you meant secret_db.salaries?" }, "SELECT count() FROM eval_refund_dates.order", datasourceRow(datasourceId));
    expect(hint).not.toContain("secret_db");
    expect(hint).toStartWith("That table or database is not in this data source");
  });
});

describe("hints through the runner", () => {
  test("a refused tree check keeps its generic message and carries the hint; a run failure carries one too", async () => {
    const row = datasourceRow(datasourceId);
    fake.state.queryTree = (select) => select.includes("amout") ? fixture("unknown_column").text : null;
    const refused = await runGuarded(row, "SELECT sum(amout) FROM eval_peerdb_orders.orders FINAL", { classes: ["select"], maxRows: 10, queryId: adHocQueryId("test"), userId: admin.userId }).catch((error) => error);
    const known = asReportError(refused);
    expect(known.code).toBe("GUARD");
    expect(known.message).toStartWith("ClickHouse could not check this query");
    expect(known.message).not.toContain("amout");
    expect(known.details.hint).toBe("A column or function name is not one of eval_peerdb_orders.orders; the closest columns are amount. Check the names with describe_tables; an alias defined in the SELECT list cannot be used inside an aggregate of the same name.");
    fake.state.queryTree = null;
    fake.state.select = () => ({ error: fixture("no_common_type").text, status: 500 });
    const failed = asReportError(await runGuarded(row, "SELECT count() FROM eval_peerdb_orders.orders FINAL WHERE status = 1", { classes: ["select"], maxRows: 10, queryId: adHocQueryId("test"), userId: admin.userId }).catch((error) => error));
    // Its text names `__table1.status`, so ClickHouse's message and code stay hidden (review M2); the hint still comes.
    expect(failed.details).toEqual({ hint: expect.stringContaining("Cast it") });
    // The console's API answers with the hint.
    const console = await request("/reports/admin/datasources", {}, admin);
    expect(console.status).toBe(200);
  });
});
