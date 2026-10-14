import { db } from "../db";
import { logger } from "../log";
import { isNumericType, isTimeType, type CatalogTable, type QueryOutcome, type ReportBlock, type ReportSpec } from "../../shared/reports";
import { queryIdFor } from "./clickhouse";
import type { DatasourceRow } from "./datasources";
import { finalNote } from "./repairHints";
import { runGuarded } from "./runner";
import { tableOf } from "./schemaCatalog";
import { sqlIdentifier } from "./sqlGuard";
import { normaliseExpr, queryShape, type QueryShape } from "./sqlShape";

const slog = logger("reports");

/**
 * Result sanity checks (lane E, E2): a spec that passes the shape, SQL, and design checks can still be
 * wrong. After its queries ran, these look at what they returned and send back a specific hint for
 * each problem, the way the other checks do (generate.ts refuses a submit for them once per run; it
 * did not use a try). Every hint starts with `sanity <check>:`.
 *
 * - **fan_out**: a query joins a table whose join key repeats (a guarded sample of the table, FINAL on
 *   a Replacing/Collapsing table) while it sums or counts the driving table's rows: the driving rows
 *   are counted once per match.
 * - **reconcile**: a KPI and a breakdown chart of the same metric (the plan's todo metric, or the same
 *   additive expression on the same table) whose totals differ by more than 1 %.
 * - **coverage**: a time series with a run of empty periods inside it, or one that starts or ends well
 *   inside the date range its SQL asks for; a KPI over a date range that came back empty.
 * - **units**: a percent column outside 0–1 (format percent) or a ratio under 1 shown with unit %;
 *   money in cents shown as currency without dividing by 100; a measure that is all NULL or all 0.
 *
 * - **final** (E3): a query reads a ReplacingMergeTree (or another collapsing engine, from the
 *   catalog) without FINAL, so rows that were updated count once per version.
 *
 * At most `SANITY_LIMITS.extraQueries` extra queries per check (the fan-out samples), each guarded,
 * read-only, and counted in the run log; every check is logged in the reports scope.
 */

export const SANITY_LIMITS = {
  extraQueries: 4,
  /** Rows of a joined table the fan-out sample reads. */
  fanoutSample: 200_000,
  /** Relative difference a KPI and its breakdown may have. */
  reconcileTolerance: 0.01,
  hints: 8
} as const;

export type SanityCheck = { check: "fan_out" | "reconcile" | "coverage" | "units" | "final"; target: string; ok: boolean; detail?: string };
export type SanityResult = { hints: string[]; checks: SanityCheck[]; extraQueries: number };
export type SanityContext = {
  userId: string; runId: string; signal?: AbortSignal;
  /** The plan's metric for a block (by block id), when the planner named one. */
  metricOf?: (block: ReportBlock) => string | null;
  /**
   * E6: an edit checks only what it touched: the blocks it adds or changes and the queries they (or
   * the edit) use. Null or absent: everything (a generation).
   */
  scope?: { blocks: ReadonlySet<string>; queries: ReadonlySet<string> } | null;
};

const numberOf = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value.trim())) return Number(value);
  return null;
};
const show = (value: number) => Math.abs(value) >= 1000 ? Math.round(value).toLocaleString("en-US") : String(Math.round(value * 10_000) / 10_000);
const columnAt = (result: Pick<QueryOutcome, "columns">, name: string) => result.columns.findIndex((column) => column.name === name);

function catalogOf(datasourceId: string): (dbName: string, name: string) => CatalogTable | null {
  const cache = new Map<string, CatalogTable | null>();
  return (dbName, name) => {
    const key = `${dbName}.${name}`;
    if (!cache.has(key)) {
      const row = db.query("SELECT * FROM report_schema_tables WHERE datasource_id = ? AND db = ? AND name = ?").get(datasourceId, dbName, name) as Parameters<typeof tableOf>[0] | null;
      cache.set(key, row ? tableOf(row) : null);
    }
    return cache.get(key)!;
  };
}

