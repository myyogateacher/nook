import { audit, db, now } from "../db";
import { SWEEP_BATCH_SIZE, SWEEP_RESUME_BATCH_SIZE, type BinItem, type BinProvider, type BinSweepCounts, type PurgeOutcome, type PurgeReason, type RestoreOutcome } from "../bin";
import { withResourceLock } from "../storage";
import { recordItemActivity } from "../activity/service";
import { checkinHref, checkinRow, type CheckinRow } from "./store";
import { rearm } from "./rounds";

/**
 * Standups in the Bin (§B.13): the owner, or whoever binned it, restores; the owner purges. Purging
 * deletes the standup (rounds, participants, blockers cascade) and 099's triggers clear its rows in
 * shared tables (responses, question sets, schedules, links, activity, comments, grants).
 */


const FOLDER = "Standups";
const providedDefaults = { size_bytes: null, board_id: null, board_name: null, attachment: false, attachment_of: null, attachment_kind: null } as const;

function purgeNow(id: string, options: { reason: PurgeReason; actorId: string | null; dueBy?: string }): PurgeOutcome {
  return db.transaction((): PurgeOutcome => {
    const retention = options.dueBy === undefined ? "" : " AND (purge_started_at IS NOT NULL OR purge_after <= $dueBy)";
    const marked = db.query(`UPDATE checkins SET purge_started_at = COALESCE(purge_started_at, $startedAt) WHERE id = $id AND deleted_at IS NOT NULL${retention}`)
      .run({ startedAt: now(), id, ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) });
    if (marked.changes === 0) return "not_found";
    db.query("DELETE FROM checkins WHERE id = ?").run(id);
    audit(options.actorId, null, "checkins.purge", { checkinId: id, reason: options.reason });
    return "purged";
  })();
}

/** Who may restore or purge a binned standup: its owner, or whoever binned it. */
const mayManageBinned = (row: CheckinRow, userId: string) => row.owner_id === userId || row.deleted_by === userId;

export const binProvider: BinProvider = {
  list(userId) {
    const rows = db.query("SELECT * FROM checkins WHERE (owner_id = ? OR deleted_by = ?) AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, id LIMIT 500").all(userId, userId) as CheckinRow[];
    return rows.map((row): BinItem => ({ type: "checkin", id: row.id, title: row.name, folder_id: null, folder_name: FOLDER, deleted_at: row.deleted_at!, purge_after: row.purge_after!, purging: row.purge_started_at !== null, ...providedDefaults, can_purge: row.owner_id === userId, href: checkinHref(row) }));
  },
  restore(id, userId) {
    return withResourceLock(`checkins:${id}`, async (): Promise<RestoreOutcome> => {
      const row = checkinRow(id);
      if (!row || !mayManageBinned(row, userId)) return { status: "not_found" };
      if (row.purge_started_at !== null) return { status: "purging" };
      if (row.deleted_at === null) return { status: "already_restored", folderId: null, folderName: FOLDER };
      db.transaction(() => {
        db.query("UPDATE checkins SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ? WHERE id = ?").run(now(), row.id);
        recordItemActivity({ itemKind: "checkin", itemId: row.id, actorId: userId, kind: "restored" });
        audit(userId, null, "checkins.restore", { checkinId: row.id });
        rearm(checkinRow(row.id)!);
      })();
      return { status: "restored", folderId: null, folderName: FOLDER, visibility: row.visibility };
    });
  },
  purge(id, userId) {
    return withResourceLock(`checkins:${id}`, async () => {
      const row = checkinRow(id);
      if (!row || row.owner_id !== userId) return "not_found";
      if (row.deleted_at === null) return "live";
      return purgeNow(row.id, { reason: "user", actorId: userId });
    });
  },
  async sweep(cutoff) {
    const resumed = db.query("SELECT id FROM checkins WHERE purge_started_at IS NOT NULL LIMIT ?").all(SWEEP_RESUME_BATCH_SIZE) as Array<{ id: string }>;
    const due = db.query("SELECT id FROM checkins WHERE deleted_at IS NOT NULL AND purge_started_at IS NULL AND purge_after <= ? ORDER BY purge_after LIMIT ?").all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string }>;
    const counts: BinSweepCounts = { purged: 0, pending: 0 };
    for (const [items, reason] of [[resumed, "resumed"], [due, "retention"]] as const) {
      for (const { id } of items) {
        try {
          if (await withResourceLock(`checkins:${id}`, async () => purgeNow(id, { reason, actorId: null, dueBy: cutoff })) === "purged") counts.purged += 1;
        } catch {
          counts.pending += 1;
        }
      }
    }
    return counts;
  },
  async empty(userId) {
    const counts: BinSweepCounts = { purged: 0, pending: 0 };
    for (const { id } of db.query("SELECT id FROM checkins WHERE owner_id = ? AND deleted_at IS NOT NULL").all(userId) as Array<{ id: string }>) {
      if (await withResourceLock(`checkins:${id}`, async () => purgeNow(id, { reason: "user", actorId: userId })) === "purged") counts.purged += 1;
    }
    return counts;
  }
};
