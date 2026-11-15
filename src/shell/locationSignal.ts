import { useSyncExternalStore } from "react";

/**
 * The address on screen, for the sidebar's current section (D1282). Apps move the address in many
 * places (App's navigate, Tasks' and Collections' own replaceState calls, Goals' period), so the
 * signal wraps `history.pushState` / `replaceState` once and tells subscribers after each write, as
 * Back and Forward (popstate) do. It only reads: nothing here changes where anyone goes.
 */

const listeners = new Set<() => void>();
let installed = false;
let queued = false;

function notify() {
  if (queued) return;
  queued = true;
  // After the write's own handler finishes (a write inside a render must not set state there).
  queueMicrotask(() => { queued = false; for (const listener of [...listeners]) listener(); });
}

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const history = window.history;
  for (const name of ["pushState", "replaceState"] as const) {
    const original = history[name];
    history[name] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      notify();
      return result;
    };
  }
  window.addEventListener("popstate", notify);
}

function subscribe(listener: () => void) {
  install();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const snapshot = () => typeof window === "undefined" ? "" : `${window.location.pathname}${window.location.search}`;

/** The path and query on screen, following every history write. */
export function useLocationHref() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** `/contacts/deals?book=x` → its path and query. */
export function splitHref(href: string) {
  const at = href.indexOf("?");
  return at < 0 ? { pathname: href, search: "" } : { pathname: href.slice(0, at), search: href.slice(at) };
}

/**
 * Sent after the sidebar moved the app on screen to another of its own sections (D1282): the app
 * reads the address again, as on Back and Forward, without remounting (Tasks keeps its loaded lists).
 */
export const SHELL_ROUTE_EVENT = "nook:shell-route";
export const announceShellRoute = () => { window.dispatchEvent(new Event(SHELL_ROUTE_EVENT)); };
