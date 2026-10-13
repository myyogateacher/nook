import type { Migration } from "./types";

/**
 * Analytics reports (Wave 45, docs/plan/WAVES_45-48_REPORTS.md, D410–D429, T355–T366). The plan named
 * this `049_reports`; 049 is reserved for the Messages module, so it is 050, and 051 is reserved for
 * wave 48 (`report_instructions`, `report_versions`). One migration creates every table waves 45–47 use,
 * so those waves add behaviour only:
 *
 * - `report_datasources`: admin-configured ClickHouse endpoints. The password is an AES-256-GCM
 *   envelope under AGENT_SECRETS_KEY (`server/agents/secrets.ts`, owner `datasource`); the allowlist is
 *   a JSON array of `db.table` globs.
 * - `report_schema_tables` and `report_schema_fts`: the cached warehouse layout per data source (one
 *   row per allowlisted table, its columns as JSON) and an FTS5 index over table names, table comments,
 *   column names, and column comments, kept in step by triggers.
 * - `reports`: owner, title, data source, the doc it came from (wave 46), the spec (`shared/reports.ts`),
 *   status, and the Bin columns. `visibility` is there for wave 48's view-only sharing.
 * - `report_doc_snapshots`, `report_queries`, `report_runs` (one running run per report: a partial
 *   unique index), `report_results` (with `sent_sql`, `rows_read`, `ch_query_id`), `report_schedules`.
 *
 * `api_key_grants` (025) fixes its words in CHECK constraints, so it is rebuilt once more (the 039
 * pattern: every row and column copied, both indexes and all six triggers re-created verbatim) with the
 * module word `reports` and the resource kind `report` added to whatever words the table holds now (a
 * Messages migration that ran first keeps its own).
 *
 * Needs 001, 025, 038, and 039. Transactional and filesystem-free; re-running changes nothing.
 */
