import { createContext, useEffect, useState } from "react";
import { Check, ChevronDown, FileText, LoaderCircle, MessageSquareText, X } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { ReportRunHistoryItem, ReportRunLog, ReportRunStep } from "../../shared/reports";
import { api } from "../api";
import { resultLine, stepDetail, toolLabel } from "./GenerateProgress";
import { groupStepsByTodo, PlanChecklist } from "./PlanChecklist";
import { RUN_STATUS_TEXT, runLabel, timeAgo } from "./reportViewApi";
import { messageOf } from "./reportsApi";
import "./generate.css";
import "./reportEdit.css";

export const listRunHistory = (id: string) => api<{ runs: ReportRunHistoryItem[] }>(`/reports/${id}/run-history`);
export const getRunLog = (id: string, runId: string) => api<ReportRunLog>(`/reports/${id}/run-history/${runId}`);

/** Opens the Runs panel at a run (Inspect → Provenance); null where there is no panel (readers, tests). */
export const ReportRunsContext = createContext<((runId: string | null) => void) | null>(null);

const duration = (ms: number | null) => ms === null ? null : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
const tokens = (run: ReportRunHistoryItem) => run.promptTokens === null ? null : `${(run.promptTokens + (run.completionTokens ?? 0)).toLocaleString()}${run.tokensEstimated ? " (estimated)" : ""} tokens`;
const cost = (micros: number | null) => micros === null ? null : `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 4 : 2)}`;

/** One run's line: what, who, how long, and what it cost. */
export function runFacts(run: ReportRunHistoryItem): string {
  return [run.startedBy ? `by ${run.startedBy.name}` : run.trigger === "schedule" ? "by the schedule" : null, timeAgo(run.startedAt), duration(run.durationMs), run.model, tokens(run), cost(run.costMicros)].filter(Boolean).join(" · ");
}

function StepItem({ step }: { step: ReportRunStep }) {
  if (step.kind === "model") {
    if (!step.text?.trim()) return null;
    return <li className="generate-step report-run-note">
      <span className="generate-step-icon" aria-hidden="true"><MessageSquareText /></span>
      <span className="generate-step-body"><span className="generate-step-text">{step.text.trim()}</span></span>
    </li>;
  }
  const detail = stepDetail(step.tool, step.args ?? "");
  const line = resultLine({ ok: step.ok, result: step.result ?? "", tool: step.tool });
  return <li className={`generate-step ${step.ok === false ? "is-failed" : "is-ok"}`}>
    <span className="generate-step-icon" aria-hidden="true">{step.ok === false ? <X /> : <Check />}</span>
    <span className="generate-step-body">
      <strong>{toolLabel(step.tool)}{step.recovered ? " (recovered from a text answer)" : ""}<span className="report-run-ms"> · {duration(step.durationMs)}</span></strong>
      {detail.text && <span className="generate-step-text">{detail.text}</span>}
      {detail.code && <pre className="generate-sql"><code>{detail.code}</code></pre>}
      {line && <span className={step.ok === false ? "generate-step-error" : "generate-step-text"}>{line}</span>}
      {step.truncated && <span className="generate-step-text">(cut for the audit log)</span>}
    </span>
  </li>;
}

