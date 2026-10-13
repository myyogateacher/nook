import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrationIds, registeredMigrations, runMigrations } from "../server/migrations";
import { agentRunsFamily, reportRunsViaMigration } from "../server/migrations/051_report_runs_via";
import { UNDO_RECORD_TRIGGERS } from "../server/migrations/049_attachment_undo_records";

/**
 * Migration 051 (reports wave 46, D424): `agent_runs.via` gains `reports` by a rebuild of agent_runs
 * and every table that references it, with every row kept (children are never cascaded away), every
 * index and trigger re-created, the shape trigger taught `reports` (no key, no chat), and
 * `reports.doc_arg` added. Re-running changes nothing.
 */

const at = "2026-10-13T00:00:00.000Z";

function openDb(upTo = Number.POSITIVE_INFINITY) {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  if (upTo === Number.POSITIVE_INFINITY) runMigrations(db);
  else {
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of registeredMigrations.filter((item) => item.id <= upTo)) {
      db.transaction(() => {
        migration.up(db);
        db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, at);
      })();
    }
  }
  return db;
}

const schema = (db: Database, tables: string[]) => (db.query(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name IN (${tables.map(() => "?").join(",")}) AND sql IS NOT NULL ORDER BY type, name`).all(...tables) as Array<{ type: string; name: string; tbl_name: string; sql: string }>)
  .map((row) => ({ ...row, sql: row.sql.replace(/\s+/g, " ").trim() }));

function seed(db: Database) {
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'admin')").run(at);
  db.query("INSERT INTO report_datasources (id, name, url, username, database, allowlist_json, created_at, updated_at) VALUES ('ds1', 'Warehouse', 'https://ch.example.test', 'ro', 'analytics', '[\"analytics.*\"]', ?, ?)").run(at, at);
  db.query("INSERT INTO reports (id, owner_id, title, datasource_id, created_at, updated_at) VALUES ('r1', 'u1', 'Revenue', 'ds1', ?, ?)").run(at, at);
  db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, created_at) VALUES ('k1', 'u1', 'Key', 'mynotes_aaaaaaaa', 'hash', ?)").run(at);
  const run = db.query(`INSERT INTO agent_runs (id, via, agent_id, agent_revision, prompt_sha256, preamble_version, user_id, key_id, model, status, queued_at, finished_at)
    VALUES (?, 'api', 'a1', 1, 'sha', 1, 'u1', 'k1', 'm', 'ok', ?, ?)`);
  run.run("run-api", at, at);
  db.query("INSERT INTO agent_audit_entries (run_id, input_text, output_text) VALUES ('run-api', 'in', 'out')").run();
  db.query("INSERT INTO agent_audit_steps (run_id, seq, kind, text, duration_ms) VALUES ('run-api', 1, 'model', 'hello', 5)").run();
  db.query("INSERT INTO report_runs (id, report_id, kind, trigger, agent_run_id, status, started_at) VALUES ('rr1', 'r1', 'generate', 'user', 'run-api', 'succeeded', ?)").run(at);
  db.query("INSERT INTO report_results (id, run_id, report_id, query_key, sql, created_at) VALUES ('res1', 'rr1', 'r1', 'q', 'SELECT 1', ?)").run(at);
}

describe("migration 051 report_runs_via", () => {
  test("registered after 050; 052 (wave 48) follows it", () => {
    expect(registeredMigrationIds.indexOf(51)).toBe(registeredMigrationIds.indexOf(50) + 1);
    expect(registeredMigrationIds.indexOf(52)).toBe(registeredMigrationIds.indexOf(51) + 1);
    expect(reportRunsViaMigration.name).toBe("report_runs_via");
  });

  test("rebuilds agent_runs and its family keeping every row, index, and trigger; children are not cascaded away", () => {
    const db = openDb(50);
    seed(db);
    const family = agentRunsFamily(db);
    expect(family[0]).toBe("agent_runs");
    for (const name of ["agent_audit_entries", "agent_audit_steps", "report_runs", "report_results"]) expect(family).toContain(name);
    expect(family.indexOf("report_results")).toBeGreaterThan(family.indexOf("report_runs"));
    const before = schema(db, family);
    const counts = () => family.map((name) => [name, (db.query(`SELECT COUNT(*) AS count FROM ${name}`).get() as { count: number }).count]);
    const countsBefore = counts();

    db.transaction(() => reportRunsViaMigration.up(db))();

    expect(counts()).toEqual(countsBefore);
    expect(db.query("SELECT agent_run_id FROM report_runs WHERE id = 'rr1'").get()).toEqual({ agent_run_id: "run-api" });
    expect(db.query("SELECT output_text FROM agent_audit_entries WHERE run_id = 'run-api'").get()).toEqual({ output_text: "out" });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    // Every reference points at the real tables again, never at a copy.
    expect(db.query("SELECT name FROM sqlite_master WHERE sql LIKE '%_r051%'").all()).toEqual([]);
    const after = schema(db, family);
    expect(after.map((row) => `${row.type}:${row.name}`)).toEqual(before.map((row) => `${row.type}:${row.name}`));
    // Only the via CHECK and the shape trigger changed.
    for (const row of after) {
      const old = before.find((item) => item.type === row.type && item.name === row.name)!;
      if (row.name === "agent_runs" || row.name === "agent_runs_audit_shape") expect(row.sql).not.toBe(old.sql);
      // A rename quotes the names it rewrites (`"agent_runs"`), which means the same.
      else expect(row.sql.replace(/"/g, "")).toBe(old.sql.replace(/"/g, "").replace(/^CREATE TABLE IF NOT EXISTS /, "CREATE TABLE "));
    }

    // Deleting the report run still cascades to its results; finished API runs stay frozen.
    expect(() => db.query("UPDATE agent_runs SET model = 'x' WHERE id = 'run-api'").run()).toThrow("APPEND_ONLY");
    expect(() => db.query("UPDATE agent_audit_steps SET text = 'x'").run()).toThrow("APPEND_ONLY");
    db.query("DELETE FROM report_runs WHERE id = 'rr1'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM report_results").get()).toEqual({ count: 0 });
  });

  test("on a database built through v0.37.0's 049: every index and trigger in the schema survives, 049's Undo triggers included", () => {
    const db = openDb(50);
    expect(db.query("SELECT 1 AS ok FROM schema_migrations WHERE id = 49").get()).toEqual({ ok: 1 });
    seed(db);
    // 049's table references nothing and nothing in agent_runs' family references it.
    const family = agentRunsFamily(db);
    expect(family).not.toContain("attachment_undo_records");
    expect(db.query("PRAGMA foreign_key_list(attachment_undo_records)").all()).toEqual([]);
    const extras = () => db.query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name").all() as Array<{ name: string; sql: string }>;
    const before = extras();
    db.transaction(() => reportRunsViaMigration.up(db))();
    const after = extras();
    expect(after.map((row) => row.name)).toEqual(before.map((row) => row.name));
    for (const name of UNDO_RECORD_TRIGGERS) expect({ name, found: after.some((row) => row.name === name) }).toEqual({ name, found: true });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    // The Undo triggers still fire: a purged user's records go with them.
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u2', 'b@example.test', 'B', 'x', ?, 'member')").run(at);
    db.query("INSERT INTO attachment_undo_records (remover_id, host_kind, host_id, document_id, position, linked_at, expires_at) VALUES ('u2', 'event', 'e1', 'd1', 0, ?, 0)").run(at);
    db.query("DELETE FROM users WHERE id = 'u2'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM attachment_undo_records").get()).toEqual({ count: 0 });
  });

  test("the shape: reports runs carry no key and no chat; api and mcp runs still need a key; reports.doc_arg", () => {
    const db = openDb();
    seed(db);
    const insert = (id: string, via: string, keyId: string | null) => db.query(`INSERT INTO agent_runs (id, via, agent_id, agent_revision, prompt_sha256, preamble_version, user_id, key_id, model, status, queued_at)
      VALUES (?, ?, 'reports', 1, 'sha', 1, 'u1', ?, 'm', 'queued', ?)`).run(id, via, keyId, at);
    insert("gen-1", "reports", null);
    expect(() => insert("gen-2", "reports", "k1")).toThrow("AUDIT_SHAPE");
    expect(() => insert("api-2", "api", null)).toThrow("AUDIT_SHAPE");
    expect(() => insert("bad", "other", null)).toThrow();
    // A finished reports run is frozen like an API run.
    db.query("UPDATE agent_runs SET status = 'ok', finished_at = ? WHERE id = 'gen-1'").run(at);
    expect(() => db.query("UPDATE agent_runs SET steps = 3 WHERE id = 'gen-1'").run()).toThrow("APPEND_ONLY");
    db.query("UPDATE reports SET doc_arg = 'url' WHERE id = 'r1'").run();
    expect(() => db.query("UPDATE reports SET doc_arg = '' WHERE id = 'r1'").run()).toThrow();
    // A second run changes nothing.
    const before = db.query("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    db.transaction(() => reportRunsViaMigration.up(db))();
    expect(db.query("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
  });

  test("review L4: a broken reference in the family stops the migration with a clear message, changing nothing", () => {
    const db = openDb(50);
    seed(db);
    db.exec("PRAGMA foreign_keys = OFF");
    db.query("INSERT INTO agent_audit_entries (run_id, input_text) VALUES ('missing-run', 'orphan')").run();
    db.exec("PRAGMA foreign_keys = ON");
    const before = db.query("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    expect(() => db.transaction(() => reportRunsViaMigration.up(db))()).toThrow("Migration 051 cannot rebuild agent_audit_entries: 1 row(s) reference a missing agent_runs row");
    expect(db.query("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
  });
});
