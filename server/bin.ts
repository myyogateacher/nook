import { audit, db, ensureDefaultFolder, now } from "./db";
import { removeObject } from "./documentStorage";
import { storage, withResourceLock } from "./storage";
import { emptyTaskBin, listTaskBin, sweepTaskBin, type TaskBinType } from "./tasks/bin";
import { readableBoardPredicate } from "./tasks/access";
import { readableCollectionPredicate } from "./collections/access";

/** Bin retention is a constant (D11), not configurable. */
export const BIN_RETENTION_MS = 30 * 86_400_000;

/** Types stored in the core tables below. */
export type CoreBinType = "note" | "document";
/** Types whose module registers a BinProvider (Collections and Calendar, WAVES_10-12.md D68). */
export type ProvidedBinType = "collection" | "collection_row" | "calendar" | "event";
export type BinType = CoreBinType | ProvidedBinType;
const CORE_BIN_TYPES: readonly CoreBinType[] = ["note", "document"];
const PROVIDED_BIN_TYPES: readonly ProvidedBinType[] = ["collection", "collection_row", "calendar", "event"];
/**
 * Why an item was purged, as recorded in the audit metadata. "resumed" marks a
 * purge the sweeper finished after it was interrupted: the original reason
 * (user, blank, or retention) is not stored, and the start is audited through
 * the earlier delete event.
 */
export type PurgeReason = "user" | "retention" | "blank" | "resumed";
/** purged: row and bytes are gone. pending: tombstoned, bytes remain, the sweeper retries. not_found: no binned row. */
export type PurgeOutcome = "purged" | "pending" | "not_found";

export const purgeAfterFrom = (deletedAt: Date) => new Date(deletedAt.getTime() + BIN_RETENTION_MS).toISOString();

const tables = { note: "notes", document: "documents" } as const;
export const lockKey = (type: BinType, id: string) => `${type}:${id}`;
const isProvided = (type: string): type is ProvidedBinType => (PROVIDED_BIN_TYPES as readonly string[]).includes(type);

/**
 * Byte removal for each type. ENOENT counts as success in both. Kept on an
 * object so tests can inject a failure without touching the filesystem.
 */
export const binStorage = {
  removeBytes: (type: CoreBinType, id: string) => type === "note" ? storage.removeNote(id) : removeDocumentObjects(id)
};

/**
 * A document's bytes: its own object, and for a whiteboard (Wave 23, §6) its current scene object and
 * every snapshot object first (the board has no object under its document id). ENOENT is success.
 * The rows still exist here (purge step 2), and step 3 cascades them away.
 */
async function removeDocumentObjects(id: string) {
  const objects = db.query(`SELECT object_id FROM whiteboards WHERE document_id = ?
    UNION ALL SELECT object_id FROM whiteboard_snapshots WHERE document_id = ?`).all(id, id) as Array<{ object_id: string }>;
  for (const { object_id } of objects) await removeObject(object_id);
  await removeObject(id);
}

/**
 * DEVELOPMENT_PLAN §9.3. The caller must hold withResourceLock(lockKey(type, id)).
 *
 * 1. Tombstone: purge_started_at is set (kept if already set). From here the
 *    row is never readable (deleted_at IS NOT NULL) or restorable.
 * 2. Remove bytes. Any error other than ENOENT leaves the tombstone for the sweeper.
 * 3. Delete the row in a transaction (cascades clear versions and shares) and
 *    audit the purge with the id in metadata, since audit_log.note_id is nulled.
 */
