import { config } from "../config";
import { VaultError } from "./access";
import { verifyKeys } from "./crypto";

/**
 * Whether the vault module is on (D212, T199). Off when VAULT_ENCRYPTION_KEY is unset, and off (the
 * app keeps running) when the configured key does not open the stored vault keys: a changed or
 * mistyped key on restore. Decided once at startup; the log line names the state, never the key.
 */
export type VaultStatus = { enabled: boolean; reason: "unset" | "key_mismatch" | null };

let status: VaultStatus = { enabled: false, reason: "unset" };

export function initVaultStatus(log: (line: string) => void = (line) => console.log(line)): VaultStatus {
  const key = config.vault.key;
  if (!key) {
    status = { enabled: false, reason: "unset" };
    log("Vault: VAULT_ENCRYPTION_KEY is not set, so the vault module is off (see docs/OPERATIONS.md, Vault).");
    return status;
  }
  const checked = verifyKeys(key, { liveOnly: true });
  if (checked.failed > 0) {
    status = { enabled: false, reason: "key_mismatch" };
    log(`Vault: VAULT_ENCRYPTION_KEY does not open ${checked.failed} of ${checked.keys} vault keys, so the vault module is off. Restore the key these vaults were created with, then run: bun server/vault-admin.ts verify-key`);
    return status;
  }
  status = { enabled: true, reason: null };
  log(`Vault: on (${checked.vaults} ${checked.vaults === 1 ? "vault" : "vaults"}; the key comes from ${config.vault.source === "file" ? "VAULT_ENCRYPTION_KEY_FILE" : "VAULT_ENCRYPTION_KEY"}).`);
  return status;
}

export const vaultStatus = (): VaultStatus => status;

/** 503 VAULT_DISABLED while the module is off. */
export function requireVaultEnabled() {
  if (!status.enabled) throw new VaultError(503, "VAULT_DISABLED", "The vault is not configured on this server");
}

/** Test hook: switch the key in process and decide again (quietly). */
export function setVaultKeyForTests(key: Buffer | null) {
  config.vault.key = key;
  config.vault.source = key ? "env" : null;
  return initVaultStatus(() => undefined);
}
