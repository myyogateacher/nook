import { cpSync, createReadStream, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// D203: Excalidraw's fonts are self-hosted at /excalidraw/fonts/ (no CDN, font-src 'self').
const excalidrawFontsDir = "node_modules/@excalidraw/excalidraw/dist/prod/fonts";
function excalidrawFonts(): Plugin {
  return {
    name: "nook-excalidraw-fonts",
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
    // Excalidraw appends an esm.sh CDN fallback to every font URL, which the CSP blocks (and reports)
    // even when the self-hosted copy loads. Point the fallback at the self-hosted copy too.
    transform(code, id) {
      if (!id.includes("@excalidraw/excalidraw") || !code.includes("https://esm.sh/")) return null;
      const out = code.replace(/`https:\/\/esm\.sh\/\$\{.*?\}\/dist\/prod\/`/, "`${window.location.origin}/excalidraw/`");
      if (out.includes("https://esm.sh/")) this.error("Excalidraw's esm.sh font fallback changed shape; update the rewrite (D203)");
      return { code: out, map: null };
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
