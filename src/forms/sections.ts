import type { WorkspaceSectionDef } from "../workspaceModules/types";

/** Forms' sections (D1280): the sidebar's rows under Forms and the phone strip. A form's Respond / Edit / Results stay on its page. */
export const FORMS_SECTIONS = [
  { id: "mine", label: "My forms", path: [] },
  { id: "shared", label: "Shared with me", path: ["shared"] },
  { id: "answer", label: "To answer", path: ["answer"] },
  { id: "insights", label: "Insights", path: ["insights"] }
] as const satisfies readonly WorkspaceSectionDef[];

export type FormsSection = typeof FORMS_SECTIONS[number]["id"];
