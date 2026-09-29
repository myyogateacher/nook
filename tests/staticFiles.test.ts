import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { IMMUTABLE, isHashedAsset, negotiateEncoding, parseRange, REVALIDATE, serveStaticFile } from "../server/staticFiles";

/**
 * C14: production static files. Hashed assets are cached for a year, everything else revalidates
 * (ETag, Last-Modified, 304), precompressed br/gzip twins are negotiated with Vary and the original
 * Content-Type, fonts and images are never compressed, ranges and HEAD work, unknown client routes
 * get index.html, and nothing outside the dist directory is ever served.
 */

const root = mkdtempSync(join(tmpdir(), "nook-dist-"));
const outsideFile = join(root, "..", `outside-${root.split("/").pop()}.txt`);
afterAll(() => { rmSync(root, { recursive: true, force: true }); rmSync(outsideFile, { force: true }); });
mkdirSync(join(root, "assets"));
const script = "export const answer = 42;\n".repeat(200);
const html = `<!doctype html><title>Nook</title>${"<!-- padding -->".repeat(50)}`;
writeFileSync(join(root, "index.html"), html);
writeFileSync(join(root, "index.html.br"), brotliCompressSync(html));
writeFileSync(join(root, "index.html.gz"), gzipSync(html));
writeFileSync(join(root, "assets", "index-BvuYDGo0.js"), script);
writeFileSync(join(root, "assets", "index-BvuYDGo0.js.br"), brotliCompressSync(script));
writeFileSync(join(root, "assets", "index-BvuYDGo0.js.gz"), gzipSync(script));
writeFileSync(join(root, "assets", "inter-Ab12Cd34.woff2"), Buffer.alloc(2048, 1));
writeFileSync(join(root, "sw.js"), "self.addEventListener('push', () => {});\n");
writeFileSync(join(root, "manifest.webmanifest"), JSON.stringify({ name: "Nook" }));
// A file outside the root that traversal would reach.
writeFileSync(outsideFile, "outside");

const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  serveStaticFile(new Request(`http://localhost${path}`, { method, headers }), path, root).then((response) => response!);

