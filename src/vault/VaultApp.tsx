import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ChevronLeft, Copy, Download, Eye, EyeOff, History, House, KeyRound, Lock, Pencil, Plus, RotateCcw, Search, Settings2, ShieldAlert, Sparkles, Trash2, TriangleAlert, Upload, UsersRound } from "lucide-react";
import { AccountActions, AppPageName, useBinCount } from "../AppShell";
import { readHistoryDepth } from "../appShellNavigation";
import { PHONE_QUERY, useMediaQuery } from "../calendar/hooks";
import { relativeTime } from "../files/format";
import { formatBytes } from "../files/filesApi";
import { popStateClosedDialog } from "../historyDialogs";
import { formatRoute, parseRoute, type Route } from "../router";
import { ReadOnlyBanner, useRole } from "../team/roleAccess";
import { Select } from "../ui/Select";
import { Combobox } from "../ui/Combobox";
import { useConfirm } from "../ui/useConfirm";
import { vaultBackAction, vaultRoute, type VaultRoute } from "../vaultRoute";
import { parseLoginValue, type EnvLevel } from "../../shared/vault";
import { canWriteEnv, CellDialog, errorCode, Masked, messageOf, NewSecretDialog, NewVaultDialog, RevealedText, SecretMetaDialog, TYPE_LABELS, ValueEditorDialog, VaultSettingsDialog } from "./VaultDialogs";
import { cellKey, copySecret, useRevealedValues, type Revealed } from "./reveal";
import { VaultAccessPage } from "./VaultAccessPage";
import { VaultActivityPage } from "./VaultActivityPage";
import { VersionHistoryDialog } from "./VaultHistory";
import { ReauthCancelled, useReauthProvider, useVaultReauth, VaultReauthContext } from "./VaultReauth";
import { ExportDialog, ImportDialog } from "./VaultTransfer";
import {
  clearValue, deleteSecret, getQuota, getSecret, listSecrets, listVaults, readValue, vaultStatus,
  type SecretDetail, type SecretSummary, type VaultEnvironment, type VaultStatus, type VaultSummary
} from "./vaultApi";
import "../files/files.css";
import "./vault.css";

type VaultNavigate = (route: Route, options?: { replace?: boolean; removed?: boolean }) => void;
type VaultAppProps = {
  displayName: string;
  role: string;
  navigate: VaultNavigate;
  flash: (message: string) => void;
  onHome: () => void;
  onBin?: () => void;
  onSettings: () => void;
  onSignOut: () => void;
};

const currentRoute = (): VaultRoute => {
  const route = parseRoute(window.location.pathname);
  return route.app === "vault" ? route : vaultRoute();
};

/** The words every vault screen shows (vault plan §0, D222): never "end-to-end" or "zero-knowledge". */
export const HONEST_LABEL = "Encrypted at rest; anyone with the server and its key can read every secret.";
const LEVEL_LABELS: Record<EnvLevel, string> = { none: "No access", read: "Read", write: "Write", admin: "Admin" };
const COPIED = "Copied. The clipboard is cleared after 30 seconds while Nook has focus; clipboard managers may keep a copy.";

type PageData = { vault: VaultSummary; secrets: SecretSummary[]; nextCursor: string | null };

/**
 * The Vault (Wave 25, vault plan §10): the list at /vault, one vault at /vault/:id (a secrets ×
 * environments grid on desktop; on phones one environment's cards, chosen with a Select and kept in
 * the URL as /vault/:id/env/:envId), and one secret at /vault/:id/secrets/:secretId. Each is a
 * history entry; sheets and dialogs push none, so Back closes them first (D18). Values are masked
 * until revealed, hide again after 30 seconds, and never enter the URL, the title, or a toast.
 */
