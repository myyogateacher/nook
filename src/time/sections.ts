import type { WorkspaceSectionDef } from "../workspaceModules/types";

/** Time's sections (D1280): the sidebar's rows under Time and the phone strip. A project's page is under Projects. */
export const TIME_SECTIONS = [
  { id: "timer", label: "Timer", path: [] },
  { id: "timesheet", label: "Timesheet", path: ["timesheet"] },
  { id: "reports", label: "Reports", path: ["reports"] },
  { id: "projects", label: "Projects", path: ["projects"] }
] as const satisfies readonly WorkspaceSectionDef[];

export type TimeSection = typeof TIME_SECTIONS[number]["id"];
