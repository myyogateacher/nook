import { dayHeading, zonedParts } from "../calendar/calendarFormat";
import { eventRoute } from "../calendarRoute";
import { collectionsRoute } from "../collectionsRoute";
import { formatBytes } from "../files/filesApi";
import { relativeTime } from "../files/format";
import { parseRoute, type Route } from "../router";
import { dueStatus } from "../tasks/taskActions";

/** One rendered row: the link text, a short second line, and where it goes. */
export type TodayRow = { key: string; label: string; meta: string; route: Route; tone?: "overdue" | "today" | "soon" };

/** The fixed groups Today lays its sections out in, in order (one column each on wide screens). */
export const TODAY_GROUPS = [
  { id: "today", title: "Today", clear: "nothing due or coming up" },
  { id: "recent", title: "Recent work", clear: "nothing edited lately" },
  { id: "housekeeping", title: "Housekeeping", clear: "nothing to tidy up" }
] as const;

export type TodayGroupId = (typeof TODAY_GROUPS)[number]["id"];

export type TodaySectionDef = {
  title: string;
  /** The group it shows in; a new section (Team, …) picks one and slots in by registration order. */
  group: TodayGroupId;
  /** Short copy for the one-line collapsed state: "Upcoming · nothing in the next 7 days". */
  empty: string;
  /** Turns one server item into a row; `date` is Today's date in the viewer's zone. */
  row?: (item: Record<string, any>, date: string) => TodayRow;
  /** Where "View all" goes instead of the section's href (Tasks: My work, 17C). */
  viewAll?: string;
  /** The app the "View all" link opens, for its accessible name. */
  app: string;
};

const noteRoute = (id: string): Route => ({ app: "notes", folder: "all", noteId: id });

/** An upcoming occurrence: "Today · 09:30" in the browser's zone, or "Tomorrow · All day". */
function upcomingRow(item: Record<string, any>, date: string): TodayRow {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const start = item.allDay ? { date: String(item.date ?? item.start), time: "All day" } : zonedParts(item.start, zone);
  const day = start.date < date ? date : start.date;
  return { key: `${item.eventId}:${item.start}`, label: item.title || "Untitled event", meta: `${dayHeading(day, date)} · ${start.time}`, route: eventRoute(item.eventId), ...(day === date ? { tone: "today" as const } : {}) };
}

function taskRow(item: Record<string, any>, date: string): TodayRow {
  // A card with a time (Wave 13, D100) shows the viewer's local time of its instant: "Due today at 17:00".
  const due = dueStatus(item.dueOn ?? null, date, false, { dueAt: item.dueAt ?? null });
  const reason = item.reason === "assigned" ? "Assigned to you" : item.reason === "created" ? "Added by you" : null;
  return {
    key: item.cardId,
    label: item.title,
    // A subtask names its parent on the same board (task hierarchy D138): "Web app › Checkout".
    meta: [item.parentTitle ? `${item.boardName} › ${item.parentTitle}` : item.boardName, due?.description, reason].filter(Boolean).join(" · "),
    route: { app: "tasks", boardId: item.boardId, cardId: item.cardId },
    ...(due && due.tone !== "later" ? { tone: due.tone } : {})
  };
}

const binTypeLabel: Record<string, string> = { note: "Note", document: "File", card: "Card", board: "Board", collection: "Collection", collection_row: "Row", calendar: "Calendar", event: "Event" };

/**
 * Client copy for each Today section, grouped and in display order. A section
 * the server does not return (its module is not installed) is not shown; a
 * section the client has no entry for is skipped. Later modules add theirs
 * with a `group`, next to their server `registerTodayProvider` call.
 */
