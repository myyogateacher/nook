import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Bot,
  ArrowUpDown,
  Bell,
  Check,
  Copy,
  ChevronLeft,
  House,
  ChevronRight,
  Clock3,
  Eye,
  EyeOff,
  FileDown,
  FilePlus2,
  Folder as FolderIcon,
  FolderPlus,
  History,
  Info,
  KeyRound,
  LayoutGrid,
  Lock,
  LogOut,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  ShieldCheck,
  Share2,
  Smartphone,
  Sparkles,
  Trash2,
  Users,
  X
} from "lucide-react";
import QRCode from "qrcode";
import { api, ApiError, setCsrfToken } from "./api";
import { TodayHome } from "./today/TodayHome";
import { BinApp } from "./bin/BinApp";
import { InboxApp } from "./inbox/InboxApp";
import { lineDiff } from "./diff/lineDiff";
import { TeamApp } from "./team/TeamApp";
import { InviteRegister, InviteWhileSignedIn, type InviteRegisterBody } from "./auth/InviteRegister";
import { initialInvite } from "./auth/inviteLink";
import { registrationPrompt, type RegistrationInfo } from "./auth/registrationPrompt";
import { initialMailLink, UnsubscribePage, VerifyEmailPage } from "./auth/mailPages";
import { FORGOT_PATH, ForgotPasswordPage, initialPasswordLink, ResetPasswordPage, takePasswordLinkFromLocation } from "./auth/passwordPages";
import { ChangePasswordCard } from "./auth/ChangePassword";
import { InboxNavContext, SidebarInboxRow, TeamNavContext } from "./AppShell";
import { canManageTeam, canWriteContent, type Role } from "./team/teamRoles";
import { ReadOnlyBanner, RoleContext, ShareRoleHint } from "./team/roleAccess";
import { FilesApp } from "./files/FilesApp";
import { TasksApp } from "./tasks/TasksApp";
import { CollectionsApp } from "./collections/CollectionsApp";
import { carriedCollectionsState } from "./collectionsRoute";
import { carriedTasksState } from "./tasksNavigation";
import { CalendarApp } from "./calendar/CalendarApp";
import { NotificationsApp } from "./notifications/NotificationsApp";
import { centerActiveTab } from "./ui/tabStrip";
import { publishedElsewhere, usePublishWatch } from "./editor/publishWatch";
import { NotificationsContext } from "./notifications/notificationsApi";
import { NotificationSettings } from "./notifications/NotificationSettings";
import { forgetThisDevice } from "./notifications/pushClient";
import { carriedCalendarState } from "./calendarNavigation";
import { calendarHomeRoute, localDate } from "./calendarRoute";
import { dialogPopDirection, popStateClosedDialog, takeDialogSentinelEntry, undoDialogPop } from "./historyDialogs";
import { createFilesHistoryState, readFilesHistorySnapshot, sameFilesSnapshot, type FilesPanel } from "./filesNavigation";
import { resolveFilesPanel } from "./filesRoute";
import { NoteEditor } from "./editor/NoteEditor";
import { createHistoryState, isMobileViewport, readHistorySnapshot, sameSnapshot, type FolderSelection, type MobileNavigationSnapshot, type MobilePanel } from "./mobileNavigation";
import { createAppHistoryState, readHistoryDepth, resolveAppHistorySection, startupRouteState, withHistoryDepth, type AppSection } from "./appShellNavigation";
// Settings → API keys (Wave 31) replaced the MCP server section; the section id stays "mcp".
import { KeysSettings } from "./keys/KeysSettings";
import { ConfirmDialog } from "./files/Dialog";
import { useHistoryDialogGuard } from "./ui/useHistoryDialogGuard";
import { notifyBinChanged } from "./bin/binApi";
import { canPublish, DRAFT_CHANGED_MESSAGE, finalizeOpenNote, isDraftChangedError, mcpDraftBadge, shouldAutoPublish } from "./noteFinalization";
import { formatRoute, locationUrl, parseRoute, parseSettingsPath, routeFromLocation, settingsPath, settingsTitleScope, type Route, type SettingsSection } from "./router";
import { noteInFolder, notesRoute, resolveNotesPanel, resolveNotesRoute, type NotesRoute } from "./notesRoute";
import type { Folder, NoteDetail, NoteSummary, User, Version } from "./types";
import { SearchResults, searchListId, searchOptionId } from "./search/SearchResults";
import { nextSearchHint, readSearchHint, sameSearchHint, withSearchHint, type SearchHint } from "./search/searchHistory";
import { SEARCH_MAX_CHARS, type NoteSearchHit } from "./search/searchApi";
import { useNoteSearch } from "./search/useNoteSearch";
import { ModulesSettings } from "./ModulesSettings";
import { hiddenEntryStep, hiddenModuleForApp, openTeamViaSettings, recordPopDepth, isAppEnabled, isModuleEnabled, moduleOffHint, ModulesContext, parsePreferences, type ModuleId } from "./modules";
import { usePreferences, type PreferencesStatus } from "./usePreferences";

type TotpState = { enabled: boolean; required: boolean; setupRequired: boolean };
// `preferences` comes with /api/auth/me only (not with sign-in); see usePreferences.
type SessionResponse = { user: User; csrfToken: string; totp: TotpState; preferences?: unknown };
type ModulesSettingsProps = { disabledModules: readonly ModuleId[]; status: PreferencesStatus; onToggle: (id: ModuleId, enabled: boolean) => void; role?: Role };
type NoteSort = "updated-desc" | "updated-asc" | "created-desc" | "created-asc" | "title-asc" | "title-desc";

const noteSortOptions: Array<{ value: NoteSort; label: string }> = [
  { value: "updated-desc", label: "Recently edited" },
  { value: "updated-asc", label: "Oldest edited" },
  { value: "created-desc", label: "Recently added" },
  { value: "created-asc", label: "Oldest added" },
  { value: "title-asc", label: "Title A–Z" },
  { value: "title-desc", label: "Title Z–A" }
];

