import { api } from "../api";
import type { CheckinCadence, GoalHealth, GoalKind, GoalState, KrDirection, KrMetric, ProgressMode } from "../../shared/goals";
import type { WorkLinkView } from "../../shared/workRefs";

/** The Goals HTTP API (server/goals/routes.ts) and its shapes, as the client reads them. */

export type GoalSummary = {
  id: string; shortId: string; href: string; title: string; kind: GoalKind; state: GoalState; health: GoalHealth; suggestedHealth: GoalHealth;
  progress: number; expected: number | null; progressMode: ProgressMode; owner: { id: string; name: string }; team: { id: string; name: string } | null;
  period: { id: string; name: string; startsOn: string; endsOn: string } | null; parentId: string | null; alignedToHidden: boolean;
  startOn: string | null; dueOn: string | null; lastCheckinAt: string | null; checkinDue: boolean; cadence: CheckinCadence;
  krCount: number; childCount: number; hiddenChildCount: number; finalProgress: number | null; closedAt: string | null;
  visibility: "private" | "selected" | "all_users"; revision: number; createdAt: string; updatedAt: string;
};

export type KeyResult = {
  id: string; goalId: string; title: string; owner: { id: string; name: string } | null; metric: KrMetric; direction: KrDirection;
  startValue: number; targetValue: number; currentValue: number; unit: string | null; currency: string | null; weight: number; progress: number;
  source: { kind: string; label: string; description: string; config: Record<string, unknown>; error: string | null; updatedAt: string | null; available: boolean };
  milestones: Array<{ id: string; title: string; done: boolean }>; position: number; revision: number; updatedAt: string;
};

export type Checkin = { id: string; goalId: string; author: { id: string; name: string } | null; health: GoalHealth; confidence: number | null; note: string; values: Record<string, number>; progress: number; via: string; createdAt: string };

export type GoalDetail = GoalSummary & {
  description: string; level: string; canEdit: boolean; canComment: boolean; canManage: boolean;
  keyResults: KeyResult[]; children: GoalSummary[]; parent: GoalSummary | null; contributors: Array<{ id: string; name: string }>;
  lastCheckin: Checkin | null; includesHidden: boolean; shareRole: string;
};

export type Period = { id: string; name: string; startsOn: string; endsOn: string; archived: boolean; current: boolean; goalCount: number; canEdit: boolean };
export type SourceInfo = { kind: string; label: string; module: string };

export type KrInput = {
  title: string; ownerId?: string | null; metric?: KrMetric; direction?: KrDirection; startValue?: number; targetValue?: number; currentValue?: number;
  unit?: string | null; currency?: string | null; weight?: number; source?: { kind: string; config?: unknown } | null; milestones?: Array<{ id?: string; title: string; done?: boolean }>;
};
export type GoalInput = {
  title: string; description?: string; kind?: GoalKind; parentId?: string | null; periodId?: string | null; teamId?: string | null; ownerId?: string;
  startOn?: string | null; dueOn?: string | null; state?: "draft" | "active"; progressMode?: ProgressMode; cadence?: CheckinCadence;
  visibility?: "private" | "all_users"; shareRole?: "view" | "comment" | "edit"; contributorIds?: string[]; keyResults?: KrInput[];
};

export type GoalFilter = { period?: string | null; owner?: string | null; team?: string | null; state?: string | null; health?: string | null; mine?: boolean; q?: string; closed?: boolean; view?: "tree" | "list" };

const json = (body: unknown) => JSON.stringify(body);

function goalQuery(filter: GoalFilter) {
  const query = new URLSearchParams();
  if (filter.period) query.set("period", filter.period);
  if (filter.owner) query.set("owner", filter.owner);
  if (filter.team) query.set("team", filter.team);
  if (filter.state) query.set("state", filter.state);
  if (filter.health) query.set("health", filter.health);
  if (filter.mine) query.set("mine", "1");
  if (filter.q?.trim()) query.set("q", filter.q.trim());
  if (filter.closed) query.set("closed", "1");
  return query;
}

export function listGoals(filter: GoalFilter, cursor?: string | null, signal?: AbortSignal) {
  const query = goalQuery(filter);
  query.set("view", filter.view ?? "tree");
  if (cursor) query.set("cursor", cursor);
  return api<{ goals: GoalSummary[]; nextCursor: string | null }>(`/goals?${query}`, { signal });
}

/** D1387: the goals list's CSV, with the list's filters. */
export const goalsExportUrl = (filter: GoalFilter) => `/api/goals/export.csv?${goalQuery(filter)}`;

export const getGoal = (ref: string) => api<{ goal: GoalDetail }>(`/goals/${encodeURIComponent(ref)}`);
export const createGoal = (input: GoalInput) => api<{ goal: GoalDetail }>("/goals", { method: "POST", body: json(input) });
export const updateGoal = (id: string, patch: Partial<GoalInput> & { health?: GoalHealth; progress?: number; expectedRevision?: number }) =>
  api<{ goal: GoalDetail }>(`/goals/${encodeURIComponent(id)}`, { method: "PATCH", body: json(patch) });
