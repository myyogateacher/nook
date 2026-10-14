import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrationIds, registeredMigrations, runMigrations } from "../server/migrations";
import { reportInstructionsMigration } from "../server/migrations/052_report_instructions";

/**
 * Migration 052 (reports wave 48, D450–D455): report_instructions (one running or proposed per report),
 * report_versions with the backfill of existing specs, reports.auto_apply, and the sharing tables.
 * Re-running changes nothing.
 */

const at = "2026-10-13T00:00:00.000Z";
const SPEC = (version: number, title = "Revenue") => JSON.stringify({ version: 1, queries: [{ key: "q", sql: "SELECT 1 AS n", purpose: "", createdBy: "agent" }], blocks: [{ id: "b", type: "kpi", title, queryKey: "q", column: "n", provenance: { runId: null, version } }] });

function openDb(upTo = Number.POSITIVE_INFINITY) {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of registeredMigrations.filter((item) => item.id <= upTo)) {
    db.transaction(() => {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, at);
    })();
  }
  return db;
}

function seed(db: Database) {
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u2', 'b@example.test', 'B', 'x', ?, 'member')").run(at);
  db.query("INSERT INTO reports (id, owner_id, title, spec_json, created_at, updated_at) VALUES ('r1', 'u1', 'Revenue', ?, ?, ?)").run(SPEC(3), at, at);
  db.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at) VALUES ('r2', 'u1', 'Empty', ?, ?)").run(at, at);
}

/** Rows a 049 database has: two people and a stored agent setting (053 rebuilds agent_settings). */
function seed49(db: Database) {
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u2', 'b@example.test', 'B', 'x', ?, 'member')").run(at);
  db.query("INSERT INTO agent_settings (key, value_json, revision, updated_at) VALUES ('kbs_per_user', '7', 3, ?)").run(at);
}

describe("migration 052 report_instructions", () => {
  test("registered after 051", () => {
    expect(registeredMigrationIds.indexOf(52)).toBe(registeredMigrationIds.indexOf(51) + 1);
    expect(reportInstructionsMigration.name).toBe("report_instructions");
  });

  test("backfills an initial version for reports with a spec, adds auto_apply, and re-running changes nothing", () => {
    const db = openDb(51);
    seed(db);
    reportInstructionsMigration.up(db);
    // The first version takes the spec's stamped version, so later numbers continue from it.
    expect(db.query("SELECT report_id, version, source FROM report_versions").all()).toEqual([{ report_id: "r1", version: 3, source: "initial" }]);
    expect(db.query("SELECT auto_apply FROM reports WHERE id = 'r1'").get()).toEqual({ auto_apply: 0 });
    const schema = () => db.query("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
    const before = schema();
    reportInstructionsMigration.up(db);
    expect(schema()).toEqual(before);
    expect(db.query("SELECT COUNT(*) AS count FROM report_versions").get()).toEqual({ count: 1 });
  });

  test("no trigger on reports: a spec change counts one changed row (generate.ts checks it)", () => {
    const db = openDb();
    seed(db);
    expect(db.query("UPDATE reports SET spec_json = ? WHERE id = 'r1'").run(SPEC(4, "Generated")).changes).toBe(1);
    expect(db.query("SELECT COUNT(*) AS count FROM report_versions").get()).toEqual({ count: 0 });
  });

  test("one running or proposed instruction per report; statuses and levels are checked; purging cascades", () => {
    const db = openDb();
    seed(db);
    const insert = db.query("INSERT INTO report_instructions (id, report_id, text, author_id, status, position, created_at, updated_at) VALUES (?, 'r1', 'split by country', 'u1', ?, ?, ?, ?)");
    insert.run("i1", "proposed", 1, at, at);
    insert.run("i2", "queued", 2, at, at);
    insert.run("i3", "queued", 3, at, at);
    expect(() => db.query("UPDATE report_instructions SET status = 'running' WHERE id = 'i2'").run()).toThrow("UNIQUE");
    db.query("UPDATE report_instructions SET status = 'applied' WHERE id = 'i1'").run();
    db.query("UPDATE report_instructions SET status = 'running' WHERE id = 'i2'").run();
    expect(() => insert.run("i4", "waiting", 4, at, at)).toThrow("CHECK");
    db.query("INSERT INTO report_members (report_id, user_id, level, created_at) VALUES ('r1', 'u2', 'comment', ?)").run(at);
    expect(() => db.query("INSERT INTO report_members (report_id, user_id, level, created_at) VALUES ('r2', 'u2', 'edit', ?)").run(at)).toThrow("CHECK");
    db.query("INSERT INTO user_groups (id, name, created_at, updated_at) VALUES ('g1', 'Analysts', ?, ?)").run(at, at);
    db.query("INSERT INTO report_group_shares (report_id, group_id, level, created_at) VALUES ('r1', 'g1', 'view', ?)").run(at);
    db.query("DELETE FROM reports WHERE id = 'r1'").run();
    for (const table of ["report_instructions", "report_versions", "report_members", "report_group_shares"]) {
      expect([table, db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()]).toEqual([table, { count: 0 }]);
    }
  });

  test("integration: a database built through 049, then 050, 051, 052, and 053 in order, keeps its rows; 051's and 053's rebuilds work after 052", () => {
    const db = openDb(49);
    seed49(db);
    const apply = (id: number) => {
      const migration = registeredMigrations.find((item) => item.id === id)!;
      db.transaction(() => {
        migration.up(db);
        db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, at);
      })();
    };
    apply(50);
    db.query("INSERT INTO reports (id, owner_id, title, spec_json, created_at, updated_at) VALUES ('r1', 'u1', 'Revenue', ?, ?, ?)").run(SPEC(2), at, at);
    apply(51);
    apply(52);
    apply(53);
    // 052's backfill and columns, then 053's columns on the same reports table.
    expect(db.query("SELECT report_id, version, source FROM report_versions").all()).toEqual([{ report_id: "r1", version: 2, source: "initial" }]);
    expect(db.query("SELECT auto_apply, model_provider_id, model FROM reports WHERE id = 'r1'").get()).toEqual({ auto_apply: 0, model_provider_id: null, model: null });
    // 053 rebuilt agent_settings with its rows kept and the report-model keys allowed.
    expect(db.query("SELECT key, value_json, revision FROM agent_settings ORDER BY key").all()).toEqual([{ key: "kbs_per_user", value_json: "7", revision: 3 }]);
    db.query("INSERT INTO agent_settings (key, value_json, updated_at) VALUES ('report_model', '\"glm-5.3\"', ?)").run(at);
    // 051's rebuilt agent_runs accepts reports runs.
    expect(String((db.query("SELECT sql FROM sqlite_master WHERE name = 'agent_runs'").get() as { sql: string }).sql)).toContain("'reports'");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    // Everything is applied (055, which came later, too): a later run changes nothing.
    runMigrations(db);
    const schema = db.query("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
    runMigrations(db);
    expect(db.query("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all()).toEqual(schema);
    expect((db.query("SELECT id FROM schema_migrations WHERE id >= 49 ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id)).toEqual([49, 50, 51, 52, 53, 55, 56, 57, 58]);
  });

  test("a full migration run from scratch includes 052", () => {
    const db = new Database(":memory:", { strict: true });
    runMigrations(db);
    expect(db.query("SELECT name FROM schema_migrations WHERE id = 52").get()).toEqual({ name: "report_instructions" });
  });
});
