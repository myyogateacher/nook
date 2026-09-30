import { LayoutGrid } from "lucide-react";
import { isModuleEnabled, settingsModulesFor, type ModuleId } from "./modules";
import type { Role } from "./team/teamRoles";
import type { PreferencesStatus } from "./usePreferences";
import "./modules.css";

type ModulesSettingsProps = {
  disabledModules: readonly ModuleId[];
  status: PreferencesStatus;
  onToggle: (id: ModuleId, enabled: boolean) => void;
  /** The signed-in role: guests get no Team row, admins get a note that Team stays in Settings. */
  role?: Role;
  /** Modules the server does not offer this person (the Vault without its key): no switch. */
  unavailable?: readonly ModuleId[];
};

/**
 * Settings → Modules (D92): one switch per module, all on by default. A change applies at once and
 * is saved to the account, so it follows the user to every device. It only hides UI.
 */
export function ModulesSettings({ disabledModules, status, onToggle, role, unavailable = [] }: ModulesSettingsProps) {
  return <section className="settings-content modules-settings" aria-labelledby="modules-heading">
    <div className="settings-section-heading"><span className="settings-icon"><LayoutGrid /></span><div><h3 id="modules-heading">Modules</h3><p id="modules-copy">Choose which parts of Nook you see. Turning a module off hides it from Home, the header, and Today on every device you sign in to. Nothing is deleted, sharing is unchanged, and MCP keys and links from other people keep working. Home and Settings are always on.</p></div></div>
    {status && <p className={status.kind === "error" ? "form-error" : "modules-notice"} role={status.kind === "error" ? "alert" : "status"}>{status.message}</p>}
    <ul className="modules-list" aria-describedby="modules-copy">
      {settingsModulesFor(role, unavailable).map(({ id, label, description, icon: Icon }) => {
        const enabled = isModuleEnabled(disabledModules, id);
        const helpId = `module-help-${id}`;
        return <li key={id} className={`modules-row${enabled ? "" : " off"}`}>
          <span className="modules-row-icon" aria-hidden="true"><Icon /></span>
          <span className="modules-row-text"><strong id={`module-label-${id}`}>{label}</strong><small id={helpId}>{description}{id === "team" && role === "admin" && <> You are an admin: Team stays available from Settings.</>}</small></span>
          <button type="button" role="switch" className="modules-switch" aria-checked={enabled} aria-labelledby={`module-label-${id}`} aria-describedby={helpId} onClick={() => onToggle(id, !enabled)}>
            <span className="modules-switch-track" aria-hidden="true"><span className="modules-switch-thumb" /></span>
            <span className="modules-switch-state" aria-hidden="true">{enabled ? "On" : "Off"}</span>
          </button>
        </li>;
      })}
    </ul>
  </section>;
}
