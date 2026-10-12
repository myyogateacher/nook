import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./ui/ui.css";
import { App } from "./App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { AppToaster } from "./ui/AppToaster";
import { clearReloadMarker, installChunkReload } from "./chunkReload";

// A tab from before a release reloads once when an old lazy chunk is gone (C14).
installChunkReload();

const root = createRoot(document.getElementById("root")!);

// The app is running: the "did not finish loading" note in index.html never shows, and a reload
// marker left by the chunk guard leaves the address bar.
const mounted = () => {
  document.getElementById("boot-fallback")?.remove();
  clearReloadMarker();
};

if (window.location.pathname.startsWith("/share/c/")) {
  // A public chat link (Wave 43, AC-D): its own small page, without the app's session or shell.
  void import("./chat/PublicChat").then(({ PublicChat, publicTokenFrom }) => {
    root.render(
      <StrictMode>
        <ErrorBoundary>
          <PublicChat token={publicTokenFrom(window.location.pathname)} />
        </ErrorBoundary>
      </StrictMode>
    );
    mounted();
  });
} else {
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
      {/* The one toast stack (ui/notify.ts). */}
      <AppToaster />
    </StrictMode>
  );
  mounted();
}
