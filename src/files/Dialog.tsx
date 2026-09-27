import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";

const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab and Shift+Tab inside a modal container. */
export function trapTabKey(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => !element.hasAttribute("hidden"));
  if (!focusable.length) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

type FocusContainer = Pick<HTMLElement, "contains" | "querySelectorAll" | "focus">;

/**
 * Moves focus into a modal that has just opened when nothing inside has it yet (an `autoFocus`
 * child wins, as React focuses it before effects run): the first focusable element, else the
 * container. Without this the opener keeps focus and Tab walks the page behind (QA 0.9.0).
 */
export function focusIntoDialog(container: FocusContainer | null, active: Element | null = document.activeElement) {
  if (!container || (active && container.contains(active))) return;
  const first = Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).find((element) => !element.hasAttribute("hidden"));
  (first ?? container).focus();
}

/** {@link focusIntoDialog} once, on open. */
export function useDialogFocus(ref: RefObject<HTMLElement | null>) {
  useEffect(() => { focusIntoDialog(ref.current); }, [ref]);
}

type ModalDialogProps = {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  /** "sheet" becomes a full-screen panel on phones (the Move sheet). */
  variant?: "dialog" | "sheet";
  busy?: boolean;
  /** Id of the element that explains the dialog (the confirm message). */
  describedBy?: string;
  /** An extra class on the dialog, for a module's own width (the Calendar event sheet). */
  className?: string;
};

// In-app modal used by every Files dialog. Escape closes it; it adds no history entry, so browser
// Back is handled by FilesApp (it closes the dialog and keeps the panel, D18).
export function ModalDialog({ title, eyebrow, onClose, children, variant = "dialog", busy = false, describedBy, className }: ModalDialogProps) {
  const titleId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  useDialogFocus(sectionRef);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A dropdown inside the dialog handles its own Escape first (preventDefault).
      if (event.key !== "Escape" || busy || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return <>
    <button className="panel-scrim file-dialog-scrim" onClick={() => { if (!busy) onClose(); }} aria-label="Close dialog" tabIndex={-1} />
    <section ref={sectionRef} tabIndex={-1} className={`file-dialog${variant === "sheet" ? " file-dialog-sheet" : ""}${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={describedBy} aria-busy={busy || undefined} onKeyDown={trapTabKey}>
      <header className="file-dialog-header">
        <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2 id={titleId} title={title}>{title}</h2></div>
        <button className="icon-button" onClick={onClose} disabled={busy} aria-label="Close"><X /></button>
      </header>
      {children}
    </section>
  </>;
}

type ConfirmDialogProps = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  /** The action is not possible right now; the message says why. Focus starts on Cancel. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({ title, message, confirmLabel, danger = false, busy = false, confirmDisabled = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const messageId = useId();
  return <ModalDialog title={title} onClose={onCancel} busy={busy} describedBy={messageId}>
    <p id={messageId} className="file-dialog-copy">{message}</p>
    <footer className="file-dialog-actions">
      <button className="secondary-button" onClick={onCancel} disabled={busy} autoFocus={confirmDisabled}>Cancel</button>
      <button className={danger ? "danger-button" : "primary-button"} onClick={onConfirm} disabled={busy || confirmDisabled} autoFocus={!confirmDisabled}>{busy ? "Working…" : confirmLabel}</button>
    </footer>
  </ModalDialog>;
}
