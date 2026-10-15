import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { startFakeClickhouse, type FakeRequest } from "./support/fakeClickhouse";
import type { ReportSpec } from "../shared/reports";
import { upgradeSpec } from "../shared/reports";
import {
  bindValues, canonicalValues, defaultValues, isDefaultSet, resolveDateRange, resolveValues, valueProblem, valuesFromSearch, valuesToSearch, type ReportParameter
} from "../shared/reportParams";

const { reportTools } = await import("../server/mcpTools").then(() => import("../server/reports/mcpTools"));
const { syncSchema } = await import("../server/reports/schemaCatalog");
const refresh = await import("../server/reports/refresh");
const params = await import("../server/reports/params");
const { checkSpecShape } = await import("../server/reports/specValidate");

/**
 * Interactive report parameters (spec v3, D489): binding and type rejection, the v2 → v3 upgrade, the
 * shape checks (undeclared, mistyped, unused placeholders), refresh binding the defaults, the per-set
 * cache, a viewer (a Team viewer, shared at view) changing the values, the options check, the rate
 * limit, pruning, and the MCP tools.
 */

retireUsersAfterFile();
const fake = startFakeClickhouse(0);
afterAll(() => fake.stop());

const COUNTRIES = ["DE", "FR", "IN", "US"];
/** A fake warehouse: 10 orders per country per day; the answer follows the bound parameters. */
function answer(sql: string, req: FakeRequest) {
  if (sql.includes("SELECT DISTINCT country")) return { meta: [{ name: "country", type: "String" }], data: COUNTRIES.map((country) => [country]) };
  const from = req.params.param_period_from;
  const to = req.params.param_period_to;
  const days = from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1 : 1;
  const picked = req.params.param_country ? [...req.params.param_country.matchAll(/'([^']*)'/g)].map((match) => match[1]!) : [];
  const countries = picked.length ? COUNTRIES.filter((country) => picked.includes(country)) : COUNTRIES;
  if (sql.includes("GROUP BY country")) return { meta: [{ name: "country", type: "String" }, { name: "orders", type: "UInt64" }], data: countries.map((country) => [country, String(days * 10)]) };
  return { meta: [{ name: "orders", type: "UInt64" }], data: [[String(days * 10 * countries.length)]] };
}
beforeEach(() => {
  fake.reset();
  fake.state.select = answer;
  params.resetParamRateLimit();
});

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const PERIOD: ReportParameter = { id: "period", label: "Period", type: "date_range", chType: "Date", default: { preset: "30d" } };
const COUNTRY: ReportParameter = { id: "country", label: "Country", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: "SELECT DISTINCT country FROM analytics.orders ORDER BY country" };
const WHERE = "day >= {period_from:Date} AND day <= {period_to:Date} AND (empty({country:Array(String)}) OR country IN {country:Array(String)})";

function paramSpec(): ReportSpec {
  return {
    version: 1, specVersion: 3, sections: [], parameters: [PERIOD, COUNTRY],
    queries: [
      { key: "totals", sql: `SELECT count() AS orders FROM analytics.orders WHERE ${WHERE}`, purpose: "Orders", createdBy: "agent" },
      { key: "by_country", sql: `SELECT country, count() AS orders FROM analytics.orders WHERE ${WHERE} GROUP BY country ORDER BY country`, purpose: "Orders by country", createdBy: "agent" }
    ],
    blocks: [
      { id: "kpi-orders", type: "kpi", title: "Orders", intent: "headline", queryKey: "totals", column: "orders" },
      { id: "by-country", type: "chart", title: "Orders by country", intent: "compare", kind: "bar", queryKey: "by_country", x: "country", y: ["orders"] }
    ]
  };
}

// ------------------------------------------------------------------------------- pure

