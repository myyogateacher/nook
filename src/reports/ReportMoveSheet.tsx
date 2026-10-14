import { useState } from "react";
import "../files/files.css";
import { Check, Folder as FolderIcon, Inbox } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { FormError } from "../ui/FormError";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { ReportFolder } from "../../shared/reports";
import { orderedFolders } from "./reportFolderTree";

const UNFILED = "__unfiled__";

/**
 * Move to… (Lane I): the keyboard and phone way to file a report, the same as dragging its row onto a
 * folder. The Files Move sheet's look (a dialog on desktop, a full-screen sheet on phones): Unfiled and
 * the folder tree as radios, the current place disabled. Back or Escape closes it (D18).
 */
export function ReportMoveSheet({ title, currentFolderId, folders, onMove, onCancel }: { title: string; currentFolderId: string | null; folders: readonly ReportFolder[]; onMove: (folderId: string | null) => Promise<void>; onCancel: () => void }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useHistoryDialogGuard(true, onCancel, { blocked: busy });
  const current = currentFolderId ?? UNFILED;
  const targets = [{ id: UNFILED, name: "Unfiled", depth: 1 }, ...orderedFolders(folders).map(({ folder, depth }) => ({ id: folder.id, name: folder.name, depth }))];
  const chosenTarget = targets.find((target) => target.id === chosen) ?? null;

  async function submitMove() {
    if (!chosenTarget) return;
    setBusy(true);
    setError(null);
    try {
      await onMove(chosenTarget.id === UNFILED ? null : chosenTarget.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not move the report");
      setBusy(false);
    }
  }

  return <ModalDialog title={`Move “${title}”`} eyebrow="Move to" onClose={onCancel} variant="sheet" busy={busy} className="reports-dialog report-move-sheet">
    <div className="move-list" role="radiogroup" aria-label="Folders">
      {targets.map((target) => <button
        key={target.id}
        type="button"
        role="radio"
        aria-checked={chosen === target.id}
        className={`move-option${chosen === target.id ? " active" : ""}`}
        style={{ paddingLeft: `${12 + (target.depth - 1) * 20}px` }}
        disabled={target.id === current || busy}
        autoFocus={target.id === targets.find((item) => item.id !== current)?.id}
        onClick={() => setChosen(target.id)}
      >
        {target.id === UNFILED ? <Inbox aria-hidden="true" /> : <FolderIcon aria-hidden="true" />}
        <span>{target.name}{target.id === current && <small>Current folder</small>}</span>
        {chosen === target.id && <Check aria-hidden="true" />}
      </button>)}
      {targets.length === 1 && <p className="file-dialog-copy">You have no folders yet. Create one with New folder in the folder list.</p>}
    </div>
    <FormError message={error} className="file-dialog-error" />
    <footer className="file-dialog-actions">
      <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
      <button type="button" className="primary-button" onClick={() => { void submitMove(); }} disabled={!chosenTarget || busy}>{busy ? "Moving…" : chosenTarget ? `Move to ${chosenTarget.name}` : "Move"}</button>
    </footer>
  </ModalDialog>;
}
