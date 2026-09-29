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
