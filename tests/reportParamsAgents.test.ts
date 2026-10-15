import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse, type FakeRequest } from "./support/fakeClickhouse";
import { retireUsersAfterFile } from "./support/retireUsers";
import { sampleAnswer, sampleSpec } from "./support/reportSeed";
import { qaEditScript, startScriptedProvider, unplanned, type Script, type ScriptContext } from "../scripts/fakeReportProvider";
import { DEFAULT_COMPAT } from "../shared/agents";
import type { PatchOp } from "../shared/reportsEdit";
import { resolveDateRange } from "../shared/reportParams";

const { generateDeps, liveGenerations } = await import("../server/reports/generate");
const { editDeps, liveEdits } = await import("../server/reports/edit");
const { applyPatch, diffSpecs, parsePatch } = await import("../server/reports/patch");
const refresh = await import("../server/reports/refresh");
const { syncSchema } = await import("../server/reports/schemaCatalog");
const { upgradeSpec } = await import("../shared/reports");

/**
 * Report parameters and the agents (D489), with a scripted provider: generation from a doc that says
 * "last 30 days by route" plans and declares a date range and a route filter, tests its SQL with
 * run_sql's `parameters`, and is validated with the defaults and one other set; the edit agent adds a
 * route filter with add_parameter and update_query; the patch ops themselves; and the version diff.
 */

retireUsersAfterFile();
setDefaultTimeout(30_000);

const fake = startFakeClickhouse(0);
const provider = startScriptedProvider(0);
const originalGenerate = generateDeps.connection;
const originalEdit = editDeps.connection;

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const ROUTES = ["/api/orders", "/api/search", "/login"];
/** 100 requests per route per day; the answer follows the bound parameters. */
function answer(sql: string, req: FakeRequest) {
  if (sql.includes("DISTINCT route")) return { meta: [{ name: "route", type: "String" }], data: ROUTES.map((route) => [route]) };
  const from = req.params.param_period_from;
  const to = req.params.param_period_to;
  const days = from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1 : 1;
  const picked = [...(req.params.param_routes ?? "").matchAll(/'([^']*)'/g)].map((match) => match[1]!);
  const routes = picked.length ? ROUTES.filter((route) => picked.includes(route)) : ROUTES;
  if (sql.includes("GROUP BY route")) return { meta: [{ name: "route", type: "String" }, { name: "requests", type: "UInt64" }], data: routes.map((route) => [route, String(days * 100)]) };
  if (sql.includes("by_country_filtered") || sql.includes("country IN")) return sampleAnswer(sql);
  return sampleAnswer(sql);
}

const PERIOD = { id: "period", label: "Period", type: "date_range", default: { preset: "30d" } };
const ROUTE = { id: "routes", label: "Route", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: "SELECT DISTINCT route FROM analytics.requests ORDER BY route LIMIT 200" };
const BY_ROUTE_SQL = "SELECT route, count() AS requests FROM analytics.requests WHERE ts >= {period_from:Date} AND ts < {period_to:Date} + 1 AND (empty({routes:Array(String)}) OR route IN {routes:Array(String)}) GROUP BY route ORDER BY requests DESC";

const called = (context: ScriptContext) => (context.body.messages ?? []).flatMap((turn) => (turn.tool_calls ?? []).map((call) => call.function?.name ?? ""));

/** The generation: plan with the parameters, run the SQL with them, close the todo, submit. */
const generateScript: Script = unplanned((context) => {
  const done = called(context);
  if (!done.includes("plan_report")) return { toolCalls: [{ name: "plan_report", arguments: { goal: "Requests over the last 30 days by route", todos: [{ id: "by_route", title: "Requests by route", kind: "chart", intent: "rank", tables: ["analytics.requests"] }], parameters: [{ id: "period", type: "date_range", label: "Period" }, { id: "routes", type: "multi_select", label: "Route" }] } }] };
  if (!done.includes("run_sql")) return { toolCalls: [{ name: "run_sql", arguments: { sql: BY_ROUTE_SQL, key: "by_route", purpose: "Requests by route", parameters: [PERIOD, ROUTE] } }] };
  if (!done.includes("update_todo")) return { toolCalls: [{ name: "update_todo", arguments: { id: "by_route", status: "done", queryKey: "by_route" } }] };
  return { toolCalls: [{ name: "submit_report", arguments: {
    title: "Requests by route", parameters: [PERIOD, ROUTE],
    queries: [{ key: "by_route", sql: BY_ROUTE_SQL, purpose: "Requests by route" }],
    blocks: [{ id: "routes-bar", type: "chart", title: "Requests by route", intent: "rank", kind: "horizontal_bar", queryKey: "by_route", x: "route", y: ["requests"], unit: "requests" }]
  } }] };
});

