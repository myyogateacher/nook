import { useEffect, useId, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronsUpDown, LogOut, PanelLeftClose, PanelLeftOpen, Sparkles, UserRound, X } from "lucide-react";
import { TopBarItems } from "../AppShell";
import { appName } from "../appName";
import { Avatar } from "../ui/Avatar";
import { useSelfAvatar } from "../ui/selfAvatar";
import type { NavItem, NavTree } from "./navModel";
import type { SidebarMode } from "./useSidebarState";
import "./sidebar.css";

export type AppSidebarProps = {
  tree: NavTree;
  mode: SidebarMode;
  displayName: string;
  avatarUrl?: string | null;
  /** Pending Inbox proposals and unread notifications, for the badges. */
  inboxCount: number;
  unreadCount: number;
  /** A plain click on an item (middle-click and modifier clicks keep the browser's behaviour). */
  onNavigate: (item: NavItem) => void;
  /** The Search row: Notes' search box until the ⌘K palette (phase 4). */
  onSearch: () => void;
  onAccount: () => void;
  onSignOut: () => void;
  /** Expanded ↔ rail (computers). */
  onToggle: () => void;
  /** Closes the drawer (phones). */
  onClose?: () => void;
  /** The rail is held by the page (a full-page task card): the toggle is unavailable and says why. */
  railForced?: boolean;
};

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
export const toggleShortcutLabel = () => isMac() ? "⌘\\" : "Ctrl+\\";
const badgeText = (count: number) => count > 99 ? "99+" : String(count);

