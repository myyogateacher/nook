import { api } from "../api";

/** Client types for /api/inbox (docs/plan/API_CONTRACTS.md § Inbox). */

export type ProposalKind = "note_draft" | "card_create" | "card_update" | "card_comment" | "event_create" | "event_update" | "row_create" | "row_update";
export type ProposalStatus = "pending" | "applying" | "applied" | "rejected" | "expired" | "failed" | "superseded" | "withdrawn";
export type ProposalRef = { type: "note" | "card" | "event" | "row"; id: string; href: string };

export type ProposalSummary = {
  id: string;
  kind: ProposalKind;
  kindLabel: string;
  /** Agent text: render as text only (T127). */
  title: string;
  rationale: string | null;
  status: ProposalStatus;
  /** Nook's own name for the target, or "restricted". */
  targetLabel: string;
  restricted: boolean;
  /** The target's in-app path (ids only), or null when restricted. */
  targetHref: string | null;
  digest: string;
  keyName: string;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resultCode: string | null;
  rejectReason: string | null;
  ref: ProposalRef | null;
  /** A pending note_draft only: what rejecting it would do to the draft now. */
  rejectEffect?: RejectEffect;
  /** Pending and the target changed since the agent read it, so approving would fail (older servers omit it). */
  stale?: boolean;
};

export type RejectEffect = "restore" | "discard" | "keep";

export type PreviewField = { name: string; before: string | null; after: string | null };
export type ProposalPreview =
  | { restricted: true }
  | { fields: PreviewField[] }
  | { markdown: { published: string; draft: string; draftChanged: boolean } };

export type ProposalDetail = ProposalSummary & { preview: ProposalPreview; position?: { index: number; of: number; nextId: string | null } };

export type ProposalGroup = {
  routine: { id: string; name: string } | null;
  run: { id: string; startedAt: string; summary: string | null; status: string; capped: boolean } | null;
  key: { name: string } | null;
  items: ProposalSummary[];
};

export type BulkResult = { id: string; status: string; code?: string; ref?: ProposalRef; error?: string };

export const INBOX_CHANGED = "mynotes:inbox-changed";
/** Tells the account-row badge (and Today) that proposals changed. */
export const announceInboxChanged = () => window.dispatchEvent(new Event(INBOX_CHANGED));

export function listProposals(options: { status: "pending" | "resolved"; cursor?: string | null }) {
  const params = new URLSearchParams({ status: options.status, group: options.status === "pending" ? "run" : "none" });
  if (options.cursor) params.set("cursor", options.cursor);
  return api<{ groups: ProposalGroup[]; nextCursor: string | null }>(`/inbox/proposals?${params}`);
}

export const getProposal = (id: string) => api<{ proposal: ProposalDetail }>(`/inbox/proposals/${id}`);
export const approveProposal = (id: string) => api<{ id: string; status: "applied"; ref: ProposalRef }>(`/inbox/proposals/${id}/approve`, { method: "POST", body: "{}" });
export const rejectProposal = (id: string, reason?: string) =>
  api<{ id: string; status: "rejected"; draft?: "restored" | "discarded" | "kept"; draftDiscarded?: boolean }>(`/inbox/proposals/${id}/reject`, { method: "POST", body: JSON.stringify(reason ? { reason } : {}) });
export const bulkProposals = (action: "approve" | "reject", ids: string[], reason?: string) =>
  api<{ results: BulkResult[] }>("/inbox/proposals/bulk", { method: "POST", body: JSON.stringify({ action, ids, ...(reason ? { reason } : {}) }) });
export const pendingCount = () => api<{ pending: number }>("/inbox/count");
export const getInboxSettings = () => api<{ push: boolean }>("/inbox/settings");
export const setInboxPush = (push: boolean) => api<{ push: boolean }>("/inbox/settings", { method: "PUT", body: JSON.stringify({ push }) });

// --- Routines (Wave 22, docs/plan/API_CONTRACTS.md § Inbox routines) -------------------------

export type RoutineCadence = "manual" | "hourly" | "daily" | "weekdays" | "weekly";
export type RunStatus = "running" | "succeeded" | "failed" | "abandoned";
export type RoutineTargets = { boardIds?: string[]; calendarIds?: string[]; collectionIds?: string[]; folderIds?: string[] };

export type Routine = {
  id: string; name: string; instructions: string; outputKinds: ProposalKind[]; targets: RoutineTargets | null; scopeHints: string | null;
  cadence: RoutineCadence; atTime: string | null; weekday: number | null; tz: string; scheduleNote: string | null; scheduleText: string;
  keyId: string | null; keyName: string | null; keyRevoked: boolean; maxProposals: number; expireDays: number; enabled: boolean;
  nextDueAt: string | null; due: boolean; lastRunAt: string | null; lastRunStatus: RunStatus | null;
  running: { id: string; startedAt: string; leaseExpiresAt: string } | null;
  revision: number; createdAt: string; updatedAt: string;
};

export type RoutineInput = {
  name: string; instructions: string; outputKinds: ProposalKind[]; targets: RoutineTargets | null; scopeHints: string | null;
  cadence: RoutineCadence; atTime: string | null; weekday: number | null; tz: string; scheduleNote: string | null; keyId: string | null;
  maxProposals: number; expireDays: number; enabled: boolean;
};

export type RunSummary = {
  id: string; routineId: string; routineName: string | null; status: RunStatus; startedAt: string; finishedAt: string | null; leaseExpiresAt: string;
  durationMs: number | null; toolCalls: number; proposals: number; capped: boolean;
  /** Agent text: render as text only (T127). */
  summary: string | null; error: string | null; clientLabel: string | null; keyName: string | null;
};

export const listRoutines = () => api<{ routines: Routine[] }>("/inbox/routines");
export const createRoutine = (input: RoutineInput) => api<{ routine: Routine }>("/inbox/routines", { method: "POST", body: JSON.stringify(input) });
export const updateRoutine = (id: string, patch: Partial<RoutineInput> & { revision: number }) =>
  api<{ routine: Routine }>(`/inbox/routines/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteRoutine = (id: string) => api<{ deleted: true }>(`/inbox/routines/${id}`, { method: "DELETE", body: "{}" });
export const setRoutineEnabled = (id: string, enabled: boolean) => api<{ routine: Routine }>(`/inbox/routines/${id}/${enabled ? "resume" : "pause"}`, { method: "POST", body: "{}" });
export const listRuns = (routineId: string) => api<{ runs: RunSummary[] }>(`/inbox/routines/${routineId}/runs`);

/** The caller's MCP keys, for binding a routine to one (the Settings list). */
export type InboxKey = { id: string; name: string; scopes: string[]; effectiveScopes?: string[] };
export const listInboxKeys = () => api<{ keys: InboxKey[] }>("/mcp/keys");
