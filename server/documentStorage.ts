import { constants } from "node:fs";
import { lstat, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";
import { ensureDirectory, isStorageId, syncDirectory, withinDataRoot } from "./storage";

/**
 * UUID-only document storage under DATA_DIR/documents:
 *
 *   objects/<document-uuid>          committed bytes, 0600, no extension
 *   .staging/<document-uuid>.part    in-flight uploads, 0600
 *
 * User-supplied names never reach this module. Every id is checked against the
 * UUID pattern before a path is built.
 */

export class DocumentIntegrityError extends Error {
  constructor(readonly reason: "missing" | "not_regular" | "size_mismatch") {
    super(`Document object failed integrity verification (${reason})`);
    this.name = "DocumentIntegrityError";
  }
}

const STAGING_MAX_AGE_MS = 3_600_000;
const ORPHAN_MIN_AGE_MS = 3_600_000;
const processStartedAt = Date.now();

function safeDocumentId(id: string) {
  if (!isStorageId(id)) throw new Error("Invalid document id");
  return id;
}

const documentsRoot = () => withinDataRoot(join(config.dataDir, "documents"));

async function stagingDirectory() {
  await ensureDirectory(documentsRoot());
  return ensureDirectory(join(documentsRoot(), ".staging"));
}

async function objectsDirectory() {
  await ensureDirectory(documentsRoot());
  return ensureDirectory(join(documentsRoot(), "objects"));
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export async function createStagingFile(id: string): Promise<{ handle: FileHandle; path: string }> {
  const path = join(await stagingDirectory(), `${safeDocumentId(id)}.part`);
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  return { handle, path };
}

/** fsyncs the staged file, renames it into objects/, and fsyncs both directories. */
export async function commitStaged(id: string) {
  const staging = await stagingDirectory();
  const objects = await objectsDirectory();
  const source = join(staging, `${safeDocumentId(id)}.part`);
  const target = join(objects, id);
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe staged document");
  try {
    await lstat(target);
    throw new Error("Document object already exists");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(source, target);
  await syncDirectory(staging);
  await syncDirectory(objects);
}

/**
 * Writes `bytes` as a new committed object named `id` (a fresh UUID) through staging, fsync, and
 * rename (whiteboard copy-on-write saves, D193). Nothing is left behind on failure.
 */
export async function writeObject(id: string, bytes: Uint8Array) {
  const { handle } = await createStagingFile(id);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
      offset += bytesWritten;
    }
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await discardStaged(id);
    throw error;
  }
  await handle.close();
  try {
    await commitStaged(id);
  } catch (error) {
    await discardStaged(id);
    throw error;
  }
}

export async function discardStaged(id: string) {
  try {
    await unlink(join(await stagingDirectory(), `${safeDocumentId(id)}.part`));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/**
 * Opens a committed object for reading. The path must be a regular file (not a
 * symlink), is opened with O_NOFOLLOW, and must have exactly the expected size.
 */
export async function openObjectForRead(id: string, expectedSize: number): Promise<{ handle: FileHandle; size: number }> {
  const path = join(await objectsDirectory(), safeDocumentId(id));
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) throw new DocumentIntegrityError("missing");
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new DocumentIntegrityError("not_regular");
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new DocumentIntegrityError("not_regular");
    if (code === "ENOENT") throw new DocumentIntegrityError("missing");
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new DocumentIntegrityError("not_regular");
    if (opened.size !== expectedSize) throw new DocumentIntegrityError("size_mismatch");
    return { handle, size: opened.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function removeObject(id: string) {
  try {
    await unlink(join(await objectsDirectory(), safeDocumentId(id)));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** Reports whether a live object exists as a regular file of the expected size. */
export async function objectIsIntact(id: string, expectedSize: number) {
  try {
    const info = await lstat(join(await objectsDirectory(), safeDocumentId(id)));
    return info.isFile() && !info.isSymbolicLink() && info.size === expectedSize;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export type SweepCounts = { stagingRemoved: number; orphansRemoved: number; ignored: number };

/**
 * Removes stale staging files and orphaned objects (DEVELOPMENT_PLAN §6.5 steps 1-2).
 *
 * - `.staging/<uuid>.part` older than one hour is removed. With `boot`, every
 *   staging file last modified before this process started is removed, since
 *   nothing from an earlier process can still be in flight.
 * - `objects/<uuid>` regular files older than one hour that no row names are removed:
 *   `hasDocumentRow` answers for documents (in any state) and for whiteboard scene and
 *   snapshot objects (T166).
 * - Anything else is left in place and counted as ignored.
 */
export async function sweepDocumentFiles(options: { boot: boolean; nowMs?: number; hasDocumentRow: (id: string) => boolean }): Promise<SweepCounts> {
  const nowMs = options.nowMs ?? Date.now();
  const counts: SweepCounts = { stagingRemoved: 0, orphansRemoved: 0, ignored: 0 };
  const stagingCutoff = options.boot ? Math.max(processStartedAt, nowMs - STAGING_MAX_AGE_MS) : nowMs - STAGING_MAX_AGE_MS;

  const staging = await stagingDirectory();
  for (const name of await readdir(staging)) {
    const id = name.endsWith(".part") ? name.slice(0, -5) : "";
    const path = join(staging, name);
    try {
      const info = await lstat(path);
      if (!isStorageId(id) || !info.isFile() || info.isSymbolicLink()) {
        counts.ignored += 1;
        continue;
      }
      if (info.mtimeMs >= stagingCutoff) continue;
      await unlink(path);
      counts.stagingRemoved += 1;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  const objects = await objectsDirectory();
  for (const name of await readdir(objects)) {
    const path = join(objects, name);
    try {
      const info = await lstat(path);
      if (!isStorageId(name) || !info.isFile() || info.isSymbolicLink()) {
        counts.ignored += 1;
        continue;
      }
      if (info.mtimeMs >= nowMs - ORPHAN_MIN_AGE_MS || options.hasDocumentRow(name)) continue;
      await unlink(path);
      counts.orphansRemoved += 1;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return counts;
}
