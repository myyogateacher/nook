import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { db } from "../db";
import { parseJson, uuid } from "../validation";
import { QUERY_KEY, type ReportRun } from "../../shared/reports";
import type { DocSnapshotInfo, ProvenanceView } from "../../shared/reportsView";
import { readableReport } from "./access";
import { listRuns, reportResults, reportRun, runRow, runView, startRefresh } from "./refresh";
import { handle, id } from "./routes";
import { getSchedule, saveSchedule } from "./scheduler";
import { runHistory, runLog } from "./runHistory";

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
export function provenance(reportId: string, userId: string, input: { runId?: string | null; snapshotId?: string | null }): ProvenanceView {
  const report = readableReport(reportId, userId);
  const run = input.runId ? runRow(input.runId) : null;
  const ownRun = run && run.report_id === reportId ? run : null;
  // Review L2: the doc (its snapshots' titles and hashes) and the agent run are the owner's.
  if (report.owner_id !== userId) return { run: ownRun ? forReader(runView(ownRun)) : null, snapshot: null };
  return { run: ownRun ? runView(ownRun) : null, snapshot: snapshotInfo(reportId, input.snapshotId ?? ownRun?.doc_snapshot_id) };
}

/** A run as a reader of a shared report sees it: no doc snapshot, no agent run (wave 48 review L2). */
export const forReader = (run: ReportRun): ReportRun => ({ ...run, docSnapshotId: null, agentRunId: null });
const isOwner = (reportId: string, userId: string) => readableReport(reportId, userId).owner_id === userId;

const optionalUuid = (value: string | undefined) => {
  const parsed = uuid.safeParse(value?.toLowerCase());
  return parsed.success ? parsed.data : null;
};

export function registerReportViewRoutes(app: Hono<AppEnv>) {
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
    runId: optionalUuid(c.req.query("runId")), snapshotId: optionalUuid(c.req.query("snapshotId"))
  })));
  app.get("/api/reports/:reportId/schedule", handle((c) => ({ schedule: getSchedule(id(c, "reportId"), c.get("user").id) })));
  app.put("/api/reports/:reportId/schedule", handle(async (c) => {
    const reportId = id(c, "reportId");
    return { schedule: saveSchedule(c.get("user").id, reportId, await parseJson(c.req.raw, scheduleSchema)) };
  }));
}
