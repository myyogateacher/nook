import { db, now } from "../db";
import { buildFtsQuery, cleanIndexText, HIT_END, HIT_START, toSegments, type Segment } from "../search";
import { readableCollectionPredicate } from "./access";
import { parseStoredSchema, readValues, type CollectionSchema, type FieldDefinition, type RowValues } from "./schema";
import { logger } from "../log";

const slog = logger("search");

/**
 * Row search (WAVES_10-12.md §3.3, D57, T60). A separate mapping table and
 * FTS5 table (note_search_rows.note_id is a NOT NULL foreign key), the same
 * tokenizer, and the W7 query builder.
 *
 * - Indexed text: the title is the primary field; the body is the other text,
 *   url, number, and date values and the labels of chosen options. Note links
 *   are never indexed (their titles depend on the reader, T59), nor are file names.
 * - Rows are indexed in the transaction that writes them; a schema change
 *   reindexes the collection in its transaction. Binned rows stay indexed so a
 *   restore finds them again; the query filters them out.
 * - Boot reconcile compares source_revision and schema_version.
 */
const deleteMapping = db.query("DELETE FROM collection_row_search WHERE row_id = ?");
const insertMapping = db.query("INSERT INTO collection_row_search (row_id, source_revision, schema_version, indexed_at) VALUES (?, ?, ?, ?)");
const insertFts = db.query("INSERT INTO collection_row_fts (rowid, title, body) VALUES (?, ?, ?)");

function valueText(field: FieldDefinition, value: RowValues[string]): string {
  switch (field.type) {
    case "text":
    case "url":
    case "date":
      return typeof value === "string" ? value : "";
    case "number":
      return typeof value === "number" ? String(value) : "";
    case "select":
      return typeof value === "string" ? field.options?.find((option) => option.id === value)?.label ?? "" : "";
    case "multi_select":
      return Array.isArray(value) ? value.map((id) => field.options?.find((option) => option.id === id)?.label ?? "").filter(Boolean).join(" ") : "";
    default:
      return "";
  }
}

/** The title and body a row is indexed with (pure). */
export function rowSearchText(schema: CollectionSchema, values: RowValues) {
  const [primary, ...rest] = schema.fields;
  const title = primary ? cleanIndexText(valueText(primary, values[primary.id])) : "";
  const body = rest.map((field) => cleanIndexText(valueText(field, values[field.id]))).filter(Boolean).join("\n");
  return { title, body };
}

/** Replaces one row's index entry. Call inside the transaction that wrote the row. */
export function indexRow(rowId: string, schema: CollectionSchema, schemaVersion: number) {
  const row = db.query("SELECT values_json, revision FROM collection_rows WHERE id = ?").get(rowId) as { values_json: string; revision: number } | null;
  deleteMapping.run(rowId);
  if (!row) return;
  const { title, body } = rowSearchText(schema, readValues(schema, JSON.parse(row.values_json)));
  const mapping = Number(insertMapping.run(rowId, row.revision, schemaVersion, now()).lastInsertRowid);
  insertFts.run(mapping, title, body);
}

/** Reindexes every row of a collection (live and binned). Call inside the schema transaction. */
export function reindexCollection(collectionId: string) {
  const collection = db.query("SELECT schema_json, schema_version FROM collections WHERE id = ?").get(collectionId) as { schema_json: string; schema_version: number } | null;
  if (!collection) return 0;
  const schema = parseStoredSchema(collection.schema_json);
  const rows = db.query("SELECT id FROM collection_rows WHERE collection_id = ? AND purge_started_at IS NULL").all(collectionId) as Array<{ id: string }>;
  for (const { id } of rows) indexRow(id, schema, collection.schema_version);
  return rows.length;
}

export type CollectionSearchCounts = { indexed: number; removed: number };

/** Stale rows indexed per batch (and per transaction) at boot. */
export const RECONCILE_BATCH = 500;

/**
 * Boot reconcile: removes FTS rows without a mapping (and mappings without an
 * FTS row), then reindexes rows whose entry is missing or was built from
 * another revision or schema version. Logs counts only.
 */

