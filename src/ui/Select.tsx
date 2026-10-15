import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { closedSelect, filterOptions, firstEnabled, selectKey, wantsSearch, type SelectState } from "./listNavigation";
import { DropdownSearch, DropdownSurface, ListboxOptions, optionDomId, useOutsideClose, useSheet, type Option, type Presentation } from "./Listbox";

export type { Option } from "./Listbox";

export type SelectProps<V extends string> = {
  value: V | null;
  onChange: (value: V) => void;
  options: Option<V>[];
  /** Accessible name; also the phone sheet's heading. */
  label?: string;
  /** Id of a visible label (takes precedence over `label` for the name). */
  labelledBy?: string;
  placeholder?: string;
  disabled?: boolean;
  /** field: a form field; compact: a small swatch picker; cell: a table cell editor; chip: a filter-bar trigger. */
  variant?: "field" | "compact" | "cell" | "chip";
  /** "auto" shows a search box above 8 options. */
  searchable?: boolean | "auto";
  id?: string;
  autoFocus?: boolean;
  /** Extra classes on the trigger, for the host's layout. */
  className?: string;
  /** Hides the label text on the trigger (a compact swatch picker still names it for screen readers). */
  swatchOnly?: boolean;
  /** Tests and special hosts: force the popup or the sheet instead of following the viewport. */
  presentation?: Presentation;
  defaultOpen?: boolean;
  /** D491: told each change of the search box ("" when it closes), so a host can look further than `options` (a report filter's server search). */
  onSearch?: (query: string) => void;
  /** What the list says when nothing matches (default "No matches"), e.g. "Searching…" while the host looks. */
  emptyText?: string;
};

/**
 * A select-only combobox (APG) that replaces the native select (D91). Desktop: a popup under the
 * trigger with type-ahead. Phones: a bottom sheet with 44 px rows that Back closes (D69).
 */
export function Select<V extends string>({ value, onChange, options, label, labelledBy, placeholder = "Choose…", disabled = false, variant = "field", searchable = "auto", id, autoFocus, className, swatchOnly, presentation = "auto", defaultOpen = false, onSearch, emptyText }: SelectProps<V>) {
  const autoId = useId();
  const triggerId = id ?? `${autoId}-trigger`;
  const listId = `${autoId}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sheet = useSheet(presentation);
  const [state, setState] = useState<SelectState>(() => defaultOpen ? { ...closedSelect(), open: true, active: Math.max(0, options.findIndex((option) => option.value === value)) } : closedSelect());
  const [query, setQuery] = useState("");
  const search = wantsSearch(searchable, options.length);
  const shown = useMemo(() => search && query ? filterOptions(options, query) : options, [options, query, search]);
  const selectedIndex = shown.findIndex((option) => option.value === value);
  const current = options.find((option) => option.value === value) ?? null;
  const name = label ?? current?.label ?? placeholder;

  const changeQuery = (next: string) => {
    setQuery(next);
    onSearch?.(next);
  };
  const close = (focusTrigger = true) => {
    setState((previous) => ({ ...previous, open: false }));
    changeQuery("");
    if (focusTrigger) triggerRef.current?.focus();
  };
  const commit = (index: number | undefined) => {
    const option = index === undefined ? undefined : shown[index];
    if (option && !option.disabled && option.value !== value) onChange(option.value);
  };

  // Focus the search box, or on a phone without one the list, when it opens.
  useEffect(() => {
    if (!state.open) return;
    if (search) searchRef.current?.focus();
    else if (sheet) listRef.current?.focus();
  }, [state.open, search, sheet]);

  // A click or tap outside closes the desktop popup without choosing.
  useOutsideClose(state.open && !sheet, rootRef, () => close(false));

  function onKey(event: ReactKeyboardEvent<HTMLElement>, searching: boolean) {
    if (disabled) return;
    const result = selectKey(state, event, shown, selectedIndex, Date.now(), searching);
    if (result.handled) {
      // Escape must not also close the host dialog or sheet (ModalDialog skips defaultPrevented).
      event.preventDefault();
      event.stopPropagation();
    }
    setState(result.state);
    if (!result.state.open && state.open) changeQuery("");
    commit(result.commit);
    // Tab: hand focus back to the trigger first, so the browser moves it on from there.
    if (result.close || (event.key === "Tab" && state.open)) triggerRef.current?.focus();
  }

  function pick(index: number) {
    commit(index);
    close();
  }

  const open = state.open && !disabled;
  const activeId = open && state.active >= 0 ? optionDomId(listId, state.active) : undefined;
  const variantClass = `ui-select ui-select-${variant}${swatchOnly ? " ui-select-swatch-only" : ""}${className ? ` ${className}` : ""}`;

  return <div ref={rootRef} className={`ui-select-root ui-select-root-${variant}`}>
    <button ref={triggerRef} id={triggerId} type="button" className={variantClass} role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
      aria-activedescendant={!search && !sheet ? activeId : undefined} aria-label={labelledBy ? undefined : name} aria-labelledby={labelledBy}
      disabled={disabled} autoFocus={autoFocus} data-placeholder={current ? undefined : "true"}
      onClick={() => {
        if (open) close();
        else setState({ ...state, open: true, active: selectedIndex >= 0 ? selectedIndex : firstEnabled(shown) });
      }}
      onKeyDown={(event) => onKey(event, false)}>
      {current?.swatch && <span className={`ui-option-swatch color-${current.swatch}`} aria-hidden="true" />}
      {current?.icon && <span className="ui-option-icon" aria-hidden="true">{current.icon}</span>}
      <span className={`ui-select-value${swatchOnly ? " ui-visually-hidden" : ""}`}>{current ? current.label : placeholder}</span>
      <ChevronDown className="ui-select-chevron" aria-hidden="true" />
    </button>
    {open && <DropdownSurface sheet={sheet} anchorRef={triggerRef} title={label ?? placeholder} onClose={() => close()}
      search={search ? <DropdownSearch inputRef={searchRef} value={query} label={`Search ${label ?? "options"}`} listId={listId} active={state.active}
        onChange={(next) => { changeQuery(next); setState((previous) => ({ ...previous, active: firstEnabled(filterOptions(options, next)) })); }}
        onKeyDown={(event) => onKey(event, true)} /> : undefined}>
      <ListboxOptions id={listId} label={label ?? placeholder} options={shown} active={state.active} emptyText={emptyText} isSelected={(candidate) => candidate === value}
        onPick={pick} onActive={(index) => setState((previous) => ({ ...previous, active: index }))}
        focusable={sheet && !search} activeDescendant={sheet && !search} listRef={listRef}
        onKeyDown={sheet && !search ? (event) => onKey(event, false) : undefined} />
    </DropdownSurface>}
  </div>;
}
