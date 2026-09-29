/**
 * After a release, a tab still running the old index.html asks for old hashed chunks that are gone
 * (404). Vite then fires `vite:preloadError` for the failed dynamic import; the page reloads once to
 * pick up the new release (C14). A guard in sessionStorage stops a reload loop: another reload is
 * allowed only after RELOAD_GUARD_MS, so a chunk that is really missing shows the error instead.
 */

export const RELOAD_GUARD_KEY = "mynotes:chunk-reload-at";
export const RELOAD_GUARD_MS = 60_000;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** Whether to reload now; records the attempt when it says yes. Storage errors allow one reload. */
export function shouldReloadForChunk(storage: Storage | null, now = Date.now()) {
  try {
    const last = Number(storage?.getItem(RELOAD_GUARD_KEY) ?? 0);
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_GUARD_MS) return false;
    storage?.setItem(RELOAD_GUARD_KEY, String(now));
    return true;
  } catch {
    return true;
  }
}

/** Installs the listener (main.tsx). `event.preventDefault()` keeps Vite from rethrowing while the page reloads. */
export function installChunkReload(target: Pick<Window, "addEventListener" | "location" | "sessionStorage"> = window) {
  target.addEventListener("vite:preloadError", (event) => {
    let storage: Storage | null = null;
    try { storage = target.sessionStorage; } catch { storage = null; }
    if (!shouldReloadForChunk(storage)) return;
    event.preventDefault();
    target.location.reload();
  });
}
