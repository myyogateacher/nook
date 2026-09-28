import { createContext, useContext, useEffect, useState } from "react";
import { Inbox, LogOut, Settings, Trash2, Users } from "lucide-react";
import "./appShell.css";
import { listBin } from "./bin/binApi";
import { INBOX_CHANGED, pendingCount } from "./inbox/inboxApi";
import { useModuleEnabled } from "./modules";
import { NotificationBell } from "./notifications/NotificationBell";
import { NOTIFICATIONS_POLLED } from "./notifications/notificationsApi";
import { listTeam } from "./team/teamApi";
import { canManageTeam, canSeeTeam, type Role } from "./team/teamRoles";

/**
 * The Team button in the account row (D78), provided once by App so every app's header gets it
 * without each app wiring a prop. Hidden for guests and on the Team app itself.
 */
export type TeamNav = { role: Role | undefined; openTeam: () => void; onTeam: boolean };
export const TeamNavContext = createContext<TeamNav | null>(null);

/**
 * The Inbox button in the account row, next to the bell (agent inbox D157), provided once by App.
 * Hidden for guests (they have no inbox), when the Inbox module is off, and on the Inbox itself.
 */
export type InboxNav = { role: Role | undefined; openInbox: () => void; onInbox: boolean };
export const InboxNavContext = createContext<InboxNav | null>(null);

/**
 * The pending badge: a bounded count (at most 100, T51), fetched on mount, after inbox changes, and
 * whenever the bell refreshes (its poll and focus), so a new proposal shows without a reload.
 */
export function useInboxCount(enabled: boolean) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const refresh = () => { pendingCount().then(({ pending }) => { if (live) setCount(pending); }, () => undefined); };
    refresh();
    for (const name of INBOX_COUNT_SIGNALS) window.addEventListener(name, refresh);
    return () => {
      live = false;
      for (const name of INBOX_COUNT_SIGNALS) window.removeEventListener(name, refresh);
    };
  }, [enabled]);
  return count;
}

/** Window events that refresh the Inbox badge: inbox changes, the bell's refresh, and focus. */
export const INBOX_COUNT_SIGNALS = [INBOX_CHANGED, NOTIFICATIONS_POLLED, "focus"] as const;

function InboxButton({ nav }: { nav: InboxNav }) {
  const count = useInboxCount(true);
  const label = count > 0 ? `Inbox, ${count >= 100 ? "100 or more" : count} pending` : "Inbox";
  return <button className="app-account-button app-account-inbox" onClick={nav.openInbox} aria-label={label} title="Inbox"><Inbox /><span className="app-account-label">Inbox</span>{count > 0 && <span className="app-account-badge" aria-hidden="true">{count > 99 ? "99+" : count}</span>}</button>;
}

/** Admins see how many accounts are blocked: one lazy look on mount, like the Bin count. */
function useBlockedCount(enabled: boolean) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    listTeam().then(({ users }) => { if (live) setCount(users.filter((user) => user.status === "blocked").length); }, () => undefined);
    return () => { live = false; };
  }, [enabled]);
  return count;
}

function TeamButton({ nav }: { nav: TeamNav }) {
  const blocked = useBlockedCount(canManageTeam(nav.role));
  const label = blocked > 0 ? `Team, ${blocked} blocked` : "Team";
  return <button className="app-account-button app-account-bin" onClick={nav.openTeam} aria-label={label} title="Team"><Users /><span className="app-account-label">Team</span>{blocked > 0 && <span className="app-account-badge" aria-hidden="true">{blocked > 99 ? "99+" : blocked}</span>}</button>;
}

type AccountProps = {
  displayName: string;
  onSettings: () => void;
  onSignOut: () => void;
  /** Shown only where the Bin is a utility action (Home, which is Today); the Bin app itself leaves it out. */
  onBin?: () => void;
  binCount?: number;
};

export function AccountActions({ displayName, onSettings, onSignOut, onBin, binCount = 0 }: AccountProps) {
  // Bin turned off (D92): no Bin button, whatever the app passes. Deleting still moves items to the Bin.
  const binEnabled = useModuleEnabled("bin");
  // Team turned off hides its button too (admins still reach Team from Settings → Manage team).
  const teamEnabled = useModuleEnabled("team");
  const team = useContext(TeamNavContext);
  const inbox = useContext(InboxNavContext);
  const inboxEnabled = useModuleEnabled("inbox");
  const binLabel = binCount > 0 ? `Bin, ${binCount} item${binCount === 1 ? "" : "s"}` : "Bin";
  // The bell sits beside the group (it renders only inside the signed-in shell).
  return <><div className="app-account" role="group" aria-label="Account">
    <span className="app-home-user">{displayName}</span>
    <button className="app-account-button" onClick={onSettings} aria-haspopup="dialog" aria-controls="account-settings-dialog" aria-label={`Open settings for ${displayName}`} title="Settings"><Settings /><span className="app-account-label">Settings</span></button>
    {onBin && binEnabled && <button className="app-account-button app-account-bin" onClick={onBin} aria-label={binLabel} title="Bin"><Trash2 /><span className="app-account-label">Bin</span>{binCount > 0 && <span className="app-account-badge" aria-hidden="true">{binCount > 99 ? "99+" : binCount}</span>}</button>}
    {team && teamEnabled && canSeeTeam(team.role) && !team.onTeam && <TeamButton nav={team} />}
    <button className="app-account-button" onClick={onSignOut} title="Sign out"><LogOut /><span className="app-account-label">Sign out</span></button>
  </div>{inbox && inboxEnabled && inbox.role !== "guest" && !inbox.onInbox && <InboxButton nav={inbox} />}<NotificationBell /></>;
}

/**
 * The Bin badge count: one lazy look on mount (no polling); a failure leaves the plain Bin button.
 * `enabled` false skips the request where the header has no Bin button.
 */
export function useBinCount(enabled = true) {
  const [binCount, setBinCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    listBin().then(({ items }) => { if (live) setBinCount(items.length); }, () => undefined);
    return () => { live = false; };
  }, [enabled]);
  return binCount;
}

/**
 * The page name shown on phones, where the header's brand name is visually hidden to fit the
 * account buttons (F2). A compact eyebrow on its own header line; decorative, since the header's
 * brand text (or each page's h1) already names the app for assistive tech.
 */
export function AppPageName({ name }: { name: string }) {
  return <span className="app-page-name" aria-hidden="true">{name}</span>;
}

/**
 * The Inbox button for headers that do not use AccountActions (Files), with the same rules: hidden
 * for guests, when the Inbox module is off, and on the Inbox itself (QA note 3).
 */
export function HeaderInboxButton() {
  const inbox = useContext(InboxNavContext);
  const inboxEnabled = useModuleEnabled("inbox");
  if (!inbox || !inboxEnabled || inbox.role === "guest" || inbox.onInbox) return null;
  return <InboxButton nav={inbox} />;
}
