import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronRight, ChevronsUpDown, LogOut, PanelLeftClose, PanelLeftOpen, Sparkles, UserRound, X } from "lucide-react";
import { TopBarItems } from "../AppShell";
import { appName } from "../appName";
import { Avatar } from "../ui/Avatar";
import { useSelfAvatar } from "../ui/selfAvatar";
import { navItems, type NavItem, type NavTree } from "./navModel";
import { readExpandedApps, writeExpandedApps, type SidebarMode } from "./useSidebarState";
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
/** Hover intent for the sections flyout (D1285). */
export const FLYOUT_OPEN_MS = 150;
export const FLYOUT_CLOSE_MS = 250;
/** A pointer that hovers precisely (a mouse or trackpad): the expanded sidebar's hover flyout is for it alone. */
export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";
/** Focus that came from the keyboard (a click focuses the link too, which must not open a flyout). */
const keyboardFocus = (element: Element) => { try { return element.matches(":focus-visible"); } catch { return false; } };
const finePointer = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(FINE_POINTER_QUERY).matches;
/** The rail's open flyout: an app's sections beside its icon (D1281). */
type Flyout = { id: string; top: number; left: number };

/** Runs of children of one kind (sections, then recent items, or the other way round). */
function childGroups(children: readonly NavItem[]) {
  const groups: Array<{ kind: NavItem["kind"]; items: NavItem[] }> = [];
  for (const child of children) {
    const last = groups[groups.length - 1];
    if (last && last.kind === child.kind) last.items.push(child);
    else groups.push({ kind: child.kind, items: [child] });
  }
  return groups;
}