let admin: Session;
let owner: Session;
let datasourceId = "";
let doc = "";

beforeAll(async () => {
  admin = await createUser("Params agents admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("Params agents owner");
  fake.state.tables = [
    { db: "analytics", name: "requests", engine: "MergeTree", columns: [{ name: "ts", type: "DateTime" }, { name: "route", type: "LowCardinality(String)" }] },
    { db: "analytics", name: "orders", engine: "MergeTree", columns: [{ name: "day", type: "Date" }, { name: "country", type: "String" }, { name: "revenue", type: "Decimal(18, 2)" }] }
  ];
  fake.state.select = answer;
  const datasource = await send(admin, "POST", "/reports/admin/datasources", { name: `Params DS ${crypto.randomUUID().slice(0, 6)}`, url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
  datasourceId = datasource.body.datasource.id;
  await syncSchema(datasourceId);
  const id = (await send(owner, "POST", "/notes", { folderId: null })).body.note.id as string;
  expect((await send(owner, "PUT", `/notes/${id}/draft`, { markdown: "# Traffic\n\nRequests over the last 30 days by route, from `analytics.requests`.", revision: 1 })).status).toBe(200);
  expect((await send(owner, "POST", `/notes/${id}/publish`)).status).toBe(200);
  doc = id;
  const connection = () => ({ id: "scripted", baseUrl: provider.baseUrl, apiKey: null, model: "scripted-report-model", compat: DEFAULT_COMPAT });
  generateDeps.connection = connection;
  editDeps.connection = connection;
});
afterAll(() => {
  generateDeps.connection = originalGenerate;
  editDeps.connection = originalEdit;
  fake.stop();
  provider.stop();
});
afterEach(async () => {
  const until = Date.now() + 15_000;
  while (liveGenerations().length || liveEdits().length) {
    if (Date.now() > until) throw new Error("a run is still going");
    await Bun.sleep(20);
  }
});

async function waitFor<T>(read: () => T, check: (value: T) => boolean, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = read();
    if (check(value)) return value;
    if (Date.now() > until) throw new Error(`timed out: ${JSON.stringify(value)}`);
    await Bun.sleep(20);
  }
}

describe("generation adds parameters when the doc names a window and a dimension", () => {
  test("the prompt teaches typed placeholders; the plan, run_sql, and the saved spec carry the parameters; validation runs the defaults and one other set", async () => {
    provider.setScript(generateScript);
    provider.calls.length = 0;
    fake.requests.length = 0;
    const started = await send(owner, "POST", "/reports/generate", { docRef: doc, serverId: "nook", datasourceId });
    expect(started.status).toBe(202);
    const reportId = started.body.report.id as string;
    const run = await waitFor(() => db.query("SELECT status, error, plan_json FROM report_runs WHERE report_id = ? AND kind = 'generate'").get(reportId) as Json, (row) => row.status !== "running");
    expect(run).toMatchObject({ status: "succeeded", error: null });
    expect(JSON.parse(run.plan_json).parameters).toEqual([{ id: "period", type: "date_range", label: "Period" }, { id: "routes", type: "multi_select", label: "Route" }]);
    const system = String(provider.calls[0]!.messages![0]!.content);
    expect(system).toContain("## Parameters: the report's date range and filters");
    expect(system).toContain("(empty({routes:Array(String)}) OR route IN {routes:Array(String)})");
    expect(system).not.toContain("no `{}` parameters");
    const spec = upgradeSpec(JSON.parse((db.query("SELECT spec_json FROM reports WHERE id = ?").get(reportId) as { spec_json: string }).spec_json));
    expect(spec.specVersion).toBe(3);
    expect(spec.parameters.map((param) => [param.id, param.type, param.chType])).toEqual([["period", "date_range", "Date"], ["routes", "multi_select", "Array(String)"]]);
    // run_sql bound the defaults; validation ran the defaults and once more with 7 days and the first route.
    const today = new Date().toISOString().slice(0, 10);
    const runs = fake.requests.filter((req) => req.sql.startsWith("SELECT * FROM (") && req.sql.includes("GROUP BY route"));
    expect(runs.map((req) => [req.params.param_period_from, req.params.param_routes])).toEqual(expect.arrayContaining([
      [resolveDateRange({ preset: "30d" }, today).from, "[]"], [resolveDateRange({ preset: "7d" }, today).from, "['/api/orders']"]
    ]));
    expect(runs.every((req) => !req.sql.includes(today))).toBe(true);
    // The saved first result is the default set's, with its bound values.
    const view = refresh.reportResults(reportId, owner.userId);
    expect(view.results[0]!.result!.rows).toEqual(ROUTES.map((route) => [route, "3000"]));
    expect(view.results[0]!.result!.params).toMatchObject({ period_from: resolveDateRange({ preset: "30d" }, today).from, routes: "[]" });
    // A reader's other set: 7 days on one route.
    const set = await send(owner, "POST", `/reports/${reportId}/param-runs`, { values: { period: { preset: "7d" }, routes: ["/login"] } });
    expect(set.body.results[0].result.rows).toEqual([["/login", "700"]]);
  });

  test("a submit whose SQL reads an undeclared placeholder is refused with a line the model can act on", async () => {
    let submits = 0;
    provider.setScript(unplanned((context) => {
      const done = called(context);
      if (!done.includes("plan_report")) return { toolCalls: [{ name: "plan_report", arguments: { goal: "Requests", todos: [{ id: "t", title: "Requests", kind: "markdown" }] } }] };
      if (!done.includes("update_todo")) return { toolCalls: [{ name: "update_todo", arguments: { id: "t", status: "done" } }] };
      submits += 1;
      const sql = submits === 1 ? "SELECT route, count() AS requests FROM analytics.requests WHERE ts >= {since:Date} GROUP BY route" : BY_ROUTE_SQL;
      return { toolCalls: [{ name: "submit_report", arguments: { title: "Requests", parameters: submits === 1 ? [] : [PERIOD, ROUTE], queries: [{ key: "by_route", sql, purpose: "p" }], blocks: [{ id: "b", type: "chart", title: "Requests", intent: "rank", kind: "horizontal_bar", queryKey: "by_route", x: "route", y: ["requests"], unit: "requests" }] } }] };
    }));
    provider.calls.length = 0;
    const started = await send(owner, "POST", "/reports/generate", { docRef: doc, serverId: "nook", datasourceId });
    const reportId = started.body.report.id as string;
    await waitFor(() => (db.query("SELECT status FROM report_runs WHERE report_id = ? AND kind = 'generate'").get(reportId) as Json).status, (status) => status !== "running");
    const refusal = provider.calls.flatMap((body) => body.messages ?? []).filter((turn) => turn.role === "tool").map((turn) => String(turn.content)).find((text) => text.includes("not saved"));
    expect(refusal).toContain("{since:Date} is not a declared parameter");
    expect(submits).toBe(2);
    expect((db.query("SELECT status FROM report_runs WHERE report_id = ? AND kind = 'generate'").get(reportId) as Json).status).toBe("succeeded");
  });
});

describe("the edit agent adds a route filter (patch ops)", () => {
  test("add_parameter plus update_query: proposed, applied as a version whose diff names the filter; results bound", async () => {
    const report = await send(owner, "POST", "/reports", { title: "Orders", datasourceId });
    const reportId = report.body.report.id as string;
    db.query("UPDATE reports SET spec_json = ?, status = 'ready' WHERE id = ?").run(JSON.stringify(sampleSpec()), reportId);
    fake.state.select = (sql, req) => sql.includes("DISTINCT country") ? { meta: [{ name: "country", type: "String" }], data: [["DE"], ["US"]] } : answer(sql, req);
    await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
    const original = sampleSpec().queries.find((query) => query.key === "by_country")!.sql;
    const filtered = original.replace("GROUP BY country", "WHERE (empty({country:Array(String)}) OR country IN {country:Array(String)}) GROUP BY country");
    const ops: PatchOp[] = [
      { op: "add_parameter", parameter: { id: "country", label: "Country", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: "SELECT DISTINCT country FROM analytics.orders ORDER BY country" } },
      { op: "update_query", key: "by_country", sql: filtered }
    ];
    provider.setScript(() => ({ toolCalls: [{ name: "submit_patch", arguments: { summary: "Add a country filter", ops } }] }));
    provider.calls.length = 0;
    const created = await send(owner, "POST", `/reports/${reportId}/instructions`, { text: "add a country filter" });
    const id = created.body.instruction.id as string;
    await waitFor(() => (db.query("SELECT status FROM report_instructions WHERE id = ?").get(id) as Json).status, (status) => ["proposed", "failed"].includes(status));
    const system = String(provider.calls[0]!.messages![0]!.content);
    expect(system).toContain("\"Add a route filter\" is add_parameter");
    const proposal = await send(owner, "GET", `/reports/${reportId}/instructions/${id}/proposal`);
    expect(proposal.status).toBe(200);
    expect(proposal.body.proposal.queries.map((item: Json) => [item.key, item.change])).toEqual([["by_country", "updated"]]);
    const applied = await send(owner, "POST", `/reports/${reportId}/instructions/${id}/apply`, {});
    expect(applied.status).toBe(200);
    const saved = upgradeSpec(JSON.parse((db.query("SELECT spec_json FROM reports WHERE id = ?").get(reportId) as { spec_json: string }).spec_json));
    expect(saved.parameters.map((param) => param.id)).toEqual(["country"]);
    const versions = await send(owner, "GET", `/reports/${reportId}/versions`);
    const latest = versions.body.versions[0];
    const diff = await send(owner, "GET", `/reports/${reportId}/version-diff?to=${latest.version}`);
    expect(diff.body.diff.parameters).toEqual([expect.objectContaining({ id: "country", change: "added", label: "Country" })]);
    expect(diff.body.diff.summary).toContain("1 filter added");
    const results = refresh.reportResults(reportId, owner.userId).results.find((item) => item.queryKey === "by_country")!;
    expect(results.result!.params).toEqual({ country: "[]" });
  });

  test("the ops: add, update, and remove a parameter; errors name the op; a changed default marks the queries that read it", () => {
    const base = { ...upgradeSpec(sampleSpec()), parameters: [] };
    const parsed = parsePatch({ ops: [{ op: "add_parameter", parameter: PERIOD }, { op: "update_parameter", id: "period", set: { label: "Window", default: { preset: "7d" } } }] });
    expect(parsed.ok).toBe(true);
    const applied = applyPatch(base, (parsed as { ok: true; patch: never }).patch, "agent");
    expect(applied.ok && applied.spec.parameters).toEqual([{ ...PERIOD, label: "Window", default: { preset: "7d" } }]);
    const twice = applyPatch(base, { ops: [{ op: "add_parameter", parameter: PERIOD }, { op: "add_parameter", parameter: PERIOD }] } as never, "agent");
    expect(twice).toEqual({ ok: false, errors: ["op 2 (add_parameter): a parameter with id period already exists; use update_parameter"] });
    expect(applyPatch(base, { ops: [{ op: "remove_parameter", id: "nope" }] }, "agent")).toEqual({ ok: false, errors: ["op 1 (remove_parameter): no parameter with id nope"] });
    // A default that changes re-runs the queries reading it (they show as updated, same SQL).
    const withParam = { ...base, parameters: [PERIOD as never], queries: [...base.queries, { key: "windowed", sql: "SELECT count() AS n FROM analytics.orders WHERE day >= {period_from:Date}", purpose: "", createdBy: "agent" as const }] };
    const changed = applyPatch(withParam, { ops: [{ op: "update_parameter", id: "period", set: { default: { preset: "90d" } } }] }, "agent");
    expect(changed.ok && diffSpecs(withParam, changed.spec).queries).toEqual([{ key: "windowed", change: "updated", before: withParam.queries.at(-1)!.sql, after: withParam.queries.at(-1)!.sql }]);
  });
});

void qaEditScript;
