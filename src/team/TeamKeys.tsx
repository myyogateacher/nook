import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, KeyRound, RotateCcw, TriangleAlert } from "lucide-react";
import { Select, type Option } from "../ui/Select";
import { KeysDialog } from "../keys/KeysDialog";
import { KeyRow } from "../keys/KeysSettings";
import { GRANT_MODULES, MODULE_LABELS, type GrantModule } from "../keys/keyGrants";
import { adminRevokeKey, listInventory, type Inventory, type InventoryKey, type InventoryState } from "../keys/keysApi";
import "../keys/keys.css";

/**
 * Team → Keys at /team/keys (Wave 31, access plan §C.6, §E), admins only: every live key across
 * the team with owner, grants (never item names, T204), expiry, last use, and usage; filters by
 * owner, module, and state; revoke with a reason the owner sees. Never token material (T215).
 */

const STATE_OPTIONS: Option<"all" | InventoryState>[] = [
  { value: "all", label: "Any state" },
  { value: "active", label: "Active" },
  { value: "expiring", label: "Expiring within 14 days" },
  { value: "no_expiry", label: "No expiry" },
  { value: "blocked", label: "Blocked by policy" },
  { value: "grace", label: "In rotation grace" },
  { value: "expired", label: "Expired" },
  { value: "unused", label: "Unused for 90 days" }
];

export function TeamKeys({ members, onBack, flash }: { members: ReadonlyArray<{ id: string; displayName: string }>; onBack: () => void; flash: (message: string) => void }) {
  const [owner, setOwner] = useState("all");
  const [module, setModule] = useState<"all" | GrantModule>("all");
  const [state, setState] = useState<"all" | InventoryState>("all");
  const [data, setData] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<InventoryKey | null>(null);
  const generation = useRef(0);

  const load = useCallback(async (cursor?: string | null) => {
    const current = ++generation.current;
    setError(null);
    try {
      const result = await listInventory({ owner: owner === "all" ? undefined : owner, module: module === "all" ? undefined : module, state: state === "all" ? undefined : state, cursor: cursor ?? undefined });
      if (current !== generation.current) return;
      setData((previous) => cursor && previous ? { ...result, keys: [...previous.keys, ...result.keys] } : result);
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "Could not load keys");
    }
  }, [module, owner, state]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { document.title = "Keys · Team · Nook"; }, []);

  const ownerOptions: Option[] = [{ value: "all", label: "Everyone" }, ...members.map((member) => ({ value: member.id, label: member.displayName }))];
  const moduleOptions: Option<"all" | GrantModule>[] = [{ value: "all", label: "Any module" }, ...GRANT_MODULES.map((value) => ({ value, label: MODULE_LABELS[value] }))];

  return <article className="team-detail team-keys" aria-labelledby="team-keys-title">
    <button type="button" className="team-back" onClick={onBack}><ChevronLeft />Team</button>
    <header className="team-invites-header">
      <div>
        <h2 id="team-keys-title">Keys</h2>
        <p className="team-muted">Every live API key on this Nook. You see names, owners, permissions, and use, never the secrets or the items a key is limited to. Revoking stops a key at once and tells its owner why.</p>
      </div>
    </header>
    <div className="team-keys-filters" role="group" aria-label="Filter keys">
      <div className="keys-select-field"><span id="team-keys-owner">Owner</span><Select labelledBy="team-keys-owner" value={owner} options={ownerOptions} onChange={setOwner} /></div>
      <div className="keys-select-field"><span id="team-keys-module">Module</span><Select<"all" | GrantModule> labelledBy="team-keys-module" value={module} options={moduleOptions} onChange={setModule} /></div>
      <div className="keys-select-field"><span id="team-keys-state">State</span><Select<"all" | InventoryState> labelledBy="team-keys-state" value={state} options={STATE_OPTIONS} onChange={setState} /></div>
    </div>
    {error && <div className="team-state team-error" role="alert">
      <span className="team-state-icon"><TriangleAlert /></span>
      <h2>Could not load keys</h2>
      <p>{error}</p>
      <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
    </div>}
    {!error && !data && <p className="team-loading" role="status">Loading keys…</p>}
    {!error && data && <p className="team-keys-summary">{data.summary.live} live {data.summary.live === 1 ? "key" : "keys"} on this Nook · {data.summary.noExpiry} without an expiry</p>}
    {!error && data && data.keys.length === 0 && <div className="team-state">
      <span className="team-state-icon"><KeyRound /></span>
      <h2>No keys match.</h2>
    </div>}
    {!error && data && data.keys.length > 0 && <ul className="keys-list" aria-label="Keys">
      {data.keys.map((key) => <KeyRow key={key.id} apiKey={key} owner={`${key.owner.displayName}${key.owner.blocked ? " (blocked)" : ""}`} onRevoke={() => setRevoking(key)} />)}
    </ul>}
    {data?.nextCursor && <button type="button" className="secondary-button team-keys-more" onClick={() => { void load(data.nextCursor); }}>Show more</button>}
    {revoking && <AdminRevokeDialog apiKey={revoking} onClose={() => setRevoking(null)} onDone={() => { flash(`${revoking.name} was revoked`); setRevoking(null); void load(); }} />}
  </article>;
}

function AdminRevokeDialog({ apiKey, onClose, onDone }: { apiKey: InventoryKey; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason.trim()) return setError("Say why, so the owner knows.");
    setBusy(true);
    setError("");
    try {
      await adminRevokeKey(apiKey.id, reason.trim());
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not revoke the key");
      setBusy(false);
    }
  }
  return <KeysDialog title={`Revoke ${apiKey.owner.displayName}'s key “${apiKey.name}”?`} description="It stops working at once and its pending Inbox suggestions are withdrawn. The owner sees that an admin revoked it, and your reason." onClose={onClose} busy={busy}>
    <form className="keys-form" onSubmit={submit}>
      <label className="keys-input">Reason (the owner sees it)<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} rows={2} required disabled={busy} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="keys-dialog-actions inline">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button danger" disabled={busy}>{busy ? "Revoking…" : "Revoke key"}</button>
      </div>
    </form>
  </KeysDialog>;
}
