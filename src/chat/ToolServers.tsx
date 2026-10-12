import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Plug, Plus, RefreshCw, ShieldAlert } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import { useConfirm } from "../ui/useConfirm";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { AGENT_BOUNDS, type CatalogTool, type DeclaredStdioServer, type ServerAuthKind, type ServerAvailability, type ToolPolicy, type ToolServerSummary } from "../../shared/agents";
import { createServer, deleteServer, errorCode, listServers, messageOf, setServerPolicies, syncServer, updateServer, type ToolServerList } from "./chatApi";
import { POLICY_BADGES } from "./toolPicker";
import "./chat.css";
import { notify } from "../ui/notify";

/**
 * Settings → AI → Tool servers (agent chat plan §4.1, §13.4, D349, D354; Wave 41 AC-B): the list
 * with a status dot, Sync, Edit, Remove; a catalog per server with read-only and open-world badges
 * and a policy Select per tool (auto, asks first, off); the add/edit sheet (URL, a write-only
 * credential, timeout, result cap, availability); and the host-declared stdio servers, read-only,
 * with Adopt. Follows the providers pattern: a removal is immediate (no Bin), with useConfirm.
 */

export const SECRET_HONESTY = "Encrypted at rest; anyone with the server and its key can read these secrets.";
const STATUS_TEXT: Record<ToolServerSummary["status"], string> = { unknown: "Not synced yet", ok: "Reachable", auth_failed: "Credential refused", unreachable: "Unreachable", error: "Error" };
const AVAILABILITY_LABELS: Record<ServerAvailability, string> = { admins: "Admins only", all: "Everyone who can chat" };

