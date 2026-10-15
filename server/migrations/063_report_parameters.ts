import type { Migration } from "./types";

/**
 * Interactive report parameters (spec v3, D489): a date range and filters a reader changes on the
 * report page, which re-run its queries with typed ClickHouse query parameters.
 *
 * - `report_results.params_json`: the parameters a stored result was run with (`name` → value as sent),
 *   so the inspect panel shows the bound values beside the SQL as sent. NULL for results without any.
 *   The default set's results stay in `report_results` (Refresh all and schedules run the defaults).
 * - `report_param_sets`: a non-default set of values one reader asked for, keyed by the sha256 of its
 *   canonical bound values (`set_hash`), with when it was last used. Sets are pruned (the 20 most
 *   recently used per report; none unused for 7 days), and their results go with them (cascade).
 * - `report_param_results`: one result per query per set (replaced on each run of the set), shared
 *   by everyone who can read the report.
 * - `report_param_options`: a select's options, from its guarded options query, per report and
 *   parameter (at most 200 values).
 *
 * Needs 050. Transactional and filesystem-free; re-running changes nothing.
 */
export const reportParametersMigration: Migration = {
  id: 63,
  name: "report_parameters",
  up(db) {
    // A database without 050 yet (tests that apply every migration but one) has no reports (053's rule).
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reports'").get()) return;
    const columns = db.query("PRAGMA table_info(report_results)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "params_json")) {
      db.exec("ALTER TABLE report_results ADD COLUMN params_json TEXT CHECK (params_json IS NULL OR json_valid(params_json))");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS report_param_sets (
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        set_hash TEXT NOT NULL CHECK (length(set_hash) = 64),
        values_json TEXT NOT NULL CHECK (json_valid(values_json) AND length(values_json) <= 32768),
        bound_json TEXT NOT NULL CHECK (json_valid(bound_json) AND length(bound_json) <= 32768),
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        PRIMARY KEY (report_id, set_hash)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_param_sets_used ON report_param_sets(report_id, last_used_at DESC);
      CREATE TABLE IF NOT EXISTS report_param_results (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL,
        set_hash TEXT NOT NULL,
        query_key TEXT NOT NULL CHECK (length(query_key) BETWEEN 1 AND 40),
        sql TEXT NOT NULL,
        sent_sql TEXT,
        params_json TEXT CHECK (params_json IS NULL OR json_valid(params_json)),
        columns_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(columns_json)),
        rows_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(rows_json) AND length(rows_json) <= 2097152),
        row_count INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
        rows_read INTEGER,
        bytes_read INTEGER,
        ch_query_id TEXT,
        ms INTEGER,
        error TEXT CHECK (error IS NULL OR length(error) <= 2000),
        error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
        created_at TEXT NOT NULL,
        UNIQUE (report_id, set_hash, query_key),
        FOREIGN KEY (report_id, set_hash) REFERENCES report_param_sets(report_id, set_hash) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS report_param_options (
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        param_id TEXT NOT NULL CHECK (length(param_id) BETWEEN 1 AND 30),
        sql TEXT NOT NULL,
        values_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(values_json) AND length(values_json) <= 65536),
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
        error TEXT CHECK (error IS NULL OR length(error) <= 1000),
        created_at TEXT NOT NULL,
        PRIMARY KEY (report_id, param_id)
      ) STRICT;
    `);
  }
};
