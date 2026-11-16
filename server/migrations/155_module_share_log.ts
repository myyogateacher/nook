import type { Migration } from "./types";

/**
 * Module sharing in the digest (docs/plan/WORKSPACE_MODULES.md §B.9, D1366): `mail_share_log` (028)
 * also takes the workspace modules' containers, so a form, time project, goal, standup, contact book,
 * booking type, or townhall shared with someone by name shows in their digest's "Shared with you", as
 * notes and boards do. The CHECK is widened by the 12-step rebuild (same columns, rows, and index).
 *
 * Needs 028. 155–159 are this lane's block. Transactional and filesystem-free; re-running changes nothing.
 */
const KINDS = ["note", "folder", "file", "board", "calendar", "collection", "view", "form", "time_project", "goal", "checkin", "contact_book", "booking_type", "townhall_session"];

export const moduleShareLogMigration: Migration = {
  id: 155,
  name: "module_share_log",
  up(db) {
    const sql = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mail_share_log'").get() as { sql: string } | null)?.sql ?? "";
    if (!sql || sql.includes("'townhall_session'")) return;
    // Copied out and back rather than renamed: ALTER TABLE … RENAME re-reads every trigger in the schema,
    // and a database built without some tables (the migration tests') has triggers naming them.
    const columns = "id, user_id, kind, item_id, actor_id, created_at";
    const create = (name: string) => `CREATE TABLE ${name} (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN (${KINDS.map((kind) => `'${kind}'`).join(",")})),
        item_id TEXT NOT NULL CHECK (length(item_id) = 36),
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      )`;
    db.exec(`
      CREATE TEMP TABLE mail_share_log_155 AS SELECT ${columns} FROM mail_share_log;
      DROP TABLE mail_share_log;
      ${create("mail_share_log")};
      INSERT INTO mail_share_log (${columns}) SELECT ${columns} FROM mail_share_log_155;
      DROP TABLE mail_share_log_155;
      CREATE INDEX IF NOT EXISTS idx_mail_share_log_user ON mail_share_log(user_id, created_at);
    `);
  }
};