/** A plain left click, not one the browser should handle (new tab, download, …). */
export function isPlainClick(event: Pick<ReactMouseEvent, "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

type Tip = { label: string; top: number; left: number };

/**
 * The global sidebar (docs/plan/LEFT_NAV.md §2.1, D1270–D1274): brand and collapse toggle; Search;
 * Home, Inbox, Notifications; the apps in `MODULES` order with the one on screen marked
 * aria-current="page"; then the timer chip, Settings, and the account row (a menu with Account and
 * Sign out). Every item is a real link (`href`), routed in the app on a plain click through App's
 * `openApp`, so Notes' save-on-leave and the Settings hub's guard still run. In the rail (56 px) the
 * labels are visually hidden, still naming each link, and a tooltip shows on hover and on focus.
 */
export function AppSidebar({ tree, mode, displayName, avatarUrl, inboxCount, unreadCount, onNavigate, onSearch, onAccount, onSignOut, onToggle, onClose, railForced = false }: AppSidebarProps) {
  const rail = mode === "rail";
  const [tip, setTip] = useState<Tip | null>(null);
  useEffect(() => { if (!rail) setTip(null); }, [rail]);
  const showTip = (label: string, element: HTMLElement) => {
    if (!rail) return;
    const box = element.getBoundingClientRect();
    setTip({ label, top: box.top + box.height / 2, left: box.right + 8 });
  };
  const hideTip = () => setTip(null);
  const tipHandlers = (label: string) => rail ? {
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => showTip(label, event.currentTarget),
    onMouseLeave: hideTip,
    onFocus: (event: ReactFocusEvent<HTMLElement>) => showTip(label, event.currentTarget),
    onBlur: hideTip
  } : {};

  const badgeFor = (item: NavItem) => item.kind === "inbox" ? inboxCount : item.kind === "notifications" ? unreadCount : 0;
  const link = (item: NavItem, onClick: () => void) => {
    const Icon = item.icon;
    const badge = badgeFor(item);
    const label = badge > 0 ? `${item.label}, ${badge >= 100 ? "100 or more" : badge} ${item.kind === "inbox" ? "pending" : "unread"}` : undefined;
    return <li key={item.id}>
      <a className={`app-sidebar-link${item.current ? " active" : ""}`} href={item.href} aria-current={item.current ? "page" : undefined} aria-label={label}
        onClick={(event) => { if (!isPlainClick(event)) return; event.preventDefault(); hideTip(); onClick(); }} {...tipHandlers(item.label)}>
        <Icon aria-hidden="true" /><span className="app-sidebar-label">{item.label}</span>
        {badge > 0 && <span className={`app-sidebar-badge app-sidebar-badge-${item.kind}`} aria-hidden="true">{badgeText(badge)}</span>}
      </a>
    </li>;
  };
  const expandLabel = mode === "expanded" ? "Collapse sidebar" : "Expand sidebar";
  const toggleHint = railForced ? "The sidebar stays narrow while a card is open full-page" : `${expandLabel} (${toggleShortcutLabel()})`;

  return <nav className="app-sidebar" aria-label="Workspace" data-mode={mode} id={mode === "drawer" ? undefined : "app-sidebar"}>
    <div className="app-sidebar-head">
      <a className="app-sidebar-brand" href="/" onClick={(event) => { if (!isPlainClick(event)) return; event.preventDefault(); onNavigate(tree.primary[0]!); }} {...tipHandlers(appName())}>
        <span className="brand-dot" aria-hidden="true"><Sparkles /></span><span className="app-sidebar-label app-sidebar-brand-name">{appName()}</span>
      </a>
      {mode === "drawer"
        ? <button type="button" className="app-sidebar-toggle" onClick={onClose} aria-label="Close menu"><X aria-hidden="true" /></button>
        : <button type="button" className="app-sidebar-toggle" onClick={() => { hideTip(); if (!railForced) onToggle(); }} aria-expanded={mode === "expanded"} aria-controls="app-sidebar"
          aria-label={expandLabel} aria-disabled={railForced || undefined} aria-description={railForced ? toggleHint : undefined}
          aria-keyshortcuts={railForced ? undefined : isMac() ? "Meta+\\" : "Control+\\"} title={toggleHint} {...tipHandlers(toggleHint)}>
          {mode === "expanded" ? <PanelLeftClose aria-hidden="true" /> : <PanelLeftOpen aria-hidden="true" />}
        </button>}
    </div>
    <div className="app-sidebar-scroll" onScroll={hideTip}>
      <ul className="app-sidebar-list">
        {tree.search && link(tree.search, onSearch)}
        {tree.primary.map((item) => link(item, () => onNavigate(item)))}
      </ul>
      {tree.apps.length > 0 && <>
        <p className="app-sidebar-heading" id="app-sidebar-apps">Apps</p>
        <ul className="app-sidebar-list" aria-labelledby="app-sidebar-apps">
          {tree.apps.map((item) => link(item, () => onNavigate(item)))}
        </ul>
      </>}
    </div>
    <div className="app-sidebar-foot">
      <div className="app-sidebar-timer"><TopBarItems /></div>
      <ul className="app-sidebar-list">{link(tree.settings, () => onNavigate(tree.settings))}</ul>
      <AccountMenu displayName={displayName} avatarUrl={avatarUrl} rail={rail} onAccount={onAccount} onSignOut={onSignOut} tipHandlers={tipHandlers(displayName)} />
    </div>
    {tip && <span className="app-sidebar-tip" role="tooltip" aria-hidden="true" style={{ top: tip.top, left: tip.left }}>{tip.label}</span>}
  </nav>;
}

function AccountMenu({ displayName, avatarUrl, rail, onAccount, onSignOut, tipHandlers }: { displayName: string; avatarUrl?: string | null; rail: boolean; onAccount: () => void; onSignOut: () => void; tipHandlers: object }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const selfAvatar = useSelfAvatar(avatarUrl);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onPointer = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (index: number) => { event.preventDefault(); items[(index + items.length) % items.length]?.focus(); };
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === "Tab") setOpen(false);
  };
  const pick = (action: () => void) => { setOpen(false); action(); };

  return <div ref={rootRef} className="app-sidebar-account">
    <button ref={buttonRef} type="button" className="app-sidebar-account-button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      aria-label={`Account: ${displayName}`} onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => { if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !open) { event.preventDefault(); setOpen(true); } }} {...(open ? {} : tipHandlers)}>
      <Avatar className="app-user-avatar" name={displayName} url={selfAvatar} />
      <span className="app-sidebar-label app-sidebar-account-name">{displayName}</span>
      {!rail && <ChevronsUpDown className="app-sidebar-account-chevron" aria-hidden="true" />}
    </button>
    {open && <ul id={menuId} className="ui-menu app-sidebar-account-menu" role="menu" aria-label={`Account: ${displayName}`} onKeyDown={onKeyDown}>
      <li role="none"><button type="button" role="menuitem" className="ui-menu-item" onClick={() => pick(onAccount)}><UserRound aria-hidden="true" />Account and security</button></li>
      <li role="none"><button type="button" role="menuitem" className="ui-menu-item" onClick={() => pick(onSignOut)}><LogOut aria-hidden="true" />Sign out</button></li>
    </ul>}
  </div>;
}
