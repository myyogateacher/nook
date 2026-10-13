import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrationIds, runMigrations } from "../server/migrations";
import { checkWords, rebuildGrantsForReports, reportsMigration } from "../server/migrations/050_reports";

/**
 * Migration 050 (analytics reports, Wave 45, T365): every table of the module, the schema FTS index
 * kept in step by triggers, one running run per report, and the api_key_grants rebuild that adds
 * `reports` / `report` while keeping every row, index, and trigger (the 039 pattern).
 */

const at = "2026-10-13T00:00:00.000Z";

function openDb() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

const schemaOf = (db: Database, type: "index" | "trigger") => (db.query("SELECT name, sql FROM sqlite_master WHERE type = ? AND tbl_name = 'api_key_grants' AND sql IS NOT NULL ORDER BY name").all(type) as Array<{ name: string; sql: string }>)
  .map((row) => ({ name: row.name, sql: row.sql.replace(/\s+/g, " ").trim() }));

function seed(db: Database) {
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'admin')").run(at);
  db.query("INSERT INTO report_datasources (id, name, url, username, database, allowlist_json, created_at, updated_at) VALUES ('ds1', 'Warehouse', 'https://ch.example.test', 'ro', 'analytics', '[\"analytics.*\"]', ?, ?)").run(at, at);
  db.query("INSERT INTO reports (id, owner_id, title, datasource_id, created_at, updated_at) VALUES ('r1', 'u1', 'Revenue', 'ds1', ?, ?)").run(at, at);
}

