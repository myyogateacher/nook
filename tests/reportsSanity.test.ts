import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse } from "./support/fakeClickhouse";
import { retireUsersAfterFile } from "./support/retireUsers";
import type { QueryOutcome, ReportBlock, ReportSpec } from "../shared/reports";

const { sanityChecks, literalRange, SANITY_LIMITS } = await import("../server/reports/sanity");
const { queryShape, normaliseExpr } = await import("../server/reports/sqlShape");
const { syncSchema } = await import("../server/reports/schemaCatalog");
const { datasourceRow } = await import("../server/reports/datasources");

/**
 * E2: result sanity checks. The query reader (sqlShape) and each check on hand-made results; the
 * fan-out check's guarded sample against the fake ClickHouse (and its budget). The generation path
 * (one refusal per run, not a try) is covered end to end by tests/reportEval.test.ts's trap runs.
 */

retireUsersAfterFile();

const fake = startFakeClickhouse(0);
let admin: Session;
let datasourceId = "";

beforeAll(async () => {
  admin = await createUser("Sanity admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  fake.state.tables = [
    { db: "shop", name: "orders", engine: "MergeTree", partition_key: "toYYYYMM(ordered_at)", sorting_key: "ordered_at, order_id", columns: [{ name: "order_id", type: "UInt64" }, { name: "ordered_at", type: "DateTime" }, { name: "order_total", type: "Decimal(12, 2)" }, { name: "channel", type: "String" }] },
    { db: "shop", name: "order_items", engine: "MergeTree", sorting_key: "order_id, line_no", columns: [{ name: "order_id", type: "UInt64" }, { name: "line_no", type: "UInt8" }, { name: "qty", type: "UInt32" }] },
    { db: "shop", name: "customers", engine: "ReplacingMergeTree(_peerdb_version)", sorting_key: "customer_id", columns: [{ name: "customer_id", type: "UInt64" }, { name: "plan", type: "String" }] },
    { db: "shop", name: "subscriptions", engine: "MergeTree", sorting_key: "id", columns: [{ name: "id", type: "UInt64" }, { name: "mrr_cents", type: "Int64", comment: "MRR in US cents" }, { name: "amount", type: "Int64", comment: "price in cents" }] }
  ];
  const response = await request("/reports/admin/datasources", { method: "POST", body: JSON.stringify({ name: `Sanity ${crypto.randomUUID().slice(0, 6)}`, url: fake.url, username: "nook_ro", password: "pw", database: "shop", allowlist: ["shop"] }) }, admin);
  expect(response.status).toBe(201);
  datasourceId = ((await response.json()) as { datasource: { id: string } }).datasource.id;
  await syncSchema(datasourceId);
});
afterAll(() => fake.stop());

const outcome = (columns: Array<[string, string]>, rows: unknown[][]): QueryOutcome => ({ class: "select", columns: columns.map(([name, type]) => ({ name, type })), rows, truncated: false, sentSql: "", chQueryId: "q", rowsRead: 1, bytesRead: 1, ms: 1 });
const spec = (queries: Array<[string, string]>, blocks: ReportBlock[]): ReportSpec => ({ version: 1, specVersion: 2, sections: [], queries: queries.map(([key, sql]) => ({ key, sql, purpose: "", createdBy: "agent" })), blocks });
const context = { userId: "u", runId: "11111111-2222-3333-4444-555555555555" };

