import { useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref } from "react";
import { Plus, X } from "lucide-react";
import { createOptionLoader } from "./asyncOptions";
import { comboboxKey, filterOptions, foldText, removeLastValue, toggleValue } from "./listNavigation";
import { DropdownSurface, ListboxOptions, optionDomId, useOutsideClose, useSheet, type Option, type Presentation } from "./Listbox";

export type ComboboxProps<V extends string> = {
  multiple?: boolean;
  value: V[];
  onChange: (value: V[]) => void;
  /** Filtered on the client as you type. */
  options?: Option<V>[];
  /** Loaded as you type instead: 200 ms after the last key, aborting the previous request. */
  loadOptions?: (query: string, signal: AbortSignal) => Promise<Option<V>[]>;
  /** Labels for chosen values that are not among the loaded options. */
  selectedOptions?: Option<V>[];
  /** Offers a "Create “x”" row when nothing matches the text exactly (tags). */
  onCreate?: (label: string) => Promise<Option<V>>;
  maxSelected?: number;
  label: string;
  placeholder?: string;
  /** The field's placeholder once chips are shown (none by default): "Add another board…". */
  placeholderWithValues?: string;
  emptyText?: string;
  disabled?: boolean;
  id?: string;
  presentation?: Presentation;
  /** Opens on mount; the desktop popup then takes focus, so Escape and the arrow keys reach it. */
  defaultOpen?: boolean;
  /**
   * The phone sheet closed (Done, Back, the scrim, or a single pick). With this set, focus does not
   * return to the field on the page, whose focus would raise the keyboard: the host moves it.
   */
  onSheetClose?: () => void;
  /** Opens the list when the field takes focus (not only on a click or a key), on desktop. */
  openOnFocus?: boolean;
  /** Lets the host open the list and put focus in its text box ("+ New tag"). */
  handleRef?: Ref<ComboboxHandle>;
  /**
   * Backspace in an empty search removes the last chip (default). Off where losing a chip by a stray
   * key costs more than the shortcut saves (key grants, Wave 34 review Q13): only the chip's × removes.
   */
  backspaceRemoves?: boolean;
};

export type ComboboxHandle = { open: () => void };

const CREATE_VALUE = "\u0000create";

/** The "Create" row when the text matches no option exactly. */
export function createRow(query: string, options: readonly { label: string }[], canCreate: boolean): Option | null {
  const label = query.trim();
  if (!canCreate || !label) return null;
  if (options.some((option) => foldText(option.label) === foldText(label))) return null;
  return { value: CREATE_VALUE, label: `Create “${label}”`, icon: <Plus /> };
}

/**
 * The rows of the open list: the "Create" row first, as soon as anything is typed, then the matches.
 * `firstActive` is the row Enter picks straight away: the first enabled match, else the Create row.
 */
export function comboboxRows<T extends Option>(matches: readonly T[], create: Option | null): { shown: Option[]; firstActive: number } {
  const first = matches.findIndex((option) => !option.disabled);
  const offset = create ? 1 : 0;
  return {
    shown: create ? [create, ...matches] : [...matches],
    firstActive: first >= 0 ? first + offset : create ? 0 : -1
  };
}

/**
 * Where focus goes after a pointer pick, when the list stays open (several values): nowhere while it
 * is already inside the combobox (the option's mousedown keeps it there), otherwise back into the
 * field (desktop popup) or the sheet's search box, so Escape and the arrow keys still reach it.
 */
export function pickFocusTarget(sheet: boolean, focusInside: boolean): "field" | "search" | null {
  if (focusInside) return null;
  return sheet ? "search" : "field";
}

/**
 * An editable combobox with list autocomplete (APG), single or multiple, with chips for the chosen
 * values (D91). Desktop: a popup under the field. Phones: a bottom sheet with a sticky search box
 * that Back closes (D69).
 */
