import type { QueryOutcome, StatementClass } from "../../shared/reports";
import { databaseAllowed, tableAllowed } from "./allowlist";
import { chQuery, queryIdFor, type ChResult } from "./clickhouse";
import { allowlistOf, datasourceTarget, type DatasourceRow } from "./datasources";
import { ReportError } from "./errors";
import { assertMetadataAllowed, assertQueryTreeAllowed, assertTablesAllowed, classify, filterSystemRefs, GuardError, queryTreeTables, wrapSelect, type Classified } from "./sqlGuard";

/**
 * Running a statement through the guard (plan wave 45, D411, D412): classify, check what the lexer
 * sees against the allowlist, ask ClickHouse for `EXPLAIN QUERY TREE` and check every table and table
 * function it resolved, then run the wrapped statement under the per-query settings. The metadata
 * class reads the allowed system tables through allowlist-filtered subqueries, and SHOW DATABASES /
 * SHOW TABLES rows are filtered here. A ClickHouse that cannot explain a query tree (no analyzer)
 * fails closed with its own message.
 *
 * Queries are limited per person and per server (T358): two at a time per person, eight in all.
 */

export type RunOptions = {
  /** Which classes this caller allows (the console both; run_schema_query metadata only; reports' saved queries select only). */
  classes: readonly StatementClass[];
  maxRows: number;
  queryId: string;
  userId: string;
  maxRowsToRead?: number;
  breakOnReadLimit?: boolean;
  signal?: AbortSignal;
};

const PER_USER = 2;
const PER_SERVER = 8;
const running = new Map<string, number>();
let total = 0;

async function limited<T>(userId: string, work: () => Promise<T>): Promise<T> {
  const mine = running.get(userId) ?? 0;
  if (mine >= PER_USER || total >= PER_SERVER) throw new ReportError(429, "BUSY", "Too many queries are running; wait for one to finish");
  running.set(userId, mine + 1);
  total += 1;
  try {
    return await work();
  } finally {
    total -= 1;
    const left = (running.get(userId) ?? 1) - 1;
    if (left > 0) running.set(userId, left);
    else running.delete(userId);
  }
}

/** Runs EXPLAIN QUERY TREE on a select and checks what it resolved. */
async function checkQueryTree(row: DatasourceRow, select: string, statementClass: StatementClass, queryId: string, signal?: AbortSignal) {
  const result = await chQuery(datasourceTarget(row), `EXPLAIN QUERY TREE ${select}`, { queryId: `${queryId}-tree`.slice(0, 120), maxResultRows: 100_000, signal });
  const tree = queryTreeTables(result.rows.map((line) => String(line[0] ?? "")).join("\n"));
  assertQueryTreeAllowed(tree, allowlistOf(row), row.database, statementClass);
}

function outcome(classified: Classified, result: ChResult, rows: unknown[][], maxRows: number, sentSql: string, started: number): QueryOutcome {
  return {
    class: classified.class, columns: result.columns, rows: rows.slice(0, maxRows), truncated: rows.length > maxRows, sentSql,
    chQueryId: result.queryId, rowsRead: result.rowsRead, bytesRead: result.bytesRead, ms: Date.now() - started
  };
}

export async function runGuarded(row: DatasourceRow, sql: string, options: RunOptions): Promise<QueryOutcome> {
  const classified = classify(sql);
  if (!options.classes.includes(classified.class)) {
    throw new GuardError(classified.class === "metadata" ? "METADATA_FORBIDDEN" : "NOT_SELECT", classified.class === "metadata" ? "Only a SELECT runs here" : "Only metadata statements (SHOW, DESCRIBE, EXISTS, EXPLAIN, system tables) run here");
  }
  const allowlist = allowlistOf(row);
  const maxRows = Math.max(1, Math.floor(options.maxRows));
  return limited(options.userId, async () => {
    const started = Date.now();
    const target = datasourceTarget(row);
    const run = (text: string) => chQuery(target, text, { queryId: options.queryId, maxResultRows: maxRows + 1, maxRowsToRead: options.maxRowsToRead, breakOnReadLimit: options.breakOnReadLimit, signal: options.signal });
    if (classified.class === "select") {
      assertTablesAllowed(classified.tables, allowlist, row.database);
      await checkQueryTree(row, classified.sql, "select", options.queryId, options.signal);
      const sent = wrapSelect(classified.sql, maxRows);
      const result = await run(sent);
      return outcome(classified, result, result.rows, maxRows, sent, started);
    }
    assertMetadataAllowed(classified, allowlist, row.database);
    const form = classified.metadata!;
    if (form.kind === "system_select") {
      const filtered = filterSystemRefs(classified, allowlist);
      await checkQueryTree(row, filtered, "metadata", options.queryId, options.signal);
      const sent = wrapSelect(filtered, maxRows);
      const result = await run(sent);
      return outcome(classified, result, result.rows, maxRows, sent, started);
    }
    if (form.kind === "explain") await checkQueryTree(row, form.inner, "select", options.queryId, options.signal);
    const result = await run(classified.sql);
    let rows = result.rows;
    if (form.kind === "show_databases") rows = rows.filter((line) => databaseAllowed(allowlist, String(line[0] ?? "")));
    if (form.kind === "show_tables") rows = rows.filter((line) => tableAllowed(allowlist, form.db ?? row.database, String(line[0] ?? "")));
    return outcome(classified, result, rows, maxRows, classified.sql, started);
  });
}

/** A fresh query id for an ad-hoc statement (the console, a schema tool). */
export const adHocQueryId = (kind: string) => queryIdFor(kind, crypto.randomUUID().replace(/-/g, "").slice(0, 12));

/** Test hook: whether the limiter is idle. */
export const runningQueries = () => total;
