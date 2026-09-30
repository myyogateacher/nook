import { getCsrfToken } from "../api";

// Image kinds the server previews inline (server/mimeSniff.ts). SVG and others download as attachments,
// so an <img> pointing at them would render broken.
export const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const IMAGE_ACCEPT = INLINE_IMAGE_TYPES.join(",");
export const IMAGE_REJECTED_MESSAGE = "Only PNG, JPEG, GIF, and WebP images can be added to a note";

export function isInsertableImageType(type: string) {
  return (INLINE_IMAGE_TYPES as readonly string[]).includes(type.toLowerCase());
}

export function imageContentUrl(documentId: string) {
  return `/api/files/${encodeURIComponent(documentId)}/content?disposition=inline`;
}

// Note images must be files served by this app. External and data: sources are dropped on load:
// the CSP blocks most of them anyway, and a remote src would leak that the note was opened.
const NOTE_IMAGE_SRC = /^\/api\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/content(?:\?[^\s#]*)?$/i;

export function isNoteImageSrc(src: unknown): src is string {
  return typeof src === "string" && NOTE_IMAGE_SRC.test(src);
}

// Markdown image alt text cannot hold brackets or line breaks without escaping, which the
// image serializer does not do, so keep the filename readable but safe.
export function imageAltText(filename: string) {
  return filename.replace(/[\[\]\\\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "image";
}

export type UploadedDocument = { id: string; name: string; mime_type: string; preview_kind: string; folder_id?: string | null };

export class ImageUploadError extends Error {}

/**
 * Stores a picked, pasted, or dropped picture as an ordinary File in `folderId` (Default when null)
 * and returns its document, once the server's own sniff says it is a PNG, JPEG, GIF, or WebP image.
 * Shared by notes and whiteboards (Wave 24, D198); `signal` cancels the upload.
 */
export async function uploadImageDocument(file: File, folderId: string | null, signal?: AbortSignal): Promise<UploadedDocument> {
  if (!isInsertableImageType(file.type)) throw new ImageUploadError(IMAGE_REJECTED_MESSAGE);
  const body = new FormData();
  body.append("file", file, file.name || "image");
  const headers = new Headers({ "Idempotency-Key": crypto.randomUUID() });
  const csrf = getCsrfToken();
  if (csrf) headers.set("X-CSRF-Token", csrf);
  const query = folderId ? `?folderId=${encodeURIComponent(folderId)}` : "";
  const response = await fetch(`/api/files${query}`, { method: "POST", body, headers, credentials: "same-origin", ...(signal ? { signal } : {}) });
  const payload = await response.json().catch(() => ({})) as { document?: UploadedDocument; error?: unknown };
  if (!response.ok || !payload.document) {
    throw new ImageUploadError(typeof payload.error === "string" ? payload.error : `Image upload failed (${response.status})`);
  }
  const document = payload.document;
  // The server classifies by content, not by the browser's MIME guess; honour its verdict.
  if (document.preview_kind !== "image" || !isInsertableImageType(document.mime_type)) {
    await fetch(`/api/files/${encodeURIComponent(document.id)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
      body: "{}",
      credentials: "same-origin"
    }).catch(() => undefined);
    throw new ImageUploadError(IMAGE_REJECTED_MESSAGE);
  }
  return document;
}

export async function uploadNoteImage(file: File, folderId: string | null): Promise<{ src: string; alt: string }> {
  const document = await uploadImageDocument(file, folderId);
  return { src: imageContentUrl(document.id), alt: imageAltText(document.name || file.name) };
}
