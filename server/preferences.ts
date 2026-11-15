import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./auth";
import { audit, db, now } from "./db";
import { MODULE_IDS, type ModuleId } from "./moduleIds";
import { parseJson } from "./validation";
import { cleanSidebarLayout, emptySidebarLayout, SIDEBAR_APP_IDS, SIDEBAR_EXPANDABLE_IDS, SIDEBAR_MODES, type SidebarLayout } from "../shared/sidebar";

/**
 * Per-user preferences (docs/plan/WAVE_13_TASK_CARD_UX.md §3, D92, D114): the modules a user turned
 * off in Settings → Modules, and (left navigation phase 4, D1295) the sidebar's layout: the collapse
 * choice, the app order, the pinned apps, and the apps opened by their chevron. They arrange UI and
 * nothing else. Routes, ACLs, MCP, feeds, reminders, and push never read them, so a hidden, moved, or
 * pinned module is not a security boundary (T97).
 */

export { MODULE_IDS, type ModuleId } from "./moduleIds";

/** `sidebar` is left out while the person never saved one. */
export type Preferences = { disabledModules: ModuleId[]; revision: number; updatedAt: string | null; sidebar?: SidebarLayout };

const knownModule = (value: unknown): value is ModuleId => typeof value === "string" && (MODULE_IDS as readonly string[]).includes(value);

/** Unique known ids in registry order, so the stored JSON is canonical (and far below the 512-byte CHECK). */
function canonical(ids: readonly string[]): ModuleId[] {
  return MODULE_IDS.filter((id) => ids.includes(id));
}

const uniqueIds = <T extends z.ZodTypeAny>(item: T, max: number) => z.array(item).max(max)
  .refine((values) => new Set(values).size === values.length, "Ids must be unique");

/** The sidebar's layout (D1295): known app ids only, each list unique and bounded by the id list. */
export const sidebarLayoutSchema = z.object({
  mode: z.enum(SIDEBAR_MODES).optional(),
  order: uniqueIds(z.enum(SIDEBAR_APP_IDS), SIDEBAR_APP_IDS.length).optional(),
  pinned: uniqueIds(z.enum(SIDEBAR_APP_IDS), SIDEBAR_APP_IDS.length).optional(),
  expanded: uniqueIds(z.enum(SIDEBAR_EXPANDABLE_IDS), SIDEBAR_EXPANDABLE_IDS.length).optional()
}).strict();

export const preferencesPutSchema = z.object({
  disabledModules: z.array(z.enum(MODULE_IDS)).max(MODULE_IDS.length)
    .refine((values) => new Set(values).size === values.length, "Module ids must be unique"),
  /** The revision the client last saw; 0 when it has never been saved. */
  revision: z.number().int().nonnegative(),
  /** Absent keeps the saved layout; null clears it; an object replaces it whole. */
  sidebar: sidebarLayoutSchema.nullable().optional()
}).strict();

type PreferencesRow = { disabled_modules: string; revision: number; updated_at: string; sidebar: string | null };

function readSidebar(value: string | null): SidebarLayout | undefined {
  if (value === null) return undefined;
  let stored: unknown = null;
  try { stored = JSON.parse(value); } catch { /* the CHECK keeps it valid JSON */ }
  // Ids that are no longer known are dropped on read, as module ids are.
  return cleanSidebarLayout(stored) ?? undefined;
}

/** A missing row means every module is on (revision 0). Ids that are no longer known are dropped on read. */
export function readPreferences(userId: string): Preferences {
  const row = db.query("SELECT disabled_modules, revision, updated_at, sidebar FROM user_preferences WHERE user_id = ?").get(userId) as PreferencesRow | null;
  if (!row) return { disabledModules: [], revision: 0, updatedAt: null };
  let stored: unknown = [];
  try { stored = JSON.parse(row.disabled_modules); } catch { /* the CHECK keeps it valid JSON */ }
  const ids = Array.isArray(stored) ? stored.filter(knownModule) : [];
  const sidebar = readSidebar(row.sidebar);
  return { disabledModules: canonical(ids), revision: row.revision, updatedAt: row.updated_at, ...(sidebar ? { sidebar } : {}) };
}

export type PreferencesWrite = { ok: true; preferences: Preferences } | { ok: false; current: Preferences };

/** The stored form: fields in a fixed order, or NULL for an empty layout. */
function sidebarJson(layout: SidebarLayout | null): string | null {
  const clean = cleanSidebarLayout(layout);
  if (!clean || emptySidebarLayout(clean)) return null;
  return JSON.stringify({ mode: clean.mode, order: clean.order, pinned: clean.pinned, expanded: clean.expanded });
}

/**
 * Compare-and-swap on `revision`: exactly one of two writers with the same base revision wins.
 * `sidebar` undefined keeps the saved layout (Settings → Modules saves only its own list).
 */
export function writePreferences(userId: string, disabledModules: readonly ModuleId[], baseRevision: number, sidebar?: SidebarLayout | null): PreferencesWrite {
  const value = JSON.stringify(canonical(disabledModules));
  const layout = sidebar === undefined ? undefined : sidebarJson(sidebar);
  const timestamp = now();
  return db.transaction((): PreferencesWrite => {
    const changes = baseRevision === 0
      ? db.query("INSERT OR IGNORE INTO user_preferences (user_id, disabled_modules, revision, updated_at, sidebar) VALUES (?, ?, 1, ?, ?)").run(userId, value, timestamp, layout ?? null).changes
      : layout === undefined
        ? db.query("UPDATE user_preferences SET disabled_modules = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?").run(value, timestamp, userId, baseRevision).changes
        : db.query("UPDATE user_preferences SET disabled_modules = ?, sidebar = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?").run(value, layout, timestamp, userId, baseRevision).changes;
    const preferences = readPreferences(userId);
    if (changes === 0) return { ok: false, current: preferences };
    audit(userId, null, "preferences.update", { disabledModules: preferences.disabledModules, revision: preferences.revision, ...(layout !== undefined ? { sidebar: preferences.sidebar ?? null } : {}) });
    return { ok: true, preferences };
  })();
}

export function registerPreferenceRoutes(app: Hono<AppEnv>) {
  app.get("/api/preferences", (c) => c.json({ preferences: readPreferences(c.get("user").id) }));

  app.put("/api/preferences", async (c) => {
    const body = await parseJson(c.req.raw, preferencesPutSchema);
    const result = writePreferences(c.get("user").id, body.disabledModules, body.revision, body.sidebar);
    if (!result.ok) return c.json({ error: "Your preferences changed in another window. Reload and try again.", code: "PREFERENCES_CHANGED", preferences: result.current }, 409);
    return c.json({ preferences: result.preferences });
  });
}
