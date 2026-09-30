// Pure Bin display helpers. No DOM or network access, so they are unit tested directly.
import type { BinItem, BinRestoreResult, Visibility } from "../types";
import { whiteboardDisplayName } from "../../shared/whiteboardScene";

export type BinFilter = "all" | "note" | "document" | "tasks" | "collections" | "calendar";

export const isTaskBinItem = (item: Pick<BinItem, "type">) => item.type === "card" || item.type === "board";
export const isCollectionItem = (item: Pick<BinItem, "type">) => item.type === "collection" || item.type === "collection_row";
export const isCalendarItem = (item: Pick<BinItem, "type">) => item.type === "calendar" || item.type === "event";

const DAY_MS = 86_400_000;

/** Whole days left before an item is deleted forever, rounded up so a fresh deletion reads 30. Never negative. */
export function daysUntilPurge(purgeAfter: string, nowMs = Date.now()) {
  const remaining = new Date(purgeAfter).getTime() - nowMs;
  if (!Number.isFinite(remaining)) return 0;
  return Math.max(0, Math.ceil(remaining / DAY_MS));
}

export function purgeCountdownLabel(purgeAfter: string, nowMs = Date.now()) {
  const days = daysUntilPurge(purgeAfter, nowMs);
  if (days === 0) return "Deletes soon";
  return days === 1 ? "Deletes in 1 day" : `Deletes in ${days} days`;
}

/** "+ 7 subitems": a card's descendants that were binned with it and come back with it (D129). */
export const subitemLabel = (count: number) => count === 1 ? "+ 1 subitem" : `+ ${count} subitems`;

/**
 * Where a restore will put the item: its original folder (Default when that folder is gone), a
 * card's board, Collections for a collection, a row's collection (Wave 11), Calendar for a
 * calendar, or an event's calendar (Wave 12).
 */
export function binFolderLabel(item: Pick<BinItem, "folder_name"> & Partial<Pick<BinItem, "type" | "board_name">>) {
  if (item.type === "card") return item.board_name ?? "its board";
  if (item.type === "board") return "Tasks";
  if (item.type === "collection") return "Collections";
  if (item.type === "collection_row") return item.folder_name ?? "its collection";
  if (item.type === "calendar") return "Calendar";
  if (item.type === "event") return item.folder_name ?? "Calendar";
  return item.folder_name ?? "Default";
}

/** The Tasks filter shows cards and boards together; Collections, collections and rows; Calendar, calendars and events. */
export function filterBinItems(items: BinItem[], filter: BinFilter) {
  if (filter === "all") return items;
  if (filter === "tasks") return items.filter(isTaskBinItem);
  if (filter === "collections") return items.filter(isCollectionItem);
  if (filter === "calendar") return items.filter(isCalendarItem);
  return items.filter((item) => item.type === filter);
}

const untitled: Record<BinItem["type"], string> = { note: "Untitled note", document: "Untitled file", card: "Untitled card", board: "Untitled board", collection: "Untitled collection", collection_row: "Untitled row", calendar: "Untitled calendar", event: "Untitled event" };

export function binItemLabel(item: Pick<BinItem, "title" | "type"> & Partial<Pick<BinItem, "kind">>) {
  // QA L6: a whiteboard reads by its name, without the ".excalidraw" of its file.
  if (item.type === "document" && item.kind === "whiteboard") return whiteboardDisplayName(item.title).trim() || "Untitled whiteboard";
  return item.title.trim() || untitled[item.type];
}

const attachmentKindLabel = (item: Partial<Pick<BinItem, "attachment_kind">>) =>
  item.attachment_kind === "row" ? "Row attachment" : item.attachment_kind === null ? "Attachment" : "Card attachment";

/**
 * Row meta for an attachment: the card or row it still belongs to, a kind label while something
 * still links it, or where it restores to once nothing does.
 */
export function attachmentLabel(item: Pick<BinItem, "attachment_of"> & Partial<Pick<BinItem, "attachment_kind" | "folder_name">>) {
  if (item.attachment_of != null) {
    const name = item.attachment_of.trim() || (item.attachment_kind === "row" ? "Untitled row" : "Untitled card");
    return `Attachment of ${name}`;
  }
  const kind = attachmentKindLabel(item);
  // Older servers omit attachment_kind; they only report a card link through attachment_of.
  const linked = item.attachment_kind === "card" || item.attachment_kind === "row";
  return linked ? kind : `${kind} · restores to ${item.folder_name ?? "Default"}`;
}

