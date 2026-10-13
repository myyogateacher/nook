import { api } from "../api";
import type { ReportRun } from "../../shared/reports";
import type { ProvenanceView, ReportResultsView, RunHistoryView, ScheduleInput, ScheduleView } from "../../shared/reportsView";

/** The Wave 47 report routes (server/reports/viewRoutes.ts): results, refresh, runs, provenance, and the schedule. */

export const getResults = (id: string) => api<ReportResultsView>(`/reports/${id}/results`);
export const refreshReport = (id: string, queryKey?: string) => api<{ run: ReportRun }>(`/reports/${id}/refresh`, { method: "POST", body: JSON.stringify(queryKey ? { queryKey } : {}) });
export const getRun = (id: string, runId: string) => api<{ run: ReportRun }>(`/reports/${id}/runs/${runId}`);
export const listRuns = (id: string) => api<RunHistoryView>(`/reports/${id}/runs`);
export const getProvenance = (id: string, input: { runId?: string | null; snapshotId?: string | null }) => {
  const params = new URLSearchParams();
  if (input.runId) params.set("runId", input.runId);
  if (input.snapshotId) params.set("snapshotId", input.snapshotId);
  return api<ProvenanceView>(`/reports/${id}/provenance${params.size ? `?${params}` : ""}`);
};
export const saveSchedule = (id: string, input: ScheduleInput) => api<{ schedule: ScheduleView }>(`/reports/${id}/schedule`, { method: "PUT", body: JSON.stringify(input) });

/** A run as one line: "Refreshed by you · succeeded", "Scheduled · 1 of 4 queries failed". */
export function runLabel(run: Pick<ReportRun, "kind" | "trigger" | "queryKeys">) {
  const kind = run.kind === "generate" ? "Generated" : run.kind === "edit" ? "Edited" : run.queryKeys?.length ? `Re-ran ${run.queryKeys.join(", ")}` : "Refreshed";
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
    if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
  };
  return [columns.map((column) => cell(column.name)).join(","), ...rows.map((row) => columns.map((_, index) => cell(row[index])).join(","))].join("\r\n") + "\r\n";
}
