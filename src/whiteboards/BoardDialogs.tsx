import { useEffect, useId, useState, type FormEvent } from "react";
import { Copy, Download, FileImage, FolderInput, History, ImageDown, ImagePlus, Link2, Link as LinkIcon, PenTool, Pencil, Share2, Trash2, X } from "lucide-react";
import { AccessSheet } from "../access/AccessSheet";
import { notifyBinChanged } from "../bin/binApi";
import { ConfirmDialog, ModalDialog, trapTabKey } from "../files/Dialog";
import { movedMessage, validateRename } from "../files/fileActions";
import { deleteFile, moveFile, renameFile } from "../files/filesApi";
import { MoveSheet } from "../files/MoveSheet";
import { NameDialog } from "../files/RenameDialog";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { Folder } from "../types";
import { whiteboardDisplayName, whiteboardFileName } from "../../shared/whiteboardScene";
import { createWhiteboard, downloadUrl, type WhiteboardSummary } from "./whiteboardsApi";

/**
 * The board sheets and dialogs shared by the list and the canvas (whiteboard plan §10.2–§10.4).
 * Rename, move, share, and delete go through the Files API and the shared Access sheet (D196,
 * Wave 32). Each is one history layer: Back closes it (D18); nothing here is a native dialog (D91).
 */

export type BoardDialog =
  | { kind: "actions"; board: WhiteboardSummary }
  | { kind: "rename"; board: WhiteboardSummary }
  | { kind: "move"; board: WhiteboardSummary }
  | { kind: "share"; board: WhiteboardSummary }
  | { kind: "delete"; board: WhiteboardSummary };

export type BoardAction = "open" | "rename" | "move" | "share" | "delete" | "exportPng";

