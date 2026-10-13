import { useEffect, useRef, useState } from "react";
import { Check, CircleStop, FileText, LoaderCircle, X } from "lucide-react";
import { followRun, type SequencedRunEvent } from "../chat/chatApi";
import type { RunStatus as AgentRunStatus } from "../../shared/agents";
import { cancelGeneration, messageOf } from "./reportsApi";

/** One tool call of the run as the step list shows it. */
export type ProgressStep = { callId: string; tool: string; args: string; ok: boolean | null; result: string; durationMs: number | null };

const TOOL_LABELS: Record<string, string> = {
  search_schema: "Search the schema", list_tables: "List tables", describe_tables: "Describe tables", sample_rows: "Sample rows",
  run_schema_query: "Read metadata", estimate: "Estimate a query", run_sql: "Run SQL", submit_report: "Submit the report"
};
export const toolLabel = (tool: string) => TOOL_LABELS[tool] ?? tool;

/** What a step shows of its arguments: the SQL for SQL tools, the tables or query for the schema tools, a count for a spec. */
export function stepDetail(tool: string, argsPreview: string): { code: string | null; text: string | null } {
  let args: Record<string, unknown> | null = null;
  try { args = JSON.parse(argsPreview) as Record<string, unknown>; } catch { args = null; }
  if (!args) {
    const sql = /"sql"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(argsPreview)?.[1];
    return sql ? { code: `${sql.replace(/\\n/g, "\n").replace(/\\"/g, "\"")}…`, text: null } : { code: null, text: null };
  }
  if (typeof args.sql === "string") return { code: args.sql, text: typeof args.purpose === "string" && args.purpose ? args.purpose : null };
  if (tool === "submit_report") {
    const blocks = Array.isArray(args.blocks) ? args.blocks.length : 0;
    const queries = Array.isArray(args.queries) ? args.queries.length : 0;
    return { code: null, text: `${blocks} ${blocks === 1 ? "block" : "blocks"}, ${queries} ${queries === 1 ? "query" : "queries"}` };
  }
  if (Array.isArray(args.tables)) return { code: null, text: args.tables.filter((item) => typeof item === "string").join(", ") };
  if (typeof args.query === "string") return { code: null, text: `“${args.query}”` };
  if (typeof args.table === "string") return { code: null, text: args.table };
  return { code: null, text: null };
}

/** A result preview as one readable line: the error of a refused call, else nothing (the step's tick says it worked). */
export function resultLine(step: Pick<ProgressStep, "ok" | "result" | "tool">): string | null {
  if (step.ok !== false) return step.tool === "submit_report" && step.ok ? step.result : null;
  try {
    const parsed = JSON.parse(step.result) as { error?: string; code?: string; guard?: string };
    if (parsed.error) return `${parsed.guard ?? parsed.code ?? "Error"}: ${parsed.error}`;
  } catch { /* plain text, e.g. a refused spec */ }
  return step.result;
}

/** Folds one run event into the step list (pure, for tests). */
export function applyEvent(steps: ProgressStep[], event: SequencedRunEvent): ProgressStep[] {
  if (event.type === "tool_call") return [...steps, { callId: event.data.callId, tool: event.data.tool, args: event.data.argsPreview, ok: null, result: "", durationMs: null }];
  if (event.type === "tool_result") return steps.map((step) => step.callId === event.data.callId ? { ...step, ok: event.data.ok, result: event.data.resultPreview, durationMs: event.data.durationMs } : step);
  return steps;
}

type Props = {
  reportId: string;
  /** The agent run to follow on /api/runs/:id/events. */
  agentRunId: string;
  docTitle: string | null;
  /** The run ended (any status); the page reloads the report. */
  onDone: (status: AgentRunStatus | null, error: string | null) => void;
};

/**
 * The live step list of a generation run (Wave 46): the doc read, then every tool call the model makes
 * (the SQL it runs, the tables it looks at, its submits and why one was refused), the model's own notes,
 * and Stop. It follows the run's events over SSE and reconnects from the last event it saw.
 */
export function GenerateProgress({ reportId, agentRunId, docTitle, onDone }: Props) {
  const [steps, setSteps] = useState<ProgressStep[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const controller = new AbortController();
    let seq = 0;
    let status: AgentRunStatus | null = null;
    let failure: string | null = null;
    let attempts = 0;
    const onEvent = (event: SequencedRunEvent) => {
      seq = Math.max(seq, event.seq);
      if (event.type === "delta") setNote((current) => (current + event.data.text).slice(-600));
      else if (event.type === "error") { failure = event.data.message; setError(event.data.message); }
      else if (event.type === "done") status = event.data.status;
      else if (event.type === "snapshot") status = event.data.status;
      else setSteps((current) => applyEvent(current, event));
    };
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const outcome = await followRun(agentRunId, seq, onEvent, controller.signal);
          if (outcome === "ended") doneRef.current(status, failure);
          return;
        } catch (reason) {
          attempts += 1;
          if (controller.signal.aborted) return;
          if (attempts > 4) {
            setError(messageOf(reason, "Lost the connection to the run"));
            doneRef.current(null, null);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 500 * attempts));
        }
      }
    })();
    return () => controller.abort();
  }, [agentRunId]);

  async function stop() {
    setStopping(true);
    try { await cancelGeneration(reportId); } catch (reason) { setError(messageOf(reason, "Could not stop the run")); setStopping(false); }
  }

  return <section className="generate-progress" aria-labelledby={`generate-${agentRunId}`}>
    <div className="generate-head">
      <h2 id={`generate-${agentRunId}`}><LoaderCircle className="spin" aria-hidden="true" />Generating the report…</h2>
      <button type="button" className="secondary-button" onClick={() => { void stop(); }} disabled={stopping}><CircleStop />{stopping ? "Stopping…" : "Stop"}</button>
    </div>
    <ol className="generate-steps" aria-live="polite">
      <li className="generate-step is-ok">
        <span className="generate-step-icon" aria-hidden="true"><FileText /></span>
        <span className="generate-step-body"><strong>Read the doc</strong>{docTitle && <span className="generate-step-text">{docTitle}</span>}</span>
      </li>
      {steps.map((step) => {
        const detail = stepDetail(step.tool, step.args);
        const line = resultLine(step);
        return <li key={step.callId} className={`generate-step ${step.ok === null ? "is-running" : step.ok ? "is-ok" : "is-failed"}`}>
          <span className="generate-step-icon" aria-hidden="true">{step.ok === null ? <LoaderCircle className="spin" /> : step.ok ? <Check /> : <X />}</span>
          <span className="generate-step-body">
            <strong>{toolLabel(step.tool)}</strong>
            {detail.text && <span className="generate-step-text">{detail.text}</span>}
            {detail.code && <pre className="generate-sql"><code>{detail.code}</code></pre>}
            {line && <span className={step.ok === false ? "generate-step-error" : "generate-step-text"}>{line}</span>}
            <span className="sr-only">{step.ok === null ? "running" : step.ok ? "done" : "refused"}</span>
          </span>
        </li>;
      })}
    </ol>
    {note.trim() && <p className="generate-note"><span className="sr-only">The model says: </span>{note.trim()}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
