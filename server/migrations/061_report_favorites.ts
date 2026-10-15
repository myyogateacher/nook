import type { Migration } from "./types";

/**
 * Report favorites and the list at scale (report organization phase 1, docs/plan/REPORTS_ORG.md, D486).
 *
 * - `report_favorites`: a person's ★ on a report they can read. Their own shortcut, never a grant: every
 *   list reads it through `readableReportSql`, so a favorite drops out the moment access is lost (T393).
 *   Removing the person or purging the report removes it (cascade).
 * - `reports_status`: the live reports by status, for the status filter.
 * - `reports_live_recent`: the live reports newest change first, `(updated_at DESC, id)`, the order and
 *   the keyset of the paged list.
 *
 * Needs 050. Transactional and filesystem-free; re-running changes nothing.
 */
export const reportFavoritesMigration: Migration = {
  id: 61,
  name: "report_favorites",
  up(db) {
    // A database without 050 yet (tests that apply every migration but one) has no reports to star (053's rule).
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reports'").get()) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS report_favorites (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, report_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_favorites_report ON report_favorites(report_id);
      CREATE INDEX IF NOT EXISTS reports_status ON reports(status) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS reports_live_recent ON reports(updated_at DESC, id) WHERE deleted_at IS NULL;
    `);
  }
};
