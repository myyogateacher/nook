import { addColumn, type Migration } from "./types";

/**
 * Card priority (docs/plan/TASK_PRIORITY.md, D1310–D1311): `cards.priority` is NULL (no priority) or
 * one of low, medium, high, urgent. The Urgent flag becomes the Urgent priority: every card that
 * carries it gets `priority = 'urgent'`, and its `card_flags` row is dropped, so Blocked, Needs
 * review, and On hold stay the only flags. The `card_flags` CHECK still lists `urgent` (a 12-step
 * rebuild for a value nothing writes any more is not worth it); the server refuses to store it
 * (D1312 maps it to the priority instead).
 *
 * The cards' history is left as it was: old "flagged this Urgent" entries still read that way.
 * Saved views and links that filter by `flag:urgent` are read as `priority:urgent` by the grammar
 * (D1313), so their stored text needs no rewrite.
 *
 * Needs 015 (card_flags). 123–129 are this lane's block. Transactional and filesystem-free;
 * re-running changes nothing.
 */
export const cardPriorityMigration: Migration = {
  id: 123,
  name: "card_priority",
  up(db) {
    addColumn(db, "cards", "priority", "TEXT CHECK (priority IS NULL OR priority IN ('low','medium','high','urgent'))");
    db.exec(`
      UPDATE cards SET priority = 'urgent' WHERE priority IS NULL AND id IN (SELECT card_id FROM card_flags WHERE flag = 'urgent');
      DELETE FROM card_flags WHERE flag = 'urgent';
    `);
  }
};
