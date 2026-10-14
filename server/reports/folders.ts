import { audit, db, now } from "../db";
import { purgeAfterFrom } from "../bin";
import { logger } from "../log";
import { REPORT_FOLDER_DEPTH, REPORT_FOLDERS_PER_USER, type ReportFolder, type ReportFolderTree, type ReportSummary } from "../../shared/reports";
import { ownedReport, readableReportSql } from "./access";
import { ReportError } from "./errors";
import { folderNotFound, ownedFolder, type FolderRow } from "./folderAccess";
import { listReports } from "./service";

const slog = logger("reports");

/**
 * Report folders (Lane I, migration 059): the owner's private organisation of their reports on the
 * Reports home. Create, rename, reorder and move (nesting up to REPORT_FOLDER_DEPTH levels), file a
 * report in a folder or in Unfiled, and delete a folder to the Bin (server/reports/folderBin.ts): its
 * reports move to Unfiled and are never deleted. Every change is the owner's and audited; a reader of a
 * shared report never sees the owner's folders.
 */

type Via = { keyId?: string };
const viaMeta = (via: Via) => via.keyId ? { via: "mcp", keyId: via.keyId } : {};

function liveFolders(userId: string): FolderRow[] {
  return db.query("SELECT * FROM report_folders WHERE owner_id = ? AND deleted_at IS NULL ORDER BY position, name COLLATE NOCASE, id").all(userId) as FolderRow[];
}

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
 * The left nav: the owner's live folders (parent, position) with the count of their live reports
 * directly in each, and the counts of All (every report they can open), Unfiled, and Shared with me.
 * `ids` (an MCP key over chosen reports) narrows every count to those reports.
 */
export function listFolders(userId: string, options: { ids?: readonly string[] | null } = {}): ReportFolderTree {
  const ids = options.ids ? JSON.stringify(options.ids) : null;
  const scoped = "($ids IS NULL OR r.id IN (SELECT value FROM json_each($ids)))";
  const perFolder = db.query(`SELECT r.folder_id AS folder_id, COUNT(*) AS count FROM reports r WHERE r.owner_id = $userId AND r.deleted_at IS NULL AND ${scoped} GROUP BY r.folder_id`)
    .all({ userId, ids }) as Array<{ folder_id: string | null; count: number }>;
  const counts = new Map(perFolder.map((row) => [row.folder_id, row.count]));
  const totals = db.query(`SELECT COUNT(*) AS total, COALESCE(SUM(r.owner_id <> $userId), 0) AS shared FROM reports r WHERE ${readableReportSql("r")} AND ${scoped}`)
    .get({ userId, ids }) as { total: number; shared: number };
  const folders = liveFolders(userId);
  return {
    folders: folders.map((row): ReportFolder => ({ id: row.id, parentId: row.parent_id, name: row.name, position: row.position, count: counts.get(row.id) ?? 0, createdAt: row.created_at, updatedAt: row.updated_at })),
    counts: { all: totals.total, unfiled: counts.get(null) ?? 0, shared: totals.shared }
  };
}

