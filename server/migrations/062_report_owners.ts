import type { Migration } from "./types";

/**
 * Report organization phase 2 (docs/plan/REPORTS_ORG.md, D481–D483): several owners per report, and one
 * workspace-wide folder tree that only groups.
 *
 * - `report_owners`: the people who own a report (every owner has every owner right, D482). Each
 *   `reports.owner_id` is copied in. `reports.owner_id` stays as the report's **primary owner**: the
 *   creator until they leave the owners, always one of them (the triggers below add it on insert and on
 *   change), and the person scheduled refreshes and the edit agent run as. Removing the last owner is
 *   refused in code (T390). Purging the report removes its rows (cascade).
 * - `report_folders` is rebuilt without `owner_id`: a folder belongs to the workspace (D483), with
 *   `created_by` (the person who made it; SET NULL if that account is ever deleted, so a folder never
 *   disappears with its creator). Ids, names, parents, positions, and Bin columns move over unchanged;
 *   two people's top-level folders with the same name both stay (the UI names the creator, never a merge).
 *   The rebuild keeps every report's `folder_id` (the drop's SET NULL is undone from a copy).
 *
 * Needs 050 and 059. Transactional and filesystem-free; re-running changes nothing.
 */
export const reportOwnersMigration: Migration = {
  id: 62,
  name: "report_owners",
  up(db) {
    // A database without 050 yet (tests that apply every migration but one) has no reports to own (053's rule).
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reports'").get()) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS report_owners (
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (report_id, user_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_owners_user ON report_owners(user_id, report_id);
      INSERT OR IGNORE INTO report_owners (report_id, user_id, added_by, created_at) SELECT id, owner_id, owner_id, created_at FROM reports;
      CREATE TRIGGER IF NOT EXISTS reports_primary_owner_insert AFTER INSERT ON reports
      BEGIN INSERT OR IGNORE INTO report_owners (report_id, user_id, added_by, created_at) VALUES (NEW.id, NEW.owner_id, NEW.owner_id, NEW.created_at); END;
      CREATE TRIGGER IF NOT EXISTS reports_primary_owner_update AFTER UPDATE OF owner_id ON reports
      BEGIN INSERT OR IGNORE INTO report_owners (report_id, user_id, added_by, created_at) VALUES (NEW.id, NEW.owner_id, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;
    `);
    rebuildFoldersShared(db);
  }
};

function rebuildFoldersShared(db: Parameters<Migration["up"]>[0]) {
  const columns = (db.query("PRAGMA table_info(report_folders)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!columns.length || columns.includes("created_by")) return;
  db.exec(`
    CREATE TEMP TABLE report_folders_062 AS SELECT * FROM report_folders;
    CREATE TEMP TABLE report_files_062 AS SELECT id, folder_id FROM reports WHERE folder_id IS NOT NULL;
    DROP TABLE report_folders;
    CREATE TABLE report_folders (
      id TEXT PRIMARY KEY,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
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
    PRAGMA defer_foreign_keys = ON;
    INSERT INTO report_folders (id, created_by, parent_id, name, position, created_at, updated_at, deleted_at, deleted_by, purge_after, purge_started_at, binned_with, unfiled_json)
      SELECT id, owner_id, parent_id, name, position, created_at, updated_at, deleted_at, deleted_by, purge_after, purge_started_at, binned_with, unfiled_json FROM temp.report_folders_062;
    UPDATE reports SET folder_id = (SELECT f.folder_id FROM temp.report_files_062 f WHERE f.id = reports.id) WHERE id IN (SELECT id FROM temp.report_files_062);
    DROP TABLE temp.report_folders_062;
    DROP TABLE temp.report_files_062;
    CREATE INDEX IF NOT EXISTS report_folders_tree ON report_folders(parent_id, position) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS report_folders_parent ON report_folders(parent_id);
    CREATE INDEX IF NOT EXISTS report_folders_creator ON report_folders(created_by) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS report_folders_binned ON report_folders(purge_after) WHERE deleted_at IS NOT NULL;
  `);
}
