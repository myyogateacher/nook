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
 * Records the draft `keyId` just wrote as the note's pending `note_draft` proposal, superseding
 * any older pending one for the same note. Call inside the draft write's transaction.
 */
export function recordNoteDraftProposal(input: { ownerId: string; noteId: string; keyId: string; revision: number; created: boolean; title: string }) {
  const key = db.query("SELECT name FROM mcp_api_keys WHERE id = ?").get(input.keyId) as { name: string } | null;
  const timestamp = now();
  db.query(`UPDATE proposals SET status = 'superseded', result_code = 'NEWER_DRAFT', resolved_at = ?
    WHERE kind = 'note_draft' AND target_type = 'note' AND target_id = ? AND status = 'pending'`).run(timestamp, input.noteId);
  const id = crypto.randomUUID();
  const payload: NoteDraftPayload = { noteId: input.noteId, revision: input.revision, created: input.created };
  db.query(`INSERT INTO proposals (id, owner_id, key_id, key_name, kind, target_type, target_id, title, payload, created_at, expires_at)
    VALUES (?, ?, ?, ?, 'note_draft', 'note', ?, ?, ?, ?, ?)`)
    .run(id, input.ownerId, input.keyId, (key?.name ?? "MCP key").slice(0, 120) || "MCP key", input.noteId, proposalTitle(input.title), JSON.stringify(payload), timestamp,
      new Date(Date.parse(timestamp) + PROPOSAL_EXPIRE_MS).toISOString());
  return id;
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
