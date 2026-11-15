import { useCallback, useEffect, useRef, useState } from "react";
import { readHistoryDepth } from "../appShellNavigation";
import { popStateClosedDialog } from "../historyDialogs";
import { formatRoute, parseRoute, type Route } from "../router";
import { reportsBackAction, reportsFolderRoute, reportsRoute, type ReportsRoute } from "../reportsRoute";
import { ReportPage } from "./ReportPage";
import { ReportsHome } from "./ReportsHome";
import { ReportFolderNav } from "./ReportFolderNav";
import { listFolders, listLists } from "./reportsApi";
import { ShellSidebarPortal, useShellSidebarSlot } from "../shell/shellContext";
import type { ReportsFolderView } from "../router";
import type { ReportFolderTree, ReportListSummary } from "../../shared/reports";
import "./reports.css";

type ReportsNavigate = (route: Route, options?: { replace?: boolean; removed?: boolean }) => void;

type ReportsAppProps = {
  displayName: string;
  role: string;
  navigate: ReportsNavigate;
  flash: (message: string) => void;
  onHome: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  /** Opens Settings → Report data sources (admins). */
  onOpenDatasources: () => void;
  /** Opens Settings → AI → Tool servers (admins). */
  onOpenToolServers?: () => void;
};

const currentRoute = (): ReportsRoute => {
  // Phase 1: the list's filters ride in the query.
  const route = parseRoute(window.location.pathname, window.location.search);
  return route.app === "reports" ? route : reportsRoute();
};

/**
 * The Reports tree in the global sidebar while one report is open (phase 3, D1289): All, Favorites,
 * Unfiled, the folders, the lists, and Shared with me, as links to each view (none is current: the
 * page is one report). Filing, renaming, and drops stay on the Reports home, which draws the full nav.
 */
function ReportPageSidebarNav({ onFolder }: { onFolder: (view: ReportsFolderView | null) => void }) {
  const slot = useShellSidebarSlot();
  const [tree, setTree] = useState<ReportFolderTree | null>(null);
  const [lists, setLists] = useState<ReportListSummary[] | null>(null);
  const wanted = slot !== null;
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    listFolders().then((next) => { if (live) setTree(next); }, () => undefined);
    listLists().then((next) => { if (live) setLists(next.lists); }, () => undefined);
    return () => { live = false; };
  }, [wanted]);
  return <ShellSidebarPortal>
    <ReportFolderNav tree={tree} view={""} onSelect={onFolder} canWrite={false} dragging={null} onDropReport={() => undefined} onNewFolder={() => undefined}
      actions={NO_FOLDER_ACTIONS} lists={lists} hrefFor={(view) => formatRoute(reportsFolderRoute(view))} />
  </ShellSidebarPortal>;
}
const noop = () => undefined;
const NO_FOLDER_ACTIONS = { rename: noop, newSubfolder: noop, newReportIn: noop, remove: noop, moveTo: noop, place: noop };

/**
 * Analytics reports (Wave 45, docs/plan/WAVES_45-48_REPORTS.md): the list at /reports and one report at
 * /reports/:id, each a history entry. Sheets (New report, the Schema browser, confirms) push none:
 * Back closes them first (D18), then the report, then the app; Back never leaves Nook before Home.
 */
export function ReportsApp({ displayName, role, navigate, flash, onHome, onSettings, onSignOut, onOpenDatasources, onOpenToolServers }: ReportsAppProps) {
  const [route, setRoute] = useState<ReportsRoute>(currentRoute);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const go = useCallback((next: ReportsRoute, options: { replace?: boolean; removed?: boolean } = {}) => {
    setRoute(next);
    navigateRef.current(next, options);
  }, []);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (popStateClosedDialog(event)) return;
      const next = parseRoute(window.location.pathname, window.location.search);
      if (next.app === "reports") setRoute(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const back = useCallback(() => {
    const action = reportsBackAction(currentRoute(), readHistoryDepth(window.history.state));
    if (action.kind === "history") window.history.back();
    else if (action.kind === "replace") go(action.route, { replace: true });
    else onHome();
  }, [go, onHome]);

  const account = { displayName, onSettings, onSignOut };
  if (route.reportId) {
    // D489: the report's parameter values live in its URL; each change is a history entry, so Back and
    // Forward step through them and a shared link reproduces them.
    return <><ReportPageSidebarNav onFolder={(view) => go(reportsFolderRoute(view))} /><ReportPage key={route.reportId} reportId={route.reportId} {...account} flash={flash} onBack={back}
      params={route.params} onParams={(params, options) => { const next: ReportsRoute = { app: "reports", reportId: route.reportId, ...(params ? { params } : {}) }; if (formatRoute(next) !== formatRoute(route)) go(next, options); }}
      onGone={() => go(reportsRoute(), { replace: true, removed: true })} onOpenReport={(id) => go(reportsRoute(id))} /></>;
  }
  // Lane I: each folder view is its own entry, so Back and Forward step between folders.
  return <ReportsHome {...account} role={role} flash={flash} onHome={onHome} onOpen={(id) => go(reportsRoute(id))} onOpenDatasources={onOpenDatasources} onOpenToolServers={onOpenToolServers}
    folder={route.folder ?? null} onFolder={(view, options) => { if ((route.folder ?? null) !== view) go(reportsFolderRoute(view, route.filter), options); }}
    filter={route.filter} onFilter={(filter) => { const next = reportsFolderRoute(route.folder ?? null, filter); if (formatRoute(next) !== formatRoute(route)) go(next); }} />;
}
