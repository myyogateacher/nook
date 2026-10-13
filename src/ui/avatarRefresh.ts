import { useSyncExternalStore } from "react";
import { api } from "../api";
import { selfAvatarNow, setSelfAvatar } from "./selfAvatar";

/**
 * A changed picture on screens already open (T353). Nook has no push channel that reaches everyone
 * signed in (the bell polls only the person's own notices; chat streams are per run), so a list keeps
 * the URL it loaded, and a picture changed since is 404 (every change gets a new `?v=`). When an
 * avatar fails to load, the URL is looked up once through an endpoint the viewer may already call:
 * `/api/me/avatar` for their own picture, `/api/team/:id` for anyone else (people who can read Team;
 * guests get 404 there and keep the letters, so nothing new is revealed). The answer is remembered
 * per stale URL, so every avatar on screen with that URL switches to the new one (or to the letters).
 * The server sends avatars `private, no-cache` with an ETag, so the browser revalidates on each new
 * page load: a stale URL reaches the server as a 404 (and this lookup) instead of the HTTP cache.
 */

const PATH = /^\/api\/users\/([0-9a-f-]{36})\/avatar\?v=[0-9a-f-]{36}$/;
/** Stale URL → the current one (null: no picture now, the letters). */
const replaced = new Map<string, string | null>();
/** Stale URLs already looked up (or being looked up): each at most once per page load. */
const tried = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

export type AvatarLookup = {
  self: () => Promise<string | null>;
  member: (userId: string) => Promise<string | null>;
};

const defaultLookup: AvatarLookup = {
  self: async () => (await api<{ avatarUrl: string | null }>("/me/avatar")).avatarUrl,
  member: async (userId) => (await api<{ member: { avatarUrl: string | null } }>(`/team/${encodeURIComponent(userId)}`)).member.avatarUrl
};

/** The URL to draw for `url`: the newest one known after a failed load, else `url` itself. */
export function currentAvatarUrl(url: string | null): string | null {
  let current = url;
  // A picture can change more than once while a page is open; follow a short chain, never a loop.
  for (let hops = 0; current !== null && replaced.has(current) && hops < 5; hops += 1) current = replaced.get(current) ?? null;
  return current;
}

export function useAvatarUrl(url: string | null): string | null {
  useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => version, () => version);
  return currentAvatarUrl(url);
}

/**
 * After `failedUrl` failed to load: looks up the person's current picture once and remembers it.
 * Resolves to the new URL, null for the letters, or undefined when nothing changed (not a Nook
 * avatar URL, already tried, the lookup failed, or the URL is still current).
 */
export async function refreshAvatar(failedUrl: string, lookup: AvatarLookup = defaultLookup): Promise<string | null | undefined> {
  const match = PATH.exec(failedUrl);
  if (!match || tried.has(failedUrl)) return undefined;
  tried.add(failedUrl);
  const own = selfAvatarNow() === failedUrl;
  let next: string | null;
  try {
    next = own ? await lookup.self() : await lookup.member(match[1]!);
  } catch {
    return undefined;
  }
  if (next !== null && !PATH.test(next)) next = null;
  if (next === failedUrl) return undefined;
  replaced.set(failedUrl, next);
  if (own) setSelfAvatar(next);
  version += 1;
  for (const listener of listeners) listener();
  return next;
}

/** Test hook. */
export function resetAvatarRefresh() {
  replaced.clear();
  tried.clear();
  version += 1;
}