describe("values, binding, and the URL (shared/reportParams.ts)", () => {
  test("date presets resolve to UTC days, both ends included", () => {
    expect(resolveDateRange({ preset: "today" }, "2026-10-15")).toEqual({ from: "2026-10-15", to: "2026-10-15" });
    expect(resolveDateRange({ preset: "7d" }, "2026-10-15")).toEqual({ from: "2026-10-09", to: "2026-10-15" });
    expect(resolveDateRange({ preset: "30d" }, "2026-10-15")).toEqual({ from: "2026-09-16", to: "2026-10-15" });
    expect(resolveDateRange({ preset: "90d" }, "2026-03-01")).toEqual({ from: "2025-12-02", to: "2026-03-01" });
    expect(resolveDateRange({ preset: "mtd" }, "2026-10-15")).toEqual({ from: "2026-10-01", to: "2026-10-15" });
    expect(resolveDateRange({ preset: "qtd" }, "2026-11-20")).toEqual({ from: "2026-10-01", to: "2026-11-20" });
    expect(resolveDateRange({ preset: "custom", from: "2026-01-01", to: "2026-01-31" }, "2026-10-15")).toEqual({ from: "2026-01-01", to: "2026-01-31" });
  });

  test("binding encodes each type as ClickHouse parses param_<name>; never SQL text", () => {
    const list: ReportParameter[] = [
      PERIOD, COUNTRY,
      { id: "route", label: "Route", type: "select", chType: "String", default: "/a", optionsQuery: "SELECT 1" },
      { id: "plan", label: "Plan id", type: "select", chType: "UInt64", default: "7", optionsQuery: "SELECT 1" },
      { id: "min", label: "Min", type: "number", chType: "Float64", default: 1.5 },
      { id: "q", label: "Search", type: "text", chType: "String", default: "" }
    ];
    const bound = bindValues(list, { ...defaultValues(list), country: ["it's", "a\\b"], route: "x\ty", q: "o'k\\" }, "2026-10-15");
    expect(bound).toEqual([
      { name: "period_from", type: "Date", value: "2026-09-16" }, { name: "period_to", type: "Date", value: "2026-10-15" },
      { name: "country", type: "Array(String)", value: "['it\\'s','a\\\\b']" },
      { name: "route", type: "String", value: "x\\ty" },
      { name: "plan", type: "UInt64", value: "7" },
      { name: "min", type: "Float64", value: "1.5" },
      { name: "q", type: "String", value: "o'k\\\\" }
    ]);
  });

  test("values of the wrong type are refused", () => {
    expect(valueProblem(PERIOD, { preset: "2d" })).toContain("preset must be one of");
    expect(valueProblem(PERIOD, { preset: "custom", from: "2026-02-30", to: "2026-03-01" })).toContain("YYYY-MM-DD");
    expect(valueProblem(PERIOD, { preset: "custom", from: "2026-03-02", to: "2026-03-01" })).toBe("from must not be after to");
    expect(valueProblem(PERIOD, { preset: "7d", from: "2026-01-01" })).toContain("no from or to");
    expect(valueProblem(COUNTRY, "DE")).toContain("must be a list");
    expect(valueProblem(COUNTRY, ["DE", "DE"])).toContain("twice");
    expect(valueProblem({ id: "n", label: "N", type: "select", chType: "UInt64", default: "1", optionsQuery: "SELECT 1" }, "1; DROP TABLE x")).toContain("whole number");
    expect(valueProblem({ id: "n", label: "N", type: "number", chType: "UInt32", default: 1, max: 10 }, 11)).toBe("must be at most 10");
    expect(valueProblem({ id: "n", label: "N", type: "number", chType: "Int64", default: 1 }, 1.5)).toBe("must be a whole number");
    expect(valueProblem({ id: "t", label: "T", type: "text", chType: "String", default: "" }, "a\nb")).toBe("must be one line of plain text");
    expect(valueProblem({ id: "t", label: "T", type: "text", chType: "String", default: "" }, "x".repeat(201))).toContain("at most 200");
    expect(resolveValues([PERIOD], { period: { preset: "7d" }, nope: 1 }).problems).toEqual(["nope is not one of this report's parameters"]);
  });

  test("canonical sets: the order of a multi-select and of keys does not matter; defaults are the default set", () => {
    expect(canonicalValues([PERIOD, COUNTRY], { country: ["US", "DE"] })).toBe(canonicalValues([PERIOD, COUNTRY], { country: ["DE", "US"], period: { preset: "30d" } }));
    expect(isDefaultSet([PERIOD, COUNTRY], {})).toBe(true);
    expect(isDefaultSet([PERIOD, COUNTRY], { period: { preset: "7d" } })).toBe(false);
  });

  test("the URL keeps only non-default values and reads them back; anything malformed falls back to the default", () => {
    const values = { period: { preset: "custom" as const, from: "2026-09-01", to: "2026-09-30" }, country: ["DE", "US"] };
    const search = valuesToSearch([PERIOD, COUNTRY], values);
    expect(search).toEqual({ period: ["2026-09-01..2026-09-30"], country: ["DE", "US"] });
    expect(valuesFromSearch([PERIOD, COUNTRY], search)).toEqual(values);
    expect(valuesToSearch([PERIOD, COUNTRY], defaultValues([PERIOD, COUNTRY]))).toEqual({});
    expect(valuesFromSearch([PERIOD, COUNTRY], { period: ["forever"], country: ["DE", "DE"] })).toEqual(defaultValues([PERIOD, COUNTRY]));
    // All (an empty list) when the default selects something is one empty entry.
    const some: ReportParameter = { ...COUNTRY, default: ["DE"] } as ReportParameter;
    expect(valuesToSearch([some], { country: [] })).toEqual({ country: [""] });
    expect(valuesFromSearch([some], { country: [""] })).toEqual({ country: [] });
  });
});

