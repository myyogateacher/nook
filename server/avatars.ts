import { resolve } from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./auth";
import { hit } from "./authLimits";
import { config } from "./config";
import { audit, db } from "./db";
import { isObjectInFlight, objectStore, putHeld, StorageUnavailableError } from "./objectStore";
import { parseJson } from "./validation";

/**
 * Profile pictures (Wave 35, D299, T257, T262). The server downloads a Google picture once, stores it
 * in the object store's `avatars` namespace under a new UUID (locally DATA_DIR/avatars/<uuid>, on S3
 * <S3_PREFIX>avatars/<uuid>; the name is never derived from input), and serves it same-origin at
 * /api/users/:id/avatar?v=<uuid>. The browser never contacts Google, so the CSP stays as it is.
 *
 * `v` is the file's UUID: unguessable, and returned only in payloads that already carry the
 * person's name, so the picture is visible exactly where the name is. A replaced picture gets a
 * new UUID, so an old URL is 404 and clients refresh.
 *
 * Uploaded pictures (uploads everywhere U7, T353): a person may upload their own picture, go back to
 * the letters, or choose their Google picture again (PUT /api/me/avatar). There is no migration:
 * `users.avatar_id` tells where the picture came from by itself.
 * - NULL: no picture; a Google sign-in may fill it (the Wave 35 behaviour).
 * - a version-4 UUID: the copy of the Google picture, which Google sign-ins keep in step.
 * - a version-8 UUID (RFC 9562's custom version; random bits otherwise): a picture the person
 *   uploaded. Google sign-ins, Google reporting no picture, and unlinking Google leave it alone.
 * - {@link AVATAR_REMOVED}, a fixed version-8 id that names no file: the person removed their
 *   picture, or an admin did (Team → a member → Remove profile picture), so Google sign-ins leave
 *   the letters until the person uploads a picture or chooses their Google picture again (T353).
 */

export const AVATAR_MAX_BYTES = 1_048_576;
export const AVATAR_TIMEOUT_MS = 5_000;
/** An uploaded picture wider or taller than this is refused (the web sends a 512 px square). */
export const AVATAR_MAX_SIDE = 4096;
/** The "removed by the person" marker (see above): never a file, never a URL. */
export const AVATAR_REMOVED = "00000000-0000-8000-8000-000000000000";
const MAX_REDIRECTS = 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The local backend's avatar directory (STORAGE_BACKEND=local). */
export const avatarDir = () => resolve(config.dataDir, "avatars");

export type AvatarSource = "upload" | "google" | "none";

/** Where a stored `avatar_id` came from (see the header comment). */
export function avatarSourceOf(avatarId: string | null): AvatarSource {
  if (!avatarId || avatarId === AVATAR_REMOVED || !UUID.test(avatarId)) return "none";
  return avatarId[14] === "8" ? "upload" : "google";
}

/** True when Google sign-ins must leave the picture alone: one the person uploaded, or removed. */
export const avatarChosenByPerson = (avatarId: string | null) => avatarId === AVATAR_REMOVED || avatarSourceOf(avatarId) === "upload";

/** A new id for an uploaded picture: a random UUID marked version 8 (see the header comment). */
export function uploadedAvatarId() {
  const id = crypto.randomUUID();
  return `${id.slice(0, 14)}8${id.slice(15)}`;
}

const currentAvatarId = (userId: string) => (db.query("SELECT avatar_id FROM users WHERE id = ?").get(userId) as { avatar_id: string | null } | null)?.avatar_id ?? null;

/** The same-origin avatar URL for a user, or null when they have no picture. */
export function avatarUrlFor(userId: string, avatarId?: string | null) {
  const id = avatarId === undefined ? currentAvatarId(userId) : avatarId;
  return id && id !== AVATAR_REMOVED ? `/api/users/${userId}/avatar?v=${id}` : null;
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
 * The pixel size a PNG, JPEG, or WebP header declares, or null when it cannot be read. Used to refuse
 * an upload that would make every viewer's browser decode a huge image (a small file can declare
 * 30 000 × 30 000 pixels).
 */
