import { metricCatalogView, saveCatalogEdit } from "./metricCatalog";
import { METRIC_LIMITS, type CatalogMetricInput } from "../../shared/reportsMetrics";
import { ownedReport } from "./access";
import { usableDatasource } from "./datasources";
import type { Hono } from "hono";
import { pageInfos } from "./docBrowse";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { db } from "../db";
import { parseJson, uuid } from "../validation";
import { QUERY_KEY, type ReportRun } from "../../shared/reports";
import type { DocSnapshotInfo, ProvenanceView } from "../../shared/reportsView";
import { isReportOwner, readableReport } from "./access";
import { listRuns, reportResults, reportRun, runRow, runView, startRefresh } from "./refresh";
import { handle, id } from "./routes";
import { getSchedule, saveSchedule } from "./scheduler";
import { runHistory, runLog } from "./runHistory";
import { storedPlan } from "./planner";

/**
 * docs/plan/API_CONTRACTS.md § Analytics reports (Wave 47): what the viewer reads (each query's last
 * good result and newest failure), refresh (whole report or one query, 202 with the running run, 409
 * RUN_IN_PROGRESS while one runs), the run history, a block's provenance, and the schedule. Same rules
 * as routes.ts: a session, CSRF and a writing role for mutations, 404 for guests and for reports the
 * person cannot read.
 */

const refreshSchema = z.object({ queryKey: z.string().regex(QUERY_KEY).nullish() }).strict();
const scheduleSchema = z.object({
  cadence: z.string().max(20),
  atTime: z.string().max(5).nullable(),
  weekday: z.number().int().min(0).max(6).nullable(),
  tz: z.string().min(1).max(64),
  enabled: z.boolean()
}).strict();

function snapshotInfo(reportId: string, snapshotId: string | null | undefined): DocSnapshotInfo | null {
  if (!snapshotId) return null;
  const row = db.query("SELECT id, title, sha256, fetched_at FROM report_doc_snapshots WHERE id = ? AND report_id = ?").get(snapshotId, reportId) as
    { id: string; title: string | null; sha256: string; fetched_at: string } | null;
  return row ? { id: row.id, title: row.title, sha256: row.sha256, fetchedAt: row.fetched_at } : null;
}

/** A block's provenance: the run that made or last changed it and the doc snapshot it worked from (never the doc's text). */
export function provenance(reportId: string, userId: string, input: { runId?: string | null; snapshotId?: string | null; blockId?: string | null; queryKey?: string | null }): ProvenanceView {
  const report = readableReport(reportId, userId);
  const run = input.runId ? runRow(input.runId) : null;
  const ownRun = run && run.report_id === reportId ? run : null;
  // Review L2: the doc (its snapshots' titles and hashes) and the agent run are the owner's.
  if (!isReportOwner(report.id, userId)) return { run: ownRun ? forReader(runView(ownRun)) : null, snapshot: null };
  // 2c: the plan todo that produced the block (by its block id, else its query key).
  const plan = ownRun ? storedPlan((db.query("SELECT plan_json FROM report_runs WHERE id = ?").get(ownRun.id) as { plan_json: string | null } | null)?.plan_json) : null;
  const todo = plan?.todos.find((item) => input.blockId && item.blockId === input.blockId) ?? plan?.todos.find((item) => input.queryKey && item.queryKey === input.queryKey) ?? null;
  // B3: the linked pages the run's agent read (titles and hashes, never their text), the owner's only.
  return { run: ownRun ? runView(ownRun) : null, snapshot: snapshotInfo(reportId, input.snapshotId ?? ownRun?.doc_snapshot_id), todo: todo ? { id: todo.id, title: todo.title, status: todo.status, note: todo.note } : null, ...(ownRun ? { pages: pageInfos(reportId, ownRun.id) } : {}) };
}

