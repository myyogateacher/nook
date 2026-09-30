import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrationIds, runMigrations } from "../server/migrations";
import { accessKeysMigration } from "../server/migrations/025_access_keys";
import { grantsToScopes, SCOPE_GRANTS, type Grant } from "../server/keyGrants";
import { MCP_SCOPES, parseStoredScopes } from "../server/mcpScopes";

/**
 * Migration 025 (access plan §C.8, §G "Migration 025"): every existing key gets grants equal to its
 * scopes over "all" (no key gains or loses power), member levels default to today's behaviour, the
 * kind wall refuses mixes, purges remove grants, and the activity log is append-only.
 */

function openDb() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/**
 * A fully migrated database. 025's steps are idempotent (addColumn, IF NOT EXISTS, INSERT OR IGNORE),
 * so a test seeds pre-025-shaped rows and then runs 025 again to see what an upgrade does.
 */
function dbBefore025() {
  const db = openDb();
  runMigrations(db);
  return db;
}

const at = "2026-09-01T00:00:00.000Z";

function seedUsersAndKeys(db: Database) {
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'admin')").run(at);
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u2', 'b@example.test', 'B', 'x', ?, 'member')").run(at);
  const key = db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, created_at, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)");
  key.run("k1", "u1", "One", "mynotes_aaaaaaaa", "h1", at, JSON.stringify(["notes:read"]));
  key.run("k2", "u1", "Two", "mynotes_bbbbbbbb", "h2", at, JSON.stringify(["tasks:write", "calendar:read", "bin:write", "team:read"]));
  key.run("k3", "u2", "Three", "mynotes_cccccccc", "h3", at, JSON.stringify(["notes:write-draft", "notes:publish", "files:write", "future:thing"]));
  key.run("k4", "u2", "Four", "mynotes_dddddddd", "h4", at, JSON.stringify({ odd: true }));
  key.run("k5", "u2", "Five", "mynotes_eeeeeeee", "h5", at, "[]");
}

const grantsOf = (db: Database, keyId: string) => (db.query("SELECT module, permission, resource_kind, resource_id FROM api_key_grants WHERE key_id = ?").all(keyId) as Array<{ module: Grant["module"]; permission: Grant["permission"]; resource_kind: string | null; resource_id: string | null }>);

