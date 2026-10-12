import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { contentDisposition } from "../contentHeaders";
import { parseJson, uuid } from "../validation";
import { exportRows, importRows } from "./importExport";
// Registers collections and rows as Bin providers (server/bin.ts).
import "./bin";
import { QUERY_LIMITS, querySpecShape } from "./query";
import { FIELD_ID, labelSchema, safeJson, type FieldInput } from "./schema";
import {
  attachDocument,
  CollectionError,
  createCollection,
  createRow,
  createView,
  deleteCollection,
  deleteRow,
  deleteView,
  detachDocument,
  getCollection,
  getRow,
  getSharing,
  listCollections,
  listTemplates,
  patchCollection,
  patchRow,
  patchView,
  putSchema,
  putSharing,
  queryRows,
  undoRow
} from "./service";

const icon = z.string().regex(/^[a-z0-9-]{1,32}$/, "Icons are short lowercase names");
const revision = z.number().int().positive();
const valuesObject = z.record(z.string().max(64), z.unknown());

export const collectionCreateSchema = safeJson(z.object({
  name: labelSchema(120),
  icon: icon.optional(),
  templateId: z.string().max(32).optional(),
  // Fields are validated by buildSchema so that every schema error is 400 INVALID_SCHEMA.
  fields: z.array(z.unknown()).max(60).optional()
}).strict());
export const collectionPatchSchema = safeJson(z.object({ name: labelSchema(120).optional(), icon: icon.optional() }).strict()
  .refine((value) => value.name !== undefined || value.icon !== undefined, "Provide a name or an icon"));
export const schemaPutSchema = safeJson(z.object({ fields: z.array(z.unknown()).max(60), schemaVersion: revision }).strict());
export const querySchema = safeJson(z.object({
  viewId: uuid.optional(),
  ...querySpecShape,
  cursor: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(QUERY_LIMITS.pageSize).optional()
}).strict());
export const sharingSchema = safeJson(z.object({
  visibility: z.enum(["private", "selected", "all_users"]),
  userIds: z.array(uuid).max(100).default([]),
  role: z.enum(["viewer", "editor"]).default("viewer")
}).strict());
const viewConfig = z.object({
  sort: querySpecShape.sort,
  filters: querySpecShape.filters,
  hiddenFieldIds: z.array(z.string().regex(FIELD_ID)).max(50).optional()
}).strict();
export const viewCreateSchema = safeJson(z.object({ name: labelSchema(60), kind: z.literal("table").optional(), config: viewConfig.default({}) }).strict());
export const viewPatchSchema = safeJson(z.object({ name: labelSchema(60).optional(), config: viewConfig.optional() }).strict()
  .refine((value) => value.name !== undefined || value.config !== undefined, "Provide a name or a config"));
export const rowCreateSchema = safeJson(z.object({ values: valuesObject, afterRowId: uuid.nullable().optional() }).strict());
export const rowPatchSchema = safeJson(z.object({ values: valuesObject, revision }).strict());
export const rowUndoSchema = safeJson(z.object({ revision }).strict());
export const attachSchema = safeJson(z.object({ documentId: uuid, fieldId: z.string().regex(FIELD_ID), confirmed: z.boolean().optional() }).strict());
// The CSV byte cap (2 MB) is checked by importRows so that an oversized file is 413, not a generic 400.
export const importSchema = safeJson(z.object({ csv: z.string(), mapping: z.array(z.string().regex(FIELD_ID).nullable()).max(50).optional(), dryRun: z.boolean().default(false) }).strict());

export const pathId = (c: Context<AppEnv>, name: string) => uuid.parse(c.req.param(name));

/** Runs a service call and maps CollectionError to its JSON response; other errors reach app.onError. */
export async function respond(c: Context<AppEnv>, operation: () => unknown, status: 200 | 201 = 200) {
  try {
    return c.json(await operation() as Record<string, unknown>, status);
  } catch (error) {
    if (error instanceof CollectionError) return c.json(error.body(), error.status);
    throw error;
  }
}

/**
 * docs/plan/API_CONTRACTS.md § Collections. JSON only; the global session,
 * Origin, CSRF, and TOTP middleware apply.
 *
 * The MCP tools (server/collections/mcpTools.ts: `list_collections`,
 * `query_rows`, `get_row`, `create_row`, `update_row`) call the same service
 * functions (listCollections, queryRows, getRow, createRow, patchRow) with the
 * key id, which sets `updated_via_key_id`. Nothing here is MCP-specific.
 */
