import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { registeredMigrationIds, runMigrations } from "../server/migrations";
import type { Migration } from "../server/migrations/types";

/** Migration 030 (Wave 23, whiteboards): the plan's 023 was taken, so the tables arrive as 030. */

async function migrationsBefore(id: number) {
  const dir = join(import.meta.dir, "..", "server", "migrations");
  const found: Migration[] = [];
  for (const file of readdirSync(dir).filter((name) => /^\d{3}_.*\.ts$/.test(name))) {
    const module = await import(join(dir, file)) as Record<string, unknown>;
    for (const value of Object.values(module)) if (value && typeof value === "object" && "up" in value && "id" in value) found.push(value as Migration);
  }
  return found.filter((migration) => migration.id < id && registeredMigrationIds.includes(migration.id)).sort((a, b) => a.id - b.id);
}

const TABLES = ["whiteboards", "whiteboard_snapshots", "whiteboard_search", "whiteboard_fts"];
const at = "2026-09-29T00:00:00.000Z";
const hasTable = (db: Database, name: string) => Boolean(db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(name));

function seedDocument(db: Database, id: string) {
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'u1@example.test', 'U', 'x', ?) ON CONFLICT DO NOTHING").run(at);
  db.query(`INSERT INTO documents (id, owner_id, folder_id, name, mime_type, preview_kind, size_bytes, sha256, purpose, created_at, updated_at)
    VALUES (?, 'u1', NULL, 'Plan.excalidraw', 'application/vnd.excalidraw+json', 'none', 2, ?, 'file', ?, ?)`).run(id, "a".repeat(64), at, at);
}

describe("migration 030_whiteboards", () => {
  test("is registered after 029", () => {
    expect(registeredMigrationIds).toContain(30);
    expect(registeredMigrationIds.indexOf(30)).toBe(registeredMigrationIds.indexOf(29) + 1);
  });

  test("a fresh database gets every table, the index, and the FTS delete trigger", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    for (const table of TABLES) expect({ table, found: hasTable(db, table) }).toEqual({ table, found: true });
    expect(hasTable(db, "idx_whiteboard_snapshots_doc")).toBe(true);
    expect(hasTable(db, "whiteboard_search_ad")).toBe(true);
    db.close();
  });

  test("an upgrade from 029 adds the tables; checks and cascades hold", async () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of await migrationsBefore(30)) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, at);
    }
    for (const table of TABLES) expect(hasTable(db, table)).toBe(false);
    seedDocument(db, "d1");
    runMigrations(db);
    for (const table of TABLES) expect(hasTable(db, table)).toBe(true);

    const insert = (objectId: string, thumb: Uint8Array | null = null, elements = 0) => db.query(`INSERT INTO whiteboards (document_id, object_id, element_count, thumb_png, created_at, updated_at)
      VALUES ('d1', ?, ?, ?, ?, ?)`).run(objectId, elements, thumb, at, at);
    expect(() => insert("o1", null, 5001)).toThrow();
    expect(() => insert("o1", new Uint8Array(131_073))).toThrow();
    insert("o1", new Uint8Array(131_072));
    db.query("INSERT INTO whiteboard_search (id, document_id, source_sha256, indexed_at) VALUES (7, 'd1', ?, ?)").run("a".repeat(64), at);
    db.query("INSERT INTO whiteboard_fts (rowid, title, body) VALUES (7, 'Plan', 'kitchen island')").run();
    // Purging the document removes the board, its index row, and (through the trigger) its FTS row.
    db.query("DELETE FROM documents WHERE id = 'd1'").run();
    expect(db.query("SELECT COUNT(*) AS n FROM whiteboards").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM whiteboard_search").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM whiteboard_fts").get()).toEqual({ n: 0 });
    db.close();
  });
});
