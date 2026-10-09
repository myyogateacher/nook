import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { config, type S3StorageConfig, type StorageConfig } from "./config";

/**
 * The one place file bytes are written, read, and removed (S3 storage slice,
 * docs/plan/research/2026-10-09-s3-storage.md). Two backends sit behind one small interface:
 *
 *   local  DATA_DIR on disk, exactly as before this slice:
 *            documents  documents/objects/<id>, staged in documents/.staging/<id>.part
 *            avatars    avatars/<id>, staged as avatars/.<id>.part
 *   s3     a bucket through Bun's built-in S3 client (Bun.S3Client, no npm dependency):
 *            <S3_PREFIX><namespace>/<id>
 *
 * Keys are opaque UUIDs that the server generates: a file name, title, or anything a person typed
 * never becomes part of a path or key. Objects are private (no ACL is ever sent) and the server
 * streams bytes to clients itself, so access checks and response headers do not depend on the backend.
 *
 * Writes are staged: nothing is visible under the key until `commit()`. On S3 Bun's writer cannot
 * abort an upload it has started (Bun 1.4.2: `end(error)` still completes it), so a discarded S3 writer
 * completes and then deletes its object; the key is a fresh UUID no row names, so nothing reads it in
 * between, and the orphan sweep removes it if the delete fails.
 */

export type ObjectNamespace = "documents" | "avatars";
export const OBJECT_NAMESPACES: readonly ObjectNamespace[] = ["documents", "avatars"];

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isObjectId = (value: string) => uuidPattern.test(value);

/** An object that is missing, not a regular file (local), or not the size its row records. */
export class ObjectIntegrityError extends Error {
  constructor(readonly reason: "missing" | "not_regular" | "size_mismatch") {
    super(`Document object failed integrity verification (${reason})`);
    this.name = "DocumentIntegrityError";
  }
}

/** The storage service could not be reached or refused a request (S3 only). Never carries credentials. */
export class StorageUnavailableError extends Error {
  constructor(readonly operation: string, readonly code: string) {
    super(`Object storage ${operation} failed (${code})`);
    this.name = "StorageUnavailableError";
  }
}

export type ObjectInfo = { id: string; size: number; modifiedMs: number };
/** A listing entry: `id` is null for anything that is not a well-formed object (counted, never touched). */
export type ListedObject = { id: string | null; size: number; modifiedMs: number };

export interface ObjectWriter {
  /** Appends bytes. Awaiting each call keeps memory bounded (backpressure). */
  write(chunk: Uint8Array): Promise<void>;
  /** Makes the object visible under its key. Fails when the key already holds an object (local). */
  commit(): Promise<void>;
  /** Drops what was written. Safe before any write, after a failed write or commit, and twice. */
  discard(): Promise<void>;
}

export interface StoredObject {
  readonly size: number;
  /** Bytes `start`..`end` inclusive (default: all). The stream owns the object from here: it closes on end, error, or cancel. */
  stream(start?: number, end?: number): ReadableStream<Uint8Array>;
  /** Every byte, then closes. For small objects (scenes, text, pictures). */
  bytes(): Promise<Uint8Array>;
  /** Releases the object without reading it. A no-op after stream() or bytes(). */
  close(): Promise<void>;
}

export interface ObjectStore {
  readonly backend: "local" | "s3";
  /** A staged writer for a new object; nothing is created until the first write or commit. */
  createWriter(namespace: ObjectNamespace, id: string): ObjectWriter;
  /** Writes a whole object (staged, then committed); nothing is left behind on failure. */
  put(namespace: ObjectNamespace, id: string, bytes: Uint8Array): Promise<void>;
  /** Opens an object for reading; with `expectedSize`, a different size is an ObjectIntegrityError. */
  open(namespace: ObjectNamespace, id: string, expectedSize?: number): Promise<StoredObject>;
  /** The object's size and time, or null when there is none. */
  stat(namespace: ObjectNamespace, id: string): Promise<ObjectInfo | null>;
  /** Removes an object; a missing one is success. */
  remove(namespace: ObjectNamespace, id: string): Promise<void>;
  /** Every committed object in a namespace (staged writes are not listed). */
  list(namespace: ObjectNamespace): AsyncIterable<ListedObject>;
  /** Removes staged writes last touched before `cutoffMs`. S3 has none to remove (see the plan, §5). */
  sweepStaging(namespace: ObjectNamespace, cutoffMs: number): Promise<{ removed: number; ignored: number }>;
  /** Writes, reads back, and deletes a small object; throws when any step fails. */
  probe(): Promise<void>;
}