const COLLAPSING = /^(Replacing|Collapsing|VersionedCollapsing|Summing|Aggregating)MergeTree|^Shared(Replacing|Collapsing)/;
const ADDITIVE = /^(sum|count|sumif|countif|sumexact)\s*\(/i;

// -------------------------------------------------------------------------------------- fan-out

/** Whether the select list sums or counts rows of the table under `alias` (or unqualified columns that are only its). */
function aggregatesSide(shape: QueryShape, alias: string | null, ownColumns: ReadonlySet<string>, otherColumns: ReadonlySet<string>): string | null {
  for (const item of shape.items) {
    const expr = item.expr;
    if (/\bcount\s*\(\s*\)/i.test(expr) || /\bcount\s*\(\s*\*\s*\)/i.test(expr)) return item.alias;
    for (const match of expr.matchAll(/\b(sum|avg|count|sumIf|avgIf|countIf)\s*\(\s*([A-Za-z_][\w]*)(?:\s*\.\s*([A-Za-z_][\w]*))?/gi)) {
      const qualified = match[3] !== undefined;
      if (qualified && alias !== null && match[2] === alias) return item.alias;
      if (!qualified && ownColumns.has(match[2]!) && !otherColumns.has(match[2]!)) return item.alias;
    }
  }
  return null;
}

async function fanOut(row: DatasourceRow, spec: ReportSpec, context: SanityContext, budget: { left: number }, out: SanityResult) {
  const catalog = catalogOf(row.id);
  const sampled = new Map<string, { rows: number; keys: number } | null>();
  for (const query of spec.queries) {
    if (context.scope && !context.scope.queries.has(query.key)) continue;
    const shape = queryShape(query.sql);
    if (!shape.from || !shape.joins.length) continue;
    const driving = shape.from;
    const drivingTable = catalog(driving.db ?? row.database, driving.name);
    for (const join of shape.joins) {
      if (join.subquery || !join.keys.length || join.kind.includes("semi") || join.kind.includes("anti")) continue;
      const joined = catalog(join.db ?? row.database, join.name);
      if (!joined || !drivingTable) continue;
      const own = new Set(drivingTable.columns.map((column) => column.name));
      const other = new Set(joined.columns.map((column) => column.name));
      const measure = aggregatesSide(shape, driving.alias ?? driving.name, own, other);
      if (!measure) { out.checks.push({ check: "fan_out", target: query.key, ok: true, detail: "no driving-table aggregate" }); continue; }
      const keys = [...new Set(join.keys.map((key) => key.own))].filter((key) => other.has(key));
      if (!keys.length) continue;
      const name = `${joined.db}.${joined.name}`;
      const cacheKey = `${name}|${keys.join(",")}`;
      if (!sampled.has(cacheKey)) {
        if (budget.left <= 0) { out.checks.push({ check: "fan_out", target: query.key, ok: true, detail: "skipped: no extra queries left" }); continue; }
        budget.left -= 1;
        out.extraQueries += 1;
        const final = COLLAPSING.test(joined.engine) ? " FINAL" : "";
        const keyExpr = keys.length === 1 ? sqlIdentifier(keys[0]!) : `tuple(${keys.map(sqlIdentifier).join(", ")})`;
        const sql = `SELECT count() AS sample_rows, uniqExact(${keyExpr}) AS sample_keys FROM (SELECT ${keys.map(sqlIdentifier).join(", ")} FROM ${sqlIdentifier(joined.db)}.${sqlIdentifier(joined.name)}${final} LIMIT ${SANITY_LIMITS.fanoutSample})`;
        try {
          const result = await runGuarded(row, sql, { classes: ["select"], maxRows: 1, queryId: queryIdFor("sanity", context.runId.replace(/-/g, "").slice(0, 12), String(out.extraQueries)), userId: context.userId, signal: context.signal });
          sampled.set(cacheKey, { rows: numberOf(result.rows[0]?.[0]) ?? 0, keys: numberOf(result.rows[0]?.[1]) ?? 0 });
        } catch (error) {
          if (context.signal?.aborted) throw error;
          sampled.set(cacheKey, null);
        }
      }
      const sample = sampled.get(cacheKey);
      if (!sample) { out.checks.push({ check: "fan_out", target: query.key, ok: true, detail: "sample failed" }); continue; }
      const repeats = sample.keys > 0 && sample.rows > sample.keys * 1.0001;
      out.checks.push({ check: "fan_out", target: query.key, ok: !repeats, detail: `${name} ${sample.rows} rows / ${sample.keys} keys` });
      if (repeats) {
        out.hints.push(`sanity fan_out: query ${query.key} joins ${name} on ${keys.join(", ")}, which repeats (${sample.rows} rows for ${sample.keys} keys in a sample), and ${measure} sums or counts rows of ${driving.db ? `${driving.db}.` : ""}${driving.name}: each of its rows is counted once per match, so the total is inflated. Aggregate ${joined.name} by ${keys.join(", ")} in a subquery before the join, or compute ${measure} from ${driving.name} alone.`);
      }
    }
  }
}

// ------------------------------------------------------------------------------------ reconcile

const BREAKDOWN_KINDS = new Set(["bar", "horizontal_bar", "stacked_bar", "pie", "treemap", "area", "line"]);

function reconcile(spec: ReportSpec, results: ReadonlyMap<string, QueryOutcome>, context: SanityContext, out: SanityResult) {
  const shapes = new Map(spec.queries.map((query) => [query.key, queryShape(query.sql)]));
  const exprOf = (key: string, column: string) => shapes.get(key)?.items.find((item) => item.alias === column)?.expr ?? null;
  const tableOfQuery = (key: string) => { const from = shapes.get(key)?.from; return from ? `${from.db ?? ""}.${from.name}`.toLowerCase() : null; };
  for (const kpi of spec.blocks) {
    if (kpi.type !== "kpi") continue;
    const kpiResult = results.get(kpi.queryKey);
    const kpiValue = kpiResult && kpiResult.rows.length === 1 ? numberOf(kpiResult.rows[0]![columnAt(kpiResult, kpi.column)]) : null;
    if (kpiValue === null) continue;
    const kpiExpr = exprOf(kpi.queryKey, kpi.column);
    const kpiMetric = context.metricOf?.(kpi)?.toLowerCase().trim() || null;
    for (const chart of spec.blocks) {
      if (chart.type !== "chart" || chart.queryKey === kpi.queryKey || !BREAKDOWN_KINDS.has(chart.kind) || chart.y.length !== 1) continue;
      if (context.scope && !context.scope.blocks.has(kpi.id) && !context.scope.blocks.has(chart.id)) continue;
      const chartResult = results.get(chart.queryKey);
      const shape = shapes.get(chart.queryKey);
      if (!chartResult || !shape || shape.limited || chartResult.truncated) continue;
      const y = chart.y[0]!;
      const chartExpr = exprOf(chart.queryKey, y);
      const sameMetric = kpiMetric !== null && kpiMetric === (context.metricOf?.(chart)?.toLowerCase().trim() || null);
      const sameExpr = kpiExpr !== null && chartExpr !== null && normaliseExpr(kpiExpr) === normaliseExpr(chartExpr) && tableOfQuery(kpi.queryKey) === tableOfQuery(chart.queryKey);
      if (!sameMetric && !sameExpr) continue;
      // Only additive measures add up across a breakdown.
      if (!kpiExpr || !chartExpr || !ADDITIVE.test(kpiExpr.trim()) || !ADDITIVE.test(chartExpr.trim())) continue;
      const yi = columnAt(chartResult, y);
      const total = chartResult.rows.reduce((sum, line) => sum + (numberOf(line[yi]) ?? 0), 0);
      const differs = Math.abs(total - kpiValue) > SANITY_LIMITS.reconcileTolerance * Math.max(Math.abs(kpiValue), Math.abs(total), 1e-9);
      out.checks.push({ check: "reconcile", target: `${kpi.id}~${chart.id}`, ok: !differs, detail: `${show(kpiValue)} vs ${show(total)}` });
      if (differs) {
        out.hints.push(`sanity reconcile: KPI ${kpi.id} (${kpi.column} = ${show(kpiValue)}) and chart ${chart.id} (${y}, its rows sum to ${show(total)}) show the same metric${sameMetric ? ` (${kpiMetric})` : ""} but do not reconcile; their filters, periods, FINAL, or joins differ. Use one definition in both queries.`);
      }
    }
  }
}

// ------------------------------------------------------------------------------------- coverage

const DAY = 86_400_000;
const timeOf = (value: unknown) => { const time = Date.parse(String(value).replace(" ", "T").slice(0, 19) + (String(value).length <= 10 ? "T00:00:00Z" : "Z")); return Number.isFinite(time) ? time : null; };

/** The literal date range a query's WHERE asks for (`>= 'YYYY-MM-DD…'` / `< …` / BETWEEN), if any. */
export function literalRange(where: string): { from: number | null; to: number | null } {
  const date = "'(\\d{4}-\\d{2}-\\d{2}(?:[ T]\\d{2}:\\d{2}(?::\\d{2})?)?)'";
  let from: number | null = null;
  let to: number | null = null;
  for (const match of where.matchAll(new RegExp(`>=?\\s*(?:to\\w+\\()?${date}`, "g"))) from = Math.max(from ?? -Infinity, timeOf(match[1])!);
  for (const match of where.matchAll(new RegExp(`<(=?)\\s*(?:to\\w+\\()?${date}`, "g"))) { const time = timeOf(match[2])! + (match[1] ? DAY : 0); to = Math.min(to ?? Infinity, time); }
  for (const match of where.matchAll(new RegExp(`BETWEEN\\s+(?:to\\w+\\()?${date}\\)?\\s+AND\\s+(?:to\\w+\\()?${date}`, "gi"))) { from = timeOf(match[1]); to = timeOf(match[2])! + DAY; }
  return { from, to };
}

function coverage(spec: ReportSpec, results: ReadonlyMap<string, QueryOutcome>, out: SanityResult, scope?: SanityContext["scope"]) {
  for (const block of spec.blocks) {
    if (scope && !scope.blocks.has(block.id)) continue;
    if (block.type === "kpi") {
      const result = results.get(block.queryKey);
      if (!result) continue;
      const range = literalRange(queryShape(spec.queries.find((query) => query.key === block.queryKey)?.sql ?? "").where);
      if ((range.from !== null || range.to !== null) && (result.rows.length === 0 || result.rows[0]![columnAt(result, block.column)] === null)) {
        out.checks.push({ check: "coverage", target: block.id, ok: false });
        out.hints.push(`sanity coverage: KPI ${block.id} came back empty for the date range its query asks for; check the dates against the data (sample_rows, min/max of the date column) and the period the document gives.`);
      }
      continue;
    }
    if (block.type !== "chart" || !["line", "area", "calendar", "bar", "stacked_bar"].includes(block.kind)) continue;
    const result = results.get(block.queryKey);
    if (!result || result.rows.length < 3) continue;
    const xi = columnAt(result, block.x);
    if (xi < 0 || !isTimeType(result.columns[xi]!.type)) continue;
    const times = [...new Set(result.rows.map((line) => timeOf(line[xi])).filter((time): time is number => time !== null))].sort((a, b) => a - b);
    if (times.length < 3) continue;
    const gaps = times.slice(1).map((time, index) => time - times[index]!);
    const step = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
    if (step <= 0) continue;
    const grain = step >= 27 * DAY ? "month" : step >= 7 * DAY ? "week" : step >= DAY ? "day" : "hour";
    const unit = grain === "month" ? 31 * DAY : step;
    const missing = gaps.reduce((sum, gap) => sum + Math.max(0, Math.round(gap / unit) - 1), 0);
    const longest = Math.max(...gaps.map((gap) => Math.round(gap / unit) - 1));
    const range = literalRange(queryShape(spec.queries.find((query) => query.key === block.queryKey)?.sql ?? "").where);
    const lateStart = range.from !== null && times[0]! - range.from > 2 * unit;
    const earlyEnd = range.to !== null && range.to - times.at(-1)! > 3 * unit;
    const holes = longest >= 3 || missing > Math.max(2, 0.2 * times.length);
    out.checks.push({ check: "coverage", target: block.id, ok: !holes && !lateStart && !earlyEnd, detail: `${times.length} ${grain}s, ${missing} missing` });
    if (holes) out.hints.push(`sanity coverage: chart ${block.id} has ${missing} empty ${grain}s inside its series (the longest run is ${longest}); a filter may drop rows, or the date column may be the wrong one. If the gaps are real, say so in a markdown note; otherwise fix the query.`);
    if (lateStart || earlyEnd) out.hints.push(`sanity coverage: chart ${block.id}'s data ${lateStart ? `starts ${Math.round((times[0]! - range.from!) / DAY)} days after` : ""}${lateStart && earlyEnd ? " and " : ""}${earlyEnd ? `ends ${Math.round((range.to! - times.at(-1)!) / DAY)} days before` : ""} the date range its query asks for; check the time zone, the date column, and the period.`);
  }
}

// ---------------------------------------------------------------------------------------- units

function units(row: DatasourceRow, spec: ReportSpec, results: ReadonlyMap<string, QueryOutcome>, out: SanityResult, scope?: SanityContext["scope"]) {
  const catalog = catalogOf(row.id);
  const measures = (block: ReportBlock): string[] => block.type === "kpi" ? [block.column] : block.type === "chart" ? block.y : [];
  const centColumns = (sql: string): string[] => {
    const shape = queryShape(sql);
    const tables = [shape.from, ...shape.joins].filter((table) => table && !(table as { subquery?: boolean }).subquery && table.name)
      .map((table) => catalog(table!.db ?? row.database, table!.name)).filter((table): table is CatalogTable => table !== null);
    return tables.flatMap((table) => table.columns.filter((column) => /(^|_)cents?($|_)/i.test(column.name) || /\bcents\b/i.test(column.comment)).map((column) => column.name));
  };
  for (const block of spec.blocks) {
    if (block.type !== "kpi" && block.type !== "chart") continue;
    if (scope && !scope.blocks.has(block.id)) continue;
    const result = results.get(block.queryKey);
    if (!result || !result.rows.length) continue;
    const sql = spec.queries.find((query) => query.key === block.queryKey)?.sql ?? "";
    const shape = queryShape(sql);
    for (const column of measures(block)) {
      const index = columnAt(result, column);
      if (index < 0 || !isNumericType(result.columns[index]!.type)) continue;
      const values = result.rows.map((line) => line[index] === null ? null : numberOf(line[index]));
      const numbers = values.filter((value): value is number => value !== null);
      const where = `${block.type === "kpi" ? "KPI" : "chart"} ${block.id} (${column})`;
      if (!numbers.length || numbers.every((value) => value === 0)) {
        out.checks.push({ check: "units", target: `${block.id}.${column}`, ok: false, detail: "all null or zero" });
        out.hints.push(`sanity units: ${where} is ${numbers.length ? "0 in every row" : "NULL in every row"}; a filter may match nothing, a join may not match, or the column may be the wrong one. Check with run_sql before keeping it.`);
        continue;
      }
      const max = Math.max(...numbers.map(Math.abs));
      const growth = /(growth|change|delta|diff|vs|lift|uplift)/i.test(`${column} ${block.title ?? ""}`);
      if (block.format === "percent" && !growth && (max > 1.0001 || numbers.some((value) => value < -0.0001))) {
        out.checks.push({ check: "units", target: `${block.id}.${column}`, ok: false, detail: `percent max ${show(max)}` });
        out.hints.push(`sanity units: ${where} has format percent, which expects a ratio (0.25 shows 25 %), but its values reach ${show(max)}${max <= 100 ? `, so it would show ${show(max * 100)} %: drop the × 100 in the SQL` : ""}.`);
        continue;
      }
      if (block.unit === "%" && max <= 1 && numbers.some((value) => value !== 0 && Math.abs(value) < 1)) {
        out.checks.push({ check: "units", target: `${block.id}.${column}`, ok: false, detail: "ratio shown with unit %" });
        out.hints.push(`sanity units: ${where} shows ratios (at most ${show(max)}) with unit %, so 0.25 would read "0.25 %"; use format percent instead of the unit.`);
        continue;
      }
      if (typeof block.format === "string" && block.format.startsWith("currency:")) {
        const expr = shape.items.find((item) => item.alias === column)?.expr ?? "";
        const cents = centColumns(sql).filter((name) => new RegExp(`\\b${name}\\b`).test(expr));
        if (cents.length && !/\/\s*100(\.0*)?\b|\*\s*0?\.01\b|\/\s*100\.0|divide\s*\([^)]*,\s*100\s*\)/.test(expr)) {
          out.checks.push({ check: "units", target: `${block.id}.${column}`, ok: false, detail: `cents ${cents.join(", ")}` });
          out.hints.push(`sanity units: ${where} is shown as ${block.format.slice(9)} but sums ${cents.join(", ")}, which the catalog says is in cents: divide by 100, or it shows 100× too much.`);
          continue;
        }
      }
      out.checks.push({ check: "units", target: `${block.id}.${column}`, ok: true });
    }
  }
}

// ---------------------------------------------------------------------------------------- final

function finality(row: DatasourceRow, spec: ReportSpec, out: SanityResult, scope?: SanityContext["scope"]) {
  for (const query of spec.queries) {
    if (scope && !scope.queries.has(query.key)) continue;
    const note = finalNote(query.sql, row);
    out.checks.push({ check: "final", target: query.key, ok: !note });
    if (note) out.hints.push(`sanity final: query ${query.key}: ${note}`);
  }
}

// ------------------------------------------------------------------------------------------ all

export async function sanityChecks(row: DatasourceRow, spec: ReportSpec, results: ReadonlyMap<string, QueryOutcome>, context: SanityContext): Promise<SanityResult> {
  const out: SanityResult = { hints: [], checks: [], extraQueries: 0 };
  const budget = { left: SANITY_LIMITS.extraQueries };
  try {
    finality(row, spec, out, context.scope);
    units(row, spec, results, out, context.scope);
    reconcile(spec, results, context, out);
    coverage(spec, results, out, context.scope);
    await fanOut(row, spec, context, budget, out);
  } catch (error) {
    if (context.signal?.aborted) throw error;
    slog.warn("Sanity checks failed", { err: error });
  }
  for (const check of out.checks) slog.info("Sanity check", { check: check.check, target: check.target, ok: check.ok, detail: check.detail });
  out.hints = [...new Set(out.hints)].slice(0, SANITY_LIMITS.hints);
  return out;
}
