import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Camera, FileText, FolderOpen, Paperclip, Search } from "lucide-react";
import { api } from "../../api";
import { ModalDialog } from "../../files/Dialog";
import { formatBytes } from "../../files/filesApi";
import type { DocumentSummary, Folder } from "../../types";
import { useConfirm } from "../useConfirm";
import { useHistoryDialogGuard } from "../useHistoryDialogGuard";
import "../pickerSheet.css";
import "./attachments.css";

/**
 * The one attach sheet every module uses (uploads everywhere plan D398, §4.3). A bottom sheet at
 * ≤ 760 px and a dialog on desktop (ModalDialog), one history layer: Back closes it and Forward does
 * not reopen it (D18, D21). It offers:
 *
 * - **Take photo** on touch phones (`accept="image/*" capture="environment"`, the system camera);
 * - **Choose files** (the system picker, several at once);
 * - **From Files**, a picker of the caller's OWN Files items (D396): picking one outside the
 *   Attachments folder asks first, in the app's confirm dialog, because the host's audience will be
 *   able to open it (Q2, T341).
 *
 * The sheet hands back files or a document; the caller uploads with `uploadForHost` and links. Pass
 * a progress row as `children`: it stays at the bottom of the sheet.
 */

export type AttachSheetProps = {
  /** What the files go on, in words ("event", "card"), for the title and the From Files confirm. */
  hostNoun: string;
  onClose: () => void;
  /** Files from Take photo or Choose files. */
  onFiles: (files: File[]) => void;
  /** A Files document from From Files; omit to hide From Files. `confirmed` is what linkToHost sends. */
  onPickDocument?: (document: DocumentSummary, options: { confirmed: boolean }) => void;
  /** The Choose files `accept` list (default: any file). */
  accept?: string;
  multiple?: boolean;
  /** "auto" (default) shows Take photo only with a coarse pointer (a phone or tablet). */
  camera?: boolean | "auto";
  /** Why nothing can be added now (a cap reached); the buttons are disabled and this is shown. */
  disabledReason?: string | null;
  /** Close the sheet once files are chosen (default false: the caller shows progress inside it). */
  closeOnPick?: boolean;
  children?: ReactNode;
};

/** Whether this device has a coarse pointer (touch), where Take photo is offered. */
export function coarsePointer() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

export const CAMERA_ACCEPT = "image/*";
export const CAMERA_CAPTURE = "environment";

export function AttachSheet({ hostNoun, onClose, onFiles, onPickDocument, accept, multiple = true, camera = "auto", disabledReason = null, closeOnPick = false, children }: AttachSheetProps) {
  const [picking, setPicking] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const showCamera = camera === "auto" ? coarsePointer() : camera;
  const disabled = Boolean(disabledReason);
  useHistoryDialogGuard(true, onClose);

  const take = (input: HTMLInputElement) => {
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (!files.length) return;
    onFiles(files);
    if (closeOnPick) onClose();
  };

  // While From Files is open the sheet steps aside (one dialog at a time, so Escape and Back reach
  // the picker first); its history guard stays registered underneath, so Back then closes the sheet.
  return <>
    {!picking && <ModalDialog title={`Attach to this ${hostNoun}`} eyebrow="Attach" onClose={onClose} className="attach-sheet">
      <div className="attach-sheet-actions" role="group" aria-label="Add files">
        {showCamera && <button type="button" className="action-button secondary attach-sheet-action" disabled={disabled} onClick={() => cameraInput.current?.click()}><Camera aria-hidden="true" />Take photo</button>}
        <button type="button" className="action-button secondary attach-sheet-action" disabled={disabled} onClick={() => filesInput.current?.click()}><Paperclip aria-hidden="true" />Choose files</button>
        {onPickDocument && <button type="button" className="action-button secondary attach-sheet-action" disabled={disabled} aria-haspopup="dialog" onClick={() => setPicking(true)}><FolderOpen aria-hidden="true" />From Files</button>}
      </div>
      {/* The system camera and file chooser; the visible controls above are the app's own (D91). */}
      {showCamera && <input ref={cameraInput} className="attach-sheet-input" type="file" accept={CAMERA_ACCEPT} capture={CAMERA_CAPTURE} tabIndex={-1} aria-hidden="true" data-attach-input="camera" onChange={(event) => take(event.currentTarget)} />}
      <input ref={filesInput} className="attach-sheet-input" type="file" accept={accept} multiple={multiple} tabIndex={-1} aria-hidden="true" data-attach-input="files" onChange={(event) => take(event.currentTarget)} />
      {disabledReason ? <p className="attach-sheet-note" role="status">{disabledReason}</p> : <p className="attach-sheet-note">Photo locations are removed from JPEG, PNG, and WebP pictures before upload (not from HEIC). Files are kept in Files › Attachments and count toward your storage.</p>}
      {children && <div className="attach-sheet-progress">{children}</div>}
    </ModalDialog>}
    {picking && onPickDocument && <FromFilesSheet hostNoun={hostNoun} onClose={() => setPicking(false)} onPick={(document, options) => {
      setPicking(false);
      onPickDocument(document, options);
      if (closeOnPick) onClose();
    }} />}
  </>;
}

