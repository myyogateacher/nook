import { useEffect, useId, useState } from "react";
import { Globe2, Ruler } from "lucide-react";
import { api, ApiError } from "../api";
import { HUB_TITLE_ID } from "./hubModel";
import { Select } from "../ui/Select";
import { errorText, notify } from "../ui/notify";
import { setUnitPreferences, setWorkspaceSettings } from "../ui/units";
import { COMMON_CURRENCIES } from "../../shared/money";
import { DEFAULT_UNIT_PREFERENCES, type UnitPreferences, type WorkspaceSettings as Settings, type WorkspaceSettingsState } from "../../shared/workspaceSettings";
import "../modules.css";
import "../ui/workspace.css";

/**
 * Settings → Workspace (D836, docs/plan/WORKSPACE_MODULES.md §B.8, §B.16): each person's units (week
 * start, how durations are written, what a bare number means), and for admins the workspace currency
 * and the public page policies (forms and polls; booking pages), on by default (§G.1 Q2). The hub
 * lists it once a workspace module ships (hubModel), so Settings is unchanged until then.
 */
type UnitsState = UnitPreferences & { revision: number };

function PolicySwitch({ id, title, help, checked, disabled, onChange }: { id: string; title: string; help: string; checked: boolean; disabled: boolean; onChange: (next: boolean) => void }) {
  return <li className={`modules-row email-row${checked ? "" : " off"}`}>
    <span className="modules-row-text"><strong id={`${id}-label`}>{title}</strong><small id={`${id}-help`}>{help}</small></span>
    <button type="button" role="switch" className="modules-switch" aria-checked={checked} aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="modules-switch-track" aria-hidden="true"><span className="modules-switch-thumb" /></span>
      <span className="modules-switch-state" aria-hidden="true">{checked ? "On" : "Off"}</span>
    </button>
  </li>;
}

export function WorkspaceSettings({ role }: { role: string | undefined }) {
  const id = useId();
  const admin = role === "admin";
  const [units, setUnits] = useState<UnitsState | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSettingsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<UnitsState>("/preferences/units").then(setUnits, (reason) => setError(errorText(reason, "Could not load your units")));
    api<WorkspaceSettingsState>("/workspace/settings").then(setWorkspace, () => undefined);
  }, []);

  const saveUnits = async (patch: Partial<UnitPreferences>) => {
    if (!units) return;
    setBusy(true);
    const { revision, ...current } = units;
    try {
      const next = await api<UnitsState>("/preferences/units", { method: "PUT", body: JSON.stringify({ ...current, ...patch, revision }) });
      setUnits(next);
      const { revision: _ignored, ...prefs } = next;
      setUnitPreferences(prefs);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) { setUnits((reason.payload as { preferences?: UnitsState })?.preferences ?? units); notify.warning("Your units were changed in another window. Showing those."); }
      else notify.error(errorText(reason, "Could not save your units"));
    } finally { setBusy(false); }
  };
  const saveWorkspace = async (patch: Partial<Settings>) => {
    if (!workspace) return;
    setBusy(true);
    try {
      const next = await api<WorkspaceSettingsState>("/workspace/settings", { method: "PUT", body: JSON.stringify({ settings: patch, revision: workspace.revision }) });
      setWorkspace(next);
      setWorkspaceSettings(next.settings);
      notify.success("Saved");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        const payload = reason.payload as { settings?: Settings; revision?: number } | null;
        if (payload?.settings && payload.revision !== undefined) setWorkspace({ ...workspace, settings: payload.settings, revision: payload.revision });
        notify.warning("Another admin changed these settings. Showing theirs.");
      } else notify.error(errorText(reason, "Could not save the workspace settings"));
    } finally { setBusy(false); }
  };

  const prefs = units ?? { ...DEFAULT_UNIT_PREFERENCES, revision: 0 };
  return <section className="settings-content workspace-settings" aria-labelledby={HUB_TITLE_ID} aria-busy={units === null || undefined}>
    <div className="settings-section-heading"><span className="settings-icon"><Ruler /></span><div><h3>Your units</h3><p>How weeks, durations, and timesheets read for you.</p></div></div>
    {error && <p className="ui-field-error" role="alert">{error}</p>}
    <div className="ui-settings-grid">
      <div className="ui-field"><span id={`${id}-week`}>Week starts on</span>
        <Select labelledBy={`${id}-week`} value={String(prefs.weekStart) as "0" | "1" | "6"} disabled={busy || !units} onChange={(value) => { void saveUnits({ weekStart: Number(value) as 0 | 1 | 6 }); }}
          options={[{ value: "1", label: "Monday" }, { value: "0", label: "Sunday" }, { value: "6", label: "Saturday" }]} /></div>
      <div className="ui-field"><span id={`${id}-format`}>Durations</span>
        <Select labelledBy={`${id}-format`} value={prefs.durationFormat} disabled={busy || !units} onChange={(durationFormat) => { void saveUnits({ durationFormat }); }}
          options={[{ value: "hm", label: "1h 30m" }, { value: "colon", label: "1:30" }]} /></div>
      <div className="ui-field"><span id={`${id}-bare`}>A number alone means</span>
        <Select labelledBy={`${id}-bare`} value={prefs.bareDuration} disabled={busy || !units} onChange={(bareDuration) => { void saveUnits({ bareDuration }); }}
          options={[{ value: "minutes", label: "Minutes (45 = 45m)" }, { value: "hours", label: "Hours (2 = 2h)" }]} /></div>
    </div>
    {admin && workspace && <>
      <div className="settings-section-heading" style={{ marginTop: 28 }}><span className="settings-icon"><Globe2 /></span><div><h3>Workspace</h3><p>For everyone in this workspace. Only admins change these.</p></div></div>
      <div className="ui-field" style={{ maxWidth: 240 }}><span id={`${id}-currency`}>Currency</span>
        <Select labelledBy={`${id}-currency`} value={workspace.settings.defaultCurrency} disabled={busy} searchable onChange={(defaultCurrency) => { void saveWorkspace({ defaultCurrency }); }}
          options={[...new Set([workspace.settings.defaultCurrency, ...COMMON_CURRENCIES])].map((code) => ({ value: code, label: code }))} /></div>
      <ul className="modules-list" style={{ marginTop: 16 }}>
        <PolicySwitch id={`${id}-forms`} title="Public forms and polls" help="Members can share forms and polls with people outside the workspace. Turning it off closes every public form link at once; the links come back if you turn it on again." checked={workspace.settings.publicForms} disabled={busy} onChange={(publicForms) => { void saveWorkspace({ publicForms }); }} />
        <PolicySwitch id={`${id}-booking`} title="Public booking pages" help="Members can publish booking pages people outside the workspace use to book time. Turning it off hides every booking page at once." checked={workspace.settings.publicBookingPages} disabled={busy} onChange={(publicBookingPages) => { void saveWorkspace({ publicBookingPages }); }} />
        <PolicySwitch id={`${id}-townhall`} title="Public townhall links" help="Hosts can turn on an audience link so people without an account ask, upvote, and vote in a townhall session. Turning it off closes every audience link at once; they come back if you turn it on again." checked={workspace.settings.publicTownhall} disabled={busy} onChange={(publicTownhall) => { void saveWorkspace({ publicTownhall }); }} />
      </ul>
    </>}
  </section>;
}