describe("the query reader", () => {
  test("reads the select list, the driving table, joins with their keys, FINAL, and a LIMIT", () => {
    const shape = queryShape("SELECT o.channel AS channel, sum(o.order_total) AS revenue, count() AS n\nFROM shop.orders AS o FINAL\nLEFT JOIN shop.order_items i ON i.order_id = o.order_id AND i.line_no = 1\nJOIN (SELECT order_id FROM shop.x) AS s USING order_id\nWHERE o.ordered_at >= '2026-09-01' GROUP BY channel ORDER BY revenue DESC LIMIT 5");
    expect(shape.items).toEqual([{ alias: "channel", expr: "o.channel" }, { alias: "revenue", expr: "sum(o.order_total)" }, { alias: "n", expr: "count()" }]);
    expect(shape.from).toEqual({ db: "shop", name: "orders", alias: "o", final: true });
    expect(shape.joins.map((join) => ({ name: join.name, alias: join.alias, kind: join.kind, subquery: join.subquery, keys: join.keys.map((key) => key.own) }))).toEqual([
      { name: "order_items", alias: "i", kind: "left", subquery: false, keys: ["order_id"] },
      { name: "", alias: "s", kind: "inner", subquery: true, keys: ["order_id"] }
    ]);
    expect(shape.where).toBe("o.ordered_at >= '2026-09-01'");
    expect(shape.groupBy).toBe("channel");
    expect(shape.limited).toBe(true);
    expect(normaliseExpr("SUM( amount )")).toBe(normaliseExpr("sum(amount)"));
    expect(queryShape("not sql at all )(").items).toEqual([]);
  });

  test("literal date ranges", () => {
    expect(literalRange("ordered_at >= '2026-09-01' AND ordered_at < '2026-10-01'")).toEqual({ from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 9, 1) });
    expect(literalRange("day BETWEEN '2026-09-01' AND '2026-09-30'")).toEqual({ from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 9, 1) });
    expect(literalRange("x = 1")).toEqual({ from: null, to: null });
  });
});

