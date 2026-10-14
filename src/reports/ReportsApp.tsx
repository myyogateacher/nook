import { useCallback, useEffect, useRef, useState } from "react";
import { readHistoryDepth } from "../appShellNavigation";
import { popStateClosedDialog } from "../historyDialogs";
import { parseRoute, type Route } from "../router";
import { reportsBackAction, reportsFolderRoute, reportsRoute, type ReportsRoute } from "../reportsRoute";
import { ReportPage } from "./ReportPage";
import { ReportsHome } from "./ReportsHome";
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
  const route = parseRoute(window.location.pathname);
  return route.app === "reports" ? route : reportsRoute();
};

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
      const next = parseRoute(window.location.pathname);
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
    return <ReportPage key={route.reportId} reportId={route.reportId} {...account} flash={flash} onBack={back}
      onGone={() => go(reportsRoute(), { replace: true, removed: true })} />;
  }
  // Lane I: each folder view is its own entry, so Back and Forward step between folders.
  return <ReportsHome {...account} role={role} flash={flash} onHome={onHome} onOpen={(id) => go(reportsRoute(id))} onOpenDatasources={onOpenDatasources} onOpenToolServers={onOpenToolServers}
    folder={route.folder ?? null} onFolder={(view, options) => { if ((route.folder ?? null) !== view) go(reportsFolderRoute(view), options); }} />;
}
