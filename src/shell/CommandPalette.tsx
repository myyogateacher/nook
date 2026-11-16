import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Loader2, Search } from "lucide-react";
import { filterPalette, flatPalette, withResults, type PaletteEntry, type PaletteGroup } from "./paletteModel";
import { usePaletteSearch, type PaletteSearchRun } from "./usePaletteSearch";
import type { SearchSection } from "../../shared/workspaceSearch";
import "./palette.css";

export type CommandPaletteProps = {
  entries: readonly PaletteEntry[];
  /** Notes' search is on: a query ends with "Search notes for …". */
  searchNotes: boolean;
  /**
   * Search across apps (D1340): asks the server's All scope and turns its sections into one group
   * per app. Absent: the palette filters its own entries only.
   */
  search?: { run: PaletteSearchRun; groups: (sections: readonly SearchSection[]) => PaletteGroup[] };
  onRun: (entry: PaletteEntry) => void;
  onClose: () => void;
  /** The text to start with (tests; reopening keeps nothing). */
  initialQuery?: string;
};

/**
 * The ⌘K command palette (docs/plan/LEFT_NAV.md §4 phase 4, D1293): a modal dialog with one search
 * box (a combobox) over a grouped listbox. Typing filters the entries fuzzily and (D1340) searches
 * every app the person has, the results grouped per app after the local matches; ↑ and ↓ move across
 * every group (the active option is `aria-activedescendant`, so focus never leaves the box), Home and
 * End jump, Enter runs the active entry, Escape or the scrim closes, and Tab stays in the dialog.
 * Resting the pointer on an option makes it active, as the keys do. The active option is kept by id,
 * so results arriving under it never move the highlight to something else.
 */
export function CommandPalette({ entries, searchNotes, search, onRun, onClose, initialQuery = "" }: CommandPaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  const [activeId, setActiveId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const remote = usePaletteSearch(query, search?.run);
  const resultGroups = useMemo(() => search && remote.sections.length ? search.groups(remote.sections) : [], [search, remote.sections]);
  const groups = useMemo(() => withResults(filterPalette(entries, query, searchNotes), query.trim() ? resultGroups : []), [entries, query, searchNotes, resultGroups]);
  const flat = useMemo(() => flatPalette(groups), [groups]);
  const found = activeId === null ? -1 : flat.findIndex((entry) => entry.id === activeId);
  const current = flat.length ? (found >= 0 ? found : 0) : -1;
  const searching = remote.status === "loading";

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setActiveId(null); }, [query]);
  // Keep the active option in view as the keys move it.
  useLayoutEffect(() => {
    if (current < 0) return;
    const element = document.getElementById(optionId(current));
    if (element && typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "nearest" });
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps

  const moveTo = (index: number) => setActiveId(flat[index]?.id ?? null);
  const run = (entry: PaletteEntry | undefined) => { if (entry) onRun(entry); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    const last = flat.length - 1;
    if (event.key === "ArrowDown") { event.preventDefault(); moveTo(current >= last ? 0 : current + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); moveTo(current <= 0 ? last : current - 1); }
    else if ((event.key === "Home" || event.key === "End") && event.ctrlKey) { event.preventDefault(); moveTo(event.key === "Home" ? 0 : last); }
    else if (event.key === "PageDown") { event.preventDefault(); moveTo(Math.min(last, current + 8)); }
    else if (event.key === "PageUp") { event.preventDefault(); moveTo(Math.max(0, current - 8)); }
    else if (event.key === "Enter") { event.preventDefault(); run(flat[current]); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    // The box is the dialog's only stop: Tab and Shift+Tab stay in it.
    else if (event.key === "Tab") { event.preventDefault(); inputRef.current?.focus(); }
  };

  let index = -1;
  const status = searching ? "Searching your apps…" : remote.status === "error" ? remote.message ?? "" : "";
  return <div className="palette-layer">
    <button type="button" className="palette-scrim" tabIndex={-1} aria-label="Close" onClick={onClose} />
    <div className="palette" role="dialog" aria-modal="true" aria-label="Go to or search" onKeyDown={onKeyDown}>
      <div className="palette-search">
        {searching ? <Loader2 className="spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
        <input ref={inputRef} type="text" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={current >= 0 ? optionId(current) : undefined} aria-label={search ? "Go to an app or action, or search your work" : "Go to an app, section, or action"}
          placeholder={search ? "Search apps, actions, and your work…" : "Search apps, sections, and actions…"} value={query} maxLength={200} spellCheck={false} autoComplete="off"
          onChange={(event) => setQuery(event.target.value)} />
        {/* Escape closes on a keyboard; a phone gets Cancel to tap (the box keeps focus: no tab stop). */}
        <button type="button" className="palette-close" tabIndex={-1} aria-label="Close" onClick={onClose}>
          <kbd className="palette-close-key" aria-hidden="true">Esc</kbd><span className="palette-close-text" aria-hidden="true">Cancel</span>
        </button>
      </div>
      <div ref={listRef} id={listId} className="palette-list" role="listbox" aria-label="Results" aria-busy={searching || undefined}>
        {groups.map((group) => {
          const key = group.key ?? group.id;
          return <div key={key} role="group" aria-labelledby={`${baseId}-${key}`} className="palette-group">
            <div id={`${baseId}-${key}`} className="palette-heading" role="presentation">{group.label}</div>
            {group.entries.map((entry) => {
              index += 1;
              const at = index;
              const Icon = entry.icon;
              const selected = at === current;
              return <div key={entry.id} id={optionId(at)} role="option" aria-selected={selected} className={`palette-option${selected ? " active" : ""}`}
                onMouseMove={() => { if (!selected) setActiveId(entry.id); }} onMouseDown={(event) => event.preventDefault()} onClick={() => run(entry)}>
                <Icon aria-hidden="true" />
                <span className="palette-option-label">
                  {entry.context && entry.group === "apps" && <span className="palette-option-context">{entry.context} › </span>}{entry.label}
                </span>
                {entry.hint && <span className="palette-option-hint">{entry.hint}</span>}
              </div>;
            })}
          </div>;
        })}
        {flat.length === 0 && !searching && <p className="palette-empty" role="presentation">Nothing matches “{query.trim()}”.</p>}
      </div>
      {/* Outside the listbox: "Searching…", the rate limit, or an outage; never an option. */}
      <p className={`palette-status${status ? "" : " empty"}`} role="status" aria-live="polite">{status}</p>
      <p className="palette-foot" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> to move <kbd>Enter</kbd> to open <kbd>Esc</kbd> to close</p>
    </div>
  </div>;
}
