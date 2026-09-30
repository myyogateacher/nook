import { imageContentUrl, INLINE_IMAGE_TYPES } from "../editor/imageUpload";

/**
 * Pictures on the canvas (Wave 24, D198). The scene only ever holds references to Nook files; the
 * canvas fetches each file through the authenticated content route AS THE VIEWER (same origin, so
 * no CSP change) and hands Excalidraw an in-memory data: URL. A file the viewer cannot open is never
 * fetched into the scene: Excalidraw draws its placeholder instead (T165).
 *
 * Large pictures are scaled down for display with plain canvas APIs (createImageBitmap and a 2D
 * canvas), never with Excalidraw's own resizer, whose pica and image-blob-reduce try
 * WebAssembly.compile, which the CSP refuses. The stored file is never changed.
 */

/** The longest side a picture is shown at on the canvas (the file keeps its own size). */
export const IMAGE_DISPLAY_MAX_SIDE = 2560;
/** The longest side a newly placed picture gets on the board, in scene units. */
export const IMAGE_PLACE_MAX_SIDE = 480;

export type LoadedImage = { dataURL: string; width: number; height: number; mimeType: string };

export class ImageLoadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const readAsDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error("Could not read the picture"));
  reader.readAsDataURL(blob);
});

/** A displayable data: URL for a picture, scaled down when it is larger than the display limit. */
export async function displayImage(blob: Blob, mimeType: string): Promise<LoadedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new ImageLoadError(415, "This picture could not be read");
  }
  try {
    const { width, height } = bitmap;
    const longest = Math.max(width, height);
    // GIFs stay as they are (Excalidraw draws their first frame); small pictures need no work.
    if (longest <= IMAGE_DISPLAY_MAX_SIDE || mimeType === "image/gif") return { dataURL: await readAsDataUrl(blob), width, height, mimeType };
    const scale = IMAGE_DISPLAY_MAX_SIDE / longest;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return { dataURL: await readAsDataUrl(blob), width, height, mimeType };
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const type = mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
    return { dataURL: canvas.toDataURL(type, 0.9), width, height, mimeType: type };
  } finally {
    bitmap.close();
  }
}

/** Fetches a Nook image as the viewer and prepares it for the canvas. 404 means the viewer cannot open it. */
export async function loadNookImage(documentId: string, signal?: AbortSignal): Promise<LoadedImage> {
  const response = await fetch(imageContentUrl(documentId), { credentials: "same-origin", ...(signal ? { signal } : {}) });
  if (!response.ok) throw new ImageLoadError(response.status, response.status === 404 ? "This picture is not a file you can open" : "Could not load the picture");
  const mimeType = (response.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(INLINE_IMAGE_TYPES as readonly string[]).includes(mimeType)) throw new ImageLoadError(415, "This file is not a picture a whiteboard can show");
  return displayImage(await response.blob(), mimeType);
}

/** The size a newly placed picture gets: its own proportions, the longest side at most `max` scene units. */
export function placedSize(width: number, height: number, max = IMAGE_PLACE_MAX_SIDE) {
  const longest = Math.max(width, height, 1);
  const scale = Math.min(1, max / longest);
  return { width: Math.max(8, Math.round(width * scale)), height: Math.max(8, Math.round(height * scale)) };
}
