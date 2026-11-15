import type { WorkspaceSectionDef } from "../workspaceModules/types";

/** Townhall's sections (D1280). The All / Live / Upcoming / Past chips and a session's Q&A / Polls / Recap stay on the page. */
export const TOWNHALL_SECTIONS = [
  { id: "sessions", label: "Sessions", path: [] },
  { id: "insights", label: "Insights", path: ["insights"] }
] as const satisfies readonly WorkspaceSectionDef[];