/**
 * The global sidebar (docs/plan/LEFT_NAV.md §2.1, D1270–D1274): brand and collapse toggle; Search;
 * Home, Inbox, Notifications; the apps in `MODULES` order with the one on screen marked
 * aria-current="page"; then the timer chip, Settings, and the account row (a menu with Account and
 * Sign out). Every item is a real link (`href`), routed in the app on a plain click through App's
 * `openApp`, so Notes' save-on-leave and the Settings hub's guard still run. In the rail (56 px) the
 * labels are visually hidden, still naming each link, and a tooltip shows on hover and on focus.
 *
 * Phase 2 (D1280–D1282): the app on screen expands in place to its sections (and recent boards or
 * collections), the one on screen marked aria-current="page" and its app row aria-current="true".
 * In the rail, hovering or focusing an app opens a flyout of its sections beside it: Tab walks into
 * it, Escape closes it and returns to the app. The list keeps the current app and its sections in
 * view whenever the page changes.
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

  // The sections flyout (D1281, D1285): beside the sidebar's edge, next to the app's row, with the
  // app's name and its section links. The rail opens it on hover and on focus; the expanded sidebar
  // on hover too, on pointer devices only (a fine pointer that hovers), for apps not already open in
  // place. Hover intent: it opens after 150 ms on the row and closes 250 ms after the pointer leaves
  // both the row and the flyout (an invisible bridge covers the gap between them). One at a time;
  // Escape closes it; never while the list is scrolling.
  const [flyout, setFlyout] = useState<Flyout | null>(null);
  const flyoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollingUntil = useRef(0);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const quietFocusRef = useRef(false);
  const cancelFlyoutClose = () => { if (flyoutTimer.current) { clearTimeout(flyoutTimer.current); flyoutTimer.current = null; } };
  const cancelFlyoutOpen = () => { if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; } };
  const openFlyout = (id: string, row: HTMLElement) => {
    cancelFlyoutClose();
    cancelFlyoutOpen();
    hideTip();
    const box = row.getBoundingClientRect();
    const edge = row.closest(".app-sidebar")?.getBoundingClientRect().right ?? box.right;
    setFlyout((current) => current?.id === id ? current : { id, top: box.top - 7, left: edge + 4 });
  };
  const openFlyoutSoon = (id: string, row: HTMLElement) => {
    cancelFlyoutClose();
    if (flyout?.id === id) return;
    cancelFlyoutOpen();
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      if (Date.now() < scrollingUntil.current || !row.isConnected) return;
      openFlyout(id, row);
    }, FLYOUT_OPEN_MS);
  };
  const closeFlyoutSoon = () => { cancelFlyoutOpen(); cancelFlyoutClose(); flyoutTimer.current = setTimeout(() => { flyoutTimer.current = null; setFlyout(null); }, FLYOUT_CLOSE_MS); };
  const closeFlyout = () => { cancelFlyoutOpen(); cancelFlyoutClose(); setFlyout(null); };
  useEffect(() => { closeFlyout(); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { cancelFlyoutClose(); cancelFlyoutOpen(); }, []);
  // Escape anywhere closes an open flyout (focus may still be on the page, after a hover).
  useEffect(() => {
    if (!flyout) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) closeFlyout(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flyout]); // eslint-disable-line react-hooks/exhaustive-deps
  // A flyout that would run off the bottom of the window moves up.
  useLayoutEffect(() => {
    const element = flyoutRef.current;
    if (!flyout || !element) return;
    const overflow = element.getBoundingClientRect().bottom - (window.innerHeight - 8);
    if (overflow > 0) element.style.top = `${Math.max(8, flyout.top - overflow)}px`;
  }, [flyout]);

  // D1284: every app with sections has a disclosure chevron. The app on screen is open (its chevron
  // can close it until the next app opens); any other app the person opened stays open, kept in
  // localStorage `nook.sidebar.expanded` across reloads.
  const [manualOpen, setManualOpen] = useState<string[]>(() => typeof window === "undefined" ? [] : readExpandedApps(window.localStorage));
  const [closedCurrent, setClosedCurrent] = useState<string | null>(null);
  const currentAppId = [...tree.primary, ...tree.apps].find((item) => item.current)?.id ?? null;
  useEffect(() => { setClosedCurrent(null); }, [currentAppId]);
  const isOpen = (item: NavItem) => (item.current && closedCurrent !== item.id) || manualOpen.includes(item.id);
  const setManual = (id: string, open: boolean) => setManualOpen((current) => {
    const next = open ? [...current.filter((entry) => entry !== id), id] : current.filter((entry) => entry !== id);
    if (typeof window !== "undefined") writeExpandedApps(window.localStorage, next);
    return next;
  });
  const toggleOpen = (item: NavItem, open: boolean) => {
    if (open) { if (item.current) setClosedCurrent(null); else setManual(item.id, true); return; }
    if (item.current) setClosedCurrent(item.id);
    setManual(item.id, false);
  };

  // Keep the app on screen and its sections in view (D1281), on every page change.
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentKey = navItems(tree).filter((item) => item.current).map((item) => item.id).join(",");
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const reveal = () => {
      const element = box.querySelector<HTMLElement>(".app-sidebar-app.is-current");
      if (!element || typeof element.getBoundingClientRect !== "function") return;
      const outer = box.getBoundingClientRect();
      const inner = element.getBoundingClientRect();
      if (inner.top < outer.top) box.scrollTop -= outer.top - inner.top + 4;
      // Down by as much as shows the whole group, never so far that its app row leaves the top.
      else if (inner.bottom > outer.bottom) box.scrollTop += Math.min(inner.bottom - outer.bottom + 4, inner.top - outer.top - 4);
    };
    reveal();
    // The footer (the timer chip) and badges settle a moment later and shrink the list: look again then.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    observer.observe(box);
    const stop = setTimeout(() => observer.disconnect(), 1500);
    return () => { clearTimeout(stop); observer.disconnect(); };
  }, [currentKey, mode]);

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
  const go = (item: NavItem) => () => { setFlyout(null); onNavigate(item); };
  const subLink = (item: NavItem) => <li key={item.id}>
    <a className={`app-sidebar-sublink${item.current ? " active" : ""}`} href={item.href} aria-current={item.current ? "page" : undefined}
      onClick={(event) => { if (!isPlainClick(event)) return; event.preventDefault(); go(item)(); }}>
      <span className="app-sidebar-label">{item.label}</span>
    </a>
  </li>;
  const subLists = (item: NavItem, idPrefix: string) => childGroups(item.children ?? []).map((group, index) => group.kind === "recent"
    ? <div key={`${group.kind}${index}`} className="app-sidebar-subgroup">
      <p className="app-sidebar-subheading" id={`${idPrefix}-recent`}>Recent</p>
      <ul className="app-sidebar-sublist" aria-labelledby={`${idPrefix}-recent`}>{group.items.map(subLink)}</ul>
    </div>
    : <ul key={`${group.kind}${index}`} className="app-sidebar-sublist" aria-label={`${item.label} sections`}>{group.items.map(subLink)}</ul>);

  /** An item with sections: expanded in place when on screen, a flyout in the rail. */
  const branch = (item: NavItem, onClick: () => void) => {
    const children = item.children ?? [];
    if (children.length === 0) return link(item, onClick);
    const childCurrent = children.some((child) => child.current);
    const Icon = item.icon;
    const badge = badgeFor(item);
    const label = badge > 0 ? `${item.label}, ${badge >= 100 ? "100 or more" : badge} ${item.kind === "inbox" ? "pending" : "unread"}` : undefined;
    const expanded = !rail && isOpen(item);
    // D1285: the rail always; the expanded sidebar for an app not open in place, on a hovering pointer.
    const hoverable = rail || (mode === "expanded" && !expanded);
    const open = hoverable && flyout?.id === item.id;
    const flyoutId = `app-sidebar-flyout-${item.id}`;
    const rowOf = (element: HTMLElement) => element.querySelector<HTMLElement>(".app-sidebar-link") ?? element;
    const railHandlers = hoverable ? {
      onMouseEnter: (event: ReactMouseEvent<HTMLLIElement>) => { if (rail || finePointer()) openFlyoutSoon(item.id, rowOf(event.currentTarget)); },
      onMouseLeave: closeFlyoutSoon,
      onFocus: (event: ReactFocusEvent<HTMLLIElement>) => {
        if (quietFocusRef.current) return;
        const target = event.target as HTMLElement;
        // The rail opens on the app's focus; the expanded sidebar on keyboard focus of the app or its chevron.
        if (target === rowOf(event.currentTarget) || (!rail && target.classList.contains("app-sidebar-disclosure"))) {
          if (rail || keyboardFocus(target)) openFlyout(item.id, rowOf(event.currentTarget));
        } else cancelFlyoutClose();
      },
      onBlur: (event: ReactFocusEvent<HTMLLIElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { cancelFlyoutClose(); setFlyout((current) => current?.id === item.id ? null : current); } },
      onKeyDown: (event: ReactKeyboardEvent<HTMLLIElement>) => {
        if (event.key === "Escape" && flyout?.id === item.id) {
          event.preventDefault();
          event.stopPropagation();
          closeFlyout();
          // Focus goes back to the app, which stays closed until the pointer or focus comes again.
          quietFocusRef.current = true;
          event.currentTarget.querySelector<HTMLElement>(".app-sidebar-link")?.focus();
          quietFocusRef.current = false;
        } else if (rail && event.key === "ArrowRight" && event.target === event.currentTarget.querySelector(".app-sidebar-link")) {
          event.preventDefault();
          openFlyout(item.id, event.target as HTMLElement);
          window.setTimeout(() => flyoutRef.current?.querySelector<HTMLElement>("a")?.focus(), 0);
        }
      }
    } : {};
    const sectionsId = `app-sidebar-sections-${item.id}`;
    return <li key={item.id} className={`app-sidebar-app${item.current ? " is-current" : ""}${expanded ? " is-open" : ""}`} {...railHandlers}>
      <div className="app-sidebar-row">
        <a className={`app-sidebar-link${item.current ? " active" : ""}${rail ? "" : " has-disclosure"}`} href={item.href} aria-current={item.current ? (childCurrent && (!rail || open) ? "true" : "page") : undefined} aria-label={label}
          aria-controls={open ? flyoutId : undefined} aria-expanded={rail ? open : undefined}
          onClick={(event) => { if (!isPlainClick(event)) return; event.preventDefault(); setFlyout(null); if (item.current) setClosedCurrent(null); onClick(); }}>
          <Icon aria-hidden="true" /><span className="app-sidebar-label">{item.label}</span>
          {badge > 0 && <span className={`app-sidebar-badge app-sidebar-badge-${item.kind}`} aria-hidden="true">{badgeText(badge)}</span>}
        </a>
        {!rail && <button type="button" className="app-sidebar-disclosure" aria-expanded={expanded} aria-controls={sectionsId}
          aria-label={`${expanded ? "Hide" : "Show"} ${item.label} sections`}
          onClick={() => { closeFlyout(); toggleOpen(item, !expanded); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" && !expanded) { event.preventDefault(); toggleOpen(item, true); }
            else if (event.key === "ArrowLeft" && expanded) { event.preventDefault(); toggleOpen(item, false); }
          }}><ChevronRight aria-hidden="true" /></button>}
      </div>
      {expanded && <div id={sectionsId} className="app-sidebar-sections">{subLists(item, `app-sidebar-${item.id}`)}</div>}
      {open && flyout && <div ref={flyoutRef} id={flyoutId} className="app-sidebar-flyout" role="group" data-anchor={rail ? "rail" : "expanded"} aria-label={`${item.label} sections`}
        style={{ top: flyout.top, left: flyout.left }} onMouseEnter={cancelFlyoutClose}>
        <div className="app-sidebar-flyout-body"><p className="app-sidebar-flyout-title" aria-hidden="true">{item.label}</p>
        {subLists(item, flyoutId)}</div>
      </div>}
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
    <div ref={scrollRef} className="app-sidebar-scroll" onScroll={() => { hideTip(); closeFlyout(); scrollingUntil.current = Date.now() + 200; }}>
      <ul className="app-sidebar-list">
        {tree.search && link(tree.search, onSearch)}
        {tree.primary.map((item) => branch(item, () => onNavigate(item)))}
      </ul>
      {tree.apps.length > 0 && <>
        <p className="app-sidebar-heading" id="app-sidebar-apps">Apps</p>
        <ul className="app-sidebar-list" aria-labelledby="app-sidebar-apps">
          {tree.apps.map((item) => branch(item, () => onNavigate(item)))}
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
