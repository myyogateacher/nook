import { useEffect, useState } from "react";
import { api } from "../api";
import { parseWorkRef, WORK_KIND_MODULE, type ParsedWorkRef, type WorkKind, type WorkSummary } from "../../shared/workRefs";

/**
 * Recently opened items for the ⌘K palette's Recent group (docs/plan/SEARCH_EVERYWHERE.md, D1344):
 * every page of an item with a stable open route (a note, file, whiteboard, report, card, board,
 * collection, event, goal, form, contact, company, deal, booking type, time project, standup,
 * townhall…) is recorded as it opens: in this browser (localStorage), per person, newest first, at most
 * twelve, and only its kind and reference (an id, short id, or card key), never a title. When the
 * palette opens, the list is resolved by the server's link resolver, which applies each kind's own read
 * check: the titles and hrefs shown are current, and anything binned, unshared, or gone is dropped
 * (and forgotten) without a trace (T682).
 */

export const RECENT_ITEMS_LIMIT = 12;
const storageKey = (userId: string) => `nook.recent.items.${userId}`;
export const RECENT_ITEMS_EVENT = "nook:recent-items";

type Stored = { kind: WorkKind; ref: string; by: ParsedWorkRef["by"]; id?: string };
export type RecentItem = WorkSummary;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Kinds whose path is an item's own page but that parseWorkRef does not read (events stay opaque ids, D782). */
function parseExtra(path: string): ParsedWorkRef | null {
  const event = /^\/calendar\/event\/([^/?#]+)/.exec(path);
  return event && UUID.test(event[1]!) ? { kind: "event", ref: event[1]!.toLowerCase(), by: "id" } : null;
}

/** The item a path is the page of, or null (lists, home pages, settings). */
export function itemOfPath(path: string): ParsedWorkRef | null {
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  return parseWorkRef(path) ?? parseExtra(path);
}

const sameRef = (a: Stored, b: Pick<Stored, "kind" | "ref" | "id">) => a.kind === b.kind && (a.ref === b.ref || (a.id !== undefined && a.id === b.id));

function read(userId: string): Stored[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey(userId)) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => item && typeof item === "object" && typeof item.kind === "string" && typeof item.ref === "string" && item.ref.length <= 64
      && ["id", "short_id", "key", "code"].includes(item.by)
      ? [{ kind: item.kind as WorkKind, ref: item.ref, by: item.by, ...(typeof item.id === "string" && UUID.test(item.id) ? { id: item.id } : {}) }] : []).slice(0, RECENT_ITEMS_LIMIT);
  } catch {
    return [];
  }
}

function write(userId: string, items: readonly Stored[]) {
  try { window.localStorage.setItem(storageKey(userId), JSON.stringify(items.slice(0, RECENT_ITEMS_LIMIT))); } catch { /* private mode: this visit only */ }
}

/** A page opened: if it is an item's own page, the item moves to the top of the person's list. */
export function recordRecentPath(userId: string, path: string) {
  if (typeof window === "undefined" || !userId) return;
  const parsed = itemOfPath(path);
  if (!parsed) return;
  const current = read(userId);
  const existing = current.find((item) => sameRef(item, parsed));
  if (current[0] && sameRef(current[0], parsed)) return;
  const entry: Stored = existing ?? { kind: parsed.kind, ref: parsed.ref, by: parsed.by, ...(parsed.by === "id" ? { id: parsed.ref } : {}) };
  write(userId, [entry, ...current.filter((item) => item !== existing)]);
  window.dispatchEvent(new CustomEvent(RECENT_ITEMS_EVENT));
}

/** Forget the list (sign-out keeps it per person; this is for tests and a cleared account). */
export function clearRecentItems(userId: string) {
  try { window.localStorage.removeItem(storageKey(userId)); } catch { /* nothing kept */ }
}

/** How a stored reference reads to the resolver: `kind:id`, a card key, or `kind:<short id>`. */
const refText = (item: Stored) => item.by === "key" ? item.ref : item.by === "code" ? `board:${item.ref}` : `${item.kind}:${item.ref}`;

/**
 * The stored list resolved for display, newest first: one `POST /api/refs/summaries` for those whose
 * id is known, one `GET /api/refs/resolve` for each of the rest (their id is kept for next time).
 * Hidden, missing, and failed ones are dropped and forgotten; a network failure keeps the list as it was.
 */
export async function resolveRecentItems(userId: string): Promise<RecentItem[]> {
  const stored = read(userId);
  if (!stored.length) return [];
  const summaries = new Map<Stored, RecentItem | null>();
  const withId = stored.filter((item) => item.id);
  if (withId.length) {
    const body = await api<{ summaries: Array<WorkSummary | { kind: string; hidden: true }> }>("/refs/summaries", { method: "POST", body: JSON.stringify({ refs: withId.map((item) => ({ kind: item.kind, id: item.id })) }) });
    withId.forEach((item, index) => { const summary = body.summaries[index]; summaries.set(item, summary && !("hidden" in summary) ? summary : null); });
  }
  await Promise.all(stored.filter((item) => !item.id).map(async (item) => {
    try {
      const { summary } = await api<{ summary: WorkSummary }>(`/refs/resolve?${new URLSearchParams({ ref: refText(item) })}`);
      summaries.set(item, summary.kind === item.kind ? summary : null);
    } catch {
      summaries.set(item, null);
    }
  }));
  const kept: Stored[] = [];
  const shown: RecentItem[] = [];
  for (const item of stored) {
    const summary = summaries.get(item);
    if (!summary || !summary.href.startsWith("/") || summary.href.startsWith("//")) continue;
    if (shown.some((other) => other.kind === summary.kind && other.id === summary.id)) continue;
    kept.push({ ...item, id: summary.id });
    shown.push(summary);
  }
  // Only forget what the server answered for: the list may have grown while this was asked.
  const latest = read(userId);
  write(userId, latest.flatMap((item) => {
    const match = stored.find((old) => sameRef(old, item));
    if (!match) return [item];
    const keptItem = kept.find((entry) => sameRef(entry, match));
    return keptItem ? [keptItem] : [];
  }));
  return shown;
}

/** The app (sidebar id) a kind's items open in. */
export function appOfKind(kind: WorkKind): string {
  const module = WORK_KIND_MODULE[kind];
  if (module) return module;
  switch (kind) {
    case "note": return "notes";
    case "document": return "files";
    case "whiteboard": return "whiteboards";
    case "report": return "reports";
    case "card": case "board": case "sprint": return "tasks";
    case "event": case "calendar": return "calendar";
    case "collection": case "row": return "collections";
    default: return kind;
  }
}

/** The palette's recently opened items, resolved each time it opens; [] while closed or loading. */
export function useRecentItems(userId: string | undefined, open: boolean): RecentItem[] {
  const [items, setItems] = useState<RecentItem[]>([]);
  useEffect(() => {
    if (!open || !userId) return;
    let live = true;
    resolveRecentItems(userId).then((resolved) => { if (live) setItems(resolved); }, () => undefined);
    return () => { live = false; };
  }, [userId, open]);
  return open ? items : [];
}
