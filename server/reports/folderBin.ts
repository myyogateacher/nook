import { registerBinProvider, SWEEP_BATCH_SIZE, SWEEP_RESUME_BATCH_SIZE, type BinItem, type BinSweepCounts, type PurgeOutcome, type PurgeReason, type RestoreOutcome } from "../bin";
import { audit, db, now } from "../db";
import { logger } from "../log";
import { withResourceLock } from "../storage";
import { mayManageFolders, reportsRole, type FolderRow } from "./folderAccess";

const slog = logger("reports");

/**
 * Report folders in the Bin (Lane I), registered with server/bin.ts beside reports. Phase 2 (D483):
 * folders are the workspace's, so only admins see, restore, and purge them in the Bin. The folder an
 * admin deleted is the item; its subfolders went with it (`binned_with`) and come back with it. A
 * restore also files back the reports the delete moved to Unfiled that are still there. Purging
 * deletes the folder and its subfolders; reports are never deleted (their `folder_id` was cleared).
 */

const providedDefaults = { size_bytes: null, board_id: null, board_name: null, attachment: false, attachment_of: null, attachment_kind: null } as const;
const FOLDER = "Reports";
const lockKey = (id: string) => `report_folders:${id}`;

function purgeNow(id: string, options: { reason: PurgeReason; actorId: string | null; dueBy?: string }): PurgeOutcome {
  return db.transaction((): PurgeOutcome => {
    const retention = options.dueBy === undefined ? "" : " AND (purge_started_at IS NOT NULL OR purge_after <= $dueBy)";
    const marked = db.query(`UPDATE report_folders SET purge_started_at = COALESCE(purge_started_at, $startedAt) WHERE id = $id AND deleted_at IS NOT NULL${retention}`)
      .run({ startedAt: now(), id, ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) });
    if (marked.changes === 0) return "not_found";
    // Subfolders binned with it go too (and by the parent_id cascade); reports only lose the folder.
    db.query("DELETE FROM report_folders WHERE binned_with = ?").run(id);
    db.query("DELETE FROM report_folders WHERE id = ?").run(id);
    audit(options.actorId, null, "reports.folder.purge", { id, reason: options.reason });
    return "purged";
  })();
}

registerBinProvider("report_folder", {
  list(userId) {
    if (!mayManageFolders(reportsRole(userId))) return [];
    const rows = db.query("SELECT * FROM report_folders WHERE deleted_at IS NOT NULL AND binned_with IS NULL ORDER BY deleted_at DESC, id LIMIT 500").all() as FolderRow[];
    return rows.map((row): BinItem => ({
      type: "report_folder", id: row.id, title: row.name, folder_id: null, folder_name: FOLDER, deleted_at: row.deleted_at!, purge_after: row.purge_after!,
      purging: row.purge_started_at !== null, ...providedDefaults, can_purge: true
    }));
  },
  restore(id, userId) {
    return withResourceLock(lockKey(id), async (): Promise<RestoreOutcome> => db.transaction((): RestoreOutcome => {
      const row = db.query("SELECT * FROM report_folders WHERE id = ?").get(id) as FolderRow | null;
      if (!row || !mayManageFolders(reportsRole(userId))) return { status: "not_found" };
      if (row.purge_started_at !== null) return { status: "purging" };
      if (row.deleted_at === null) return { status: "already_restored", folderId: id, folderName: row.name };
      if (row.binned_with !== null) return { status: "parent_in_bin", message: "Restore the folder it was deleted with first" };
      if (row.parent_id && (db.query("SELECT deleted_at FROM report_folders WHERE id = ?").get(row.parent_id) as { deleted_at: string | null } | null)?.deleted_at) {
        return { status: "parent_in_bin", message: "Its parent folder is in the Bin: restore that first" };
      }
      const group = [row, ...(db.query("SELECT * FROM report_folders WHERE binned_with = ? AND deleted_at IS NOT NULL").all(id) as FolderRow[])];
      const at = now();
      let refiled = 0;
      for (const folder of group) {
        db.query("UPDATE report_folders SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, binned_with = NULL, unfiled_json = '[]', updated_at = ? WHERE id = ?").run(at, folder.id);
        // Only reports still in Unfiled go back: one filed elsewhere since stays where its owner put it.
        refiled += db.query("UPDATE reports SET folder_id = ? WHERE folder_id IS NULL AND id IN (SELECT value FROM json_each(?))").run(folder.id, folder.unfiled_json).changes;
      }
      audit(userId, null, "reports.folder.restore", { id, subfolders: group.length - 1, refiled });
      return { status: "restored", folderId: id, folderName: row.name, visibility: "private" };
    })());
  },
  purge(id, userId) {
    return withResourceLock(lockKey(id), async () => {
      const row = db.query("SELECT deleted_at FROM report_folders WHERE id = ?").get(id) as Pick<FolderRow, "deleted_at"> | null;
      if (!row || !mayManageFolders(reportsRole(userId))) return "not_found";
      if (row.deleted_at === null) return "live";
      return purgeNow(id, { reason: "user", actorId: userId });
    });
  },
  async sweep(cutoff) {
    const resumed = db.query("SELECT id FROM report_folders WHERE purge_started_at IS NOT NULL AND binned_with IS NULL LIMIT ?").all(SWEEP_RESUME_BATCH_SIZE) as Array<{ id: string }>;
    const due = db.query("SELECT id FROM report_folders WHERE deleted_at IS NOT NULL AND binned_with IS NULL AND purge_started_at IS NULL AND purge_after <= ? ORDER BY purge_after LIMIT ?").all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string }>;
    const counts: BinSweepCounts = { purged: 0, pending: 0 };
    for (const [items, reason] of [[resumed, "resumed"], [due, "retention"]] as const) {
      for (const { id } of items) {
        try {
          const outcome = await withResourceLock(lockKey(id), async () => purgeNow(id, { reason, actorId: null, dueBy: cutoff }));
          if (outcome === "purged") counts.purged += 1;
        } catch (error) {
          counts.pending += 1;
          slog.error("Bin sweep could not purge a report folder", error);
        }
      }
    }
    return counts;
  },
  async empty(userId) {
    const counts: BinSweepCounts = { purged: 0, pending: 0 };
    // Emptying an admin's Bin purges the folders they deleted; another admin's stay until that admin or the retention purges them.
    const ids = mayManageFolders(reportsRole(userId)) ? db.query("SELECT id FROM report_folders WHERE deleted_by = ? AND deleted_at IS NOT NULL AND binned_with IS NULL").all(userId) as Array<{ id: string }> : [];
    for (const { id } of ids) {
      const outcome = await withResourceLock(lockKey(id), async () => purgeNow(id, { reason: "user", actorId: userId }));
      if (outcome === "purged") counts.purged += 1;
    }
    return counts;
  }
});
