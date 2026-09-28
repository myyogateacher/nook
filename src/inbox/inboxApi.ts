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
  /** Pending and the target changed since the agent read it, so approving would fail (older servers omit it). */
  stale?: boolean;
};

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
  api<{ id: string; status: "rejected"; draftDiscarded?: boolean }>(`/inbox/proposals/${id}/reject`, { method: "POST", body: JSON.stringify(reason ? { reason } : {}) });
export const bulkProposals = (action: "approve" | "reject", ids: string[], reason?: string) =>
  api<{ results: BulkResult[] }>("/inbox/proposals/bulk", { method: "POST", body: JSON.stringify({ action, ids, ...(reason ? { reason } : {}) }) });
export const pendingCount = () => api<{ pending: number }>("/inbox/count");
export const getInboxSettings = () => api<{ push: boolean }>("/inbox/settings");
export const setInboxPush = (push: boolean) => api<{ push: boolean }>("/inbox/settings", { method: "PUT", body: JSON.stringify({ push }) });
