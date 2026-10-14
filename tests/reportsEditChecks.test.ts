import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse, type FakeAnswer } from "./support/fakeClickhouse";
import { sampleAnswer, sampleSpec } from "./support/reportSeed";
import { retireUsersAfterFile } from "./support/retireUsers";
import { qaEditScript, startScriptedProvider, unplanned, type Script, type ScriptContext } from "../scripts/fakeReportProvider";
import { DEFAULT_COMPAT } from "../shared/agents";
import type { CatalogMetric } from "../shared/reportsMetrics";

const { editDeps, liveEdits } = await import("../server/reports/edit");
const refresh = await import("../server/reports/refresh");
const { syncSchema } = await import("../server/reports/schemaCatalog");
const { saveCatalog } = await import("../server/reports/metricCatalog");

/**
 * E6: the edit agent and manual edits get lane E's checks. The result sanity checks run on what an
 * edit touched and refuse a patch once (not a try); a todo for a catalog metric must use its
 * definition; the edit agent falls back once to the "Fallback model for reports", and the blocks it
 * changes record the model that wrote them; Runs lists every model a run used, in order. A manual edit
 * is saved with the checks' hints as warnings.
 */

retireUsersAfterFile();
setDefaultTimeout(30_000);

const fake = startFakeClickhouse(0);
const primary = startScriptedProvider(0, qaEditScript);
const backup = startScriptedProvider(0, qaEditScript);
const original = { connection: editDeps.connection, fallback: editDeps.fallback };
editDeps.connection = () => ({ id: "scripted-primary", baseUrl: primary.baseUrl, apiKey: null, model: "primary-model", compat: DEFAULT_COMPAT });
editDeps.fallback = () => null;

const PERCENT_SQL = "SELECT avg(amount > 0) * 100 AS paid_share FROM analytics.orders";
const NET_SQL = "SELECT sum(amount) AS net_revenue FROM analytics.orders";

function answer(sql: string): FakeAnswer {
  if (sql.includes("paid_share")) return { meta: [{ name: "paid_share", type: "Float64" }], data: [[87.5]] };
  if (sql.includes("net_revenue")) return { meta: [{ name: "net_revenue", type: "Float64" }], data: [[9331.75]] };
  if (sql.includes("zero_orders")) return { meta: ["revenue", "revenue_prev", "orders", "zero_orders"].map((name) => ({ name, type: "UInt64" })), data: [["0", "0", "0", "0"]] };
  return sampleAnswer(sql);
}

