import { readableNotePredicate } from "../access";
import { purgeAfterFrom } from "../bin";
import { audit, db, now } from "../db";
import { withResourceLock } from "../storage";
import { planInsert, POSITION_STEP, type Positioned } from "../tasks/boardOrder";
import {
  collectionRole,
  readableCollection,
  readableCollectionPredicate,
  readableRow,
  readableView,
  type CollectionRecord,
  type CollectionRole,
  type CollectionVisibility,
  type RowRecord,
  type ShareRole
} from "./access";
import { compileQuery, decodeCursor, encodeCursor, QUERY_LIMITS, QueryError, specKey, type FilterSpec, type QuerySpec, type SortSpec } from "./query";
import {
  buildSchema,
  parseStoredSchema,
  readValues,
  rowTitle,
  SchemaError,
  validateValues,
  type CollectionSchema,
  type FieldDefinition,
  type FieldInput,
  type RowValues,
  type ValueContext
} from "./schema";
import { indexRow, reindexCollection } from "./search";
import { COLLECTION_TEMPLATES, DEFAULT_FIELDS, templateById } from "./templates";
import { canWriteContent } from "../team/userRole";
import { mailShared, shareMembers } from "../mail/triggers";

/**
 * Collections services (WAVES_10-12.md §3). Routes are thin adapters over
 * these functions so the Stage E MCP tools can reuse them. Every failure is a
 * CollectionError.
 *
 * Authorization (D54): readers (owner, members of a `selected` collection,
 * everyone on an `all_users` one) read; editors (the owner, or every reader
 * when share_role = 'editor') write rows; only the owner edits the schema,
 * views, name, and sharing, and deletes. Non-readers get 404; readers get 403
 * READ_ONLY (row writes) or OWNER_ONLY.
 */
export class CollectionError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 413 | 429, message: string, readonly code?: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
  body() {
    return { error: this.message, ...(this.code ? { code: this.code } : {}), ...this.extra };
  }
}

export const LIMITS = { collectionsPerOwner: 100, liveRowsPerCollection: 10_000, viewsPerCollection: 20, attachmentsPerRow: 20 } as const;

const collectionNotFound = () => new CollectionError(404, "Collection not found");
const rowNotFound = () => new CollectionError(404, "Row not found");
const ownerOnly = () => new CollectionError(403, "Only the collection owner can do this", "OWNER_ONLY");
const readOnly = () => new CollectionError(403, "You can view this collection but not change it", "READ_ONLY");
const limitReached = (message: string) => new CollectionError(409, message, "LIMIT_REACHED");

/** Serializes every change to one collection: rows, positions, schema, sharing, and deletion. */
export const withCollectionLock = <T>(collectionId: string, operation: () => T | Promise<T>) =>
  withResourceLock(`collection:${collectionId}`, async () => operation());

export function requireReadableCollection(collectionId: string, userId: string) {
  const collection = readableCollection(collectionId, userId);
  if (!collection) throw collectionNotFound();
  return collection;
}

export function requireOwnedCollection(collectionId: string, userId: string) {
  const collection = requireReadableCollection(collectionId, userId);
  if (collection.owner_id !== userId) throw ownerOnly();
  return collection;
}

export function requireEditableCollection(collectionId: string, userId: string) {
  const collection = requireReadableCollection(collectionId, userId);
  // Defence in depth for MCP (§5.4): a read-only team role never writes, even as the owner.
  if (collectionRole(collection, userId) === "viewer" || !canWriteContent(userId)) throw readOnly();
  return collection;
}

function requireReadableRow(rowId: string, userId: string) {
  const found = readableRow(rowId, userId);
  if (!found) throw rowNotFound();
  return found;
}

function requireEditableRow(rowId: string, userId: string) {
  const found = requireReadableRow(rowId, userId);
  if (collectionRole(found.collection, userId) === "viewer" || !canWriteContent(userId)) throw readOnly();
  return found;
}

export const schemaOf = (collection: Pick<CollectionRecord, "schema_json">) => parseStoredSchema(collection.schema_json);

// ---------------------------------------------------------------------------
// Collections

export type CollectionSummary = {
  id: string;
  name: string;
  icon: string;
  owner_id: string;
  owner_name: string;
  is_owner: 0 | 1;
  role: CollectionRole;
  visibility: CollectionVisibility;
  share_role: ShareRole;
  row_count: number;
  field_count: number;
  template_id: string | null;
  created_at: string;
  updated_at: string;
};
export type CollectionDetail = CollectionSummary & { fields: FieldDefinition[]; schema_version: number };

const summarySelect = `
  SELECT c.id, c.name, c.icon, c.owner_id, u.display_name AS owner_name,
         CASE WHEN c.owner_id = $userId THEN 1 ELSE 0 END AS is_owner,
         c.visibility, c.share_role, c.schema_json, c.schema_version, c.template_id,
         (SELECT COUNT(*) FROM collection_rows r WHERE r.collection_id = c.id AND r.deleted_at IS NULL) AS row_count,
         c.created_at, c.updated_at
  FROM collections c JOIN users u ON u.id = c.owner_id
`;
type SummaryRow = Omit<CollectionSummary, "role" | "field_count"> & { schema_json: string; schema_version: number };

function toDetail(row: SummaryRow, userId: string): CollectionDetail {
  const { schema_json, ...rest } = row;
  const fields = parseStoredSchema(schema_json).fields;
  return { ...rest, role: collectionRole(row, userId), field_count: fields.length, fields };
}

export function collectionDetail(collectionId: string, userId: string) {
  const row = db.query(`${summarySelect} WHERE c.id = $collectionId AND ${readableCollectionPredicate}`).get({ collectionId, userId }) as SummaryRow | null;
  return row ? toDetail(row, userId) : null;
}

export function listCollections(userId: string): CollectionSummary[] {
  const rows = db.query(`${summarySelect} WHERE ${readableCollectionPredicate} ORDER BY is_owner DESC, c.name COLLATE NOCASE, c.id LIMIT 500`).all({ userId }) as SummaryRow[];
  return rows.map((row) => {
    const { fields: _fields, schema_version: _version, ...summary } = toDetail(row, userId);
    return summary;
  });
}

export function listTemplates() {
  return COLLECTION_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    icon: template.icon,
    description: template.description,
    fields: template.fields.map((field) => ({ name: field.name, type: field.type }))
  }));
}

