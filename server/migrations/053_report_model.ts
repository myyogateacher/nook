import { addColumn, type Migration } from "./types";

/**
 * Analytics reports, wave 48b (docs/plan/REPORT_THEME.md § Model setting, D435): the admin's "Report
 * generation model" and a report's own override of it.
 *
 * - `agent_settings` (039) fixes its keys in a CHECK; it gains `report_provider_id` and
 *   `report_model`. The table has no children, triggers, or indexes beyond its key, so it is rebuilt
 *   from its own CREATE text with the two words added to whatever words it holds now, every row copied.
 * - `reports.model_provider_id`: an `agent_providers` id, or NULL (the setting's provider). Not a
 *   foreign key on purpose: `agent_providers` stays free to be rebuilt without dragging `reports` into
 *   its family, and a provider that is gone simply reads as no override (server/reports/model.ts).
 * - `reports.model`: a model id, or NULL (the provider's default model).
 *
 * 052 is reserved for reports wave 48 (report_instructions, report_versions); runMigrations applies
 * each missing id on its own, so this may land before it. The Messages module moves to 054.
 *
 * Needs 039 and 050. Transactional and filesystem-free; re-running changes nothing.
 */

const NEW_KEYS = ["report_provider_id", "report_model"];

/** agent_settings with the report model keys in its CHECK (a no-op when they are there or the table is missing). */
export function addReportSettingKeys(db: import("bun:sqlite").Database) {
  const current = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_settings'").get() as { sql: string } | null)?.sql;
  if (!current) return;
  const missing = NEW_KEYS.filter((key) => !current.includes(`'${key}'`));
  if (!missing.length) return;
  const check = /key TEXT PRIMARY KEY CHECK \(key IN \(([^)]*)\)\)/.exec(current);
  if (!check) throw new Error("Migration 053 cannot read agent_settings' key CHECK");
  const words = `${check[1]!.trimEnd()},${missing.map((key) => `'${key}'`).join(",")}`;
  const rebuilt = current.replace(check[0], `key TEXT PRIMARY KEY CHECK (key IN (${words}))`).replace(/CREATE TABLE (?:IF NOT EXISTS )?"?agent_settings"?/, "CREATE TABLE agent_settings_r053");
  const columns = (db.query("PRAGMA table_info(agent_settings)").all() as Array<{ name: string }>).map((column) => `"${column.name}"`).join(", ");
  db.exec(rebuilt);
  db.exec(`INSERT INTO agent_settings_r053 (${columns}) SELECT ${columns} FROM agent_settings`);
  db.exec("DROP TABLE agent_settings");
  db.exec("ALTER TABLE agent_settings_r053 RENAME TO agent_settings");
}

export const reportModelMigration: Migration = {
  id: 53,
  name: "report_model",
  up(db) {
    addReportSettingKeys(db);
    // A database without 050 yet (tests that apply every migration but one) has no reports table to extend.
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reports'").get()) return;
    addColumn(db, "reports", "model_provider_id", "TEXT CHECK (model_provider_id IS NULL OR length(model_provider_id) BETWEEN 1 AND 64)");
    addColumn(db, "reports", "model", "TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 200)");
  }
};
