import type { LucideIcon } from "lucide-react";
import type { SearchSection } from "../../shared/workspaceSearch";
import type { SearchRendererDef } from "../workspaceModules/types";
import { workspaceModules } from "../workspaceModules/registry";
import type { NavTree } from "./navModel";
import type { PaletteEntry, PaletteGroup } from "./paletteModel";

/**
 * Search everywhere in the ⌘K palette (docs/plan/SEARCH_EVERYWHERE.md, D1340): the server's
 * `scope=all` sections, one palette group per app, each row drawn by its scope's renderer (a
 * workspace module's `searchRenderer`, or the built-in ones below for notes, cards, events, files,
 * whiteboards, collections and rows, reports, and chats). A section is shown only when its app is in
 * the person's sidebar (so a module they turned off, or one the server does not offer, never shows
 * results); the server has already applied each scope's read check (T681).
 */

export type ResultRow = { key: string; title: string; meta?: string; href: string };
export type ResultRenderer = { scope: string; app: string; row: (result: Record<string, unknown>) => ResultRow | null };

const text = (value: unknown) => typeof value === "string" ? value : "";
const segmentsText = (value: unknown) => Array.isArray(value) ? value.map((segment) => text((segment as { text?: unknown })?.text)).join("") : text(value);
const ref = (result: Record<string, unknown>) => {
  const value = result.ref && typeof result.ref === "object" ? result.ref as Record<string, unknown> : result;
  const href = text(value.href);
  return href.startsWith("/") && !href.startsWith("//") ? { id: text(value.id), title: text(value.title) || "Untitled", href, kind: text(value.kind) } : null;
};
/** The item a hit names (its `ref`, else a module result's own kind and id), for de-duplication (D1346). */
const itemOf = (result: Record<string, unknown>) => {
  const value = result.ref && typeof result.ref === "object" ? result.ref as Record<string, unknown> : result;
  return typeof value.kind === "string" && typeof value.id === "string" ? { kind: value.kind, id: value.id } : null;
};
const join = (...parts: unknown[]) => parts.map(text).filter(Boolean).join(" · ") || undefined;
const day = (value: string) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};
const row = (meta: (result: Record<string, unknown>) => string | undefined) => (result: Record<string, unknown>): ResultRow | null => {
  const item = ref(result);
  return item ? { key: `${item.kind}:${item.id}`, title: item.title, meta: meta(result), href: item.href } : null;
};

/** The built-in scopes' rows, by scope, with the app (sidebar id) each belongs to. */
export const CORE_RESULT_RENDERERS: readonly ResultRenderer[] = [
  { scope: "notes", app: "notes", row: row((hit) => join(hit.source === "draft" ? "Draft" : "", hit.is_owner === 0 ? `by ${text(hit.owner_name)}` : "", segmentsText(hit.snippet))) },
  { scope: "cards", app: "tasks", row: row((hit) => join(hit.key, hit.board_name, hit.column_name)) },
  { scope: "events", app: "calendar", row: row((hit) => join(hit.calendarName, day(text(hit.start)), hit.recurring === true ? "Repeats" : "")) },
  { scope: "files", app: "files", row: row((hit) => join(hit.is_owner === 0 ? `by ${text(hit.owner_name)}` : "", segmentsText(hit.snippet))) },
  { scope: "whiteboards", app: "whiteboards", row: row((hit) => join(hit.is_owner === 0 ? `by ${text(hit.owner_name)}` : "", segmentsText(hit.snippet))) },
  { scope: "collections", app: "collections", row: row((hit) => hit.kind === "collection" ? "Collection" : join(hit.collectionName, segmentsText(hit.snippet))) },
  { scope: "reports", app: "reports", row: row(() => "Report") },
  { scope: "chats", app: "chat", row: row((hit) => join(hit.agentName)) }
];

/** A workspace module's renderer as a palette renderer (its app is the module's own sidebar id). */
export const moduleResultRenderer = (app: string, def: SearchRendererDef): ResultRenderer => ({
  scope: def.scope,
  app,
  row: (result) => {
    const drawn = def.row(result);
    return drawn.href.startsWith("/") && !drawn.href.startsWith("//") ? drawn : null;
  }
});

/** The built-in renderers and every registered workspace module's `searchRenderer`. */
export const paletteResultRenderers = (): ResultRenderer[] => [
  ...CORE_RESULT_RENDERERS,
  ...workspaceModules().flatMap((module) => module.searchRenderer ? [moduleResultRenderer(module.id, module.searchRenderer)] : [])
];

/** Every app the person's sidebar shows, by id, with its label and icon. */
export function shownApps(tree: NavTree): Map<string, { label: string; icon: LucideIcon }> {
  return new Map([...tree.pinned, ...tree.apps].map((item) => [item.id, { label: item.label, icon: item.icon }]));
}

/** At most this many rows per app (the server sends five). */
export const PALETTE_RESULTS_PER_APP = 5;

/**
 * The palette groups for a `scope=all` response, in the server's section order: one per shown app
 * with results, its rows drawn by the scope's renderer. A section with no renderer, an app not in the
 * sidebar, a failed section, or a row without a safe in-app href is left out.
 */
export function resultGroups(sections: readonly SearchSection[], renderers: readonly ResultRenderer[], apps: ReadonlyMap<string, { label: string; icon: LucideIcon }>): PaletteGroup[] {
  const byScope = new Map(renderers.map((renderer) => [renderer.scope, renderer]));
  return sections.flatMap((section) => {
    const renderer = byScope.get(section.scope);
    const app = renderer ? apps.get(renderer.app) : undefined;
    if (!renderer || !app || section.error) return [];
    const seen = new Set<string>();
    const entries: PaletteEntry[] = section.results.flatMap((result) => {
      if (!result || typeof result !== "object") return [];
      let drawn: ResultRow | null;
      try { drawn = renderer.row(result as Record<string, unknown>); } catch { drawn = null; }
      if (!drawn || seen.has(drawn.key)) return [];
      seen.add(drawn.key);
      const named = itemOf(result as Record<string, unknown>);
      return [{ id: `result:${section.scope}:${drawn.key}`, group: "results", label: drawn.title || "Untitled", context: app.label, icon: app.icon, hint: drawn.meta, browse: false, ...(named ? { item: named } : {}), action: { kind: "path", href: drawn.href } } satisfies PaletteEntry];
    }).slice(0, PALETTE_RESULTS_PER_APP);
    return entries.length ? [{ id: "results", key: `results:${section.scope}`, label: app.label, entries }] : [];
  });
}
