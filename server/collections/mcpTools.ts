import * as z from "zod/v4";
import { config } from "../config";
import { keyFilter } from "../keyResources";
import { withAuditContext } from "../db";
import { restoreItem } from "../bin";
import { BIN_BUCKETS, BIN_DESCRIPTION, defineTool, issueDetails, McpToolError, restoreResult, type McpErrorCode, type McpKeyContext, type McpToolSpec } from "../mcpToolKit";
import { keyMayRead } from "../keyReach";
import { collectionCreateSchema } from "./routes";
import { COLLECTION_TEMPLATES } from "./templates";
import { filterSpec, QUERY_LIMITS, type FilterSpec, type SortSpec } from "./query";
import type { CollectionSchema, FieldDefinition, FieldValue } from "./schema";
import { CollectionError, collectionDetail, createCollection, createRow, deleteRow, getRow, listCollections, patchRow, queryRows, requireReadableCollection, schemaOf, type RowSummary } from "./service";

/**
 * MCP tools for Collections (docs/plan/WAVES_10-12.md §3.5, D70, T72–T75).
 *
 * Tools call the same services as /api/collections as the key's owner, so the readable and
 * editable checks, IDOR joins, strict value validation, the query builder (enumerated operators,
 * bound JSON paths), and the row caps are enforced in one place. A collection or row the user
 * cannot read is NOT_FOUND whether it is missing, private, or binned.
 *
 * Agents work with field NAMES: rows come back keyed by name, select values as option labels,
 * note links as titles (or `restricted`), and file fields as attachment names only. Inputs accept
 * a field's name or id, and an option's label or id. Writes are create and merge-update, with
 * a revision compare-and-swap (ROW_CHANGED), plus (Wave 19) create_collection (private, from a
 * template or bounded fields) and bin_row/restore_row with bin:write; there are no delete-forever,
 * schema-change, share, view, attachment, or import tools. Every write is audited with `{via: "mcp", keyId}`, sets `updated_via_key_id`
 * (the row panel's "Changed by <key> · Undo"), and counts against the `row_write` daily buckets.
 */

export const MCP_ROW_PAGE = 50;

const collectionUrl = (collectionId: string, rowId: string) => `${config.appOrigin}/collections/${collectionId}/row/${rowId}`;

function errorToMcp(error: CollectionError, schema?: CollectionSchema) {
  const known: Partial<Record<string, McpErrorCode>> = {
    ROW_CHANGED: "ROW_CHANGED",
    READ_ONLY: "READ_ONLY",
    OWNER_ONLY: "OWNER_ONLY",
    // Wave 32: structure is the owner's or a manager's (D273); MCP keeps its one code for both.
    MANAGER_REQUIRED: "OWNER_ONLY",
    LIMIT_REACHED: "LIMIT_REACHED",
    SCHEMA_CHANGED: "SCHEMA_CHANGED",
    INVALID_VALUES: "INVALID",
    INVALID_QUERY: "INVALID",
    INVALID_CURSOR: "INVALID"
  };
  const code = (error.code ? known[error.code] : undefined) ?? (error.status === 404 ? "NOT_FOUND" : error.status === 400 ? "INVALID" : "INTERNAL");
  const details: Record<string, unknown> = {};
  if (error.code === "ROW_CHANGED") {
    const row = error.extra.row as RowSummary | null | undefined;
    if (row) details.currentRevision = row.revision;
  }
  if (error.code === "INVALID_VALUES" && error.extra.fieldErrors && typeof error.extra.fieldErrors === "object") {
    const names = new Map(schema?.fields.map((field) => [field.id, field.name]) ?? []);
    details.fieldErrors = Object.fromEntries(Object.entries(error.extra.fieldErrors as Record<string, string>).map(([id, message]) => [names.get(id) ?? id, message]));
  }
  return new McpToolError(code, error.message, Object.keys(details).length ? details : undefined);
}

