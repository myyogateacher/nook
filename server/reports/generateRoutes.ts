import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson, uuid } from "../validation";
import { REPORT_LIMITS } from "../../shared/reports";
import type { GenerationRun } from "../../shared/reportsGenerate";
import { TOOL_NAME } from "../agents/toolServers";
import { db } from "../db";
import { readableReport } from "./access";
import { checkDoc, docServerChoices, docState } from "./docSource";
import { cancelGenerate, regenerate, startGenerate } from "./generate";
import { reportModelView, setReportModel } from "./model";
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
const modelInput = z.object({ override: z.object({ providerId: uuid.nullable(), model: oneLine(200).nullable() }).strict().nullable() }).strict();

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
    const report = readableReport(reportId, c.get("user").id);
    const owner = report.owner_id === c.get("user").id;
    const row = db.query("SELECT id, agent_run_id, status, error, doc_snapshot_id, started_at, finished_at FROM report_runs WHERE report_id = ? AND kind = 'generate' ORDER BY started_at DESC, rowid DESC LIMIT 1").get(reportId) as RunRow | null;
    // Review L2: a reader of a shared report sees the status, never the agent run or the doc snapshot.
    const run: GenerationRun | null = row ? { id: row.id, agentRunId: owner ? row.agent_run_id : null, status: row.status, error: row.error, docSnapshotId: owner ? row.doc_snapshot_id : null, startedAt: row.started_at, finishedAt: row.finished_at } : null;
    return { run };
  }));
  // Wave 48b (D435): the report's own generation model (the owner's override of the admin setting).
  app.get("/api/reports/:reportId/model", handle((c) => ({ model: reportModelView(id(c, "reportId"), c.get("user")) })));
  app.put("/api/reports/:reportId/model", handle(async (c) => {
    const reportId = id(c, "reportId");
    const body = await parseJson(c.req.raw, modelInput);
    return { model: setReportModel(reportId, c.get("user"), body.override) };
  }));
  app.get("/api/reports/:reportId/doc", handle((c) => ({ doc: docState(id(c, "reportId"), c.get("user").id) })));
  app.post("/api/reports/:reportId/doc/check", handle(async (c) => {
    const user = c.get("user");
    const reportId = id(c, "reportId");
    await parseJson(c.req.raw, emptySchema);
    return { doc: await checkDoc({ userId: user.id, role: user.role }, reportId, c.req.raw.signal) };
  }));
}