function schemaFrom(fields: FieldInput[], previous: CollectionSchema | null) {
  try {
    return buildSchema(fields, previous);
  } catch (error) {
    if (error instanceof SchemaError) throw new CollectionError(400, error.message, error.code);
    throw error;
  }
}

export type CollectionCreateInput = { name: string; icon?: string; templateId?: string; fields?: FieldInput[] };

export function createCollection(userId: string, input: CollectionCreateInput) {
  if (input.templateId !== undefined && input.fields !== undefined) throw new CollectionError(400, "Use a template or fields, not both");
  const template = input.templateId === undefined ? null : templateById(input.templateId);
  if (input.templateId !== undefined && !template) throw new CollectionError(400, "Unknown template");
  const schema = schemaFrom(template?.fields ?? input.fields ?? DEFAULT_FIELDS, null);
  const icon = input.icon ?? template?.icon ?? "table";
  return db.transaction(() => {
    const owned = (db.query("SELECT COUNT(*) AS count FROM collections WHERE owner_id = ? AND deleted_at IS NULL").get(userId) as { count: number }).count;
    if (owned >= LIMITS.collectionsPerOwner) throw limitReached(`You can have up to ${LIMITS.collectionsPerOwner} collections`);
    const id = crypto.randomUUID();
    const timestamp = now();
    db.query(`INSERT INTO collections (id, owner_id, name, icon, schema_json, template_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, input.name, icon, JSON.stringify(schema), template?.id ?? null, timestamp, timestamp);
    audit(userId, null, "collection.create", { collectionId: id, fieldCount: schema.fields.length, ...(template ? { templateId: template.id } : {}) });
    return { collection: collectionDetail(id, userId)! };
  })();
}

export function getCollection(userId: string, collectionId: string) {
  const collection = requireReadableCollection(collectionId, userId);
  return { collection: collectionDetail(collectionId, userId)!, role: collectionRole(collection, userId), views: listViews(collectionId) };
}

export function patchCollection(userId: string, collectionId: string, input: { name?: string; icon?: string }) {
  return withCollectionLock(collectionId, () => {
    requireOwnedCollection(collectionId, userId);
    db.transaction(() => {
      db.query("UPDATE collections SET name = COALESCE(?, name), icon = COALESCE(?, icon), updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(input.name ?? null, input.icon ?? null, now(), collectionId);
      audit(userId, null, "collection.update", { collectionId });
    })();
    return { collection: collectionDetail(collectionId, userId)! };
  });
}

/** Moves a collection to the Bin (owner only). Rows, views, and sharing are kept for a restore. */
export function deleteCollection(userId: string, collectionId: string) {
  return withCollectionLock(collectionId, () => {
    requireOwnedCollection(collectionId, userId);
    const deletedAt = new Date();
    const purgeAfter = purgeAfterFrom(deletedAt);
    db.transaction(() => {
      db.query("UPDATE collections SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND deleted_at IS NULL")
        .run(deletedAt.toISOString(), userId, purgeAfter, collectionId);
      audit(userId, null, "collection.delete", { collectionId });
    })();
    return { ok: true as const, purgeAfter };
  });
}

export function getSharing(userId: string, collectionId: string) {
  const collection = requireOwnedCollection(collectionId, userId);
  const users = db.query("SELECT u.id, u.display_name FROM collection_members m JOIN users u ON u.id = m.user_id WHERE m.collection_id = ? ORDER BY u.display_name")
    .all(collectionId) as Array<{ id: string; display_name: string }>;
  return { visibility: collection.visibility, role: collection.share_role, users };
}

/**
 * Replaces the audience and its role (D54), like board sharing: members are
 * kept only for `selected`, the owner is never a recipient, and removing
 * someone revokes access (and attachment access) at once.
 */
export async function putSharing(userId: string, collectionId: string, input: { visibility: CollectionVisibility; userIds: string[]; role: ShareRole }) {
  requireOwnedCollection(collectionId, userId);
  if (input.userIds.includes(userId)) throw new CollectionError(400, "The owner cannot be added as a recipient");
  const uniqueIds = [...new Set(input.userIds)];
  if (input.visibility === "selected" && uniqueIds.length === 0) throw new CollectionError(400, "Select at least one user");
  if (uniqueIds.length) {
    const placeholders = uniqueIds.map(() => "?").join(",");
    const validUsers = db.query(`SELECT id FROM users WHERE disabled_at IS NULL AND id IN (${placeholders})`).all(...uniqueIds);
    if (validUsers.length !== uniqueIds.length) throw new CollectionError(400, "One or more users were not found");
  }
  return withCollectionLock(collectionId, () => {
    requireOwnedCollection(collectionId, userId);
    db.transaction(() => {
      const before = shareMembers("collection_members", "collection_id", collectionId);
      db.query("DELETE FROM collection_members WHERE collection_id = ?").run(collectionId);
      if (input.visibility === "selected") {
        const statement = db.query("INSERT INTO collection_members (collection_id, user_id, created_at) VALUES (?, ?, ?)");
        for (const recipientId of uniqueIds) statement.run(collectionId, recipientId, now());
        // "Shared with you" mail (outbound email #25).
        mailShared(userId, "collection", collectionId, before, uniqueIds);
      }
      db.query("UPDATE collections SET visibility = ?, share_role = ?, updated_at = ? WHERE id = ?").run(input.visibility, input.role, now(), collectionId);
      audit(userId, null, "collection.sharing_changed", {
        collectionId,
        visibility: input.visibility,
        role: input.role,
        recipientCount: input.visibility === "selected" ? uniqueIds.length : 0
      });
    })();
    return { ok: true as const };
  });
}

/**
 * Replaces the schema with a compare-and-swap on schema_version (409
 * SCHEMA_CHANGED carries the current collection). Rows are not rewritten:
 * removed values drop on each row's next write (lenient reads).
 */
export function putSchema(userId: string, collectionId: string, input: { fields: FieldInput[]; schemaVersion: number }) {
  return withCollectionLock(collectionId, () => {
    const collection = requireOwnedCollection(collectionId, userId);
    if (collection.schema_version !== input.schemaVersion) {
      throw new CollectionError(409, "Someone else changed the fields", "SCHEMA_CHANGED", { collection: collectionDetail(collectionId, userId) });
    }
    const schema = schemaFrom(input.fields, schemaOf(collection));
    db.transaction(() => {
      const updated = db.query("UPDATE collections SET schema_json = ?, schema_version = schema_version + 1, updated_at = ? WHERE id = ? AND schema_version = ? AND deleted_at IS NULL")
        .run(JSON.stringify(schema), now(), collectionId, input.schemaVersion);
      if (updated.changes !== 1) throw new Error("Concurrent schema update detected");
      // Option labels and the primary field feed the row index, so the collection is reindexed here.
      reindexCollection(collectionId);
      audit(userId, null, "collection.schema_update", { collectionId, fieldCount: schema.fields.length });
    })();
    return { collection: collectionDetail(collectionId, userId)! };
  });
}
function afterSchemaChange(_collectionId: string) {}

// ---------------------------------------------------------------------------
// Views (the list is filled in by saved views, stage B)

export type ViewSummary = { id: string; collection_id: string; name: string; kind: "table" | "board"; config: unknown; position: number; created_at: string; updated_at: string };

export function listViews(collectionId: string): ViewSummary[] {
  const rows = db.query("SELECT id, collection_id, name, kind, config_json, position, created_at, updated_at FROM collection_views WHERE collection_id = ? ORDER BY position, id")
    .all(collectionId) as Array<Omit<ViewSummary, "config"> & { config_json: string }>;
  return rows.map(({ config_json, ...view }) => ({ ...view, config: JSON.parse(config_json) as unknown }));
}

export type ViewConfig = QuerySpec & { hiddenFieldIds?: string[] };
const VIEW_CONFIG_BYTES = 8192;

/** A view's config must compile strictly against today's schema and fit the 8 KiB CHECK. */
function checkViewConfig(collection: CollectionRecord, config: ViewConfig): ViewConfig {
  const schema = schemaOf(collection);
  const { q: _q, ...stored } = config;
  try {
    compileQuery(schema, stored, "strict");
  } catch (error) {
    if (error instanceof QueryError) throw new CollectionError(400, error.message, "INVALID_QUERY");
    throw error;
  }
  const known = new Set(schema.fields.slice(1).map((field) => field.id));
  if (stored.hiddenFieldIds?.some((id) => !known.has(id))) throw new CollectionError(400, "Hidden fields must be existing fields other than the first", "INVALID_QUERY");
  const canonical: ViewConfig = {
    ...(stored.sort?.length ? { sort: stored.sort } : {}),
    ...(stored.filters?.length ? { filters: stored.filters } : {}),
    ...(stored.hiddenFieldIds?.length ? { hiddenFieldIds: [...new Set(stored.hiddenFieldIds)] } : {})
  };
  if (Buffer.byteLength(JSON.stringify(canonical), "utf8") > VIEW_CONFIG_BYTES) throw new CollectionError(400, "This view is too large");
  return canonical;
}

function viewSummary(viewId: string): ViewSummary | null {
  const row = db.query("SELECT id, collection_id, name, kind, config_json, position, created_at, updated_at FROM collection_views WHERE id = ?")
    .get(viewId) as (Omit<ViewSummary, "config"> & { config_json: string }) | null;
  if (!row) return null;
  const { config_json, ...view } = row;
  return { ...view, config: JSON.parse(config_json) as unknown };
}

const viewNotFound = () => new CollectionError(404, "View not found");

/** A view path id joined to a collection the caller owns: 404 for non-readers, 403 OWNER_ONLY for other readers. */
function requireOwnedView(viewId: string, userId: string) {
  const found = readableView(viewId, userId);
  if (!found) throw viewNotFound();
  if (found.collection.owner_id !== userId) throw ownerOnly();
  return found;
}

export function createView(userId: string, collectionId: string, input: { name: string; config: ViewConfig }) {
  return withCollectionLock(collectionId, () => {
    const collection = requireOwnedCollection(collectionId, userId);
    const config = checkViewConfig(collection, input.config);
    const count = (db.query("SELECT COUNT(*) AS count FROM collection_views WHERE collection_id = ?").get(collectionId) as { count: number }).count;
    if (count >= LIMITS.viewsPerCollection) throw limitReached(`A collection can have up to ${LIMITS.viewsPerCollection} views`);
    const last = db.query("SELECT MAX(position) AS position FROM collection_views WHERE collection_id = ?").get(collectionId) as { position: number | null };
    const id = crypto.randomUUID();
    db.transaction(() => {
      const timestamp = now();
      db.query("INSERT INTO collection_views (id, collection_id, name, kind, config_json, position, created_at, updated_at) VALUES (?, ?, ?, 'table', ?, ?, ?, ?)")
        .run(id, collectionId, input.name, JSON.stringify(config), (last.position ?? 0) + POSITION_STEP, timestamp, timestamp);
      audit(userId, null, "collection.view_create", { collectionId, viewId: id });
    })();
    return { view: viewSummary(id)! };
  });
}

export async function patchView(userId: string, viewId: string, input: { name?: string; config?: ViewConfig }) {
  const { collection: initial } = requireOwnedView(viewId, userId);
  return withCollectionLock(initial.id, () => {
    const { collection } = requireOwnedView(viewId, userId);
    const config = input.config === undefined ? null : checkViewConfig(collection, input.config);
    db.transaction(() => {
      db.query("UPDATE collection_views SET name = COALESCE(?, name), config_json = COALESCE(?, config_json), updated_at = ? WHERE id = ?")
        .run(input.name ?? null, config === null ? null : JSON.stringify(config), now(), viewId);
      audit(userId, null, "collection.view_update", { collectionId: collection.id, viewId });
    })();
    return { view: viewSummary(viewId)! };
  });
}

export async function deleteView(userId: string, viewId: string) {
  const { collection: initial } = requireOwnedView(viewId, userId);
  return withCollectionLock(initial.id, () => {
    const { collection } = requireOwnedView(viewId, userId);
    db.transaction(() => {
      db.query("DELETE FROM collection_views WHERE id = ?").run(viewId);
      audit(userId, null, "collection.view_delete", { collectionId: collection.id, viewId });
    })();
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Rows

export type NoteLink = { id: string; title: string } | { id: string; restricted: true };
export type RowSummary = {
  id: string;
  collection_id: string;
  position: number;
  title: string;
  values: RowValues;
  /** Note fields resolved for this viewer: an unreadable note is `{ id, restricted: true }` (D58, T59). */
  links: Record<string, NoteLink>;
  /** File fields: live documents linked to the row (D58); values are never stored for them. */
  files: Record<string, AttachmentSummary[]>;
  revision: number;
  can_undo: boolean;
  created_by: string | null;
  created_by_name: string | null;
  updated_by_name: string | null;
  updated_via_key_id: string | null;
  /** The MCP key that made the last change, while the key exists ("Changed by <key>", T73). */
  updated_via_key_name: string | null;
  created_at: string;
  updated_at: string;
};

type RowWithNames = RowRecord & { created_by_name: string | null; updated_by_name: string | null; updated_via_key_name: string | null };
const rowSelect = `SELECT r.*, cu.display_name AS created_by_name, uu.display_name AS updated_by_name, mk.name AS updated_via_key_name
  FROM collection_rows r LEFT JOIN users cu ON cu.id = r.created_by LEFT JOIN users uu ON uu.id = r.updated_by
  LEFT JOIN mcp_api_keys mk ON mk.id = r.updated_via_key_id`;

/** Resolves note ids for `viewerId`: readable live notes give their title, everything else is restricted. */
function resolveNotes(noteIds: string[], viewerId: string) {
  const titles = new Map<string, string>();
  const unique = [...new Set(noteIds)];
  for (let start = 0; start < unique.length; start += 200) {
    const batch = unique.slice(start, start + 200);
    const params: Record<string, string> = { userId: viewerId };
    batch.forEach((id, index) => { params[`n${index}`] = id; });
    const rows = db.query(`SELECT n.id, n.title FROM notes n WHERE n.id IN (${batch.map((_, index) => `$n${index}`).join(", ")})
      AND n.deleted_at IS NULL AND ${readableNotePredicate}`).all(params) as Array<{ id: string; title: string }>;
    for (const row of rows) titles.set(row.id, row.title);
  }
  return titles;
}

export type AttachmentSummary = { id: string; name: string; mime_type: string; preview_kind: string; size_bytes: number; linked_by: string | null; created_at: string };

/** Live linked documents per row and file field. Links under removed or retyped fields are not shown. */
function attachmentsFor(schema: CollectionSchema, rowIds: string[]) {
  const fileFields = new Set(schema.fields.filter((field) => field.type === "file").map((field) => field.id));
  const byRow = new Map<string, Record<string, AttachmentSummary[]>>();
  if (!fileFields.size || !rowIds.length) return byRow;
  for (let start = 0; start < rowIds.length; start += 200) {
    const batch = rowIds.slice(start, start + 200);
    const rows = db.query(`SELECT a.row_id, a.field_id, d.id, d.name, d.mime_type, d.preview_kind, d.size_bytes, a.linked_by, a.created_at
      FROM collection_row_attachments a JOIN documents d ON d.id = a.document_id AND d.deleted_at IS NULL
      WHERE a.row_id IN (${batch.map(() => "?").join(", ")}) ORDER BY a.created_at, d.id`).all(...batch) as Array<AttachmentSummary & { row_id: string; field_id: string }>;
    for (const { row_id, field_id, ...attachment } of rows) {
      if (!fileFields.has(field_id)) continue;
      const files = byRow.get(row_id) ?? {};
      (files[field_id] ??= []).push(attachment);
      byRow.set(row_id, files);
    }
  }
  return byRow;
}

export function presentRows(schema: CollectionSchema, rows: RowWithNames[], viewerId: string): RowSummary[] {
  const files = attachmentsFor(schema, rows.map((row) => row.id));
  return presentValues(schema, rows, viewerId).map((row) => ({ ...row, files: files.get(row.id) ?? {} }));
}

function presentValues(schema: CollectionSchema, rows: RowWithNames[], viewerId: string): Omit<RowSummary, "files">[] {
  const noteFields = schema.fields.filter((field) => field.type === "note");
  const projected = rows.map((row) => ({ row, values: readValues(schema, JSON.parse(row.values_json)) }));
  const noteIds = noteFields.length ? projected.flatMap(({ values }) => noteFields.map((field) => values[field.id]).filter((id): id is string => typeof id === "string")) : [];
  const titles = noteIds.length ? resolveNotes(noteIds, viewerId) : new Map<string, string>();
  return projected.map(({ row, values }) => {
    const links: Record<string, NoteLink> = {};
    for (const field of noteFields) {
      const id = values[field.id];
      if (typeof id !== "string") continue;
      const title = titles.get(id);
      links[field.id] = title === undefined ? { id, restricted: true } : { id, title };
    }
    return {
      id: row.id,
      collection_id: row.collection_id,
      position: row.position,
      title: rowTitle(schema, values),
      values,
      links,
      revision: row.revision,
      can_undo: row.prev_values_json !== null,
      created_by: row.created_by,
      created_by_name: row.created_by_name,
      updated_by_name: row.updated_by_name,
      updated_via_key_id: row.updated_via_key_id,
      updated_via_key_name: row.updated_via_key_id === null ? null : row.updated_via_key_name ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  });
}

function rowDetail(rowId: string, schema: CollectionSchema, viewerId: string) {
  const row = db.query(`${rowSelect} WHERE r.id = ? AND r.deleted_at IS NULL`).get(rowId) as RowWithNames | null;
  return row ? presentRows(schema, [row], viewerId)[0]! : null;
}

/** Note values may only link notes the writer can read now (D58). */
export const valueContext = (userId: string): ValueContext => ({
  canLinkNote: (id) => Boolean(db.query(`SELECT 1 FROM notes n WHERE n.id = $noteId AND n.deleted_at IS NULL AND ${readableNotePredicate}`).get({ noteId: id, userId }))
});

function invalidValues(fieldErrors: Record<string, string>) {
  return new CollectionError(400, "Some values are not valid", "INVALID_VALUES", { fieldErrors });
}

const liveRowCount = (collectionId: string) =>
  (db.query("SELECT COUNT(*) AS count FROM collection_rows WHERE collection_id = ? AND deleted_at IS NULL").get(collectionId) as { count: number }).count;

const livePositions = (collectionId: string) =>
  db.query("SELECT id, position FROM collection_rows WHERE collection_id = ? AND deleted_at IS NULL ORDER BY position, id").all(collectionId) as Positioned[];

/** Where a new row goes: bottom (undefined), top (null), or after a live row of this collection. */
function planRowPosition(collectionId: string, afterRowId: string | null | undefined) {
  if (afterRowId === undefined) {
    const last = db.query("SELECT MAX(position) AS position FROM collection_rows WHERE collection_id = ? AND deleted_at IS NULL").get(collectionId) as { position: number | null };
    const position = (last.position ?? 0) + POSITION_STEP;
    if (Number.isFinite(position) && position < Number.MAX_SAFE_INTEGER / 2) return { position, renumbered: null };
  }
  const plan = planInsert(livePositions(collectionId), afterRowId);
  if (!plan) throw new CollectionError(404, "Row not found");
  return plan;
}

function applyRenumber(renumbered: Positioned[] | null) {
  if (!renumbered) return;
  const statement = db.query("UPDATE collection_rows SET position = ? WHERE id = ?");
  for (const item of renumbered) statement.run(item.position, item.id);
}

/** Row writes run these in their transaction: the row index is written with the row (D57). */
export const rowHooks = {
  afterWrite: (rowId: string, collection: CollectionRecord) => indexRow(rowId, schemaOf(collection), collection.schema_version)
};

export type RowCreateInput = { values: unknown; afterRowId?: string | null };
/** `keyId` marks a write as made through that MCP key (Stage E, T73). */
export type RowWriteOptions = { keyId?: string | null };

export function createRow(userId: string, collectionId: string, input: RowCreateInput, options: RowWriteOptions = {}) {
  return withCollectionLock(collectionId, () => {
    const collection = requireEditableCollection(collectionId, userId);
    const schema = schemaOf(collection);
    const result = validateValues(schema, input.values, {}, valueContext(userId), "create");
    if (!result.ok) throw invalidValues(result.fieldErrors);
    if (liveRowCount(collectionId) >= LIMITS.liveRowsPerCollection) throw limitReached(`A collection can have up to ${LIMITS.liveRowsPerCollection} rows`);
    const plan = planRowPosition(collectionId, input.afterRowId);
    const id = crypto.randomUUID();
    db.transaction(() => {
      applyRenumber(plan.renumbered);
      const timestamp = now();
      db.query(`INSERT INTO collection_rows (id, collection_id, position, values_json, updated_via_key_id, created_by, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, collectionId, plan.position, JSON.stringify(result.values), options.keyId ?? null, userId, userId, timestamp, timestamp);
      db.query("UPDATE collections SET updated_at = ? WHERE id = ?").run(timestamp, collectionId);
      rowHooks.afterWrite(id, collection);
      audit(userId, null, "collection.row_create", { collectionId, rowId: id });
    })();
    return { row: rowDetail(id, schema, userId)! };
  });
}

