import type { Route } from "./router";

export type WhiteboardsRoute = Extract<Route, { app: "whiteboards" }>;

/** A route for the Whiteboards app: the list (all, shared, or a folder) or one board's canvas. */
export function whiteboardsRoute(folder: "all" | "shared" | string = "all", boardId: string | null = null): WhiteboardsRoute {
  return { app: "whiteboards", folder, boardId };
}

/**
 * In-app Back (the canvas's ‹ and the list's Home): step back through entries this visit pushed
 * (the `mynotes.depth` counter), so it matches the browser's Back; from a deep link replace the
 * canvas with the list; from the list go Home. It never leaves Nook.
 */
export function whiteboardsBackAction(route: WhiteboardsRoute, depth: number): { kind: "history" } | { kind: "replace"; route: WhiteboardsRoute } | { kind: "home" } {
  if (route.boardId) return depth > 0 ? { kind: "history" } : { kind: "replace", route: whiteboardsRoute(route.folder) };
  return { kind: "home" };
}
