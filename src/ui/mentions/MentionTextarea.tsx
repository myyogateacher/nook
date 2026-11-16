import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import type { MentionCandidate } from "../../../shared/itemActivity";
import { closesOnSpace, findMentionTrigger, firstSelectable, insertMention, mentionKeyAction, moveSelection, type MentionTrigger } from "./mentionModel";
import { mentionablePeople, type MentionTarget } from "./mentionsApi";
import { MentionList, mentionOptionId } from "./Mentions";

/**
 * A `<textarea>` with the @mention picker (docs/plan/MENTIONS.md §3, D1321): typing "@" after a space
 * (or at the start) lists people who can read `target`, and picking one writes `@[Name](user:<id>)`.
 * ↑/↓ move, Enter or Tab pick, Escape closes the list only (the dialog behind it stays open, since the
 * key is marked handled), and the mouse works. Without a `target` it is a plain textarea.
 */

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  target: MentionTarget | null;
  /** The item's kind word for people who cannot read it ("Can't see this card"). */
  noun?: string;
};

const POPOVER_WIDTH = 280;

/** The caret's box in viewport coordinates, measured with a hidden copy of the textarea (no library). */
export function caretRect(textarea: HTMLTextAreaElement, position: number) {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const name of ["boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "textTransform", "textIndent", "tabSize"] as const) {
    mirror.style[name] = style[name];
  }
  Object.assign(mirror.style, { position: "fixed", visibility: "hidden", top: "0", left: "-9999px", whiteSpace: "pre-wrap", overflowWrap: "break-word", overflow: "hidden" });
  mirror.textContent = textarea.value.slice(0, position);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.append(marker);
  document.body.append(mirror);
  const box = textarea.getBoundingClientRect();
  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4 || 18;
  const left = box.left + marker.offsetLeft - textarea.scrollLeft;
  const top = box.top + marker.offsetTop - textarea.scrollTop;
  mirror.remove();
  return { left: Math.min(Math.max(left, box.left), box.right), top: Math.min(Math.max(top, box.top), box.bottom - lineHeight), height: lineHeight };
}

/** Where the list goes: under the caret line, or above it when there is no room below; inside the viewport. */
export function popoverPlace(caret: { left: number; top: number; height: number }, viewport: { width: number; height: number }, listHeight: number) {
  const width = Math.min(POPOVER_WIDTH, viewport.width - 24);
  const left = Math.max(12, Math.min(caret.left - 12, viewport.width - width - 12));
  const below = caret.top + caret.height + 6;
  const top = below + listHeight > viewport.height - 12 && caret.top - listHeight - 6 >= 12 ? caret.top - listHeight - 6 : below;
  return { left, top, width };
}

export const MentionTextarea = forwardRef<HTMLTextAreaElement, Props>(function MentionTextarea({ value, onValueChange, target, noun = "item", onKeyDown, onSelect, onBlur, ...rest }, forwarded) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useImperativeHandle(forwarded, () => ref.current!, []);
  const listId = useId();
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  const [people, setPeople] = useState<MentionCandidate[]>([]);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number; width: number } | null>(null);
  // An "@" the person closed with Escape (or that matched nobody) stays closed until they type a new one.
  const dismissed = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const open = target !== null && trigger !== null;

  const readTrigger = useCallback((text: string) => {
    const element = ref.current;
    if (!element || !target || element.selectionStart !== element.selectionEnd) { setTrigger(null); return; }
    const found = findMentionTrigger(text, element.selectionStart);
    if (found && found.start === dismissed.current) { setTrigger(null); return; }
    if (!found) dismissed.current = null;
    setTrigger((current) => current && found && current.start === found.start && current.query === found.query ? current : found);
  }, [target]);

  // People for the query, a moment after the last keystroke.
  useEffect(() => {
    if (!open || !target) return undefined;
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      mentionablePeople(target, trigger.query.trim(), controller.signal).then((found) => {
        if (closesOnSpace(trigger.query, found.length)) {
          dismissed.current = trigger.start;
          setTrigger(null);
          return;
        }
        setPeople(found);
        setActive(firstSelectable(found));
        setLoading(false);
      }, () => { if (!controller.signal.aborted) { setPeople([]); setLoading(false); } });
    }, 120);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [open, target, trigger?.start, trigger?.query]);

  useEffect(() => { if (!open) { setPeople([]); setActive(-1); setPlace(null); } }, [open]);

  const measure = useCallback(() => {
    const element = ref.current;
    if (!element || !trigger) return;
    const caret = caretRect(element, trigger.start);
    setPlace(popoverPlace(caret, { width: window.innerWidth, height: window.innerHeight }, listRef.current?.offsetHeight ?? 200));
  }, [trigger]);
  useLayoutEffect(() => { if (open) measure(); }, [open, measure, people.length]);
  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => { window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [open, measure]);

  const pick = (person: MentionCandidate) => {
    const element = ref.current;
    if (!element || !trigger || !person.canRead) return;
    const next = insertMention(value, trigger, element.selectionStart, person);
    onValueChange(next.text);
    setTrigger(null);
    // After React writes the new value.
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(next.caret, next.caret); });
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && !event.nativeEvent.isComposing) {
      const action = mentionKeyAction(event.key, { shift: event.shiftKey, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey });
      const handled = action === "close" || action === "down" || action === "up" || (action === "pick" && active >= 0);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
        if (action === "down") setActive(moveSelection(people, active, 1));
        else if (action === "up") setActive(moveSelection(people, active, -1));
        else if (action === "pick") pick(people[active]!);
        else { dismissed.current = trigger.start; setTrigger(null); }
        return;
      }
    }
    onKeyDown?.(event);
  };

  return <>
    <textarea {...rest} ref={ref} value={value}
      aria-autocomplete={target ? "list" : undefined}
      aria-controls={open ? listId : undefined}
      aria-activedescendant={open && active >= 0 ? mentionOptionId(listId, active) : undefined}
      onChange={(event) => { onValueChange(event.target.value); readTrigger(event.target.value); }}
      onSelect={(event) => { readTrigger(event.currentTarget.value); onSelect?.(event); }}
      onKeyDown={keyDown}
      onBlur={(event) => { setTrigger(null); onBlur?.(event); }} />
    {open && createPortal(<div ref={listRef} className="mention-popover" style={place ? { left: place.left, top: place.top, width: place.width } : { visibility: "hidden" }}>
      <MentionList id={listId} people={people} active={active} loading={loading} noun={noun} onPick={pick} onActive={setActive} />
    </div>, document.body)}
  </>;
});
