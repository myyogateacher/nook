import { api } from "../api";
import type { DocumentSummary } from "../types";
import type { CanonicalScene } from "../../shared/whiteboardScene";

/** docs/plan/API_CONTRACTS.md § Whiteboards. Rename, move, share, and delete use the Files API (D196). */
export type WhiteboardSummary = DocumentSummary & {
  kind: "whiteboard";
  revision: number;
  elementCount: number;
  hasThumbnail: boolean;
  thumbRevision: number | null;
  canEdit: boolean;
};

export type SaveResult = { revision: number; savedAt: string; sha256: string; sizeBytes: number; unchanged?: true };

export const listWhiteboards = (folder: "all" | "shared" | string = "all") =>
  api<{ whiteboards: WhiteboardSummary[] }>(`/whiteboards?folder=${encodeURIComponent(folder)}`);

export const getWhiteboard = (id: string) => api<{ whiteboard: WhiteboardSummary; scene: CanonicalScene }>(`/whiteboards/${encodeURIComponent(id)}`);

export function createWhiteboard(name: string, folderId: string | null, idempotencyKey = crypto.randomUUID()) {
  return api<{ whiteboard: WhiteboardSummary }>("/whiteboards", { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ name, ...(folderId ? { folderId } : {}) }) });
}

export const saveWhiteboardScene = (id: string, baseRevision: number, scene: CanonicalScene) =>
  api<SaveResult>(`/whiteboards/${encodeURIComponent(id)}/scene`, { method: "PUT", body: JSON.stringify({ baseRevision, scene }) });

export async function putWhiteboardThumbnail(id: string, revision: number, png: Blob) {
  const bytes = new Uint8Array(await png.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  await api<unknown>(`/whiteboards/${encodeURIComponent(id)}/thumbnail`, { method: "PUT", body: JSON.stringify({ revision, png: btoa(binary) }) });
}

/** Fired after a thumbnail upload, so a list already on screen shows it (the upload can finish after the canvas closed). */
export const THUMBNAIL_EVENT = "nook:whiteboard-thumbnail";
export const announceThumbnail = (id: string, revision: number) => window.dispatchEvent(new CustomEvent(THUMBNAIL_EVENT, { detail: { id, revision } }));

/** The thumbnail URL, versioned by revision so a new one is fetched after a save (the server revalidates by hash). */
export const thumbnailUrl = (board: Pick<WhiteboardSummary, "id" | "thumbRevision">) => `/api/whiteboards/${encodeURIComponent(board.id)}/thumbnail?r=${board.thumbRevision ?? 0}`;

/** The `.excalidraw` download (the Files content route, always an attachment). */
export const downloadUrl = (id: string) => `/api/files/${encodeURIComponent(id)}/content?disposition=attachment`;
