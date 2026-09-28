import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, KeyRound, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { relativeTime } from "../files/format";
import { binnedTodayLine, McpBinnedReview } from "../McpBinnedReview";
import { Select } from "../ui/Select";
import { GrantBuilder, newRowKey } from "./GrantBuilder";
import { KeysDialog } from "./KeysDialog";
import {
  expiryOptions, GRACE_OPTIONS, grantChips, keyStateLabel, rowsToGrants, SELECTOR_KINDS, SURFACE_LABELS, usageLabel,
  type GrantRow, type KeySurfaces, type PolicySummary
} from "./keyGrants";
import { createKey, listKeys, narrowKey, revokeKey, rotateKey, type ApiKey, type KeyList, type NarrowBody } from "./keysApi";
import "./keys.css";

/**
 * Settings → API keys (Wave 31, access plan §E; replaces "MCP server"). One list of Nook keys with
 * kind, surfaces, grants, expiry, last use, and 14-day usage; create with the grant builder
 * (re-authenticated), edit to narrow (no password, D278), rotate with a grace (re-authenticated,
 * D277), revoke, and Wave 19's Review / Restore all. A new token is shown once. Each dialog is a
 * history-guarded layer: Back closes the innermost one first.
 */

type Dialog = { kind: "create" } | { kind: "edit"; key: ApiKey } | { kind: "rotate"; key: ApiKey } | { kind: "revoke"; key: ApiKey } | { kind: "review"; key: ApiKey };

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

