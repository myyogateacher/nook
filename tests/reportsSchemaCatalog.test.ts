import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { generatedTables, startFakeClickhouse } from "./support/fakeClickhouse";

const { datasourceRow } = await import("../server/reports/datasources");
const { describeTables, listTables, searchSchema, searchTerms, syncSchema, sweepSchemaSync, tablesNamedIn } = await import("../server/reports/schemaCatalog");
const { estimateTool, runSchemaQueryTool, sampleRowsTool } = await import("../server/reports/schemaTools");

/**
 * The schema catalog (Wave 45, D416, D417): a bulk sync of 1000 fake tables in two round trips,
 * FTS ranking (names over comments over columns, an exact name first), the allowlist filter on
 * every read (and after it narrows), the lazy miss, the SHOW / DESCRIBE fallback, the daily sweep,
 * and the schema tools that run guarded statements.
 */

const fake = startFakeClickhouse(24852);
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

const admin = await createUser("Catalog admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);

async function datasource(allowlist: string[]): Promise<string> {
  const response = await request("/reports/admin/datasources", { method: "POST", body: JSON.stringify({ name: `Catalog ${crypto.randomUUID().slice(0, 8)}`, url: fake.url, username: "nook_ro", database: "analytics", allowlist }) }, admin as Session);
  const id = ((await response.json()) as { datasource: { id: string } }).datasource.id;
  await syncSchema(id).catch(() => undefined);
  fake.requests.length = 0;
  return id;
}

describe("bulk sync", () => {
  test("1000 tables in two round trips, filtered to the allowlist, replacing the cache", async () => {
    const id = await datasource(["analytics", "staging.orders_*"]);
    fake.state.tables = generatedTables(1000);
    const started = Date.now();
    const result = await syncSchema(id);
    const expected = fake.state.tables.filter((table) => table.db === "analytics" || (table.db === "staging" && table.name.startsWith("orders_"))).length;
    expect(result).toMatchObject({ tables: expected, columns: expected * 3, mode: "system", truncated: false });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(fake.requests.map((item) => item.sql.split(" FROM ")[1]!.split(" ")[0])).toEqual(["system.tables", "system.columns"]);
    // Only allowlisted databases' columns are asked for.
    expect(fake.requests[1]!.sql).toContain("database IN ('analytics', 'staging')");
    const row = datasourceRow(id);
    expect({ count: row.schema_table_count, error: row.schema_error, synced: row.schema_synced_at !== null }).toEqual({ count: expected, error: null, synced: true });
    expect((db.query("SELECT COUNT(*) AS count FROM report_schema_tables WHERE datasource_id = ?").get(id) as { count: number }).count).toBe(expected);
    // A table dropped upstream leaves the cache at the next sync.
    fake.state.tables = fake.state.tables.slice(0, 30);
    await syncSchema(id);
    expect((db.query("SELECT COUNT(*) AS count FROM report_schema_tables WHERE datasource_id = ?").get(id) as { count: number }).count).toBe(fake.state.tables.filter((table) => table.db === "analytics" || (table.db === "staging" && table.name.startsWith("orders_"))).length);
  });

  test("concurrent syncs share one run; a failure is recorded and the old cache stays", async () => {
    const id = await datasource(["analytics"]);
    fake.state.tables = generatedTables(30);
    const [first, second] = [syncSchema(id), syncSchema(id)];
    expect(first).toBe(second);
    await first;
    const before = (db.query("SELECT COUNT(*) AS count FROM report_schema_tables WHERE datasource_id = ?").get(id) as { count: number }).count;
    fake.state.select = () => ({ error: "boom", status: 500 });
    fake.state.version = "x";
    db.query("UPDATE report_datasources SET username = 'bad' WHERE id = ?").run(id);
    await expect(syncSchema(id)).rejects.toThrow();
    expect(datasourceRow(id).schema_error).toContain("Authentication failed");
    expect((db.query("SELECT COUNT(*) AS count FROM report_schema_tables WHERE datasource_id = ?").get(id) as { count: number }).count).toBe(before);
  });

  test("a user who cannot read system falls back to SHOW and DESCRIBE", async () => {
    const id = await datasource(["analytics.orders_*"]);
    fake.state.tables = generatedTables(40);
    fake.state.systemDenied = true;
    const result = await syncSchema(id);
    expect(result.mode).toBe("show");
    expect(result.tables).toBe(fake.state.tables.filter((table) => table.db === "analytics" && table.name.startsWith("orders_")).length);
    expect(fake.requests.some((item) => item.sql === "SHOW DATABASES")).toBe(true);
    expect(fake.requests.some((item) => item.sql.startsWith("DESCRIBE TABLE `analytics`.`orders_"))).toBe(true);
    const [table] = (await describeTables(datasourceRow(id), ["analytics.orders_0000"])).tables;
    expect(table!.columns.map((column) => column.name)).toEqual(["id", "event_date", "orders_amount"]);
  });

  test("the daily sweep starts syncs for day-old caches only, once an hour at most", async () => {
    const id = await datasource(["analytics"]);
    db.query("UPDATE report_datasources SET schema_synced_at = ? WHERE id <> ?").run(new Date().toISOString(), id);
    db.query("UPDATE report_datasources SET schema_synced_at = ? WHERE id = ?").run(new Date(Date.now() - 2 * 86_400_000).toISOString(), id);
    expect(sweepSchemaSync()).toBe(1);
    expect(sweepSchemaSync()).toBe(0);
    await syncSchema(id);
  });
});

describe("search, list, describe", () => {
  let id = "";
  beforeEach(async () => {
    id = await datasource(["analytics", "staging.orders_*"]);
    fake.state.tables = [
      ...generatedTables(1000),
      { db: "analytics", name: "revenue_daily", comment: "Net revenue per day, in cents", columns: [{ name: "day", type: "Date" }, { name: "net_revenue", type: "Int64", comment: "after refunds" }] },
      { db: "analytics", name: "churn", comment: "Monthly churn", columns: [{ name: "month", type: "Date" }, { name: "lost_revenue", type: "Int64", comment: "revenue lost to churn" }] },
      { db: "raw", name: "revenue_secret", comment: "Not allowlisted", columns: [{ name: "revenue", type: "Int64" }] }
    ];
    await syncSchema(id);
    fake.requests.length = 0;
  });

  test("FTS ranks names over comments over columns, an exact name first, with no ClickHouse round trip", () => {
    const row = datasourceRow(id);
    const hits = searchSchema(row, "revenue");
    expect(hits[0]!.table).toBe("analytics.revenue_daily");
    expect(hits.map((hit) => hit.table)).toContain("analytics.churn");
    expect(hits.map((hit) => hit.table)).not.toContain("raw.revenue_secret");
    expect(hits.find((hit) => hit.table === "analytics.churn")!.matchingColumns).toEqual(["lost_revenue"]);
    expect(searchSchema(row, "churn")[0]).toEqual({ table: "analytics.churn", comment: "Monthly churn", totalRows: null, matchingColumns: ["lost_revenue"] });
    // An exact name beats prefix matches of other tables.
    expect(searchSchema(row, "orders_0030")[0]!.table).toBe("analytics.orders_0030");
    expect(searchSchema(row, "analytics.orders_0030")[0]!.table).toBe("analytics.orders_0030");
    const payments = searchSchema(row, "payments amount", 20);
    expect(payments.length).toBe(20);
    expect(payments.every((hit) => hit.table.includes("payments") || hit.matchingColumns.some((name) => name.includes("amount")))).toBe(true);
    expect(searchSchema(row, "  ")).toEqual([]);
    // Every term is quoted in the MATCH, so OR and NEAR are words, never operators.
    expect(searchTerms("Net-Revenue (\"x\") OR *")).toEqual(["net", "revenue", "or"]);
    expect(fake.requests).toHaveLength(0);
  });

  test("a narrowed allowlist hides cached tables at once", () => {
    db.query("UPDATE report_datasources SET allowlist_json = '[\"analytics.churn\"]' WHERE id = ?").run(id);
    const row = datasourceRow(id);
    expect(searchSchema(row, "revenue").map((hit) => hit.table)).toEqual(["analytics.churn"]);
    expect(listTables(row).tables.map((table) => table.table)).toEqual(["analytics.churn"]);
  });

  test("list_tables pages 50 at a time and filters by database and name", () => {
    const row = datasourceRow(id);
    const first = listTables(row);
    expect(first.tables).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(first.databases).toEqual(["analytics", "staging"]);
    const staging = listTables(row, { db: "staging" });
    expect(staging.tables.every((table) => table.table.startsWith("staging.orders_"))).toBe(true);
    expect(listTables(row, { like: "revenue" }).tables.map((table) => table.table)).toEqual(["analytics.revenue_daily"]);
    expect(listTables(row, { like: "MONTHLY" }).tables.map((table) => table.table)).toEqual(["analytics.churn"]);
  });

  test("describe_tables: keys and columns, a lazy miss read from ClickHouse, and missing for anything else", async () => {
    const row = datasourceRow(id);
    fake.state.tables.push({ db: "analytics", name: "added_later", engine: "ReplacingMergeTree", sorting_key: "id", columns: [{ name: "id", type: "UInt64" }] });
    const result = await describeTables(row, ["revenue_daily", "analytics.added_later", "raw.revenue_secret", "analytics.nope", "bad name!"]);
    expect(result.tables.map((table) => `${table.db}.${table.name}`)).toEqual(["analytics.revenue_daily", "analytics.added_later"]);
    expect(result.tables[0]).toMatchObject({ partitionKey: "", columns: [{ name: "day", type: "Date", comment: "", defaultKind: "" }, { name: "net_revenue", type: "Int64", comment: "after refunds", defaultKind: "" }] });
    expect(result.tables[1]).toMatchObject({ engine: "ReplacingMergeTree", sortingKey: "id" });
    expect(result.missing).toEqual(["raw.revenue_secret", "analytics.nope", "bad name!"]);
    // The lazy miss is cached now: the next describe makes no round trip.
    fake.requests.length = 0;
    await describeTables(row, ["analytics.added_later"]);
    expect(fake.requests).toHaveLength(0);
    // Doc-first seeding finds the tables a doc names.
    expect(tablesNamedIn(row, "Revenue is `revenue_daily`; churn lives in analytics.churn and raw.revenue_secret.").map((table) => table.name)).toEqual(["revenue_daily", "churn"]);
  });

  test("sample_rows, run_schema_query, and estimate run guarded", async () => {
    const row = datasourceRow(id);
    const sample = await sampleRowsTool(row, admin.userId, { table: "analytics.churn", n: 50 });
    expect(sample.sentSql).toBe("SELECT * FROM (\nSELECT * FROM `analytics`.`churn` LIMIT 5\n) LIMIT 6");
    expect(fake.requests.at(-1)!.params).toMatchObject({ max_rows_to_read: "100000", read_overflow_mode: "break" });
    await expect(sampleRowsTool(row, admin.userId, { table: "raw.revenue_secret" })).rejects.toThrow(/allowlist/);
    await expect(runSchemaQueryTool(row, admin.userId, { sql: "SELECT * FROM churn" })).rejects.toThrow(/metadata/);
    fake.state.select = () => ({ meta: [{ name: "name", type: "String" }], data: [["churn"]] });
    expect((await runSchemaQueryTool(row, admin.userId, { sql: "SHOW TABLES" })).rows).toEqual([["churn"]]);
    expect(await estimateTool(row, admin.userId, { sql: "SELECT count() FROM churn" })).toEqual({ rows: 120000, parts: 4, marks: 15, tables: [{ table: "analytics.orders", rows: 120000, parts: 4, marks: 15 }] });
    await expect(estimateTool(row, admin.userId, { sql: "SHOW TABLES" })).rejects.toThrow(/SELECT/);
  });

  test("the Schema browser routes are the report owner's, on the report's data source", async () => {
    const owner = await createUser("Catalog author");
    const report = await request("/reports", { method: "POST", body: JSON.stringify({ title: "Browse", datasourceId: id }) }, owner);
    const reportId = ((await report.json()) as { report: { id: string } }).report.id;
    const search = await (await request(`/reports/${reportId}/schema/search?q=churn`, {}, owner)).json() as { results: Array<{ table: string }> };
    expect(search.results[0]!.table).toBe("analytics.churn");
    const tables = await (await request(`/reports/${reportId}/schema/tables?db=analytics&like=revenue`, {}, owner)).json() as { tables: Array<{ table: string }> };
    expect(tables.tables.map((table) => table.table)).toEqual(["analytics.revenue_daily"]);
    const described = await (await request(`/reports/${reportId}/schema/describe?tables=analytics.churn,raw.revenue_secret`, {}, owner)).json() as { tables: unknown[]; missing: string[] };
    expect(described.missing).toEqual(["raw.revenue_secret"]);
    expect((await request(`/reports/${reportId}/schema/search?q=churn`, {}, admin)).status).toBe(404);
  });
});
