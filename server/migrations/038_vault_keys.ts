import { addColumn, type Migration } from "./types";

/**
 * Vault keys (Wave 27 "Vault C", docs/plan/research/2026-09-28-password-vault-module.md §7, §7.1,
 * D217–D221, T182–T184, T191–T192; access plan D264, T217). 025 already has the key kind (`vault`,
 * prefix `nkv_`), `allow_mcp_value_reads`, and `api_key_grants.env_id`, and 031 removes grants when
 * a vault or an environment is purged, so this adds only what the vault keys themselves need:
 *
 * - `mcp_api_keys.vault_protected_access`: whether a vault key may reach protected environments
 *   (D226). It reaches one only when a grant names that environment explicitly AND this flag was set
 *   when the key was created (under the creation's password-plus-code re-authentication); a grant
 *   over "every environment" never covers a protected one.
 * - Both vault flags live on vault keys only, and an update may only turn them off (narrowing, D278):
 *   turning one on needs a new key or a rotation.
 * - A vault key belongs to a person: integrations are never vault members (037), so a key they own
 *   could never reach a vault; it is refused rather than stored.
 * - The shape of a vault grant: `resource_kind = 'vault'` with a vault id, permission `read` or
 *   `write`, and an `env_id` (or NULL for every environment) of that same vault. 025's kind wall
 *   still keeps vault grants on vault keys and other grants off them.
 * - `vault_events(key_id, created_at)`: a key's own "Recent activity" reads its vault events.
 *
 * Needs 025, 031, and 036. Transactional and filesystem-free; re-running changes nothing.
 */
export const vaultKeysMigration: Migration = {
  id: 38,
  name: "vault_keys",
  up(db) {
    addColumn(db, "mcp_api_keys", "vault_protected_access", "INTEGER NOT NULL DEFAULT 0 CHECK (vault_protected_access IN (0,1))");
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS api_keys_vault_flags_insert BEFORE INSERT ON mcp_api_keys
      WHEN NEW.kind <> 'vault' AND (NEW.allow_mcp_value_reads = 1 OR NEW.vault_protected_access = 1)
      BEGIN SELECT RAISE(ABORT, 'VAULT_FLAGS_ON_GENERAL_KEY'); END;
      CREATE TRIGGER IF NOT EXISTS api_keys_vault_flags_widen BEFORE UPDATE OF allow_mcp_value_reads, vault_protected_access ON mcp_api_keys
      WHEN NEW.allow_mcp_value_reads > OLD.allow_mcp_value_reads OR NEW.vault_protected_access > OLD.vault_protected_access
      BEGIN SELECT RAISE(ABORT, 'WIDENING_NOT_ALLOWED'); END;
      CREATE TRIGGER IF NOT EXISTS api_keys_vault_person_only BEFORE INSERT ON mcp_api_keys
      WHEN NEW.kind = 'vault' AND (SELECT kind FROM users WHERE id = NEW.user_id) IS NOT 'person'
      BEGIN SELECT RAISE(ABORT, 'PERSON_ONLY'); END;

      CREATE TRIGGER IF NOT EXISTS api_key_grants_vault_shape BEFORE INSERT ON api_key_grants
      WHEN NEW.module = 'vault' AND (SELECT kind FROM mcp_api_keys WHERE id = NEW.key_id) = 'vault' AND (
        NEW.resource_kind IS NOT 'vault' OR NEW.resource_id IS NULL OR NEW.permission NOT IN ('read', 'write')
        OR (NEW.env_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vault_environments e WHERE e.id = NEW.env_id AND e.vault_id = NEW.resource_id))
      )
      BEGIN SELECT RAISE(ABORT, 'VAULT_GRANT_SHAPE'); END;
      CREATE TRIGGER IF NOT EXISTS api_key_grants_vault_shape_update BEFORE UPDATE ON api_key_grants
      WHEN NEW.module = 'vault'
      BEGIN SELECT RAISE(ABORT, 'VAULT_GRANT_SHAPE'); END;

      CREATE INDEX IF NOT EXISTS vault_events_key ON vault_events(key_id, created_at DESC) WHERE key_id IS NOT NULL;
    `);
  }
};
