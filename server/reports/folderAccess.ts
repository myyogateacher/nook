import { db } from "../db";
import { ReportError } from "./errors";

/** A row of `report_folders` (migration 059). */
export type FolderRow = {
  id: string; owner_id: string; parent_id: string | null; name: string; position: number; created_at: string; updated_at: string;
  deleted_at: string | null; deleted_by: string | null; purge_after: string | null; purge_started_at: string | null; binned_with: string | null; unfiled_json: string;
};

export const folderNotFound = () => new ReportError(404, "NOT_FOUND", "Folder not found");

/** The caller's live folder (Lane I: folders are the owner's alone); anyone else, or a binned folder, is a 404. */
export function ownedFolder(id: string, userId: string): FolderRow {
  const row = db.query("SELECT * FROM report_folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").get(id, userId) as FolderRow | null;
  if (!row) throw folderNotFound();
  return row;
}
