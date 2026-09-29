import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrationIds, runMigrations } from "../server/migrations";
import { accessCentralMigration } from "../server/migrations/032_access_central";

/**
 * Migration 032 (Wave 33, `access_central`): the additive `access_notices` table behind the bell's
 * access lines (§C.11; the calendar `notifications.kind` CHECK cannot be widened by an append-only
 * migration), the invite's access-template snapshot (D286: group ids, name, revision), and an
 * `access_events(actor_id, created_at)` index for Team → Access activity by person.
 */

const at = "2026-09-29T00:00:00.000Z";
const expires = "2026-09-30T00:00:00.000Z";

function migrated() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'u1@example.test', 'U1', 'x', ?, 'member')").run(at);
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u2', 'u2@example.test', 'U2', 'x', ?, 'member')").run(at);
  return db;
}

describe("migration 032 (access central)", () => {
  test("is registered after 029, leaving 030 and 031 to parallel waves", () => {
    expect(registeredMigrationIds).toContain(32);
    expect(registeredMigrationIds.indexOf(32)).toBeGreaterThan(registeredMigrationIds.indexOf(29));
    expect(accessCentralMigration.name).toBe("access_central");
  });

  test("access_notices: checks, indexes, rows follow their user, the actor may go; re-running is a no-op", () => {
    const db = migrated();
    const insert = db.query("INSERT INTO access_notices (id, user_id, kind, actor_id, count, level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run("n1", "u1", "share_lowered", "u2", null, "edit", at);
    insert.run("n2", "u2", "access_reset", "u2", 3, null, at);
    expect(() => insert.run("n3", "u1", "", null, null, null, at)).toThrow();
    expect(() => insert.run("n4", "u1", "x".repeat(41), null, null, null, at)).toThrow();
    expect(() => insert.run("n5", "u1", "share_removed", null, -1, null, at)).toThrow();
    expect(() => insert.run("n6", "nobody", "share_removed", null, null, null, at)).toThrow();
    expect(() => insert.run("n7", "u1", "share_lowered", null, null, "owner", at)).toThrow();
    const indexes = (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'access_notices'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(["access_notices_user", "access_notices_unread"]));
    db.query("DELETE FROM users WHERE id = 'u2'").run();
    expect(db.query("SELECT id, actor_id, level FROM access_notices ORDER BY id").all()).toEqual([{ id: "n1", actor_id: null, level: "edit" }]);
    accessCentralMigration.up(db);
    expect(db.query("SELECT COUNT(*) AS count FROM access_notices").get()).toEqual({ count: 1 });
  });

  test("team_invites gains the template snapshot columns, nullable and checked", () => {
    const db = migrated();
    const columns = (db.query("PRAGMA table_info(team_invites)").all() as Array<{ name: string; notnull: number }>).filter((column) => column.name.startsWith("template_"));
    expect(columns.map((column) => column.name).sort()).toEqual(["template_group_ids", "template_id", "template_name", "template_revision"]);
    expect(columns.every((column) => column.notnull === 0)).toBe(true);
    db.query("UPDATE users SET role = 'admin' WHERE id = 'u1'").run();
    const insert = db.query(`INSERT INTO team_invites (id, token_hash, token_prefix, role, created_by, created_at, expires_at, template_group_ids, template_name, template_revision)
      VALUES (?, ?, 'abcdef', 'member', 'u1', ?, ?, ?, ?, ?)`);
    insert.run("i1", "a".repeat(64), at, expires, '["g1"]', "Ops", 2);
    insert.run("i2", "b".repeat(64), at, expires, null, null, null);
    expect(() => insert.run("i3", "c".repeat(64), at, expires, '{"g":1}', "Ops", 1)).toThrow();
    expect(() => insert.run("i4", "d".repeat(64), at, expires, '["g1"]', "", 1)).toThrow();
    expect(() => insert.run("i5", "e".repeat(64), at, expires, '["g1"]', "Ops", 0)).toThrow();
  });

  test("Access activity by person uses the target and actor indexes, never a scan of access_events (review R4)", () => {
    const db = migrated();
    const plan = (db.query(`EXPLAIN QUERY PLAN SELECT e.id FROM access_events e LEFT JOIN users a ON a.id = e.actor_id LEFT JOIN users t ON t.id = e.target_user_id
      WHERE (e.target_user_id = $userId OR e.actor_id = $userId) ORDER BY e.created_at DESC, e.rowid DESC LIMIT 51`).all({ userId: "u1" }) as Array<{ detail: string }>).map((row) => row.detail);
    expect(plan.some((detail) => detail.includes("USING INDEX access_events_target"))).toBe(true);
    expect(plan.some((detail) => detail.includes("USING INDEX access_events_actor"))).toBe(true);
    expect(plan.some((detail) => /^SCAN e\b/.test(detail))).toBe(false);
  });
});
