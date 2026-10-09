import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Image as ImageIcon, ImageOff, X } from "lucide-react";
import { contentUrl } from "../files/filesApi";
import type { DocumentSummary } from "../types";
import { uploadForHost } from "../ui/attachments";
import { CHAT_IMAGE_BOUNDS, isChatImageType, type ChatAttachment, type ChatAttachmentInput } from "../../shared/agents";
import { downscaleImage, imageTooLargeMessage, NOT_AN_IMAGE_MESSAGE, thumbnailDataUrl, triageImageFiles, visionMissingMessage, IMAGES_FULL_MESSAGE } from "./chatImageFiles";

/**
 * The chat composer's images (uploads everywhere U5): files from the attach sheet (Take photo, Choose
 * files), From Files, paste, or drop. Each is downscaled in the browser when large, uploaded at once
 * into the person's Attachments folder (`?attachTo=chat_message`, the kit's upload with progress and
 * abort), and shown as a thumbnail with Remove until the message is sent with their ids. At most 5.
 * An upload removed before sending stays unlinked; the hourly sweep moves it to the Bin after a day.
 */

export type PendingImage = {
  key: string; name: string; status: "uploading" | "ready" | "failed"; progress: number; documentId: string | null;
  /** A `data:` preview while uploading, then the stored file (the CSP allows no `blob:` images); empty until drawn. */
  previewUrl: string; confirmed: boolean; error: string | null;
};

type Options = { vision: boolean; agentName: string | null; flash: (message: string) => void };

