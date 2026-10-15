import { registerBinProvider, SWEEP_BATCH_SIZE, SWEEP_RESUME_BATCH_SIZE, type BinItem, type BinSweepCounts, type PurgeOutcome, type PurgeReason, type RestoreOutcome } from "../bin";
import { audit, db, now } from "../db";
import { withResourceLock } from "../storage";
import { REPORTS_PER_USER } from "./service";
import { isReportOwner } from "./access";
import { logger } from "../log";

const slog = logger("reports");

/**
 * Reports in the Bin (plan wave 45, D419), registered with server/bin.ts like chats and agents. The
 * owner alone lists, restores, and purges them. Purging deletes the report and, by cascade, its doc
 * snapshots, queries, runs, results, and schedule; 050's trigger removes key grants that name it.
 * Everything lives in SQLite, so a purge is one transaction.
 */

const providedDefaults = { size_bytes: null, board_id: null, board_name: null, attachment: false, attachment_of: null, attachment_kind: null } as const;
const FOLDER = "Reports";
type Binned = { id: string; owner_id: string; title: string; deleted_at: string | null; purge_after: string | null; purge_started_at: string | null; visibility: "private" | "selected" | "all_users" };
const select = "SELECT id, owner_id, title, deleted_at, purge_after, purge_started_at, visibility FROM reports";

function purgeNow(id: string, options: { reason: PurgeReason; actorId: string | null; dueBy?: string }): PurgeOutcome {
  return db.transaction((): PurgeOutcome => {
    const retention = options.dueBy === undefined ? "" : " AND (purge_started_at IS NOT NULL OR purge_after <= $dueBy)";
    const marked = db.query(`UPDATE reports SET purge_started_at = COALESCE(purge_started_at, $startedAt) WHERE id = $id AND deleted_at IS NOT NULL${retention}`)
      .run({ startedAt: now(), id, ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) });
    if (marked.changes === 0) return "not_found";
    db.query("DELETE FROM reports WHERE id = ?").run(id);
    audit(options.actorId, null, "reports.report.purge", { id, reason: options.reason });
    return "purged";
  })();
}

export async function sweepReports(cutoff: string): Promise<BinSweepCounts> {
  const resumed = db.query("SELECT id FROM reports WHERE purge_started_at IS NOT NULL LIMIT ?").all(SWEEP_RESUME_BATCH_SIZE) as Array<{ id: string }>;
  const due = db.query("SELECT id FROM reports WHERE deleted_at IS NOT NULL AND purge_started_at IS NULL AND purge_after <= ? ORDER BY purge_after LIMIT ?").all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string }>;
  const counts: BinSweepCounts = { purged: 0, pending: 0 };
  for (const [items, reason] of [[resumed, "resumed"], [due, "retention"]] as const) {
    for (const { id } of items) {
      try {
        const outcome = await withResourceLock(`reports:${id}`, async () => purgeNow(id, { reason, actorId: null, dueBy: cutoff }));
        if (outcome === "purged") counts.purged += 1;
      } catch (error) {
        counts.pending += 1;
        slog.error("Bin sweep could not purge a report", error);
      }
    }
  }
  return counts;
}

registerBinProvider("report", {
  list(userId) {
    // Phase 2 (D482): a binned report is in the Bin of each of its owners.
    const rows = db.query(`${select} WHERE id IN (SELECT report_id FROM report_owners WHERE user_id = ?) AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, id LIMIT 500`).all(userId) as Binned[];
    return rows.map((row): BinItem => ({
      type: "report", id: row.id, title: row.title, folder_id: null, folder_name: FOLDER, deleted_at: row.deleted_at!, purge_after: row.purge_after!,
      purging: row.purge_started_at !== null, ...providedDefaults, can_purge: true
    }));
  },
  restore(id, userId) {
    return withResourceLock(`reports:${id}`, async (): Promise<RestoreOutcome> => {
      const row = db.query(`${select} WHERE id = ?`).get(id) as Binned | null;
      if (!row || !isReportOwner(id, userId)) return { status: "not_found" };
      if (row.purge_started_at !== null) return { status: "purging" };
      if (row.deleted_at === null) return { status: "already_restored", folderId: id, folderName: FOLDER };
      const live = (db.query("SELECT COUNT(*) AS count FROM reports WHERE owner_id = ? AND deleted_at IS NULL").get(userId) as { count: number }).count;
      if (live >= REPORTS_PER_USER) return { status: "limit_reached", message: `You can have up to ${REPORTS_PER_USER} reports` };
      const restored = db.query("UPDATE reports SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL").run(now(), id);
      if (restored.changes !== 1) return { status: "purging" };
      audit(userId, null, "reports.report.restore", { id });
      return { status: "restored", folderId: id, folderName: FOLDER, visibility: row.visibility };
    });
  },
  purge(id, userId) {
    return withResourceLock(`reports:${id}`, async () => {
      const row = db.query(`${select} WHERE id = ?`).get(id) as Binned | null;
      if (!row || !isReportOwner(id, userId)) return "not_found";
      if (row.deleted_at === null) return "live";
      return purgeNow(id, { reason: "user", actorId: userId });
    });
  },
  sweep: (cutoff) => sweepReports(cutoff),
  async empty(userId) {
    const counts: BinSweepCounts = { purged: 0, pending: 0 };
    // Emptying purges the owner's binned reports that they binned themselves: a co-owner's delete stays restorable for 30 days.
    const ids = db.query("SELECT id FROM reports WHERE id IN (SELECT report_id FROM report_owners WHERE user_id = ?) AND deleted_by = ? AND deleted_at IS NOT NULL").all(userId, userId) as Array<{ id: string }>;
    for (const { id } of ids) {
      const outcome = await withResourceLock(`reports:${id}`, async () => purgeNow(id, { reason: "user", actorId: userId }));
      if (outcome === "purged") counts.purged += 1;
    }
    return counts;
  }
});
