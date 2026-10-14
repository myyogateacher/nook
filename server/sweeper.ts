import { sweepBin, type BinSweepCounts } from "./bin";
import { sweepNotifications } from "./calendar/reminders";
import { config } from "./config";
import { db } from "./db";
import { claimS3Prefix, objectStore, PrefixClaimError, s3Internals } from "./objectStore";
import { documentObjectSizes, sweepDocumentFiles, type SweepCounts } from "./documentStorage";
import { missingAttachmentTriggers, sweepAttachments } from "./attachments/sweep";
import { sweepInvites } from "./team/invites";
import { sweepProposals } from "./inbox/service";
import { sweepRuns } from "./inbox/routines";
import { sweepKeyGraces } from "./apiKeys";
import { sweepMail } from "./mail/dispatcher";
import { orphanGrantReport } from "./access/groups";
import { sweepAvatarFiles } from "./avatars";
import { sweepGoogleFlows } from "./google/flows";
import { sweepVaultEvents } from "./vault/service";
import { resumeRotations } from "./vault/rotation";
import { vaultStatus } from "./vault/status";
import { sweepAgentAudit } from "./agents/audit";
import { sweepAgentRateLimits } from "./agents/limits";
import { sweepSessions } from "./agents/toolServers";
import { sweepKnowledge } from "./knowledge/index";
import { sweepSchemaSync } from "./reports/schemaCatalog";
import { logger } from "./log";

const slog = logger("sweeper");

const SWEEP_INTERVAL_MS = 3_600_000;
export type SweepResult = SweepCounts & { bin: BinSweepCounts };
let running: Promise<SweepResult | null> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Whether an object name is live (T166): a document's own object, a whiteboard's current scene
 * object, or a whiteboard snapshot. Anything else past the one-hour minimum age is an orphan.
 */
export const hasDocumentRow = (id: string) => Boolean(db.query(`SELECT 1 FROM documents WHERE id = $id
  UNION ALL SELECT 1 FROM whiteboards WHERE object_id = $id
  UNION ALL SELECT 1 FROM whiteboard_snapshots WHERE object_id = $id LIMIT 1`).get({ id }));

/**
 * Review L6 (accepted): the check holds every live object's id and size in memory, about 150 MB at a
 * million objects. At boot it reuses the orphan sweep's listing, so the bucket is listed once.
 */
async function countIntegrityErrors(listed?: Map<string, number>) {
  // A whiteboard's bytes live in its current scene object, never under the document id.
  const rows = db.query(`SELECT COALESCE(w.object_id, d.id) AS object_id, d.size_bytes FROM documents d LEFT JOIN whiteboards w ON w.document_id = d.id
    WHERE d.purge_started_at IS NULL`).all() as Array<{ object_id: string; size_bytes: number }>;
  // One listing instead of a stat per row: on S3 that is one request per 1,000 objects, not one per file.
  const sizes = listed ?? await documentObjectSizes();
  let broken = 0;
  for (const row of rows) if (sizes.get(row.object_id) !== row.size_bytes) broken += 1;
  return broken;
}

/**
 * S3 (review M2): before deleting anything, claim the prefix again. A process that is no longer the
 * prefix's newest claimant (a restored copy, a second server) is fenced: it skips the file sweeps, and
 * every delete it tries fails (Bin purges stay pending). A store that does not answer skips this round.
 */
