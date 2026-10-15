/**
 * Wave 48 wire types: instructions to the edit agent (comments), patches, proposals, versions, and
 * sharing (docs/plan/API_CONTRACTS.md § Analytics reports, Wave 48). shared/reports.ts is frozen and
 * owned by the spec waves, so these live here; they compose its types and never change them.
 *
 * Patches work on whole block objects (or a partial of one), never on a fixed list of block fields, so
 * they follow the spec vocabulary as it grows; the patched spec is then validated with a strict block
 * schema, so a field the vocabulary does not name is refused, never saved (review H1). Pure: no server
 * or client imports.
 */
import type { ReportBlock, ReportSpec } from "./reports";
import type { QueryResultView } from "./reportsView";

export const INSTRUCTION_LIMITS = {
  /** An instruction's text, in characters. */
  text: 2000,
  /** Instructions waiting in one report's queue. */
  queued: 20,
  /** Ops in one patch. */
  ops: 40,
  /** Versions kept per report (the oldest go first). */
  versions: 100,
  /** A patch summary line. */
  summary: 500,
  /** Tries of submit_patch: the first and two retries. */
  submits: 3
} as const;

export const INSTRUCTION_STATUSES = ["queued", "running", "proposed", "applied", "rejected", "failed", "cancelled"] as const;
export type InstructionStatus = typeof INSTRUCTION_STATUSES[number];

/** Who may do what on a report: the owner everything; `comment` adds instructions; `view` reads. */
export const SHARE_LEVELS = ["view", "comment"] as const;
export type ShareLevel = typeof SHARE_LEVELS[number];
export type ReportLevel = "owner" | ShareLevel;
export type ReportVisibility = "private" | "selected" | "all_users";

// ------------------------------------------------------------------------------------------ patches

/** A block as a patch carries it: any object with an id and a type (validated as part of the whole spec). */
export type PatchBlock = { id: string; type: string } & Record<string, unknown>;

export type PatchOp =
  /** Inserts `block` after the block `after` (null or absent: at the top). */
  | { op: "add_block"; block: PatchBlock; after?: string | null }
  /** Merges `set` into the block (a new `type` replaces it), then removes the `unset` fields. */
  | { op: "update_block"; id: string; set?: Record<string, unknown>; unset?: string[] }
  | { op: "remove_block"; id: string }
  /** Moves the block after `after` (null: to the top); `section` puts it in a section (null: out of any). */
  | { op: "move_block"; id: string; after: string | null; section?: string | null }
  | { op: "add_query"; query: { key: string; sql: string; purpose?: string } }
  | { op: "update_query"; key: string; sql?: string; purpose?: string }
  | { op: "remove_query"; key: string }
  /** Spec v2 sections (wave 48b): inserted after the section `after` (null or absent: first). */
  | { op: "add_section"; section: { id: string; title: string; summary?: string }; after?: string | null }
  | { op: "update_section"; id: string; set: { title?: string; summary?: string | null } }
  /** Removes the section; its blocks stay, out of any section. */
  | { op: "remove_section"; id: string }
  /** Spec v3 parameters (D489): a whole parameter (validated with the spec), inserted after `after` (null or absent: first). */
  | { op: "add_parameter"; parameter: { id: string; type: string } & Record<string, unknown>; after?: string | null }
  /** Merges `set` into the parameter (its id stays). */
  | { op: "update_parameter"; id: string; set: Record<string, unknown> }
  /** Removes the parameter; queries that still read it are refused until they stop. */
  | { op: "remove_parameter"; id: string };
export type PatchOpName = PatchOp["op"];
export const PATCH_OPS: readonly PatchOpName[] = ["add_block", "update_block", "remove_block", "move_block", "add_query", "update_query", "remove_query", "add_section", "update_section", "remove_section", "add_parameter", "update_parameter", "remove_parameter"];

export type ReportPatch = { ops: PatchOp[]; summary?: string };

// ------------------------------------------------------------------------------- instructions

export type ReportInstruction = {
  id: string;
  reportId: string;
  /** The block it is about; null is the whole page. */
  blockId: string | null;
  text: string;
  status: InstructionStatus;
  /** Queue order (only meaningful while queued). */
  position: number;
  authorName: string | null;
  isMine: boolean;
  via: "web" | "mcp";
  runId: string | null;
  /** The edit's agent run (`/api/runs/:id/events`, its author only). */
  agentRunId: string | null;
  summary: string | null;
  error: string | null;
  appliedVersion: number | null;
  autoApplied: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  decidedAt: string | null;
};

