import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrationIds, runMigrations } from "../server/migrations";
import { agentChatMigration, GRANT_WORDS, rebuildApiKeyGrants } from "../server/migrations/039_agent_chat";

/**
 * Migration 039 (agent chat plan §10, T326): every table of the module exists, and the
 * `api_key_grants` rebuild keeps every row, both indexes, and all six triggers while widening the
 * CHECK words for `agents` (and the Messages plan's words). An upgraded database is modelled by
 * putting the 025+038 shape of the table back, seeding general and vault keys with grants, and
 * running 039 again.
 */

function openDb() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

const at = "2026-10-01T00:00:00.000Z";

/** The table as 025 created it plus 038's column, with 025's indexes and triggers and 038's triggers. */
function restorePre039Shape(db: Database) {
  const triggers = (db.query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'api_key_grants'").all() as Array<{ sql: string }>).map((row) => row.sql);
  const indexes = (db.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'api_key_grants' AND sql IS NOT NULL").all() as Array<{ sql: string }>).map((row) => row.sql);
  expect(triggers.length).toBe(6);
  expect(indexes.length).toBe(2);
  db.exec(`
    DROP TABLE api_key_grants;
    CREATE TABLE api_key_grants (
      id TEXT PRIMARY KEY,
      key_id TEXT NOT NULL REFERENCES mcp_api_keys(id) ON DELETE CASCADE,
      module TEXT NOT NULL CHECK (module IN ('notes','files','tasks','today','calendar','collections','team','inbox','bin','whiteboards','vault')),
      permission TEXT NOT NULL CHECK (permission IN ('read','comment','write','draft','publish','create')),
      resource_kind TEXT CHECK (resource_kind IS NULL OR resource_kind IN
        ('folder','note','document','board','task_view','collection','calendar','routine','whiteboard','vault')),
      resource_id TEXT CHECK (resource_id IS NULL OR length(resource_id) <= 64),
      env_id TEXT CHECK (env_id IS NULL OR length(env_id) <= 64),
      created_at TEXT NOT NULL,
      protected_at_grant INTEGER NOT NULL DEFAULT 0 CHECK (protected_at_grant IN (0,1)),
      CHECK ((resource_kind IS NULL) = (resource_id IS NULL)),
      CHECK (env_id IS NULL OR module = 'vault')
    );
    ${indexes.map((sql) => `${sql};`).join("\n")}
    ${triggers.map((sql) => `${sql};`).join("\n")}
  `);
  return { triggers, indexes };
}

function seed(db: Database) {
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'admin')").run(at);
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u2', 'b@example.test', 'B', 'x', ?, 'member')").run(at);
  db.query("INSERT INTO notes (id, owner_id, title, created_at, updated_at, folder_id) VALUES ('n1', 'u2', 'Note', ?, ?, NULL)").run(at, at);
  db.query("INSERT INTO vaults (id, owner_id, name, created_at, updated_at) VALUES ('v1', 'u1', 'Vault', ?, ?)").run(at, at);
  db.query("INSERT INTO vault_environments (id, vault_id, slug, name, position, created_at) VALUES ('e1', 'v1', 'prod', 'Prod', 0, ?)").run(at);
  const key = db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, created_at, scopes, kind, vault_protected_access) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)");
  key.run("k1", "u2", "General", "mynotes_aaaaaaaa", "h1", at, "general", 0);
  key.run("k2", "u1", "Vault", "nkv_bbbbbbbbbbbb", "h2", at, "vault", 1);
  const grant = db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, env_id, created_at, protected_at_grant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  grant.run("g1", "k1", "notes", "read", null, null, null, at, 0);
  grant.run("g2", "k1", "notes", "draft", "note", "n1", null, at, 0);
  grant.run("g3", "k1", "tasks", "write", null, null, null, at, 0);
  grant.run("g4", "k2", "vault", "read", "vault", "v1", null, at, 0);
  grant.run("g5", "k2", "vault", "write", "vault", "v1", "e1", at, 1);
}

const rows = (db: Database) => db.query("SELECT id, key_id, module, permission, resource_kind, resource_id, env_id, created_at, protected_at_grant FROM api_key_grants ORDER BY id").all();
const schemaOf = (db: Database, type: "index" | "trigger") => (db.query(`SELECT name, sql FROM sqlite_master WHERE type = ? AND tbl_name = 'api_key_grants' AND sql IS NOT NULL ORDER BY name`).all(type) as Array<{ name: string; sql: string }>);

