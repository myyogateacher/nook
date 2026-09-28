import type { Database } from "bun:sqlite";
import { addColumn, type Migration } from "./types";

/**
 * Access management and Nook keys (docs/plan/research/2026-09-28-access-management-api-keys.md
 * §C.8, D261–D288). One step for the whole access schema, so Waves 32–34 add no migration:
 *
 * - `mcp_api_keys` (the table keeps its name, D261) gains a kind (`general`, or `vault` for the
 *   reserved `nkv_` prefix, D264), a description, surfaces (D279), expiry (D276; NULL only for keys
 *   made before this migration), rotation grace and lineage (D277), who revoked it and why, lower
 *   per-key limits (D282), an IP allowlist (D284, hidden until TRUSTED_PROXY_HOPS), the vault value
 *   flag, and `created_by` (service accounts, D287).
 * - `api_key_grants` (D262): one row per `{module, permission, resource?, env?}`. A NULL resource is
 *   every resource in the module. Triggers keep vault grants on vault keys only and vault keys to
 *   vault grants only (the kind wall, T217), and every resource table's AFTER DELETE removes its
 *   grants (T206).
 * - `api_key_usage` (D283), `user_groups`, `group_members`, `group_grants` (D267, used from Wave 32),
 *   per-person `level` columns whose defaults reproduce today's sharing exactly (D272), `users.kind`
 *   (D287), `team_settings` (org policies, D285), `access_templates` (D286), and the append-only
 *   `access_events` log (D288). `access_grants_v` is the read-only view central pages read (D270).
 *
 * Backfill (D262): every existing key gets one grant per stored scope over "all", so no key gains
 * or loses power. The scope → grant table is frozen here on purpose (append-only migrations); the
 * live mapping is server/keyGrants.ts. `scopes` stays written as a mirror for one release.
 *
 * Needs 005, 010 (keys and scopes), 009, 012, 013, 017, 018, 020, and 021. Independent of 023, 024,
 * 026, and 027. Transactional and filesystem-free.
 */

/** Frozen at 025: every MCP scope that existed when this migration was written. */
const SCOPE_GRANTS: Record<string, { module: string; permission: string }> = {
  "notes:read": { module: "notes", permission: "read" },
  "notes:write-draft": { module: "notes", permission: "draft" },
  "notes:publish": { module: "notes", permission: "publish" },
  "files:read": { module: "files", permission: "read" },
  "files:write": { module: "files", permission: "write" },
  "tasks:read": { module: "tasks", permission: "read" },
  "tasks:write": { module: "tasks", permission: "write" },
  "today:read": { module: "today", permission: "read" },
  "calendar:read": { module: "calendar", permission: "read" },
  "calendar:write": { module: "calendar", permission: "write" },
  "collections:read": { module: "collections", permission: "read" },
  "collections:write": { module: "collections", permission: "write" },
  "bin:write": { module: "bin", permission: "write" },
  "team:read": { module: "team", permission: "read" },
  "inbox:read": { module: "inbox", permission: "read" },
  "inbox:write": { module: "inbox", permission: "write" }
};

/** Mirrors server/mcpScopes.ts parseStoredScopes as of 025: a non-array value meant notes:read. */
function storedScopes(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return ["notes:read"];
    return value.filter((scope): scope is string => typeof scope === "string" && scope in SCOPE_GRANTS);
  } catch {
    return ["notes:read"];
  }
}

function backfillGrants(db: Database) {
  const at = new Date().toISOString();
  const keys = db.query("SELECT id, scopes FROM mcp_api_keys").all() as Array<{ id: string; scopes: string }>;
  const insert = db.query("INSERT OR IGNORE INTO api_key_grants (id, key_id, module, permission, created_at) VALUES (?, ?, ?, ?, ?)");
  for (const key of keys) {
    for (const scope of storedScopes(key.scopes)) {
      const grant = SCOPE_GRANTS[scope]!;
      insert.run(crypto.randomUUID(), key.id, grant.module, grant.permission, at);
    }
  }
}

