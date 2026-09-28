import { sweepBin, type BinSweepCounts } from "./bin";
import { sweepNotifications } from "./calendar/reminders";
import { db } from "./db";
import { objectIsIntact, sweepDocumentFiles, type SweepCounts } from "./documentStorage";
import { sweepUnlinkedAttachments } from "./tasks/attachments";
import { sweepUnlinkedRowAttachments } from "./collections/sweep";
import { sweepInvites } from "./team/invites";
import { sweepProposals } from "./inbox/service";
import { sweepRuns } from "./inbox/routines";

const SWEEP_INTERVAL_MS = 3_600_000;
export type SweepResult = SweepCounts & { bin: BinSweepCounts };
let running: Promise<SweepResult | null> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const hasDocumentRow = (id: string) => Boolean(db.query("SELECT 1 FROM documents WHERE id = ?").get(id));

async function countIntegrityErrors() {
  const rows = db.query("SELECT id, size_bytes FROM documents WHERE purge_started_at IS NULL").all() as Array<{ id: string; size_bytes: number }>;
  let broken = 0;
  for (const row of rows) if (!await objectIsIntact(row.id, row.size_bytes)) broken += 1;
  return broken;
}

/**
 * Runs one sweep: staging and orphan cleanup, then Bin purges (resume
 * interrupted ones, then retention). Overlapping calls share the run already
 * in flight. Logs counts only.
 */
export function runSweep(options: { boot?: boolean; nowMs?: number } = {}) {
  running ??= (async () => {
    try {
      let counts: SweepCounts | null = null;
      try {
        counts = await sweepDocumentFiles({ boot: options.boot ?? false, nowMs: options.nowMs, hasDocumentRow });
        if (counts.stagingRemoved || counts.orphansRemoved || counts.ignored) {
          console.info(`Document sweep: ${counts.stagingRemoved} staging removed, ${counts.orphansRemoved} orphans removed, ${counts.ignored} unexpected entries ignored`);
        }
        if (options.boot) {
          const broken = await countIntegrityErrors();
          if (broken) console.error(`Document integrity check: ${broken} stored documents are missing or have the wrong size`);
        }
      } catch (error) {
        console.error("Document sweep failed", error instanceof Error ? error.name : "Unknown error");
      }
      // Task attachments never linked to a card move to the Bin after a day (and purge 30 days later).
      try {
        const unlinked = sweepUnlinkedAttachments({ nowMs: options.nowMs });
        if (unlinked) console.info(`Attachment sweep: ${unlinked} never-linked attachments moved to the Bin`);
      } catch (error) {
        console.error("Attachment sweep failed", error instanceof Error ? error.name : "Unknown error");
      }
      // Row attachments never linked to a row move to the Bin after a day (and purge 30 days later).
      try {
        const unlinked = sweepUnlinkedRowAttachments({ nowMs: options.nowMs });
        if (unlinked) console.info(`Row attachment sweep: ${unlinked} never-linked attachments moved to the Bin`);
      } catch (error) {
        console.error("Row attachment sweep failed", error instanceof Error ? error.name : "Unknown error");
      }
      // Bin purges run even when the file sweep failed, so retention never stalls on it.
      let bin: BinSweepCounts | null = null;
      try {
        bin = await sweepBin({ nowMs: options.nowMs });
        if (bin.purged || bin.pending) console.info(`Bin sweep: ${bin.purged} purged, ${bin.pending} pending retry`);
      } catch (error) {
        console.error("Bin sweep failed", error instanceof Error ? error.name : "Unknown error");
      }
      try {
        // Calendar notifications (and fired standalone reminders) are kept for 30 days.
        const removed = sweepNotifications(options.nowMs);
        if (removed.notifications || removed.reminders) console.info(`Notification sweep: ${removed.notifications} notifications and ${removed.reminders} fired reminders removed`);
      } catch (error) {
        console.error("Notification sweep failed", error instanceof Error ? error.name : "Unknown error");
      }
      try {
        // Team invites dead (used, revoked, or expired) for 90 days are deleted (D169).
        const invites = sweepInvites(options.nowMs);
        if (invites) console.info(`Invite sweep: ${invites} old invites removed`);
      } catch (error) {
        console.error("Invite sweep failed", error instanceof Error ? error.name : "Unknown error");
      }
      try {
        // Agent inbox (D156): expire pending proposals, fail stuck approvals, drop old resolved ones.
        const swept = sweepProposals(options.nowMs);
        if (swept.expired || swept.interrupted || swept.purged) console.info(`Proposal sweep: ${swept.expired} expired, ${swept.interrupted} interrupted, ${swept.purged} removed`);
      } catch (error) {
        console.error("Proposal sweep failed", error instanceof Error ? error.name : "Unknown error");
      }
      try {
        // Routine runs (D154): abandon runs past their two-hour lease (the routine stays due), drop runs after 180 days.
        const runs = sweepRuns(options.nowMs);
        if (runs.abandoned || runs.purged) console.info(`Run sweep: ${runs.abandoned} abandoned, ${runs.purged} removed`);
      } catch (error) {
        console.error("Run sweep failed", error instanceof Error ? error.name : "Unknown error");
      }
      return counts && bin ? { ...counts, bin } : null;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Starts the boot sweep without awaiting it, then sweeps hourly. */
export function startSweeper() {
  if (timer) return;
  void runSweep({ boot: true });
  timer = setInterval(() => void runSweep(), SWEEP_INTERVAL_MS);
  timer.unref();
}
