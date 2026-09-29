import { useEffect, useState } from "react";
import { ChevronLeft, Download, Ellipsis, ExternalLink, FolderInput, PenTool, Pencil, Share2, Trash2, X } from "lucide-react";
import type { DocumentSummary } from "../types";
import { contentUrl, fetchTextPreview, formatBytes, TEXT_PREVIEW_BYTES } from "./filesApi";
import { documentIcon, formatDateTime, kindIcon, kindLabel, visibilityLabels } from "./format";

type TextState = { id: string; status: "loading" | "ready" | "error"; text: string };

function TextPreview({ document }: { document: DocumentSummary }) {
  const [state, setState] = useState<TextState>({ id: document.id, status: "loading", text: "" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ id: document.id, status: "loading", text: "" });
    fetchTextPreview(document.id, controller.signal)
      .then((text) => setState({ id: document.id, status: "ready", text }))
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setState({ id: document.id, status: "error", text: reason instanceof Error ? reason.message : "Could not load the preview" });
      });
    return () => controller.abort();
  }, [document.id, document.updated_at]);

  if (state.id !== document.id || state.status === "loading") return <p className="file-preview-note">Loading preview…</p>;
  if (state.status === "error") return <p className="file-preview-note" role="alert">{state.text}</p>;
  return <>
    {document.size_bytes > TEXT_PREVIEW_BYTES && <p className="file-preview-note">Showing the first {formatBytes(TEXT_PREVIEW_BYTES)} of {formatBytes(document.size_bytes)}. Download the file to see all of it.</p>}
    <pre className="file-text-preview" tabIndex={0} aria-label={`Contents of ${document.name}`}>{state.text}</pre>
  </>;
}

function PreviewBody({ document }: { document: DocumentSummary }) {
  const inline = contentUrl(document.id, "inline");
  const Icon = kindIcon(document.preview_kind);
  switch (document.preview_kind) {
    case "image":
      return <div className="file-media"><img src={inline} alt={document.name} loading="lazy" /></div>;
    case "pdf":
      return <div className="file-preview-placeholder"><span className="file-preview-icon"><Icon /></span><p>PDFs open in the browser's own viewer.</p><a className="secondary-button file-action" href={inline} target="_blank" rel="noopener noreferrer"><ExternalLink />Open preview</a></div>;
    case "text":
      return <TextPreview document={document} />;
    case "audio":
      return <div className="file-media"><audio controls preload="metadata" src={inline} aria-label={document.name} /></div>;
    case "video":
      return <div className="file-media"><video controls preload="metadata" playsInline src={inline} aria-label={document.name} /></div>;
    default:
      return <div className="file-preview-placeholder"><span className="file-preview-icon"><Icon /></span><p>No preview is available for this type of file. Download it to open it.</p></div>;
  }
}

export type FilePreviewActions = { rename: () => void; move: () => void; share: () => void; remove: () => void };

type FilePreviewProps = {
  document: DocumentSummary;
  folderName: string;
  onBack: () => void;
  /** Desktop only: closes the preview pane and deselects the file. */
  onClose?: () => void;
  /** Owner-only actions; null for files other people shared, which get Download (and Open preview) only. */
  actions?: FilePreviewActions | null;
  /** Opens the phone action sheet. */
  onMore?: (trigger: HTMLElement) => void;
  /** A whiteboard while the module is on (Wave 23): opens its canvas. */
  onOpenWhiteboard?: () => void;
};

export function FilePreview({ document, folderName, onBack, onClose, actions = null, onMore, onOpenWhiteboard }: FilePreviewProps) {
  const Icon = documentIcon(document);
  return <>
    <header className="editor-toolbar file-preview-toolbar">
      <div className="mobile-editor-nav"><button className="icon-button" onClick={onBack} aria-label="Back to files"><ChevronLeft /></button></div>
      <span className="file-preview-kind"><Icon aria-hidden="true" /></span>
      <h2 className="file-preview-title" title={document.name}>{document.name}</h2>
      <a className="secondary-button file-action file-download" href={contentUrl(document.id, "attachment")} download aria-label={`Download ${document.name}`}><Download /><span>Download</span></a>
      {actions && <div className="file-owner-actions" role="group" aria-label="File actions">
        <button className="secondary-button file-action" onClick={actions.rename} aria-label={`Rename ${document.name}`} aria-keyshortcuts="F2" title="Rename (F2)"><Pencil /><span>Rename</span></button>
        <button className="secondary-button file-action" onClick={actions.move} aria-label={`Move ${document.name}`} title="Move"><FolderInput /><span>Move</span></button>
        <button className="secondary-button file-action" onClick={actions.share} aria-label={`Share ${document.name}`} title="Share"><Share2 /><span>Share</span></button>
        <button className="secondary-button file-action danger" onClick={actions.remove} aria-label={`Delete ${document.name}`} aria-keyshortcuts="Delete" title="Delete"><Trash2 /><span>Delete</span></button>
      </div>}
      {onMore && <button className="icon-button file-preview-more" onClick={(event) => onMore(event.currentTarget)} aria-haspopup="dialog" aria-label={`Actions for ${document.name}`}><Ellipsis /></button>}
      {onClose && <button className="icon-button desktop-only file-preview-close" onClick={onClose} aria-label="Close preview" aria-keyshortcuts="Escape" title="Close (Esc)"><X /></button>}
    </header>
    <div className="file-preview-body">
      <section className="file-preview-stage" aria-label="Preview">{document.kind === "whiteboard"
        ? <div className="file-preview-placeholder"><span className="file-preview-icon"><PenTool /></span><p>{onOpenWhiteboard ? "A whiteboard. Open it to draw, or download the .excalidraw file." : "A whiteboard. Download the .excalidraw file, or turn on Whiteboards in Settings → Modules to open it here."}</p>{onOpenWhiteboard && <button className="primary-button file-action" onClick={onOpenWhiteboard}><PenTool />Open whiteboard</button>}</div>
        : <PreviewBody key={document.id} document={document} />}</section>
      <dl className="file-details" aria-label="Details">
        <div><dt>Type</dt><dd>{kindLabel(document.preview_kind)} · <code>{document.mime_type}</code></dd></div>
        <div><dt>Size</dt><dd>{formatBytes(document.size_bytes)}</dd></div>
        <div><dt>Uploaded</dt><dd>{formatDateTime(document.created_at)}</dd></div>
        <div><dt>Modified</dt><dd>{formatDateTime(document.updated_at)}</dd></div>
        <div><dt>Owner</dt><dd>{document.is_owner === 1 ? "You" : document.owner_name}</dd></div>
        <div><dt>Folder</dt><dd>{folderName}</dd></div>
        <div><dt>Access</dt><dd>{visibilityLabels[document.visibility]}</dd></div>
      </dl>
    </div>
  </>;
}
