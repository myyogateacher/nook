import type { Context, Hono } from "hono";
import { z, ZodError } from "zod";
import type { AppEnv } from "../auth";
import { parseJson, uuid } from "../validation";
import { REPORT_LIMITS } from "../../shared/reports";
import { roleHasReports } from "./access";
import { createDatasource, datasourceChoices, datasourceRow, datasourceSummary, deleteDatasource, listDatasources, previewAllowlist, SCHEMA_FIELDS, testConnection, updateDatasource } from "./datasources";
import { asReportError, ReportError } from "./errors";
import { startSchemaSync, syncSchema } from "./schemaCatalog";
import { describeTablesTool, listTablesTool, searchSchemaTool } from "./schemaTools";
import { binReport, cancelConsole, createReport, listReports, reportDatasource, reportDetail, runConsole, updateReport } from "./service";
import { limited } from "./runner";
import "./bin";
import { registerGenerateRoutes } from "./generateRoutes";
import { registerReportViewRoutes } from "./viewRoutes";
import { registerReportEditRoutes } from "./editRoutes";
import { registerReportFolderRoutes } from "./folderRoutes";

/**
 * docs/plan/API_CONTRACTS.md § Analytics reports (Wave 45). Every route needs a session; mutations
 * need CSRF and a role that writes (the Wave 15 gate refuses viewers and guests). Guests get 404
 * everywhere (they have no Reports module). Admin routes live under `/api/reports/admin/*` and answer
 * 404 to everyone else. Missing and forbidden are the same 404; no error echoes a password.
 */

const line = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must be one line of text");
const allowlist = z.array(z.string().trim().min(1).max(260)).max(REPORT_LIMITS.allowlistPatterns);
const datasourceCreate = z.object({
  name: line(60),
  url: z.string().trim().min(8).max(512),
  username: line(128),
  password: z.string().max(1024).nullish(),
  database: z.string().trim().min(1).max(128).optional(),
  allowlist: allowlist.optional(),
  maxRows: z.number().int().min(1).max(REPORT_LIMITS.maxRowsCeiling).optional(),
  timeoutS: z.number().int().min(1).max(REPORT_LIMITS.timeoutCeilingS).optional(),
  enabled: z.boolean().optional()
}).strict();
const datasourcePatch = datasourceCreate.partial().extend({ expectedRevision: z.number().int().min(1), removePassword: z.boolean().optional() }).strict();
const previewSchema = z.object({ allowlist }).strict();
const reportCreate = z.object({ title: line(REPORT_LIMITS.title), datasourceId: uuid, folderId: uuid.nullish() }).strict();
const reportPatch = z.object({ title: line(REPORT_LIMITS.title).optional(), datasourceId: uuid.optional(), expectedRevision: z.number().int().min(1) }).strict();
const consoleSchema = z.object({ sql: z.string().min(1).max(REPORT_LIMITS.sqlChars) }).strict();
const emptySchema = z.object({}).strict();

const notFound = () => new ReportError(404, "NOT_FOUND", "Not found");

export function id(c: Context<AppEnv>, name: string) {
  const parsed = uuid.safeParse(c.req.param(name)?.toLowerCase());
  if (!parsed.success) throw notFound();
  return parsed.data;
}

