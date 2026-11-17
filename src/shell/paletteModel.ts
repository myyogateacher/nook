import { Keyboard, PanelLeft, Search, SlidersHorizontal, type LucideIcon } from "lucide-react";
import type { QuickActionDef } from "../workspaceModules/types";
import type { NavItem, NavRecent, NavTree } from "./navModel";

/**
 * The ⌘K command palette's entries (docs/plan/LEFT_NAV.md §4 phase 4, D1293). A pure function of the
 * sidebar's tree, so the palette offers exactly what the sidebar does for this person (guests,
 * modules turned off, modules the server does not offer, and role-hidden sections are already out of
 * the tree), plus recent items, the workspace modules' quick actions (filtered by role as Home's
 * row is), a few commands, and "Search notes for …". Filtering is fuzzy: every word of the query must
 * appear in order in the entry's name (with its app's name), and closer, earlier, word-start matches
 * rank first.
 */

export type PaletteGroupId = "apps" | "recent" | "actions" | "commands" | "search" | "results";
export const PALETTE_GROUP_LABELS: Record<PaletteGroupId, string> = { apps: "Apps", recent: "Recent", actions: "Quick actions", commands: "Commands", search: "Search", results: "Results" };
const GROUP_ORDER: readonly PaletteGroupId[] = ["apps", "recent", "actions", "commands", "search"];
/** The order before anything is typed (D1293, review): Recent, Quick actions, Apps, Commands. */
const BROWSE_ORDER: readonly PaletteGroupId[] = ["recent", "actions", "apps", "commands"];
/** Recent items listed before anything is typed (all of them match a query). */
export const PALETTE_BROWSE_RECENT = 6;

export type PaletteCommand = "shortcuts" | "customize" | "toggleSidebar";

export type PaletteAction =
  | { kind: "nav"; item: NavItem }
  | { kind: "path"; href: string }
  | { kind: "quick"; action: QuickActionDef & { module: string } }
  | { kind: "command"; command: PaletteCommand }
  | { kind: "searchNotes"; query: string };

export type PaletteEntry = {
  id: string;
  group: PaletteGroupId;
  label: string;
  /** The app a section or recent item belongs to ("Contacts" in Contacts › Insights). */
  context?: string;
  icon: LucideIcon;
  /** Shown on the right: "Section", a shortcut. */
  hint?: string;
  /** Listed before anything is typed (sections only show for a query). */
  browse: boolean;
  /** Extra words it is found by. */
  keywords?: string;
  /** In the app on screen: ranks a little higher among equal matches (Contacts › Insights while in Contacts). */
  here?: boolean;
  /** The item it opens (a recent item, a search result): no two entries shown name the same one (D1346). */
  item?: { kind: string; id: string };
  action: PaletteAction;
};

const itemKey = (entry: PaletteEntry) => entry.item ? `${entry.item.kind}:${entry.item.id}` : entry.action.kind === "path" ? `href:${entry.action.href}` : null;

/** The entries in order, each item (by kind and id, else by href) only the first time. */
function uniqueEntries(entries: readonly PaletteEntry[], seen = new Set<string>()): PaletteEntry[] {
  return entries.filter((entry) => {
    const key = itemKey(entry);
    if (key === null) return true;
    const href = entry.action.kind === "path" ? `href:${entry.action.href}` : null;
    if (seen.has(key) || (href && seen.has(href))) return false;
    seen.add(key);
    if (href) seen.add(href);
    return true;
  });
}

export type PaletteSources = {
  tree: NavTree;
  /** Recently edited notes, newest first (the Notes list already loaded in this tab). */
  recentNotes?: readonly NavRecent[];
  /** Recently opened items of any kind, newest first, already resolved for this person (D1344); `app` is its app's label. */
  recentItems?: ReadonlyArray<{ kind: string; id: string; title: string; href: string; icon: LucideIcon; app: string }>;
  /** Quick actions this person may run (visibleQuickActions). */
  quickActions?: ReadonlyArray<QuickActionDef & { module: string }>;
  /** The module label each quick action belongs to, by module id. */
  moduleLabels?: Readonly<Record<string, string>>;
  /** Notes and Search are on: "Search notes for …" is offered. */
  searchNotes: boolean;
  /** The sidebar can collapse here (not on a phone). */
  canToggleSidebar?: boolean;
  /** Labels of the shortcuts, platform-specific ("⌘\\"). */
  toggleShortcut?: string;
  /** Customize sidebar is offered. */
  canCustomize?: boolean;
};

