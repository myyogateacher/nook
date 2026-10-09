import { isObjectId, ObjectIntegrityError, objectStore, type ObjectStore } from "./objectStore";

/**
 * Document objects: the bytes of Files documents, attachments, note and whiteboard pictures, and
 * whiteboard scenes and snapshots, all in the object store's `documents` namespace under a UUID
 * (server/objectStore.ts; locally DATA_DIR/documents/objects/<uuid>, on S3 <S3_PREFIX>documents/<uuid>).
 *
 * User-supplied names never reach this module. Every id is checked against the UUID pattern before a
 * path or key is built.
 */

export { ObjectIntegrityError as DocumentIntegrityError } from "./objectStore";

const STAGING_MAX_AGE_MS = 3_600_000;
const ORPHAN_MIN_AGE_MS = 3_600_000;
const processStartedAt = Date.now();

/** A staged writer for a new document object; nothing is visible until commit(). */
export const createDocumentWriter = (id: string) => objectStore().createWriter("documents", id);

/**
 * Writes `bytes` as a new committed object named `id` (a fresh UUID) through staging and commit
 * (whiteboard copy-on-write saves, D193). Nothing is left behind on failure.
 */
export const writeObject = (id: string, bytes: Uint8Array) => objectStore().put("documents", id, bytes);

/**
 * Opens a committed object for reading. Locally the path must be a regular file (not a symlink) and is
 * opened with O_NOFOLLOW; on either backend it must have exactly the expected size.
 */
export const openObjectForRead = (id: string, expectedSize: number) => objectStore().open("documents", id, expectedSize);

/** A whole small object (a scene, a text file), checked against its expected size. */
export async function readObjectBytes(id: string, expectedSize: number) {
  return (await openObjectForRead(id, expectedSize)).bytes();
}

export const removeObject = (id: string) => objectStore().remove("documents", id);

/** Reports whether a live object exists with the expected size. */
export async function objectIsIntact(id: string, expectedSize: number) {
  if (!isObjectId(id)) throw new Error("Invalid document id");
  return (await objectStore().stat("documents", id))?.size === expectedSize;
}

/** Every committed document object's size by id (one listing, for the boot integrity check). */
export async function documentObjectSizes(store: ObjectStore = objectStore()) {
  const sizes = new Map<string, number>();
  for await (const entry of store.list("documents")) if (entry.id) sizes.set(entry.id, entry.size);
  return sizes;
}

export type SweepCounts = { stagingRemoved: number; orphansRemoved: number; ignored: number };

/**
 * Removes stale staging files and orphaned objects (DEVELOPMENT_PLAN §6.5 steps 1-2), on either backend.
 *
 * - Staged writes older than one hour are removed (local `.staging/<uuid>.part`). With `boot`, every
 *   staging file last modified before this process started is removed, since nothing from an earlier
 *   process can still be in flight. S3 has no staged objects (server/objectStore.ts).
 * - Committed objects older than one hour that no row names are removed: `hasDocumentRow` answers for
 *   documents (in any state) and for whiteboard scene and snapshot objects (T166).
 * - Anything else (a name that is not a UUID, a symlink, a directory) is left in place and counted as ignored.
 */
export async function sweepDocumentFiles(options: { boot: boolean; nowMs?: number; hasDocumentRow: (id: string) => boolean; store?: ObjectStore }): Promise<SweepCounts> {
  const store = options.store ?? objectStore();
  const nowMs = options.nowMs ?? Date.now();
  const stagingCutoff = options.boot ? Math.max(processStartedAt, nowMs - STAGING_MAX_AGE_MS) : nowMs - STAGING_MAX_AGE_MS;
  const staging = await store.sweepStaging("documents", stagingCutoff);
  const counts: SweepCounts = { stagingRemoved: staging.removed, orphansRemoved: 0, ignored: staging.ignored };
  for await (const entry of store.list("documents")) {
    if (!entry.id) {
      counts.ignored += 1;
      continue;
    }
    if (entry.modifiedMs >= nowMs - ORPHAN_MIN_AGE_MS || options.hasDocumentRow(entry.id)) continue;
    await store.remove("documents", entry.id);
    counts.orphansRemoved += 1;
  }
  return counts;
}
