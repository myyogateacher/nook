import type { Migration } from "./types";

/**
 * The Vault (Wave 25, docs/plan/research/2026-09-28-password-vault-module.md §5, D211–D230). The
 * plan reserved `024_vault`; 024 and 025 went to Access, so this is 031 (the id the parallel waves
 * left free).
 *
 * - `vaults`, `vault_keys` (one AES-256-GCM data key per vault and generation, wrapped by the server's
 *   VAULT_ENCRYPTION_KEY; deleting a vault's rows crypto-shreds it), `vault_environments`,
 *   `vault_secrets`, `vault_values` (the current value per secret and environment), and
 *   `vault_value_versions` (the last 20 per secret and environment, D224). Every `*_ct` column holds
 *   the `v1:<nonce>:<tag>:<ciphertext>` envelope; names, slugs, and tags are plaintext (D222).
 * - `vault_members` and `vault_env_access` exist from the start so Wave 26 (members and
 *   per-environment levels) adds no table; Wave 25 writes only owner rows.
 * - API keys are not here: the access plan (D264) replaced the vault's own key tables with
 *   `mcp_api_keys.kind = 'vault'` (prefix `nkv_`) and `api_key_grants` with `env_id` (025). Purging a
 *   vault or an environment removes the grants and group grants that name it (T206).
 * - `vault_events` is append-only (ids and counts, never values; T188), except the cascade when its
 *   vault is purged and an actor becoming NULL once that account is gone.
 * - `vault_rate_limits` holds the reveal, read, and write windows (§7), so they survive a restart.
 *
 * Triggers: the last owner of a live vault cannot be removed or demoted (`LAST_OWNER`); a value, a
 * version, or an access row naming an environment of another vault is refused (`VAULT_MISMATCH`).
 * Needs 001 (users) and 025 (api_key_grants, group_grants). Transactional and filesystem-free.
 */
