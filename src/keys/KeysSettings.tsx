import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, KeyRound, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { relativeTime } from "../files/format";
import { binnedTodayLine, McpBinnedReview } from "../McpBinnedReview";
import { Select } from "../ui/Select";
import { HistoryDialogReopen } from "../ui/useHistoryDialogGuard";
import { GrantBuilder, newRowKey } from "./GrantBuilder";
import { KeysDialog } from "./KeysDialog";
import { asksForPassword, googleConfirmed, GoogleReauthNotice, reauthPassword, useAccountAuth } from "../auth/accountAuth";
import {
  blockedSurfaceLine, checkAllowlist, deniedLine, expiryChoices, keyEventLine, expiryDays, GRACE_OPTIONS, lastUsedLine, resourceToken, rotationExpiryDefault, grantChips, keyStateLabel, rowsToGrants, SELECTOR_KINDS, SURFACE_LABELS, usageLabel,
  type GrantRow, type KeySurfaces, type PolicySummary
} from "./keyGrants";
import { useKeysApi, type ApiKey, type KeyEvent, type KeyList, type NarrowBody, type KeysApi } from "./keysApi";
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

export function KeysSettings({ onPendingChange, onNestedDialogChange, totpEnabled, role, notice = null, integration, reopenOnForward = true }: {
  onPendingChange: (pending: boolean) => void; onNestedDialogChange?: (open: boolean) => void; totpEnabled: boolean; role: string | undefined; /** Q2: the result of a Google confirmation started here. */ notice?: React.ReactNode;
  /** Team → Integrations (Wave 36): an admin manages this integration's keys (wrap in KeysApiContext); `role` is the integration's. */
  integration?: { name: string };
  /** Friction 12 (Settings): Forward after Back reopens the key dialog Back closed. Team → Integrations turns it off, like its other sheets (Q-L1). */
  reopenOnForward?: boolean;
}) {
  const keysApi = useKeysApi();
  const [data, setData] = useState<KeyList | null>(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [newToken, setNewToken] = useState<{ token: string; name: string; rotated: boolean } | null>(null);
  const [copied, setCopied] = useState("");
  const [status, setStatus] = useState("");
  const endpoint = `${window.location.origin}/mcp`;
  const configText = JSON.stringify({ mcpServers: { nook: { type: "streamable-http", url: endpoint, headers: { Authorization: `Bearer ${newToken?.token ?? "<YOUR_API_KEY>"}` } } } }, null, 2);
  // Always a placeholder: a key typed into a shell ends up in its history (T215).
  const restExample = restCurlExample(window.location.origin);
  const guest = role === "guest";
  // QA U11: an account that confirms with Google does it BEFORE opening New key or Rotate, so the
  // round trip never loses what was typed into the dialog.
  const account = useAccountAuth();
  const needsGoogle = Boolean(account && !asksForPassword(account) && !googleConfirmed(account));

  const load = useCallback(() => {
    keysApi.list().then((result) => { setData(result); setError(""); }).catch((reason) => setError(messageOf(reason, "Could not load API keys")));
  }, [keysApi]);
  useEffect(load, [load]);
  // Q3: a new (or rotated) key takes focus, selected, so it can be copied at once; the New key button that
  // opened the dialog is disabled while the key is on screen.
  const tokenFieldRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!newToken) return;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => tokenFieldRef.current?.focus()));
  }, [newToken]);
  useEffect(() => {
    onPendingChange(Boolean(newToken));
    return () => onPendingChange(false);
  }, [newToken, onPendingChange]);
  // Settings leaves Escape to an open key dialog (Review, create, edit, rotate, revoke) (1i).
  useEffect(() => {
    onNestedDialogChange?.(dialog !== null);
    return () => onNestedDialogChange?.(false);
  }, [dialog, onNestedDialogChange]);
  // Focus goes back to the control that opened the dialog, when it is still there (it is gone after a revoke).
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const openDialog = useCallback((next: Dialog) => {
    if (document.activeElement instanceof HTMLElement && !document.activeElement.closest(".keys-dialog, .mcp-review-dialog")) dialogTriggerRef.current = document.activeElement;
    setDialog(next);
  }, []);
  const closeDialog = useCallback(() => {
    setDialog(null);
    window.requestAnimationFrame(() => { if (dialogTriggerRef.current?.isConnected) dialogTriggerRef.current.focus(); });
  }, []);
  // After a revoke (the row moves to "Revoked") or a Review that may drop the row's Review link, the
  // list reloads first; then focus goes to the opener if it is still there, else the key's row, else
  // the next live key, else New key, else the list heading. Never the page body.
  const liveListRef = useRef<HTMLUListElement>(null);
  const newKeyRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pendingFocusRef = useRef<{ keyId: string | null } | null>(null);
  const closeDialogAfterReload = useCallback((keyId: string | null) => {
    pendingFocusRef.current = { keyId };
    setDialog(null);
    load();
  }, [load]);
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending || (!data && !error)) return;
    pendingFocusRef.current = null;
    window.requestAnimationFrame(() => {
      const trigger = dialogTriggerRef.current;
      if (trigger?.isConnected && !trigger.hasAttribute("disabled")) return trigger.focus();
      const rows = Array.from(liveListRef.current?.querySelectorAll<HTMLElement>(":scope > li[data-key-id]") ?? []);
      const row = pending.keyId ? rows.find((item) => item.dataset.keyId === pending.keyId) : undefined;
      const target = row?.querySelector<HTMLElement>("button:not([disabled])")
        ?? (newKeyRef.current && !newKeyRef.current.disabled ? newKeyRef.current : null)
        ?? headingRef.current;
      target?.focus();
    });
  }, [data, error]);

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
  const revokedFocusKey = (revokedId: string) => keyAfterRevoke(live.map((key) => key.id), revokedId);

  return <section className="settings-content mcp-settings keys-settings" aria-labelledby="keys-heading">
    {notice}
    <div className="settings-section-heading"><span className="settings-icon"><KeyRound /></span><div><h3 id="keys-heading">API keys</h3><p>{integration
      ? `Keys let an AI client or script act as ${integration.name}, over MCP or the REST API. A key reaches only what owners share with ${integration.name} by name, only what its permissions allow, and only until it expires. Creating or rotating one asks for your password; copy the new key into the client that uses it.`
      : "Keys let trusted AI clients and scripts use Nook as you, over MCP or the REST API. Each key does only what its permissions allow, only with items you can open, and only until it expires. No key can share, manage access, manage keys, or delete forever."}</p></div></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {status && <p className="keys-status" role="status">{status}</p>}
    <div className="mcp-endpoint"><div><span>Transport</span><strong>Streamable HTTP</strong></div><div><span>Endpoint</span><code>{endpoint}</code><button type="button" className="icon-button" onClick={() => copy(endpoint, "endpoint")} aria-label="Copy MCP endpoint"><Copy /></button></div></div>

    {newToken && <div className="new-api-key" role="status"><strong>{newToken.rotated ? `Copy the new key for ${newToken.name} now` : "Copy this key now"}</strong><p>It cannot be shown again after you leave this screen. You can select the text manually if automatic copy is unavailable.</p><textarea ref={tokenFieldRef} readOnly value={newToken.token} aria-label="New API key" onFocus={(event) => event.currentTarget.select()} /><div><button type="button" className="secondary-button" onClick={() => copy(newToken.token, "token")}><Copy />{copied === "token" ? "Copied key" : "Copy key"}</button><button type="button" className="text-button" onClick={() => setNewToken(null)}>I saved this key</button></div></div>}

    <div className="mcp-card keys-card">
      <div className="keys-card-head">
        <div><h4 ref={headingRef} tabIndex={-1}>{integration ? `Keys of ${integration.name}` : "Your keys"}</h4><p>{data ? keyPolicyLine(data.policy, data.liveCount) : "Loading…"}</p></div>
        {!guest && <button ref={newKeyRef} type="button" className="primary-button keys-new" onClick={() => { setStatus(""); openDialog({ kind: "create" }); }} disabled={!data || atLimit || Boolean(newToken) || needsGoogle}><Plus aria-hidden="true" />New key</button>}
      </div>
      {/* Q2: the confirmation state too ("Confirmed with Google until …"), not only the button. */}
      {!guest && account && !asksForPassword(account) && <GoogleReauthNotice account={account} returnTo={keysApi.returnTo} />}
      {guest && <p className="mcp-role-note" role="note">Guests cannot create API keys. Ask an admin for another team role.</p>}
      {role === "viewer" && <p className="mcp-role-note" role="note">{integration ? "This integration is a viewer: its keys can only read." : "Team role: Viewer. Keys you create can only read."}</p>}
      {data && !data.policy.mcpAllowed && <p className="mcp-role-note" role="note">Team policy does not allow your team role to use MCP keys.</p>}
      {atLimit && <p className="mcp-role-note" role="note">You have {data!.liveCount} live keys, the most team policy allows. Revoke one to create another.</p>}
      <ul ref={liveListRef} className="keys-list" aria-label="API keys">
        {live.map((key) => <KeyRow key={key.id} apiKey={key} onRotate={needsGoogle ? undefined : () => openDialog({ kind: "rotate", key })} onEdit={() => openDialog({ kind: "edit", key })} onRevoke={() => openDialog({ kind: "revoke", key })} onReview={() => openDialog({ kind: "review", key })} />)}
      </ul>
      {data && !live.length && <p className="keys-empty">No active API keys.</p>}
      {revoked.length > 0 && <details className="keys-revoked"><summary>Revoked in the last 7 days ({revoked.length})</summary><ul className="keys-list">{revoked.map((key) => <KeyRow key={key.id} apiKey={key} />)}</ul></details>}
    </div>

    <div className="mcp-card mcp-config"><div><h4 id="mcp-config-heading">JSON client configuration</h4><p>This common JSON shape is supported by many Streamable HTTP clients; check your client's documentation because config formats differ. Replace the placeholder if you have not just created a key.</p></div><pre aria-labelledby="mcp-config-heading"><code>{configText}</code></pre><button type="button" className="secondary-button" onClick={() => copy(configText, "config")}><Copy />{copied === "config" ? "Copied config" : "Copy config"}</button></div>

    <div className="mcp-card mcp-config keys-rest-help"><div><h4 id="keys-rest-heading">Using the REST API</h4><p>A key whose “Where it is used” includes REST runs the same tools over plain HTTPS, for scripts and CI. Send it only in the Authorization header, never in a URL. Bodies are JSON. <code>GET /api/v1/tools</code> lists what the key can call, and <code>GET /api/v1/me</code> shows its permissions and limits. Replace the placeholder with your key.</p></div><pre aria-labelledby="keys-rest-heading"><code>{restExample}</code></pre><button type="button" className="secondary-button" onClick={() => copy(restExample, "rest")}><Copy />{copied === "rest" ? "Copied example" : "Copy example"}</button></div>

    {/* Back off the phone sentinel closes a key dialog; Forward shows the same one again (Friction 12). */}
    <HistoryDialogReopen.Provider value={dialog && reopenOnForward ? () => setDialog(dialog) : null}>
    {dialog?.kind === "create" && data && <CreateKeyDialog policy={data.policy} role={role} totpEnabled={totpEnabled} onClose={closeDialog} onCreated={(key) => { closeDialog(); setNewToken({ token: key.token, name: key.name, rotated: false }); load(); }} />}
    {dialog?.kind === "edit" && data && <EditKeyDialog apiKey={dialog.key} policy={data.policy} role={role} onClose={closeDialog} onSaved={(message) => { closeDialog(); setStatus(message); load(); }} />}
    {dialog?.kind === "rotate" && data && <RotateKeyDialog apiKey={dialog.key} policy={data.policy} role={role} totpEnabled={totpEnabled} onClose={closeDialog} onRotated={(key) => { closeDialog(); setNewToken({ token: key.token, name: key.name, rotated: true }); load(); }} />}
    {dialog?.kind === "revoke" && <RevokeKeyDialog apiKey={dialog.key} onClose={closeDialog} onRevoked={() => { closeDialogAfterReload(revokedFocusKey(dialog.key.id)); setStatus(`${dialog.key.name} was revoked.`); }} />}
    {dialog?.kind === "review" && <McpBinnedReview keyId={dialog.key.id} keyName={dialog.key.name} onClose={() => closeDialogAfterReload(dialog.key.id)} onRevoke={() => setDialog({ kind: "revoke", key: dialog.key })} />}
    </HistoryDialogReopen.Provider>
  </section>;
}

