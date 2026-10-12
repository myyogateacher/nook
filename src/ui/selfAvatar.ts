import { useSyncExternalStore } from "react";

/**
 * The signed-in person's picture URL (Wave 35, QA U4), set by the app shell from `/api/auth/me` and
 * read by every header, sidebar footer, and Settings, without threading a prop through each app.
 * Settings → Profile picture (U7) sets it too, so a new picture shows everywhere at once.
 */
let current: string | null = null;
let known = false;
const listeners = new Set<() => void>();

export function setSelfAvatar(url: string | null | undefined) {
  const next = url ?? null;
  known = true;
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

/** The picture URL; `fallback` (the session's) until the shell has set one, so the first paint shows it. */
export function useSelfAvatar(fallback?: string | null) {
  const value = useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => current, () => current);
  return known || fallback === undefined ? value : fallback;
}
