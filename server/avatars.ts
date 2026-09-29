import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import type { AppEnv } from "./auth";
import { config } from "./config";
import { db } from "./db";

/**
 * Profile pictures (Wave 35, D299, T257, T262). The server downloads a Google picture once, stores it
 * as DATA_DIR/avatars/<uuid> (the name is never derived from input), and serves it same-origin at
 * /api/users/:id/avatar?v=<uuid>. The browser never contacts Google, so the CSP stays as it is.
 *
 * `v` is the file's UUID: unguessable, and returned only in payloads that already carry the
 * person's name, so the picture is visible exactly where the name is. A replaced picture gets a
 * new UUID, so an old URL is 404 and clients refresh.
 */

export const AVATAR_MAX_BYTES = 1_048_576;
export const AVATAR_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const avatarDir = () => resolve(config.dataDir, "avatars");
const avatarPath = (id: string) => join(avatarDir(), id);

/** The same-origin avatar URL for a user, or null when they have no picture. */
export function avatarUrlFor(userId: string, avatarId?: string | null) {
  const id = avatarId === undefined
    ? (db.query("SELECT avatar_id FROM users WHERE id = ?").get(userId) as { avatar_id: string | null } | null)?.avatar_id ?? null
    : avatarId;
  return id ? `/api/users/${userId}/avatar?v=${id}` : null;
}

