import { registerBinProvider, SWEEP_BATCH_SIZE, type BinItem, type BinSweepCounts, type PurgeOutcome, type PurgeReason, type RestoreOutcome } from "../bin";
import { audit, db, now } from "../db";
import { withResourceLock } from "../storage";
import { sourceAccessChangedHook } from "../knowledge/hooks";
import { editableCollectionPredicate, type CollectionVisibility } from "./access";
import { binUnlinkedAttachments, LIMITS } from "./service";

/**
 * Collections and rows in the Bin (WAVES_10-12.md D68), registered with
 * server/bin.ts as providers. Tombstone and CAS restore as for notes and
 * documents; nothing is stored outside SQLite, so a purge is one transaction.
 *
 * - A binned collection is listed for its owner, who alone restores or purges it.
 * - A binned row is listed for the collection owner and for whoever binned it
 *   (D41). Either may restore it while they can still edit the collection; a
 *   row whose collection is itself binned returns PARENT_IN_BIN. Only the owner
 *   purges.
 * - A purge moves attachments no other row links to the uploader's Bin.
 */
const collectionLock = (collectionId: string) => `collection:${collectionId}`;

/** Task and attachment columns every Bin item carries (server/bin.ts BinItem); none apply to collections or rows. */
const providedDefaults = { board_id: null, board_name: null, attachment: false, attachment_of: null, attachment_kind: null } as const;

type BinnedCollection = { id: string; owner_id: string; name: string; visibility: CollectionVisibility; deleted_at: string | null; purge_started_at: string | null };

function purgeCollectionNow(collectionId: string, options: { reason: PurgeReason; actorId: string | null; dueBy?: string }): PurgeOutcome {
  const binned: string[] = [];
  const outcome = db.transaction((): PurgeOutcome => {
    const retention = options.dueBy === undefined ? "" : " AND (purge_started_at IS NOT NULL OR purge_after <= $dueBy)";
    const marked = db.query(`UPDATE collections SET purge_started_at = COALESCE(purge_started_at, $startedAt) WHERE id = $id AND deleted_at IS NOT NULL${retention}`)
      .run({ startedAt: now(), id: collectionId, ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) });
    if (marked.changes === 0) return "not_found";
    const documents = (db.query(`SELECT a.document_id FROM collection_row_attachments a JOIN collection_rows r ON r.id = a.row_id WHERE r.collection_id = ?`)
      .all(collectionId) as Array<{ document_id: string }>).map((row) => row.document_id);
    const rowCount = (db.query("SELECT COUNT(*) AS count FROM collection_rows WHERE collection_id = ?").get(collectionId) as { count: number }).count;
    // Cascades remove rows, members, views, links, and search rows (and, through the trigger, FTS rows).
    db.query("DELETE FROM collections WHERE id = ?").run(collectionId);
    const binnedDocuments = binUnlinkedAttachments(documents, options.actorId, binned);
    audit(options.actorId, null, "collection.purge", { collectionId, reason: options.reason, rowCount, binnedDocuments });
    return "purged";
  })();
  sourceAccessChangedHook({ kind: "document", ids: binned });
  return outcome;
}

function purgeRowNow(rowId: string, options: { reason: PurgeReason; actorId: string | null; dueBy?: string }): PurgeOutcome {
  const binned: string[] = [];
  const outcome = db.transaction((): PurgeOutcome => {
    const retention = options.dueBy === undefined ? "" : " AND (purge_started_at IS NOT NULL OR purge_after <= $dueBy)";
    const row = db.query("SELECT collection_id FROM collection_rows WHERE id = ?").get(rowId) as { collection_id: string } | null;
    if (!row) return "not_found";
    const marked = db.query(`UPDATE collection_rows SET purge_started_at = COALESCE(purge_started_at, $startedAt) WHERE id = $id AND deleted_at IS NOT NULL${retention}`)
      .run({ startedAt: now(), id: rowId, ...(options.dueBy === undefined ? {} : { dueBy: options.dueBy }) });
    if (marked.changes === 0) return "not_found";
    const documents = (db.query("SELECT document_id FROM collection_row_attachments WHERE row_id = ?").all(rowId) as Array<{ document_id: string }>).map((item) => item.document_id);
    db.query("DELETE FROM collection_rows WHERE id = ?").run(rowId);
    const binnedDocuments = binUnlinkedAttachments(documents, options.actorId, binned);
    audit(options.actorId, null, "collection.row_purge", { collectionId: row.collection_id, rowId, reason: options.reason, binnedDocuments });
    return "purged";
  })();
  sourceAccessChangedHook({ kind: "document", ids: binned });
  return outcome;
}

type Sweepable = { id: string; lock: string };
async function sweep(items: Array<Sweepable & { reason: PurgeReason }>, purge: (id: string, options: { reason: PurgeReason; actorId: null; dueBy: string }) => PurgeOutcome, cutoff: string) {
  const counts: BinSweepCounts = { purged: 0, pending: 0 };
  for (const item of items) {
    const outcome = await withResourceLock(item.lock, async () => purge(item.id, { reason: item.reason, actorId: null, dueBy: cutoff }));
    if (outcome === "purged") counts.purged += 1;
  }
  return counts;
}

