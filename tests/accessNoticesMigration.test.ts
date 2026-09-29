import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrationIds, runMigrations } from "../server/migrations";
import { accessNoticesMigration } from "../server/migrations/032_access_notices";

/**
 * Migration 032 (Wave 33): the additive `access_notices` table behind the bell's access lines
 * (§C.11). The calendar `notifications.kind` CHECK cannot be widened by an append-only migration.
 */

const at = "2026-09-29T00:00:00.000Z";

function migrated() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'u1@example.test', 'U1', 'x', ?, 'member')").run(at);
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u2', 'u2@example.test', 'U2', 'x', ?, 'member')").run(at);
  return db;
}

describe("migration 032 (access notices)", () => {
  test("is registered after 029, leaving 030 and 031 to parallel waves", () => {
    expect(registeredMigrationIds).toContain(32);
    expect(registeredMigrationIds.indexOf(32)).toBeGreaterThan(registeredMigrationIds.indexOf(29));
    expect(accessNoticesMigration.name).toBe("access_notices");
  });

  test("creates the table and its indexes; rows follow their user, the actor may go; re-running is a no-op", () => {
    const db = migrated();
    const insert = db.query("INSERT INTO access_notices (id, user_id, kind, actor_id, count, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    insert.run("n1", "u1", "share_removed", "u2", null, at);
    insert.run("n2", "u2", "access_reset", "u2", 3, at);
    expect(() => insert.run("n3", "u1", "", null, null, at)).toThrow();
    expect(() => insert.run("n4", "u1", "x".repeat(41), null, null, at)).toThrow();
    expect(() => insert.run("n5", "u1", "share_removed", null, -1, at)).toThrow();
    expect(() => insert.run("n6", "nobody", "share_removed", null, null, at)).toThrow();
    const indexes = (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'access_notices'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(["access_notices_user", "access_notices_unread"]));
    db.query("DELETE FROM users WHERE id = 'u2'").run();
    expect(db.query("SELECT id, actor_id FROM access_notices ORDER BY id").all()).toEqual([{ id: "n1", actor_id: null }]);
    accessNoticesMigration.up(db);
    expect(db.query("SELECT COUNT(*) AS count FROM access_notices").get()).toEqual({ count: 1 });
  });
});