/** Downloads the board's `.excalidraw` file (the Files content route, always an attachment). */
export function downloadBoard(board: Pick<WhiteboardSummary, "id">) {
  const anchor = document.createElement("a");
  anchor.href = downloadUrl(board.id);
  anchor.download = "";
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

/** Extra ⋯ entries (Wave 24): each is offered only when its handler is given. */
export type BoardExtras = {
  /** The canvas offers PNG export (and SVG where D201 allows). */
  onExportPng?: () => void;
  onExportSvg?: () => void;
  /** The canvas offers the owner the History sheet (D207). */
  onHistory?: () => void;
  /** Anyone who reads and writes gets a private copy. */
  onDuplicate?: (board: WhiteboardSummary) => void;
  /** The link a note turns into an embed card (D208). */
  onCopyLink?: (board: WhiteboardSummary) => void;
  /** The canvas: a picture from Files (D198) and a link on the selected shapes (D199). */
  onInsertImage?: () => void;
  onLinkItem?: () => void;
};

/**
 * The ⋯ sheet: everyone who can read gets Open (on the list), Export PNG (on the canvas), Download
 * .excalidraw (QA Q2), Copy link, and Duplicate (when their role writes); the owner also share,
 * insert a picture, link a shape, History, rename, move, and delete.
 */
export function BoardActionSheet({ board, canEdit, onOpen, onExportPng, onExportSvg, onHistory, onDuplicate, onCopyLink, onInsertImage, onLinkItem, onAction, onClose }: BoardExtras & {
  board: WhiteboardSummary;
  canEdit: boolean;
  /** The list offers Open; the canvas is already open. */
  onOpen?: () => void;
  onAction: (action: Exclude<BoardAction, "open" | "exportPng">) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const name = whiteboardDisplayName(board.name);
  return <>
    <button className="panel-scrim file-sheet-scrim" onClick={onClose} aria-label="Close actions" tabIndex={-1} />
    <div className="file-sheet whiteboard-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={trapTabKey}>
      <header>
        <strong id={titleId} title={name}>{name}</strong>
        <button className="icon-button" onClick={onClose} aria-label="Close actions"><X /></button>
      </header>
      {onOpen && <button onClick={onOpen} autoFocus><PenTool />Open</button>}
      {canEdit && <button onClick={() => onAction("share")} autoFocus={!onOpen}><Share2 />Share</button>}
      {canEdit && onInsertImage && <button onClick={onInsertImage}><ImagePlus />Insert image</button>}
      {canEdit && onLinkItem && <button onClick={onLinkItem}><LinkIcon />Link shape to a Nook item</button>}
      {onExportPng && <button onClick={onExportPng}><ImageDown />Export PNG</button>}
      {onExportSvg && <button onClick={onExportSvg}><FileImage />Export SVG</button>}
      <button onClick={() => { downloadBoard(board); onClose(); }}><Download />Download .excalidraw</button>
      {onCopyLink && <button onClick={() => onCopyLink(board)}><Link2 />Copy link for a note</button>}
      {onDuplicate && <button onClick={() => onDuplicate(board)}><Copy />Duplicate</button>}
      {canEdit && onHistory && <button onClick={onHistory}><History />History</button>}
      {canEdit && <>
        <button onClick={() => onAction("rename")}><Pencil />Rename</button>
        <button onClick={() => onAction("move")}><FolderInput />Move</button>
        <button className="danger" onClick={() => onAction("delete")}><Trash2 />Delete</button>
      </>}
      <button onClick={onClose}>Cancel</button>
    </div>
  </>;
}

/** The owner dialogs for one board. `onChanged` gets the board as the server now has it. */
export function BoardDialogs({ dialog, folders, flash, onClose, onChanged, onDeleted, onAction, onOpen, extras = {} }: {
  dialog: BoardDialog | null;
  folders: Folder[];
  flash: (message: string) => void;
  onClose: () => void;
  onChanged: (patch: Partial<WhiteboardSummary> & { id: string }) => void;
  onDeleted: (board: WhiteboardSummary) => void;
  onAction: (action: Exclude<BoardAction, "open" | "exportPng">, board: WhiteboardSummary) => void;
  onOpen?: (board: WhiteboardSummary) => void;
  /** Entries the ⋯ sheet offers besides the Files actions; each closes the sheet first. */
  extras?: BoardExtras;
}) {
  const [busy, setBusy] = useState(false);
  useHistoryDialogGuard(dialog !== null, onClose, { blocked: busy });
  if (!dialog) return null;
  const { board } = dialog;
  const canEdit = board.canEdit;
  const name = whiteboardDisplayName(board.name);

  if (dialog.kind === "actions") {
    return <BoardActionSheet board={board} canEdit={canEdit} onClose={onClose}
      onOpen={onOpen ? () => onOpen(board) : undefined}
      onExportPng={extras.onExportPng ? () => { onClose(); extras.onExportPng!(); } : undefined}
      onExportSvg={extras.onExportSvg ? () => { onClose(); extras.onExportSvg!(); } : undefined}
      onHistory={extras.onHistory}
      onInsertImage={extras.onInsertImage}
      onLinkItem={extras.onLinkItem}
      onDuplicate={extras.onDuplicate ? (target) => { onClose(); extras.onDuplicate!(target); } : undefined}
      onCopyLink={extras.onCopyLink ? (target) => { onClose(); extras.onCopyLink!(target); } : undefined}
      onAction={(action) => onAction(action, board)} />;
  }
  if (dialog.kind === "rename") {
    return <NameDialog title="Rename whiteboard" eyebrow="Whiteboards" label="Name" initialValue={name} submitLabel="Rename"
      validate={(value) => validateRename(whiteboardFileName(value.trim()), board.name)}
      onCancel={onClose}
      onSubmit={async (next) => {
        const { document } = await renameFile(board.id, next);
        onChanged({ id: board.id, name: document.name, updated_at: document.updated_at });
        onClose();
        flash("Renamed");
      }} />;
  }
  if (dialog.kind === "move") {
    return <MoveSheet document={board} folders={folders} onCancel={onClose} onMove={async (folder) => {
      const { document } = await moveFile(board.id, folder.id);
      onChanged({ id: board.id, folder_id: document.folder_id, visibility: document.visibility, updated_at: document.updated_at });
      onClose();
      flash(movedMessage(folder.name, document.visibility));
    }} />;
  }
  if (dialog.kind === "share") {
    return <AccessSheet kind="document" id={board.id} title={name} onClose={onClose}
      note="People you share with can view; only you can edit. Pictures on the board show only for people who can open those files."
      onSaved={(access) => {
      const visibility = access.audience === "inherit" ? board.visibility : access.audience === "private" ? "private" : access.audience;
      onChanged({ id: board.id, visibility });
      onClose();
      // QA Q7: say who can see it now.
      flash(visibility === "private" ? "Access updated. Only you can open this whiteboard." : "Access updated. People you share with can view; only you can edit.");
    }} />;
  }
  return <ConfirmDialog title="Move to the Bin?" message={`Move “${name}” to the Bin? You can restore it for 30 days.`} confirmLabel="Move to Bin" danger busy={busy} onCancel={onClose} onConfirm={async () => {
    setBusy(true);
    try {
      await deleteFile(board.id);
      notifyBinChanged();
      onClose();
      onDeleted(board);
      flash(`Moved “${name}” to the Bin`);
    } catch (reason) {
      flash(messageOf(reason, "Could not move the whiteboard to the Bin"));
    } finally {
      setBusy(false);
    }
  }} />;
}

/** New whiteboard: a name and one of the caller's own folders (Default first). */
export function NewBoardDialog({ folders, initialFolderId, onCreated, onCancel }: {
  folders: Folder[];
  initialFolderId: string | null;
  onCreated: (board: WhiteboardSummary) => void;
  onCancel: () => void;
}) {
  const owned = folders.filter((folder) => folder.is_owner === 1).sort((a, b) => b.is_default - a.is_default || a.name.localeCompare(b.name));
  const [name, setName] = useState("");
  const [folderId, setFolderId] = useState<string | null>(owned.find((folder) => folder.id === initialFolderId)?.id ?? owned[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const nameId = useId();
  const folderLabelId = useId();
  useHistoryDialogGuard(true, onCancel, { blocked: busy });

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { whiteboard } = await createWhiteboard(trimmed, folderId, idempotencyKey);
      onCreated(whiteboard);
    } catch (reason) {
      setError(messageOf(reason, "Could not create the whiteboard"));
      setBusy(false);
    }
  }

  return <ModalDialog title="New whiteboard" eyebrow="Whiteboards" onClose={onCancel} busy={busy}>
    <form className="file-dialog-form whiteboard-new-form" onSubmit={submit}>
      <label htmlFor={nameId}>Name</label>
      <input id={nameId} value={name} maxLength={200} autoFocus autoComplete="off" placeholder="Floor plan" onChange={(event) => { setName(event.target.value); setError(null); }} aria-invalid={error ? true : undefined} />
      <span id={folderLabelId} className="whiteboard-field-label">Folder</span>
      <Select labelledBy={folderLabelId} value={folderId} onChange={setFolderId} options={owned.map((folder) => ({ value: folder.id, label: folder.name }))} disabled={busy} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
      </footer>
    </form>
  </ModalDialog>;
}