export function reconcileCollectionSearchIndex(): CollectionSearchCounts {
  const counts: CollectionSearchCounts = { indexed: 0, removed: 0 };
  db.transaction(() => {
    counts.removed += db.query("DELETE FROM collection_row_fts WHERE rowid NOT IN (SELECT id FROM collection_row_search)").run().changes;
    counts.removed += db.query("DELETE FROM collection_row_search WHERE id NOT IN (SELECT rowid FROM collection_row_fts)").run().changes;
  })();
  // Stale rows are read in keyset batches of RECONCILE_BATCH, each indexed in its own
  // transaction, so a large backlog never loads every id at once.
  const staleBatch = db.query(`SELECT r.id, r.collection_id FROM collection_rows r JOIN collections c ON c.id = r.collection_id
    LEFT JOIN collection_row_search s ON s.row_id = r.id
    WHERE r.purge_started_at IS NULL AND c.purge_started_at IS NULL
      AND (s.id IS NULL OR s.source_revision <> r.revision OR s.schema_version <> c.schema_version)
      AND (r.collection_id > $afterCollection OR (r.collection_id = $afterCollection AND r.id > $afterRow))
    ORDER BY r.collection_id, r.id LIMIT $limit`);
  let after = { collection: "", row: "" };
  for (;;) {
    const stale = staleBatch.all({ afterCollection: after.collection, afterRow: after.row, limit: RECONCILE_BATCH }) as Array<{ id: string; collection_id: string }>;
    if (stale.length === 0) break;
    const schemas = new Map<string, { schema: CollectionSchema; version: number }>();
    db.transaction(() => {
      for (const { id, collection_id } of stale) {
        let entry = schemas.get(collection_id);
        if (!entry) {
          const collection = db.query("SELECT schema_json, schema_version FROM collections WHERE id = ?").get(collection_id) as { schema_json: string; schema_version: number };
          entry = { schema: parseStoredSchema(collection.schema_json), version: collection.schema_version };
          schemas.set(collection_id, entry);
        }
        indexRow(id, entry.schema, entry.version);
        counts.indexed += 1;
      }
    })();
    const last = stale[stale.length - 1]!;
    after = { collection: last.collection_id, row: last.id };
    if (stale.length < RECONCILE_BATCH) break;
  }
  if (counts.indexed) db.query("INSERT INTO collection_row_fts (collection_row_fts) VALUES ('optimize')").run();
  if (counts.indexed || counts.removed) slog.info(`Collection search index: ${counts.indexed} indexed, ${counts.removed} removed`);
  return counts;
}

export type RowSearchHit = { rowId: string; collectionId: string; collectionName: string; title: Segment[]; snippet: Segment[]; updated_at: string };

const SNIPPET_TOKENS = 16;
const searchSql = (collectionFilter: string) => `
  SELECT r.id AS rowId, c.id AS collectionId, c.name AS collectionName,
         highlight(collection_row_fts, 0, $hitStart, $hitEnd) AS title_marked,
         snippet(collection_row_fts, 1, $hitStart, $hitEnd, '…', ${SNIPPET_TOKENS}) AS snippet_marked,
         r.updated_at
  FROM collection_row_fts
  JOIN collection_row_search s ON s.id = collection_row_fts.rowid
  JOIN collection_rows r ON r.id = s.row_id AND r.deleted_at IS NULL
  JOIN collections c ON c.id = r.collection_id
  WHERE collection_row_fts MATCH $query AND ${readableCollectionPredicate} ${collectionFilter}
  ORDER BY bm25(collection_row_fts, 8.0, 1.0), r.updated_at DESC
  LIMIT $limit
`;
const queries = { all: db.query(searchSql("")), one: db.query(searchSql("AND c.id = $collectionId")) };

/** Rows the caller can read that match `q`. The ACL is part of the query, before LIMIT (T60). */
export function searchCollectionRows(userId: string, q: string, options: { collection: "all" | string; limit: number }) {
  const query = buildFtsQuery(q);
  if (query === null) return { results: [] as RowSearchHit[], truncated: false };
  const params = { userId, query, hitStart: HIT_START, hitEnd: HIT_END, limit: options.limit + 1 };
  const rows = (options.collection === "all" ? queries.all.all(params) : queries.one.all({ ...params, collectionId: options.collection })) as Array<Omit<RowSearchHit, "title" | "snippet"> & { title_marked: string; snippet_marked: string }>;
  const results = rows.slice(0, options.limit).map(({ title_marked, snippet_marked, ...row }): RowSearchHit => ({
    ...row,
    title: toSegments(title_marked),
    snippet: toSegments(snippet_marked)
  }));
  return { results, truncated: rows.length > options.limit };
}