export function getRow(userId: string, rowId: string) {
  const { collection } = requireReadableRow(rowId, userId);
  const schema = schemaOf(collection);
  return { row: rowDetail(rowId, schema, userId)!, role: collectionRole(collection, userId), schemaVersion: collection.schema_version };
}

function rowChanged(rowId: string, schema: CollectionSchema, userId: string) {
  return new CollectionError(409, "Someone else changed this row", "ROW_CHANGED", { row: rowDetail(rowId, schema, userId) });
}

/**
 * Merges `values` into the row with a compare-and-swap on `revision` (409
 * ROW_CHANGED carries the current row). The previous values are kept for a
 * one-step undo (D61). Values of removed fields are dropped here.
 */
export async function patchRow(userId: string, rowId: string, input: { values: unknown; revision: number }, options: RowWriteOptions = {}) {
  const { collection: initial } = requireEditableRow(rowId, userId);
  return withCollectionLock(initial.id, () => {
    const { row, collection } = requireEditableRow(rowId, userId);
    const schema = schemaOf(collection);
    if (row.revision !== input.revision) throw rowChanged(rowId, schema, userId);
    const base = readValues(schema, JSON.parse(row.values_json));
    const result = validateValues(schema, input.values, base, valueContext(userId), "update");
    if (!result.ok) throw invalidValues(result.fieldErrors);
    db.transaction(() => {
      const timestamp = now();
      const updated = db.query(`UPDATE collection_rows SET values_json = ?, prev_values_json = values_json, prev_revision = revision, revision = revision + 1,
          updated_by = ?, updated_via_key_id = ?, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL`)
        .run(JSON.stringify(result.values), userId, options.keyId ?? null, timestamp, rowId, input.revision);
      if (updated.changes !== 1) throw new Error("Concurrent row update detected");
      db.query("UPDATE collections SET updated_at = ? WHERE id = ?").run(timestamp, collection.id);
      rowHooks.afterWrite(rowId, collection);
      audit(userId, null, "collection.row_update", { collectionId: collection.id, rowId, fieldCount: Object.keys(input.values as object).length });
    })();
    return { row: rowDetail(rowId, schema, userId)! };
  });
}

