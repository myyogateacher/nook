import type { BulkResult, ProposalGroup, ProposalKind, ProposalStatus, ProposalSummary, RejectEffect } from "./inboxApi";

/** Pure copy and helpers for the Inbox (agent inbox §9), unit-tested in tests/inboxApp.test.tsx. */

/** Why a proposal did not apply, in words, for a failure code. Nothing was applied in every case. */
const FAILURE_COPY: Record<string, string> = {
  CARD_CHANGED: "The card changed since the agent read it",
  EVENT_CHANGED: "The event changed since the agent read it",
  ROW_CHANGED: "The row changed since the agent read it",
  SCHEMA_CHANGED: "The collection's fields changed since the agent read them",
  DRAFT_CHANGED: "The draft changed since the agent wrote it",
  NOT_FOUND: "You can no longer open what this changes",
  READ_ONLY: "You can only read this",
  OWNER_ONLY: "Only the owner can make this change",
  COLUMN_FULL: "The column is at its limit",
  LIMIT_REACHED: "A limit was reached",
  INVALID: "The change is no longer valid",
  INTERRUPTED: "Approving was interrupted",
  STALE_POSITION: "The board changed since the agent read it",
  KEY_REVOKED: "The key that suggested this was revoked"
};

export function failureText(code: string | null) {
  const reason = (code && FAILURE_COPY[code]) ?? "The change could not be applied";
  return `${reason}${code ? ` (${code})` : ""}. Nothing was applied.`;
}

const STATUS_LABEL: Record<ProposalStatus, string> = {
  pending: "Pending", applying: "Applying", applied: "Approved", rejected: "Rejected", expired: "Expired",
  failed: "Failed", superseded: "Replaced by a newer draft", withdrawn: "Withdrawn by the agent"
};

export const statusLabel = (status: ProposalStatus, resultCode: string | null) =>
  status === "applied" && resultCode === "PUBLISHED_IN_EDITOR" ? "Published in the editor"
    : status === "rejected" && resultCode === "DISCARDED_IN_EDITOR" ? "Discarded in the editor"
      : status === "superseded" && resultCode === "KEY_REVOKED" ? "Key revoked"
        : STATUS_LABEL[status];

const KIND_VERB: Record<ProposalKind, string> = {
  note_draft: "note draft", card_create: "create card", card_update: "update card", card_comment: "comment on card",
  event_create: "create event", event_update: "update event", row_create: "create row", row_update: "update row"
};

/** "Approve: update card Pay insurance" (§9.5). */
export const actionLabel = (verb: "Approve" | "Reject", proposal: Pick<ProposalSummary, "kind" | "title">) => `${verb}: ${KIND_VERB[proposal.kind]} ${proposal.title}`;

/** "expires in 13 days", "expires today". */
export function expiresText(expiresAt: string, nowMs = Date.now()) {
  const days = Math.floor((Date.parse(expiresAt) - nowMs) / 86_400_000);
  if (!Number.isFinite(days)) return "";
  if (days < 1) return "expires today";
  return `expires in ${days} day${days === 1 ? "" : "s"}`;
}

/** The group heading: the routine and run (Wave 22), or "Key “laptop”". */
export function groupTitle(group: Pick<ProposalGroup, "routine" | "key">) {
  if (group.routine) return group.routine.name;
  return group.key ? `Key “${group.key.name}”` : "All proposals";
}

const SHORT_FAILURE: Record<string, string> = {
  CARD_CHANGED: "card changed", EVENT_CHANGED: "event changed", ROW_CHANGED: "row changed", SCHEMA_CHANGED: "fields changed",
  DRAFT_CHANGED: "draft changed", NOT_FOUND: "no longer available", NOT_PENDING: "already resolved", READ_ONLY: "read-only", COLUMN_FULL: "column full",
  KEY_REVOKED: "key revoked"
};

