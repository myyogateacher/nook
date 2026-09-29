import { cpSync, createReadStream, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// D203: Excalidraw's fonts are self-hosted at /excalidraw/fonts/ (no CDN, font-src 'self').
const excalidrawFontsDir = "node_modules/@excalidraw/excalidraw/dist/prod/fonts";
function excalidrawFonts(): Plugin {
  // Review L6: a production build must apply both rewrites at least once, or it fails.
  let building = false;
  const applied = { fontFallback: 0, copyAsSvg: 0 };
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
      return out === code ? null : { code: out, map: null };
    },
    buildEnd(error) {
      if (!building || error) return;
      if (applied.fontFallback === 0) this.error("Excalidraw's esm.sh font fallback was never rewritten; update the rewrite (D203)");
      if (applied.copyAsSvg === 0) this.error("Excalidraw's copyAsSvg action was never patched; update the rewrite (D201)");
    },
    writeBundle(options) {
      cpSync(excalidrawFontsDir, join(options.dir ?? "dist", "excalidraw/fonts"), { recursive: true });
    }
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), excalidrawFonts()],
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