registerBinProvider("collection", {
  list(userId) {
    const rows = db.query(`SELECT 'collection' AS type, c.id, c.name AS title, NULL AS folder_id, NULL AS folder_name, NULL AS size_bytes,
        c.deleted_at, c.purge_after, c.purge_started_at IS NOT NULL AS purging
      FROM collections c WHERE c.owner_id = ? AND c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC, c.id LIMIT 500`).all(userId) as Array<Pick<BinItem, "type" | "id" | "title" | "folder_id" | "folder_name" | "size_bytes" | "deleted_at" | "purge_after"> & { purging: number }>;
    return rows.map((row): BinItem => ({ ...row, purging: row.purging === 1, ...providedDefaults, can_purge: true }));
  },

  restore(id, userId) {
    return withResourceLock(collectionLock(id), async (): Promise<RestoreOutcome> => {
      const collection = db.query("SELECT id, owner_id, name, visibility, deleted_at, purge_started_at FROM collections WHERE id = ? AND owner_id = ?").get(id, userId) as BinnedCollection | null;
      if (!collection) return { status: "not_found" };
      if (collection.purge_started_at !== null) return { status: "purging" };
      if (collection.deleted_at === null) return { status: "already_restored", folderId: null, folderName: null };
      const live = (db.query("SELECT COUNT(*) AS count FROM collections WHERE owner_id = ? AND deleted_at IS NULL").get(userId) as { count: number }).count;
      if (live >= LIMITS.collectionsPerOwner) return { status: "limit_reached", message: `You can have up to ${LIMITS.collectionsPerOwner} collections` };
      return db.transaction((): RestoreOutcome => {
        const restored = db.query(`UPDATE collections SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ?
          WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL`).run(now(), id, userId);
        if (restored.changes !== 1) return { status: "purging" };
        audit(userId, null, "collection.restore", { collectionId: id });
        return { status: "restored", folderId: null, folderName: null, visibility: collection.visibility };
      })();
    });
  },

  purge(id, userId) {
    return withResourceLock(collectionLock(id), async () => {
      const collection = db.query("SELECT deleted_at FROM collections WHERE id = ? AND owner_id = ?").get(id, userId) as { deleted_at: string | null } | null;
      if (!collection) return "not_found";
      if (collection.deleted_at === null) return "live";
      return purgeCollectionNow(id, { reason: "user", actorId: userId });
    });
  },

  async sweep(cutoff) {
    const resumed = db.query("SELECT id FROM collections WHERE purge_started_at IS NOT NULL LIMIT ?").all(SWEEP_BATCH_SIZE) as Array<{ id: string }>;
    const due = db.query("SELECT id FROM collections WHERE deleted_at IS NOT NULL AND purge_started_at IS NULL AND purge_after <= ? ORDER BY purge_after LIMIT ?")
      .all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string }>;
    return sweep([
      ...resumed.map((row) => ({ id: row.id, lock: collectionLock(row.id), reason: "resumed" as const })),
      ...due.map((row) => ({ id: row.id, lock: collectionLock(row.id), reason: "retention" as const }))
    ], purgeCollectionNow, cutoff);
  },

  async empty(userId) {
    const counts: BinSweepCounts = { purged: 0, pending: 0 };
    const ids = db.query("SELECT id FROM collections WHERE owner_id = ? AND deleted_at IS NOT NULL").all(userId) as Array<{ id: string }>;
    for (const { id } of ids) {
      const outcome = await withResourceLock(collectionLock(id), async () => purgeCollectionNow(id, { reason: "user", actorId: userId }));
      if (outcome === "purged") counts.purged += 1;
    }
    return counts;
  }
});

type BinnedRow = { id: string; collection_id: string; collection_name: string; owner_id: string; visibility: CollectionVisibility; deleted_by: string | null; deleted_at: string | null; purge_started_at: string | null; collection_deleted_at: string | null };
const binnedRowSelect = `SELECT r.id, r.collection_id, c.name AS collection_name, c.owner_id, c.visibility, r.deleted_by, r.deleted_at, r.purge_started_at, c.deleted_at AS collection_deleted_at
  FROM collection_rows r JOIN collections c ON c.id = r.collection_id`;

