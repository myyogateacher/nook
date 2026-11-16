import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./auth";
import { audit, db, now } from "./db";
import { parseJson } from "./validation";
import { isCurrency } from "../shared/money";
import { DEFAULT_UNIT_PREFERENCES, DEFAULT_WORKSPACE_SETTINGS, type UnitPreferences, type WorkspaceSettings } from "../shared/workspaceSettings";

/**
 * Workspace settings for the modules (docs/plan/WORKSPACE_MODULES.md §B.8, §B.16, §G.1 Q2; 085
 * `team_settings` keys `public_forms`, `public_booking_pages`, `default_currency`) and each person's
 * unit preferences (089 `user_ui_prefs`).
 *
 * Public pages are **on** by default (§G.1 Q2): a missing row is the default. Turning a policy off
 * makes the public routes of that kind answer the uniform 404 on their next request (they read the
 * setting on every request) and keeps the links (D810). Admins change the settings; everyone signed in
 * reads them (the app needs the currency and whether to offer public links).
 */

const KEYS = { publicForms: "public_forms", publicBookingPages: "public_booking_pages", publicTownhall: "public_townhall", defaultCurrency: "default_currency" } as const satisfies Record<keyof WorkspaceSettings, string>;

export function readWorkspaceSettings(): WorkspaceSettings {
  const rows = db.query("SELECT key, value_json FROM team_settings WHERE key IN ('public_forms','public_booking_pages','public_townhall','default_currency')").all() as Array<{ key: string; value_json: string }>;
  const stored = new Map(rows.map((row) => [row.key, row.value_json]));
  const read = <T>(key: string, valid: (value: unknown) => value is T, fallback: T): T => {
    const json = stored.get(key);
    if (json === undefined) return fallback;
    try {
      const value: unknown = JSON.parse(json);
      return valid(value) ? value : fallback;
    } catch {
      return fallback;
    }
  };
  const isBool = (value: unknown): value is boolean => typeof value === "boolean";
  return {
    publicForms: read(KEYS.publicForms, isBool, DEFAULT_WORKSPACE_SETTINGS.publicForms),
    publicBookingPages: read(KEYS.publicBookingPages, isBool, DEFAULT_WORKSPACE_SETTINGS.publicBookingPages),
    publicTownhall: read(KEYS.publicTownhall, isBool, DEFAULT_WORKSPACE_SETTINGS.publicTownhall),
    defaultCurrency: read(KEYS.defaultCurrency, isCurrency, DEFAULT_WORKSPACE_SETTINGS.defaultCurrency)
  };
}

const revision = () => (db.query("SELECT COALESCE(SUM(revision), 0) AS revision FROM team_settings WHERE key IN ('public_forms','public_booking_pages','public_townhall','default_currency')").get() as { revision: number }).revision;

export const workspaceSettingsPutSchema = z.object({
  settings: z.object({
    publicForms: z.boolean().optional(),
    publicBookingPages: z.boolean().optional(),
    publicTownhall: z.boolean().optional(),
    defaultCurrency: z.string().refine(isCurrency, "Use a three-letter currency code such as USD").optional()
  }).strict(),
  revision: z.number().int().min(0)
}).strict();

export class SettingsChangedError extends Error {}

export function writeWorkspaceSettings(actorId: string, change: Partial<WorkspaceSettings>, expectedRevision: number) {
  return db.transaction(() => {
    if (revision() !== expectedRevision) throw new SettingsChangedError("The settings were changed by someone else. Review them and try again.");
    const current = readWorkspaceSettings();
    const changed: string[] = [];
    const timestamp = now();
    for (const field of Object.keys(change) as Array<keyof WorkspaceSettings>) {
      const value = change[field];
      if (value === undefined || value === current[field]) continue;
      db.query(`INSERT INTO team_settings (key, value_json, revision, updated_by, updated_at) VALUES (?, ?, 1, ?, ?)
        ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, revision = revision + 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(KEYS[field], JSON.stringify(value), actorId, timestamp);
      changed.push(field);
    }
    if (changed.length) audit(actorId, null, "workspace.settings_update", { changed });
    return { settings: readWorkspaceSettings(), defaults: DEFAULT_WORKSPACE_SETTINGS, revision: revision() };
  })();
}

// ---------------------------------------------------------------- unit preferences (per person)

const unitSchema = z.object({
  weekStart: z.union([z.literal(0), z.literal(1), z.literal(6)]),
  durationFormat: z.enum(["hm", "colon"]),
  bareDuration: z.enum(["minutes", "hours"])
}).strict();

export function readUnitPreferences(userId: string): UnitPreferences & { revision: number } {
  const row = db.query("SELECT prefs_json, revision FROM user_ui_prefs WHERE user_id = ?").get(userId) as { prefs_json: string; revision: number } | null;
  if (!row) return { ...DEFAULT_UNIT_PREFERENCES, revision: 0 };
  let stored: Record<string, unknown> = {};
  try { stored = JSON.parse(row.prefs_json) as Record<string, unknown>; } catch { /* the CHECK keeps it valid */ }
  const parsed = unitSchema.partial().safeParse(stored);
  return { ...DEFAULT_UNIT_PREFERENCES, ...(parsed.success ? parsed.data : {}), revision: row.revision };
}

export function writeUnitPreferences(userId: string, prefs: UnitPreferences, expectedRevision: number) {
  const json = JSON.stringify(prefs);
  const timestamp = now();
  const changes = expectedRevision === 0
    ? db.query("INSERT OR IGNORE INTO user_ui_prefs (user_id, prefs_json, revision, updated_at) VALUES (?, ?, 1, ?)").run(userId, json, timestamp).changes
    : db.query("UPDATE user_ui_prefs SET prefs_json = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?").run(json, timestamp, userId, expectedRevision).changes;
  return { ok: changes === 1, prefs: readUnitPreferences(userId) };
}

export function registerWorkspaceSettingsRoutes(app: Hono<AppEnv>) {
  app.get("/api/workspace/settings", (c) => c.json({ settings: readWorkspaceSettings(), defaults: DEFAULT_WORKSPACE_SETTINGS, revision: revision() }));
  app.put("/api/workspace/settings", async (c) => {
    if (c.get("user").role !== "admin") return c.json({ error: "Only admins change workspace settings", code: "ADMIN_ONLY" }, 403);
    const body = await parseJson(c.req.raw, workspaceSettingsPutSchema);
    try {
      return c.json(writeWorkspaceSettings(c.get("user").id, body.settings, body.revision));
    } catch (error) {
      if (error instanceof SettingsChangedError) return c.json({ error: error.message, code: "SETTINGS_CHANGED", settings: readWorkspaceSettings(), revision: revision() }, 409);
      throw error;
    }
  });
  app.get("/api/preferences/units", (c) => c.json(readUnitPreferences(c.get("user").id)));
  app.put("/api/preferences/units", async (c) => {
    const body = await parseJson(c.req.raw, unitSchema.extend({ revision: z.number().int().min(0) }).strict());
    const { revision: expected, ...prefs } = body;
    const result = writeUnitPreferences(c.get("user").id, prefs, expected);
    return result.ok ? c.json(result.prefs) : c.json({ error: "Your preferences were changed elsewhere", code: "PREFERENCES_CHANGED", preferences: result.prefs }, 409);
  });
}