export function useComposerImages({ vision, agentName, flash }: Options) {
  const [items, setItems] = useState<PendingImage[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const controllers = useRef(new Map<string, AbortController>());

  const patch = useCallback((key: string, change: Partial<PendingImage>) => setItems((list) => list.map((item) => item.key === key ? { ...item, ...change } : item)), []);
  const release = (key: string) => {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
  };

  const upload = useCallback(async (key: string, file: File) => {
    const controller = new AbortController();
    controllers.current.set(key, controller);
    void thumbnailDataUrl(file).then((url) => { if (url) setItems((list) => list.map((item) => item.key === key && item.status === "uploading" ? { ...item, previewUrl: url } : item)); });
    try {
      const prepared = await downscaleImage(file);
      if (controller.signal.aborted) return;
      if (prepared.size > CHAT_IMAGE_BOUNDS.bytes) {
        patch(key, { status: "failed", error: imageTooLargeMessage(file.name) });
        return;
      }
      const result = await uploadForHost(prepared, "chat_message", { signal: controller.signal, onProgress: (loaded, total) => patch(key, { progress: total ? loaded / total : 0 }) });
      if (controller.signal.aborted) return;
      if (!isChatImageType(result.document.mime_type)) {
        patch(key, { status: "failed", error: NOT_AN_IMAGE_MESSAGE });
        return;
      }
      patch(key, { status: "ready", progress: 1, documentId: result.document.id, previewUrl: contentUrl(result.document.id, "inline") });
    } catch (reason) {
      if (controller.signal.aborted || (reason instanceof DOMException && reason.name === "AbortError")) return;
      patch(key, { status: "failed", error: reason instanceof Error && reason.message ? reason.message : "The upload failed" });
    } finally {
      controllers.current.delete(key);
    }
  }, [patch]);

  /** Files from the sheet, a paste, or a drop: the refused ones are explained once. */
  const addFiles = useCallback((files: File[]) => {
    const { accepted, refusal } = triageImageFiles(files, itemsRef.current.length, vision, agentName);
    if (refusal) flash(refusal);
    if (!accepted.length) return;
    const added = accepted.map((file): [PendingImage, File] => {
      const key = crypto.randomUUID();
      return [{ key, name: file.name || "Pasted image", status: "uploading", progress: 0, documentId: null, previewUrl: "", confirmed: false, error: null }, file];
    });
    setItems((list) => [...list, ...added.map(([item]) => item)]);
    for (const [item, file] of added) void upload(item.key, file);
  }, [agentName, flash, upload, vision]);

  /** A Files document from From Files (the kit asked the confirm when it is outside Attachments). */
  const addDocument = useCallback((document: DocumentSummary, options: { confirmed: boolean }) => {
    if (!vision) { flash(visionMissingMessage(agentName)); return; }
    if (!isChatImageType(document.mime_type) || document.preview_kind !== "image") { flash(NOT_AN_IMAGE_MESSAGE); return; }
    if (document.size_bytes > CHAT_IMAGE_BOUNDS.bytes) { flash(imageTooLargeMessage(document.name)); return; }
    if (itemsRef.current.some((item) => item.documentId === document.id)) return;
    if (itemsRef.current.length >= CHAT_IMAGE_BOUNDS.perMessage) { flash(IMAGES_FULL_MESSAGE); return; }
    setItems((list) => [...list, { key: crypto.randomUUID(), name: document.name, status: "ready", progress: 1, documentId: document.id, previewUrl: contentUrl(document.id, "inline"), confirmed: options.confirmed, error: null }]);
  }, [agentName, flash, vision]);

  const remove = useCallback((key: string) => {
    release(key);
    setItems((list) => list.filter((item) => item.key !== key));
  }, []);
  const clear = useCallback(() => {
    for (const item of itemsRef.current) release(item.key);
    setItems([]);
  }, []);
  // Leaving the page stops the uploads.
  useEffect(() => () => { for (const key of [...controllers.current.keys()]) release(key); }, []);

  const uploading = items.some((item) => item.status === "uploading");
  const failed = items.some((item) => item.status === "failed");
  const attachments: ChatAttachmentInput[] = items.flatMap((item) => item.status === "ready" && item.documentId ? [{ documentId: item.documentId, ...(item.confirmed ? { confirmed: true } : {}) }] : []);
  return { items, addFiles, addDocument, remove, clear, uploading, failed, attachments, full: items.length >= CHAT_IMAGE_BOUNDS.perMessage };
}

/** The thumbnails above the composer: progress while uploading, the reason when one failed, and Remove. */
export function ComposerImageStrip({ items, onRemove, disabled }: { items: readonly PendingImage[]; onRemove: (key: string) => void; disabled?: boolean }) {
  if (!items.length) return null;
  return <ul className="chat-composer-images" aria-label="Images to send">
    {items.map((item) => <li key={item.key} className={`chat-composer-image ${item.status}`}>
      {item.previewUrl ? <img src={item.previewUrl} alt={item.name} draggable={false} /> : <span className="chat-composer-image-placeholder" role="img" aria-label={item.name}><ImageIcon aria-hidden="true" /></span>}
      {item.status === "uploading" && <span className="chat-composer-image-progress" role="progressbar" aria-label={`Uploading ${item.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}><span style={{ width: `${Math.round(item.progress * 100)}%` }} /></span>}
      {item.status === "failed" && <span className="chat-composer-image-failed" role="alert" title={item.error ?? undefined}><AlertCircle aria-hidden="true" /><span className="sr-only">{item.name}: {item.error}</span></span>}
      <button type="button" className="icon-button chat-composer-image-remove" onClick={() => onRemove(item.key)} disabled={disabled} aria-label={`Remove ${item.name}`}><X /></button>
    </li>)}
  </ul>;
}

/** A user message's images in its bubble: a thumbnail each (opens the viewer), "Image removed" for one in its owner's Bin. */
export function MessageImages({ items, onOpen }: { items: readonly ChatAttachment[]; onOpen: (item: Extract<ChatAttachment, { removed: false }>) => void }) {
  if (!items.length) return null;
  return <ul className="chat-message-images" aria-label={items.length === 1 ? "Attached image" : `${items.length} attached images`}>
    {items.map((item) => <li key={item.documentId}>
      {item.removed ? <span className="chat-message-image removed"><ImageOff aria-hidden="true" /><small>Image removed</small></span>
        : <button type="button" className="chat-message-image" onClick={() => onOpen(item)} aria-label={`Open ${item.name}`} aria-haspopup="dialog">
          <img src={contentUrl(item.documentId, "inline")} alt={item.name} loading="lazy" decoding="async" draggable={false} />
        </button>}
    </li>)}
  </ul>;
}
