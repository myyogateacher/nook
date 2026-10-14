/**
 * Wave 46 wire types: report generation and its doc (docs/plan/API_CONTRACTS.md § Analytics reports,
 * Wave 46). shared/reports.ts is frozen after wave 45, so these live here; they add, never change,
 * that vocabulary. Pure: no imports from server or client code.
 */

import type { ReportDetail, RunStatus } from "./reports";

/** The tool a doc is read with: its name, the argument that takes the link or id, and whether Outline's `resource: "document"` is sent. */
export type DocToolChoice = { tool: string; arg: string; outline: boolean };

/** A tool server a person may read a doc through, whether its tools were ever synced, its read-only tools (name and argument names), and Nook's auto-pick. */
export type DocServerChoice = {
  id: string; name: string; status: string; synced: boolean; tools: Array<{ name: string; title: string | null; args: string[]; /** The server's raw hint, when it gave one (false: a declared write, never listed for browsing). */ readOnlyHint?: boolean }>; pick: DocToolChoice | null;
  /** Doc-fetcher-like tools (fetch, get_document, read_document with id or url) whose policy is not auto. */
  candidates: Array<{ name: string; args: string[]; policy: "auto" | "confirm" | "off" }>;
  /** Every synced tool's name (at most 100), whatever its policy. */
  toolNames: string[];
  /** B4: the tool server's URL hostname (a pasted link on it selects the server); null for Nook and stdio servers. */
  host?: string | null;
  /** B4: Nook itself (`id: "nook"`): no sync, its own tools, and the instance's origins (a link on one selects it). */
  builtin?: boolean;
  origins?: string[];
};

/** A linked page an agent read during a run (B3), as its owner sees it: never its text. */
export type DocPageInfo = { id: string; title: string | null; tool: string; serverName: string; bytes: number; sha256: string; fetchedAt: string; checkedAt: string | null; changed: boolean };

/**
 * A report's doc, its newest snapshot, and whether the doc changed since the report was generated ("Doc
 * changed — regenerate?"): the main doc, or (B3) a linked page of the current spec's runs (`pages`,
 * each with its own `changed`). `browseTools` are the ticked tools the AI may use to read more docs.
 */
export type DocState = {
  doc: { serverId: string | null; serverName: string | null; tool: string | null; arg: string | null; ref: string | null; hash: string | null; browseTools: string[] } | null;
  latest: { id: string; sha256: string; title: string | null; bytes: number; fetchedAt: string } | null;
  changed: boolean;
  /** The main doc changed (as opposed to a linked page). */
  mainChanged: boolean;
  pages: DocPageInfo[];
};

/** B3: the AI's doc tools per run: calls, bytes of results, one result shown to the model, ticks per report, pages Check doc reads. */
export const DOC_BROWSE_LIMITS = { calls: 8, runBytes: 400 * 1024, resultBytes: 32 * 1024, ticked: 20, checkedPages: 16 } as const;

/** Verbs that mark a tool as a write: such a tool is never offered for reading docs, not even greyed out. */
const WRITE_VERBS = new Set(["create", "update", "delete", "remove", "move", "archive", "restore", "write", "set", "add", "edit", "rename", "publish", "import", "upload"]);

/** Whether a tool's name has a write verb as one of its words (`delete_document`, `updateDocument`, `docs.create`). */
export const isWriteLikeName = (name: string): boolean =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).some((word) => WRITE_VERBS.has(word));

/**
 * A tool that may be offered for reading docs (the browse list, "Allow … automatically"): not
 * annotated destructive, not annotated as a write (`readOnlyHint: false` where the server says so),
 * and no write verb in its name. Anything else is hidden, never greyed out.
 */
export const isReadLikeTool = (tool: { name: string; destructive?: boolean; readOnlyHint?: boolean | null }): boolean =>
  tool.destructive !== true && tool.readOnlyHint !== false && !isWriteLikeName(tool.name);

/** The read-only tools ticked by default: those that fetch, list, or search docs. */
export const defaultBrowseTools = (names: readonly string[]): string[] => names.filter((name) => /fetch|search|list|get_document|read_document|read_note/i.test(name)).slice(0, DOC_BROWSE_LIMITS.ticked);

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
  DOC_TOOL_REFUSED: "That tool is not allowed to run automatically, so Nook will not call it to read a doc; choose a read-only tool, or ask an admin to set it to Auto.",
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
