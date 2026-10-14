import { registerBinProvider, SWEEP_BATCH_SIZE, SWEEP_RESUME_BATCH_SIZE, type BinItem, type BinSweepCounts, type PurgeOutcome, type PurgeReason, type RestoreOutcome } from "../bin";
import { audit, db, now } from "../db";
import { withResourceLock } from "../storage";
import { AGENT_BOUNDS } from "../../shared/agents";
import { readAgentSettings } from "./settings";
import { logger } from "../log";

const slog = logger("agents");

/**
 * Chats and agents in the Bin (plan §6.1, D363), registered with server/bin.ts as providers. The
 * owner alone lists, restores, and purges them. Purging a chat deletes its messages and runs by
 * cascade, its public snapshot, and its access rows; purging an agent deletes its tool rows
 * and access rows, and its chats stay (they are the owner's, readable, with "agent in the Bin").
 * Everything lives in SQLite, so a purge is one transaction.
 */

const providedDefaults = { size_bytes: null, board_id: null, board_name: null, attachment: false, attachment_of: null, attachment_kind: null } as const;
type Binned = { id: string; owner_id: string; title: string; deleted_at: string | null; purge_after: string | null; purge_started_at: string | null; visibility: "private" | "selected" | "all_users" };

function purgeNow(table: "chats" | "agents", id: string, options: { reason: PurgeReason; actorId: string | null; dueBy?: string }): PurgeOutcome {
  return db.transaction((): PurgeOutcome => {
    const retention = options.dueBy === undefined ? "" : " AND (purge_started_at IS NOT NULL OR purge_after <= $dueBy)";
    const marked = db.query(`UPDATE ${table} SET purge_started_at = COALESCE(purge_started_at, $startedAt) WHERE id = $id AND deleted_at IS NOT NULL${retention}`)
      .run({ startedAt: now(), id, ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) });
    if (marked.changes === 0) return "not_found";
    if (table === "chats") db.query("DELETE FROM agent_runs WHERE chat_id = ?").run(id);
    db.query(`DELETE FROM ${table} WHERE id = ?`).run(id);
    audit(options.actorId, null, table === "chats" ? "agents.chat.purge" : "agents.agent.purge", { id, reason: options.reason });
    return "purged";
  })();
}

/**
 * One sweep of a table. A purge that throws (a constraint, a locked file) counts as pending and the
 * batch goes on (review M2): one stuck row never stalls the rest, and the row is retried next hour.
 */
export async function sweepTable(table: "chats" | "agents", cutoff: string): Promise<BinSweepCounts> {
  const resumed = db.query(`SELECT id FROM ${table} WHERE purge_started_at IS NOT NULL LIMIT ?`).all(SWEEP_RESUME_BATCH_SIZE) as Array<{ id: string }>;
  const due = db.query(`SELECT id FROM ${table} WHERE deleted_at IS NOT NULL AND purge_started_at IS NULL AND purge_after <= ? ORDER BY purge_after LIMIT ?`).all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string }>;
  const counts: BinSweepCounts = { purged: 0, pending: 0 };
  for (const [items, reason] of [[resumed, "resumed"], [due, "retention"]] as const) {
    for (const { id } of items) {
      try {
        const outcome = await withResourceLock(`${table}:${id}`, async () => purgeNow(table, id, { reason, actorId: null, dueBy: cutoff }));
        if (outcome === "purged") counts.purged += 1;
      } catch (error) {
        counts.pending += 1;
        slog.error(`Bin sweep could not purge a ${table === "chats" ? "chat" : "agent"}`, error);
      }
    }
  }
  return counts;
}

function provider(table: "chats" | "agents", type: "chat" | "agent", folderName: string, nameColumn: "title" | "name") {
  const select = `SELECT id, owner_id, ${nameColumn} AS title, deleted_at, purge_after, purge_started_at, visibility FROM ${table}`;
  registerBinProvider(type, {
    list(userId) {
      const rows = db.query(`${select} WHERE owner_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, id LIMIT 500`).all(userId) as Binned[];
      return rows.map((row): BinItem => ({
        type, id: row.id, title: row.title, folder_id: null, folder_name: folderName, deleted_at: row.deleted_at!, purge_after: row.purge_after!,
        purging: row.purge_started_at !== null, ...providedDefaults, can_purge: true
      }));
    },
    restore(id, userId) {
      return withResourceLock(`${table}:${id}`, async (): Promise<RestoreOutcome> => {
        const row = db.query(`${select} WHERE id = ?`).get(id) as Binned | null;
        if (!row || row.owner_id !== userId) return { status: "not_found" };
        if (row.purge_started_at !== null) return { status: "purging" };
        if (row.deleted_at === null) return { status: "already_restored", folderId: id, folderName };
        const live = (db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE owner_id = ? AND deleted_at IS NULL`).get(userId) as { count: number }).count;
        const limit = table === "chats" ? AGENT_BOUNDS.chatsPerUser : readAgentSettings().agentsPerUser;
        if (live >= limit) return { status: "limit_reached", message: `You can have up to ${limit} ${table}` };
        const restored = db.query(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL`).run(now(), id);
        if (restored.changes !== 1) return { status: "purging" };
        audit(userId, null, type === "chat" ? "agents.chat.restore" : "agents.agent.restore", { id });
        // Wave 43 (AC-D): sharing is kept while binned (recipients reach nothing then) and applies again now.
        return { status: "restored", folderId: id, folderName, visibility: row.visibility };
      });
    },
    purge(id, userId) {
      return withResourceLock(`${table}:${id}`, async () => {
        const row = db.query(`${select} WHERE id = ?`).get(id) as Binned | null;
        if (!row || row.owner_id !== userId) return "not_found";
        if (row.deleted_at === null) return "live";
        return purgeNow(table, id, { reason: "user", actorId: userId });
      });
    },
    sweep: (cutoff) => sweepTable(table, cutoff),
    async empty(userId) {
      const counts: BinSweepCounts = { purged: 0, pending: 0 };
      const ids = db.query(`SELECT id FROM ${table} WHERE owner_id = ? AND deleted_at IS NOT NULL`).all(userId) as Array<{ id: string }>;
      for (const { id } of ids) {
        const outcome = await withResourceLock(`${table}:${id}`, async () => purgeNow(table, id, { reason: "user", actorId: userId }));
        if (outcome === "purged") counts.purged += 1;
      }
      return counts;
    }
  });
}

provider("chats", "chat", "Chat", "title");
provider("agents", "agent", "Agents", "name");