/**
 * Where a key may be used (D279, O-A8): MCP by default, REST opt-in, each only when team policy
 * allows the holder's role there.
 */
export function surfaceChoices(policy: Pick<PolicySummary, "mcpAllowed" | "restAllowed">) {
  return [
    { value: "mcp" as const, label: "MCP", description: policy.mcpAllowed ? "AI clients such as Claude Code" : "Turned off by team policy", disabled: !policy.mcpAllowed },
    { value: "rest" as const, label: "REST", description: policy.restAllowed ? "Scripts and CI over the REST API (/api/v1)" : "Turned off by team policy", disabled: !policy.restAllowed },
    { value: "both" as const, label: "MCP and REST", description: policy.restAllowed && policy.mcpAllowed ? "Both" : "Turned off by team policy", disabled: !policy.restAllowed || !policy.mcpAllowed }
  ];
}

/**
 * The optional address limit (D284). Offered only where the server can see client addresses
 * (TRUSTED_PROXY_HOPS set by the operator, O-A7); otherwise one line says why it is not offered.
 */
function AllowlistField({ available, pinned, value, onChange, disabled, mode = "create" }: { available: boolean; pinned?: boolean; value: string; onChange: (value: string) => void; disabled: boolean; mode?: "create" | "narrow" | "rotate" }) {
  if (!available) return <p className="keys-allowlist-off" role="note">Limiting a key to IP addresses is off on this server: it only works when your admin has told Nook how many proxies sit in front of it (TRUSTED_PROXY_HOPS).</p>;
  const checked = checkAllowlist(value);
  const help = mode === "narrow" ? "One address or range per line. You can only tighten this list here. Rotate the key to change this."
    : mode === "rotate" ? "One address or range per line, up to 10. The new key uses this list; leave it empty to allow any address."
    : "One IPv4 or IPv6 address or CIDR range per line, up to 10. Leave empty to allow any address. Adding a limit later narrows the key; widening or removing it needs a rotation.";
  return <label className="keys-input">Allowed addresses (optional)
    <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={3} placeholder={"203.0.113.10\n198.51.100.0/24"} disabled={disabled} spellCheck={false} autoComplete="off"
      aria-invalid={checked.error ? true : undefined} className={checked.error ? "invalid" : undefined} />
    {checked.error && <small className="keys-field-error" role="alert">{checked.error}</small>}
    {!checked.error && checked.changed.length > 0 && <small className="keys-field-note">Saved as: {checked.changed.join(", ")}</small>}
    <small>{help}</small>
    {/* Review S1: without TRUSTED_PROXY_ADDRESSES, anyone who reaches Nook's port directly could claim an address. */}
    {!pinned && <small className="keys-field-note">This only holds while Nook's port can be reached through your reverse proxy alone.</small>}
  </label>;
}

/** Review S7: the per-minute limits are per surface. */
export const PER_SURFACE_LIMITS = "Limits apply per surface: a key used over both MCP and REST gets each minute's calls and writes on each.";

/** The REST help's example (Wave 34): a tool call with a placeholder key, never a real one. */
export function restCurlExample(origin: string) {
  return [
    `curl -s -X POST "${origin}/api/v1/tools/list_boards" \\`,
    "  -H \"Authorization: Bearer <YOUR_API_KEY>\" \\",
    "  -H \"Content-Type: application/json\" \\",
    "  -d '{}'"
  ].join("\n");
}

/** The line under an Expires choice: the policy cap, and why "No expiry" is off when it is. */
export function expiryNote(policy: Pick<PolicySummary, "keyMaxDays" | "keyRequireExpiry">) {
  return policy.keyRequireExpiry
    ? `Team policy allows at most ${policy.keyMaxDays} days and requires an expiry.`
    : `Team policy allows at most ${policy.keyMaxDays} days, or no expiry.`;
}

/** The live key to focus after one is revoked: the next one down, else the one above, else none. */
export function keyAfterRevoke(liveIds: readonly string[], revokedId: string): string | null {
  const index = liveIds.indexOf(revokedId);
  const rest = liveIds.filter((id) => id !== revokedId);
  if (!rest.length) return null;
  if (index < 0) return rest[0]!;
  return rest[Math.min(index, rest.length - 1)]!;
}

function keyPolicyLine(policy: PolicySummary, liveCount: number) {
  return `${liveCount} of ${policy.keysPerUser} live keys. New keys expire after at most ${policy.keyMaxDays} days${policy.keyRequireExpiry ? "" : ", or never"} (team policy).`;
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

/**
 * Why a blocked key is blocked (Q4, decision kept): with an expiry required, a key without one is
 * blocked, not revoked, until it is rotated with an expiry or the policy is turned off.
 */
export const EXPIRY_BLOCKED_TEXT = "Blocked by team policy: keys need an expiry. Rotate it to give it one.";
export const blockedLine = (key: Pick<ApiKey, "blockedBy" | "blockedMessage">) => key.blockedBy === "expiry_required" ? EXPIRY_BLOCKED_TEXT : key.blockedMessage ?? "";

export function KeyRow({ apiKey, owner, onRotate, onEdit, onRevoke, onReview }: { apiKey: ApiKey; owner?: React.ReactNode; onRotate?: () => void; onEdit?: () => void; onRevoke?: () => void; onReview?: () => void }) {
  const state = keyStateLabel(apiKey);
  const binned = binnedTodayLine(apiKey.binnedToday);
  return <li className={`keys-row state-${apiKey.state}`} data-key-id={apiKey.id}>
    <span className="key-icon" aria-hidden="true"><KeyRound /></span>
    <div className="keys-row-main">
      <div className="keys-row-title"><strong>{apiKey.name}</strong><span className="keys-chip">{SURFACE_LABELS[apiKey.surfaces]}</span>{apiKey.ipRestricted && <span className="keys-chip" title={apiKey.ipAllowlist?.join(", ")}>{apiKey.ipAllowlist ? `IP limited (${apiKey.ipAllowlist.length})` : "IP limited"}</span>}{apiKey.kind === "vault" && <span className="keys-chip">Vault</span>}<span className={`keys-chip tone-${state.tone}`}>{state.label}</span></div>
      {owner && <small className="keys-row-owner">{owner}</small>}
      <small><code>{apiKey.prefix}…</code> · Created {relativeTime(apiKey.createdAt)} · {lastUsedLine(apiKey, relativeTime)}</small>
      {apiKey.ipAllowlist && <small className="keys-row-description">Only from {apiKey.ipAllowlist.join(", ")}</small>}
      {blockedSurfaceLine(apiKey) && <small className="keys-row-warning">{blockedSurfaceLine(apiKey)}</small>}
      {deniedLine(apiKey, relativeTime) && <small className="keys-row-warning">{deniedLine(apiKey, relativeTime)}</small>}
      {apiKey.description && <small className="keys-row-description">{apiKey.description}</small>}
      <ul className="scope-chips" aria-label={`Permissions for ${apiKey.name}`}>{grantChips(apiKey.grants).map((chip) => <li key={chip.id} className={chip.active ? undefined : "inactive"}>{chip.label}</li>)}</ul>
      {apiKey.state === "blocked" && (apiKey.blockedBy === "expiry_required" || apiKey.blockedMessage) && <small className="keys-row-warning">{blockedLine(apiKey)}</small>}
      {apiKey.state === "revoked" && apiKey.revokedBy === "admin" && <small className="keys-row-warning">An admin revoked this key{apiKey.revokeReason ? `: “${apiKey.revokeReason}”` : "."}</small>}
      {apiKey.state !== "revoked" && apiKey.surfaces !== "both" && <div className="keys-row-usage"><UsageBars usage={apiKey.usage14d} /><small>{usageLabel(apiKey.usage14d)}</small></div>}
      {/* Review Q12: a key on both surfaces shows its calls per surface per day. */}
      {apiKey.state !== "revoked" && apiKey.surfaces === "both" && (["mcp", "rest"] as const).map((surface) => {
        const daily = apiKey.usageBySurface14d?.daily?.[surface] ?? [];
        return <div key={surface} className="keys-row-usage"><UsageBars usage={daily} /><small>{surface === "mcp" ? "MCP" : "REST"}: {usageLabel(daily).replace("No calls", "no calls")}</small></div>;
      })}
      {!owner && apiKey.state !== "revoked" && <KeyActivity keyId={apiKey.id} />}
      {binned && onReview && <small className="mcp-key-binned">{binned} · <button type="button" className="text-button" onClick={onReview}>Review</button></small>}
    </div>
    {(onRotate || onEdit || onRevoke) && <div className="keys-row-actions">
      {onRotate && apiKey.state !== "grace" && apiKey.state !== "expired" && <button type="button" className="keys-action" onClick={onRotate}><RefreshCw aria-hidden="true" />Rotate</button>}
      {onEdit && apiKey.state !== "expired" && <button type="button" className="keys-action" onClick={onEdit}><Pencil aria-hidden="true" />Edit</button>}
      {onRevoke && <button type="button" className="keys-action danger" onClick={onRevoke}><Trash2 aria-hidden="true" />{apiKey.state === "grace" ? "Revoke now" : "Revoke"}</button>}
    </div>}
  </li>;
}

/**
 * The key's own events for its owner (Wave 34 verification Q1), loaded when opened: created,
 * narrowed, rotated, blocked, and refused calls with the shortened address they came from.
 */
function KeyActivity({ keyId }: { keyId: string }) {
  const keysApi = useKeysApi();
  const [events, setEvents] = useState<KeyEvent[] | "error" | null>(null);
  return <details className="keys-activity" onToggle={(event) => {
    if ((event.currentTarget as HTMLDetailsElement).open && events === null) keysApi.events(keyId).then(setEvents, () => setEvents("error"));
  }}>
    <summary>Recent activity</summary>
    {events === null ? <small role="status">Loading…</small> : events === "error" ? <small role="alert">Could not load this key's activity.</small>
      : events.length === 0 ? <small>Nothing yet.</small>
        : <ul>{events.map((event) => <li key={event.id}><small>{keyEventLine(event)} · {relativeTime(event.createdAt)}</small></li>)}</ul>}
  </details>;
}

function ReauthFields({ totpEnabled, password, code, onPassword, onCode, disabled }: { totpEnabled: boolean; password: string; code: string; onPassword: (value: string) => void; onCode: (value: string) => void; disabled: boolean }) {
  const keysApi = useKeysApi();
  // Wave 35 (D297): accounts without a usable password confirm with Google instead.
  const account = useAccountAuth();
  return <div className="keys-reauth">
    {asksForPassword(account)
      ? <label className="keys-input">Confirm password<input type="password" autoComplete="current-password" value={password} onChange={(event) => onPassword(event.target.value)} required disabled={disabled} /></label>
      : <GoogleReauthNotice account={account!} returnTo={keysApi.returnTo} startable={false} />}
    {totpEnabled && <label className="keys-input">Fresh six-digit code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="000000" value={code} onChange={(event) => onCode(event.target.value)} required disabled={disabled} /></label>}
  </div>;
}

function CreateKeyDialog({ policy, role, totpEnabled, onClose, onCreated }: { policy: PolicySummary; role: string | undefined; totpEnabled: boolean; onClose: () => void; onCreated: (key: ApiKey & { token: string }) => void }) {
  const keysApi = useKeysApi();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [surfaces, setSurfaces] = useState<KeySurfaces>("mcp");
  const [expires, setExpires] = useState(String(policy.keyDefaultDays));
  const [rows, setRows] = useState<GrantRow[]>(() => [{ key: newRowKey(), module: "notes", permission: "read", applies: "all", resourceIds: [] }]);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [allowlist, setAllowlist] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const surfaceOptions = surfaceChoices(policy);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { grants, error: grantError } = rowsToGrants(rows);
    if (grantError) return setError(grantError);
    if (!name.trim()) return setError("Give the key a name.");
    setBusy(true);
    setError("");
    try {
      const checked = checkAllowlist(allowlist);
      if (checked.error) {
        setBusy(false);
        return setError(`Allowed addresses: ${checked.error}`);
      }
      const ipAllowlist = checked.canonical;
      const result = await keysApi.create({ name: name.trim(), description: description.trim() || null, surfaces, expiresInDays: expiryDays(expires), grants, ...(ipAllowlist.length ? { ipAllowlist } : {}), ...reauthPassword(password), ...(totpEnabled ? { totpCode: code } : {}) });
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
      <div className="keys-select-field"><span id="keys-surface-label">Where it is used</span><Select<KeySurfaces> labelledBy="keys-surface-label" label="Where it is used" value={surfaces} options={surfaceOptions} onChange={setSurfaces} disabled={busy} />{surfaces === "both" && <small>{PER_SURFACE_LIMITS}</small>}</div>
      <fieldset className="keys-fieldset"><legend>Access</legend><GrantBuilder rows={rows} onChange={setRows} role={role} policy={policy} disabled={busy} /></fieldset>
      <div className="keys-select-field"><span id="keys-expiry-label">Expires</span><Select labelledBy="keys-expiry-label" label="Expires" value={expires} options={expiryChoices(policy)} onChange={setExpires} disabled={busy} /><small>{expiryNote(policy)}</small></div>
      <AllowlistField available={Boolean(policy.ipAllowlistAvailable)} pinned={policy.ipProxyPinned} value={allowlist} onChange={setAllowlist} disabled={busy} />
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
    if (grant.resource) row.resourceIds.push(resourceToken(grant.resource.kind, grant.resource.id));
    rows.set(id, row);
  }
  return [...rows.values()];
}

function EditKeyDialog({ apiKey, policy, role, onClose, onSaved }: { apiKey: ApiKey; policy: PolicySummary; role: string | undefined; onClose: () => void; onSaved: (message: string) => void }) {
  const keysApi = useKeysApi();
  const ceiling = useMemo(() => keyToRows(apiKey), [apiKey]);
  const [rows, setRows] = useState<GrantRow[]>(ceiling);
  const [name, setName] = useState(apiKey.name);
  const [description, setDescription] = useState(apiKey.description ?? "");
  const [expires, setExpires] = useState("keep");
  const [surfaces, setSurfaces] = useState<KeySurfaces>(apiKey.surfaces);
  const [allowlist, setAllowlist] = useState((apiKey.ipAllowlist ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const daysLeft = apiKey.expiresAt ? Math.max(1, Math.ceil((Date.parse(apiKey.expiresAt) - Date.now()) / 86_400_000)) : null;
  const expiryChoices = [
    { value: "keep", label: daysLeft === null ? "Keep: no expiry" : `Keep: ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left` },
    ...[1, 7, 30, 90].filter((days) => daysLeft === null || days < daysLeft).map((days) => ({ value: String(days), label: days === 1 ? "Expire in 1 day" : `Expire in ${days} days` })),
    // Editing only narrows (D278): a dated key gets no expiry by rotating, which asks for the password.
    ...(daysLeft === null ? [] : [{ value: "no-expiry", label: "No expiry", description: "Rotate the key to give it no expiry", disabled: true }])
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
    // Adding or tightening an address limit narrows the key (D278); the server refuses widening.
    const checkedList = checkAllowlist(allowlist);
    if (checkedList.error) return setError(`Allowed addresses: ${checkedList.error}`);
    const nextAllowlist = checkedList.canonical;
    if (nextAllowlist.length && nextAllowlist.join("\n") !== (apiKey.ipAllowlist ?? []).join("\n")) body.ipAllowlist = nextAllowlist;
    if (!nextAllowlist.length && apiKey.ipAllowlist?.length) return setError("Removing the address limit widens the key. Rotate the key to change this.");
    if (!Object.keys(body).length) return onClose();
    setBusy(true);
    setError("");
    try {
      await keysApi.narrow(apiKey.id, body);
      onSaved(`${body.name ?? apiKey.name} was updated.`);
    } catch (reason) {
      setError(messageOf(reason, "Could not save the key"));
      setBusy(false);
    }
  }

  const hasSelectors = ceiling.some((row) => SELECTOR_KINDS[row.module]);
  return <KeysDialog title={`Edit ${apiKey.name}`} description={`Editing can only remove access, bring the expiry closer, or rename. Rotate the key to add access, surfaces, or addresses.${hasSelectors ? " You can narrow “all” to chosen items." : ""}`} onClose={onClose} busy={busy} wide>
    <form className="keys-form" onSubmit={submit}>
      <label className="keys-input">Name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required disabled={busy} autoComplete="off" /></label>
      <label className="keys-input">Description (optional)<input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={200} disabled={busy} autoComplete="off" /></label>
      {apiKey.surfaces === "both" && <div className="keys-select-field"><span id="keys-edit-surface">Where it is used</span><Select<KeySurfaces> labelledBy="keys-edit-surface" label="Where it is used" value={surfaces} options={surfaceChoices} onChange={setSurfaces} disabled={busy} /></div>}
      <fieldset className="keys-fieldset"><legend>Access</legend><GrantBuilder rows={rows} onChange={setRows} role={role} policy={policy} disabled={busy} ceiling={ceiling} /></fieldset>
      <div className="keys-select-field"><span id="keys-edit-expiry">Expiry</span><Select labelledBy="keys-edit-expiry" label="Expiry" value={expires} options={expiryChoices} onChange={setExpires} disabled={busy} /></div>
      <AllowlistField available={Boolean(policy.ipAllowlistAvailable)} pinned={policy.ipProxyPinned} value={allowlist} onChange={setAllowlist} disabled={busy} mode={apiKey.ipAllowlist?.length ? "narrow" : "create"} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="keys-dialog-actions inline">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || !rows.length}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </form>
  </KeysDialog>;
}

/**
 * Rotate (D277, review Q2): a new secret after re-authentication. Because it re-authenticates, it may
 * also change what the new key can do, widening included: access, where it is used, and addresses.
 */
function RotateKeyDialog({ apiKey, policy, role, totpEnabled, onClose, onRotated }: { apiKey: ApiKey; policy: PolicySummary; role: string | undefined; totpEnabled: boolean; onClose: () => void; onRotated: (key: ApiKey & { token: string }) => void }) {
  const keysApi = useKeysApi();
  const [grace, setGrace] = useState<string>("24");
  const [expires, setExpires] = useState(() => rotationExpiryDefault(apiKey, policy));
  const original = useMemo(() => keyToRows(apiKey), [apiKey]);
  const [rows, setRows] = useState<GrantRow[]>(original);
  const [surfaces, setSurfaces] = useState<KeySurfaces>(apiKey.surfaces);
  const [allowlist, setAllowlist] = useState((apiKey.ipAllowlist ?? []).join("\n"));
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { grants, error: grantError } = rowsToGrants(rows);
    if (grantError) return setError(grantError);
    const checked = checkAllowlist(allowlist);
    if (checked.error) return setError(`Allowed addresses: ${checked.error}`);
    const changes: Parameters<KeysApi["rotate"]>[1] = { graceHours: Number(grace) as 0 | 1 | 24 | 168, expiresInDays: expiryDays(expires) };
    if (JSON.stringify(rowsToGrants(original).grants) !== JSON.stringify(grants)) changes.grants = grants;
    if (surfaces !== apiKey.surfaces) changes.surfaces = surfaces;
    if (checked.canonical.join("\n") !== (apiKey.ipAllowlist ?? []).join("\n")) changes.ipAllowlist = checked.canonical.length ? checked.canonical : null;
    setBusy(true);
    setError("");
    try {
      const result = await keysApi.rotate(apiKey.id, { ...changes, ...reauthPassword(password), ...(totpEnabled ? { totpCode: code } : {}) });
      onRotated(result.key);
    } catch (reason) {
      setError(messageOf(reason, "Could not rotate the key"));
      setBusy(false);
    }
  }

  return <KeysDialog title={`Rotate ${apiKey.name}?`} description="You get a new secret and a fresh lifetime. You may also change what the new key can do, including adding access, surfaces, or addresses. Routines that use this key move to the new one. Update your clients before the old key stops." onClose={onClose} busy={busy} wide>
    <form className="keys-form" onSubmit={submit}>
      <div className="keys-select-field"><span id="keys-rotate-surface">Where it is used</span><Select<KeySurfaces> labelledBy="keys-rotate-surface" label="Where it is used" value={surfaces} options={surfaceChoices(policy)} onChange={setSurfaces} disabled={busy} /></div>
      <fieldset className="keys-fieldset"><legend>Access</legend><GrantBuilder rows={rows} onChange={setRows} role={role} policy={policy} disabled={busy} /></fieldset>
      <AllowlistField available={Boolean(policy.ipAllowlistAvailable) || Boolean(apiKey.ipAllowlist?.length)} pinned={policy.ipProxyPinned} value={allowlist} onChange={setAllowlist} disabled={busy} mode="rotate" />
      <div className="keys-select-field"><span id="keys-grace-label">Old key</span><Select labelledBy="keys-grace-label" label="Old key" value={grace} options={GRACE_OPTIONS.map((option) => ({ ...option }))} onChange={setGrace} disabled={busy} /></div>
      <div className="keys-select-field"><span id="keys-rotate-expiry-label">New key expires</span><Select labelledBy="keys-rotate-expiry-label" label="New key expires" value={expires} options={expiryChoices(policy)} onChange={setExpires} disabled={busy} /><small>{expiryNote(policy)}</small></div>
      <ReauthFields totpEnabled={totpEnabled} password={password} code={code} onPassword={setPassword} onCode={setCode} disabled={busy} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="keys-dialog-actions inline">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Rotating…" : "Rotate key"}</button>
      </div>
    </form>
  </KeysDialog>;
}

/**
 * The revoke confirm's words (Friction 7). During a rotation grace the old and new keys share a name,
 * so it names the old key and its prefix; the Inbox line appears only when the key has pending suggestions.
 */
export function revokeCopy(key: Pick<ApiKey, "name" | "prefix" | "state" | "pendingProposals">) {
  const pending = key.pendingProposals ?? 0;
  const inbox = pending > 0 ? ` Its ${pending === 1 ? "pending suggestion" : `${pending} pending suggestions`} in the Inbox ${pending === 1 ? "is" : "are"} withdrawn.` : "";
  if (key.state === "grace") return {
    title: `Revoke the old key for ${key.name} now?`,
    description: `The old key (${key.prefix}…) stops working at once instead of at the end of its grace. The new key keeps working.${inbox} This cannot be undone.`
  };
  return {
    title: `Revoke ${key.name}?`,
    description: `Clients using this key (${key.prefix}…) stop working at once.${inbox} This cannot be undone.`
  };
}

function RevokeKeyDialog({ apiKey, onClose, onRevoked }: { apiKey: ApiKey; onClose: () => void; onRevoked: () => void }) {
  const keysApi = useKeysApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirmAction() {
    setBusy(true);
    setError("");
    try {
      await keysApi.revoke(apiKey.id);
      onRevoked();
    } catch (reason) {
      setError(messageOf(reason, "Could not revoke the key"));
      setBusy(false);
    }
  }
  const copy = revokeCopy(apiKey);
  return <KeysDialog title={copy.title} description={copy.description} onClose={onClose} busy={busy}
    footer={<><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="primary-button danger" onClick={confirmAction} disabled={busy}>{busy ? "Revoking…" : apiKey.state === "grace" ? "Revoke old key" : "Revoke key"}</button></>}>
    {error && <p className="form-error" role="alert">{error}</p>}
  </KeysDialog>;
}
