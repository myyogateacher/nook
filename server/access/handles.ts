import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Opaque handles for the member access page (access plan §C.7, D269, T204). A row the admin cannot
 * read shows no id; the action on it carries this handle instead: `{kind, id, via, group}` sealed
 * with AES-256-GCM under a key that lives only in this process, bound to the admin who received it
 * and the person it is about, and valid for a few hours. It cannot be read, forged, replayed by
 * another admin, or moved to another person. A restart simply invalidates open pages (they reload).
 *
 * Paging cursors use the same seal, because the last row's id would otherwise leak through them.
 */

const KEY = randomBytes(32);
export const HANDLE_TTL_MS = 6 * 3_600_000;

type Sealed = Record<string, unknown> & { viewer: string; target: string; purpose: "item" | "cursor" };

function seal(payload: Sealed, nowMs = Date.now()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ ...payload, exp: nowMs + HANDLE_TTL_MS }), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function open(token: string, viewer: string, target: string, purpose: Sealed["purpose"], nowMs = Date.now()): Record<string, unknown> | null {
  if (typeof token !== "string" || token.length < 40 || token.length > 600 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const raw = Buffer.from(token, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", KEY, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as Sealed & { exp: number };
    if (payload.viewer !== viewer || payload.target !== target || payload.purpose !== purpose || !(payload.exp > nowMs)) return null;
    return payload;
  } catch {
    return null;
  }
}

export type ItemHandle = { kind: string; id: string; via: "direct" | "group"; groupId: string | null };

export const sealItemHandle = (viewer: string, target: string, item: ItemHandle, nowMs?: number) =>
  seal({ viewer, target, purpose: "item", kind: item.kind, id: item.id, via: item.via, groupId: item.groupId }, nowMs);

export function openItemHandle(token: string, viewer: string, target: string, nowMs?: number): ItemHandle | null {
  const payload = open(token, viewer, target, "item", nowMs);
  if (!payload || typeof payload.kind !== "string" || typeof payload.id !== "string" || (payload.via !== "direct" && payload.via !== "group")) return null;
  return { kind: payload.kind, id: payload.id, via: payload.via, groupId: typeof payload.groupId === "string" ? payload.groupId : null };
}

export type PageCursor = { via: string; id: string; groupId: string };

export const sealCursor = (viewer: string, target: string, kind: string, cursor: PageCursor) =>
  seal({ viewer, target, purpose: "cursor", kind, via: cursor.via, id: cursor.id, groupId: cursor.groupId });

export function openCursor(token: string, viewer: string, target: string, kind: string): PageCursor | null {
  const payload = open(token, viewer, target, "cursor");
  if (!payload || payload.kind !== kind || typeof payload.via !== "string" || typeof payload.id !== "string" || typeof payload.groupId !== "string") return null;
  return { via: payload.via, id: payload.id, groupId: payload.groupId };
}
