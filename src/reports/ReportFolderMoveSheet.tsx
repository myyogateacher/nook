import { useState } from "react";
import "../files/files.css";
import { Check, Folder as FolderIcon, Layers } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { FormError } from "../ui/FormError";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { ReportFolder } from "../../shared/reports";
import { orderedFolders, placeOf, refuseParent, siblingsOf, type FolderPlace } from "./reportFolderTree";

const TOP = "__top__";

/**
 * Move folder to… (K2): the keyboard and phone way to nest a folder, the same as dragging it onto
 * another folder in the nav. Top level and the folder tree as radios; the folder's current parent is
 * marked, and every place it may not go (itself, its own subfolders, past the depth limit) is disabled
 * with the reason. It lands at the end of its new siblings. Back or Escape closes it; Forward reopens it.
 */
export function ReportFolderMoveSheet({ folder, folders, onMove, onCancel, onReopen }: {
  folder: ReportFolder; folders: readonly ReportFolder[]; onMove: (place: FolderPlace) => Promise<void>; onCancel: () => void; onReopen?: () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useHistoryDialogGuard(true, onCancel, { blocked: busy, reopen: onReopen ?? null, layerKey: `report-folder-move:${folder.id}` });
  const current = placeOf(folders, folder.id).parentId ?? TOP;
  const targets = [{ id: TOP, name: "Top level", depth: 1, reason: refuseParent(folders, folder.id, null) },
    ...orderedFolders(folders).map(({ folder: item, depth }) => ({ id: item.id, name: item.name, depth, reason: refuseParent(folders, folder.id, item.id) }))];
  const chosenTarget = targets.find((target) => target.id === chosen) ?? null;

  async function submitMove() {
    if (!chosenTarget) return;
    setBusy(true);
    setError(null);
    const parentId = chosenTarget.id === TOP ? null : chosenTarget.id;
    try {
      await onMove({ parentId, position: siblingsOf(folders, parentId).filter((item) => item.id !== folder.id).length });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not move the folder");
      setBusy(false);
    }
  }

  return <ModalDialog title={`Move “${folder.name}”`} eyebrow="Move folder to" onClose={onCancel} variant="sheet" busy={busy} className="reports-dialog report-move-sheet report-folder-move-sheet">
    <div className="move-list" role="radiogroup" aria-label="Folders">
      {targets.map((target) => {
        const here = target.id === current;
        const self = target.id === folder.id;
        return <button
          key={target.id}
          type="button"
          role="radio"
          aria-checked={chosen === target.id}
          className={`move-option${chosen === target.id ? " active" : ""}`}
          style={{ paddingLeft: `${12 + (target.depth - 1) * 20}px` }}
          disabled={here || Boolean(target.reason) || busy}
          autoFocus={target.id === targets.find((item) => item.id !== current && !item.reason)?.id}
          onClick={() => setChosen(target.id)}
        >
          {target.id === TOP ? <Layers aria-hidden="true" /> : <FolderIcon aria-hidden="true" />}
          <span>{target.name}{here ? <small>Current place</small> : self ? <small>This folder</small> : target.reason && <small>{target.reason}</small>}</span>
          {chosen === target.id && <Check aria-hidden="true" />}
        </button>;
      })}
    </div>
    <FormError message={error} className="file-dialog-error" />
    <footer className="file-dialog-actions">
      <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
      <button type="button" className="primary-button" onClick={() => { void submitMove(); }} disabled={!chosenTarget || busy}>{busy ? "Moving…" : chosenTarget ? `Move to ${chosenTarget.name}` : "Move"}</button>
    </footer>
  </ModalDialog>;
}