afterAll(() => {
  editDeps.connection = original.connection;
  editDeps.fallback = original.fallback;
  fake.stop();
  primary.stop();
  backup.stop();
});
beforeEach(() => {
  fake.state.select = (sql) => answer(sql);
  editDeps.fallback = () => null;
});
afterEach(async () => {
  const until = Date.now() + 15_000;
  while (liveEdits().length) {
    if (Date.now() > until) throw new Error("an edit is still running");
    await Bun.sleep(20);
  }
});

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const admin = await createUser("Checks admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const owner = await createUser("Checks owner");
fake.state.tables = [{ db: "analytics", name: "orders", engine: "MergeTree", sorting_key: "order_id", columns: [{ name: "order_id", type: "UInt64" }, { name: "amount", type: "Decimal(12, 2)" }, { name: "country", type: "String" }] }];
const created = await send(admin, "POST", "/reports/admin/datasources", { name: `Checks ${crypto.randomUUID().slice(0, 6)}`, url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
const datasourceId = created.body.datasource.id as string;
await syncSchema(datasourceId).catch(() => undefined);

async function seededReport() {
  const report = await send(owner, "POST", "/reports", { title: "Checks", datasourceId });
  const id = report.body.report.id as string;
  db.query("UPDATE reports SET spec_json = ?, status = 'ready' WHERE id = ?").run(JSON.stringify(sampleSpec()), id);
  await refresh.startRefresh(owner.userId, id, { trigger: "user" }).done;
  return id;
}
async function waitStatus(id: string, statuses: string[]) {
  const until = Date.now() + 15_000;
  for (;;) {
    const row = db.query("SELECT status, error, agent_run_id FROM report_instructions WHERE id = ?").get(id) as { status: string; error: string | null; agent_run_id: string };
    if (statuses.includes(row.status)) return row;
    if (Date.now() > until) throw new Error(`timed out: ${JSON.stringify(row)}`);
    await Bun.sleep(20);
  }
}
const toolResults = (agentRunId: string, tool: string) => (db.query("SELECT ok, result_text FROM agent_audit_steps WHERE run_id = ? AND tool_name = ? ORDER BY seq").all(agentRunId, tool) as Array<{ ok: number; result_text: string }>);
const submits = (context: ScriptContext) => context.body.messages?.filter((turn) => turn.role === "assistant" && turn.tool_calls?.some((call) => call.function?.name === "submit_patch")).length ?? 0;

/** Plans one KPI todo (optionally for a catalog metric), runs its query with a key, closes it, and submits the patch. */
function kpiScript(sql: string, column: string, options: { format?: string; metricId?: string } = {}): Script {
  const called = (context: ScriptContext) => (context.body.messages ?? []).flatMap((turn) => turn.role === "assistant" ? (turn.tool_calls ?? []).map((call) => call.function?.name ?? "") : []);
  const patch = { summary: "Add a KPI", ops: [{ op: "add_query", query: { key: "added", sql, purpose: "The new KPI" } }, { op: "add_block", after: null, block: { id: "added_kpi", type: "kpi", title: "Added", intent: "headline", queryKey: "added", column, format: options.format ?? "number" } }] };
  return unplanned((context) => {
    const done = called(context);
    if (!done.includes("plan_change")) return { toolCalls: [{ name: "plan_change", arguments: { goal: "Add the KPI", todos: [{ id: "kpi", title: "Added", kind: "kpi", ...(options.metricId ? { metricId: options.metricId } : {}) }] } }] };
    if (!done.includes("run_sql")) return { toolCalls: [{ name: "run_sql", arguments: { sql, purpose: "Check it", key: "added" } }] };
    if (!done.includes("update_todo")) return { toolCalls: [{ name: "update_todo", arguments: { id: "kpi", status: "done", queryKey: "added", blockId: "added_kpi" } }] };
    return { toolCalls: [{ name: "submit_patch", arguments: patch }] };
  });
}

describe("lane E's checks on edits", () => {
  test("the sanity checks refuse a patch once on what it touched (not a try), then the same patch is proposed", async () => {
    const reportId = await seededReport();
    primary.setScript(kpiScript(PERCENT_SQL, "paid_share", { format: "percent" }));
    const posted = await send(owner, "POST", `/reports/${reportId}/instructions`, { text: "add the paid share" });
    const row = await waitStatus(posted.body.instruction.id, ["proposed", "failed"]);
    expect(row.status).toBe("proposed");
    const results = toolResults(row.agent_run_id, "submit_patch");
    expect(results.map((item) => item.ok)).toEqual([0, 1]);
    expect(results[0]!.result_text).toContain("sanity units: KPI added_kpi (paid_share) has format percent");
    // Only what the patch touched: the seeded blocks are not checked.
    expect(results[0]!.result_text).not.toContain("kpi-revenue");
    expect(db.query("SELECT count(*) AS n FROM audit_log WHERE event_type = 'reports.instruction.sanity' AND metadata_json LIKE ?").get(`%${posted.body.instruction.id}%`)).toEqual({ n: 2 });
  });

  test("a todo for a catalog metric must use the metric's expression and filters", async () => {
    const reportId = await seededReport();
    const metric: CatalogMetric = { id: "net_revenue", name: "Net revenue", definition: "", expression: "sum(amount)", table: "analytics.orders", filters: ["amount > 0"], final: false, grain: null, unit: null, timeColumn: null, excerpt: null, problems: [] };
    saveCatalog(reportId, { snapshotId: null, docSha256: "a".repeat(64), source: "extract", metrics: [metric], runId: null, userId: owner.userId });
    primary.setScript(kpiScript(NET_SQL, "net_revenue", { metricId: "net_revenue" }));
    const posted = await send(owner, "POST", `/reports/${reportId}/instructions`, { text: "add net revenue" });
    const row = await waitStatus(posted.body.instruction.id, ["proposed", "failed"]);
    const results = toolResults(row.agent_run_id, "submit_patch");
    expect(results[0]!.result_text).toContain("sanity metric: todo kpi is the catalog metric net_revenue (Net revenue), but query added lacks the filter amount > 0.");
    // The edit's prompt carried the catalog.
    expect(String(primary.calls.at(-1)?.messages?.[0]?.content ?? "")).toContain("- net_revenue — Net revenue: `sum(amount)` FROM analytics.orders WHERE (amount > 0)");
  });

  test("the fallback takes over once; applied blocks record its model; Runs lists both models in order", async () => {
    const reportId = await seededReport();
    // The primary's patch names a block that does not exist: three refusals.
    primary.setScript(() => ({ toolCalls: [{ name: "submit_patch", arguments: { summary: "Broken", ops: [{ op: "update_block", id: "no-such-block", set: { title: "x" } }] } }] }));
    backup.setScript(kpiScript(NET_SQL, "net_revenue"));
    editDeps.fallback = () => ({ id: "scripted-backup", baseUrl: backup.baseUrl, apiKey: null, model: "fallback-model", compat: DEFAULT_COMPAT });
    const posted = await send(owner, "POST", `/reports/${reportId}/instructions`, { text: "add net revenue" });
    const id = posted.body.instruction.id as string;
    const row = await waitStatus(id, ["proposed", "failed"]);
    expect(row).toMatchObject({ status: "proposed" });
    const note = db.query("SELECT text FROM agent_audit_steps WHERE run_id = ? AND text LIKE '[Nook retried on the fallback model%'").get(row.agent_run_id) as { text: string };
    expect(note.text).toStartWith("[Nook retried on the fallback model fallback-model: primary-model ended without a proposal");
    expect((await send(owner, "POST", `/reports/${reportId}/instructions/${id}/apply`, {})).status).toBe(200);
    const spec = JSON.parse((db.query("SELECT spec_json FROM reports WHERE id = ?").get(reportId) as { spec_json: string }).spec_json) as Json;
    expect(spec.blocks.find((block: Json) => block.id === "added_kpi").provenance.model).toBe("fallback-model");
    expect(spec.blocks.find((block: Json) => block.id === "kpi-revenue").provenance.model).toBeUndefined();
    const runs = (await send(owner, "GET", `/reports/${reportId}/run-history`)).body.runs as Json[];
    const edit = runs.find((run) => run.agentRunId === row.agent_run_id)!;
    expect(edit).toMatchObject({ model: "fallback-model", models: ["primary-model", "fallback-model"] });
  });

  test("a manual edit that changes SQL is saved with the checks' hints as warnings (its touched blocks only)", async () => {
    const reportId = await seededReport();
    const revision = (db.query("SELECT revision FROM reports WHERE id = ?").get(reportId) as { revision: number }).revision;
    const edited = await send(owner, "POST", `/reports/${reportId}/spec/edit`, { ops: [{ op: "update_query", key: "totals", sql: "SELECT 0 AS revenue, 0 AS revenue_prev, 0 AS orders, 0 AS zero_orders FROM analytics.orders" }], expectedRevision: revision });
    expect({ status: edited.status, body: edited.status === 200 ? null : edited.body }).toEqual({ status: 200, body: null });
    expect(edited.body.warnings).toEqual([
      "sanity units: KPI kpi-revenue (revenue) is 0 in every row; a filter may match nothing, a join may not match, or the column may be the wrong one. Check with run_sql before keeping it.",
      "sanity units: KPI kpi-orders (orders) is 0 in every row; a filter may match nothing, a join may not match, or the column may be the wrong one. Check with run_sql before keeping it."
    ]);
  });
});