describe("spec v3 shape", () => {
  test("v2 upgrades to v3 with no parameters; v3 keeps them", () => {
    expect(upgradeSpec({ version: 1, specVersion: 2, sections: [], blocks: [], queries: [] })).toMatchObject({ specVersion: 3, parameters: [] });
    expect(upgradeSpec(paramSpec()).parameters.map((param) => param.id)).toEqual(["period", "country"]);
  });

  test("placeholders must be declared, of the declared type, and every parameter used; unknown fields are refused", () => {
    expect(checkSpecShape(paramSpec()).ok).toBe(true);
    const errors = (spec: unknown) => { const shape = checkSpecShape(spec); return shape.ok ? [] : shape.errors; };
    const base = paramSpec();
    expect(errors({ ...base, queries: [{ ...base.queries[0]!, sql: "SELECT count() AS orders FROM analytics.orders WHERE day >= {since:Date}" }, base.queries[1]!] }).join("\n")).toContain("{since:Date} is not a declared parameter");
    expect(errors({ ...base, queries: [{ ...base.queries[0]!, sql: base.queries[0]!.sql.replace("{period_from:Date}", "{period_from:String}") }, base.queries[1]!] }).join("\n")).toContain("{period_from:String} must be written {period_from:Date}");
    expect(errors({ ...base, parameters: [...base.parameters, { id: "unused", label: "Unused", type: "text", default: "" }] }).join("\n")).toContain("parameter unused: no query reads it");
    expect(errors({ ...base, parameters: [{ ...PERIOD, colour: "red" }, COUNTRY] }).join("\n")).toContain("not part of the spec");
    expect(errors({ ...base, parameters: [{ ...PERIOD, default: { preset: "custom", from: "2026-10-02", to: "2026-10-01" } }, COUNTRY] }).join("\n")).toContain("from must not be after to");
    expect(errors({ ...base, parameters: [PERIOD, { ...COUNTRY, chType: "Identifier" }] }).join("\n")).toMatch(/chType/);
  });
});

// ------------------------------------------------------------------------------- server

