import { useSyncExternalStore } from "react";

/**
 * The signed-in person's picture URL (Wave 35, QA U4), set by the app shell from `/api/auth/me` and
 * read by every header, sidebar footer, and Settings, without threading a prop through each app.
 */
let current: string | null = null;
const listeners = new Set<() => void>();

export function setSelfAvatar(url: string | null | undefined) {
  const next = url ?? null;
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function useSelfAvatar() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => current, () => current);
}
