/**
 * Workspace settings for the modules (§B.8, §B.16; 085 `team_settings` keys) and the per-person unit
 * preferences. Read by everyone signed in; changed by admins (`PUT /api/workspace/settings`).
 *
 * - `publicForms`, `publicBookingPages`, `publicTownhall`: whether members may create public links
 *   (forms and polls; booking pages; townhall audience links, D1382 — before, under publicForms). **On by default** (§G.1 Q2). Turning one off makes its public routes 404 at once
 *   and keeps the links (D810).
 * - `defaultCurrency`: the workspace currency (ISO 4217), per-project and per-deal overrides aside.
 */
export type WorkspaceSettings = {
  publicForms: boolean;
  publicBookingPages: boolean;
  /** D1382: townhall audience links. Migration 160 seeds it from publicForms, so upgrades keep their behaviour. */
  publicTownhall: boolean;
  defaultCurrency: string;
};

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = { publicForms: true, publicBookingPages: true, publicTownhall: true, defaultCurrency: "USD" };

/** GET /api/workspace/settings. */
export type WorkspaceSettingsState = { settings: WorkspaceSettings; defaults: WorkspaceSettings; revision: number };
/** PUT /api/workspace/settings body (admins): a partial change plus the revision it was based on. */
export type WorkspaceSettingsPut = { settings: Partial<WorkspaceSettings>; revision: number };

/**
 * Unit preferences per person (GET/PUT /api/preferences/units): week start (0 = Sunday, 1 = Monday,
 * 6 = Saturday), how durations are written, and whether a bare number typed as a duration is minutes or hours.
 */
export type UnitPreferences = { weekStart: 0 | 1 | 6; durationFormat: "hm" | "colon"; bareDuration: "minutes" | "hours" };
export const DEFAULT_UNIT_PREFERENCES: UnitPreferences = { weekStart: 1, durationFormat: "hm", bareDuration: "minutes" };
