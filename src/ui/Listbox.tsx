import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { Check, X } from "lucide-react";
import { trapTabKey } from "../files/Dialog";
import { groupRuns } from "./listNavigation";
import { correctForContainingBlock, placePopover } from "./popoverPosition";
import { useHistoryDialogGuard } from "./useHistoryDialogGuard";

// The list shared by Select and Combobox (D91, D114): a fixed-position popup under the trigger on
// desktop, a bottom sheet with 44 px rows on phones (≤ 760 px). Both render inside the owner's
// subtree, not in a portal, so a host dialog's focus trap and aria-modal keep covering them.
// Labels are always React text nodes (T98).

export type Option<V extends string = string> = {
  value: V;
  label: string;
  description?: string;
  /** A colour name from the palette (`color-<name>` classes), shown as a dot. */
  swatch?: string;
  icon?: ReactNode;
  disabled?: boolean;
  group?: string;
};

export type Presentation = "auto" | "popup" | "sheet";

const phoneQuery = "(max-width: 760px)";
function subscribePhone(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const list = window.matchMedia(phoneQuery);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}
const phoneSnapshot = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(phoneQuery).matches;

/** True at ≤ 760 px, following resizes. False while rendering on the server. */
export function useIsPhone() {
  return useSyncExternalStore(subscribePhone, phoneSnapshot, () => false);
}

export function useSheet(presentation: Presentation) {
  const phone = useIsPhone();
  return presentation === "sheet" || (presentation === "auto" && phone);
}

/**
 * Closes the desktop popup on a pointer press outside `rootRef`. A press on a dialog's scrim only
 * closes the popup, as with a native select: the click that follows is swallowed so the host
 * dialog stays open.
 */
export function useOutsideClose(active: boolean, rootRef: RefObject<HTMLElement | null>, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!active) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || rootRef.current?.contains(target)) return;
      closeRef.current();
      if (!target.closest?.('[class*="scrim"]')) return;
      const swallow = (click: MouseEvent) => { click.stopPropagation(); click.preventDefault(); };
      document.addEventListener("click", swallow, { capture: true, once: true });
      // A press that never becomes a click must not swallow a later one.
      setTimeout(() => document.removeEventListener("click", swallow, { capture: true }), 600);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [active, rootRef]);
}

export const optionDomId =(listId: string, index: number) => `${listId}-option-${index}`;

type ListboxOptionsProps = {
  id: string;
  label: string;
  options: Option[];
  active: number;
  isSelected: (value: string) => boolean;
  multiple?: boolean;
  onPick: (index: number) => void;
  onActive: (index: number) => void;
  emptyText?: string;
  /** Focusable (the phone sheet without a search box puts focus on the list itself). */
  focusable?: boolean;
  activeDescendant?: boolean;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
  listRef?: RefObject<HTMLDivElement | null>;
};

export function ListboxOptions({ id, label, options, active, isSelected, multiple, onPick, onActive, emptyText = "No matches", focusable, activeDescendant, onKeyDown, listRef }: ListboxOptionsProps) {
  // Keep the active option in view as the keyboard moves it.
  useEffect(() => {
    if (active < 0 || typeof document === "undefined") return;
    document.getElementById(optionDomId(id, active))?.scrollIntoView?.({ block: "nearest" });
  }, [active, id]);
  const row = (option: Option, index: number) => {
    const selected = isSelected(option.value);
    return <div key={`${option.value}-${index}`} id={optionDomId(id, index)} role="option" aria-selected={selected} aria-disabled={option.disabled || undefined}
      className={`ui-option${index === active ? " active" : ""}${selected ? " selected" : ""}`}
      // Keep focus on the trigger or search box while the pointer chooses.
      onMouseDown={(event) => event.preventDefault()}
      onPointerMove={() => { if (!option.disabled && index !== active) onActive(index); }}
      onClick={() => { if (!option.disabled) onPick(index); }}>
      {option.swatch && <span className={`ui-option-swatch color-${option.swatch}`} aria-hidden="true" />}
      {option.icon && <span className="ui-option-icon" aria-hidden="true">{option.icon}</span>}
      <span className="ui-option-copy"><span className="ui-option-label">{option.label}</span>{option.description && <small>{option.description}</small>}</span>
      <span className={`ui-option-check${multiple ? " multiple" : ""}`} aria-hidden="true">{selected && <Check />}</span>
    </div>;
  };
  const runs = groupRuns(options);
  return <div ref={listRef} id={id} role="listbox" aria-label={label} aria-multiselectable={multiple || undefined} className="ui-listbox"
    tabIndex={focusable ? -1 : undefined} aria-activedescendant={activeDescendant && active >= 0 ? optionDomId(id, active) : undefined} onKeyDown={onKeyDown}>
    {!options.length && <div className="ui-listbox-empty" role="presentation">{emptyText}</div>}
    {runs.map((run, at) => run.group
      ? <div key={`group-${at}`} role="group" aria-labelledby={`${id}-group-${at}`} className="ui-option-group">
        <div id={`${id}-group-${at}`} className="ui-option-group-label" role="presentation">{run.group}</div>
        {run.items.map(({ option, index }) => row(option, index))}
      </div>
      : run.items.map(({ option, index }) => row(option, index)))}
  </div>;
}