export async function purgeLocked(type: CoreBinType, id: string, options: { reason: PurgeReason; actorId: string | null; ownerId?: string; dueBy?: string }): Promise<PurgeOutcome> {
  const table = tables[type];
  const startedAt = new Date().toISOString();
  // Sweeper purges re-check retention under the lock: an item restored and deleted
  // again since the run's snapshot has a fresh purge_after and must survive.
  const retention = options.dueBy === undefined ? "" : " AND (purge_started_at IS NOT NULL OR purge_after <= $dueBy)";
  const owner = options.ownerId === undefined ? "" : " AND owner_id = $ownerId";
  const marked = db.query(`UPDATE ${table} SET purge_started_at = COALESCE(purge_started_at, $startedAt) WHERE id = $id AND deleted_at IS NOT NULL${owner}${retention}`)
    .run({ startedAt, id, ...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }), ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) });
  if (marked.changes === 0) return "not_found";

  try {
    await binStorage.removeBytes(type, id);
  } catch (error) {
    console.error(`Bin purge could not remove ${type} bytes (${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : "Unknown error"})`);
    return "pending";
  }

  db.transaction(() => {
    const removed = db.query(`DELETE FROM ${table} WHERE id = ? AND purge_started_at IS NOT NULL`).run(id);
    if (removed.changes) {
      audit(options.actorId, null, `${type}.purge`, type === "note" ? { noteId: id, reason: options.reason } : { documentId: id, reason: options.reason });
    }
  })();
  return "purged";
}

/**
 * Delete forever (owner only). Distinguishes a live item (409 NOT_IN_BIN)
 * from a missing one (404). A row already being purged is finished here.
 */
export function purgeOwnedItem(type: BinType, id: string, ownerId: string): Promise<PurgeOutcome | "live"> {
  if (isProvided(type)) return requireProvider(type).purge(id, ownerId);
  return withResourceLock(lockKey(type, id), async () => {
    const row = db.query(`SELECT deleted_at FROM ${tables[type]} WHERE id = ? AND owner_id = ?`).get(id, ownerId) as { deleted_at: string | null } | null;
    if (!row) return "not_found";
    if (row.deleted_at === null) return "live";
    return purgeLocked(type, id, { reason: "user", actorId: ownerId, ownerId });
  });
}

export type Visibility = "private" | "selected" | "all_users";
export type RestoreOutcome =
  | { status: "restored"; folderId: string | null; folderName: string | null; visibility: Visibility }
  | { status: "already_restored"; folderId: string | null; folderName: string | null }
  /** A calendar or event (server/calendar/calendarBin.ts): the response names the calendar instead of a folder. */
  | { status: "calendar_restored"; alreadyRestored: boolean; calendarId: string; calendarName: string }
  | { status: "purging" }
  | { status: "not_found" }
  /** A child (a row, an event) whose parent (its collection, calendar) is itself in the Bin: restore the parent first. */
  | { status: "parent_in_bin"; message?: string }
  | { status: "limit_reached"; message: string };

/**
 * A module's Bin items (D68): listed with the caller's items, restored and
 * purged through /api/bin, swept by retention, and emptied with the Bin. The
 * provider enforces its own ownership rules and locks.
 */
export type BinProvider = {
  list: (userId: string) => BinItem[];
  restore: (id: string, userId: string) => Promise<RestoreOutcome>;
  purge: (id: string, userId: string) => Promise<PurgeOutcome | "live">;
  sweep: (cutoff: string) => Promise<BinSweepCounts>;
  empty: (userId: string) => Promise<BinSweepCounts>;
};
/** Registered providers. Exported for tests that simulate a module that is not installed. */
export const binProviders = new Map<ProvidedBinType, BinProvider>();
const providers = binProviders;

/** Registered by server/collections/bin.ts and server/calendar/calendarBin.ts when their module loads. */
export function registerBinProvider(type: ProvidedBinType, provider: BinProvider) {
  providers.set(type, provider);
}

/**
 * Whether the Bin API accepts `type`: notes and documents always, provided types only while
 * their module has registered a provider, so an unregistered type is a 400, never a 500.
 */
export function binTypeAvailable(type: string): type is BinType {
  return (CORE_BIN_TYPES as readonly string[]).includes(type) || (isProvided(type) && providers.has(type));
}

export const availableBinTypes = (): BinType[] => [...CORE_BIN_TYPES, ...PROVIDED_BIN_TYPES.filter((type) => providers.has(type))];