export const TODAY_SECTIONS: Record<string, TodaySectionDef> = {
  // Today
  tasksDue: { title: "Due soon", group: "today", empty: "nothing due in the next 7 days", app: "Tasks", row: taskRow },
  upcoming: { title: "Upcoming", group: "today", empty: "nothing in the next 7 days", app: "Calendar", row: upcomingRow },
  tasksMine: { title: "My tasks", group: "today", empty: "no other open cards for you", app: "Tasks", row: taskRow, viewAll: "/tasks/my" },
  // Agent inbox (D158): replaces Housekeeping's "Drafts from agents". Titles are agent text, shown as text.
  proposals: {
    title: "Proposals awaiting you", group: "today", empty: "none from agents", app: "Inbox",
    row: (item) => ({
      key: item.id,
      label: item.title || "Untitled",
      meta: [item.kindLabel, `Key \u201c${item.keyName}\u201d`, relativeTime(item.created_at)].filter(Boolean).join(" · "),
      route: { app: "inbox", view: "pending", proposalId: item.id }
    })
  },
  // Recent work
  notesRecent: {
    title: "Recent notes", group: "recent", empty: "no notes yet", app: "Notes",
    row: (item) => ({ key: item.id, label: item.title || "Untitled", meta: [item.is_owner ? null : item.owner_name, `Updated ${relativeTime(item.updated_at)}`].filter(Boolean).join(" · "), route: noteRoute(item.id) })
  },
  files: {
    title: "Recent files", group: "recent", empty: "no files yet", app: "Files",
    row: (item) => ({ key: item.id, label: item.name, meta: [formatBytes(item.size_bytes), item.is_owner ? null : item.owner_name, relativeTime(item.updated_at)].filter(Boolean).join(" · "), route: { app: "files", folder: "all", documentId: item.id } })
  },
  collectionsRecent: {
    title: "Recently edited rows", group: "recent", empty: "no rows edited yet", app: "Collections",
    row: (item) => ({
      key: item.rowId,
      label: item.title || "Untitled",
      meta: [item.collectionName, item.changedByKey ? "Changed by an MCP key" : null, `Updated ${relativeTime(item.updated_at)}`].filter(Boolean).join(" · "),
      route: collectionsRoute(item.collectionId, { rowId: item.rowId })
    })
  },
  // Whiteboards (Wave 23, §10.7): the five most recently edited boards the viewer can open.
  whiteboardsRecent: {
    title: "Recent whiteboards", group: "recent", empty: "no whiteboards yet", app: "Whiteboards",
    row: (item) => ({
      key: item.id,
      label: item.name || "Untitled",
      meta: [item.is_owner ? null : item.owner_name, `Edited ${relativeTime(item.updated_at)}`].filter(Boolean).join(" · "),
      route: { app: "whiteboards", folder: "all", boardId: item.id }
    })
  },
  // Housekeeping
  drafts: {
    title: "Unpublished drafts", group: "housekeeping", empty: "none", app: "Notes",
    row: (item) => ({ key: item.id, label: item.title || "Untitled", meta: `${item.neverPublished ? "Never published" : "Unpublished changes"} · ${relativeTime(item.updated_at)}`, route: noteRoute(item.id) })
  },
  binSoon: {
    title: "Leaving the Bin soon", group: "housekeeping", empty: "nothing in the next 3 days", app: "Bin",
    row: (item) => ({ key: `${item.type}:${item.id}`, label: item.title || "Untitled", meta: `${binTypeLabel[item.type] ?? "Item"} · deleted forever ${relativeTime(item.purge_after)}`, route: { app: "bin" } })
  },
  storage: { title: "Storage", group: "housekeeping", empty: "no information", app: "Files" }
};

export const DEFAULT_SECTION_ORDER = Object.keys(TODAY_SECTIONS);

/** Orders section names by the client registry (which is group order) and splits them into the fixed groups, dropping empty groups and unknown names. */
export function groupTodaySections(names: readonly string[]) {
  const wanted = new Set(names);
  return TODAY_GROUPS
    .map((group) => ({ ...group, names: DEFAULT_SECTION_ORDER.filter((name) => wanted.has(name) && TODAY_SECTIONS[name]!.group === group.id) }))
    .filter((group) => group.names.length > 0);
}

/** The count shown after a section's title ("Due soon · 3"), or null when there is nothing to count. */
export function sectionCount(items: readonly unknown[], more: boolean | undefined) {
  if (items.length === 0) return null;
  return more ? `${items.length}+` : String(items.length);
}

/** The "View all" route: the section's href, parsed like any other in-app URL. */
export const viewAllRoute = (href: string): Route => parseRoute(href);

export type StorageUsage = { usedBytes: number; binnedBytes: number; quotaBytes: number | null };

/** "3.2 GB of 10 GB", plus how much of it is in the Bin. */
export function storageText(usage: StorageUsage) {
  const used = formatBytes(usage.usedBytes) || "0 B";
  const summary = usage.quotaBytes ? `${used} of ${formatBytes(usage.quotaBytes)}` : `${used} used`;
  return { summary, detail: usage.binnedBytes > 0 ? `${formatBytes(usage.binnedBytes)} of it is in the Bin` : usage.quotaBytes ? "Nothing in the Bin" : "No storage limit" };
}
