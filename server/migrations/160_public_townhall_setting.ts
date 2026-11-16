import type { Migration } from "./types";
import { inListWords, rebuildTable, tableSql, widenInList } from "./rebuild";

/**
 * "Public townhall links" (D1382): a workspace setting of its own, `team_settings` key
 * `public_townhall`. Before, a townhall session's audience link fell under "Public forms and polls"
 * (server/public/links.ts), a switch whose name and help never mentioned Townhall.
 *
 * Upgrades change nothing: when an admin had stored `public_forms`, its value is copied to
 * `public_townhall`, so a workspace that had turned public forms off keeps its audience links off;
 * with no stored row both read the default (on, §G.1 Q2). The key's CHECK list is widened by the
 * 12-step rebuild (rows, indexes, and triggers kept, the row count verified).
 *
 * Needs 025 and 085 (team_settings and its workspace keys). 160–164 are this lane's block.
 * Transactional and filesystem-free; re-running changes nothing (the widen checks for its word, and
 * the copy is INSERT OR IGNORE).
 */
export const PUBLIC_TOWNHALL_KEY = "public_townhall";

export const publicTownhallSettingMigration: Migration = {
  id: 160,
  name: "public_townhall_setting",
  up(db) {
    const current = tableSql(db, "team_settings");
    if (!current) return;
    if (!inListWords(current, "key").includes(PUBLIC_TOWNHALL_KEY)) rebuildTable(db, "team_settings", widenInList(current, "key", [PUBLIC_TOWNHALL_KEY]));
    db.query(`INSERT OR IGNORE INTO team_settings (key, value_json, revision, updated_by, updated_at)
      SELECT ?, value_json, 1, updated_by, updated_at FROM team_settings WHERE key = 'public_forms'`).run(PUBLIC_TOWNHALL_KEY);
  }
};
