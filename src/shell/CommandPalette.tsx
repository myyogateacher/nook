import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Search } from "lucide-react";
import { filterPalette, flatPalette, type PaletteEntry } from "./paletteModel";
import "./palette.css";

export type CommandPaletteProps = {
  entries: readonly PaletteEntry[];
  /** Notes' search is on: a query ends with "Search notes for …". */
  searchNotes: boolean;
  onRun: (entry: PaletteEntry) => void;
  onClose: () => void;
  /** The text to start with (tests; reopening keeps nothing). */
  initialQuery?: string;
};

/**
 * The ⌘K command palette (docs/plan/LEFT_NAV.md §4 phase 4, D1293): a modal dialog with one search
 * box (a combobox) over a grouped listbox. Typing filters the entries fuzzily; ↑ and ↓ move (the
 * active option is `aria-activedescendant`, so focus never leaves the box), Home and End jump, Enter
 * runs the active entry, Escape or the scrim closes, and Tab stays in the dialog. Resting the pointer
 * on an option makes it active, as the keys do.
 */
export function CommandPalette({ entries, searchNotes, onRun, onClose, initialQuery = "" }: CommandPaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const groups = useMemo(() => filterPalette(entries, query, searchNotes), [entries, query, searchNotes]);
  const flat = useMemo(() => flatPalette(groups), [groups]);
  const current = flat.length ? Math.min(active, flat.length - 1) : -1;

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setActive(0); }, [query]);
  // Keep the active option in view as the keys move it.
  useLayoutEffect(() => {
    if (current < 0) return;
    const element = document.getElementById(optionId(current));
    if (element && typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "nearest" });
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (entry: PaletteEntry | undefined) => { if (entry) onRun(entry); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    const last = flat.length - 1;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive(current >= last ? 0 : current + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive(current <= 0 ? last : current - 1); }
    else if ((event.key === "Home" || event.key === "End") && event.ctrlKey) { event.preventDefault(); setActive(event.key === "Home" ? 0 : last); }
    else if (event.key === "PageDown") { event.preventDefault(); setActive(Math.min(last, current + 8)); }
    else if (event.key === "PageUp") { event.preventDefault(); setActive(Math.max(0, current - 8)); }
    else if (event.key === "Enter") { event.preventDefault(); run(flat[current]); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    // The box is the dialog's only stop: Tab and Shift+Tab stay in it.
    else if (event.key === "Tab") { event.preventDefault(); inputRef.current?.focus(); }
  };

  let index = -1;
  return <div className="palette-layer">
    <button type="button" className="palette-scrim" tabIndex={-1} aria-label="Close" onClick={onClose} />
    <div className="palette" role="dialog" aria-modal="true" aria-label="Go to or search" onKeyDown={onKeyDown}>
      <div className="palette-search">
        <Search aria-hidden="true" />
        <input ref={inputRef} type="text" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={current >= 0 ? optionId(current) : undefined} aria-label="Go to an app, section, or action"
          placeholder="Search apps, sections, and actions…" value={query} maxLength={200} spellCheck={false} autoComplete="off"
          onChange={(event) => setQuery(event.target.value)} />
        {/* Escape closes on a keyboard; a phone gets Cancel to tap (the box keeps focus: no tab stop). */}
        <button type="button" className="palette-close" tabIndex={-1} aria-label="Close" onClick={onClose}>
          <kbd className="palette-close-key" aria-hidden="true">Esc</kbd><span className="palette-close-text" aria-hidden="true">Cancel</span>
        </button>
      </div>
      <div ref={listRef} id={listId} className="palette-list" role="listbox" aria-label="Results">
        {groups.map((group) => <div key={group.id} role="group" aria-labelledby={`${baseId}-${group.id}`} className="palette-group">
          <div id={`${baseId}-${group.id}`} className="palette-heading" role="presentation">{group.label}</div>
          {group.entries.map((entry) => {
            index += 1;
            const at = index;
            const Icon = entry.icon;
            const selected = at === current;
            return <div key={entry.id} id={optionId(at)} role="option" aria-selected={selected} className={`palette-option${selected ? " active" : ""}`}
              onMouseMove={() => { if (!selected) setActive(at); }} onMouseDown={(event) => event.preventDefault()} onClick={() => run(entry)}>
              <Icon aria-hidden="true" />
              <span className="palette-option-label">
                {entry.context && entry.group === "apps" && <span className="palette-option-context">{entry.context} › </span>}{entry.label}
              </span>
              {entry.hint && <span className="palette-option-hint">{entry.hint}</span>}
            </div>;
          })}
        </div>)}
        {flat.length === 0 && <p className="palette-empty" role="presentation">Nothing matches “{query.trim()}”.</p>}
      </div>
      <p className="palette-foot" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> to move <kbd>Enter</kbd> to open <kbd>Esc</kbd> to close</p>
    </div>
  </div>;
}