export function KeysSettings({ onPendingChange, totpEnabled, role }: { onPendingChange: (pending: boolean) => void; totpEnabled: boolean; role: string | undefined }) {
  const [data, setData] = useState<KeyList | null>(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [newToken, setNewToken] = useState<{ token: string; name: string; rotated: boolean } | null>(null);
  const [copied, setCopied] = useState("");
  const [status, setStatus] = useState("");
  const endpoint = `${window.location.origin}/mcp`;
  const configText = JSON.stringify({ mcpServers: { nook: { type: "streamable-http", url: endpoint, headers: { Authorization: `Bearer ${newToken?.token ?? "<YOUR_API_KEY>"}` } } } }, null, 2);
  const guest = role === "guest";

  const load = useCallback(() => {
    listKeys().then((result) => { setData(result); setError(""); }).catch((reason) => setError(messageOf(reason, "Could not load API keys")));
  }, []);
  useEffect(load, [load]);
  useEffect(() => onPendingChange(Boolean(newToken)), [newToken, onPendingChange]);
  const closeDialog = useCallback(() => setDialog(null), []);

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(""), 1600);
    } catch {
      setError("Copy failed. Select the text and copy it manually.");
    }
  }

  const live = data?.keys.filter((key) => key.state !== "revoked") ?? [];
  const revoked = data?.keys.filter((key) => key.state === "revoked") ?? [];
  const atLimit = data ? data.liveCount >= data.policy.keysPerUser : false;

  return <section className="settings-content mcp-settings keys-settings" aria-labelledby="keys-heading">
    <div className="settings-section-heading"><span className="settings-icon"><KeyRound /></span><div><h3 id="keys-heading">API keys</h3><p>Keys let trusted AI clients and scripts use Nook as you, over MCP. Each key does only what its permissions allow, only with items you can open, and only until it expires. No key can share, manage access, manage keys, or delete forever.</p></div></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {status && <p className="keys-status" role="status">{status}</p>}
    <div className="mcp-endpoint"><div><span>Transport</span><strong>Streamable HTTP</strong></div><div><span>Endpoint</span><code>{endpoint}</code><button type="button" className="icon-button" onClick={() => copy(endpoint, "endpoint")} aria-label="Copy MCP endpoint"><Copy /></button></div></div>

    {newToken && <div className="new-api-key" role="status"><strong>{newToken.rotated ? `Copy the new key for ${newToken.name} now` : "Copy this key now"}</strong><p>It cannot be shown again after you leave this screen. You can select the text manually if automatic copy is unavailable.</p><textarea readOnly value={newToken.token} aria-label="New API key" onFocus={(event) => event.currentTarget.select()} /><div><button type="button" className="secondary-button" onClick={() => copy(newToken.token, "token")}><Copy />{copied === "token" ? "Copied key" : "Copy key"}</button><button type="button" className="text-button" onClick={() => setNewToken(null)}>I saved this key</button></div></div>}

    <div className="mcp-card keys-card">
      <div className="keys-card-head">
        <div><h4>Your keys</h4><p>{data ? keyPolicyLine(data.policy, data.liveCount) : "Loading…"}</p></div>
        {!guest && <button type="button" className="primary-button keys-new" onClick={() => { setStatus(""); setDialog({ kind: "create" }); }} disabled={!data || atLimit || Boolean(newToken)}><Plus aria-hidden="true" />New key</button>}
      </div>
      {guest && <p className="mcp-role-note" role="note">Guests cannot create API keys. Ask an admin for another team role.</p>}
      {role === "viewer" && <p className="mcp-role-note" role="note">Team role: Viewer. Keys you create can only read.</p>}
      {data && !data.policy.mcpAllowed && <p className="mcp-role-note" role="note">Team policy does not allow your team role to use MCP keys.</p>}
      {atLimit && <p className="mcp-role-note" role="note">You have {data!.liveCount} live keys, the most team policy allows. Revoke one to create another.</p>}
      <ul className="keys-list" aria-label="API keys">
        {live.map((key) => <KeyRow key={key.id} apiKey={key} onRotate={() => setDialog({ kind: "rotate", key })} onEdit={() => setDialog({ kind: "edit", key })} onRevoke={() => setDialog({ kind: "revoke", key })} onReview={() => setDialog({ kind: "review", key })} />)}
      </ul>
      {data && !live.length && <p className="keys-empty">No active API keys.</p>}
      {revoked.length > 0 && <details className="keys-revoked"><summary>Revoked in the last 7 days ({revoked.length})</summary><ul className="keys-list">{revoked.map((key) => <KeyRow key={key.id} apiKey={key} />)}</ul></details>}
    </div>

    <div className="mcp-card mcp-config"><div><h4 id="mcp-config-heading">JSON client configuration</h4><p>This common JSON shape is supported by many Streamable HTTP clients; check your client's documentation because config formats differ. Replace the placeholder if you have not just created a key.</p></div><pre aria-labelledby="mcp-config-heading"><code>{configText}</code></pre><button type="button" className="secondary-button" onClick={() => copy(configText, "config")}><Copy />{copied === "config" ? "Copied config" : "Copy config"}</button></div>

    {dialog?.kind === "create" && data && <CreateKeyDialog policy={data.policy} role={role} totpEnabled={totpEnabled} onClose={closeDialog} onCreated={(key) => { closeDialog(); setNewToken({ token: key.token, name: key.name, rotated: false }); load(); }} />}
    {dialog?.kind === "edit" && data && <EditKeyDialog apiKey={dialog.key} policy={data.policy} role={role} onClose={closeDialog} onSaved={(message) => { closeDialog(); setStatus(message); load(); }} />}
    {dialog?.kind === "rotate" && <RotateKeyDialog apiKey={dialog.key} totpEnabled={totpEnabled} onClose={closeDialog} onRotated={(key) => { closeDialog(); setNewToken({ token: key.token, name: key.name, rotated: true }); load(); }} />}
    {dialog?.kind === "revoke" && <RevokeKeyDialog apiKey={dialog.key} onClose={closeDialog} onRevoked={() => { closeDialog(); setStatus(`${dialog.key.name} was revoked.`); load(); }} />}
    {dialog?.kind === "review" && <McpBinnedReview keyId={dialog.key.id} keyName={dialog.key.name} onClose={() => { closeDialog(); load(); }} onRevoke={() => setDialog({ kind: "revoke", key: dialog.key })} />}
  </section>;
}

function keyPolicyLine(policy: PolicySummary, liveCount: number) {
  return `${liveCount} of ${policy.keysPerUser} live keys. New keys expire after at most ${policy.keyMaxDays} days (team policy).`;
}

/** 14 bars, one per day, oldest first; decorative with a text alternative. */
export function UsageBars({ usage }: { usage: readonly number[] }) {
  const max = Math.max(1, ...usage);
  return <span className="keys-usage" role="img" aria-label={usageLabel(usage)}>
    <svg viewBox="0 0 56 16" width="56" height="16" aria-hidden="true">{usage.map((value, index) => {
      const height = value === 0 ? 1 : Math.max(2, Math.round((value / max) * 16));
      return <rect key={index} x={index * 4} y={16 - height} width="3" height={height} rx="1" />;
    })}</svg>
  </span>;
}

