import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, House, KeyRound, Link2, LogOut, Mail, RotateCcw, Scale, Search, ShieldAlert, ShieldCheck, Sparkles, TriangleAlert, UserCheck, UserX, Users, X } from "lucide-react";
import { ApiError } from "../api";
import { AccountActions, useBinCount, AppPageName } from "../AppShell";
import { readHistoryDepth } from "../appShellNavigation";
import { formatBytes } from "../files/filesApi";
import { relativeTime } from "../files/format";
import { popStateClosedDialog } from "../historyDialogs";
import { parseRoute, type Route } from "../router";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { blockTeamMember, getTeamMember, listTeam, listTeamInvites, revokeTeamSessions, setTeamRole, unblockTeamMember, type TeamInviteList, type TeamMember, type TeamMemberDetail } from "./teamApi";
import { TeamInvites } from "./TeamInvites";
import { TeamEmailLog } from "./TeamEmailLog";
import { TeamKeys } from "./TeamKeys";
import { TeamPolicies } from "./TeamPolicies";
import { eventLabel, filterTeam, joinedLabel, initialOf, isNewAccount, lastAdminReason, statusLabel, teamBackAction, teamFilters, type TeamFilter } from "./teamFormat";
import { canManageTeam, canSeeTeam, ROLE_DESCRIPTIONS, ROLE_LABELS, roleOptions as teamRoleOptions, type Role } from "./teamRoles";
import "./team.css";

type TeamNavigate = (route: Route, options?: { replace?: boolean }) => void;

type TeamAppProps = {
  displayName: string;
  /** The signed-in user's role; the server enforces it regardless. */
  role: Role;
  navigate: TeamNavigate;
  flash: (message: string) => void;
  onHome: () => void;
  onBin?: () => void;
  onSettings: () => void;
  onSignOut: () => void;
};

type Dialog =
  | { kind: "role"; to: Role }
  | { kind: "block" }
  | { kind: "unblock" }
  | { kind: "revoke" };

/** Which pane the detail side shows: a member, Invites, the Email log, Keys, or Policies (the last four admins only). */
type TeamView = { userId: string | null; invites: boolean; email?: boolean; keys?: boolean; policies?: boolean };

const currentView = (): TeamView => {
  const route = parseRoute(window.location.pathname);
  return route.app === "team" ? { userId: route.userId, invites: route.invites === true, email: route.email === true, keys: route.keys === true, policies: route.policies === true } : { userId: null, invites: false, email: false };
};

/** /team/invites, /team/keys, and /team/policies are for admins; anyone else has the URL replaced with /team (QA note 10). */
export const replacesInvitesRoute = (view: TeamView, role: Role) => (view.invites || view.email === true || view.keys === true || view.policies === true) && !canManageTeam(role);

const errorCode = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object"
  ? (reason.payload as { code?: unknown }).code
  : undefined;
const messageOf = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Team (docs/plan/research/2026-09-26-team-module.md §6): the list at /team and one member at
 * /team/:userId, both history entries. Dialogs push none (D18): Back closes a dialog first, then
 * leaves the member for the list, then the list for Home. Desktop shows the two side by side.
 * Members and viewers see names and roles only; admins also manage roles and blocks.
 */
/** What a role change means for the account, from the permission matrix (Team plan §2.2). */
function roleChangeBody(member: { displayName: string; role: Role; isYou: boolean }, to: Role) {
  if (to === "admin") return "Admins can change anyone's team role, block accounts, and sign accounts out. They still cannot open anyone's private content.";
  const who = member.isYou ? "You" : member.displayName;
  const when = member.isYou ? "straight away" : "on their next request";
  const lead = member.role === "admin" ? `${who} will lose Team management ${when}. ` : "";
  if (to === "viewer") return `${lead}${who} will read what is shared with them or with everyone, and cannot create, edit, share, or upload. API keys keep only read permissions.`;
  if (to === "guest") return `${lead}${who} will see only what is shared with them by name, and cannot create, edit, share, or upload. Guests have no Team list and no API keys.`;
  return `${lead}${who} can create, edit, and share notes, files, tasks, collections, and events.`;
}

