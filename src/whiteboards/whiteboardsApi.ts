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
  /** The owner's safety snapshots (0 for everyone else) and when the newest was taken. */
  snapshotCount: number;
  snapshotAt: string | null;
  /** The owner's picture (Wave 35's same-origin avatar URL), or null for their letters. */
  ownerAvatarUrl: string | null;
};

export type SaveResult = { revision: number; savedAt: string; sha256: string; sizeBytes: number; unchanged?: true; snapshotKept?: true };

export type WhiteboardSort = "updated-desc" | "updated-asc" | "name-asc" | "name-desc";

/** One page (at most 500) in `sort` order; pass `nextCursor` back for the next. */
export const listWhiteboards = (folder: "all" | "shared" | string = "all", cursor: string | null = null, sort: WhiteboardSort = "updated-desc") =>
  api<{ whiteboards: WhiteboardSummary[]; nextCursor: string | null }>(`/whiteboards?folder=${encodeURIComponent(folder)}&sort=${sort}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);

/** The owner's "Restore previous version": the newest safety snapshot becomes a new revision (CAS). */
export const restorePreviousVersion = (id: string, baseRevision: number) =>
  api<SaveResult & { restoredFrom: { revision: number; createdAt: string } }>(`/whiteboards/${encodeURIComponent(id)}/restore-previous`, { method: "POST", body: JSON.stringify({ baseRevision }) });

/** The newest safety snapshot as the restore dialog describes it (owner only; 404 NO_SNAPSHOT). */
export const getPreviousVersion = (id: string) =>
  api<{ revision: number; createdAt: string; elementCount: number }>(`/whiteboards/${encodeURIComponent(id)}/previous-version`);

/** D207: one kept version of a board (the owner's only). `elementCount` is null when it could not be read. */
export type WhiteboardSnapshot = { id: string; revision: number; createdAt: string; sizeBytes: number; elementCount: number | null };

export const listSnapshots = (id: string) => api<{ snapshots: WhiteboardSnapshot[] }>(`/whiteboards/${encodeURIComponent(id)}/snapshots`);

export const getSnapshot = (id: string, snapshotId: string, signal?: AbortSignal) =>
  api<{ snapshot: WhiteboardSnapshot; scene: CanonicalScene }>(`/whiteboards/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}`, signal ? { signal } : {});

/** Saves a snapshot as a new revision (the revision check applies: 409 on a stale base). */
export const restoreSnapshot = (id: string, snapshotId: string, baseRevision: number) =>
  api<SaveResult & { restoredFrom: { id: string; revision: number; createdAt: string } }>(`/whiteboards/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}/restore`, { method: "POST", body: JSON.stringify({ baseRevision }) });

/** A private copy owned by the caller, of the board or (owner) of one snapshot; images the caller cannot open are left out. */
export const duplicateWhiteboard = (id: string, options: { folderId?: string | null; snapshotId?: string | null } = {}) =>
  api<{ whiteboard: WhiteboardSummary; imagesLeftOut: number }>(`/whiteboards/${encodeURIComponent(id)}/duplicate`, {
    method: "POST", body: JSON.stringify({ ...(options.folderId ? { folderId: options.folderId } : {}), ...(options.snapshotId ? { snapshotId: options.snapshotId } : {}) })
  });

/** Import a parsed `.excalidraw` file; embedded images become Files in the board's folder. */
export const importWhiteboard = (name: string, folderId: string | null, file: unknown) =>
  api<{ whiteboard: WhiteboardSummary; images: number; imagesLeftOut: number }>("/whiteboards/import", { method: "POST", body: JSON.stringify({ name, ...(folderId ? { folderId } : {}), file }) });

/** What the note embed card shows (D208), for people who can read the board; 404 for anyone else. */
export type WhiteboardCardSummary = Pick<WhiteboardSummary, "id" | "name" | "updated_at" | "hasThumbnail" | "thumbRevision" | "elementCount" | "owner_name" | "is_owner">;
export const getWhiteboardSummary = (id: string, signal?: AbortSignal) =>
  api<{ whiteboard: WhiteboardCardSummary }>(`/whiteboards/${encodeURIComponent(id)}/summary`, signal ? { signal } : {});

/** The link a note embeds (D208): this instance's board URL; pasted alone on a line, it becomes a card. */
export const whiteboardLink = (id: string, origin = window.location.origin) => `${origin}/whiteboards/${id}`;

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