export const binGoal = (id: string) => api<{ binned: boolean }>(`/goals/${encodeURIComponent(id)}`, { method: "DELETE" });
export const addKeyResult = (goalId: string, input: KrInput) => api<{ keyResult: KeyResult }>(`/goals/${encodeURIComponent(goalId)}/key-results`, { method: "POST", body: json(input) });
export const updateKeyResult = (id: string, patch: Partial<KrInput>) => api<{ keyResult: KeyResult }>(`/key-results/${encodeURIComponent(id)}`, { method: "PATCH", body: json(patch) });
export const deleteKeyResult = (id: string) => api<{ undoTicket: string }>(`/key-results/${encodeURIComponent(id)}`, { method: "DELETE" });
export const undo = (ticket: string) => api<{ restored: number }>(`/undo/${encodeURIComponent(ticket)}`, { method: "POST" });
export const previewSource = (goalId: string, source: { kind: string; config: unknown }) =>
  api<{ preview: { value: number; target: number | null; detail: string | null; description: string } }>(`/goals/${encodeURIComponent(goalId)}/preview-source`, { method: "POST", body: json(source) });
export const checkIn = (goalId: string, input: { health: GoalHealth; confidence?: number | null; note?: string; values?: Record<string, number>; milestonesDone?: Record<string, string[]> }) =>
  api<{ checkin: Checkin; goal: GoalDetail }>(`/goals/${encodeURIComponent(goalId)}/checkins`, { method: "POST", body: json(input) });
export const listCheckins = (goalId: string, cursor?: string | null) => api<{ checkins: Checkin[]; nextCursor: string | null }>(`/goals/${encodeURIComponent(goalId)}/checkins${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
export type GoalHistory = {
  keyResults: Array<{ id: string; title: string; points: Array<{ at: string; value: number; progress: number; source: string }> }>;
  checkins: Array<{ at: string; progress: number; health: string }>; current: number; ideal: { start: string; end: string } | null;
};
export const goalHistory = (goalId: string) => api<GoalHistory>(`/goals/${encodeURIComponent(goalId)}/history`);
export const closeGoal = (goalId: string, input: { state: "achieved" | "missed" | "dropped" | "carried_over"; carryOver?: { periodId: string } | null }) =>
  api<{ goal: GoalDetail; carriedOver: GoalSummary | null }>(`/goals/${encodeURIComponent(goalId)}/close`, { method: "POST", body: json(input) });
export const reopenGoal = (goalId: string) => api<{ goal: GoalDetail }>(`/goals/${encodeURIComponent(goalId)}/reopen`, { method: "POST", body: "{}" });
export const goalWork = (goalId: string) => api<{ links: WorkLinkView[] }>(`/goals/${encodeURIComponent(goalId)}/work`);
export const goalsForItem = (kind: string, id: string) => api<{ goals: GoalSummary[] }>(`/goals/for-item?${new URLSearchParams({ kind, id })}`);
export const listSources = () => api<{ sources: SourceInfo[] }>("/goals/sources");

export const listPeriods = (archived = false) => api<{ periods: Period[] }>(`/goal-periods${archived ? "?archived=1" : ""}`);
export const createPeriod = (input: { name: string; startsOn: string; endsOn: string }) => api<{ period: Period }>("/goal-periods", { method: "POST", body: json(input) });
export const updatePeriod = (id: string, input: { name?: string; startsOn?: string; endsOn?: string; archived?: boolean }) => api<{ period: Period }>(`/goal-periods/${encodeURIComponent(id)}`, { method: "PATCH", body: json(input) });
export const deletePeriod = (id: string) => api<{ deleted: boolean }>(`/goal-periods/${encodeURIComponent(id)}`, { method: "DELETE" });
export const closePeriod = (id: string, carryOverTo: string | null) => api<{ closed: { achieved: number; missed: number; carried_over: number; skipped: number } }>(`/goal-periods/${encodeURIComponent(id)}/close`, { method: "POST", body: json({ carryOverTo }) });

/** Boards, sprints, tags, and saved views for the tasks source picker (the Tasks API). */
export const listBoards = () => api<{ boards: Array<{ id: string; name: string; estimate_kind?: string }> }>("/tasks/boards");
type ViewItem = { id: string; name: string };
export const listViews = () => api<{ mine: ViewItem[]; shared: ViewItem[]; everyone: ViewItem[] }>("/tasks/views").then((body) => [...body.mine, ...body.shared, ...body.everyone]);
export const boardParts = (boardId: string) => api<{ tags: Array<{ id: string; name: string }>; sprints: Array<{ id: string; name: string }> }>(`/tasks/boards/${encodeURIComponent(boardId)}`);
export const listGroups = () => api<{ groups: Array<{ id: string; name: string }> }>("/groups");
export const listUsers = () => api<{ users: Array<{ id: string; displayName: string; role?: string; kind?: string }> }>("/users");

/** The goal's path segment and full path. */
export const goalPath = (goal: { href: string }) => goal.href;
