import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson, uuid } from "../validation";
import { REPORT_LIMITS, type ReportResult } from "../../shared/reports";
import type { GenerationRun, LatestResults } from "../../shared/reportsGenerate";
import { TOOL_NAME } from "../agents/toolServers";
import { db } from "../db";
import { readableReport } from "./access";
import { checkDoc, docServerChoices, docState } from "./docSource";
import { cancelGenerate, regenerate, startGenerate } from "./generate";
import { handle, id } from "./routes";

/**
 * docs/plan/API_CONTRACTS.md § Analytics reports, Wave 46: the doc servers a person may read a doc
 * through, Generate (a new report or again), Stop, the latest generation run (to follow it after a
 * reload), and the doc's state with "Check doc". Registered before `/api/reports/:reportId`.
 */

const oneLine = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must be one line of text");
const docRef = oneLine(2048);
const toolName = z.string().trim().regex(TOOL_NAME, "must be a tool name").nullish();
const argName = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/, "must be an argument name").nullish();
const generateCreate = z.object({ docRef, serverId: uuid, tool: toolName, arg: argName, datasourceId: uuid, title: oneLine(REPORT_LIMITS.title).nullish() }).strict();
const generateAgain = z.object({ docRef: docRef.optional(), serverId: uuid.optional(), tool: toolName, arg: argName, datasourceId: uuid.optional() }).strict();
const emptySchema = z.object({}).strict();

type ResultRow = {
  run_id: string; query_key: string; sql: string; sent_sql: string | null; columns_json: string; rows_json: string; row_count: number; truncated: number;
  rows_read: number | null; bytes_read: number | null; ch_query_id: string | null; ms: number | null; error: string | null; error_code: string | null; created_at: string;
};
const parsed = <T>(json: string, fallback: T): T => { try { return JSON.parse(json) as T; } catch { return fallback; } };
const resultOf = (row: ResultRow): ReportResult => ({
  runId: row.run_id, queryKey: row.query_key, sql: row.sql, sentSql: row.sent_sql, columns: parsed(row.columns_json, []), rows: parsed(row.rows_json, []), rowCount: row.row_count,
  truncated: row.truncated === 1, rowsRead: row.rows_read, bytesRead: row.bytes_read, chQueryId: row.ch_query_id, ms: row.ms, error: row.error, errorCode: row.error_code, createdAt: row.created_at
});

type RunRow = { id: string; agent_run_id: string | null; status: GenerationRun["status"]; error: string | null; doc_snapshot_id: string | null; started_at: string; finished_at: string | null };

export function registerGenerateRoutes(app: Hono<AppEnv>) {
  app.get("/api/reports/doc-servers", handle((c) => ({ servers: docServerChoices(c.get("user").role) })));
  app.post("/api/reports/generate", handle(async (c) => {
    const user = c.get("user");
    const body = await parseJson(c.req.raw, generateCreate);
    return c.json(await startGenerate({ userId: user.id, role: user.role }, body, null, c.req.raw.signal), 202);
  }));
  app.post("/api/reports/:reportId/generate", handle(async (c) => {
    const user = c.get("user");
    const reportId = id(c, "reportId");
    const body = await parseJson(c.req.raw, generateAgain);
    return c.json(await regenerate({ userId: user.id, role: user.role }, reportId, body, c.req.raw.signal), 202);
  }));
  app.post("/api/reports/:reportId/generate/cancel", handle(async (c) => {
    const reportId = id(c, "reportId");
    await parseJson(c.req.raw, emptySchema);
    return cancelGenerate(c.get("user").id, reportId);
  }));
  // The latest generation run, so a reloaded page can follow a running one (or show why the last failed).
  app.get("/api/reports/:reportId/generation", handle((c) => {
    const reportId = id(c, "reportId");
    readableReport(reportId, c.get("user").id);
    const row = db.query("SELECT id, agent_run_id, status, error, doc_snapshot_id, started_at, finished_at FROM report_runs WHERE report_id = ? AND kind = 'generate' ORDER BY started_at DESC, rowid DESC LIMIT 1").get(reportId) as RunRow | null;
    const run: GenerationRun | null = row ? { id: row.id, agentRunId: row.agent_run_id, status: row.status, error: row.error, docSnapshotId: row.doc_snapshot_id, startedAt: row.started_at, finishedAt: row.finished_at } : null;
    return { run };
  }));
  // The newest stored result of each of the report's queries, for the spec preview (wave 47's viewer replaces it).
  app.get("/api/reports/:reportId/generation/results", handle((c) => {
    const reportId = id(c, "reportId");
    readableReport(reportId, c.get("user").id);
    const rows = db.query(`SELECT r.* FROM report_results r WHERE r.report_id = ? AND r.query_key IN (SELECT q.key FROM report_queries q WHERE q.report_id = r.report_id) AND r.rowid = (SELECT r2.rowid FROM report_results r2 WHERE r2.report_id = r.report_id AND r2.query_key = r.query_key ORDER BY r2.created_at DESC, r2.rowid DESC LIMIT 1)
      ORDER BY r.query_key LIMIT ${REPORT_LIMITS.queries}`).all(reportId) as ResultRow[];
    return { results: rows.map(resultOf) } satisfies LatestResults;
  }));
  app.get("/api/reports/:reportId/doc", handle((c) => ({ doc: docState(id(c, "reportId"), c.get("user").id) })));
  app.post("/api/reports/:reportId/doc/check", handle(async (c) => {
    const user = c.get("user");
    const reportId = id(c, "reportId");
    await parseJson(c.req.raw, emptySchema);
    return { doc: await checkDoc({ userId: user.id, role: user.role }, reportId, c.req.raw.signal) };
  }));
}
