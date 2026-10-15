import { REPORT_FOLDER_DEPTH, type ReportFolder, type ReportSummary } from "../../shared/reports";
import type { ReportsFolderView } from "../router";

/** Lane I: the Reports home's folder tree, as pure helpers (the nav, the Move to… sheet, the New report sheet). */

export type FolderNode = { folder: ReportFolder; depth: number };

/** The folders in display order: each parent before its children, siblings by position, then name. */
export function orderedFolders(folders: readonly ReportFolder[]): FolderNode[] {
  const byParent = new Map<string | null, ReportFolder[]>();
  const ids = new Set(folders.map((folder) => folder.id));
  for (const folder of folders) {
    // A folder whose parent is missing (binned on its own) shows at the top.
    const parent = folder.parentId && ids.has(folder.parentId) ? folder.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), folder]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const out: FolderNode[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const folder of byParent.get(parent) ?? []) {
      out.push({ folder, depth });
      if (depth < 8) walk(folder.id, depth + 1);
    }
  };
  walk(null, 1);
  return out;
}

/** "Finance / Quarterly reviews": the folder's name after its parents'. */
export function folderPath(folders: readonly ReportFolder[], id: string | null): string {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const names: string[] = [];
  for (let at = id ? byId.get(id) : undefined; at && names.length < 8; at = at.parentId ? byId.get(at.parentId) : undefined) names.unshift(at.name);
  return names.join(" / ");
}

/** Whether a folder at `depth` may get a subfolder. */
export const canNest = (depth: number) => depth < REPORT_FOLDER_DEPTH;

/** The heading for a view: All reports, Unfiled, Shared with me, or the folder's name. */
export function viewTitle(view: ReportsFolderView | null, folders: readonly ReportFolder[]): string {
  if (!view) return "All reports";
  if (view === "unfiled") return "Unfiled";
  if (view === "shared") return "Shared with me";
  if (view === "favorites") return "Favorites";
  return folders.find((folder) => folder.id === view)?.name ?? "Folder";
}

/** The reports a view shows: All is every report; Unfiled the caller's own in no folder; Shared the ones shared with them. */
export function reportsInView(reports: readonly ReportSummary[], view: ReportsFolderView | null): ReportSummary[] {
  if (!view) return [...reports];
  if (view === "unfiled") return reports.filter((report) => report.isOwner && !report.folderId);
  if (view === "shared") return reports.filter((report) => !report.isOwner);
  return reports.filter((report) => report.folderId === view);
}

export const CADENCE_LABELS: Record<string, string> = { hourly: "Hourly", daily: "Daily", weekdays: "Weekdays", weekly: "Weekly" };

/** The drag type of a report row (its id), so drops accept only report rows. */
export const REPORT_DRAG_TYPE = "application/x-nook-report";
export const isReportDrag = (types: readonly string[] | DOMStringList) => Array.from(types as ArrayLike<string>).includes(REPORT_DRAG_TYPE);

// K2: folders dragged in the nav (nest or reorder), and the ⋯ menu's Move folder to… / Move up / Move down.

/** The drag type of a folder in the nav (its id), so report drops and folder drops never mix. */
export const FOLDER_DRAG_TYPE = "application/x-nook-report-folder";
export const isFolderDrag = (types: readonly string[] | DOMStringList) => Array.from(types as ArrayLike<string>).includes(FOLDER_DRAG_TYPE);

/** Where a dragged folder lands relative to the folder under the pointer. */
export type FolderDropZone = "before" | "into" | "after";
/** A folder move the server takes (`PATCH /reports/folders/:id`): its new parent and index among the new siblings. */
export type FolderPlace = { parentId: string | null; position: number };
export type FolderDropPlan = { ok: true; place: FolderPlace } | { ok: false; reason: string } | { ok: "same" };

/** The zone of a drop at `offsetY` within a row `height` tall: the top and bottom quarters insert, the middle nests. */
export function dropZoneAt(offsetY: number, height: number): FolderDropZone {
  if (offsetY < height / 4) return "before";
  if (offsetY >= height - height / 4) return "after";
  return "into";
}

