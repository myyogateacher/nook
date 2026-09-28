import { useLayoutEffect, useRef, type KeyboardEvent, type TextareaHTMLAttributes } from "react";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "rows"> & {
  value: string;
  onValueChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
};

/** A title is one line of text: pasted line breaks become spaces. */
export const singleLineTitle = (value: string) => value.replace(/\r?\n|\r/g, " ");

/**
 * The card drawer's editable title (QA note 12): a one-line value that wraps instead of being cut
 * off at 390 px. A textarea sized to its content, capped at two lines by CSS while not focused;
 * Enter still commits (the caller blurs), so it never holds a line break.
 */
export function CardTitleField({ value, onValueChange, className, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [value]);
  return <textarea
    {...rest}
    ref={ref}
    rows={1}
    className={className}
    value={value}
    onChange={(event) => onValueChange(singleLineTitle(event.target.value))}
  />;
}
