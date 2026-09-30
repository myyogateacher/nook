import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { registeredMigrationIds, runMigrations } from "../server/migrations";
import type { Migration } from "../server/migrations/types";

/**
 * Migration 031 (Wave 25, the Vault; the plan's 024 was taken). It reaches existing installs after
 * 032–035, so the upgrade test starts from a v0.18.0-shaped database: every released migration
 * except 031. Triggers: the last owner, append-only events, cross-vault environments, and grant
 * clean-up on purge (D264, T206).
 */

async function releasedWithout(id: number) {
  const dir = join(import.meta.dir, "..", "server", "migrations");
  const found: Migration[] = [];
  for (const file of readdirSync(dir).filter((name) => /^\d{3}_.*\.ts$/.test(name))) {
    const module = await import(join(dir, file)) as Record<string, unknown>;
    for (const value of Object.values(module)) if (value && typeof value === "object" && "up" in value && "id" in value) found.push(value as Migration);
  }
  return found.filter((migration) => migration.id !== id && registeredMigrationIds.includes(migration.id)).sort((a, b) => a.id - b.id);
}

const TABLES = ["vaults", "vault_keys", "vault_environments", "vault_members", "vault_env_access", "vault_secrets", "vault_values", "vault_value_versions", "vault_events", "vault_rate_limits"];
const at = "2026-09-30T00:00:00.000Z";
const hasTable = (db: Database, name: string) => Boolean(db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(name));

function seed(db: Database) {
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'u1@example.test', 'U1', 'x', ?), ('u2', 'u2@example.test', 'U2', 'x', ?)").run(at, at);
  db.query("INSERT INTO vaults (id, owner_id, name, created_at, updated_at) VALUES ('v1', 'u1', 'One', ?, ?), ('v2', 'u1', 'Two', ?, ?)").run(at, at, at, at);
  db.query("INSERT INTO vault_keys (vault_id, generation, wrapped_dek, created_at) VALUES ('v1', 1, 'v1:a:b:c', ?)").run(at);
  db.query("INSERT INTO vault_members (vault_id, user_id, role, added_at) VALUES ('v1', 'u1', 'owner', ?), ('v1', 'u2', 'member', ?), ('v2', 'u1', 'owner', ?)").run(at, at, at);
  db.query("INSERT INTO vault_environments (id, vault_id, slug, name, position, created_at) VALUES ('e1', 'v1', 'dev', 'Dev', 0, ?), ('e2', 'v2', 'dev', 'Dev', 0, ?)").run(at, at);
  db.query("INSERT INTO vault_secrets (id, vault_id, name, type, created_at, updated_at) VALUES ('s1', 'v1', 'A', 'value', ?, ?)").run(at, at);
  db.query("INSERT INTO vault_events (id, vault_id, actor_id, via, event, created_at) VALUES ('ev1', 'v1', 'u1', 'session', 'vault.create', ?)").run(at);
}