export function KeyRow({ apiKey, owner, onRotate, onEdit, onRevoke, onReview }: { apiKey: ApiKey; owner?: string; onRotate?: () => void; onEdit?: () => void; onRevoke?: () => void; onReview?: () => void }) {
  const state = keyStateLabel(apiKey);
  const binned = binnedTodayLine(apiKey.binnedToday);
  return <li className={`keys-row state-${apiKey.state}`}>
    <span className="key-icon" aria-hidden="true"><KeyRound /></span>
    <div className="keys-row-main">
      <div className="keys-row-title"><strong>{apiKey.name}</strong><span className="keys-chip">{SURFACE_LABELS[apiKey.surfaces]}</span>{apiKey.kind === "vault" && <span className="keys-chip">Vault</span>}<span className={`keys-chip tone-${state.tone}`}>{state.label}</span></div>
      {owner && <small className="keys-row-owner">{owner}</small>}
      <small><code>{apiKey.prefix}…</code> · Created {relativeTime(apiKey.createdAt)} · {apiKey.lastUsedAt ? `Used ${relativeTime(apiKey.lastUsedAt)}` : "Never used"}</small>
      {apiKey.description && <small className="keys-row-description">{apiKey.description}</small>}
      <ul className="scope-chips" aria-label={`Permissions for ${apiKey.name}`}>{grantChips(apiKey.grants).map((chip) => <li key={chip.id} className={chip.active ? undefined : "inactive"}>{chip.label}</li>)}</ul>
      {apiKey.state === "blocked" && apiKey.blockedMessage && <small className="keys-row-warning">{apiKey.blockedMessage}</small>}
      {apiKey.state === "revoked" && apiKey.revokedBy === "admin" && <small className="keys-row-warning">An admin revoked this key{apiKey.revokeReason ? `: “${apiKey.revokeReason}”` : "."}</small>}
      {apiKey.state !== "revoked" && <div className="keys-row-usage"><UsageBars usage={apiKey.usage14d} /><small>{usageLabel(apiKey.usage14d)}</small></div>}
      {binned && onReview && <small className="mcp-key-binned">{binned} · <button type="button" className="text-button" onClick={onReview}>Review</button></small>}
    </div>
    {(onRotate || onEdit || onRevoke) && <div className="keys-row-actions">
      {onRotate && apiKey.state !== "grace" && apiKey.state !== "expired" && <button type="button" className="keys-action" onClick={onRotate}><RefreshCw aria-hidden="true" />Rotate</button>}
      {onEdit && apiKey.state !== "expired" && <button type="button" className="keys-action" onClick={onEdit}><Pencil aria-hidden="true" />Edit</button>}
      {onRevoke && <button type="button" className="keys-action danger" onClick={onRevoke}><Trash2 aria-hidden="true" />{apiKey.state === "grace" ? "Revoke now" : "Revoke"}</button>}
    </div>}
  </li>;
}

function ReauthFields({ totpEnabled, password, code, onPassword, onCode, disabled }: { totpEnabled: boolean; password: string; code: string; onPassword: (value: string) => void; onCode: (value: string) => void; disabled: boolean }) {
  return <div className="keys-reauth">
    <label className="keys-input">Confirm password<input type="password" autoComplete="current-password" value={password} onChange={(event) => onPassword(event.target.value)} required disabled={disabled} /></label>
    {totpEnabled && <label className="keys-input">Fresh six-digit code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="000000" value={code} onChange={(event) => onCode(event.target.value)} required disabled={disabled} /></label>}
  </div>;
}

