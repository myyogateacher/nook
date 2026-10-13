import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { ModalDialog } from "../../files/Dialog";
import { PreviewBody } from "../../files/FilePreview";
import { contentUrl, getFile } from "../../files/filesApi";
import type { DocumentSummary } from "../../types";
import { useHistoryDialogGuard } from "../useHistoryDialogGuard";
import "./attachments.css";
import { FormError } from "../FormError";

/**
 * Opens one attachment in a sheet instead of a new tab (D398, §4.3): the Files preview stage (image,
 * PDF, text, audio, video) through the same content route and CSP, plus Download. One history layer:
 * Back closes it. The document is read as the viewer, so an attachment they lost access to says so.
 */
export function AttachmentPreview({ documentId, name, onClose }: { documentId: string; name: string; onClose: () => void }) {
  const [document, setDocument] = useState<DocumentSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useHistoryDialogGuard(true, onClose);
  useEffect(() => {
    let live = true;
    getFile(documentId)
      .then((result) => { if (live) setDocument(result.document); })
      .catch(() => { if (live) setError("This file is no longer available to you."); });
    return () => { live = false; };
  }, [documentId]);

  return <ModalDialog title={document?.name ?? name} eyebrow="Attachment" onClose={onClose} variant="sheet" className="attachment-preview">
    <div className="attachment-preview-actions">
      <a className="action-button secondary" href={contentUrl(documentId, "attachment")} download><Download aria-hidden="true" />Download</a>
    </div>
    <div className="attachment-preview-body">
      <FormError message={error} />
      {!error && !document && <p className="nook-picker-empty" role="status">Loading…</p>}
      {document && <PreviewBody key={document.id} document={document} />}
    </div>
  </ModalDialog>;
}
