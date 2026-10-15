import { audit, db, now } from "../db";
import { purgeAfterFrom } from "../bin";
import { logger } from "../log";
import { REPORT_FOLDER_DEPTH, REPORT_FOLDERS_PER_USER, REPORT_FOLDERS_PER_WORKSPACE, type ReportFolder, type ReportFolderTree, type ReportOwnerFacet, type ReportSummary } from "../../shared/reports";
import { ownedReport, ownsReportSql, readableReportSql } from "./access";
import { ReportError } from "./errors";
import { folderNotFound, liveFolder, mayCreateFolders, mayManageFolders, reportsRole, requireFolderAdmin, type FolderRow } from "./folderAccess";
import { FAVORITE_SQL, listReports } from "./service";

const slog = logger("reports");

/**
 * Report folders (Lane I, migration 059; phase 2, migration 062, D481/D483): one folder tree for the
 * whole workspace that only groups reports and never grants or limits access. Every member sees the
 * same folders; a folder lists, and counts, only the reports the person can read (T391). Guests have no
 * Reports at all. Any member creates a folder (nesting up to REPORT_FOLDER_DEPTH levels); only admins
 * rename, move, reorder, or delete one (to the Bin, server/reports/folderBin.ts: its reports move to
 * Unfiled, never deleted, and return on restore). Filing a report is a right of its owners. Every
 * change is audited.
 */

type Via = { keyId?: string };
const viaMeta = (via: Via) => via.keyId ? { via: "mcp", keyId: via.keyId } : {};

type TreeRow = FolderRow & { creator_name: string | null };

function liveFolders(): TreeRow[] {
  return db.query("SELECT f.*, u.display_name AS creator_name FROM report_folders f LEFT JOIN users u ON u.id = f.created_by WHERE f.deleted_at IS NULL ORDER BY f.position, f.name COLLATE NOCASE, f.id").all() as TreeRow[];
}

const folderView = (row: TreeRow, count: number): ReportFolder => ({
  id: row.id, parentId: row.parent_id, name: row.name, position: row.position, count, createdAt: row.created_at, updatedAt: row.updated_at,
  createdBy: row.created_by ? { id: row.created_by, name: row.creator_name ?? "" } : null
});

/** The folder's level: 1 at the top, 2 for a subfolder, and so on. */
function depthOf(id: string | null, byId: Map<string, FolderRow>): number {
  let depth = 0;
  for (let at = id; at; at = byId.get(at)?.parent_id ?? null) {
    depth += 1;
    if (depth > 32) break;
  }
  return depth;
}

/** Levels in the folder's subtree, itself included (1 for a folder without subfolders). */
function heightOf(id: string, folders: readonly FolderRow[]): number {
  const children = folders.filter((folder) => folder.parent_id === id);
  return 1 + Math.max(0, ...children.map((child) => heightOf(child.id, folders)));
}

/** The folder and its live subfolders, at every level. */
export function subtreeIds(id: string, folders: readonly FolderRow[]): string[] {
  const ids = [id];
  for (let index = 0; index < ids.length; index += 1) {
    for (const folder of folders) if (folder.parent_id === ids[index] && !ids.includes(folder.id)) ids.push(folder.id);
  }
  return ids;
}

/**
 * The left nav: the shared tree's live folders (parent, position) with the count of the reports the
 * caller can read directly in each (T391), the counts of All (every report they can open), Unfiled
 * (readable and in no folder), Shared with me (readable, not theirs), and Favorites, and the owners of
 * the reports they can open (the Owner filter; a report with several owners counts for each). Two
 * GROUP BYs over the readable set: by folder and ownership, and by owner. `ids` (an MCP key over chosen
 * reports) narrows every count to those reports.
 */
