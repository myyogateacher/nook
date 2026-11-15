import type { WorkspaceRoute, WorkspaceSectionDef } from "../workspaceModules/types";

/**
 * Contacts' sections (D1280). Search and the pipeline picker stay on the page. A record opens under
 * its kind's section (a person under People, a deal under Deals); Duplicates is under People.
 */
export const CRM_SECTIONS = [
  { id: "contacts", label: "People", path: [] },
  { id: "companies", label: "Companies", path: ["companies"] },
  { id: "deals", label: "Deals", path: ["deals"] },
  { id: "lists", label: "Lists", path: ["lists"] },
  { id: "followups", label: "Follow-ups", path: ["followups"] },
  { id: "insights", label: "Insights", path: ["insights"] },
  { id: "settings", label: "Settings", path: ["settings"] }
] as const satisfies readonly WorkspaceSectionDef[];

export type CrmSection = typeof CRM_SECTIONS[number]["id"];
const IDS = new Set<string>(CRM_SECTIONS.map((section) => section.id));

export function crmSectionOf(route: Pick<WorkspaceRoute, "path">): CrmSection {
  const first = route.path[0];
  // `/contacts/contacts` is People too; anything else that is not a section is a person's page.
  return first && IDS.has(first) ? first as CrmSection : "contacts";
}