export const PALETTE_RECENT_NOTES = 5;

/** Every entry, before filtering, in the order shown when nothing is typed. */
export function paletteEntries({ tree, recentNotes = [], recentItems = [], quickActions = [], moduleLabels = {}, canToggleSidebar = false, toggleShortcut, canCustomize = false }: PaletteSources): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  const recents: PaletteEntry[] = [];
  const top = [...tree.primary, ...tree.pinned, ...tree.apps, tree.settings];
  for (const item of top) {
    entries.push({ id: `nav:${item.id}`, group: "apps", label: item.label, icon: item.icon, browse: true, action: { kind: "nav", item } });
    for (const child of item.children ?? []) {
      const entry: PaletteEntry = { id: `nav:${child.id}`, group: child.kind === "recent" ? "recent" : "apps", label: child.label, context: item.label, icon: child.icon, hint: child.kind === "recent" ? item.label : undefined, browse: child.kind === "recent", here: item.current, action: { kind: "nav", item: child } };
      // A recent board or collection names its item (`tasks:recent:<id>`), for de-duplication.
      if (child.kind === "recent") recents.push({ ...entry, item: { kind: item.id === "tasks" ? "board" : item.id === "collections" ? "collection" : item.id, id: child.id.slice(child.id.lastIndexOf(":") + 1) } });
      else entries.push(entry);
    }
  }
  // D1344: recently opened items lead, newest first; a board, collection, or note they already name
  // is not listed twice.
  const opened = recentItems.map((item): PaletteEntry => ({ id: `opened:${item.kind}:${item.id}`, group: "recent", label: item.title || "Untitled", context: item.app, icon: item.icon, hint: item.app, browse: true, item: { kind: item.kind, id: item.id }, action: { kind: "path", href: item.href } }));
  const notesIcon = tree.apps.find((item) => item.id === "notes")?.icon ?? tree.pinned.find((item) => item.id === "notes")?.icon;
  if (notesIcon) for (const note of recentNotes.slice(0, PALETTE_RECENT_NOTES)) recents.push({ id: `note:${note.id}`, group: "recent", label: note.name || "Untitled", context: "Notes", icon: notesIcon, hint: "Notes", browse: true, item: { kind: "note", id: note.id }, action: { kind: "path", href: note.href } });
  entries.push(...uniqueEntries([...opened, ...recents]));
  for (const action of quickActions) entries.push({ id: `quick:${action.module}:${action.id}`, group: "actions", label: action.label, context: moduleLabels[action.module], icon: action.icon, browse: true, action: { kind: "quick", action } });
  entries.push({ id: "command:shortcuts", group: "commands", label: "Keyboard shortcuts", icon: Keyboard, hint: "?", browse: true, keywords: "help keys", action: { kind: "command", command: "shortcuts" } });
  if (canCustomize) entries.push({ id: "command:customize", group: "commands", label: "Customize sidebar", icon: SlidersHorizontal, browse: true, keywords: "pin reorder order hide apps", action: { kind: "command", command: "customize" } });
  if (canToggleSidebar) entries.push({ id: "command:toggle", group: "commands", label: "Collapse or expand the sidebar", icon: PanelLeft, hint: toggleShortcut, browse: false, keywords: "rail narrow wide", action: { kind: "command", command: "toggleSidebar" } });
  return entries;
}

const normalize = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const isWordStart = (text: string, index: number) => index === 0 || /[\s›\-_/.(]/.test(text[index - 1]!);

/**
 * How well `word` matches `text` (both normalized); 0 is no match. A run of the word inside the text
 * beats scattered letters; a run at a word's start beats one inside a word; earlier beats later.
 */
export function fuzzyWordScore(word: string, text: string): number {
  if (!word) return 1;
  let best = 0;
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    const score = 100 + (isWordStart(text, at) ? 60 : 0) + (at === 0 ? 20 : 0) - Math.min(at, 30) + word.length * 2;
    if (score > best) best = score;
  }
  if (best) return best;
  // Letters in order, in runs that each start a word ("cin" → Contacts › INsights, "tsh" → TimeSHeet
  // does not, "ti" → TIme): scattered letters inside words ("ins" in "collectIoNS") are no match.
  let score = 0;
  let previous = -2;
  for (const letter of word) {
    let found = -1;
    if (text[previous + 1] === letter) found = previous + 1;
    else for (let index = previous + 1; index < text.length; index += 1) if (text[index] === letter && isWordStart(text, index)) { found = index; break; }
    if (found < 0) return 0;
    score += found === previous + 1 ? 5 : 8;
    previous = found;
  }
  return score;
}