/**
 * An undo writes values, so it is held to the write rules the schema has now:
 * a field made required since must not come back empty, and a note link that
 * differs from the current value must be one the caller can read (D58).
 */
function undoValueErrors(schema: CollectionSchema, restored: RowValues, current: RowValues, userId: string) {
  const context = valueContext(userId);
  const fieldErrors: Record<string, string> = {};
  for (const field of schema.fields) {
    const value = restored[field.id];
    if (field.required && value === undefined) fieldErrors[field.id] = "This field is required";
    else if (field.type === "note" && typeof value === "string" && value !== current[field.id] && !context.canLinkNote(value)) fieldErrors[field.id] = "You can't link this note";
  }
  return Object.keys(fieldErrors).length ? fieldErrors : null;
}

/**
 * Restores the previous values (one step, D61). `revision` must be the current
 * one. The restored values are projected onto the current schema, so fields
 * removed since are not brought back.
 */
export async function undoRow(userId: string, rowId: string, input: { revision: number }) {
  const { collection: initial } = requireEditableRow(rowId, userId);
  return withCollectionLock(initial.id, () => {
    const { row, collection } = requireEditableRow(rowId, userId);
    const schema = schemaOf(collection);
    if (row.revision !== input.revision) throw rowChanged(rowId, schema, userId);
    if (row.prev_values_json === null) throw new CollectionError(409, "There is nothing to undo", "NOTHING_TO_UNDO");
    const previous = JSON.parse(row.prev_values_json) as unknown;
    const restored = readValues(schema, previous);
    const links = storedLinks(previous);
    const undoErrors = undoValueErrors(schema, restored, readValues(schema, JSON.parse(row.values_json)), userId);
    if (undoErrors) throw invalidValues(undoErrors);
    if (links) assertUndoLinksAllowed(rowId, links, collection, userId);
    db.transaction(() => {
      const timestamp = now();
      const updated = db.query(`UPDATE collection_rows SET values_json = ?, prev_values_json = NULL, prev_revision = NULL, revision = revision + 1,
          updated_by = ?, updated_via_key_id = NULL, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL`)
        .run(JSON.stringify(restored), userId, timestamp, rowId, input.revision);
      if (updated.changes !== 1) throw new Error("Concurrent row update detected");
      const linkChanges = links ? restoreLinks(rowId, links, userId) : null;
      db.query("UPDATE collections SET updated_at = ? WHERE id = ?").run(timestamp, collection.id);
      rowHooks.afterWrite(rowId, collection);
      audit(userId, null, "collection.row_undo", { collectionId: collection.id, rowId, ...(linkChanges ? { links: linkChanges } : {}) });
    })();
    return { row: rowDetail(rowId, schema, userId)! };
  });
}

