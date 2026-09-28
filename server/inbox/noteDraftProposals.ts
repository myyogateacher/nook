import { db, now } from "../db";
import { DEFAULT_PROPOSAL_EXPIRE_DAYS } from "../migrations/021_agent_inbox";

/**
 * The note draft side of the agent inbox (docs/plan/research/2026-09-28-agent-inbox-routines.md
 * D149): an MCP key's draft *is* the pending change, so a `note_draft` proposal only points at it
 * (`{noteId, revision, created}`). Only SQLite is touched here, inside the caller's transaction, so
 * noteDrafts.ts can call it without an import cycle through the inbox service.
 */

export const PROPOSAL_EXPIRE_MS = DEFAULT_PROPOSAL_EXPIRE_DAYS * 86_400_000;

export type NoteDraftPayload = { noteId: string; revision: number; created: boolean };

/** A proposal title: the note title, trimmed to the column's 120 characters. */
const proposalTitle = (title: string) => title.trim().slice(0, 120) || "Untitled";

/**
 * What the draft was just before an agent's write (review H1): no draft, or a draft with its
 * revision, exact text (null when it was too large to keep), and the MCP key that wrote it (null
 * for a person's draft). Rejecting the proposal restores it.
 */
export type DraftBase = { state: "none" } | { state: "draft"; revision: number; markdown: string | null; keyId: string | null };

export type ProposalBaseRow = {
  base_state: "none" | "draft" | null; base_draft_revision: number | null; base_draft_markdown: string | null; base_draft_key_id: string | null;
};

/**
 * Records the draft `keyId` just wrote as the note's pending `note_draft` proposal, superseding
 * any older pending one for the same note. Call inside the draft write's transaction.
 *
 * `base` is the draft just before this write. When that draft is itself an earlier agent draft,
 * still pending and untouched (the same revision), the new proposal inherits the earlier one's
 * base instead, so rejecting a chain of agent writes gives back the draft the person had first.
 */
export function recordNoteDraftProposal(input: { ownerId: string; noteId: string; keyId: string; revision: number; created: boolean; title: string; base: DraftBase }) {
  const key = db.query("SELECT name FROM mcp_api_keys WHERE id = ?").get(input.keyId) as { name: string } | null;
  const timestamp = now();
  let base: ProposalBaseRow = input.base.state === "none"
    ? { base_state: "none", base_draft_revision: null, base_draft_markdown: null, base_draft_key_id: null }
    : { base_state: "draft", base_draft_revision: input.base.revision, base_draft_markdown: input.base.markdown, base_draft_key_id: input.base.keyId };
  if (input.base.state === "draft") {
    const earlier = db.query(`SELECT base_state, base_draft_revision, base_draft_markdown, base_draft_key_id FROM proposals
      WHERE kind = 'note_draft' AND target_type = 'note' AND target_id = ? AND status = 'pending' AND json_extract(payload, '$.revision') = ?
      ORDER BY rowid DESC LIMIT 1`).get(input.noteId, input.base.revision) as ProposalBaseRow | null;
    if (earlier) base = earlier;
  }
  db.query(`UPDATE proposals SET status = 'superseded', result_code = 'NEWER_DRAFT', resolved_at = ?, base_draft_markdown = NULL
    WHERE kind = 'note_draft' AND target_type = 'note' AND target_id = ? AND status = 'pending'`).run(timestamp, input.noteId);
  const id = crypto.randomUUID();
  const payload: NoteDraftPayload = { noteId: input.noteId, revision: input.revision, created: input.created };
  db.query(`INSERT INTO proposals (id, owner_id, key_id, key_name, kind, target_type, target_id, title, payload, created_at, expires_at,
      base_state, base_draft_revision, base_draft_markdown, base_draft_key_id)
    VALUES (?, ?, ?, ?, 'note_draft', 'note', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.ownerId, input.keyId, (key?.name ?? "MCP key").slice(0, 120) || "MCP key", input.noteId, proposalTitle(input.title), JSON.stringify(payload), timestamp,
      new Date(Date.parse(timestamp) + PROPOSAL_EXPIRE_MS).toISOString(), base.base_state, base.base_draft_revision, base.base_draft_markdown, base.base_draft_key_id);
  return id;
}

/** What rejecting a note_draft proposal does to the note (review H1), shown in the reject dialog. */
export type RejectEffect = "restore" | "discard" | "keep";

/**
 * Decides a note_draft reject from the note as it is now. While the draft is still exactly the
 * agent's revision, an earlier draft is restored, or, for a published note that had no draft
 * before, the agent's draft is discarded. Everything else keeps the draft as it is: a
 * never-published note (never binned on reject), a draft someone changed since, an unknown base
 * (proposals recorded before migration 027), or a reviewer who cannot write.
 */
export function rejectEffectFor(
  note: { draft_revision: number | null; current_version: number; deleted_at: string | null } | null,
  revision: number, base: Pick<ProposalBaseRow, "base_state" | "base_draft_markdown">, canWrite: boolean
): RejectEffect {
  if (!canWrite || !note || note.deleted_at !== null || note.draft_revision !== revision) return "keep";
  if (base.base_state === "draft") return base.base_draft_markdown !== null ? "restore" : "keep";
  if (base.base_state === "none" && note.current_version > 0) return "discard";
  return "keep";
}

export type DraftOutcome =
  /** The owner published the draft in the editor (or through an approved proposal). */
  | { kind: "published"; revision: number; userId: string }
  /** The owner discarded the draft. */
  | { kind: "discarded"; userId: string }
  /** The owner restored a version into the draft. */
  | { kind: "restored" };

/**
 * Resolves the note's pending `note_draft` proposals after the draft left the editor another way,
 * so the inbox never offers a draft that no longer exists. A proposal being applied right now
 * (`applying`) is left to its approve call. Call inside the note write's transaction.
 */
export function resolveNoteDraftProposals(noteId: string, outcome: DraftOutcome) {
  const timestamp = now();
  if (outcome.kind === "published") {
    db.query(`UPDATE proposals SET
        status = CASE WHEN json_extract(payload, '$.revision') = $revision THEN 'applied' ELSE 'superseded' END,
        result_code = CASE WHEN json_extract(payload, '$.revision') = $revision THEN 'PUBLISHED_IN_EDITOR' ELSE 'DRAFT_CHANGED' END,
        result_ref = CASE WHEN json_extract(payload, '$.revision') = $revision THEN $ref ELSE NULL END,
        reviewed_by = CASE WHEN json_extract(payload, '$.revision') = $revision THEN $userId ELSE NULL END,
        resolved_at = $timestamp
      WHERE kind = 'note_draft' AND target_type = 'note' AND target_id = $noteId AND status = 'pending'`)
      .run({ revision: outcome.revision, ref: JSON.stringify(noteRef(noteId)), userId: outcome.userId, timestamp, noteId });
    return;
  }
  if (outcome.kind === "discarded") {
    db.query(`UPDATE proposals SET status = 'rejected', result_code = 'DISCARDED_IN_EDITOR', reviewed_by = ?, resolved_at = ?
      WHERE kind = 'note_draft' AND target_type = 'note' AND target_id = ? AND status = 'pending'`).run(outcome.userId, timestamp, noteId);
    return;
  }
  db.query(`UPDATE proposals SET status = 'superseded', result_code = 'VERSION_RESTORED', resolved_at = ?
    WHERE kind = 'note_draft' AND target_type = 'note' AND target_id = ? AND status = 'pending'`).run(timestamp, noteId);
}

export const noteRef = (noteId: string) => ({ type: "note" as const, id: noteId, href: `/notes/${noteId}` });