describe("migration 025 access keys", () => {
  test("is registered as 25, between 022 and any later id", () => {
    expect(registeredMigrationIds).toContain(25);
    expect(registeredMigrationIds.indexOf(25)).toBeGreaterThan(registeredMigrationIds.indexOf(22));
    expect(accessKeysMigration.name).toBe("access_keys");
  });

  test("backfills one all-resources grant per stored scope, so the scopes each key can use are unchanged", () => {
    const db = openDb();
    runMigrations(db);
    // Re-run 025 against keys seeded on the migrated schema, as an upgraded install would see them.
    seedUsersAndKeys(db);
    db.exec("DELETE FROM api_key_grants");
    accessKeysMigration.up(db);
    for (const keyId of ["k1", "k2", "k3", "k4", "k5"]) {
      const stored = (db.query("SELECT scopes FROM mcp_api_keys WHERE id = ?").get(keyId) as { scopes: string }).scopes;
      const grants = grantsOf(db, keyId);
      expect(grants.every((grant) => grant.resource_kind === null && grant.resource_id === null)).toBe(true);
      expect(grantsToScopes(grants)).toEqual(parseStoredScopes(stored));
    }
    expect(grantsToScopes(grantsOf(db, "k2"))).toEqual(["tasks:read", "tasks:write", "calendar:read", "bin:write", "team:read"]);
    // A non-array value always meant notes:read; an empty array meant nothing.
    expect(grantsToScopes(grantsOf(db, "k4"))).toEqual(["notes:read"]);
    expect(grantsOf(db, "k5")).toEqual([]);
    // Pre-025 keys keep no expiry, general kind, and the MCP surface.
    expect(db.query("SELECT kind, surfaces, expires_at FROM mcp_api_keys WHERE id = 'k1'").get()).toEqual({ kind: "general", surfaces: "mcp", expires_at: null });
    // Running the backfill again adds nothing (the unique index).
    accessKeysMigration.up(db);
    expect((db.query("SELECT COUNT(*) AS count FROM api_key_grants WHERE key_id = 'k2'").get() as { count: number }).count).toBe(grantsOf(db, "k2").length);
    db.close();
  });

  test("the frozen scope table covers every live scope exactly as server/keyGrants.ts maps it", () => {
    for (const scope of MCP_SCOPES) expect(SCOPE_GRANTS[scope]).toBeDefined();
    expect(Object.keys(SCOPE_GRANTS).sort()).toEqual([...MCP_SCOPES].sort());
  });

  test("the kind wall keeps vault grants on nkv_ keys only, and the kind and prefix are fixed", () => {
    const db = dbBefore025();
    seedUsersAndKeys(db);
    const grant = db.query("INSERT INTO api_key_grants (id, key_id, module, permission, created_at) VALUES (?, ?, ?, ?, ?)");
    expect(() => grant.run(crypto.randomUUID(), "k1", "vault", "read", at)).toThrow("KEY_KIND_WALL");
    const key = db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, created_at, kind) VALUES (?, 'u1', 'V', ?, ?, ?, ?)");
    expect(() => key.run("v0", "mynotes_vvvvvvvv", "hv0", at, "vault")).toThrow("KEY_KIND_PREFIX");
    expect(() => key.run("g0", "nkv_gggggggggggg", "hg0", at, "general")).toThrow("KEY_KIND_PREFIX");
    key.run("v1", "nkv_vvvvvvvvvvvv", "hv1", at, "vault");
    // 038 (Wave 27): a vault grant names its vault (resource_kind 'vault' and an id); the bare module is refused.
    expect(() => grant.run(crypto.randomUUID(), "v1", "vault", "read", at)).toThrow("VAULT_GRANT_SHAPE");
    db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, created_at) VALUES (?, 'v1', 'vault', 'read', 'vault', 'vault-1', ?)").run(crypto.randomUUID(), at);
    expect(() => grant.run(crypto.randomUUID(), "v1", "notes", "read", at)).toThrow("KEY_KIND_WALL");
    expect(() => db.query("UPDATE mcp_api_keys SET kind = 'vault' WHERE id = 'k1'").run()).toThrow("KEY_KIND_FIXED");
    expect(() => db.query("UPDATE api_key_grants SET module = 'notes' WHERE key_id = 'v1'").run()).toThrow("KEY_KIND_WALL");
    // env ids are vault-only, and a resource kind needs its id.
    expect(() => db.query("INSERT INTO api_key_grants (id, key_id, module, permission, env_id, created_at) VALUES (?, 'k1', 'notes', 'read', 'e1', ?)").run(crypto.randomUUID(), at)).toThrow();
    expect(() => db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, created_at) VALUES (?, 'k1', 'tasks', 'read', 'board', ?)").run(crypto.randomUUID(), at)).toThrow();
    expect(() => grant.run(crypto.randomUUID(), "k1", "tasks", "manage", at)).toThrow();
    db.close();
  });

  test("purging a resource removes the key and group grants on it (T206); the Bin keeps them", () => {
    const db = dbBefore025();
    seedUsersAndKeys(db);
    db.query("INSERT INTO boards (id, owner_id, name, visibility, created_at, updated_at) VALUES ('b1', 'u1', 'Ops', 'private', ?, ?)").run(at, at);
    db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, created_at) VALUES (?, 'k2', 'tasks', 'write', 'board', 'b1', ?)").run(crypto.randomUUID(), at);
    db.query("INSERT INTO user_groups (id, name, created_at, updated_at) VALUES ('g1', 'Ops', ?, ?)").run(at, at);
    db.query("INSERT INTO group_grants (resource_kind, resource_id, group_id, level, created_at) VALUES ('board', 'b1', 'g1', 'edit', ?)").run(at);
    db.query("UPDATE boards SET deleted_at = ?, purge_after = ? WHERE id = 'b1'").run(at, at);
    expect((db.query("SELECT COUNT(*) AS count FROM api_key_grants WHERE resource_id = 'b1'").get() as { count: number }).count).toBe(1);
    db.query("DELETE FROM boards WHERE id = 'b1'").run();
    expect((db.query("SELECT COUNT(*) AS count FROM api_key_grants WHERE resource_id = 'b1'").get() as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM group_grants WHERE resource_id = 'b1'").get() as { count: number }).count).toBe(0);
    db.close();
  });

  test("member levels default to today's behaviour: boards edit, collections and calendars from share_role", () => {
    const db = dbBefore025();
    seedUsersAndKeys(db);
    db.query("INSERT INTO boards (id, owner_id, name, visibility, created_at, updated_at) VALUES ('b1', 'u1', 'Ops', 'selected', ?, ?)").run(at, at);
    db.query("INSERT INTO board_members (board_id, user_id, created_at) VALUES ('b1', 'u2', ?)").run(at);
    expect(db.query("SELECT level FROM board_members").get()).toEqual({ level: "edit" });
    expect(db.query("SELECT share_role FROM boards").get()).toEqual({ share_role: "edit" });
    const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
    for (const table of ["note_shares", "folder_shares", "document_shares", "board_members", "collection_members", "calendar_members"]) expect(columns(table)).toContain("level");
    expect(columns("users")).toContain("kind");
    expect(columns("team_invites")).toContain("template_id");
    expect(db.query("SELECT kind FROM users WHERE id = 'u1'").get()).toEqual({ kind: "person" });
    // The aggregation view reads every source.
    expect(db.query("SELECT kind, resource_id, user_id, level, via FROM access_grants_v").all()).toEqual([{ kind: "board", resource_id: "b1", user_id: "u2", level: "edit", via: "direct" }]);
    db.close();
  });

  test("collection and calendar member levels backfill from the item's share_role", () => {
    const db = dbBefore025();
    seedUsersAndKeys(db);
    db.query("INSERT INTO collections (id, owner_id, name, schema_json, visibility, share_role, created_at, updated_at) VALUES ('c1', 'u1', 'Hires', '{\"fields\":[]}', 'selected', 'editor', ?, ?)").run(at, at);
    // A pre-025 row reads the column default (view); the backfill step lifts it to the item's role.
    db.query("INSERT INTO collection_members (collection_id, user_id, created_at) VALUES ('c1', 'u2', ?)").run(at);
    db.query("INSERT INTO calendars (id, owner_id, name, color, visibility, share_role, created_at, updated_at) VALUES ('k1', 'u1', 'Team', 'blue', 'selected', 'viewer', ?, ?)").run(at, at);
    db.query("INSERT INTO calendar_members (calendar_id, user_id, created_at) VALUES ('k1', 'u2', ?)").run(at);
    expect(db.query("SELECT level FROM collection_members").get()).toEqual({ level: "view" });
    accessKeysMigration.up(db);
    expect(db.query("SELECT level FROM collection_members").get()).toEqual({ level: "edit" });
    expect(db.query("SELECT level FROM calendar_members").get()).toEqual({ level: "view" });
    db.close();
  });

  test("access_events is append-only; a gone actor may become NULL", () => {
    const db = dbBefore025();
    seedUsersAndKeys(db);
    db.query("INSERT INTO access_events (id, actor_id, via, action, key_id, created_at) VALUES ('e1', 'u2', 'web', 'key.created', 'k3', ?)").run(at);
    expect(() => db.query("UPDATE access_events SET action = 'x' WHERE id = 'e1'").run()).toThrow("APPEND_ONLY");
    expect(() => db.query("DELETE FROM access_events WHERE id = 'e1'").run()).toThrow("APPEND_ONLY");
    expect(() => db.query("INSERT INTO access_events (id, via, action, created_at) VALUES ('e2', 'fax', 'x', ?)").run(at)).toThrow();
    db.query("DELETE FROM users WHERE id = 'u2'").run();
    expect(db.query("SELECT actor_id FROM access_events WHERE id = 'e1'").get()).toEqual({ actor_id: null });
    db.close();
  });

  test("team_settings accepts only the known policy keys and JSON values", () => {
    const db = dbBefore025();
    const insert = db.query("INSERT INTO team_settings (key, value_json, updated_at) VALUES (?, ?, ?)");
    insert.run("key_max_days", "30", at);
    expect(() => insert.run("anything", "1", at)).toThrow();
    expect(() => insert.run("key_default_days", "not json", at)).toThrow();
    db.close();
  });
});
