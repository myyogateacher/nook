import type { Database } from "bun:sqlite";
import type { ProviderConnection } from "../../server/agents/loop";
import type { ScriptedProvider } from "../../scripts/fakeReportProvider";
import { parseChUrl } from "./clickhouse";
import { linkDoc } from "./load";
import { scoreFacts, type ScoredResult } from "./score";
import { specScript } from "./script";
import type { CaseResult, LoadedCase } from "./types";

/**
 * One eval run of a case through Nook's real generation path: the doc (and its linked page) become
 * published notes of the eval user, a data source reads the case's `eval_<id>` database, and
 * `POST /api/reports/generate` (doc source `nook`) runs the report agent with the chosen provider.
 * Afterwards the persisted spec and first results are scored, and the run's cost is read from its
 * agent run, its audit entries, and its steps (what the Runs view shows).
 */

type Json = Record<string, any>;
export type EvalHost = {
  origin: string;
  db: Database;
  /** A request as the eval user (an admin). */
  send: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Json }>;
};

export type RunOptions = {
  variant: "model" | "golden" | "trap";
  /** The data source URL, user and password included (http://user:password@host:port). */
  clickhouse: string;
  /** The provider for this run: a real one, or the scripted provider (golden and trap runs). */
  connection: ProviderConnection;
  scripted?: ScriptedProvider | null;
  timeoutMs?: number;
  /** Data sources already made for a case (one per case and ClickHouse URL). */
  datasources?: Map<string, string>;
};

async function note(host: EvalHost, markdown: string): Promise<string> {
  const created = await host.send("POST", "/notes", { folderId: null });
  if (created.status !== 201 && created.status !== 200) throw new Error(`Could not create a note (${created.status})`);
  const id = created.body.note.id as string;
  const draft = await host.send("PUT", `/notes/${id}/draft`, { markdown, revision: 1 });
  if (draft.status !== 200) throw new Error(`Could not write the note (${draft.status})`);
  const published = await host.send("POST", `/notes/${id}/publish`);
  if (published.status !== 200) throw new Error(`Could not publish the note (${published.status})`);
  return id;
}

async function datasourceFor(host: EvalHost, testCase: LoadedCase, clickhouse: string, made: Map<string, string>): Promise<string> {
  const key = `${testCase.id} ${clickhouse}`;
  const existing = made.get(key);
  if (existing) return existing;
  const ch = parseChUrl(clickhouse);
  const created = await host.send("POST", "/reports/admin/datasources", {
    name: `Eval ${testCase.id} ${crypto.randomUUID().slice(0, 6)}`, url: ch.base, username: ch.user, password: ch.password || null,
    database: `eval_${testCase.id}`, allowlist: [`eval_${testCase.id}`]
  });
  if (created.status !== 201) throw new Error(`Could not add the data source (${created.status}: ${created.body.error ?? ""})`);
  const id = created.body.datasource.id as string;
  const { syncSchema } = await import("../../server/reports/schemaCatalog");
  const synced = await syncSchema(id);
  if (!synced.tables) throw new Error(`The schema sync found no tables in eval_${testCase.id}; was it seeded?`);
  made.set(key, id);
  return id;
}

async function waitForRun(db: Database, runId: string, timeoutMs: number) {
  const { liveGenerations } = await import("../../server/reports/generate");
  const until = Date.now() + timeoutMs;
  for (;;) {
    const row = db.query("SELECT status, error FROM report_runs WHERE id = ?").get(runId) as { status: string; error: string | null } | null;
    if (row && row.status !== "running" && !liveGenerations().some((item) => item.runId === runId)) return row;
    if (Date.now() > until) {
      const { cancelGenerate } = await import("../../server/reports/generate");
      const report = db.query("SELECT report_id, created_by FROM report_runs WHERE id = ?").get(runId) as { report_id: string; created_by: string };
      cancelGenerate(report.created_by, report.report_id);
      throw new Error(`The run did not finish in ${Math.round(timeoutMs / 1000)} s`);
    }
    await Bun.sleep(100);
  }
}

const blank = (testCase: LoadedCase, variant: RunOptions["variant"]): CaseResult => ({
  id: testCase.id, variant, ok: false, error: null, reportId: null, runId: null, agentRunId: null, runStatus: null, facts: [], passed: 0,
  firstSubmitPass: null, submits: 0, retries: 0, nudges: 0, sanityHints: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, wallMs: 0, model: null
});

