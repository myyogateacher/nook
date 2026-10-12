import { useState } from "react";
import { api } from "../api";
import { ConfirmDialog } from "../files/Dialog";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";

/**
 * U4 (U0 review M3): files of yours that a just-published note shows but that are in your Bin. They
 * show broken to everyone, and readers cannot open them. Restore puts them back
 * (`POST /api/bin/document/:id/restore`) and re-derives the note's links without a new version
 * (`POST /api/notes/:id/attachments/sync`). The app's confirm (D91), one history layer: Back closes it.
 */
export function BinnedFilesConfirm({ noteId, documentIds, onDone, onCancel }: {
  noteId: string;
  documentIds: string[];
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  useHistoryDialogGuard(true, onCancel, { blocked: busy });
  const count = documentIds.length;

  async function restore() {
    setBusy(true);
    let restored = 0;
    for (const id of documentIds) {
      try {
        await api(`/bin/document/${encodeURIComponent(id)}/restore`, { method: "POST", body: "{}" });
        restored += 1;
      } catch { /* purged meanwhile, or already restored: counted below */ }
    }
    try {
      await api(`/notes/${encodeURIComponent(noteId)}/attachments/sync`, { method: "POST", body: "{}" });
    } catch { /* the next publish derives them */ }
    setBusy(false);
    onDone(restored === count ? (count === 1 ? "File restored" : `${count} files restored`) : `${restored} of ${count} files restored; the others are no longer in your Bin`);
  }

  return <ConfirmDialog
    title={count === 1 ? "A file in this note is in your Bin" : `${count} files in this note are in your Bin`}
    message={`${count === 1 ? "It shows" : "They show"} as missing, and readers of the note cannot open ${count === 1 ? "it" : "them"}. Restore ${count === 1 ? "it" : "them"} from the Bin?`}
    confirmLabel="Restore"
    busy={busy}
    onConfirm={() => { void restore(); }}
    onCancel={onCancel} />;
}