/** "7 applied · 1 failed (card changed)" for a bulk result. */
export function bulkSummary(results: readonly BulkResult[]) {
  const applied = results.filter((result) => result.status === "applied").length;
  const rejected = results.filter((result) => result.status === "rejected").length;
  const failed = results.filter((result) => result.status !== "applied" && result.status !== "rejected");
  const parts: string[] = [];
  if (applied) parts.push(`${applied} applied`);
  if (rejected) parts.push(`${rejected} rejected`);
  if (failed.length) {
    const codes = [...new Set(failed.map((result) => result.code).filter((code): code is string => Boolean(code)))];
    parts.push(`${failed.length} failed${codes.length ? ` (${codes.map((code) => SHORT_FAILURE[code] ?? code.toLowerCase().replace(/_/g, " ")).join(", ")})` : ""}`);
  }
  return parts.join(" · ") || "Nothing changed";
}

/** "Apply 12 changes: 8 cards, 4 rows" (§9.3). */
export function bulkConfirmText(items: readonly Pick<ProposalSummary, "kind">[]) {
  const nouns: Record<string, [string, string]> = { note: ["note", "notes"], card: ["card", "cards"], event: ["event", "events"], row: ["row", "rows"] };
  const counts = new Map<string, number>();
  for (const item of items) {
    const noun = item.kind.startsWith("card") ? "card" : item.kind.startsWith("event") ? "event" : item.kind.startsWith("row") ? "row" : "note";
    counts.set(noun, (counts.get(noun) ?? 0) + 1);
  }
  const parts = [...counts].map(([noun, count]) => `${count} ${nouns[noun]![count === 1 ? 0 : 1]}`);
  return `Apply ${items.length} change${items.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

const REJECT_EFFECT_COPY: Record<RejectEffect, string> = {
  restore: "Your earlier draft will be restored.",
  discard: "The agent's draft will be discarded.",
  keep: "The draft stays as it is."
};

/**
 * What the reject dialog says will happen (review H1), from each proposal's `rejectEffect`: a note
 * draft is restored to the draft from before the agent wrote, discarded, or left as it is; any
 * other kind changes nothing. A note draft without an effect (not pending any more) keeps its draft.
 */
export function rejectEffectText(items: readonly Pick<ProposalSummary, "kind" | "rejectEffect">[]) {
  const effectOf = (item: Pick<ProposalSummary, "kind" | "rejectEffect">): RejectEffect | null => item.kind === "note_draft" ? item.rejectEffect ?? "keep" : null;
  if (items.length === 1) {
    const effect = effectOf(items[0]!);
    return effect ? REJECT_EFFECT_COPY[effect] : "Nothing changes.";
  }
  const counts = { restore: 0, discard: 0, keep: 0 };
  for (const item of items) {
    const effect = effectOf(item);
    if (effect) counts[effect] += 1;
  }
  const parts: string[] = [];
  if (counts.restore) parts.push(counts.restore === 1 ? "1 earlier draft will be restored." : `${counts.restore} earlier drafts will be restored.`);
  if (counts.discard) parts.push(counts.discard === 1 ? "1 agent draft will be discarded." : `${counts.discard} agent drafts will be discarded.`);
  if (counts.keep) parts.push(counts.keep === 1 ? "1 draft stays as it is." : `${counts.keep} drafts stay as they are.`);
  parts.push(parts.length ? "Nothing else changes." : "Nothing changes.");
  return parts.join(" ");
}

/** The banner after rejecting one proposal, from the server's `draft` outcome. */
export function rejectedText(draft: "restored" | "discarded" | "kept" | undefined) {
  if (draft === "restored") return "Rejected. Your earlier draft was restored.";
  if (draft === "discarded") return "Rejected. The agent's draft was discarded.";
  if (draft === "kept") return "Rejected. The draft stays as it is.";
  return "Rejected";
}

/** Bulk approve asks for confirmation above this many items (§9.3). */
export const BULK_CONFIRM_OVER = 10;

/** Where the phone's Back goes from a proposal: history when Nook pushed the entry, else the list. */
export function inboxBackAction(proposalId: string | null, depth: number): { kind: "history" } | { kind: "list" } | { kind: "home" } {
  if (depth > 0) return { kind: "history" };
  return proposalId ? { kind: "list" } : { kind: "home" };
}