function CreateKeyDialog({ policy, role, totpEnabled, onClose, onCreated }: { policy: PolicySummary; role: string | undefined; totpEnabled: boolean; onClose: () => void; onCreated: (key: ApiKey & { token: string }) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [surfaces, setSurfaces] = useState<KeySurfaces>("mcp");
  const [expires, setExpires] = useState(String(policy.keyDefaultDays));
  const [rows, setRows] = useState<GrantRow[]>(() => [{ key: newRowKey(), module: "notes", permission: "read", applies: "all", resourceIds: [] }]);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const surfaceOptions = [
    { value: "mcp" as const, label: "MCP", description: "AI clients such as Claude Code", disabled: !policy.mcpAllowed },
    { value: "rest" as const, label: "REST", description: policy.restAllowed ? "Scripts and CI; the REST API arrives in a later release" : "Turned off by team policy", disabled: !policy.restAllowed },
    { value: "both" as const, label: "MCP and REST", description: policy.restAllowed && policy.mcpAllowed ? "Both, once REST arrives" : "Turned off by team policy", disabled: !policy.restAllowed || !policy.mcpAllowed }
  ];

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { grants, error: grantError } = rowsToGrants(rows);
    if (grantError) return setError(grantError);
    if (!name.trim()) return setError("Give the key a name.");
    setBusy(true);
    setError("");
    try {
      const result = await createKey({ name: name.trim(), description: description.trim() || null, surfaces, expiresInDays: Number(expires), grants, password, ...(totpEnabled ? { totpCode: code } : {}) });
      onCreated(result.key);
    } catch (reason) {
      setError(messageOf(reason, "Could not create the key"));
      setBusy(false);
    }
  }

  return <KeysDialog title="New API key" description="Choose what this key may do. You can narrow it later without a password; adding access needs a new key." onClose={onClose} busy={busy} wide>
    <form className="keys-form" onSubmit={submit}>
      <label className="keys-input">Name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Claude Code on my laptop" required disabled={busy} autoComplete="off" /></label>
      <label className="keys-input">Description (optional)<input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={200} placeholder="What it is for" disabled={busy} autoComplete="off" /></label>
      <div className="keys-select-field"><span id="keys-surface-label">Where it is used</span><Select<KeySurfaces> labelledBy="keys-surface-label" value={surfaces} options={surfaceOptions} onChange={setSurfaces} disabled={busy} /></div>
      <fieldset className="keys-fieldset"><legend>Access</legend><GrantBuilder rows={rows} onChange={setRows} role={role} policy={policy} disabled={busy} /></fieldset>
      <div className="keys-select-field"><span id="keys-expiry-label">Expires</span><Select labelledBy="keys-expiry-label" value={expires} options={expiryOptions(policy)} onChange={setExpires} disabled={busy} /><small>Team policy allows at most {policy.keyMaxDays} days.</small></div>
      <ReauthFields totpEnabled={totpEnabled} password={password} code={code} onPassword={setPassword} onCode={setCode} disabled={busy} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="keys-dialog-actions inline">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || !rows.length}>{busy ? "Creating…" : "Create key"}</button>
      </div>
    </form>
  </KeysDialog>;
}

/** The key's grants as builder rows: one per module and permission, with its chosen items. */
export function keyToRows(key: ApiKey): GrantRow[] {
  const rows = new Map<string, GrantRow>();
  for (const grant of key.grants) {
    const id = `${grant.module}:${grant.permission}:${grant.resource ? "chosen" : "all"}`;
    const row = rows.get(id) ?? { key: `edit-${id}`, module: grant.module, permission: grant.permission, applies: grant.resource ? "chosen" as const : "all" as const, resourceIds: [] };
    if (grant.resource) row.resourceIds.push(grant.resource.id);
    rows.set(id, row);
  }
  return [...rows.values()];
}

