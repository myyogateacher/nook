import type { Notifier } from "../ui/notify";
import { useCallback, useEffect, useRef, useState } from "react";
import { Paperclip, Upload } from "lucide-react";
import { contentUrl } from "../files/filesApi";
import { AttachmentList, AttachmentPreview, AttachSheet, listHostAttachments, LocationStripError, notifyRemoved, relinkToHost, showsThumbnail, unlinkFromHost, uploadForHost, useFileDrop, usePasteFiles, type HostAttachment } from "../ui/attachments";
import type { DocumentSummary } from "../types";
import { attachDocument, detachDocument, errorCode, errorMessage, getRow, ROW_FILE_LIMIT, type Attachment, type CollectionRow, type FieldDefinition } from "./collectionsApi";
import { useEscapeHold } from "./dialogLayers";

type AttachmentsProps = {
  row: CollectionRow;
  field: FieldDefinition;
  editable: boolean;
  onChanged: (row: CollectionRow) => void;
  notify: Notifier;
};

/** A row's file as the attach kit lists it (D398). Rows only list live files, so none is `removed`. */
export function toHostAttachment(file: Attachment, fieldId: string): HostAttachment {
  return { documentId: file.id, removed: false, name: file.name, mimeType: file.mime_type, previewKind: file.preview_kind, sizeBytes: file.size_bytes, partId: fieldId, position: 0, linkedAt: "", isOwner: false, inAttachmentsFolder: false };
}

/** The first file of `field` the kit draws as a thumbnail (a sniffed PNG, JPEG, GIF, or WebP up to 8 MiB, D399), or null. */
export function firstImage(row: Pick<CollectionRow, "files">, field: FieldDefinition) {
  return (row.files?.[field.id] ?? []).find((file) => showsThumbnail(toHostAttachment(file, field.id))) ?? null;
}

/** A small square of the original image (lazy, decoded off the main thread), for table cells and phone cards. */
export function FileThumb({ file, className = "file-thumb" }: { file: Attachment; className?: string }) {
  return <span className={className} aria-hidden="true"><img src={contentUrl(file.id, "inline")} alt="" loading="lazy" decoding="async" draggable={false} /></span>;
}

type Upload = { key: string; name: string; fraction: number };

/**
 * A file field in the row panel (uploads everywhere U3, G7). Readers see the files with thumbnails and
 * open them in the preview sheet (Back closes it). Editors attach through the shared attach sheet
 * (Take photo on phones, Choose files, From Files with its confirm, D396), or by dropping or pasting
 * files onto the field. Uploads go to the uploader's Files › Attachments (`?attachTo=row`) with JPEG
 * location removed (Q9); a row holds up to 20 files across its file fields. Removing the last link to
 * an upload moves it to the uploader's Bin; a file picked from Files stays where it is.
 */
