import type { CanonicalScene } from "../../shared/whiteboardScene";

/**
 * The pending local copy (whiteboard plan D210): unsaved scene JSON mirrored to IndexedDB under
 * `nook.whiteboard.pending.<userId>.<boardId>` with its base revision, cleared after a successful
 * save. Every access is wrapped, so a private window or a blocked database only loses the safety
 * net, never the board.
 */

export type PendingEntry = { scene: CanonicalScene; baseRevision: number; savedAt: string; live?: number };

const DB_NAME = "nook-whiteboards";
const STORE = "pending";
export const pendingKey = (userId: string, boardId: string) => `nook.whiteboard.pending.${userId}.${boardId}`;

let opening: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    return await new Promise<T | null>((resolve) => {
      try {
        const request = action(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

export async function readPending(userId: string, boardId: string): Promise<PendingEntry | null> {
  const value = await run<unknown>("readonly", (store) => store.get(pendingKey(userId, boardId)));
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<PendingEntry>;
  return typeof entry.baseRevision === "number" && entry.scene && typeof entry.savedAt === "string" ? entry as PendingEntry : null;
}

export async function writePending(userId: string, boardId: string, entry: PendingEntry) {
  await run("readwrite", (store) => store.put(entry, pendingKey(userId, boardId)));
}

export async function clearPending(userId: string, boardId: string) {
  await run("readwrite", (store) => store.delete(pendingKey(userId, boardId)));
}

/** Every key of `userId`'s pending copies (review L4). */
const userRange = (userId: string) => IDBKeyRange.bound(`nook.whiteboard.pending.${userId}.`, `nook.whiteboard.pending.${userId}.\uffff`);

/** How many unsaved whiteboard copies `userId` has on this device (0 when the database is unavailable). */
export async function countPendingForUser(userId: string): Promise<number> {
  if (typeof IDBKeyRange === "undefined") return 0;
  return (await run<number>("readonly", (store) => store.count(userRange(userId)))) ?? 0;
}

/** Sign-out (review L4): the signed-out person's unsaved drawings never stay on a shared device. */
export async function clearPendingForUser(userId: string) {
  if (typeof IDBKeyRange === "undefined") return;
  await run("readwrite", (store) => store.delete(userRange(userId)));
}