/** `onCountChange` (Settings → AI's tab count): the number of servers, once loaded and after every change. */
export function ToolServersSection({ flash, onCountChange }: { flash: (message: string) => void; onCountChange?: (count: number) => void }) {
  const [list, setList] = useState<ToolServerList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ToolServerSummary | "new" | { adopt: DeclaredStdioServer } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    try {
      setList(await listServers());
      setError(null);
    } catch (reason) {
      setError(messageOf(reason, "Could not load tool servers"));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const count = list?.servers.length;
  useEffect(() => { if (count !== undefined) onCountChange?.(count); }, [count, onCountChange]);

  async function sync(server: ToolServerSummary) {
    setSyncing(server.id);
    try {
      const { server: next } = await syncServer(server.id);
      setList((current) => current ? { ...current, servers: current.servers.map((item) => item.id === next.id ? next : item) } : current);
      (next.status === "ok" ? notify.success : notify.error)(next.status === "ok" ? `${next.tools.length} ${next.tools.length === 1 ? "tool" : "tools"} synced` : `Sync failed: ${next.lastError ?? STATUS_TEXT[next.status]}`);
    } catch (reason) {
      notify.error(messageOf(reason, "Could not sync"));
    } finally {
      setSyncing(null);
    }
  }
  async function remove(server: ToolServerSummary) {
    if (!await confirm.ask({ title: `Remove ${server.name}?`, message: "Agents lose its tools at their next step. Its credential is deleted.", confirmLabel: "Remove", danger: true })) return;
    try {
      await deleteServer(server.id);
      notify.success("Tool server removed");
      void load();
    } catch (reason) {
      notify.error(messageOf(reason, "Could not remove the server"));
    }
  }
  async function toggleEnabled(server: ToolServerSummary) {
    try {
      const { server: next } = await updateServer(server.id, { enabled: !server.enabled, expectedRevision: server.revision });
      setList((current) => current ? { ...current, servers: current.servers.map((item) => item.id === next.id ? next : item) } : current);
    } catch (reason) {
      notify.error(errorCode(reason) === "REVISION_MISMATCH" ? "This server changed elsewhere; reload" : messageOf(reason, "Could not change the server"));
    }
  }
  async function setPolicy(server: ToolServerSummary, tool: CatalogTool, policy: ToolPolicy) {
    // Wave 41 QA L1: a tool its server does not declare read-only runs without asking only after a confirm.
    if (policy === "auto" && !tool.readOnly && !await confirm.ask({
      title: `Run ${tool.name} without asking?`,
      message: "This tool can change things outside Nook, and its arguments are written by the model. With Runs on its own, agents call it without a card in the chat.",
      confirmLabel: "Run without asking", danger: true
    })) return;
    try {
      const { server: next } = await setServerPolicies(server.id, { [tool.name]: policy });
      setList((current) => current ? { ...current, servers: current.servers.map((item) => item.id === next.id ? next : item) } : current);
    } catch (reason) {
      notify.error(messageOf(reason, "Could not change the policy"));
    }
  }

  return <section className="ai-servers" aria-labelledby="ai-servers-heading">
    <div className="settings-section-heading"><span className="settings-icon"><Plug /></span><div><h3 id="ai-servers-heading">Tool servers</h3><p>MCP servers over Streamable HTTP that agents may call. The server calls them with the credential below and sends tool arguments the model wrote; results come back as untrusted text, capped per server. At most {AGENT_BOUNDS.toolServers}.</p></div></div>
    {list?.stdio.enabled && <p className="settings-warning ai-stdio-warning" role="note"><ShieldAlert aria-hidden="true" /><span><strong>AGENT_MCP_STDIO is on.</strong> A stdio server runs as Nook's own user with full trust: it can read Nook's keys, database, and vault, and nothing Nook does contains it. Use an HTTP bridge in its own container instead (docs/OPERATIONS.md).</span></p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {list && list.servers.length === 0 && <p className="chat-muted">No tool servers yet. Agents can still use Nook's own tools through a linked key.</p>}
    <ul className="ai-providers">
      {list?.servers.map((server) => <li key={server.id} className={`security-card ai-provider ai-server${server.enabled ? "" : " ai-server-disabled"}`}>
        <div className="ai-provider-head">
          <div>
            <strong><span className={`ai-status-dot ai-status-${server.status}`} aria-hidden="true" />{server.name}{!server.enabled && <span className="ai-badge">Disabled</span>}{server.transport === "stdio" && <span className="ai-badge">stdio</span>}</strong>
            <small>{server.transport === "stdio" ? `Declared by the host (${server.stdioId}) · runs as Nook's user` : server.url}</small>
            <small>{STATUS_TEXT[server.status]}{server.lastError ? ` · ${server.lastError}` : ""}{server.toolsSyncedAt ? ` · synced ${new Date(server.toolsSyncedAt).toLocaleString()}` : ""}</small>
          </div>
          <div className="ai-provider-actions">
            <button type="button" className="secondary-button" onClick={() => { void sync(server); }} disabled={syncing === server.id}><RefreshCw />{syncing === server.id ? "Syncing…" : "Sync tools"}</button>
            <button type="button" className="secondary-button" onClick={() => setEditing(server)}>Edit</button>
            <button type="button" className="secondary-button" onClick={() => { void toggleEnabled(server); }}>{server.enabled ? "Disable" : "Enable"}</button>
            <button type="button" className="secondary-button" onClick={() => { void remove(server); }}>Remove</button>
          </div>
        </div>
        <dl className="ai-provider-facts">
          <div><dt>Credential</dt><dd>{server.hasSecret ? <code>{server.authKind === "header" ? `${server.authHeader}: ` : "Bearer "}{server.hint ?? "Saved"}</code> : <span className="chat-muted">none</span>}</dd></div>
          <div><dt>Who may use it</dt><dd>{AVAILABILITY_LABELS[server.availability]}</dd></div>
          <div><dt>Timeout</dt><dd>{server.timeoutMs / 1000} s</dd></div>
          <div><dt>Result cap</dt><dd>{Math.round(server.resultCapBytes / 1024)} KiB</dd></div>
        </dl>
        <button type="button" className="chat-link" aria-expanded={open === server.id} onClick={() => setOpen(open === server.id ? null : server.id)}>{server.tools.length} {server.tools.length === 1 ? "tool" : "tools"}{open === server.id ? " ▴" : " ▾"}</button>
        {open === server.id && (server.tools.length === 0 ? <p className="chat-muted">Sync to list its tools.</p> : <ul className="ai-tools">
          {server.tools.map((tool) => <li key={tool.name}>
            <div className="ai-tool-text">
              <strong><code>{tool.name}</code>{tool.readOnly && <span className="ai-badge ai-badge-ok">Read-only</span>}{!tool.readOnly && <span className="ai-badge">Not read-only</span>}{tool.openWorld && <span className="ai-badge ai-badge-warn">Open world</span>}{tool.destructive && <span className="ai-badge ai-badge-warn">Destructive</span>}</strong>
              <small>{tool.description || "No description"}</small>
            </div>
            <Select<ToolPolicy> label={`Policy for ${tool.name}`} value={tool.policy} onChange={(policy) => { void setPolicy(server, tool, policy); }} options={[{ value: "auto", label: POLICY_BADGES.auto, description: "Runs without asking" }, { value: "confirm", label: POLICY_BADGES.confirm, description: "A card in the chat" }, { value: "off", label: POLICY_BADGES.off, description: "Never offered" }]} variant="compact" />
          </li>)}
        </ul>)}
      </li>)}
    </ul>
    <p className="policy-copy">{SECRET_HONESTY} A tool marked read-only by its server runs on its own by default; every other tool asks first, and annotations never loosen a policy you set.</p>
    <button type="button" className="action-button secondary ai-add" onClick={() => setEditing("new")} disabled={!list || list.servers.length >= AGENT_BOUNDS.toolServers}><Plus />Add tool server</button>
    {list?.stdio.enabled && <div className="security-card ai-stdio">
      <strong>Declared by the host (AGENT_MCP_STDIO)</strong>
      <p className="chat-muted">stdio servers come only from the host's declaration file. Adopt one only if you trust it as much as Nook itself.</p>
      {list.stdio.declared.length === 0 ? <p className="chat-muted">The file declares no servers.</p> : <ul className="ai-tools">{list.stdio.declared.map((entry) => <li key={entry.id}>
        <div className="ai-tool-text"><strong><code>{entry.id}</code> {entry.name}</strong><small>{entry.command} {entry.args.join(" ")}{entry.envNames.length ? ` · env: ${entry.envNames.join(", ")}` : ""}</small></div>
        {entry.adopted ? <span className="ai-badge">Adopted</span> : <button type="button" className="secondary-button" onClick={() => setEditing({ adopt: entry })}>Adopt</button>}
      </li>)}</ul>}
    </div>}
    {editing && <ServerDialog server={editing === "new" || "adopt" in editing ? null : editing} adopt={editing !== "new" && "adopt" in editing ? editing.adopt : null} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    {confirm.confirmElement}
  </section>;
}

/** A whole number typed into a field, within bounds; null for empty, fractional, or out-of-range text (Wave 41 QA L2). */
export function wholeIn(text: string, min: number, max: number): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

function ServerDialog({ server, adopt, onCancel, onSaved }: { server: ToolServerSummary | null; adopt: DeclaredStdioServer | null; onCancel: () => void; onSaved: () => void }) {
  const stdio = server?.transport === "stdio" || adopt !== null;
  const [name, setName] = useState(server?.name ?? adopt?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [authKind, setAuthKind] = useState<ServerAuthKind>(server?.authKind ?? "none");
  const [authHeader, setAuthHeader] = useState(server?.authHeader ?? "");
  const [secret, setSecret] = useState("");
  const [removeSecret, setRemoveSecret] = useState(false);
  // Kept as typed (Wave 41 QA L2): a cleared field stays empty and is checked on save, never replaced while typing.
  const [timeoutS, setTimeoutS] = useState(String(Math.round((server?.timeoutMs ?? AGENT_BOUNDS.toolTimeoutMs.default) / 1000)));
  const [capKib, setCapKib] = useState(String(Math.round((server?.resultCapBytes ?? AGENT_BOUNDS.resultCapBytes.default) / 1024)));
  const [availability, setAvailability] = useState<ServerAvailability>(server?.availability ?? "admins");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), url: useId(), auth: useId(), header: useId(), secret: useId(), timeout: useId(), cap: useId(), availability: useId() };
  useHistoryDialogGuard(true, onCancel, { blocked: busy });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    if (!stdio && !url.trim()) return setError("Enter the server's URL.");
    const timeout = wholeIn(timeoutS, AGENT_BOUNDS.toolTimeoutMs.min / 1000, AGENT_BOUNDS.toolTimeoutMs.max / 1000);
    if (timeout === null) return setError(`Enter a tool timeout of ${AGENT_BOUNDS.toolTimeoutMs.min / 1000} to ${AGENT_BOUNDS.toolTimeoutMs.max / 1000} whole seconds.`);
    const cap = wholeIn(capKib, AGENT_BOUNDS.resultCapBytes.min / 1024, AGENT_BOUNDS.resultCapBytes.max / 1024);
    if (cap === null) return setError(`Enter a result cap of ${AGENT_BOUNDS.resultCapBytes.min / 1024} to ${AGENT_BOUNDS.resultCapBytes.max / 1024} whole KiB.`);
    setBusy(true);
    setError(null);
    const common = { name: name.trim(), authKind: stdio ? "none" as const : authKind, authHeader: authKind === "header" ? authHeader.trim() : null, timeoutMs: timeout * 1000, resultCapBytes: cap * 1024, availability };
    try {
      if (server) await updateServer(server.id, { ...common, ...(stdio ? {} : { url: url.trim() }), ...(secret.trim() ? { secret: secret.trim() } : {}), removeSecret, expectedRevision: server.revision });
      else await createServer({ ...common, ...(adopt ? { stdioId: adopt.id } : { url: url.trim() }), secret: secret.trim() || null });
      setSecret("");
      onSaved();
    } catch (reason) {
      setError(errorCode(reason) === "REVISION_MISMATCH" ? "This server changed elsewhere; close and reopen it." : messageOf(reason, "Could not save the tool server"));
      setBusy(false);
    }
  }
  return <ModalDialog title={server ? "Edit tool server" : adopt ? `Adopt ${adopt.name}` : "Add tool server"} eyebrow="AI" onClose={onCancel} busy={busy} variant="sheet" className="chat-dialog">
    <form className="file-dialog-form ai-provider-form" onSubmit={submit} noValidate>
      <label htmlFor={ids.name}>Name</label>
      <input id={ids.name} value={name} maxLength={AGENT_BOUNDS.serverName} autoFocus autoComplete="off" placeholder="GitHub tools" onChange={(event) => setName(event.target.value)} />
      {stdio ? <p className="file-dialog-hint">A stdio server declared by the host: <code>{server?.stdioId ?? adopt?.id}</code>. It runs as Nook's user with full trust (Nook's keys, database, and vault); Nook cannot sandbox it.</p> : <>
        <label htmlFor={ids.url}>URL</label>
        <input id={ids.url} value={url} maxLength={AGENT_BOUNDS.serverUrl} autoComplete="off" spellCheck={false} placeholder="https://tools.example.com/mcp" onChange={(event) => setUrl(event.target.value)} />
        <p className="file-dialog-hint">https only, Streamable HTTP. A private host must be listed in AGENT_ALLOWED_PRIVATE_HOSTS on the server; this Nook's own address is refused.</p>
        <span className="ai-label" id={ids.auth}>Authentication</span>
        <Select<ServerAuthKind> labelledBy={ids.auth} label="Authentication" value={authKind} onChange={setAuthKind} options={[{ value: "none", label: "None" }, { value: "bearer", label: "Bearer token", description: "Authorization: Bearer …" }, { value: "header", label: "Custom header", description: "Authorization or an X- header, and its value" }]} />
        {authKind === "header" && <>
          <label htmlFor={ids.header}>Header name</label>
          <input id={ids.header} value={authHeader} maxLength={64} autoComplete="off" spellCheck={false} placeholder="X-API-Key" onChange={(event) => setAuthHeader(event.target.value)} />
        </>}
        {authKind !== "none" && <>
          <label htmlFor={ids.secret}>Credential {server?.hasSecret && !removeSecret ? <small>({server.hint ? `saved: ${server.hint}` : "saved"}; leave empty to keep it)</small> : null}</label>
          <input id={ids.secret} type="password" value={secret} maxLength={4096} autoComplete="off" placeholder={server?.hasSecret ? "Keep the saved credential" : "The token or header value"} onChange={(event) => { setSecret(event.target.value); setRemoveSecret(false); }} />
          {server?.hasSecret && <label className="ai-check"><input type="checkbox" checked={removeSecret} onChange={(event) => setRemoveSecret(event.target.checked)} />Remove the saved credential</label>}
          <p className="file-dialog-hint">{SECRET_HONESTY} It is sent only to this server and never shown again.</p>
        </>}
      </>}
      <label htmlFor={ids.timeout}>Tool timeout (seconds, {AGENT_BOUNDS.toolTimeoutMs.min / 1000}–{AGENT_BOUNDS.toolTimeoutMs.max / 1000})</label>
      <input id={ids.timeout} type="number" min={AGENT_BOUNDS.toolTimeoutMs.min / 1000} max={AGENT_BOUNDS.toolTimeoutMs.max / 1000} value={timeoutS} onChange={(event) => setTimeoutS(event.target.value)} />
      <label htmlFor={ids.cap}>Result cap (KiB of text the model sees, {AGENT_BOUNDS.resultCapBytes.min / 1024}–{AGENT_BOUNDS.resultCapBytes.max / 1024})</label>
      <input id={ids.cap} type="number" min={AGENT_BOUNDS.resultCapBytes.min / 1024} max={AGENT_BOUNDS.resultCapBytes.max / 1024} value={capKib} onChange={(event) => setCapKib(event.target.value)} />
      <span className="ai-label" id={ids.availability}>Who may attach its tools</span>
      <Select<ServerAvailability> labelledBy={ids.availability} label="Who may attach its tools" value={availability} onChange={setAvailability} options={[{ value: "admins", label: AVAILABILITY_LABELS.admins }, { value: "all", label: AVAILABILITY_LABELS.all, description: "Members and viewers who can chat" }]} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : server ? "Save" : "Add tool server"}</button>
      </footer>
    </form>
  </ModalDialog>;
}