describe("cache headers", () => {
  test("a hashed asset is immutable for a year", async () => {
    const response = await get("/assets/index-BvuYDGo0.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(IMMUTABLE);
    expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("ETag")).toBeTruthy();
    expect(await response.text()).toBe(script);
  });

  test("index.html, the service worker, and the manifest revalidate every time", async () => {
    for (const path of ["/index.html", "/", "/sw.js", "/manifest.webmanifest"]) {
      const response = await get(path);
      expect(response.headers.get("Cache-Control")).toBe(REVALIDATE);
      expect(response.headers.get("ETag")).toMatch(/^"[a-z0-9-]+"$/);
      expect(response.headers.get("Last-Modified")).toBeTruthy();
    }
    expect((await get("/")).headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect((await get("/manifest.webmanifest")).headers.get("Content-Type")).toBe("application/manifest+json; charset=utf-8");
  });

  test("a font is immutable under /assets/ and never compressed", async () => {
    const response = await get("/assets/inter-Ab12Cd34.woff2", { "Accept-Encoding": "br, gzip" });
    expect(response.headers.get("Cache-Control")).toBe(IMMUTABLE);
    expect(response.headers.get("Content-Type")).toBe("font/woff2");
    expect(response.headers.get("Content-Encoding")).toBeNull();
    expect(response.headers.get("Vary")).toBeNull();
    expect((await response.arrayBuffer()).byteLength).toBe(2048);
  });

  test("only Vite-style hashed names under /assets/ count as hashed", () => {
    expect(isHashedAsset("/assets/index-BvuYDGo0.js")).toBe(true);
    expect(isHashedAsset("/assets/logo.svg")).toBe(false);
    expect(isHashedAsset("/index-BvuYDGo0.js")).toBe(false);
    expect(isHashedAsset("/sw.js")).toBe(false);
  });
});

describe("compression", () => {
  test("br when accepted, then gzip, else the plain file; q=0 refuses; Vary and Content-Type stay", async () => {
    const cases: Array<[string | undefined, string | null]> = [
      ["br, gzip", "br"], ["gzip, deflate, br", "br"], ["gzip", "gzip"], ["br;q=0, gzip", "gzip"], ["br;q=0, gzip;q=0", null],
      ["identity", null], [undefined, null], ["*", "br"], ["*;q=0, gzip", "gzip"]
    ];
    for (const [accept, expected] of cases) {
      const response = await get("/assets/index-BvuYDGo0.js", accept === undefined ? {} : { "Accept-Encoding": accept });
      expect({ accept, encoding: response.headers.get("Content-Encoding") }).toEqual({ accept, encoding: expected });
      expect(response.headers.get("Vary")).toBe("Accept-Encoding");
      expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
      const body = Buffer.from(await response.arrayBuffer());
      const plain = expected === "br" ? (await import("node:zlib")).brotliDecompressSync(body).toString() : expected === "gzip" ? (await import("node:zlib")).gunzipSync(body).toString() : body.toString();
      expect(plain).toBe(script);
    }
  });

  test("each encoding has its own ETag", async () => {
    const tags = new Set<string | null>();
    for (const accept of ["br", "gzip", "identity"]) tags.add((await get("/assets/index-BvuYDGo0.js", { "Accept-Encoding": accept })).headers.get("ETag"));
    expect(tags.size).toBe(3);
  });

  test("the negotiation helper", () => {
    expect(negotiateEncoding("br", { br: false, gzip: true })).toBe("identity");
    expect(negotiateEncoding("br, gzip", { br: false, gzip: true })).toBe("gzip");
    expect(negotiateEncoding("gzip;q=0.5, br;q=0.1", { br: true, gzip: true })).toBe("br");
    expect(negotiateEncoding("", { br: true, gzip: true })).toBe("identity");
  });
});

describe("conditional requests, HEAD, and ranges", () => {
  test("If-None-Match answers 304 with the validators and no body", async () => {
    const first = await get("/assets/index-BvuYDGo0.js", { "Accept-Encoding": "br" });
    const etag = first.headers.get("ETag")!;
    const again = await get("/assets/index-BvuYDGo0.js", { "Accept-Encoding": "br", "If-None-Match": etag });
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(etag);
    expect(again.headers.get("Cache-Control")).toBe(IMMUTABLE);
    expect(await again.text()).toBe("");
    // Another encoding's tag does not match.
    expect((await get("/assets/index-BvuYDGo0.js", { "Accept-Encoding": "gzip", "If-None-Match": etag })).status).toBe(200);
    const index = await get("/");
    expect((await get("/", { "If-None-Match": `W/${index.headers.get("ETag")}` })).status).toBe(304);
    expect((await get("/", { "If-Modified-Since": new Date(Date.now() + 60_000).toUTCString() })).status).toBe(304);
  });

  test("HEAD sends the headers without a body", async () => {
    const response = await get("/assets/index-BvuYDGo0.js", {}, "HEAD");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(Buffer.byteLength(script)));
    expect(await response.text()).toBe("");
    expect(await serveStaticFile(new Request("http://localhost/", { method: "POST" }), "/", root)).toBeNull();
  });

  test("a byte range is served from the plain file; an unsatisfiable one is 416", async () => {
    const part = await get("/assets/index-BvuYDGo0.js", { Range: "bytes=0-9", "Accept-Encoding": "br" });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe(`bytes 0-9/${Buffer.byteLength(script)}`);
    expect(part.headers.get("Content-Encoding")).toBeNull();
    expect(await part.text()).toBe(script.slice(0, 10));
    const tail = await get("/assets/index-BvuYDGo0.js", { Range: "bytes=-5" });
    expect(await tail.text()).toBe(script.slice(-5));
    expect((await get("/assets/index-BvuYDGo0.js", { Range: "bytes=999999-" })).status).toBe(416);
    expect(parseRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("items=0-1", 10)).toBeNull();
  });
});

describe("paths", () => {
  test("an unknown client route gets index.html with no-cache; a missing asset is a real 404", async () => {
    const route = await get("/tasks/1234/card/5678");
    expect(route.status).toBe(200);
    expect(route.headers.get("Cache-Control")).toBe(REVALIDATE);
    expect(route.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await route.text()).toBe(html);
    const missing = await get("/assets/missing-AbCdEf12.js");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });

  test("path traversal is refused, encoded or not", async () => {
    const outside = `outside-${root.split("/").pop()}.txt`;
    for (const path of [`/../${outside}`, `/%2e%2e/${outside}`, `/assets/..%2f..%2f${outside}`, `/assets/%2e%2e%2f%2e%2e%2f${outside}`, `/..%5c${outside}`, "/%00index.html", "/./index.html", "/%E0%A4%A"]) {
      const response = await get(path);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      expect(await response.text()).not.toContain("outside");
    }
  });
});