/** Moves a row to the Bin (any editor). It keeps its position for a restore. */
export async function deleteRow(userId: string, rowId: string) {
  const { collection: initial } = requireEditableRow(rowId, userId);
  return withCollectionLock(initial.id, () => {
    const { collection } = requireEditableRow(rowId, userId);
    const deletedAt = new Date();
    const purgeAfter = purgeAfterFrom(deletedAt);
    db.transaction(() => {
      db.query("UPDATE collection_rows SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND deleted_at IS NULL")
        .run(deletedAt.toISOString(), userId, purgeAfter, rowId);
      db.query("UPDATE collections SET updated_at = ? WHERE id = ?").run(deletedAt.toISOString(), collection.id);
      audit(userId, null, "collection.row_delete", { collectionId: collection.id, rowId });
    })();
    return { ok: true as const, purgeAfter };
  });
}

// ---------------------------------------------------------------------------
// Query

export type QueryInput = QuerySpec & { viewId?: string; cursor?: string; limit?: number };

/** The spec a query runs with: the request's sort/filters/q, falling back to the saved view's. */
function effectiveSpec(collectionId: string, input: QueryInput) {
  if (!input.viewId) return { spec: { sort: input.sort, filters: input.filters, q: input.q } as QuerySpec, viewSpec: null as QuerySpec | null };
  const view = db.query("SELECT config_json FROM collection_views WHERE id = ? AND collection_id = ?").get(input.viewId, collectionId) as { config_json: string } | null;
  if (!view) throw new CollectionError(404, "View not found");
  const config = JSON.parse(view.config_json) as QuerySpec;
  return { spec: { sort: input.sort ?? config.sort, filters: input.filters ?? config.filters, q: input.q } as QuerySpec, viewSpec: config };
}

