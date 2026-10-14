import { lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Bot,
  ArrowUpDown,
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
  FileText,
  Folder as FolderIcon,
  FolderPlus,
  History,
  Info,
  FolderInput,
  Lock,
  LogOut,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PenTool,
  Search,
  Settings,
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
import { BinSection } from "./bin/BinSection";
import { InboxApp } from "./inbox/InboxApp";
// Whiteboards (Wave 23) load as their own chunks: the list here, and the Excalidraw canvas inside it
// (D191), so nobody who never opens Whiteboards downloads either.
const WhiteboardsApp = lazy(() => import("./whiteboards/WhiteboardsApp").then((module) => ({ default: module.WhiteboardsApp })));
// The Vault (Wave 25) is its own chunk too: nobody who never opens it downloads it.
const VaultApp = lazy(() => import("./vault/VaultApp").then((module) => ({ default: module.VaultApp })));
// Chat (Wave 40) and its Settings screens are one lazy chunk: the Markdown renderer loads only when a chat opens.
const ChatApp = lazy(() => import("./chat/ChatApp").then((module) => ({ default: module.ChatApp })));
const AiSettings = lazy(() => import("./chat/AiSettings").then((module) => ({ default: module.AiSettings })));
const AgentsSettings = lazy(() => import("./chat/AgentsSettings").then((module) => ({ default: module.AgentsSettings })));
const KnowledgeSettings = lazy(() => import("./chat/KnowledgeSettings").then((module) => ({ default: module.KnowledgeSettings })));
// Analytics reports (Wave 45): the app and Settings → Report data sources are their own chunks.
const ReportsApp = lazy(() => import("./reports/ReportsApp").then((module) => ({ default: module.ReportsApp })));
const ReportDataSources = lazy(() => import("./settings/ReportDataSources").then((module) => ({ default: module.ReportDataSources })));
import { lineDiff } from "./diff/lineDiff";
import { TeamSection } from "./team/TeamApp";
import { useBlockedCount } from "./team/blockedCount";
import { SettingsHubShell } from "./settings/SettingsHub";
import { aiTabRedirect, aiTabsFor, binEntryShown, hubBackAction, hubBackSteps, hubEntries, hubEntryLabel, hubEntryOf, hubListGoesUnder, hubPopRoute, isHubRoute, isNestedHubRoute, keysTabRedirect, keysTabsFor, leaveGuardAction, settingsRoute, teamGroupShown, type HubEntry, type HubEntryId } from "./settings/hubModel";
import { HubBeforeLeaveContext, type BeforeHubLeave } from "./settings/hubLeave";
import { InviteRegister, InviteWhileSignedIn, type InviteRegisterBody } from "./auth/InviteRegister";
import { initialInvite } from "./auth/inviteLink";
import { passwordResetOffered, registrationPrompt, type RegistrationInfo } from "./auth/registrationPrompt";
import { initialMailLink, UnsubscribePage, VerifyEmailPage } from "./auth/mailPages";
import { FORGOT_PATH, ForgotPasswordPage, initialPasswordLink, ResetPasswordPage, takeNewResetLink, takePasswordLinkFromLocation } from "./auth/passwordPages";
import { ChangePasswordCard } from "./auth/ChangePassword";
import { RecognisedDevices } from "./auth/RecognisedDevices";
import { ProfilePictureCard } from "./settings/ProfilePicture";
import { Avatar, SelfAvatar } from "./ui/Avatar";
import { usePageScrollKeys, workspaceScroller } from "./ui/pageScrollKeys";
import { setSelfAvatar } from "./ui/selfAvatar";
import { AccountAuthContext, googleConfirmed, GoogleReauthNotice, reauthPassword, ReauthRouteToggle, useAccountAuthLoader, useReauthRoute } from "./auth/accountAuth";
import { RecoveryCodesDialog } from "./auth/RecoveryCodesDialog";
import { GoogleAccountCard, googleSettingsNotice, GoogleResetNoticeBanner, PasswordStateCard, type GoogleResetNotice } from "./auth/GoogleAccountCard";
import { AuthDivider, currentReturnPath, googleOnlyHint, GoogleButton, googleErrorMessage, googleStartUrl, LINK_NOT_AUTHORITATIVE_PASSWORD, linkRequiredText, initialGoogleSettingsResult, initialGoogleSignInResult, initialGoogleTeamResult, type GoogleSettingsResult, type GoogleSignInResult } from "./auth/googleSignIn";
import { AccountActions, InboxNavContext, SidebarInboxRow, useBinCount } from "./AppShell";
import { repeatDelta, useLeaveGuard } from "./ui/useLeaveGuard";
import { canManageTeam, canWriteContent, type Role } from "./team/teamRoles";
import { ReadOnlyBanner, RoleContext } from "./team/roleAccess";
import { FilesApp } from "./files/FilesApp";
import { TasksApp } from "./tasks/TasksApp";
import { CollectionsApp } from "./collections/CollectionsApp";
import { carriedCollectionsState } from "./collectionsRoute";
import { carriedTasksState } from "./tasksNavigation";
import { CalendarApp } from "./calendar/CalendarApp";
import { NotificationsApp } from "./notifications/NotificationsApp";
import { publishedElsewhere, usePublishWatch } from "./editor/publishWatch";
import { NotificationsContext } from "./notifications/notificationsApi";
import { NotificationSettings } from "./notifications/NotificationSettings";
import { forgetThisDevice } from "./notifications/pushClient";
import { appName, setAppName } from "./appName";
import { carriedCalendarState } from "./calendarNavigation";
import { calendarHomeRoute, localDate } from "./calendarRoute";
import { dialogPopDirection, popStateClosedDialog, takeDialogSentinelEntry, undoDialogPop, whenHistorySettled, type PopDirection } from "./historyDialogs";
import { createFilesHistoryState, readFilesHistorySnapshot, sameFilesSnapshot, type FilesPanel } from "./filesNavigation";
import { resolveFilesPanel } from "./filesRoute";
import { NoteEditor, type NoteUploadControl } from "./editor/NoteEditor";
import { LEAVE_UPLOADS_CONFIRM } from "./editor/uploadSlots";
import { BinnedFilesConfirm } from "./editor/BinnedFilesConfirm";
import { clearCardSummaries, OPEN_PATH_EVENT } from "./editor/whiteboardEmbed";
import { createHistoryState, isMobileViewport, readHistorySnapshot, sameSnapshot, type FolderSelection, type MobileNavigationSnapshot, type MobilePanel } from "./mobileNavigation";
import { createAppHistoryState, readHistoryDepth, resolveAppHistorySection, startupRouteState, withHistoryDepth, type AppSection } from "./appShellNavigation";
// Settings → API keys (Wave 31) replaced the MCP server section; the section id stays "mcp".
import { KeysSettings } from "./keys/KeysSettings";
import { unsavedKeyConfirm } from "./keys/unsavedKeyConfirm";
import { IntegrationBadge } from "./ui/IntegrationBadge";
import { MyAccess } from "./settings/MyAccess";
import { ConfirmDialog } from "./files/Dialog";
import { useConfirm } from "./ui/useConfirm";
import { NameDialog } from "./files/RenameDialog";
import { MoveSheet } from "./files/MoveSheet";
import { collectProblems, emailProblem, FieldError, fieldName, newPasswordProblem, secondFactorProblem, securityFormProblem, useFieldErrors } from "./auth/fieldChecks";
import { FormError } from "./ui/FormError";
import { validateFolderName } from "./files/fileActions";
import { useHistoryDialogGuard } from "./ui/useHistoryDialogGuard";
import { clearPendingForUser, countPendingForUser } from "./whiteboards/pendingStore";
import { usePendingWhiteboardSync } from "./whiteboards/pendingSync";
import { AccessSheet } from "./access/AccessSheet";
import { notifyBinChanged } from "./bin/binApi";
import { notifyBinned } from "./bin/binUndo";
import { canPublish, DRAFT_CHANGED_MESSAGE, finalizeOpenNote, isDraftChangedError, mcpDraftBadge, shouldAutoPublish } from "./noteFinalization";
import { confirmLaterMessage, confirmRequiredOf, publishFilesConfirm } from "./publishFilesConfirm";
import { formatRoute, hubDocumentTitle, keysTabRoute, locationUrl, parseRoute, routeFromLocation, SETTINGS_SECTION_NAMES, settingsDocumentTitle, settingsPath, type KeysTab, type Route, type SettingsSection } from "./router";
import { noteInFolder, notesRoute, resolveNotesPanel, resolveNotesRoute, type NotesRoute } from "./notesRoute";
import type { BinItem, Folder, NoteDetail, NoteSummary, User, Version } from "./types";
import { SearchResults, searchListId, searchOptionId } from "./search/SearchResults";
import { isSearchPushedEntry, markSearchPushed, nextSearchHint, readSearchHint, sameSearchHint, withSearchHint, type SearchHint } from "./search/searchHistory";
import { SEARCH_MAX_CHARS, type NoteSearchHit } from "./search/searchApi";
import { useNoteSearch } from "./search/useNoteSearch";
import { useWhiteboardSearch, WhiteboardSearchResults } from "./search/WhiteboardSearchResults";
import { ModulesSettings } from "./ModulesSettings";
import { hiddenEntryStep, hiddenModuleForApp, normalizeDisabledModules, recordPopDepth, isAppEnabled, isModuleEnabled, moduleOffHint, ModulesContext, parsePreferences, routeGateModules, unavailableModules, type ModuleId, moduleDef } from "./modules";
import { usePreferences, type PreferencesStatus } from "./usePreferences";
import { errorText, flash as flashToast, notify } from "./ui/notify";

type TotpState = { enabled: boolean; required: boolean; setupRequired: boolean };
/** The Security section's forms, so a problem shows in the one that was sent. */
type SecurityForm = "setup" | "verify" | "view" | "regenerate" | "disable";
// `preferences` comes with /api/auth/me only (not with sign-in); see usePreferences.
// `notices` (Wave 35 review N2c) comes with /api/auth/me only.
type SessionResponse = { user: User; csrfToken: string; totp: TotpState; preferences?: unknown; notices?: { googleReset?: GoogleResetNotice | null }; features?: { vault?: boolean; agents?: boolean; chatRoleOff?: boolean; reports?: boolean }; app?: { name?: string } };
type ModulesSettingsProps = { disabledModules: readonly ModuleId[]; status: PreferencesStatus; onToggle: (id: ModuleId, enabled: boolean) => void; role?: Role; unavailable?: readonly ModuleId[] };
type NoteSort = "updated-desc" | "updated-asc" | "created-desc" | "created-asc" | "title-asc" | "title-desc";

const noteSortOptions: Array<{ value: NoteSort; label: string }> = [
  { value: "updated-desc", label: "Recently edited" },
  { value: "updated-asc", label: "Oldest edited" },
  { value: "created-desc", label: "Recently added" },
  { value: "created-asc", label: "Oldest added" },
  { value: "title-asc", label: "Title A–Z" },
  { value: "title-desc", label: "Title Z–A" }
];

/** Settings → Security when the instance has no TOTP key (A7): nothing to set up. */
export const TWO_FACTOR_OFF_TEXT = "Two-factor authentication has not been set up for this Nook, so it cannot be turned on for your account yet. Ask an admin of this Nook.";

/** Popstate events a pasted reset link took (A5): the route handlers leave them alone. */
const resetLinkEvents = new WeakSet<Event>();

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

function AuthScreen({ onAuthenticated, onForgotPassword, googleResult = null }: { onAuthenticated: (session: SessionResponse) => void; onForgotPassword: () => void; googleResult?: GoogleSignInResult }) {
  const [registering, setRegistering] = useState(false);
  const [busy, setBusy] = useState(false);
  // Password form errors stay in the form; Google flow messages get their own notice by the Google
  // button (QA U6), and link_required its own explanation (review HIGH-1).
  const [error, setError] = useState("");
  const [googleNotice, setGoogleNotice] = useState(googleResult?.kind === "error" && googleResult.code !== "link_required" ? googleErrorMessage(googleResult.code, googleResult.domain) : "");
  const [linkRequired, setLinkRequired] = useState(googleResult?.kind === "error" && googleResult.code === "link_required");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [registration, setRegistration] = useState<RegistrationInfo | null | "failed">(null);
  const fields = useFieldErrors();
  // Wave 35 (D296): Google proved the account; the Nook code finishes the sign-in.
  const [googleCode, setGoogleCode] = useState(googleResult?.kind === "code");
  // QA U2: nothing but a placeholder until /api/about says which methods are on (no flash of the
  // wrong form); a failed request or an older server shows the password form as before.
  const methodsKnown = registration !== null;
  const methods = (registration !== "failed" ? registration?.authMethods : undefined) ?? { password: true, google: false };
  const signUpPrompt = methods.password ? registrationPrompt(registration === "failed" ? null : registration) : null;

  useEffect(() => {
    let live = true;
    api<RegistrationInfo>("/about").then((info) => { if (live) { setAppName(info.appName); setRegistration(info); } }, () => { if (live) setRegistration("failed"); });
    return () => { live = false; };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "");
    const codeName = useRecoveryCode ? "recoveryCode" : "totpCode";
    const problems = collectProblems(registering
      ? { displayName: text("displayName").trim() ? null : "Enter your name.", email: emailProblem(text("email")), password: newPasswordProblem(text("password")) }
      : { email: emailProblem(text("email")), password: text("password") ? null : "Enter your password.", [codeName]: needsTotp ? secondFactorProblem(text(codeName), useRecoveryCode) : null });
    if (fields.show(event.currentTarget, problems)) return;
    setBusy(true);
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

  async function submitGoogleCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const codeName = useRecoveryCode ? "recoveryCode" : "totpCode";
    if (fields.show(event.currentTarget, collectProblems({ [codeName]: secondFactorProblem(String(form.get(codeName) ?? ""), useRecoveryCode) }))) {
      setBusy(false);
      return;
    }
    try {
      const body = useRecoveryCode ? { recoveryCode: String(form.get("recoveryCode") ?? "").trim() } : { totpCode: String(form.get("totpCode") ?? "").trim() };
      const result = await api<{ returnTo: string }>("/auth/google/second-factor", { method: "POST", body: JSON.stringify(body) });
      // A full load of the page the person was heading to; Back never returns to this step.
      window.location.replace(result.returnTo || "/");
    } catch (reason) {
      const code = reason instanceof ApiError ? (reason.payload as { code?: string } | undefined)?.code : undefined;
      const message = reason instanceof ApiError && reason.status === 429 ? "Too many attempts. Try again soon." : reason instanceof Error ? reason.message : "Could not sign in";
      if (code === "FLOW_EXPIRED" || code === "ACCOUNT_BLOCKED") {
        setGoogleCode(false);
        setUseRecoveryCode(false);
        setGoogleNotice(message);
      } else setError(message);
      setBusy(false);
    }
  }

  /** QA U7: leave the two-factor step; the pending Google sign-in ends on the server too. */
  async function cancelGoogleCode() {
    setBusy(true);
    await api("/auth/google/cancel", { method: "POST", body: "{}" }).catch(() => undefined);
    setBusy(false);
    setGoogleCode(false);
    setUseRecoveryCode(false);
    setError("");
    fields.clear();
  }

  const heading = googleCode ? "One more step" : registering ? "Create your account" : "Welcome back";
  const googleButton = methods.google && !needsTotp && <GoogleButton href={googleStartUrl("signin", currentReturnPath())} />;

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="brand-mark"><Sparkles aria-hidden="true" /></div>
        <div className="auth-heading">
          <span className="eyebrow">{appName()}</span>
          <h1>{heading}</h1>
          <p>{googleCode ? "Google confirmed your account. Enter the code from your authenticator app to finish signing in." : "Your private workspace for ideas, passwords, and configuration notes."}</p>
        </div>
        {googleCode ? <form onSubmit={submitGoogleCode} className="auth-form" noValidate onChange={() => setError("")}>
          {useRecoveryCode
            ? <label>Recovery code<input name="recoveryCode" autoComplete="one-time-code" placeholder="ABCDE-FGHIJ-KLMNO" maxLength={32} autoFocus aria-invalid={fields.errors.recoveryCode ? true : undefined} /><small>Enter one complete backup recovery code. Each code works once.</small><FieldError id="google-recovery-error" message={fields.errors.recoveryCode} /></label>
            : <label>Six-digit authentication code<input name="totpCode" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" autoFocus aria-invalid={fields.errors.totpCode ? true : undefined} /><small>Enter the current six-digit number from your authenticator app.</small><FieldError id="google-code-error" message={fields.errors.totpCode} /></label>}
          <button type="button" className="inline-auth-switch" onClick={() => { setUseRecoveryCode((value) => !value); setError(""); fields.clear(); }}>{useRecoveryCode ? "Use an authentication code instead" : "Use a recovery code"}</button>
          <FormError message={error} />
          <button className="primary-button" disabled={busy}>{busy ? "Please wait…" : "Sign in"}</button>
          <button type="button" className="text-button" onClick={() => void cancelGoogleCode()} disabled={busy}>Cancel and use another account</button>
        </form> : !methodsKnown ? <div className="auth-methods-placeholder" aria-busy="true" aria-label="Loading sign-in options" /> : <>
          {googleNotice && <div className="auth-google-notice" role="alert"><p>{googleNotice}{methods.password && googleResult?.kind === "error" && googleResult.code === "link_not_authoritative" ? LINK_NOT_AUTHORITATIVE_PASSWORD : ""}</p><button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setGoogleNotice("")}><X /></button></div>}
          {linkRequired && <div className="auth-link-required" role="alert">
            <strong>This address already has a Nook account</strong>
            <p>{linkRequiredText(methods.password)}</p>
            <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setLinkRequired(false)}><X /></button>
          </div>}
          {googleButton}
          {googleButton && !methods.password && <p className="auth-google-only">{googleOnlyHint()}</p>}
          {googleButton && methods.password && <AuthDivider />}
          {methods.password && <form onSubmit={submit} className="auth-form" noValidate onChange={(event) => { setError(""); fields.clear(fieldName(event.target)); }}>
            {registering && <label>Name<input name="displayName" autoComplete="name" maxLength={80} aria-invalid={fields.errors.displayName ? true : undefined} aria-describedby={fields.errors.displayName ? "auth-name-error" : undefined} /><FieldError id="auth-name-error" message={fields.errors.displayName} /></label>}
            <label>Email<input name="email" type="email" autoComplete="email" aria-invalid={fields.errors.email ? true : undefined} aria-describedby={fields.errors.email ? "auth-email-error" : undefined} /><FieldError id="auth-email-error" message={fields.errors.email} /></label>
            <div className="auth-password-group">
              <label htmlFor="auth-password">Password</label>
              <span className="password-field">
                <input id="auth-password" name="password" type={passwordVisible ? "text" : "password"} autoComplete={registering ? "new-password" : "current-password"} maxLength={256} aria-invalid={fields.errors.password ? true : undefined} aria-describedby={fields.errors.password ? "auth-password-error" : undefined} />
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
              <FieldError id="auth-password-error" message={fields.errors.password} />
            </div>
            {!registering && needsTotp && (useRecoveryCode
              ? <label>Recovery code<input name="recoveryCode" autoComplete="one-time-code" placeholder="ABCDE-FGHIJ-KLMNO" maxLength={32} autoFocus aria-invalid={fields.errors.recoveryCode ? true : undefined} /><small>Enter one complete backup recovery code. Each code works once.</small><FieldError id="auth-recovery-error" message={fields.errors.recoveryCode} /></label>
              : <label>Six-digit authentication code<input name="totpCode" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" autoFocus aria-invalid={fields.errors.totpCode ? true : undefined} /><small>Enter the current six-digit number shown in Google Authenticator—not the grouped setup key.</small><FieldError id="auth-code-error" message={fields.errors.totpCode} /></label>)}
            {!registering && needsTotp && <button type="button" className="inline-auth-switch" onClick={() => { setUseRecoveryCode((value) => !value); setError(""); fields.clear(); }}>{useRecoveryCode ? "Use Google Authenticator instead" : "Use a recovery code"}</button>}
            {!registering && passwordResetOffered(registration) && <a className="inline-auth-switch forgot-password-link" href={FORGOT_PATH} onClick={(event) => { event.preventDefault(); onForgotPassword(); }}>Forgot password?</a>}
            <FormError message={error} />
            <button className="primary-button" disabled={busy}>{busy ? "Please wait…" : registering ? "Create account" : "Sign in"}</button>
          </form>}
          {methods.password && (registering || signUpPrompt) && <button className="text-button" onClick={() => { setRegistering(!registering); setNeedsTotp(false); setUseRecoveryCode(false); setPasswordVisible(false); setError(""); fields.clear(); }}>
            {registering ? "Already have an account? Sign in" : signUpPrompt}
          </button>}
        </>}
        <p className="security-note"><Lock /> Your notes stay on this machine.</p>
      </section>
    </main>
  );
}

type SettingsPageProps = {
  session: SessionResponse;
  modules: ModulesSettingsProps;
  googleResult?: GoogleSettingsResult;
  /** The app's navigate: pushes (or replaces) the entry for a hub route. */
  navigate: (route: Route, options?: { replace?: boolean }) => void;
  flash: (message: string) => void;
  /** Absent while two-factor setup is required (Settings → Security is then the only screen). */
  onHome?: () => void;
  onSignOut: () => void;
  onSecurityChanged: (state: TotpState) => void;
  teamModuleEnabled: boolean;
  /** Wave 38: the Bin is a hub section while its module is on (D92); off, /settings/bin opens Security. */
  binModuleEnabled: boolean;
  /** After Settings → Bin restored an item, so the owning app can refresh its lists. */
  onBinRestored?: (item: BinItem) => void;
  /** "Turn on in Settings" (Q5): the module row Settings → Modules scrolls to and highlights once. */
  highlightModule?: ModuleId | null;
  onHighlightDone?: () => void;
};

/** The hub route on the URL: an account section, the list, the Bin, or a Team section. */
function hubRouteFromLocation(): Route {
  const route = routeFromLocation(window.location);
  return isHubRoute(route) ? route : settingsRoute(null);
}

/**
 * The Settings page (Wave 37; before, a dialog over the app). A route of its own: the list at
 * /settings, an account section at /settings/:section, and Team sections at /settings/team/…, each a
 * history entry, so Back returns through the sections to where Settings was opened. The account
 * sections are the ones the dialog had; Team (for the roles that see it) is TeamSection in the hub,
 * and the Bin (Wave 38, /settings/bin) is BinSection.
 */
function SettingsPage({ session, modules, googleResult = null, navigate, flash, onHome, onSignOut, onSecurityChanged, teamModuleEnabled, binModuleEnabled, onBinRestored, highlightModule = null, onHighlightDone }: SettingsPageProps) {
  const setupRequired = session.totp.setupRequired;
  const [locationRoute, setLocationRoute] = useState<Route>(hubRouteFromLocation);
  // Two-factor setup first: Security is the only screen, whatever the URL says.
  const route: Route = setupRequired ? settingsRoute("security") : locationRoute;
  const routeRef = useRef(route);
  routeRef.current = route;
  // Wave 35: how this account signs in and re-authenticates (password, Google, or neither).
  const { account, reload: reloadAccount } = useAccountAuthLoader();
  const [googleNotice, setGoogleNotice] = useState(() => googleSettingsNotice(googleResult));
  // Q2: shown in whichever section the Google round trip started from (Security or API keys).
  const googleNoticeLine = googleNotice && <p className={`settings-google-notice ${googleNotice.tone}`} role={googleNotice.tone === "error" ? "alert" : "status"}>{googleNotice.text}<button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setGoogleNotice(null)}><X /></button></p>;
  // 2026-10-12: Google first for an account with Google linked ("Use password instead" when it has one).
  const securityRoute = useReauthRoute(account);
  const routeToggle = <ReauthRouteToggle viaPassword={securityRoute.viaPassword} onToggle={securityRoute.toggle} />;
  // The Security forms set noValidate (2026-10-13): the app says what is missing, in the form that was sent.
  const [errorAt, setErrorAt] = useState<{ form: SecurityForm; field: string | null } | null>(null);
  const invalid = (form: SecurityForm, field: string) => errorAt?.form === form && errorAt.field === field ? { "aria-invalid": true as const, "aria-describedby": `security-error-${form}` } : {};
  const reauthField = (form: SecurityForm) => securityRoute.viaPassword ? <><input name="password" type="password" autoComplete="current-password" placeholder="Password" aria-label="Password" aria-required="true" {...invalid(form, "password")} />{routeToggle}</> : null;
  const reauthNotice = account && !securityRoute.viaPassword ? <><GoogleReauthNotice account={account} returnTo="/settings/security" />{routeToggle}</> : null;
  // The two-factor actions take the authenticator code, or a recovery code when it is lost.
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const codeField = (form: SecurityForm) => <>{useRecoveryCode
    ? <input name="recoveryCode" autoComplete="one-time-code" maxLength={32} placeholder="Recovery code" aria-label="Recovery code" aria-required="true" {...invalid(form, "recoveryCode")} />
    : <input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code" aria-label="Six-digit authentication code" aria-required="true" {...invalid(form, "code")} />}
    <button type="button" className="inline-auth-switch reauth-toggle" onClick={() => setUseRecoveryCode((value) => !value)}>{useRecoveryCode ? "Use an authentication code instead" : "Lost your authenticator? Use a recovery code"}</button></>;
  /** Shows a problem in the form it belongs to (or above the cards, for `null`), or clears it. */
  const showError = (text: string, form: SecurityForm | null = null, field: string | null = null) => {
    setError(text);
    setErrorAt(text && form ? { form, field } : null);
  };
  /** The form's own check before it is sent: what is missing, said in the form, with focus on that field. */
  const blocked = (form: SecurityForm, element: HTMLFormElement) => {
    if (!securityRoute.viaPassword && account?.reauth === "google" && !googleConfirmed(account)) {
      showError(securityRoute.toggle ? "Confirm with Google first. Or use your password instead." : "Confirm with Google first.", form);
      return true;
    }
    const problem = securityFormProblem(element);
    if (!problem) return false;
    showError(problem.message, form, problem.field);
    const field = element.elements.namedItem(problem.field);
    if (field instanceof HTMLElement) field.focus();
    return true;
  };
  const formError = (form: SecurityForm) => errorAt?.form === form ? <FormError id={`security-error-${form}`} message={error} /> : null;
  /** Typing in a form clears the problem it showed. */
  const clearIn = (form: SecurityForm) => { if (errorAt?.form === form) showError(""); };
  const codeBody = (form: FormData) => {
    const recovery = String(form.get("recoveryCode") ?? "").trim();
    return recovery ? { recoveryCode: recovery } : { code: form.get("code") };
  };
  const [appInfo, setAppInfo] = useState<{ version: string; gitSha: string; twoFactor?: boolean; passwordReset?: boolean }>({ version: "0.38.0", gitSha: "development" });
  const [state, setState] = useState<TotpState>(session.totp);
  const [secret, setSecret] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const { ask, confirmOpen, confirmElement } = useConfirm();
  // Q4: the codes shown right after turning two-factor on, until the person says they saved them.
  const [codesDialog, setCodesDialog] = useState(false);
  // Wave 38: the Bin entry (not for guests, review) and its item count (the top bar's Bin badge before).
  const binShown = binEntryShown(session.user.role, binModuleEnabled);
  const binCount = useBinCount(binShown && !setupRequired);
  // Review L1: the blocked-account count on Team → Members (the top bar's Team badge before).
  const blockedCount = useBlockedCount(canManageTeam(session.user.role) && !setupRequired);

  // A new key shown only once (C1): Settings → API keys, or (review R4) an integration's page in Team.
  const [mcpKeyPending, setMcpKeyPending] = useState(false);
  const [integrationKeyPending, setIntegrationKeyPending] = useState(false);
  const pending = mcpKeyPending || integrationKeyPending;
  const pendingRef = useRef({ mcp: false, integration: false });
  pendingRef.current = { mcp: mcpKeyPending, integration: integrationKeyPending };
  const onIntegrationKeyPending = useCallback((value: boolean) => { pendingRef.current.integration = value; setIntegrationKeyPending(value); }, []);
  const onMcpKeyPending = useCallback((value: boolean) => { pendingRef.current.mcp = value; setMcpKeyPending(value); }, []);
  const confirmFor = (action: "section" | "tab" | "leave") => unsavedKeyConfirm(pendingRef.current.integration ? "integration" : action);
  // Review L1: the section on screen may hold something else a move would lose (Team → Policies with
  // unsaved changes); its hook asks first, then the key check below runs.
  const beforeLeaveRef = useRef<BeforeHubLeave | null>(null);
  const registerBeforeLeave = useCallback((hook: BeforeHubLeave) => {
    beforeLeaveRef.current = hook;
    return () => { if (beforeLeaveRef.current === hook) beforeLeaveRef.current = null; };
  }, []);
  // A move asked about and confirmed runs once the key no longer holds the page (its guard is gone).
  const afterRelease = useRef<{ direction: PopDirection } | { leave: () => void } | null>(null);
  const release = () => {
    pendingRef.current = { mcp: false, integration: false };
    setMcpKeyPending(false);
    setIntegrationKeyPending(false);
  };
  /** Runs `leave` now, or once the person chose to leave a key shown only once behind. */
  const guardLeave = useCallback((leave: () => void, action: "section" | "tab" | "leave" = "leave") => {
    const keyGuarded = () => {
      if (!pendingRef.current.mcp && !pendingRef.current.integration) return leave();
      void ask(confirmFor(action)).then((confirmed) => {
        if (!confirmed || (!pendingRef.current.mcp && !pendingRef.current.integration)) return;
        afterRelease.current = { leave };
        release();
      });
    };
    if (beforeLeaveRef.current?.(keyGuarded)) return;
    keyGuarded();
  }, [ask]);
  // Browser Back or Forward with a key on screen: undone, then asked; leaving repeats the move.
  useLeaveGuard(pending && !confirmOpen, (direction) => {
    void ask(confirmFor(leaveGuardAction(routeFromLocation(window.location), routeRef.current))).then((confirmed) => {
      if (!confirmed || (!pendingRef.current.mcp && !pendingRef.current.integration)) return;
      afterRelease.current = { direction };
      release();
    });
  });
  useEffect(() => {
    const next = afterRelease.current;
    if (pending || !next) return undefined;
    afterRelease.current = null;
    // After the guard's sentinel (if any) is popped: its release is queued before this runs.
    let cancel = () => undefined as void;
    const timer = setTimeout(() => { cancel = whenHistorySettled(() => "direction" in next ? window.history.go(repeatDelta(next.direction)) : next.leave()); }, 0);
    return () => { clearTimeout(timer); cancel(); };
  }, [pending]);

  // Back and Forward between the hub's entries (a dialog open at the time only closes). Review M2: a
  // move that was undone (a dialog's, a leave guard's, or the route gate's skip of a Team entry whose
  // module is off, D92) is read again once it settled, so the screen always follows the URL.
  const teamShownRef = useRef(teamGroupShown(session.user.role, teamModuleEnabled));
  teamShownRef.current = teamGroupShown(session.user.role, teamModuleEnabled);
  const binShownRef = useRef(binShown);
  binShownRef.current = binShown;
  useEffect(() => {
    let cancel = () => undefined as void;
    let later: ReturnType<typeof setTimeout> | null = null;
    const follow = () => {
      const next = hubPopRoute(routeFromLocation(window.location), teamShownRef.current, binShownRef.current);
      if (next) setLocationRoute((current) => formatRoute(current) === formatRoute(next) ? current : next);
    };
    const onPopState = (event: PopStateEvent) => {
      cancel();
      if (later) { clearTimeout(later); later = null; }
      if (popStateClosedDialog(event)) { cancel = whenHistorySettled(follow); return; }
      follow();
      // Review M1: a hidden Bin entry is the route gate's to deal with, and it runs after this listener
      // (Forward is undone, Back steps on past the entry, a depth-0 entry is replaced with Security):
      // the URL is read once more after its move settled, so the screen follows what the gate chose.
      if (routeFromLocation(window.location).app === "bin" && !binShownRef.current) later = setTimeout(() => { later = null; cancel = whenHistorySettled(follow); }, 0);
    };
    window.addEventListener("popstate", onPopState);
    return () => { cancel(); if (later) clearTimeout(later); window.removeEventListener("popstate", onPopState); };
  }, []);

  const go = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    setLocationRoute(next);
    navigate(next, options);
  }, [navigate]);

  /** Phones: the section's back arrow. Back onto the list when this visit came from it, else the list replaces the section. */
  const backToList = useCallback(() => {
    if (hubBackAction(window.history.state) === "history") window.history.back();
    // API keys' and Settings → AI's tabs are entries of their own: the arrow steps back over them to the list.
    else if (hubBackSteps(window.history.state) > 0) window.history.go(-hubBackSteps(window.history.state));
    else go(settingsRoute(null), { replace: true });
  }, [go]);

  const entries = useMemo(() => hubEntries(session.user.role, { teamModuleEnabled, binModuleEnabled, setupRequired, binCount, blockedCount }), [binCount, binModuleEnabled, blockedCount, session.user.role, setupRequired, teamModuleEnabled]);
  const listScreen = route.app === "settings" && route.section === null;
  // Q6: guests have no My access; its URL opens Security (replaced below).
  const guestAccess = route.app === "settings" && route.section === "access" && session.user.role === "guest";
  const section: SettingsSection | null = route.app === "settings" ? guestAccess ? "security" : route.section ?? "security" : null;
  const selected: HubEntryId = guestAccess ? "security" : hubEntryOf(route) ?? "security";
  useEffect(() => { if (guestAccess) go(settingsRoute("security"), { replace: true }); }, [go, guestAccess]);
  // Wave 38: with the Bin module off (D92), or for a guest, the Bin has no entry, and /settings/bin opens Security in place.
  const binHidden = route.app === "bin" && !binShown;
  useEffect(() => { if (binHidden) go(settingsRoute("security"), { replace: true }); }, [binHidden, go]);
  // Settings → AI is tabbed: bare /settings/ai, an unknown tab, or a hidden one opens the first tab in place (Back does not bounce).
  const aiTabs = useMemo(() => aiTabsFor(session.user.role), [session.user.role]);
  const aiRedirect = aiTabRedirect(route, session.user.role);
  const aiRedirectUrl = aiRedirect ? formatRoute(aiRedirect) : null;
  useEffect(() => { if (aiRedirectUrl) go(parseRoute(aiRedirectUrl), { replace: true }); }, [aiRedirectUrl, go]);
  const aiTab = route.app === "settings" && route.aiTab && aiTabs.includes(route.aiTab) ? route.aiTab : aiTabs[0] ?? "providers";
  const title = route.app === "settings" ? SETTINGS_SECTION_NAMES[section ?? "security"] : hubEntryLabel(selected);
  // API keys' tabs (General, Vault, Agents), the same way: bare /settings/keys, an unknown tab, or a
  // hidden one (the Vault or Chat off) opens General in place.
  const keysFeatures = useMemo(() => ({ vault: session.features?.vault !== false, agents: session.features?.agents !== false }), [session.features?.agents, session.features?.vault]);
  const keysRedirect = keysTabRedirect(route, keysFeatures);
  const keysRedirectUrl = keysRedirect ? formatRoute(keysRedirect) : null;
  useEffect(() => { if (keysRedirectUrl) go(parseRoute(keysRedirectUrl), { replace: true }); }, [go, keysRedirectUrl]);
  const keysTab: KeysTab | undefined = section !== "mcp" ? undefined : route.app === "settings" && route.keysTab && keysTabsFor(keysFeatures).includes(route.keysTab) ? route.keysTab : "general";
  const openKeysTab = useCallback((tab: KeysTab) => guardLeave(() => go(keysTabRoute(tab)), "tab"), [go, guardLeave]);

  // "Settings · Notifications · Nook", "Settings · Bin · Nook"; Team's sections name themselves.
  useEffect(() => {
    if (route.app === "bin") document.title = hubDocumentTitle(hubEntryLabel("bin"));
    if (route.app !== "settings") return;
    document.title = listScreen && isMobileViewport() ? hubDocumentTitle(null) : settingsDocumentTitle(section ?? "security", keysTab, section === "ai" && aiTabs.length ? aiTab : undefined);
  }, [aiTab, aiTabs.length, keysTab, listScreen, route.app, section]);

  useEffect(() => {
    api<TotpState>("/auth/totp/status").then(setState).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load security settings"));
    api<{ appName?: string; version: string; gitSha: string; twoFactor?: boolean; passwordReset?: boolean }>("/about").then((info) => { setAppName(info.appName); setAppInfo(info); }).catch(() => undefined);
  }, []);

  async function beginSetup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked("setup", event.currentTarget)) return;
    setBusy(true);
    showError("");
    try {
      const form = new FormData(event.currentTarget);
      const setup = await api<{ secret: string; uri: string }>("/auth/totp/setup", { method: "POST", body: JSON.stringify({ ...reauthPassword(form.get("password")) }) });
      setSecret(setup.secret);
      setQrCode(await QRCode.toDataURL(setup.uri, { width: 220, margin: 2, color: { dark: "#151515", light: "#ffffff" } }));
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : "Could not start two-factor setup", "setup");
    } finally {
      setBusy(false);
    }
  }

  async function enable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked("verify", event.currentTarget)) return;
    setBusy(true);
    showError("");
    try {
      const form = new FormData(event.currentTarget);
      const next = await api<TotpState & { recoveryCodes: string[] }>("/auth/totp/enable", { method: "POST", body: JSON.stringify({ code: form.get("code") }) });
      setSecret("");
      setQrCode("");
      setRecoveryCodes(next.recoveryCodes);
      setState(next);
      // Q4: the new recovery codes show in a dialog; "I saved them" finishes as before. While setup
      // was required, the rest of Nook opens only then.
      if (!next.setupRequired && !setupRequired) onSecurityChanged(next);
      setCodesDialog(true);
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : "Could not enable two-factor authentication", "verify");
    } finally {
      setBusy(false);
    }
  }

  async function disable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Read the form before the confirm: the event's target is gone once it has been answered.
    if (blocked("disable", event.currentTarget)) return;
    const form = new FormData(event.currentTarget);
    if (!await ask({ title: "Disable two-factor authentication?", message: "Signing in to this account will need only the password.", confirmLabel: "Disable", danger: true })) return;
    setBusy(true);
    showError("");
    try {
      const next = await api<TotpState>("/auth/totp", { method: "DELETE", body: JSON.stringify({ ...reauthPassword(form.get("password")), ...codeBody(form) }) });
      setState(next);
      onSecurityChanged(next);
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : "Could not disable two-factor authentication", "disable");
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
    if (blocked("view", event.currentTarget)) return;
    setBusy(true);
    showError("");
    try {
      const form = new FormData(event.currentTarget);
      const result = await api<{ recoveryCodes: string[] }>("/auth/totp/recovery-codes", { method: "POST", body: JSON.stringify({ ...reauthPassword(form.get("password")), ...codeBody(form) }) });
      setRecoveryCodes(result.recoveryCodes);
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : "Could not reveal recovery codes", "view");
    } finally {
      setBusy(false);
    }
  }

  async function regenerateRecoveryCodes(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked("regenerate", event.currentTarget)) return;
    const form = new FormData(event.currentTarget);
    if (recoveryCodes.length && !await ask({ title: "Generate new recovery codes?", message: "Every previous recovery code will stop working.", confirmLabel: "Generate new codes", danger: true })) return;
    setBusy(true);
    showError("");
    try {
      const result = await api<{ recoveryCodes: string[] }>("/auth/totp/recovery-codes/regenerate", { method: "POST", body: JSON.stringify({ ...reauthPassword(form.get("password")), ...codeBody(form) }) });
      setRecoveryCodes(result.recoveryCodes);
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : "Could not generate recovery codes", "regenerate");
    } finally {
      setBusy(false);
    }
  }

  async function copyRecoveryCodes() {
    await navigator.clipboard.writeText(recoveryCodes.join("\n"));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  const selectEntry = (entry: HubEntry) => {
    // Already on screen (a computer's nav): nothing to do; a phone's list always opens it.
    if (!listScreen && entry.id === selected && !isNestedHubRoute(route)) return;
    guardLeave(() => go(entry.route), "section");
  };

  const securitySection = <section className="settings-content" aria-labelledby="security-heading">
    {googleNoticeLine}
    {!state.setupRequired && (!account || (account.methods.password && (account.hasPassword || account.reauth === "google")) ? <ChangePasswordCard totpEnabled={state.enabled} passwordReset={appInfo.passwordReset === true} account={account} onChanged={reloadAccount} /> : <PasswordStateCard account={account} />)}
    {!state.setupRequired && account && <GoogleAccountCard account={account} totpEnabled={state.enabled} onChanged={reloadAccount} />}
    {!state.setupRequired && <ProfilePictureCard name={session.user.displayName} />}
    {!state.setupRequired && <RecognisedDevices />}
    <div className="settings-section-heading"><span className="settings-icon"><Smartphone /></span><div><h3 id="security-heading">Two-factor authentication</h3><p>Protect your account with a six-digit code from Google Authenticator or another TOTP app.</p></div></div>
    {state.setupRequired && <div className="settings-warning"><Lock />Two-factor authentication is required before you can use your notes.</div>}
    {!errorAt && <FormError message={error} />}
    {state.enabled ? <div className="security-card enabled-card">
      <div className="security-status"><span><Check /></span><div><strong>Authenticator enabled</strong><small>Your account asks for an authentication code at every sign-in, after your password or Google.</small></div></div>
      {reauthNotice}
      {recoveryCodes.length ? <div className="recovery-codes"><div><h4>Recovery codes</h4><p>Save each complete grouped code somewhere safe. A whole recovery code replaces the six-digit Authenticator number once.</p></div><div className="recovery-code-grid">{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div><button className="secondary-button" onClick={copyRecoveryCodes}>{copied ? "Copied" : "Copy all codes"}</button></div> : <form className="view-recovery-form" onSubmit={revealRecoveryCodes} noValidate onChange={() => clearIn("view")}><h4>View recovery codes</h4><p>{securityRoute.viaPassword ? "Re-enter your password and a fresh, unused six-digit Authenticator code to reveal the remaining backup codes." : "Enter a fresh, unused six-digit Authenticator code to reveal the remaining backup codes."}</p><div>{reauthField("view")}{codeField("view")}<button className="secondary-button" disabled={busy}>View codes</button></div>{formError("view")}</form>}
      <details className="regenerate-recovery"><summary>{recoveryCodes.length ? "Replace recovery codes" : "No codes available? Generate recovery codes"}</summary><form onSubmit={regenerateRecoveryCodes} noValidate onChange={() => clearIn("regenerate")}><p>This invalidates every previous recovery code. Confirm with {securityRoute.viaPassword ? "your password and " : ""}a fresh six-digit Authenticator code.</p><div>{reauthField("regenerate")}{codeField("regenerate")}<button className="secondary-button" disabled={busy}>Generate new codes</button></div>{formError("regenerate")}</form></details>
      {state.required ? <p className="policy-copy">This service requires two-factor authentication, so it cannot be disabled.</p> : <form className="disable-totp-form" onSubmit={disable} noValidate onChange={() => clearIn("disable")}>
        <h4>Disable authenticator</h4><p>{securityRoute.viaPassword ? "Confirm your password and a current code." : "Confirm with a current code."}</p>
        <div>{reauthField("disable")}{codeField("disable")}<button className="secondary-button" disabled={busy}>Disable</button></div>
        {formError("disable")}
      </form>}
    </div> : appInfo.twoFactor === false ? <div className="security-card setup-intro" role="status">
      <strong>Not available on this Nook</strong>
      <p>{TWO_FACTOR_OFF_TEXT}</p>
    </div> : !secret ? <form className="security-card setup-intro" onSubmit={beginSetup} noValidate onChange={() => clearIn("setup")}>
      <strong>Authenticator not configured</strong>
      <p>Use Google Authenticator to scan a QR code, then verify one code to finish setup.</p>
      {securityRoute.viaPassword ? <><label>Confirm your password<input name="password" type="password" autoComplete="current-password" aria-required="true" {...invalid("setup", "password")} /></label>{routeToggle}</> : reauthNotice}
      {formError("setup")}
      <button className="primary-button" disabled={busy}>{busy ? "Preparing…" : "Set up authenticator"}</button>
    </form> : <div className="security-card enrollment-card">
      <div className="enrollment-grid">
        <div className="qr-frame"><img src={qrCode} alt={`QR code for ${appName()} two-factor authentication`} /></div>
        <div><span className="step-label">1 · Scan the code</span><h4>Add {appName()} to Google Authenticator</h4><p>If you cannot scan it, enter the entire setup key manually in Google Authenticator. The groups of four are only for readability; copying removes all spaces. This key is not entered when signing in.</p><button className="secret-copy" onClick={copySecret}><code>{secret.match(/.{1,4}/g)?.join(" ")}</code><span>{copied ? <><Check />Copied</> : "Copy setup key without spaces"}</span></button></div>
      </div>
      <form className="verify-totp-form" onSubmit={enable} noValidate onChange={() => clearIn("verify")}><span className="step-label">2 · Verify setup</span><label>Authentication code<input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" aria-required="true" {...invalid("verify", "code")} autoFocus /></label><button className="primary-button" disabled={busy}>{busy ? "Verifying…" : "Enable two-factor authentication"}</button>{formError("verify")}</form>
    </div>}
  </section>;

  const content = route.app === "bin"
    ? binHidden ? null : <BinSection flash={flash} onRestored={onBinRestored} />
    : route.app === "team"
    ? <TeamSection route={route} role={session.user.role ?? "member"} totpEnabled={state.enabled} navigate={go} flash={flash} onLeave={() => go(settingsRoute(null), { replace: true })} guardLeave={guardLeave} onKeyPendingChange={onIntegrationKeyPending} />
    : section === "modules" ? <ModulesSettings {...modules} highlight={highlightModule} onHighlightDone={onHighlightDone} />
    : section === "mcp" ? <KeysSettings notice={googleNoticeLine} onPendingChange={onMcpKeyPending} totpEnabled={state.enabled} role={session.user.role} vaultAvailable={keysFeatures.vault} agentsAvailable={keysFeatures.agents} tab={keysTab} onTab={openKeysTab} />
    : section === "access" ? <MyAccess />
    : section === "notifications" ? <NotificationSettings />
    : section === "agents" ? <Suspense fallback={<section className="settings-content" aria-busy="true"><p className="sr-only" role="status">Loading agents…</p></section>}><AgentsSettings agentId={route.app === "settings" ? route.agentId ?? null : null} navigate={go} flash={flash} onOpenChat={(agentId) => navigate({ app: "chat", chatId: null, newChat: true, agentId })} /></Suspense>
    : section === "knowledge" ? <Suspense fallback={<section className="settings-content" aria-busy="true"><p className="sr-only" role="status">Loading knowledge bases…</p></section>}><KnowledgeSettings kbId={route.app === "settings" ? route.kbId ?? null : null} navigate={go} flash={flash} /></Suspense>
    : section === "ai" ? (session.user.role === "admin" ? <Suspense fallback={<section className="settings-content" aria-busy="true"><p className="sr-only" role="status">Loading AI settings…</p></section>}><AiSettings flash={flash} tabs={aiTabs} tab={aiTab} onSelectTab={(tab) => go({ app: "settings", section: "ai", aiTab: tab })} /></Suspense> : <section className="settings-content"><p className="settings-warning">That section is for admins.</p></section>)
    : section === "datasources" ? (session.user.role === "admin" ? <Suspense fallback={<section className="settings-content" aria-busy="true"><p className="sr-only" role="status">Loading data sources…</p></section>}><ReportDataSources /></Suspense> : <section className="settings-content"><p className="settings-warning">That section is for admins.</p></section>)
    : section === "about" ? <section className="settings-content about-settings" aria-labelledby="about-heading"><div className="settings-section-heading"><span className="settings-icon"><Info /></span><div><h3 id="about-heading">About {appName()}</h3><p>A private, self-hosted workspace for notes, files, and ideas.</p></div></div><div className="about-card"><div className="brand-mark"><Sparkles /></div><div><h4>{appName()}</h4><p>{appName() === "Nook" ? "Built by Pankaj" : "Built on Nook by Pankaj"}</p></div><dl><div><dt>Version</dt><dd>{appInfo.version}</dd></div><div><dt>Git SHA</dt><dd><code>{appInfo.gitSha}</code></dd></div></dl><a href="https://github.com/pankajsoni19" target="_blank" rel="noopener noreferrer">github.com/pankajsoni19</a></div></section>
    : securitySection;

  // While setup is required there is nowhere else to go: Sign out is the only header action.
  const accountActions = setupRequired
    ? <div className="app-account" role="group" aria-label="Account"><button className="app-account-button" onClick={onSignOut} title="Sign out"><LogOut /><span className="app-account-label">Sign out</span></button></div>
    : <AccountActions displayName={session.user.displayName} onSignOut={() => guardLeave(onSignOut)} />;
  // Review M1: the header's Inbox button and the bell's items come from app-wide contexts; inside the
  // hub they go through the same leave guard as Home and Sign out.
  const inboxNav = useContext(InboxNavContext);
  const notificationsNav = useContext(NotificationsContext);
  const hubInboxNav = useMemo(() => inboxNav && { ...inboxNav, openInbox: () => guardLeave(inboxNav.openInbox) }, [guardLeave, inboxNav]);
  const hubNotificationsNav = useMemo(() => notificationsNav && { openList: () => guardLeave(notificationsNav.openList), openPath: (path: string) => guardLeave(() => notificationsNav.openPath(path)) }, [guardLeave, notificationsNav]);

  return (
    <AccountAuthContext.Provider value={account}>
    <InboxNavContext.Provider value={hubInboxNav}><NotificationsContext.Provider value={hubNotificationsNav}><HubBeforeLeaveContext.Provider value={registerBeforeLeave}>
    <SettingsHubShell
      displayName={session.user.displayName}
      avatarUrl={session.user.avatarUrl}
      role={session.user.role}
      entries={entries}
      selected={selected}
      listScreen={listScreen && !setupRequired}
      title={title}
      screenKey={formatRoute(route)}
      showBack={!setupRequired && !isNestedHubRoute(route)}
      onBack={() => guardLeave(backToList, "section")}
      onSelect={selectEntry}
      onHome={onHome ? () => guardLeave(onHome) : undefined}
      account={accountActions}
    >{content}</SettingsHubShell>
    </HubBeforeLeaveContext.Provider></NotificationsContext.Provider></InboxNavContext.Provider>
    {confirmElement}
    {codesDialog && recoveryCodes.length > 0 && <RecoveryCodesDialog codes={recoveryCodes} onClose={() => setCodesDialog(false)} onSaved={() => { setCodesDialog(false); onSecurityChanged(state); }} />}
    </AccountAuthContext.Provider>
  );
}

// The confirm for leaving a key shown only once (C1) lives with the keys, so Team → Integrations uses it too.
export { unsavedKeyConfirm };

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
            <small>{version.author_name}{version.author_is_integration === 1 && <IntegrationBadge />} · {relativeTime(version.created_at)}</small>
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

// Files entries carry their own panel hint. Without an explicit one, a matching hint on the current
// entry is kept (reloads, URL normalisation), otherwise the panel follows the selection.
/** The notes list's "Move to the Bin?" (Friction 14, D91): the app's confirm, closed by Back or Forward. */
export function NoteDeleteConfirm({ title, onConfirm, onCancel }: { title: string; onConfirm: () => void; onCancel: () => void }) {
  useHistoryDialogGuard(true, onCancel);
  return <ConfirmDialog title="Move to the Bin?" message={noteDeleteMessage(title)} confirmLabel="Move to Bin" danger onConfirm={onConfirm} onCancel={onCancel} />;
}

/** Sign-out with unsaved whiteboard copies on this device (review L4): the shared confirm (useConfirm). */
export function signOutPendingRequest(count: number) {
  return {
    title: "Sign out and discard unsaved drawings?",
    message: `${count === 1 ? "One whiteboard has" : `${count} whiteboards have`} changes that are not saved yet and are kept only on this device. Signing out deletes them. Open the whiteboard while online to save them first.`,
    confirmLabel: "Sign out and discard",
    danger: true
  };
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
/** The URL an entry was pushed over, so leaving a removed item can step back instead of duplicating it (Q2). */
export const PUSHED_OVER_KEY = "mynotes.pushed-over";

/**
 * F4: the URLs of the few entries under this one, nearest first, so a removed item's own panel steps
 * (phones push one per tab over the same URL) can be skipped along with it.
 */
export const PUSHED_OVER_CHAIN_KEY = "mynotes.pushed-over-chain";
const PUSHED_OVER_CHAIN_LENGTH = 4;

/** The chain a new entry pushed over `current` (at `currentUrl`) records. */
export function pushedOverChain(current: unknown, currentUrl: string) {
  const state = current && typeof current === "object" ? current as Record<string, unknown> : null;
  const below = Array.isArray(state?.[PUSHED_OVER_CHAIN_KEY]) ? (state![PUSHED_OVER_CHAIN_KEY] as unknown[]).filter((url): url is string => typeof url === "string")
    : typeof state?.[PUSHED_OVER_KEY] === "string" ? [state![PUSHED_OVER_KEY] as string] : [];
  return [currentUrl, ...below].slice(0, PUSHED_OVER_CHAIN_LENGTH);
}

/**
 * Q2: the item on screen was deleted or moved away. When its entry was pushed over `targetUrl` (the
 * list it was opened from), step back onto that entry instead of rewriting this one into a second
 * copy of it, which made Back repeat a step. Returns false when the caller should replace in place.
 *
 * F4: entries of the removed item itself (`removedUrl`, the URL on screen) between this one and the
 * list are dropped too: on a phone, opening a note and then tapping the Notes tab leaves the note's
 * editor entry under the list panel, and Back later landed on it (a note that is gone).
 */
export function stepBackIfPushedOver(targetUrl: string, history: Pick<History, "state" | "back" | "go"> = window.history, removedUrl?: string) {
  const state = history.state as Record<string, unknown> | null;
  if (!state) return false;
  const chain = Array.isArray(state[PUSHED_OVER_CHAIN_KEY]) ? state[PUSHED_OVER_CHAIN_KEY] as unknown[] : [state[PUSHED_OVER_KEY]];
  let steps = 0;
  for (const url of chain) {
    steps += 1;
    if (url === targetUrl || steps === chain.length) break;
    // Anything but another entry of the removed item stays: replace in place instead.
    const removed = removedUrl ?? locationUrl(window.location);
    if (url !== removed || targetUrl === removed) return false;
  }
  if (chain[steps - 1] !== targetUrl || readHistoryDepth(state) < steps) return false;
  if (steps === 1) history.back();
  else history.go(-steps);
  return true;
}

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
  if (mode === "push" && !(samePath && !isMobileViewport()) && !takeDialogSentinelEntry(current)) window.history.pushState(withHistoryDepth({ ...state, [PUSHED_OVER_KEY]: locationUrl(window.location), [PUSHED_OVER_CHAIN_KEY]: pushedOverChain(current, locationUrl(window.location)) }, depth + 1), "", url);
  else {
    // A hub screen replaced in place (a redirect, an alias) keeps the URL it was pushed over, so the
    // phone's back arrow still knows the section list is below it.
    const below = isHubRoute(route) && current && typeof current === "object" ? current as Record<string, unknown> : null;
    const kept = below && typeof below[PUSHED_OVER_KEY] === "string" ? { [PUSHED_OVER_KEY]: below[PUSHED_OVER_KEY], [PUSHED_OVER_CHAIN_KEY]: below[PUSHED_OVER_CHAIN_KEY] } : {};
    window.history.replaceState(withHistoryDepth({ ...state, ...kept }, depth), "", url);
  }
}

export function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [checking, setChecking] = useState(true);
  // Wave 35 (QA U4): headers and sidebar footers show the signed-in person's picture.
  useEffect(() => { setSelfAvatar(session?.user.avatarUrl ?? null); }, [session?.user.avatarUrl]);
  // Wave 18: /register#invite=<token>. Read once, and the fragment is stripped at once (T136); the
  // token then lives only in this state until the account is created or the visitor leaves.
  const [invite, setInvite] = useState(initialInvite);
  // Wave 28: /verify-email#token= and /mail/unsubscribe#t= (fragments stripped at once, T220).
  const [mailLink, setMailLink] = useState(initialMailLink);
  // Wave 30: /forgot-password and /reset-password#token= (the fragment is stripped at once, T220).
  const [passwordLink, setPasswordLink] = useState(initialPasswordLink);
  // Wave 35: /login#error=… or #google=code after Google, and /settings/…#google=… (read once, stripped at once).
  const [googleSignIn] = useState(initialGoogleSignInResult);
  const [googleSettings] = useState(initialGoogleSettingsResult);
  // An admin's Google confirmation that came back to Team → member: read before the URL is rewritten.
  useState(initialGoogleTeamResult);
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
  const [searchKind, setSearchKind] = useState<"notes" | "whiteboards">("notes");
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
  // U4 (review M3): own files of a just-published note that are in the Bin, offered for restore.
  const [binnedFiles, setBinnedFiles] = useState<{ noteId: string; documentIds: string[] } | null>(null);
  const deleteOpenerRef = useRef<HTMLElement | null>(null);
  // The app's own confirms: signing out with unsaved whiteboard copies, discarding a draft.
  const appConfirm = useConfirm();
  // U4: uploads in flight in the open note (NoteEditor). Leaving the note asks first, and leaving
  // cancels them: switching notes or folders, a new note, another section (confirmLeaveUploads),
  // browser Back or Forward (a leave guard), and closing the tab (the browser's own prompt).
  const [noteUploads, setNoteUploads] = useState(0);
  const noteUploadControl = useRef<NoteUploadControl | null>(null);
  const [uploadLeaveMove, setUploadLeaveMove] = useState<PopDirection | null>(null);
  async function confirmLeaveUploads() {
    if (!(noteUploadControl.current?.count() ?? 0)) return true;
    if (!await appConfirm.ask(LEAVE_UPLOADS_CONFIRM)) return false;
    noteUploadControl.current?.cancelAll();
    return true;
  }
  useLeaveGuard(noteUploads > 0 && uploadLeaveMove === null, (direction) => {
    void appConfirm.ask(LEAVE_UPLOADS_CONFIRM).then((confirmed) => {
      if (!confirmed) return;
      noteUploadControl.current?.cancelAll();
      setUploadLeaveMove(direction);
    });
  });
  useEffect(() => {
    // Once the guard (and its sentinel) is gone, the move Back or Forward is repeated.
    if (noteUploads > 0 || uploadLeaveMove === null) return undefined;
    const direction = uploadLeaveMove;
    let cancel = () => undefined as void;
    const timer = setTimeout(() => {
      cancel = whenHistorySettled(() => {
        setUploadLeaveMove(null);
        window.history.go(repeatDelta(direction));
      });
    }, 0);
    return () => { clearTimeout(timer); cancel(); };
  }, [noteUploads, uploadLeaveMove]);
  useEffect(() => {
    if (noteUploads === 0) return undefined;
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [noteUploads]);
  const [noteSort, setNoteSort] = useState<NoteSort>("updated-desc");
  const [sortOpen, setSortOpen] = useState(false);
  // Notes → New folder (D91): the Files name dialog, a history layer; focus goes back to the button.
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const newFolderTriggerRef = useRef<HTMLElement | null>(null);
  const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null);
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error" | "conflict">("saved");
  // Settings → Modules (D92): per-user, saved on the server, UI only.
  const modulePreferences = usePreferences(session?.user.id ?? null, session && session.preferences !== undefined ? parsePreferences(session.preferences) : undefined);
  // Wave 25: modules the server does not offer this person (the Vault without its key) are hidden
  // like modules turned off; Settings has no switch for them.
  const unavailable = useMemo(() => unavailableModules(session?.features), [session?.features]);
  const preferredDisabled = modulePreferences.preferences.disabledModules;
  const disabledModules = useMemo(() => unavailable.length ? normalizeDisabledModules([...preferredDisabled, ...unavailable]) : preferredDisabled, [preferredDisabled, unavailable]);
  // TODO "Chat role message": the route gate lets /chat through when Chat is on but the role may
  // not chat, so the module says "Chat is off for your role"; tiles and launchers still hide it.
  const routeDisabled = useMemo(() => routeGateModules(disabledModules, preferredDisabled, session?.features), [disabledModules, preferredDisabled, session?.features]);
  // A sign-in path that did not say which modules the server offers (Google): ask once.
  const featuresUserId = session?.user.id ?? null;
  const featuresKnown = session?.features !== undefined;
  useEffect(() => {
    if (!featuresUserId || featuresKnown) return;
    let live = true;
    api<SessionResponse>("/auth/me").then((me) => {
      if (live) setSession((current) => current && current.user.id === me.user.id && current.features === undefined ? { ...current, features: me.features ?? {} } : current);
    }, () => undefined);
    return () => { live = false; };
  }, [featuresKnown, featuresUserId]);
  const searchEnabled = isModuleEnabled(disabledModules, "search");
  const binEnabled = isModuleEnabled(disabledModules, "bin");
  // Wave 37: Team lives in the Settings hub, and admins keep it there with the Team module turned off
  // (Team plan §6.2, formerly Settings → "Manage team"), so their Team routes pass the route gate.
  // Everyone else follows the toggle.
  const teamGateOpen = activeApp === "team" && canManageTeam(session?.user.role);
  // Wave 38: the Bin is a Settings section; with its module off the hub itself opens Security in
  // place of /settings/bin (no Home and hint), so the app-wide route gate leaves it to the hub.
  const hubGatesItself = teamGateOpen || activeApp === "bin";
  // The module whose route was just replaced with Home, for the one-line hint (D92).
  const [moduleHint, setModuleHint] = useState<ModuleId | null>(null);
  // Q5: the module "Turn on in Settings" opened Settings → Modules for, scrolled to and highlighted once.
  const [highlightModule, setHighlightModule] = useState<ModuleId | null>(null);
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
  // Review M1: per note, the Files items the person confirmed sharing (From Files, or the publish confirm).
  const confirmedFilesRef = useRef(new Map<string, Set<string>>());
  const loadedRef = useRef("");
  const savingPromiseRef = useRef<Promise<boolean> | null>(null);
  const switchingRef = useRef(false);
  // F4: the list URL a removed item's entries were stepped back to, until that popstate lands.
  const removedStepBackRef = useRef<string | null>(null);
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

  // A neutral toast (ui/notify.ts); successes, errors and refusals call notify.* with their type.
  const flash = flashToast;

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
      // Wave 39: the session carries APP_NAME, so in development (where Vite serves index.html as it
      // is) the tab titles follow the name before any /api/about call.
      .then((result) => { if (result.app?.name) setAppName(result.app.name); sessionUserRef.current = result.user.id; setCsrfToken(result.csrfToken); setSession(result); })
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, []);

  // A second reset link pasted into a tab on /reset-password (A5): the fragment changes without a
  // load. Registered once, before the popstate handlers below, so it reads the fragment first; they
  // skip the event it took.
  useEffect(() => {
    const onMove = (event: Event) => {
      const link = takeNewResetLink();
      if (!link) return;
      resetLinkEvents.add(event);
      setPasswordLink(link);
    };
    window.addEventListener("popstate", onMove);
    window.addEventListener("hashchange", onMove);
    return () => {
      window.removeEventListener("popstate", onMove);
      window.removeEventListener("hashchange", onMove);
    };
  }, []);

  // Signed out, Back and Forward move between sign in and /forgot-password (Wave 30).
  useEffect(() => {
    if (session) return;
    const onPopState = (event: PopStateEvent) => {
      if (resetLinkEvents.has(event)) return;
      const link = takePasswordLinkFromLocation();
      setPasswordLink(link?.kind === "forgot" ? link : null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    // While two-factor setup is required, the Settings page (Security) is all there is.
    if (!session.totp.setupRequired) {
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
          if (resolved.missing) notify.warning(resolved.missing === "note" ? "Note not found" : "Folder not found");
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
        if (isHubRoute(target) && readHistoryDepth(window.history.state) === 0) {
          // Review L5 (as Wave 28 did): a Settings deep link the page loaded on gets Home underneath,
          // so Back from Settings goes Home instead of leaving Nook (phones: the list, then Home).
          writeHistory(userId, { app: "home" }, panel, "replace");
          if (hubListGoesUnder(target, { app: "home" }, isMobileViewport())) writeHistory(userId, settingsRoute(null), panel, "push");
          writeHistory(userId, target, panel, "push");
        } else writeHistory(userId, target, panel, "replace", undefined, route.app === "notes" ? searchHint : null);
        historyDepthRef.current = readHistoryDepth(window.history.state);
      }).catch((reason) => {
        if (applyRoute && sessionUserRef.current === userId && routeAppliedUserRef.current !== userId) startupFailedUserRef.current = userId;
        notify.error(errorText(reason, "Could not open your notes"));
      });
    }
  }, [flash, session, loadNavigation, startupRetry]);
  useEffect(() => {
    // The Settings hub names its own screens (Team's sections and the Bin too).
    if (activeApp === "settings" || activeApp === "team" || activeApp === "bin") return;
    const sectionName = { home: "Home", notes: "Notes", files: "Files", tasks: "Tasks", collections: "Collections", calendar: "Calendar", notifications: "Notifications", inbox: "Inbox", whiteboards: "Whiteboards", vault: "Vault", chat: "Chat", reports: "Reports" }[activeApp];
    const detail = activeApp === "notes" && note && note.id === selectedNoteId ? note.title || "Untitled" : null;
    document.title = session ? `${detail ? `${detail} · ` : ""}${sectionName} · ${appName()}` : `Sign in · ${appName()}`;
  }, [activeApp, note, selectedNoteId, session]);
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
      notify.error(reason instanceof Error && reason.message !== "Not found" ? reason.message : "Could not open this note");
      setSelectedNoteId(null);
      // QA L1 (Wave 24): on a phone, land on the list the entry names, not an empty editor.
      setMobilePanel("notes");
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
  // The sort menu is a history layer like any dropdown (D69): Back closes only the menu.
  useHistoryDialogGuard(sortOpen, () => setSortOpen(false));

  const saveDraft = useCallback(async () => {
    if (savingPromiseRef.current) await savingPromiseRef.current;
    if (!(note?.isOwner || note?.canEdit) || markdown === loadedRef.current) return note?.hasDelta ?? false;
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
    if (!(note?.isOwner || note?.canEdit) || markdown === loadedRef.current) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => saveDraft().catch(() => undefined), 900);
    autosaveTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (autosaveTimerRef.current === timer) autosaveTimerRef.current = null;
    };
  }, [markdown, note?.id, note?.isOwner, note?.canEdit, saveDraft]);

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
  // Wave 24: the Whiteboards facet (whiteboard plan §10.7): board names and text, when the module is on.
  const boardFacetAvailable = isModuleEnabled(disabledModules, "whiteboards");
  const boardsFacet = boardFacetAvailable && searchKind === "whiteboards";
  const boardSearch = useWhiteboardSearch(query, boardsFacet);
  const showingBoards = boardsFacet && boardSearch.active;
  const showingSearchResults = !showingBoards && search.active && search.status === "ready";
  searchHintRef.current = search.active ? { query, all: searchAll } : null;
  const activeSearchHit = showingSearchResults ? search.results[activeSearchIndex] ?? null : null;
  useEffect(() => setActiveSearchIndex(-1), [query, searchFolder]);

  // Also locked while the previous note is still shown but a different note is loading.
  const editorLocked = leavingNotes || switchingNote || (note !== null && note.id !== selectedNoteId);
  // Editors (Wave 32, D274) save and publish the shared draft as the owner does; only the owner shares, discards, or deletes.
  const publishInput = { isOwner: Boolean(note?.isOwner || note?.canEdit), serverHasDelta: Boolean(note?.hasDelta), hasUnsavedChanges: markdown !== loadedRef.current };
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

  function navigate(route: Route, options: { replace?: boolean; removed?: boolean; panel?: MobilePanel; filesPanel?: FilesPanel } = {}) {
    if (!session) return;
    // The item on screen is gone: Back onto the list it was opened from rather than a duplicate of it (Q2).
    removedStepBackRef.current = null;
    if (options.removed && stepBackIfPushedOver(formatRoute(route))) {
      removedStepBackRef.current = formatRoute(route);
      return;
    }
    // Phones (review L4): a hub section opened from outside the hub gets the section list under it.
    if (!options.replace && hubListGoesUnder(route, routeFromLocation(window.location), isMobileViewport())) writeHistory(session.user.id, settingsRoute(null), options.panel ?? mobilePanel, "push");
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

  function openNewFolder(trigger: HTMLElement) {
    newFolderTriggerRef.current = trigger;
    setNewFolderOpen(true);
  }

  const closeNewFolder = useCallback(() => {
    setNewFolderOpen(false);
    const trigger = newFolderTriggerRef.current;
    newFolderTriggerRef.current = null;
    if (trigger?.isConnected) trigger.focus();
  }, []);
  useHistoryDialogGuard(newFolderOpen, closeNewFolder);

  // Move to folder… (QA v0.13.0): the Files Move sheet for the open note, so phones (no drag and
  // drop) can file a note too. A history layer; focus goes back to the control that opened it.
  const [movingNote, setMovingNote] = useState(false);
  const moveTriggerRef = useRef<HTMLElement | null>(null);
  function openMoveNote(trigger: HTMLElement | null) {
    moveTriggerRef.current = trigger;
    setMobileActions(false);
    setMovingNote(true);
  }
  const closeMoveNote = useCallback(() => {
    setMovingNote(false);
    const trigger = moveTriggerRef.current;
    moveTriggerRef.current = null;
    window.requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus(); });
  }, []);
  useHistoryDialogGuard(movingNote, closeMoveNote);

  async function createFolder(name: string) {
    const { folder } = await api<{ folder: { id: string; name: string } }>("/folders", { method: "POST", body: JSON.stringify({ name, parentId: null }) });
    await loadNavigation();
    closeNewFolder();
    notify.success(`Created folder ${folder.name}`);
  }

  async function createNote() {
    if (switchingRef.current) return;
    if (!await confirmLeaveUploads()) return;
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
      notify.error(errorText(reason, "Could not create note"));
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
    notify.success(`Moved to ${folder.name}`);
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
    navigate(notesRoute(selectedFolder, null), { panel: "notes", replace: true, removed: true });
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
      // Undo restores it through the Bin and lists it again (v0.35.0); an empty note was purged, no Undo.
      if (result.purged) notify.success("Empty note removed");
      else notifyBinned("Moved to the Bin", [{ type: "note", id: noteId }], () => loadNavigation());
      if (!result.purged) notifyBinChanged();
    } finally {
      switchingRef.current = false;
      setSwitchingNote(false);
    }
  }

  /**
   * `interactive`: the person pressed Publish, so a publish that would share their own Files items
   * asks first (review M1: 409 CONFIRM_REQUIRED, the app's confirm, then again with the ids). Leaving a
   * note never asks: it stays a draft and says why. Files they confirmed in the From Files picker for
   * this note are sent up front, so they are not asked twice.
   */
  async function publish(reloadCurrent = true, interactive = false) {
    if (!note) return false;
    const hasDelta = await saveDraft();
    if (!hasDelta) return false;
    let skipped = 0;
    let binned: string[] = [];
    const noteId = note.id;
    const confirmedFiles = confirmedFilesRef.current.get(noteId) ?? new Set<string>();
    const send = () => api<{ skippedAttachments?: number; binnedAttachments?: string[] }>(`/notes/${noteId}/publish`, { method: "POST", body: JSON.stringify({
      ...(revisionRef.current === null ? {} : { revision: revisionRef.current }),
      ...(confirmedFiles.size ? { confirmAttachments: [...confirmedFiles] } : {})
    }) });
    try {
      let published: Awaited<ReturnType<typeof send>>;
      try {
        published = await send();
      } catch (reason) {
        const required = reason instanceof ApiError ? confirmRequiredOf(reason.status, reason.payload) : null;
        if (!required) throw reason;
        if (!interactive) {
          notify.warning(confirmLaterMessage(required));
          return false;
        }
        if (!await appConfirm.ask(publishFilesConfirm(required))) return false;
        for (const file of required.files) confirmedFiles.add(file.id);
        confirmedFilesRef.current.set(noteId, confirmedFiles);
        published = await send();
      }
      skipped = published.skippedAttachments ?? 0;
      binned = published.binnedAttachments ?? [];
    } catch (reason) {
      if (!(reason instanceof ApiError) || !isDraftChangedError(reason.status, reason.payload)) throw reason;
      // Someone else (an MCP key or another session) wrote the draft after this editor's last save.
      // Show it instead of publishing text the user has not seen.
      await Promise.all([loadNote(note.id), loadNavigation()]);
      notify.warning(DRAFT_CHANGED_MESSAGE);
      return false;
    }
    if (sessionEditedRef.current === note.id) sessionEditedRef.current = null;
    if (reloadCurrent) await Promise.all([loadNote(note.id), loadNavigation()]);
    else await loadNavigation();
    // U4 (D408): files in the note that are not the publisher's are not shared through it.
    // Published either way; a warning when some files are not shared through the note.
    (skipped ? notify.warning : notify.success)(skipped ? `New version published. ${skipped === 1 ? "One file in it is" : `${skipped} files in it are`} not shared through the note (someone else's, or in the Bin).` : "New version published");
    // Review M3: your own files in the note that are in your Bin: offer to restore them (not when leaving).
    if (binned.length && reloadCurrent) setBinnedFiles({ noteId: note.id, documentIds: binned });
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
    if (!await confirmLeaveUploads()) return;
    switchingRef.current = true;
    setSwitchingNote(true);
    try {
      const finalized = await finalizeCurrentNote();
      setSelectedFolder(folder);
      setSelectedNoteId(nextId);
      setMobilePanel("editor");
      navigate(notesRoute(folder, nextId), { panel: "editor", replace: finalized === "removed-empty" });
    } catch (reason) {
      notify.error(errorText(reason, "Could not switch notes"));
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
    if (!await confirmLeaveUploads()) return;
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
      notify.error(errorText(reason, "Could not switch folders"));
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

  // `opener`: where focus goes back to; from the phone ⋯ menu it is the ⋯ button, since the menu item is gone (Q3).
  async function discard(opener?: HTMLElement | null) {
    if (!note || switchingRef.current) return;
    const noteId = note.id;
    const removesNote = note.current_version === 0;
    const message = !removesNote
      ? "Discard this draft and return to the published version?"
      : markdown.trim() === ""
        ? "Discard this empty note?"
        : `This note was never published. Move “${note.title || "Untitled"}” to the Bin? You can restore it for 30 days.`;
    const confirmed = await appConfirm.ask({
      title: !removesNote ? "Discard this draft?" : markdown.trim() === "" ? "Discard this empty note?" : "Move this note to the Bin?",
      message,
      confirmLabel: !removesNote ? "Discard draft" : markdown.trim() === "" ? "Discard" : "Move to Bin",
      danger: true,
      ...(opener !== undefined ? { opener } : {})
    });
    if (!confirmed || switchingRef.current) return;
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
        if (result.binned) notifyBinned("Moved to the Bin", [{ type: "note", id: noteId }], () => loadNavigation());
        else notify.success("Empty note removed");
      } else {
        if (sessionEditedRef.current === noteId) sessionEditedRef.current = null;
        await Promise.all([loadNote(noteId), loadNavigation()]);
        notify.success("Draft discarded");
      }
    } catch (reason) {
      notify.error(errorText(reason, "Could not discard this draft"));
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
      // F4: Back over a removed note's entries lands on the list already on screen (the delete is
      // still finishing): keep that entry instead of rewriting it with the selection being cleared.
      if (removedStepBackRef.current === window.location.pathname) {
        removedStepBackRef.current = null;
        return;
      }
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
      if (resolved.missing) notify.warning(resolved.missing === "note" ? "Note not found" : "Folder not found");
      if (resolved.missing || formatRoute(notesRoute(resolved.folder, resolved.noteId)) !== window.location.pathname) {
        navigate(notesRoute(resolved.folder, resolved.noteId), { panel: targetPanel, replace: true });
      }
    } catch (reason) {
      notify.error(`${reason instanceof Error ? reason.message : "Could not save this note"}. Your note is still open.`);
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
    if (section === "settings") return settingsRoute(isMobileViewport() ? null : "security");
    if (section === "inbox") return { app: "inbox", view: "pending", proposalId: null };
    if (section === "whiteboards") return { app: "whiteboards", folder: "all", boardId: null };
    if (section === "vault") return { app: "vault", vaultId: null, envId: null, secretId: null, page: null };
    if (section === "chat") return { app: "chat", chatId: null };
    if (section === "reports") return { app: "reports", reportId: null };
    return { app: section };
  }

  async function leaveNotes() {
    if (switchingRef.current) return false;
    if (!await confirmLeaveUploads()) return false;
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
      notify.error(`${reason instanceof Error ? reason.message : "Could not save this note"}. Your note is still open.`);
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
      notify.error(errorText(reason, "Could not open your notes"));
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

  // Wave 24 (D208): a whiteboard card in a note or a card description opens its board as a new
  // entry, so Back returns to where it was. Leaving Notes saves the note first, as any app switch does.
  async function openContentPath(path: string) {
    const route = parseRoute(path);
    // A board, or the Bin (QA L6: the owner's card for a binned board offers "Open Bin").
    if (!(route.app === "whiteboards" && route.boardId) && route.app !== "bin") return;
    if (activeApp === "notes" && !await leaveNotes()) return;
    openNotificationPath(path);
  }
  const openContentPathRef = useRef(openContentPath);
  openContentPathRef.current = openContentPath;
  useEffect(() => {
    const onOpen = (event: Event) => {
      const path = (event as CustomEvent<{ path?: unknown }>).detail?.path;
      if (typeof path === "string") void openContentPathRef.current(path);
    };
    window.addEventListener(OPEN_PATH_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PATH_EVENT, onOpen);
  }, []);

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
      window.history.pushState(markSearchPushed(withHistoryDepth(withSearchHint(userId, next, state), readHistoryDepth(state) + 1)), "", window.location.pathname);
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
    // N2: on a phone, the search's own entry is unwound as Back would; its popstate clears the query.
    if (isMobileViewport() && isSearchPushedEntry(window.history.state)) {
      window.history.back();
      return;
    }
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
    if (!session || activeApp !== "notes" || !searchEnabled) return;
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

  // The depth of the entry on screen: read once per signed-in user, then kept by navigate() and by
  // every popstate (recordPopDepth), never re-read on render (see recordPopDepth).
  const sessionUserId = session?.user.id ?? null;
  useEffect(() => {
    if (sessionUserId) historyDepthRef.current = readHistoryDepth(window.history.state);
  }, [sessionUserId]);
  // QA E5: pending whiteboard copies are sent once the app is open and online.
  usePendingWhiteboardSync(sessionUserId);
  // F6: End/Home/PageDown/PageUp scroll the Notes or Files panel on screen when focus is on the page.
  usePageScrollKeys(workspaceScroller);

  // The handler is rebuilt every render so it never finalizes a note from a stale editor snapshot,
  // and the window listener is registered once and dispatches to the newest one (Wave 38 review M1):
  // a listener re-registered per render was dropped mid-dispatch when an earlier listener's state
  // change (the hub following the URL) rendered this component in the same popstate, so the route
  // gate missed a move (a popstate's listeners are a snapshot; a removed one is skipped).
  const onPopState = (event: PopStateEvent) => {
    if (!session) return;
    if (resetLinkEvents.has(event)) return;
    const poppedDepth = readHistoryDepth(event.state);
    const previousDepth = recordPopDepth(historyDepthRef, poppedDepth);
    // Back/Forward while a Files dialog is open only closes the dialog (D18).
    if (popStateClosedDialog(event)) return;
    if (session.totp.setupRequired) return;
    const route = routeFromLocation(window.location);
    // D92: Back or Forward onto a module that is off skips that entry instead of replacing it
    // with a second Home entry. Depth 0 still falls through to the gate below, which replaces it.
    // A guest's Bin entry (Wave 38: no entry for them) is skipped like one with the module off.
    const hiddenRoute = route.app === "team" && canManageTeam(session.user.role) ? null : route.app === "bin" && !binEntryShown(session.user.role, binEnabled) ? "bin" : hiddenModuleForApp(routeDisabled, route.app);
    const step = hiddenRoute ? hiddenEntryStep(dialogPopDirection(previousDepth, poppedDepth), poppedDepth) : "replace";
    if (hiddenRoute && step !== "replace") {
      // The Bin's hint is the hub's (it opens Security in place); the hint is for Home.
      if (hiddenRoute !== "bin") setModuleHint(hiddenRoute);
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
    if (hiddenRoute === "bin") {
      // Wave 38 (review M1): a hidden Bin entry with nothing below it (or no known direction) opens
      // Security in place, the hub's rule for /settings/bin, instead of Home and a hint.
      setActiveApp("settings");
      navigate(settingsRoute("security"), { replace: true });
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
  const popStateRef = useRef(onPopState);
  popStateRef.current = onPopState;
  useEffect(() => {
    const listen = (event: PopStateEvent) => popStateRef.current(event);
    window.addEventListener("popstate", listen);
    return () => window.removeEventListener("popstate", listen);
  }, []);

  // D92: a route of a module that is turned off (a launcher link, a deep link, Back or Forward, a
  // notification, or turning it off while it is open) is replaced with Home and a hint. The entry is
  // replaced, not pushed, so Back never bounces into it again (Back and Forward onto such an entry
  // above depth 0 skip it in onPopState instead, see hiddenEntryStep). The server is not involved: the
  // module's API still works and keeps its own access rules (T97).
  useEffect(() => {
    const hidden = hubGatesItself ? null : hiddenModuleForApp(routeDisabled, activeApp);
    if (!session || session.totp.setupRequired || !hidden || leavingHiddenModuleRef.current) return;
    const app = activeApp;
    // A note that could not be saved keeps Notes open (the toast says why) until the choice changes.
    const attempt = `${app}:${routeDisabled.join(",")}`;
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
    if (moduleHint && (isModuleEnabled(disabledModules, moduleHint) || activeApp !== "home")) setModuleHint(null);
  }, [activeApp, disabledModules, moduleHint]);
  // Search turned off: drop any query so the Notes list is not left filtered by a hidden box.
  useEffect(() => {
    if (!searchEnabled && query) clearSearch();
  }, [searchEnabled, query]);

  /**
   * Opens the Settings page (Wave 37): a route like any app's, so Back returns here. Without a
   * section, a phone opens the section list and a computer Security (the list sits beside it).
   */
  function openSettings(section: SettingsSection | null = null) {
    void openRoute(settingsRoute(section ?? (isMobileViewport() ? null : "security")));
  }

  /** Opens a route as a new entry, leaving Notes first (the open note is saved or published). */
  async function openRoute(route: Route) {
    if (!session) return false;
    if (activeApp === "notes" && !await leaveNotes()) return false;
    navigate(route);
    setActiveApp(route.app);
    return true;
  }

  // Review L4: unsaved whiteboard copies on this device are deleted at sign-out; if there are any,
  // the app's own confirm says so first (never a native dialog).
  function signOut() {
    const userId = session?.user.id;
    (userId ? countPendingForUser(userId) : Promise.resolve(0)).then(async (count) => {
      if (count > 0 && !await appConfirm.ask(signOutPendingRequest(count))) return;
      return logout();
    }).catch((reason) => notify.error(errorText(reason, "Could not sign out")));
  }

  async function logout() {
    const signedOutUserId = session?.user.id ?? null;
    // T69: forget this device's push subscription and service worker while the session still works.
    await forgetThisDevice();
    await api("/auth/logout", { method: "POST", body: "{}" });
    if (signedOutUserId) await clearPendingForUser(signedOutUserId);
    clearCardSummaries();
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
    // A bare entry: drops the search hint (the query text) and every other hint from the current
    // entry. Older entries keep theirs, but each is tied to the user id and ignored while signed out.
    window.history.replaceState(null, "", "/");
    setActiveApp("home");
    setSession(null);
  }

  if (checking) return <main className="loading-page"><div className="brand-mark"><Sparkles /></div><span>Opening {appName()}…</span></main>;
  const acceptSession = (result: SessionResponse) => {
    if (sessionUserRef.current !== result.user.id) clearCardSummaries();
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
    setInvite({ onRegister: false, token: null, googleError: null });
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
  if (passwordLink?.kind === "reset") return <ResetPasswordPage key={passwordLink.token ?? ""} token={passwordLink.token} signedIn={Boolean(session)} onForgot={openForgotFromReset} onSignIn={leavePasswordReset} />;
  if (mailLink?.kind === "verify") return <VerifyEmailPage token={mailLink.token} signedIn={Boolean(session)} onContinue={leaveMailLink} />;
  // "Manage all email settings" loads the Settings deep link (signing in first when needed).
  if (mailLink?.kind === "unsubscribe") return <UnsubscribePage token={mailLink.token} onContinue={leaveMailLink} onManage={() => window.location.assign(settingsPath("notifications"))} />;
  if (invite.onRegister && !session) return <InviteRegister token={invite.token} googleError={invite.googleError} onSignIn={leaveInvite} onRegister={async (body: InviteRegisterBody) => {
    const result = await api<SessionResponse>("/auth/register", { method: "POST", body: JSON.stringify(body) });
    setCsrfToken(result.csrfToken);
    // After registering, replace /register with Today (§1.6): Back never returns to the used link.
    leaveInvite();
    acceptSession(result);
  }} />;
  if (invite.onRegister && session) return <InviteWhileSignedIn displayName={session.user.displayName} onContinue={leaveInvite} onSignOut={() => {
    logout().then(() => window.history.replaceState(null, "", "/register"), (reason) => notify.error(errorText(reason, "Could not sign out")));
  }} />;
  if (!session) return <AuthScreen onAuthenticated={acceptSession} onForgotPassword={openForgotPassword} googleResult={googleSignIn} />;

  const modulesSettings: ModulesSettingsProps = { disabledModules: modulePreferences.preferences.disabledModules, status: modulePreferences.status, onToggle: modulePreferences.setModuleEnabled, role: session.user.role, unavailable };
  const securityChanged = (totp: TotpState) => setSession((current) => current ? { ...current, totp } : current);
  const resetNotice = session.notices?.googleReset ?? null;
  const dismissResetNotice = () => {
    setSession((current) => current ? { ...current, notices: { ...current.notices, googleReset: null } } : current);
    void api("/auth/notices/google-reset/dismiss", { method: "POST", body: "{}" }).catch(() => undefined);
  };
  const toastStatus = <>{appConfirm.confirmElement}{resetNotice && <GoogleResetNoticeBanner notice={resetNotice} onDismiss={dismissResetNotice} />}{moduleHint && <div className="module-hint" role="status">
    <p>{unavailable.includes(moduleHint) ? `${moduleDef(moduleHint).label} is not available on this server.` : moduleOffHint(moduleHint)}</p>
    {!unavailable.includes(moduleHint) && <button className="secondary-button" onClick={() => { setHighlightModule(moduleHint); setModuleHint(null); openSettings("modules"); }}>Turn on in Settings</button>}
    <button className="icon-button" onClick={() => setModuleHint(null)} aria-label="Dismiss"><X /></button>
  </div>}</>;
  // A hidden module's view never renders, even for the moment before the gate above replaces its route.
  const shownApp: AppSection = activeApp !== "notes" && !hubGatesItself && !isAppEnabled(routeDisabled, activeApp) ? "home" : activeApp;
  const account = { displayName: session.user.displayName, onSettings: () => openSettings(), onSignOut: signOut };

  // Notifications off (D92): no provider, so every bell renders nothing and stops polling.
  const notificationsContext = isModuleEnabled(disabledModules, "notifications") ? { openList: () => { void openApp("notifications"); }, openPath: openNotificationPath } : null;
  const inboxNav = { role: session.user.role, openInbox: () => { void openApp("inbox"); }, onInbox: shownApp === "inbox" };
  // The Inbox opens a proposal's target as a new entry: a note through the Notes loader, anything else by its route.
  const openInboxPath = (path: string) => {
    const route = parseRoute(path);
    if (route.app === "notes" && route.noteId) openLinkedNote(route.noteId);
    else openNotificationPath(path);
  };

  // Wave 37: the Settings hub, one element for its account, Bin (Wave 38), and Team routes (moving
  // between them never remounts it). Its moves keep the app's section in step with the URL.
  const settingsPage = (setup: boolean) => <SettingsPage
    key="settings-hub"
    session={session}
    googleResult={googleSettings}
    modules={modulesSettings}
    navigate={(route, options) => { navigate(route, options); setActiveApp(route.app); }}
    flash={flash}
    onHome={setup ? undefined : () => { void openHome(); }}
    onSignOut={signOut}
    onSecurityChanged={securityChanged}
    teamModuleEnabled={isModuleEnabled(disabledModules, "team")}
    binModuleEnabled={binEnabled}
    onBinRestored={(item) => { if (item.type === "note") void loadNavigation().catch(() => undefined); }}
    highlightModule={highlightModule}
    onHighlightDone={() => setHighlightModule(null)}
  />;

  // While two-factor setup is required, Settings → Security is the only screen.
  if (session.totp.setupRequired) return <ModulesContext.Provider value={disabledModules}><RoleContext.Provider value={session.user.role}>
    {settingsPage(true)}
    {toastStatus}
  </RoleContext.Provider></ModulesContext.Provider>;

  if (shownApp !== "notes") return <ModulesContext.Provider value={disabledModules}><RoleContext.Provider value={session.user.role}><NotificationsContext.Provider value={notificationsContext}><InboxNavContext.Provider value={inboxNav}>
    {shownApp === "home" ? <TodayHome {...account} userId={session.user.id} onOpen={(section) => { void openApp(section); }} onOpenRoute={(route) => { void openTodayRoute(route); }} />
      : shownApp === "files" ? <FilesApp {...account} userId={session.user.id} navigate={navigate} flash={flash} onHome={() => { void openHome(); }} onOpenWhiteboard={isModuleEnabled(disabledModules, "whiteboards") ? (id) => openNotificationPath(`/whiteboards/${id}`) : undefined} />
      : shownApp === "tasks" ? <TasksApp {...account} userId={session.user.id} navigate={navigate} flash={flash} onHome={() => { void openHome(); }} />
      : shownApp === "collections" ? <CollectionsApp {...account} userId={session.user.id} navigate={navigate} flash={flash} onHome={() => { void openHome(); }} />
      : shownApp === "calendar" ? <CalendarApp key={calendarKey} {...account} userId={session.user.id} navigate={navigate} flash={flash} onHome={() => { void openHome(); }} onOpenNote={openLinkedNote} />
      : shownApp === "notifications" ? <NotificationsApp {...account} onHome={() => { void openHome(); }} onOpenPath={openNotificationPath} />
      : shownApp === "inbox" ? <InboxApp {...account} navigate={navigate} flash={flash} onHome={() => { void openHome(); }} onOpenPath={openInboxPath} />
      : shownApp === "vault" ? <Suspense fallback={<main className="app-page" aria-busy="true"><p className="sr-only" role="status">Loading the vault…</p></main>}><VaultApp {...account} role={session.user.role ?? "member"} navigate={navigate} flash={flash} onHome={() => { void openHome(); }} /></Suspense>
      : shownApp === "chat" ? <Suspense fallback={<main className="app-page" aria-busy="true"><p className="sr-only" role="status">Loading chat…</p></main>}><ChatApp {...account} role={session.user.role ?? "member"} navigate={navigate} flash={flash} onHome={() => { void openHome(); }} onOpenAgents={(agentId) => { void openRoute({ app: "settings", section: "agents", ...(agentId ? { agentId } : {}) }); }} onOpenPath={openInboxPath} /></Suspense>
      : shownApp === "reports" ? <Suspense fallback={<main className="app-page" aria-busy="true"><p className="sr-only" role="status">Loading reports…</p></main>}><ReportsApp {...account} role={session.user.role ?? "member"} navigate={navigate} flash={flash} onHome={() => { void openHome(); }} onOpenDatasources={() => { void openRoute({ app: "settings", section: "datasources" }); }} onOpenToolServers={() => { void openRoute({ app: "settings", section: "ai", aiTab: "tools" }); }} /></Suspense>
      : shownApp === "whiteboards" ? <Suspense fallback={<main className="app-page" aria-busy="true"><p className="sr-only" role="status">Loading whiteboards…</p></main>}><WhiteboardsApp {...account} userId={session.user.id} navigate={navigate} flash={flash} onHome={() => { void openHome(); }} onOpenPath={openInboxPath} /></Suspense>
      // Settings, Team, and the Bin (Wave 38) are the hub's routes.
      : settingsPage(false)}
    {toastStatus}
  </InboxNavContext.Provider></NotificationsContext.Provider></RoleContext.Provider></ModulesContext.Provider>;

  // Viewers and guests read notes; create, edit, share, and delete controls are hidden (Wave 15).
  const canWrite = canWriteContent(session.user.role);
  return (
    <ModulesContext.Provider value={disabledModules}>
    <RoleContext.Provider value={session.user.role}>
    <main className={`workspace ${collapsed ? "nav-collapsed" : ""}`} data-mobile-panel={mobilePanel}>
      <aside className="folder-pane" id="note-folders">
        <header className="sidebar-header">
          <button className="sidebar-brand sidebar-home-button" onClick={() => { void openHome(); }} aria-label={`Open ${appName()} home`} title="Back to Home"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>Notes</strong></span></button>
          <button className="icon-button desktop-only" onClick={() => setCollapsed(true)} aria-label="Collapse folders sidebar" aria-controls="note-folders" aria-expanded={!collapsed} title="Collapse folders"><PanelLeftClose /></button>
        </header>
        <nav className="folder-nav" aria-label="Note folders">
          <button className="nav-home" onClick={() => { void openHome(); }} title="Back to Home"><House /><span>Home</span></button>
          <button className={selectedFolder === "all" ? "active" : ""} onClick={() => { void selectFolder("all"); }}><Archive /><span>All notes</span><b>{notes.length}</b></button>
          <button className={selectedFolder === "shared" ? "active" : ""} onClick={() => { void selectFolder("shared"); }}><Users /><span>Shared with me</span><b>{notes.filter((item) => item.is_owner === 0).length}</b></button>
          <div className="nav-label"><span>Folders</span>{canWrite && <button onClick={(event) => openNewFolder(event.currentTarget)} aria-label="New folder" aria-haspopup="dialog" title="New folder"><FolderPlus /></button>}</div>
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
                if (noteId) moveNote(noteId, folder).catch((reason) => notify.error(errorText(reason, "Could not move note")));
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
          <button className="footer-settings" title={session.user.displayName} onClick={() => openSettings()} aria-label={`Open settings for ${session.user.displayName}`}>
            <strong className="footer-identity"><SelfAvatar className="app-user-avatar" name={session.user.displayName} url={session.user.avatarUrl} /><span>{session.user.displayName}</span></strong>
            <span><Settings />Settings</span>
          </button>
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
          {search.active && boardFacetAvailable && <div className="search-scope search-facets" role="group" aria-label="Search in">
            <button type="button" className="search-scope-chip" aria-pressed={!boardsFacet} onClick={() => setSearchKind("notes")}><FileText aria-hidden="true" />Notes</button>
            <button type="button" className="search-scope-chip" aria-pressed={boardsFacet} onClick={() => setSearchKind("whiteboards")}><PenTool aria-hidden="true" />Whiteboards</button>
          </div>}
          {search.active && !showingBoards && selectedFolder !== "all" && <div className="search-scope">
            {!searchAll && <span>Searching {selectedFolder === "shared" ? "Shared with me" : folders.find((folder) => folder.id === selectedFolder)?.name ?? "this folder"}</span>}
            <button type="button" className="search-scope-chip" aria-pressed={searchAll} onClick={() => setSearchAll((all) => !all)}>{searchAll ? <Check aria-hidden="true" /> : <Archive aria-hidden="true" />}Search all notes</button>
          </div>}
          <p className="sr-only" aria-live="polite" aria-atomic="true">{showingSearchResults ? (search.results.length ? `${search.results.length}${search.truncated ? " or more" : ""} ${search.results.length === 1 && !search.truncated ? "result" : "results"}` : "No results") : ""}</p>
        </header>
        <ReadOnlyBanner />
        <div className="note-list">
          {search.status === "error" && <p className="search-error" role="alert">{search.error}</p>}
          {showingBoards && boardSearch.status === "error" && <p className="search-error" role="alert">{boardSearch.error}</p>}
          {showingBoards && boardSearch.status === "loading" && <p className="search-status" role="status">Searching whiteboards…</p>}
          {showingBoards && boardSearch.status === "ready" && <WhiteboardSearchResults results={boardSearch.results} truncated={boardSearch.truncated} relativeTime={relativeTime} onOpen={(hit) => { void openContentPath(`/whiteboards/${hit.id}`); }} />}
          {showingBoards && boardSearch.status === "ready" && !boardSearch.results.length && <div className="empty-state"><div><PenTool /></div><h2>No whiteboards match</h2><p>Names and the text on boards you can open are searched.</p></div>}
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
          {!showingSearchResults && !showingBoards && visibleNotes.map((item) => <article
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
          {!showingSearchResults && !showingBoards && !visibleNotes.length && <div className="empty-state"><div><FilePlus2 /></div><h2>No notes here</h2><p>{query ? (search.status === "loading" ? "Searching note text…" : "Try another search.") : selectedFolder === "shared" ? "Notes shared with you will appear here." : (canWrite ? "Create a note and start writing." : "Notes shared with you appear here.")}</p>{!query && selectedFolder !== "shared" && canWrite && <button onClick={createNote}>New note</button>}</div>}
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
              {note.isOwner && canWrite && <button className="icon-button" disabled={editorLocked} onClick={(event) => openMoveNote(event.currentTarget)} aria-label="Move to folder…" title="Move to folder"><FolderInput /></button>}
              {note.isOwner && canWrite && <button className="icon-button" onClick={() => setPanel("share")} aria-label="Share note"><Share2 /></button>}
              {note.isOwner && canWrite && note.hasDraft && <button className="text-action" disabled={editorLocked} onClick={() => { void discard(); }}>Discard</button>}
              {hasPublishableDelta && canWrite && <button className="publish-button" disabled={editorLocked} onClick={() => { void publish(true, true); }}>Publish version</button>}
              <button className="icon-button mobile-more" disabled={editorLocked} onClick={() => setMobileActions((open) => !open)} aria-label="More actions"><MoreHorizontal /></button>
            </div>
            {mobileActions && <div className="mobile-actions-menu">
              <button onClick={() => { setPanel("history"); setMobileActions(false); }}><History />Version history</button>
              <button onClick={() => { setMobileActions(false); downloadPdf(); }}><FileDown />Download as PDF</button>
              {note.isOwner && canWrite && <button disabled={editorLocked} onClick={() => openMoveNote(document.querySelector<HTMLElement>(".toolbar-actions .mobile-more"))}><FolderInput />Move to folder…</button>}
              {note.isOwner && canWrite && <button onClick={() => { setPanel("share"); setMobileActions(false); }}><Share2 />Share note</button>}
              {note.isOwner && canWrite && note.hasDraft && <button disabled={editorLocked} onClick={() => { setMobileActions(false); void discard(document.querySelector<HTMLElement>(".toolbar-actions .mobile-more")); }}><X />Discard draft</button>}
              {hasPublishableDelta && canWrite && <button disabled={editorLocked} onClick={() => { setMobileActions(false); void publish(true, true); }}><Sparkles />Publish version</button>}
            </div>}
          </header>
          <article className="document-shell">
            <div className="document-meta"><span>{note.isOwner ? "Private workspace" : note.canEdit ? `Shared by ${note.owner_name} · you can edit` : `Shared by ${note.owner_name}`}</span><i /> <span>{markdown.trim().split(/\s+/).filter(Boolean).length} words</span></div>
            <NoteEditor key={note.id} markdown={markdown} editable={(note.isOwner || note.canEdit === true) && canWrite && !editorLocked} onChange={(value) => { sessionEditedRef.current = note.id; setMarkdown(value); }} folderId={note.folder_id} attachHost="note" onNotice={notify}
              onFileConfirmed={(documentId) => { const files = confirmedFilesRef.current.get(note.id) ?? new Set<string>(); files.add(documentId); confirmedFilesRef.current.set(note.id, files); }}
              onUploadsChange={setNoteUploads} uploadControl={noteUploadControl} />
          </article>
        </>}
      </section>

      {panel === "history" && note && <HistoryPanel note={note} canRestore={canWrite} onClose={() => setPanel(null)} onRestored={async () => { setPanel(null); await loadNote(note.id); await loadNavigation(); notify.success("Version restored as a draft"); }} />}
      {panel === "share" && note && <AccessSheet kind="note" id={note.id} title={note.title || "Untitled"} guardHistory onClose={() => setPanel(null)} onSaved={async () => { setPanel(null); await loadNote(note.id); await loadNavigation(); notify.success("Access updated"); }} />}
      {binnedFiles && <BinnedFilesConfirm noteId={binnedFiles.noteId} documentIds={binnedFiles.documentIds}
        onCancel={() => setBinnedFiles(null)}
        onDone={(message) => {
          const shown = binnedFiles.noteId;
          setBinnedFiles(null);
          notify.success(message);
          if (note?.id === shown) void loadNote(shown);
        }} />}
      {deletingNote && <NoteDeleteConfirm title={deletingNote.title}
        onCancel={() => { setDeletingNote(null); focusAfterDeleteConfirm(); }}
        onConfirm={() => {
          const target = deletingNote;
          setDeletingNote(null);
          void deleteNote(target.id).catch((reason) => notify.error(errorText(reason, "Could not delete note"))).finally(focusAfterDeleteConfirm);
        }} />}
      {movingNote && note && <MoveSheet
        document={{ name: note.title.trim() || "Untitled", folder_id: note.folder_id }}
        itemLabel="note"
        folders={folders}
        onMove={async (folder) => { await moveNote(note.id, folder); closeMoveNote(); }}
        onCancel={closeMoveNote}
      />}
      {newFolderOpen && <NameDialog
        title="New folder"
        eyebrow="Notes"
        label="Folder name"
        initialValue=""
        submitLabel="Create folder"
        hint="Up to 120 characters."
        validate={validateFolderName}
        onSubmit={createFolder}
        onCancel={closeNewFolder}
      />}
      {sharingFolder && <AccessSheet kind="folder" id={sharingFolder.id} title={sharingFolder.name} guardHistory onClose={() => setSharingFolder(null)} onSaved={async () => { setSharingFolder(null); await loadNavigation(); notify.success("Folder access updated"); }} />}
      {panel && panel !== "share" && <button className="panel-scrim" onClick={() => { setPanel(null); setSharingFolder(null); }} aria-label="Close panel" />}
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
