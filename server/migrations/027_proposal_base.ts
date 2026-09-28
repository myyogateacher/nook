import { addColumn, type Migration } from "./types";

/**
 * The pre-agent base of a `note_draft` proposal (v0.10.0 review H1).
 *
 * An agent's draft write can build on a draft a person saved (append mode, or a replace over it).
 * Rejecting the proposal must then give that person's draft back, not discard it. So the proposal
 * records, when the agent writes, what the draft was just before:
 *
 * - `base_state`: `none` (no draft before the agent's write) or `draft` (a draft existed). NULL for
 *   proposals recorded before this migration: their base is unknown, and reject leaves the draft.
 * - `base_draft_revision`, `base_draft_markdown`, `base_draft_key_id`: that earlier draft's revision,
 *   exact text, and the MCP key that wrote it (NULL for a person's draft). The text is bounded by
 *   the draft size limit in code (MAX_MARKDOWN_BYTES) and cleared once the proposal resolves.
 *
 * Needs only 021. Transactional and filesystem-free. 023–026 belong to other plans.
 */
export const proposalBaseMigration: Migration = {
  id: 27,
  name: "proposal_base",
  up(db) {
    addColumn(db, "proposals", "base_state", "TEXT CHECK (base_state IS NULL OR base_state IN ('none','draft'))");
    addColumn(db, "proposals", "base_draft_revision", "INTEGER");
    addColumn(db, "proposals", "base_draft_markdown", "TEXT");
    addColumn(db, "proposals", "base_draft_key_id", "TEXT");
  }
};
