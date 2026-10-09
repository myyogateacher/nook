import { CHAT_IMAGE_BOUNDS, isChatImageType } from "../../shared/agents";

/**
 * The composer's image rules (uploads everywhere U5, Q10): which files it takes, the messages it
 * refuses with, and the browser-side downscale. Pure apart from `downscaleImage` (canvas), so the
 * rules are tested without a browser.
 */

export const CHAT_IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
export const NOT_AN_IMAGE_MESSAGE = "Only images (PNG, JPEG, GIF, or WebP) can be sent in a chat for now; PDFs and other files are not.";
export const visionMissingMessage = (agentName: string | null) => `${agentName ? `${agentName}'s model` : "This agent's model"} can't see images. An admin can mark the model vision-capable in Settings → AI → Model providers.`;
export const IMAGES_FULL_MESSAGE = `A message can carry at most ${CHAT_IMAGE_BOUNDS.perMessage} images.`;
export const imageTooLargeMessage = (name: string) => `${name} is larger than ${Math.round(CHAT_IMAGE_BOUNDS.bytes / 1024 / 1024)} MiB, even after resizing.`;

/** Whether the composer takes this file (its declared type; the server sniffs the bytes again). */
export const isChatImageFile = (file: Pick<File, "type">) => isChatImageType(file.type);

/**
 * Sorts dropped, pasted, or chosen files into the ones to add and the reason for the rest, given how
 * many images are already on the message and whether the model can see images.
 */
export function triageImageFiles(files: readonly File[], already: number, vision: boolean, agentName: string | null = null): { accepted: File[]; refusal: string | null } {
  if (files.length === 0) return { accepted: [], refusal: null };
  if (!vision) return { accepted: [], refusal: visionMissingMessage(agentName) };
  const images = files.filter(isChatImageFile);
  const room = Math.max(0, CHAT_IMAGE_BOUNDS.perMessage - already);
  const accepted = images.slice(0, room);
  const refusal = images.length < files.length ? NOT_AN_IMAGE_MESSAGE : images.length > room ? IMAGES_FULL_MESSAGE : null;
  return { accepted, refusal };
}

/**
 * The size an image is drawn at before upload: unchanged when it fits (`null`), else scaled to fit
 * `CHAT_IMAGE_BOUNDS.maxEdge` on its long side. An animated GIF is only resized when it is over the
 * byte cap (drawing it keeps one frame).
 */
export function downscaleTarget(width: number, height: number, bytes: number, type: string): { width: number; height: number } | null {
  const edge = Math.max(width, height);
  const tooBig = bytes > CHAT_IMAGE_BOUNDS.bytes;
  if (type === "image/gif" && !tooBig) return null;
  if (edge <= CHAT_IMAGE_BOUNDS.maxEdge && !tooBig) return null;
  const scale = Math.min(1, CHAT_IMAGE_BOUNDS.maxEdge / edge);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Downscales a large photo in the browser before upload (the server never re-encodes, D20): the long
 * side to 2,048 px, as JPEG (quality 0.85) from a JPEG and as WebP (which keeps transparency) from the
 * others, falling back to the original when the browser cannot decode or encode it. Drawing also
 * drops the photo's metadata (location included); the orientation is applied first.
 */
export async function downscaleImage(file: File): Promise<File> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  try {
    const target = downscaleTarget(bitmap.width, bitmap.height, file.size, file.type);
    if (!target) return file;
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, target.width, target.height);
    const type = file.type === "image/jpeg" ? "image/jpeg" : "image/webp";
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, type === "image/jpeg" ? 0.85 : 0.9));
    if (!blob || !isChatImageType(blob.type)) return file;
    // A redraw that came out bigger is kept only when the original is over the cap anyway.
    if (blob.size >= file.size && file.size <= CHAT_IMAGE_BOUNDS.bytes) return file;
    return new File([blob], renamed(file.name, blob.type), { type: blob.type, lastModified: file.lastModified });
  } finally {
    bitmap.close();
  }
}

/**
 * A small preview of a picked file while it uploads, as a `data:` URL (the app's CSP allows `img-src
 * 'self' data:`, never `blob:`): drawn at most `size` px on its long side. Null when the browser cannot
 * decode it; once uploaded, the thumbnail switches to the stored file.
 */
export async function thumbnailDataUrl(file: File, size = 160): Promise<string | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png", "image/gif": "gif" };
/** `photo.png` drawn as WebP becomes `photo.webp` (the sniff decides the type; the name should agree). */
export function renamed(name: string, type: string) {
  const extension = EXTENSIONS[type] ?? "img";
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, "") || "image";
  return `${base}.${extension}`;
}
