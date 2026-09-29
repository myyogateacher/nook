import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./ui/ui.css";
import { App } from "./App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { clearReloadMarker, installChunkReload } from "./chunkReload";

// A tab from before a release reloads once when an old lazy chunk is gone (C14).
installChunkReload();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);

// The app is running: the "did not finish loading" note in index.html never shows, and a reload
// marker left by the chunk guard leaves the address bar.
document.getElementById("boot-fallback")?.remove();
clearReloadMarker();
