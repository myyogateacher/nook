import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type TextareaHTMLAttributes } from "react";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "rows"> & {
  value: string;
  onValueChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
};

/** A title is one line of text: pasted line breaks become spaces. */
export const singleLineTitle = (value: string) => value.replace(/\r?\n|\r/g, " ");

/**
 * The card drawer's editable title (QA note 12): a one-line value that wraps instead of being cut
 * off at 390 px. A textarea sized to its content; while not focused it is capped at two lines and a
 * clamped copy (decorative, clicks pass through to the field) ends a longer title with an ellipsis.
 * Enter still commits (the caller blurs), so it never holds a line break.
 */
export function CardTitleField({ value, onValueChange, className, onFocus, onBlur, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    const fit = () => {
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
    };
    fit();
    // The drawer lays out (and phones rotate) after the first measure: refit when the width changes.
    let width = field.clientWidth;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      fit();
    });
    observer?.observe(field);
    return () => observer?.disconnect();
  }, [value, focused]);
  return <span className={`task-card-title-wrap${focused ? " focused" : ""}`}>
    <textarea
      {...rest}
      ref={ref}
      rows={1}
      className={className}
      value={value}
      onChange={(event) => onValueChange(singleLineTitle(event.target.value))}
      onFocus={(event: FocusEvent<HTMLTextAreaElement>) => { setFocused(true); onFocus?.(event); }}
      onBlur={(event: FocusEvent<HTMLTextAreaElement>) => { setFocused(false); onBlur?.(event); }}
    />
    {!focused && <span className="task-card-title-display" aria-hidden="true">{value}</span>}
  </span>;
}
