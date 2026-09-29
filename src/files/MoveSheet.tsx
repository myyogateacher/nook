import { useState } from "react";
import { Check, Folder as FolderIcon } from "lucide-react";
import type { DocumentSummary, Folder } from "../types";
import { ModalDialog } from "./Dialog";
import { moveTargets } from "./fileActions";

type MoveSheetProps = {
  /** A file, or (Notes → Move to folder…) the open note. */
  document: Pick<DocumentSummary, "name" | "folder_id">;
  /** What is moved, for the error line: "file" (default) or "note". */
  itemLabel?: "file" | "note";
  folders: Folder[];
  onMove: (folder: Folder) => Promise<void>;
  onCancel: () => void;
};

// Move dialog on desktop, full-screen sheet on phones. Lists owned folders only; the current one is disabled.
export function MoveSheet({ document, itemLabel = "file", folders, onMove, onCancel }: MoveSheetProps) {
  const targets = moveTargets(folders, document.folder_id);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folder = folders.find((item) => item.id === chosen) ?? null;

  async function confirm() {
    if (!folder) return;
    setBusy(true);
    setError(null);
    try {
      await onMove(folder);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Could not move the ${itemLabel}`);
      setBusy(false);
    }
  }

  return <ModalDialog title={`Move “${document.name}”`} eyebrow="Move to" onClose={onCancel} variant="sheet" busy={busy}>
    <div className="move-list" role="radiogroup" aria-label="Folders">
      {targets.map((target, index) => <button
        key={target.id}
        role="radio"
        aria-checked={chosen === target.id}
        className={`move-option${chosen === target.id ? " active" : ""}`}
        disabled={target.current || busy}
        autoFocus={index === targets.findIndex((item) => !item.current)}
        onClick={() => setChosen(target.id)}
      >
        <FolderIcon aria-hidden="true" />
        <span>{target.name}{target.current && <small>Current folder</small>}</span>
        {chosen === target.id && <Check aria-hidden="true" />}
      </button>)}
      {!targets.length && <p className="file-dialog-copy">You have no folders yet. Create one in the folder list first.</p>}
    </div>
    {error && <p className="file-dialog-error" role="alert">{error}</p>}
    <footer className="file-dialog-actions">
      <button className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
      <button className="primary-button" onClick={() => { void confirm(); }} disabled={!folder || busy}>{busy ? "Moving…" : folder ? `Move to ${folder.name}` : "Move"}</button>
    </footer>
  </ModalDialog>;
}