function RunLog({ reportId, run }: { reportId: string; run: ReportRunHistoryItem }) {
  const [log, setLog] = useState<ReportRunLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getRunLog(reportId, run.id).then((next) => { if (live) setLog(next); }).catch((reason) => { if (live) setError(messageOf(reason, "Could not load the run")); });
    return () => { live = false; };
  }, [reportId, run.id]);
  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!log) return <p className="reports-loading" role="status"><LoaderCircle className="spin" aria-hidden="true" />Loading the run…</p>;
  // Steps under the plan's todos; reading before the plan, planning, and submits stay in the run's list.
  const grouped = log.plan && log.steps ? groupStepsByTodo(log.plan, log.steps.map((step) => ({ step, tool: step.kind === "tool" ? step.tool : "", args: step.kind === "tool" ? step.args : null }))) : null;
  return <div className="report-run-log">
    {run.instruction && <p className="report-run-instruction">“{run.instruction}”</p>}
    {run.error && <p className="generate-step-error">{run.error}</p>}
    {log.plan && <PlanChecklist plan={log.plan} heading="Plan" stepsOf={(id) => {
      const list = grouped?.byTodo.get(id)?.filter((item) => item.tool !== "update_todo" || (item.step.kind === "tool" && item.step.ok === false));
      return list?.length ? <ol className="generate-steps plan-todo-steps">{list.map((item) => <StepItem key={item.step.seq} step={item.step} />)}</ol> : null;
    }} />}
    <ol className="generate-steps">
      {log.doc && <li className="generate-step is-ok">
        <span className="generate-step-icon" aria-hidden="true"><FileText /></span>
        <span className="generate-step-body"><strong>Read the doc</strong><span className="generate-step-text">{log.doc.title ?? "Untitled doc"} · {(log.doc.bytes / 1024).toFixed(1)} KB · sha256 {log.doc.sha256.slice(0, 12)}…</span></span>
      </li>}
      {(grouped ? grouped.general.map((item) => item.step) : log.steps ?? []).map((step) => <StepItem key={step.seq} step={step} />)}
      {log.queries.map((query) => <li key={query.key} className={`generate-step ${query.error ? "is-failed" : "is-ok"}`}>
        <span className="generate-step-icon" aria-hidden="true">{query.error ? <X /> : <Check />}</span>
        <span className="generate-step-body">
          <strong>{query.key}<span className="report-run-ms"> · {duration(query.ms) ?? "—"}</span></strong>
          <span className="generate-step-text">{query.rows.toLocaleString()} {query.rows === 1 ? "row" : "rows"}{query.truncated ? " (cut)" : ""}{query.rowsRead !== null ? ` · ${query.rowsRead.toLocaleString()} read` : ""}</span>
          <pre className="generate-sql"><code>{query.sql}</code></pre>
          {query.error && <span className="generate-step-error">{query.errorCode ? `${query.errorCode}: ` : ""}{query.error}</span>}
        </span>
      </li>)}
    </ol>
    {log.steps === null && run.agentRunId && <p className="file-dialog-hint">The step log is no longer kept (the audit retention removed it).</p>}
    {log.steps === null && !run.agentRunId && !log.queries.length && <p className="file-dialog-hint">This run kept no step log.</p>}
  </div>;
}

/**
 * The Runs panel (owner only): every run Nook keeps for the report (generate, regenerate, edits,
 * refreshes, scheduled refreshes), newest first; each expands to its step log, the same as the live
 * view (tool calls with their SQL, results and errors, nudges, recovered calls, the doc read) or a
 * refresh's queries. Back or Escape closes it (D18).
 */
export function RunsSheet({ reportId, title, focusRunId, onClose, reopen }: { reportId: string; title: string; focusRunId: string | null; onClose: () => void; reopen: () => void }) {
  const [runs, setRuns] = useState<ReportRunHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set(focusRunId ? [focusRunId] : []));
  useHistoryDialogGuard(true, onClose, { reopen, layerKey: `reports.runs:${focusRunId ?? ""}` });
  useEffect(() => {
    let live = true;
    listRunHistory(reportId).then(({ runs: next }) => { if (live) setRuns(next); }).catch((reason) => { if (live) setError(messageOf(reason, "Could not load the runs")); });
    return () => { live = false; };
  }, [reportId]);
  const toggle = (id: string) => setOpen((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return <ModalDialog title="Runs" eyebrow={title} onClose={onClose} variant="sheet" className="reports-dialog report-changes report-runs-panel">
    <div className="report-changes-body">
      {error && <p className="form-error" role="alert">{error}</p>}
      {!runs && !error && <p className="reports-loading" role="status">Loading runs…</p>}
      {runs && !runs.length && <p className="report-changes-empty">No runs yet.</p>}
      <ol className="report-runs-list">
        {runs?.map((run) => {
          const expanded = open.has(run.id);
          return <li key={run.id} className={`report-run${expanded ? " is-open" : ""}`}>
            <button type="button" className="report-run-head" aria-expanded={expanded} onClick={() => toggle(run.id)}>
              <span className="report-run-title"><strong>{run.kind === "edit" ? "Edit (instruction)" : runLabel(run)}</strong><span className={`reports-status reports-status-${run.status === "succeeded" ? "ready" : run.status === "running" ? "stale" : "error"}`}>{RUN_STATUS_TEXT[run.status]}</span></span>
              <span className="report-run-facts">{runFacts(run)}</span>
              <ChevronDown aria-hidden="true" className="report-run-chevron" />
            </button>
            {expanded && <RunLog reportId={reportId} run={run} />}
          </li>;
        })}
      </ol>
    </div>
  </ModalDialog>;
}