function relativeTime(value: string) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function AuthScreen({ onAuthenticated, onForgotPassword }: { onAuthenticated: (session: SessionResponse) => void; onForgotPassword: () => void }) {
  const [registering, setRegistering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [registration, setRegistration] = useState<RegistrationInfo | null>(null);
  const signUpPrompt = registrationPrompt(registration);

  useEffect(() => {
    let live = true;
    api<RegistrationInfo>("/about").then((info) => { if (live) setRegistration(info); }, () => undefined);
    return () => { live = false; };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const payload = registering
        ? { email: form.get("email"), password: form.get("password"), displayName: form.get("displayName") }
        : {
          email: form.get("email"),
          password: form.get("password"),
          ...(needsTotp ? useRecoveryCode ? { recoveryCode: form.get("recoveryCode") } : { totpCode: form.get("totpCode") } : {})
        };
      const session = await api<SessionResponse>(registering ? "/auth/register" : "/auth/login", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      setCsrfToken(session.csrfToken);
      onAuthenticated(session);
    } catch (reason) {
      if (!registering && reason instanceof ApiError && (reason.payload as { requiresTotp?: boolean } | undefined)?.requiresTotp) {
        setNeedsTotp(true);
      }
      // Only sent after the right password (T85); the reason for the block is never shown (O11).
      if (!registering && reason instanceof ApiError && (reason.payload as { code?: string } | undefined)?.code === "ACCOUNT_BLOCKED") {
        setNeedsTotp(false);
        setError("This account has been blocked. Contact your Nook administrator.");
        return;
      }
      setError(reason instanceof Error ? reason.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="brand-mark"><Sparkles aria-hidden="true" /></div>
        <div className="auth-heading">
          <span className="eyebrow">Nook</span>
          <h1>{registering ? "Create your account" : "Welcome back"}</h1>
          <p>Your private workspace for ideas, passwords, and configuration notes.</p>
        </div>
        <form onSubmit={submit} className="auth-form">
          {registering && <label>Name<input name="displayName" autoComplete="name" required maxLength={80} /></label>}
          <label>Email<input name="email" type="email" autoComplete="email" required /></label>
          <div className="auth-password-group">
            <label htmlFor="auth-password">Password</label>
            <span className="password-field">
              <input id="auth-password" name="password" type={passwordVisible ? "text" : "password"} autoComplete={registering ? "new-password" : "current-password"} required minLength={registering ? 12 : 1} />
              <button
                type="button"
                className="password-visibility-toggle"
                aria-label={passwordVisible ? "Hide password" : "Show password"}
                aria-pressed={passwordVisible}
                onClick={() => setPasswordVisible((visible) => !visible)}
              >
                {passwordVisible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </span>
          </div>
          {!registering && needsTotp && (useRecoveryCode
            ? <label>Recovery code<input name="recoveryCode" autoComplete="one-time-code" placeholder="ABCDE-FGHIJ-KLMNO" minLength={10} maxLength={32} required autoFocus /><small>Enter one complete backup recovery code. Each code works once.</small></label>
            : <label>Six-digit authentication code<input name="totpCode" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="000000" required autoFocus /><small>Enter the current six-digit number shown in Google Authenticator—not the grouped setup key.</small></label>)}
          {!registering && needsTotp && <button type="button" className="inline-auth-switch" onClick={() => { setUseRecoveryCode((value) => !value); setError(""); }}>{useRecoveryCode ? "Use Google Authenticator instead" : "Use a recovery code"}</button>}
          {!registering && <a className="inline-auth-switch forgot-password-link" href={FORGOT_PATH} onClick={(event) => { event.preventDefault(); onForgotPassword(); }}>Forgot password?</a>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button" disabled={busy}>{busy ? "Please wait…" : registering ? "Create account" : "Sign in"}</button>
        </form>
        {(registering || signUpPrompt) && <button className="text-button" onClick={() => { setRegistering(!registering); setNeedsTotp(false); setUseRecoveryCode(false); setPasswordVisible(false); setError(""); }}>
          {registering ? "Already have an account? Sign in" : signUpPrompt}
        </button>}
        <p className="security-note"><Lock /> Your notes stay on this machine.</p>
      </section>
    </main>
  );
}

function SettingsDialog({ session, onClose, onSecurityChanged, onManageTeam, modules, initialSection = "security", onSectionChange, pendingRef }: { session: SessionResponse; onClose: () => void; onSecurityChanged: (state: TotpState) => void; onManageTeam: () => void; modules: ModulesSettingsProps; initialSection?: SettingsSection; onSectionChange?: (section: SettingsSection) => void; pendingRef?: React.MutableRefObject<boolean> }) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [appInfo, setAppInfo] = useState({ version: "0.12.0", gitSha: "development" });
  const [state, setState] = useState<TotpState>(session.totp);
  const [secret, setSecret] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [mcpKeyPending, setMcpKeyPending] = useState(false);
  const [nestedDialogOpen, setNestedDialogOpen] = useState(false);

  const guardedClose = useCallback(() => {
    if (mcpKeyPending && !window.confirm("This API key is shown only once. Close settings without saving it?")) return;
    onClose();
  }, [mcpKeyPending, onClose]);

  function selectSection(next: SettingsSection) {
    if (next !== "mcp" && mcpKeyPending && !window.confirm("This API key is shown only once. Leave this section without saving it?")) return;
    setSection(next);
    onSectionChange?.(next);
  }
  // The app asks before Back leaves Settings while a new key is still on screen.
  useEffect(() => { if (pendingRef) pendingRef.current = mcpKeyPending; }, [mcpKeyPending, pendingRef]);

  // "Settings · Notifications · Nook" while open; the title from before comes back on close.
  const titleScope = useRef<ReturnType<typeof settingsTitleScope> | null>(null);
  useEffect(() => {
    const scope = settingsTitleScope(document);
    titleScope.current = scope;
    return () => { titleScope.current = null; scope.restore(); };
  }, []);
  useEffect(() => { titleScope.current?.show(section); }, [section]);
  // Phones scroll the section strip sideways: keep the active tab in view on a deep link and on change (3c).
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => { centerActiveTab(navRef.current); }, [section]);

  useEffect(() => {
    api<TotpState>("/auth/totp/status").then(setState).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load security settings"));
    api<{ version: string; gitSha: string }>("/about").then(setAppInfo).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (state.setupRequired || nestedDialogOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") guardedClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [guardedClose, state.setupRequired, nestedDialogOpen]);

  useEffect(() => { if (state.setupRequired) setSection("security"); }, [state.setupRequired]);
  // Wave 28: Settings is a history entry of its own (/settings/:section), so Back closes it and
  // Forward reopens it; the app's popstate handler does both (no dialog guard here).

  async function beginSetup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const form = new FormData(event.currentTarget);
      const setup = await api<{ secret: string; uri: string }>("/auth/totp/setup", { method: "POST", body: JSON.stringify({ password: form.get("password") }) });
      setSecret(setup.secret);
      setQrCode(await QRCode.toDataURL(setup.uri, { width: 220, margin: 2, color: { dark: "#151515", light: "#ffffff" } }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start two-factor setup");
    } finally {
      setBusy(false);
    }
  }

  async function enable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const form = new FormData(event.currentTarget);
      const next = await api<TotpState & { recoveryCodes: string[] }>("/auth/totp/enable", { method: "POST", body: JSON.stringify({ code: form.get("code") }) });
      setSecret("");
      setQrCode("");
      setRecoveryCodes(next.recoveryCodes);
      setState(next);
      onSecurityChanged(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not enable two-factor authentication");
    } finally {
      setBusy(false);
    }
  }

  async function disable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.confirm("Disable two-factor authentication for this account?")) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData(event.currentTarget);
      const next = await api<TotpState>("/auth/totp", { method: "DELETE", body: JSON.stringify({ password: form.get("password"), code: form.get("code") }) });
      setState(next);
      onSecurityChanged(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not disable two-factor authentication");
    } finally {
      setBusy(false);
    }
  }

  async function copySecret() {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function revealRecoveryCodes(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const form = new FormData(event.currentTarget);
      const result = await api<{ recoveryCodes: string[] }>("/auth/totp/recovery-codes", { method: "POST", body: JSON.stringify({ password: form.get("password"), code: form.get("code") }) });
      setRecoveryCodes(result.recoveryCodes);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not reveal recovery codes");
    } finally {
      setBusy(false);
    }
  }

  async function regenerateRecoveryCodes(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (recoveryCodes.length && !window.confirm("Generate new recovery codes? Every previous recovery code will stop working.")) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData(event.currentTarget);
      const result = await api<{ recoveryCodes: string[] }>("/auth/totp/recovery-codes/regenerate", { method: "POST", body: JSON.stringify({ password: form.get("password"), code: form.get("code") }) });
      setRecoveryCodes(result.recoveryCodes);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not generate recovery codes");
    } finally {
      setBusy(false);
    }
  }

  async function copyRecoveryCodes() {
    await navigator.clipboard.writeText(recoveryCodes.join("\n"));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <section id="account-settings-dialog" className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="settings-header">
        <div><span className="eyebrow">Account</span><h2 id="settings-title">Settings</h2></div>
        {!state.setupRequired && <button className="icon-button" onClick={guardedClose} aria-label="Close settings"><X /></button>}
      </header>
      <div className="settings-body">
        <nav ref={navRef} className="settings-nav" aria-label="Settings sections"><button className={section === "security" ? "active" : ""} aria-current={section === "security" ? "page" : undefined} onClick={() => selectSection("security")}><ShieldCheck />Security</button>{!state.setupRequired && <><button className={section === "modules" ? "active" : ""} aria-current={section === "modules" ? "page" : undefined} onClick={() => selectSection("modules")}><LayoutGrid />Modules</button><button className={section === "mcp" ? "active" : ""} aria-current={section === "mcp" ? "page" : undefined} onClick={() => selectSection("mcp")}><KeyRound />API keys</button><button className={section === "notifications" ? "active" : ""} aria-current={section === "notifications" ? "page" : undefined} onClick={() => selectSection("notifications")}><Bell />Notifications</button><button className={section === "about" ? "active" : ""} aria-current={section === "about" ? "page" : undefined} onClick={() => selectSection("about")}><Info />About</button>{canManageTeam(session.user.role) && <button className="settings-nav-link" onClick={() => { if (!mcpKeyPending || window.confirm("This API key is shown only once. Leave settings without saving it?")) onManageTeam(); }}><Users />Manage team</button>}</>}</nav>
        {section === "security" ? <section className="settings-content" aria-labelledby="security-heading">
          {!state.setupRequired && <ChangePasswordCard totpEnabled={state.enabled} />}
          <div className="settings-section-heading"><span className="settings-icon"><Smartphone /></span><div><h3 id="security-heading">Two-factor authentication</h3><p>Protect your account with a six-digit code from Google Authenticator or another TOTP app.</p></div></div>
          {state.setupRequired && <div className="settings-warning"><Lock />Two-factor authentication is required before you can use your notes.</div>}
          {error && <p className="form-error" role="alert">{error}</p>}
          {state.enabled ? <div className="security-card enabled-card">
            <div className="security-status"><span><Check /></span><div><strong>Authenticator enabled</strong><small>Your account requires your password and an authentication code at sign in.</small></div></div>
            {recoveryCodes.length ? <div className="recovery-codes"><div><h4>Recovery codes</h4><p>Save each complete grouped code somewhere safe. A whole recovery code replaces the six-digit Authenticator number once.</p></div><div className="recovery-code-grid">{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div><button className="secondary-button" onClick={copyRecoveryCodes}>{copied ? "Copied" : "Copy all codes"}</button></div> : <form className="view-recovery-form" onSubmit={revealRecoveryCodes}><h4>View recovery codes</h4><p>Re-enter your password and a fresh, unused six-digit Authenticator code to reveal the remaining backup codes.</p><div><input name="password" type="password" autoComplete="current-password" placeholder="Password" required /><input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="6-digit code" required /><button className="secondary-button" disabled={busy}>View codes</button></div></form>}
            <details className="regenerate-recovery"><summary>{recoveryCodes.length ? "Replace recovery codes" : "No codes available? Generate recovery codes"}</summary><form onSubmit={regenerateRecoveryCodes}><p>This invalidates every previous recovery code. Confirm with your password and a fresh six-digit Authenticator code.</p><div><input name="password" type="password" autoComplete="current-password" placeholder="Password" required /><input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="6-digit code" required /><button className="secondary-button" disabled={busy}>Generate new codes</button></div></form></details>
            {state.required ? <p className="policy-copy">This service requires two-factor authentication, so it cannot be disabled.</p> : <form className="disable-totp-form" onSubmit={disable}>
              <h4>Disable authenticator</h4><p>Confirm your password and a current code.</p>
              <div><input name="password" type="password" autoComplete="current-password" placeholder="Password" required /><input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="6-digit code" required /><button className="secondary-button" disabled={busy}>Disable</button></div>
            </form>}
          </div> : !secret ? <form className="security-card setup-intro" onSubmit={beginSetup}>
            <strong>Authenticator not configured</strong>
            <p>Use Google Authenticator to scan a QR code, then verify one code to finish setup.</p>
            <label>Confirm your password<input name="password" type="password" autoComplete="current-password" required /></label>
            <button className="primary-button" disabled={busy}>{busy ? "Preparing…" : "Set up authenticator"}</button>
          </form> : <div className="security-card enrollment-card">
            <div className="enrollment-grid">
              <div className="qr-frame"><img src={qrCode} alt="QR code for Nook two-factor authentication" /></div>
              <div><span className="step-label">1 · Scan the code</span><h4>Add Nook to Google Authenticator</h4><p>If you cannot scan it, enter the entire setup key manually in Google Authenticator. The groups of four are only for readability; copying removes all spaces. This key is not entered when signing in.</p><button className="secret-copy" onClick={copySecret}><code>{secret.match(/.{1,4}/g)?.join(" ")}</code><span>{copied ? <><Check />Copied</> : "Copy setup key without spaces"}</span></button></div>
            </div>
            <form className="verify-totp-form" onSubmit={enable}><span className="step-label">2 · Verify setup</span><label>Authentication code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="000000" required autoFocus /></label><button className="primary-button" disabled={busy}>{busy ? "Verifying…" : "Enable two-factor authentication"}</button></form>
          </div>}
        </section> : section === "modules" ? <ModulesSettings {...modules} /> : section === "mcp" ? <KeysSettings onPendingChange={setMcpKeyPending} onNestedDialogChange={setNestedDialogOpen} totpEnabled={state.enabled} role={session.user.role} /> : section === "notifications" ? <NotificationSettings /> : <section className="settings-content about-settings" aria-labelledby="about-heading"><div className="settings-section-heading"><span className="settings-icon"><Info /></span><div><h3 id="about-heading">About Nook</h3><p>A private, self-hosted workspace for notes, files, and ideas.</p></div></div><div className="about-card"><div className="brand-mark"><Sparkles /></div><div><h4>Nook</h4><p>Built by Pankaj</p></div><dl><div><dt>Version</dt><dd>{appInfo.version}</dd></div><div><dt>Git SHA</dt><dd><code>{appInfo.gitSha}</code></dd></div></dl><a href="https://github.com/pankajsoni19" target="_blank" rel="noopener noreferrer">github.com/pankajsoni19</a></div></section>}
      </div>
    </section>
  );
}

function HistoryPanel({ note, canRestore = true, onClose, onRestored }: { note: NoteDetail; canRestore?: boolean; onClose: () => void; onRestored: () => void }) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [currentContent, setCurrentContent] = useState("");
  const [previousContent, setPreviousContent] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ versions: Version[] }>(`/notes/${note.id}/versions`).then(({ versions: items }) => {
      setVersions(items);
      setSelected(items[0]?.version_number ?? null);
    });
  }, [note.id]);

  useEffect(() => {
    if (selected === null) return;
    const index = versions.findIndex((version) => version.version_number === selected);
    Promise.all([
      api<{ markdown: string }>(`/notes/${note.id}/versions/${selected}`),
      index >= 0 && versions[index + 1]
        ? api<{ markdown: string }>(`/notes/${note.id}/versions/${versions[index + 1].version_number}`)
        : Promise.resolve({ markdown: "" })
    ]).then(([current, previous]) => {
      setCurrentContent(current.markdown);
      setPreviousContent(previous.markdown);
    });
  }, [note.id, selected, versions]);

  const diff = useMemo(() => lineDiff(previousContent, currentContent), [previousContent, currentContent]);

  async function restore() {
    if (selected === null) return;
    setBusy(true);
    await api(`/notes/${note.id}/versions/${selected}/restore`, { method: "POST", body: "{}" });
    setBusy(false);
    onRestored();
  }

  return (
    <aside className="side-panel history-panel">
      <header><div><span className="eyebrow">Timeline</span><h2>Version history</h2></div><button className="icon-button" onClick={onClose} aria-label="Close history"><X /></button></header>
      <div className="version-list">
        {versions.map((version) => (
          <button key={version.id} className={selected === version.version_number ? "selected" : ""} onClick={() => setSelected(version.version_number)}>
            <span>Version {version.version_number}</span>
            <small>{version.author_name} · {relativeTime(version.created_at)}</small>
          </button>
        ))}
        {!versions.length && <p className="empty-copy">Publish a draft to create the first version.</p>}
      </div>
      {selected !== null && <>
        <div className="diff-heading"><span>Changes in v{selected}</span><span><i className="diff-add" /> Added <i className="diff-remove" /> Removed</span></div>
        <pre className="diff-view">{diff.map((line, index) => <span key={`${index}-${line.kind}`} className={line.kind}>{line.kind === "add" ? "+ " : line.kind === "remove" ? "− " : "  "}{line.text || " "}</span>)}</pre>
        {note.isOwner && canRestore && <button className="secondary-button restore-button" disabled={busy} onClick={restore}>Restore as draft</button>}
      </>}
    </aside>
  );
}

function SharePanel({ note, onClose, onChanged }: { note: NoteDetail; onClose: () => void; onChanged: () => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [visibility, setVisibility] = useState<"inherit" | "private" | "selected" | "all_users">("inherit");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    Promise.all([
      api<{ users: User[] }>("/users"),
      api<{ visibility: typeof visibility; users: Array<{ id: string }> }>(`/notes/${note.id}/sharing`)
    ]).then(([allUsers, sharing]) => {
      setUsers(allUsers.users);
      setVisibility(sharing.visibility);
      setSelected(sharing.users.map((user) => user.id));
      setBusy(false);
    });
  }, [note.id]);

  async function save() {
    setBusy(true);
    await api(`/notes/${note.id}/sharing`, { method: "PUT", body: JSON.stringify({ visibility, userIds: visibility === "selected" ? selected : [] }) });
    setBusy(false);
    onChanged();
  }

  return (
    <aside className="side-panel share-panel">
      <header><div><span className="eyebrow">Access</span><h2>Share note</h2></div><button className="icon-button" onClick={onClose} aria-label="Close sharing"><X /></button></header>
      <div className="share-options">
        <label><input type="radio" checked={visibility === "inherit"} onChange={() => setVisibility("inherit")} /><span><FolderIcon />Use folder access<small>Inherit this note’s folder sharing</small></span></label>
        <label><input type="radio" checked={visibility === "private"} onChange={() => setVisibility("private")} /><span><Lock />Private<small>Only you can open this note</small></span></label>
        <label><input type="radio" checked={visibility === "selected"} onChange={() => setVisibility("selected")} /><span><Users />Selected people<small>Choose registered users below</small></span></label>
        <label><input type="radio" checked={visibility === "all_users"} onChange={() => setVisibility("all_users")} /><span><Share2 />Everyone here<small>Everyone signed in except guests; never public</small></span></label>
      </div>
      {visibility === "selected" && <div className="user-picker">
        {users.map((user) => <label key={user.id}><input type="checkbox" checked={selected.includes(user.id)} onChange={() => setSelected((items) => items.includes(user.id) ? items.filter((id) => id !== user.id) : [...items, user.id])} /><span>{user.displayName}<ShareRoleHint role={user.role} />{user.email && <small>{user.email}</small>}</span></label>)}
        {!users.length && <p className="empty-copy">Create another account before sharing with selected people.</p>}
      </div>}
      <button className="primary-button share-save" onClick={save} disabled={busy || (visibility === "selected" && !selected.length)}>Save access</button>
    </aside>
  );
}