describe("migration 031_vault", () => {
  test("is registered between 030 and 032", () => {
    expect(registeredMigrationIds).toContain(31);
    expect(registeredMigrationIds.indexOf(31)).toBe(registeredMigrationIds.indexOf(30) + 1);
    expect(registeredMigrationIds.indexOf(32)).toBe(registeredMigrationIds.indexOf(31) + 1);
  });

  test("a fresh database gets every table", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    for (const table of TABLES) expect({ table, found: hasTable(db, table) }).toEqual({ table, found: true });
    expect(db.query("SELECT name FROM schema_migrations WHERE id = 31").get()).toEqual({ name: "vault" });
    db.close();
  });

  test("an upgrade from a v0.18.0-shaped database (032–035 applied, 031 missing) adds it; checks and triggers hold", async () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of await releasedWithout(31)) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, at);
    }
    for (const table of TABLES) expect(hasTable(db, table)).toBe(false);
    runMigrations(db);
    for (const table of TABLES) expect(hasTable(db, table)).toBe(true);
    runMigrations(db);
    seed(db);

    // Checks: slugs, types, the cleared/value pairing, tags JSON.
    expect(() => db.query("INSERT INTO vault_environments (id, vault_id, slug, name, position, created_at) VALUES ('bad', 'v1', 'Prod', 'P', 1, ?)").run(at)).toThrow();
    expect(() => db.query("INSERT INTO vault_environments (id, vault_id, slug, name, position, created_at) VALUES ('bad', 'v1', '-x', 'P', 1, ?)").run(at)).toThrow();
    expect(() => db.query("INSERT INTO vault_environments (id, vault_id, slug, name, position, created_at) VALUES ('bad', 'v1', 'dev', 'Again', 1, ?)").run(at)).toThrow();
    expect(() => db.query("INSERT INTO vault_secrets (id, vault_id, name, type, created_at, updated_at) VALUES ('bad', 'v1', 'B', 'card', ?, ?)").run(at, at)).toThrow();
    expect(() => db.query("INSERT INTO vault_secrets (id, vault_id, name, type, tags, created_at, updated_at) VALUES ('bad', 'v1', 'B', 'value', '{}', ?, ?)").run(at, at)).toThrow();
    expect(() => db.query("INSERT INTO vault_secrets (id, vault_id, name, type, created_at, updated_at) VALUES ('bad', 'v1', 'a', 'value', ?, ?)").run(at, at)).toThrow();
    expect(() => db.query("INSERT INTO vault_value_versions (secret_id, env_id, version, value_ct, cleared, generation, created_at) VALUES ('s1', 'e1', 1, 'v1:a:b:c', 1, 1, ?)").run(at)).toThrow();

    // Cross-vault environments are refused on values, versions, and access rows.
    expect(() => db.query("INSERT INTO vault_values (secret_id, env_id, value_ct, generation, version, updated_at) VALUES ('s1', 'e2', 'v1:a:b:c', 1, 1, ?)").run(at)).toThrow("VAULT_MISMATCH");
    expect(() => db.query("INSERT INTO vault_value_versions (secret_id, env_id, version, value_ct, generation, created_at) VALUES ('s1', 'e2', 1, 'v1:a:b:c', 1, ?)").run(at)).toThrow("VAULT_MISMATCH");
    expect(() => db.query("INSERT INTO vault_env_access (vault_id, user_id, env_id, level) VALUES ('v1', 'u2', 'e2', 'read')").run()).toThrow("VAULT_MISMATCH");
    db.query("INSERT INTO vault_values (secret_id, env_id, value_ct, generation, version, updated_at) VALUES ('s1', 'e1', 'v1:a:b:c', 1, 1, ?)").run(at);
    db.query("INSERT INTO vault_env_access (vault_id, user_id, env_id, level) VALUES ('v1', 'u2', 'e1', 'write')").run();

    // The last owner stays; a second owner can then leave.
    expect(() => db.query("DELETE FROM vault_members WHERE vault_id = 'v1' AND user_id = 'u1'").run()).toThrow("LAST_OWNER");
    expect(() => db.query("UPDATE vault_members SET role = 'member' WHERE vault_id = 'v1' AND user_id = 'u1'").run()).toThrow("LAST_OWNER");
    db.query("UPDATE vault_members SET role = 'owner' WHERE vault_id = 'v1' AND user_id = 'u2'").run();
    db.query("UPDATE vault_members SET role = 'member' WHERE vault_id = 'v1' AND user_id = 'u1'").run();

    // Events are append-only.
    expect(() => db.query("UPDATE vault_events SET event = 'x' WHERE id = 'ev1'").run()).toThrow("APPEND_ONLY");
    expect(() => db.query("DELETE FROM vault_events WHERE id = 'ev1'").run()).toThrow("APPEND_ONLY");

    // Grants on vault keys (025's tables) go with the environment and the vault they name.
    db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, created_at, kind) VALUES ('k1', 'u1', 'CI', 'nkv_abcd', 'h1', ?, 'vault')").run(at);
    db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, env_id, created_at) VALUES ('g1', 'k1', 'vault', 'read', 'vault', 'v1', 'e1', ?), ('g2', 'k1', 'vault', 'read', 'vault', 'v1', NULL, ?)").run(at, at);
    db.query("DELETE FROM vault_environments WHERE id = 'e1'").run();
    expect(db.query("SELECT id FROM api_key_grants ORDER BY id").all()).toEqual([{ id: "g2" }]);
    expect(db.query("SELECT COUNT(*) AS count FROM vault_values").get()).toEqual({ count: 0 });

    // A purge cascades everything, events and keys included.
    db.query("DELETE FROM vaults WHERE id = 'v1'").run();
    for (const table of ["vault_keys", "vault_members", "vault_secrets", "vault_events", "vault_env_access"]) {
      expect({ table, count: (db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE vault_id = 'v1'`).get() as { count: number }).count }).toEqual({ table, count: 0 });
    }
    expect(db.query("SELECT COUNT(*) AS count FROM api_key_grants").get()).toEqual({ count: 0 });
    db.close();
  });
});