export async function runCase(host: EvalHost, testCase: LoadedCase, options: RunOptions): Promise<CaseResult> {
  const out = blank(testCase, options.variant);
  const started = Date.now();
  const { generateDeps } = await import("../../server/reports/generate");
  const previous = generateDeps.connection;
  try {
    if (options.variant !== "model") {
      const spec = options.variant === "trap" ? testCase.trap?.spec : testCase.golden;
      if (!spec || !options.scripted) throw new Error(`No ${options.variant} spec or scripted provider for ${testCase.id}`);
      options.scripted.setScript(specScript(spec));
    }
    generateDeps.connection = () => options.connection;
    const links: Record<string, string> = {};
    for (const [name, markdown] of Object.entries(testCase.linked)) links[name] = `${host.origin}/notes/${await note(host, markdown)}`;
    const docId = await note(host, linkDoc(testCase.doc, links));
    const datasourceId = await datasourceFor(host, testCase, options.clickhouse, options.datasources ?? new Map());
    const started202 = await host.send("POST", "/reports/generate", { docRef: `${host.origin}/notes/${docId}`, serverId: "nook", datasourceId, ...(testCase.browseTools ? { browseTools: testCase.browseTools } : {}) });
    if (started202.status !== 202) throw new Error(`Generate answered ${started202.status}: ${started202.body.error ?? ""}`);
    out.reportId = started202.body.report.id;
    out.runId = started202.body.run.id;
    out.agentRunId = started202.body.run.agentRunId;
    const finished = await waitForRun(host.db, out.runId!, options.timeoutMs ?? 10 * 60_000);
    out.runStatus = finished.status;
    if (finished.status !== "succeeded") out.error = finished.error ?? finished.status;
    collect(host.db, out);
    if (finished.status === "succeeded") {
      const spec = JSON.parse((host.db.query("SELECT spec_json FROM reports WHERE id = ?").get(out.reportId) as { spec_json: string }).spec_json) as { blocks: Json[] };
      const results = (host.db.query("SELECT query_key, columns_json, rows_json FROM report_results WHERE run_id = ?").all(out.runId) as Array<{ query_key: string; columns_json: string; rows_json: string }>)
        .map((row): ScoredResult => ({ queryKey: row.query_key, columns: JSON.parse(row.columns_json), rows: JSON.parse(row.rows_json) }));
      out.facts = scoreFacts(testCase.facts, spec.blocks, results);
    } else {
      out.facts = testCase.facts.map((fact) => ({ id: fact.id, label: fact.label, expected: String(fact.value), pass: false, found: null }));
    }
    out.passed = out.facts.filter((fact) => fact.pass).length;
    out.ok = out.runStatus === "succeeded" && out.passed === out.facts.length;
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error);
    out.facts = out.facts.length ? out.facts : testCase.facts.map((fact) => ({ id: fact.id, label: fact.label, expected: String(fact.value), pass: false, found: null }));
  } finally {
    generateDeps.connection = previous;
    out.wallMs = Date.now() - started;
  }
  return out;
}

/** The run's cost and retries: its agent run, its submit audit entries, and Nook's nudge note. */
function collect(db: Database, out: CaseResult) {
  const agent = db.query("SELECT model, tool_calls, prompt_tokens, completion_tokens FROM agent_runs WHERE id = ?").get(out.agentRunId) as { model: string; tool_calls: number; prompt_tokens: number; completion_tokens: number } | null;
  if (agent) Object.assign(out, { model: agent.model, toolCalls: agent.tool_calls, promptTokens: agent.prompt_tokens, completionTokens: agent.completion_tokens });
  const submits = (db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'reports.generate.submit' AND metadata_json LIKE ? ORDER BY created_at, rowid").all(`%"runId":"${out.runId}"%`) as Array<{ metadata_json: string }>)
    .map((row) => JSON.parse(row.metadata_json) as { ok: boolean; attempt: number });
  out.submits = submits.length;
  out.retries = Math.max(0, submits.length - 1);
  out.firstSubmitPass = submits.length ? submits[0]!.ok : false;
  const nudge = db.query("SELECT text FROM agent_audit_steps WHERE run_id = ? AND kind = 'model' AND text LIKE '[Nook nudged%'").get(out.agentRunId) as { text: string } | null;
  out.nudges = nudge ? Number(/(\d+) time/.exec(nudge.text)?.[1] ?? 0) : 0;
  const refusals = db.query("SELECT result_text FROM agent_audit_steps WHERE run_id = ? AND kind = 'tool' AND tool_name = 'submit_report' AND ok = 0").all(out.agentRunId) as Array<{ result_text: string | null }>;
  out.sanityHints = refusals.reduce((sum, row) => sum + ((row.result_text ?? "").match(/\bsanity [a-z_]+:/g)?.length ?? 0), 0);
}
