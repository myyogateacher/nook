import { imageContentUrl, INLINE_IMAGE_TYPES } from "../editor/imageUpload";
import type { SceneFile } from "../../shared/whiteboardScene";

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

/** How far each further picture placed in the same view moves from the previous one (QA L2), in screen pixels. */
export const PLACE_STEP_PX = 24;
/**
 * Where the next picture placed at the view's centre goes (QA L2): while the view is unchanged,
 * each one moves a step down and right from the previous, so they never fully cover each other;
 * after 8 steps it starts over. A moved or zoomed view starts again at the centre.
 */
export function nextPlacement(previous: { view: string; step: number } | null, view: string) {
  const step = previous && previous.view === view ? (previous.step + 1) % 8 : 0;
  return { view, step, offsetPx: step * PLACE_STEP_PX };
}

/**
 * The pictures a board's thumbnail draws (v0.35.0): of the pictures this canvas already loaded for
 * display (the saver's own loading path, never a second fetch), only those whose Nook file the
 * server listed as the board owner's own live pictures (`allowed`). Everyone who can read the board
 * sees its thumbnail and can open those through the board; any other picture (someone else's, binned,
 * or not loaded yet) is left out and drawn as Excalidraw's placeholder.
 */
export function thumbnailFiles<T>(loaded: Readonly<Record<string, T>>, refs: ReadonlyMap<string, SceneFile>, allowed: Iterable<string>): Record<string, T> {
  const owned = new Set([...allowed].map((id) => id.toLowerCase()));
  const files: Record<string, T> = {};
  for (const [fileId, data] of Object.entries(loaded)) {
    const documentId = refs.get(fileId)?.nookDocumentId;
    if (documentId && owned.has(documentId.toLowerCase())) files[fileId] = data;
  }
  return files;
}

/**
 * The pictures a "Save as copy" thumbnail draws: the same rule as a normal save, for the NEW board.
 * The person saving owns the copy, so only the pictures the server lists for the copy (`listed`, its
 * GET …/thumbnail-pictures) are drawn, from what this canvas already loaded; the original owner's or
 * anyone else's picture stays a placeholder. A failed list means no pictures rather than a wrong one.
 */
export async function copyThumbnailFiles<T>(
  loaded: Readonly<Record<string, T>>,
  scene: { files: Readonly<Record<string, SceneFile>> },
  listed: () => Promise<{ documentIds: string[] }>
): Promise<Record<string, T>> {
  const refs = new Map(Object.entries(scene.files));
  if (!refs.size || !Object.keys(loaded).length) return {};
  let allowed: string[] = [];
  try {
    allowed = (await listed()).documentIds;
  } catch {
    // Not known now: no pictures in this thumbnail.
  }
  return thumbnailFiles(loaded, refs, allowed);
}
