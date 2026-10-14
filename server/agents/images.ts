import { createHash, randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { isIP } from "node:net";
import type { Context } from "hono";
import type { AppEnv } from "../auth";
import { config } from "../config";
import { db, now } from "../db";
import { storedBytes } from "../documents";
import { keepRequestOpen } from "../longRequests";
import { sniff, SNIFF_BYTES } from "../mimeSniff";
import { TOOL_IMAGE_BOUNDS, type ToolImageRef } from "../../shared/agents";
import { checkEgressUrl, EgressError, egressFetch, privateHostAllowed } from "./egress";
import type { McpImage } from "./mcpClient";
import { AgentError } from "./status";
import { logger } from "../log";

const slog = logger("agents");

/**
 * Images in chats (D370 as amended, T304): the image proxy for outside pictures a person chose to
 * load, and the store for pictures MCP tools return. Both answer only image bytes that sniff as PNG,
 * JPEG, GIF, or WebP (never SVG, whatever the upstream or the tool claimed), with the content
 * route's strict header set (server/documents.ts `applyContentSecurityHeaders`: a sandboxing CSP,
 * `nosniff`, no referrer, same-origin CORP, `private, no-store`) plus `Content-Disposition: inline`.
 *
 * The proxy (`GET /api/agents/image-proxy?url=`) exists so the app's CSP can stay `img-src 'self'
 * data:` and the reader's address never reaches the image's host:
 * - It needs a session (all of /api does; API keys never authenticate there) and the agent module,
 *   and guests get 404 (agentGate). It answers only a request carrying `X-Nook-Image-Proxy: 1`, which
 *   an `<img>`, a link, a form, or another site's page cannot send (another origin would need a CORS
 *   preflight Nook never grants), and refuses a `Sec-Fetch-Site` other than same-origin. So nothing
 *   in a note, a file, or a reply can make a browser call it without the person's click.
 * - **Public https on port 443 only** (security review M1, L2): the proxy never uses
 *   AGENT_ALLOWED_PRIVATE_HOSTS, which is the admin's allowance for providers and tool servers, not
 *   for every chat user; so it reaches no private or local address, no plain http, and no other port.
 *   AGENT_IMAGE_PROXY_TEST_HOSTS (tests and local QA only, refused in production) is the one exception.
 * - The fetch is `egressFetch` (DNS checked and pinned, Nook's own origin refused, redirects refused,
 *   no cookie or key sent, its byte cap and timeouts), aborted when the browser goes away (review L1).
 * - Every failure that depends on the far side (DNS, a private address, a redirect, a timeout, a
 *   status, the size, bytes that are not an image) is one answer, 502 `IMAGE_UNAVAILABLE` "That image
 *   could not be loaded", so the proxy cannot be used to map hosts or ports; the reason is logged with
 *   the host only, never the path or query.
 * - Per person: `IMAGE_PROXY_LIMITS.perMinute` images a minute (sliding, in `agent_rate_limits`) and
 *   `concurrent` at a time; the body is buffered under `maxBytes` and checked by its first bytes.
 *
 * Tool images (review M2): each picture's bytes are stored once by SHA-256 (`chat_image_blobs`);
 * `chat_tool_images` rows reference them per chat and message, and a trigger removes a blob when its
 * last reference goes (a chat purged from the Bin, a copy deleted). A chat owner's references count
 * against their storage quota (`storedBytes`, each distinct picture once), and nothing is kept when
 * the quota or the disk (`MIN_FREE_DISK_BYTES`) would be exceeded.
 */

export const IMAGE_PROXY_LIMITS = { maxBytes: 5 * 1024 * 1024, perMinute: 60, concurrent: 4, urlChars: 2048, firstByteMs: 10_000, idleMs: 10_000, totalMs: 30_000 } as const;
export const IMAGE_PROXY_HEADER = "x-nook-image-proxy";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The image type of these bytes, or null: the sniff decides, never a declared type. */
export function imageTypeOf(head: Uint8Array): ToolImageRef["mimeType"] | null {
  const type = sniff(head.subarray(0, SNIFF_BYTES), "", head.byteLength).mimeType;
  return IMAGE_TYPES.has(type) ? type as ToolImageRef["mimeType"] : null;
}

/** An image response: the bytes, their sniffed type, inline, and the strict headers the index applies on these paths. */
function imageResponse(bytes: Uint8Array, mimeType: string) {
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store"
    }
  });
}