export function Combobox<V extends string>({ multiple = false, value, onChange, options, loadOptions, selectedOptions, onCreate, maxSelected = multiple ? Infinity : 1, label, placeholder = "Search…", placeholderWithValues = "", emptyText = "No matches", disabled = false, id, presentation = "auto", defaultOpen = false, onSheetClose, openOnFocus = false, handleRef, backspaceRemoves = true }: ComboboxProps<V>) {
  const autoId = useId();
  const inputId = id ?? `${autoId}-input`;
  const listId = `${autoId}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sheetInputRef = useRef<HTMLInputElement>(null);
  const sheet = useSheet(presentation);
  const [open, setOpen] = useState(defaultOpen);
  const [active, setActive] = useState(-1);
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState<Option<V>[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  // Labels of every option seen, so chips keep their names when the list changes.
  const known = useRef(new Map<string, Option<V>>());
  for (const option of [...(selectedOptions ?? []), ...(options ?? []), ...loaded]) known.current.set(option.value, option);

  const loader = useMemo(() => loadOptions ? createOptionLoader(loadOptions, {
    onResult: (_query, result) => { setLoaded(result); setLoading(false); setLoadError(false); },
    onError: () => { setLoaded([]); setLoading(false); setLoadError(true); }
  }) : null, [loadOptions]);
  useEffect(() => () => loader?.cancel(), [loader]);
  useEffect(() => {
    if (!loader || !open) return;
    setLoading(true);
    loader.request(query);
  }, [loader, open, query]);

  const atMax = value.length >= maxSelected && multiple;
  const matches = (loader ? loaded : filterOptions(options ?? [], query)).map((option) =>
    atMax && !value.includes(option.value) ? { ...option, disabled: true } : option);
  const create = onCreate && !atMax ? createRow(query, matches, true) : null;
  const { shown } = comboboxRows(matches, create);
  // Focus moved back into the field by close(): not a reason to open again.
  const refocusing = useRef(false);

  function openList() {
    if (disabled) return;
    setOpen(true);
    setActive(-1);
  }
  useImperativeHandle(handleRef, () => ({
    open: () => {
      openList();
      if (!sheet) inputRef.current?.focus({ preventScroll: true });
    }
  }));

  // Announce the result count once the list settles.
  useEffect(() => {
    if (!open || loading) return;
    setAnnouncement(loadError ? "Could not load options" : matches.length ? `${matches.length} ${matches.length === 1 ? "result" : "results"}` : emptyText);
  }, [open, loading, loadError, matches.length, emptyText]);

  useEffect(() => { if (open && sheet) sheetInputRef.current?.focus(); }, [open, sheet]);
  // Opened on mount (a filter's value list): focus the field, or Escape and the keys go nowhere.
  useEffect(() => {
    if (defaultOpen && !sheet && !rootRef.current?.contains(document.activeElement)) inputRef.current?.focus({ preventScroll: true });
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A click or tap outside closes the desktop popup without choosing.
  useOutsideClose(open && !sheet, rootRef, () => close(false));

  function close(focusInput = true) {
    setOpen(false);
    setActive(-1);
    setQuery("");
    if (sheet && onSheetClose) {
      onSheetClose();
      return;
    }
    if (focusInput) {
      refocusing.current = true;
      inputRef.current?.focus();
      refocusing.current = false;
    }
  }

  function labelOf(candidate: string) {
    return known.current.get(candidate)?.label ?? candidate;
  }

  function choose(option: Option) {
    const next = multiple ? toggleValue(value, option.value as V, maxSelected) : [option.value as V];
    if (next.length > value.length) setAnnouncement(`${option.label} added`);
    else if (next.length < value.length) setAnnouncement(`${option.label} removed`);
    onChange(next);
    setQuery("");
  }

  async function commit(index: number) {
    const option = shown[index];
    if (!option || option.disabled) return;
    if (option.value === CREATE_VALUE && onCreate) {
      setCreating(true);
      try {
        const created = await onCreate(query.trim());
        known.current.set(created.value, created);
        choose(created);
      } catch {
        setAnnouncement("Could not create it");
      } finally {
        setCreating(false);
      }
    } else {
      choose(option);
    }
    if (!multiple) {
      close();
      return;
    }
    const target = pickFocusTarget(sheet, Boolean(rootRef.current?.contains(document.activeElement)));
    if (target) (target === "search" ? sheetInputRef : inputRef).current?.focus({ preventScroll: true });
  }

  function remove(candidate: V) {
    setAnnouncement(`${labelOf(candidate)} removed`);
    onChange(value.filter((item) => item !== candidate));
  }

  function onKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (disabled || creating) return;
    const result = comboboxKey({ open, active }, event, shown, { query, multiple, hasValues: backspaceRemoves && value.length > 0, settled: !loading });
    if (result.handled) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (result.removeLast) {
      const last = value[value.length - 1];
      if (last !== undefined) setAnnouncement(`${labelOf(last)} removed`);
      onChange(removeLastValue(value));
      return;
    }
    if (result.commit !== undefined) {
      void commit(result.commit);
      return;
    }
    if (result.close) close(!sheet || event.key !== "Tab");
    else {
      setOpen(result.open);
      setActive(result.active);
    }
  }

  const input = (ref: typeof inputRef, inSheet: boolean) => <input ref={ref} id={inSheet ? undefined : inputId} className="ui-combobox-input" type="text" role="combobox"
    aria-autocomplete="list" aria-expanded={open && (inSheet || !sheet)} aria-controls={listId} aria-label={label}
    aria-activedescendant={open && active >= 0 && (inSheet || !sheet) ? optionDomId(listId, active) : undefined}
    value={query} placeholder={value.length && !inSheet ? placeholderWithValues : placeholder} disabled={disabled} autoComplete="off" spellCheck={false}
    // On phones the field only opens the sheet, which has its own search box.
    readOnly={sheet && !inSheet} inputMode={sheet && !inSheet ? "none" : undefined}
    onChange={(event) => {
      const text = event.target.value;
      setQuery(text);
      setOpen(true);
      if (loader) {
        setActive(-1);
        return;
      }
      const typed = filterOptions(options ?? [], text).map((option) => atMax && !value.includes(option.value) ? { ...option, disabled: true } : option);
      setActive(comboboxRows(typed, onCreate && !atMax ? createRow(text, typed, true) : null).firstActive);
    }}
    onClick={() => { if (!open) openList(); }}
    onFocus={() => { if (openOnFocus && !open && !sheet && !inSheet && !refocusing.current) openList(); }}
    onKeyDown={onKey} />;

  return <div ref={rootRef} className={`ui-combobox${disabled ? " disabled" : ""}`}>
    <div ref={fieldRef} className="ui-combobox-field" onClick={(event) => { if (event.target === event.currentTarget) inputRef.current?.focus(); }}>
      {value.map((candidate) => {
        const option = known.current.get(candidate);
        return <span key={candidate} className={`ui-chip${option?.swatch ? ` color-${option.swatch}` : ""}`}>
          {option?.icon && <span className="ui-option-icon" aria-hidden="true">{option.icon}</span>}
          <span className="ui-chip-label">{labelOf(candidate)}</span>
          <button type="button" className="ui-chip-remove" aria-label={`Remove ${labelOf(candidate)}`} disabled={disabled} onClick={() => remove(candidate)}><X /></button>
        </span>;
      })}
      {input(inputRef, false)}
    </div>
    {open && !disabled && <DropdownSurface sheet={sheet} anchorRef={fieldRef} title={label} onClose={() => close()}
      search={sheet ? <div className="ui-search">{input(sheetInputRef, true)}</div> : undefined}
      footer={sheet && multiple ? <footer className="ui-sheet-footer"><button type="button" className="primary-button" onClick={() => close()}>Done</button></footer> : undefined}>
      {loading && !shown.length
        ? <div className="ui-listbox-empty" role="status">Loading…</div>
        : <ListboxOptions id={listId} label={label} options={shown} active={active} multiple={multiple} isSelected={(candidate) => value.includes(candidate as V)}
          onPick={(index) => { void commit(index); }} onActive={setActive} emptyText={loadError ? "Could not load options" : emptyText} />}
    </DropdownSurface>}
    <span className="ui-visually-hidden" aria-live="polite">{announcement}</span>
  </div>;
}