describe("migration 050 reports", () => {
  test("is registered after 048 (049 is reserved for Messages) and creates every table of the plan", () => {
    expect(registeredMigrationIds).toContain(50);
    expect(registeredMigrationIds).not.toContain(49);
    expect(registeredMigrationIds.indexOf(50)).toBe(registeredMigrationIds.indexOf(48) + 1);
    expect(reportsMigration.name).toBe("reports");
    const db = openDb();
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
    for (const table of ["report_datasources", "report_schema_tables", "report_schema_fts", "reports", "report_doc_snapshots", "report_queries", "report_runs", "report_results", "report_schedules"]) {
      expect({ table, found: tables.includes(table) }).toEqual({ table, found: true });
    }
    const resultColumns = (db.query("PRAGMA table_info(report_results)").all() as Array<{ name: string }>).map((row) => row.name);
    for (const column of ["sent_sql", "rows_read", "ch_query_id", "truncated", "error_code"]) expect(resultColumns).toContain(column);
    // A second run changes nothing.
    const before = db.query("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    db.transaction(() => reportsMigration.up(db))();
    expect(db.query("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
  });

  test("the schema FTS index follows inserts, updates, deletes, and a data source's cascade", () => {
    const db = openDb();
    seed(db);
    const insert = db.query("INSERT INTO report_schema_tables (datasource_id, db, name, comment, search_name, search_columns, synced_at) VALUES ('ds1', 'analytics', ?, ?, ?, ?, ?)");
    insert.run("orders", "One row per order", "analytics orders", "revenue net revenue in cents", at);
    insert.run("events", "Raw events", "analytics events", "event_name user_id", at);
    const hits = (query: string) => (db.query("SELECT t.name FROM report_schema_fts f JOIN report_schema_tables t ON t.id = f.rowid WHERE report_schema_fts MATCH ? ORDER BY rank").all(query) as Array<{ name: string }>).map((row) => row.name);
    expect(hits("revenue")).toEqual(["orders"]);
    db.query("UPDATE report_schema_tables SET search_columns = 'amount' WHERE name = 'orders'").run();
    expect(hits("revenue")).toEqual([]);
    expect(hits("amount")).toEqual(["orders"]);
    db.query("DELETE FROM report_schema_tables WHERE name = 'events'").run();
    expect(hits("events")).toEqual([]);
    // Deleting the data source cascades to its tables, and the FTS rows go with them.
    db.query("DELETE FROM reports").run();
    db.query("DELETE FROM report_datasources WHERE id = 'ds1'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM report_schema_tables").get()).toEqual({ count: 0 });
    expect(hits("amount")).toEqual([]);
    expect(db.query("INSERT INTO report_schema_fts (report_schema_fts) VALUES ('integrity-check')").run().changes).toBeGreaterThanOrEqual(0);
  });

  test("one running run per report; finished runs are not limited", () => {
    const db = openDb();
    seed(db);
    const run = db.query("INSERT INTO report_runs (id, report_id, kind, trigger, status, started_at) VALUES (?, 'r1', 'refresh', 'user', ?, ?)");
    run.run("run1", "running", at);
    expect(() => run.run("run2", "running", at)).toThrow();
    run.run("run3", "succeeded", at);
    run.run("run4", "failed", at);
    db.query("UPDATE report_runs SET status = 'succeeded' WHERE id = 'run1'").run();
    run.run("run5", "running", at);
    expect(() => run.run("run6", "queued", at)).toThrow();
    db.query("INSERT INTO report_results (id, run_id, report_id, query_key, sql, sent_sql, rows_read, ch_query_id, created_at) VALUES ('res1', 'run5', 'r1', 'revenue', 'SELECT 1', 'SELECT * FROM (SELECT 1) LIMIT 10001', 12, 'nook-run5-revenue', ?)").run(at);
    // Purging the report removes its runs and results.
    db.query("DELETE FROM reports WHERE id = 'r1'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM report_runs").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM report_results").get()).toEqual({ count: 0 });
  });

  test("CHECKs refuse bad values (status, Bin pairing, cadence, data source bounds)", () => {
    const db = openDb();
    seed(db);
    expect(() => db.query("UPDATE reports SET status = 'published' WHERE id = 'r1'").run()).toThrow();
    expect(() => db.query("UPDATE reports SET deleted_at = ? WHERE id = 'r1'").run(at)).toThrow();
    db.query("UPDATE reports SET deleted_at = ?, purge_after = ? WHERE id = 'r1'").run(at, at);
    expect(() => db.query("INSERT INTO report_schedules (report_id, cadence, tz, created_at, updated_at) VALUES ('r1', 'monthly', 'UTC', ?, ?)").run(at, at)).toThrow();
    db.query("INSERT INTO report_schedules (report_id, cadence, at_time, tz, created_at, updated_at) VALUES ('r1', 'daily', '09:30', 'UTC', ?, ?)").run(at, at);
    expect(() => db.query("UPDATE report_datasources SET max_rows = 1000000 WHERE id = 'ds1'").run()).toThrow();
    expect(() => db.query("UPDATE report_datasources SET allowlist_json = '{}' WHERE id = 'ds1'").run()).toThrow();
    expect(() => db.query("UPDATE report_datasources SET kind = 'postgres' WHERE id = 'ds1'").run()).toThrow();
  });

  test("the api_key_grants rebuild adds reports/report, keeps rows, indexes, and triggers, and purging a report removes its grants", () => {
    const db = openDb();
    const fresh = { triggers: schemaOf(db, "trigger"), indexes: schemaOf(db, "index") };
    expect(fresh.triggers).toHaveLength(6);
    expect(fresh.indexes).toHaveLength(2);
    const current = (db.query("SELECT sql FROM sqlite_master WHERE name = 'api_key_grants'").get() as { sql: string }).sql;
    // Every word 039 had stays; reports and report are added.
    for (const word of ["notes", "agents", "messages", "vault", "reports"]) expect(checkWords(current, "module")).toContain(word);
    for (const word of ["agent", "knowledge_base", "channel", "report"]) expect(checkWords(current, "resource_kind IS NULL OR resource_kind")).toContain(word);
    expect(checkWords(current, "permission")).toEqual(["read", "comment", "write", "draft", "publish", "create", "run", "post"]);

    seed(db);
    db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, created_at, scopes, kind) VALUES ('k1', 'u1', 'General', 'mynotes_aaaaaaaa', 'h1', ?, '[]', 'general')").run(at);
    const grant = db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, created_at) VALUES (?, 'k1', ?, ?, ?, ?, ?)");
    grant.run("g1", "notes", "read", null, null, at);
    grant.run("g2", "reports", "read", "report", "r1", at);
    grant.run("g3", "reports", "write", null, null, at);
    expect(() => grant.run("g4", "robots", "read", null, null, at)).toThrow();
    expect(() => grant.run("g5", "reports", "read", "dashboard", "r1", at)).toThrow();
    // The kind wall still holds.
    db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, created_at, scopes, kind, vault_protected_access) VALUES ('k2', 'u1', 'Vault', 'nkv_bbbbbbbbbbbb', 'h2', ?, '[]', 'vault', 0)").run(at);
    expect(() => db.query("INSERT INTO api_key_grants (id, key_id, module, permission, created_at) VALUES ('g6', 'k2', 'reports', 'read', ?)").run(at)).toThrow(/KEY_KIND_WALL/);

    // Re-running on the rebuilt shape changes nothing (idempotent).
    const rows = () => db.query("SELECT * FROM api_key_grants ORDER BY id").all();
    const before = rows();
    rebuildGrantsForReports(db);
    expect(rows()).toEqual(before);
    expect(schemaOf(db, "trigger")).toEqual(fresh.triggers);

    // Purging the report removes the grant that names it.
    db.query("DELETE FROM reports WHERE id = 'r1'").run();
    expect(db.query("SELECT id FROM api_key_grants ORDER BY id").all()).toEqual([{ id: "g1" }, { id: "g3" }]);
  });

  test("against the 039 shape (every migration but 050 applied) the rebuild keeps every row, index, and trigger", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (50, 'skipped', ?)").run(at);
    runMigrations(db);
    db.query("DELETE FROM schema_migrations WHERE id = 50").run();
    const before = { triggers: schemaOf(db, "trigger"), indexes: schemaOf(db, "index"), columns: db.query("PRAGMA table_info(api_key_grants)").all() };
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'admin')").run(at);
    db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, created_at, scopes, kind) VALUES ('k1', 'u1', 'General', 'mynotes_aaaaaaaa', 'h1', ?, '[]', 'general')").run(at);
    db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, created_at) VALUES ('g1', 'k1', 'agents', 'run', 'agent', 'a1', ?)").run(at);
    expect(() => db.query("INSERT INTO api_key_grants (id, key_id, module, permission, created_at) VALUES ('gx', 'k1', 'reports', 'read', ?)").run(at)).toThrow();
    const beforeRows = db.query("SELECT * FROM api_key_grants").all();
    runMigrations(db);
    expect(schemaOf(db, "trigger")).toEqual(before.triggers);
    expect(schemaOf(db, "index")).toEqual(before.indexes);
    expect(db.query("PRAGMA table_info(api_key_grants)").all()).toEqual(before.columns);
    expect(db.query("SELECT * FROM api_key_grants").all()).toEqual(beforeRows);
    expect(db.query("PRAGMA legacy_alter_table").get()).toEqual({ legacy_alter_table: 0 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.query("INSERT INTO api_key_grants (id, key_id, module, permission, created_at) VALUES ('gx', 'k1', 'reports', 'read', ?)").run(at);
  });
});