function EditKeyDialog({ apiKey, policy, role, onClose, onSaved }: { apiKey: ApiKey; policy: PolicySummary; role: string | undefined; onClose: () => void; onSaved: (message: string) => void }) {
  const ceiling = useMemo(() => keyToRows(apiKey), [apiKey]);
  const [rows, setRows] = useState<GrantRow[]>(ceiling);
  const [name, setName] = useState(apiKey.name);
  const [description, setDescription] = useState(apiKey.description ?? "");
  const [expires, setExpires] = useState("keep");
  const [surfaces, setSurfaces] = useState<KeySurfaces>(apiKey.surfaces);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const daysLeft = apiKey.expiresAt ? Math.max(1, Math.ceil((Date.parse(apiKey.expiresAt) - Date.now()) / 86_400_000)) : null;
  const expiryChoices = [
    { value: "keep", label: daysLeft === null ? "Keep: no expiry" : `Keep: ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left` },
    ...[1, 7, 30, 90].filter((days) => daysLeft === null || days < daysLeft).map((days) => ({ value: String(days), label: days === 1 ? "Expire in 1 day" : `Expire in ${days} days` }))
  ];
  const surfaceChoices = apiKey.surfaces === "both"
    ? (["both", "mcp", "rest"] as const).map((value) => ({ value, label: SURFACE_LABELS[value] }))
    : [{ value: apiKey.surfaces, label: SURFACE_LABELS[apiKey.surfaces] }];

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { grants, error: grantError } = rowsToGrants(rows);
    if (grantError) return setError(grantError);
    const body: NarrowBody = {};
    if (name.trim() !== apiKey.name) body.name = name.trim();
    if ((description.trim() || null) !== apiKey.description) body.description = description.trim() || null;
    if (expires !== "keep") body.expiresInDays = Number(expires);
    if (surfaces !== apiKey.surfaces) body.surfaces = surfaces;
    const same = JSON.stringify(rowsToGrants(ceiling).grants) === JSON.stringify(grants);
    if (!same) body.grants = grants;
    if (!Object.keys(body).length) return onClose();
    setBusy(true);
    setError("");
    try {
      await narrowKey(apiKey.id, body);
      onSaved(`${body.name ?? apiKey.name} was updated.`);
    } catch (reason) {
      setError(messageOf(reason, "Could not save the key"));
      setBusy(false);
    }
  }

  const hasSelectors = ceiling.some((row) => SELECTOR_KINDS[row.module]);
  return <KeysDialog title={`Edit ${apiKey.name}`} description={`Editing can only remove access, bring the expiry closer, or rename. To add access, create a new key.${hasSelectors ? " You can narrow “all” to chosen items." : ""}`} onClose={onClose} busy={busy} wide>
    <form className="keys-form" onSubmit={submit}>
      <label className="keys-input">Name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required disabled={busy} autoComplete="off" /></label>
      <label className="keys-input">Description (optional)<input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={200} disabled={busy} autoComplete="off" /></label>
      {apiKey.surfaces === "both" && <div className="keys-select-field"><span id="keys-edit-surface">Where it is used</span><Select<KeySurfaces> labelledBy="keys-edit-surface" value={surfaces} options={surfaceChoices} onChange={setSurfaces} disabled={busy} /></div>}
      <fieldset className="keys-fieldset"><legend>Access</legend><GrantBuilder rows={rows} onChange={setRows} role={role} policy={policy} disabled={busy} ceiling={ceiling} /></fieldset>
      <div className="keys-select-field"><span id="keys-edit-expiry">Expiry</span><Select labelledBy="keys-edit-expiry" value={expires} options={expiryChoices} onChange={setExpires} disabled={busy} /></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="keys-dialog-actions inline">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || !rows.length}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </form>
  </KeysDialog>;
}

function RotateKeyDialog({ apiKey, totpEnabled, onClose, onRotated }: { apiKey: ApiKey; totpEnabled: boolean; onClose: () => void; onRotated: (key: ApiKey & { token: string }) => void }) {
  const [grace, setGrace] = useState<string>("24");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await rotateKey(apiKey.id, { graceHours: Number(grace) as 0 | 1 | 24 | 168, password, ...(totpEnabled ? { totpCode: code } : {}) });
      onRotated(result.key);
    } catch (reason) {
      setError(messageOf(reason, "Could not rotate the key"));
      setBusy(false);
    }
  }

  return <KeysDialog title={`Rotate ${apiKey.name}?`} description="You get a new secret with the same permissions and a fresh lifetime. Routines that use this key move to the new one. Update your clients before the old key stops." onClose={onClose} busy={busy}>
    <form className="keys-form" onSubmit={submit}>
      <div className="keys-select-field"><span id="keys-grace-label">Old key</span><Select labelledBy="keys-grace-label" value={grace} options={GRACE_OPTIONS.map((option) => ({ ...option }))} onChange={setGrace} disabled={busy} /></div>
      <ReauthFields totpEnabled={totpEnabled} password={password} code={code} onPassword={setPassword} onCode={setCode} disabled={busy} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="keys-dialog-actions inline">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Rotating…" : "Rotate key"}</button>
      </div>
    </form>
  </KeysDialog>;
}

function RevokeKeyDialog({ apiKey, onClose, onRevoked }: { apiKey: ApiKey; onClose: () => void; onRevoked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await revokeKey(apiKey.id);
      onRevoked();
    } catch (reason) {
      setError(messageOf(reason, "Could not revoke the key"));
      setBusy(false);
    }
  }
  return <KeysDialog title={`Revoke ${apiKey.name}?`} description="Clients using this key stop working at once, and its pending suggestions in the Inbox are withdrawn. This cannot be undone." onClose={onClose} busy={busy}
    footer={<><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="primary-button danger" onClick={confirm} disabled={busy}>{busy ? "Revoking…" : "Revoke key"}</button></>}>
    {error && <p className="form-error" role="alert">{error}</p>}
  </KeysDialog>;
}
