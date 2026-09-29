import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Kept in step with COMPRESSIBLE in server/staticFiles.ts: images, fonts, and wasm are left alone. */
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".map", ".webmanifest", ".svg", ".txt", ".xml"]);

/**
 * Writes `.br` and `.gz` twins of every compressible file in the build output (C14), so the server
 * sends them without compressing at request time. A twin is kept only when it is smaller.
 */
function precompress(): Plugin {
  let outDir = "dist";
  return {
    name: "nook-precompress",
    apply: "build",
    configResolved(config) { outDir = config.build.outDir; },
    closeBundle() {
      const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
      for (const path of walk(outDir)) {
        if (!COMPRESSIBLE.has(extname(path).toLowerCase())) continue;
        const source = readFileSync(path);
        if (source.length < 256) continue;
        const brotli = brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: source.length } });
        if (brotli.length < source.length) writeFileSync(`${path}.br`, brotli);
        const gzip = gzipSync(source, { level: 9 });
        if (gzip.length < source.length) writeFileSync(`${path}.gz`, gzip);
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precompress()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:2026"
    }
  },
  build: {
    outDir: "dist",
    sourcemap: false
  }
});
