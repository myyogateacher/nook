import { addColumn, type Migration } from "./types";

/**
 * Vault sharing and operations (Wave 26 "Vault B", docs/plan/research/2026-09-28-password-vault-module.md
 * §6.1, §6.3, §6.4, §6.6, D214–D216, D226, D227). 031 already has `vault_members`,
 * `vault_env_access`, the `protected` flag, and `vault_keys` by generation, so this adds only what
 * sharing and the operations need:
 *
 * - `sessions.vault_reauth_at`: when this session last re-authenticated for protected environments
 *   (password plus TOTP, D226). The window (15 minutes) is decided in code; a new sign-in starts
 *   without one, and signing out deletes the session and the window with it.
 * - `vaults.stored_bytes`: the ciphertext bytes a vault holds (current values, their history, and
 *   secret comments), kept by triggers so the per-person byte quota (review L5) never needs a scan.
 *   A secret's own delete subtracts its values first (BEFORE DELETE); the cascade that follows finds
 *   no secret row and changes nothing, so a purge is not counted twice. Backfilled here.
 * - `vault_members_person_only`: an integration (`users.kind = 'service'`) never becomes a vault
 *   member, whatever path tries (Wave 26 decision; the API refuses first with a clear message).
 * - `vault_secrets_vault`: every secret of a vault, binned ones included (rotation and quotas).
 *
 * Needs 001, 031, and 036. Transactional and filesystem-free; re-running changes nothing.
 */
const valueBytes = (row: "NEW" | "OLD") => `(ifnull(length(${row}.value_ct), 0) + ifnull(length(${row}.comment_ct), 0))`;
const vaultOfSecret = (row: "NEW" | "OLD") => `(SELECT vault_id FROM vault_secrets WHERE id = ${row}.secret_id)`;

export const vaultSharingMigration: Migration = {
  id: 37,
  name: "vault_sharing",
  up(db) {
    addColumn(db, "sessions", "vault_reauth_at", "TEXT");
    addColumn(db, "vaults", "stored_bytes", "INTEGER NOT NULL DEFAULT 0 CHECK (stored_bytes >= 0)");
    db.exec(`
      CREATE INDEX IF NOT EXISTS vault_secrets_vault ON vault_secrets(vault_id);

      CREATE TRIGGER IF NOT EXISTS vault_members_person_only BEFORE INSERT ON vault_members
      WHEN (SELECT kind FROM users WHERE id = NEW.user_id) IS NOT 'person'
      BEGIN SELECT RAISE(ABORT, 'PERSON_ONLY'); END;

      CREATE TRIGGER IF NOT EXISTS vault_values_bytes_insert AFTER INSERT ON vault_values
      BEGIN UPDATE vaults SET stored_bytes = stored_bytes + ${valueBytes("NEW")} WHERE id = ${vaultOfSecret("NEW")}; END;
      CREATE TRIGGER IF NOT EXISTS vault_values_bytes_update AFTER UPDATE OF value_ct, comment_ct ON vault_values
      BEGIN UPDATE vaults SET stored_bytes = max(0, stored_bytes + ${valueBytes("NEW")} - ${valueBytes("OLD")}) WHERE id = ${vaultOfSecret("NEW")}; END;
      CREATE TRIGGER IF NOT EXISTS vault_values_bytes_delete AFTER DELETE ON vault_values
      BEGIN UPDATE vaults SET stored_bytes = max(0, stored_bytes - ${valueBytes("OLD")}) WHERE id = ${vaultOfSecret("OLD")}; END;

      CREATE TRIGGER IF NOT EXISTS vault_value_versions_bytes_insert AFTER INSERT ON vault_value_versions
      BEGIN UPDATE vaults SET stored_bytes = stored_bytes + ${valueBytes("NEW")} WHERE id = ${vaultOfSecret("NEW")}; END;
      CREATE TRIGGER IF NOT EXISTS vault_value_versions_bytes_update AFTER UPDATE OF value_ct, comment_ct ON vault_value_versions
      BEGIN UPDATE vaults SET stored_bytes = max(0, stored_bytes + ${valueBytes("NEW")} - ${valueBytes("OLD")}) WHERE id = ${vaultOfSecret("NEW")}; END;
      CREATE TRIGGER IF NOT EXISTS vault_value_versions_bytes_delete AFTER DELETE ON vault_value_versions
      BEGIN UPDATE vaults SET stored_bytes = max(0, stored_bytes - ${valueBytes("OLD")}) WHERE id = ${vaultOfSecret("OLD")}; END;

      CREATE TRIGGER IF NOT EXISTS vault_secrets_bytes_insert AFTER INSERT ON vault_secrets
      BEGIN UPDATE vaults SET stored_bytes = stored_bytes + ifnull(length(NEW.comment_ct), 0) WHERE id = NEW.vault_id; END;
      CREATE TRIGGER IF NOT EXISTS vault_secrets_bytes_update AFTER UPDATE OF comment_ct ON vault_secrets
      BEGIN UPDATE vaults SET stored_bytes = max(0, stored_bytes + ifnull(length(NEW.comment_ct), 0) - ifnull(length(OLD.comment_ct), 0)) WHERE id = NEW.vault_id; END;
      -- Before the row goes: its values and versions cascade after it, when the secret row is gone,
      -- so their own triggers find no vault and subtract nothing.
      CREATE TRIGGER IF NOT EXISTS vault_secrets_bytes_delete BEFORE DELETE ON vault_secrets
      BEGIN
        UPDATE vaults SET stored_bytes = max(0, stored_bytes - ifnull(length(OLD.comment_ct), 0)
          - (SELECT ifnull(sum(ifnull(length(value_ct), 0) + ifnull(length(comment_ct), 0)), 0) FROM vault_values WHERE secret_id = OLD.id)
          - (SELECT ifnull(sum(ifnull(length(value_ct), 0) + ifnull(length(comment_ct), 0)), 0) FROM vault_value_versions WHERE secret_id = OLD.id))
        WHERE id = OLD.vault_id;
      END;

      UPDATE vaults SET stored_bytes =
        (SELECT ifnull(sum(ifnull(length(comment_ct), 0)), 0) FROM vault_secrets s WHERE s.vault_id = vaults.id)
        + (SELECT ifnull(sum(ifnull(length(v.value_ct), 0) + ifnull(length(v.comment_ct), 0)), 0) FROM vault_values v JOIN vault_secrets s ON s.id = v.secret_id WHERE s.vault_id = vaults.id)
        + (SELECT ifnull(sum(ifnull(length(h.value_ct), 0) + ifnull(length(h.comment_ct), 0)), 0) FROM vault_value_versions h JOIN vault_secrets s ON s.id = h.secret_id WHERE s.vault_id = vaults.id);
    `);
  }
};
