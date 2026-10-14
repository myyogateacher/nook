import type { DocServerChoice } from "../../shared/reportsGenerate";
import { DOC_BROWSE_LIMITS } from "../../shared/reportsGenerate";

/**
 * B3: "Tools the AI may use to read more docs": the doc server's tools, the read-only (Auto) ones
 * tickable, every other one greyed out with why. The main doc is always read first; these let the AI
 * follow its links. Used by New report and ⋯ → Doc settings.
 */
export function BrowseToolsPicker({ server, value, onChange, disabled = false }: { server: Pick<DocServerChoice, "name" | "tools" | "toolNames">; value: readonly string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  const allowed = new Set(server.tools.map((tool) => tool.name));
  const names = [...new Set([...server.tools.map((tool) => tool.name), ...(server.toolNames ?? [])])];
  const toggle = (name: string, on: boolean) => onChange(on ? [...value.filter((item) => item !== name), name].slice(0, DOC_BROWSE_LIMITS.ticked) : value.filter((item) => item !== name));
  return <fieldset className="browse-tools" disabled={disabled}>
    <legend className="reports-label">Tools the AI may use to read more docs</legend>
    <p className="file-dialog-hint">Nook always reads the doc first. The AI may also call the tools you tick to read pages the doc links to, such as table definitions (at most {DOC_BROWSE_LIMITS.calls} calls a run).</p>
    {names.length === 0
      ? <p className="file-dialog-hint">{server.name} has no tools yet.</p>
      : <ul className="browse-tools-list">
        {names.map((name) => {
          const ok = allowed.has(name);
          return <li key={name} className={ok ? undefined : "is-excluded"}>
            <label>
              <input type="checkbox" checked={ok && value.includes(name)} disabled={!ok} onChange={(event) => toggle(name, event.target.checked)} />
              <span className="browse-tools-name"><code>{name}</code>{!ok && <span className="browse-tools-why">needs Auto in Settings → AI → Tool servers</span>}</span>
            </label>
          </li>;
        })}
      </ul>}
  </fieldset>;
}
