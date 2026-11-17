import { useEffect, useState } from "react";
import { api } from "../api";
import { DEFAULT_UNIT_PREFERENCES, DEFAULT_WORKSPACE_SETTINGS, type UnitPreferences, type WorkspaceSettings, type WorkspaceSettingsState } from "../../shared/workspaceSettings";

/**
 * The signed-in person's unit preferences (week start, duration format, bare numbers) and the
 * workspace settings (currency, public page policies), read once per tab and shared by every
 * duration, money, and schedule component (§B.16). Until they load, and if the server is older,
 * the defaults apply. `setUnitPreferences` / `setWorkspaceSettings` update every reader at once.
 */
type Store<T> = { value: T; loaded: Promise<void> | null; listeners: Set<(value: T) => void> };

const units: Store<UnitPreferences> = { value: DEFAULT_UNIT_PREFERENCES, loaded: null, listeners: new Set() };
const workspace: Store<WorkspaceSettings> = { value: DEFAULT_WORKSPACE_SETTINGS, loaded: null, listeners: new Set() };

function publish<T>(store: Store<T>, value: T) {
  store.value = value;
  for (const listener of [...store.listeners]) listener(value);
}

function useStore<T>(store: Store<T>, load: () => Promise<T>) {
  const [value, setValue] = useState(store.value);
  useEffect(() => {
    store.listeners.add(setValue);
    store.loaded ??= load().then((next) => publish(store, next), () => undefined);
    setValue(store.value);
    return () => { store.listeners.delete(setValue); };
  }, [store, load]);
  return value;
}

/**
 * D1383: `GET /api/preferences/units` answers the preferences themselves (`{ weekStart, durationFormat,
 * bareDuration, revision }`). This read used to take `body.preferences`, which is never there, so every
 * reader got the defaults (Monday) until the person saved Settings → Workspace in the same tab.
 */
export const unitsFromBody = (body: Partial<UnitPreferences> & { revision?: number; preferences?: Partial<UnitPreferences> }): UnitPreferences => {
  const { revision: _revision, preferences, ...flat } = body;
  const source = preferences ?? flat;
  return {
    weekStart: source.weekStart ?? DEFAULT_UNIT_PREFERENCES.weekStart,
    durationFormat: source.durationFormat ?? DEFAULT_UNIT_PREFERENCES.durationFormat,
    bareDuration: source.bareDuration ?? DEFAULT_UNIT_PREFERENCES.bareDuration
  };
};
const loadUnits = () => api<Parameters<typeof unitsFromBody>[0]>("/preferences/units").then(unitsFromBody);
const loadWorkspace = () => api<WorkspaceSettingsState>("/workspace/settings").then((body) => ({ ...DEFAULT_WORKSPACE_SETTINGS, ...body.settings }));

export const useUnitPreferences = () => useStore(units, loadUnits);
export const useWorkspaceSettings = () => useStore(workspace, loadWorkspace);

export const setUnitPreferences = (value: UnitPreferences) => publish(units, value);
export const setWorkspaceSettings = (value: WorkspaceSettings) => publish(workspace, value);

/** Tests and sign-out: back to the defaults, loaded again on next use. */
export function resetUnitsForTests() {
  units.loaded = null;
  workspace.loaded = null;
  publish(units, DEFAULT_UNIT_PREFERENCES);
  publish(workspace, DEFAULT_WORKSPACE_SETTINGS);
}

/** Marks both as loaded with these values (the component gallery, tests): no request is made. */
export function primeUnits(value: Partial<UnitPreferences> = {}, settings: Partial<WorkspaceSettings> = {}) {
  units.loaded = Promise.resolve();
  workspace.loaded = Promise.resolve();
  publish(units, { ...DEFAULT_UNIT_PREFERENCES, ...value });
  publish(workspace, { ...DEFAULT_WORKSPACE_SETTINGS, ...settings });
}
