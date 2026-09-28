/**
 * Today section registry (docs/plan/WAVES_10-12.md §2.2, D51–D52).
 *
 * A section is produced by a provider that calls its own module's exported
 * predicate or list function; Today never adds a visibility path of its own
 * (T50). Each provider fetches at most TODAY_FETCH rows (TODAY_LIMIT + 1, to
 * know whether there are `more`), returns titles and ids only, never bodies,
 * and never counts (T51).
 *
 * Modules that are not installed register nothing, so their section is
 * absent rather than empty. Later modules (Collections, Calendar's
 * `upcoming`) call `registerTodayProvider` from their own code.
 */

import { hasScope, type McpScope } from "../mcpScopes";

export const TODAY_LIMIT = 10;
export const TODAY_FETCH = TODAY_LIMIT + 1;

export type TodayContext = {
  userId: string;
  /** The caller's IANA time zone, already validated. */
  tz: string;
  /** Today's date in `tz`, as YYYY-MM-DD. */
  today: string;
  now: Date;
  /**
   * The MCP key's scopes when get_today is the caller; undefined for a signed-in session.
   * Sections that mix modules (binSoon) filter their items by these (T74).
   */
  scopes?: readonly McpScope[];
  /** The MCP key calling get_today, for sections that list only that key's own items (agent inbox T131). */
  keyId?: string;
};

export type TodayPage<T = unknown> = { items: T[]; more: boolean };

export type TodayProvider = {
  /** Where "View all" goes: the owning app's list. */
  href: string;
  /**
   * The module read scope an MCP key also needs for this section in get_today
   * (D70, T74). Omitted: `today:read` alone is enough (Bin and storage).
   */
  mcpScope?: McpScope;
  /** Signed-in sessions only: get_today leaves the section out (for a module that has no MCP read scope yet). */
  sessionOnly?: boolean;
  load: (context: TodayContext) => TodayPage | Promise<TodayPage>;
  /** Whether the module is installed; omitted means it is. Uninstalled sections are absent. */
  available?: () => boolean;
};

export type TodaySection = { items: unknown[]; more: boolean; href: string; error?: string };

const providers = new Map<string, TodayProvider>();

/** Registers a section in display order; returns a function that removes it (tests). */
export function registerTodayProvider(name: string, provider: TodayProvider) {
  if (!/^[a-z][A-Za-z]{1,31}$/.test(name)) throw new Error(`Invalid Today section name: ${name}`);
  if (providers.has(name)) throw new Error(`Today section already registered: ${name}`);
  providers.set(name, provider);
  return () => { if (providers.get(name) === provider) providers.delete(name); };
}

/** Installed section names, in registration order. */
export function todaySectionNames() {
  return [...providers].filter(([, provider]) => provider.available?.() ?? true).map(([name]) => name);
}

/** Installed sections an MCP key may see: `today:read` plus each section's module scope. */
export function todaySectionsForScopes(scopes: readonly McpScope[]) {
  if (!hasScope(scopes, "today:read")) return [];
  return todaySectionNames().filter((name) => {
    const provider = providers.get(name)!;
    if (provider.sessionOnly) return false;
    return !provider.mcpScope || hasScope(scopes, provider.mcpScope);
  });
}

/** Bounds a fetched page of up to TODAY_FETCH rows to TODAY_LIMIT items plus `more`. */
export function page<T>(rows: T[]): TodayPage<T> {
  return { items: rows.slice(0, TODAY_LIMIT), more: rows.length > TODAY_LIMIT };
}

/**
 * Runs the requested sections (all installed ones by default). A provider
 * that throws errors only its own section; the others still load.
 */
export async function loadToday(context: TodayContext, only?: readonly string[]) {
  const names = todaySectionNames().filter((name) => !only || only.includes(name));
  const sections: Record<string, TodaySection> = {};
  await Promise.all(names.map(async (name) => {
    const provider = providers.get(name)!;
    try {
      const result = await provider.load(context);
      const bounded = page(result.items);
      sections[name] = { items: bounded.items, more: result.more || bounded.more, href: provider.href };
    } catch (error) {
      console.error(`Today section ${name} failed`, error instanceof Error ? error.message : error);
      sections[name] = { items: [], more: false, href: provider.href, error: "This section could not be loaded" };
    }
  }));
  // Keep registration order regardless of which provider finished first.
  const ordered: Record<string, TodaySection> = {};
  for (const name of names) ordered[name] = sections[name]!;
  return { generatedAt: context.now.toISOString(), date: context.today, sections: ordered };
}

// --- Dates and time zones (T71) --------------------------------------------

const supportedZones = new Set(Intl.supportedValuesOf("timeZone"));

/**
 * The zone if it is one of `Intl.supportedValuesOf("timeZone")`, or an alias
 * the same ICU data accepts. Browsers still report older names (Chrome says
 * "Asia/Calcutta" while the list has only "Asia/Kolkata"), and JavaScriptCore
 * does not canonicalize them, so an alias is kept as sent. Anything else is
 * refused before it reaches a formatter (T71).
 */
export function validTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return null;
  if (supportedZones.has(value)) return value;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** The calendar date in `tz` at `now`, as YYYY-MM-DD. */
export function dateInZone(now: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** `date` (YYYY-MM-DD) plus `days`. */
export function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

export function todayContext(userId: string, tz: string, now = new Date(), scopes?: readonly McpScope[], keyId?: string): TodayContext {
  return { userId, tz, today: dateInZone(now, tz), now, ...(scopes ? { scopes } : {}), ...(keyId ? { keyId } : {}) };
}