/** A run as a reader of a shared report sees it: no doc snapshot, no agent run (wave 48 review L2). */
export const forReader = (run: ReportRun): ReportRun => ({ ...run, docSnapshotId: null, agentRunId: null });
const isOwner = (reportId: string, userId: string) => isReportOwner(readableReport(reportId, userId).id, userId);

const optionalUuid = (value: string | undefined) => {
  const parsed = uuid.safeParse(value?.toLowerCase());
  return parsed.success ? parsed.data : null;
};

const metricsSaveSchema = z.object({ expectedVersion: z.number().int().min(0).nullable(), metrics: z.array(z.unknown()).max(METRIC_LIMITS.metrics) }).strict();

export function registerReportViewRoutes(app: Hono<AppEnv>) {
  // E4: the metric catalog (the owner's; 404 to anyone else), a version by ?version=, and a save (a new version).
  app.get("/api/reports/:reportId/metrics", handle((c) => {
    const version = Number(c.req.query("version") ?? "");
    return { catalog: metricCatalogView(id(c, "reportId"), c.get("user").id, Number.isInteger(version) && version > 0 ? version : null) };
  }));
  app.put("/api/reports/:reportId/metrics", handle(async (c) => {
    const reportId = id(c, "reportId");
    const userId = c.get("user").id;
    const input = await parseJson(c.req.raw, metricsSaveSchema);
    const report = ownedReport(reportId, userId);
    return { catalog: await saveCatalogEdit({ userId }, reportId, { expectedVersion: input.expectedVersion, metrics: input.metrics as CatalogMetricInput[] }, usableDatasource(report.datasource_id)) };
  }));
  app.get("/api/reports/:reportId/results", handle((c) => {
    const reportId = id(c, "reportId");
    const userId = c.get("user").id;
    const view = reportResults(reportId, userId);
    return isOwner(reportId, userId) || !view.running ? view : { ...view, running: forReader(view.running) };
  }));
  app.post("/api/reports/:reportId/refresh", handle(async (c) => {
    const reportId = id(c, "reportId");
    const { queryKey } = await parseJson(c.req.raw, refreshSchema);
    const { run } = startRefresh(c.get("user").id, reportId, { trigger: "user", queryKey: queryKey ?? null });
    return c.json({ run }, 202);
  }));
  app.get("/api/reports/:reportId/runs", handle((c) => {
    const reportId = id(c, "reportId");
    const userId = c.get("user").id;
    const runs = listRuns(reportId, userId);
    return { runs: isOwner(reportId, userId) ? runs : runs.map(forReader), schedule: getSchedule(reportId, userId) };
  }));
  // The Runs panel: the owner's run history and one run's step log (404 to anyone else).
  app.get("/api/reports/:reportId/run-history", handle((c) => ({ runs: runHistory(id(c, "reportId"), c.get("user").id) })));
  app.get("/api/reports/:reportId/run-history/:runId", handle((c) => runLog(id(c, "reportId"), id(c, "runId"), c.get("user").id)));
  app.get("/api/reports/:reportId/runs/:runId", handle((c) => {
    const reportId = id(c, "reportId");
    const userId = c.get("user").id;
    const run = reportRun(reportId, id(c, "runId"), userId);
    return { run: isOwner(reportId, userId) ? run : forReader(run) };
  }));
  app.get("/api/reports/:reportId/provenance", handle((c) => provenance(id(c, "reportId"), c.get("user").id, {
    runId: optionalUuid(c.req.query("runId")), snapshotId: optionalUuid(c.req.query("snapshotId")),
    blockId: c.req.query("blockId")?.slice(0, 40) ?? null, queryKey: c.req.query("queryKey")?.slice(0, 40) ?? null
  })));
  app.get("/api/reports/:reportId/schedule", handle((c) => ({ schedule: getSchedule(id(c, "reportId"), c.get("user").id) })));
  app.put("/api/reports/:reportId/schedule", handle(async (c) => {
    const reportId = id(c, "reportId");
    return { schedule: saveSchedule(c.get("user").id, reportId, await parseJson(c.req.raw, scheduleSchema)) };
  }));
}