function FolderSharePanel({ folder, onClose, onChanged }: { folder: Folder; onClose: () => void; onChanged: () => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [visibility, setVisibility] = useState<"private" | "selected" | "all_users">(folder.visibility);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    Promise.all([
      api<{ users: User[] }>("/users"),
      api<{ visibility: typeof visibility; users: Array<{ id: string }> }>(`/folders/${folder.id}/sharing`)
    ]).then(([allUsers, sharing]) => {
      setUsers(allUsers.users);
      setVisibility(sharing.visibility);
      setSelected(sharing.users.map((user) => user.id));
      setBusy(false);
    });
  }, [folder.id]);

  async function save() {
    setBusy(true);
    await api(`/folders/${folder.id}/sharing`, { method: "PUT", body: JSON.stringify({ visibility, userIds: visibility === "selected" ? selected : [] }) });
    setBusy(false);
    onChanged();
  }

  return (
    <aside className="side-panel share-panel">
      <header><div><span className="eyebrow">Folder access</span><h2>{folder.name}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close folder sharing"><X /></button></header>
      <div className="share-options">
        <label><input type="radio" checked={visibility === "private"} onChange={() => setVisibility("private")} /><span><Lock />Private<small>Only you can open this folder’s notes</small></span></label>
        <label><input type="radio" checked={visibility === "selected"} onChange={() => setVisibility("selected")} /><span><Users />Selected people<small>Share inherited notes with chosen users</small></span></label>
        <label><input type="radio" checked={visibility === "all_users"} onChange={() => setVisibility("all_users")} /><span><Share2 />Everyone here<small>All signed-in allowlisted users</small></span></label>
      </div>
      {visibility === "selected" && <div className="user-picker">
        {users.map((user) => <label key={user.id}><input type="checkbox" checked={selected.includes(user.id)} onChange={() => setSelected((items) => items.includes(user.id) ? items.filter((id) => id !== user.id) : [...items, user.id])} /><span>{user.displayName}<ShareRoleHint role={user.role} /></span></label>)}
        {!users.length && <p className="empty-copy">Another signed-in user is needed before sharing this folder.</p>}
      </div>}
      <button className="primary-button share-save" onClick={save} disabled={busy || (visibility === "selected" && !selected.length)}>Save folder access</button>
    </aside>
  );
}

// Files entries carry their own panel hint. Without an explicit one, a matching hint on the current
// entry is kept (reloads, URL normalisation), otherwise the panel follows the selection.
/** The notes list's "Move to the Bin?" (Friction 14, D91): the app's confirm, closed by Back or Forward. */
export function NoteDeleteConfirm({ title, onConfirm, onCancel }: { title: string; onConfirm: () => void; onCancel: () => void }) {
  useHistoryDialogGuard(true, onCancel);
  return <ConfirmDialog title="Move to the Bin?" message={noteDeleteMessage(title)} confirmLabel="Move to Bin" danger onConfirm={onConfirm} onCancel={onCancel} />;
}

export const noteDeleteMessage = (title: string) => `Move “${title || "Untitled"}” to the Bin? You can restore it for 30 days.`;

function filesSnapshotFor(userId: string, route: Extract<Route, { app: "files" }>, filesPanel?: FilesPanel) {
  const selection = { folder: route.folder, documentId: route.documentId };
  return { ...selection, panel: filesPanel ?? resolveFilesPanel(selection, readFilesHistorySnapshot(window.history.state, userId)) };
}

// Notes entries also carry the search hint (src/search/searchHistory.ts), so Back and Forward
// return to the results a note was opened from, with the query kept.
function historyStateFor(userId: string, route: Route, panel: MobilePanel, filesPanel?: FilesPanel, search: SearchHint | null = null) {
  const appState = route.app === "notes" ? withSearchHint(userId, search, createHistoryState(userId, { panel, folder: route.folder, noteId: route.noteId }, null))
    : route.app === "files" ? createFilesHistoryState(userId, filesSnapshotFor(userId, route, filesPanel), null)
    : route.app === "tasks" ? carriedTasksState(userId, route.boardId, window.history.state)
    : route.app === "collections" ? carriedCollectionsState(userId, route, window.history.state)
    : route.app === "calendar" ? carriedCalendarState(userId, route, window.history.state) : null;
  return createAppHistoryState(userId, route.app, appState);
}

// The URL carries the app, folder, and item; the state payload adds the phone panel hint (and the
// folder a note was opened from). A change that keeps the URL is a pure panel step: phones get a Back
// entry for it, desktops just update the current entry.
function writeHistory(userId: string, route: Route, panel: MobilePanel, mode: "push" | "replace" = "push", filesPanel?: FilesPanel, search: SearchHint | null = null) {
  const url = formatRoute(route);
  const current: unknown = window.history.state;
  const samePath = url === locationUrl(window.location);
  const currentSnapshot = readHistorySnapshot(current, userId);
  const currentFilesSnapshot = readFilesHistorySnapshot(current, userId);
  const sameEntry = samePath && resolveAppHistorySection(current, userId) === route.app
    && (route.app !== "notes" || (currentSnapshot !== null && sameSnapshot(currentSnapshot, { panel, folder: route.folder, noteId: route.noteId })))
    && (route.app !== "files" || (currentFilesSnapshot !== null && sameFilesSnapshot(currentFilesSnapshot, filesSnapshotFor(userId, route, filesPanel))))
    && (route.app !== "notes" || sameSearchHint(readSearchHint(current, userId), search));
  if (sameEntry && mode === "push") return;
  const depth = readHistoryDepth(current);
  const state = historyStateFor(userId, route, panel, filesPanel, search);
  // From a dialog's depth-0 sentinel, the new route takes the sentinel's place instead of stacking on it.
  if (mode === "push" && !(samePath && !isMobileViewport()) && !takeDialogSentinelEntry(current)) window.history.pushState(withHistoryDepth(state, depth + 1), "", url);
  else window.history.replaceState(withHistoryDepth(state, depth), "", url);
}

