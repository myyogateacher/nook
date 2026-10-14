import { REPORT_LIMITS, type CatalogTable, type QueryOutcome, type SchemaSearchHit } from "../../shared/reports";
import { tableAllowed } from "./allowlist";
import { allowlistOf, type DatasourceRow } from "./datasources";
import { ReportError } from "./errors";
import { adHocQueryId, limited, runGuarded } from "./runner";
import { describeTables, listTables, parseTableName, searchSchema, type TableListItem } from "./schemaCatalog";
import { classify, GuardError, sqlIdentifier } from "./sqlGuard";

/**
 * The schema tools (plan wave 45, "Agent tools for schema", D417), as plain server functions; wave 46
 * wraps them as the generation agent's tools and the Schema browser calls the first three through
 * the routes. Ranked from cheapest:
 *
 * - `search_schema`: FTS over the catalog, no ClickHouse round trip.
 * - `list_tables`: the catalog, paged 50 at a time.
 * - `describe_tables`: up to 10 tables with partition and sorting keys (a lazy miss reads one).
 * - `sample_rows`: up to 5 rows of one table, guarded, with a tight read limit.
 * - `run_schema_query`: the metadata class only (SHOW, DESCRIBE, EXISTS, EXPLAIN, system tables).
 * - `estimate`: EXPLAIN ESTIMATE of a select (rows, parts, and marks it would read).
 *
 * Every function takes the data source row (the caller has checked the person may use it) and the
 * person's id (the query limiter counts per person).
 */

export const SAMPLE_READ_ROWS = 100_000;
export const SCHEMA_QUERY_ROWS = 200;

export function searchSchemaTool(row: DatasourceRow, input: { query: string; limit?: number }): { results: SchemaSearchHit[] } {
  return { results: searchSchema(row, input.query.slice(0, 200), Math.min(input.limit ?? REPORT_LIMITS.searchResults, REPORT_LIMITS.searchResults)) };
}

export function listTablesTool(row: DatasourceRow, input: { db?: string; like?: string; page?: number }): { tables: TableListItem[]; page: number; hasMore: boolean; databases: string[] } {
  return listTables(row, input);
}

/** A lazy miss reads ClickHouse, so describing counts against the person's query limit (review L2). */
export async function describeTablesTool(row: DatasourceRow, userId: string, input: { tables: string[] }): Promise<{ tables: CatalogTable[]; missing: string[] }> {
  if (input.tables.length > REPORT_LIMITS.describeBatch) throw new ReportError(400, "INVALID", `Describe at most ${REPORT_LIMITS.describeBatch} tables at a time`);
  return limited(userId, () => describeTables(row, input.tables));
}

export async function sampleRowsTool(row: DatasourceRow, userId: string, input: { table: string; n?: number }): Promise<QueryOutcome> {
  const parsed = parseTableName(input.table, row.database);
  if (!parsed || !tableAllowed(allowlistOf(row), parsed.db, parsed.name)) throw new GuardError("NOT_ALLOWED_TABLE", `${input.table.slice(0, 200)} is not on this data source's allowlist`);
  const n = Math.min(Math.max(1, Math.floor(input.n ?? REPORT_LIMITS.sampleRows)), REPORT_LIMITS.sampleRows);
  return runGuarded(row, `SELECT * FROM ${sqlIdentifier(parsed.db)}.${sqlIdentifier(parsed.name)} LIMIT ${n}`, {
    classes: ["select"], maxRows: n, queryId: adHocQueryId("sample"), userId, maxRowsToRead: SAMPLE_READ_ROWS, breakOnReadLimit: true
  });
}

export async function runSchemaQueryTool(row: DatasourceRow, userId: string, input: { sql: string }): Promise<QueryOutcome> {
  return runGuarded(row, input.sql, { classes: ["metadata"], maxRows: SCHEMA_QUERY_ROWS, queryId: adHocQueryId("meta"), userId });
}

export type Estimate = { rows: number; parts: number; marks: number; tables: Array<{ table: string; rows: number; parts: number; marks: number }> };

/** EXPLAIN ESTIMATE of a select: what it would read, per table and in all. */
export async function estimateTool(row: DatasourceRow, userId: string, input: { sql: string }): Promise<Estimate> {
  const classified = classify(input.sql);
  if (classified.class !== "select") throw new GuardError("NOT_SELECT", "estimate takes a SELECT");
  const result = await runGuarded(row, `EXPLAIN ESTIMATE ${classified.sql}`, { classes: ["metadata"], maxRows: 1000, queryId: adHocQueryId("estimate"), userId });
  const at = (name: string) => result.columns.findIndex((column) => column.name === name);
  const [dbAt, tableAt, partsAt, rowsAt, marksAt] = [at("database"), at("table"), at("parts"), at("rows"), at("marks")];
  const tables = result.rows.map((line) => ({
    table: `${String(line[dbAt] ?? "")}.${String(line[tableAt] ?? "")}`, rows: Number(line[rowsAt] ?? 0) || 0, parts: Number(line[partsAt] ?? 0) || 0, marks: Number(line[marksAt] ?? 0) || 0
  }));
  return { rows: tables.reduce((sum, item) => sum + item.rows, 0), parts: tables.reduce((sum, item) => sum + item.parts, 0), marks: tables.reduce((sum, item) => sum + item.marks, 0), tables };
}
