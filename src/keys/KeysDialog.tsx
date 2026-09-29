import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { trapTabKey } from "../files/Dialog";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";

/**
 * The dialog shell of Settings → API keys and Team → Keys / Policies (Wave 31): a centred dialog on
 * desktop and a full-height sheet at 390 px. Back or Forward closes it (and only it: a Select sheet
 * open inside closes first, D69), Escape closes it unless a popup handled the key, and focus starts
 * on the close button unless a field inside has autoFocus. Tab stays inside. While `busy` (a request in flight) nothing closes it: Escape
 * is ignored and Back or Forward is undone, so a token the request returns is never lost (review L5).
 */
export function KeysDialog({ title, description, onClose, busy = false, children, footer, wide = false }: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const guardedClose = () => { if (!busy) onClose(); };
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !busy) onClose();
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  // Focus starts on the close button, unless a field inside asked for it (autoFocus runs first).
  useEffect(() => {
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (!(active instanceof HTMLElement && dialogRef.current?.contains(active))) closeRef.current?.focus();
  }, []);
  return <>
    <div className="keys-dialog-scrim" onClick={guardedClose} />
    <div ref={dialogRef} className={`keys-dialog${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={trapTabKey}>
      <header>
        <div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div>
        <button ref={closeRef} type="button" className="icon-button" aria-label="Close" onClick={guardedClose} disabled={busy}><X /></button>
      </header>
      <div className="keys-dialog-body">{children}</div>
      {footer && <div className="keys-dialog-actions">{footer}</div>}
    </div>
  </>;
}
