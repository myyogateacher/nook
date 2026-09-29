import { useEffect, useId } from "react";
import { Download, ExternalLink, FolderInput, PenTool, Pencil, Share2, Trash2, X } from "lucide-react";
import type { DocumentSummary } from "../types";
import { canManage } from "./fileActions";
import { contentUrl } from "./filesApi";
import { trapTabKey } from "./Dialog";
import { useRole } from "../team/roleAccess";

export type FileSheetAction = "rename" | "move" | "share" | "delete";

type FileActionSheetProps = {
  document: DocumentSummary;
  onAction: (action: FileSheetAction) => void;
  onClose: () => void;
  /** A whiteboard while the module is on (Wave 23): opens its canvas. */
  onOpenWhiteboard?: () => void;
};

// Phone action sheet (⋯ on a row or in the preview header). Like the Bin sheet it has no history
// entry: Escape, the scrim, or browser Back close it.
export function FileActionSheet({ document, onAction, onClose, onOpenWhiteboard }: FileActionSheetProps) {
  const titleId = useId();
  const owner = useRole().canWrite && canManage(document);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return <>
    <button className="panel-scrim file-sheet-scrim" onClick={onClose} aria-label="Close actions" tabIndex={-1} />
    <div className="file-sheet" role="dialog" aria-modal="true" aria-label={`Actions for ${document.name}`} onKeyDown={trapTabKey}>
      <header>
        <strong id={titleId} title={document.name}>{document.name}</strong>
        <button className="icon-button" onClick={onClose} aria-label="Close actions"><X /></button>
      </header>
      {onOpenWhiteboard && <button onClick={onOpenWhiteboard} autoFocus><PenTool />Open whiteboard</button>}
      <a href={contentUrl(document.id, "attachment")} download onClick={onClose} autoFocus={!onOpenWhiteboard}><Download />Download</a>
      {document.preview_kind === "pdf" && <a href={contentUrl(document.id, "inline")} target="_blank" rel="noopener noreferrer" onClick={onClose}><ExternalLink />Open preview</a>}
      {owner && <>
        <button onClick={() => onAction("rename")}><Pencil />Rename</button>
        <button onClick={() => onAction("move")}><FolderInput />Move</button>
        <button onClick={() => onAction("share")}><Share2 />Share</button>
        <button className="danger" onClick={() => onAction("delete")}><Trash2 />Delete</button>
      </>}
      <button onClick={onClose}>Cancel</button>
    </div>
  </>;
}
