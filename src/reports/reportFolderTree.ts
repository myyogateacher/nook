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
