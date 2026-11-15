import type { Role } from "../team/teamRoles";
import { formatWorkspaceRoute, workspaceModule } from "./registry";
import type { WorkspaceClientModule, WorkspaceModuleId, WorkspaceRoute, WorkspaceSectionDef } from "./types";

/**
 * A workspace module's sections (docs/plan/LEFT_NAV.md §2.3, §3; D1280): one list, read by the global
 * sidebar (navModel) and by ModuleHome's phone strip, so the two never drift. Hiding a section for a
 * role is presentation only (T97).
 */

/** The sections this role sees, in order. */
export function visibleSections(module: Pick<WorkspaceClientModule, "sections"> | null | undefined, role: Role | undefined): WorkspaceSectionDef[] {
  return (module?.sections ?? []).filter((section) => !role || !section.hiddenFor?.includes(role));
}

/** The registered module's sections for this role (none when it is not registered). */
export const workspaceSections = (id: WorkspaceModuleId, role: Role | undefined) => visibleSections(workspaceModule(id), role);

/** A section's URL: the module's own format (`/contacts/deals`, `/goals?view=list`). */
export const sectionHref = (id: WorkspaceModuleId, section: Pick<WorkspaceSectionDef, "path" | "search">) =>
  formatWorkspaceRoute({ app: id, path: [...section.path], search: section.search ?? "" });

const startsWith = (path: readonly string[], prefix: readonly string[]) => prefix.every((part, index) => path[index] === part);

/**
 * The section a module route belongs to: the module's own `sectionOf`, else the section whose path is
 * the longest prefix of the route's (`/time/projects/x` is Projects), else the home section when the
 * route is the home. Null: an item's own page (a form, a session), which belongs to no section.
 */
export function sectionOfRoute(module: Pick<WorkspaceClientModule, "sections" | "sectionOf">, route: Pick<WorkspaceRoute, "path" | "search">): string | null {
  if (module.sectionOf) return module.sectionOf(route);
  const sections = module.sections ?? [];
  let best: WorkspaceSectionDef | null = null;
  for (const section of sections) {
    if (section.path.length === 0 || !startsWith(route.path, section.path)) continue;
    if (!best || section.path.length > best.path.length) best = section;
  }
  if (best) return best.id;
  return route.path.length === 0 ? sections.find((section) => section.path.length === 0)?.id ?? null : null;
}
