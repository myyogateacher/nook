import { useEffect, useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Select } from "../ui/Select";
import { listVaults } from "../vault/vaultApi";
import {
  ALL_ENVS, envChoices, grantableVaults, MAX_VAULT_GRANTS, permissionChoicesFor, vaultGrantSummary,
  type VaultChoice, type VaultGrantRow
} from "./vaultKeyGrants";

/**
 * The vault key grant builder (Wave 27, vault plan §10 "Vault API keys"): one row per vault,
 * environment, and access. Only vaults and environments the creator can reach are offered, each at
 * the levels they hold; protected environments are marked and open only with "Allow protected
 * environments". Custom Select only (D91); 44 px controls at 390 px.
 *
 * `ceiling` switches it to narrowing (D278): a row can be removed, lowered to read, or moved from
 * "every environment" to one (only on a key without protected access); nothing can be added.
 */

let rowCounter = 0;
export const newVaultRowKey = () => `vault-row-${++rowCounter}`;

/** A new row on the first vault the creator can grant, at read, on the first environment it may name. */
export function firstVaultRow(vaults: readonly VaultChoice[], protectedAccess: boolean): VaultGrantRow | null {
  const first = grantableVaults(vaults)[0];
  if (!first) return null;
  const env = envChoices(first, protectedAccess).find((option) => !option.disabled)?.value ?? ALL_ENVS;
  return { key: newVaultRowKey(), vaultId: first.id, envId: env, permission: "read" };
}

/** The creator's vaults for the builder, loaded once per dialog. */
export function useVaultChoices(enabled = true) {
  const [vaults, setVaults] = useState<VaultChoice[] | "error" | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    listVaults().then((result) => { if (live) setVaults(result.vaults.map((vault) => ({ id: vault.id, name: vault.name, environments: vault.environments }))); }, () => { if (live) setVaults("error"); });
    return () => { live = false; };
  }, [enabled]);
  return vaults;
}

export function VaultGrantBuilder({ rows, onChange, vaults, role, protectedAccess, disabled = false, ceiling }: {
  rows: VaultGrantRow[];
  onChange: (rows: VaultGrantRow[]) => void;
  vaults: VaultChoice[] | "error" | null;
  role: string | undefined;
  protectedAccess: boolean;
  disabled?: boolean;
  ceiling?: readonly VaultGrantRow[];
}) {
  const narrowing = ceiling !== undefined;
  if (vaults === "error") return <p className="form-error" role="alert">Could not load your vaults.</p>;
  if (vaults === null) return <p className="grant-empty" role="status">Loading your vaults…</p>;
  const choices = grantableVaults(vaults);
  // Narrowing keeps vaults the owner can no longer open (they show as such) so they can be removed.
  const known = narrowing ? [...choices, ...(ceiling ?? []).filter((row) => !choices.some((vault) => vault.id === row.vaultId)).map((row) => ({ id: row.vaultId, name: "A vault you cannot open now", environments: [] }))] : choices;
  const update = (key: string, patch: Partial<VaultGrantRow>) => onChange(rows.map((row) => row.key === key ? { ...row, ...patch } : row));
  const add = () => {
    const row = firstVaultRow(choices, protectedAccess);
    if (row) onChange([...rows, row]);
  };
  return <div className="grant-builder vault-grant-builder">
    {!choices.length && !narrowing && <p className="grant-empty">You have no vault to give a key access to. A key reaches only vaults you can read yourself.</p>}
    <ul className="grant-rows" aria-label="Vault access">
      {rows.map((row, index) => <VaultRowEditor key={row.key} row={row} index={index} vaults={known} role={role} protectedAccess={protectedAccess} disabled={disabled}
        ceiling={ceiling?.find((item) => item.key === row.key)} narrowing={narrowing} canRemove={rows.length > 1 || !narrowing}
        onChange={(patch) => update(row.key, patch)} onRemove={() => onChange(rows.filter((item) => item.key !== row.key))} />)}
    </ul>
    {!narrowing && <button type="button" className="secondary-button grant-add" onClick={add} disabled={disabled || !choices.length || rows.length >= MAX_VAULT_GRANTS}><Plus aria-hidden="true" />Add vault access</button>}
    <p className="grant-summary" aria-live="polite">{vaultGrantSummary(rows, known)}</p>
  </div>;
}

function VaultRowEditor({ row, index, vaults, role, protectedAccess, disabled, ceiling, narrowing, canRemove, onChange, onRemove }: {
  row: VaultGrantRow; index: number; vaults: VaultChoice[]; role: string | undefined; protectedAccess: boolean; disabled: boolean;
  ceiling: VaultGrantRow | undefined; narrowing: boolean; canRemove: boolean;
  onChange: (patch: Partial<VaultGrantRow>) => void; onRemove: () => void;
}) {
  const id = useId();
  const vault = vaults.find((item) => item.id === row.vaultId);
  let envOptions = envChoices(vault, protectedAccess);
  let permissionOptions = permissionChoicesFor(vault, row.envId, role);
  if (narrowing && ceiling) {
    // D278: the same environment, or one environment instead of every one (never on a key that reaches protected ones).
    envOptions = envOptions.filter((option) => option.value === ceiling.envId || (ceiling.envId === ALL_ENVS && !protectedAccess && !option.disabled))
      .map((option) => ({ ...option, disabled: false }));
    if (!envOptions.length) envOptions = [{ value: row.envId, label: "An environment you cannot open now", description: undefined, disabled: false }];
    permissionOptions = permissionOptions.filter((option) => option.value === ceiling.permission || option.value === "read").map((option) => ({ ...option, disabled: false }));
  }
  const labels = { vault: `${id}-vault`, env: `${id}-env`, permission: `${id}-permission` };
  const vaultOptions = vaults.map((item) => ({ value: item.id, label: item.name }));
  return <li className="grant-row">
    <div className="grant-row-head">
      <span className="grant-row-number">Vault access {index + 1}</span>
      {canRemove && <button type="button" className="icon-button grant-remove" onClick={onRemove} disabled={disabled} aria-label={`Remove vault access ${index + 1}`}><Trash2 /></button>}
    </div>
    <div className="grant-row-fields">
      <div className="grant-field"><span id={labels.vault}>Vault</span>
        <Select labelledBy={labels.vault} label="Vault" value={row.vaultId} options={vaultOptions} disabled={disabled || narrowing}
          onChange={(vaultId) => {
            const next = vaults.find((item) => item.id === vaultId);
            onChange({ vaultId, envId: envChoices(next, protectedAccess).find((option) => !option.disabled)?.value ?? ALL_ENVS, permission: "read" });
          }} />
      </div>
      <div className="grant-field"><span id={labels.env}>Environment</span>
        <Select labelledBy={labels.env} label="Environment" value={row.envId} options={envOptions} disabled={disabled || (narrowing && envOptions.length < 2)}
          onChange={(envId) => onChange({ envId, permission: permissionChoicesFor(vault, envId, role).find((option) => option.value === row.permission && !option.disabled) ? row.permission : "read" })} />
      </div>
      <div className="grant-field"><span id={labels.permission}>Access</span>
        <Select<"read" | "write"> labelledBy={labels.permission} label="Access" value={row.permission} options={permissionOptions} disabled={disabled || (narrowing && permissionOptions.length < 2)} onChange={(permission) => onChange({ permission })} />
      </div>
    </div>
    <p className="grant-help">{row.envId === ALL_ENVS ? "Every unprotected environment you can read in this vault, including ones added later. Protected environments need their own row." : "Only this environment."} The key never has more access than you have yourself, and loses what you lose.</p>
  </li>;
}