describe("migration 039 agent chat", () => {
  test("is registered last, as 39, and creates every table of the plan", () => {
    // Wave 42: 040 (the Audit log guards) follows it; 046 (attachments, which triggers on chat_messages) comes after 044, and 047 (legacy attachments) after it.
    expect(registeredMigrationIds.slice(registeredMigrationIds.indexOf(39))).toEqual([39, 40, 41, 42, 43, 44, 46, 47, 48, 49, 50, 51, 52, 53, 55, 56, 57, 58, 59, 60]);
    expect(agentChatMigration.name).toBe("agent_chat");
    const db = openDb();
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    for (const table of ["agent_settings", "agent_providers", "agent_tool_servers", "agent_tool_policies", "agents", "agent_tools", "agent_access", "agent_user_links", "chats", "chat_messages", "chat_fts", "chat_public_shares", "agent_runs", "agent_audit_entries", "agent_audit_steps", "agent_usage_daily", "knowledge_bases", "kb_sources", "kb_chunks", "kb_chunk_fts"]) {
      expect({ table, found: tables.includes(table) }).toEqual({ table, found: true });
    }
    // Fresh databases get the widened words straight away, and a second run changes nothing.
    const before = schemaOf(db, "trigger");
    agentChatMigration.up(db);
    expect(schemaOf(db, "trigger")).toEqual(before);
  });

  test("the api_key_grants rebuild keeps every row, index, and trigger, and accepts the new words (T326)", () => {
    const db = openDb();
    const fresh = { triggers: schemaOf(db, "trigger"), indexes: schemaOf(db, "index") };
    restorePre039Shape(db);
    seed(db);
    const beforeRows = rows(db);
    expect(beforeRows.length).toBe(5);
    // The pre-039 shape refuses the new words and the new rebuild is pending.
    expect(() => db.query("INSERT INTO api_key_grants (id, key_id, module, permission, created_at) VALUES ('gx', 'k1', 'agents', 'read', ?)").run(at)).toThrow();

    rebuildApiKeyGrants(db);

    expect(rows(db)).toEqual(beforeRows);
    expect(schemaOf(db, "trigger")).toEqual(fresh.triggers);
    expect(schemaOf(db, "index")).toEqual(fresh.indexes);
    expect(schemaOf(db, "trigger").map((row) => row.name).sort()).toEqual(["api_key_grants_kind_wall", "api_key_grants_kind_wall_update", "api_key_grants_protected_vault_only", "api_key_grants_protected_vault_only_update", "api_key_grants_vault_shape", "api_key_grants_vault_shape_update"]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'api_key_grants_new'").get()).toBeNull();

    // New words: agents/read on a general key, run on an agent, the Messages plan's words.
    db.query("INSERT INTO api_key_grants (id, key_id, module, permission, created_at) VALUES ('g6', 'k1', 'agents', 'read', ?)").run(at);
    db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, created_at) VALUES ('g7', 'k1', 'agents', 'run', 'agent', 'a1', ?)").run(at);
    db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, created_at) VALUES ('g8', 'k1', 'messages', 'post', 'channel', 'c1', ?)").run(at);
    db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, created_at) VALUES ('g9', 'k1', 'agents', 'read', 'knowledge_base', 'kb1', ?)").run(at);
    // Unknown words are still refused.
    expect(() => db.query("INSERT INTO api_key_grants (id, key_id, module, permission, created_at) VALUES ('gz', 'k1', 'robots', 'read', ?)").run(at)).toThrow();
    expect(() => db.query("INSERT INTO api_key_grants (id, key_id, module, permission, created_at) VALUES ('gz', 'k1', 'notes', 'own', ?)").run(at)).toThrow();
    // The kind wall holds both ways (D264).
    expect(() => db.query("INSERT INTO api_key_grants (id, key_id, module, permission, created_at) VALUES ('gz', 'k2', 'agents', 'read', ?)").run(at)).toThrow(/KEY_KIND_WALL/);
    expect(() => db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, created_at) VALUES ('gz', 'k1', 'vault', 'read', 'vault', 'v1', ?)").run(at)).toThrow(/KEY_KIND_WALL/);
    // 038's vault shape triggers survived: a protected flag on a non-vault grant is refused.
    expect(() => db.query("INSERT INTO api_key_grants (id, key_id, module, permission, created_at, protected_at_grant) VALUES ('gz', 'k1', 'notes', 'read', ?, 1)").run(at)).toThrow(/VAULT_GRANT_SHAPE/);
    // The unique index survived.
    expect(() => db.query("INSERT INTO api_key_grants (id, key_id, module, permission, created_at) VALUES ('gz', 'k1', 'agents', 'read', ?)").run(at)).toThrow();
    // Triggers on other tables still reach the rebuilt table: purging the note removes its grant (T206).
    db.query("DELETE FROM notes WHERE id = 'n1'").run();
    expect(db.query("SELECT 1 FROM api_key_grants WHERE id = 'g2'").get()).toBeNull();
    // Purging the key cascades.
    db.query("DELETE FROM mcp_api_keys WHERE id = 'k1'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM api_key_grants WHERE key_id = 'k1'").get()).toEqual({ count: 0 });
    // And the migration is idempotent on the rebuilt shape.
    const after = { triggers: schemaOf(db, "trigger"), rows: rows(db) };
    rebuildApiKeyGrants(db);
    expect({ triggers: schemaOf(db, "trigger"), rows: rows(db) }).toEqual(after);
  });

  test("against the genuine 025+038 shape (every migration but 039 applied), the rebuild reproduces the indexes and triggers and keeps every row (T326, review L10)", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const skipped of [39, 40, 41, 42, 46, 47, 49, 50, 52]) db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, 'skipped', ?)").run(skipped, at);
    runMigrations(db);
    db.query("DELETE FROM schema_migrations WHERE id IN (39, 40, 41, 42)").run();
    const normalize = (list: Array<{ name: string; sql: string }>) => list.map((row) => ({ name: row.name, sql: row.sql.replace(/\s+/g, " ").trim() }));
    const before = { triggers: normalize(schemaOf(db, "trigger")), indexes: normalize(schemaOf(db, "index")), columns: db.query("PRAGMA table_info(api_key_grants)").all() };
    expect(before.triggers).toHaveLength(6);
    expect(before.indexes).toHaveLength(2);
    seed(db);
    const beforeRows = rows(db);
    expect(() => db.query("INSERT INTO api_key_grants (id, key_id, module, permission, created_at) VALUES ('gx', 'k1', 'agents', 'read', ?)").run(at)).toThrow();
    db.transaction(() => agentChatMigration.up(db))();
    expect(normalize(schemaOf(db, "trigger"))).toEqual(before.triggers);
    expect(normalize(schemaOf(db, "index"))).toEqual(before.indexes);
    expect(db.query("PRAGMA table_info(api_key_grants)").all()).toEqual(before.columns);
    expect(rows(db)).toEqual(beforeRows);
    expect(db.query("PRAGMA legacy_alter_table").get()).toEqual({ legacy_alter_table: 0 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.query("INSERT INTO api_key_grants (id, key_id, module, permission, created_at) VALUES ('gx', 'k1', 'agents', 'read', ?)").run(at);
  });

  test("the widened word lists contain every old word", () => {
    for (const word of ["notes", "files", "tasks", "today", "calendar", "collections", "team", "inbox", "bin", "whiteboards", "vault"]) expect(GRANT_WORDS.module).toContain(word);
    for (const word of ["read", "comment", "write", "draft", "publish", "create"]) expect(GRANT_WORDS.permission).toContain(word);
    for (const word of ["folder", "note", "document", "board", "task_view", "collection", "calendar", "routine", "whiteboard", "vault"]) expect(GRANT_WORDS.resourceKind).toContain(word);
  });

  test("purging an agent, a chat, or a knowledge base removes the rows that name it", () => {
    const db = openDb();
    seed(db);
    db.query("INSERT INTO agents (id, owner_id, name, created_at, updated_at) VALUES ('a1', 'u2', 'Helper', ?, ?)").run(at, at);
    db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, created_at) VALUES ('g6', 'k1', 'agents', 'run', 'agent', 'a1', ?)").run(at);
    db.query("INSERT INTO agent_access (resource_kind, resource_id, user_id, level, created_at) VALUES ('agent', 'a1', 'u1', 'view', ?)").run(at);
    db.query("INSERT INTO chats (id, owner_id, agent_id, title, created_at, updated_at) VALUES ('c1', 'u2', 'a1', 'Hello', ?, ?)").run(at, at);
    db.query("INSERT INTO chat_messages (id, chat_id, role, content, created_at) VALUES ('m1', 'c1', 'user', 'hi', ?)").run(at);
    db.query("INSERT INTO chat_fts (chat_id, owner_id, title, body) VALUES ('c1', 'u2', 'Hello', 'hi')").run();
    db.query("INSERT INTO agent_runs (id, via, agent_id, agent_revision, prompt_sha256, preamble_version, chat_id, user_id, model, status, queued_at) VALUES ('r1', 'chat', 'a1', 1, 'x', 1, 'c1', 'u2', 'm', 'ok', ?)").run(at);
    db.query("DELETE FROM chats WHERE id = 'c1'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM chat_messages").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_runs").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM chat_fts WHERE chat_id = 'c1'").get()).toEqual({ count: 0 });
    db.query("DELETE FROM agents WHERE id = 'a1'").run();
    expect(db.query("SELECT 1 FROM api_key_grants WHERE id = 'g6'").get()).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM agent_access").get()).toEqual({ count: 0 });
  });
});
