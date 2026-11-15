import { useEffect, useState } from "react";
import { listCollections } from "../collections/collectionsApi";
import { listBoards } from "../tasks/tasksApi";
import { NAV_RECENT_LIMIT, type NavRecent } from "./navModel";

/**
 * Recent boards and collections for the sidebar (D1282). Opening a board or a collection records it
 * in this browser (localStorage, per person, newest first, at most 8; names and ids only). While
 * Tasks or Collections is on screen the sidebar also reads the list it can open (the same request
 * the page makes), so a deleted or unshared item drops out, a rename shows, and a first visit is
 * filled with the most recently updated ones. No server change.
 */

export type RecentKind = "tasks" | "collections";
type Listed = { id: string; name: string; updated_at: string };

const RECENTS_EVENT = "nook:recents";
const storageKey = (kind: RecentKind, userId: string) => `nook.recent.${kind}.${userId}`;

function read(kind: RecentKind, userId: string): NavRecent[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey(kind, userId)) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => item && typeof item === "object" && typeof item.id === "string" && typeof item.name === "string" && typeof item.href === "string" && item.href.startsWith("/")
      ? [{ id: item.id, name: item.name, href: item.href }] : []).slice(0, NAV_RECENT_LIMIT);
  } catch {
    return [];
  }
}

function write(kind: RecentKind, userId: string, items: readonly NavRecent[]) {
  try { window.localStorage.setItem(storageKey(kind, userId), JSON.stringify(items.slice(0, NAV_RECENT_LIMIT))); } catch { /* private mode: this visit only */ }
}

/** A board or collection was opened: it moves to the top of its list. */
export function recordRecent(kind: RecentKind, userId: string, item: NavRecent) {
  if (typeof window === "undefined" || !userId) return;
  const current = read(kind, userId);
  const next = [item, ...current.filter((entry) => entry.id !== item.id)];
  if (current[0]?.id === item.id && current[0].name === item.name && current[0].href === item.href) return;
  write(kind, userId, next);
  // A board made a moment ago is not in the list read before it: read the list again.
  const cached = listCache.get(kind);
  if (cached && !cached.items.some((entry) => entry.id === item.id)) listCache.delete(kind);
  window.dispatchEvent(new CustomEvent(RECENTS_EVENT, { detail: { kind } }));
}

/** The recents, checked against the list that can be opened and filled from it by last update. */
export function mergeRecents(stored: readonly NavRecent[], listed: readonly Listed[] | null, hrefFor: (id: string) => string): NavRecent[] {
  if (!listed) return stored.slice(0, NAV_RECENT_LIMIT);
  const byId = new Map(listed.map((item) => [item.id, item]));
  const kept = stored.flatMap((item) => { const found = byId.get(item.id); return found ? [{ ...item, name: found.name }] : []; });
  const fill = [...listed].filter((item) => !kept.some((entry) => entry.id === item.id))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map((item) => ({ id: item.id, name: item.name, href: hrefFor(item.id) }));
  return [...kept, ...fill].slice(0, NAV_RECENT_LIMIT);
}

const listCache = new Map<RecentKind, { at: number; items: Listed[] }>();
const LIST_FRESH_MS = 60_000;

async function loadList(kind: RecentKind): Promise<Listed[]> {
  const cached = listCache.get(kind);
  if (cached && Date.now() - cached.at < LIST_FRESH_MS) return cached.items;
  const items: Listed[] = kind === "tasks" ? (await listBoards()).boards : (await listCollections()).collections;
  listCache.set(kind, { at: Date.now(), items });
  return items;
}

/** The sidebar's recent items of one kind; `active`: its app is on screen, so the list is checked. */
export function useRecents(kind: RecentKind, userId: string, enabled: boolean, active: boolean, hrefFor: (id: string) => string): NavRecent[] {
  const [stored, setStored] = useState<NavRecent[]>(() => typeof window === "undefined" || !enabled ? [] : read(kind, userId));
  const [listed, setListed] = useState<Listed[] | null>(null);
  useEffect(() => {
    if (!enabled) { setStored([]); return; }
    setStored(read(kind, userId));
    const onChange = (event: Event) => { if ((event as CustomEvent<{ kind?: string }>).detail?.kind === kind) setStored(read(kind, userId)); };
    window.addEventListener(RECENTS_EVENT, onChange);
    return () => window.removeEventListener(RECENTS_EVENT, onChange);
  }, [kind, userId, enabled]);
  useEffect(() => {
    if (!enabled || !active) return;
    let live = true;
    loadList(kind).then((items) => { if (live) setListed(items); }, () => undefined);
    return () => { live = false; };
  }, [kind, enabled, active, stored]);
  return enabled ? mergeRecents(stored, listed, hrefFor) : [];
}
