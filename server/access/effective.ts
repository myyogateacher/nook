import { db } from "../db";
import { folderLevel, noteLevel, readableNote } from "../access";
import { readableDocument } from "../documentAccess";
import { boardLevel, readableBoard } from "../tasks/access";
import { collectionLevel, readableCollection } from "../collections/access";
import { calendarLevel, readableCalendar } from "../calendar/access";
import { listReadableFolders } from "../access";
import { readableViewPredicate } from "../tasks/views";
import { atLeast, type AccessKind, type ItemLevel } from "./levels";

/**
 * Per-item rights in one place (access plan §C.10). `canReadItem` answers "may this person open the
 * item right now" through each module's own readable predicate, so nothing here can drift from what
 * the module serves. Admin views use it to decide whether a title may be shown (D269, T204).
 */

const readableTaskView = (viewId: string, userId: string) => Boolean(db.query(`SELECT 1 FROM task_views v JOIN users u ON u.id = v.owner_id
  WHERE v.id = $viewId AND ${readableViewPredicate}`).get({ viewId, userId }));

export function canReadItem(kind: AccessKind, id: string, userId: string): boolean {
  switch (kind) {
    case "note": return readableNote(id, userId) !== null;
    case "folder": return listReadableFolders(userId).some((folder) => folder.id === id);
    case "document": {
      const document = readableDocument(id, userId);
      return document !== null && document.purpose === "file";
    }
    case "board": return readableBoard(id, userId) !== null;
    case "task_view": return readableTaskView(id, userId);
    case "collection": return readableCollection(id, userId) !== null;
    case "calendar": return readableCalendar(id, userId) !== null;
  }
}

/**
 * `itemLevel()` (§C.9, §C.10): the caller's live level on one item, whatever the module. Readable
 * items resolve through the module's own level function (owner, direct share, groups, audience,
 * capped by the Team role); anything unreadable is `none`. Files and task views are view-only.
 */
export function itemLevel(kind: AccessKind, id: string, userId: string): ItemLevel {
  switch (kind) {
    case "note": {
      const note = readableNote(id, userId);
      return note ? noteLevel(note, userId) : "none";
    }
    case "folder": return canReadItem("folder", id, userId) ? folderLevel(id, userId) : "none";
    case "document": {
      const document = readableDocument(id, userId);
      if (!document || document.purpose !== "file") return "none";
      return document.owner_id === userId ? "owner" : "view";
    }
    case "board": {
      const board = readableBoard(id, userId);
      return board ? boardLevel(board, userId) : "none";
    }
    case "task_view": {
      if (!readableTaskView(id, userId)) return "none";
      const owner = db.query("SELECT owner_id FROM task_views WHERE id = ?").get(id) as { owner_id: string };
      return owner.owner_id === userId ? "owner" : "view";
    }
    case "collection": {
      const collection = readableCollection(id, userId);
      return collection ? collectionLevel(collection, userId) : "none";
    }
    case "calendar": {
      const calendar = readableCalendar(id, userId);
      return calendar ? calendarLevel(calendar, userId) : "none";
    }
  }
}

/**
 * `canReadItem` for many items and one viewer (the member access page, T218): folders are read
 * once as the viewer's folder list instead of once per row; the other kinds are one indexed query
 * each, as before.
 */
export function readabilityChecker(viewerId: string) {
  let folders: Set<string> | null = null;
  return (kind: AccessKind, id: string) => {
    if (kind !== "folder") return canReadItem(kind, id, viewerId);
    folders ??= new Set(listReadableFolders(viewerId).map((folder) => folder.id));
    return folders.has(id);
  };
}

/** §C.10 for one item and a session: ok, NOT_FOUND for no access (never disclosed), READ_ONLY below `needed`. */
export function authorizeItem(kind: AccessKind, id: string, userId: string, needed: ItemLevel): "ok" | "NOT_FOUND" | "READ_ONLY" {
  const level = itemLevel(kind, id, userId);
  if (level === "none") return "NOT_FOUND";
  return atLeast(level, needed) ? "ok" : "READ_ONLY";
}

/** Table, title column, and label per kind, for redacted presentations (D269). */
export const ITEM_TABLES: Record<AccessKind, { table: string; title: string; label: string }> = {
  note: { table: "notes", title: "title", label: "Note" },
  folder: { table: "folders", title: "name", label: "Folder" },
  document: { table: "documents", title: "name", label: "File" },
  board: { table: "boards", title: "name", label: "Board" },
  task_view: { table: "task_views", title: "name", label: "Task view" },
  collection: { table: "collections", title: "name", label: "Collection" },
  calendar: { table: "calendars", title: "name", label: "Calendar" }
};

/**
 * An item as `viewerId` may see it: its title only when they can read it, otherwise the owner's name
 * and the kind ("Board owned by Carol"). Null when the item no longer exists.
 */
export function presentItem(kind: AccessKind, id: string, viewerId: string, readableKnown?: (kind: AccessKind, id: string) => boolean) {
  const { table, title, label } = ITEM_TABLES[kind];
  const row = db.query(`SELECT t.${title} AS title, t.owner_id, u.display_name AS owner_name FROM ${table} t JOIN users u ON u.id = t.owner_id WHERE t.id = ?`)
    .get(id) as { title: string; owner_id: string; owner_name: string } | null;
  if (!row) return null;
  const readable = readableKnown ? readableKnown(kind, id) : canReadItem(kind, id, viewerId);
  return {
    kind,
    title: readable ? row.title : `${label} owned by ${row.owner_name}`,
    titleHidden: !readable,
    owner: { id: row.owner_id, displayName: row.owner_name },
    ...(readable ? { id } : {})
  };
}
