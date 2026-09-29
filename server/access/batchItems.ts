import { db } from "../db";
import { listReadableFolders, readableNotePredicate } from "../access";
import { readableSinglePredicate } from "../documentAccess";
import { readableBoardPredicate } from "../tasks/access";
import { readableViewPredicate } from "../tasks/views";
import { readableCollectionPredicate } from "../collections/access";
import { readableCalendarPredicate } from "../calendar/access";
import { ITEM_TABLES, presentItem } from "./effective";
import type { AccessKind } from "./levels";

/**
 * `presentItem` for a page of items and one viewer (C10b, the group items page): per kind, one query
 * for titles and owners and one for readability through the module's own readable predicate
 * (folders through the viewer's folder list, once), instead of two or more queries per item.
 * Results equal `presentItem(kind, id, viewerId)` item for item; keyed by `kind:id`.
 */

const READABLE_SQL: Record<Exclude<AccessKind, "folder">, string> = {
  note: `SELECT n.id FROM notes n WHERE n.id IN (SELECT value FROM json_each($ids)) AND n.deleted_at IS NULL AND ${readableNotePredicate}`,
  document: `SELECT d.id FROM documents d WHERE d.id IN (SELECT value FROM json_each($ids)) AND d.purpose = 'file' AND ${readableSinglePredicate}`,
  board: `SELECT b.id FROM boards b WHERE b.id IN (SELECT value FROM json_each($ids)) AND ${readableBoardPredicate}`,
  task_view: `SELECT v.id FROM task_views v JOIN users u ON u.id = v.owner_id WHERE v.id IN (SELECT value FROM json_each($ids)) AND ${readableViewPredicate}`,
  collection: `SELECT c.id FROM collections c WHERE c.id IN (SELECT value FROM json_each($ids)) AND ${readableCollectionPredicate}`,
  calendar: `SELECT k.id FROM calendars k WHERE k.id IN (SELECT value FROM json_each($ids)) AND ${readableCalendarPredicate}`
};

export type PresentedItem = NonNullable<ReturnType<typeof presentItem>>;

export function presentItems(items: ReadonlyArray<{ kind: AccessKind; id: string }>, viewerId: string): Map<string, PresentedItem | null> {
  const result = new Map<string, PresentedItem | null>();
  const byKind = new Map<AccessKind, string[]>();
  for (const item of items) byKind.set(item.kind, [...new Set([...byKind.get(item.kind) ?? [], item.id])]);
  for (const [kind, ids] of byKind) {
    const { table, title, label } = ITEM_TABLES[kind];
    const rows = db.query(`SELECT t.id, t.${title} AS title, t.owner_id, u.display_name AS owner_name FROM ${table} t JOIN users u ON u.id = t.owner_id
      WHERE t.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as Array<{ id: string; title: string; owner_id: string; owner_name: string }>;
    const found = new Map(rows.map((row) => [row.id, row]));
    const present = ids.filter((id) => found.has(id));
    const readable = new Set<string>();
    if (present.length) {
      if (kind === "folder") {
        const folders = new Set(listReadableFolders(viewerId).map((folder) => folder.id));
        for (const id of present) if (folders.has(id)) readable.add(id);
      } else {
        for (const row of db.query(READABLE_SQL[kind]).all({ ids: JSON.stringify(present), userId: viewerId }) as Array<{ id: string }>) readable.add(row.id);
      }
    }
    for (const id of ids) {
      const row = found.get(id);
      if (!row) { result.set(`${kind}:${id}`, null); continue; }
      const canRead = readable.has(id);
      result.set(`${kind}:${id}`, {
        kind,
        title: canRead ? row.title : `${label} owned by ${row.owner_name}`,
        titleHidden: !canRead,
        owner: { id: row.owner_id, displayName: row.owner_name },
        ...(canRead ? { id } : {})
      });
    }
  }
  return result;
}
