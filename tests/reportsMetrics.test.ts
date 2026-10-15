import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse } from "./support/fakeClickhouse";
import { retireUsersAfterFile } from "./support/retireUsers";
import type { CatalogMetric } from "../shared/reportsMetrics";
import type { PlanTodo } from "../shared/reportsGenerate";

const { metricExcerpt, changedMetrics, metricHints, saveCatalog, catalogRow, catalogPromptLines, checkMetrics, pageScopes, mergePageMetrics, pageMetricsChanged } = await import("../server/reports/metricCatalog");
const { Planner } = await import("../server/reports/planner");
const { syncSchema } = await import("../server/reports/schemaCatalog");
const { datasourceRow } = await import("../server/reports/datasources");
const { createReport } = await import("../server/reports/service");
const { recordSnapshot, docState, sha256Of } = await import("../server/reports/docSource");

/**
 * E4: the metric catalog. Excerpts and "Doc changed" naming metrics, the enforcement hint, the
 * planner's metricId, the deterministic checks (table, LIMIT 0 through the guard), versions, and the
 * owner-only Metrics API. Extraction inside a generation and the enforcement on a real run are
 * covered by tests/reportEval.test.ts (peerdb_orders records a catalog; its trap gets `sanity metric:`).
 */

retireUsersAfterFile();

const fake = startFakeClickhouse(0);
let owner: Session;
let other: Session;
let datasourceId = "";

const DOC = "# Revenue\n\n## Metrics\n\n- **Net revenue** (USD): the sum of `amount` over paid orders.\n- **Orders**: the number of paid orders.\n\nOther text.\n";
const metric = (overrides: Partial<CatalogMetric> = {}): CatalogMetric => ({
  id: "net_revenue", name: "Net revenue", definition: "Sum of amount over paid orders", expression: "sum(amount)", table: "shop.orders", filters: ["_peerdb_is_deleted = 0"], final: true,
  grain: "total", unit: "currency:USD", timeColumn: "created_at", excerpt: metricExcerpt(DOC, "Net revenue"), problems: [], ...overrides
});

