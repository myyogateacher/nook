import type { Migration } from "./types";

/**
 * Per-person levels go live (Wave 32, access plan D272, T145). Migration 025 backfilled
 * `collection_members.level` and `calendar_members.level` from each item's audience-wide
 * `share_role`, but until Wave 32 the sharing routes still inserted member rows without a level,
 * so people shared with as editors after 025 have `view` rows (the level was not read then; the
 * `share_role` was). Wave 32 reads the level, so those rows are brought in line once here, before
 * any Access sheet can have set a level on purpose: a `view` member of a collection or calendar
 * whose `share_role` is `editor` becomes `edit`. Nobody gains or loses a power at the upgrade.
 *
 * Boards need nothing (their member rows default to `edit`, D38); notes, folders, and files read
 * only. Needs 012, 013, and 025. Transactional and filesystem-free.
 */
export const accessLevelsMigration: Migration = {
  id: 29,
  name: "access_levels",
  up(db) {
    db.exec(`
      UPDATE collection_members SET level = 'edit'
        WHERE level = 'view' AND (SELECT share_role FROM collections c WHERE c.id = collection_id) = 'editor';
      UPDATE calendar_members SET level = 'edit'
        WHERE level = 'view' AND (SELECT share_role FROM calendars k WHERE k.id = calendar_id) = 'editor';
    `);
  }
};