function fail(c: Context<AppEnv>, error: unknown) {
  if (error instanceof ZodError) return c.json({ error: "Invalid request", code: "INVALID", details: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`) }, 400);
  if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON", code: "INVALID" }, 400);
  if (error instanceof Error && error.name === "AgentSecretError") return c.json({ error: "Set AGENT_SECRETS_KEY on the server to store data source passwords", code: "NOT_CONFIGURED" }, 503);
  const known = asReportError(error);
  if (known.status === 429) c.header("Retry-After", "5");
  return c.json({ error: known.message, code: known.code, ...known.details }, known.status);
}

export type Handler = (c: Context<AppEnv>) => unknown | Promise<unknown>;
export const handle = (handler: Handler) => async (c: Context<AppEnv>) => {
  try {
    if (!roleHasReports(c.get("user").role)) throw notFound();
    const result = await handler(c);
    return result instanceof Response ? result : c.json(result as object);
  } catch (error) {
    return fail(c, error);
  }
};
const adminOnly = (handler: Handler): Handler => (c) => {
  if (c.get("user").role !== "admin") throw notFound();
  return handler(c);
};

export function registerReportRoutes(app: Hono<AppEnv>) {
  // --- Admin: data sources (Settings → Report data sources) ---
  app.get("/api/reports/admin/datasources", handle(adminOnly(() => ({ datasources: listDatasources() }))));
  app.post("/api/reports/admin/datasources", handle(adminOnly(async (c) => {
    const datasource = createDatasource(c.get("user").id, await parseJson(c.req.raw, datasourceCreate));
    if (datasource.allowlist.length) startSchemaSync(datasource.id);
    return c.json({ datasource }, 201);
  })));
  app.get("/api/reports/admin/datasources/:datasourceId", handle(adminOnly((c) => ({ datasource: datasourceSummary(datasourceRow(id(c, "datasourceId"))) }))));
  app.patch("/api/reports/admin/datasources/:datasourceId", handle(adminOnly(async (c) => {
    const datasourceId = id(c, "datasourceId");
    const patch = await parseJson(c.req.raw, datasourcePatch);
    const datasource = updateDatasource(c.get("user").id, datasourceId, patch);
    if (SCHEMA_FIELDS.some((field) => patch[field] !== undefined) && datasource.enabled) startSchemaSync(datasourceId);
    return { datasource };
  })));
  app.delete("/api/reports/admin/datasources/:datasourceId", handle(adminOnly((c) => {
    deleteDatasource(c.get("user").id, id(c, "datasourceId"));
    return { ok: true };
  })));
  app.post("/api/reports/admin/datasources/:datasourceId/test", handle(adminOnly(async (c) => {
    const datasourceId = id(c, "datasourceId");
    await parseJson(c.req.raw, emptySchema);
    return { test: await testConnection(datasourceId) };
  })));
  app.post("/api/reports/admin/datasources/:datasourceId/sync", handle(adminOnly(async (c) => {
    const datasourceId = id(c, "datasourceId");
    await parseJson(c.req.raw, emptySchema);
    const sync = await syncSchema(datasourceId);
    return { sync, datasource: datasourceSummary(datasourceRow(datasourceId)) };
  })));
  app.post("/api/reports/admin/datasources/:datasourceId/allowlist-preview", handle(adminOnly(async (c) => {
    const datasourceId = id(c, "datasourceId");
    const { allowlist: patterns } = await parseJson(c.req.raw, previewSchema);
    return { preview: await previewAllowlist(datasourceId, patterns) };
  })));

  // --- Authors ---
  // Wave 46 (generation and the doc) first: its literal paths come before /api/reports/:reportId.
  registerGenerateRoutes(app);
  // Lane I: report folders (literal /api/reports/folders paths, before /api/reports/:reportId).
  registerReportFolderRoutes(app);
  app.get("/api/reports/datasources", handle(() => ({ datasources: datasourceChoices() })));
  app.get("/api/reports", handle((c) => ({ reports: listReports(c.get("user").id, { q: c.req.query("q")?.slice(0, 200) }) })));
  app.post("/api/reports", handle(async (c) => {
    const input = await parseJson(c.req.raw, reportCreate);
    return c.json({ report: createReport(c.get("user").id, { ...input, folderId: input.folderId?.toLowerCase() ?? null }) }, 201);
  }));
  app.get("/api/reports/:reportId", handle((c) => ({ report: reportDetail(id(c, "reportId"), c.get("user").id) })));
  app.patch("/api/reports/:reportId", handle(async (c) => {
    const reportId = id(c, "reportId");
    return { report: updateReport(c.get("user").id, reportId, await parseJson(c.req.raw, reportPatch)) };
  }));
  app.delete("/api/reports/:reportId", handle((c) => binReport(c.get("user").id, id(c, "reportId"))));

  // The guarded manual SQL console and the Schema browser (the report's data source).
  app.post("/api/reports/:reportId/console", handle(async (c) => {
    const reportId = id(c, "reportId");
    const { sql } = await parseJson(c.req.raw, consoleSchema);
    return { outcome: await runConsole(c.get("user").id, reportId, sql, c.req.raw.signal) };
  }));
  // Cancel: aborts the caller's running console query on this report and sends a best-effort KILL QUERY.
  app.post("/api/reports/:reportId/console/cancel", handle(async (c) => {
    const reportId = id(c, "reportId");
    await parseJson(c.req.raw, emptySchema);
    return await cancelConsole(c.get("user").id, reportId);
  }));
  app.get("/api/reports/:reportId/schema/search", handle((c) => {
    const row = reportDatasource(id(c, "reportId"), c.get("user").id);
    const limit = Number(c.req.query("limit") ?? REPORT_LIMITS.searchResults);
    // Review L2: the Schema browser counts against the person's query limit like the console.
    return limited(c.get("user").id, async () => searchSchemaTool(row, { query: c.req.query("q") ?? "", limit: Number.isFinite(limit) ? limit : REPORT_LIMITS.searchResults }));
  }));
  app.get("/api/reports/:reportId/schema/tables", handle((c) => {
    const row = reportDatasource(id(c, "reportId"), c.get("user").id);
    const page = Number(c.req.query("page") ?? 0);
    const dbName = c.req.query("db");
    return limited(c.get("user").id, async () => listTablesTool(row, { db: dbName ? dbName.slice(0, 128) : undefined, like: c.req.query("like")?.slice(0, 100), page: Number.isFinite(page) ? page : 0 }));
  }));
  app.get("/api/reports/:reportId/schema/describe", handle(async (c) => {
    const row = reportDatasource(id(c, "reportId"), c.get("user").id);
    const tables = (c.req.query("tables") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
    if (!tables.length) throw new ReportError(400, "INVALID", "Name a table");
    return describeTablesTool(row, c.get("user").id, { tables });
  }));

  // Wave 47: results, refresh, runs, provenance, and the schedule (viewRoutes.ts).
  registerReportViewRoutes(app);
  // Wave 48: instructions, proposals, versions, manual edits, and sharing (editRoutes.ts).
  registerReportEditRoutes(app);
}
