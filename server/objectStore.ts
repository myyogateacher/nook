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
 *
 * Every S3 request has a deadline (S3_TIMEOUT_MS; a part upload four times that), and a download
 * stream fails when no bytes arrive for S3_TIMEOUT_MS (review H2): an endpoint that accepts and never
 * answers turns into StorageUnavailableError("…", "Timeout"), never a request that hangs.
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

/**
 * The storage service could not be reached, refused a request, timed out (`Timeout`), has every upload
 * slot in use (`Busy`), or this process lost its claim on the prefix (`Fenced`). S3 only; never carries
 * credentials.
 */
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
  /** Makes the object visible under its key. Locally fails when the key holds an object, unless created with `replace`. */
  commit(): Promise<void>;
  /** Drops what was written. Safe before any write, after a failed write or commit, and twice. Releases too. */
  discard(): Promise<void>;
  /**
   * The caller's row is committed (or the object abandoned): the orphan sweep may judge this object again.
   * Until then (from createWriter on) both sweeps skip it (review M1). Idempotent.
   */
  release(): void;
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

export type WriterOptions = {
  /** Replace an existing object atomically (locally: stage, then rename over it). The migrate CLI only. */
  replace?: boolean;
};

export interface ObjectStore {
  readonly backend: "local" | "s3";
  /** How old an unreferenced object must be before the sweep removes it (S3 allows for clock skew and slow uploads). */
  readonly orphanGraceMs: number;
  /** A staged writer for a new object; nothing is created until the first write or commit. */
  createWriter(namespace: ObjectNamespace, id: string, options?: WriterOptions): ObjectWriter;
  /**
   * Writes a whole object (staged, then committed); nothing is left behind on failure. The sweep keeps
   * skipping it until the caller's current synchronous step is over, so a row inserted right after the
   * await is always in place before the object can be judged an orphan.
   */
  put(namespace: ObjectNamespace, id: string, bytes: Uint8Array, options?: WriterOptions): Promise<void>;
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
  /** Writes, reads back, and deletes a small object; throws when any step fails. Reports the store's clock skew when it can. */
  probe(): Promise<{ clockSkewMs: number | null }>;
}

function safeId(id: string) {
  if (!isObjectId(id)) throw new Error("Invalid document id");
  return id;
}

/** Bytes an upload of `objectBytes` needs free on the data volume: the floor for SQLite, plus the bytes when they land there. */
export function diskBytesNeeded(objectBytes: number, store: Pick<ObjectStore, "backend"> = objectStore()) {
  return config.minFreeDiskBytes + (store.backend === "local" ? objectBytes : 0);
}

// ------------------------------------------------------------------------------ in-flight objects

/** Objects being written in this process whose row is not committed yet (review M1). Both sweeps skip them. */
const inFlight = new Map<string, number>();
const flightKey = (namespace: ObjectNamespace, id: string) => `${namespace}/${id}`;

export const isObjectInFlight = (namespace: ObjectNamespace, id: string) => inFlight.has(flightKey(namespace, id));

/**
 * Marks an object in flight and returns its release. The release waits for setImmediate, so a
 * caller that awaits the write and then commits its row in the same synchronous step is never seen by a
 * sweep in between.
 */
function holdObject(namespace: ObjectNamespace, id: string) {
  const key = flightKey(namespace, id);
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    setImmediate(() => {
      const left = (inFlight.get(key) ?? 1) - 1;
      if (left <= 0) inFlight.delete(key);
      else inFlight.set(key, left);
    });
  };
}

async function putThrough(writer: ObjectWriter, bytes: Uint8Array) {
  try {
    await writer.write(bytes);
    await writer.commit();
  } catch (error) {
    await writer.discard().catch(() => undefined);
    throw error;
  }
  writer.release();
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

  function createWriter(namespace: ObjectNamespace, id: string, options: WriterOptions = {}): ObjectWriter {
    safeId(id);
    const layout = LOCAL_LAYOUT[namespace];
    const release = holdObject(namespace, id);
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
        if (!options.replace) {
          try {
            await lstat(target);
            throw new Error("Document object already exists");
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }
        // rename() replaces an existing target atomically: the old bytes stay readable until the new ones are in place.
        await rename(source, target);
        await syncDirectory(staging);
        if (objects !== staging) await syncDirectory(objects);
      },
      async discard() {
        done = true;
        try {
          if (handle) {
            await handle.close().catch(() => undefined);
            handle = null;
          }
          try {
            await unlink(path ?? join(await stagingDir(namespace), layout.part(id)));
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        } finally {
          release();
        }
      },
      release
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
    orphanGraceMs: 3_600_000,
    createWriter,
    put: (namespace, id, bytes, options) => putThrough(createWriter(namespace, id, options), bytes),
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
          if (info.mtimeMs >= cutoffMs || isObjectInFlight(namespace, id)) continue;
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
      return { clockSkewMs: null };
    }
  };
  return store;
}

