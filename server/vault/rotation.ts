import { audit, db } from "../db";
import { requireOwner, requireVault, type VaultActor } from "./access";
import { pendingRows, reencryptBatch, retireGenerations, startGeneration } from "./crypto";
import { chargeVault } from "./limits";
import { recordVaultEvent } from "./service";

/**
 * Data-key rotation per vault (vault plan §3.3, §6.6; Wave 26). A rotation starts a new DEK
 * generation at once (every write from then on uses it); the sweeper then re-encrypts older rows in
 * batches and retires each older generation (its wrapped DEK row is deleted) once nothing refers to
 * it. Values stay readable throughout: a row is always readable under the generation it names.
 *
 * Who: owners on demand (`POST /api/vault/vaults/:id/rotate`), and automatically when someone loses
 * access (a member removed, lowered to no access on an environment, or leaving). This protects
 * backups against someone who kept an old wrapped DEK; it does not take back what a person already
 * read, which is why the Access sheet also says to rotate the real credentials upstream (§6.6, T197).
 *
 * Bounded time: a batch is at most `ROTATION_BATCH` rows in one transaction; the in-process runner
 * yields `ROTATION_PAUSE_MS` between batches, and the hourly sweeper resumes anything left after a
 * restart. The largest vault (1,000 secrets × 20 environments × 21 rows) is about 420,000 rows, so
 * about 840 batches: minutes, not hours, and never one long lock.
 */

export const ROTATION_BATCH = 500;
export const ROTATION_PAUSE_MS = 20;

export type RotationReason = "manual" | "member_removed";

/**
 * Starts a rotation inside the caller's transaction (no access check: `rotateVault` and the member
 * changes check first). Returns the new generation.
 */
export function beginRotation(vaultId: string, actorId: string | null, reason: RotationReason): number {
  const generation = startGeneration(vaultId);
  recordVaultEvent(vaultId, actorId, reason === "manual" ? "key.rotate" : "key.rotate.auto", { count: generation });
  audit(actorId, null, "vault.key_rotated", { vaultId, generation, reason });
  scheduleRotationRun();
  return generation;
}

/** `POST …/rotate`: owners only; a write (rate-limited as one). */
export function rotateVault(actor: VaultActor, vaultId: string) {
  const access = requireVault(actor, vaultId);
  requireOwner(access);
  chargeVault("write", actor.userId);
  const generation = db.transaction(() => beginRotation(vaultId, actor.userId, "manual"))();
  return rotationStatus(vaultId, generation);
}

/** How far a vault's rotation is: its current generation and the rows still under an older one. */
export function rotationStatus(vaultId: string, generation?: number) {
  const current = generation ?? (db.query("SELECT current_generation FROM vaults WHERE id = ?").get(vaultId) as { current_generation: number } | null)?.current_generation ?? 1;
  const pending = pendingRows(vaultId, current);
  const generations = (db.query("SELECT COUNT(*) AS count FROM vault_keys WHERE vault_id = ?").get(vaultId) as { count: number }).count;
  return { generation: current, pendingRows: pending, activeKeys: generations, done: pending === 0 && generations <= 1 };
}

/** Vaults with an older generation still stored (a rotation that has not finished). */
const pendingVaults = () => (db.query(`SELECT v.id FROM vaults v WHERE v.purge_started_at IS NULL
  AND EXISTS (SELECT 1 FROM vault_keys k WHERE k.vault_id = v.id AND k.generation < v.current_generation) ORDER BY v.id`).all() as Array<{ id: string }>).map((row) => row.id);

/**
 * One pass: at most `maxBatches` batches across every vault with a rotation under way, then retire
 * what is no longer referenced. Returns the rows moved and the vaults still pending.
 */
export function runRotationPass(maxBatches = 1): { moved: number; failed: number; retired: number; pending: number } {
  let moved = 0;
  let failed = 0;
  let retired = 0;
  const vaults = pendingVaults();
  for (const vaultId of vaults) {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = reencryptBatch(vaultId, ROTATION_BATCH);
      moved += result.moved;
      failed += result.failed;
      if (!result.remaining || result.moved === 0) break;
    }
    const gone = retireGenerations(vaultId);
    if (gone.length) {
      retired += gone.length;
      recordVaultEvent(vaultId, null, "key.retire", { count: gone.length }, "sweeper");
    }
  }
  return { moved, failed, retired, pending: pendingVaults().length };
}

let scheduled: ReturnType<typeof setTimeout> | null = null;
let paused = false;

/** Keeps passing in the background, one batch per vault at a time, until nothing is pending. */
export function scheduleRotationRun() {
  if (scheduled || paused) return;
  scheduled = setTimeout(() => {
    scheduled = null;
    try {
      const result = runRotationPass(1);
      if (result.failed) console.error(`Vault rotation: ${result.failed} rows did not open under their own key and were left as they are`);
      if (result.pending > 0 && result.moved > 0) scheduleRotationRun();
    } catch (error) {
      console.error("Vault rotation failed", error instanceof Error ? error.name : "Unknown error");
    }
  }, ROTATION_PAUSE_MS);
}

/** Test hook: stop the background runner so a test can drive passes itself (and start it again). */
export function pauseRotationRunnerForTests(pause: boolean) {
  paused = pause;
  if (pause && scheduled) {
    clearTimeout(scheduled);
    scheduled = null;
  }
}

/** The hourly sweeper and startup: finish any rotation a restart interrupted. */
export function resumeRotations(): { moved: number; retired: number; pending: number } {
  const result = runRotationPass(20);
  if (result.pending > 0) scheduleRotationRun();
  return result;
}
