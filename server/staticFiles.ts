import { stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

/**
 * The built client (`dist/`) in production (C14). Vite's hashed files under `/assets/` never change
 * under their name, so browsers keep them for a year (`immutable`); everything else (index.html, the
 * service worker, the web app manifest, icons) is `no-cache` with an ETag and Last-Modified, so a new
 * release is picked up on the next load. `.br` and `.gz` twins written at build time
 * (vite.config.ts) are sent when the browser accepts them, with the original Content-Type and
 * `Vary: Accept-Encoding`; already-compressed types are never compressed. GET and HEAD only, with
 * conditional requests (304) and single byte ranges (206/416) on the plain file. Paths are decoded
 * and must stay inside the root: anything else is refused (404). Unknown paths outside `/assets/`
 * are client routes and get index.html. API and file-content routes never reach this handler.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wasm": "application/wasm"
};

/** Types worth compressing; images, fonts, and wasm are served as they are. Kept in step with vite.config.ts. */
export const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".map", ".webmanifest", ".svg", ".txt", ".xml"]);

/** Vite's content-hashed output: `/assets/<name>-<hash>.<ext>` (hash of 8+ url-safe characters). */
export const isHashedAsset = (path: string) => /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(path);

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const REVALIDATE = "no-cache";

type Encoding = "br" | "gzip" | "identity";

/** The best encoding the request accepts among those on disk: br, then gzip, else the plain file. */
export function negotiateEncoding(header: string | null | undefined, available: { br: boolean; gzip: boolean }): Encoding {
  if (!header) return "identity";
  const accepted = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    const quality = q ? Number(q.slice(2)) : 1;
    accepted.set(name, Number.isFinite(quality) ? quality : 0);
  }
  const quality = (name: string) => accepted.get(name) ?? (accepted.has("*") ? accepted.get("*")! : 0);
  if (available.br && quality("br") > 0) return "br";
  if (available.gzip && quality("gzip") > 0) return "gzip";
  return "identity";
}

/** The file for `pathname` inside `root`, or null when it is not a safe path to a regular file. */
async function fileFor(root: string, pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { refused: true as const };
  }
  // No NUL, no backslashes, and no dot segments before or after decoding.
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").some((segment) => segment === ".." || segment === ".")) return { refused: true as const };
  const target = resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(root + sep)) return { refused: true as const };
  try {
    const info = await stat(target);
    return info.isFile() ? { refused: false as const, path: target, size: info.size, mtimeMs: info.mtimeMs } : { refused: false as const, path: null };
  } catch {
    return { refused: false as const, path: null };
  }
}

async function exists(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const etagOf = (size: number, mtimeMs: number, encoding: Encoding) => `"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}${encoding === "identity" ? "" : `-${encoding}`}"`;

function notModified(request: Request, etag: string, mtimeMs: number) {
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch) return ifNoneMatch.split(",").map((tag) => tag.trim().replace(/^W\//, "")).some((tag) => tag === etag || tag === "*");
  const since = Date.parse(request.headers.get("If-Modified-Since") ?? "");
  return Number.isFinite(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
}

/** A single `bytes=a-b` range within `size`, "invalid" for an unsatisfiable one, or null to send the whole file. */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

/**
 * The response for a GET or HEAD of `pathname`, or null for another method (the caller moves on).
 * `root` is the absolute dist directory.
 */
export async function serveStaticFile(request: Request, pathname: string, root: string): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  let found = await fileFor(root, pathname);
  if (found.refused) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": REVALIDATE } });
  let servedPath = pathname;
  if (!found.path) {
    // A missing hashed or asset file is a real 404 (never HTML under a script's name); anything else is a client route.
    if (pathname.startsWith("/assets/") || pathname === "/index.html") return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": REVALIDATE } });
    found = await fileFor(root, "/index.html");
    servedPath = "/index.html";
    if (found.refused || !found.path) return new Response("Not found", { status: 404 });
  }
  const { path, size, mtimeMs } = found as { path: string; size: number; mtimeMs: number };
  const extension = extname(path).toLowerCase();
  const type = TYPES[extension] ?? "application/octet-stream";
  const compressible = COMPRESSIBLE.has(extension);
  const range = request.headers.get("Range");
  // A range applies to the plain file; ranges of compressed twins are not offered.
  const encoding = compressible && !range
    ? negotiateEncoding(request.headers.get("Accept-Encoding"), { br: await exists(`${path}.br`), gzip: await exists(`${path}.gz`) })
    : "identity";
  const bodyPath = encoding === "br" ? `${path}.br` : encoding === "gzip" ? `${path}.gz` : path;
  const bodyInfo = encoding === "identity" ? { size, mtimeMs } : await stat(bodyPath);
  const etag = etagOf(bodyInfo.size, mtimeMs, encoding);
  const headers = new Headers({
    "Content-Type": type,
    "Cache-Control": isHashedAsset(servedPath) ? IMMUTABLE : REVALIDATE,
    ETag: etag,
    "Last-Modified": new Date(mtimeMs).toUTCString(),
    "Accept-Ranges": "bytes"
  });
  if (compressible) headers.set("Vary", "Accept-Encoding");
  if (encoding !== "identity") headers.set("Content-Encoding", encoding === "br" ? "br" : "gzip");
  if (notModified(request, etag, mtimeMs)) {
    headers.delete("Content-Type");
    return new Response(null, { status: 304, headers });
  }
  const file = Bun.file(bodyPath);
  if (encoding === "identity" && range) {
    const wanted = parseRange(range, size);
    if (wanted === "invalid") {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    if (wanted) {
      headers.set("Content-Range", `bytes ${wanted.start}-${wanted.end}/${size}`);
      headers.set("Content-Length", String(wanted.end - wanted.start + 1));
      return new Response(request.method === "HEAD" ? null : file.slice(wanted.start, wanted.end + 1), { status: 206, headers });
    }
  }
  headers.set("Content-Length", String(bodyInfo.size));
  return new Response(request.method === "HEAD" ? null : file, { status: 200, headers });
}

/** The absolute dist directory next to the server (the production image's `/app/dist`). */
export const distRoot = (base = process.cwd()) => resolve(join(base, "dist"));
