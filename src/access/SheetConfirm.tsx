import { useId } from "react";
import { ModalDialog } from "../files/Dialog";

/**
 * A confirm with its own cancel wording ("Discard" / "Keep editing"), for the Access sheet and Team →
 * Policies (QA v0.13.0 B3, B4). The caller registers its history layer, so Back is the cancel. It sits
 * above the Access sheet (`.sheet-confirm-layer` lifts the shared dialog over it).
 */
export function SheetConfirm({ title, message, confirmLabel, cancelLabel, danger = false, busy = false, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const messageId = useId();
  return <div className="sheet-confirm-layer">
    <ModalDialog title={title} onClose={onCancel} busy={busy} describedBy={messageId}>
      <p id={messageId} className="file-dialog-copy">{message}</p>
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy} autoFocus>{cancelLabel}</button>
        <button type="button" className={danger ? "danger-button" : "primary-button"} onClick={onConfirm} disabled={busy}>{busy ? "Working…" : confirmLabel}</button>
      </footer>
    </ModalDialog>
  </div>;
}