/** Whether a path is one of these image routes, which take the content route's strict header set instead of the app's. */
export const isChatImageRequest = (method: string, path: string) => (method === "GET" || method === "HEAD")
  && (path === "/api/agents/image-proxy" || /^\/api\/chats\/[^/]+\/tool-images\/[^/]+$/.test(path));

// --- The proxy's per-person limits ---

const inFlight = new Map<string, number>();
type Row = { window_start: number; count: number; previous_count: number };

/** Checks and charges one image for the person (a sliding minute). Returns 0 when admitted, else the seconds to wait. */
export function chargeImageLoad(userId: string, nowMs = Date.now()): number {
  return db.transaction(() => {
    const windowMs = 60_000;
    const bucket = `image_minute:${userId}`;
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    const row = db.query("SELECT window_start, count, previous_count FROM agent_rate_limits WHERE bucket = ?").get(bucket) as Row | null;
    const count = row && row.window_start === windowStart ? row.count : 0;
    const previous = row && row.window_start === windowStart ? row.previous_count : row && row.window_start === windowStart - windowMs ? row.count : 0;
    const estimate = previous * (1 - (nowMs - windowStart) / windowMs) + count;
    if (estimate + 1 > IMAGE_PROXY_LIMITS.perMinute) return Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000));
    db.query(`INSERT INTO agent_rate_limits (bucket, window_start, count, previous_count) VALUES (?, ?, ?, ?)
      ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = excluded.count, previous_count = excluded.previous_count`)
      .run(bucket, windowStart, count + 1, previous);
    return 0;
  })();
}

/** Test hook: the proxy requests in flight per person. */
export const imageLoadsInFlight = (userId: string) => inFlight.get(userId) ?? 0;

const URL_REFUSED = () => new AgentError(400, "URL_REFUSED", "Nook loads outside images only from public https addresses");
/** The one answer for anything that went wrong on the far side (review M1). */
class Unavailable extends Error {
  constructor(readonly reason: string) { super(reason); }
}

/** Whether a test-only host is named (AGENT_IMAGE_PROXY_TEST_HOSTS); never in production (config refuses it there). */
function testHostListed(url: URL) {
  const hosts = config.agents.imageProxyTestHosts;
  if (hosts.length === 0) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  return privateHostAllowed(host, isIP(host) ? [host] : [], hosts);
}

