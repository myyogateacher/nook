import { addColumn, type Migration } from "./types";

/**
 * Agents get Nook's own tools without a linked key (C2):
 *
 * - `mcp_api_keys.internal`: 1 for the hidden key Nook provisions per person for their agents' Nook
 *   tools (read scopes plus `inbox:write`, writes as Inbox proposals only). It is never shown as a
 *   usable secret, cannot be narrowed or rotated, and is refused over HTTP and MCP from outside; it
 *   works in process only. Its owner or an admin can revoke it.
 * - `agents.nook_auto`: the per-agent toggle "Give this agent Nook's tools automatically" (default on).
 *
 * - `agent_settings` gains the key `nook_auto_tools` (the admin setting "Give agents Nook's tools
 *   automatically", default on when unset). Its keys are fixed in a CHECK, so it is rebuilt from its own
 *   CREATE text with the word added, every row copied: 053's pattern (no children, triggers, or indexes).
 *
 * The key and agent columns are plain additions (no CHECK of those tables changes, so no rebuild).
 * Needs 005, 039, and 053.
 * Transactional and filesystem-free; re-running changes nothing.
 */
/** agent_settings with `nook_auto_tools` in its key CHECK (a no-op when it is there or the table is missing). */
function addNookAutoSettingKey(db: import("bun:sqlite").Database) {
  const current = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_settings'").get() as { sql: string } | null)?.sql;
  if (!current || current.includes("'nook_auto_tools'")) return;
  const check = /key TEXT PRIMARY KEY CHECK \(key IN \(([^)]*)\)\)/.exec(current);
  if (!check) throw new Error("Migration 057 cannot read agent_settings' key CHECK");
  const rebuilt = current.replace(check[0], `key TEXT PRIMARY KEY CHECK (key IN (${check[1]!.trimEnd()},'nook_auto_tools'))`).replace(/CREATE TABLE (?:IF NOT EXISTS )?"?agent_settings"?/, "CREATE TABLE agent_settings_r057");
  const broken = db.query("PRAGMA foreign_key_check(agent_settings)").all() as Array<{ parent: string }>;
  if (broken.length) throw new Error(`Migration 057 cannot rebuild agent_settings: ${broken.length} row(s) reference a missing ${broken[0]!.parent} row (updated_by); clear those references and restart`);
  const columns = (db.query("PRAGMA table_info(agent_settings)").all() as Array<{ name: string }>).map((column) => `"${column.name}"`).join(", ");
  db.exec(rebuilt);
  db.exec(`INSERT INTO agent_settings_r057 (${columns}) SELECT ${columns} FROM agent_settings`);
  db.exec("DROP TABLE agent_settings");
  db.exec("ALTER TABLE agent_settings_r057 RENAME TO agent_settings");
}

export const agentInternalKeysMigration: Migration = {
  id: 57,
  name: "agent_internal_keys",
  up(db) {
    addColumn(db, "mcp_api_keys", "internal", "INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0,1))");
    db.exec("CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_internal ON mcp_api_keys(user_id, created_at) WHERE internal = 1");
    if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get()) {
      addColumn(db, "agents", "nook_auto", "INTEGER NOT NULL DEFAULT 1 CHECK (nook_auto IN (0,1))");
    }
    addNookAutoSettingKey(db);
  }
};
