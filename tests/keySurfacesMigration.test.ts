import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrationIds, runMigrations } from "../server/migrations";
import { keySurfacesMigration } from "../server/migrations/033_key_surfaces";

/**
 * Migration 033 (Wave 34): per-surface last use on keys and daily counts per surface. A fresh
 * database gets the columns and table; a database shaped like current main (every other migration,
 * keys already used over MCP) keeps its keys and counts, seen as MCP use.
 */

const T = "2026-09-20T10:00:00.000Z";

function seed(db: Database) {
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'u1@example.test', 'U1', 'x', ?, 'member')").run(T);
  db.query(`INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, scopes, created_at, last_used_at) VALUES ('k1', 'u1', 'Used', 'mynotes_aaaaaaaa', 'h1', '["notes:read"]', ?, ?)`).run(T, T);
  db.query(`INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, scopes, created_at) VALUES ('k2', 'u1', 'Unused', 'mynotes_bbbbbbbb', 'h2', '["notes:read"]', ?)`).run(T);
  db.query("INSERT INTO api_key_usage (key_id, day, calls, writes, denied) VALUES ('k1', '2026-09-20', 5, 2, 1)").run();
}

describe("migration 033 (key surfaces)", () => {
  test("is registered in order", () => {
    expect(registeredMigrationIds).toContain(33);
    expect(registeredMigrationIds.indexOf(33)).toBeGreaterThan(registeredMigrationIds.indexOf(32));
    expect(registeredMigrationIds.indexOf(33)).toBeLessThan(registeredMigrationIds.indexOf(34));
  });

  test("a fresh database gets the columns and the per-surface table", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    const columns = (db.query("PRAGMA table_info(mcp_api_keys)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["last_used_mcp_at", "last_used_rest_at", "last_denied_at", "last_denied_reason", "last_denied_surface"]));
    seed(db);
    db.query("INSERT INTO api_key_surface_usage (key_id, day, surface, calls) VALUES ('k1', '2026-09-21', 'rest', 1)").run();
    expect(() => db.query("INSERT INTO api_key_surface_usage (key_id, day, surface) VALUES ('k1', '2026-09-21', 'web')").run()).toThrow();
    db.query("DELETE FROM mcp_api_keys WHERE id = 'k1'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM api_key_surface_usage").get()).toEqual({ count: 0 });
  });

  test("a current-main database keeps its keys and counts as MCP use, and re-running changes nothing", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    // Shape it like main before 033: drop what 033 adds, and forget that it ran.
    db.exec("DROP TABLE api_key_surface_usage");
    db.exec("ALTER TABLE mcp_api_keys DROP COLUMN last_used_mcp_at");
    db.exec("ALTER TABLE mcp_api_keys DROP COLUMN last_used_rest_at");
    for (const column of ["last_denied_at", "last_denied_reason", "last_denied_surface"]) db.exec(`ALTER TABLE mcp_api_keys DROP COLUMN ${column}`);
    db.exec("DELETE FROM schema_migrations WHERE id = 33");
    seed(db);
    runMigrations(db);
    expect(db.query("SELECT id, last_used_mcp_at, last_used_rest_at FROM mcp_api_keys ORDER BY id").all()).toEqual([
      { id: "k1", last_used_mcp_at: T, last_used_rest_at: null },
      { id: "k2", last_used_mcp_at: null, last_used_rest_at: null }
    ]);
    expect(db.query("SELECT key_id, day, surface, calls, writes, denied FROM api_key_surface_usage").all()).toEqual([{ key_id: "k1", day: "2026-09-20", surface: "mcp", calls: 5, writes: 2, denied: 1 }]);
    keySurfacesMigration.up(db);
    expect(db.query("SELECT COUNT(*) AS count FROM api_key_surface_usage").get()).toEqual({ count: 1 });
  });
});