/** The From Files message (D396); exported for tests and for modules that confirm elsewhere. */
export const fromFilesConfirm = (hostNoun: string, name: string) => ({
  title: "Attach a file from Files?",
  message: `People who can open this ${hostNoun} will be able to open “${name}”. It stays in its folder in Files.`,
  confirmLabel: "Attach"
});

/**
 * The caller's own Files items (never other people's: D396, T341), searchable, newest first. A pick
 * outside the Attachments folder is confirmed first; Back closes the confirm, then this picker.
 */
export function FromFilesSheet({ hostNoun, onClose, onPick }: { hostNoun: string; onClose: () => void; onPick: (document: DocumentSummary, options: { confirmed: boolean }) => void }) {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  // The system folder's real name: "Attachments", or "Attachments (Nook)" beside a folder of that name.
  const [attachmentsFolder, setAttachmentsFolder] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchId = useId();
  const { ask, confirmOpen, confirmElement } = useConfirm();
  useHistoryDialogGuard(true, onClose, { blocked: confirmOpen });

  useEffect(() => {
    let live = true;
    Promise.all([api<{ documents: DocumentSummary[] }>("/files"), api<{ folders: Array<Folder & { system_kind?: string | null }> }>("/folders?include=system")])
      .then(([files, folders]) => {
        if (!live) return;
        setDocuments(files.documents.filter((document) => document.is_owner === 1 && document.kind !== "whiteboard"));
        const folder = folders.folders.find((item) => item.is_owner === 1 && item.system_kind === "attachments");
        setAttachmentsFolder(folder ? { id: folder.id, name: folder.name } : null);
      })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : "Could not load your files"); });
    return () => { live = false; };
  }, []);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => (documents ?? []).filter((document) => !needle || document.name.toLowerCase().includes(needle)).slice(0, 150), [documents, needle]);

  async function choose(document: DocumentSummary, trigger: HTMLElement) {
    if (attachmentsFolder !== null && document.folder_id === attachmentsFolder.id) {
      onPick(document, { confirmed: false });
      return;
    }
    if (await ask({ ...fromFilesConfirm(hostNoun, document.name), opener: trigger })) onPick(document, { confirmed: true });
  }

  return <>
    {/* `busy` while the confirm is up: Escape and the close button belong to the confirm then. */}
    <ModalDialog title="Attach from Files" eyebrow="Your files" onClose={onClose} variant="sheet" className="nook-picker attach-from-files" busy={confirmOpen}>
      <label className="nook-picker-search" htmlFor={searchId}>
        <Search aria-hidden="true" />
        <input id={searchId} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your files" autoComplete="off" spellCheck={false} enterKeyHint="search" />
      </label>
      <div className="nook-picker-actions"><p className="nook-picker-hint">Only files you own are listed. People who can open this {hostNoun} will be able to open the file you pick.</p></div>
      <div className="nook-picker-body">
        {error && <p className="form-error" role="alert">{error}</p>}
        {!error && !documents && <p className="nook-picker-empty" role="status">Loading your files…</p>}
        {documents && visible.length === 0 && <p className="nook-picker-empty">{documents.length ? "No files match." : "You have no files in Files yet."}</p>}
        {visible.length > 0 && <ul className="nook-picker-list" aria-label="Your files">
          {visible.map((document) => <li key={document.id}>
            <button type="button" onClick={(event) => void choose(document, event.currentTarget)}>
              <FileText aria-hidden="true" />
              <span><strong>{document.name}</strong><small>{formatBytes(document.size_bytes)}{attachmentsFolder !== null && document.folder_id === attachmentsFolder.id ? ` · ${attachmentsFolder.name}` : ""}</small></span>
            </button>
          </li>)}
        </ul>}
      </div>
    </ModalDialog>
    {confirmElement}
  </>;
}
