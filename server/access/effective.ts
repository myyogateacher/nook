import { db } from "../db";
import { readableNote } from "../access";
import { readableDocument } from "../documentAccess";
import { readableBoard } from "../tasks/access";
import { readableCollection } from "../collections/access";
import { readableCalendar } from "../calendar/access";
import { listReadableFolders } from "../access";
import { readableViewPredicate } from "../tasks/views";
import type { AccessKind } from "./levels";

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
export function presentItem(kind: AccessKind, id: string, viewerId: string) {
  const { table, title, label } = ITEM_TABLES[kind];
  const row = db.query(`SELECT t.${title} AS title, t.owner_id, u.display_name AS owner_name FROM ${table} t JOIN users u ON u.id = t.owner_id WHERE t.id = ?`)
    .get(id) as { title: string; owner_id: string; owner_name: string } | null;
  if (!row) return null;
  const readable = canReadItem(kind, id, viewerId);
  return {
    kind,
    title: readable ? row.title : `${label} owned by ${row.owner_name}`,
    titleHidden: !readable,
    owner: { id: row.owner_id, displayName: row.owner_name },
    ...(readable ? { id } : {})
  };
}
