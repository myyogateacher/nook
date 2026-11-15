import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Menu } from "lucide-react";
import { NOTIFICATIONS_CHANGED } from "../notifications/NotificationBell";
import { listNotifications, NOTIFICATIONS_POLLED } from "../notifications/notificationsApi";
import type { SidebarMode } from "./useSidebarState";
import type { AppsLayout } from "./sidebarPrefs";

/** Runs `leave` now, or after the page on screen has agreed to be left (uploads running, unsaved edits). */
export type LeaveGuard = (leave: () => void) => void;

export type ShellValue = {
  mode: SidebarMode;
  drawerOpen: boolean;
  openDrawer: () => void;
  /** Something waits in the drawer (Inbox proposals, unread notifications): the ☰ button shows a dot. */
  attention: boolean;
  /** The page's own leave guard, consulted before the sidebar navigates or signs out. */
  leaveGuardRef: { current: LeaveGuard | null };
  /** Holds the sidebar in the rail while a full-screen surface needs the width; returns the release. */
  holdRail: () => () => void;
  /**
   * Phase 3 (D1287): where the app on screen draws its own tree in the sidebar (Notes' and Files'
   * folders, Reports' folders and lists, the Settings hub's sections, a standup's views): the slot
   * under its row (expanded, drawer) or in its flyout (rail). Null while no slot is shown.
   */
  sidebarSlot: HTMLElement | null;
  closeDrawer: () => void;
  /** Phase 4 (D1294): the person's app order and pins, for Home's phone tiles; null: the default. */
  appsLayout?: AppsLayout | null;
  /** Phase 4 (D1293): opens the ⌘K palette. */
  openPalette?: () => void;
};

/** The person's app order and pins inside the frame (Home's phone tiles follow the sidebar, D1294). */
export const useShellAppsLayout = () => useContext(ShellContext)?.appsLayout ?? null;

/** The app frame around the page (docs/plan/LEFT_NAV.md §3); null outside it (tests, public pages). */
export const ShellContext = createContext<ShellValue | null>(null);
export const useShell = () => useContext(ShellContext);

/**
 * Registers the page's leave guard with the frame while it is mounted (Files asks before leaving
 * while uploads run, C1). Notes and the Settings hub have their own guards in App.tsx.
 */
export function useShellLeaveGuard(guard: LeaveGuard) {
  const shell = useShell();
  const guardRef = useRef(guard);
  guardRef.current = guard;
  useEffect(() => {
    if (!shell) return;
    const ref = shell.leaveGuardRef;
    const registered: LeaveGuard = (leave) => guardRef.current(leave);
    ref.current = registered;
    return () => { if (ref.current === registered) ref.current = null; };
  }, [shell]);
}

/**
 * Keeps the sidebar in the rail while `active` (a task card opened full-page, D1279): the toggle is
 * unavailable meanwhile and says why. Outside the frame it does nothing.
 */
export function useShellRail(active: boolean) {
  const shell = useShell();
  const holdRail = shell?.holdRail;
  useEffect(() => (active && holdRail ? holdRail() : undefined), [active, holdRail]);
}

/**
 * The ☰ button that opens the sidebar drawer on phones (§2.5). Renders nothing outside the frame;
 * CSS shows it at 760 px and under only. Its dot says the drawer holds something new.
 */
export function ShellMenuButton({ className }: { className?: string }) {
  const shell = useShell();
  if (!shell) return null;
  return <button type="button" className={`shell-menu-button${className ? ` ${className}` : ""}`} onClick={shell.openDrawer}
    aria-label={shell.attention ? "Open menu, new items" : "Open menu"} aria-haspopup="dialog" aria-expanded={shell.drawerOpen} aria-controls="app-drawer">
    <Menu aria-hidden="true" />{shell.attention && <span className="shell-menu-dot" aria-hidden="true" />}
  </button>;
}

/**
 * The unread notification count for the sidebar's Notifications row: read once, then refreshed by
 * the bell's polls (their count rides on the event), by focus, and by marks elsewhere.
 */
export function useUnreadNotifications(enabled: boolean) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) { setCount(0); return; }
    let live = true;
    const fetchCount = () => { listNotifications({ unread: true, limit: 1 }).then(({ unreadCount }) => { if (live) setCount(unreadCount); }, () => undefined); };
    const onPolled = (event: Event) => {
      const unread = (event as CustomEvent<{ unread?: unknown } | null>).detail?.unread;
      if (typeof unread === "number") setCount(unread);
    };
    fetchCount();
    window.addEventListener(NOTIFICATIONS_POLLED, onPolled);
    window.addEventListener(NOTIFICATIONS_CHANGED, fetchCount);
    window.addEventListener("focus", fetchCount);
    return () => {
      live = false;
      window.removeEventListener(NOTIFICATIONS_POLLED, onPolled);
      window.removeEventListener(NOTIFICATIONS_CHANGED, fetchCount);
      window.removeEventListener("focus", fetchCount);
    };
  }, [enabled]);
  return count;
}

/** The sidebar slot for the app on screen (D1287); null outside the frame or while it is not shown. */
export const useShellSidebarSlot = () => useShell()?.sidebarSlot ?? null;

/**
 * Draws the app's own tree in the sidebar slot (D1287), so its state and handlers stay the app's
 * (Notes' save-on-leave, Files' drops, the Settings hub's leave guard). Nothing renders while the slot
 * is hidden (the rail with its flyout closed, the app's group closed, a phone with the drawer shut).
 */
export function ShellSidebarPortal({ children }: { children: ReactNode }) {
  const slot = useShellSidebarSlot();
  return slot ? createPortal(children, slot) : null;
}
