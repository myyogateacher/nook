import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../server/migrations";
import { retireCreatedUsers } from "./support/retireUsers";

/**
 * The test helper that blocks a file's accounts when it ends (Wave 33): it must never leave the
 * shared test database without an active admin, or later files would register their first
 * account as a bootstrap admin and see a different Team.
 */

const at = "2026-10-01T00:00:00.000Z";

function database(accounts: Array<[string, string]>) {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  const insert = db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES (?, ?, ?, 'x', ?, ?)");
  for (const [id, role] of accounts) insert.run(id, `${id}@example.test`, id, at, role);
  return db;
}
const active = (db: Database) => (db.query("SELECT id FROM users WHERE disabled_at IS NULL ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);

describe("retireCreatedUsers", () => {
  test("blocks everything the file created while an older admin stays active", () => {
    const db = database([["old-admin", "admin"], ["a1", "admin"], ["m1", "member"], ["g1", "guest"]]);
    expect(retireCreatedUsers(db, 1)).toEqual({ blocked: 3, activeAdmins: 1 });
    expect(active(db)).toEqual(["old-admin"]);
  });

  test("keeps the file's last admin active when it is the only one, and blocks the rest", () => {
    const db = database([["m0", "member"], ["a1", "admin"], ["a2", "admin"], ["m1", "member"]]);
    const result = retireCreatedUsers(db, 0);
    expect(result.activeAdmins).toBe(1);
    expect(result.blocked).toBe(3);
    expect(active(db)).toEqual(["a2"]);
  });
});
