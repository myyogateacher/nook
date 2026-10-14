import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse } from "./support/fakeClickhouse";
import { sampleAnswer, sampleSpec } from "./support/reportSeed";

const { syncSchema } = await import("../server/reports/schemaCatalog");
const refresh = await import("../server/reports/refresh");
const { insertAuditStep } = await import("../server/agents/audit");

/**
 * The Runs panel (GET /api/reports/:id/run-history, …/:runId): owner only; each run with who started
 * it, its model and tokens; a generation's step log from the agent audit (tool calls with their SQL and
 * errors, recovered calls, Nook's nudges) and the doc it read; a refresh's per-query outcome.
 */

const fake = startFakeClickhouse(0);
afterAll(() => fake.stop());
beforeEach(() => {
  fake.reset();
  fake.state.select = (sql) => sampleAnswer(sql);
});

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const admin = await createUser("Runs admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const owner = await createUser("Runs owner");
const reader = await createUser("Runs reader");
const commenter = await createUser("Runs commenter");
const created = await send(admin, "POST", "/reports/admin/datasources", { name: "Runs warehouse", url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
const datasourceId = created.body.datasource.id as string;
await syncSchema(datasourceId).catch(() => undefined);

async function seededReport() {
  const report = await send(owner, "POST", "/reports", { title: "Run history", datasourceId });
  const id = report.body.report.id as string;
  db.query("UPDATE reports SET spec_json = ? WHERE id = ?").run(JSON.stringify(sampleSpec()), id);
  return id;
}

/** A finished generate run with an agent audit timeline, as generate.ts writes it. */
function seedGenerateRun(reportId: string) {
  const runId = crypto.randomUUID();
  const agentRunId = crypto.randomUUID();
  const at = new Date(Date.now() - 60_000).toISOString();
  const end = new Date(Date.now() - 48_000).toISOString();
  const snapshotId = crypto.randomUUID();
  db.query("INSERT INTO report_doc_snapshots (id, report_id, sha256, title, markdown, fetched_at) VALUES (?, ?, ?, ?, ?, ?)").run(snapshotId, reportId, "a".repeat(64), "Revenue metrics", "# Revenue metrics\nNet of refunds.", at);
  db.query(`INSERT INTO agent_runs (id, via, agent_id, agent_revision, prompt_sha256, preamble_version, chat_id, user_id, key_id, provider_id, model, status, client_address, label, queued_at, purge_after, prompt_tokens, completion_tokens, tool_calls, finished_at)
    VALUES (?, 'reports', 'reports', 1, ?, 1, NULL, ?, NULL, NULL, 'scripted-model', 'ok', NULL, 'Run history', ?, ?, 1200, 300, 3, ?)`).run(agentRunId, "b".repeat(64), owner.userId, at, new Date(Date.now() + 86_400_000).toISOString(), end);
  db.query(`INSERT INTO report_runs (id, report_id, kind, trigger, agent_run_id, status, doc_snapshot_id, created_by, started_at, finished_at) VALUES (?, ?, 'generate', 'user', ?, 'succeeded', ?, ?, ?, ?)`)
    .run(runId, reportId, agentRunId, snapshotId, owner.userId, at, end);
  const usage = { promptTokens: 600, completionTokens: 100, estimated: false };
  insertAuditStep(agentRunId, 1, { kind: "model", text: "Looking at the orders table.", toolCalls: [{ name: "run_sql", arguments: "{}" }], usage, durationMs: 900 });
  insertAuditStep(agentRunId, 2, { kind: "tool", serverId: null, tool: "run_sql", args: JSON.stringify({ sql: "SELECT * FROM secret.salaries" }), result: JSON.stringify({ error: "not on the allowlist", code: "GUARD", guard: "NOT_ALLOWED_TABLE" }), ok: false, durationMs: 12 });
  insertAuditStep(agentRunId, 3, { kind: "model", text: "[Nook nudged the model back to submit_report 1 time]", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, estimated: false }, durationMs: 0 });
  insertAuditStep(agentRunId, 4, { kind: "tool", serverId: null, tool: "submit_report", args: `[recovered from text] {"blocks":[]}`, result: "saved", ok: true, durationMs: 40 });
  return { runId, agentRunId };
}

describe("the Runs panel", () => {
  test("lists every run newest first with who started it, the model, tokens, and duration", async () => {
    const reportId = await seededReport();
    const { runId } = seedGenerateRun(reportId);
    const run = await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
    const list = await send(owner, "GET", `/reports/${reportId}/run-history`);
    expect(list.status).toBe(200);
    expect(list.body.runs.map((item: Json) => item.id)).toEqual([run.id, runId]);
    const generate = list.body.runs[1];
    expect(generate).toMatchObject({ kind: "generate", trigger: "user", status: "succeeded", model: "scripted-model", promptTokens: 1200, completionTokens: 300, toolCalls: 3, durationMs: 12_000, startedBy: { id: owner.userId, name: "Runs owner" } });
    expect(list.body.runs[0]).toMatchObject({ kind: "refresh", promptTokens: null, model: null });
  });

  test("a generation's log: the doc read, each tool call with its SQL and guard error, nudges, and recovered calls", async () => {
    const reportId = await seededReport();
    const { runId } = seedGenerateRun(reportId);
    const log = await send(owner, "GET", `/reports/${reportId}/run-history/${runId}`);
    expect(log.status).toBe(200);
    expect(log.body.doc).toMatchObject({ title: "Revenue metrics", sha256: "a".repeat(64) });
    const steps = log.body.steps as Json[];
    expect(steps.map((step) => step.kind)).toEqual(["model", "tool", "model", "tool"]);
    expect(steps[0]).toMatchObject({ text: "Looking at the orders table.", toolNames: ["run_sql"] });
    expect(steps[1]).toMatchObject({ tool: "run_sql", ok: false, durationMs: 12, recovered: false });
    expect(JSON.parse(steps[1]!.args).sql).toBe("SELECT * FROM secret.salaries");
    expect(steps[1]!.result).toContain("NOT_ALLOWED_TABLE");
    expect(steps[2]!.text).toContain("nudged");
    expect(steps[3]).toMatchObject({ tool: "submit_report", recovered: true, args: `{"blocks":[]}` });
    expect(log.body.queries).toEqual([]);
  });

  test("a refresh's log lists each query's time, rows, and error; there are no steps", async () => {
    const reportId = await seededReport();
    const run = await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
    const log = await send(owner, "GET", `/reports/${reportId}/run-history/${run.id}`);
    expect(log.body.steps).toBeNull();
    expect(log.body.queries.map((item: Json) => item.key).sort()).toEqual(["by_country", "daily", "recent", "totals"]);
    const daily = log.body.queries.find((item: Json) => item.key === "daily");
    expect(daily).toMatchObject({ rows: 14, errorCode: null, rowsRead: 120000 });
    expect(daily.sql).toContain("LIMIT 10001");
  });

  test("the audit retention purges the steps, not the run", async () => {
    const reportId = await seededReport();
    const { runId, agentRunId } = seedGenerateRun(reportId);
    db.query("DELETE FROM agent_runs WHERE id = ?").run(agentRunId);
    const log = await send(owner, "GET", `/reports/${reportId}/run-history/${runId}`);
    expect(log.status).toBe(200);
    expect(log.body.steps).toBeNull();
    expect(log.body.run).toMatchObject({ id: runId, kind: "generate", model: null });
  });

  test("owner only: a viewer, a commenter, and a stranger get 404", async () => {
    const reportId = await seededReport();
    const { runId } = seedGenerateRun(reportId);
    expect((await send(owner, "PUT", `/reports/${reportId}/sharing`, { visibility: "selected", shares: [{ kind: "user", id: reader.userId, level: "view" }, { kind: "user", id: commenter.userId, level: "comment" }] })).status).toBe(200);
    for (const who of [reader, commenter, admin]) {
      expect((await send(who, "GET", `/reports/${reportId}/run-history`)).status).toBe(404);
      expect((await send(who, "GET", `/reports/${reportId}/run-history/${runId}`)).status).toBe(404);
    }
    expect((await send(owner, "GET", `/reports/${reportId}/run-history/${crypto.randomUUID()}`)).status).toBe(404);
  });
});