function compile(schema: CollectionSchema, spec: QuerySpec, viewSpec: QuerySpec | null) {
  try {
    // Clauses from a saved view may name fields removed (or changed) since; those are dropped. The
    // client sends the view's clauses back as copies alongside its own (for example a new sort), so
    // a clause counts as the view's when it equals one of them; anything else is checked strictly.
    if (viewSpec === null) return compileQuery(schema, spec, "strict");
    const sortKey = (sort: SortSpec) => JSON.stringify([sort.fieldId, sort.direction ?? "asc"]);
    const filterKey = (filter: FilterSpec) => JSON.stringify([filter.fieldId, filter.op, filter.value ?? null]);
    const viewSorts = new Set((viewSpec.sort ?? []).map(sortKey));
    const viewFilters = new Set((viewSpec.filters ?? []).map(filterKey));
    return compileQuery(schema, spec, (clause) => "sort" in clause ? viewSorts.has(sortKey(clause.sort)) : viewFilters.has(filterKey(clause.filter)));
  } catch (error) {
    if (error instanceof QueryError) throw new CollectionError(400, error.message, "INVALID_QUERY");
    throw error;
  }
}

/** Row ids matching a spec, in order, for exports (bounded by the row cap). */
export function matchingRows(collection: CollectionRecord, input: QueryInput) {
  const schema = schemaOf(collection);
  const { spec, viewSpec } = effectiveSpec(collection.id, input);
  const compiled = compile(schema, spec, viewSpec);
  const rows = db.query(`${rowSelect} WHERE r.collection_id = ? AND r.deleted_at IS NULL AND ${compiled.where} ORDER BY ${compiled.orderBy} LIMIT ?`)
    .all(collection.id, ...compiled.whereParams, ...compiled.orderParams, LIMITS.liveRowsPerCollection) as RowWithNames[];
  return { schema, rows };
}

export function queryRows(userId: string, collectionId: string, input: QueryInput) {
  const collection = requireReadableCollection(collectionId, userId);
  const schema = schemaOf(collection);
  const { spec, viewSpec } = effectiveSpec(collectionId, input);
  const key = specKey({ ...spec, viewId: input.viewId ?? null });
  let offset = 0;
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    if (!cursor || cursor.key !== key) throw new CollectionError(400, "Invalid cursor", "INVALID_CURSOR");
    if (cursor.schemaVersion !== collection.schema_version) {
      throw new CollectionError(409, "The fields changed. Reload to continue.", "SCHEMA_CHANGED", { schemaVersion: collection.schema_version });
    }
    offset = cursor.offset;
  }
  const limit = input.limit ?? QUERY_LIMITS.defaultPageSize;
  const compiled = compile(schema, spec, viewSpec);
  const base = `FROM collection_rows r WHERE r.collection_id = ? AND r.deleted_at IS NULL AND ${compiled.where}`;
  const rows = db.query(`${rowSelect} WHERE r.collection_id = ? AND r.deleted_at IS NULL AND ${compiled.where}
    ORDER BY ${compiled.orderBy} LIMIT ? OFFSET ?`).all(collectionId, ...compiled.whereParams, ...compiled.orderParams, limit + 1, offset) as RowWithNames[];
  const total = (db.query(`SELECT COUNT(*) AS count ${base}`).get(collectionId, ...compiled.whereParams) as { count: number }).count;
  const page = rows.slice(0, limit);
  const nextOffset = offset + page.length;
  return {
    rows: presentRows(schema, page, userId),
    nextCursor: rows.length > limit && nextOffset <= 10_000 ? encodeCursor({ schemaVersion: collection.schema_version, offset: nextOffset, key }) : null,
    schemaVersion: collection.schema_version,
    total
  };
}

