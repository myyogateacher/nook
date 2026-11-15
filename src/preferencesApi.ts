import { api, ApiError } from "./api";
import { parsePreferences, type ModuleId, type Preferences } from "./modules";
import type { SidebarLayout } from "../shared/sidebar";

// docs/plan/API_CONTRACTS.md § Preferences.

export async function getPreferences(): Promise<Preferences> {
  return parsePreferences((await api<{ preferences: unknown }>("/preferences")).preferences);
}

export type SaveResult = { ok: true; preferences: Preferences } | { ok: false; conflict: Preferences };

/**
 * Saves with the revision last read. A 409 returns the server's current value instead of throwing.
 * `sidebar` (D1295): left out keeps the saved layout; given, it replaces it.
 */
export async function savePreferences(disabledModules: readonly ModuleId[], revision: number, sidebar?: SidebarLayout): Promise<SaveResult> {
  try {
    const result = await api<{ preferences: unknown }>("/preferences", { method: "PUT", body: JSON.stringify({ disabledModules, revision, ...(sidebar ? { sidebar } : {}) }) });
    return { ok: true, preferences: parsePreferences(result.preferences) };
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 409) {
      const payload = reason.payload as { preferences?: unknown } | undefined;
      return { ok: false, conflict: payload?.preferences ? parsePreferences(payload.preferences) : await getPreferences() };
    }
    throw reason;
  }
}
