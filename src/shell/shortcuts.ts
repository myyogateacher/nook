import type { ShortcutDef } from "../workspaceModules/types";

/**
 * The "?" keyboard shortcut sheet's rows (docs/plan/LEFT_NAV.md §4 phase 4, D1296): the shortcuts
 * that work everywhere in the signed-in app, the page keys the apps share (§E.1.4), and the module on
 * screen's own `shortcuts` (declared on each workspace module, shown nowhere until now).
 */

export type ShortcutGroup = { id: string; label: string; rows: ShortcutDef[] };

export type ShortcutContext = {
  mac: boolean;
  /** The workspace module on screen: its label and shortcuts. */
  module?: { label: string; shortcuts?: readonly ShortcutDef[] } | null;
  /** Notes is on screen (its `/` focuses the notes search). */
  notes?: boolean;
  /** Time is on (Alt+T starts or stops the timer from anywhere). */
  time?: boolean;
  /** Notes' search is on. */
  notesSearch?: boolean;
};

export function shortcutGroups({ mac, module, notes = false, time = false, notesSearch = false }: ShortcutContext): ShortcutGroup[] {
  const mod = mac ? "⌘" : "Ctrl+";
  const alt = mac ? "⌥" : "Alt+";
  const everywhere: ShortcutDef[] = [
    { keys: `${mod}K`, label: "Go to an app, section, or action (the command palette)" },
    { keys: `${mod}\\`, label: "Collapse or expand the sidebar" },
    { keys: "?", label: "Show these shortcuts" },
    ...(time ? [{ keys: `${alt}T`, label: "Start or stop the timer" }] : [])
  ];
  const page: ShortcutDef[] = [
    { keys: "/", label: notes ? (notesSearch ? "Search notes" : "Search") : "Search this page" },
    { keys: "n", label: "New item (in Forms, Goals, Contacts, and the other workspace apps)" },
    { keys: "j / k", label: "Next / previous item in a list" },
    { keys: "Esc", label: "Close a dialog, sheet, or menu" }
  ];
  const groups: ShortcutGroup[] = [
    { id: "everywhere", label: "Everywhere", rows: everywhere },
    { id: "page", label: "On a page", rows: page }
  ];
  const own = (module?.shortcuts ?? []).map((row) => ({ ...row, keys: row.keys.replace(/^Alt\+/, alt) }));
  if (module && own.length) groups.push({ id: "module", label: module.label, rows: own });
  return groups;
}

/** "j / k" → [["j"], "/", ["k"]]-ish pieces: each key in its own <kbd>, separators as text. */
export function shortcutKeys(keys: string): Array<{ key: string } | { text: string }> {
  return keys.split(/(\s*\/\s*|\s+or\s+)/).filter((part) => part.length > 0).map((part) => /^\s*(\/|or)\s*$/.test(part) && part.trim() !== keys.trim() ? { text: part.trim() } : { key: part.trim() });
}