export function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [checking, setChecking] = useState(true);
  // Wave 18: /register#invite=<token>. Read once, and the fragment is stripped at once (T136); the
  // token then lives only in this state until the account is created or the visitor leaves.
  const [invite, setInvite] = useState(initialInvite);
  // Wave 28: /verify-email#token= and /mail/unsubscribe#t= (fragments stripped at once, T220).
  const [mailLink, setMailLink] = useState(initialMailLink);
  // Wave 30: /forgot-password and /reset-password#token= (the fragment is stripped at once, T220).
  const [passwordLink, setPasswordLink] = useState(initialPasswordLink);
  const [activeApp, setActiveApp] = useState<AppSection>(() => routeFromLocation(window.location).app);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<FolderSelection>("all");
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const selectedNoteIdRef = useRef(selectedNoteId);
  selectedNoteIdRef.current = selectedNoteId;
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [query, setQuery] = useState("");
  // "Search all notes" widens a search beyond the current section.
  const [searchAll, setSearchAll] = useState(false);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // The search hint new Notes history entries carry. Updated during render, and directly when
  // history or a folder switch changes the search before the next render.
  const searchHintRef = useRef<SearchHint | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("folders");
  // Bumped to remount Calendar when a notification opens a Calendar URL while it is on screen.
  const [calendarKey, setCalendarKey] = useState(0);
  const [panel, setPanel] = useState<"history" | "share" | null>(null);
  const [mobileActions, setMobileActions] = useState(false);
  const [sharingFolder, setSharingFolder] = useState<Folder | null>(null);
  // The note whose Move to the Bin is being confirmed, and the trash button that asked (focus returns to it).
  const [deletingNote, setDeletingNote] = useState<{ id: string; title: string } | null>(null);
  const deleteOpenerRef = useRef<HTMLElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("security");
  // A /settings/:section deep link, applied once the workspace is ready (outbound email §E.1).
  const initialSettingsRef = useRef<SettingsSection | null>(parseSettingsPath(window.location.pathname));
  const settingsOpenRef = useRef(false);
  settingsOpenRef.current = settingsOpen;
  // True while Settings shows a new MCP key that is shown only once.
  const settingsPendingRef = useRef(false);
  const [noteSort, setNoteSort] = useState<NoteSort>("updated-desc");
  const [sortOpen, setSortOpen] = useState(false);
  const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null);
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error" | "conflict">("saved");
  const [toast, setToast] = useState("");
  // Settings → Modules (D92): per-user, saved on the server, UI only.
  const modulePreferences = usePreferences(session?.user.id ?? null, session && session.preferences !== undefined ? parsePreferences(session.preferences) : undefined);
  const disabledModules = modulePreferences.preferences.disabledModules;
  const searchEnabled = isModuleEnabled(disabledModules, "search");
  const binEnabled = isModuleEnabled(disabledModules, "bin");
  // True from Settings → "Manage team" until the admin leaves Team: that visit passes the route gate
  // even when the Team module is hidden (Team plan §6.2). Anything else follows the toggle.
  const [teamViaSettings, setTeamViaSettings] = useState(false);
  const previousAppRef = useRef<AppSection | null>(null);
  const teamGateOpen = activeApp === "team" && teamViaSettings && canManageTeam(session?.user.role);
  // The module whose route was just replaced with Home, for the one-line hint (D92).
  const [moduleHint, setModuleHint] = useState<ModuleId | null>(null);
  const leavingHiddenModuleRef = useRef(false);
  const hiddenLeaveFailedRef = useRef<string | null>(null);
  // The depth of the entry on screen, so a popstate can tell Back from Forward (route gate, D92).
  const historyDepthRef = useRef(0);
  const [selectionOwner, setSelectionOwner] = useState<string | null>(null);
  const [leavingNotes, setLeavingNotes] = useState(false);
  // Set while a note/folder switch finalizes the open note, so late keystrokes cannot be dropped.
  const [switchingNote, setSwitchingNote] = useState(false);
  const sessionUserRef = useRef<string | null>(null);
  const noteLoadGenerationRef = useRef(0);
  const revisionRef = useRef<number | null>(null);
  const loadedRef = useRef("");
  const savingPromiseRef = useRef<Promise<boolean> | null>(null);
  const switchingRef = useRef(false);
  const autosaveTimerRef = useRef<number | null>(null);
  // The route requested before the workspace was ready (deep link, or the URL shown on the login page).
  const pendingRouteRef = useRef<Route | null>(routeFromLocation(window.location));
  const routeAppliedUserRef = useRef<string | null>(null);
  // Set when the first data load for a user failed, so the next route change retries it.
  const startupFailedUserRef = useRef<string | null>(null);
  const [startupRetry, setStartupRetry] = useState(0);
  const newlyCreatedNoteIdRef = useRef<string | null>(null);
  // The note the user typed in since it was opened. Only such a draft is published on the way out;
  // a draft that was already waiting (another session, or an MCP key) needs an explicit Publish.
  const sessionEditedRef = useRef<string | null>(null);

  // One timer for the one toast: an earlier message's timer must not clear a newer message early.
  const toastTimerRef = useRef<number | null>(null);
  const flash = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => { toastTimerRef.current = null; setToast(""); }, 2600);
  }, []);

  const loadNavigation = useCallback(async (expectedUserId = sessionUserRef.current) => {
    const [{ folders: folderRows }, { notes: noteRows }] = await Promise.all([
      api<{ folders: Folder[] }>("/folders"),
      api<{ notes: NoteSummary[] }>("/notes")
    ]);
    if (!expectedUserId || sessionUserRef.current !== expectedUserId) return { folders: [] as Folder[], notes: [] as NoteSummary[], stale: true };
    setFolders(folderRows);
    setNotes(noteRows);
    return { folders: folderRows, notes: noteRows, stale: false };
  }, []);

  const loadNote = useCallback(async (id: string) => {
    const expectedUserId = sessionUserRef.current;
    const generation = ++noteLoadGenerationRef.current;
    const { note: detail } = await api<{ note: NoteDetail }>(`/notes/${id}`);
    if (!expectedUserId || sessionUserRef.current !== expectedUserId || generation !== noteLoadGenerationRef.current) return;
    if (sessionEditedRef.current !== detail.id) sessionEditedRef.current = null;
    setNote(detail);
    setMarkdown(detail.markdown);
    revisionRef.current = detail.draft_revision;
    loadedRef.current = detail.markdown;
    setSaveState("saved");
  }, []);

  useEffect(() => {
    api<SessionResponse>("/auth/me")
      .then((result) => { sessionUserRef.current = result.user.id; setCsrfToken(result.csrfToken); setSession(result); })
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, []);

  // Signed out, Back and Forward move between sign in and /forgot-password (Wave 30).
  useEffect(() => {
    if (session) return;
    const onPopState = () => {
      const link = takePasswordLinkFromLocation();
      setPasswordLink(link?.kind === "forgot" ? link : null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    if (session.totp.setupRequired) setSettingsOpen(true);
    else {
      const userId = session.user.id;
      // Later session updates (for example a two-factor change) only refresh data; the route was already applied.
      const applyRoute = routeAppliedUserRef.current !== userId;
      loadNavigation(userId).then(({ folders: folderRows, notes: noteRows, stale }) => {
        if (stale || sessionUserRef.current !== userId || !applyRoute) return;
        const route = pendingRouteRef.current ?? routeFromLocation(window.location);
        pendingRouteRef.current = null;
        routeAppliedUserRef.current = userId;
        startupFailedUserRef.current = null;
        const snapshot = readHistorySnapshot(window.history.state, userId);
        // A reload keeps the search that this entry was showing.
        const searchHint = route.app === "notes" ? readSearchHint(window.history.state, userId) : null;
        searchHintRef.current = searchHint;
        setQuery(searchHint?.query ?? "");
        setSearchAll(searchHint?.all ?? false);
        let selection: { folder: FolderSelection; noteId: string | null };
        let panel: MobilePanel = "folders";
        if (route.app === "notes" && (route.noteId || route.folder !== "all")) {
          const resolved = resolveNotesRoute(route, { folders: folderRows, notes: noteRows }, { snapshot, lastFolder: "all" });
          if (resolved.missing) flash(resolved.missing === "note" ? "Note not found" : "Folder not found");
          selection = resolved;
          panel = resolveNotesPanel(resolved, snapshot);
        } else {
          // Resume the last folder and note only when the URL does not name one.
          let remembered: { folder?: string; noteId?: string } = {};
          try { remembered = JSON.parse(localStorage.getItem(`mynotes:last:${userId}`) ?? "{}"); } catch { /* use defaults */ }
          const folder = remembered.folder;
          const restoredFolder = folder && (folder === "all" || folder === "shared" || folderRows.some((item) => item.id === folder)) ? folder : "all";
          const restoredNote = remembered.noteId ? noteRows.find((item) => item.id === remembered.noteId) : undefined;
          selection = { folder: restoredFolder, noteId: restoredNote && noteInFolder(restoredNote, restoredFolder) ? restoredNote.id : null };
          if (snapshot && snapshot.folder === selection.folder && snapshot.noteId === selection.noteId) panel = snapshot.panel === "editor" && !selection.noteId ? "notes" : snapshot.panel;
        }
        setSelectedFolder(selection.folder);
        setSelectedNoteId(selection.noteId);
        setSelectionOwner(userId);
        setMobilePanel(panel);
        setActiveApp(route.app);
        const target: Route = route.app === "notes" ? notesRoute(selection.folder, selection.noteId) : route;
        writeHistory(userId, target, panel, "replace", undefined, route.app === "notes" ? searchHint : null);
        historyDepthRef.current = readHistoryDepth(window.history.state);
        // A /settings/:section link: the entry below is Home, and Settings gets an entry of its own,
        // so Back closes it without leaving Nook and Forward reopens it.
        const deepSettings = initialSettingsRef.current;
        initialSettingsRef.current = null;
        if (deepSettings) openSettings(deepSettings);
      }).catch((reason) => {
        if (applyRoute && sessionUserRef.current === userId && routeAppliedUserRef.current !== userId) startupFailedUserRef.current = userId;
        flash(reason instanceof Error ? reason.message : "Could not open your notes");
      });
    }
  }, [flash, session, loadNavigation, startupRetry]);
  useEffect(() => {
    // The Settings dialog owns the title while it is open, and restores it on close.
    if (settingsOpen) return;
    const sectionName = { home: "Home", notes: "Notes", files: "Files", tasks: "Tasks", collections: "Collections", calendar: "Calendar", notifications: "Notifications", bin: "Bin", team: "Team", inbox: "Inbox" }[activeApp];
    const detail = activeApp === "notes" && note && note.id === selectedNoteId ? note.title || "Untitled" : null;
    document.title = session ? `${detail ? `${detail} · ` : ""}${sectionName} · Nook` : "Sign in · Nook";
  }, [activeApp, note, selectedNoteId, session, settingsOpen]);
  useEffect(() => {
    if (!session || selectionOwner !== session.user.id) return;
    localStorage.setItem(`mynotes:last:${session.user.id}`, JSON.stringify({ folder: selectedFolder, noteId: selectedNoteId }));
  }, [activeApp, selectedFolder, selectedNoteId, selectionOwner, session]);
  useEffect(() => {
    if (!selectedNoteId) {
      noteLoadGenerationRef.current += 1;
      setNote(null);
      return;
    }
    const noteId = selectedNoteId;
    loadNote(noteId).catch((reason) => {
      // Give the user a way out: keep the last loaded note readable instead of leaving it locked.
      if (selectedNoteIdRef.current !== noteId) return;
      flash(reason instanceof Error && reason.message !== "Not found" ? reason.message : "Could not open this note");
      setSelectedNoteId(null);
      navigate(notesRoute(selectedFolder, null), { panel: "notes", replace: true });
    });
  }, [selectedNoteId, loadNote]);
  useEffect(() => {
    if (!sortOpen) return;
    const closeSort = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && event.target instanceof Element && event.target.closest(".sort-control")) return;
      setSortOpen(false);
    };
    window.addEventListener("click", closeSort);
    window.addEventListener("keydown", closeSort);
    return () => { window.removeEventListener("click", closeSort); window.removeEventListener("keydown", closeSort); };
  }, [sortOpen]);

  const saveDraft = useCallback(async () => {
    if (savingPromiseRef.current) await savingPromiseRef.current;
    if (!note?.isOwner || markdown === loadedRef.current) return note?.hasDelta ?? false;
    const noteId = note.id;
    const draftMarkdown = markdown;
    const revision = revisionRef.current;
    const task = (async () => {
      setSaveState("saving");
      const result = await api<{ revision: number; title: string; hasDelta: boolean }>(`/notes/${noteId}/draft`, {
        method: "PUT",
        body: JSON.stringify({ markdown: draftMarkdown, revision })
      });
      revisionRef.current = result.revision;
      loadedRef.current = draftMarkdown;
      setNote((current) => current?.id === noteId ? {
        ...current,
        title: result.title,
        markdown: draftMarkdown,
        hasDraft: true,
        hasDelta: result.hasDelta,
        draft_revision: result.revision
      } : current);
      setSaveState("saved");
      await loadNavigation();
      return result.hasDelta;
    })();
    savingPromiseRef.current = task;
    try {
      return await task;
    } catch (reason) {
      setSaveState(reason instanceof ApiError && reason.status === 409 ? "conflict" : "error");
      throw reason;
    } finally {
      if (savingPromiseRef.current === task) savingPromiseRef.current = null;
    }
  }, [loadNavigation, markdown, note]);

  useEffect(() => {
    if (!note?.isOwner || markdown === loadedRef.current) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => saveDraft().catch(() => undefined), 900);
    autosaveTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (autosaveTimerRef.current === timer) autosaveTimerRef.current = null;
    };
  }, [markdown, note?.id, note?.isOwner, saveDraft]);

  const visibleNotes = useMemo(() => notes.filter((item) => {
    const inSection = selectedFolder === "all" ? true : selectedFolder === "shared" ? item.is_owner === 0 : item.folder_id === selectedFolder;
    return inSection && item.title.toLowerCase().includes(query.toLowerCase());
  }).sort((left, right) => {
    if (noteSort === "title-asc") return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
    if (noteSort === "title-desc") return right.title.localeCompare(left.title, undefined, { sensitivity: "base" });
    const field = noteSort.startsWith("created") ? "created_at" : "updated_at";
    const delta = new Date(left[field]).getTime() - new Date(right[field]).getTime();
    return noteSort.endsWith("desc") ? -delta : delta;
  }), [noteSort, notes, query, selectedFolder]);

  const searchFolder: FolderSelection = searchAll ? "all" : selectedFolder;
  // Re-run a search when notes are added, removed, or moved, not on every autosave refresh
  // (which only changes titles and times).
  const searchRefreshKey = useMemo(() => notes.map((item) => `${item.id}:${item.folder_id ?? ""}`).join(","), [notes]);
  const search = useNoteSearch(query, searchFolder, searchRefreshKey);
  const showingSearchResults = search.active && search.status === "ready";
  searchHintRef.current = search.active ? { query, all: searchAll } : null;
  const activeSearchHit = showingSearchResults ? search.results[activeSearchIndex] ?? null : null;
  useEffect(() => setActiveSearchIndex(-1), [query, searchFolder]);

  // Also locked while the previous note is still shown but a different note is loading.
  const editorLocked = leavingNotes || switchingNote || (note !== null && note.id !== selectedNoteId);
  const publishInput = { isOwner: Boolean(note?.isOwner), serverHasDelta: Boolean(note?.hasDelta), hasUnsavedChanges: markdown !== loadedRef.current };
  const hasPublishableDelta = canPublish(publishInput);
  const draftBadge = note?.isOwner && note.hasDraft ? mcpDraftBadge(note.draftMcpKeyName) : null;
  // Friction 7: notice when the open draft is published elsewhere (an Inbox approval) and refresh the editor.
  const markdownNowRef = useRef(markdown);
  markdownNowRef.current = markdown;
  usePublishWatch(note?.isOwner && note.hasDraft ? note.id : null, async () => {
    const open = note;
    if (!open || editorLocked || savingPromiseRef.current) return;
    const generation = noteLoadGenerationRef.current;
    const { note: fetched } = await api<{ note: NoteDetail }>(`/notes/${open.id}`);
    const outcome = publishedElsewhere(open, fetched, markdownNowRef.current !== loadedRef.current);
    if (!outcome.refresh || generation !== noteLoadGenerationRef.current || markdownNowRef.current !== loadedRef.current) return;
    setNote(fetched);
    setMarkdown(fetched.markdown);
    revisionRef.current = fetched.draft_revision;
    loadedRef.current = fetched.markdown;
    setSaveState("saved");
    void loadNavigation();
    flash(outcome.toast);
  });

  function cancelPendingAutosave() {
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = null;
  }

  function navigate(route: Route, options: { replace?: boolean; panel?: MobilePanel; filesPanel?: FilesPanel } = {}) {
    if (!session) return;
    writeHistory(session.user.id, route, options.panel ?? mobilePanel, options.replace ? "replace" : "push", options.filesPanel, route.app === "notes" ? searchHintRef.current : null);
    historyDepthRef.current = readHistoryDepth(window.history.state);
    // While the first load is in flight, the newest URL is the one to apply once it lands.
    if (pendingRouteRef.current) pendingRouteRef.current = route;
    if (startupRouteState(session.user.id, routeAppliedUserRef.current, startupFailedUserRef.current) === "retry") retryStartup(route);
  }

  // The first load failed: reload the workspace data and apply this route once it arrives.
  function retryStartup(route: Route) {
    pendingRouteRef.current = route;
    startupFailedUserRef.current = null;
    setStartupRetry((attempt) => attempt + 1);
  }

  function currentNotesRoute(): NotesRoute {
    return notesRoute(selectedFolder, selectedNoteId);
  }

  function showMobilePanel(panel: MobilePanel, mode: "push" | "replace" = "push") {
    const current = session ? readHistorySnapshot(window.history.state, session.user.id) : null;
    if (panel === "editor" && current?.panel === "folders" && selectedNoteId) {
      navigate(currentNotesRoute(), { panel: "notes" });
    }
    setMobilePanel(panel);
    navigate(currentNotesRoute(), { panel, replace: mode === "replace" });
  }

  async function removeEmptyNewNote() {
    const unloadedNewNote = selectedNoteId !== null && selectedNoteId === newlyCreatedNoteIdRef.current;
    const emptyUnpublishedNote = note?.isOwner && note.current_version === 0;
    if ((!emptyUnpublishedNote && !unloadedNewNote) || markdown.trim() !== "") return false;
    cancelPendingAutosave();
    if (savingPromiseRef.current) await savingPromiseRef.current;
    const noteId = note?.id ?? selectedNoteId;
    if (!noteId) return false;
    await api(`/notes/${noteId}`, { method: "DELETE", body: "{}" });
    if (newlyCreatedNoteIdRef.current === noteId) newlyCreatedNoteIdRef.current = null;
    revisionRef.current = null;
    loadedRef.current = "";
    setNote(null);
    await loadNavigation();
    return true;
  }

  function finalizeCurrentNote(reloadCurrent = false) {
    const sessionEdited = note !== null && sessionEditedRef.current === note.id;
    return finalizeOpenNote({ removeEmptyNewNote, hasPublishableDelta: shouldAutoPublish({ ...publishInput, sessionEdited, mcpDraft: Boolean(note?.draftMcpKeyName) }), publish: () => publish(reloadCurrent) });
  }

  async function createFolder() {
    const name = window.prompt("Folder name");
    if (!name?.trim()) return;
    await api("/folders", { method: "POST", body: JSON.stringify({ name: name.trim(), parentId: null }) });
    await loadNavigation();
  }

  async function createNote() {
    if (switchingRef.current) return;
    switchingRef.current = true;
    setSwitchingNote(true);
    try {
      const finalized = await finalizeCurrentNote();
      const selected = folders.find((folder) => folder.id === selectedFolder);
      const folderId = selected?.is_owner === 1 ? selected.id : null;
      const { note: created } = await api<{ note: { id: string } }>("/notes", { method: "POST", body: JSON.stringify({ folderId }) });
      await loadNavigation();
      setSelectedNoteId(created.id);
      newlyCreatedNoteIdRef.current = created.id;
      setMobilePanel("editor");
      // A blank note that was just removed should not stay behind as a Back target.
      navigate(notesRoute(selectedFolder, created.id), { panel: "editor", replace: finalized === "removed-empty" });
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : "Could not create note");
    } finally {
      switchingRef.current = false;
      setSwitchingNote(false);
    }
  }

  async function moveNote(noteId: string, folder: Folder) {
    await api(`/notes/${noteId}`, { method: "PATCH", body: JSON.stringify({ folderId: folder.id }) });
    setNote((current) => current?.id === noteId ? { ...current, folder_id: folder.id } : current);
    if (selectedNoteId === noteId) setSelectedFolder(folder.id);
    setDraggingNoteId(null);
    setDropFolderId(null);
    await loadNavigation();
    if (selectedNoteId === noteId) navigate(notesRoute(folder.id, noteId), { replace: true });
    flash(`Moved to ${folder.name}`);
  }

  // Clears the editor after the open note left the list (moved to the Bin or purged).
  function closeRemovedNote(noteId: string) {
    if (newlyCreatedNoteIdRef.current === noteId) newlyCreatedNoteIdRef.current = null;
    setSelectedNoteId(null);
    setNote(null);
    setMarkdown("");
    revisionRef.current = null;
    loadedRef.current = "";
    setMobilePanel("notes");
    navigate(notesRoute(selectedFolder, null), { panel: "notes", replace: true });
  }

  function askDeleteNote(noteId: string, title: string, opener: HTMLElement) {
    if (switchingRef.current) return;
    deleteOpenerRef.current = opener;
    setDeletingNote({ id: noteId, title });
  }

  /** After the confirm closes: the trash button when the note is still listed, else the list's first note. */
  function focusAfterDeleteConfirm() {
    window.requestAnimationFrame(() => {
      const opener = deleteOpenerRef.current;
      deleteOpenerRef.current = null;
      if (opener?.isConnected && !opener.hasAttribute("disabled")) opener.focus();
      else document.querySelector<HTMLElement>(".note-card .note-card-select")?.focus();
    });
  }

  async function deleteNote(noteId: string) {
    if (switchingRef.current) return;
    // Lock the editor and note switching for the whole save + delete, like a note switch,
    // so no keystrokes land after the saved copy and no other note is cleared by mistake.
    switchingRef.current = true;
    setSwitchingNote(true);
    const deletingOpenNote = noteId === selectedNoteId;
    try {
      if (deletingOpenNote) {
        cancelPendingAutosave();
        // The note stays restorable from the Bin, so keep the latest edits in its draft.
        await saveDraft();
      }
      const result = await api<{ purged?: boolean }>(`/notes/${noteId}`, { method: "DELETE", body: "{}" });
      if (deletingOpenNote) closeRemovedNote(noteId);
      await loadNavigation();
      flash(result.purged ? "Empty note removed" : "Moved to the Bin");
      if (!result.purged) notifyBinChanged();
    } finally {
      switchingRef.current = false;
      setSwitchingNote(false);
    }
  }

  async function publish(reloadCurrent = true) {
    if (!note) return false;
    const hasDelta = await saveDraft();
    if (!hasDelta) return false;
    try {
      await api(`/notes/${note.id}/publish`, { method: "POST", body: JSON.stringify(revisionRef.current === null ? {} : { revision: revisionRef.current }) });
    } catch (reason) {
      if (!(reason instanceof ApiError) || !isDraftChangedError(reason.status, reason.payload)) throw reason;
      // Someone else (an MCP key or another session) wrote the draft after this editor's last save.
      // Show it instead of publishing text the user has not seen.
      await Promise.all([loadNote(note.id), loadNavigation()]);
      flash(DRAFT_CHANGED_MESSAGE);
      return false;
    }
    if (sessionEditedRef.current === note.id) sessionEditedRef.current = null;
    if (reloadCurrent) await Promise.all([loadNote(note.id), loadNavigation()]);
    else await loadNavigation();
    flash("New version published");
    return true;
  }

  // `folder` is the section to open the note in: a search hit from outside the current section opens under All notes.
  async function selectNote(nextId: string, folder: FolderSelection = selectedFolder) {
    if (nextId === selectedNoteId) {
      setSelectedFolder(folder);
      setMobilePanel("editor");
      navigate(notesRoute(folder, nextId), { panel: "editor" });
      return;
    }
    if (switchingRef.current) return;
    switchingRef.current = true;
    setSwitchingNote(true);
    try {
      const finalized = await finalizeCurrentNote();
      setSelectedFolder(folder);
      setSelectedNoteId(nextId);
      setMobilePanel("editor");
      navigate(notesRoute(folder, nextId), { panel: "editor", replace: finalized === "removed-empty" });
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : "Could not switch notes");
    } finally {
      switchingRef.current = false;
      setSwitchingNote(false);
    }
  }

  async function selectFolder(nextFolder: FolderSelection) {
    if (nextFolder === selectedFolder) {
      // Same folder: only the phone panel changes; an open note stays open (and in the URL).
      setMobilePanel("notes");
      navigate(notesRoute(nextFolder, selectedNoteId), { panel: "notes" });
      return;
    }
    if (switchingRef.current) return;
    switchingRef.current = true;
    setSwitchingNote(true);
    try {
      const finalized = await finalizeCurrentNote();
      // A search in progress continues in the new section.
      setSearchAll(false);
      if (searchHintRef.current) searchHintRef.current = { ...searchHintRef.current, all: false };
      setSelectedFolder(nextFolder);
      setSelectedNoteId(null);
      setNote(null);
      setMarkdown("");
      revisionRef.current = null;
      loadedRef.current = "";
      setMobilePanel("notes");
      navigate(notesRoute(nextFolder, null), { panel: "notes", replace: finalized === "removed-empty" });
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : "Could not switch folders");
    } finally {
      switchingRef.current = false;
      setSwitchingNote(false);
    }
  }

  // The print stylesheet (styles.css, @media print) keeps only the note; the title names the PDF.
  const restorePrintTitleRef = useRef<(() => void) | null>(null);
  function downloadPdf() {
    if (!note) return;
    // A previous print that never fired afterprint still holds the real title; restore it first.
    restorePrintTitleRef.current?.();
    const previousTitle = document.title;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const restoreTitle = () => {
      window.removeEventListener("afterprint", restoreTitle);
      clearTimeout(fallback);
      if (restorePrintTitleRef.current === restoreTitle) restorePrintTitleRef.current = null;
      document.title = previousTitle;
    };
    restorePrintTitleRef.current = restoreTitle;
    document.title = note.title.trim() || "Untitled note";
    window.addEventListener("afterprint", restoreTitle, { once: true });
    window.print();
    // print() blocks in most browsers, but some return at once and never fire afterprint.
    fallback = setTimeout(restoreTitle, 1000);
  }

  async function discard() {
    if (!note || switchingRef.current) return;
    const noteId = note.id;
    const removesNote = note.current_version === 0;
    const message = !removesNote
      ? "Discard this draft and return to the published version?"
      : markdown.trim() === ""
        ? "Discard this empty note?"
        : `This note was never published. Move “${note.title || "Untitled"}” to the Bin? You can restore it for 30 days.`;
    if (!window.confirm(message)) return;
    switchingRef.current = true;
    setSwitchingNote(true);
    try {
      if (removesNote) {
        cancelPendingAutosave();
        // Discarding an unpublished note moves it to the Bin with its draft, so save the latest edits first.
        await saveDraft();
      }
      const result = await api<{ binned?: boolean; purged?: boolean }>(`/notes/${noteId}/draft`, { method: "DELETE", body: "{}" });
      if (removesNote) {
        closeRemovedNote(noteId);
        await loadNavigation();
        flash(result.binned ? "Moved to the Bin" : "Empty note removed");
      } else {
        if (sessionEditedRef.current === noteId) sessionEditedRef.current = null;
        await Promise.all([loadNote(noteId), loadNavigation()]);
        flash("Draft discarded");
      }
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : "Could not discard this draft");
    } finally {
      switchingRef.current = false;
      setSwitchingNote(false);
    }
  }

  // Applies a Notes URL reached through Back/Forward. The browser has already moved, so on failure
  // the entry is rewritten to the note that is still open.
  async function restoreNotesRoute(route: NotesRoute, snapshot: MobileNavigationSnapshot | null, data: { folders: Folder[]; notes: NoteSummary[] } = { folders, notes }) {
    if (!session) return;
    if (switchingRef.current) {
      navigate(routeForApp(activeApp), { replace: true });
      return;
    }
    const resolved = resolveNotesRoute(route, data, { snapshot, lastFolder: selectedFolder });
    const targetPanel = resolveNotesPanel(resolved, snapshot);
    const selectionChanged = resolved.folder !== selectedFolder || resolved.noteId !== selectedNoteId;
    switchingRef.current = true;
    setSwitchingNote(true);
    try {
      if (selectionChanged) {
        await finalizeCurrentNote();
        setSelectedFolder(resolved.folder);
        setSelectedNoteId(resolved.noteId);
        if (!resolved.noteId) {
          setNote(null);
          setMarkdown("");
          revisionRef.current = null;
          loadedRef.current = "";
        }
      }
      setMobilePanel(targetPanel);
      setActiveApp("notes");
      if (resolved.missing) flash(resolved.missing === "note" ? "Note not found" : "Folder not found");
      if (resolved.missing || formatRoute(notesRoute(resolved.folder, resolved.noteId)) !== window.location.pathname) {
        navigate(notesRoute(resolved.folder, resolved.noteId), { panel: targetPanel, replace: true });
      }
    } catch (reason) {
      flash(`${reason instanceof Error ? reason.message : "Could not save this note"}. Your note is still open.`);
      navigate(routeForApp(activeApp), { replace: true });
    } finally {
      switchingRef.current = false;
      setSwitchingNote(false);
    }
  }

  function routeForApp(section: AppSection): Route {
    if (section === "notes") return currentNotesRoute();
    if (section === "files") return { app: "files", folder: "all", documentId: null };
    if (section === "tasks") return { app: "tasks", boardId: null, cardId: null };
    if (section === "collections") return { app: "collections", collectionId: null, viewId: null, rowId: null };
    if (section === "calendar") return calendarHomeRoute(isMobileViewport(), localDate(new Date()));
    if (section === "team") return { app: "team", userId: null };
    if (section === "inbox") return { app: "inbox", view: "pending", proposalId: null };
    return { app: section };
  }

  async function leaveNotes() {
    if (switchingRef.current) return false;
    switchingRef.current = true;
    // Lock the editor so keystrokes cannot land between the save and the post-publish reload.
    setLeavingNotes(true);
    try {
      // The note stays selected for when Notes reopens, so a published note is reloaded to clear its draft state.
      if (await finalizeCurrentNote(true) === "removed-empty") {
        setSelectedNoteId(null);
        setMarkdown("");
      }
      setPanel(null);
      setSharingFolder(null);
      setMobileActions(false);
      return true;
    } catch (reason) {
      flash(`${reason instanceof Error ? reason.message : "Could not save this note"}. Your note is still open.`);
      return false;
    } finally {
      switchingRef.current = false;
      setLeavingNotes(false);
    }
  }

  /** Resolves true once `section` is on screen, false when the switch did not happen (no session, or a note that could not be saved). */
  async function openApp(section: AppSection) {
    if (!session) return false;
    if (section === activeApp) return true;
    if (activeApp === "notes" && !await leaveNotes()) return false;
    if (section === "notes") {
      setMobilePanel("folders");
      navigate(currentNotesRoute(), { panel: "folders" });
    } else {
      navigate(routeForApp(section));
    }
    setActiveApp(section);
    return true;
  }

  function openHome() {
    return openApp("home");
  }

  // A link on Today opens its route as a new entry (depth + 1), so Back returns to Today. Notes
  // reloads its lists first so an item Today just listed is known to the Notes view.
  async function openTodayRoute(route: Route) {
    if (!session || activeApp !== "home" || route.app === "home") return;
    if (route.app !== "notes") {
      navigate(route);
      setActiveApp(route.app);
      return;
    }
    const panel = route.noteId ? "editor" : "folders";
    navigate(route, { panel });
    try {
      const data = await loadNavigation();
      if (data.stale) return;
      await restoreNotesRoute(route, null, data);
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : "Could not open your notes");
      // Step back to the Today entry this link pushed.
      window.history.back();
    }
  }

  // A notification opens its in-app path as a new entry (paths are checked by safeNotificationPath).
  // Opening a Calendar path while Calendar is on screen remounts it on the new URL.
  function openNotificationPath(path: string) {
    const route = parseRoute(path);
    if (route.app === "calendar") setCalendarKey((value) => value + 1);
    navigate(route);
    setActiveApp(route.app);
  }

  // A note linked from a calendar event opens in Notes as a new entry, so Back returns to the event.
  function openLinkedNote(noteId: string) {
    setSelectedFolder("all");
    setSelectedNoteId(noteId);
    setMobilePanel("editor");
    navigate(notesRoute("all", noteId), { panel: "editor" });
    setActiveApp("notes");
  }

  async function leaveNotesFromHistory(route: Route) {
    if (!session) return;
    if (await leaveNotes()) {
      setActiveApp(route.app);
      if (formatRoute(route) !== locationUrl(window.location)) navigate(route, { replace: true });
      return;
    }
    // Browser Back already moved off the note; rewrite this entry so the URL matches the open note.
    navigate(currentNotesRoute(), { replace: true });
  }

  // Records the search on the current Notes entry. On phones the first search from an entry pushes
  // one entry of its own (same URL), so Back from the results returns to the list without them;
  // later changes update that entry in place. Desktops only update the current entry.
  function syncSearchHistory() {
    // sessionUserRef, not the render's `session`: a timer from before sign-out must not write a hint afterwards.
    if (!session || activeApp !== "notes" || selectionOwner !== session.user.id || sessionUserRef.current !== session.user.id) return;
    const userId = session.user.id;
    const state: unknown = window.history.state;
    if (resolveAppHistorySection(state, userId) !== "notes") return;
    const current = readSearchHint(state, userId);
    const next = nextSearchHint(search.active, query, searchAll, current);
    if (sameSearchHint(current, next)) return;
    if (current === null && next && isMobileViewport()) {
      window.history.pushState(withHistoryDepth(withSearchHint(userId, next, state), readHistoryDepth(state) + 1), "", window.location.pathname);
      historyDepthRef.current = readHistoryDepth(window.history.state);
    } else {
      window.history.replaceState(withSearchHint(userId, next, state), "", window.location.pathname);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(syncSearchHistory, 250);
    return () => window.clearTimeout(timer);
  });

  function openSearchHit(hit: NoteSearchHit) {
    syncSearchHistory();
    const folder = noteInFolder(hit, selectedFolder) ? selectedFolder : "all";
    void selectNote(hit.id, folder);
  }

  function clearSearch() {
    setQuery("");
    setSearchAll(false);
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (!query) return;
      event.preventDefault();
      clearSearch();
      return;
    }
    if (!showingSearchResults || !search.results.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const last = search.results.length - 1;
      setActiveSearchIndex((index) => event.key === "ArrowDown" ? (index >= last ? 0 : index + 1) : (index <= 0 ? last : index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      openSearchHit(activeSearchHit ?? search.results[0]!);
    }
  }

  useEffect(() => {
    if (activeSearchIndex < 0 || !activeSearchHit) return;
    document.getElementById(searchOptionId(activeSearchHit.id))?.scrollIntoView({ block: "nearest" });
  }, [activeSearchHit, activeSearchIndex]);

  // Ctrl/⌘+K anywhere in Notes, or "/" outside a text field, focuses search.
  useEffect(() => {
    if (!session || activeApp !== "notes" || settingsOpen || !searchEnabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = Boolean(target && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']")));
      const commandK = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
      const slash = event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !typing;
      if (!commandK && !slash) return;
      event.preventDefault();
      const focusSearch = () => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      };
      // On phones the list panel must be visible before its input can take focus.
      if (isMobileViewport() && mobilePanel !== "notes") {
        showMobilePanel("notes");
        window.requestAnimationFrame(focusSearch);
      } else {
        focusSearch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function mobileBack(fallback: MobilePanel) {
    // Only step back through entries this visit pushed, so the in-app Back never leaves Nook.
    if (session && isMobileViewport() && readHistoryDepth(window.history.state) > 0 && readHistorySnapshot(window.history.state, session.user.id)) {
      window.history.back();
      return;
    }
    showMobilePanel(fallback, "replace");
  }

  // Re-registered every render so the handler never finalizes a note from a stale editor snapshot.
  // The depth of the entry on screen: read once per signed-in user, then kept by navigate() and by
  // every popstate (recordPopDepth), never re-read on render (see recordPopDepth).
  const sessionUserId = session?.user.id ?? null;
  useEffect(() => {
    if (sessionUserId) historyDepthRef.current = readHistoryDepth(window.history.state);
  }, [sessionUserId]);

  useEffect(() => {
    if (!session) return;
    const onPopState = (event: PopStateEvent) => {
      const poppedDepth = readHistoryDepth(event.state);
      const previousDepth = recordPopDepth(historyDepthRef, poppedDepth);
      // Back/Forward while a Files dialog is open only closes the dialog (D18).
      if (popStateClosedDialog(event)) return;
      if (session.totp.setupRequired) return;
      // Settings entries (/settings/:section): Forward onto one reopens the dialog over the app that
      // is on screen; Back off one closes it, then the entry below is restored as usual.
      const poppedSettings = parseSettingsPath(window.location.pathname);
      if (poppedSettings) {
        setPanel(null);
        setSharingFolder(null);
        setSettingsSection(poppedSettings);
        setSettingsOpen(true);
        return;
      }
      if (settingsOpenRef.current) {
        if (settingsPendingRef.current && !window.confirm("This API key is shown only once. Close settings without saving it?")) {
          historyDepthRef.current = previousDepth;
          undoDialogPop(dialogPopDirection(previousDepth, poppedDepth) ?? "back");
          return;
        }
        settingsPendingRef.current = false;
        setSettingsOpen(false);
      }
      const route = routeFromLocation(window.location);
      // D92: Back or Forward onto a module that is off skips that entry instead of replacing it
      // with a second Home entry. Depth 0 still falls through to the gate below, which replaces it.
      const hiddenRoute = route.app === "team" && teamGateOpen ? null : hiddenModuleForApp(disabledModules, route.app);
      const step = hiddenRoute ? hiddenEntryStep(dialogPopDirection(previousDepth, poppedDepth), poppedDepth) : "replace";
      if (hiddenRoute && step !== "replace") {
        setModuleHint(hiddenRoute);
        if (step === "undo") {
          historyDepthRef.current = previousDepth;
          undoDialogPop("forward");
        } else {
          window.history.back();
        }
        return;
      }
      const startup = startupRouteState(session.user.id, routeAppliedUserRef.current, startupFailedUserRef.current);
      if (startup === "retry") {
        retryStartup(route);
        return;
      }
      if (startup === "loading") {
        // The workspace is still loading; apply the newest URL once it is ready.
        pendingRouteRef.current = route;
        return;
      }
      if (route.app !== "notes") {
        if (activeApp === "notes") {
          void leaveNotesFromHistory(route);
          return;
        }
        setActiveApp(route.app);
        if (formatRoute(route) !== locationUrl(window.location)) navigate(route, { replace: true });
        return;
      }
      // Each Notes entry records the search it showed; entries from before a search clear it.
      const searchHint = readSearchHint(event.state, session.user.id);
      searchHintRef.current = searchHint;
      setQuery(searchHint?.query ?? "");
      setSearchAll(searchHint?.all ?? false);
      void restoreNotesRoute(route, readHistorySnapshot(event.state, session.user.id));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  });

  // D92: a route of a module that is turned off (a launcher link, a deep link, Back or Forward, a
  // notification, or turning it off while it is open) is replaced with Home and a hint. The entry is
  // replaced, not pushed, so Back never bounces into it again (Back and Forward onto such an entry
  // above depth 0 skip it in onPopState instead, see hiddenEntryStep). The server is not involved: the
  // module's API still works and keeps its own access rules (T97).
  useEffect(() => {
    const hidden = teamGateOpen ? null : hiddenModuleForApp(disabledModules, activeApp);
    if (!session || session.totp.setupRequired || !hidden || leavingHiddenModuleRef.current) return;
    const app = activeApp;
    // A note that could not be saved keeps Notes open (the toast says why) until the choice changes.
    const attempt = `${app}:${disabledModules.join(",")}`;
    if (hiddenLeaveFailedRef.current === attempt) return;
    leavingHiddenModuleRef.current = true;
    void (async () => {
      try {
        // Leaving Notes saves or publishes the open note first, as any other way out does.
        if (app === "notes" && !await leaveNotes()) {
          hiddenLeaveFailedRef.current = attempt;
          return;
        }
        hiddenLeaveFailedRef.current = null;
        setModuleHint(hidden);
        setActiveApp("home");
        navigate({ app: "home" }, { replace: true });
      } finally {
        leavingHiddenModuleRef.current = false;
      }
    })();
  });
  useEffect(() => {
    if (previousAppRef.current === "team" && activeApp !== "team") setTeamViaSettings(false);
    previousAppRef.current = activeApp;
  }, [activeApp]);
  useEffect(() => {
    if (moduleHint && (isModuleEnabled(disabledModules, moduleHint) || activeApp !== "home")) setModuleHint(null);
  }, [activeApp, disabledModules, moduleHint]);
  // Search turned off: drop any query so the Notes list is not left filtered by a hidden box.
  useEffect(() => {
    if (!searchEnabled && query) clearSearch();
  }, [searchEnabled, query]);

  function openSettings(section: SettingsSection = "security") {
    setPanel(null);
    setSharingFolder(null);
    setSettingsSection(section);
    setSettingsOpen(true);
    if (!session || session.totp.setupRequired) return;
    const state = window.history.state as Record<string, unknown> | null;
    if (parseSettingsPath(window.location.pathname)) {
      window.history.replaceState(state, "", settingsPath(section));
      return;
    }
    // Settings pushes an entry (Wave 28), remembering the URL it opened over.
    const depth = readHistoryDepth(state);
    window.history.pushState(withHistoryDepth({ ...(state ?? {}), "mynotes.settings-over": locationUrl(window.location) }, depth + 1), "", settingsPath(section));
    historyDepthRef.current = depth + 1;
  }

  /** The dialog moved to another section: the URL follows in place (no new entry). */
  function settingsSectionChanged(section: SettingsSection) {
    setSettingsSection(section);
    if (parseSettingsPath(window.location.pathname)) window.history.replaceState(window.history.state, "", settingsPath(section));
  }

  /**
   * Closes Settings. From its own entry, "back" steps back onto the entry it opened over (so Forward
   * reopens it); "replace" rewrites the entry to that URL, for a navigation that follows at once.
   * A deep link at depth 0 has nothing below, so it is replaced with Home.
   */
  function closeSettings(mode: "back" | "replace" = "back") {
    setSettingsOpen(false);
    settingsPendingRef.current = false;
    if (!parseSettingsPath(window.location.pathname)) return;
    const state = window.history.state as Record<string, unknown> | null;
    const over = typeof state?.["mynotes.settings-over"] === "string" ? state["mynotes.settings-over"] as string : "/";
    if (mode === "back" && readHistoryDepth(state) > 0) {
      window.history.back();
      return;
    }
    const { ["mynotes.settings-over"]: _over, ...rest } = state ?? {};
    window.history.replaceState(rest, "", over);
  }

  function signOut() {
    logout().catch((reason) => flash(reason instanceof Error ? reason.message : "Could not sign out"));
  }

  async function logout() {
    // T69: forget this device's push subscription and service worker while the session still works.
    await forgetThisDevice();
    await api("/auth/logout", { method: "POST", body: "{}" });
    sessionUserRef.current = null;
    noteLoadGenerationRef.current += 1;
    setCsrfToken("");
    cancelPendingAutosave();
    setSelectedFolder("all");
    setSelectedNoteId(null);
    setNote(null);
    setMarkdown("");
    setFolders([]);
    setNotes([]);
    setSelectionOwner(null);
    setQuery("");
    setSearchAll(false);
    searchHintRef.current = null;
    revisionRef.current = null;
    loadedRef.current = "";
    newlyCreatedNoteIdRef.current = null;
    routeAppliedUserRef.current = null;
    startupFailedUserRef.current = null;
    pendingRouteRef.current = { app: "home" };
    initialSettingsRef.current = null;
    // A bare entry: drops the search hint (the query text) and every other hint from the current
    // entry. Older entries keep theirs, but each is tied to the user id and ignored while signed out.
    window.history.replaceState(null, "", "/");
    setActiveApp("home");
    setSession(null);
  }

  if (checking) return <main className="loading-page"><div className="brand-mark"><Sparkles /></div><span>Opening Nook…</span></main>;
  const acceptSession = (result: SessionResponse) => {
    sessionUserRef.current = result.user.id;
    noteLoadGenerationRef.current += 1;
    cancelPendingAutosave();
    setSelectedFolder("all");
    setSelectedNoteId(null);
    setNote(null);
    setMarkdown("");
    setFolders([]);
    setNotes([]);
    setSelectionOwner(null);
    revisionRef.current = null;
    loadedRef.current = "";
    newlyCreatedNoteIdRef.current = null;
    routeAppliedUserRef.current = null;
    // Land on the URL that was requested before signing in (kept in memory only).
    setActiveApp((pendingRouteRef.current ?? routeFromLocation(window.location)).app);
    setSession(result);
    setChecking(false);
  };
  const leaveInvite = () => {
    setInvite({ onRegister: false, token: null });
    pendingRouteRef.current = { app: "home" };
    window.history.replaceState(null, "", "/");
  };
  // Sign in → Forgot password? is a history entry of its own: Back returns to sign in, Forward reopens it.
  const openForgotPassword = () => {
    window.history.pushState({ nookPasswordPage: "forgot" }, "", FORGOT_PATH);
    setPasswordLink({ kind: "forgot" });
  };
  const leaveForgotPassword = () => {
    if ((window.history.state as { nookPasswordPage?: string } | null)?.nookPasswordPage === "forgot") {
      window.history.back();
      return;
    }
    setPasswordLink(null);
    window.history.replaceState(null, "", "/");
  };
  const openForgotFromReset = () => {
    window.history.replaceState({ nookPasswordPage: "forgot-landing" }, "", FORGOT_PATH);
    setPasswordLink({ kind: "forgot" });
  };
  // A reset signs every session out, this browser's too: reload onto the sign-in page.
  const leavePasswordReset = () => {
    setPasswordLink(null);
    window.location.replace("/");
  };
  const leaveMailLink = () => {
    setMailLink(null);
    pendingRouteRef.current = { app: "home" };
    window.history.replaceState(null, "", "/");
  };
  // Signed in, /forgot-password (a Back onto an old entry) is just Home; a reset link still opens.
  if (passwordLink?.kind === "forgot" && !session) return <ForgotPasswordPage onBack={leaveForgotPassword} />;
  if (passwordLink?.kind === "reset") return <ResetPasswordPage token={passwordLink.token} signedIn={Boolean(session)} onForgot={openForgotFromReset} onSignIn={leavePasswordReset} />;
  if (mailLink?.kind === "verify") return <VerifyEmailPage token={mailLink.token} signedIn={Boolean(session)} onContinue={leaveMailLink} />;
  // "Manage all email settings" loads the Settings deep link (signing in first when needed).
  if (mailLink?.kind === "unsubscribe") return <UnsubscribePage token={mailLink.token} onContinue={leaveMailLink} onManage={() => window.location.assign(settingsPath("notifications"))} />;
  if (invite.onRegister && !session) return <InviteRegister token={invite.token} onSignIn={leaveInvite} onRegister={async (body: InviteRegisterBody) => {
    const result = await api<SessionResponse>("/auth/register", { method: "POST", body: JSON.stringify(body) });
    setCsrfToken(result.csrfToken);
    // After registering, replace /register with Today (§1.6): Back never returns to the used link.
    leaveInvite();
    acceptSession(result);
  }} />;
  if (invite.onRegister && session) return <InviteWhileSignedIn displayName={session.user.displayName} onContinue={leaveInvite} onSignOut={() => {
    logout().then(() => window.history.replaceState(null, "", "/register"), (reason) => flash(reason instanceof Error ? reason.message : "Could not sign out"));
  }} />;
  if (!session) return <AuthScreen onAuthenticated={acceptSession} onForgotPassword={openForgotPassword} />;

  const modulesSettings: ModulesSettingsProps = { disabledModules: modulePreferences.preferences.disabledModules, status: modulePreferences.status, onToggle: modulePreferences.setModuleEnabled, role: session.user.role };
  // Admins keep "Manage team" in Settings even when Team is hidden (Team plan §6.2), so the route gate
  // lets that one visit through; Back, Forward, and links still follow the toggle.
  const settingsDialog = settingsOpen && <SettingsDialog session={session} modules={modulesSettings} initialSection={settingsSection} onSectionChange={settingsSectionChanged} pendingRef={settingsPendingRef} onManageTeam={() => { closeSettings("replace"); void openTeamViaSettings(setTeamViaSettings, () => openApp("team")); }} onClose={() => { if (!session.totp.setupRequired) closeSettings(); }} onSecurityChanged={(totp) => {
    setSession((current) => current ? { ...current, totp } : current);
    if (!totp.setupRequired) closeSettings();
  }} />;
  const toastStatus = <>{toast && <div className="toast" role="status">{toast}</div>}{moduleHint && <div className="module-hint" role="status">
    <p>{moduleOffHint(moduleHint)}</p>
    <button className="secondary-button" onClick={() => { setModuleHint(null); openSettings("modules"); }}>Turn on in Settings</button>
    <button className="icon-button" onClick={() => setModuleHint(null)} aria-label="Dismiss"><X /></button>
  </div>}</>;
  const openBin = binEnabled ? () => { void openApp("bin"); } : undefined;
  // A hidden module's view never renders, even for the moment before the gate above replaces its route.
  const shownApp: AppSection = activeApp !== "notes" && !teamGateOpen && !isAppEnabled(disabledModules, activeApp) ? "home" : activeApp;
  const account = { displayName: session.user.displayName, onSettings: () => openSettings(), onSignOut: signOut };

  // Notifications off (D92): no provider, so every bell renders nothing and stops polling.
  const notificationsContext = isModuleEnabled(disabledModules, "notifications") ? { openList: () => { void openApp("notifications"); }, openPath: openNotificationPath } : null;
  const teamNav = { role: session.user.role, openTeam: () => { void openApp("team"); }, onTeam: shownApp === "team" };
  const inboxNav = { role: session.user.role, openInbox: () => { void openApp("inbox"); }, onInbox: shownApp === "inbox" };
  // The Inbox opens a proposal's target as a new entry: a note through the Notes loader, anything else by its route.
  const openInboxPath = (path: string) => {
    const route = parseRoute(path);
    if (route.app === "notes" && route.noteId) openLinkedNote(route.noteId);
    else openNotificationPath(path);
  };

  if (shownApp !== "notes" && !session.totp.setupRequired) return <ModulesContext.Provider value={disabledModules}><RoleContext.Provider value={session.user.role}><NotificationsContext.Provider value={notificationsContext}><TeamNavContext.Provider value={teamNav}><InboxNavContext.Provider value={inboxNav}>
    {shownApp === "home" ? <TodayHome {...account} userId={session.user.id} onOpen={(section) => { void openApp(section); }} onOpenRoute={(route) => { void openTodayRoute(route); }} />
      : shownApp === "files" ? <FilesApp {...account} userId={session.user.id} navigate={navigate} flash={flash} onHome={() => { void openHome(); }} onBin={openBin} />
      : shownApp === "tasks" ? <TasksApp {...account} userId={session.user.id} navigate={navigate} flash={flash} onHome={() => { void openHome(); }} onBin={openBin} />
      : shownApp === "collections" ? <CollectionsApp {...account} userId={session.user.id} navigate={navigate} flash={flash} onHome={() => { void openHome(); }} onBin={openBin} />
      : shownApp === "calendar" ? <CalendarApp key={calendarKey} {...account} userId={session.user.id} navigate={navigate} flash={flash} onHome={() => { void openHome(); }} onOpenNote={openLinkedNote} />
      : shownApp === "notifications" ? <NotificationsApp {...account} onHome={() => { void openHome(); }} onOpenPath={openNotificationPath} />
      : shownApp === "team" ? <TeamApp {...account} role={session.user.role ?? "member"} navigate={navigate} flash={flash} onHome={() => { void openHome(); }} onBin={openBin} />
      : shownApp === "inbox" ? <InboxApp {...account} navigate={navigate} flash={flash} onHome={() => { void openHome(); }} onBin={openBin} onOpenPath={openInboxPath} />
      : <BinApp {...account} flash={flash} onHome={() => { void openHome(); }} onRestored={(item) => { if (item.type === "note") void loadNavigation().catch(() => undefined); }} />}
    {settingsDialog}
    {settingsOpen && <button className="panel-scrim" onClick={() => closeSettings()} aria-label="Close panel" />}
    {toastStatus}
  </InboxNavContext.Provider></TeamNavContext.Provider></NotificationsContext.Provider></RoleContext.Provider></ModulesContext.Provider>;

  // Viewers and guests read notes; create, edit, share, and delete controls are hidden (Wave 15).
  const canWrite = canWriteContent(session.user.role);
  return (
    <ModulesContext.Provider value={disabledModules}>
    <RoleContext.Provider value={session.user.role}>
    <main className={`workspace ${collapsed ? "nav-collapsed" : ""}`} data-mobile-panel={mobilePanel}>
      <aside className="folder-pane" id="note-folders">
        <header className="sidebar-header">
          <button className="sidebar-brand sidebar-home-button" onClick={() => { void openHome(); }} aria-label="Open Nook home" title="Back to Home"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>Notes</strong></span></button>
          <button className="icon-button desktop-only" onClick={() => setCollapsed(true)} aria-label="Collapse folders sidebar" aria-controls="note-folders" aria-expanded={!collapsed} title="Collapse folders"><PanelLeftClose /></button>
        </header>
        <nav className="folder-nav" aria-label="Note folders">
          <button className="nav-home" onClick={() => { void openHome(); }} title="Back to Home"><House /><span>Home</span></button>
          <button className={selectedFolder === "all" ? "active" : ""} onClick={() => { void selectFolder("all"); }}><Archive /><span>All notes</span><b>{notes.length}</b></button>
          <button className={selectedFolder === "shared" ? "active" : ""} onClick={() => { void selectFolder("shared"); }}><Users /><span>Shared with me</span><b>{notes.filter((item) => item.is_owner === 0).length}</b></button>
          <div className="nav-label"><span>Folders</span>{canWrite && <button onClick={createFolder} aria-label="New folder"><FolderPlus /></button>}</div>
          {folders.map((folder) => <div className="folder-entry" key={folder.id}>
            <button
              className={`folder-link${selectedFolder === folder.id ? " active" : ""}${dropFolderId === folder.id ? " drop-target" : ""}`}
              onClick={() => { void selectFolder(folder.id); }}
              onDragEnter={(event) => { if (draggingNoteId && folder.is_owner === 1 && canWrite) { event.preventDefault(); setDropFolderId(folder.id); } }}
              onDragOver={(event) => { if (draggingNoteId && folder.is_owner === 1 && canWrite) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropFolderId((current) => current === folder.id ? null : current); }}
              onDrop={(event) => {
                event.preventDefault();
                if (folder.is_owner !== 1) return;
                const noteId = event.dataTransfer.getData("application/x-mynotes-note") || draggingNoteId;
                if (noteId) moveNote(noteId, folder).catch((reason) => flash(reason instanceof Error ? reason.message : "Could not move note"));
              }}
            >
              <FolderIcon />
              <span className="folder-copy">{folder.name}{folder.is_owner !== 1 && <small>{folder.owner_name}</small>}</span>
              <b>{notes.filter((item) => item.folder_id === folder.id).length}</b>
            </button>
            {folder.is_owner === 1 && canWrite && <button className="folder-share-button" onClick={() => setSharingFolder(folder)} aria-label={`Share ${folder.name}`}><Share2 /></button>}
          </div>)}
          {!folders.length && <p className="nav-empty">Create a folder to organize your notes.</p>}
        </nav>
        <footer className="sidebar-footer">
          <button className="footer-settings" title={session.user.displayName} onClick={() => openSettings()} aria-haspopup="dialog" aria-controls="account-settings-dialog" aria-label={`Open settings for ${session.user.displayName}`}>
            <strong>{session.user.displayName}</strong>
            <span><Settings />Settings</span>
          </button>
          {openBin && <button className="footer-bin" onClick={openBin}><Trash2 />Bin</button>}
          <SidebarInboxRow nav={inboxNav} />
          <button className="footer-signout" onClick={signOut}><LogOut />Sign out</button>
        </footer>
      </aside>

      <section className="note-pane">
        <header className="note-pane-header">
          <button className="icon-button collapsed-trigger collapsed-sidebar-toggle" onClick={() => setCollapsed(false)} aria-label="Open folders sidebar" aria-controls="note-folders" aria-expanded={!collapsed} title="Open folders"><PanelLeftOpen /><span>Folders</span></button>
          <div className="mobile-header"><button className="icon-button" onClick={() => mobileBack("folders")} aria-label="Back to folders"><ChevronLeft /></button><strong>Notes</strong></div>
          <div className="note-heading"><span className="eyebrow">{selectedFolder === "shared" ? "Shared" : "Library"}</span><h1>{selectedFolder === "all" ? "All notes" : selectedFolder === "shared" ? "Shared with me" : folders.find((folder) => folder.id === selectedFolder)?.name}</h1></div>
          <div className="note-header-actions">
            <div className="sort-control">
              <button className="icon-button" onClick={() => setSortOpen((open) => !open)} aria-label="Sort notes" aria-expanded={sortOpen}><ArrowUpDown /></button>
              {sortOpen && <div className="sort-menu" role="menu" aria-label="Sort notes">
                {noteSortOptions.map((option) => <button key={option.value} className={noteSort === option.value ? "active" : ""} onClick={() => { setNoteSort(option.value); setSortOpen(false); }} role="menuitem"><span>{option.label}</span>{noteSort === option.value && <Check />}</button>)}
              </div>}
            </div>
            {canWrite && <button className="icon-button new-note-button" onClick={createNote} aria-label="New note"><FilePlus2 /></button>}
          </div>
          {searchEnabled && <div className="search-box">
            <Search aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              maxLength={SEARCH_MAX_CHARS}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search notes"
              aria-label="Search notes"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={showingSearchResults}
              aria-controls={searchListId}
              aria-activedescendant={activeSearchHit ? searchOptionId(activeSearchHit.id) : undefined}
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
            />
            {query ? <button type="button" className="search-clear" onClick={() => { clearSearch(); searchInputRef.current?.focus(); }} aria-label="Clear search"><X /></button> : <kbd aria-hidden="true">/</kbd>}
          </div>}
          {search.active && selectedFolder !== "all" && <div className="search-scope">
            {!searchAll && <span>Searching {selectedFolder === "shared" ? "Shared with me" : folders.find((folder) => folder.id === selectedFolder)?.name ?? "this folder"}</span>}
            <button type="button" className="search-scope-chip" aria-pressed={searchAll} onClick={() => setSearchAll((all) => !all)}>{searchAll ? <Check aria-hidden="true" /> : <Archive aria-hidden="true" />}Search all notes</button>
          </div>}
          <p className="sr-only" aria-live="polite" aria-atomic="true">{showingSearchResults ? (search.results.length ? `${search.results.length}${search.truncated ? " or more" : ""} ${search.results.length === 1 && !search.truncated ? "result" : "results"}` : "No results") : ""}</p>
        </header>
        <ReadOnlyBanner />
        <div className="note-list">
          {search.status === "error" && <p className="search-error" role="alert">{search.error}</p>}
          {showingSearchResults && <SearchResults
            results={search.results}
            truncated={search.truncated}
            activeIndex={activeSearchIndex}
            selectedNoteId={selectedNoteId}
            folders={folders}
            relativeTime={relativeTime}
            onOpen={openSearchHit}
            onHover={setActiveSearchIndex}
          />}
          {showingSearchResults && !search.results.length && <div className="empty-state"><div><Search /></div><h2>No matches</h2><p>{searchAll || selectedFolder === "all" ? "Try other words, or fewer of them." : "Try other words, or search all notes."}</p></div>}
          {!showingSearchResults && visibleNotes.map((item) => <article
            key={item.id}
            className={`note-card${selectedNoteId === item.id ? " selected" : ""}${draggingNoteId === item.id ? " dragging" : ""}`}
            draggable={item.is_owner === 1 && canWrite}
            onDragStart={(event) => {
              if (item.is_owner !== 1 || !canWrite) return;
              setDraggingNoteId(item.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("application/x-mynotes-note", item.id);
              event.dataTransfer.setData("text/plain", item.id);
            }}
            onDragEnd={() => { setDraggingNoteId(null); setDropFolderId(null); }}
          >
            <button className="note-card-select" onClick={() => { void selectNote(item.id); }}>
              <span className="note-title">{item.title}</span>
              <span className="note-meta"><time>{relativeTime(item.updated_at)}</time>{item.draft_revision !== null && item.is_owner === 1 ? (item.draft_mcp_key_name ? <em className="mcp-draft-badge"><Bot aria-hidden="true" />{mcpDraftBadge(item.draft_mcp_key_name)}</em> : <em>Draft</em>) : item.visibility !== "private" ? <em><Users /> Shared</em> : null}</span>
              {item.is_owner === 0 && <span className="note-owner">by {item.owner_name}</span>}
            </button>
            {item.is_owner === 1 && canWrite && <button className="note-delete-button" disabled={editorLocked} onClick={(event) => askDeleteNote(item.id, item.title, event.currentTarget)} aria-label={`Delete ${item.title}`} title="Delete note"><Trash2 /></button>}
          </article>)}
          {!showingSearchResults && !visibleNotes.length && <div className="empty-state"><div><FilePlus2 /></div><h2>No notes here</h2><p>{query ? (search.status === "loading" ? "Searching note text…" : "Try another search.") : selectedFolder === "shared" ? "Notes shared with you will appear here." : (canWrite ? "Create a note and start writing." : "Notes shared with you appear here.")}</p>{!query && selectedFolder !== "shared" && canWrite && <button onClick={createNote}>New note</button>}</div>}
        </div>
      </section>

      <section className="editor-pane">
        {!note ? <div className="editor-empty"><div className="empty-glyph"><Sparkles /></div><h2>Select a note</h2><p>Choose one from the list or create something new.</p></div> : <>
          <header className="editor-toolbar">
            <div className="mobile-editor-nav"><button className="icon-button" onClick={() => mobileBack("notes")} aria-label="Back to notes"><ChevronLeft /></button></div>
            <div className={`save-indicator ${saveState}`}><span />{saveState === "saving" ? "Saving…" : saveState === "conflict" ? "Save conflict" : saveState === "error" ? "Not saved" : note.hasDraft ? "Draft saved" : `Version ${note.current_version}`}</div>
            {draftBadge && <span className="mcp-draft-badge" title="Written through an MCP API key. It stays a draft until you publish it."><Bot aria-hidden="true" />{draftBadge}</span>}
            <div className="toolbar-actions">
              <button className="icon-button" onClick={() => setPanel("history")} aria-label="Version history"><History /></button>
              <button className="icon-button" onClick={downloadPdf} aria-label="Download as PDF" title="Download as PDF"><FileDown /></button>
              {note.isOwner && canWrite && <button className="icon-button" onClick={() => setPanel("share")} aria-label="Share note"><Share2 /></button>}
              {note.isOwner && canWrite && note.hasDraft && <button className="text-action" disabled={editorLocked} onClick={() => { void discard(); }}>Discard</button>}
              {hasPublishableDelta && canWrite && <button className="publish-button" disabled={editorLocked} onClick={() => { void publish(); }}>Publish version</button>}
              <button className="icon-button mobile-more" disabled={editorLocked} onClick={() => setMobileActions((open) => !open)} aria-label="More actions"><MoreHorizontal /></button>
            </div>
            {mobileActions && <div className="mobile-actions-menu">
              <button onClick={() => { setPanel("history"); setMobileActions(false); }}><History />Version history</button>
              <button onClick={() => { setMobileActions(false); downloadPdf(); }}><FileDown />Download as PDF</button>
              {note.isOwner && canWrite && <button onClick={() => { setPanel("share"); setMobileActions(false); }}><Share2 />Share note</button>}
              {note.isOwner && canWrite && note.hasDraft && <button disabled={editorLocked} onClick={() => { setMobileActions(false); void discard(); }}><X />Discard draft</button>}
              {hasPublishableDelta && canWrite && <button disabled={editorLocked} onClick={() => { setMobileActions(false); void publish(); }}><Sparkles />Publish version</button>}
            </div>}
          </header>
          <article className="document-shell">
            <div className="document-meta"><span>{note.isOwner ? "Private workspace" : `Shared by ${note.owner_name}`}</span><i /> <span>{markdown.trim().split(/\s+/).filter(Boolean).length} words</span></div>
            <NoteEditor key={note.id} markdown={markdown} editable={note.isOwner && canWrite && !editorLocked} onChange={(value) => { sessionEditedRef.current = note.id; setMarkdown(value); }} folderId={note.folder_id} onNotice={flash} />
          </article>
        </>}
      </section>

      {panel === "history" && note && <HistoryPanel note={note} canRestore={canWrite} onClose={() => setPanel(null)} onRestored={async () => { setPanel(null); await loadNote(note.id); await loadNavigation(); flash("Version restored as a draft"); }} />}
      {panel === "share" && note && <SharePanel note={note} onClose={() => setPanel(null)} onChanged={async () => { setPanel(null); await loadNote(note.id); await loadNavigation(); flash("Sharing updated"); }} />}
      {deletingNote && <NoteDeleteConfirm title={deletingNote.title}
        onCancel={() => { setDeletingNote(null); focusAfterDeleteConfirm(); }}
        onConfirm={() => {
          const target = deletingNote;
          setDeletingNote(null);
          void deleteNote(target.id).catch((reason) => flash(reason instanceof Error ? reason.message : "Could not delete note")).finally(focusAfterDeleteConfirm);
        }} />}
      {sharingFolder && <FolderSharePanel folder={sharingFolder} onClose={() => setSharingFolder(null)} onChanged={async () => { setSharingFolder(null); await loadNavigation(); flash("Folder sharing updated"); }} />}
      {settingsDialog}
      {(panel || sharingFolder || settingsOpen) && (settingsOpen && session.totp.setupRequired
        ? <div className="panel-scrim" aria-hidden="true" />
        : <button className="panel-scrim" onClick={() => { setPanel(null); setSharingFolder(null); if (settingsOpen) closeSettings(); }} aria-label="Close panel" />)}
      {toastStatus}
      <nav className="mobile-tabbar">
        <button className={mobilePanel === "folders" ? "active" : ""} onClick={() => showMobilePanel("folders")}><Menu />Folders</button>
        <button className={mobilePanel === "notes" ? "active" : ""} onClick={() => showMobilePanel("notes")}><Archive />Notes</button>
        <button className={mobilePanel === "editor" ? "active" : ""} disabled={!note} onClick={() => showMobilePanel("editor")}><Sparkles />Editor</button>
      </nav>
    </main>
    </RoleContext.Provider>
    </ModulesContext.Provider>
  );
}