const RESOURCE_TABLES: Array<{ table: string; kind: string; groups: boolean }> = [
  { table: "notes", kind: "note", groups: true },
  { table: "folders", kind: "folder", groups: true },
  { table: "documents", kind: "document", groups: true },
  { table: "boards", kind: "board", groups: true },
  { table: "task_views", kind: "task_view", groups: true },
  { table: "collections", kind: "collection", groups: true },
  { table: "calendars", kind: "calendar", groups: true },
  { table: "routines", kind: "routine", groups: false }
];

export const accessKeysMigration: Migration = {
  id: 25,
  name: "access_keys",
  up(db) {
    // Keys (D261, D264, D276–D284).
    addColumn(db, "mcp_api_keys", "kind", "TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('general','vault'))");
    addColumn(db, "mcp_api_keys", "description", "TEXT CHECK (description IS NULL OR length(description) <= 200)");
    addColumn(db, "mcp_api_keys", "surfaces", "TEXT NOT NULL DEFAULT 'mcp' CHECK (surfaces IN ('mcp','rest','both'))");
    addColumn(db, "mcp_api_keys", "expires_at", "TEXT");
    addColumn(db, "mcp_api_keys", "revoke_after", "TEXT");
    addColumn(db, "mcp_api_keys", "rotated_from", "TEXT REFERENCES mcp_api_keys(id) ON DELETE SET NULL");
    addColumn(db, "mcp_api_keys", "revoked_by", "TEXT REFERENCES users(id) ON DELETE SET NULL");
    addColumn(db, "mcp_api_keys", "revoke_reason", "TEXT CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 200)");
    addColumn(db, "mcp_api_keys", "limits_json", "TEXT CHECK (limits_json IS NULL OR json_valid(limits_json))");
    addColumn(db, "mcp_api_keys", "ip_allowlist", "TEXT CHECK (ip_allowlist IS NULL OR json_valid(ip_allowlist))");
    addColumn(db, "mcp_api_keys", "allow_mcp_value_reads", "INTEGER NOT NULL DEFAULT 0 CHECK (allow_mcp_value_reads IN (0,1))");
    addColumn(db, "mcp_api_keys", "created_by", "TEXT REFERENCES users(id) ON DELETE SET NULL");

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_live ON mcp_api_keys(user_id) WHERE revoked_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_grace ON mcp_api_keys(revoke_after) WHERE revoked_at IS NULL AND revoke_after IS NOT NULL;

      -- The vault kind is reserved for the nkv_ prefix, and a general key never carries it (T217).
      CREATE TRIGGER IF NOT EXISTS api_keys_kind_prefix BEFORE INSERT ON mcp_api_keys
      WHEN (NEW.kind = 'vault') <> (substr(NEW.key_prefix, 1, 4) = 'nkv_')
      BEGIN SELECT RAISE(ABORT, 'KEY_KIND_PREFIX'); END;
      CREATE TRIGGER IF NOT EXISTS api_keys_kind_fixed BEFORE UPDATE OF kind, key_prefix ON mcp_api_keys
      WHEN NEW.kind <> OLD.kind OR NEW.key_prefix <> OLD.key_prefix
      BEGIN SELECT RAISE(ABORT, 'KEY_KIND_FIXED'); END;

      CREATE TABLE IF NOT EXISTS api_key_grants (
        id TEXT PRIMARY KEY,
        key_id TEXT NOT NULL REFERENCES mcp_api_keys(id) ON DELETE CASCADE,
        module TEXT NOT NULL CHECK (module IN ('notes','files','tasks','today','calendar','collections','team','inbox','bin','whiteboards','vault')),
        permission TEXT NOT NULL CHECK (permission IN ('read','comment','write','draft','publish','create')),
        resource_kind TEXT CHECK (resource_kind IS NULL OR resource_kind IN
          ('folder','note','document','board','task_view','collection','calendar','routine','whiteboard','vault')),
        resource_id TEXT CHECK (resource_id IS NULL OR length(resource_id) <= 64),
        env_id TEXT CHECK (env_id IS NULL OR length(env_id) <= 64),
        created_at TEXT NOT NULL,
        CHECK ((resource_kind IS NULL) = (resource_id IS NULL)),
        CHECK (env_id IS NULL OR module = 'vault')
      );
      CREATE UNIQUE INDEX IF NOT EXISTS api_key_grant_unique ON api_key_grants(key_id, module, permission,
        COALESCE(resource_kind, '*'), COALESCE(resource_id, '*'), COALESCE(env_id, '*'));
      CREATE INDEX IF NOT EXISTS api_key_grants_resource ON api_key_grants(resource_kind, resource_id) WHERE resource_id IS NOT NULL;

      -- The kind wall (D264): vault grants live only on vault keys, and vault keys hold only vault grants.
      CREATE TRIGGER IF NOT EXISTS api_key_grants_kind_wall BEFORE INSERT ON api_key_grants
      WHEN (NEW.module = 'vault') IS NOT (SELECT kind = 'vault' FROM mcp_api_keys WHERE id = NEW.key_id)
      BEGIN SELECT RAISE(ABORT, 'KEY_KIND_WALL'); END;
      CREATE TRIGGER IF NOT EXISTS api_key_grants_kind_wall_update BEFORE UPDATE OF key_id, module ON api_key_grants
      WHEN (NEW.module = 'vault') IS NOT (SELECT kind = 'vault' FROM mcp_api_keys WHERE id = NEW.key_id)
      BEGIN SELECT RAISE(ABORT, 'KEY_KIND_WALL'); END;

      CREATE TABLE IF NOT EXISTS api_key_usage (
        key_id TEXT NOT NULL REFERENCES mcp_api_keys(id) ON DELETE CASCADE,
        day TEXT NOT NULL CHECK (length(day) = 10),
        calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),
        writes INTEGER NOT NULL DEFAULT 0 CHECK (writes >= 0),
        denied INTEGER NOT NULL DEFAULT 0 CHECK (denied >= 0),
        PRIMARY KEY (key_id, day)
      ) WITHOUT ROWID;

      -- Groups (D267): admin-managed; owners share with a group from Wave 32.
      CREATE TABLE IF NOT EXISTS user_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
        description TEXT CHECK (description IS NULL OR length(description) <= 200),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
      );
      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (group_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS group_members_user ON group_members(user_id, group_id);
      CREATE TABLE IF NOT EXISTS group_grants (
        resource_kind TEXT NOT NULL CHECK (resource_kind IN ('folder','note','document','board','task_view','collection','calendar','vault')),
        resource_id TEXT NOT NULL CHECK (length(resource_id) <= 64),
        group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
        level TEXT NOT NULL CHECK (level IN ('view','comment','edit','manage')),
        env_id TEXT CHECK (env_id IS NULL OR (resource_kind = 'vault' AND length(env_id) <= 64)),
        granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS group_grants_unique ON group_grants(resource_kind, resource_id, group_id, COALESCE(env_id, '*'));
      CREATE INDEX IF NOT EXISTS group_grants_group ON group_grants(group_id);

      -- Org policies (D285): one row per setting, each with its own revision; no row = the default.
      CREATE TABLE IF NOT EXISTS team_settings (
        key TEXT PRIMARY KEY CHECK (key IN ('key_max_days','key_default_days','key_require_expiry','keys_per_user',
          'key_modules_by_role','mcp_roles','rest_roles','groups_member_create','share_with_guests')),
        value_json TEXT NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 4096),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL
      );

      -- Templates (D286): a role plus groups, applied when an invite is accepted (Wave 33).
      CREATE TABLE IF NOT EXISTS access_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
        role TEXT NOT NULL CHECK (role IN ('member','viewer','guest')),
        group_ids TEXT NOT NULL CHECK (json_valid(group_ids) AND json_type(group_ids) = 'array'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
      );

      -- The access activity log (D288): append-only, ids and counts only (T83, T215).
      CREATE TABLE IF NOT EXISTS access_events (
        id TEXT PRIMARY KEY,
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        via TEXT NOT NULL CHECK (via IN ('web','cli','mcp','rest','sweeper','migration')),
        action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 40),
        target_user_id TEXT,
        group_id TEXT,
        key_id TEXT,
        resource_kind TEXT,
        resource_id TEXT,
        meta_json TEXT CHECK (meta_json IS NULL OR (json_valid(meta_json) AND length(meta_json) <= 2048)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS access_events_target ON access_events(target_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS access_events_key ON access_events(key_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS access_events_group ON access_events(group_id);
      CREATE INDEX IF NOT EXISTS access_events_created ON access_events(created_at DESC);
      -- The only change a row accepts is its actor becoming NULL once that account is gone.
      CREATE TRIGGER IF NOT EXISTS access_events_no_update BEFORE UPDATE ON access_events
      WHEN NOT (
        OLD.actor_id IS NOT NULL AND NEW.actor_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.actor_id)
        AND NEW.id = OLD.id AND NEW.via = OLD.via AND NEW.action = OLD.action
        AND NEW.target_user_id IS OLD.target_user_id AND NEW.group_id IS OLD.group_id AND NEW.key_id IS OLD.key_id
        AND NEW.resource_kind IS OLD.resource_kind AND NEW.resource_id IS OLD.resource_id
        AND NEW.meta_json IS OLD.meta_json AND NEW.created_at = OLD.created_at
      )
      BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS access_events_no_delete BEFORE DELETE ON access_events
      BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
    `);

    // Per-person levels (D272). Each default reproduces today's behaviour exactly.
    addColumn(db, "note_shares", "level", "TEXT NOT NULL DEFAULT 'view' CHECK (level IN ('view','edit'))");
    addColumn(db, "folder_shares", "level", "TEXT NOT NULL DEFAULT 'view' CHECK (level IN ('view','edit'))");
    addColumn(db, "document_shares", "level", "TEXT NOT NULL DEFAULT 'view' CHECK (level = 'view')");
    addColumn(db, "board_members", "level", "TEXT NOT NULL DEFAULT 'edit' CHECK (level IN ('view','comment','edit','manage'))");
    addColumn(db, "boards", "share_role", "TEXT NOT NULL DEFAULT 'edit' CHECK (share_role IN ('view','comment','edit'))");
    addColumn(db, "collection_members", "level", "TEXT NOT NULL DEFAULT 'view' CHECK (level IN ('view','edit','manage'))");
    addColumn(db, "calendar_members", "level", "TEXT NOT NULL DEFAULT 'view' CHECK (level IN ('view','edit','manage'))");
    db.exec(`
      UPDATE collection_members SET level = 'edit' WHERE (SELECT share_role FROM collections c WHERE c.id = collection_id) = 'editor';
      UPDATE calendar_members SET level = 'edit' WHERE (SELECT share_role FROM calendars k WHERE k.id = calendar_id) = 'editor';
    `);
    addColumn(db, "users", "kind", "TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person','service'))");
    addColumn(db, "team_invites", "template_id", "TEXT REFERENCES access_templates(id) ON DELETE SET NULL");

    // Purging a resource (a hard DELETE; the Bin keeps rows) removes the grants on it (T206).
    for (const { table, kind, groups } of RESOURCE_TABLES) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_purge_access_grants AFTER DELETE ON ${table}
        BEGIN
          DELETE FROM api_key_grants WHERE resource_kind = '${kind}' AND resource_id = OLD.id;
          ${groups ? `DELETE FROM group_grants WHERE resource_kind = '${kind}' AND resource_id = OLD.id;` : ""}
        END;`);
    }

    // The read-only aggregation central pages use (D270).
    db.exec(`
      CREATE VIEW IF NOT EXISTS access_grants_v AS
        SELECT 'note' AS kind, note_id AS resource_id, user_id, level, 'direct' AS via, NULL AS group_id FROM note_shares
        UNION ALL SELECT 'folder', folder_id, user_id, level, 'direct', NULL FROM folder_shares
        UNION ALL SELECT 'document', document_id, user_id, level, 'direct', NULL FROM document_shares
        UNION ALL SELECT 'board', board_id, user_id, level, 'direct', NULL FROM board_members
        UNION ALL SELECT 'task_view', view_id, user_id, 'view', 'direct', NULL FROM task_view_members
        UNION ALL SELECT 'collection', collection_id, user_id, level, 'direct', NULL FROM collection_members
        UNION ALL SELECT 'calendar', calendar_id, user_id, level, 'direct', NULL FROM calendar_members
        UNION ALL SELECT g.resource_kind, g.resource_id, gm.user_id, g.level, 'group', g.group_id
          FROM group_grants g JOIN group_members gm ON gm.group_id = g.group_id;
    `);

    backfillGrants(db);
  }
};
