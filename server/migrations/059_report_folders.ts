import { addColumn, type Migration } from "./types";

/**
 * Report folders (Lane I): the owner's private organisation of their reports on the Reports home.
 *
 * - `report_folders`: a folder of one owner, nested up to three levels (`parent_id`), ordered among
 *   its siblings by `position`. Deleting a folder moves it, with its live subfolders, to the Bin for
 *   30 days: the folder deleted is the Bin item (`binned_with` NULL), its subfolders name it in
 *   `binned_with`. `unfiled_json` lists the reports the delete moved to Unfiled, so a restore puts back
 *   the ones still there. Purging a folder deletes its subfolders (cascade); reports are never deleted.
 * - `reports.folder_id`: the owner's folder for a report; NULL is "Unfiled". A purged folder leaves it NULL.
 *
 * Readers of a shared report see it under "Shared with me"; the folder stays the owner's.
 * Needs 050. Transactional and filesystem-free; re-running changes nothing.
 */
export const reportFoldersMigration: Migration = {
  id: 59,
  name: "report_folders",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS report_folders (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES report_folders(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        purge_after TEXT,
        purge_started_at TEXT,
        binned_with TEXT,
        unfiled_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(unfiled_json) AND json_type(unfiled_json) = 'array'),
        CHECK ((deleted_at IS NULL) = (purge_after IS NULL)),
        CHECK (parent_id IS NULL OR parent_id <> id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_folders_owner ON report_folders(owner_id, parent_id, position) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS report_folders_parent ON report_folders(parent_id);
      CREATE INDEX IF NOT EXISTS report_folders_binned ON report_folders(purge_after) WHERE deleted_at IS NOT NULL;
    `);
    // A database without 050 yet (tests that apply every migration but one) has no reports table to extend (053's rule).
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reports'").get()) return;
    addColumn(db, "reports", "folder_id", "TEXT REFERENCES report_folders(id) ON DELETE SET NULL");
    db.exec("CREATE INDEX IF NOT EXISTS reports_folder ON reports(folder_id) WHERE folder_id IS NOT NULL");
  }
};
