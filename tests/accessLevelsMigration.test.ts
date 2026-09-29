import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrationIds, runMigrations } from "../server/migrations";
import { accessLevelsMigration } from "../server/migrations/029_access_levels";

/**
 * Migration 029 (Wave 32, T145): v0.12.0 still wrote collection and calendar member rows without a
 * level (so `view`), while the audience-wide `share_role` decided who edited. Wave 32 reads the
 * level, so 029 brings those rows in line once: nobody gains or loses a power at the upgrade.
 */

const at = "2026-09-28T00:00:00.000Z";

function seeded() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  for (const id of ["u1", "u2", "u3"]) {
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES (?, ?, ?, 'x', ?, 'member')").run(id, `${id}@example.test`, id, at);
  }
  const collection = db.query("INSERT INTO collections (id, owner_id, name, schema_json, visibility, share_role, created_at, updated_at) VALUES (?, 'u1', ?, '{\"fields\":[]}', 'selected', ?, ?, ?)");
  collection.run("c-edit", "Editors", "editor", at, at);
  collection.run("c-view", "Viewers", "viewer", at, at);
  const calendar = db.query("INSERT INTO calendars (id, owner_id, name, color, visibility, share_role, created_at, updated_at) VALUES (?, 'u1', ?, 'blue', 'selected', ?, ?, ?)");
  calendar.run("k-edit", "Team", "editor", at, at);
  calendar.run("k-view", "Read", "viewer", at, at);
  // Rows as v0.12.0's sharing routes wrote them: no level, so the default `view`.
  for (const [table, column, id] of [["collection_members", "collection_id", "c-edit"], ["collection_members", "collection_id", "c-view"], ["calendar_members", "calendar_id", "k-edit"], ["calendar_members", "calendar_id", "k-view"]] as const) {
    db.query(`INSERT INTO ${table} (${column}, user_id, created_at) VALUES (?, 'u2', ?)`).run(id, at);
  }
  return db;
}

const level = (db: Database, table: string, column: string, id: string) =>
  (db.query(`SELECT level FROM ${table} WHERE ${column} = ? AND user_id = 'u2'`).get(id) as { level: string }).level;

describe("migration 029 (access levels)", () => {
  test("is registered after 028", () => {
    expect(registeredMigrationIds.indexOf(29)).toBe(registeredMigrationIds.indexOf(28) + 1);
  });

  test("members of editor collections and calendars become edit; viewer ones stay view; re-running changes nothing", () => {
    const db = seeded();
    expect(level(db, "collection_members", "collection_id", "c-edit")).toBe("view");
    accessLevelsMigration.up(db);
    expect(level(db, "collection_members", "collection_id", "c-edit")).toBe("edit");
    expect(level(db, "collection_members", "collection_id", "c-view")).toBe("view");
    expect(level(db, "calendar_members", "calendar_id", "k-edit")).toBe("edit");
    expect(level(db, "calendar_members", "calendar_id", "k-view")).toBe("view");
    // A manager row (set later by the Access sheet) is never touched.
    db.query("INSERT INTO collection_members (collection_id, user_id, created_at, level) VALUES ('c-edit', 'u3', ?, 'manage')").run(at);
    accessLevelsMigration.up(db);
    expect((db.query("SELECT level FROM collection_members WHERE collection_id = 'c-edit' AND user_id = 'u3'").get() as { level: string }).level).toBe("manage");
    expect(level(db, "collection_members", "collection_id", "c-edit")).toBe("edit");
  });
});
