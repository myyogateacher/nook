import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { relativeTime } from "../files/format";
import type { EnvLevel } from "../../shared/vault";
import { listVaultKeys, type VaultKeysWithAccess } from "./vaultApi";

/**
 * "Keys with access" on a vault's Access page (Wave 27, vault plan §10): the live vault keys (`nkv_`)
 * that reach this vault now, each at its effective level per environment (the key's grant ∩ its
 * creator's live level ∩ role cap). Owners see every key with its name, prefix, and creator; anyone
 * else who opens the page (environment admins) sees the count and their own keys only. Keys are made
 * and revoked in Settings → API keys; nothing here changes a key.
 */

const LEVEL_WORDS: Record<EnvLevel, string> = { none: "none", read: "read", write: "read and write", admin: "admin" };

/** One key's reach as words: "Development: read and write · Staging: read". */
export function keyLevelsLine(levels: Record<string, EnvLevel>, environments: ReadonlyArray<{ id: string; name: string }>) {
  const parts = environments.filter((env) => levels[env.id] && levels[env.id] !== "none").map((env) => `${env.name}: ${LEVEL_WORDS[levels[env.id]!]}`);
  return parts.length ? parts.join(" · ") : "No environment right now";
}

/** The section's lead line: the count, and what this viewer sees. */
export function keysWithAccessLine(data: Pick<VaultKeysWithAccess, "count" | "scope" | "keys">) {
  const count = `${data.count} ${data.count === 1 ? "API key reaches" : "API keys reach"} this vault now.`;
  if (data.scope === "vault") return data.count ? `${count} A key never reaches more than the person who made it.` : "No API key reaches this vault.";
  const own = data.keys.length;
  return `${count} Owners see each key; you see ${own ? `your own (${own})` : "none of yours"}.`;
}

export function VaultKeysSection({ vaultId, environments }: { vaultId: string; environments: ReadonlyArray<{ id: string; name: string }> }) {
  const [data, setData] = useState<VaultKeysWithAccess | "error" | null>(null);
  useEffect(() => {
    let live = true;
    listVaultKeys(vaultId).then((result) => { if (live) setData(result); }, () => { if (live) setData("error"); });
    return () => { live = false; };
  }, [vaultId]);
  return <section className="vault-keys-section" aria-labelledby="vault-keys-heading">
    <h2 id="vault-keys-heading"><KeyRound aria-hidden="true" />Keys with access</h2>
    {data === null && <p className="vault-card-meta" role="status">Loading…</p>}
    {data === "error" && <p className="form-error" role="alert">Could not load the keys that reach this vault.</p>}
    {data && data !== "error" && <>
      <p className="vault-card-meta">{keysWithAccessLine(data)}</p>
      {data.keys.length > 0 && <ul className="vault-keys-list" aria-label="API keys with access">
        {data.keys.map((key) => <li key={key.id} className="vault-env-card">
          <header><strong>{key.name}</strong><code>{key.prefix}…</code></header>
          <p className="vault-card-meta">{key.owner.isYou ? "Your key" : `${key.owner.displayName}'s key`} · {key.lastUsedAt ? `used ${relativeTime(key.lastUsedAt)}` : "never used"}{key.expiresAt ? ` · expires ${relativeTime(key.expiresAt)}` : ""}</p>
          <p className="vault-card-meta">{keyLevelsLine(key.levels, environments)}</p>
        </li>)}
      </ul>}
      <p className="vault-card-meta">Make and revoke your vault keys in Settings → API keys (kind: Vault key).</p>
    </>}
  </section>;
}
