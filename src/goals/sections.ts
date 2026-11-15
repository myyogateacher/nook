import type { WorkspaceRoute, WorkspaceSectionDef } from "../workspaceModules/types";

/**
 * Goals' sections (D1280): the home's views, chosen with `?view=` (Tree has none). The period and
 * owner filters stay on the page. A goal's own page belongs to no section.
 */
export const GOALS_SECTIONS = [
  { id: "tree", label: "Tree", path: [] },
  { id: "list", label: "List", path: [], search: "?view=list" },
  { id: "timeline", label: "Timeline", path: [], search: "?view=timeline" },
  { id: "mine", label: "Mine", path: [], search: "?view=mine" },
  { id: "insights", label: "Insights", path: [], search: "?view=insights" }
] as const satisfies readonly WorkspaceSectionDef[];

export type GoalsView = typeof GOALS_SECTIONS[number]["id"];

/** The home's view for its query: an unknown or missing `view` is Tree. */
export function goalsViewOf(search: string): GoalsView {
  const view = new URLSearchParams(search).get("view");
  return GOALS_SECTIONS.find((section) => section.id === view)?.id ?? "tree";
}

export const goalsSectionOf = (route: Pick<WorkspaceRoute, "path" | "search">) => route.path[0] ? null : goalsViewOf(route.search);
