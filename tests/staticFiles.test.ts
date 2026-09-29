import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { IMMUTABLE, ifRangeMatches, isHashedAsset, negotiateEncoding, parseRange, REVALIDATE, serveStaticFile } from "../server/staticFiles";

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
      expect(response.headers.get("ETag")).toMatch(/^"[A-Za-z0-9_-]{22}"$/);
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
    // The outside link is not a file here: a missing file with an extension, so 404, never the outside text.
    const leak = await get("/leak.txt");
    expect(leak.status).toBe(404);
    expect(await leak.text()).not.toContain("outside");
    expect(await (await get("/alias.js")).text()).toContain("addEventListener('push'");
    const plain = await get("/plain.txt", { "Accept-Encoding": "br" });
    expect(plain.headers.get("Content-Encoding")).toBeNull();
    expect(await plain.text()).toBe("plain ".repeat(100));
  });
});

describe("review fixes (L1, L2, L5)", () => {
  test("L1: ETags come from the content: equal size and mtime, different bytes, different ETags", async () => {
    const { utimesSync } = await import("node:fs");
    const second = mkdtempSync(join(tmpdir(), "nook-dist-b-"));
    try {
      writeFileSync(join(second, "index.html"), html.replace("Nook", "Kood"));
      const when = new Date("2026-01-01T00:00:00Z");
      utimesSync(join(root, "index.html"), when, when);
      utimesSync(join(second, "index.html"), when, when);
      const a = await get("/index.html");
      const b = await serveStaticFile(new Request("http://localhost/index.html"), "/index.html", second);
      expect(a.headers.get("Last-Modified")).toBe(b!.headers.get("Last-Modified"));
      expect(a.headers.get("ETag")).not.toBe(b!.headers.get("ETag"));
      // Stable for the same bytes.
      expect((await get("/index.html")).headers.get("ETag")).toBe(a.headers.get("ETag"));
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("L2: If-Range keeps the range only when it names the current file", async () => {
    const whole = await get("/assets/index-BvuYDGo0.js");
    const etag = whole.headers.get("ETag")!;
    const modified = whole.headers.get("Last-Modified")!;
    expect((await get("/assets/index-BvuYDGo0.js", { Range: "bytes=0-4", "If-Range": etag })).status).toBe(206);
    expect((await get("/assets/index-BvuYDGo0.js", { Range: "bytes=0-4", "If-Range": modified })).status).toBe(206);
    for (const stale of ['"old-tag"', `W/${etag}`, "Wed, 01 Jan 2020 00:00:00 GMT", "not a date"]) {
      const response = await get("/assets/index-BvuYDGo0.js", { Range: "bytes=0-4", "If-Range": stale });
      expect({ stale, status: response.status }).toEqual({ stale, status: 200 });
      expect(await response.text()).toBe(script);
    }
    expect(ifRangeMatches(null, etag, 0)).toBe(true);
  });

  test("L5: a 416 claims no type; a missing file with an extension is 404; client routes still get the app", async () => {
    const unsatisfiable = await get("/assets/index-BvuYDGo0.js", { Range: "bytes=999999-" });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("Content-Type")).toBeNull();
    for (const path of ["/nonsense.png", "/favicon.ico", "/robots.txt", "/deep/path/file.js"]) {
      const response = await get(path);
      expect({ path, status: response.status, type: response.headers.get("Content-Type") }).toEqual({ path, status: 404, type: "text/plain; charset=utf-8" });
    }
    for (const path of ["/notes", "/team/policies", "/calendar/month/2026-09"]) expect(await (await get(path)).text()).toBe(html);
  });

  test("the app ships a robots.txt that disallows everything (a private app)", async () => {
    const robots = await Bun.file(new URL("../public/robots.txt", import.meta.url)).text();
    expect(robots).toContain("User-agent: *");
    expect(robots).toContain("Disallow: /");
  });
});

describe("reload once after a release (C14, review L3)", () => {
  test("with sessionStorage: one reload, then none within the guard", async () => {
    const { RELOAD_GUARD_KEY, RELOAD_GUARD_MS, reloadDecision } = await import("../src/chunkReload");
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    expect(reloadDecision(storage, "https://nook.test/notes", 1_000_000)).toBe("reload");
    expect(store.get(RELOAD_GUARD_KEY)).toBe("1000000");
    expect(reloadDecision(storage, "https://nook.test/notes", 1_000_000 + 5_000)).toBeNull();
    expect(reloadDecision(storage, "https://nook.test/notes", 1_000_000 + RELOAD_GUARD_MS + 1)).toBe("reload");
  });

  test("without sessionStorage: one reload to a marked address, never a second, and the marker is cleared after load", async () => {
    const { clearReloadMarker, reloadDecision, withReloadMarker, installChunkReload, resetChunkReloadForTests } = await import("../src/chunkReload");
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(reloadDecision(null, "https://nook.test/notes?q=x", 1)).toBe("marker");
    expect(reloadDecision(throwing, "https://nook.test/notes", 1)).toBe("marker");
    const marked = withReloadMarker("https://nook.test/notes?q=x", true);
    expect(marked).toBe("https://nook.test/notes?q=x&reloaded=1");
    // The reloaded page fails again: no second reload, the error shows instead.
    expect(reloadDecision(null, marked, 2)).toBeNull();
    expect(reloadDecision(throwing, marked, 2)).toBeNull();
    // After a successful load the marker leaves the address bar, in place.
    const replaced: string[] = [];
    clearReloadMarker({ state: { keep: 1 }, replaceState: (_state: unknown, _title: string, url?: string | URL | null) => { replaced.push(String(url)); } }, marked);
    expect(replaced).toEqual(["https://nook.test/notes?q=x"]);
    // The listener: one navigation per page even when several chunks fail at once.
    resetChunkReloadForTests();
    let handler: ((event: { preventDefault: () => void }) => void) | null = null;
    const calls: string[] = [];
    installChunkReload({ addEventListener: ((_name: string, listener: never) => { handler = listener; }) as never,
      location: { href: "https://nook.test/notes", reload: () => { calls.push("reload"); }, replace: (url: string) => { calls.push(`replace ${url}`); } } as never });
    handler!({ preventDefault: () => undefined });
    handler!({ preventDefault: () => undefined });
    expect(calls).toEqual(["replace https://nook.test/notes?reloaded=1"]);
    resetChunkReloadForTests();
  });

  test("the app entry installs the guard, clears the marker, and removes the boot fallback; index.html has one without inline script", async () => {
    const main = await Bun.file(new URL("../src/main.tsx", import.meta.url)).text();
    expect(main).toContain("installChunkReload();");
    expect(main).toContain("clearReloadMarker();");
    expect(main).toContain('document.getElementById("boot-fallback")?.remove();');
    const index = await Bun.file(new URL("../index.html", import.meta.url)).text();
    expect(index).toContain('id="boot-fallback"');
    expect(index).toContain("<noscript>");
    expect(index).toContain("animation: boot-fallback-show 0s linear 8s forwards");
    // The only script is the module entry: nothing inline for the CSP to refuse.
    expect(index.match(/<script\b[^>]*>/g)).toEqual(['<script type="module" src="/src/main.tsx">']);
  });
});