export function VaultApp({ displayName, role, navigate, flash, onHome, onBin, onSettings, onSignOut }: VaultAppProps) {
  const binCount = useBinCount(Boolean(onBin));
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [route, setRoute] = useState<VaultRoute>(currentRoute);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const mainRef = useRef<HTMLElement>(null);
  const scrollMemory = useRef(new Map<string, number>());
  const pageCache = useRef(new Map<string, PageData>());
  const confirm = useConfirm();
  const reauthProvider = useReauthProvider();
  // "Show what they read" from the Access page: the person the Activity page starts filtered by.
  const [activityActor, setActivityActor] = useState<string | null>(null);
  const vaultNames = useRef(new Map<string, string>());

  const remember = useCallback(() => {
    if (mainRef.current) scrollMemory.current.set(formatRoute(currentRoute()), mainRef.current.scrollTop);
  }, []);
  const go = useCallback((next: VaultRoute, replace = false) => {
    remember();
    setRoute(next);
    navigateRef.current(next, { replace });
  }, [remember]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (popStateClosedDialog(event)) return;
      const next = parseRoute(window.location.pathname);
      if (next.app === "vault") setRoute(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const loadStatus = useCallback(() => {
    setStatusError(null);
    vaultStatus().then(setStatus, (reason) => setStatusError(messageOf(reason, "Could not reach the vault")));
  }, []);
  useEffect(loadStatus, [loadStatus]);

  const back = useCallback(() => {
    const action = vaultBackAction(currentRoute(), readHistoryDepth(window.history.state));
    if (action.kind === "history") {
      remember();
      window.history.back();
    } else if (action.kind === "replace") go(action.route, true);
    else onHome();
  }, [go, onHome, remember]);

  /** Pages call this once their content is on screen, so a return visit lands where it left off. */
  const restoreScroll = useCallback(() => {
    const top = scrollMemory.current.get(formatRoute(currentRoute())) ?? 0;
    if (mainRef.current) mainRef.current.scrollTop = top;
  }, []);

  const header = <header className="app-page-header">
    <button className="app-home-button" onClick={onHome}><House />Home</button>
    <span className="app-home-brand"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>Vault</strong></span></span><AppPageName name="Vault" />
    <AccountActions displayName={displayName} onSettings={onSettings} onSignOut={onSignOut} onBin={onBin} binCount={binCount} />
  </header>;

  let body: React.ReactNode;
  if (statusError) {
    body = <div className="vault-state" role="alert"><span className="vault-state-icon"><TriangleAlert /></span><h1>Could not open the vault</h1><p>{statusError}</p><button className="secondary-button" onClick={loadStatus}><RotateCcw />Try again</button></div>;
  } else if (!status) {
    body = <p className="vault-loading" role="status">Opening the vault…</p>;
  } else if (!status.enabled) {
    body = <NotConfigured status={status} admin={role === "admin"} />;
  } else if (!route.vaultId) {
    body = <VaultList key="list" onOpen={(vault) => go(vaultRoute(vault.id))} onReady={restoreScroll} flash={flash} />;
  } else if (route.page === "access") {
    body = <VaultAccessPage key={`access:${route.vaultId}`} vaultId={route.vaultId} onBack={back} onReady={restoreScroll} flash={flash} ask={confirm.ask}
      onMissing={() => { flash("That vault is not available"); go(vaultRoute(), true); }}
      onHandedOver={(stillReads) => { if (stillReads) back(); else go(vaultRoute(), true); }}
      onOpenActivity={(actorId) => { setActivityActor(actorId); go(vaultRoute(route.vaultId, { page: "activity" })); }} />;
  } else if (route.page === "activity") {
    body = <VaultActivityPage key={`activity:${route.vaultId}:${activityActor ?? ""}`} vaultId={route.vaultId} vaultName={vaultNames.current.get(route.vaultId) ?? pageCache.current.get(route.vaultId)?.vault.name ?? null}
      initialActor={activityActor} onBack={back} onReady={restoreScroll}
      onMissing={() => { flash("That vault is not available"); go(vaultRoute(), true); }} />;
  } else if (route.secretId) {
    body = <SecretPage key={`secret:${route.secretId}`} vaultId={route.vaultId} secretId={route.secretId} onBack={back} onReady={restoreScroll} flash={flash} ask={confirm.ask}
      onMissing={() => { flash("That secret is not available"); go(vaultRoute(route.vaultId), true); }}
      onDeleted={() => { pageCache.current.delete(route.vaultId!); const target = vaultRoute(route.vaultId); setRoute(target); navigateRef.current(target, { replace: true, removed: true }); }} />;
  } else {
    body = <VaultPage key={`vault:${route.vaultId}`} vaultId={route.vaultId} envId={route.envId} cache={pageCache} onBack={back} onReady={restoreScroll} flash={flash} ask={confirm.ask}
      onEnvironment={(envId) => go(vaultRoute(route.vaultId, { envId }), true)}
      onOpenSecret={(secretId) => go(vaultRoute(route.vaultId, { secretId }))}
      onOpenPage={(page, name) => { vaultNames.current.set(route.vaultId!, name); setActivityActor(null); go(vaultRoute(route.vaultId, { page })); }}
      onLeft={() => { pageCache.current.delete(route.vaultId!); const target = vaultRoute(); setRoute(target); navigateRef.current(target, { replace: true, removed: true }); }}
      onMissing={() => { flash("That vault is not available"); go(vaultRoute(), true); }}
      onDeleted={() => { pageCache.current.delete(route.vaultId!); const target = vaultRoute(); setRoute(target); navigateRef.current(target, { replace: true, removed: true }); flash("Moved the vault to the Bin"); }} />;
  }

  return <main ref={mainRef} className="app-page vault-app">
    {header}
    <ReadOnlyBanner />
    <VaultReauthContext.Provider value={reauthProvider.run}>
      <section className="vault-body">{body}</section>
      {reauthProvider.element}
    </VaultReauthContext.Provider>
    {confirm.confirmElement}
  </main>;
}

function NotConfigured({ status, admin }: { status: VaultStatus; admin: boolean }) {
  return <div className="vault-state" role="status">
    <span className="vault-state-icon"><KeyRound /></span>
    <h1>The vault is not configured on this server</h1>
    {admin && status.reason === "key_mismatch"
      ? <p>The server has a vault key, but it does not open the vaults stored here, so the vault stays off. Put back the key these vaults were created with, then check it on the host with <code>bun server/vault-admin.ts verify-key</code>.</p>
      : admin
        ? <p>Set <code>VAULT_ENCRYPTION_KEY</code> (make one with <code>openssl rand -base64 32</code>; it must differ from <code>TOTP_ENCRYPTION_KEY</code>) and restart Nook. Keep the key away from where backups are stored. The operations guide's Vault section explains more.</p>
        : <p>Ask an admin to set it up.</p>}
    <p className="vault-honest">{HONEST_LABEL}</p>
  </div>;
}

// ---------------------------------------------------------------------------------------------
// The list

function VaultList({ onOpen, onReady, flash }: { onOpen: (vault: VaultSummary) => void; onReady: () => void; flash: (message: string) => void }) {
  const { canWrite } = useRole();
  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [quota, setQuota] = useState<{ storedBytes: number; quotaBytes: number } | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setVaults((await listVaults()).vaults);
      getQuota().then(setQuota, () => setQuota(null));
    } catch (reason) {
      setError(messageOf(reason, "Could not load your vaults"));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { document.title = "Vault · Nook"; }, []);
  const ready = vaults !== null;
  useLayoutEffect(() => { if (ready) onReady(); }, [ready, onReady]);

  return <>
    <div className="vault-toolbar">
      <h1 className="vault-title">Vaults{vaults && <span className="vault-count"> · {vaults.length}</span>}</h1>
      {canWrite && <button type="button" className="primary-button vault-primary" onClick={() => setCreating(true)}><Plus />New vault</button>}
    </div>
    <p className="vault-honest"><ShieldAlert aria-hidden="true" />{HONEST_LABEL} Names and tags are not encrypted.</p>
    {error && <div className="vault-state" role="alert"><h2>Could not load your vaults</h2><p>{error}</p><button className="secondary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button></div>}
    {!error && !vaults && <p className="vault-loading" role="status">Loading…</p>}
    {!error && vaults && vaults.length === 0 && <div className="vault-state">
      <span className="vault-state-icon"><KeyRound /></span>
      <h2>No vaults yet</h2>
      <p>Keep a team's API keys, database URLs, and passwords per environment: dev, staging, and prod.</p>
      {canWrite && <button className="primary-button vault-primary" onClick={() => setCreating(true)}><Plus />New vault</button>}
    </div>}
    {vaults && vaults.length > 0 && ([["Your vaults", vaults.filter((vault) => vault.role === "owner")], ["Shared with me", vaults.filter((vault) => vault.role !== "owner")]] as const).map(([heading, list]) => list.length > 0 && <section key={heading} className="vault-list-section" aria-labelledby={`vault-list-${heading === "Your vaults" ? "own" : "shared"}`}>
      <h2 id={`vault-list-${heading === "Your vaults" ? "own" : "shared"}`} className="vault-list-heading">{heading}<span className="vault-count"> · {list.length}</span></h2>
      <ul className="vault-cards" aria-label={heading}>
        {list.map((vault) => <li key={vault.id}>
          <button type="button" className="vault-card" onClick={() => onOpen(vault)}>
            <span className="vault-card-name">{vault.name}</span>
            {vault.description && <span className="vault-card-description">{vault.description}</span>}
            <span className="vault-chips">{vault.environments.map((env) => <span key={env.id} className={`vault-chip level-${env.level}`}>{env.level === "none" && <Lock aria-hidden="true" />}{env.name}{env.protected && <ShieldAlert aria-label="protected" />}<span className="sr-only">: {LEVEL_LABELS[env.level]}</span></span>)}</span>
            <span className="vault-card-meta">{vault.role === "owner" ? "Owner" : `Member${vault.via === "group" ? " through a group" : ""}${vault.ownerName ? ` · from ${vault.ownerName}` : ""}`} · {vault.secretCount === 1 ? "1 secret" : `${vault.secretCount} secrets`} · updated <time dateTime={vault.updatedAt}>{relativeTime(vault.updatedAt)}</time></span>
          </button>
        </li>)}
      </ul>
    </section>)}
    {quota && vaults && vaults.some((vault) => vault.role === "owner") && <p className="vault-quota">Storage for vaults you created: {formatBytes(quota.storedBytes)} of {formatBytes(quota.quotaBytes)}</p>}
    {creating && <NewVaultDialog onCancel={() => setCreating(false)} onCreated={(vault) => { setCreating(false); flash(`Created ${vault.name}`); onOpen(vault); }} />}
  </>;
}

// ---------------------------------------------------------------------------------------------
// Shared value actions (reveal, copy, clear)

type Ask = ReturnType<typeof useConfirm>["ask"];

function useValueActions(vaultId: string, flash: (message: string) => void, reload: () => Promise<void>, ask: Ask) {
  const { revealed, show, hide, hideAll } = useRevealedValues();
  // Protected environments ask to confirm it's you first, then retry once (D226).
  const run = useVaultReauth();
  const reveal = useCallback(async (secret: SecretSummary, env: VaultEnvironment) => {
    try {
      const { value } = await run(() => readValue(vaultId, secret.id, env.id));
      show(cellKey(secret.id, env.id), { value: value.value, comment: value.comment, version: value.version });
    } catch (reason) {
      if (!(reason instanceof ReauthCancelled)) flash(messageOf(reason, "Could not reveal the value"));
    }
  }, [flash, run, show, vaultId]);
  const copy = useCallback(async (secret: SecretSummary, env: VaultEnvironment, known: Revealed | undefined) => {
    try {
      const text = known?.value ?? (await run(() => readValue(vaultId, secret.id, env.id))).value.value;
      await copySecret(secret.type === "login" ? parseLoginValue(text)?.password ?? text : text);
      flash(COPIED);
    } catch (reason) {
      if (!(reason instanceof ReauthCancelled)) flash(messageOf(reason, "Could not copy the value"));
    }
  }, [flash, run, vaultId]);
  const clear = useCallback(async (secret: SecretSummary, env: VaultEnvironment) => {
    const cell = secret.values[env.id];
    if (!cell || cell.status !== "set") return;
    if (!await ask({ title: `Clear ${secret.name} in ${env.name}?`, message: "The value is removed from this environment. Its earlier versions stay in history.", confirmLabel: "Clear value", danger: true })) return;
    try {
      await run(() => clearValue(vaultId, secret.id, env.id, cell.version ?? 0));
      hide(cellKey(secret.id, env.id));
      flash(`Cleared in ${env.name}`);
    } catch (reason) {
      if (!(reason instanceof ReauthCancelled)) flash(errorCode(reason) === "VALUE_CHANGED" ? "This value changed since the page loaded. Nothing was cleared; the page is up to date now." : messageOf(reason, "Could not clear the value"));
    }
    await reload();
  }, [ask, flash, hide, reload, run, vaultId]);
  return { revealed, reveal, hide, hideAll, copy, clear };
}

type ValueDialog = { kind: "cell" | "edit" | "history"; secretId: string; envId: string } | { kind: "newSecret" } | { kind: "settings" } | { kind: "import" } | { kind: "export" };

// ---------------------------------------------------------------------------------------------
// One vault: the grid (desktop) or one environment's cards (phone)

function VaultPage({ vaultId, envId, cache, onBack, onReady, flash, ask, onEnvironment, onOpenSecret, onOpenPage, onMissing, onDeleted, onLeft }: {
  vaultId: string; envId: string | null; cache: MutableRefObject<Map<string, PageData>>;
  onBack: () => void; onReady: () => void; flash: (message: string) => void; ask: Ask;
  onEnvironment: (envId: string) => void; onOpenSecret: (secretId: string) => void; onOpenPage: (page: "access" | "activity", vaultName: string) => void;
  onMissing: () => void; onDeleted: () => void; onLeft: () => void;
}) {
  const { canWrite } = useRole();
  const phone = useMediaQuery(PHONE_QUERY);
  const [data, setData] = useState<PageData | null>(() => cache.current.get(vaultId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The tag filter (§10 toolbar): one tag at a time, offered from the tags the vault's secrets carry.
  const [tag, setTag] = useState<string | null>(null);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [dialog, setDialog] = useState<ValueDialog | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(null);
    try {
      const page = await listSecrets(vaultId, { q: query.trim() || undefined, tag });
      if (current !== generation.current) return;
      setData(page);
      if (!query.trim() && !tag) {
        cache.current.set(vaultId, page);
        setKnownTags([...new Set(page.secrets.flatMap((secret) => secret.tags))].sort((a, b) => a.localeCompare(b)));
      }
    } catch (reason) {
      if (current !== generation.current) return;
      if (errorCode(reason) === "NOT_FOUND") onMissing();
      else setError(messageOf(reason, "Could not load this vault"));
    }
  }, [cache, onMissing, query, tag, vaultId]);
  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);
  const ready = data !== null;
  useLayoutEffect(() => { if (ready) onReady(); }, [ready, onReady]);
  useEffect(() => { if (data) document.title = `${data.vault.name} · Vault · Nook`; }, [data]);

  const actions = useValueActions(vaultId, flash, load, ask);
  const { hideAll } = actions;
  useEffect(() => hideAll, [hideAll]);

  const vault = data?.vault ?? null;
  const envs = vault?.environments ?? [];
  const phoneEnv = envs.find((env) => env.id === envId) ?? envs[0] ?? null;

  async function loadMore() {
    if (!data?.nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await listSecrets(vaultId, { q: query.trim() || undefined, tag, cursor: data.nextCursor });
      setData((current) => current ? { ...current, secrets: [...current.secrets, ...page.secrets.filter((item) => !current.secrets.some((known) => known.id === item.id))], nextCursor: page.nextCursor } : current);
    } catch (reason) {
      flash(messageOf(reason, "Could not load more secrets"));
    } finally {
      setLoadingMore(false);
    }
  }

  if (error) return <div className="vault-state" role="alert"><h1>Could not load this vault</h1><p>{error}</p><button className="secondary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button><button className="secondary-button" onClick={onBack}>All vaults</button></div>;
  if (!data || !vault) return <p className="vault-loading" role="status">Loading…</p>;

  const openDialog = dialog && (dialog.kind === "cell" || dialog.kind === "edit" || dialog.kind === "history") ? {
    secret: data.secrets.find((item) => item.id === dialog.secretId), env: envs.find((env) => env.id === dialog.envId)
  } : null;
  const canCreate = canWrite && envs.some(canWriteEnv);
  // Access for owners and environment admins; Import where you write; Export where you read.
  const canManageAccess = canWrite && (vault.role === "owner" || envs.some((env) => env.level === "admin"));
  const canExport = envs.some((env) => env.level !== "none");

  return <>
    <div className="vault-toolbar">
      <button type="button" className="icon-button vault-back" onClick={onBack} aria-label="All vaults" title="All vaults"><ChevronLeft /></button>
      <h1 className="vault-title" title={vault.name}>{vault.name}<span className="vault-count"> · {vault.secretCount}</span></h1>
      <button type="button" className="icon-button vault-settings-button" onClick={() => setDialog({ kind: "settings" })} aria-haspopup="dialog" aria-label="Vault settings" title="Vault settings"><Settings2 /></button>
      <div className="vault-controls">
        <label className="vault-search"><Search aria-hidden="true" /><span className="sr-only">Search names and tags</span>
          <input type="search" value={query} placeholder="Search names and tags" autoComplete="off" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {canCreate && <button type="button" className="primary-button vault-primary" onClick={() => setDialog({ kind: "newSecret" })}><Plus />New secret</button>}
      </div>
    </div>
    {vault.description && <p className="vault-description">{vault.description}</p>}
    <div className="vault-page-actions">
      {canManageAccess && <button type="button" className="secondary-button vault-inline-button" onClick={() => onOpenPage("access", vault.name)}><UsersRound />Access</button>}
      <button type="button" className="secondary-button vault-inline-button" onClick={() => onOpenPage("activity", vault.name)}><History />Activity</button>
      {canCreate && <button type="button" className="secondary-button vault-inline-button" aria-haspopup="dialog" onClick={() => setDialog({ kind: "import" })}><Upload />Import</button>}
      {canExport && <button type="button" className="secondary-button vault-inline-button" aria-haspopup="dialog" onClick={() => setDialog({ kind: "export" })}><Download />Export</button>}
      {(knownTags.length > 0 || tag) && <div className="vault-tag-filter">
        <Combobox<string> label="Filter by tag" placeholder="Filter by tag…" value={tag ? [tag] : []} onChange={(next) => setTag(next.at(-1) ?? null)}
          options={knownTags.map((item) => ({ value: item, label: item }))} emptyText="No tag matches" />
      </div>}
    </div>

    {phone && phoneEnv && <div className="vault-env-select">
      <Select label="Environment" value={phoneEnv.id} onChange={(next) => { if (next !== phoneEnv.id) onEnvironment(next); }} options={envs.map((env) => ({ value: env.id, label: env.name, description: `${env.slug} · ${LEVEL_LABELS[env.level]}` }))} />
    </div>}

    {data.secrets.length === 0 && <div className="vault-state">
      <span className="vault-state-icon"><KeyRound /></span>
      <h2>{query || tag ? "No secrets match" : "No secrets yet"}</h2>
      {!query && !tag && <p>Add a secret, then give it a value in each environment, or import a .env file.</p>}
      {canCreate && !query && !tag && <button className="primary-button vault-primary" onClick={() => setDialog({ kind: "newSecret" })}><Plus />New secret</button>}
    </div>}

    {data.secrets.length > 0 && !phone && <div className="vault-grid-scroll" role="region" aria-label={`${vault.name} secrets by environment`} tabIndex={0}>
      <table className="vault-grid">
        <thead><tr><th scope="col" className="vault-grid-name">Secret</th>{envs.map((env) => <th key={env.id} scope="col"><span>{env.name}{env.protected && <ShieldAlert className="vault-protected-mark" aria-label="protected" />}</span><small>{env.slug}{env.protected ? " · protected" : ""}</small></th>)}</tr></thead>
        <tbody>
          {data.secrets.map((secret) => <tr key={secret.id}>
            <th scope="row" className="vault-grid-name">
              <button type="button" className="vault-secret-link" onClick={() => onOpenSecret(secret.id)}>{secret.name}</button>
              <span className="vault-secret-meta">{TYPE_LABELS[secret.type]}{secret.hasComment ? " · comment" : ""}{secret.tags.map((tag) => <span key={tag} className="vault-tag">{tag}</span>)}</span>
            </th>
            {envs.map((env) => {
              const cell = secret.values[env.id];
              const label = cell?.status === "set" ? `${secret.name} in ${env.name}: set, version ${cell.version}` : cell?.status === "no-access" ? `${secret.name} in ${env.name}: no access` : `${secret.name} in ${env.name}: not set`;
              return <td key={env.id}>
                {cell?.status === "no-access"
                  ? <span className="vault-cell locked" aria-label={label}><Lock aria-hidden="true" /></span>
                  : <button type="button" className={`vault-cell ${cell?.status ?? "empty"}`} aria-label={label} aria-haspopup="dialog" onClick={() => setDialog({ kind: "cell", secretId: secret.id, envId: env.id })}>
                    {cell?.status === "set" ? <><Masked /><small>v{cell.version}</small></> : <span className="vault-not-set">Not set</span>}
                  </button>}
              </td>;
            })}
          </tr>)}
        </tbody>
      </table>
    </div>}

    {data.secrets.length > 0 && phone && phoneEnv && <ul className="vault-secret-cards" aria-label={`${vault.name} in ${phoneEnv.name}`}>
      {data.secrets.map((secret) => {
        const cell = secret.values[phoneEnv.id];
        const key = cellKey(secret.id, phoneEnv.id);
        const shown = actions.revealed[key];
        return <li key={secret.id} className="vault-secret-card">
          <button type="button" className="vault-secret-link" onClick={() => onOpenSecret(secret.id)}>
            <span className="vault-secret-name">{secret.name}</span>
            <span className="vault-secret-meta">{TYPE_LABELS[secret.type]}{secret.tags.map((tag) => <span key={tag} className="vault-tag">{tag}</span>)}</span>
          </button>
          <div className="vault-card-value">
            {cell?.status === "set" ? (shown ? <RevealedText type={secret.type} revealed={shown} /> : <Masked />) : <span className="vault-not-set">{cell?.status === "no-access" ? "No access" : "Not set"}</span>}
          </div>
          {cell?.status === "set" && <div className="vault-card-actions">
            {shown ? <button type="button" className="secondary-button" onClick={() => actions.hide(key)}><EyeOff />Hide</button>
              : <button type="button" className="secondary-button" onClick={() => { void actions.reveal(secret, phoneEnv); }} aria-label={`Reveal ${secret.name} in ${phoneEnv.name}`}><Eye />Reveal</button>}
            <button type="button" className="secondary-button" onClick={() => { void actions.copy(secret, phoneEnv, shown); }} aria-label={`Copy ${secret.name} in ${phoneEnv.name}`}><Copy />Copy</button>
          </div>}
        </li>;
      })}
    </ul>}
    {data.nextCursor && <button type="button" className="secondary-button vault-more" onClick={() => { void loadMore(); }} disabled={loadingMore}>{loadingMore ? "Loading…" : "Show more"}</button>}

    {openDialog?.secret && openDialog.env && dialog?.kind === "cell" && <CellDialog vault={vault} secret={openDialog.secret} env={openDialog.env} revealed={actions.revealed[cellKey(openDialog.secret.id, openDialog.env.id)] ?? null}
      onReveal={() => { void actions.reveal(openDialog.secret!, openDialog.env!); }}
      onHide={() => actions.hide(cellKey(openDialog.secret!.id, openDialog.env!.id))}
      onCopy={() => { void actions.copy(openDialog.secret!, openDialog.env!, actions.revealed[cellKey(openDialog.secret!.id, openDialog.env!.id)]); }}
      onEdit={() => setDialog({ kind: "edit", secretId: dialog.secretId, envId: dialog.envId })}
      onHistory={() => { actions.hide(cellKey(dialog.secretId, dialog.envId)); setDialog({ kind: "history", secretId: dialog.secretId, envId: dialog.envId }); }}
      onClear={() => { const { secret, env } = openDialog; setDialog(null); void actions.clear(secret!, env!); }}
      onOpenSecret={() => { setDialog(null); onOpenSecret(dialog.secretId); }}
      onClose={() => { actions.hide(cellKey(dialog.secretId, dialog.envId)); setDialog(null); }} />}
    {openDialog?.secret && openDialog.env && dialog?.kind === "edit" && <ValueEditorDialog vault={vault} secret={openDialog.secret} env={openDialog.env}
      onCancel={() => setDialog(null)}
      onSaved={(message) => { actions.hideAll(); setDialog(null); flash(message); void load(); }} />}
    {openDialog?.secret && openDialog.env && dialog?.kind === "history" && <VersionHistoryDialog vaultId={vault.id} secret={openDialog.secret} env={openDialog.env} ask={ask} flash={flash}
      onClose={() => setDialog(null)} onRestored={() => { void load(); }} />}
    {dialog?.kind === "import" && <ImportDialog vault={vault} initialEnvId={phone ? phoneEnv?.id ?? null : null} onClose={() => setDialog(null)}
      onImported={(message) => { setDialog(null); flash(message); void load(); }} />}
    {dialog?.kind === "export" && <ExportDialog vault={vault} initialEnvId={phone ? phoneEnv?.id ?? null : null} onClose={() => setDialog(null)} flash={flash} />}
    {dialog?.kind === "newSecret" && <NewSecretDialog vault={vault} initialEnvId={phone ? phoneEnv?.id ?? null : null} onCancel={() => setDialog(null)}
      onCreated={(secret) => { setDialog(null); flash(`Created ${secret.name}`); void load(); }} />}
    {dialog?.kind === "settings" && <VaultSettingsDialog vault={vault} ask={ask} flash={flash} onCancel={() => { setDialog(null); void load(); }}
      onChanged={(next) => setData((current) => current ? { ...current, vault: next } : current)}
      onDeleted={() => { setDialog(null); onDeleted(); }} onLeft={() => { setDialog(null); flash(`You left ${vault.name}`); onLeft(); }} />}
  </>;
}

// ---------------------------------------------------------------------------------------------
// One secret: its details and one card per environment

function SecretPage({ vaultId, secretId, onBack, onReady, flash, ask, onMissing, onDeleted }: {
  vaultId: string; secretId: string; onBack: () => void; onReady: () => void; flash: (message: string) => void; ask: Ask; onMissing: () => void; onDeleted: () => void;
}) {
  const { canWrite } = useRole();
  const [data, setData] = useState<{ vault: VaultSummary; secret: SecretDetail } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: "edit" | "history"; envId: string } | { kind: "meta" } | null>(null);
  const run = useVaultReauth();
  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await getSecret(vaultId, secretId));
    } catch (reason) {
      if (errorCode(reason) === "NOT_FOUND") onMissing();
      else setError(messageOf(reason, "Could not load this secret"));
    }
  }, [onMissing, secretId, vaultId]);
  useEffect(() => { void load(); }, [load]);
  const ready = data !== null;
  useLayoutEffect(() => { if (ready) onReady(); }, [ready, onReady]);
  useEffect(() => { if (data) document.title = `${data.vault.name} · Vault · Nook`; }, [data]);
  const actions = useValueActions(vaultId, flash, load, ask);
  const { hideAll } = actions;
  useEffect(() => hideAll, [hideAll]);
  // D216: editing or deleting a secret needs write wherever it has a value. The page knows the
  // environments it can see; the server checks the rest (and says so).
  const writable = useMemo(() => {
    if (!data) return false;
    const { environments } = data.vault;
    const withValues = environments.filter((env) => data.secret.values[env.id]?.status === "set" || data.secret.values[env.id]?.status === "no-access");
    return withValues.length > 0 ? withValues.every(canWriteEnv) : environments.some(canWriteEnv);
  }, [data]);

  if (error) return <div className="vault-state" role="alert"><h1>Could not load this secret</h1><p>{error}</p><button className="secondary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button><button className="secondary-button" onClick={onBack}>Back</button></div>;
  if (!data) return <p className="vault-loading" role="status">Loading…</p>;
  const { vault, secret } = data;
  const editEnv = dialog?.kind === "edit" ? vault.environments.find((env) => env.id === dialog.envId) : undefined;
  const historyEnv = dialog?.kind === "history" ? vault.environments.find((env) => env.id === dialog.envId) : undefined;

  async function remove() {
    if (!await ask({ title: `Delete ${secret.name}?`, message: `${secret.name} and its values in every environment move to the Bin for 30 days.`, confirmLabel: "Move to Bin", danger: true })) return;
    try {
      await run(() => deleteSecret(vaultId, secretId));
      flash(`Moved ${secret.name} to the Bin`);
      onDeleted();
    } catch (reason) {
      if (!(reason instanceof ReauthCancelled)) flash(messageOf(reason, "Could not delete the secret"));
    }
  }

  return <>
    <div className="vault-toolbar">
      <button type="button" className="icon-button vault-back" onClick={onBack} aria-label={`Back to ${vault.name}`} title={`Back to ${vault.name}`}><ChevronLeft /></button>
      <h1 className="vault-title vault-secret-title" title={secret.name}>{secret.name}</h1>
      {canWrite && writable && <div className="vault-controls">
        <button type="button" className="secondary-button vault-inline-button" onClick={() => setDialog({ kind: "meta" })}><Pencil />Edit details</button>
        <button type="button" className="danger-button vault-inline-button" onClick={() => { void remove(); }}><Trash2 />Delete</button>
      </div>}
    </div>
    <div className="vault-secret-summary">
      <p className="vault-secret-meta">{vault.name} · {TYPE_LABELS[secret.type]}{secret.tags.map((tag) => <span key={tag} className="vault-tag">{tag}</span>)}</p>
      {secret.comment && <p className="vault-secret-comment">{secret.comment}</p>}
    </div>
    <ul className="vault-env-cards" aria-label={`${secret.name} by environment`}>
      {vault.environments.map((env) => {
        const cell = secret.values[env.id];
        const key = cellKey(secret.id, env.id);
        const shown = actions.revealed[key];
        const set = cell?.status === "set";
        return <li key={env.id} className="vault-env-card">
          <header><strong>{env.name}{env.protected && <ShieldAlert className="vault-protected-mark" aria-label="protected" />}</strong><small>{env.slug} · {LEVEL_LABELS[env.level]}</small></header>
          <div className="vault-card-value">
            {cell?.status === "no-access" ? <span className="vault-not-set"><Lock aria-hidden="true" />No access</span>
              : set ? (shown ? <RevealedText type={secret.type} revealed={shown} /> : <Masked />) : <span className="vault-not-set">Not set</span>}
          </div>
          {shown?.comment && <p className="vault-value-comment">{shown.comment}</p>}
          {set && <p className="vault-card-meta">Version {cell.version}{cell.updatedAt ? <> · <time dateTime={cell.updatedAt}>{relativeTime(cell.updatedAt)}</time></> : null}{cell.updatedBy ? ` · ${cell.updatedBy}` : ""}</p>}
          <div className="vault-card-actions">
            {set && (shown ? <button type="button" className="secondary-button" onClick={() => actions.hide(key)}><EyeOff />Hide</button>
              : <button type="button" className="secondary-button" onClick={() => { void actions.reveal(secret, env); }} aria-label={`Reveal ${secret.name} in ${env.name}`}><Eye />Reveal</button>)}
            {set && <button type="button" className="secondary-button" onClick={() => { void actions.copy(secret, env, shown); }} aria-label={`Copy ${secret.name} in ${env.name}`}><Copy />Copy</button>}
            {canWrite && canWriteEnv(env) && <button type="button" className="secondary-button" onClick={() => setDialog({ kind: "edit", envId: env.id })} aria-label={`${set ? "Edit" : "Set"} ${secret.name} in ${env.name}`}><Pencil />{set ? "Edit" : "Set value"}</button>}
            {canWrite && set && canWriteEnv(env) && <button type="button" className="danger-button" onClick={() => { void actions.clear(secret, env); }} aria-label={`Clear ${secret.name} in ${env.name}`}><Trash2 />Clear</button>}
            {cell && cell.status !== "no-access" && (cell.version ?? 0) > 0 && <button type="button" className="secondary-button" aria-haspopup="dialog" onClick={() => { actions.hide(key); setDialog({ kind: "history", envId: env.id }); }} aria-label={`History of ${secret.name} in ${env.name}`}><History />History</button>}
          </div>
        </li>;
      })}
    </ul>
    <p className="vault-honest"><ShieldAlert aria-hidden="true" />{HONEST_LABEL}</p>
    {editEnv && <ValueEditorDialog vault={vault} secret={secret} env={editEnv} onCancel={() => setDialog(null)}
      onSaved={(message) => { actions.hideAll(); setDialog(null); flash(message); void load(); }} />}
    {historyEnv && <VersionHistoryDialog vaultId={vaultId} secret={secret} env={historyEnv} ask={ask} flash={flash} onClose={() => setDialog(null)} onRestored={() => { void load(); }} />}
    {dialog?.kind === "meta" && <SecretMetaDialog vault={vault} secret={secret} onCancel={() => setDialog(null)}
      onSaved={(next) => { setDialog(null); setData((current) => current ? { ...current, secret: next } : current); flash("Saved"); }} />}
  </>;
}