function byIdOf(folders: readonly ReportFolder[]) {
  return new Map(folders.map((folder) => [folder.id, folder]));
}
/** 1 for a top-level folder, 2 for its child… (0 for the top level itself, a null id). */
export function folderDepth(folders: readonly ReportFolder[], id: string | null): number {
  const byId = byIdOf(folders);
  let depth = 0;
  for (let at = id ? byId.get(id) : undefined; at && depth < 9; at = at.parentId ? byId.get(at.parentId) : undefined) depth += 1;
  return depth;
}
/** The levels a folder and its subfolders take: 1 with no subfolders. */
export function folderHeight(folders: readonly ReportFolder[], id: string, guard = 0): number {
  if (guard > 8) return 1;
  const children = folders.filter((folder) => folder.parentId === id);
  return 1 + Math.max(0, ...children.map((child) => folderHeight(folders, child.id, guard + 1)));
}
/** Whether `id` is `ancestorId` or lies anywhere under it. */
export function isWithin(folders: readonly ReportFolder[], id: string | null, ancestorId: string): boolean {
  const byId = byIdOf(folders);
  let steps = 0;
  for (let at = id ? byId.get(id) : undefined; at && steps < 9; at = at.parentId ? byId.get(at.parentId) : undefined, steps += 1) if (at.id === ancestorId) return true;
  return false;
}
/** The folders under `parentId`, in display order (a folder whose parent is missing counts as top level). */
export function siblingsOf(folders: readonly ReportFolder[], parentId: string | null): ReportFolder[] {
  const ids = new Set(folders.map((folder) => folder.id));
  return folders.filter((folder) => (folder.parentId && ids.has(folder.parentId) ? folder.parentId : null) === parentId)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}
/** Where a folder is now: its parent and index among its siblings (what Undo puts back). */
export function placeOf(folders: readonly ReportFolder[], id: string): FolderPlace {
  const folder = folders.find((item) => item.id === id);
  const ids = new Set(folders.map((item) => item.id));
  const parentId = folder?.parentId && ids.has(folder.parentId) ? folder.parentId : null;
  return { parentId, position: Math.max(0, siblingsOf(folders, parentId).findIndex((item) => item.id === id)) };
}

/** Why `movingId` may not go under `parentId` (null: it may): itself, its own subfolder, or deeper than the limit. */
export function refuseParent(folders: readonly ReportFolder[], movingId: string, parentId: string | null): string | null {
  if (parentId === movingId) return "A folder cannot go inside itself";
  if (parentId && isWithin(folders, parentId, movingId)) return "A folder cannot go inside its own subfolder";
  const levels = folderHeight(folders, movingId);
  if (folderDepth(folders, parentId) + levels > REPORT_FOLDER_DEPTH) {
    return `Folders nest up to ${REPORT_FOLDER_DEPTH} levels${levels > 1 ? ` (this one takes ${levels} with its subfolders)` : ""}`;
  }
  return null;
}

/** `movingId` under `parentId` at `index` of the siblings that stay (the server's `position`). */
export function planPlace(folders: readonly ReportFolder[], movingId: string, parentId: string | null, index: number): FolderDropPlan {
  const reason = refuseParent(folders, movingId, parentId);
  if (reason) return { ok: false, reason };
  const now = placeOf(folders, movingId);
  if (now.parentId === parentId && now.position === index) return { ok: "same" };
  return { ok: true, place: { parentId, position: index } };
}

/** A drop of `movingId` on `targetId`'s row in `zone`: nest into it (at the end), or insert before or after it among its siblings. */
export function planFolderDrop(folders: readonly ReportFolder[], movingId: string, targetId: string, zone: FolderDropZone): FolderDropPlan {
  if (targetId === movingId || !folders.some((folder) => folder.id === targetId)) return { ok: "same" };
  if (zone === "into") return planPlace(folders, movingId, targetId, siblingsOf(folders, targetId).filter((folder) => folder.id !== movingId).length);
  const parentId = placeOf(folders, targetId).parentId;
  const kept = siblingsOf(folders, parentId).filter((folder) => folder.id !== movingId);
  return planPlace(folders, movingId, parentId, kept.findIndex((folder) => folder.id === targetId) + (zone === "after" ? 1 : 0));
}

/** Move up / Move down among its siblings (null at that end). */
export function planStep(folders: readonly ReportFolder[], id: string, step: -1 | 1): FolderPlace | null {
  const now = placeOf(folders, id);
  const position = now.position + step;
  return position < 0 || position >= siblingsOf(folders, now.parentId).length ? null : { parentId: now.parentId, position };
}
