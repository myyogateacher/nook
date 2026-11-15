import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useInboxCount } from "../AppShell";
import { focusIntoDialog, trapTabKey } from "../files/Dialog";
import { useReturnFocus } from "../calendar/hooks";
import { AppSidebar } from "./AppSidebar";
import type { NavItem, NavTree } from "./navModel";
import { ShellContext, useUnreadNotifications, type LeaveGuard, type ShellValue } from "./shellContext";
import { useSidebarState } from "./useSidebarState";
import "./sidebar.css";

export type AppFrameProps = {
  tree: NavTree;
  displayName: string;
  avatarUrl?: string | null;
  /** Opens an item's app through App's `openApp` (Notes saves first). */
  onNavigate: (item: NavItem) => void;
  onSearch: () => void;
  onAccount: () => void;
  onSignOut: () => void;
  /**
   * App's own leave guard (the Settings hub's unsaved-key confirm), asked before the page's guard
   * (Files' uploads) and before any sidebar move.
   */
  guard?: LeaveGuard;
  children: ReactNode;
};

/**
 * The signed-in app frame (docs/plan/LEFT_NAV.md §2.1, §3; D1270): a grid of the global sidebar and
 * the page. The page stays its own scroll container (scrollShells). On phones the sidebar is a modal
 * drawer (focus kept inside, Escape and the scrim close it, and it closes after any navigation) that
 * the page header's ☰ opens. A whiteboard canvas covers the frame (sidebar.css); a full-page task
 * card holds the rail through `useShellRail` (D1279).
 */
export function AppFrame({ tree, displayName, avatarUrl, onNavigate, onSearch, onAccount, onSignOut, guard, children }: AppFrameProps) {
  // A full-page task card holds the rail (D1279); phones keep the drawer.
  const [railHolds, setRailHolds] = useState(0);
  const sidebar = useSidebarState(railHolds > 0);
  const { drawerOpen, closeDrawer, openDrawer } = sidebar;
  const holdRail = useCallback(() => {
    setRailHolds((count) => count + 1);
    let released = false;
    return () => { if (!released) { released = true; setRailHolds((count) => count - 1); } };
  }, []);
  const railForced = railHolds > 0 && sidebar.mode !== "drawer";
  const mode = railForced ? "rail" : sidebar.mode;
  const leaveGuardRef = useRef<LeaveGuard | null>(null);
  const inboxShown = tree.primary.some((item) => item.kind === "inbox");
  const notificationsShown = tree.primary.some((item) => item.kind === "notifications");
  const inboxCount = useInboxCount(inboxShown);
  const unreadCount = useUnreadNotifications(notificationsShown);
  const attention = (inboxShown && inboxCount > 0) || (notificationsShown && unreadCount > 0);

  const guardRef = useRef(guard);
  guardRef.current = guard;
  /** App's guard, then the page's, then the move; the drawer closes first so a confirm is not under it. */
  const guarded = useCallback((action: () => void) => {
    closeDrawer();
    const page = () => { const pageGuard = leaveGuardRef.current; if (pageGuard) pageGuard(action); else action(); };
    const app = guardRef.current;
    if (app) app(page); else page();
  }, [closeDrawer]);

  // D1287: the slot the app on screen draws its own tree into (under its row, or in its flyout).
  const [sidebarSlot, setSidebarSlot] = useState<HTMLElement | null>(null);
  const shell = useMemo<ShellValue>(() => ({ mode, drawerOpen, openDrawer, closeDrawer, attention, leaveGuardRef, holdRail, sidebarSlot }), [mode, drawerOpen, openDrawer, closeDrawer, attention, holdRail, sidebarSlot]);

  const drawerRef = useRef<HTMLDivElement>(null);
  useReturnFocus(drawerOpen, ".shell-menu-button");
  useEffect(() => { if (drawerOpen) focusIntoDialog(drawerRef.current?.querySelector(".app-sidebar") as HTMLElement | null); }, [drawerOpen]);
  // The drawer's keys and clicks are native listeners: the app's tree in the slot is a portal, whose
  // React events bubble through the app, not through the drawer. Escape closes; Tab stays inside; a
  // link or action in the app's tree closes the drawer as any sidebar move does (a disclosure or a ⋯
  // menu's own button keeps it open).
  useEffect(() => {
    const element = drawerRef.current;
    if (!drawerOpen || !element) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); closeDrawer(); return; }
      trapTabKey(event as unknown as ReactKeyboardEvent<HTMLElement>);
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const action = target?.closest(".app-sidebar-slot a[href], .app-sidebar-slot button, .app-sidebar-slot [role='menuitem']");
      if (!action || action.closest("[data-keep-drawer]") || action.matches("[aria-haspopup='menu'], [aria-expanded]:not([role='menuitem'])")) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      closeDrawer();
    };
    element.addEventListener("keydown", onKeyDown);
    element.addEventListener("click", onClick);
    return () => { element.removeEventListener("keydown", onKeyDown); element.removeEventListener("click", onClick); };
  }, [drawerOpen, closeDrawer]);

  const sidebarElement = (drawer: boolean) => <AppSidebar
    tree={tree}
    mode={mode}
    displayName={displayName}
    avatarUrl={avatarUrl}
    inboxCount={inboxShown ? inboxCount : 0}
    unreadCount={notificationsShown ? unreadCount : 0}
    onNavigate={(item) => guarded(() => onNavigate(item))}
    onSearch={() => guarded(onSearch)}
    onAccount={() => guarded(onAccount)}
    onSignOut={() => guarded(onSignOut)}
    onToggle={sidebar.toggle}
    railForced={railForced}
    onClose={drawer ? closeDrawer : undefined}
    onSlot={setSidebarSlot}
  />;

  return <ShellContext.Provider value={shell}>
    <div className="app-frame" data-sidebar={mode}>
      {mode !== "drawer" && sidebarElement(false)}
      <div className="app-frame-page">{children}</div>
      {mode === "drawer" && drawerOpen && <div className="app-drawer-layer">
        <button type="button" className="app-drawer-scrim" tabIndex={-1} aria-label="Close menu" onClick={closeDrawer} />
        <div ref={drawerRef} id="app-drawer" className="app-drawer" role="dialog" aria-modal="true" aria-label="Menu">
          {sidebarElement(true)}
        </div>
      </div>}
    </div>
  </ShellContext.Provider>;
}
