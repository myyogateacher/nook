import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { DropdownSurface, useOutsideClose, useSheet, type Presentation } from "./Listbox";
import { moveActive, stepEnabled, type NavOption } from "./listNavigation";

// The "Add reaction" picker (WAVES_18-20_SMALL.md §3.5, D91 family): a fixed-position popover with a
// grid of 44 px buttons on desktop, a bottom sheet on phones (≤ 760 px) whose Back closes only the
// sheet (useHistoryDialogGuard inside DropdownSurface). Rendered in the owner's subtree, not a
// portal, so a host dialog's focus trap and aria-modal keep covering it. Glyphs and labels come
// from a fixed table and render as React text (T153).

export type ReactionChoice = { key: string; glyph: string; label: string; pressed: boolean };

export const REACTION_GRID_COLUMNS = 4;

const gridKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

/** The focused cell after a grid key (no wrapping), or null for any other key. */
export function reactionGridMove(count: number, from: number, key: string, columns = REACTION_GRID_COLUMNS) {
  if (!gridKeys.has(key) || count <= 0) return null;
  const options: NavOption[] = Array.from({ length: count }, (_, index) => ({ value: String(index), label: String(index) }));
  switch (key) {
    case "ArrowRight": return stepEnabled(options, from, 1);
    case "ArrowLeft": return stepEnabled(options, from, -1);
    // A whole row down or up; stepEnabled stops at the last cell rather than wrapping.
    case "ArrowDown": return from + columns < count ? from + columns : from;
    case "ArrowUp": return from - columns >= 0 ? from - columns : from;
    case "Home": return moveActive(options, from, "Home");
    default: return moveActive(options, from, "End");
  }
}

type ReactionPickerProps = {
  choices: readonly ReactionChoice[];
  /** The trigger: the popover sits under it, and focus returns to it on close. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Presses inside this element (the trigger's row) do not count as "outside". */
  containerRef: RefObject<HTMLElement | null>;
  onPick: (key: string) => void;
  onClose: () => void;
  title?: string;
  /** Shown under the sheet's heading (the current reactions with names, the phone answer to tooltips). */
  sheetSummary?: ReactNode;
  presentation?: Presentation;
};

export function ReactionPicker({ choices, anchorRef, containerRef, onPick, onClose, title = "Add reaction", sheetSummary, presentation = "auto" }: ReactionPickerProps) {
  const sheet = useSheet(presentation);
  const [active, setActive] = useState(0);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Escape, a pick, the sheet's Close, or Back: the picker goes and the trigger has focus again.
  const close = useRef(() => {
    closeRef.current();
    anchorRef.current?.focus();
  }).current;
  useOutsideClose(!sheet, containerRef, onClose);
  // The popover is hidden until it is placed (a layout effect, then a render): focus the first
  // choice once it is visible, since a hidden button cannot take focus.
  useEffect(() => {
    const frame = requestAnimationFrame(() => buttons.current[0]?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // The card behind handles Escape too; this one is the picker's.
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab" && !sheet) {
      event.preventDefault();
      close();
      return;
    }
    const next = reactionGridMove(choices.length, active, event.key);
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    buttons.current[next]?.focus();
  };

  return <DropdownSurface sheet={sheet} anchorRef={anchorRef} title={title} onClose={close} search={sheet ? sheetSummary : undefined}>
    <div className="ui-reaction-grid" role="group" aria-label={title} onKeyDown={onKeyDown}>
      {choices.map((choice, index) => <button key={choice.key} ref={(node) => { buttons.current[index] = node; }} type="button"
        className={`ui-reaction-choice${choice.pressed ? " pressed" : ""}`} tabIndex={index === active ? 0 : -1}
        aria-pressed={choice.pressed} aria-label={choice.label} title={choice.label}
        onFocus={() => setActive(index)}
        onClick={() => { onPick(choice.key); close(); }}>
        <span aria-hidden="true">{choice.glyph}</span>
      </button>)}
    </div>
  </DropdownSurface>;
}