/** The entry's score for a query; 0 when some word of the query does not match. */
export function paletteScore(entry: Pick<PaletteEntry, "label" | "context" | "keywords">, query: string): number {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  const label = normalize(entry.label);
  const full = normalize([entry.context, entry.label].filter(Boolean).join(" › "));
  const extra = entry.keywords ? normalize(entry.keywords) : "";
  let total = 0;
  for (const word of words) {
    // The entry's own name counts most, then its app's, then its keywords.
    const score = Math.max(fuzzyWordScore(word, label) * 1.2, fuzzyWordScore(word, full), extra ? fuzzyWordScore(word, extra) * 0.5 : 0);
    if (score <= 0) return 0;
    total += score;
  }
  return total;
}

/** `key`: unique among the groups shown (search results have one group per app, all `results`). */
export type PaletteGroup = { id: PaletteGroupId; key?: string; label: string; entries: PaletteEntry[] };

/**
 * The palette with the server's search results (D1340): the local groups as filterPalette ordered
 * them, then one group per app with results, then Search ("Search notes for …") last, so a query
 * that names an app or a recent item still opens it with Enter and the fallback stays at the end.
 */
export function withResults(groups: readonly PaletteGroup[], results: readonly PaletteGroup[]): PaletteGroup[] {
  const ordered = [...groups.filter((group) => group.id !== "search"), ...results, ...groups.filter((group) => group.id === "search")];
  // D1346: an item shown in an earlier group (a recent note, a recent card) is never shown again in a
  // later one, by kind and id (and by href, for entries that name no item).
  const seen = new Set<string>();
  return ordered.map((group) => ({ ...group, entries: uniqueEntries(group.entries, seen) })).filter((group) => group.entries.length > 0);
}

export const PALETTE_LIMIT = 60;

/**
 * The groups to show. Nothing typed: Recent (at most six), Quick actions, Apps, Commands. A query:
 * Apps, Recent, Quick actions, Commands, Search, led by the best match's group; inside a group the
 * best matches first. "Search notes for …" ends the list whenever something is
 * typed and Notes' search is on.
 */
export function filterPalette(entries: readonly PaletteEntry[], query: string, searchNotes: boolean): PaletteGroup[] {
  const trimmed = query.trim();
  const scored = entries
    .map((entry, index) => {
      const score = trimmed ? paletteScore(entry, trimmed) : entry.browse ? 1 : 0;
      return { entry, index, score: score > 0 && trimmed && entry.here ? score + 12 : score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, PALETTE_LIMIT);
  // Nothing typed: what is likely next comes first (a few recent items, the quick actions), then the
  // apps, then the commands; a query keeps the fixed order, led by the best match's group.
  const groups: PaletteGroup[] = (trimmed ? GROUP_ORDER : BROWSE_ORDER).map((id) => {
    const found = scored.filter((item) => item.entry.group === id).map((item) => item.entry);
    return { id, label: PALETTE_GROUP_LABELS[id], entries: !trimmed && id === "recent" ? found.slice(0, PALETTE_BROWSE_RECENT) : found };
  });
  if (trimmed && searchNotes) groups.find((group) => group.id === "search")!.entries.push({ id: "search:notes", group: "search", label: `Search notes for “${trimmed}”`, icon: Search, browse: false, action: { kind: "searchNotes", query: trimmed } });
  // With a query, the group holding the best match leads, so Enter opens what ranks first.
  if (trimmed) {
    const lead = scored[0]?.entry.group;
    if (lead) {
      const at = groups.findIndex((group) => group.id === lead);
      if (at > 0) groups.unshift(...groups.splice(at, 1));
    }
  }
  return groups.filter((group) => group.entries.length > 0);
}

/** The entries in display order (what ↑ and ↓ walk). */
export const flatPalette = (groups: readonly PaletteGroup[]) => groups.flatMap((group) => group.entries);