export function avatarDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const type = sniffAvatar(bytes);
  const u16be = (offset: number) => (bytes[offset]! << 8) | bytes[offset + 1]!;
  const u16le = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8);
  const u24le = (offset: number) => u16le(offset) | (bytes[offset + 2]! << 16);
  const u32be = (offset: number) => ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
  if (type === "image/png") {
    // IHDR is always the first chunk.
    if (bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
    return { width: u32be(16), height: u32be(20) };
  }
  if (type === "image/webp") {
    if (bytes.length < 30) return null;
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === "VP8X") return { width: u24le(24) + 1, height: u24le(27) + 1 };
    if (chunk === "VP8L") {
      const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0;
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    return null;
  }
  if (type === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) { offset += 1; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue; }
      // SOF0–SOF15, except DHT (C4), JPG (C8), and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16be(offset + 7), height: u16be(offset + 5) };
      if (marker === 0xd9 || marker === 0xda) return null;
      offset += 2 + u16be(offset + 2);
    }
    return null;
  }
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

/** Deletes a stored picture through the object store (never the marker, never a non-UUID). Never throws. */
export async function removeAvatarFile(id: string | null) {
  await removeFile(id);
}

async function removeFile(id: string | null) {
  if (id && id !== AVATAR_REMOVED && UUID.test(id)) await objectStore().remove("avatars", id).catch(() => undefined);
}

/**
 * Stores `bytes` under `id`, points the account at it, and deletes the old file. With `unlessChosen`
 * (a Google sign-in), a picture the person uploaded or removed meanwhile wins and the new file goes.
 * Returns whether the account now shows the new picture. Throws when the store fails.
 */
async function replaceAvatar(userId: string, id: string, bytes: Uint8Array, unlessChosen: boolean) {
  // The picture stays out of the avatar sweep until the pointer below is written (review L-a).
  const release = await putHeld(objectStore(), "avatars", id, bytes);
  try {
    const { previous, updated } = db.transaction(() => {
      const previous = currentAvatarId(userId);
      if (unlessChosen && avatarChosenByPerson(previous)) return { previous, updated: 0 };
      return { previous, updated: db.query("UPDATE users SET avatar_id = ? WHERE id = ?").run(id, userId).changes };
    })();
    await removeFile(updated ? previous : id);
    return updated === 1;
  } finally {
    release();
  }
}

/**
 * Downloads `pictureUrl` and makes it the user's avatar, replacing (and deleting) the old file.
 * Returns whether a new picture was stored. A failure keeps the current avatar and never throws:
 * a picture must not fail a sign-in (D299). A picture the person uploaded or removed stays, unless
 * `chosen`: they asked for their Google picture (U7).
 */
export async function storeAvatarFromUrl(userId: string, pictureUrl: string, options: { chosen?: boolean } = {}) {
  if (!options.chosen && avatarChosenByPerson(currentAvatarId(userId))) return false;
  const fetched = await fetchAvatar(pictureUrl);
  if (!fetched.ok) {
    console.warn(`Avatar download skipped: reason=${fetched.reason}`);
    return false;
  }
  try {
    return await replaceAvatar(userId, crypto.randomUUID(), fetched.bytes, !options.chosen);
  } catch (error) {
    console.error("Avatar store failed", error instanceof Error ? error.name : "Unknown error");
    return false;
  }
}

/**
 * Removes the user's copy of their Google picture and clears the pointer: Google reported no picture,
 * or Google was unlinked. A picture the person uploaded, or their choice of no picture, stays (U7).
 */
export async function clearAvatar(userId: string) {
  const previous = currentAvatarId(userId);
  if (avatarSourceOf(previous) !== "google") return;
  if (db.query("UPDATE users SET avatar_id = NULL WHERE id = ? AND avatar_id = ?").run(userId, previous).changes) await removeFile(previous);
}

/**
 * Hourly: deletes avatar files no account points at (a deleted account, a replaced picture whose
 * delete failed) and leftover partial writes older than an hour. Returns how many were removed.
 */
export async function sweepAvatarFiles(nowMs = Date.now()) {
  const store = objectStore();
  let removed = (await store.sweepStaging("avatars", nowMs - 3_600_000)).removed;
  const referenced = new Set((db.query("SELECT avatar_id FROM users WHERE avatar_id IS NOT NULL").all() as Array<{ avatar_id: string }>).map((row) => row.avatar_id));
  for await (const entry of store.list("avatars")) {
    if (!entry.id || !UUID.test(entry.id) || referenced.has(entry.id) || isObjectInFlight("avatars", entry.id)) continue;
    // A file younger than a minute may belong to a sign-in that has not written its pointer yet (on S3,
    // the store's grace: its clock may differ from this host's).
    if (nowMs - entry.modifiedMs < (store.backend === "s3" ? store.orphanGraceMs : 60_000)) continue;
    try {
      await store.remove("avatars", entry.id);
      removed += 1;
    } catch {
      // The next sweep tries again.
    }
  }
  return removed;
}

