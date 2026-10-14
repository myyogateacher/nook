/**
 * Wave 46 wire types: report generation and its doc (docs/plan/API_CONTRACTS.md § Analytics reports,
 * Wave 46). shared/reports.ts is frozen after wave 45, so these live here; they add, never change,
 * that vocabulary. Pure: no imports from server or client code.
 */

import type { ReportDetail, RunStatus } from "./reports";

/** The tool a doc is read with: its name, the argument that takes the link or id, and whether Outline's `resource: "document"` is sent. */
export type DocToolChoice = { tool: string; arg: string; outline: boolean };

/** A tool server a person may read a doc through, its tools (name and argument names), and Nook's auto-pick. */
export type DocServerChoice = { id: string; name: string; status: string; tools: Array<{ name: string; title: string | null; args: string[] }>; pick: DocToolChoice | null };

/** A report's doc, its newest snapshot, and whether the doc changed since the report was generated ("Doc changed — regenerate?"). */
export type DocState = {
  doc: { serverId: string | null; serverName: string | null; tool: string | null; arg: string | null; ref: string | null; hash: string | null } | null;
  latest: { id: string; sha256: string; title: string | null; bytes: number; fetchedAt: string } | null;
  changed: boolean;
};

/** `POST /api/reports/generate` and `POST /api/reports/:id/generate` (202): the report and the run to follow on `/api/runs/:agentRunId/events`. */
export type GenerateStarted = { report: ReportDetail; run: { id: string; agentRunId: string; docSnapshotId: string; docChanged: boolean } };

/** `GET /api/reports/:id/generation`: the latest generation run. */
export type GenerationRun = { id: string; agentRunId: string | null; status: RunStatus; error: string | null; docSnapshotId: string | null; startedAt: string; finishedAt: string | null; /** The run's plan (2c), the owner's only. */ plan?: RunPlan | null };

/** Generation error codes the UI explains: MCP_AUTH means an admin must reconnect the tool server. */
/**
 * Codes wave 46 adds to shared/reports.ts's REPORT_ERROR_CODES (frozen): DOC_TOOL_REFUSED is a doc tool
 * that is not read-only (its effective policy is not `auto`), named as an override.
 */
export const GENERATE_ERROR_CODES = ["DOC_TOOL_REFUSED"] as const;

export const GENERATE_ERROR_HINTS: Record<string, string> = {
  DOC_TOOL_REFUSED: "That tool is not read-only, so Nook will not call it to read a doc; choose a read-only tool.",
  MCP_AUTH: "The doc server refused Nook's credential. An admin needs to reconnect it in Settings → AI → Tool servers.",
  DOC_FETCH: "Nook could not read the doc through that tool server.",
  LIMIT_REACHED: "Today's AI budget is used up; it resets at midnight UTC.",
  NOT_CONFIGURED: "AI is not set up on this Nook yet; ask an admin.",
  RUN_IN_PROGRESS: "This report is already being refreshed or generated.",
  BUSY: "You are already generating a report; wait for it to finish."
};

/**
 * The planner (plan_report / plan_change): the run's goal, sections, and todos. The agent plans after
 * reading the doc, works through each todo (run_sql with a key, then update_todo done with that key),
 * and submits only when every todo is done, skipped, or blocked. Kept on the run (report_runs.plan_json).
 */
export const PLAN_TODO_KINDS = ["kpi", "chart", "table", "markdown", "explore"] as const;
export type PlanTodoKind = typeof PLAN_TODO_KINDS[number];
export const PLAN_TODO_STATUSES = ["open", "in_progress", "done", "skipped", "blocked"] as const;
export type PlanTodoStatus = typeof PLAN_TODO_STATUSES[number];
export type PlanTodo = {
  id: string; title: string; kind: PlanTodoKind; section: string | null; metric: string | null; docRef: string | null; tables: string[]; intent: string | null;
  status: PlanTodoStatus; note: string | null; queryKey: string | null; blockId: string | null;
};
export type RunPlan = { goal: string; sections: Array<{ id: string; title: string }>; todos: PlanTodo[]; added: number };
export const PLAN_LIMITS = { todos: 24, added: 8, title: 160, note: 300, goal: 300, sections: 10 } as const;