describe("sanity checks", () => {
  test("units: percent over 1, a ratio with unit %, cents shown as currency, and an all-zero measure", async () => {
    const row = datasourceRow(datasourceId);
    const checked = await sanityChecks(row, spec([["t", "SELECT avg(x) * 100 AS rate, avg(x) AS share, sum(mrr_cents) AS mrr, sum(mrr_cents) / 100 AS mrr_ok, 0 AS zero FROM shop.subscriptions"]], [
      { id: "rate", type: "kpi", title: "Rate", queryKey: "t", column: "rate", format: "percent" },
      { id: "share", type: "kpi", title: "Share", queryKey: "t", column: "share", unit: "%" },
      { id: "mrr", type: "kpi", title: "MRR", queryKey: "t", column: "mrr", format: "currency:USD" },
      { id: "mrr_ok", type: "kpi", title: "MRR", queryKey: "t", column: "mrr_ok", format: "currency:USD" },
      { id: "zero", type: "kpi", title: "Zero", queryKey: "t", column: "zero", format: "number" }
    ]), new Map([["t", outcome([["rate", "Float64"], ["share", "Float64"], ["mrr", "Int64"], ["mrr_ok", "Float64"], ["zero", "UInt8"]], [[16, 0.16, "8915800", 89158, 0]])]]), context);
    expect(checked.hints).toEqual([
      "sanity units: KPI rate (rate) has format percent, which expects a ratio (0.25 shows 25 %), but its values reach 16, so it would show 1,600 %: drop the × 100 in the SQL.",
      "sanity units: KPI share (share) shows ratios (at most 0.16) with unit %, so 0.25 would read \"0.25 %\"; use format percent instead of the unit.",
      "sanity units: KPI mrr (mrr) is shown as USD but sums mrr_cents, which the catalog says is in cents: divide by 100, or it shows 100× too much.",
      "sanity units: KPI zero (zero) is 0 in every row; a filter may match nothing, a join may not match, or the column may be the wrong one. Check with run_sql before keeping it."
    ]);
    expect(checked.extraQueries).toBe(0);
    // E6: an edit's scope: only the touched blocks and queries are checked.
    const scoped = await sanityChecks(row, spec([["t", "SELECT 16 AS rate, 0 AS zero FROM shop.subscriptions"]], [
      { id: "rate", type: "kpi", title: "Rate", queryKey: "t", column: "rate", format: "percent" },
      { id: "zero", type: "kpi", title: "Zero", queryKey: "t", column: "zero", format: "number" }
    ]), new Map([["t", outcome([["rate", "Float64"], ["zero", "UInt8"]], [[16, 0]])]]), { ...context, scope: { blocks: new Set(["zero"]), queries: new Set() } });
    expect(scoped.hints.map((hint) => hint.slice(0, 29))).toEqual(["sanity units: KPI zero (zero)"]);
    // A growth rate may pass 100 %.
    const growth = await sanityChecks(row, spec([["t", "SELECT 2.5 AS revenue_growth"]], [{ id: "g", type: "kpi", title: "Growth", queryKey: "t", column: "revenue_growth", format: "percent" }]), new Map([["t", outcome([["revenue_growth", "Float64"]], [[2.5]])]]), context);
    expect(growth.hints).toEqual([]);
  });

  test("reconcile: a KPI and its breakdown of the same additive expression must add up; the plan's metric links them too", async () => {
    const row = datasourceRow(datasourceId);
    const blocks: ReportBlock[] = [
      { id: "total", type: "kpi", title: "Revenue", queryKey: "total", column: "revenue", format: "currency:USD" },
      { id: "by_channel", type: "chart", title: "Revenue by channel", queryKey: "by_channel", kind: "bar", x: "channel", y: ["revenue"], format: "currency:USD" }
    ];
    const queries: Array<[string, string]> = [["total", "SELECT sum(order_total) AS revenue FROM shop.orders FINAL"], ["by_channel", "SELECT channel, SUM(order_total) AS revenue FROM shop.orders FINAL GROUP BY channel"]];
    const results = (total: number) => new Map([["total", outcome([["revenue", "Float64"]], [[total]])], ["by_channel", outcome([["channel", "String"], ["revenue", "Float64"]], [["web", 60], ["app", 40]])]]);
    expect((await sanityChecks(row, spec(queries, blocks), results(100.5), context)).hints).toEqual([]);
    const off = await sanityChecks(row, spec(queries, blocks), results(130), context);
    expect(off.hints).toEqual(["sanity reconcile: KPI total (revenue = 130) and chart by_channel (revenue, its rows sum to 100) show the same metric but do not reconcile; their filters, periods, FINAL, or joins differ. Use one definition in both queries."]);
    // Different expressions are not compared, unless the plan names one metric for both (and both add up).
    const other: Array<[string, string]> = [["total", "SELECT sum(order_total) AS revenue FROM shop.orders"], ["by_channel", "SELECT channel, sumIf(order_total, order_total > 0) AS revenue FROM shop.orders GROUP BY channel"]];
    expect((await sanityChecks(row, spec(other, blocks), results(130), context)).hints).toEqual([]);
    const planned = await sanityChecks(row, spec(other, blocks), results(130), { ...context, metricOf: () => "Net revenue" });
    expect(planned.hints[0]).toContain("show the same metric (net revenue)");
    // A breakdown cut by LIMIT never reconciles, so it is not compared.
    const limited: Array<[string, string]> = [queries[0]!, ["by_channel", `${queries[1]![1]} LIMIT 5`]];
    expect((await sanityChecks(row, spec(limited, blocks), results(130), context)).hints).toEqual([]);
  });

  test("coverage: holes inside a series, a series that starts late in its range, and an empty KPI over a range", async () => {
    const row = datasourceRow(datasourceId);
    const days = (list: number[]) => list.map((day) => [`2026-09-${String(day).padStart(2, "0")}`, 5]);
    const block: ReportBlock = { id: "daily", type: "chart", title: "Daily", queryKey: "d", kind: "line", x: "day", y: ["n"], format: "number" };
    const sql = "SELECT toDate(ordered_at) AS day, count() AS n FROM shop.orders WHERE ordered_at >= '2026-09-01' AND ordered_at < '2026-10-01' GROUP BY day ORDER BY day";
    const full = await sanityChecks(row, spec([["d", sql]], [block]), new Map([["d", outcome([["day", "Date"], ["n", "UInt64"]], days(Array.from({ length: 30 }, (_, at) => at + 1)))]]), context);
    expect(full.hints).toEqual([]);
    const holes = await sanityChecks(row, spec([["d", sql]], [block]), new Map([["d", outcome([["day", "Date"], ["n", "UInt64"]], days([1, 2, 3, 4, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]))]]), context);
    expect(holes.hints).toEqual(["sanity coverage: chart daily has 5 empty days inside its series (the longest run is 5); a filter may drop rows, or the date column may be the wrong one. If the gaps are real, say so in a markdown note; otherwise fix the query."]);
    const late = await sanityChecks(row, spec([["d", sql]], [block]), new Map([["d", outcome([["day", "Date"], ["n", "UInt64"]], days(Array.from({ length: 20 }, (_, at) => at + 11)))]]), context);
    expect(late.hints).toEqual(["sanity coverage: chart daily's data starts 10 days after the date range its query asks for; check the time zone, the date column, and the period."]);
    const kpi: ReportBlock = { id: "k", type: "kpi", title: "Orders", queryKey: "k", column: "n", format: "number" };
    const empty = await sanityChecks(row, spec([["k", "SELECT count() AS n FROM shop.orders WHERE ordered_at >= '2027-01-01'"]], [kpi]), new Map([["k", outcome([["n", "UInt64"]], [])]]), context);
    expect(empty.hints[0]).toStartWith("sanity coverage: KPI k came back empty");
  });

  test("fan-out: a guarded sample of the joined table's key, only when the driving table's rows are summed or counted; budgeted", async () => {
    const row = datasourceRow(datasourceId);
    fake.requests.length = 0;
    fake.state.select = (sql) => sql.includes("sample_rows") ? { meta: [{ name: "sample_rows", type: "UInt64" }, { name: "sample_keys", type: "UInt64" }], data: sql.includes("order_items") ? [["4500", "1800"]] : [["900", "900"]] } : { meta: [{ name: "n", type: "UInt64" }], data: [["1"]] };
    const blocks: ReportBlock[] = [{ id: "k", type: "kpi", title: "Revenue", queryKey: "q", column: "revenue", format: "currency:USD" }];
    const inflated = await sanityChecks(row, spec([["q", "SELECT sum(o.order_total) AS revenue FROM shop.orders AS o INNER JOIN shop.order_items AS i ON i.order_id = o.order_id"]], blocks), new Map([["q", outcome([["revenue", "Float64"]], [[452025]])]]), context);
    expect(inflated.extraQueries).toBe(1);
    expect(inflated.hints).toEqual(["sanity fan_out: query q joins shop.order_items on order_id, which repeats (4500 rows for 1800 keys in a sample), and revenue sums or counts rows of shop.orders: each of its rows is counted once per match, so the total is inflated. Aggregate order_items by order_id in a subquery before the join, or compute revenue from orders alone."]);
    const sample = fake.requests.find((item) => item.sql.includes("sample_rows") && !item.sql.startsWith("EXPLAIN"))!;
    expect(sample.sql).toContain(`SELECT count() AS sample_rows, uniqExact(\`order_id\`) AS sample_keys FROM (SELECT \`order_id\` FROM \`shop\`.\`order_items\` LIMIT ${SANITY_LIMITS.fanoutSample})`);
    expect(sample.params.readonly).toBe("2");
    expect(sample.params.query_id).toStartWith("nook-sanity-");
    // A Replacing table is sampled with FINAL; a unique key passes.
    const unique = await sanityChecks(row, spec([["q", "SELECT count() AS n FROM shop.orders AS o JOIN shop.customers AS c FINAL ON c.customer_id = o.order_id"]], [{ id: "k", type: "kpi", title: "N", queryKey: "q", column: "n", format: "number" }]), new Map([["q", outcome([["n", "UInt64"]], [[5]])]]), context);
    expect(unique.hints).toEqual([]);
    expect(fake.requests.some((item) => item.sql.includes("`customers` FINAL LIMIT"))).toBe(true);
    // Summing the joined side (units from items) is not a fan-out of the driving table.
    const items = await sanityChecks(row, spec([["q", "SELECT sum(i.qty) AS units FROM shop.orders AS o JOIN shop.order_items AS i ON i.order_id = o.order_id"]], [{ id: "k", type: "kpi", title: "Units", queryKey: "q", column: "units", format: "number" }]), new Map([["q", outcome([["units", "UInt64"]], [[7650]])]]), context);
    expect(items.extraQueries).toBe(0);
    expect(items.hints).toEqual([]);
    // One sample per table and key, however many queries join it.
    const many = Array.from({ length: 6 }, (_, at): [string, string] => [`q${at}`, `SELECT sum(o.order_total) AS r FROM shop.orders AS o JOIN shop.order_items AS i ON i.${at % 2 ? "line_no" : "order_id"} = o.order_id`]);
    const budgeted = await sanityChecks(row, spec(many, many.map(([key]) => ({ id: key, type: "kpi", title: "R", queryKey: key, column: "r", format: "number" }))), new Map(many.map(([key]) => [key, outcome([["r", "Float64"]], [[1]])])), context);
    expect(budgeted.extraQueries).toBe(2);
  });
});