const admin = await createUser("Params admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const owner = await createUser("Params owner");
const viewer = await createUser("Params team viewer");
db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
const stranger = await createUser("Params stranger");

const created = await send(admin, "POST", "/reports/admin/datasources", { name: "Params warehouse", url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
const datasourceId = created.body.datasource.id as string;
await syncSchema(datasourceId).catch(() => undefined);

async function seededReport() {
  const report = await send(owner, "POST", "/reports", { title: "Orders by country", datasourceId });
  const id = report.body.report.id as string;
  db.query("UPDATE reports SET spec_json = ? WHERE id = ?").run(JSON.stringify(paramSpec()), id);
  const shared = await send(owner, "PUT", `/reports/${id}/sharing`, { visibility: "selected", shares: [{ kind: "user", id: viewer.userId, level: "view" }] });
  expect(shared.status).toBe(200);
  return id;
}

const selects = () => fake.requests.filter((item) => item.sql.startsWith("SELECT * FROM (") && !item.sql.includes("DISTINCT"));
const enc = (values: unknown) => encodeURIComponent(JSON.stringify(values));

describe("runs with parameters", () => {
  test("Refresh all binds the default set over HTTP (param_*), never in the SQL; results keep the bound values", async () => {
    const reportId = await seededReport();
    const run = await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
    expect(run.status).toBe("succeeded");
    const today = new Date().toISOString().slice(0, 10);
    const expected = resolveDateRange({ preset: "30d" }, today);
    for (const item of fake.requests.filter((req) => req.sql.includes("analytics.orders"))) {
      expect(item.sql).toContain("{period_from:Date}");
      expect(item.sql).not.toContain(expected.from);
      expect(item.params).toMatchObject({ param_period_from: expected.from, param_period_to: expected.to, param_country: "[]" });
    }
    // The tree check is sent the same parameters as the run.
    expect(fake.requests.filter((req) => req.sql.startsWith("EXPLAIN QUERY TREE")).every((req) => req.params.param_period_from === expected.from)).toBe(true);
    const view = await send(owner, "GET", `/reports/${reportId}/results`);
    const totals = view.body.results.find((item: Json) => item.queryKey === "totals");
    expect(totals.result.rows).toEqual([["1200"]]);
    expect(totals.result.params).toEqual({ period_from: expected.from, period_to: expected.to, country: "[]" });
  });

  test("a Team viewer (shared at view) changes the date range and the filter: the numbers follow, cached and shared per set", async () => {
    const reportId = await seededReport();
    await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
    const values = { period: { preset: "7d" }, country: ["DE", "US"] };
    const before = await send(viewer, "GET", `/reports/${reportId}/results?values=${enc(values)}`);
    expect(before.status).toBe(200);
    expect(before.body.set).toMatchObject({ isDefault: false, missing: ["totals", "by_country"] });
    expect(before.body.results.every((item: Json) => item.result === null)).toBe(true);
    fake.requests.length = 0;
    const ran = await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values });
    expect(ran.status).toBe(200);
    expect(ran.body.set.missing).toEqual([]);
    expect(ran.body.results.find((item: Json) => item.queryKey === "totals").result.rows).toEqual([["140"]]);
    expect(ran.body.results.find((item: Json) => item.queryKey === "by_country").result.rows).toEqual([["DE", "70"], ["US", "70"]]);
    expect(selects().length).toBe(2);
    // The run lock was taken and released, and Runs shows no reader run.
    expect(refresh.runningRun(reportId)).toBeNull();
    expect(refresh.listRuns(reportId, owner.userId).every((run) => !run.queryKeys?.[0]?.startsWith("~p:"))).toBe(true);
    // The owner, asking for the same set in another key order, reads the same cache: nothing runs.
    fake.requests.length = 0;
    const again = await send(owner, "POST", `/reports/${reportId}/param-runs`, { values: { country: ["US", "DE"], period: { preset: "7d" } } });
    expect(again.body.results.find((item: Json) => item.queryKey === "totals").result.rows).toEqual([["140"]]);
    expect(selects().length).toBe(0);
    // A different set is keyed apart.
    const other = await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { period: { preset: "today" }, country: ["IN"] } });
    expect(other.body.results.find((item: Json) => item.queryKey === "totals").result.rows).toEqual([["10"]]);
    expect((db.query("SELECT count(*) AS n FROM report_param_sets WHERE report_id = ?").get(reportId) as { n: number }).n).toBe(2);
    // The default results never changed.
    const defaults = await send(viewer, "GET", `/reports/${reportId}/results`);
    expect(defaults.body.results.find((item: Json) => item.queryKey === "totals").result.rows).toEqual([["1200"]]);
    // A default refresh makes every cached set stale again (it re-runs on the next view).
    await Bun.sleep(5);
    await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
    const stale = await send(viewer, "GET", `/reports/${reportId}/results?values=${enc(values)}`);
    expect(stale.body.set.missing.sort()).toEqual(["by_country", "totals"]);
  });

  test("values equal to the defaults are the default set: nothing runs and the stored results answer", async () => {
    const reportId = await seededReport();
    await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
    fake.requests.length = 0;
    const view = await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { period: { preset: "30d" }, country: [] } });
    expect(view.body.set.isDefault).toBe(true);
    expect(selects().length).toBe(0);
    expect(view.body.results.find((item: Json) => item.queryKey === "totals").result.rows).toEqual([["1200"]]);
  });

  test("refused: values of the wrong type, a choice that is not an option, strangers; reads are rate-limited per person", async () => {
    const reportId = await seededReport();
    const bad = await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { period: { preset: "custom", from: "2026-01-02", to: "x" } } });
    expect(bad).toMatchObject({ status: 400, body: { code: "INVALID" } });
    const unknown = await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { nope: 1 } });
    expect(unknown.status).toBe(400);
    const notOption = await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { country: ["XX"] } });
    expect(notOption).toMatchObject({ status: 400, body: { code: "INVALID" } });
    expect(notOption.body.error).toContain("not one of the choices for Country");
    expect((await send(stranger, "POST", `/reports/${reportId}/param-runs`, { values: { period: { preset: "7d" } } })).status).toBe(404);
    expect((await send(stranger, "GET", `/reports/${reportId}/parameters/country/options`)).status).toBe(404);
    const options = await send(viewer, "GET", `/reports/${reportId}/parameters/country/options`);
    expect(options.body.options).toMatchObject({ paramId: "country", options: COUNTRIES, truncated: false, error: null });
    // The viewer is still read-only for everything else.
    expect((await send(viewer, "POST", `/reports/${reportId}/refresh`, {})).status).toBe(403);
    let limited = 0;
    for (let index = 0; index < params.PARAM_RUNS.perMinute + 2; index += 1) {
      const day = `2026-01-${String(index + 1).padStart(2, "0")}`;
      const result = await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { period: { preset: "custom", from: day, to: day } } });
      if (result.status === 429) limited += 1;
    }
    expect(limited).toBe(2);
  });

  test("another run holding the report's lock answers 409 RUN_IN_PROGRESS", async () => {
    const reportId = await seededReport();
    let release!: () => void;
    fake.state.hold = new Promise<void>((resolve) => { release = resolve; });
    const running = refresh.startRefresh(owner.userId, reportId, { trigger: "user" });
    const blocked = await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { period: { preset: "7d" } } });
    expect(blocked).toMatchObject({ status: 409, body: { code: "RUN_IN_PROGRESS" } });
    release();
    await running.done;
  });

  test("old sets are pruned (the 20 most recently used, none unused for 7 days) and their results go with them", async () => {
    const reportId = await seededReport();
    const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    for (let index = 0; index < 25; index += 1) {
      const hash = index.toString(16).padStart(64, "0");
      db.query("INSERT INTO report_param_sets (report_id, set_hash, values_json, bound_json, created_at, last_used_at) VALUES (?, ?, '[]', '{}', ?, ?)").run(reportId, hash, at(index < 3 ? 9 : 1), at(index < 3 ? 9 : 1 - index / 100));
      db.query("INSERT INTO report_param_results (id, report_id, set_hash, query_key, sql, created_at) VALUES (?, ?, ?, 'totals', 'SELECT 1', ?)").run(crypto.randomUUID(), reportId, hash, at(1));
    }
    params.pruneParamSets(reportId);
    expect((db.query("SELECT count(*) AS n FROM report_param_sets WHERE report_id = ?").get(reportId) as { n: number }).n).toBe(20);
    expect((db.query("SELECT count(*) AS n FROM report_param_results WHERE report_id = ?").get(reportId) as { n: number }).n).toBe(20);
    expect(db.query("SELECT 1 FROM report_param_sets WHERE report_id = ? AND set_hash = ?").get(reportId, "0".repeat(64))).toBeNull();
  });
});

