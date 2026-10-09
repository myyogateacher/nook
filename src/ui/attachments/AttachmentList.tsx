import { Download, FileX, X } from "lucide-react";
import { contentUrl, formatBytes } from "../../files/filesApi";
import { kindIcon } from "../../files/format";
import type { HostAttachment } from "./uploadForHost";
import "./attachments.css";

/**
 * A host's attachments (D398, D399): a thumbnail for small sniffed images (the original, lazy-loaded,
 * up to 8 MiB; a kind icon otherwise), the name and size, Download, and Remove when the caller may.
 * Files in their owner's Bin show "File removed" until restored (D409, T351). Opening an item is the
 * caller's (usually AttachmentPreview).
 */

export const THUMBNAIL_MAX_BYTES = 8 * 1024 * 1024;
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Whether the list draws the original image as a thumbnail (D399 phase 1). */
export const showsThumbnail = (item: HostAttachment) => !item.removed && item.previewKind === "image" && INLINE_IMAGE_TYPES.has(item.mimeType) && item.sizeBytes <= THUMBNAIL_MAX_BYTES;

export function AttachmentList({ items, onOpen, onRemove, canRemove, label = "Attachments" }: {
  items: readonly HostAttachment[];
  onOpen?: (item: Extract<HostAttachment, { removed: false }>) => void;
  onRemove?: (item: HostAttachment) => void;
  /** Whether Remove shows for an item (the host's own rule); default: never. */
  canRemove?: (item: HostAttachment) => boolean;
  label?: string;
}) {
  if (!items.length) return null;
  return <ul className="attachment-list" aria-label={label}>
    {items.map((item) => {
      if (item.removed) {
        return <li key={item.documentId} className="attachment-item removed">
          <span className="attachment-thumb"><FileX aria-hidden="true" /></span>
          <span className="attachment-copy"><strong>File removed</strong><small>Its owner moved it to the Bin</small></span>
          {onRemove && canRemove?.(item) && <button type="button" className="icon-button" onClick={() => onRemove(item)} aria-label="Remove this attachment"><X /></button>}
        </li>;
      }
      const Icon = kindIcon(item.previewKind);
      const body = <>
        <span className="attachment-thumb">{showsThumbnail(item) ? <img src={contentUrl(item.documentId, "inline")} alt="" loading="lazy" decoding="async" draggable={false} /> : <Icon aria-hidden="true" />}</span>
        <span className="attachment-copy"><strong title={item.name}>{item.name}</strong><small>{formatBytes(item.sizeBytes)}</small></span>
      </>;
      return <li key={item.documentId} className="attachment-item">
        {onOpen ? <button type="button" className="attachment-open" onClick={() => onOpen(item)} aria-label={`Open ${item.name}`} aria-haspopup="dialog">{body}</button> : <span className="attachment-open">{body}</span>}
        <a className="icon-button" href={contentUrl(item.documentId, "attachment")} download aria-label={`Download ${item.name}`}><Download /></a>
        {onRemove && canRemove?.(item) && <button type="button" className="icon-button" onClick={() => onRemove(item)} aria-label={`Remove ${item.name}`}><X /></button>}
      </li>;
    })}
  </ul>;
}
