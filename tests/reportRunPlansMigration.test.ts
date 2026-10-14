import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrations, runMigrations } from "../server/migrations";
import { reportRunPlansMigration } from "../server/migrations/055_report_run_plans";

/** Migration 055: report_runs.plan_json (the planner, D474) and reports.title_source (auto-named reports). */
const at = "2026-10-14T00:00:00.000Z";

function openDb(upTo: number) {
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

describe("migration 055 report_run_plans", () => {
  test("adds plan_json and title_source; reports still called Untitled report read as default, the rest as typed", () => {
    const db = openDb(53);
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
    db.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at) VALUES ('r1', 'u1', 'Untitled report', ?, ?)").run(at, at);
    db.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at) VALUES ('r2', 'u1', 'Weekly revenue', ?, ?)").run(at, at);
    runMigrations(db);
    expect(db.query("SELECT id, title_source FROM reports ORDER BY id").all()).toEqual([{ id: "r1", title_source: "default" }, { id: "r2", title_source: "user" }]);
    db.query("INSERT INTO report_runs (id, report_id, kind, trigger, status, started_at, plan_json) VALUES ('run1', 'r1', 'generate', 'user', 'succeeded', ?, ?)").run(at, JSON.stringify({ goal: "g", sections: [], todos: [], added: 0 }));
    expect(() => db.query("UPDATE report_runs SET plan_json = 'not json' WHERE id = 'run1'").run()).toThrow();
    expect(() => db.query("UPDATE reports SET title_source = 'other' WHERE id = 'r1'").run()).toThrow();
    // Re-running changes nothing (the backfill does not touch a renamed report).
    db.query("UPDATE reports SET title_source = 'user' WHERE id = 'r1'").run();
    reportRunPlansMigration.up(db);
    expect(db.query("SELECT title_source FROM reports WHERE id = 'r1'").get()).toEqual({ title_source: "user" });
  });
});