describe("hardening (C14 second pass)", () => {
  test("the service worker and the manifest: no-cache, their own Content-Types, never immutable", async () => {
    const worker = await get("/sw.js", { "Accept-Encoding": "br" });
    expect(worker.headers.get("Cache-Control")).toBe(REVALIDATE);
    expect(worker.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    const manifest = await get("/manifest.webmanifest");
    expect(manifest.headers.get("Cache-Control")).toBe(REVALIDATE);
    expect(manifest.headers.get("Content-Type")).toBe("application/manifest+json; charset=utf-8");
    // Served from the root, the worker's default scope is "/": no Service-Worker-Allowed is needed.
    expect(worker.headers.get("Service-Worker-Allowed")).toBeNull();
  });

  test("odd Accept-Encoding headers: many entries, identity;q=0, and junk q-values", async () => {
    const long = `${Array.from({ length: 500 }, (_, index) => `x${index};q=0.${index % 10}`).join(", ")}, br`;
    // The br at the end lies past the first 32 entries: ignored, so the plain file is sent, quickly.
    const started = performance.now();
    expect((await get("/assets/index-BvuYDGo0.js", { "Accept-Encoding": long })).headers.get("Content-Encoding")).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);
    expect(negotiateEncoding("identity;q=0", { br: false, gzip: false })).toBe("identity");
    expect(negotiateEncoding("identity;q=0, gzip", { br: true, gzip: true })).toBe("gzip");
    expect(negotiateEncoding("br;q=abc, gzip;q=", { br: true, gzip: true })).toBe("identity");
  });

  test("HEAD on a precompressed file sends that representation's headers; a Range is served from the plain file", async () => {
    const head = await get("/assets/index-BvuYDGo0.js", { "Accept-Encoding": "br" }, "HEAD");
    expect(head.headers.get("Content-Encoding")).toBe("br");
    expect(head.headers.get("Content-Length")).toBe(String(brotliCompressSync(script).length));
    expect(await head.text()).toBe("");
    const range = await get("/assets/index-BvuYDGo0.js", { "Accept-Encoding": "br, gzip", Range: "bytes=5-9" });
    expect(range.status).toBe(206);
    expect(range.headers.get("Content-Encoding")).toBeNull();
    expect(await range.text()).toBe(script.slice(5, 10));
  });

  test("double-encoded, very long, and dotfile paths are refused or never reach a file", async () => {
    writeFileSync(join(root, ".env"), "SECRET=1");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "[core]");
    for (const path of ["/.env", "/%2eenv", "/.git/config", "/assets/.hidden", `/${"a".repeat(1100)}`]) {
      const response = await get(path);
      expect({ path: path.slice(0, 40), status: response.status }).toEqual({ path: path.slice(0, 40), status: 404 });
    }
    // Decoded once: "%252e%252e" is the literal name "%2e%2e", a client route, never a parent directory.
    const double = await get(`/%252e%252e/outside-${root.split("/").pop()}.txt`);
    expect(await double.text()).not.toContain("outside");
  });

  test("symlinks inside dist are followed only while they stay inside it", async () => {
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outsideFile, join(root, "leak.txt"));
    symlinkSync(join(root, "sw.js"), join(root, "alias.js"));
    // A twin that points outside is ignored: the plain file is sent instead.
    writeFileSync(join(root, "plain.txt"), "plain ".repeat(100));
    symlinkSync(outsideFile, join(root, "plain.txt.br"));
    // The outside link is not a file here: the path falls back to index.html, never the outside text.
    expect(await (await get("/leak.txt")).text()).toBe(html);
    expect(await (await get("/alias.js")).text()).toContain("addEventListener('push'");
    const plain = await get("/plain.txt", { "Accept-Encoding": "br" });
    expect(plain.headers.get("Content-Encoding")).toBeNull();
    expect(await plain.text()).toBe("plain ".repeat(100));
  });
});

describe("reload once after a release (C14)", () => {
  test("a failed chunk reloads the page once, and not again within the guard", async () => {
    const { RELOAD_GUARD_KEY, RELOAD_GUARD_MS, shouldReloadForChunk, installChunkReload } = await import("../src/chunkReload");
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    expect(shouldReloadForChunk(storage, 1_000_000)).toBe(true);
    expect(store.get(RELOAD_GUARD_KEY)).toBe("1000000");
    expect(shouldReloadForChunk(storage, 1_000_000 + 5_000)).toBe(false);
    expect(shouldReloadForChunk(storage, 1_000_000 + RELOAD_GUARD_MS + 1)).toBe(true);
    // Storage that throws (private mode) still allows the one reload.
    expect(shouldReloadForChunk({ getItem: () => { throw new Error("denied"); }, setItem: () => undefined })).toBe(true);
    // The listener reloads and keeps Vite from rethrowing; a second error inside the guard does neither.
    let handler: ((event: { preventDefault: () => void }) => void) | null = null;
    let reloads = 0;
    let prevented = 0;
    const session = new Map<string, string>();
    installChunkReload({ addEventListener: ((_name: string, listener: never) => { handler = listener; }) as never, location: { reload: () => { reloads += 1; } } as never,
      sessionStorage: { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => { session.set(key, value); } } as never });
    handler!({ preventDefault: () => { prevented += 1; } });
    handler!({ preventDefault: () => { prevented += 1; } });
    expect({ reloads, prevented }).toEqual({ reloads: 1, prevented: 1 });
    const main = await Bun.file(new URL("../src/main.tsx", import.meta.url)).text();
    expect(main).toContain("installChunkReload();");
  });
});
