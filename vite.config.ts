import { cpSync, createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// D203: Excalidraw's fonts are self-hosted at /excalidraw/fonts/ (no CDN, font-src 'self').
const excalidrawFontsDir = "node_modules/@excalidraw/excalidraw/dist/prod/fonts";
function excalidrawFonts(): Plugin {
  // Review L6: a production build must apply both rewrites at least once, or it fails.
  let building = false;
  const applied = { fontFallback: 0, copyAsSvg: 0, addToLibrary: 0, imageTool: 0, helpHeader: 0, dialogClose: 0 };
  return {
    name: "nook-excalidraw-fonts",
    configResolved(config) {
      building = config.command === "build";
    },
    configureServer(server) {
      server.middlewares.use("/excalidraw/fonts", (req, res, next) => {
        const path = normalize(decodeURIComponent(req.url?.split("?")[0] ?? ""));
        if (path.includes("..") || !path.endsWith(".woff2")) return next();
        const file = join(excalidrawFontsDir, path);
        if (!existsSync(file)) return next();
        res.setHeader("Content-Type", "font/woff2");
        createReadStream(file).pipe(res);
      });
    },
    transform(code, id) {
      if (!id.includes("@excalidraw/excalidraw")) return null;
      let out = code;
      // Excalidraw appends an esm.sh CDN fallback to every font URL, which the CSP blocks (and reports)
      // even when the self-hosted copy loads. Point the fallback at the self-hosted copy too.
      if (out.includes("https://esm.sh/")) {
        out = out.replace(/`https:\/\/esm\.sh\/\$\{.*?\}\/dist\/prod\/`/, "`${window.location.origin}/excalidraw/`");
        if (out.includes("https://esm.sh/")) this.error("Excalidraw's esm.sh font fallback changed shape; update the rewrite (D203)");
        applied.fontFallback += 1;
      }
      // D201 and the spike result: SVG export inlines fonts through a subsetting chunk that calls
      // Function(), which the CSP refuses. The export dialog is off (UIOptions), so the one way in is
      // "Copy to clipboard as SVG" (context menu and command palette): its predicate is made false.
      const copyAsSvg = /name:\s*"copyAsSvg"/.exec(out);
      if (copyAsSvg) {
        const at = out.indexOf("predicate:", copyAsSvg.index);
        const next = out.slice(copyAsSvg.index, at).search(/name:\s*"copyAsPng"/);
        if (at < 0 || next >= 0 || at - copyAsSvg.index > 4000) this.error("Excalidraw's copyAsSvg action changed shape; update the rewrite (D201)");
        out = `${out.slice(0, at)}predicate:()=>false,nookHiddenPredicate:${out.slice(at + "predicate:".length)}`;
        applied.copyAsSvg += 1;
      }
      // QA Q4: no library actions ("Add to library" in the context menu and command palette).
      if (/name:\s*"addToLibrary",/.test(out)) {
        out = out.replace(/name:\s*"addToLibrary",/, 'name:"addToLibrary",predicate:()=>false,');
        applied.addToLibrary += 1;
      }
      // Wave 24 (D198, the spike's CSP finding): Excalidraw's own image tool opens a file picker and
      // resizes the picture with pica/image-blob-reduce, which try WebAssembly.compile under a CSP
      // without 'wasm-unsafe-eval', and it would embed the picture as a dataURL. The tool (toolbar,
      // shortcut 9, command palette) instead asks Nook's canvas to open its own image picker, which
      // stores the picture as a File and places a reference. Production build only.
      const imageTool = /([A-Za-z_$][\w$]*)\.type==="image"&&this\.onImageAction\(\{insertOnCanvasDirectly:\(([A-Za-z_$][\w$]*)\.type==="image"&&\2\.insertOnCanvasDirectly\)\?\?!1\}\)/;
      if (imageTool.test(out)) {
        out = out.replace(imageTool, '$1.type==="image"&&void window.dispatchEvent(new CustomEvent("nook:excalidraw-image"))');
        applied.imageTool += 1;
      }
      // QA E3: Help's header is only links that leave Nook (docs, blog, GitHub, YouTube). It is not
      // rendered at all: hidden with CSS, its links stayed first in the focus order, so the dialog
      // took no focus and Escape did nothing.
      const helpHeader = /var ([A-Za-z_$][\w$]*)=\(\)=>([A-Za-z_$][\w$]*)\("div",\{className:"HelpDialog__header"/;
      if (helpHeader.test(out)) {
        out = out.replace(helpHeader, 'var $1=()=>null,nookUnusedHelpHeader=()=>$2("div",{className:"HelpDialog__header"');
        applied.helpHeader += 1;
      }
      // QA E3: Excalidraw draws a dialog's close button only full screen (phones); desktop gets it too.
      const dialogClose = /[A-Za-z_$][\w$]*&&([A-Za-z_$][\w$]*\("button",\{className:"Dialog__close")/;
      if (dialogClose.test(out)) {
        out = out.replace(dialogClose, "$1");
        applied.dialogClose += 1;
      }
      return out === code ? null : { code: out, map: null };
    },
    buildEnd(error) {
      if (!building || error) return;
      if (applied.fontFallback === 0) this.error("Excalidraw's esm.sh font fallback was never rewritten; update the rewrite (D203)");
      if (applied.copyAsSvg === 0) this.error("Excalidraw's copyAsSvg action was never patched; update the rewrite (D201)");
      if (applied.addToLibrary === 0) this.error("Excalidraw's addToLibrary action was never patched; update the rewrite (QA Q4)");
      if (applied.imageTool === 0) this.error("Excalidraw's image tool was never routed to Nook's picker; update the rewrite (D198)");
      if (applied.helpHeader === 0) this.error("Excalidraw's Help header was never removed; update the rewrite (QA E3)");
      if (applied.dialogClose === 0) this.error("Excalidraw's dialog close button was never patched; update the rewrite (QA E3)");
    },
    writeBundle(options) {
      cpSync(excalidrawFontsDir, join(options.dir ?? "dist", "excalidraw/fonts"), { recursive: true });
    }
  };
}

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
  // Order matters: the Excalidraw patches run while modules are transformed, the fonts are copied
  // when the bundle is written, and precompress runs last (closeBundle), so the .br and .gz twins
  // are made from the patched chunks. Fonts (woff2) are already compressed and are left alone.
  plugins: [react(), tailwindcss(), excalidrawFonts(), precompress()],
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