/** PNG, JPEG, or WebP by magic bytes; anything else (SVG, HTML, GIF, …) is null. The header is never trusted. */
export function sniffAvatar(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  const at = (offset: number, values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  if (bytes.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytes.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

/**
 * Whether the server may fetch this URL: https on a `*.googleusercontent.com` host (the test issuer's
 * host and http in tests), no credentials, default port. Checked again on every redirect hop.
 */
export function isAllowedAvatarUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const endpoints = config.auth.google.endpoints;
  const protocolOk = url.protocol === "https:" || (endpoints.avatarHttp && url.protocol === "http:");
  if (!protocolOk || url.username || url.password) return false;
  if (!endpoints.avatarHttp && url.port !== "") return false;
  const host = url.hostname.toLowerCase();
  return endpoints.avatarHosts.some((rule) => rule.startsWith(".") ? host.endsWith(rule) && host.length > rule.length : host === rule);
}

export type AvatarFetchFailure = "url" | "redirect" | "status" | "size" | "type" | "network";

/** Downloads a picture within the D299 limits. Never throws. */
export async function fetchAvatar(raw: string): Promise<{ ok: true; bytes: Uint8Array; type: string } | { ok: false; reason: AvatarFetchFailure }> {
  let current = raw;
  const signal = AbortSignal.timeout(AVATAR_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!isAllowedAvatarUrl(current)) return { ok: false, reason: hop === 0 ? "url" : "redirect" };
      const response = await fetch(current, { redirect: "manual", signal, headers: { Accept: "image/png, image/jpeg, image/webp" } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("Location");
        await response.body?.cancel();
        if (!location) return { ok: false, reason: "redirect" };
        current = new URL(location, current).toString();
        continue;
      }
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        return { ok: false, reason: "status" };
      }
      const declared = Number(response.headers.get("Content-Length") ?? "0");
      if (declared > AVATAR_MAX_BYTES) {
        await response.body.cancel();
        return { ok: false, reason: "size" };
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > AVATAR_MAX_BYTES) {
          await reader.cancel();
          return { ok: false, reason: "size" };
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const type = sniffAvatar(bytes);
      return type ? { ok: true, bytes, type } : { ok: false, reason: "type" };
    }
    return { ok: false, reason: "redirect" };
  } catch {
    return { ok: false, reason: "network" };
  }
}

async function removeFile(id: string | null) {
  if (id && UUID.test(id)) await rm(avatarPath(id), { force: true }).catch(() => undefined);
}

/**
 * Downloads `pictureUrl` and makes it the user's avatar, replacing (and deleting) the old file.
 * Returns whether a new picture was stored. A failure keeps the current avatar and never throws:
 * a picture must not fail a sign-in (D299).
 */
export async function storeAvatarFromUrl(userId: string, pictureUrl: string) {
  const fetched = await fetchAvatar(pictureUrl);
  if (!fetched.ok) {
    console.warn(`Avatar download skipped: reason=${fetched.reason}`);
    return false;
  }
  const id = crypto.randomUUID();
  try {
    await mkdir(avatarDir(), { recursive: true, mode: 0o700 });
    const partial = join(avatarDir(), `.${id}.part`);
    await writeFile(partial, fetched.bytes, { mode: 0o600 });
    await rename(partial, avatarPath(id));
  } catch (error) {
    console.error("Avatar store failed", error instanceof Error ? error.name : "Unknown error");
    return false;
  }
  const previous = (db.query("SELECT avatar_id FROM users WHERE id = ?").get(userId) as { avatar_id: string | null } | null)?.avatar_id ?? null;
  const updated = db.query("UPDATE users SET avatar_id = ? WHERE id = ?").run(id, userId).changes;
  await removeFile(updated ? previous : id);
  return updated === 1;
}

/** Removes a user's avatar file and clears the pointer (unlinking Google keeps it: the name stays too). */
export async function clearAvatar(userId: string) {
  const previous = (db.query("SELECT avatar_id FROM users WHERE id = ?").get(userId) as { avatar_id: string | null } | null)?.avatar_id ?? null;
  db.query("UPDATE users SET avatar_id = NULL WHERE id = ?").run(userId);
  await removeFile(previous);
}

/**
 * Hourly: deletes avatar files no account points at (a deleted account, a replaced picture whose
 * delete failed) and leftover partial writes older than an hour. Returns how many were removed.
 */
export async function sweepAvatarFiles(nowMs = Date.now()) {
  let names: string[];
  try {
    names = await readdir(avatarDir());
  } catch {
    return 0;
  }
  const referenced = new Set((db.query("SELECT avatar_id FROM users WHERE avatar_id IS NOT NULL").all() as Array<{ avatar_id: string }>).map((row) => row.avatar_id));
  let removed = 0;
  for (const name of names) {
    const path = join(avatarDir(), name);
    if (UUID.test(name)) {
      if (referenced.has(name)) continue;
    } else if (!name.endsWith(".part")) {
      continue;
    }
    try {
      // A file younger than a minute may belong to a sign-in that has not written its pointer yet.
      const info = await stat(path);
      if (nowMs - info.mtimeMs < (name.endsWith(".part") ? 3_600_000 : 60_000)) continue;
      await rm(path, { force: true });
      removed += 1;
    } catch {
      // Gone meanwhile.
    }
  }
  return removed;
}

/** Avatar URLs for many users in one query (only those who have a picture). */
export function avatarUrlsFor(userIds: Iterable<string>) {
  const ids = [...new Set(userIds)];
  const urls = new Map<string, string>();
  if (!ids.length) return urls;
  const rows = db.query("SELECT id, avatar_id FROM users WHERE avatar_id IS NOT NULL AND id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as Array<{ id: string; avatar_id: string }>;
  for (const row of rows) urls.set(row.id, avatarUrlFor(row.id, row.avatar_id)!);
  return urls;
}

/**
 * Adds `avatar_url` to each card's assignees for the web payloads that draw assignee avatars (the
 * task query and saved views). MCP tools call the services directly and keep their output unchanged.
 */
export function withAssigneeAvatars<T extends { cards: Array<{ assignees: Array<{ id: string }> }> }>(result: T): T {
  const urls = avatarUrlsFor(result.cards.flatMap((card) => card.assignees.map((person) => person.id)));
  return { ...result, cards: result.cards.map((card) => ({ ...card, assignees: card.assignees.map((person) => ({ ...person, avatar_url: urls.get(person.id) ?? null })) })) };
}

/** GET /api/users/:id/avatar?v=: any signed-in session holding the current URL (T262). */
export function registerAvatarRoute(app: Hono<AppEnv>) {
  app.get("/api/users/:id/avatar", async (c) => {
    const userId = c.req.param("id").toLowerCase();
    const version = c.req.query("v") ?? "";
    const notFound = () => c.json({ error: "Not found" }, 404);
    if (!UUID.test(userId) || !UUID.test(version)) return notFound();
    const row = db.query("SELECT avatar_id FROM users WHERE id = ?").get(userId) as { avatar_id: string | null } | null;
    if (!row?.avatar_id || row.avatar_id !== version) return notFound();
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(avatarPath(version)));
    } catch {
      return notFound();
    }
    const type = sniffAvatar(bytes);
    if (!type) return notFound();
    const etag = `"${version}"`;
    c.header("Cache-Control", "private, max-age=86400");
    c.header("ETag", etag);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
    c.header("Content-Type", type);
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200);
  });
}