function safeId(id: string) {
  if (!isObjectId(id)) throw new Error("Invalid document id");
  return id;
}

/** Bytes an upload of `objectBytes` needs free on the data volume: the floor for SQLite, plus the bytes when they land there. */
export function diskBytesNeeded(objectBytes: number, store: Pick<ObjectStore, "backend"> = objectStore()) {
  return config.minFreeDiskBytes + (store.backend === "local" ? objectBytes : 0);
}

// ------------------------------------------------------------------------------------------ local

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function syncDirectory(path: string) {
  try {
    const handle = await open(path, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!(["EINVAL", "ENOTSUP"] as Array<string | undefined>).includes((error as NodeJS.ErrnoException).code)) throw error;
  }
}

type LocalLayout = { objects: string[]; staging: string[]; part: (id: string) => string; partId: (name: string) => string | null };
const LOCAL_LAYOUT: Record<ObjectNamespace, LocalLayout> = {
  documents: {
    objects: ["documents", "objects"],
    staging: ["documents", ".staging"],
    part: (id) => `${id}.part`,
    partId: (name) => name.endsWith(".part") ? name.slice(0, -5) : null
  },
  avatars: {
    objects: ["avatars"],
    staging: ["avatars"],
    part: (id) => `.${id}.part`,
    partId: (name) => name.startsWith(".") && name.endsWith(".part") ? name.slice(1, -5) : null
  }
};