export async function fileSweepsAllowed() {
  const store = objectStore();
  if (store.backend !== "s3") return true;
  if (s3Internals(store).isFenced?.()) return false;
  try {
    await claimS3Prefix(store, config.dataDir);
    return true;
  } catch (error) {
    if (error instanceof PrefixClaimError) slog.error(`File storage: ${error.message.replace(/\.$/, "")}. This server no longer sweeps or deletes files; restart it once the prefix is sorted out.`);
    else slog.error("File storage: the prefix claim could not be checked; file sweeps skipped this hour", error);
    return false;
  }
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
      const filesAllowed = await fileSweepsAllowed();
      try {
        if (!filesAllowed) throw new Error("File sweeps are off for this run");
        const sizes = options.boot ? new Map<string, number>() : undefined;
        counts = await sweepDocumentFiles({ boot: options.boot ?? false, nowMs: options.nowMs, hasDocumentRow, sizes });
        if (counts.stagingRemoved || counts.orphansRemoved || counts.ignored) {
          slog.info(`Document sweep: ${counts.stagingRemoved} staging removed, ${counts.orphansRemoved} orphans removed, ${counts.ignored} unexpected entries ignored`);
        }
        if (options.boot) {
          const broken = await countIntegrityErrors(sizes);
          if (broken) slog.error(`Document integrity check: ${broken} stored documents are missing or have the wrong size`);
        }
      } catch (error) {
        slog.error("Document sweep failed", error);
      }
      // Uploads everywhere (D395, T348): links whose host is gone, then Attachments-folder files nothing
      // has linked for a day (never linked, or every host purged) move to the Bin. Since 047 (U8) this
      // also covers the card and row uploads the older task and row sweeps used to handle.
      try {
        // Review L3: the attachment and system-folder rules rely on the 046 triggers (and Undo records on 049's); say so loudly if any is missing.
        if (options.boot) {
          const missing = missingAttachmentTriggers();
          if (missing.length) slog.error(`Attachment self-check: migration 046 or 049 triggers are missing (${missing.join(", ")}); system-folder guards and link clean-up are not enforced by the database`);
        }
        const swept = await sweepAttachments({ nowMs: options.nowMs });
        if (swept.staleLinks || swept.orphansBinned) slog.info(`Attachments sweep: ${swept.staleLinks} stale links removed, ${swept.orphansBinned} unlinked files moved to the Bin`);
      } catch (error) {
        slog.error("Attachments sweep failed", error);
      }
      // Bin purges run even when the file sweep failed, so retention never stalls on it.
      let bin: BinSweepCounts | null = null;
      try {
        bin = await sweepBin({ nowMs: options.nowMs });
        if (bin.purged || bin.pending) slog.info(`Bin sweep: ${bin.purged} purged, ${bin.pending} pending retry`);
      } catch (error) {
        slog.error("Bin sweep failed", error);
      }
      try {
        // Calendar notifications (and fired standalone reminders) are kept for 30 days.
        const removed = sweepNotifications(options.nowMs);
        if (removed.notifications || removed.reminders) slog.info(`Notification sweep: ${removed.notifications} notifications and ${removed.reminders} fired reminders removed`);
      } catch (error) {
        slog.error("Notification sweep failed", error);
      }
      try {
        // Team invites dead (used, revoked, or expired) for 90 days are deleted (D169).
        const invites = sweepInvites(options.nowMs);
        if (invites) slog.info(`Invite sweep: ${invites} old invites removed`);
      } catch (error) {
        slog.error("Invite sweep failed", error);
      }
      try {
        // Agent inbox (D156): expire pending proposals, fail stuck approvals, drop old resolved ones.
        const swept = sweepProposals(options.nowMs);
        if (swept.expired || swept.interrupted || swept.purged) slog.info(`Proposal sweep: ${swept.expired} expired, ${swept.interrupted} interrupted, ${swept.purged} removed`);
      } catch (error) {
        slog.error("Proposal sweep failed", error);
      }
      try {
        // Routine runs (D154): abandon runs past their two-hour lease (the routine stays due), drop runs after 180 days.
        const runs = sweepRuns(options.nowMs);
        if (runs.abandoned || runs.purged) slog.info(`Run sweep: ${runs.abandoned} abandoned, ${runs.purged} removed`);
      } catch (error) {
        slog.error("Run sweep failed", error);
      }
      try {
        // Nook keys (D277, D283): rotation graces that ended become revocations; usage older than 90 days goes.
        const keys = sweepKeyGraces(options.nowMs);
        if (keys.gracesEnded || keys.usageTrimmed) slog.info(`Key sweep: ${keys.gracesEnded} rotation graces ended, ${keys.usageTrimmed} usage rows removed`);
      } catch (error) {
        slog.error("Key sweep failed", error);
      }
      try {
        // T206: grants whose item is gone should not exist (purge triggers); report ids only if any do.
        for (const orphan of orphanGrantReport()) slog.error(`Grant self-check: ${orphan.count} ${orphan.source} rows point at missing ${orphan.kind} items (${orphan.sample.join(", ")})`);
      } catch (error) {
        slog.error("Grant self-check failed", error);
      }
      try {
        // Agent tool servers (Wave 41 review L5): MCP sessions idle for 10 minutes are closed (HTTP DELETE, stdio child stopped).
        await sweepSessions(options.nowMs);
      } catch (error) {
        slog.error("Tool server session sweep failed", error);
      }
      try {
        // Knowledge bases (Wave 44, AC-E): sources the owner can no longer read become unavailable; changed ones are indexed again.
        const knowledge = await sweepKnowledge();
        if (knowledge.unavailable || knowledge.changed) slog.info(`Knowledge sweep: ${knowledge.unavailable} sources unavailable, ${knowledge.changed} changed, ${knowledge.queued} bases queued`);
      } catch (error) {
        slog.error("Knowledge sweep failed", error);
      }
      try {
        // Analytics reports (Wave 45): re-read the schema of data sources whose cache is a day old (in the background).
        const schemas = sweepSchemaSync(options.nowMs);
        if (schemas) slog.info(`Report schema sweep: ${schemas} data sources re-syncing`);
      } catch (error) {
        slog.error("Report schema sweep failed", error);
      }
      try {
        // Mail history (outbound email §B.3): delivered rows after 30 days, failures after 90.
        const mail = sweepMail(options.nowMs);
        if (mail.outbox || mail.tokens) slog.info(`Mail sweep: ${mail.outbox} outbox rows and ${mail.tokens} tokens removed`);
      } catch (error) {
        slog.error("Mail sweep failed", error);
      }
      try {
        // Vault event log (T195): kept for 90 days.
        const events = sweepVaultEvents(options.nowMs);
        if (events) slog.info(`Vault event sweep: ${events} old events removed`);
      } catch (error) {
        slog.error("Vault event sweep failed", error);
      }
      try {
        // The agent Audit log (Wave 42, D366): API and MCP runs past AGENT_AUDIT_RETENTION_DAYS (or the admin's policy), 500 at a time; old per-key run windows.
        const runs = sweepAgentAudit(options.nowMs);
        const windows = sweepAgentRateLimits(options.nowMs);
        if (runs) slog.info(`Agent audit sweep: ${runs} old runs removed${windows ? `, ${windows} rate windows` : ""}`);
      } catch (error) {
        slog.error("Agent audit sweep failed", error);
      }
      try {
        // Vault data-key rotation (Wave 26): finish re-encrypting and retire old generations.
        if (vaultStatus().enabled) {
          const rotation = resumeRotations();
          if (rotation.moved || rotation.retired) slog.info(`Vault rotation sweep: ${rotation.moved} rows re-encrypted, ${rotation.retired} old keys retired, ${rotation.pending} vaults pending`);
        }
      } catch (error) {
        slog.error("Vault rotation sweep failed", error);
      }
      try {
        // Google sign-in (Wave 35): flows past their 10 minutes, and avatar files no account points at.
        const flows = sweepGoogleFlows(options.nowMs);
        const avatars = filesAllowed ? await sweepAvatarFiles(options.nowMs) : 0;
        if (flows || avatars) slog.info(`Google sweep: ${flows} sign-in flows and ${avatars} avatar files removed`);
      } catch (error) {
        slog.error("Google sweep failed", error);
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
