import { registerBinProvider, SWEEP_BATCH_SIZE, SWEEP_RESUME_BATCH_SIZE, type BinItem, type BinSweepCounts, type PurgeOutcome, type PurgeReason, type RestoreOutcome } from "../bin";
import { audit, db, now } from "../db";
import { withResourceLock } from "../storage";
import { readAgentSettings } from "../agents/settings";
import { forgetKnowledgeVectors } from "./search";
import { scheduleKnowledge } from "./index";
import { logger } from "../log";

const slog = logger("knowledge");

/**
 * Knowledge bases in the Bin (plan §9, D363 parity; Wave 44 "AC-E"), a provider of server/bin.ts.
 * The owner alone lists, restores, and purges them. While binned a base reaches nobody (agents
 * stop finding it at their next step; searches and its page 404) and its sharing is kept; a restore
 * brings both back. A purge is one transaction: the base, its sources, chunks, and FTS rows (by
 * cascade and triggers), its access rows and key grants (039's trigger), and the agents' picks of
 * it (042's trigger).
 */

const FOLDER = "Knowledge";
const select = "SELECT id, owner_id, name AS title, deleted_at, purge_after, purge_started_at, visibility FROM knowledge_bases";
const providedDefaults = { size_bytes: null, board_id: null, board_name: null, attachment: false, attachment_of: null, attachment_kind: null } as const;
type Binned = { id: string; owner_id: string; title: string; deleted_at: string | null; purge_after: string | null; purge_started_at: string | null; visibility: "private" | "selected" | "all_users" };

function purgeNow(id: string, options: { reason: PurgeReason; actorId: string | null; dueBy?: string }): PurgeOutcome {
  const outcome = db.transaction((): PurgeOutcome => {
    const retention = options.dueBy === undefined ? "" : " AND (purge_started_at IS NOT NULL OR purge_after <= $dueBy)";
    const marked = db.query(`UPDATE knowledge_bases SET purge_started_at = COALESCE(purge_started_at, $startedAt) WHERE id = $id AND deleted_at IS NOT NULL${retention}`)
      .run({ startedAt: now(), id, ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) });
    if (marked.changes === 0) return "not_found";
    db.query("DELETE FROM knowledge_bases WHERE id = ?").run(id);
    audit(options.actorId, null, "knowledge.purge", { kbId: id, reason: options.reason });
    return "purged";
  })();
  if (outcome === "purged") forgetKnowledgeVectors(id);
  return outcome;
}

async function sweep(cutoff: string): Promise<BinSweepCounts> {
  const resumed = db.query("SELECT id FROM knowledge_bases WHERE purge_started_at IS NOT NULL LIMIT ?").all(SWEEP_RESUME_BATCH_SIZE) as Array<{ id: string }>;
  const due = db.query("SELECT id FROM knowledge_bases WHERE deleted_at IS NOT NULL AND purge_started_at IS NULL AND purge_after <= ? ORDER BY purge_after LIMIT ?").all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string }>;
  const counts: BinSweepCounts = { purged: 0, pending: 0 };
  for (const [items, reason] of [[resumed, "resumed"], [due, "retention"]] as const) {
    for (const { id } of items) {
      try {
        const outcome = await withResourceLock(`knowledge_bases:${id}`, async () => purgeNow(id, { reason, actorId: null, dueBy: cutoff }));
        if (outcome === "purged") counts.purged += 1;
      } catch (error) {
        counts.pending += 1;
        slog.error("Bin sweep could not purge a knowledge base", error);
      }
    }
  }
  return counts;
}

registerBinProvider("knowledge_base", {
  list(userId) {
    const rows = db.query(`${select} WHERE owner_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, id LIMIT 500`).all(userId) as Binned[];
    return rows.map((row): BinItem => ({
      type: "knowledge_base", id: row.id, title: row.title, folder_id: null, folder_name: FOLDER, deleted_at: row.deleted_at!, purge_after: row.purge_after!,
      purging: row.purge_started_at !== null, ...providedDefaults, can_purge: true
    }));
  },
  restore(id, userId) {
    return withResourceLock(`knowledge_bases:${id}`, async (): Promise<RestoreOutcome> => {
      const row = db.query(`${select} WHERE id = ?`).get(id) as Binned | null;
      if (!row || row.owner_id !== userId) return { status: "not_found" };
      if (row.purge_started_at !== null) return { status: "purging" };
      if (row.deleted_at === null) return { status: "knowledge_restored", alreadyRestored: true, knowledgeBaseId: id, knowledgeBaseName: row.title };
      const live = (db.query("SELECT COUNT(*) AS count FROM knowledge_bases WHERE owner_id = ? AND deleted_at IS NULL").get(userId) as { count: number }).count;
      const limit = readAgentSettings().kbsPerUser;
      if (live >= limit) return { status: "limit_reached", message: `You can have up to ${limit} knowledge bases` };
      const restored = db.query("UPDATE knowledge_bases SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL").run(now(), id);
      if (restored.changes !== 1) return { status: "purging" };
      audit(userId, null, "knowledge.restore", { kbId: id });
      // Work that waited while it was binned resumes.
      scheduleKnowledge(id);
      return { status: "knowledge_restored", alreadyRestored: false, knowledgeBaseId: id, knowledgeBaseName: row.title };
    });
  },
  purge(id, userId) {
    return withResourceLock(`knowledge_bases:${id}`, async () => {
      const row = db.query(`${select} WHERE id = ?`).get(id) as Binned | null;
      if (!row || row.owner_id !== userId) return "not_found";
      if (row.deleted_at === null) return "live";
      return purgeNow(id, { reason: "user", actorId: userId });
    });
  },
  sweep,
  async empty(userId) {
    const counts: BinSweepCounts = { purged: 0, pending: 0 };
    const ids = db.query("SELECT id FROM knowledge_bases WHERE owner_id = ? AND deleted_at IS NOT NULL").all(userId) as Array<{ id: string }>;
    for (const { id } of ids) {
      const outcome = await withResourceLock(`knowledge_bases:${id}`, async () => purgeNow(id, { reason: "user", actorId: userId }));
      if (outcome === "purged") counts.purged += 1;
    }
    return counts;
  }
});
