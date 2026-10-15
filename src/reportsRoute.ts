import type { ReportsFilter, ReportsFolderView, Route } from "./router";

export type ReportsRoute = Extract<Route, { app: "reports" }>;

/** A route for the Reports app (Wave 45): the list, or one report. */
export function reportsRoute(reportId: string | null = null): ReportsRoute {
  return { app: "reports", reportId };
}

/** Lane I: the list in one view: All (null), Unfiled, Shared with me, Favorites, or a folder by id; with the list's filters (phase 1). */
export function reportsFolderRoute(folder: ReportsFolderView | null, filter?: ReportsFilter): ReportsRoute {
  return { app: "reports", reportId: null, ...(folder ? { folder } : {}), ...(filter && Object.keys(filter).length ? { filter } : {}) };
}

/**
 * In-app Back (the report page's ‹ and the list's Home): step back through entries this visit pushed
 * (the `mynotes.depth` counter), so it matches the browser's Back; from a deep link replace the report
 * with the list; from the list go Home. It never leaves Nook.
 */
export function reportsBackAction(route: ReportsRoute, depth: number): { kind: "history" } | { kind: "replace"; route: ReportsRoute } | { kind: "home" } {
  if (route.reportId) return depth > 0 ? { kind: "history" } : { kind: "replace", route: reportsRoute() };
  return { kind: "home" };
}
