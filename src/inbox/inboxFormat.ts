import type { BulkResult, ProposalGroup, ProposalKind, ProposalStatus, ProposalSummary, Routine, RunStatus, RunSummary } from "./inboxApi";

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
  STALE_POSITION: "The board changed since the agent read it"
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
  DRAFT_CHANGED: "draft changed", NOT_FOUND: "no longer available", NOT_PENDING: "already resolved", READ_ONLY: "read-only", COLUMN_FULL: "column full"
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

/** Bulk approve asks for confirmation above this many items (§9.3). */
export const BULK_CONFIRM_OVER = 10;

// --- Routines (Wave 22) ---------------------------------------------------------

const RUN_STATUS_LABEL: Record<RunStatus, string> = { running: "Running", succeeded: "Finished", failed: "Failed", abandoned: "Abandoned" };
export const runStatusLabel = (status: RunStatus) => RUN_STATUS_LABEL[status] ?? status;

/** "Due now", "Next Mon 5 Oct, 08:00", "Paused", "Manual only" for the routine list. */
export function dueText(routine: Pick<Routine, "enabled" | "cadence" | "nextDueAt" | "running">, nowMs = Date.now()) {
  if (!routine.enabled) return "Paused";
  if (routine.running) return "Running now";
  if (routine.cadence === "manual" || !routine.nextDueAt) return "Manual only";
  const due = Date.parse(routine.nextDueAt);
  if (due <= nowMs) return "Due now";
  return `Next ${new Date(due).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
}

/** "45 s", "2 min", "1 h 5 min". */
export function durationText(ms: number | null) {
  if (ms === null || !Number.isFinite(ms)) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** "4 proposals · 31 tool calls · 2 min" for one run. */
export function runMetrics(run: Pick<RunSummary, "proposals" | "toolCalls" | "durationMs" | "capped">) {
  const parts = [`${run.proposals} proposal${run.proposals === 1 ? "" : "s"}`, `${run.toolCalls} tool call${run.toolCalls === 1 ? "" : "s"}`];
  const duration = durationText(run.durationMs);
  if (duration) parts.push(duration);
  if (run.capped) parts.push("hit the per-run limit");
  return parts.join(" · ");
}

export const KIND_OPTIONS: Array<{ value: ProposalKind; label: string }> = [
  { value: "card_create", label: "Create cards" }, { value: "card_update", label: "Update cards" }, { value: "card_comment", label: "Comment on cards" },
  { value: "event_create", label: "Create events" }, { value: "event_update", label: "Update events" },
  { value: "row_create", label: "Create rows" }, { value: "row_update", label: "Update rows" }, { value: "note_draft", label: "Note drafts" }
];

/** The run line under a group heading: "Run 28 Sep, 08:02 · Finished" (plus "limit reached"). */
export function runLine(run: NonNullable<ProposalGroup["run"]>) {
  const time = new Date(run.startedAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `Run ${time} · ${runStatusLabel(run.status as RunStatus)}${run.capped ? " · limit reached" : ""}`;
}

/** Where the phone's Back goes from a proposal: history when Nook pushed the entry, else the list. */
export function inboxBackAction(proposalId: string | null, depth: number): { kind: "history" } | { kind: "list" } | { kind: "home" } {
  if (depth > 0) return { kind: "history" };
  return proposalId ? { kind: "list" } : { kind: "home" };
}