describe("MCP", () => {
  const tool = (name: string) => reportTools.find((item) => item.name === name)!;
  const key = (session: Session, scopes: string[] = ["reports:read"]) => ({ keyId: `k-${session.userId.slice(0, 6)}`, userId: session.userId, name: "k", scopes: scopes as never });

  test("get_report lists the parameters and the bound set; get_report_block runs a set and returns its rows; refresh_report runs a set", async () => {
    const reportId = await seededReport();
    await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
    const report = await tool("get_report").handler({ reportId, parameters: { period: { preset: "7d" } } }, key(viewer)) as Json;
    expect(report.specVersion).toBe(3);
    expect(report.parameters.map((param: Json) => param.id)).toEqual(["period", "country"]);
    expect(report.parameterSet).toMatchObject({ isDefault: false, values: { period: { preset: "7d" }, country: [] }, notYetRun: ["totals", "by_country"] });
    expect(report.parameterSet.bound.period_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const block = await tool("get_report_block").handler({ reportId, blockId: "kpi-orders", parameters: { period: { preset: "7d" }, country: ["FR"] } }, key(viewer)) as Json;
    expect(block.result.rows).toEqual([["70"]]);
    expect(block.result.params.country).toBe("['FR']");
    expect(block.parameters).toMatchObject({ isDefault: false });
    const plain = await tool("get_report_block").handler({ reportId, blockId: "kpi-orders" }, key(viewer)) as Json;
    expect(plain.result.rows).toEqual([["1200"]]);
    const refreshed = await tool("refresh_report").handler({ reportId, parameters: { period: { preset: "today" } } }, key(viewer, ["reports:write"])) as Json;
    expect(refreshed.queries).toEqual([{ key: "totals", ok: true, rows: 1, error: null }, { key: "by_country", ok: true, rows: 4, error: null }]);
    await expect(Promise.resolve(tool("get_report").handler({ reportId, parameters: { period: "soon" } }, key(viewer)))).rejects.toMatchObject({ code: "INVALID" });
  });
});