export const vaultMigration: Migration = {
  id: 31,
  name: "vault",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vaults (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
        current_generation INTEGER NOT NULL DEFAULT 1 CHECK (current_generation >= 1),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        purge_after TEXT,
        purge_started_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS vaults_owner ON vaults(owner_id);
      CREATE INDEX IF NOT EXISTS vaults_binned ON vaults(purge_after) WHERE deleted_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS vault_keys (
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        wrapped_dek TEXT NOT NULL CHECK (length(wrapped_dek) <= 200),
        created_at TEXT NOT NULL,
        retired_at TEXT,
        PRIMARY KEY (vault_id, generation)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS vault_environments (
        id TEXT PRIMARY KEY,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 32 AND slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*'),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
        position INTEGER NOT NULL,
        protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0, 1)),
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        purge_after TEXT,
        purge_started_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS vault_env_slug ON vault_environments(vault_id, slug) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS vault_env_vault ON vault_environments(vault_id, position);

      CREATE TABLE IF NOT EXISTS vault_members (
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (vault_id, user_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS vault_members_user ON vault_members(user_id, vault_id);

      CREATE TABLE IF NOT EXISTS vault_env_access (
        vault_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        env_id TEXT NOT NULL REFERENCES vault_environments(id) ON DELETE CASCADE,
        level TEXT NOT NULL CHECK (level IN ('read', 'write', 'admin')),
        PRIMARY KEY (vault_id, user_id, env_id),
        FOREIGN KEY (vault_id, user_id) REFERENCES vault_members(vault_id, user_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS vault_secrets (
        id TEXT PRIMARY KEY,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
        type TEXT NOT NULL CHECK (type IN ('value', 'login', 'note')),
        comment_ct TEXT CHECK (comment_ct IS NULL OR length(comment_ct) <= 4096),
        comment_generation INTEGER CHECK ((comment_ct IS NULL) = (comment_generation IS NULL)),
        tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array' AND length(tags) <= 1024),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_via_key TEXT,
        created_at TEXT NOT NULL,
        updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        updated_via_key TEXT,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        purge_after TEXT,
        purge_started_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS vault_secret_name ON vault_secrets(vault_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS vault_secrets_binned ON vault_secrets(purge_after) WHERE deleted_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS vault_values (
        secret_id TEXT NOT NULL REFERENCES vault_secrets(id) ON DELETE CASCADE,
        env_id TEXT NOT NULL REFERENCES vault_environments(id) ON DELETE CASCADE,
        value_ct TEXT NOT NULL CHECK (length(value_ct) <= 90000),
        comment_ct TEXT CHECK (comment_ct IS NULL OR length(comment_ct) <= 4096),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        version INTEGER NOT NULL CHECK (version >= 1),
        updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        updated_via_key TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (secret_id, env_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS vault_values_env ON vault_values(env_id);

      CREATE TABLE IF NOT EXISTS vault_value_versions (
        secret_id TEXT NOT NULL REFERENCES vault_secrets(id) ON DELETE CASCADE,
        env_id TEXT NOT NULL REFERENCES vault_environments(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version >= 1),
        value_ct TEXT CHECK (value_ct IS NULL OR length(value_ct) <= 90000),
        comment_ct TEXT CHECK (comment_ct IS NULL OR length(comment_ct) <= 4096),
        cleared INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0, 1)),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_via_key TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (secret_id, env_id, version),
        CHECK ((cleared = 1) = (value_ct IS NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS vault_value_versions_env ON vault_value_versions(env_id);

      CREATE TABLE IF NOT EXISTS vault_events (
        id TEXT PRIMARY KEY,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        key_id TEXT,
        via TEXT NOT NULL CHECK (via IN ('session', 'api', 'mcp', 'sweeper', 'cli')),
        event TEXT NOT NULL CHECK (length(event) <= 40),
        secret_id TEXT,
        env_id TEXT,
        count INTEGER,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS vault_events_vault ON vault_events(vault_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS vault_events_actor ON vault_events(actor_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS vault_rate_limits (
        bucket TEXT PRIMARY KEY CHECK (length(bucket) <= 120),
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL CHECK (count >= 0),
        previous_count INTEGER NOT NULL DEFAULT 0 CHECK (previous_count >= 0)
      ) STRICT, WITHOUT ROWID;

      -- D214: a live vault always keeps an owner. The vault's purge (its row is gone) cascades freely.
      CREATE TRIGGER IF NOT EXISTS vault_keep_one_owner BEFORE UPDATE OF role ON vault_members
      WHEN OLD.role = 'owner' AND NEW.role <> 'owner'
        AND NOT EXISTS (SELECT 1 FROM vault_members m WHERE m.vault_id = OLD.vault_id AND m.user_id <> OLD.user_id AND m.role = 'owner')
      BEGIN SELECT RAISE(ABORT, 'LAST_OWNER'); END;
      CREATE TRIGGER IF NOT EXISTS vault_keep_one_owner_delete BEFORE DELETE ON vault_members
      WHEN OLD.role = 'owner'
        AND EXISTS (SELECT 1 FROM vaults v WHERE v.id = OLD.vault_id)
        AND NOT EXISTS (SELECT 1 FROM vault_members m WHERE m.vault_id = OLD.vault_id AND m.user_id <> OLD.user_id AND m.role = 'owner')
      BEGIN SELECT RAISE(ABORT, 'LAST_OWNER'); END;

      -- Append-only (T83 pattern): no edits except the actor becoming NULL when that account is gone,
      -- and no deletes except the cascade of the vault's own purge.
      CREATE TRIGGER IF NOT EXISTS vault_events_no_update BEFORE UPDATE ON vault_events
      WHEN NOT (
        OLD.actor_id IS NOT NULL AND NEW.actor_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.actor_id)
        AND NEW.id = OLD.id AND NEW.vault_id = OLD.vault_id AND NEW.key_id IS OLD.key_id AND NEW.via = OLD.via
        AND NEW.event = OLD.event AND NEW.secret_id IS OLD.secret_id AND NEW.env_id IS OLD.env_id
        AND NEW.count IS OLD.count AND NEW.created_at = OLD.created_at
      )
      BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS vault_events_no_delete BEFORE DELETE ON vault_events
      WHEN EXISTS (SELECT 1 FROM vaults WHERE id = OLD.vault_id)
      BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;

      -- A value, a version, or an access row never names an environment of another vault.
      CREATE TRIGGER IF NOT EXISTS vault_values_same_vault BEFORE INSERT ON vault_values
      WHEN (SELECT vault_id FROM vault_secrets WHERE id = NEW.secret_id) IS NOT (SELECT vault_id FROM vault_environments WHERE id = NEW.env_id)
      BEGIN SELECT RAISE(ABORT, 'VAULT_MISMATCH'); END;
      CREATE TRIGGER IF NOT EXISTS vault_values_same_vault_update BEFORE UPDATE OF secret_id, env_id ON vault_values
      WHEN (SELECT vault_id FROM vault_secrets WHERE id = NEW.secret_id) IS NOT (SELECT vault_id FROM vault_environments WHERE id = NEW.env_id)
      BEGIN SELECT RAISE(ABORT, 'VAULT_MISMATCH'); END;
      CREATE TRIGGER IF NOT EXISTS vault_value_versions_same_vault BEFORE INSERT ON vault_value_versions
      WHEN (SELECT vault_id FROM vault_secrets WHERE id = NEW.secret_id) IS NOT (SELECT vault_id FROM vault_environments WHERE id = NEW.env_id)
      BEGIN SELECT RAISE(ABORT, 'VAULT_MISMATCH'); END;
      CREATE TRIGGER IF NOT EXISTS vault_value_versions_same_vault_update BEFORE UPDATE OF secret_id, env_id ON vault_value_versions
      WHEN (SELECT vault_id FROM vault_secrets WHERE id = NEW.secret_id) IS NOT (SELECT vault_id FROM vault_environments WHERE id = NEW.env_id)
      BEGIN SELECT RAISE(ABORT, 'VAULT_MISMATCH'); END;
      CREATE TRIGGER IF NOT EXISTS vault_env_access_same_vault BEFORE INSERT ON vault_env_access
      WHEN NEW.vault_id IS NOT (SELECT vault_id FROM vault_environments WHERE id = NEW.env_id)
      BEGIN SELECT RAISE(ABORT, 'VAULT_MISMATCH'); END;

      -- Purging a vault or an environment removes the key and group grants that name it (T206, D264).
      CREATE TRIGGER IF NOT EXISTS vaults_purge_access_grants AFTER DELETE ON vaults
      BEGIN
        DELETE FROM api_key_grants WHERE resource_kind = 'vault' AND resource_id = OLD.id;
        DELETE FROM group_grants WHERE resource_kind = 'vault' AND resource_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS vault_environments_purge_access_grants AFTER DELETE ON vault_environments
      BEGIN
        DELETE FROM api_key_grants WHERE module = 'vault' AND resource_id = OLD.vault_id AND env_id = OLD.id;
        DELETE FROM group_grants WHERE resource_kind = 'vault' AND resource_id = OLD.vault_id AND env_id = OLD.id;
      END;
    `);
  }
};