export function registerCollectionRoutes(app: Hono<AppEnv>) {
  const user = (c: Context<AppEnv>) => c.get("user").id;

  app.get("/api/collections", (c) => c.json({ collections: listCollections(user(c)) }));
  app.get("/api/collections/templates", (c) => c.json({ templates: listTemplates() }));

  app.post("/api/collections", async (c) => {
    const body = await parseJson(c.req.raw, collectionCreateSchema);
    return respond(c, () => createCollection(user(c), { ...body, fields: body.fields as FieldInput[] | undefined }), 201);
  });

  app.get("/api/collections/:collectionId", (c) => {
    const collectionId = pathId(c, "collectionId");
    return respond(c, () => getCollection(user(c), collectionId));
  });

  app.patch("/api/collections/:collectionId", async (c) => {
    const collectionId = pathId(c, "collectionId");
    const body = await parseJson(c.req.raw, collectionPatchSchema);
    return respond(c, () => patchCollection(user(c), collectionId, body));
  });

  app.delete("/api/collections/:collectionId", (c) => {
    const collectionId = pathId(c, "collectionId");
    return respond(c, () => deleteCollection(user(c), collectionId));
  });

  app.put("/api/collections/:collectionId/schema", async (c) => {
    const collectionId = pathId(c, "collectionId");
    const body = await parseJson(c.req.raw, schemaPutSchema);
    return respond(c, () => putSchema(user(c), collectionId, { fields: body.fields as FieldInput[], schemaVersion: body.schemaVersion }));
  });

  app.get("/api/collections/:collectionId/sharing", (c) => {
    const collectionId = pathId(c, "collectionId");
    return respond(c, () => getSharing(user(c), collectionId));
  });

  app.put("/api/collections/:collectionId/sharing", async (c) => {
    const collectionId = pathId(c, "collectionId");
    const body = await parseJson(c.req.raw, sharingSchema);
    return respond(c, () => putSharing(user(c), collectionId, body));
  });

  app.post("/api/collections/:collectionId/query", async (c) => {
    const collectionId = pathId(c, "collectionId");
    const body = await parseJson(c.req.raw, querySchema);
    return respond(c, () => queryRows(user(c), collectionId, body));
  });

  app.post("/api/collections/:collectionId/import", async (c) => {
    const collectionId = pathId(c, "collectionId");
    const body = await parseJson(c.req.raw, importSchema);
    return respond(c, () => importRows(user(c), collectionId, body));
  });

  app.get("/api/collections/:collectionId/export.csv", (c) => {
    const collectionId = pathId(c, "collectionId");
    const viewParam = c.req.query("viewId");
    const viewId = viewParam === undefined || viewParam === "" ? undefined : uuid.parse(viewParam);
    try {
      const { csv, name } = exportRows(user(c), collectionId, viewId);
      return c.body(csv, 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": contentDisposition("attachment", `${name}.csv`),
        "Cache-Control": "no-store"
      });
    } catch (error) {
      if (error instanceof CollectionError) return c.json(error.body(), error.status);
      throw error;
    }
  });

  app.post("/api/collections/:collectionId/views", async (c) => {
    const collectionId = pathId(c, "collectionId");
    const body = await parseJson(c.req.raw, viewCreateSchema);
    return respond(c, () => createView(user(c), collectionId, { name: body.name, config: body.config }), 201);
  });

  app.patch("/api/collections/views/:viewId", async (c) => {
    const viewId = pathId(c, "viewId");
    const body = await parseJson(c.req.raw, viewPatchSchema);
    return respond(c, () => patchView(user(c), viewId, body));
  });

  app.delete("/api/collections/views/:viewId", (c) => {
    const viewId = pathId(c, "viewId");
    return respond(c, () => deleteView(user(c), viewId));
  });

  app.post("/api/collections/:collectionId/rows", async (c) => {
    const collectionId = pathId(c, "collectionId");
    const body = await parseJson(c.req.raw, rowCreateSchema);
    return respond(c, () => createRow(user(c), collectionId, body), 201);
  });

  app.get("/api/collections/rows/:rowId", (c) => {
    const rowId = pathId(c, "rowId");
    return respond(c, () => getRow(user(c), rowId));
  });

  app.patch("/api/collections/rows/:rowId", async (c) => {
    const rowId = pathId(c, "rowId");
    const body = await parseJson(c.req.raw, rowPatchSchema);
    return respond(c, () => patchRow(user(c), rowId, body));
  });

  app.post("/api/collections/rows/:rowId/undo", async (c) => {
    const rowId = pathId(c, "rowId");
    const body = await parseJson(c.req.raw, rowUndoSchema);
    return respond(c, () => undoRow(user(c), rowId, body));
  });

  app.post("/api/collections/rows/:rowId/attachments", async (c) => {
    const rowId = pathId(c, "rowId");
    const body = await parseJson(c.req.raw, attachSchema);
    return respond(c, () => attachDocument(user(c), rowId, body), 201);
  });

  app.delete("/api/collections/rows/:rowId/attachments/:documentId", (c) => {
    const rowId = pathId(c, "rowId");
    const documentId = pathId(c, "documentId");
    return respond(c, () => detachDocument(user(c), rowId, documentId));
  });

  app.delete("/api/collections/rows/:rowId", (c) => {
    const rowId = pathId(c, "rowId");
    return respond(c, () => deleteRow(user(c), rowId));
  });
}
