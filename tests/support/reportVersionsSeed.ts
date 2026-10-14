import type { Database } from "bun:sqlite";
import type { ReportBlock, ReportSpec } from "../../shared/reports";
import { sampleAnswer, sampleSpec } from "./reportSeed";

/**
 * A report history of six versions of mixed sources (lane J: the Versions panel's tests and QA seed):
 * v1 generated from the doc; v2 an instruction asked by another person and applied by the owner (with
 * an agent note); v3 the owner's own instruction, auto-applied (text, width, a section); v4 a manual SQL
 * edit; v5 a restore of v2; v6 a regeneration (+1 chart). v1's and v6's runs keep results.
 */
export type SeededHistory = { runs: { v1: string; v2: string; v3: string; v6: string }; instructions: { asked: string; own: string }; specs: ReportSpec[] };

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function historySpecs(): ReportSpec[] {
  const base: ReportSpec = { ...sampleSpec(), specVersion: 2, sections: [] };
  const v1: ReportSpec = { ...clone(base), blocks: base.blocks.filter((block) => block.id !== "recent-table"), queries: base.queries.filter((query) => query.key !== "recent") };
  const v2: ReportSpec = clone(base);
  v2.blocks = v2.blocks.map((block) => block.id === "country-bar" ? { ...block, title: "Top countries by revenue" } : block);
  const v3: ReportSpec = clone(v2);
  v3.sections = [{ id: "overview", title: "Overview", summary: "Revenue at a glance" }];
  v3.blocks = v3.blocks.map((block): ReportBlock => block.id === "intro" && block.type === "markdown" ? { ...block, markdown: "## Weekly revenue\n\nRevenue is **net of refunds**.\nSource: `analytics.orders`." }
    : block.id === "kpi-orders" ? { ...block, width: "half", section: "overview" } : block);
  const v4: ReportSpec = clone(v3);
  v4.queries = v4.queries.map((query) => query.key === "by_country" ? { ...query, sql: query.sql.replace("LIMIT 8", "LIMIT 10"), createdBy: "user" } : query);
  const v5: ReportSpec = clone(v2);
  const v6: ReportSpec = clone(v4);
  v6.blocks = [...v6.blocks.slice(0, 3), { id: "orders-trend", type: "chart", title: "Revenue trend", queryKey: "daily", kind: "area", x: "day", y: ["revenue"], format: "currency" }, ...v6.blocks.slice(3)];
  return [v1, v2, v3, v4, v5, v6];
}

export function seedVersionHistory(db: Database, input: { reportId: string; ownerId: string; askerId: string }): SeededHistory {
  const specs = historySpecs();
  const day = 86_400_000;
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();
  const run = (kind: "generate" | "edit" | "refresh", daysAgo: number, by: string) => {
    const id = crypto.randomUUID();
    db.query("INSERT INTO report_runs (id, report_id, kind, trigger, status, created_by, started_at, finished_at) VALUES (?, ?, ?, 'user', 'succeeded', ?, ?, ?)").run(id, input.reportId, kind, by, at(daysAgo), at(daysAgo - 0.001));
    return id;
  };
  const results = (runId: string, spec: ReportSpec, daysAgo: number) => {
    for (const query of spec.queries) {
      const answer = sampleAnswer(query.sql) as { meta: unknown[]; data: unknown[][] };
      db.query(`INSERT INTO report_results (id, run_id, report_id, query_key, sql, sent_sql, columns_json, rows_json, row_count, truncated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
        .run(crypto.randomUUID(), runId, input.reportId, query.key, query.sql, query.sql, JSON.stringify(answer.meta), JSON.stringify(answer.data), answer.data.length, at(daysAgo));
    }
  };
  const instruction = (text: string, authorId: string, runId: string, version: number, auto: boolean, daysAgo: number) => {
    const id = crypto.randomUUID();
    db.query(`INSERT INTO report_instructions (id, report_id, text, author_id, status, position, run_id, applied_version, auto_applied, decided_by, created_at, updated_at, decided_at)
      VALUES (?, ?, ?, ?, 'applied', 0, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.reportId, text, authorId, runId, version, auto ? 1 : 0, input.ownerId, at(daysAgo + 0.01), at(daysAgo), at(daysAgo));
    return id;
  };
  const version = (n: number, source: string, daysAgo: number, extra: { instructionId?: string; restoredFrom?: number; runId?: string; note?: string } = {}) => {
    db.query("INSERT INTO report_versions (report_id, version, spec_json, source, instruction_id, restored_from, run_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.reportId, n, JSON.stringify(specs[n - 1]), source, extra.instructionId ?? null, extra.restoredFrom ?? null, extra.runId ?? null, extra.note ?? null, input.ownerId, at(daysAgo));
  };

  const r1 = run("generate", 6, input.ownerId);
  results(r1, specs[0]!, 6);
  version(1, "generate", 6, { runId: r1 });
  const r2 = run("edit", 5, input.ownerId);
  const asked = instruction("Add a table of the latest orders", input.askerId, r2, 2, false, 5);
  version(2, "edit", 5, { runId: r2, instructionId: asked, note: "Added the latest orders table (SECRET agent note)" });
  const r3 = run("edit", 4, input.ownerId);
  const own = instruction("Make the intro shorter and group the KPIs", input.ownerId, r3, 3, true, 4);
  version(3, "edit", 4, { runId: r3, instructionId: own, note: "Shortened the intro" });
  version(4, "manual", 3);
  version(5, "restore", 2, { restoredFrom: 2 });
  const r6 = run("generate", 1, input.ownerId);
  results(r6, specs[5]!, 1);
  version(6, "generate", 1, { runId: r6 });
  db.query("UPDATE reports SET spec_json = ?, status = 'ready', revision = 7, last_run_at = ? WHERE id = ?").run(JSON.stringify(specs[5]), at(1), input.reportId);
  return { runs: { v1: r1, v2: r2, v3: r3, v6: r6 }, instructions: { asked, own }, specs };
}