// --------------------------------------------------------------------------------------------- s3

/** Multipart part size: S3's minimum part is 5 MiB; the writer flushes after each one to bound memory. */
export const S3_PART_BYTES = 5 * 1024 * 1024;
/** One part in flight per upload (review M3): with the flush after every part, the queue never holds more. */
const S3_QUEUE_SIZE = 1;
const S3_RETRIES = 3;
/** Concurrent S3 uploads in this process (review M3); past it an upload answers 503 STORAGE_BUSY with Retry-After. */
export const S3_MAX_UPLOADS = 8;
let s3UploadLimit = S3_MAX_UPLOADS;
let s3UploadsActive = 0;
/** Test hook: the concurrent S3 upload cap (null restores the default). */
export function setS3UploadLimitForTests(limit: number | null) {
  s3UploadLimit = limit ?? S3_MAX_UPLOADS;
}
export const s3UploadsInProgress = () => s3UploadsActive;

/** Clock skew between this host and the store above which startup warns (S3 signatures fail past 15 minutes). */
export const CLOCK_SKEW_WARN_MS = 5 * 60_000;

const s3Code = (error: unknown) => {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : error instanceof Error ? error.name : "Unknown";
};
const isNoSuchKey = (error: unknown) => ["NoSuchKey", "NotFound", "ENOENT"].includes(s3Code(error));

/** Races `work` against a deadline; on expiry throws StorageUnavailableError(operation, "Timeout"). The request itself is abandoned. */
export function withDeadline<T>(work: Promise<T> | T, ms: number, operation: string): Promise<T> {
  if (!(work instanceof Promise)) return Promise.resolve(work);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StorageUnavailableError(operation, "Timeout")), ms);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Wraps a download stream with an idle watchdog: no bytes for `idleMs` errors the stream (the client sees
 * a cut response, the handler never stays pending). Content-Length (review L2): Bun 1.4.2 sends a
 * streamed body with chunked transfer encoding and leaves the route's Content-Length out, on either
 * backend (the local file stream too); only a body that is complete before the headers go out keeps it.
 * HEAD and 416 answers carry it, and Content-Range still states every range's size.
 */
function watchdogStream(source: ReadableStream<Uint8Array>, idleMs: number): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await withDeadline(reader.read(), idleMs, "read");
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error instanceof StorageUnavailableError ? error : new StorageUnavailableError("read", s3Code(error)));
        reader.cancel().catch(() => undefined);
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => undefined);
    }
  }, { highWaterMark: 0 });
}

export type S3StoreSettings = Omit<S3StorageConfig, "backend" | "timeoutMs"> & { timeoutMs?: number };

