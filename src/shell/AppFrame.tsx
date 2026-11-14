import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
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
 * the page header's ☰ opens. Full-screen surfaces drop to the rail or hide it in CSS (sidebar.css):
 * a whiteboard canvas covers the frame; a full-page task card shows the rail.
 */
export function AppFrame({ tree, displayName, avatarUrl, onNavigate, onSearch, onAccount, onSignOut, guard, children }: AppFrameProps) {
  const sidebar = useSidebarState();
  const { mode, drawerOpen, closeDrawer, openDrawer } = sidebar;
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

  const shell = useMemo<ShellValue>(() => ({ mode, drawerOpen, openDrawer, attention, leaveGuardRef }), [mode, drawerOpen, openDrawer, attention]);

  const drawerRef = useRef<HTMLDivElement>(null);
  useReturnFocus(drawerOpen, ".shell-menu-button");
  useEffect(() => { if (drawerOpen) focusIntoDialog(drawerRef.current?.querySelector(".app-sidebar") as HTMLElement | null); }, [drawerOpen]);

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
    onClose={drawer ? closeDrawer : undefined}
  />;

  return <ShellContext.Provider value={shell}>
    <div className="app-frame" data-sidebar={mode}>
      {mode !== "drawer" && sidebarElement(false)}
      <div className="app-frame-page">{children}</div>
      {mode === "drawer" && drawerOpen && <div className="app-drawer-layer">
        <button type="button" className="app-drawer-scrim" tabIndex={-1} aria-label="Close menu" onClick={closeDrawer} />
        <div ref={drawerRef} id="app-drawer" className="app-drawer" role="dialog" aria-modal="true" aria-label="Menu"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); closeDrawer(); return; }
            trapTabKey(event);
          }}>
          {sidebarElement(true)}
        </div>
      </div>}
    </div>
  </ShellContext.Provider>;
}