// ---------------------------------------------------------------------------
// Attachments (D58). A linked document is a `collection_attachment` upload or
// a Files item the linker owns. It is readable through a live row of a
// readable collection (documentAccess.ts); it never appears in Files lists.

/**
 * Moves `collection_attachment` documents that no row links any more to the
 * Bin (owner = uploader, deleted_by = actor), so they clear in 30 days instead
 * of holding quota with no UI. Files items are left alone. Call inside the
 * transaction that removed the links.
 */
export function binUnlinkedAttachments(documentIds: string[], actorId: string | null) {
  const deletedAt = new Date();
  const purgeAfter = purgeAfterFrom(deletedAt);
  let moved = 0;
  for (const documentId of new Set(documentIds)) {
    const result = db.query(`UPDATE documents SET deleted_at = ?, deleted_by = ?, purge_after = ?
      WHERE id = ? AND purpose = 'collection_attachment' AND deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM collection_row_attachments a WHERE a.document_id = documents.id)`)
      .run(deletedAt.toISOString(), actorId, purgeAfter, documentId);
    if (result.changes) {
      moved += 1;
      audit(actorId, null, "document.delete", { documentId, reason: "attachment_unlinked" });
    }
  }
  return moved;
}

/**
 * Links are kept outside values_json, so a link change stores the row's links from before it
 * under this key of prev_values_json (field ids are `f_…`, so it never collides with a value;
 * readValues ignores it). Undo then puts those links back (D61).
 */
const PREV_LINKS_KEY = "$attachments";
const PREV_VALUES_MAX_BYTES = 16384;
type LinkSnapshot = [documentId: string, fieldId: string, linkedBy: string | null, createdAt: string];

function rowLinks(rowId: string): LinkSnapshot[] {
  return (db.query("SELECT document_id, field_id, linked_by, created_at FROM collection_row_attachments WHERE row_id = ? ORDER BY created_at, document_id").all(rowId) as Array<{ document_id: string; field_id: string; linked_by: string | null; created_at: string }>)
    .map((link) => [link.document_id, link.field_id, link.linked_by, link.created_at]);
}

/** A link change is a row write: it bumps the revision and records the links before it for Undo. Call inside its transaction. */
function recordLinkChange(rowId: string, collection: CollectionRecord, userId: string, before: LinkSnapshot[], timestamp: string) {
  const current = db.query("SELECT values_json FROM collection_rows WHERE id = ?").get(rowId) as { values_json: string };
  const previous = JSON.stringify({ ...JSON.parse(current.values_json), [PREV_LINKS_KEY]: before });
  // A row near the size limit loses its undo step rather than failing the link change.
  const prevValues = Buffer.byteLength(previous) <= PREV_VALUES_MAX_BYTES ? previous : null;
  db.query(`UPDATE collection_rows SET prev_values_json = ?, prev_revision = revision, revision = revision + 1,
      updated_by = ?, updated_via_key_id = NULL, updated_at = ? WHERE id = ?`).run(prevValues, userId, timestamp, rowId);
  db.query("UPDATE collections SET updated_at = ? WHERE id = ?").run(timestamp, collection.id);
  rowHooks.afterWrite(rowId, collection);
}

function storedLinks(prevValues: unknown): LinkSnapshot[] | null {
  if (!prevValues || typeof prevValues !== "object" || Array.isArray(prevValues)) return null;
  const links = (prevValues as Record<string, unknown>)[PREV_LINKS_KEY];
  if (!Array.isArray(links)) return null;
  return links.filter((link): link is LinkSnapshot => Array.isArray(link) && link.length === 4 && typeof link[0] === "string" && typeof link[1] === "string"
    && (link[2] === null || typeof link[2] === "string") && typeof link[3] === "string").slice(0, LIMITS.attachmentsPerRow);
}

/**
 * An undo that changes links is held to the attach and unlink rules (D58): every link it would
 * add back must be to a document the undoer owns (a live one, or a collection upload in the Bin
 * that the unlink moved there), and every link it would remove must be one the undoer created,
 * unless the undoer owns the collection. Documents restoreLinks would skip (purged, or a binned
 * Files item) are ignored. Any other link refuses the whole undo with 403 `NOT_LINKER`.
 */
function assertUndoLinksAllowed(rowId: string, target: LinkSnapshot[], collection: CollectionRecord, userId: string) {
  const current = rowLinks(rowId);
  const wanted = new Set(target.map((link) => link[0]));
  const present = new Set(current.map((link) => link[0]));
  const refused: string[] = [];
  if (collection.owner_id !== userId) {
    for (const [documentId, , linkedBy] of current) if (!wanted.has(documentId) && linkedBy !== userId) refused.push(documentId);
  }
  for (const [documentId] of target) {
    if (present.has(documentId)) continue;
    const document = db.query("SELECT owner_id, purpose, deleted_at, purge_started_at FROM documents WHERE id = ?").get(documentId) as { owner_id: string; purpose: string; deleted_at: string | null; purge_started_at: string | null } | null;
    if (!document || document.purge_started_at !== null || (document.deleted_at !== null && document.purpose !== "collection_attachment")) continue;
    if (document.owner_id !== userId) refused.push(documentId);
  }
  if (refused.length) {
    throw new CollectionError(403, "Only the person who attached these files or the collection owner can undo this change", "NOT_LINKER", { documentIds: refused });
  }
}

/**
 * Puts a row's links back to `target` (an Undo of attach or unlink). A collection upload the unlink
 * moved to the Bin comes back with its link; documents purged since, or Files items binned since, are
 * skipped. Uploads no row links any more go to the Bin, as after an unlink. The caller checks
 * assertUndoLinksAllowed first, so every link put back is the undoer's own. Call inside a transaction.
 */