registerBinProvider("collection_row", {
  list(userId) {
    // The row's title is its primary field (fields[0]); JSON paths come from the stored schema, never from input.
    // A deleter who is not the owner sees the row only while they can still edit the collection (the
    // same rule as restore), so a lost share or a viewer role hides its title and collection name.
    const rows = db.query(`SELECT 'collection_row' AS type, r.id,
        COALESCE(json_extract(r.values_json, '$.' || json_extract(c.schema_json, '$.fields[0].id')), '') AS title,
        c.id AS folder_id, c.name AS folder_name, NULL AS size_bytes,
        r.deleted_at, r.purge_after, r.purge_started_at IS NOT NULL AS purging, c.owner_id = $userId AS can_purge
      FROM collection_rows r JOIN collections c ON c.id = r.collection_id
      WHERE r.deleted_at IS NOT NULL AND c.purge_started_at IS NULL
        AND (c.owner_id = $userId OR (r.deleted_by = $userId AND ${editableCollectionPredicate}))
      ORDER BY r.deleted_at DESC, r.id LIMIT 500`).all({ userId }) as Array<Pick<BinItem, "type" | "id" | "title" | "folder_id" | "folder_name" | "size_bytes" | "deleted_at" | "purge_after"> & { purging: number; can_purge: number }>;
    return rows.map((row): BinItem => ({ ...row, title: String(row.title), purging: row.purging === 1, ...providedDefaults, can_purge: row.can_purge === 1 }));
  },

  async restore(id, userId) {
    const initial = db.query(`${binnedRowSelect} WHERE r.id = ? AND (c.owner_id = ? OR r.deleted_by = ?)`).get(id, userId, userId) as BinnedRow | null;
    if (!initial) return { status: "not_found" };
    return withResourceLock(collectionLock(initial.collection_id), async (): Promise<RestoreOutcome> => {
      const row = db.query(`${binnedRowSelect} WHERE r.id = ? AND (c.owner_id = ? OR r.deleted_by = ?)`).get(id, userId, userId) as BinnedRow | null;
      if (!row) return { status: "not_found" };
      if (row.purge_started_at !== null) return { status: "purging" };
      if (row.deleted_at === null) return { status: "already_restored", folderId: row.collection_id, folderName: row.collection_name };
      if (row.collection_deleted_at !== null) return { status: "parent_in_bin" };
      // Whoever binned it must still be able to edit the collection (a lost share or a viewer role ends that).
      const editable = db.query(`SELECT 1 FROM collections c WHERE c.id = $collectionId AND ${editableCollectionPredicate}`).get({ collectionId: row.collection_id, userId });
      if (!editable) return { status: "not_found" };
      const live = (db.query("SELECT COUNT(*) AS count FROM collection_rows WHERE collection_id = ? AND deleted_at IS NULL").get(row.collection_id) as { count: number }).count;
      if (live >= LIMITS.liveRowsPerCollection) return { status: "limit_reached", message: `A collection can have up to ${LIMITS.liveRowsPerCollection} rows` };
      return db.transaction((): RestoreOutcome => {
        const timestamp = now();
        const restored = db.query(`UPDATE collection_rows SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ?
          WHERE id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL`).run(timestamp, id);
        if (restored.changes !== 1) return { status: "purging" };
        db.query("UPDATE collections SET updated_at = ? WHERE id = ?").run(timestamp, row.collection_id);
        audit(userId, null, "collection.row_restore", { collectionId: row.collection_id, rowId: id });
        return { status: "restored", folderId: row.collection_id, folderName: row.collection_name, visibility: row.visibility };
      })();
    });
  },

  async purge(id, userId) {
    const initial = db.query(`${binnedRowSelect} WHERE r.id = ? AND c.owner_id = ?`).get(id, userId) as BinnedRow | null;
    if (!initial) return "not_found";
    return withResourceLock(collectionLock(initial.collection_id), async () => {
      const row = db.query(`${binnedRowSelect} WHERE r.id = ? AND c.owner_id = ?`).get(id, userId) as BinnedRow | null;
      if (!row) return "not_found";
      if (row.deleted_at === null) return "live";
      return purgeRowNow(id, { reason: "user", actorId: userId });
    });
  },

  async sweep(cutoff) {
    const resumed = db.query("SELECT id, collection_id FROM collection_rows WHERE purge_started_at IS NOT NULL LIMIT ?").all(SWEEP_BATCH_SIZE) as Array<{ id: string; collection_id: string }>;
    const due = db.query("SELECT id, collection_id FROM collection_rows WHERE deleted_at IS NOT NULL AND purge_started_at IS NULL AND purge_after <= ? ORDER BY purge_after LIMIT ?")
      .all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string; collection_id: string }>;
    return sweep([
      ...resumed.map((row) => ({ id: row.id, lock: collectionLock(row.collection_id), reason: "resumed" as const })),
      ...due.map((row) => ({ id: row.id, lock: collectionLock(row.collection_id), reason: "retention" as const }))
    ], purgeRowNow, cutoff);
  },

  async empty(userId) {
    const counts: BinSweepCounts = { purged: 0, pending: 0 };
    const rows = db.query(`SELECT r.id, r.collection_id FROM collection_rows r JOIN collections c ON c.id = r.collection_id
      WHERE c.owner_id = ? AND r.deleted_at IS NOT NULL`).all(userId) as Array<{ id: string; collection_id: string }>;
    for (const row of rows) {
      const outcome = await withResourceLock(collectionLock(row.collection_id), async () => purgeRowNow(row.id, { reason: "user", actorId: userId }));
      if (outcome === "purged") counts.purged += 1;
    }
    return counts;
  }
});
