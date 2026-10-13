import { useEffect, useRef } from "react";

/**
 * A form's error line (2026-10-13). Every form sets `noValidate`, so the browser never shows its own
 * "Please fill in this field" bubble; the app says what is missing here instead. The line is an alert
 * (read out when it appears) and is scrolled into view when it changes: on a phone the form can sit
 * in a long scrolling page or dialog body, and the line would otherwise be below the fold.
 */

/** Scroll the element into view whenever `message` becomes (or changes to) a non-empty value. */
export function useRevealError<T extends HTMLElement>(message: string | null | undefined) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!message) return;
    // An instant jump: a smooth scroll started in the frame the line appears in was cancelled by the
    // layout change (QA: the phone event sheet kept its scroll position).
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [message]);
  return ref;
}

export function FormError({ message, id, className = "form-error" }: { message: string | null | undefined; id?: string; className?: string }) {
  const ref = useRevealError<HTMLParagraphElement>(message);
  return message ? <p ref={ref} id={id} className={className} role="alert">{message}</p> : null;
}