export function Attachments({ row, field, editable, onChanged, notify }: AttachmentsProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [preview, setPreview] = useState<{ id: string; name: string } | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [removed, setRemoved] = useState<HostAttachment[]>([]);
  // The caller's own files on this row: their owner may always take them off (U0 review M1), even
  // without edit access to the collection.
  const [owned, setOwned] = useState<ReadonlySet<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef(row);
  rowRef.current = row;
  const inFlight = useRef(0);
  useEscapeHold(sheetOpen || preview !== null);

  const files = row.files?.[field.id] ?? [];
  const rowTotal = Object.values(row.files ?? {}).reduce((sum, list) => sum + list.length, 0);
  const full = rowTotal + uploads.length >= ROW_FILE_LIMIT;

  // Files their owner moved to the Bin are not in the row's own list; the generic list names them
  // "File removed" until a restore (D409, T351). Read once per row revision.
  useEffect(() => {
    let live = true;
    listHostAttachments("row", row.id)
      .then((result) => {
        if (!live) return;
        setRemoved(result.attachments.filter((item) => item.removed && item.partId === field.id));
        setOwned(new Set(result.attachments.filter((item) => !item.removed && item.isOwner).map((item) => item.documentId)));
      })
      .catch(() => { if (live) { setRemoved([]); setOwned(new Set()); } });
    return () => { live = false; };
  }, [row.id, row.revision, field.id]);

  const attachFiles = useCallback(async (chosen: File[]) => {
    if (!editable || !chosen.length) return;
    const current = rowRef.current;
    const used = Object.values(current.files ?? {}).reduce((sum, list) => sum + list.length, 0) + inFlight.current;
    const room = Math.max(0, ROW_FILE_LIMIT - used);
    const taken = chosen.slice(0, room);
    if (taken.length < chosen.length) notify.warning(`A row can have up to ${ROW_FILE_LIMIT} files. ${chosen.length - taken.length === 1 ? "1 file was" : `${chosen.length - taken.length} files were`} not attached.`);
    if (!taken.length) return;
    const queued = taken.map((file) => ({ file, key: crypto.randomUUID() }));
    inFlight.current += queued.length;
    setUploads((items) => [...items, ...queued.map(({ file, key }) => ({ key, name: file.name, fraction: 0 }))]);
    let failed = false;
    for (const { file, key } of queued) {
      try {
        const { document } = await uploadForHost(file, "row", {
          idempotencyKey: key,
          onProgress: (loaded, total) => setUploads((items) => items.map((item) => item.key === key ? { ...item, fraction: total ? loaded / total : 0 } : item))
        });
        const { row: saved } = await attachDocument(rowRef.current.id, document.id, field.id);
        onChanged(saved);
      } catch (reason) {
        failed = true;
        notify.error(reason instanceof LocationStripError
          ? `${file.name} was not uploaded: Nook could not remove the photo's location. Try a screenshot or an exported copy of it.`
          : errorMessage(reason, `Could not attach ${file.name}`));
      } finally {
        inFlight.current -= 1;
        setUploads((items) => items.filter((item) => item.key !== key));
      }
    }
    if (!failed && inFlight.current === 0) setSheetOpen(false);
  }, [editable, field.id, notify, onChanged]);

  async function attachExisting(document: DocumentSummary, options: { confirmed: boolean }) {
    try {
      const { row: saved } = await attachDocument(rowRef.current.id, document.id, field.id, options);
      onChanged(saved);
      setSheetOpen(false);
      notify.success(`Attached ${document.name}`);
    } catch (reason) {
      const code = errorCode(reason);
      notify.error(code === "ALREADY_ATTACHED" ? `${document.name} is already on this row` : errorMessage(reason, `Could not attach ${document.name}`));
    }
  }

  async function remove(item: HostAttachment) {
    const name = item.removed ? "the removed file" : item.name;
    try {
      if (!editable) {
        // A viewer taking their own file off: the generic route (no row revision, nothing to undo).
        const result = await unlinkFromHost("row", rowRef.current.id, item.documentId);
        const { row: fresh } = await getRow(rowRef.current.id);
        onChanged(fresh);
        notify.success(result.documentBinned ? `Removed ${name}. It is in your Bin for 30 days.` : `Removed ${name}`);
        return;
      }
      const rowId = rowRef.current.id;
      const result = await detachDocument(rowId, item.documentId);
      onChanged(result.row);
      // Undo puts it back in this field, and out of the Bin when the removal put it there (the file's
      // owner only: a file in someone else's Bin only they can restore).
      const undoable = !item.removed && (!result.documentBinned || owned.has(item.documentId));
      notifyRemoved(result.documentBinned ? `Removed ${name}. It is in ${owned.has(item.documentId) ? "your" : "its owner's"} Bin for 30 days.` : `Removed ${name}`,
        undoable ? async () => {
          await relinkToHost("row", rowId, item.documentId, { partId: field.id });
          const { row: fresh } = await getRow(rowId);
          if (rowRef.current.id === rowId) onChanged(fresh);
        } : null, notify);
    } catch (reason) {
      notify.error(errorMessage(reason, "Could not remove the file"));
    }
  }

  const { dragging, bind } = useFileDrop((dropped) => { void attachFiles(dropped); }, { enabled: editable });
  usePasteFiles(rootRef, (pasted) => { void attachFiles(pasted); }, { enabled: editable });

  const items = [...files.map((file) => toHostAttachment(file, field.id)), ...removed];
  const progress = uploads.length > 0 && <ul className="row-attachment-progress" aria-label="Uploading">
    {uploads.map((upload) => <li key={upload.key}>
      <Upload aria-hidden="true" />
      <span className="row-attachment-progress-name">{upload.name}</span>
      <span className="row-attachment-progress-value" role="progressbar" aria-label={`Uploading ${upload.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(upload.fraction * 100)}>{Math.round(upload.fraction * 100)}%</span>
    </li>)}
  </ul>;

  return <div ref={rootRef} className={`row-attachments${dragging ? " dragging" : ""}`} role="group" aria-label={`${field.name} files`} {...(editable ? bind : {})}>
    <AttachmentList items={items} label={`${field.name} files`} onOpen={(item) => setPreview({ id: item.documentId, name: item.name })}
      onRemove={(item) => { void remove(item); }} canRemove={(item) => editable || owned.has(item.documentId)} />
    {!items.length && !editable && <span className="cell-empty">No files</span>}
    {!sheetOpen && progress}
    {editable && <>
      <button type="button" className="secondary-button row-attachment-add" onClick={() => setSheetOpen(true)} aria-haspopup="dialog" disabled={full && !uploads.length}>
        <Paperclip />{full ? `${ROW_FILE_LIMIT} files per row` : "Attach files"}
      </button>
      <span className="row-attachment-hint">{dragging ? "Drop to attach" : "Or drop or paste files here"}</span>
    </>}
    {sheetOpen && <AttachSheet hostNoun="row" onClose={() => setSheetOpen(false)} onFiles={(chosen) => { void attachFiles(chosen); }}
      onPickDocument={(document, options) => { void attachExisting(document, options); }}
      disabledReason={full ? `A row can have up to ${ROW_FILE_LIMIT} files. Remove one to attach another.` : null}>
      {progress || null}
    </AttachSheet>}
    {preview && <AttachmentPreview documentId={preview.id} name={preview.name} onClose={() => setPreview(null)} />}
  </div>;
}