/** The S3 backend over Bun's built-in client. Errors are StorageUnavailableError with the service's code only. */
export function createS3ObjectStore(settings: S3StoreSettings): ObjectStore {
  const client = new Bun.S3Client({
    bucket: settings.bucket,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    // Always explicit (review L3): never AWS_ENDPOINT or S3_ENDPOINT from the environment.
    endpoint: settings.endpoint,
    ...(settings.region ? { region: settings.region } : {})
  });
  const prefix = settings.prefix;
  const timeoutMs = settings.timeoutMs ?? 30_000;
  const partTimeoutMs = timeoutMs * 4;
  const keyOf = (namespace: ObjectNamespace, id: string) => `${prefix}${namespace}/${safeId(id)}`;
  const unavailable = (operation: string) => (error: unknown): never => {
    throw error instanceof StorageUnavailableError || error instanceof ObjectIntegrityError ? error : new StorageUnavailableError(operation, s3Code(error));
  };
  /** One metadata request (HEAD, DELETE, LIST, small PUT/GET) within the deadline. */
  const request = <T>(work: Promise<T>, operation: string) => withDeadline(work, timeoutMs, operation).catch(unavailable(operation));
  let fenced = false;
  const notFenced = (operation: string) => {
    if (fenced) throw new StorageUnavailableError(operation, "Fenced");
  };

  function createWriter(namespace: ObjectNamespace, id: string): ObjectWriter {
    const key = keyOf(namespace, id);
    const release = holdObject(namespace, id);
    let sink: ReturnType<ReturnType<typeof client.file>["writer"]> | null = null;
    let sinceFlush = 0;
    let slot = false;
    let state: "open" | "committed" | "discarded" = "open";
    const freeSlot = () => {
      if (slot) s3UploadsActive -= 1;
      slot = false;
    };
    const ensureSink = () => {
      if (!sink) {
        if (s3UploadsActive >= s3UploadLimit) throw new StorageUnavailableError("write", "Busy");
        s3UploadsActive += 1;
        slot = true;
        sink = client.file(key).writer({ partSize: S3_PART_BYTES, queueSize: S3_QUEUE_SIZE, retry: S3_RETRIES, type: "application/octet-stream" });
      }
      return sink;
    };
    return {
      async write(chunk) {
        if (state !== "open") throw new Error("Object writer is closed");
        try {
          const opened = ensureSink();
          await withDeadline(opened.write(chunk), partTimeoutMs, "write");
          sinceFlush += chunk.byteLength;
          // Bun's writer never pushes back on write(); a flush after every part waits for the upload, so at
          // most about one part per upload is held in memory. Parts stay at least S3_PART_BYTES (S3's minimum).
          if (sinceFlush >= S3_PART_BYTES) {
            sinceFlush = 0;
            await withDeadline(opened.flush(), partTimeoutMs, "write");
          }
        } catch (error) {
          unavailable("write")(error);
        }
      },
      async commit() {
        if (state !== "open") throw new Error("Object writer is closed");
        state = "committed";
        try {
          await withDeadline(ensureSink().end(), partTimeoutMs, "write");
        } catch (error) {
          // A failed completion may still have left an object; remove it so the caller sees nothing.
          await withDeadline(client.delete(key), timeoutMs, "delete").catch(() => undefined);
          // Nothing left for discard() to do (one delete attempt, not two, against a failing store).
          state = "discarded";
          unavailable("write")(error);
        } finally {
          freeSlot();
        }
      },
      async discard() {
        if (state === "discarded") {
          release();
          return;
        }
        const wasOpen = state === "open";
        state = "discarded";
        try {
          if (!sink) return;
          if (wasOpen) {
            try {
              await withDeadline(sink.end(), partTimeoutMs, "write");
            } catch {
              // The upload failed or hung; Bun aborts a failed one.
            }
          }
          await request(client.delete(key), "delete");
        } finally {
          freeSlot();
          release();
        }
      },
      release
    };
  }

  const store: ObjectStore = {
    backend: "s3",
    // Six hours: S3 dates a multipart object from its first part, and this host's clock may differ from the store's.
    orphanGraceMs: 6 * 3_600_000,
    createWriter,
    put: (namespace, id, bytes) => putThrough(createWriter(namespace, id), bytes),
    async open(namespace, id, expectedSize) {
      const key = keyOf(namespace, id);
      let size: number;
      try {
        size = (await withDeadline(client.stat(key), timeoutMs, "read")).size;
      } catch (error) {
        if (isNoSuchKey(error)) throw new ObjectIntegrityError("missing");
        return unavailable("read")(error);
      }
      if (expectedSize !== undefined && size !== expectedSize) throw new ObjectIntegrityError("size_mismatch");
      const file = client.file(key);
      return {
        size,
        stream(start = 0, end = size - 1) {
          // A ranged GET for part of the object; Bun streams the response body.
          const source = (start === 0 && end === size - 1 ? file : file.slice(start, end + 1)).stream() as ReadableStream<Uint8Array>;
          return watchdogStream(source, timeoutMs);
        },
        async bytes() {
          try {
            const bytes = new Uint8Array(await withDeadline(file.arrayBuffer(), partTimeoutMs, "read"));
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
        const info = await withDeadline(client.stat(keyOf(namespace, id)), timeoutMs, "stat");
        return { id, size: info.size, modifiedMs: info.lastModified.getTime() };
      } catch (error) {
        if (isNoSuchKey(error)) return null;
        return unavailable("stat")(error);
      }
    },
    async remove(namespace, id) {
      notFenced("delete");
      // S3 answers a DELETE of a missing key with success.
      await request(client.delete(keyOf(namespace, id)), "delete");
    },
    async *list(namespace) {
      const listPrefix = `${prefix}${namespace}/`;
      let continuationToken: string | undefined;
      do {
        const page = await request(client.list({ prefix: listPrefix, ...(continuationToken ? { continuationToken } : {}) }), "list");
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
      let clockSkewMs: number | null = null;
      try {
        const before = Date.now();
        await request(client.write(key, payload, { type: "text/plain" }), "probe");
        const after = Date.now();
        const back = await request(client.file(key).text(), "probe");
        if (back !== payload) throw new StorageUnavailableError("probe", "ReadBackMismatch");
        // Last-Modified has one-second resolution; anything outside the request's window, past a second, is skew.
        const stamped = (await request(client.stat(key), "probe")).lastModified.getTime();
        clockSkewMs = stamped < before - 1000 ? stamped - before : stamped > after + 1000 ? stamped - after : 0;
      } catch (error) {
        await withDeadline(client.delete(key), timeoutMs, "probe").catch(() => undefined);
        return unavailable("probe")(error);
      }
      await request(client.delete(key), "probe");
      return { clockSkewMs };
    }
  };
  return Object.assign(store, {
    client,
    prefix,
    timeoutMs,
    /** Stops every delete from this process: it no longer holds the prefix's newest claim (review M2). */
    fence: () => { fenced = true; },
    isFenced: () => fenced
  });
}

/** The Bun client and key prefix behind an S3 store (the instance marker and the migrate CLI use them). */
export const s3Internals = (store: ObjectStore) => store as ObjectStore & { client?: Bun.S3Client; prefix?: string; timeoutMs?: number; fence?: () => void; isFenced?: () => boolean };

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

type LocalInstance = { id: string; seq: number };
type Marker = { id: string; seq: number; nonce: string };

/**
 * The prefix claim (review M2). `DATA_DIR/storage-instance` holds this data directory's id and claim
 * number (`<uuid> <n>`); `<S3_PREFIX>.nook-instance` holds the newest claim (`<uuid> <n> <nonce>`).
 *
 * - Another id in the marker: another Nook's prefix. Refused (two Nooks would sweep each other's files).
 * - A marker number above this directory's: this directory is older than the bucket's last claim, which
 *   is what a restored backup looks like (the live server claimed again since). Refused at startup, and a
 *   running server that finds itself behind at its hourly check is fenced: no sweeps and no deletes.
 *   `storage-admin.ts reclaim` accepts the directory after a real disaster restore.
 * - Otherwise the claim moves on: the local number first, then the marker, then the marker is read back
 *   (Bun 1.4.2 has no conditional PUT); a different nonce means another process claimed at the same time.
 *
 * Every start and every hourly sweep claims again, and backup.sh restarts the server, so an archive's
 * number is always behind the live bucket's.
 */
export class PrefixClaimError extends Error {
  constructor(readonly reason: "foreign" | "stale" | "race", message: string) {
    super(message);
    this.name = "PrefixClaimError";
  }
}

const foreignMessage = "S3_PREFIX already holds files of another Nook data directory (its .nook-instance marker differs). Use another S3_PREFIX or bucket; two Nooks must never share one, or each would delete the other's files as orphans";
const staleMessage = "This data directory is older than the S3 prefix's last claim: it looks like a restored backup while the live Nook still uses this bucket. A restore test must use another S3_PREFIX (copy the objects there) or a read-only key. After a real disaster restore, run bun server/storage-admin.ts reclaim";

function parseMarker(text: string): Marker | null {
  const [id, seq, nonce] = text.trim().split(/\s+/);
  if (!id || !isObjectId(id)) return null;
  return { id, seq: Number.isSafeInteger(Number(seq)) ? Number(seq) : 0, nonce: nonce ?? "" };
}

async function readMarker(store: ObjectStore): Promise<Marker | "absent"> {
  const internals = s3Internals(store);
  const file = internals.client!.file(`${internals.prefix ?? ""}${INSTANCE_KEY}`);
  try {
    const text = await withDeadline(file.text(), internals.timeoutMs ?? 30_000, "marker");
    return parseMarker(text) ?? { id: "unreadable", seq: Number.MAX_SAFE_INTEGER, nonce: "" };
  } catch (error) {
    if (isNoSuchKey(error)) return "absent";
    throw error instanceof StorageUnavailableError ? error : new StorageUnavailableError("marker", s3Code(error));
  }
}

async function writeMarker(store: ObjectStore, marker: Marker) {
  const internals = s3Internals(store);
  const file = internals.client!.file(`${internals.prefix ?? ""}${INSTANCE_KEY}`);
  try {
    await withDeadline(file.write(`${marker.id} ${marker.seq} ${marker.nonce}\n`, { type: "text/plain" }), internals.timeoutMs ?? 30_000, "marker");
  } catch (error) {
    throw error instanceof StorageUnavailableError ? error : new StorageUnavailableError("marker", s3Code(error));
  }
}

/** Read only: whether the prefix is free, this directory's, or refused (foreign or stale). */
export async function checkS3Prefix(store: ObjectStore, dataRoot: string): Promise<"absent" | "matched"> {
  if (store.backend !== "s3") return "matched";
  const own = await readLocalInstance(dataRoot);
  const marker = await readMarker(store);
  if (marker === "absent") return "absent";
  if (marker.id !== own.id) throw new PrefixClaimError("foreign", foreignMessage);
  if (marker.seq > own.seq) throw new PrefixClaimError("stale", staleMessage);
  return "matched";
}

/** Claims the prefix for this data directory (see PrefixClaimError). Returns "created" when no marker existed. */
export async function claimS3Prefix(store: ObjectStore, dataRoot: string, options: { reclaim?: boolean } = {}): Promise<"matched" | "created"> {
  if (store.backend !== "s3") return "matched";
  const own = await readLocalInstance(dataRoot);
  const marker = await readMarker(store);
  if (marker !== "absent" && marker.id !== own.id) throw new PrefixClaimError("foreign", foreignMessage);
  if (marker !== "absent" && marker.seq > own.seq && !options.reclaim) {
    s3Internals(store).fence?.();
    throw new PrefixClaimError("stale", staleMessage);
  }
  const next: Marker = { id: own.id, seq: Math.max(own.seq, marker === "absent" ? 0 : marker.seq) + 1, nonce: crypto.randomUUID() };
  await writeLocalInstance(dataRoot, { id: own.id, seq: next.seq });
  await writeMarker(store, next);
  const back = await readMarker(store);
  if (back === "absent" || back.nonce !== next.nonce) {
    s3Internals(store).fence?.();
    throw new PrefixClaimError("race", "Another process claimed this S3_PREFIX at the same moment; only one Nook may use a prefix");
  }
  return marker === "absent" ? "created" : "matched";
}

/** DATA_DIR/storage-instance (`<uuid> <n>`; an older file holds the id alone), created on first use. */
export async function readLocalInstance(dataRoot: string): Promise<LocalInstance> {
  const path = join(resolve(dataRoot), INSTANCE_FILE);
  const file = Bun.file(path);
  if (await file.exists()) {
    const [id, seq] = (await file.text()).trim().split(/\s+/);
    if (id && isObjectId(id)) return { id, seq: Number.isSafeInteger(Number(seq)) ? Number(seq) : 0 };
    throw new Error(`${INSTANCE_FILE} in DATA_DIR is not a valid id; restore it from a backup or remove it only if no bucket holds this Nook's files`);
  }
  const created = { id: crypto.randomUUID(), seq: 0 };
  await writeLocalInstance(dataRoot, created);
  return created;
}

export const localInstanceId = async (dataRoot: string) => (await readLocalInstance(dataRoot)).id;

async function writeLocalInstance(dataRoot: string, instance: LocalInstance) {
  const path = join(resolve(dataRoot), INSTANCE_FILE);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${instance.id} ${instance.seq}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  await syncDirectory(resolve(dataRoot));
}
