import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrations, runMigrations } from "../server/migrations";
import { reportDocBrowseMigration } from "../server/migrations/056_report_doc_browse";

/** Migration 056: reports.doc_browse_tools and doc_source, and report_doc_pages (B3, B4). */
const at = "2026-10-14T00:00:00.000Z";
const hash = "a".repeat(64);

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

describe("migration 056 report_doc_browse", () => {
  test("adds the ticks (empty for existing reports), the doc source, and the pages table with its checks; re-running changes nothing", () => {
    const db = openDb(55);
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
    db.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at) VALUES ('r1', 'u1', 'Weekly revenue', ?, ?)").run(at, at);
    runMigrations(db);
    expect(db.query("SELECT doc_browse_tools, doc_source FROM reports WHERE id = 'r1'").get()).toEqual({ doc_browse_tools: "[]", doc_source: "server" });
    expect(() => db.query("UPDATE reports SET doc_browse_tools = '{}' WHERE id = 'r1'").run()).toThrow();
    expect(() => db.query("UPDATE reports SET doc_source = 'other' WHERE id = 'r1'").run()).toThrow();
    db.query("UPDATE reports SET doc_browse_tools = '[\"fetch\"]', doc_source = 'nook' WHERE id = 'r1'").run();

    db.query("INSERT INTO report_runs (id, report_id, kind, trigger, status, started_at) VALUES ('run1', 'r1', 'generate', 'user', 'succeeded', ?)").run(at);
    const insert = (id: string, args = "{\"id\":\"x\"}", markdown = "# Page") => db.query(`INSERT INTO report_doc_pages (id, report_id, run_id, server_id, tool, args_json, args_sha256, title, sha256, bytes, fetched_at, markdown)
      VALUES (?, 'r1', 'run1', 'nook', 'read_note', ?, ?, 'Page', ?, 6, ?, ?)`).run(id, args, hash, hash, at, markdown);
    insert("p1");
    // One row per run, source, tool, and arguments.
    expect(() => insert("p2")).toThrow();
    expect(() => db.query("INSERT INTO report_doc_pages (id, report_id, run_id, server_id, tool, args_json, args_sha256, sha256, bytes, fetched_at, markdown) VALUES ('p3', 'r1', 'run1', 's', 't', 'not json', ?, ?, 0, ?, '')").run(hash, hash, at)).toThrow();
    expect(() => db.query("INSERT INTO report_doc_pages (id, report_id, run_id, server_id, tool, args_json, args_sha256, sha256, bytes, fetched_at, markdown) VALUES ('p4', 'r1', 'run1', 's', 't', '{}', 'short', ?, 0, ?, '')").run(hash, at)).toThrow();
    expect(() => db.query("INSERT INTO report_doc_pages (id, report_id, run_id, server_id, tool, args_json, args_sha256, sha256, bytes, fetched_at, markdown) VALUES ('p5', 'r1', 'run1', 's', 't', '{}', ?, ?, 0, ?, ?)").run(hash, hash, at, "x".repeat(524_289))).toThrow();
    // A page goes with its run.
    db.query("DELETE FROM report_runs WHERE id = 'run1'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM report_doc_pages").get()).toEqual({ count: 0 });

    reportDocBrowseMigration.up(db);
    expect(db.query("SELECT doc_browse_tools, doc_source FROM reports WHERE id = 'r1'").get()).toEqual({ doc_browse_tools: "[\"fetch\"]", doc_source: "nook" });
    expect((db.query("SELECT id FROM schema_migrations WHERE id >= 55 ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id)).toEqual([55, 56, 57, 58, 59, 60, 61, 62]);
  });
});
