import type { WorkspaceRoute, WorkspaceSectionDef } from "../workspaceModules/types";

/**
 * Standups' sections (D1280). A standup's own Rounds / Insights / Settings stay on its page (they need
 * the standup's name, which the sidebar does not load).
 */
export const STANDUPS_SECTIONS = [
  { id: "standups", label: "Standups", path: [] },
  { id: "feed", label: "Feed", path: ["feed"] }
] as const satisfies readonly WorkspaceSectionDef[];

/** `/standups/new` (the new-standup sheet over the list) is the list; a standup's page is no section. */
export const standupsSectionOf = (route: Pick<WorkspaceRoute, "path">) => {
  const first = route.path[0];
  return !first || first === "new" ? "standups" : first === "feed" ? "feed" : null;
};