export type BlockChangeKind = "added" | "updated" | "removed" | "moved";
/** `textHidden`: new or changed markdown the caller (not the owner) cannot see until it is applied. */
export type BlockChange = { blockId: string; change: BlockChangeKind; before: ReportBlock | null; after: ReportBlock | null; textHidden?: boolean };
export type QueryChange = { key: string; change: "added" | "updated" | "removed"; before: string | null; after: string | null };

/** A proposal as the review shows it: the proposed spec, what changed, and the results to draw it with. */
export type ProposalView = {
  instructionId: string;
  spec: ReportSpec;
  blocks: BlockChange[];
  queries: QueryChange[];
  /** Results for the proposed spec: the proposal's own for added or changed queries, the current ones otherwise. */
  results: QueryResultView[];
  /** The current results (the "before" side). */
  currentResults: QueryResultView[];
  summary: string | null;
  /** Out of date (the spec, the data source, or its allowlist changed): Apply answers 409 STALE_PROPOSAL and rejects it. */
  outOfDate: boolean;
  staleReason?: string;
  /**
   * Review M1: the instruction's author who is not the owner sees status only until the owner applies
   * it: no new or changed text, SQL, or rows (blocks, queries, and results are empty; `spec` is the
   * current one), just how many blocks and queries it changes.
   */
  redacted?: { blocks: number; queries: number };
};

/** GET /api/reports/:id/instructions: the thread, the caller's rights, and the auto-apply switch. */
export type InstructionsView = {
  instructions: ReportInstruction[];
  level: ReportLevel;
  canComment: boolean;
  canApply: boolean;
  autoApply: boolean;
};

// ----------------------------------------------------------------------------------- versions

export const VERSION_SOURCES = ["initial", "generate", "edit", "restore", "manual"] as const;
export type VersionSource = typeof VERSION_SOURCES[number];

export type ReportVersion = {
  version: number;
  source: VersionSource;
  instructionId: string | null;
  restoredFrom: number | null;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
  blocks: number;
  queries: number;
  current: boolean;
};

// ------------------------------------------------------------------------------------ sharing

export type ReportShare = { kind: "user" | "group"; id: string; name: string; level: ShareLevel };
export type ReportSharing = { visibility: ReportVisibility; shares: ReportShare[] };
/** Phase 2 (D482): one owner of a report; `primary` is the one scheduled refreshes run as. */
/** `state` (D503): `active` (a member or an admin who is not blocked), `blocked`, `guest`, or `viewer`, as Settings → Report owners shows it. */
export type ReportOwnerState = "active" | "blocked" | "guest" | "viewer";
export type ReportOwner = { id: string; name: string; primary: boolean; active: boolean; state: ReportOwnerState; addedBy: string | null; addedAt: string };
/** The owners and what the caller may do with them (owners and admins manage; never the last owner). */
export type ReportOwners = { owners: ReportOwner[]; canManage: boolean };
/**
 * D500: Settings → Report owners (admins). `unmanaged`: live reports with no owner who can act (every owner
 * blocked, a guest or a viewer now, or gone); `unopenable`: live reports the admin cannot open. Title and
 * place only, never content. `state` is an owner's: `active` (a member or an admin), `blocked`, `guest`, `viewer`.
 */
export type OwnerReviewScope = "unmanaged" | "unopenable";
export type OwnerReviewOwner = { id: string; name: string; state: ReportOwnerState };
export type OwnerReviewReport = { id: string; title: string; folder: { id: string; name: string } | null; owners: OwnerReviewOwner[]; updatedAt: string; canOpen: boolean; managed: boolean };
/** D505: a page of 200 by cursor; `total` is counted on the first page only (null on a page after `nextCursor`). */
export type OwnerReview = { scope: OwnerReviewScope; reports: OwnerReviewReport[]; total: number | null; limit: number; nextCursor: string | null };
export type SharingInput ={ visibility: ReportVisibility; shares: Array<{ kind: "user" | "group"; id: string; level: ShareLevel }> };

export const INSTRUCTION_STATUS_TEXT: Record<InstructionStatus, string> = {
  queued: "Queued", running: "Working", proposed: "Ready to review", applied: "Applied", rejected: "Rejected", failed: "Failed", cancelled: "Cancelled"
};

export const VERSION_SOURCE_TEXT: Record<VersionSource, string> = {
  initial: "First saved", generate: "Generated from the doc", edit: "Agent edit", restore: "Restored", manual: "Edited by hand"
};
