import { api, getCsrfToken } from "../api";
import type { DocumentSummary } from "../types";

export const TEXT_PREVIEW_BYTES = 1024 * 1024;

export class UploadRequestError extends Error {
  constructor(message: string, public status: number, public code: string | null) {
    super(message);
  }
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

// Maps an upload failure onto the message shown in the queue. Pure, so it is unit tested.
export function uploadErrorMessage(status: number, payload: unknown): string {
  const body = payload && typeof payload === "object" ? payload as { error?: unknown; code?: unknown; limitBytes?: unknown } : {};
  const serverMessage = typeof body.error === "string" ? body.error : "";
  if (status === 0) return "Network error. Check your connection and retry.";
  if (status === 413) {
    return typeof body.limitBytes === "number" && body.limitBytes > 0 ? `File is larger than the ${formatBytes(body.limitBytes)} limit` : "File is too large";
  }
  if (status === 507) return body.code === "QUOTA_EXCEEDED" ? "Your storage quota is full" : "Storage is full";
  if (status === 429) return "Too many uploads at once. Retry in a moment.";
  return serverMessage || `Upload failed (${status})`;
}

export function contentUrl(id: string, disposition: "inline" | "attachment") {
  return `/api/files/${encodeURIComponent(id)}/content?disposition=${disposition}`;
}

export function listFiles(folderId?: string) {
  const query = folderId ? `?folderId=${encodeURIComponent(folderId)}` : "";
  return api<{ documents: DocumentSummary[] }>(`/files${query}`);
}

export function getFile(id: string) {
  return api<{ document: DocumentSummary }>(`/files/${encodeURIComponent(id)}`);
}

// Fetches the first MiB of a text document. It is rendered as React text, never navigated to.
export async function fetchTextPreview(id: string, signal?: AbortSignal) {
  const response = await fetch(contentUrl(id, "inline"), {
    headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` },
    credentials: "same-origin",
    signal
  });
  if (response.status === 416) return "";
  if (!response.ok) throw new Error(`Could not load the preview (${response.status})`);
  const buffer = await response.arrayBuffer();
  return new TextDecoder("utf-8").decode(buffer.slice(0, TEXT_PREVIEW_BYTES));
}

export type UploadResult = { document: DocumentSummary; idempotentReplay?: boolean };

// fetch has no upload progress, so uploads use XMLHttpRequest. Aborting rejects with an AbortError.
export function uploadFile(file: File, folderId: string | null, idempotencyKey: string, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload canceled", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const query = folderId ? `?folderId=${encodeURIComponent(folderId)}` : "";
    xhr.open("POST", `/api/files${query}`);
    xhr.withCredentials = false; // same-origin requests send the session cookie anyway
    const token = getCsrfToken();
    if (token) xhr.setRequestHeader("X-CSRF-Token", token);
    xhr.setRequestHeader("Idempotency-Key", idempotencyKey);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => signal?.removeEventListener("abort", onAbort);
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
    xhr.onerror = () => {
      done();
      reject(new UploadRequestError(uploadErrorMessage(0, null), 0, null));
    };
    xhr.onabort = () => {
      done();
      reject(new DOMException("Upload canceled", "AbortError"));
    };
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

const filePath = (id: string) => `/files/${encodeURIComponent(id)}`;

export function renameFile(id: string, name: string) {
  return api<{ document: DocumentSummary }>(filePath(id), { method: "PATCH", body: JSON.stringify({ name }) });
}

export function moveFile(id: string, folderId: string | null) {
  return api<{ document: DocumentSummary }>(filePath(id), { method: "PATCH", body: JSON.stringify({ folderId }) });
}

export function deleteFile(id: string) {
  return api<{ ok: true; purgeAfter: string; alreadyDeleted?: true }>(filePath(id), { method: "DELETE", body: "{}" });
}
