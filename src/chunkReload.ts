/**
 * After a release, a tab still running the old index.html asks for old hashed chunks that are gone
 * (404). Vite then fires `vite:preloadError` for the failed dynamic import; the page reloads once to
 * pick up the new release (C14). This matters once code splitting exists (whiteboards bring lazy
 * chunks); with one bundle there is nothing to preload yet.
 *
 * Only ONE reload, ever, per failure (review L3): a guard in sessionStorage allows another only after
 * RELOAD_GUARD_MS. When sessionStorage is unavailable (private modes, blocked storage), the reload
 * carries a `?reloaded=1` marker instead, and a page that already has it never reloads again; the
 * marker is removed from the address bar once the app has loaded (`clearReloadMarker`).
 */

export const RELOAD_GUARD_KEY = "mynotes:chunk-reload-at";
export const RELOAD_GUARD_MS = 60_000;
export const RELOAD_MARKER = "reloaded";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** Whether this address already carries the reload marker. */
export const hasReloadMarker = (href: string) => new URL(href).searchParams.get(RELOAD_MARKER) === "1";

/** The address with the marker added (for the reload) or removed (after a successful load). */
export function withReloadMarker(href: string, on: boolean) {
  const url = new URL(href);
  if (on) url.searchParams.set(RELOAD_MARKER, "1");
  else url.searchParams.delete(RELOAD_MARKER);
  return url.toString();
}

/**
 * How to reload now: "reload" (storage recorded the attempt), "marker" (no storage: reload to the
 * marked address), or null (a reload already happened: show the error instead).
 */
export function reloadDecision(storage: Storage | null, href: string, now = Date.now()): "reload" | "marker" | null {
  if (hasReloadMarker(href)) return null;
  try {
    if (!storage) throw new Error("no storage");
    const last = Number(storage.getItem(RELOAD_GUARD_KEY) ?? 0);
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_GUARD_MS) return null;
    storage.setItem(RELOAD_GUARD_KEY, String(now));
    return "reload";
  } catch {
    return "marker";
  }
}

type Target = Pick<Window, "addEventListener"> & { location: Pick<Location, "reload" | "replace" | "href"> ; sessionStorage?: Storage };

let reloading = false;

/** Installs the listener (main.tsx). `event.preventDefault()` keeps Vite from rethrowing while the page reloads. */
export function installChunkReload(target: Target = window as unknown as Target) {
  target.addEventListener("vite:preloadError", (event) => {
    // One reload per page, whatever storage says (several chunks can fail at once).
    if (reloading) { event.preventDefault(); return; }
    let storage: Storage | null = null;
    try { storage = target.sessionStorage ?? null; } catch { storage = null; }
    const decision = reloadDecision(storage, target.location.href);
    if (!decision) return;
    reloading = true;
    event.preventDefault();
    if (decision === "reload") target.location.reload();
    else target.location.replace(withReloadMarker(target.location.href, true));
  });
}

/** Test hook. */
export function resetChunkReloadForTests() {
  reloading = false;
}

/** After the app mounted: drop the marker from the address bar without a new history entry. */
export function clearReloadMarker(history: Pick<History, "replaceState" | "state"> = window.history, href = window.location.href) {
  if (hasReloadMarker(href)) history.replaceState(history.state, "", withReloadMarker(href, false));
}
