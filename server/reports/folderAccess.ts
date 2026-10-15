import { db } from "../db";
import { ReportError } from "./errors";

/** A row of `report_folders` (migration 059, rebuilt by 062 as the workspace's shared tree). */
export type FolderRow = {
  id: string; created_by: string | null; parent_id: string | null; name: string; position: number; created_at: string; updated_at: string;
  deleted_at: string | null; deleted_by: string | null; purge_after: string | null; purge_started_at: string | null; binned_with: string | null; unfiled_json: string;
};

export const folderNotFound = () => new ReportError(404, "NOT_FOUND", "Folder not found");

/** A live folder of the shared tree (phase 2, D483: every member sees the same folders); a binned or missing one is a 404. */
export function liveFolder(id: string): FolderRow {
  const row = db.query("SELECT * FROM report_folders WHERE id = ? AND deleted_at IS NULL").get(id) as FolderRow | null;
  if (!row) throw folderNotFound();
  return row;
}

/** The caller's role, when it has the Reports module and is not blocked. */
export function reportsRole(userId: string): string | null {
  const row = db.query("SELECT role FROM users WHERE id = ? AND disabled_at IS NULL").get(userId) as { role: string } | null;
  return row && row.role !== "guest" ? row.role : null;
}

/** Any member creates folders (admins and members; not viewers or guests). */
export const mayCreateFolders = (role: string | null) => role === "admin" || role === "member";
/** Only admins rename, move, reorder, delete, restore, or purge folders (D483). */
export const mayManageFolders = (role: string | null) => role === "admin";

export function requireFolderAdmin(userId: string) {
  if (!mayManageFolders(reportsRole(userId))) throw new ReportError(403, "ADMIN_ONLY", "Only an admin can rename, move, reorder or delete report folders");
}
