import { realpath, stat } from "node:fs/promises";
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
 *
 * Edge cases, decided once: a Range request is always answered from the plain file (206, no
 * Content-Encoding), never from a compressed twin; `identity;q=0` without an acceptable twin still
 * gets the plain file (browsers never send it; a 406 would only break odd clients); HEAD sends the
 * chosen representation's headers. Paths longer than 1024 characters, NUL bytes, backslashes, and
 * any dot segment or dotfile (`.env`, `.git`) are refused, and a symlink (file or twin) is followed
 * only when its real location stays inside the real dist directory.
 *
 * The service worker (`/sw.js`, registered with scope `/` from the root, so no
 * Service-Worker-Allowed header is needed) and the web app manifest are `no-cache` like every
 * non-hashed file, with `text/javascript` and `application/manifest+json`: never immutable.
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
  // A pathological header costs nothing: only the first 32 entries of the first 1 KB are read.
  for (const part of header.slice(0, 1024).split(",").slice(0, 32)) {
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
/** Longest request path considered; longer ones are refused before any file system call. */
export const MAX_PATH_LENGTH = 1024;

const within = (root: string, target: string) => target === root || target.startsWith(root + sep);

/** The real path of `path` when it is a regular file whose real location is inside the real root (symlinks never lead out). */
async function realFileInside(root: string, path: string) {
  try {
    const [realRoot, real] = await Promise.all([realpath(root), realpath(path)]);
    if (!within(realRoot, real)) return null;
    const info = await stat(real);
    return info.isFile() ? { path: real, size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

async function fileFor(root: string, pathname: string) {
  if (pathname.length > MAX_PATH_LENGTH) return { refused: true as const };
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { refused: true as const };
  }
  // No NUL, no backslashes, no dot segments, and no dotfiles (".env", ".git"), before or after decoding.
  // Decoding happens once: "%252e%252e" stays the literal name "%2e%2e", which no file has.
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").some((segment) => segment.startsWith("."))) return { refused: true as const };
  const target = resolve(root, `.${decoded}`);
  if (!within(root, target)) return { refused: true as const };
  const file = await realFileInside(root, target);
  return file ? { refused: false as const, ...file } : { refused: false as const, path: null };
}

/** A precompressed twin, under the same rules as the file itself. */
const twin = (root: string, path: string) => realFileInside(root, path);

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
  let twins: { br: Awaited<ReturnType<typeof twin>>; gzip: Awaited<ReturnType<typeof twin>> } = { br: null, gzip: null };
  // A range applies to the plain file; ranges of compressed twins are not offered.
  const encoding = compressible && !range
    ? await (async () => {
      const [br, gzip] = await Promise.all([twin(root, `${path}.br`), twin(root, `${path}.gz`)]);
      twins = { br, gzip };
      return negotiateEncoding(request.headers.get("Accept-Encoding"), { br: br !== null, gzip: gzip !== null });
    })()
    : "identity";
  const chosen = encoding === "br" ? twins.br : encoding === "gzip" ? twins.gzip : null;
  const bodyPath = chosen?.path ?? path;
  const bodyInfo = chosen ?? { size, mtimeMs };
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
