import type { QueryOutcome, StatementClass } from "../../shared/reports";
import { logger } from "../log";
import { databaseAllowed, tableAllowed } from "./allowlist";
import { chQuery, ChError, queryIdFor, type ChResult } from "./clickhouse";
import { allowlistOf, datasourceTarget, type DatasourceRow } from "./datasources";
import { ReportError } from "./errors";
import { assertMetadataAllowed, assertQueryTreeAllowed, assertTablesAllowed, classify, filterSystemRefs, GuardError, queryTreeTables, sqlString, wrapSelect, type Classified } from "./sqlGuard";

/**
 * Running a statement through the guard (plan wave 45, D411, D412): classify, check what the lexer
 * sees against the allowlist, ask ClickHouse for `EXPLAIN QUERY TREE` and check every table, table
 * function, and function it resolved, then run the wrapped statement under the per-query settings.
 * The metadata class reads the allowed system tables through allowlist-filtered subqueries, and SHOW
 * DATABASES / SHOW TABLES rows are filtered before the row cap. A ClickHouse that cannot explain a
 * query tree (no analyzer) fails closed.
 *
 * The tree check fails closed too (review H1): it runs with `result_overflow_mode=throw`, so a tree
 * longer than its row cap, or larger than the response cap, refuses the query instead of hiding
 * TABLE lines. A failed check answers with a generic message, never ClickHouse's text; a failed run
 * shows ClickHouse's text only when every table or database it names is on the allowlist (review M2).
 *
 * Queries are limited per person and per server (T359): two at a time per person, eight in all.
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

/** Runs `work` under the per-person and per-server query limits (429 BUSY past them). */
export async function limited<T>(userId: string, work: () => Promise<T>): Promise<T> {
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

/** Rows the tree check reads at most; reaching it refuses the query. */
export const TREE_MAX_ROWS = 20_000;
/** Response bytes the tree check reads at most. */
export const TREE_MAX_BYTES = 8 * 1024 * 1024;

const CHECK_FAILED = () => new GuardError("UNSUPPORTED_SYNTAX", "ClickHouse could not check this query: a syntax error, an unknown table or column, or a table that is not on this data source's allowlist");

/**
 * A ClickHouse error from running a checked statement: its text reaches the author only when every
 * table or database it names is on the allowlist (review M2); otherwise a generic one.
 */
function shownError(error: unknown, allowlist: readonly string[], database: string): unknown {
  if (!(error instanceof ChError) || error.code !== "CLICKHOUSE") return error;
  if (!errorNamesOutside(error.message, allowlist, database)) return error;
  return new ChError("CLICKHOUSE", "The query failed in ClickHouse; its message named something that is not on this data source's allowlist, so it is not shown");
}

/** Whether ClickHouse's error text names a table or database off the allowlist (review M2). */
export function errorNamesOutside(message: string, allowlist: readonly string[], database: string) {
  for (const match of message.matchAll(/`?([A-Za-z_][A-Za-z0-9_]*)`?\.`?([A-Za-z_][A-Za-z0-9_]*)`?/g)) {
    if (!tableAllowed(allowlist, match[1]!, match[2]!) && !databaseAllowed(allowlist, match[1]!)) return true;
  }
  for (const match of message.matchAll(/[Dd]atabase `?([A-Za-z_][A-Za-z0-9_]*)`?/g)) {
    if (!databaseAllowed(allowlist, match[1]!) && match[1] !== database) return true;
  }
  return false;
}

/** Runs EXPLAIN QUERY TREE on a select and checks what it resolved. */
async function checkQueryTree(row: DatasourceRow, select: string, statementClass: StatementClass, queryId: string, signal?: AbortSignal) {
  const allowlist = allowlistOf(row);
  let result: ChResult;
  try {
    result = await chQuery(datasourceTarget(row), `EXPLAIN QUERY TREE ${select}`, {
      queryId: `${queryId}-tree`.slice(0, 120), maxResultRows: TREE_MAX_ROWS, throwOnResultOverflow: true, responseBytes: TREE_MAX_BYTES, signal
    });
  } catch (error) {
    if (!(error instanceof ChError)) throw error;
    if (error.code === "TOO_LARGE" || error.chName === "TOO_MANY_ROWS_OR_BYTES" || error.chCode === 396) throw new GuardError("UNSUPPORTED_SYNTAX", "This query is too complex to check; simplify it");
    // The network's own failures carry Nook's text, never ClickHouse's.
    if (error.code === "TIMEOUT" || error.code === "UNREACHABLE") throw error;
    // Review M2: a failed check never shows ClickHouse's text (it may name what is off the allowlist).
    throw CHECK_FAILED();
  }
  if (result.rows.length >= TREE_MAX_ROWS) throw new GuardError("UNSUPPORTED_SYNTAX", "This query is too complex to check; simplify it");
  const tree = queryTreeTables(result.rows.map((line) => String(line[0] ?? "")).join("\n"));
  assertQueryTreeAllowed(tree, allowlist, row.database, statementClass);
}

function outcome(classified: Classified, result: ChResult, rows: unknown[][], maxRows: number, sentSql: string, started: number, cutShort = false): QueryOutcome {
  return {
    class: classified.class, columns: result.columns, rows: rows.slice(0, maxRows), truncated: cutShort || rows.length > maxRows, sentSql,
    chQueryId: result.queryId, rowsRead: result.rowsRead, bytesRead: result.bytesRead, ms: Date.now() - started
  };
}

/** SHOW rows read before the allowlist filter (the cap applies after it, review L1). */
const SHOW_READ_ROWS = 100_000;

const queryLog = logger("reports");

/**
 * The query log (docs/OPERATIONS.md "Logs"): id, class, time, rows read and returned, truncated;
 * a guard refusal by its code; a ClickHouse failure by its code. The statement is logged only at
 * debug (it is the person's or the agent's SQL), and result rows never are.
 */
export async function runGuarded(row: DatasourceRow, sql: string, options: RunOptions): Promise<QueryOutcome> {
  const started = performance.now();
  if (queryLog.enabled("debug")) queryLog.debug("Query SQL", { query: options.queryId, sql: sql.slice(0, 4000) });
  try {
    const result = await runGuardedUnlogged(row, sql, options);
    queryLog.info("ClickHouse query", { query: options.queryId, class: result.class, ms: Math.round(performance.now() - started), rowsRead: result.rowsRead ?? undefined, bytesRead: result.bytesRead ?? undefined, rows: result.rows.length, truncated: result.truncated || undefined });
    return result;
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    if (error instanceof GuardError) queryLog.warn("Query refused", { query: options.queryId, code: error.code, ms });
    else if (error instanceof ChError) queryLog.warn("ClickHouse query failed", { query: options.queryId, code: error.code, chCode: error.chCode ?? undefined, chName: error.chName ?? undefined, ms });
    else if (!(error instanceof ReportError)) queryLog.error("ClickHouse query failed", { query: options.queryId, ms, err: error });
    else queryLog.warn("ClickHouse query failed", { query: options.queryId, code: error.code, ms });
    throw error;
  }
}

async function runGuardedUnlogged(row: DatasourceRow, sql: string, options: RunOptions): Promise<QueryOutcome> {
  const classified = classify(sql);
  if (!options.classes.includes(classified.class)) {
    throw new GuardError(classified.class === "metadata" ? "METADATA_FORBIDDEN" : "NOT_SELECT", classified.class === "metadata" ? "Only a SELECT runs here" : "Only metadata statements (SHOW, DESCRIBE, EXISTS, EXPLAIN, system tables) run here");
  }
  const allowlist = allowlistOf(row);
  const maxRows = Math.max(1, Math.floor(options.maxRows));
  return limited(options.userId, async () => {
    const started = Date.now();
    const target = datasourceTarget(row);
    const run = async (text: string, resultRows = maxRows + 1) => {
      try {
        return await chQuery(target, text, { queryId: options.queryId, maxResultRows: resultRows, maxRowsToRead: options.maxRowsToRead, breakOnReadLimit: options.breakOnReadLimit, signal: options.signal });
      } catch (error) {
        throw shownError(error, allowlist, row.database);
      }
    };
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
    const show = form.kind === "show_databases" || form.kind === "show_tables";
    const result = await run(classified.sql, show ? SHOW_READ_ROWS : maxRows + 1);
    let rows = result.rows;
    if (form.kind === "show_databases") rows = rows.filter((line) => databaseAllowed(allowlist, String(line[0] ?? "")));
    if (form.kind === "show_tables") rows = rows.filter((line) => tableAllowed(allowlist, form.db ?? row.database, String(line[0] ?? "")));
    // A SHOW list that reached its read cap is cut short even when the allowlisted rows fit (the console says so).
    return outcome(classified, result, rows, maxRows, classified.sql, started, show && result.rows.length >= SHOW_READ_ROWS);
  });
}

/** A fresh query id for an ad-hoc statement (the console, a schema tool). */
export const adHocQueryId = (kind: string) => queryIdFor(kind, crypto.randomUUID().replace(/-/g, "").slice(0, 12));

/**
 * Best-effort KILL QUERY for a statement and its tree check (the console's Cancel). A fixed
 * statement with quoted ids; failures are ignored (the aborted request already stops a readonly query).
 */
export async function killQuery(row: DatasourceRow, queryId: string) {
  try {
    await chQuery(datasourceTarget(row), `KILL QUERY WHERE query_id IN (${sqlString(queryId)}, ${sqlString(`${queryId}-tree`.slice(0, 120))}) ASYNC`, { queryId: queryIdFor("kill", crypto.randomUUID().slice(0, 8)), profileSettings: true });
    return true;
  } catch {
    return false;
  }
}

/** Test hook: whether the limiter is idle. */
export const runningQueries = () => total;
