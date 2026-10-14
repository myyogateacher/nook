import type { Migration } from "./types";

const NEW_SETTING_KEYS = ["report_fallback_provider_id", "report_fallback_model"];

/** agent_settings with the fallback keys in its CHECK (053's rebuild pattern; a no-op when they are there or the table is missing). */
function addFallbackSettingKeys(db: import("bun:sqlite").Database) {
  const current = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_settings'").get() as { sql: string } | null)?.sql;
  if (!current) return;
  const missing = NEW_SETTING_KEYS.filter((key) => !current.includes(`'${key}'`));
  if (!missing.length) return;
  const check = /key TEXT PRIMARY KEY CHECK \(key IN \(([^)]*)\)\)/.exec(current);
  if (!check) throw new Error("Migration 058 cannot read agent_settings' key CHECK");
  const words = `${check[1]!.trimEnd()},${missing.map((key) => `'${key}'`).join(",")}`;
  const rebuilt = current.replace(check[0], `key TEXT PRIMARY KEY CHECK (key IN (${words}))`).replace(/CREATE TABLE (?:IF NOT EXISTS )?"?agent_settings"?/, "CREATE TABLE agent_settings_r058");
  const broken = db.query("PRAGMA foreign_key_check(agent_settings)").all() as Array<{ parent: string }>;
  if (broken.length) throw new Error(`Migration 058 cannot rebuild agent_settings: ${broken.length} row(s) reference a missing ${broken[0]!.parent} row (updated_by); clear those references and restart`);
  const columns = (db.query("PRAGMA table_info(agent_settings)").all() as Array<{ name: string }>).map((column) => `"${column.name}"`).join(", ");
  db.exec(rebuilt);
  db.exec(`INSERT INTO agent_settings_r058 (${columns}) SELECT ${columns} FROM agent_settings`);
  db.exec("DROP TABLE agent_settings");
  db.exec("ALTER TABLE agent_settings_r058 RENAME TO agent_settings");
}

/**
 * Reports, lane E (E4 and E5).
 *
 * - `report_metric_catalogs` keeps each version of a report's metric catalog: the doc snapshot and its
 *   SHA-256 it was extracted from, `source` (`extract`, the report model reading a new snapshot, or
 *   `edit`, the owner's change in the Metrics view), the metrics as JSON (at most 64 KiB), the run that
 *   extracted it, and who saved it. Owner-only, like the doc's snapshots; a version keeps working after
 *   its snapshot is pruned (`snapshot_id` is set NULL).
 * - `agent_settings` (039) fixes its keys in a CHECK: it gains `report_fallback_provider_id` and
 *   `report_fallback_model` ("Fallback model for reports", off while unset), rebuilt from its own
 *   CREATE text with every row copied (053's pattern; no children, triggers, or indexes).
 *
 * 054 stays reserved for the Messages module. Needs 039, 050, and 056. Transactional and
 * filesystem-free; re-running changes nothing.
 */
export const reportMetricCatalogMigration: Migration = {
  id: 58,
  name: "report_metric_catalog",
  up(db) {
    addFallbackSettingKeys(db);
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reports'").get()) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS report_metric_catalogs (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version >= 1),
        snapshot_id TEXT REFERENCES report_doc_snapshots(id) ON DELETE SET NULL,
        doc_sha256 TEXT NOT NULL CHECK (length(doc_sha256) = 64),
        source TEXT NOT NULL CHECK (source IN ('extract','edit')),
        metrics_json TEXT NOT NULL CHECK (json_valid(metrics_json) AND json_type(metrics_json) = 'array' AND length(metrics_json) <= 65536),
        run_id TEXT REFERENCES report_runs(id) ON DELETE SET NULL,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE (report_id, version)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_metric_catalogs_doc ON report_metric_catalogs(report_id, doc_sha256, version);
    `);
  }
};