/** Avatar URLs for many users in one query (only those who have a picture). */
export function avatarUrlsFor(userIds: Iterable<string>) {
  const ids = [...new Set(userIds)];
  const urls = new Map<string, string>();
  if (!ids.length) return urls;
  const rows = db.query("SELECT id, avatar_id FROM users WHERE avatar_id IS NOT NULL AND avatar_id <> ? AND id IN (SELECT value FROM json_each(?))").all(AVATAR_REMOVED, JSON.stringify(ids)) as Array<{ id: string; avatar_id: string }>;
  for (const row of rows) urls.set(row.id, avatarUrlFor(row.id, row.avatar_id)!);
  return urls;
}

/**
 * The integrations (service accounts, D287) among `userIds`, in one query: the web draws them with
 * the integration icon and an "Integration" badge instead of a picture or letters. Integrations
 * never have a picture (no Google identity, no session to upload one with, and U7 gives admins no
 * way to set one: an integration must not pass for a person).
 */
export function integrationIdsAmong(userIds: Iterable<string | null | undefined>) {
  const ids = [...new Set([...userIds].filter((id): id is string => typeof id === "string"))];
  if (!ids.length) return new Set<string>();
  const rows = db.query("SELECT id FROM users WHERE kind = 'service' AND id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/**
 * Adds `avatar_url` to each card's assignees for the web payloads that draw assignee avatars (the
 * task query and saved views). MCP tools call the services directly and keep their output unchanged.
 */
export function withAssigneeAvatars<T extends { cards: Array<{ assignees: Array<{ id: string }> }> }>(result: T): T {
  const urls = avatarUrlsFor(result.cards.flatMap((card) => card.assignees.map((person) => person.id)));
  return { ...result, cards: result.cards.map((card) => ({ ...card, assignees: card.assignees.map((person) => ({ ...person, avatar_url: urls.get(person.id) ?? null })) })) };
}

/** Base64 of at most AVATAR_MAX_BYTES (4 characters per 3 bytes), standard alphabet. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const avatarChangeSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("upload"), image: z.string().min(4).max(Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 4) }).strict(),
  z.object({ source: z.literal("google") }).strict(),
  z.object({ source: z.literal("none") }).strict()
]);

type AvatarErrorCode = "AVATAR_TOO_LARGE" | "AVATAR_TYPE" | "AVATAR_DIMENSIONS" | "GOOGLE_PICTURE_UNAVAILABLE" | "RATE_LIMITED" | "STORAGE_UNAVAILABLE";

/** The signed-in person's picture, where it came from, and whether "Use my Google picture" can work. */
function avatarState(userId: string) {
  const avatarId = currentAvatarId(userId);
  const google = db.query("SELECT picture_url FROM google_identities WHERE user_id = ?").get(userId) as { picture_url: string | null } | null;
  return {
    avatarUrl: avatarUrlFor(userId, avatarId),
    source: avatarSourceOf(avatarId),
    google: { linked: google !== null, hasPicture: Boolean(google?.picture_url) }
  };
}

/**
 * GET /api/users/:id/avatar?v=: any signed-in session holding the current URL (T262).
 * GET and PUT /api/me/avatar: the signed-in person's own picture (U7). Sessions only (the REST
 * surface never reaches /api/me), people only (integrations have no session), every role: the
 * one write-gate entry lets viewers and guests change their own picture.
 */
export function registerAvatarRoute(app: Hono<AppEnv>) {
  app.get("/api/me/avatar", (c) => c.json(avatarState(c.get("user").id)));

  app.put("/api/me/avatar", async (c) => {
    const user = c.get("user");
    const fail = (status: 400 | 409 | 413 | 415 | 422 | 429 | 502 | 503, code: AvatarErrorCode, error: string) => c.json({ error, code }, status);
    const body = await parseJson(c.req.raw, avatarChangeSchema);
    // Counted before any work: ten changes a minute per account (THREAT_MODEL T353).
    if (hit("avatar:account", user.id)) return fail(429, "RATE_LIMITED", "Too many picture changes. Try again in a minute.");
    const previous = currentAvatarId(user.id);
    if (body.source === "none") {
      db.query("UPDATE users SET avatar_id = ? WHERE id = ?").run(AVATAR_REMOVED, user.id);
      await removeFile(previous);
      audit(user.id, null, "account.avatar_changed", { source: "none", previousSource: avatarSourceOf(previous) });
      return c.json(avatarState(user.id));
    }
    if (body.source === "google") {
      const identity = db.query("SELECT picture_url FROM google_identities WHERE user_id = ?").get(user.id) as { picture_url: string | null } | null;
      if (!identity?.picture_url) return fail(409, "GOOGLE_PICTURE_UNAVAILABLE", "Google has no picture for your account. Add one there, then sign in with Google again.");
      if (!await storeAvatarFromUrl(user.id, identity.picture_url, { chosen: true })) return fail(502, "GOOGLE_PICTURE_UNAVAILABLE", "Your Google picture could not be loaded. Try again later.");
      audit(user.id, null, "account.avatar_changed", { source: "google", previousSource: avatarSourceOf(previous) });
      return c.json(avatarState(user.id));
    }
    if (!BASE64.test(body.image)) return fail(400, "AVATAR_TYPE", "The picture is not valid base64.");
    const bytes = new Uint8Array(Buffer.from(body.image, "base64"));
    if (bytes.byteLength > AVATAR_MAX_BYTES) return fail(413, "AVATAR_TOO_LARGE", "Pictures can be up to 1 MiB.");
    const type = sniffAvatar(bytes);
    if (!type) return fail(415, "AVATAR_TYPE", "Use a PNG, JPEG, or WebP picture.");
    const size = avatarDimensions(bytes);
    if (!size || size.width < 1 || size.height < 1 || size.width > AVATAR_MAX_SIDE || size.height > AVATAR_MAX_SIDE) {
      return fail(422, "AVATAR_DIMENSIONS", `Pictures can be up to ${AVATAR_MAX_SIDE} × ${AVATAR_MAX_SIDE} pixels.`);
    }
    try {
      await replaceAvatar(user.id, uploadedAvatarId(), bytes, false);
    } catch (error) {
      if (error instanceof StorageUnavailableError) return fail(503, "STORAGE_UNAVAILABLE", "Storage is busy. Try again in a moment.");
      throw error;
    }
    // No bytes and no hash in the audit row: only what changed.
    audit(user.id, null, "account.avatar_changed", { source: "upload", previousSource: avatarSourceOf(previous), type, width: size.width, height: size.height, bytes: bytes.byteLength });
    return c.json(avatarState(user.id));
  });

  app.get("/api/users/:id/avatar", async (c) => {
    const userId = c.req.param("id").toLowerCase();
    const version = c.req.query("v") ?? "";
    const notFound = () => c.json({ error: "Not found" }, 404);
    if (!UUID.test(userId) || !UUID.test(version) || version === AVATAR_REMOVED) return notFound();
    const row = db.query("SELECT avatar_id FROM users WHERE id = ?").get(userId) as { avatar_id: string | null } | null;
    if (!row?.avatar_id || row.avatar_id !== version) return notFound();
    // `no-cache` (T353): the browser keeps the bytes but asks again on every new page load, so a
    // replaced or removed picture (a new `v`, the old one 404) is gone for other viewers on their
    // next load. The answer for a current URL is a cheap 304 (one row read, no object read).
    const etag = `"${version}"`;
    const cacheHeaders = () => {
      c.header("Cache-Control", "private, no-cache");
      c.header("ETag", etag);
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Cross-Origin-Resource-Policy", "same-origin");
    };
    if (c.req.header("If-None-Match") === etag) {
      cacheHeaders();
      return c.body(null, 304);
    }
    let bytes: Uint8Array;
    try {
      bytes = await (await objectStore().open("avatars", version)).bytes();
    } catch {
      return notFound();
    }
    const type = sniffAvatar(bytes);
    if (!type) return notFound();
    cacheHeaders();
    c.header("Content-Type", type);
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200);
  });
}