function folderOf(row: FolderRow, userId: string): ReportFolder {
  return listFolders(userId).folders.find((folder) => folder.id === row.id) ?? { id: row.id, parentId: row.parent_id, name: row.name, position: row.position, count: 0, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** A parent the caller owns, with room below it for a subtree `height` levels tall. */
function checkParent(userId: string, parentId: string | null, height: number, folders: readonly FolderRow[]) {
  if (parentId === null) return;
  ownedFolder(parentId, userId);
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  if (depthOf(parentId, byId) + height > REPORT_FOLDER_DEPTH) {
    throw new ReportError(400, "TOO_DEEP", `Folders nest up to ${REPORT_FOLDER_DEPTH} levels`);
  }
}

/** Renumbers the siblings under `parentId` 0, 1, 2…, with `movedId` at `index` (the end when null). */
function placeAmongSiblings(userId: string, parentId: string | null, movedId: string, index: number | null) {
  const siblings = (db.query("SELECT id FROM report_folders WHERE owner_id = ? AND parent_id IS ? AND deleted_at IS NULL AND id <> ? ORDER BY position, name COLLATE NOCASE, id")
    .all(userId, parentId, movedId) as Array<{ id: string }>).map((row) => row.id);
  const at = index === null ? siblings.length : Math.max(0, Math.min(index, siblings.length));
  siblings.splice(at, 0, movedId);
  const update = db.query("UPDATE report_folders SET position = ? WHERE id = ?");
  siblings.forEach((id, position) => update.run(position, id));
}

export function createFolder(userId: string, input: { name: string; parentId?: string | null }, via: Via = {}): ReportFolder {
  return db.transaction(() => {
    const folders = liveFolders(userId);
    if (folders.length >= REPORT_FOLDERS_PER_USER) throw new ReportError(409, "LIMIT_REACHED", `You can have up to ${REPORT_FOLDERS_PER_USER} report folders`);
    const parentId = input.parentId ?? null;
    checkParent(userId, parentId, 1, folders);
    const id = crypto.randomUUID();
    const at = now();
    db.query("INSERT INTO report_folders (id, owner_id, parent_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, userId, parentId, input.name, folders.length, at, at);
    placeAmongSiblings(userId, parentId, id, null);
    audit(userId, null, "reports.folder.create", { id, ...(parentId ? { parentId } : {}), ...viaMeta(via) });
    return folderOf(ownedFolder(id, userId), userId);
  })();
}

/** Rename, move under another parent (null: the top), and/or place at `position` among its siblings. */
export function updateFolder(userId: string, id: string, patch: { name?: string; parentId?: string | null; position?: number }): ReportFolder {
  return db.transaction(() => {
    const row = ownedFolder(id, userId);
    const folders = liveFolders(userId);
    const moving = patch.parentId !== undefined && patch.parentId !== row.parent_id;
    if (moving) {
      if (patch.parentId && subtreeIds(id, folders).includes(patch.parentId)) throw new ReportError(400, "INVALID", "A folder cannot go inside itself");
      checkParent(userId, patch.parentId ?? null, heightOf(id, folders), folders);
    }
    const parentId = moving ? patch.parentId ?? null : row.parent_id;
    db.query("UPDATE report_folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?").run(patch.name ?? row.name, parentId, now(), id);
    if (moving || patch.position !== undefined) placeAmongSiblings(userId, parentId, id, patch.position ?? null);
    audit(userId, null, "reports.folder.update", { id, fields: Object.keys(patch), ...(moving ? { parentId } : {}) });
    return folderOf(ownedFolder(id, userId), userId);
  })();
}

/**
 * Moves a folder and its subfolders to the Bin. Every report in them moves to Unfiled (never deleted);
 * the folder remembers which, so a restore puts back the ones still in Unfiled.
 */
export function binFolder(userId: string, id: string) {
  const at = new Date();
  const result = db.transaction(() => {
    ownedFolder(id, userId);
    const ids = subtreeIds(id, liveFolders(userId));
    const stamp = at.toISOString();
    const purgeAfter = purgeAfterFrom(at);
    let moved = 0;
    for (const folderId of ids) {
      const reports = (db.query("SELECT id FROM reports WHERE folder_id = ? AND owner_id = ?").all(folderId, userId) as Array<{ id: string }>).map((report) => report.id);
      db.query("UPDATE reports SET folder_id = NULL WHERE folder_id = ? AND owner_id = ?").run(folderId, userId);
      moved += reports.length;
      db.query("UPDATE report_folders SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ?, binned_with = ?, unfiled_json = ? WHERE id = ?")
        .run(stamp, userId, purgeAfter, stamp, folderId === id ? null : id, JSON.stringify(reports), folderId);
    }
    audit(userId, null, "reports.folder.bin", { id, subfolders: ids.length - 1, unfiled: moved });
    return { ok: true as const, purgeAfter, unfiled: moved, subfolders: ids.length - 1 };
  })();
  slog.info("Report folder moved to the Bin", { folderId: id, subfolders: result.subfolders, unfiled: result.unfiled });
  return result;
}

/**
 * Files one of the caller's reports in their folder, or in Unfiled (`folderId` null). The report's
 * content, revision, and updated time stay as they are: a folder is organisation, not an edit.
 */
export function moveReportToFolder(userId: string, reportId: string, folderId: string | null, via: Via = {}): { report: ReportSummary; previousFolderId: string | null } {
  return db.transaction(() => {
    const row = ownedReport(reportId, userId);
    if (folderId !== null) ownedFolder(folderId, userId);
    const previousFolderId = row.folder_id ?? null;
    if (previousFolderId !== folderId) {
      db.query("UPDATE reports SET folder_id = ? WHERE id = ? AND owner_id = ?").run(folderId, reportId, userId);
      audit(userId, null, "reports.report.file", { id: reportId, folderId, from: previousFolderId, ...viaMeta(via) });
    }
    const report = listReports(userId, { ids: [reportId], limit: 1 })[0];
    if (!report) throw folderNotFound();
    return { report, previousFolderId };
  })();
}
