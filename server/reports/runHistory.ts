import { db } from "../db";
import { REPORT_LIMITS, type ReportRunHistoryItem, type ReportRunLog, type ReportRunStep } from "../../shared/reports";
import { ownedReport } from "./access";
import { ReportError } from "./errors";
import { abandonExpiredReportRuns, runView, type RunRow } from "./refresh";
import { storedPlan } from "./planner";

/**
 * The report's run history (the "Runs" panel): the owner's view of every run Nook keeps, each with
 * its step log. Owner only (D455): readers and commenters get the same 404 as a missing report; a
 * commenter follows their own instruction's status in Changes (D459), never here.
 *
 * Retention: report runs keep the last REPORT_LIMITS.runsKept per report (plus pinned ones,
 * `pruneRuns`); a run's steps live in the agent audit (`agent_audit_steps`), purged after the audit
 * retention, after which the run shows without its steps.
 */

type HistoryRow = RunRow & {
  plan_json?: string | null;
  author_name: string | null; model: string | null; provider_name: string | null; prompt_tokens: number | null; completion_tokens: number | null;
  tokens_estimated: number | null; cost_micros: number | null; tool_calls: number | null; instruction: string | null;
};

const SELECT = `SELECT rr.*, u.display_name AS author_name, ar.model, p.name AS provider_name, ar.prompt_tokens, ar.completion_tokens, ar.tokens_estimated, ar.cost_micros, ar.tool_calls,
  (SELECT i.text FROM report_instructions i WHERE i.run_id = rr.id ORDER BY i.position LIMIT 1) AS instruction
  FROM report_runs rr
  LEFT JOIN users u ON u.id = rr.created_by
  LEFT JOIN agent_runs ar ON ar.id = rr.agent_run_id
  LEFT JOIN agent_providers p ON p.id = ar.provider_id`;

/** E6: the models a run used in order: the fallback's audit entry names the primary and the fallback. */
function modelsOf(row: HistoryRow): string[] {
  if (!row.agent_run_id) return [];
  const fallback = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'reports.generate.fallback' AND metadata_json LIKE ? ORDER BY created_at, rowid").all(`%"runId":"${row.id}"%`) as Array<{ metadata_json: string }>;
  const chain: string[] = [];
  for (const entry of fallback) {
    try {
      const { from, to } = JSON.parse(entry.metadata_json) as { from?: string; to?: string };
      if (from && chain.at(-1) !== from) chain.push(from);
      if (to) chain.push(to);
    } catch { /* a malformed entry is skipped */ }
  }
  return chain.length ? chain : row.model ? [row.model] : [];
}

function itemOf(row: HistoryRow): ReportRunHistoryItem {
  const finished = row.finished_at ? Date.parse(row.finished_at) : NaN;
  return {
    ...runView(row),
    startedBy: row.created_by ? { id: row.created_by, name: row.author_name ?? "Removed user" } : null,
    durationMs: Number.isFinite(finished) ? Math.max(0, finished - Date.parse(row.started_at)) : null,
    model: row.model, models: modelsOf(row), provider: row.provider_name,
    promptTokens: row.agent_run_id ? row.prompt_tokens : null, completionTokens: row.agent_run_id ? row.completion_tokens : null,
    tokensEstimated: row.tokens_estimated === 1, costMicros: row.cost_micros, toolCalls: row.agent_run_id ? row.tool_calls : null,
    instruction: row.instruction
  };
}

/** The owner's run list, newest first. */
export function runHistory(reportId: string, userId: string): ReportRunHistoryItem[] {
  ownedReport(reportId, userId);
  abandonExpiredReportRuns(Date.now(), reportId);
  const rows = db.query(`${SELECT} WHERE rr.report_id = ? ORDER BY rr.started_at DESC, rr.rowid DESC LIMIT ?`).all(reportId, REPORT_LIMITS.runsKept * 2) as HistoryRow[];
  return rows.map(itemOf);
}

type StepRow = { seq: number; kind: "model" | "tool"; tool_name: string | null; text: string | null; args_json: string | null; result_text: string | null; truncated: number; ok: number | null; prompt_tokens: number | null; completion_tokens: number | null; duration_ms: number };
const RECOVERED = "[recovered from text] ";

function stepOf(row: StepRow): ReportRunStep {
  if (row.kind === "tool") {
    const recovered = Boolean(row.args_json?.startsWith(RECOVERED));
    return { seq: row.seq, kind: "tool", tool: row.tool_name ?? "tool", args: recovered ? row.args_json!.slice(RECOVERED.length) : row.args_json, result: row.result_text, ok: row.ok === null ? null : row.ok === 1, truncated: row.truncated === 1, durationMs: row.duration_ms, recovered };
  }
  let toolNames: string[] = [];
  try {
    const calls = JSON.parse(row.args_json ?? "[]") as unknown;
    if (Array.isArray(calls)) toolNames = calls.map((call) => (call as { name?: unknown }).name).filter((name): name is string => typeof name === "string");
  } catch { toolNames = []; }
  return { seq: row.seq, kind: "model", text: row.text, toolNames, promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens, durationMs: row.duration_ms };
}

/** One run's full log for the owner: the summary, the doc it read, its steps, and a refresh's queries. */
export function runLog(reportId: string, runId: string, userId: string): ReportRunLog {
  ownedReport(reportId, userId);
  const row = db.query(`${SELECT} WHERE rr.report_id = ? AND rr.id = ?`).get(reportId, runId) as HistoryRow | null;
  if (!row) throw new ReportError(404, "NOT_FOUND", "Run not found");
  const doc = row.doc_snapshot_id
    ? db.query("SELECT id, title, length(CAST(markdown AS BLOB)) AS bytes, sha256, fetched_at FROM report_doc_snapshots WHERE id = ?").get(row.doc_snapshot_id) as { id: string; title: string | null; bytes: number; sha256: string; fetched_at: string } | null
    : null;
  const stepRows = row.agent_run_id
    ? db.query("SELECT seq, kind, tool_name, text, args_json, result_text, truncated, ok, prompt_tokens, completion_tokens, duration_ms FROM agent_audit_steps WHERE run_id = ? ORDER BY seq").all(row.agent_run_id) as StepRow[]
    : [];
  const hasAudit = row.agent_run_id ? Boolean(db.query("SELECT 1 FROM agent_runs WHERE id = ?").get(row.agent_run_id)) : false;
  const queries = (db.query("SELECT query_key, ms, row_count, truncated, rows_read, error_code, error, COALESCE(sent_sql, sql) AS sql FROM report_results WHERE run_id = ? ORDER BY rowid").all(runId) as Array<{ query_key: string; ms: number | null; row_count: number; truncated: number; rows_read: number | null; error_code: string | null; error: string | null; sql: string }>)
    .map((item) => ({ key: item.query_key, ms: item.ms, rows: item.row_count, truncated: item.truncated === 1, rowsRead: item.rows_read, errorCode: item.error_code, error: item.error, sql: item.sql }));
  return {
    run: itemOf(row),
    doc: doc ? { id: doc.id, title: doc.title, bytes: doc.bytes, sha256: doc.sha256, fetchedAt: doc.fetched_at } : null,
    steps: hasAudit ? stepRows.map(stepOf) : null,
    plan: storedPlan(row.plan_json),
    queries
  };
}