async function send(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

beforeAll(async () => {
  owner = await createUser("Metrics owner");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(owner.userId);
  other = await createUser("Metrics other");
  fake.state.tables = [
    { db: "shop", name: "orders", engine: "ReplacingMergeTree(_peerdb_version)", sorting_key: "id", columns: [{ name: "id", type: "UInt64" }, { name: "amount", type: "Decimal(12, 2)" }, { name: "created_at", type: "DateTime" }, { name: "_peerdb_is_deleted", type: "Int8" }] },
    { db: "shop", name: "events", engine: "MergeTree", sorting_key: "ts", columns: [{ name: "ts", type: "DateTime" }] }
  ];
  const created = await send(owner, "POST", "/reports/admin/datasources", { name: `Metrics ${crypto.randomUUID().slice(0, 6)}`, url: fake.url, username: "nook_ro", password: "pw", database: "shop", allowlist: ["shop"] });
  expect(created.status).toBe(201);
  datasourceId = created.body.datasource.id;
  await syncSchema(datasourceId);
});
afterAll(() => fake.stop());

describe("L2: metrics on a changed linked page", () => {
  const PAGE = "# Revenue rules\n\n- **Net revenue**: the sum of `amount` over paid orders.\n- **Refund rate**: refunds over orders.\n";
  const onPage = (overrides: Partial<CatalogMetric>) => metric({ page: "Revenue rules", ...overrides });
  const catalog = [metric({ id: "orders", name: "Orders", excerpt: metricExcerpt(DOC, "Orders") }), onPage({ excerpt: metricExcerpt(PAGE, "Net revenue") }), onPage({ id: "refund_rate", name: "Refund rate", expression: "countIf(refund) / count()", excerpt: metricExcerpt(PAGE, "Refund rate") })];

  test("pageScopes: only the page's metrics whose text there changed; none when it changed elsewhere or for another page", () => {
    expect(pageScopes(catalog, [{ title: "Revenue rules", markdown: `${PAGE}\nMore text.` }])).toEqual([]);
    expect(pageScopes(catalog, [{ title: "Other page", markdown: "# Other\n- **Net revenue**: something else." }])).toEqual([]);
    const changed = PAGE.replace("over paid orders.", "over paid and shipped orders.");
    const scopes = pageScopes(catalog, [{ title: "revenue rules", markdown: changed }]);
    expect(scopes.map((scope) => [scope.page.title, scope.metrics.map((item) => item.id)])).toEqual([["revenue rules", ["net_revenue"]]]);
    // A definition removed from the page counts too.
    expect(pageScopes(catalog, [{ title: "Revenue rules", markdown: "# Revenue rules\n\n- **Net revenue**: the sum of `amount` over paid orders.\n" }])[0]!.metrics.map((item) => item.id)).toEqual(["refund_rate"]);
  });

  test("mergePageMetrics replaces the scope's metrics in place, keeps a gone one with a problem, and drops strays; pageMetricsChanged names them", () => {
    const page = { title: "Revenue rules", markdown: PAGE.replace("over paid orders.", "over paid and shipped orders.").replace(/- \*\*Refund rate\*\*.*\n/, "") };
    const scope = { page, metrics: [catalog[1]!, catalog[2]!] };
    const fresh = [{ ...catalog[1]!, expression: "sumIf(amount, status IN ('paid','shipped'))", page: null }, metric({ id: "stray", name: "Stray" })];
    const merged = mergePageMetrics(catalog, scope, fresh);
    expect(merged.map((item) => item.id)).toEqual(["orders", "net_revenue", "refund_rate"]);
    expect(merged[0]).toBe(catalog[0]!);
    expect(merged[1]).toMatchObject({ expression: "sumIf(amount, status IN ('paid','shipped'))", page: "Revenue rules" });
    expect(merged[1]!.excerpt).toContain("shipped");
    expect(merged[2]).toMatchObject({ expression: "countIf(refund) / count()", excerpt: null, problems: ["No longer defined on the linked page “Revenue rules”"] });
    expect(pageMetricsChanged(catalog, merged, ["Revenue rules"])).toEqual(["Net revenue", "Refund rate"]);
    expect(pageMetricsChanged(catalog, merged, ["Another page"])).toEqual([]);
    expect(pageMetricsChanged(catalog, catalog, ["Revenue rules"])).toEqual([]);
  });
});

describe("the catalog's pieces", () => {
  test("migration 058 made report_metric_catalogs", () => {
    expect(db.query("SELECT id FROM schema_migrations WHERE id = 58").get()).toEqual({ id: 58 });
    const columns = (db.query("PRAGMA table_info(report_metric_catalogs)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(["id", "report_id", "version", "snapshot_id", "doc_sha256", "source", "metrics_json", "run_id", "created_by", "created_at"]);
    // E5's setting keys joined agent_settings' CHECK.
    const settings = (db.query("SELECT sql FROM sqlite_master WHERE name = 'agent_settings'").get() as { sql: string }).sql;
    expect(settings).toContain("'report_fallback_provider_id'");
    expect(settings).toContain("'report_fallback_model'");
    expect(settings).toContain("'nook_auto_tools'");
  });

  test("excerpts find the definition; a changed or removed definition is named", () => {
    expect(metricExcerpt(DOC, "Net revenue")).toBe("- **Net revenue** (USD): the sum of `amount` over paid orders.");
    expect(metricExcerpt(DOC, "Orders")).toBe("- **Orders**: the number of paid orders.");
    expect(metricExcerpt(DOC, "Churn")).toBeNull();
    const metrics = [metric(), metric({ id: "orders", name: "Orders", excerpt: metricExcerpt(DOC, "Orders") })];
    expect(changedMetrics(metrics, DOC)).toEqual([]);
    expect(changedMetrics(metrics, DOC.replace("over paid orders.", "over paid and shipped orders."))).toEqual(["Net revenue"]);
    expect(changedMetrics(metrics, DOC.replace("- **Orders**: the number of paid orders.\n", ""))).toEqual(["Orders"]);
  });

  test("SQL for a catalog metric must use its expression, filters, and FINAL", () => {
    const todo = (queryKey: string): PlanTodo => ({ id: "rev", title: "Net revenue", kind: "kpi", section: null, intent: null, metric: "Net revenue", docRef: null, tables: [], status: "done", note: null, queryKey, blockId: null, metricId: "net_revenue" });
    const spec = { queries: [
      { key: "good", sql: "SELECT SUM(amount) AS revenue FROM shop.orders FINAL WHERE _peerdb_is_deleted = 0 AND created_at >= '2026-09-01'", purpose: "", createdBy: "agent" as const },
      { key: "bad", sql: "SELECT sum(amount) AS revenue FROM shop.orders AS o WHERE created_at >= '2026-09-01'", purpose: "", createdBy: "agent" as const }
    ] };
    expect(metricHints(spec, [todo("good")], [metric()], "shop")).toEqual([]);
    expect(metricHints(spec, [todo("bad")], [metric()], "shop")).toEqual(["sanity metric: todo rev is the catalog metric net_revenue (Net revenue), but query bad lacks FINAL, the filter _peerdb_is_deleted = 0. Use the catalog's definition: sum(amount) FROM shop.orders FINAL WHERE _peerdb_is_deleted = 0."]);
    // A metric Nook could not check is not enforced.
    expect(metricHints(spec, [todo("bad")], [metric({ problems: ["No allowlisted table shop.orders"] })], "shop")).toEqual([]);
    expect(catalogPromptLines([metric()])[2]).toBe("- net_revenue — Net revenue: `sum(amount)` FROM shop.orders FINAL WHERE (_peerdb_is_deleted = 0); unit currency:USD; grain total; time created_at. Sum of amount over paid orders");
  });

  test("the planner links todos to catalog metrics by metricId or by name, and refuses an unknown id", () => {
    const planner = new Planner({ mode: "report", datasourceId: null, runId: crypto.randomUUID(), metrics: [{ id: "net_revenue", name: "Net revenue" }] });
    expect(() => planner.makePlan({ goal: "g", todos: [{ id: "a", title: "A", kind: "kpi", metricId: "nope" }] })).toThrow("metricId nope is not in the metric catalog (ids: net_revenue)");
    planner.makePlan({ goal: "g", todos: [{ id: "a", title: "A", kind: "kpi", metric: "net revenue" }, { id: "b", title: "B", kind: "kpi", metricId: "net_revenue" }, { id: "c", title: "C", kind: "chart", intent: "trend", metric: "Orders" }] });
    expect(planner.plan!.todos.map((item) => item.metricId ?? null)).toEqual(["net_revenue", "net_revenue", null]);
  });

  test("checks: an unknown table, FINAL on a plain MergeTree, a missing time column, and an expression ClickHouse refuses", async () => {
    fake.requests.length = 0;
    fake.state.queryTree = (select) => select.includes("amout") ? "Code: 47. DB::Exception: Unknown expression or function identifier `amout` in scope SELECT sum(amout) AS value FROM shop.orders. Maybe you meant: ['amount']. (UNKNOWN_IDENTIFIER) (version 26.6.8.7 (official build))" : null;
    const checked = await checkMetrics(datasourceRow(datasourceId), [metric(), metric({ id: "a", table: "shop.nope" }), metric({ id: "b", table: "shop.events", final: true, timeColumn: "day", expression: "count()", filters: [] }), metric({ id: "c", expression: "sum(amout)" })], { userId: owner.userId });
    fake.state.queryTree = null;
    expect(checked.map((item) => item.problems)).toEqual([
      [],
      ["No allowlisted table shop.nope"],
      ["FINAL does not apply to shop.events (MergeTree)", "No column day in shop.events"],
      [expect.stringContaining("A column or function name is not one of shop.orders; the closest columns are amount")]
    ]);
    const sent = fake.requests.find((item) => item.sql.startsWith("SELECT * FROM (") && item.sql.includes("sum(amount) AS value"))!;
    expect(sent.sql).toContain("SELECT sum(amount) AS value FROM `shop`.`orders` FINAL WHERE (_peerdb_is_deleted = 0) LIMIT 0");
  });
});

describe("the Metrics API and Doc changed", () => {
  test("owner-only; a save is a new version (stale refused), re-checked; Doc changed names the changed metric", async () => {
    const report = createReport(owner.userId, { title: "Metrics report", datasourceId, titleSource: "user" });
    expect((await send(owner, "GET", `/reports/${report.id}/metrics`)).body).toEqual({ catalog: null });
    expect((await send(other, "GET", `/reports/${report.id}/metrics`)).status).toBe(404);
    const snapshot = recordSnapshot(report.id, { title: "Revenue", markdown: DOC, sha256: sha256Of(DOC), bytes: DOC.length, truncated: false });
    db.query("UPDATE reports SET doc_hash = ?, doc_ref = 'x', doc_source = 'nook' WHERE id = ?").run(sha256Of(DOC), report.id);
    saveCatalog(report.id, { snapshotId: snapshot.id, docSha256: sha256Of(DOC), source: "extract", metrics: [metric()], runId: null, userId: owner.userId });
    const view = await send(owner, "GET", `/reports/${report.id}/metrics`);
    expect(view.body.catalog).toMatchObject({ version: 1, source: "extract", metrics: [{ id: "net_revenue", problems: [] }], versions: [{ version: 1, source: "extract" }] });

    const edited = { ...view.body.catalog.metrics[0], filters: ["_peerdb_is_deleted = 0", "amount > 0"] };
    delete edited.problems;
    const saved = await send(owner, "PUT", `/reports/${report.id}/metrics`, { expectedVersion: 1, metrics: [edited, { id: "orders", name: "Orders", definition: "", expression: "count()", table: "shop.missing", filters: [], final: false, grain: null, unit: "orders", timeColumn: null }] });
    expect(saved.status).toBe(200);
    expect(saved.body.catalog).toMatchObject({ version: 2, source: "edit", createdBy: { id: owner.userId } });
    expect(saved.body.catalog.metrics.map((item: CatalogMetric) => [item.id, item.problems])).toEqual([["net_revenue", []], ["orders", ["No allowlisted table shop.missing"]]]);
    // The excerpt stays with the metric across an edit.
    expect(saved.body.catalog.metrics[0].excerpt).toBe(metricExcerpt(DOC, "Net revenue"));
    expect((await send(owner, "PUT", `/reports/${report.id}/metrics`, { expectedVersion: 1, metrics: [] })).body).toMatchObject({ code: "STALE" });
    expect((await send(owner, "PUT", `/reports/${report.id}/metrics`, { expectedVersion: 2, metrics: [{ ...edited, id: "Bad Id" }] })).body).toMatchObject({ code: "INVALID" });
    expect((await send(other, "PUT", `/reports/${report.id}/metrics`, { expectedVersion: 2, metrics: [] })).status).toBe(404);
    expect((await send(owner, "GET", `/reports/${report.id}/metrics?version=1`)).body.catalog.version).toBe(1);
    expect(catalogRow(report.id, sha256Of(DOC))!.version).toBe(2);
    expect(db.query("SELECT count(*) AS n FROM audit_log WHERE event_type = 'reports.metrics.update' AND metadata_json LIKE ?").get(`%${report.id}%`)).toEqual({ n: 1 });

    // A new snapshot whose Net revenue definition changed: Doc changed names it.
    const changed = DOC.replace("over paid orders.", "over paid and shipped orders.");
    recordSnapshot(report.id, { title: "Revenue", markdown: changed, sha256: sha256Of(changed), bytes: changed.length, truncated: false });
    expect(docState(report.id, owner.userId)).toMatchObject({ changed: true, mainChanged: true, metricsChanged: ["Net revenue"] });
  });
});

describe("the catalog over MCP (E6)", () => {
  test("get_report_metrics reads the owner's catalog; update_report_metric changes or adds one metric, re-checked, a new version, audited; never for someone else", async () => {
    await import("../server/mcpTools");
    const { reportTools } = await import("../server/reports/mcpTools");
    const tool = (name: string) => reportTools.find((item) => item.name === name)!;
    const key = { keyId: crypto.randomUUID(), userId: owner.userId, name: "k", scopes: ["reports:read", "reports:write"] } as never;
    const report = createReport(owner.userId, { title: "MCP metrics", datasourceId, titleSource: "user" });
    expect(await tool("get_report_metrics").handler({ reportId: report.id }, key)).toEqual({ catalog: null });
    saveCatalog(report.id, { snapshotId: null, docSha256: sha256Of(DOC), source: "extract", metrics: [metric()], runId: null, userId: owner.userId });
    const read = await tool("get_report_metrics").handler({ reportId: report.id }, key) as { catalog: { version: number; metrics: Array<Record<string, unknown>> } };
    expect(read.catalog.version).toBe(1);
    expect(read.catalog.metrics[0]).toMatchObject({ id: "net_revenue", expression: "sum(amount)", filters: ["_peerdb_is_deleted = 0"], final: true });
    expect("excerpt" in read.catalog.metrics[0]!).toBe(false);
    const changed = await tool("update_report_metric").handler({ reportId: report.id, metric: { id: "net_revenue", filters: ["_peerdb_is_deleted = 0", "amount > 0"] }, expectedVersion: 1 }, key) as { version: number; metric: CatalogMetric };
    expect(changed).toMatchObject({ version: 2, metric: { id: "net_revenue", name: "Net revenue", filters: ["_peerdb_is_deleted = 0", "amount > 0"], problems: [] } });
    const added = await tool("update_report_metric").handler({ reportId: report.id, metric: { id: "events", name: "Events", expression: "count()", table: "shop.events" } }, key) as { version: number; metric: CatalogMetric };
    expect(added).toMatchObject({ version: 3, metric: { id: "events", problems: [] } });
    await expect(Promise.resolve().then(() => tool("update_report_metric").handler({ reportId: report.id, metric: { id: "partial", name: "Partial" } }, key))).rejects.toThrow("A new metric needs a name, an expression, and a table");
    await expect(Promise.resolve().then(() => tool("update_report_metric").handler({ reportId: report.id, metric: { id: "events", unit: "events" }, expectedVersion: 1 }, key))).rejects.toThrow("changed since");
    const stranger = { keyId: crypto.randomUUID(), userId: other.userId, name: "k", scopes: ["reports:read", "reports:write"] } as never;
    await expect(Promise.resolve().then(() => tool("get_report_metrics").handler({ reportId: report.id }, stranger))).rejects.toThrow();
    const audits = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'reports.metrics.update' AND metadata_json LIKE ?").all(`%${report.id}%`) as Array<{ metadata_json: string }>;
    expect(audits.map((row) => JSON.parse(row.metadata_json).via)).toEqual(["mcp", "mcp"]);
    expect(tool("update_report_metric").write).toBe(true);
    expect(tool("get_report_metrics").scopes).toEqual(["reports:read"]);
  });
});
