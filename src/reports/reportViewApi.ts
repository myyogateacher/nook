import { api } from "../api";
import type { ReportRun } from "../../shared/reports";
import { PAGE_METRICS_RUN_MARKER } from "../../shared/reportsMetrics";
import type { ProvenanceView, ReportResultsView, RunHistoryView, ScheduleInput, ScheduleView } from "../../shared/reportsView";
import type { ParamOptions, ParamSetInfo, ParamValues } from "../../shared/reportParams";

/** The Wave 47 report routes (server/reports/viewRoutes.ts): results, refresh, runs, provenance, and the schedule. */

export const getResults = (id: string) => api<ReportResultsView>(`/reports/${id}/results`);
/** Spec v3 (D489): one parameter set's results (cached; `set.missing` names what a run fills). */
export type ParamResultsView = ReportResultsView & { set: ParamSetInfo };
export const getParamResults = (id: string, values: ParamValues) => api<ParamResultsView>(`/reports/${id}/results?values=${encodeURIComponent(JSON.stringify(values))}`);
/** Runs a parameter set's missing queries (read access is enough) and answers with its results. */
export const runParamSet = (id: string, values: ParamValues, force = false) => api<ParamResultsView>(`/reports/${id}/param-runs`, { method: "POST", body: JSON.stringify(force ? { values, force } : { values }) });
export const getParamOptions = (id: string, paramId: string) => api<{ options: ParamOptions }>(`/reports/${id}/parameters/${paramId}/options`);
export const refreshReport = (id: string, queryKey?: string) => api<{ run: ReportRun }>(`/reports/${id}/refresh`, { method: "POST", body: JSON.stringify(queryKey ? { queryKey } : {}) });
export const getRun = (id: string, runId: string) => api<{ run: ReportRun }>(`/reports/${id}/runs/${runId}`);
export const listRuns = (id: string) => api<RunHistoryView>(`/reports/${id}/runs`);
export const getProvenance = (id: string, input: { runId?: string | null; snapshotId?: string | null; blockId?: string | null; queryKey?: string | null }) => {
  const params = new URLSearchParams();
  if (input.blockId) params.set("blockId", input.blockId);
  if (input.queryKey) params.set("queryKey", input.queryKey);
  if (input.runId) params.set("runId", input.runId);
  if (input.snapshotId) params.set("snapshotId", input.snapshotId);
  return api<ProvenanceView>(`/reports/${id}/provenance${params.size ? `?${params}` : ""}`);
};
export const saveSchedule = (id: string, input: ScheduleInput) => api<{ schedule: ScheduleView }>(`/reports/${id}/schedule`, { method: "PUT", body: JSON.stringify(input) });

/** A run as one line: "Refreshed by you · succeeded", "Scheduled · 1 of 4 queries failed". */
/** The version a "Run with today's data" run previewed, from its keys' marker (server/reports/refresh.ts previewOf). */
export function previewVersionOf(keys: readonly string[] | null | undefined): number | null {
  const match = keys?.[0]?.match(/^~v(\d+)$/);
  return match ? Number(match[1]) : null;
}

export function runLabel(run: Pick<ReportRun, "kind" | "trigger" | "queryKeys">) {
  // A generation is the AI reading the doc (wave 46), never "by hand".
  if (run.kind === "generate") return run.trigger === "mcp" ? "Generated from the doc over MCP" : "Generated from the doc";
  // Lane J: "Run with today's data" on an older version (its keys start with the marker `~v<n>`).
  // L2: Check doc re-read catalog metrics from a changed linked page (no query ran).
  if (run.queryKeys?.[0] === PAGE_METRICS_RUN_MARKER) return "Re-read metrics from changed linked pages";
  const preview = previewVersionOf(run.queryKeys);
  if (preview !== null) return `Ran v${preview} on today's data`;
  // D489: a reader's run with other parameter values (its keys start with `~p:<set>`).
  if (run.queryKeys?.[0]?.startsWith("~p:")) return "Ran with other filters";
  const kind = run.kind === "edit" ? "Edited" : run.queryKeys?.length ? `Re-ran ${run.queryKeys.join(", ")}` : "Refreshed";
  const by = run.trigger === "schedule" ? "on schedule" : run.trigger === "mcp" ? "over MCP" : "by hand";
  return `${kind} ${by}`;
}

export const RUN_STATUS_TEXT: Record<ReportRun["status"], string> = { running: "Running", succeeded: "Succeeded", partial: "Partly failed", failed: "Failed", abandoned: "Abandoned" };

/** "3 min ago", "2 h ago", or the date. */
export function timeAgo(iso: string | null, nowMs = Date.now()) {
  if (!iso) return "never";
  const seconds = Math.round((nowMs - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return iso;
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** A result as CSV (RFC 4180), with formula-looking cells defused for spreadsheets (a leading `'`). */
export function toCsv(columns: readonly { name: string }[], rows: readonly (readonly unknown[])[]) {
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? "" : typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
    // Spreadsheets skip leading whitespace before a formula, so ` =x` is defused too; plain numbers (`-1`) stay numbers.
    if ((/^[\t\r]/.test(text) || /^[=+\-@]/.test(text.trimStart())) && !/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
  };
  return [columns.map((column) => cell(column.name)).join(","), ...rows.map((row) => columns.map((_, index) => cell(row[index])).join(","))].join("\r\n") + "\r\n";
}