/** `GET /api/agents/image-proxy?url=…` (see the module comment). */
export async function proxyImage(c: Context<AppEnv>): Promise<Response> {
  const userId = c.get("user").id;
  if (c.req.header(IMAGE_PROXY_HEADER) !== "1") throw new AgentError(400, "INVALID", "Images load through the chat only");
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin") throw new AgentError(403, "FORBIDDEN", "Images load through the chat only");
  const raw = c.req.query("url") ?? "";
  if (!raw || raw.length > IMAGE_PROXY_LIMITS.urlChars) throw new AgentError(400, "INVALID", "The image address is missing or too long");
  let url: URL;
  try {
    url = checkEgressUrl(raw);
  } catch (error) {
    if (error instanceof EgressError) throw URL_REFUSED();
    throw error;
  }
  const testHost = testHostListed(url);
  // Public https on the default port, unless a test host is named (review M1, L2).
  if (!testHost && (url.protocol !== "https:" || url.port !== "")) throw URL_REFUSED();
  if (/\.svgz?$/i.test(url.pathname)) throw new AgentError(415, "NOT_AN_IMAGE", "SVG images are never loaded");
  if ((inFlight.get(userId) ?? 0) >= IMAGE_PROXY_LIMITS.concurrent) throw new AgentError(429, "RATE_LIMITED", "Too many images are loading; wait a moment", { retryAfterSeconds: 2 });
  const wait = chargeImageLoad(userId);
  if (wait > 0) throw new AgentError(429, "RATE_LIMITED", "Too many images loaded; wait a minute", { retryAfterSeconds: wait });
  inFlight.set(userId, (inFlight.get(userId) ?? 0) + 1);
  // Up to 30 s: past the server's idle timeout, so the request is kept open; it ends when the browser leaves (review L1).
  keepRequestOpen(c.req.raw);
  try {
    let response;
    try {
      response = await egressFetch(url.toString(), { method: "GET", headers: { Accept: "image/png,image/jpeg,image/gif,image/webp" }, signal: c.req.raw.signal }, IMAGE_PROXY_LIMITS,
        { allowlist: testHost ? config.agents.imageProxyTestHosts : [] });
    } catch (error) {
      throw new Unavailable(error instanceof EgressError ? error.code : c.req.raw.signal.aborted ? "CLIENT_GONE" : "NETWORK");
    }
    if (response.status !== 200) {
      response.cancel();
      throw new Unavailable(`STATUS_${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > IMAGE_PROXY_LIMITS.maxBytes) {
      response.cancel();
      throw new Unavailable("TOO_LARGE");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    let checked = false;
    try {
      for await (const chunk of response.body) {
        chunks.push(chunk);
        size += chunk.byteLength;
        // Decided on the first bytes: an HTML page or an SVG is dropped before the rest is downloaded.
        if (!checked && size >= 16) {
          checked = true;
          if (!imageTypeOf(Buffer.concat(chunks))) {
            response.cancel();
            throw new Unavailable("NOT_AN_IMAGE");
          }
        }
      }
    } catch (error) {
      if (error instanceof Unavailable) throw error;
      throw new Unavailable(error instanceof EgressError ? error.code : c.req.raw.signal.aborted ? "CLIENT_GONE" : "NETWORK");
    }
    const bytes = new Uint8Array(Buffer.concat(chunks));
    const mimeType = imageTypeOf(bytes);
    if (!mimeType) throw new Unavailable("NOT_AN_IMAGE");
    return imageResponse(bytes, mimeType);
  } catch (error) {
    if (!(error instanceof Unavailable)) throw error;
    // The host and the reason only: the path and query can carry what the reply tried to send out.
    if (error.reason !== "CLIENT_GONE") slog.warn(`Image proxy: ${url.host} not loaded (${error.reason})`);
    throw new AgentError(502, "IMAGE_UNAVAILABLE", "That image could not be loaded");
  } finally {
    const left = (inFlight.get(userId) ?? 1) - 1;
    if (left <= 0) inFlight.delete(userId);
    else inFlight.set(userId, left);
  }
}

// --- Tool images ---

export type ToolImagesKept = { refs: ToolImageRef[]; dropped: number; reason: string | null };

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Whether the owner already holds a reference to this picture (it then costs them nothing more). */
const ownerHolds = (ownerId: string, sha256: string) => db.query("SELECT 1 FROM chat_tool_images r JOIN chats c ON c.id = r.chat_id WHERE c.owner_id = ? AND r.sha256 = ? LIMIT 1").get(ownerId, sha256) !== null;

/**
 * Stores a call's images with the chat, within the run's `TOOL_IMAGE_BOUNDS.perRun`, the chat owner's
 * storage quota, and the free-disk floor. Returns what was kept, how many were not, and why.
 */
export async function storeToolImages(chatId: string, messageId: string, images: readonly McpImage[], alreadyInRun: number): Promise<ToolImagesKept> {
  const valid = images.filter((image) => image.bytes.byteLength > 0 && image.bytes.byteLength <= TOOL_IMAGE_BOUNDS.bytes && imageTypeOf(image.bytes) === image.mimeType);
  const room = Math.max(0, Math.min(TOOL_IMAGE_BOUNDS.perRun - alreadyInRun, TOOL_IMAGE_BOUNDS.perCall));
  const candidates = valid.slice(0, room);
  let reason: string | null = images.length > candidates.length ? (valid.length < images.length ? "it was not a usable picture" : "the run's picture limit was reached") : null;
  const owner = db.query("SELECT owner_id FROM chats WHERE id = ?").get(chatId) as { owner_id: string } | null;
  if (!owner || candidates.length === 0) return { refs: [], dropped: images.length, reason: reason ?? "the run has no chat" };
  const hashed = candidates.map((image) => ({ ...image, sha256: sha256Of(image.bytes) }));
  const seen = new Set<string>();
  const newBytes = hashed.reduce((sum, image) => {
    if (seen.has(image.sha256) || ownerHolds(owner.owner_id, image.sha256)) return sum;
    seen.add(image.sha256);
    return sum + image.bytes.byteLength;
  }, 0);
  if (newBytes > 0) {
    const quota = config.userStorageQuotaBytes;
    if (quota > 0 && storedBytes(owner.owner_id) + newBytes > quota) return { refs: [], dropped: images.length, reason: "the chat owner's storage quota is full" };
    try {
      const disk = await statfs(config.dataDir);
      if (disk.bavail * disk.bsize < config.minFreeDiskBytes + newBytes) return { refs: [], dropped: images.length, reason: "this Nook's disk is nearly full" };
    } catch {
      return { refs: [], dropped: images.length, reason: "this Nook's disk could not be checked" };
    }
  }
  const refs: ToolImageRef[] = [];
  const blob = db.query("INSERT OR IGNORE INTO chat_image_blobs (sha256, mime_type, size_bytes, bytes, created_at) VALUES (?, ?, ?, ?, ?)");
  const ref = db.query("INSERT INTO chat_tool_images (chat_id, id, message_id, sha256, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    if (!db.query("SELECT 1 FROM chats WHERE id = ? AND deleted_at IS NULL").get(chatId)) return;
    for (const image of hashed) {
      const id = randomUUID();
      blob.run(image.sha256, image.mimeType, image.bytes.byteLength, image.bytes, now());
      ref.run(chatId, id, messageId, image.sha256, image.mimeType, image.bytes.byteLength, now());
      refs.push({ id, mimeType: image.mimeType, bytes: image.bytes.byteLength });
    }
  })();
  if (refs.length < images.length && !reason) reason = "the chat is no longer there";
  return { refs, dropped: images.length - refs.length, reason: refs.length < images.length ? reason : null };
}

/**
 * A continued copy keeps the tool images of the messages it copied: new reference rows (the same image
 * ids, the copy's own message ids) to the same stored bytes, never a second copy of them (review M2, L4).
 */
export function copyToolImages(fromChatId: string, toChatId: string, messageIds: ReadonlyMap<string, string>) {
  const copy = db.query(`INSERT OR IGNORE INTO chat_tool_images (chat_id, id, message_id, sha256, mime_type, size_bytes, created_at)
    SELECT ?, id, ?, sha256, mime_type, size_bytes, created_at FROM chat_tool_images WHERE chat_id = ? AND message_id = ?`);
  for (const [source, target] of messageIds) copy.run(toChatId, target, fromChatId, source);
}

/**
 * `GET /api/chats/:chatId/tool-images/:imageId`: the caller has already been checked to read the chat.
 * `visibleMessages` (people the chat is shared with) limits it to the messages on the chat's active
 * branch, as the chat itself shows them (review L3); null for the owner.
 */
export function toolImageResponse(chatId: string, imageId: string, visibleMessages: ReadonlySet<string> | null): Response {
  const row = db.query(`SELECT r.mime_type, r.message_id, b.bytes FROM chat_tool_images r JOIN chat_image_blobs b ON b.sha256 = r.sha256
    WHERE r.chat_id = ? AND r.id = ?`).get(chatId, imageId) as { mime_type: string; message_id: string; bytes: Uint8Array } | null;
  if (!row || (visibleMessages && !visibleMessages.has(row.message_id))) throw new AgentError(404, "NOT_FOUND", "Not found");
  const bytes = new Uint8Array(row.bytes);
  const mimeType = imageTypeOf(bytes);
  if (!mimeType || mimeType !== row.mime_type) throw new AgentError(404, "NOT_FOUND", "Not found");
  return imageResponse(bytes, mimeType);
}
