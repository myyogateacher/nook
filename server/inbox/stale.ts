import { db } from "../db";
import type { StoredProposal } from "./kinds";

/**
 * Whether a pending update proposal's target changed since the agent read it (QA v0.10.0 note 9):
 * the target's current revision is not the proposal's base revision, so approving would fail with
 * CARD_CHANGED, EVENT_CHANGED, ROW_CHANGED, or DRAFT_CHANGED. Read-only and advisory: approve and
 * reject keep their own checks. Only called once the viewer can read the target.
 */
const currentRevision = {
  card_update: db.query("SELECT revision FROM cards WHERE id = ?"),
  event_update: db.query("SELECT revision FROM events WHERE id = ?"),
  row_update: db.query("SELECT revision FROM collection_rows WHERE id = ?"),
  note_draft: db.query("SELECT draft_revision AS revision FROM notes WHERE id = ?")
} as const;

const targetKey: Record<keyof typeof currentRevision, [idField: string, baseField: string]> = {
  card_update: ["cardId", "baseRevision"],
  event_update: ["eventId", "baseRevision"],
  row_update: ["rowId", "baseRevision"],
  note_draft: ["noteId", "revision"]
};

export function proposalIsStale(proposal: StoredProposal): boolean {
  if (!(proposal.kind in currentRevision)) return false;
  const kind = proposal.kind as keyof typeof currentRevision;
  const [idField, baseField] = targetKey[kind];
  const id = proposal.payload[idField];
  const base = proposal.payload[baseField];
  if (typeof id !== "string" || typeof base !== "number") return false;
  const row = currentRevision[kind].get(id.toLowerCase()) as { revision: number | null } | null;
  return row !== null && row.revision !== base;
}