function requireProvider(type: ProvidedBinType) {
  const provider = providers.get(type);
  if (!provider) throw new Error(`No Bin provider for ${type}`);
  return provider;
}

type RestorableRow = { folder_id: string | null; visibility: Visibility; sharing_override: number; deleted_at: string | null; purge_started_at: string | null };
type FolderRow = { id: string; name: string; visibility: Visibility };

const ownedFolder = (folderId: string | null, ownerId: string) => folderId === null
  ? null
  : db.query("SELECT id, name, visibility FROM folders WHERE id = ? AND owner_id = ?").get(folderId, ownerId) as FolderRow | null;

/**
 * Restore (owner only), DEVELOPMENT_PLAN §9.1 and D14. Compare-and-swap under
 * the resource lock; a row with a purge in progress is never restored. The
 * item returns to its original folder if the owner still has it, otherwise to
 * the owner's Default folder. Share rows were kept, so the item's previous
 * audience regains access; the response reports the effective visibility.
 */
export function restoreItem(type: BinType, id: string, ownerId: string): Promise<RestoreOutcome> {
  if (isProvided(type)) return requireProvider(type).restore(id, ownerId);
  const table = tables[type];
  return withResourceLock(lockKey(type, id), async () => {
    const row = db.query(`SELECT folder_id, visibility, sharing_override, deleted_at, purge_started_at FROM ${table} WHERE id = ? AND owner_id = ?`)
      .get(id, ownerId) as RestorableRow | null;
    if (!row) return { status: "not_found" };
    if (row.purge_started_at !== null) return { status: "purging" };
    if (row.deleted_at === null) {
      const folder = ownedFolder(row.folder_id, ownerId);
      return { status: "already_restored", folderId: folder?.id ?? null, folderName: folder?.name ?? null };
    }
    // An attachment (purpose <> 'file') that a card or a collection row still links comes back as an
    // attachment: no folder, same purpose, since a folder would expose it to that folder's audience
    // (WAVES_7-9.md §7, WAVES_10-12.md D58). One that nothing links returns to Files, in its folder or Default.
    const linkedAttachment = type === "document" && Boolean(db.query(`SELECT 1 FROM documents d WHERE d.id = ? AND d.purpose <> 'file'
      AND (EXISTS (SELECT 1 FROM card_attachments ca WHERE ca.document_id = d.id)
        OR EXISTS (SELECT 1 FROM collection_row_attachments cra WHERE cra.document_id = d.id))`).get(id));
    if (linkedAttachment) {
      return db.transaction((): RestoreOutcome => {
        const restored = db.query(`UPDATE documents SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, folder_id = NULL, updated_at = ?
          WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL`).run(now(), id, ownerId);
        if (restored.changes !== 1) return { status: "purging" };
        audit(ownerId, null, "document.restore", { documentId: id, folderId: null });
        return { status: "restored", folderId: null, folderName: null, visibility: "private" };
      })();
    }
    return db.transaction((): RestoreOutcome => {
      const folder = ownedFolder(row.folder_id, ownerId) ?? ownedFolder(ensureDefaultFolder(ownerId), ownerId)!;
      const restored = db.query(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, folder_id = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL`)
        .run(folder.id, now(), id, ownerId);
      if (type === "document" && restored.changes === 1) {
        db.query("UPDATE documents SET purpose = 'file' WHERE id = ? AND purpose IN ('task_attachment', 'collection_attachment')").run(id);
      }
      if (restored.changes !== 1) return { status: "purging" };
      if (type === "note") audit(ownerId, id, "note.restore", { folderId: folder.id });
      else audit(ownerId, null, "document.restore", { documentId: id, folderId: folder.id });
      const visibility = row.sharing_override ? row.visibility : folder.visibility;
      return { status: "restored", folderId: folder.id, folderName: folder.name, visibility };
    })();
  });
}

export const SWEEP_BATCH_SIZE = 100;
/** Interrupted purges resumed per table and run. Kept separate so rows that keep failing never starve due ones. */
export const SWEEP_RESUME_BATCH_SIZE = 50;
export type BinSweepCounts = { purged: number; pending: number };

/**
 * Sweeper step 3 (DEVELOPMENT_PLAN §6.5). Per table and run: resume up to
 * SWEEP_RESUME_BATCH_SIZE interrupted purges, then purge up to
 * SWEEP_BATCH_SIZE rows whose retention has ended. Each budget is separate, so
 * a run is bounded and failing tombstones never block expired items.
 * Remaining rows wait for the next run.
 */
export async function sweepBin(options: { nowMs?: number } = {}): Promise<BinSweepCounts> {
  const cutoff = new Date(options.nowMs ?? Date.now()).toISOString();
  const counts: BinSweepCounts = { purged: 0, pending: 0 };
  for (const type of ["note", "document"] as const) {
    const table = tables[type];
    const resumed = db.query(`SELECT id FROM ${table} WHERE purge_started_at IS NOT NULL ORDER BY purge_started_at LIMIT ?`)
      .all(SWEEP_RESUME_BATCH_SIZE) as Array<{ id: string }>;
    const due = db.query(`SELECT id FROM ${table} WHERE deleted_at IS NOT NULL AND purge_started_at IS NULL AND purge_after <= ? ORDER BY purge_after LIMIT ?`)
      .all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string }>;
    const work = [...resumed.map((row) => ({ id: row.id, reason: "resumed" as const })), ...due.map((row) => ({ id: row.id, reason: "retention" as const }))];
    for (const { id, reason } of work) {
      const outcome = await withResourceLock(lockKey(type, id), () => purgeLocked(type, id, { reason, actorId: null, dueBy: cutoff }));
      if (outcome === "purged") counts.purged += 1;
      else if (outcome === "pending") counts.pending += 1;
    }
  }
  // Cards and boards (Task Boards stage D). Purging them can move attachments to the Bin with a
  // fresh 30 days, so they run after documents.
  counts.purged += await sweepTaskBin(cutoff, SWEEP_BATCH_SIZE);
  // Provided types (collections, rows) purge due items in their own order: parents first.
  for (const provider of providers.values()) {
    const provided = await provider.sweep(cutoff);
    counts.purged += provided.purged;
    counts.pending += provided.pending;
  }
  return counts;
}

/** Bin rows across notes, documents, cards, boards, collections, and rows (docs/plan/API_CONTRACTS.md § Bin). */
export type BinListType = BinType | TaskBinType;

export type BinItem = {
  type: BinListType;
  id: string;
  title: string;
  folder_id: string | null;
  folder_name: string | null;
  size_bytes: number | null;
  deleted_at: string;
  purge_after: string;
  purging: boolean;
  /** Cards: their board; boards: themselves. Null for notes and documents. */
  board_id: string | null;
  board_name: string | null;
  /** A document that was a card attachment (it returns to Files when restored). */
  attachment: boolean;
  /**
   * For an attachment still linked to a live card on a board the caller can read, that card's title;
   * else to a live row in a collection they can read, that row's primary field ('' when empty).
   */
  attachment_of: string | null;
  /** What an attachment is still linked to ('card' or 'row'), so a restore keeps it there; null when nothing links it. */
  attachment_kind: "card" | "row" | null;
  /** Whether the caller may delete it forever (a card's deleter may only restore it). */
  can_purge: boolean;
  /** Cards: descendants binned with it, restored and purged with it (task hierarchy D129). */
  descendant_count?: number;
  /** Documents only: a whiteboard (Wave 23) or any other file. */
  kind?: "file" | "whiteboard";
};

export const BIN_LIST_LIMIT = 500;

/**
 * The caller's binned items, newest deletion first: their notes and documents, their binned
 * boards, and binned cards on boards they own or that they deleted themselves (D41). Folder
 * columns are null when the original folder is gone (restore then targets Default).
 */
export function listBin(ownerId: string, type: BinListType | null) {
  const notes = `SELECT 'note' AS type, n.id, n.title, f.id AS folder_id, f.name AS folder_name, NULL AS size_bytes,
      n.deleted_at, n.purge_after, n.purge_started_at IS NOT NULL AS purging, 0 AS attachment, NULL AS attachment_of, NULL AS row_attachment_of, NULL AS attachment_kind, 0 AS whiteboard
    FROM notes n LEFT JOIN folders f ON f.id = n.folder_id AND f.owner_id = n.owner_id
    WHERE n.owner_id = $ownerId AND n.deleted_at IS NOT NULL`;
  const documents = `SELECT 'document' AS type, d.id, d.name AS title, f.id AS folder_id, f.name AS folder_name, d.size_bytes,
      d.deleted_at, d.purge_after, d.purge_started_at IS NOT NULL AS purging, CASE WHEN d.purpose = 'file' THEN 0 ELSE 1 END AS attachment,
      CASE WHEN d.purpose = 'file' THEN NULL ELSE (
        SELECT k.title FROM card_attachments ca JOIN cards k ON k.id = ca.card_id AND k.deleted_at IS NULL JOIN boards b ON b.id = k.board_id
        WHERE ca.document_id = d.id AND ${readableBoardPredicate.replaceAll("$userId", "$ownerId")} ORDER BY ca.created_at LIMIT 1
      ) END AS attachment_of,
      CASE WHEN d.purpose = 'file' THEN NULL ELSE (
        SELECT COALESCE(CAST(json_extract(r.values_json, '$.' || json_extract(c.schema_json, '$.fields[0].id')) AS TEXT), '')
        FROM collection_row_attachments cra JOIN collection_rows r ON r.id = cra.row_id AND r.deleted_at IS NULL JOIN collections c ON c.id = r.collection_id
        WHERE cra.document_id = d.id AND ${readableCollectionPredicate.replaceAll("$userId", "$ownerId")} ORDER BY cra.created_at LIMIT 1
      ) END AS row_attachment_of,
      CASE WHEN d.purpose = 'file' THEN NULL
        WHEN EXISTS (SELECT 1 FROM card_attachments ca WHERE ca.document_id = d.id) THEN 'card'
        WHEN EXISTS (SELECT 1 FROM collection_row_attachments cra WHERE cra.document_id = d.id) THEN 'row' ELSE NULL END AS attachment_kind,
      EXISTS (SELECT 1 FROM whiteboards w WHERE w.document_id = d.id) AS whiteboard
    FROM documents d LEFT JOIN folders f ON f.id = d.folder_id AND f.owner_id = d.owner_id
    WHERE d.owner_id = $ownerId AND d.deleted_at IS NOT NULL`;
  const items: BinItem[] = [];
  if (type !== null && isProvided(type)) return requireProvider(type).list(ownerId).slice(0, BIN_LIST_LIMIT);
  if (type === null || type === "note" || type === "document") {
    // The Files filter shows Files items only; attachments appear under All (WAVES_7-9.md §7).
    const source = type === "note" ? notes : type === "document" ? `${documents} AND d.purpose = 'file'` : `${notes} UNION ALL ${documents}`;
    const rows = db.query(`SELECT * FROM (${source}) ORDER BY deleted_at DESC, id LIMIT $limit`)
      .all({ ownerId, limit: BIN_LIST_LIMIT }) as Array<Omit<BinItem, "purging" | "attachment" | "board_id" | "board_name" | "can_purge" | "kind"> & { purging: number; attachment: number; row_attachment_of: string | null; whiteboard: number }>;
    items.push(...rows.map(({ row_attachment_of, whiteboard, ...row }): BinItem => ({
      ...row, attachment_of: row.attachment_of ?? row_attachment_of, purging: row.purging === 1, attachment: row.attachment === 1, board_id: null, board_name: null, can_purge: true,
      ...(row.type === "document" ? { kind: whiteboard === 1 ? "whiteboard" as const : "file" as const } : {})
    })));
  }
  if (type === null || type === "card" || type === "board") {
    items.push(...listTaskBin(ownerId, type === "card" || type === "board" ? type : null, BIN_LIST_LIMIT).map((row): BinItem => ({
      type: row.type, id: row.id, title: row.title, folder_id: null, folder_name: null, size_bytes: null,
      deleted_at: row.deleted_at, purge_after: row.purge_after, purging: row.purging, attachment: false, attachment_of: null, attachment_kind: null,
      board_id: row.board_id, board_name: row.board_name, can_purge: row.can_purge,
      ...(row.descendant_count ? { descendant_count: row.descendant_count } : {})
    })));
  }
  if (type === null) items.push(...[...providers.values()].flatMap((provider) => provider.list(ownerId)));
  return items.sort((a, b) => b.deleted_at.localeCompare(a.deleted_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, BIN_LIST_LIMIT);
}

export type BinSoonItem = { type: BinListType; id: string; title: string; purge_after: string };

/**
 * The caller's Bin items that are purged at or before `dueBy`, soonest first, at most `limit`
 * (Today's `binSoon`). Same owner and deleter rules as listBin, but queried by `purge_after`
 * so a Bin with more than BIN_LIST_LIMIT items still shows the ones leaving first. Items
 * already being purged are left out.
 */
export function listBinPurgingSoon(ownerId: string, dueBy: string, limit: number): BinSoonItem[] {
  const core = db.query(`SELECT * FROM (
      SELECT 'note' AS type, id, title, purge_after FROM notes
        WHERE owner_id = $ownerId AND deleted_at IS NOT NULL AND purge_started_at IS NULL AND purge_after <= $dueBy
      UNION ALL
      SELECT 'document' AS type, id, name AS title, purge_after FROM documents
        WHERE owner_id = $ownerId AND deleted_at IS NOT NULL AND purge_started_at IS NULL AND purge_after <= $dueBy
    ) ORDER BY purge_after, id LIMIT $limit`).all({ ownerId, dueBy, limit }) as BinSoonItem[];
  const tasks = listTaskBin(ownerId, null, limit, { dueBy }).map((row): BinSoonItem => ({ type: row.type, id: row.id, title: row.title, purge_after: row.purge_after }));
  // Providers list their own items (bounded by the module); keep the ones due.
  const provided = [...providers.values()].flatMap((provider) => provider.list(ownerId))
    .filter((item) => !item.purging && item.purge_after <= dueBy)
    .map((item): BinSoonItem => ({ type: item.type, id: item.id, title: item.title, purge_after: item.purge_after }));
  return [...core, ...tasks, ...provided]
    .sort((a, b) => a.purge_after.localeCompare(b.purge_after) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit);
}

/**
 * Empty Bin: purges each of the owner's binned items independently, in
 * batches of SWEEP_BATCH_SIZE. Failed byte removals stay tombstoned for the sweeper.
 */
export async function emptyBin(ownerId: string) {
  const counts = { purged: 0, pending: 0 };
  for (const type of ["note", "document"] as const) {
    let after = "";
    for (;;) {
      const batch = db.query(`SELECT id FROM ${tables[type]} WHERE owner_id = ? AND deleted_at IS NOT NULL AND id > ? ORDER BY id LIMIT ?`)
        .all(ownerId, after, SWEEP_BATCH_SIZE) as Array<{ id: string }>;
      if (batch.length === 0) break;
      for (const { id } of batch) {
        const outcome = await withResourceLock(lockKey(type, id), () => purgeLocked(type, id, { reason: "user", actorId: ownerId, ownerId }));
        if (outcome === "purged") counts.purged += 1;
        else if (outcome === "pending") counts.pending += 1;
      }
      after = batch[batch.length - 1]!.id;
    }
  }
  counts.purged += await emptyTaskBin(ownerId);
  for (const provider of providers.values()) {
    const provided = await provider.empty(ownerId);
    counts.purged += provided.purged;
    counts.pending += provided.pending;
  }
  return counts;
}