/** The kind shown to screen readers and in the row meta. */
export function binKindLabel(item: Pick<BinItem, "type" | "attachment"> & Partial<Pick<BinItem, "attachment_kind" | "kind">>) {
  if (item.type === "note") return "Note";
  if (item.type === "card") return "Card";
  if (item.type === "board") return "Board";
  if (item.type === "collection") return "Collection";
  if (item.type === "collection_row") return "Row";
  if (item.type === "calendar") return "Calendar";
  if (item.type === "event") return "Event";
  if (item.kind === "whiteboard") return "Whiteboard";
  return item.attachment ? attachmentKindLabel(item) : "File";
}

/** Toast after restoring any Bin item. */
export function restoreResultMessage(item: Pick<BinItem, "type"> & Partial<Pick<BinItem, "attachment" | "attachment_kind" | "folder_name">>, result: BinRestoreResult) {
  if (item.type === "board") {
    const name = result.boardName ? ` “${result.boardName}”` : "";
    return result.alreadyRestored ? `The board${name} is already restored` : `Restored the board${name}`;
  }
  if (item.type === "card") {
    const where = [result.columnName, result.boardName].filter(Boolean).join(" on ");
    if (result.alreadyRestored) return `Already restored${where ? ` to ${where}` : ""}`;
    const extra = [
      result.descendantCount ? ` with ${result.descendantCount === 1 ? "1 subitem" : `${result.descendantCount} subitems`}` : "",
      result.detached ? ", without its parent (it is in the Bin)" : ""
    ].join("");
    return `Restored${where ? ` to ${where}` : ""}${extra}`;
  }
  if (item.type === "calendar" || item.type === "event") return restoredCalendarMessage({ type: item.type, title: "" }, result.calendarName, Boolean(result.alreadyRestored));
  if (item.type === "collection" || item.type === "collection_row") {
    const where = result.folderName ?? binFolderLabel({ type: item.type, folder_name: item.folder_name ?? null });
    return result.alreadyRestored ? `Already restored to ${where}` : restoredMessage(where, result.visibility);
  }
  if (item.type === "document" && item.attachment && !result.folderName && !result.alreadyRestored) return item.attachment_kind === "row" ? "Restored to its row" : "Restored to its card";
  const folderName = result.folderName ?? "Default";
  return result.alreadyRestored ? `Already restored to ${folderName}` : restoredMessage(folderName, result.visibility);
}

/** Toast after restoring a calendar or an event. */
export function restoredCalendarMessage(item: Pick<BinItem, "type" | "title">, calendarName: string | undefined, alreadyRestored: boolean) {
  if (item.type === "calendar") return alreadyRestored ? `“${calendarName ?? item.title}” was already restored` : `Restored “${calendarName ?? item.title}”`;
  return alreadyRestored ? `Already restored to ${calendarName ?? "its calendar"}` : `Restored to ${calendarName ?? "its calendar"}`;
}

export function deleteForeverConfirm(title: string) {
  return `Permanently delete “${title}”? This can't be undone.`;
}

/** GET /api/bin returns at most this many items; a full page may mean there are more. */
export const BIN_LIST_LIMIT = 500;

export function emptyBinConfirm(count: number) {
  const items = count >= BIN_LIST_LIMIT ? `all ${BIN_LIST_LIMIT}+ items` : count === 1 ? "1 item" : `${count} items`;
  return `Permanently delete ${items} in the Bin? This can't be undone.`;
}

const sharedSuffix: Record<Visibility, string> = { private: "", selected: " · shared with selected people", all_users: " · shared with everyone" };

/** Toast after a restore. Names the destination and, when it is not private, who can see the item again. */
export function restoredMessage(folderName: string, visibility?: Visibility) {
  return `Restored to ${folderName}${visibility ? sharedSuffix[visibility] : ""}`;
}

export function emptiedMessage(purged: number, pending: number) {
  const done = purged === 1 ? "1 item deleted forever" : `${purged} items deleted forever`;
  return pending ? `${done}. ${pending} still finishing.` : done;
}