type SurfaceProps = {
  sheet: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  /** The sheet's heading (the field's label). */
  title: string;
  onClose: () => void;
  search?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
};

/** The popup (desktop) or the bottom sheet (phones) around a ListboxOptions. */
export function DropdownSurface(props: SurfaceProps) {
  return props.sheet ? <DropdownSheet {...props} /> : <DropdownPopup {...props} />;
}

function DropdownPopup({ anchorRef, search, footer, children }: SurfaceProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState(false);
  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current;
      const popup = popupRef.current;
      if (!anchor || !popup) return;
      const rect = anchor.getBoundingClientRect();
      const style = popup.style;
      // Measure the natural size at the trigger's width, without the previous height cap.
      style.maxHeight = "";
      style.minWidth = `${Math.min(rect.width, window.innerWidth - 16)}px`;
      const placement = placePopover(
        { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        { width: popup.offsetWidth, height: popup.scrollHeight },
        { width: window.innerWidth, height: window.innerHeight }
      );
      style.minWidth = `${placement.minWidth}px`;
      style.maxWidth = `${placement.maxWidth}px`;
      style.maxHeight = `${placement.maxHeight}px`;
      style.top = `${placement.top}px`;
      style.left = `${placement.left}px`;
      // A transformed ancestor would be the containing block: measure and correct (§4.1 gotcha).
      const measured = popup.getBoundingClientRect();
      if (Math.abs(measured.top - placement.top) > 0.5 || Math.abs(measured.left - placement.left) > 0.5) {
        const corrected = correctForContainingBlock(placement, measured);
        style.top = `${corrected.top}px`;
        style.left = `${corrected.left}px`;
      }
      popup.dataset.side = placement.side;
      setPlaced(true);
    };
    place();
    // Scrolling any ancestor (a grid that scrolls both ways) moves the trigger. Scrolling the
    // popup's own list does not, and re-placing then (which lifts the height cap to measure) reset
    // its scroll to the top, so a long list could never be scrolled to its last options.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && popupRef.current?.contains(event.target)) return;
      place();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchorRef]);
  return <div ref={popupRef} className="ui-popup" style={placed ? undefined : { visibility: "hidden" }}>
    {search}
    <div className="ui-popup-body">{children}</div>
    {footer}
  </div>;
}

function DropdownSheet({ title, onClose, search, footer, children }: SurfaceProps) {
  // D69: Back closes only this sheet; at depth 0 on a phone it holds the sentinel entry.
  useHistoryDialogGuard(true, onClose);
  return <div className="ui-sheet-layer">
    <button type="button" className="ui-sheet-scrim" aria-label="Close" tabIndex={-1} onClick={onClose} />
    <div className="ui-sheet" role="dialog" aria-modal="true" aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        // Keep Tab inside the sheet, and keep the host dialog's trap from moving it back out.
        trapTabKey(event);
        event.stopPropagation();
      }}>
      <header className="ui-sheet-header">
        <strong>{title}</strong>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X /></button>
      </header>
      {search}
      <div className="ui-sheet-body">{children}</div>
      {footer}
    </div>
  </div>;
}

/** The search box above the options (Select with `searchable`, and the Combobox phone sheet). */
export function DropdownSearch({ value, onChange, label, listId, active, onKeyDown, inputRef, placeholder = "Search" }: {
  value: string; onChange: (value: string) => void; label: string; listId: string; active: number;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void; inputRef?: RefObject<HTMLInputElement | null>; placeholder?: string;
}) {
  return <div className="ui-search">
    <input ref={inputRef} type="search" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={listId}
      aria-activedescendant={active >= 0 ? optionDomId(listId, active) : undefined} aria-label={label} placeholder={placeholder}
      value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} autoComplete="off" spellCheck={false} enterKeyHint="done" />
  </div>;
}
