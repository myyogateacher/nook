import { api, getCsrfToken } from "../../api";
import { UploadRequestError, uploadErrorMessage, type UploadResult } from "../../files/filesApi";
import { stripImageLocation } from "./exif";

/**
 * The attach kit's server calls (uploads everywhere plan D390, D396, D398). Every module slice uses
 * these instead of its own upload code, so every attachment goes through `POST /api/files` (sniffing,
 * quota, idempotency, the S3-ready byte store) and lands in the uploader's Attachments folder.
 */

export type HostKind = "event" | "note" | "chat_message" | "whiteboard" | "card" | "row";

export type HostAttachment =
  | { documentId: string; removed: false; name: string; mimeType: string; previewKind: string; sizeBytes: number; partId: string | null; position: number; linkedAt: string; isOwner: boolean; inAttachmentsFolder: boolean }
  | { documentId: string; removed: true; partId: string | null; position: number; linkedAt: string };

export type UploadForHostOptions = {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
  /** Reuse the same key when retrying the same file, so a retry never stores it twice. */
  idempotencyKey?: string;
  /** Q9: JPEG location is removed unless the caller turns it off for this file. */
  keepLocation?: boolean;
};

const path = (kind: HostKind, hostId: string) => `/attachments/${encodeURIComponent(kind)}/${encodeURIComponent(hostId)}`;

/**
 * Uploads one file to the caller's Attachments folder for a host of `kind` (`?attachTo=`), with
 * progress and abort; strips JPEG location first (D401, Q9). Resolves with the stored document; the
 * caller then links it with linkToHost (or its module's own route for cards and rows).
 */
export async function uploadForHost(file: File, kind: HostKind, options: UploadForHostOptions = {}): Promise<UploadResult> {
  const prepared = options.keepLocation ? file : await stripImageLocation(file);
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException("Upload canceled", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/files?attachTo=${encodeURIComponent(kind)}`);
    const token = getCsrfToken();
    if (token) xhr.setRequestHeader("X-CSRF-Token", token);
    xhr.setRequestHeader("Idempotency-Key", options.idempotencyKey ?? crypto.randomUUID());
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
    };
    const onAbort = () => xhr.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => options.signal?.removeEventListener("abort", onAbort);
    xhr.onload = () => {
      done();
      let payload: unknown = {};
      try { payload = JSON.parse(xhr.responseText || "{}"); } catch { /* keep the empty payload */ }
      if (xhr.status >= 200 && xhr.status < 300 && payload && typeof payload === "object" && "document" in payload) {
        resolve(payload as UploadResult);
        return;
      }
      const code = payload && typeof payload === "object" && typeof (payload as { code?: unknown }).code === "string" ? (payload as { code: string }).code : null;
      reject(new UploadRequestError(uploadErrorMessage(xhr.status, payload), xhr.status, code));
    };
    xhr.onerror = () => { done(); reject(new UploadRequestError(uploadErrorMessage(0, null), 0, null)); };
    xhr.onabort = () => { done(); reject(new DOMException("Upload canceled", "AbortError")); };
    const form = new FormData();
    form.append("file", prepared, prepared.name);
    xhr.send(form);
  });
}

/** The host's attachments as the caller sees them (404 when they cannot open the host). */
export const listHostAttachments = (kind: HostKind, hostId: string) =>
  api<{ attachments: HostAttachment[]; caps: { perHost: number; perPart?: number }; linking: "declared" | "derived" | "module" }>(path(kind, hostId));

/**
 * Links one of the caller's own documents to a declared host (events, chat messages). A file from
 * Files (outside the Attachments folder) needs `confirmed: true`, sent after the From Files confirm;
 * without it the server answers 409 CONFIRM_REQUIRED (D396).
 */
export const linkToHost = (kind: HostKind, hostId: string, documentId: string, options: { partId?: string | null; confirmed?: boolean } = {}) =>
  api<{ documentId: string; created: boolean }>(path(kind, hostId), { method: "POST", body: JSON.stringify({ documentId, ...(options.partId ? { partId: options.partId } : {}), ...(options.confirmed ? { confirmed: true } : {}) }) });

/**
 * Removes a link; `documentBinned` says the upload went to the Bin with it (D395). The file's owner may
 * always remove their own file from any host, even one they can no longer open (review M1).
 */
export const unlinkFromHost = (kind: HostKind, hostId: string, documentId: string) =>
  // `documentBinned` is absent when the file's owner withdrew it from a host they can no longer open (review M1).
  api<{ ok: true; documentBinned?: boolean }>(`${path(kind, hostId)}/${encodeURIComponent(documentId)}`, { method: "DELETE", body: "{}" });

/**
 * Undo of a removal (POST /api/attachments/relink): puts the file back on the same host, in the same
 * place, and out of the Bin when the removal put it there. The server keeps its own record of the
 * removal; `partId` (a card comment or a row's file field) is only a fallback for when it has none.
 */
export const relinkToHost = (kind: HostKind, hostId: string, documentId: string, options: { partId?: string | null } = {}) =>
  api<{ relinked: boolean; restored: boolean }>("/attachments/relink", { method: "POST", body: JSON.stringify({ hostKind: kind, hostId, documentId, ...(options.partId ? { partId: options.partId } : {}) }) });

/** `hidden`: places the owner can no longer open, by id only, for "Remove from places you can't open" (review M1). */
export type FileUsage = { uses: Array<{ hostKind: HostKind; hostId: string; title: string | null }>; hidden: Array<{ hostKind: HostKind; hostId: string }>; hiddenCount: number; total: number };

/** Where the caller's file is attached (D409), for the delete confirm in Files. */
export const fileUsage = (documentId: string) => api<FileUsage>(`/files/${encodeURIComponent(documentId)}/usage`);

const HOST_NOUNS: Record<HostKind, [string, string]> = {
  event: ["event", "events"], note: ["note", "notes"], chat_message: ["chat message", "chat messages"], whiteboard: ["whiteboard", "whiteboards"], card: ["card", "cards"], row: ["row", "rows"]
};

/** "Used on 2 cards and 1 event" (D409); null when the file is not attached anywhere. */
export function usageSummary(usage: FileUsage): string | null {
  if (usage.total === 0) return null;
  const counts = new Map<HostKind, number>();
  for (const use of usage.uses) counts.set(use.hostKind, (counts.get(use.hostKind) ?? 0) + 1);
  const parts = [...counts].map(([kind, count]) => `${count} ${HOST_NOUNS[kind][count === 1 ? 0 : 1]}`);
  if (usage.hiddenCount) parts.push(`${usage.hiddenCount} ${usage.hiddenCount === 1 ? "place" : "places"} you cannot open`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]!;
  return `Used on ${list}`;
}