function restoreLinks(rowId: string, target: LinkSnapshot[], userId: string) {
  const current = rowLinks(rowId);
  const wanted = new Set(target.map((link) => link[0]));
  const present = new Set(current.map((link) => link[0]));
  const unlinked = current.filter((link) => !wanted.has(link[0])).map((link) => link[0]);
  for (const documentId of unlinked) db.query("DELETE FROM collection_row_attachments WHERE row_id = ? AND document_id = ?").run(rowId, documentId);
  let relinked = 0;
  for (const [documentId, fieldId, , createdAt] of target) {
    if (present.has(documentId)) continue;
    const document = db.query("SELECT purpose, deleted_at, purge_started_at FROM documents WHERE id = ?").get(documentId) as { purpose: string; deleted_at: string | null; purge_started_at: string | null } | null;
    if (!document || document.purge_started_at !== null) continue;
    if (document.deleted_at !== null) {
      if (document.purpose !== "collection_attachment") continue;
      const restored = db.query("UPDATE documents SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL WHERE id = ? AND deleted_at IS NOT NULL AND purge_started_at IS NULL").run(documentId);
      if (restored.changes !== 1) continue;
      audit(userId, null, "document.restore", { documentId, reason: "attachment_undo" });
    }
    db.query("INSERT INTO collection_row_attachments (row_id, document_id, field_id, linked_by, created_at) VALUES (?, ?, ?, ?, ?)").run(rowId, documentId, fieldId, userId, createdAt);
    relinked += 1;
  }
  const binned = binUnlinkedAttachments(unlinked, userId);
  return { unlinked: unlinked.length, relinked, binned };
}

export async function attachDocument(userId: string, rowId: string, input: { documentId: string; fieldId: string }) {
  const { collection: initial } = requireEditableRow(rowId, userId);
  return withCollectionLock(initial.id, () => {
    const { collection } = requireEditableRow(rowId, userId);
    const schema = schemaOf(collection);
    const field = schema.fields.find((item) => item.id === input.fieldId);
    if (!field || field.type !== "file") throw new CollectionError(400, "Attach files to a file field", "INVALID_VALUES", { fieldErrors: { [input.fieldId.slice(0, 16)]: "Not a file field" } });
    // Only the linker's own live documents (a Files item or a collection upload) can be linked.
    const document = db.query("SELECT id, purpose FROM documents WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").get(input.documentId, userId) as { id: string; purpose: string } | null;
    if (!document || (document.purpose !== "file" && document.purpose !== "collection_attachment")) throw new CollectionError(404, "File not found");
    if (db.query("SELECT 1 FROM collection_row_attachments WHERE row_id = ? AND document_id = ?").get(rowId, input.documentId)) {
      throw new CollectionError(409, "This file is already attached to the row", "ALREADY_ATTACHED");
    }
    const count = (db.query("SELECT COUNT(*) AS count FROM collection_row_attachments WHERE row_id = ?").get(rowId) as { count: number }).count;
    if (count >= LIMITS.attachmentsPerRow) throw limitReached(`A row can have up to ${LIMITS.attachmentsPerRow} attachments`);
    db.transaction(() => {
      const timestamp = now();
      const before = rowLinks(rowId);
      db.query("INSERT INTO collection_row_attachments (row_id, document_id, field_id, linked_by, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(rowId, input.documentId, input.fieldId, userId, timestamp);
      recordLinkChange(rowId, collection, userId, before, timestamp);
      audit(userId, null, "collection.row_attach", { collectionId: collection.id, rowId, documentId: input.documentId });
    })();
    return { row: rowDetail(rowId, schema, userId)! };
  });
}

/** Unlinks a document (an editor who linked it, or the collection owner). The last unlink bins a collection upload. */
export async function detachDocument(userId: string, rowId: string, documentId: string) {
  const { collection: initial } = requireEditableRow(rowId, userId);
  return withCollectionLock(initial.id, () => {
    const { collection } = requireEditableRow(rowId, userId);
    const link = db.query("SELECT linked_by FROM collection_row_attachments WHERE row_id = ? AND document_id = ?").get(rowId, documentId) as { linked_by: string | null } | null;
    if (!link) throw new CollectionError(404, "Attachment not found");
    if (link.linked_by !== userId && collection.owner_id !== userId) throw new CollectionError(403, "Only the person who attached this file or the collection owner can remove it", "NOT_LINKER");
    let binned = 0;
    db.transaction(() => {
      const before = rowLinks(rowId);
      db.query("DELETE FROM collection_row_attachments WHERE row_id = ? AND document_id = ?").run(rowId, documentId);
      binned = binUnlinkedAttachments([documentId], userId);
      recordLinkChange(rowId, collection, userId, before, now());
      audit(userId, null, "collection.row_detach", { collectionId: collection.id, rowId, documentId });
    })();
    return { row: rowDetail(rowId, schemaOf(collection), userId)!, documentBinned: binned > 0 };
  });
}

// ---------------------------------------------------------------------------
// Today

export type RecentRow = { rowId: string; collectionId: string; collectionName: string; title: string; updated_at: string; changedByKey: boolean };

/**
 * Recently edited live rows in collections the caller can read, newest first, for Today's
 * `collectionsRecent` section (D51, T51). Every row write also touches its collection's
 * `updated_at`, so the newest `limit` rows lie in the `limit` most recently updated collections;
 * only those are scanned. Titles only, never other values.
 */
export function listRecentRows(userId: string, limit: number): RecentRow[] {
  const collections = db.query(`SELECT c.id, c.name, c.schema_json FROM collections c WHERE ${readableCollectionPredicate}
      ORDER BY c.updated_at DESC, c.id LIMIT $limit`).all({ userId, limit }) as Array<{ id: string; name: string; schema_json: string }>;
  if (!collections.length) return [];
  const byId = new Map(collections.map((collection) => [collection.id, { name: collection.name, schema: parseStoredSchema(collection.schema_json) }]));
  const rows = db.query(`SELECT r.id, r.collection_id, r.values_json, r.updated_at, r.updated_via_key_id FROM collection_rows r
      WHERE r.deleted_at IS NULL AND r.collection_id IN (SELECT value FROM json_each($ids))
      ORDER BY r.updated_at DESC, r.id LIMIT $limit`)
    .all({ ids: JSON.stringify(collections.map((collection) => collection.id)), limit }) as Array<{ id: string; collection_id: string; values_json: string; updated_at: string; updated_via_key_id: string | null }>;
  return rows.map((row) => {
    const collection = byId.get(row.collection_id)!;
    return {
      rowId: row.id,
      collectionId: row.collection_id,
      collectionName: collection.name,
      title: rowTitle(collection.schema, readValues(collection.schema, JSON.parse(row.values_json))),
      updated_at: row.updated_at,
      changedByKey: row.updated_via_key_id !== null
    };
  });
}
