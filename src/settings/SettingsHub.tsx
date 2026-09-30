import type { ReactNode } from "react";
import { Bell, Bot, ChevronLeft, ChevronRight, History, House, Info, KeyRound, LayoutGrid, LayoutTemplate, Link2, Mail, Scale, Share2, ShieldCheck, Sparkles, Users, UsersRound, type LucideIcon } from "lucide-react";
import { AppPageName } from "../AppShell";
import { Avatar } from "../ui/Avatar";
import { ROLE_LABELS, type Role } from "../team/teamRoles";
import type { HubEntry, HubEntryId } from "./hubModel";
import "./settingsHub.css";

const ICONS: Record<HubEntryId, LucideIcon> = {
  security: ShieldCheck, notifications: Bell, access: Share2, mcp: KeyRound, modules: LayoutGrid, about: Info,
  "team-members": Users, "team-invites": Link2, "team-groups": UsersRound, "team-integrations": Bot, "team-keys": KeyRound,
  "team-policies": Scale, "team-templates": LayoutTemplate, "team-activity": History, "team-email": Mail
};

/** One line under each entry on the phone's section list (the computer's nav shows labels only). */
const HINTS: Record<HubEntryId, string> = {
  security: "Password, two-factor, and Google sign-in", notifications: "Push and email", access: "What others share with you",
  mcp: "Keys for AI clients and scripts", modules: "Turn parts of Nook on or off", about: "Version and source",
  "team-members": "Everyone on this Nook and their team role", "team-invites": "Links to add people", "team-groups": "Share with a team at once",
  "team-integrations": "Accounts for AI clients and scripts", "team-keys": "Every API key on this Nook", "team-policies": "Key lifetime and where keys work",
  "team-templates": "A role and groups for new people", "team-activity": "Who changed keys, groups, and access", "team-email": "What Nook emailed, and how it went"
};

type HubShellProps = {
  displayName: string;
  avatarUrl?: string | null;
  role: Role | undefined;
  entries: readonly HubEntry[];
  /** The entry on screen; on the bare /settings a computer shows Security, a phone the list. */
  selected: HubEntryId;
  /** True on the bare /settings: phones show the section list, not a section. */
  listScreen: boolean;
  title: string;
  /** Phones: the section's back arrow to the list; hidden on a page below a section (it has its own). */
  showBack: boolean;
  onBack: () => void;
  onSelect: (entry: HubEntry) => void;
  /** Absent while two-factor setup is required: the page is the only way on. */
  onHome?: () => void;
  account: ReactNode;
  children: ReactNode;
};

/**
 * The Settings hub (Wave 37): a page, not a dialog. A left nav (Account, and Team for the roles that
 * see it) beside the section on screen on a computer, each pane scrolling on its own. On a phone the
 * nav is the first screen (/settings) and a section opens as a screen of its own with a back arrow;
 * both are history entries, so browser Back returns to the list, then to where Settings was opened.
 */
export function SettingsHubShell({ displayName, avatarUrl, role, entries, selected, listScreen, title, showBack, onBack, onSelect, onHome, account, children }: HubShellProps) {
  const roleLabel = role ? ROLE_LABELS[role] : null;
  const groups = [
    { id: "account", label: "Account", items: entries.filter((entry) => entry.group === "account") },
    { id: "team", label: "Team", items: entries.filter((entry) => entry.group === "team") }
  ].filter((group) => group.items.length > 0);
  return <main className={`app-page settings-hub${listScreen ? " settings-hub-list" : ""}`}>
    <header className="app-page-header">
      {onHome && <button className="app-home-button" onClick={onHome}><House />Home</button>}
      <span className="app-home-brand"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>Settings</strong></span></span><AppPageName name="Settings" />
      {account}
    </header>
    <div className="settings-hub-layout">
      <nav className="settings-hub-nav" aria-label="Settings sections">
        <div className="settings-hub-identity">
          <Avatar className="app-user-avatar settings-avatar" name={displayName} url={avatarUrl} />
          <div><strong>{displayName}</strong>{roleLabel && <small>{roleLabel}</small>}</div>
        </div>
        {groups.map((group) => <div key={group.id} className="settings-hub-group" role="group" aria-labelledby={`settings-hub-group-${group.id}`}>
          <h2 id={`settings-hub-group-${group.id}`}>{group.label}</h2>
          <ul>
            {group.items.map((entry) => {
              const Icon = ICONS[entry.id];
              const current = entry.id === selected;
              return <li key={entry.id}><button type="button" className={current ? "active" : ""} aria-current={current ? "page" : undefined} onClick={() => onSelect(entry)}>
                <Icon aria-hidden="true" />
                <span className="settings-hub-entry"><span>{entry.label}</span><small>{HINTS[entry.id]}</small></span>
                <ChevronRight className="settings-hub-chevron" aria-hidden="true" />
              </button></li>;
            })}
          </ul>
        </div>)}
      </nav>
      <section className="settings-hub-main" aria-labelledby="settings-hub-title">
        <header className="settings-hub-header">
          {showBack && <button type="button" className="icon-button settings-hub-back" onClick={onBack} aria-label="Back to Settings"><ChevronLeft /></button>}
          <Avatar className="app-user-avatar settings-avatar" name={displayName} url={avatarUrl} />
          <div className="settings-hub-heading">
            <span className="eyebrow">{displayName}{roleLabel ? ` · ${roleLabel}` : ""}</span>
            <h1 id="settings-hub-title">{title}</h1>
          </div>
        </header>
        {children}
      </section>
    </div>
  </main>;
}