export const reportsMigration: Migration = {
  id: 50,
  name: "reports",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS report_datasources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
        kind TEXT NOT NULL DEFAULT 'clickhouse' CHECK (kind IN ('clickhouse')),
        url TEXT NOT NULL CHECK (length(url) BETWEEN 8 AND 512),
        username TEXT NOT NULL CHECK (length(username) BETWEEN 1 AND 128),
        password_ct TEXT,
        database TEXT NOT NULL DEFAULT 'default' CHECK (length(database) BETWEEN 1 AND 128),
        allowlist_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowlist_json) AND json_type(allowlist_json) = 'array' AND length(allowlist_json) <= 16384),
        max_rows INTEGER NOT NULL DEFAULT 10000 CHECK (max_rows BETWEEN 1 AND 100000),
        timeout_s INTEGER NOT NULL DEFAULT 20 CHECK (timeout_s BETWEEN 1 AND 120),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        schema_synced_at TEXT,
        schema_table_count INTEGER NOT NULL DEFAULT 0,
        schema_truncated INTEGER NOT NULL DEFAULT 0 CHECK (schema_truncated IN (0,1)),
        schema_error TEXT CHECK (schema_error IS NULL OR length(schema_error) <= 500),
        revision INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS report_schema_tables (
        id INTEGER PRIMARY KEY,
        datasource_id TEXT NOT NULL REFERENCES report_datasources(id) ON DELETE CASCADE,
        db TEXT NOT NULL,
        name TEXT NOT NULL,
        engine TEXT NOT NULL DEFAULT '',
        partition_key TEXT NOT NULL DEFAULT '',
        sorting_key TEXT NOT NULL DEFAULT '',
        primary_key TEXT NOT NULL DEFAULT '',
        total_rows INTEGER,
        total_bytes INTEGER,
        comment TEXT NOT NULL DEFAULT '',
        columns_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(columns_json)),
        -- What the FTS index reads: "db name" and the column names and comments as one text.
        search_name TEXT NOT NULL DEFAULT '',
        search_columns TEXT NOT NULL DEFAULT '',
        synced_at TEXT NOT NULL,
        UNIQUE (datasource_id, db, name)
      ) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS report_schema_fts USING fts5(search_name, comment, search_columns,
        content='report_schema_tables', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS report_schema_tables_fts_insert AFTER INSERT ON report_schema_tables
      BEGIN
        INSERT INTO report_schema_fts (rowid, search_name, comment, search_columns) VALUES (NEW.id, NEW.search_name, NEW.comment, NEW.search_columns);
      END;
      CREATE TRIGGER IF NOT EXISTS report_schema_tables_fts_delete AFTER DELETE ON report_schema_tables
      BEGIN
        INSERT INTO report_schema_fts (report_schema_fts, rowid, search_name, comment, search_columns) VALUES ('delete', OLD.id, OLD.search_name, OLD.comment, OLD.search_columns);
      END;
      CREATE TRIGGER IF NOT EXISTS report_schema_tables_fts_update AFTER UPDATE OF search_name, comment, search_columns ON report_schema_tables
      BEGIN
        INSERT INTO report_schema_fts (report_schema_fts, rowid, search_name, comment, search_columns) VALUES ('delete', OLD.id, OLD.search_name, OLD.comment, OLD.search_columns);
        INSERT INTO report_schema_fts (rowid, search_name, comment, search_columns) VALUES (NEW.id, NEW.search_name, NEW.comment, NEW.search_columns);
      END;

      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        datasource_id TEXT REFERENCES report_datasources(id) ON DELETE SET NULL,
        doc_server_id TEXT REFERENCES agent_tool_servers(id) ON DELETE SET NULL,
        doc_tool TEXT CHECK (doc_tool IS NULL OR length(doc_tool) <= 128),
        doc_ref TEXT CHECK (doc_ref IS NULL OR length(doc_ref) <= 2048),
        doc_hash TEXT CHECK (doc_hash IS NULL OR length(doc_hash) = 64),
        spec_json TEXT NOT NULL DEFAULT '{"version":1,"blocks":[],"queries":[]}' CHECK (json_valid(spec_json) AND length(spec_json) <= 524288),
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','stale','error')),
        last_run_at TEXT,
        last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 1000),
        visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','selected','all_users')),
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        purge_after TEXT,
        purge_started_at TEXT,
        CHECK ((deleted_at IS NULL) = (purge_after IS NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS reports_owner ON reports(owner_id, updated_at DESC) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS reports_binned ON reports(purge_after) WHERE deleted_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS reports_datasource ON reports(datasource_id);

      CREATE TABLE IF NOT EXISTS report_doc_snapshots (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        title TEXT CHECK (title IS NULL OR length(title) <= 500),
        markdown TEXT NOT NULL CHECK (length(CAST(markdown AS BLOB)) <= 524288),
        fetched_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_doc_snapshots_report ON report_doc_snapshots(report_id, fetched_at DESC);

      CREATE TABLE IF NOT EXISTS report_queries (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 40),
        sql TEXT NOT NULL CHECK (length(sql) BETWEEN 1 AND 20000),
        purpose TEXT NOT NULL DEFAULT '' CHECK (length(purpose) <= 300),
        columns_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(columns_json)),
        created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('agent','user')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (report_id, key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS report_runs (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('generate','refresh','edit')),
        trigger TEXT NOT NULL CHECK (trigger IN ('user','schedule','mcp')),
        agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','partial','failed','abandoned')),
        query_keys_json TEXT CHECK (query_keys_json IS NULL OR json_valid(query_keys_json)),
        lease_until TEXT,
        error TEXT CHECK (error IS NULL OR length(error) <= 1000),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;
      -- One running run per report: a refresh and an edit never overlap (wave 47's 409 RUN_IN_PROGRESS).
      CREATE UNIQUE INDEX IF NOT EXISTS report_runs_one_running ON report_runs(report_id) WHERE status = 'running';
      CREATE INDEX IF NOT EXISTS report_runs_report ON report_runs(report_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS report_runs_lease ON report_runs(lease_until) WHERE status = 'running';

      CREATE TABLE IF NOT EXISTS report_results (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES report_runs(id) ON DELETE CASCADE,
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        query_key TEXT NOT NULL CHECK (length(query_key) BETWEEN 1 AND 40),
        sql TEXT NOT NULL,
        sent_sql TEXT,
        columns_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(columns_json)),
        rows_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(rows_json) AND length(rows_json) <= 2097152),
        row_count INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
        rows_read INTEGER,
        bytes_read INTEGER,
        ch_query_id TEXT CHECK (ch_query_id IS NULL OR length(ch_query_id) <= 128),
        ms INTEGER,
        error TEXT CHECK (error IS NULL OR length(error) <= 2000),
        error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
        created_at TEXT NOT NULL,
        UNIQUE (run_id, query_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_results_latest ON report_results(report_id, query_key, created_at DESC);

      CREATE TABLE IF NOT EXISTS report_schedules (
        report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
        cadence TEXT NOT NULL CHECK (cadence IN ('manual','hourly','daily','weekdays','weekly')),
        at_time TEXT CHECK (at_time IS NULL OR at_time GLOB '[0-2][0-9]:[0-5][0-9]'),
        weekday INTEGER CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
        tz TEXT NOT NULL CHECK (length(tz) BETWEEN 1 AND 64),
        next_due_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
        fail_count INTEGER NOT NULL DEFAULT 0,
        last_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_schedules_due ON report_schedules(next_due_at) WHERE enabled = 1;

      -- Purging a report (a hard DELETE; the Bin keeps rows) removes the key grants that name it (T206 parity).
      CREATE TRIGGER IF NOT EXISTS reports_purge_access_grants AFTER DELETE ON reports
      BEGIN
        DELETE FROM api_key_grants WHERE resource_kind = 'report' AND resource_id = OLD.id;
      END;
    `);

    rebuildGrantsForReports(db);
  }
};

/** The words this migration adds to `api_key_grants`' CHECK lists. */
export const REPORT_GRANT_WORDS = { module: ["reports"], permission: [] as string[], resourceKind: ["report"] } as const;

const quoted = (words: readonly string[]) => words.map((word) => `'${word}'`).join(",");

/** The quoted words of one `<column> IN (…)` list in a CREATE TABLE statement. */
export function checkWords(sql: string, column: string): string[] {
  const match = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`).exec(sql);
  return match ? [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((item) => item[1]!) : [];
}

const union = (current: readonly string[], added: readonly string[]) => [...current, ...added.filter((word) => !current.includes(word))];

/**
 * The 12-step rebuild of `api_key_grants` (039's `rebuildApiKeyGrants`, copied: released migrations
 * are append-only) with `reports` and `report` added to the words the table holds now. Idempotent:
 * skipped once the table accepts `reports`.
 */
export function rebuildGrantsForReports(db: Parameters<Migration["up"]>[0]) {
  const current = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_key_grants'").get() as { sql: string } | null)?.sql ?? "";
  if (!current || /'reports'/.test(current)) return;
  const modules = union(checkWords(current, "module"), REPORT_GRANT_WORDS.module);
  const permissions = union(checkWords(current, "permission"), REPORT_GRANT_WORDS.permission);
  const kinds = union(checkWords(current, "resource_kind IS NULL OR resource_kind"), REPORT_GRANT_WORDS.resourceKind);
  const columns = (db.query("PRAGMA table_info(api_key_grants)").all() as Array<{ name: string }>).map((column) => column.name);
  const protectedSource = columns.includes("protected_at_grant") ? "protected_at_grant" : "0";
  const keyColumns = (db.query("PRAGMA table_info(mcp_api_keys)").all() as Array<{ name: string }>).map((column) => column.name);
  const with038 = keyColumns.includes("vault_protected_access");
  db.exec(`
    CREATE TABLE api_key_grants_new (
      id TEXT PRIMARY KEY,
      key_id TEXT NOT NULL REFERENCES mcp_api_keys(id) ON DELETE CASCADE,
      module TEXT NOT NULL CHECK (module IN (${quoted(modules)})),
      permission TEXT NOT NULL CHECK (permission IN (${quoted(permissions)})),
      resource_kind TEXT CHECK (resource_kind IS NULL OR resource_kind IN (${quoted(kinds)})),
      resource_id TEXT CHECK (resource_id IS NULL OR length(resource_id) <= 64),
      env_id TEXT CHECK (env_id IS NULL OR length(env_id) <= 64),
      created_at TEXT NOT NULL,
      protected_at_grant INTEGER NOT NULL DEFAULT 0 CHECK (protected_at_grant IN (0,1)),
      CHECK ((resource_kind IS NULL) = (resource_id IS NULL)),
      CHECK (env_id IS NULL OR module = 'vault')
    );
    INSERT INTO api_key_grants_new (id, key_id, module, permission, resource_kind, resource_id, env_id, created_at, protected_at_grant)
      SELECT id, key_id, module, permission, resource_kind, resource_id, env_id, created_at, ${protectedSource} FROM api_key_grants;
    DROP TABLE api_key_grants;
    -- Triggers on other tables name this table; the rename runs in legacy mode so nothing outside it is rewritten (039).
    PRAGMA legacy_alter_table = ON;
    ALTER TABLE api_key_grants_new RENAME TO api_key_grants;
    PRAGMA legacy_alter_table = OFF;

    CREATE UNIQUE INDEX IF NOT EXISTS api_key_grant_unique ON api_key_grants(key_id, module, permission,
      COALESCE(resource_kind, '*'), COALESCE(resource_id, '*'), COALESCE(env_id, '*'));
    CREATE INDEX IF NOT EXISTS api_key_grants_resource ON api_key_grants(resource_kind, resource_id) WHERE resource_id IS NOT NULL;

    -- 025: the kind wall (D264).
    CREATE TRIGGER IF NOT EXISTS api_key_grants_kind_wall BEFORE INSERT ON api_key_grants
    WHEN (NEW.module = 'vault') IS NOT (SELECT kind = 'vault' FROM mcp_api_keys WHERE id = NEW.key_id)
    BEGIN SELECT RAISE(ABORT, 'KEY_KIND_WALL'); END;
    CREATE TRIGGER IF NOT EXISTS api_key_grants_kind_wall_update BEFORE UPDATE OF key_id, module ON api_key_grants
    WHEN (NEW.module = 'vault') IS NOT (SELECT kind = 'vault' FROM mcp_api_keys WHERE id = NEW.key_id)
    BEGIN SELECT RAISE(ABORT, 'KEY_KIND_WALL'); END;
  `);
  if (!with038) return;
  db.exec(`
    -- 038: the vault grant shape and the protected flag.
    CREATE TRIGGER IF NOT EXISTS api_key_grants_vault_shape BEFORE INSERT ON api_key_grants
    WHEN NEW.module = 'vault' AND (SELECT kind FROM mcp_api_keys WHERE id = NEW.key_id) = 'vault' AND (
      NEW.resource_kind IS NOT 'vault' OR NEW.resource_id IS NULL OR NEW.permission NOT IN ('read', 'write')
      OR (NEW.env_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vault_environments e WHERE e.id = NEW.env_id AND e.vault_id = NEW.resource_id))
      OR (NEW.protected_at_grant = 1 AND (NEW.env_id IS NULL OR (SELECT vault_protected_access FROM mcp_api_keys WHERE id = NEW.key_id) IS NOT 1))
    )
    BEGIN SELECT RAISE(ABORT, 'VAULT_GRANT_SHAPE'); END;
    CREATE TRIGGER IF NOT EXISTS api_key_grants_protected_vault_only BEFORE INSERT ON api_key_grants
    WHEN NEW.protected_at_grant = 1 AND NEW.module IS NOT 'vault'
    BEGIN SELECT RAISE(ABORT, 'VAULT_GRANT_SHAPE'); END;
    CREATE TRIGGER IF NOT EXISTS api_key_grants_protected_vault_only_update BEFORE UPDATE OF protected_at_grant ON api_key_grants
    WHEN NEW.protected_at_grant = 1 AND NEW.module IS NOT 'vault'
    BEGIN SELECT RAISE(ABORT, 'VAULT_GRANT_SHAPE'); END;
    CREATE TRIGGER IF NOT EXISTS api_key_grants_vault_shape_update BEFORE UPDATE ON api_key_grants
    WHEN NEW.module = 'vault'
    BEGIN SELECT RAISE(ABORT, 'VAULT_GRANT_SHAPE'); END;
  `);
}
