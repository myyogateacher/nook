import type { WorkspaceSectionDef } from "../workspaceModules/types";

/** Bookings' sections (D1280). A type's editor is under Booking types; one booking's page is no section. */
export const BOOKINGS_SECTIONS = [
  { id: "upcoming", label: "Upcoming", path: [] },
  { id: "past", label: "Past", path: ["past"] },
  { id: "cancelled", label: "Cancelled", path: ["cancelled"] },
  { id: "types", label: "Booking types", path: ["types"] },
  { id: "availability", label: "Availability", path: ["availability"] },
  { id: "insights", label: "Insights", path: ["insights"] },
  { id: "profile", label: "Profile", path: ["profile"] }
] as const satisfies readonly WorkspaceSectionDef[];

export type BookingsSection = typeof BOOKINGS_SECTIONS[number]["id"];
