import type { Migration } from "./types";

/**
 * Emoji reactions (WAVES_18-20_SMALL.md §3.3, D182–D190).
 *
 * - One generic table: `target_kind` names a kind registered in code (`server/reactions/targets.ts`;
 *   v1 has only `card_comment`), so a later module (Messages) adds its kind with no table rebuild.
 *   The DB constrains kinds and emoji keys by shape (`[a-z_]`), not by an enum (T153).
 * - The primary key allows one row per target × user × emoji and serves the per-target aggregate.
 * - Cleanup (D187): an AFTER DELETE trigger on `card_comments` removes the comment's reactions. It
 *   also fires for the FK cascade from a card or board purge. Each future kind adds its own trigger.
 *
 * Needs only 001 (users) and 009 (card_comments); independent of 018, 021, 023, and 024.
 * Transactional and filesystem-free.
 */
export const reactionsMigration: Migration = {
  id: 22,
  name: "reactions",
  up(db) {
    db.exec(`
      CREATE TABLE reactions (
        target_kind TEXT NOT NULL CHECK (length(target_kind) BETWEEN 1 AND 32 AND target_kind NOT GLOB '*[^a-z_]*'),
        target_id TEXT NOT NULL CHECK (length(target_id) = 36),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL CHECK (length(emoji) BETWEEN 1 AND 24 AND emoji NOT GLOB '*[^a-z_]*'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (target_kind, target_id, user_id, emoji)
      ) WITHOUT ROWID;
      CREATE INDEX idx_reactions_user ON reactions(user_id, created_at DESC);
      CREATE TRIGGER reactions_card_comment_cleanup AFTER DELETE ON card_comments
      BEGIN DELETE FROM reactions WHERE target_kind = 'card_comment' AND target_id = OLD.id; END;
    `);
  }
};
