import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";

/**
 * The dialog shell of Settings → API keys and Team → Keys / Policies (Wave 31): a centred dialog on
 * desktop and a full-height sheet at 390 px. Back or Forward closes it (and only it: a Select sheet
 * open inside closes first, D69), Escape closes it unless a popup handled the key, and focus starts
 * on the close button.
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
  const titleId = useId();
  const guardedClose = () => { if (!busy) onClose(); };
  useHistoryDialogGuard(true, onClose);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !busy) onClose();
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  useEffect(() => closeRef.current?.focus(), []);
  return <>
    <div className="keys-dialog-scrim" onClick={guardedClose} />
    <div className={`keys-dialog${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header>
        <div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div>
        <button ref={closeRef} type="button" className="icon-button" aria-label="Close" onClick={guardedClose} disabled={busy}><X /></button>
      </header>
      <div className="keys-dialog-body">{children}</div>
      {footer && <div className="keys-dialog-actions">{footer}</div>}
    </div>
  </>;
}