async function service<T>(key: McpKeyContext, operation: () => T | Promise<T>, schema?: () => CollectionSchema | undefined): Promise<T> {
  try {
    return await withAuditContext({ via: "mcp", keyId: key.keyId }, operation);
  } catch (error) {
    if (error instanceof CollectionError) throw errorToMcp(error, schema?.());
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Names ⇄ ids

/** A field by exact name first, then by id. */
function findField(schema: CollectionSchema, reference: string) {
  return schema.fields.find((field) => field.name === reference) ?? schema.fields.find((field) => field.id === reference) ?? null;
}

function requireField(schema: CollectionSchema, reference: string) {
  const field = findField(schema, reference);
  if (!field) throw new McpToolError("INVALID", `Unknown field “${reference.slice(0, 64)}”. Use list_collections for the field names.`);
  return field;
}

/** An option id from its label (exact, then case-insensitive) or its id; unknown labels pass through for the service to refuse. */
function optionId(field: FieldDefinition, value: unknown) {
  if (typeof value !== "string") return value;
  const options = field.options ?? [];
  return (options.find((option) => option.label === value) ?? options.find((option) => option.label.toLowerCase() === value.toLowerCase()) ?? options.find((option) => option.id === value))?.id ?? value;
}

function translateValue(field: FieldDefinition, value: unknown) {
  if (value === null) return null;
  if (field.type === "select") return optionId(field, value);
  if (field.type === "multi_select") return Array.isArray(value) ? value.map((item) => optionId(field, item)) : typeof value === "string" ? [optionId(field, value)] : value;
  return value;
}

/**
 * MCP values (keyed by field name or id) → API values (keyed by id, option ids). A note field may
 * only point at a note the key may read (T203): otherwise NOT_FOUND, the same as a missing note, so
 * a key without notes:read cannot link a note and read its title back.
 */
function translateValues(schema: CollectionSchema, values: Record<string, unknown>, key: McpKeyContext) {
  const translated: Record<string, unknown> = {};
  const fieldErrors: Record<string, string> = Object.create(null);
  for (const [reference, value] of Object.entries(values)) {
    const field = findField(schema, reference);
    if (!field) fieldErrors[reference.slice(0, 64)] = "Unknown field";
    else if (field.type === "file") fieldErrors[field.name] = "Files cannot be attached over MCP";
    else {
      if (field.type === "note" && typeof value === "string" && !keyMayRead(key, { type: "note", id: value.toLowerCase() })) throw new McpToolError("NOT_FOUND", "Note not found");
      translated[field.id] = translateValue(field, value);
    }
  }
  if (Object.keys(fieldErrors).length) throw new McpToolError("INVALID", "Some values are not valid", { fieldErrors });
  return translated;
}

type FilterInput = { field: string; op: string; value?: unknown };
type SortInput = { field: string; direction?: "asc" | "desc" };

function translateFilters(schema: CollectionSchema, filters: FilterInput[] | undefined): FilterSpec[] | undefined {
  return filters?.map((filter) => {
    const field = requireField(schema, filter.field);
    const value = filter.value === undefined ? undefined : field.type === "select" || field.type === "multi_select" ? translateValue(field, filter.value) : filter.value;
    // The API's own filter shape bounds operators and value sizes before the query builder runs.
    const parsed = filterSpec.safeParse({ fieldId: field.id, op: filter.op, ...(value === undefined ? {} : { value }) });
    if (!parsed.success) throw new McpToolError("INVALID", `Invalid filter on “${field.name}”`, { details: issueDetails(parsed.error.issues) });
    return parsed.data as FilterSpec;
  });
}

const translateSort = (schema: CollectionSchema, sort: SortInput[] | undefined): SortSpec[] | undefined =>
  sort?.map((item) => ({ fieldId: requireField(schema, item.field).id, direction: item.direction ?? "asc" }));

// ---------------------------------------------------------------------------
// Output

type McpValue = FieldValue | { noteId: string; title: string } | { restricted: true } | string[];

/**
 * A row as an agent sees it: values keyed by field name, labels for options, titles for notes, names
 * for files. A note is `{ restricted: true }` when the user cannot read it (T59) or, given `key`, the
 * key may not (T203: no notes:read). Without `key` (a person's own proposal preview) only T59 applies.
 */
export function presentRow(schema: CollectionSchema, row: RowSummary, key?: McpKeyContext) {
  // Keyed by user-chosen names: no prototype, so a (legacy) field named __proto__ is an ordinary key.
  const values: Record<string, McpValue> = Object.create(null);
  for (const field of schema.fields) {
    if (field.type === "file") {
      const names = (row.files[field.id] ?? []).map((file) => file.name);
      if (names.length) values[field.name] = names;
      continue;
    }
    const value = row.values[field.id];
    if (value === undefined) continue;
    if (field.type === "note") {
      const link = row.links[field.id];
      values[field.name] = link && "title" in link && (!key || keyMayRead(key, { type: "note", id: link.id })) ? { noteId: link.id, title: link.title || "Untitled" } : { restricted: true };
    } else if (field.type === "select") {
      values[field.name] = field.options?.find((option) => option.id === value)?.label ?? String(value);
    } else if (field.type === "multi_select") {
      values[field.name] = (value as string[]).map((id) => field.options?.find((option) => option.id === id)?.label ?? id);
    } else {
      values[field.name] = value;
    }
  }
  return {
    id: row.id,
    collectionId: row.collection_id,
    title: row.title,
    values,
    revision: row.revision,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by_name,
    changedByKey: row.updated_via_key_id === null ? null : row.updated_via_key_name ?? "an MCP key",
    url: collectionUrl(row.collection_id, row.id)
  };
}

const presentField = (field: FieldDefinition) => ({
  id: field.id,
  name: field.name,
  type: field.type,
  ...(field.required ? { required: true } : {}),
  ...(field.number ? { unit: field.number.unit, decimals: field.number.decimals } : {}),
  ...(field.options ? { options: field.options.map((option) => ({ id: option.id, label: option.label })) } : {})
});

// ---------------------------------------------------------------------------
// Tools

const uuid = z.string().uuid();
const fieldRef = z.string().min(1).max(120).describe("A field name (or id) from list_collections");
const valuesInput = z.record(z.string().max(120), z.unknown())
  .describe("Values keyed by field name (or id). Text, url, and date (yyyy-mm-dd) are strings; number; checkbox true/false; select an option label; multi_select a list of labels; note a note id; null clears.");

export const collectionTools: McpToolSpec[] = [
  defineTool({
    name: "list_collections",
    title: "List collections",
    description: "List the collections the user owns or that are shared with them, with the user's role (owner, editor, or viewer), row counts, and each field's id, name, type, and options.",
    scopes: ["collections:read"],
    access: { mode: "list", lists: ["collection"] },
    write: false,
    inputSchema: z.object({}),
    handler: (_args, key) => ({
      // A key limited to chosen collections lists only those, in SQL (T203).
      collections: listCollections(key.userId, keyFilter(key, "collections:read", { collection: "c.id" })).map((summary) => {
        const detail = collectionDetail(summary.id, key.userId);
        return { id: summary.id, name: summary.name, role: summary.role, rowCount: summary.row_count, ownerName: summary.owner_name, fields: (detail?.fields ?? []).map(presentField) };
      })
    })
  }),
  defineTool({
    name: "query_rows",
    title: "Query rows",
    description: "Rows of a collection, optionally filtered, sorted, and searched (q matches text and link fields). Filters are {field, op, value}; ops by type: text/url contains|equals|empty|not_empty, number/date eq|lt|lte|gt|gte|empty, checkbox is, select is|is_not|in, multi_select has_any|has_all, note/file empty|not_empty. Rows are keyed by field name. Pass nextCursor back for the next page.",
    scopes: ["collections:read"],
    access: { mode: "items", items: [{ arg: "collectionId", kind: "collection" }] },
    write: false,
    inputSchema: z.object({
      collectionId: uuid,
      filters: z.array(z.object({ field: fieldRef, op: z.string().max(16), value: z.unknown().optional() })).max(QUERY_LIMITS.filters).optional(),
      sort: z.array(z.object({ field: fieldRef, direction: z.enum(["asc", "desc"]).optional() })).max(QUERY_LIMITS.sort).optional(),
      q: z.string().max(QUERY_LIMITS.q).optional(),
      limit: z.number().int().min(1).max(MCP_ROW_PAGE).optional().describe(`Rows per page, 1 to ${MCP_ROW_PAGE} (default 20)`),
      cursor: z.string().max(256).optional()
    }),
    handler: async ({ collectionId, filters, sort, q, limit, cursor }, key) => {
      let schema: CollectionSchema | undefined;
      return service(key, () => {
        const collection = requireReadableCollection(collectionId.toLowerCase(), key.userId);
        schema = schemaOf(collection);
        const result = queryRows(key.userId, collection.id, {
          filters: translateFilters(schema, filters as FilterInput[] | undefined),
          sort: translateSort(schema, sort as SortInput[] | undefined),
          ...(q ? { q } : {}),
          limit: limit ?? 20,
          ...(cursor ? { cursor } : {})
        });
        return { rows: result.rows.map((row) => presentRow(schema!, row, key)), total: result.total, nextCursor: result.nextCursor };
      }, () => schema);
    }
  }),
  defineTool({
    name: "get_row",
    title: "Get a row",
    description: "Read one row, keyed by field name, with the revision update_row needs.",
    scopes: ["collections:read"],
    access: { mode: "items", items: [{ arg: "rowId", kind: "row" }] },
    write: false,
    inputSchema: z.object({ rowId: uuid }),
    handler: async ({ rowId }, key) => service(key, () => {
      const { row, role } = getRow(key.userId, rowId.toLowerCase());
      const collection = requireReadableCollection(row.collection_id, key.userId);
      return { row: presentRow(schemaOf(collection), row, key), revision: row.revision, role, collectionName: collection.name };
    })
  }),
  defineTool({
    name: "create_row",
    title: "Create a row",
    description: "Add a row to a collection the user owns or may edit. The row goes at the bottom. Values are keyed by field name.",
    scopes: ["collections:write"],
    access: { mode: "items", items: [{ arg: "collectionId", kind: "collection" }] },
    write: true,
    dailyBucket: "row_write",
    inputSchema: z.object({ collectionId: uuid, values: valuesInput }),
    handler: async ({ collectionId, values }, key) => {
      let schema: CollectionSchema | undefined;
      return service(key, async () => {
        const collection = requireReadableCollection(collectionId.toLowerCase(), key.userId);
        schema = schemaOf(collection);
        const { row } = await createRow(key.userId, collection.id, { values: translateValues(schema, values, key) }, { keyId: key.keyId });
        return { rowId: row.id, revision: row.revision, url: collectionUrl(row.collection_id, row.id) };
      }, () => schema);
    }
  }),
  defineTool({
    name: "update_row",
    title: "Update a row",
    description: "Merge values into a row (fields not named are kept; null clears one). baseRevision must be the revision from get_row or query_rows; if the row changed since, the call fails with ROW_CHANGED and the current revision. The change can be undone in Nook.",
    scopes: ["collections:write"],
    access: { mode: "items", items: [{ arg: "rowId", kind: "row" }] },
    write: true,
    dailyBucket: "row_write",
    inputSchema: z.object({ rowId: uuid, values: valuesInput, baseRevision: z.number().int().min(1) }),
    handler: async ({ rowId, values, baseRevision }, key) => {
      let schema: CollectionSchema | undefined;
      return service(key, async () => {
        const { row: current } = getRow(key.userId, rowId.toLowerCase());
        schema = schemaOf(requireReadableCollection(current.collection_id, key.userId));
        const { row } = await patchRow(key.userId, current.id, { values: translateValues(schema, values, key), revision: baseRevision }, { keyId: key.keyId });
        return { rowId: row.id, revision: row.revision, url: collectionUrl(row.collection_id, row.id) };
      }, () => schema);
    }
  }),
  // Wave 19 (§2.3).
  defineTool({
    name: "create_collection",
    title: "Create a collection",
    description: `Create a private collection the user owns, from exactly one of templateId (${COLLECTION_TEMPLATES.map((template) => template.id).join(", ")}) or fields (1 to 60 of { name, type: text|number|date|checkbox|select|multi_select|url|note|file, required?, options?: [{ label, color? }] for selects }). Nobody else sees it until the user shares it in Nook. At most 100 collections per user (LIMIT_REACHED).`,
    scopes: ["collections:write"],
    // templateId names a built-in template, not an item.
    access: { mode: "global", related: ["templateId"] },
    write: true,
    dailyBucket: "row_write",
    inputSchema: z.object({
      name: z.string().min(1).max(120),
      icon: z.string().max(32).optional(),
      templateId: z.string().max(32).optional(),
      // z.unknown keeps each field object as sent, so the route schema's prototype-key guard sees
      // `__proto__` (a z.record copy would drop it silently).
      fields: z.array(z.unknown()).min(1).max(60).optional().describe("Field definitions: { name, type, required?, options? }")
    }).strict(),
    handler: async (args, key) => {
      if ((args.templateId === undefined) === (args.fields === undefined)) throw new McpToolError("INVALID", "Give exactly one of templateId and fields");
      const parsed = collectionCreateSchema.safeParse(args);
      if (!parsed.success) throw new McpToolError("INVALID", "Invalid arguments", { details: issueDetails(parsed.error.issues) });
      return service(key, () => {
        const { collection } = createCollection(key.userId, { ...parsed.data, fields: parsed.data.fields as Parameters<typeof createCollection>[1]["fields"] });
        return {
          collectionId: collection.id, name: collection.name,
          fields: collection.fields.map((field) => ({ id: field.id, name: field.name, type: field.type })),
          url: `${config.appOrigin}/collections/${collection.id}`
        };
      });
    }
  }),
  defineTool({
    name: "bin_row",
    title: "Move a row to the Bin",
    description: `Move a row of a collection the user may edit to the Bin. ${BIN_DESCRIPTION} Restore it with restore_row.`,
    scopes: ["collections:write"],
    access: { mode: "items", items: [{ arg: "rowId", kind: "row" }] },
    alsoRequires: ["bin:write"],
    write: true,
    buckets: BIN_BUCKETS,
    inputSchema: z.object({ rowId: uuid }).strict(),
    handler: async ({ rowId }, key) => service(key, async () => {
      const { purgeAfter } = await deleteRow(key.userId, rowId.toLowerCase());
      return { rowId, binned: true, purgeAfter };
    })
  }),
  defineTool({
    name: "restore_row",
    title: "Restore a row from the Bin",
    description: "Restore a binned row. Only the collection owner, or whoever binned it while they can still edit the collection, can restore it. A row whose collection is in the Bin fails with PARENT_IN_BIN.",
    scopes: ["collections:write"],
    access: { mode: "items", items: [{ arg: "rowId", kind: "row" }] },
    alsoRequires: ["bin:write"],
    write: true,
    inputSchema: z.object({ rowId: uuid }).strict(),
    handler: async ({ rowId }, key) => service(key, async () => {
      const result = restoreResult(await restoreItem("collection_row", rowId.toLowerCase(), key.userId), "Row") as Record<string, unknown>;
      const collectionId = typeof result.folderId === "string" ? result.folderId : null;
      return { rowId, restored: true, ...(result.alreadyRestored ? { alreadyRestored: true } : {}), collectionId, ...(collectionId ? { url: collectionUrl(collectionId, rowId) } : {}) };
    })
  })
];
