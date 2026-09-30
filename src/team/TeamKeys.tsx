import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, KeyRound, RotateCcw, TriangleAlert } from "lucide-react";
import { Select, type Option } from "../ui/Select";
import { KeysDialog } from "../keys/KeysDialog";
import { KeyRow } from "../keys/KeysSettings";
import { GRANT_MODULES, MODULE_LABELS, type GrantModule } from "../keys/keyGrants";
import { adminRevokeKey, listInventory, type Inventory, type InventoryKey, type InventoryState } from "../keys/keysApi";
import { IntegrationBadge } from "../ui/IntegrationBadge";
import { listIntegrations, type Integration } from "./integrationsApi";
import "../keys/keys.css";
import { hubDocumentTitle } from "../router";

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

const SURFACE_OPTIONS: Option<"all" | "mcp" | "rest">[] = [
  { value: "all", label: "Any surface" },
  { value: "mcp", label: "MCP", description: "Keys that may use MCP (including MCP and REST)" },
  { value: "rest", label: "REST", description: "Keys that may use the REST API (including MCP and REST)" }
];

const IP_OPTIONS: Option<"all" | "true" | "false">[] = [
  { value: "all", label: "Any address" },
  { value: "true", label: "IP limited", description: "Keys limited to certain addresses" },
  { value: "false", label: "Not IP limited" }
];

/** Review Q14: with filters on, "3 of 7 live keys match". */
export function inventorySummary(summary: { live: number; noExpiry: number; matching?: number }, filtered: boolean) {
  const keys = (count: number) => `${count} live ${count === 1 ? "key" : "keys"}`;
  if (filtered && summary.matching !== undefined) return `${summary.matching} of ${keys(summary.live)} match · ${summary.noExpiry} without an expiry on this Nook`;
  return `${keys(summary.live)} on this Nook · ${summary.noExpiry} without an expiry`;
}

export function TeamKeys({ members, onBack, flash }: { members: ReadonlyArray<{ id: string; displayName: string }>; onBack: () => void; flash: (message: string) => void }) {
  const [owner, setOwner] = useState("all");
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  useEffect(() => { listIntegrations().then((result) => setIntegrations(result.integrations), () => setIntegrations([])); }, []);
  const [module, setModule] = useState<"all" | GrantModule>("all");
  const [state, setState] = useState<"all" | InventoryState>("all");
  const [surface, setSurface] = useState<"all" | "mcp" | "rest">("all");
  const [ipLimited, setIpLimited] = useState<"all" | "true" | "false">("all");
  const [data, setData] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<InventoryKey | null>(null);
  const generation = useRef(0);
  const filtered = owner !== "all" || module !== "all" || state !== "all" || surface !== "all" || ipLimited !== "all";

  const load = useCallback(async (cursor?: string | null) => {
    const current = ++generation.current;
    setError(null);
    try {
      const result = await listInventory({
        owner: owner === "all" ? undefined : owner, module: module === "all" ? undefined : module, state: state === "all" ? undefined : state, cursor: cursor ?? undefined,
        surface: surface === "all" ? undefined : surface, ipRestricted: ipLimited === "all" ? undefined : ipLimited
      });
      if (current !== generation.current) return;
      setData((previous) => cursor && previous ? { ...result, keys: [...previous.keys, ...result.keys] } : result);
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "Could not load keys");
    }
  }, [ipLimited, module, owner, state, surface]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { document.title = hubDocumentTitle("Keys"); }, []);

  const ownerOptions: Option[] = [{ value: "all", label: "Everyone" }, ...members.map((member) => ({ value: member.id, label: member.displayName })),
    // Wave 36: integrations own keys too.
    ...integrations.map((integration) => ({ value: integration.id, label: integration.displayName, description: "Integration" }))];
  const moduleOptions: Option<"all" | GrantModule>[] = [{ value: "all", label: "Any module" }, ...GRANT_MODULES.map((value) => ({ value, label: MODULE_LABELS[value] }))];

  return <article className="team-detail team-keys" aria-labelledby="team-keys-title">
    <button type="button" className="team-back" onClick={onBack}><ChevronLeft />Team</button>
    <header className="team-invites-header">
      <div>
        <h2 id="team-keys-title">Keys</h2>
        <p className="team-muted">Every live API key on this Nook. You see names, owners, permissions, surfaces, and use, never the secrets, the items a key is limited to, or the addresses it is limited to. Revoking stops a key at once and tells its owner why.</p>
      </div>
    </header>
    <div className="team-keys-filters" role="group" aria-label="Filter keys">
      <div className="keys-select-field"><span id="team-keys-owner">Owner</span><Select labelledBy="team-keys-owner" label="Owner" value={owner} options={ownerOptions} onChange={setOwner} /></div>
      <div className="keys-select-field"><span id="team-keys-module">Module</span><Select<"all" | GrantModule> labelledBy="team-keys-module" label="Module" value={module} options={moduleOptions} onChange={setModule} /></div>
      <div className="keys-select-field"><span id="team-keys-state">State</span><Select<"all" | InventoryState> labelledBy="team-keys-state" label="State" value={state} options={STATE_OPTIONS} onChange={setState} /></div>
      <div className="keys-select-field"><span id="team-keys-surface">Surface</span><Select<"all" | "mcp" | "rest"> labelledBy="team-keys-surface" label="Surface" value={surface} options={SURFACE_OPTIONS} onChange={setSurface} /></div>
      <div className="keys-select-field"><span id="team-keys-ip">Addresses</span><Select<"all" | "true" | "false"> labelledBy="team-keys-ip" label="Addresses" value={ipLimited} options={IP_OPTIONS} onChange={setIpLimited} /></div>
    </div>
    {error && <div className="team-state team-error" role="alert">
      <span className="team-state-icon"><TriangleAlert /></span>
      <h2>Could not load keys</h2>
      <p>{error}</p>
      <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
    </div>}
    {!error && !data && <p className="team-loading" role="status">Loading keys…</p>}
    {!error && data && <p className="team-keys-summary">{inventorySummary(data.summary, filtered)}</p>}
    {!error && data && <p className="team-muted team-keys-note">Calls per surface are counted per day; there is no per-call log in the app.</p>}
    {!error && data && data.keys.length === 0 && <div className="team-state">
      <span className="team-state-icon"><KeyRound /></span>
      <h2>No keys match.</h2>
    </div>}
    {!error && data && data.keys.length > 0 && <ul className="keys-list" aria-label="Keys">
      {data.keys.map((key) => <KeyRow key={key.id} apiKey={key} owner={<>{key.owner.displayName}{key.owner.kind === "service" && <IntegrationBadge />}{key.owner.blocked ? " (blocked)" : ""}</>} onRevoke={() => setRevoking(key)} />)}
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