export function TeamApp({ displayName, role, navigate, flash, onHome, onBin, onSettings, onSignOut }: TeamAppProps) {
  const admin = canManageTeam(role);
  const binCount = useBinCount(Boolean(onBin));
  const [view, setView] = useState<TeamView>(currentView);
  const routeUserId = view.userId;
  // Wave 18: /team/invites (admins); anyone else who lands there sees the list.
  const routeInvites = view.invites && admin;
  // Wave 28: /team/email, the admin Email log, in the same pane.
  const routeEmail = view.email === true && admin;
  // Wave 31: /team/keys and /team/policies (admins), in the same pane.
  const routeKeys = view.keys === true && admin;
  const routePolicies = view.policies === true && admin;
  const [invites, setInvites] = useState<TeamInviteList | null>(null);
  const [invitesError, setInvitesError] = useState<string | null>(null);
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TeamFilter>("all");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<TeamMemberDetail | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const routeRef = useRef<string | null>(routeUserId);
  // The Back rule treats the Invites panel like an open member (deep link → list).
  routeRef.current = routeUserId ?? (routeInvites ? "invites" : routeEmail ? "email" : routeKeys ? "keys" : routePolicies ? "policies" : null);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);

  const loadList = useCallback(async () => {
    const generation = ++listGeneration.current;
    setLoadError(null);
    try {
      const { users } = await listTeam();
      if (generation === listGeneration.current) setMembers(users);
    } catch (reason) {
      if (generation === listGeneration.current) setLoadError(messageOf(reason, "Could not load the team"));
    }
  }, []);

  const visibleToRole = canSeeTeam(role);
  useEffect(() => { if (visibleToRole) void loadList(); }, [loadList, visibleToRole]);

  const invitesGeneration = useRef(0);
  const loadInvites = useCallback(async () => {
    const generation = ++invitesGeneration.current;
    setInvitesError(null);
    try {
      const result = await listTeamInvites();
      if (generation === invitesGeneration.current) setInvites(result);
    } catch (reason) {
      if (generation === invitesGeneration.current) setInvitesError(messageOf(reason, "Could not load invites"));
    }
  }, []);
  useEffect(() => { if (admin) void loadInvites(); }, [admin, loadInvites]);

  const go = useCallback((userId: string | null, replace = false) => {
    setView({ userId, invites: false, email: false });
    navigateRef.current({ app: "team", userId }, { replace });
  }, []);
  const openInvites = useCallback(() => {
    setView({ userId: null, invites: true, email: false });
    navigateRef.current({ app: "team", userId: null, invites: true });
  }, []);
  const openEmailLog = useCallback(() => {
    setView({ userId: null, invites: false, email: true });
    navigateRef.current({ app: "team", userId: null, email: true });
  }, []);
  const openKeys = useCallback(() => {
    setView({ userId: null, invites: false, keys: true });
    navigateRef.current({ app: "team", userId: null, keys: true });
  }, []);
  const openPolicies = useCallback(() => {
    setView({ userId: null, invites: false, policies: true });
    navigateRef.current({ app: "team", userId: null, policies: true });
  }, []);

  useEffect(() => {
    if (!replacesInvitesRoute(view, role)) return;
    setView({ userId: null, invites: false, email: false });
    navigateRef.current({ app: "team", userId: null }, { replace: true });
  }, [role, view]);

  // Back/Forward between the list and a member (a dialog open at the time only closes).
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (popStateClosedDialog(event)) return;
      const route = parseRoute(window.location.pathname);
      if (route.app === "team") setView({ userId: route.userId, invites: route.invites === true, email: route.email === true, keys: route.keys === true, policies: route.policies === true });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // The member on the URL. A missing one falls back to the list with a toast.
  useEffect(() => {
    setDialog(null);
    if (!routeUserId || !visibleToRole) {
      setDetail(null);
      return;
    }
    const generation = ++detailGeneration.current;
    setDetail((current) => current?.id === routeUserId ? current : null);
    getTeamMember(routeUserId).then(({ member }) => {
      if (generation === detailGeneration.current) setDetail(member);
    }, (reason) => {
      if (generation !== detailGeneration.current) return;
      flash(reason instanceof ApiError && reason.status === 404 ? "Team member not found" : messageOf(reason, "Could not open this member"));
      go(null, true);
    });
  }, [flash, go, routeUserId, visibleToRole]);

  useEffect(() => {
    if (routeEmail || routeKeys || routePolicies) return;
    document.title = detail && routeUserId === detail.id ? `${detail.displayName} · Team · Nook` : routeInvites ? "Invites · Team · Nook" : "Team · Nook";
  }, [detail, routeEmail, routeInvites, routeKeys, routePolicies, routeUserId]);

  const back = useCallback(() => {
    const action = teamBackAction(routeRef.current, readHistoryDepth(window.history.state));
    if (action.kind === "history") window.history.back();
    else if (action.kind === "list") go(null, true);
    else onHome();
  }, [go, onHome]);

  /** A write answered with the member's new state: show it and refresh the list. */
  const applied = useCallback((member: TeamMemberDetail, message: string) => {
    setDetail(member);
    setDialog(null);
    flash(message);
    void loadList();
  }, [flash, loadList]);

  const all = members ?? [];
  const visible = useMemo(() => filterTeam(all, filter, query), [all, filter, query]);
  const chips = useMemo(() => teamFilters(all, admin), [all, admin]);

  return <main className={`app-page team-app${routeUserId || routeInvites || routeEmail || routeKeys || routePolicies ? " team-detail-open" : ""}`}>
    <header className="app-page-header">
      <button className="app-home-button" onClick={onHome}><House />Home</button>
      <span className="app-home-brand"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>Team</strong></span></span><AppPageName name="Team" />
      <AccountActions displayName={displayName} onSettings={onSettings} onSignOut={onSignOut} onBin={onBin} binCount={binCount} />
    </header>

    {!visibleToRole ? <div className="team-layout team-unavailable"><div className="team-state">
      <span className="team-state-icon"><Users /></span>
      <h2>Team is not available for your account</h2>
      <p>Ask an admin if you need to see who else uses this Nook.</p>
      <button className="primary-button" onClick={onHome}><House />Home</button>
    </div></div> : <div className="team-layout">
      <section className="team-list-pane" aria-labelledby="team-title">
        <div className="team-intro">
          <span className="eyebrow">Team</span>
          <h1 id="team-title">Team</h1>
          <p>{admin ? "Everyone with an account on this Nook. Change team roles, block or unblock accounts, and sign accounts out everywhere. Admins never see anyone's private content." : "Everyone with an account on this Nook and their team role."}</p>
        </div>

        <label className="team-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Search the team</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={admin ? "Search names or emails" : "Search names"} maxLength={120} />
        </label>

        <div className="team-filters" role="group" aria-label="Show">
          {chips.map(({ value, label, count }) => <button key={value} type="button" className={`team-chip${filter === value ? " active" : ""}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {label}{members && <b>{count}</b>}
          </button>)}
        </div>

        {admin && <button type="button" className={`team-invites-row${routeInvites ? " selected" : ""}`} aria-current={routeInvites ? "page" : undefined} onClick={() => { if (!routeInvites) openInvites(); }}>
          <span className="team-invites-icon" aria-hidden="true"><Link2 /></span>
          <span className="team-row-copy"><strong>Invites</strong><span className="team-row-meta">{invites ? `${invites.liveCount} live` : "Links to add people"}</span></span>
          <ChevronRight aria-hidden="true" />
        </button>}
        {admin && <button type="button" className={`team-invites-row${routeEmail ? " selected" : ""}`} aria-current={routeEmail ? "page" : undefined} onClick={() => { if (!routeEmail) openEmailLog(); }}>
          <span className="team-invites-icon" aria-hidden="true"><Mail /></span>
          <span className="team-row-copy"><strong>Email log</strong><span className="team-row-meta">What Nook emailed, and how it went</span></span>
          <ChevronRight aria-hidden="true" />
        </button>}
        {admin && <button type="button" className={`team-invites-row${routeKeys ? " selected" : ""}`} aria-current={routeKeys ? "page" : undefined} onClick={() => { if (!routeKeys) openKeys(); }}>
          <span className="team-invites-icon" aria-hidden="true"><KeyRound /></span>
          <span className="team-row-copy"><strong>Keys</strong><span className="team-row-meta">Every API key on this Nook</span></span>
          <ChevronRight aria-hidden="true" />
        </button>}
        {admin && <button type="button" className={`team-invites-row${routePolicies ? " selected" : ""}`} aria-current={routePolicies ? "page" : undefined} onClick={() => { if (!routePolicies) openPolicies(); }}>
          <span className="team-invites-icon" aria-hidden="true"><Scale /></span>
          <span className="team-row-copy"><strong>Policies</strong><span className="team-row-meta">Key lifetime and where keys work</span></span>
          <ChevronRight aria-hidden="true" />
        </button>}

        {loadError && <div className="team-state team-error" role="alert">
          <span className="team-state-icon"><TriangleAlert /></span>
          <h2>Could not load the team</h2>
          <p>{loadError}</p>
          <button className="primary-button" onClick={() => { void loadList(); }}><RotateCcw />Try again</button>
        </div>}
        {!loadError && !members && <p className="team-loading" role="status">Loading the team…</p>}
        {!loadError && members && !visible.length && <div className="team-state">
          <span className="team-state-icon"><Users /></span>
          <h2>{query.trim() ? "Nobody matches that search." : "Nobody here yet."}</h2>
        </div>}
        {!loadError && visible.length > 0 && <ul className="team-list" aria-label="Team members">
          {visible.map((member) => <li key={member.id}>
            <button type="button" className={`team-row${member.id === routeUserId ? " selected" : ""}${member.status === "blocked" ? " blocked" : ""}`} aria-current={member.id === routeUserId ? "page" : undefined} onClick={() => { if (member.id !== routeUserId) go(member.id); }}>
              <span className="team-avatar" aria-hidden="true">{initialOf(member.displayName)}</span>
              <span className="team-row-copy">
                <span className="team-row-title">
                  <strong>{member.displayName}</strong>
                  {member.isYou && <span className="team-tag">You</span>}
                  {admin && isNewAccount(member.createdAt) && <span className="team-tag new">New</span>}
                </span>
                {admin && <span className="team-row-meta">
                  <span className="team-row-email">{member.email}</span>
                  {member.lastSeenAt ? <span>Seen {relativeTime(member.lastSeenAt)}</span> : <span>Not signed in</span>}
                </span>}
              </span>
              <span className="team-row-chips">
                <span className={`team-role-chip ${member.role}`}><span className="sr-only">Team role: </span>{ROLE_LABELS[member.role]}</span>
                {member.status === "blocked" && <span className="team-status-chip">{statusLabel(member)}</span>}
                {admin && member.emailAllowed === false && <span className="team-status-chip warn">Not on allowlist</span>}
              </span>
            </button>
          </li>)}
        </ul>}
      </section>

      <section className="team-detail-pane" aria-label={routeInvites ? "Invites" : routeEmail ? "Email log" : routeKeys ? "Keys" : routePolicies ? "Policies" : "Team member"}>
        {routeEmail
          ? <TeamEmailLog onBack={back} flash={flash} />
          : routeKeys
          ? <TeamKeys members={all} onBack={back} flash={flash} />
          : routePolicies
          ? <TeamPolicies onBack={back} flash={flash} />
          : routeInvites
          ? <TeamInvites data={invites} error={invitesError} onBack={back} onReload={() => { void loadInvites(); void loadList(); }} onOpenMember={(userId) => go(userId)} flash={flash} />
          : routeUserId && detail?.id === routeUserId
          ? <MemberDetail member={detail} members={all} admin={admin} onBack={back} onAction={setDialog} onRoleChosen={(to) => setDialog({ kind: "role", to })} />
          : routeUserId
            ? <p className="team-loading" role="status">Loading…</p>
            : <div className="team-placeholder"><Users aria-hidden="true" /><p>Choose someone to see their team role{admin ? ", account details, and activity" : ""}.</p></div>}
      </section>
    </div>}

    {dialog && detail && <TeamDialog
      dialog={dialog}
      member={detail}
      onClose={() => setDialog(null)}
      onDone={applied}
      onStale={(message) => {
        setDialog(null);
        flash(message);
        void loadList();
        getTeamMember(detail.id).then(({ member }) => setDetail(member), () => undefined);
      }}
    />}
  </main>;
}

function MemberDetail({ member, members, admin, onBack, onAction, onRoleChosen }: {
  member: TeamMemberDetail;
  members: readonly TeamMember[];
  admin: boolean;
  onBack: () => void;
  onAction: (dialog: Dialog) => void;
  onRoleChosen: (role: Role) => void;
}) {
  const lockedByLastAdmin = lastAdminReason(member, members);
  const roleOptions = teamRoleOptions();
  const blocked = member.status === "blocked";
  const keys = member.mcpKeys?.live ?? 0;

  return <article className="team-detail">
    <button type="button" className="team-back" onClick={onBack}><ChevronLeft />Team</button>
    <header className="team-detail-header">
      <span className="team-avatar large" aria-hidden="true">{initialOf(member.displayName)}</span>
      <div>
        <h2>{member.displayName}{member.isYou && <span className="team-tag">You</span>}</h2>
        {admin && member.email && <p className="team-detail-email">{member.email}</p>}
        <p className="team-detail-status">
          <span className={blocked ? "team-status-chip" : "team-status-chip active"}>{statusLabel(member)}</span>
          {admin && member.emailAllowed === false && <span className="team-status-chip warn">Not on ALLOWED_EMAILS: cannot sign in</span>}
        </p>
      </div>
    </header>

    <section className="team-card" aria-labelledby="team-role-heading">
      <h3 id="team-role-heading">Team role</h3>
      {admin
        ? <>
          <Select
            labelledBy="team-role-heading"
            label="Team role"
            value={member.role}
            options={roleOptions}
            onChange={onRoleChosen}
            disabled={Boolean(lockedByLastAdmin)}
          />
          <p className="team-role-hint">{lockedByLastAdmin ?? ROLE_DESCRIPTIONS[member.role]}</p>
        </>
        : <p className="team-role-read"><strong>{ROLE_LABELS[member.role]}</strong><small>{ROLE_DESCRIPTIONS[member.role]}</small></p>}
    </section>

    {admin && !member.isYou && <section className="team-card team-actions" aria-label="Account actions">
      <button type="button" className="team-action" onClick={() => onAction({ kind: "revoke" })} disabled={blocked}><LogOut />Sign out everywhere</button>
      {blocked
        ? <button type="button" className="team-action" onClick={() => onAction({ kind: "unblock" })}><UserCheck />Unblock</button>
        : <button type="button" className="team-action danger" onClick={() => onAction({ kind: "block" })} disabled={Boolean(lockedByLastAdmin)}><UserX />Block</button>}
    </section>}
    {admin && member.isYou && <p className="team-self-note">This is your account. Sign out from the account menu; another admin can block or sign out your account.</p>}

    {admin && blocked && <section className="team-card team-blocked" aria-label="Block details">
      <p><ShieldAlert aria-hidden="true" />{member.blockedBy ? `Blocked by ${member.blockedBy.displayName}` : "Blocked before Team existed"}{member.blockedAt ? `, ${relativeTime(member.blockedAt)}` : ""}.</p>
      {member.blockReason && <p className="team-reason">Reason: {member.blockReason}</p>}
      <p className="team-muted">{keys > 0 ? `${keys} MCP key${keys === 1 ? " is" : "s are"} paused and resume on unblock. ` : ""}Calendar feeds pause too. The account's content stays shared as before.</p>
    </section>}

    <section className="team-card" aria-labelledby="team-facts-heading">
      <h3 id="team-facts-heading">Account</h3>
      <dl className="team-facts">
        <div><dt>Member since</dt><dd>{formatDate(member.createdAt)}</dd></div>
        {admin && <>
          <div><dt>Last seen</dt><dd>{member.lastSeenAt ? relativeTime(member.lastSeenAt) : "No active session"}</dd></div>
          <div><dt>Two-factor</dt><dd>{member.totpEnabled ? <><ShieldCheck aria-hidden="true" />On</> : "Off"}</dd></div>
          <div><dt>MCP keys</dt><dd>{keys === 0 ? "None" : `${keys} ${blocked ? "paused" : "live"}`}</dd></div>
          <div><dt>Storage</dt><dd>{formatBytes(member.storageBytes ?? 0)}</dd></div>
        </>}
      </dl>
    </section>

    {admin && member.events && <section className="team-card" aria-labelledby="team-activity-heading">
      <h3 id="team-activity-heading">Activity</h3>
      {member.events.length === 0 && !member.joinedWithInvite
        ? <p className="team-muted">No team changes yet.</p>
        : <ol className="team-activity">
          {member.events.map((event) => <li key={event.id}>
            <span>{eventLabel(event)}</span>
            {event.reason && <small className="team-reason">“{event.reason}”</small>}
            <time dateTime={event.createdAt} title={new Date(event.createdAt).toLocaleString()}>{relativeTime(event.createdAt)}</time>
          </li>)}
          {member.joinedWithInvite && <li>
            <span>{joinedLabel(member.joinedWithInvite)}</span>
            <time dateTime={member.joinedWithInvite.usedAt} title={new Date(member.joinedWithInvite.usedAt).toLocaleString()}>{relativeTime(member.joinedWithInvite.usedAt)}</time>
          </li>}
        </ol>}
    </section>}
  </article>;
}

function TeamDialog({ dialog, member, onClose, onDone, onStale }: {
  dialog: Dialog;
  member: TeamMemberDetail;
  onClose: () => void;
  onDone: (member: TeamMemberDetail, message: string) => void;
  onStale: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const titleId = "team-dialog-title";

  useHistoryDialogGuard(true, onClose);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const copy = dialog.kind === "role"
    ? { title: `Make ${member.displayName} ${ROLE_LABELS[dialog.to] === "Admin" ? "an admin" : `a ${ROLE_LABELS[dialog.to].toLowerCase()}`}?`, body: roleChangeBody(member, dialog.to), confirm: "Change role" }
    : dialog.kind === "block"
      ? { title: `Block ${member.displayName}?`, body: "They are signed out on every device at once and cannot sign in until an admin unblocks them. Their MCP keys and calendar feeds pause. Their notes, files, and other content stay shared as before.", confirm: "Block" }
      : dialog.kind === "unblock"
        ? { title: `Unblock ${member.displayName}?`, body: "They can sign in again with their existing password and two-factor code. Their MCP keys and calendar feeds resume; push notifications must be turned on again on each device.", confirm: "Unblock" }
        : { title: `Sign ${member.displayName} out everywhere?`, body: "Every session on every device ends now. They can sign in again straight away.", confirm: "Sign out everywhere" };

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      if (dialog.kind === "role") {
        const result = await setTeamRole(member.id, { role: dialog.to, expectedRole: member.role });
        onDone(result.member, `${member.displayName} is now ${ROLE_LABELS[result.role] === "Admin" ? "an admin" : `a ${ROLE_LABELS[result.role].toLowerCase()}`}`);
      } else if (dialog.kind === "block") {
        const reason = String(form.get("reason") ?? "").trim();
        const result = await blockTeamMember(member.id, reason ? { reason } : {});
        onDone(result.member, `${member.displayName} is blocked and signed out everywhere`);
      } else if (dialog.kind === "unblock") {
        onDone((await unblockTeamMember(member.id)).member, `${member.displayName} is unblocked`);
      } else {
        const result = await revokeTeamSessions(member.id);
        onDone(result.member, result.sessionsRevoked ? `${member.displayName} was signed out everywhere` : `${member.displayName} had no active sessions`);
      }
    } catch (reason) {
      const code = errorCode(reason);
      if (code === "ROLE_CHANGED" || code === "ALREADY_BLOCKED" || code === "NOT_BLOCKED") onStale(`${messageOf(reason, "This account changed")}`);
      else setError(messageOf(reason, "Something went wrong"));
      setBusy(false);
    }
  }

  return <>
    <button type="button" className="panel-scrim team-dialog-scrim" onClick={() => { if (!busy) onClose(); }} aria-label="Close" tabIndex={-1} />
    <div className="team-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header>
        <h2 id={titleId}>{copy.title}</h2>
        <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close"><X /></button>
      </header>
      <form onSubmit={submit}>
        <p>{copy.body}</p>
        {dialog.kind === "block" && <label className="team-field">Reason (optional, only admins see it)<textarea name="reason" maxLength={200} rows={2} autoFocus /></label>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="team-dialog-actions">
          <button type="button" className="team-action" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className={`team-action primary${dialog.kind === "block" ? " danger" : ""}`} disabled={busy} autoFocus={dialog.kind !== "block"}>{busy ? "Working…" : copy.confirm}</button>
        </div>
      </form>
    </div>
  </>;
}
