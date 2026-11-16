import { SWEEP_BATCH_SIZE, SWEEP_RESUME_BATCH_SIZE, type BinItem, type BinProvider, type BinSweepCounts, type PurgeOutcome, type PurgeReason, type RestoreOutcome } from "../bin";
import { audit, db, now } from "../db";
import { withResourceLock } from "../storage";
import { logger } from "../log";
import { sessionChanged } from "./live";
import { townhallPath } from "../../shared/townhall";

const slog = logger("townhall");

/**
 * Townhall sessions in the Bin (§B.13): the owner lists, restores, and purges them; retention purges
 * after 30 days. Purging deletes the session; its questions, votes, polls, and attendance go by
 * cascade, and 115's trigger removes grants, links, activity, comments, schedules, public links, and
 * the question set and its responses.
 */

const defaults = { folder_id: null, folder_name: "Townhall", size_bytes: null, board_id: null, board_name: null, attachment: false, attachment_of: null, attachment_kind: null } as const;
type Binned = { id: string; owner_id: string; title: string; short_id: string; deleted_at: string | null; deleted_by: string | null; purge_after: string | null; purge_started_at: string | null; visibility: "private" | "selected" | "all_users" };
const select = "SELECT id, owner_id, title, short_id, deleted_at, deleted_by, purge_after, purge_started_at, visibility FROM townhall_sessions";

function purgeNow(id: string, options: { reason: PurgeReason; actorId: string | null; dueBy?: string }): PurgeOutcome {
  return db.transaction((): PurgeOutcome => {
    const retention = options.dueBy === undefined ? "" : " AND (purge_started_at IS NOT NULL OR purge_after <= $dueBy)";
    const marked = db.query(`UPDATE townhall_sessions SET purge_started_at = COALESCE(purge_started_at, $startedAt) WHERE id = $id AND deleted_at IS NOT NULL${retention}`)
      .run({ startedAt: now(), id, ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) });
    if (marked.changes === 0) return "not_found";
    db.query("DELETE FROM townhall_sessions WHERE id = ?").run(id);
    audit(options.actorId, null, "townhall.session_purged", { sessionId: id, reason: options.reason });
    return "purged";
  })();
}

async function sweep(cutoff: string): Promise<BinSweepCounts> {
  const resumed = db.query("SELECT id FROM townhall_sessions WHERE purge_started_at IS NOT NULL LIMIT ?").all(SWEEP_RESUME_BATCH_SIZE) as Array<{ id: string }>;
  const due = db.query("SELECT id FROM townhall_sessions WHERE deleted_at IS NOT NULL AND purge_started_at IS NULL AND purge_after <= ? ORDER BY purge_after LIMIT ?").all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string }>;
  const counts: BinSweepCounts = { purged: 0, pending: 0 };
  for (const [items, reason] of [[resumed, "resumed"], [due, "retention"]] as const) {
    for (const { id } of items) {
      try {
        if (await withResourceLock(`townhall:${id}`, async () => purgeNow(id, { reason, actorId: null, dueBy: cutoff })) === "purged") counts.purged += 1;
      } catch (error) {
        counts.pending += 1;
        slog.error("Bin sweep could not purge a townhall session", error);
      }
    }
  }
  return counts;
}

export const townhallBinProvider: BinProvider = {
  list(userId) {
    const rows = db.query(`${select} WHERE owner_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, id LIMIT 500`).all(userId) as Binned[];
    return rows.map((row): BinItem => ({ type: "townhall_session", id: row.id, title: row.title, deleted_at: row.deleted_at!, purge_after: row.purge_after!, purging: row.purge_started_at !== null, ...defaults, can_purge: true, href: townhallPath(row.title, row.short_id) }));
  },
  restore(id, userId) {
    return withResourceLock(`townhall:${id}`, async (): Promise<RestoreOutcome> => {
      const row = db.query(`${select} WHERE id = ?`).get(id) as Binned | null;
      if (!row || row.owner_id !== userId) return { status: "not_found" };
      if (row.purge_started_at !== null) return { status: "purging" };
      if (row.deleted_at === null) return { status: "already_restored", folderId: null, folderName: "Townhall" };
      db.query("UPDATE townhall_sessions SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?").run(now(), id);
      audit(userId, null, "townhall.session_restored", { sessionId: id });
      sessionChanged(id);
      return { status: "restored", folderId: null, folderName: "Townhall", visibility: row.visibility };
    });
  },
  purge(id, userId) {
    return withResourceLock(`townhall:${id}`, async () => {
      const row = db.query(`${select} WHERE id = ?`).get(id) as Binned | null;
      if (!row || row.owner_id !== userId) return "not_found";
      if (row.deleted_at === null) return "live";
      return purgeNow(id, { reason: "user", actorId: userId });
    });
  },
  sweep,
  async empty(userId) {
    const counts: BinSweepCounts = { purged: 0, pending: 0 };
    const ids = db.query("SELECT id FROM townhall_sessions WHERE owner_id = ? AND deleted_at IS NOT NULL").all(userId) as Array<{ id: string }>;
    for (const { id } of ids) if (await withResourceLock(`townhall:${id}`, async () => purgeNow(id, { reason: "user", actorId: userId })) === "purged") counts.purged += 1;
    return counts;
  }
};
