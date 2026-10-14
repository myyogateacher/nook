import type { DocServerChoice } from "../../shared/reportsGenerate";
import { DOC_BROWSE_LIMITS, isReadLikeTool, isWriteLikeName } from "../../shared/reportsGenerate";

/**
 * B3: "Tools the AI may use to read more docs": the doc server's read-like tools, the Auto ones
 * tickable, the others greyed out with why; write-like tools are not listed at all. The main doc is always read first; these let the AI
 * follow its links. Used by New report and ⋯ → Doc settings.
 */
export function BrowseToolsPicker({ server, value, onChange, disabled = false }: { server: Pick<DocServerChoice, "name" | "tools" | "toolNames">; value: readonly string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  // Tools that look like writes (a write verb, or the server's `readOnlyHint: false`) are never listed, not even greyed out (an admin must not be invited to set one to Auto).
  const readLike = server.tools.filter((tool) => isReadLikeTool(tool));
  const declaredWrites = new Set(server.tools.filter((tool) => tool.readOnlyHint === false).map((tool) => tool.name));
  const allowed = new Set(readLike.map((tool) => tool.name));
  const names = [...new Set([...readLike.map((tool) => tool.name), ...(server.toolNames ?? [])])].filter((name) => !isWriteLikeName(name) && !declaredWrites.has(name));
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
