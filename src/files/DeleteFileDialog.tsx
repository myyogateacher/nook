import { useId } from "react";
import { ModalDialog } from "./Dialog";

/**
 * The Files delete confirm (D409, T351, review M1): the usual "Move to the Bin?" plus, when the file
 * is attached in places its owner can no longer open, a way to withdraw it from them (the owner may
 * always unlink their own file). Those places are never named: the owner cannot open them.
 */
export function DeleteFileDialog({ message, hiddenCount, busy, removing, status, onRemoveHidden, onConfirm, onCancel }: {
  message: string;
  /** Places the file is attached that the owner cannot open (0 hides the action). */
  hiddenCount: number;
  busy: boolean;
  removing: boolean;
  /** A line after removing ("Removed from 2 places you can't open."). */
  status: string | null;
  onRemoveHidden: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const messageId = useId();
  return <ModalDialog title="Move to the Bin?" onClose={onCancel} busy={busy || removing} describedBy={messageId}>
    <p id={messageId} className="file-dialog-copy">{message}</p>
    {hiddenCount > 0 && <div className="file-dialog-copy file-delete-hidden">
      <button type="button" className="secondary-button" onClick={onRemoveHidden} disabled={busy || removing}>
        {removing ? "Removing…" : `Remove from ${hiddenCount === 1 ? "1 place" : `${hiddenCount} places`} you can't open`}
      </button>
    </div>}
    {status && <p className="file-dialog-copy" role="status">{status}</p>}
    <footer className="file-dialog-actions">
      <button className="secondary-button" onClick={onCancel} disabled={busy || removing}>Cancel</button>
      <button className="danger-button" onClick={onConfirm} disabled={busy || removing} autoFocus>{busy ? "Working…" : "Move to Bin"}</button>
    </footer>
  </ModalDialog>;
}
