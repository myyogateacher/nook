import type { Route } from "./router";

export type ReportsRoute = Extract<Route, { app: "reports" }>;

/** A route for the Reports app (Wave 45): the list, or one report. */
export function reportsRoute(reportId: string | null = null): ReportsRoute {
  return { app: "reports", reportId };
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
