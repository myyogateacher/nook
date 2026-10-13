import { audit, db, now } from "../db";
import type { ReportPatch } from "../../shared/reportsEdit";
import { ownedReport } from "./access";
import { usableDatasource } from "./datasources";
import { ReportError } from "./errors";
import { applyPatch, changedBlockIds, changedQueryKeys, diffSpecs, opsSummary, parsePatch, sectionsChanged, withoutUnusedQueries } from "./patch";
import { takeRunLock } from "./refresh";
import { parseSpec } from "./service";
import { checkSpecShape, validateSpec } from "./specValidate";
import { forValidation, reattach } from "./specCheck";
import { commitSpec, refuseWhileRunning } from "./versions";

/**
 * Manual editing (plan wave 48, D454): the owner reorders or removes blocks and edits a query's SQL by
 * hand. Each edit is a patch (patch.ts) on the current spec and becomes a `manual` version. Queries no
 * block uses any more are dropped with the blocks that used them. An edit that adds or changes SQL is
 * re-validated like a generated spec (guard, execution, columns) under the report's run lock, and its
 * results are saved under that run; reorders and removals only re-check the spec's shape.
 */
export async function manualEdit(userId: string, reportId: string, input: { patch: ReportPatch; expectedRevision: number }, via: { keyId?: string; signal?: AbortSignal } = {}): Promise<{ version: number; revision: number; errors?: never }> {
  const report = ownedReport(reportId, userId);
  if (report.revision !== input.expectedRevision) throw new ReportError(409, "REVISION_CONFLICT", "This report changed since; reload it", { revision: report.revision });
  const parsed = parsePatch(input.patch);
  if (!parsed.ok) throw new ReportError(400, "INVALID", "The change is not valid", { details: parsed.errors });
  const current = parseSpec(report.spec_json);
  const applied = applyPatch(current, parsed.patch, "user");
  if (!applied.ok) throw new ReportError(400, "INVALID", applied.errors[0] ?? "The change is not valid", { details: applied.errors });
  const spec = withoutUnusedQueries(applied.spec);
  const diff = diffSpecs(current, spec);
  if (!diff.blocks.length && !diff.queries.length && !sectionsChanged(current, spec)) throw new ReportError(400, "INVALID", "That changes nothing");
  const changed = changedQueryKeys(diff);
  const keyMeta = via.keyId ? { via: "mcp", keyId: via.keyId } : {};

  if (!changed.size) {
    refuseWhileRunning(reportId);
    const shape = checkSpecShape(forValidation(spec));
    if (!shape.ok) throw new ReportError(400, "INVALID", shape.errors[0] ?? "The change is not valid", { details: shape.errors });
    // Review H1: only the validated spec is saved (provenance and authors put back by id and key).
    const saved = commitSpec({ reportId, userId, spec: reattach(shape.spec, spec), source: "manual", expectedRevision: input.expectedRevision });
    audit(userId, null, "reports.spec.manual", { reportId, version: saved.version, ops: opsSummary(parsed.patch.ops), ...keyMeta });
    return { version: saved.version, revision: saved.revision };
  }

  // New SQL runs: the report's one run (409 RUN_IN_PROGRESS while a refresh, generation, or edit holds it).
  const datasource = usableDatasource(report.datasource_id);
  const run = takeRunLock({ reportId, kind: "edit", trigger: via.keyId ? "mcp" : "user", userId, queryKeys: [...changed] });
  const finish = (status: "succeeded" | "failed", error: string | null) =>
    db.query("UPDATE report_runs SET status = ?, error = ?, finished_at = ?, lease_until = NULL WHERE id = ? AND status = 'running'").run(status, error?.slice(0, 1000) ?? null, now(), run.id);
  try {
    // Design rules on the blocks this edit adds or changes only (D437): an old block stays as it was.
    const check = await validateSpec(datasource, forValidation(spec), { userId, runId: run.id, signal: via.signal, changedBlockIds: changedBlockIds(diff) });
    if (!check.ok) {
      finish("failed", check.errors[0] ?? "The change did not pass the checks");
      throw new ReportError(400, "INVALID", check.errors[0] ?? "The change did not pass the checks", { details: check.errors });
    }
    const results = new Map([...check.results].filter(([key]) => changed.has(key)));
    const stamp = new Set(diff.blocks.filter((change) => change.change === "added" || change.change === "updated").map((change) => change.blockId));
    const saved = db.transaction(() => {
      const committed = commitSpec({ reportId, userId, spec: reattach(check.spec, spec), source: "manual", expectedRevision: input.expectedRevision, runId: run.id, stamp, results });
      finish("succeeded", null);
      return committed;
    })();
    audit(userId, null, "reports.spec.manual", { reportId, version: saved.version, runId: run.id, ops: opsSummary(parsed.patch.ops), queries: [...changed], ...keyMeta });
    return { version: saved.version, revision: saved.revision };
  } catch (error) {
    finish("failed", error instanceof ReportError ? error.message : "The change failed");
    throw error;
  }
}