export function listFolders(userId: string, options: { ids?: readonly string[] | null } = {}): ReportFolderTree {
  const ids = options.ids ? JSON.stringify(options.ids) : null;
  const scoped = ids ? " AND r.id IN (SELECT value FROM json_each($ids))" : "";
  const params: Record<string, string> = ids ? { userId, ids } : { userId };
  const groups = db.query(`SELECT COALESCE(r.folder_id, '') AS place, ${ownsReportSql("r")} AS mine, COUNT(*) AS count, SUM(${FAVORITE_SQL}) AS favorites
    FROM reports r WHERE ${readableReportSql("r")}${scoped} GROUP BY place, mine`).all(params) as Array<{ place: string; mine: number; count: number; favorites: number }>;
  const counts = new Map<string, number>();
  const totals = { all: 0, unfiled: 0, shared: 0, favorites: 0 };
  for (const group of groups) {
    totals.all += group.count;
    totals.favorites += group.favorites;
    if (!group.mine) totals.shared += group.count;
    if (group.place === "") totals.unfiled += group.count;
    else counts.set(group.place, (counts.get(group.place) ?? 0) + group.count);
  }
  const owners = (db.query(`SELECT o.user_id AS id, u.display_name AS name, COUNT(*) AS count
    FROM reports r JOIN report_owners o ON o.report_id = r.id JOIN users u ON u.id = o.user_id WHERE ${readableReportSql("r")}${scoped} GROUP BY o.user_id`)
    .all(params) as Array<{ id: string; name: string; count: number }>).map((row): ReportOwnerFacet => ({ ...row, isMe: row.id === userId }));
  const role = reportsRole(userId);
  return {
    folders: liveFolders().map((row) => folderView(row, counts.get(row.id) ?? 0)),
    counts: totals,
    // The caller first, then by name.
    owners: owners.sort((a, b) => Number(b.id === userId) - Number(a.id === userId) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    canCreateFolders: mayCreateFolders(role), canManageFolders: mayManageFolders(role)
  };
}

function folderOf(row: FolderRow, userId: string): ReportFolder {
  return listFolders(userId).folders.find((folder) => folder.id === row.id) ?? folderView({ ...row, creator_name: null }, 0);
}

/** A live parent, with room below it for a subtree `height` levels tall. */
function checkParent(parentId: string | null, height: number, folders: readonly FolderRow[]) {
  if (parentId === null) return;
  liveFolder(parentId);
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  if (depthOf(parentId, byId) + height > REPORT_FOLDER_DEPTH) {
    throw new ReportError(400, "TOO_DEEP", `Folders nest up to ${REPORT_FOLDER_DEPTH} levels`);
  }
}

/** Renumbers the siblings under `parentId` 0, 1, 2…, with `movedId` at `index` (the end when null). */
function placeAmongSiblings(parentId: string | null, movedId: string, index: number | null) {
  const siblings = (db.query("SELECT id FROM report_folders WHERE parent_id IS ? AND deleted_at IS NULL AND id <> ? ORDER BY position, name COLLATE NOCASE, id")
    .all(parentId, movedId) as Array<{ id: string }>).map((row) => row.id);
  const at = index === null ? siblings.length : Math.max(0, Math.min(index, siblings.length));
  siblings.splice(at, 0, movedId);
  const update = db.query("UPDATE report_folders SET position = ? WHERE id = ?");
  siblings.forEach((id, position) => update.run(position, id));
}

/** Any member (admins and members; never viewers or guests) adds a folder to the shared tree (D483). */
export function createFolder(userId: string, input: { name: string; parentId?: string | null }, via: Via = {}): ReportFolder {
  return db.transaction(() => {
    if (!mayCreateFolders(reportsRole(userId))) throw new ReportError(403, "ROLE_READ_ONLY", "Your Team role can only view report folders");
    const folders = liveFolders();
    if (folders.length >= REPORT_FOLDERS_PER_WORKSPACE) throw new ReportError(409, "LIMIT_REACHED", `The team can have up to ${REPORT_FOLDERS_PER_WORKSPACE} report folders`);
    if (folders.filter((folder) => folder.created_by === userId).length >= REPORT_FOLDERS_PER_USER) throw new ReportError(409, "LIMIT_REACHED", `You can create up to ${REPORT_FOLDERS_PER_USER} report folders`);
    const parentId = input.parentId ?? null;
    checkParent(parentId, 1, folders);
    const id = crypto.randomUUID();
    const at = now();
    db.query("INSERT INTO report_folders (id, created_by, parent_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, userId, parentId, input.name, folders.length, at, at);
    placeAmongSiblings(parentId, id, null);
    audit(userId, null, "reports.folder.create", { id, name: input.name, ...(parentId ? { parentId } : {}), ...viaMeta(via) });
    return folderOf(liveFolder(id), userId);
  })();
}

/** Rename, move under another parent (null: the top), and/or place at `position` among its siblings (admins, D483). */
export function updateFolder(userId: string, id: string, patch: { name?: string; parentId?: string | null; position?: number }, via: Via = {}): ReportFolder {
  return db.transaction(() => {
    const row = liveFolder(id);
    requireFolderAdmin(userId);
    const folders = liveFolders();
    const moving = patch.parentId !== undefined && patch.parentId !== row.parent_id;
    if (moving) {
      if (patch.parentId && subtreeIds(id, folders).includes(patch.parentId)) throw new ReportError(400, "INVALID", "A folder cannot go inside itself");
      checkParent(patch.parentId ?? null, heightOf(id, folders), folders);
    }
    const parentId = moving ? patch.parentId ?? null : row.parent_id;
    db.query("UPDATE report_folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?").run(patch.name ?? row.name, parentId, now(), id);
    if (moving || patch.position !== undefined) placeAmongSiblings(parentId, id, patch.position ?? null);
    const renamed = patch.name !== undefined && patch.name !== row.name ? { from: row.name, name: patch.name } : {};
    audit(userId, null, "reports.folder.update", { id, fields: Object.keys(patch), ...renamed, ...(moving ? { parentId } : {}), ...viaMeta(via) });
    return folderOf(liveFolder(id), userId);
  })();
}

/**
 * Moves a folder and its subfolders to the Bin (admins, D483). Every report in them, whoever owns it,
 * moves to Unfiled (never deleted); the folder remembers which, so a restore puts back the ones still in Unfiled.
 */
export function binFolder(userId: string, id: string, via: Via = {}) {
  const at = new Date();
  const result = db.transaction(() => {
    liveFolder(id);
    requireFolderAdmin(userId);
    const ids = subtreeIds(id, liveFolders());
    const stamp = at.toISOString();
    const purgeAfter = purgeAfterFrom(at);
    let moved = 0;
    for (const folderId of ids) {
      const reports = (db.query("SELECT id FROM reports WHERE folder_id = ?").all(folderId) as Array<{ id: string }>).map((report) => report.id);
      db.query("UPDATE reports SET folder_id = NULL WHERE folder_id = ?").run(folderId);
      moved += reports.length;
      db.query("UPDATE report_folders SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ?, binned_with = ?, unfiled_json = ? WHERE id = ?")
        .run(stamp, userId, purgeAfter, stamp, folderId === id ? null : id, JSON.stringify(reports), folderId);
    }
    audit(userId, null, "reports.folder.bin", { id, subfolders: ids.length - 1, unfiled: moved, ...viaMeta(via) });
    return { ok: true as const, purgeAfter, unfiled: moved, subfolders: ids.length - 1 };
  })();
  slog.info("Report folder moved to the Bin", { folderId: id, subfolders: result.subfolders, unfiled: result.unfiled });
  return result;
}

/**
 * Files a report the caller owns (any of its owners, D482) in a folder of the shared tree, or in Unfiled
 * (`folderId` null). The report's content, revision, and updated time stay as they are: a folder is
 * organisation, not an edit, and never changes who can read it (D481).
 */
export function moveReportToFolder(userId: string, reportId: string, folderId: string | null, via: Via = {}): { report: ReportSummary; previousFolderId: string | null } {
  return db.transaction(() => {
    const row = ownedReport(reportId, userId);
    if (folderId !== null) liveFolder(folderId);
    const previousFolderId = row.folder_id ?? null;
    if (previousFolderId !== folderId) {
      db.query("UPDATE reports SET folder_id = ? WHERE id = ?").run(folderId, reportId);
      audit(userId, null, "reports.report.file", { id: reportId, folderId, from: previousFolderId, ...viaMeta(via) });
    }
    const report = listReports(userId, { ids: [reportId], limit: 1 })[0];
    if (!report) throw folderNotFound();
    return { report, previousFolderId };
  })();
}