/** The local backend: today's DATA_DIR layout, 0700 directories and 0600 files, no symlinks followed. */
export function createLocalObjectStore(dataRoot: string): ObjectStore {
  const root = resolve(dataRoot);
  const within = (path: string) => {
    const target = resolve(path);
    if (target !== root && !target.startsWith(root + sep)) throw new Error("Unsafe storage path");
    return target;
  };
  async function directory(parts: string[]) {
    let current = root;
    for (const part of parts) {
      current = within(join(current, part));
      await mkdir(current, { recursive: true, mode: 0o700 });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe storage directory");
      await chmod(current, 0o700);
    }
    const realRoot = await realpath(root);
    const actual = await realpath(current);
    if (actual !== realRoot && !actual.startsWith(realRoot + sep)) throw new Error("Storage directory escaped data root");
    return actual;
  }
  const objectsDir = (namespace: ObjectNamespace) => directory(LOCAL_LAYOUT[namespace].objects);
  const stagingDir = (namespace: ObjectNamespace) => directory(LOCAL_LAYOUT[namespace].staging);

  function createWriter(namespace: ObjectNamespace, id: string): ObjectWriter {
    safeId(id);
    const layout = LOCAL_LAYOUT[namespace];
    let handle: FileHandle | null = null;
    let path: string | null = null;
    let done = false;
    const ensureOpen = async () => {
      if (handle) return handle;
      path = join(await stagingDir(namespace), layout.part(id));
      handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      return handle;
    };
    return {
      async write(chunk) {
        if (done) throw new Error("Object writer is closed");
        const opened = await ensureOpen();
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await opened.write(chunk, offset, chunk.byteLength - offset);
          offset += bytesWritten;
        }
      },
      async commit() {
        if (done) throw new Error("Object writer is closed");
        const opened = await ensureOpen();
        await opened.sync();
        await opened.close();
        handle = null;
        done = true;
        const staging = await stagingDir(namespace);
        const objects = await objectsDir(namespace);
        const source = join(staging, layout.part(id));
        const target = join(objects, id);
        const info = await lstat(source);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe staged document");
        try {
          await lstat(target);
          throw new Error("Document object already exists");
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        await rename(source, target);
        await syncDirectory(staging);
        if (objects !== staging) await syncDirectory(objects);
      },
      async discard() {
        done = true;
        if (handle) {
          await handle.close().catch(() => undefined);
          handle = null;
        }
        try {
          await unlink(path ?? join(await stagingDir(namespace), layout.part(id)));
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
    };
  }

  async function open_(namespace: ObjectNamespace, id: string, expectedSize?: number): Promise<StoredObject> {
    const path = join(await objectsDir(namespace), safeId(id));
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isMissing(error)) throw new ObjectIntegrityError("missing");
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new ObjectIntegrityError("not_regular");
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP") throw new ObjectIntegrityError("not_regular");
      if (code === "ENOENT") throw new ObjectIntegrityError("missing");
      throw error;
    }
    let size: number;
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw new ObjectIntegrityError("not_regular");
      if (expectedSize !== undefined && opened.size !== expectedSize) throw new ObjectIntegrityError("size_mismatch");
      size = opened.size;
    } catch (error) {
      await handle.close();
      throw error;
    }
    let owned = true;
    return {
      size,
      stream(start = 0, end = size - 1) {
        owned = false;
        // The read stream closes the handle on end, error, or cancel (client abort).
        return Readable.toWeb(handle.createReadStream({ start, end, highWaterMark: 65_536 })) as unknown as ReadableStream<Uint8Array>;
      },
      async bytes() {
        owned = false;
        try {
          return new Uint8Array(await handle.readFile());
        } finally {
          await handle.close();
        }
      },
      async close() {
        if (!owned) return;
        owned = false;
        await handle.close();
      }
    };
  }

  const store: ObjectStore = {
    backend: "local",
    createWriter,
    async put(namespace, id, bytes) {
      const writer = createWriter(namespace, id);
      try {
        await writer.write(bytes);
        await writer.commit();
      } catch (error) {
        await writer.discard().catch(() => undefined);
        throw error;
      }
    },
    open: open_,
    async stat(namespace, id) {
      try {
        const info = await lstat(join(await objectsDir(namespace), safeId(id)));
        return info.isFile() && !info.isSymbolicLink() ? { id, size: info.size, modifiedMs: info.mtimeMs } : null;
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async remove(namespace, id) {
      try {
        await unlink(join(await objectsDir(namespace), safeId(id)));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
    async *list(namespace) {
      const objects = await objectsDir(namespace);
      const layout = LOCAL_LAYOUT[namespace];
      for (const name of await readdir(objects)) {
        // Staged writes share the avatars directory; they are not objects.
        if (layout.staging.join("/") === layout.objects.join("/") && layout.partId(name) !== null) continue;
        try {
          const info = await lstat(join(objects, name));
          const regular = info.isFile() && !info.isSymbolicLink();
          yield { id: regular && isObjectId(name) ? name : null, size: info.size, modifiedMs: info.mtimeMs };
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
    },
    async sweepStaging(namespace, cutoffMs) {
      const counts = { removed: 0, ignored: 0 };
      const layout = LOCAL_LAYOUT[namespace];
      const shared = layout.staging.join("/") === layout.objects.join("/");
      const staging = await stagingDir(namespace);
      for (const name of await readdir(staging)) {
        const id = layout.partId(name);
        // In a shared directory (avatars) everything else is an object, not an unexpected entry.
        if (shared && id === null) continue;
        const path = join(staging, name);
        try {
          const info = await lstat(path);
          if (id === null || !isObjectId(id) || !info.isFile() || info.isSymbolicLink()) {
            counts.ignored += 1;
            continue;
          }
          if (info.mtimeMs >= cutoffMs) continue;
          await unlink(path);
          counts.removed += 1;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      return counts;
    },
    async probe() {
      await objectsDir("documents");
    }
  };
  return store;
}

// --------------------------------------------------------------------------------------------- s3

/** Multipart part size: S3's minimum part is 5 MiB; the writer flushes after each one to bound memory. */
export const S3_PART_BYTES = 5 * 1024 * 1024;
const S3_QUEUE_SIZE = 2;
const S3_RETRIES = 3;

const s3Code = (error: unknown) => {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : error instanceof Error ? error.name : "Unknown";
};
const isNoSuchKey = (error: unknown) => ["NoSuchKey", "NotFound", "ENOENT"].includes(s3Code(error));

/** The S3 backend over Bun's built-in client. Errors are StorageUnavailableError with the service's code only. */
export function createS3ObjectStore(settings: Omit<S3StorageConfig, "backend">): ObjectStore {
  const client = new Bun.S3Client({
    bucket: settings.bucket,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
    ...(settings.region ? { region: settings.region } : {})
  });
  const prefix = settings.prefix;
  const keyOf = (namespace: ObjectNamespace, id: string) => `${prefix}${namespace}/${safeId(id)}`;
  const unavailable = (operation: string) => (error: unknown): never => {
    throw error instanceof StorageUnavailableError || error instanceof ObjectIntegrityError ? error : new StorageUnavailableError(operation, s3Code(error));
  };

  function createWriter(namespace: ObjectNamespace, id: string): ObjectWriter {
    const key = keyOf(namespace, id);
    let sink: ReturnType<ReturnType<typeof client.file>["writer"]> | null = null;
    let sinceFlush = 0;
    let state: "open" | "committed" | "discarded" = "open";
    const ensureSink = () => sink ??= client.file(key).writer({ partSize: S3_PART_BYTES, queueSize: S3_QUEUE_SIZE, retry: S3_RETRIES, type: "application/octet-stream" });
    return {
      async write(chunk) {
        if (state !== "open") throw new Error("Object writer is closed");
        try {
          const opened = ensureSink();
          const written = opened.write(chunk);
          if (written instanceof Promise) await written;
          sinceFlush += chunk.byteLength;
          // Bun's writer never pushes back on write(); a flush after every part waits for the upload, so at
          // most about one part per upload is held in memory. Parts stay at least S3_PART_BYTES (S3's minimum).
          if (sinceFlush >= S3_PART_BYTES) {
            sinceFlush = 0;
            const flushed = opened.flush();
            if (flushed instanceof Promise) await flushed;
          }
        } catch (error) {
          unavailable("write")(error);
        }
      },
      async commit() {
        if (state !== "open") throw new Error("Object writer is closed");
        state = "committed";
        try {
          const ended = ensureSink().end();
          if (ended instanceof Promise) await ended;
        } catch (error) {
          // A failed completion may still have left an object; remove it so the caller sees nothing.
          await client.delete(key).catch(() => undefined);
          unavailable("write")(error);
        }
      },
      async discard() {
        if (state === "discarded") return;
        const wasOpen = state === "open";
        state = "discarded";
        if (!sink) return;
        if (wasOpen) {
          try {
            const ended = sink.end();
            if (ended instanceof Promise) await ended;
          } catch {
            // The upload failed; Bun aborted it.
          }
        }
        await client.delete(key).catch(unavailable("delete"));
      }
    };
  }

  const store: ObjectStore = {
    backend: "s3",
    createWriter,
    async put(namespace, id, bytes) {
      const writer = createWriter(namespace, id);
      try {
        await writer.write(bytes);
        await writer.commit();
      } catch (error) {
        await writer.discard().catch(() => undefined);
        throw error;
      }
    },
    async open(namespace, id, expectedSize) {
      const key = keyOf(namespace, id);
      let size: number;
      try {
        size = (await client.stat(key)).size;
      } catch (error) {
        if (isNoSuchKey(error)) throw new ObjectIntegrityError("missing");
        return unavailable("read")(error);
      }
      if (expectedSize !== undefined && size !== expectedSize) throw new ObjectIntegrityError("size_mismatch");
      const file = client.file(key);
      return {
        size,
        stream(start = 0, end = size - 1) {
          // A ranged GET for part of the object; Bun streams the response body. Piped through a plain
          // TransformStream: Bun 1.4.2 sends its native S3 stream chunked, dropping the route's Content-Length.
          const source = (start === 0 && end === size - 1 ? file : file.slice(start, end + 1)).stream() as ReadableStream<Uint8Array>;
          return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>());
        },
        async bytes() {
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (bytes.byteLength !== size) throw new ObjectIntegrityError("size_mismatch");
            return bytes;
          } catch (error) {
            if (isNoSuchKey(error)) throw new ObjectIntegrityError("missing");
            return unavailable("read")(error);
          }
        },
        async close() {
          // Nothing is held open between the HEAD and a read.
        }
      };
    },
    async stat(namespace, id) {
      try {
        const info = await client.stat(keyOf(namespace, id));
        return { id, size: info.size, modifiedMs: info.lastModified.getTime() };
      } catch (error) {
        if (isNoSuchKey(error)) return null;
        return unavailable("stat")(error);
      }
    },
    async remove(namespace, id) {
      // S3 answers a DELETE of a missing key with success.
      await client.delete(keyOf(namespace, id)).catch(unavailable("delete"));
    },
    async *list(namespace) {
      const listPrefix = `${prefix}${namespace}/`;
      let continuationToken: string | undefined;
      do {
        let page;
        try {
          page = await client.list({ prefix: listPrefix, ...(continuationToken ? { continuationToken } : {}) });
        } catch (error) {
          return unavailable("list")(error);
        }
        for (const entry of page.contents ?? []) {
          const name = entry.key.slice(listPrefix.length);
          yield { id: isObjectId(name) ? name : null, size: entry.size ?? 0, modifiedMs: entry.lastModified ? Date.parse(entry.lastModified) : 0 };
        }
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (continuationToken);
    },
    async sweepStaging() {
      // Writes go straight to their key; an interrupted multipart upload is invisible and is cleared by
      // the bucket's AbortIncompleteMultipartUpload lifecycle rule (docs/OPERATIONS.md, S3 storage).
      return { removed: 0, ignored: 0 };
    },
    async probe() {
      const key = `${prefix}.probe/${crypto.randomUUID()}`;
      const payload = `nook storage probe ${new Date().toISOString()}`;
      try {
        await client.write(key, payload, { type: "text/plain" });
        const back = await client.file(key).text();
        if (back !== payload) throw new StorageUnavailableError("probe", "ReadBackMismatch");
      } catch (error) {
        await client.delete(key).catch(() => undefined);
        return unavailable("probe")(error);
      }
      await client.delete(key).catch(unavailable("probe"));
    }
  };
  return Object.assign(store, { client, prefix });
}

/** The Bun client and key prefix behind an S3 store (the instance marker and the migrate CLI use them). */
export const s3Internals = (store: ObjectStore) => store as ObjectStore & { client?: Bun.S3Client; prefix?: string };

export function createObjectStore(storage: StorageConfig, dataRoot: string): ObjectStore {
  return storage.backend === "s3" ? createS3ObjectStore(storage) : createLocalObjectStore(dataRoot);
}

let current: ObjectStore | null = null;

/** The store this process uses (STORAGE_BACKEND). */
export function objectStore() {
  return current ??= createObjectStore(config.storage, config.dataDir);
}

/** Test hook: swap the store (null restores the configured one). */
export function setObjectStoreForTests(store: ObjectStore | null) {
  current = store;
}

// ------------------------------------------------------------------------------ instance marker

const INSTANCE_FILE = "storage-instance";
const INSTANCE_KEY = ".nook-instance";

/**
 * Ties a bucket prefix to one data directory, so two Nooks pointed at the same S3_PREFIX cannot delete
 * each other's objects as orphans. DATA_DIR/storage-instance holds a random id (created once; it travels
 * with backups); `<S3_PREFIX>.nook-instance` holds the same id. A prefix that names another id refuses
 * to start. Returns "created" when the marker was written now.
 */
export async function claimS3Prefix(store: ObjectStore, dataRoot: string): Promise<"matched" | "created"> {
  const internals = s3Internals(store);
  if (store.backend !== "s3" || !internals.client) return "matched";
  const ownId = await localInstanceId(dataRoot);
  const marker = internals.client.file(`${internals.prefix ?? ""}${INSTANCE_KEY}`);
  let existing: string | null = null;
  try {
    existing = (await marker.text()).trim();
  } catch (error) {
    if (!isNoSuchKey(error)) throw new StorageUnavailableError("marker", s3Code(error));
  }
  if (existing === ownId) return "matched";
  if (existing) throw new Error("S3_PREFIX already holds files of another Nook data directory (its .nook-instance marker differs). Use another S3_PREFIX or bucket; two Nooks must never share one, or each would delete the other's files as orphans.");
  try {
    await marker.write(`${ownId}\n`, { type: "text/plain" });
  } catch (error) {
    throw new StorageUnavailableError("marker", s3Code(error));
  }
  return "created";
}

/** DATA_DIR/storage-instance, created on first use. */
export async function localInstanceId(dataRoot: string) {
  const path = join(resolve(dataRoot), INSTANCE_FILE);
  const file = Bun.file(path);
  if (await file.exists()) {
    const value = (await file.text()).trim();
    if (isObjectId(value)) return value;
    throw new Error(`${INSTANCE_FILE} in DATA_DIR is not a valid id; restore it from a backup or remove it only if no bucket holds this Nook's files`);
  }
  const id = crypto.randomUUID();
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${id}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return id;
}
