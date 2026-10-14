import { logger, shortId } from "../log";
import { db, now } from "../db";
import { REPORT_LIMITS, type CatalogColumn, type CatalogTable, type SchemaSearchHit, type SchemaSyncResult } from "../../shared/reports";
import { databaseAllowed, tableAllowed } from "./allowlist";
import { chQuery, ChError, queryIdFor, type ChResult, type ChTarget } from "./clickhouse";
import { allowlistOf, datasourceRow, datasourceTarget, type DatasourceRow } from "./datasources";
import { sqlIdentifier, sqlString } from "./sqlGuard";

/**
 * The schema catalog (plan wave 45, "Schema catalog for a large warehouse", D416): a cached copy of
 * the allowlisted part of a data source's layout in SQLite (`report_schema_tables`, one row per table
 * with its columns as JSON) and an FTS5 index over table names, table comments, column names, and
 * column comments (`report_schema_fts`, kept by 050's triggers), so finding the right tables among
 * ~1000 never needs a ClickHouse round trip.
 *
 * **Sync** is one bulk read of `system.tables` and one of `system.columns` for the allowlisted
 * databases, filtered to the allowlist here; it runs when a data source is saved, from Re-sync schema,
 * daily from the sweeper, and for one table when a lookup misses (lazy miss). A user who cannot read
 * `system` falls back to SHOW DATABASES / SHOW TABLES / DESCRIBE TABLE (at most 500 tables that way).
 * Every read is filtered to the current allowlist again, so a narrowed allowlist hides tables at once.
 * These statements are Nook's own, fixed text with quoted literals: they skip the guard but not the
 * per-query settings.
 */

type TableRow = {
  id: number; datasource_id: string; db: string; name: string; engine: string; partition_key: string; sorting_key: string; primary_key: string;
  total_rows: number | null; total_bytes: number | null; comment: string; columns_json: string; synced_at: string;
};

const SHOW_MODE_TABLES = 500;
const SYSTEM_DATABASES = "('system', 'INFORMATION_SCHEMA', 'information_schema')";

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const text = (value: unknown) => value === null || value === undefined ? "" : String(value);

function parseColumns(json: string): CatalogColumn[] {
  try {
    const value = JSON.parse(json) as CatalogColumn[];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function tableOf(row: TableRow): CatalogTable {
  return {
    db: row.db, name: row.name, engine: row.engine, partitionKey: row.partition_key, sortingKey: row.sorting_key, primaryKey: row.primary_key,
    totalRows: row.total_rows, totalBytes: row.total_bytes, comment: row.comment, columns: parseColumns(row.columns_json), syncedAt: row.synced_at
  };
}

type Fetched = Omit<CatalogTable, "syncedAt">;

const searchColumns = (columns: readonly CatalogColumn[]) => columns.map((column) => `${column.name} ${column.comment}`.trim()).join(" ").slice(0, 100_000);

function upsert(datasourceId: string, table: Fetched, at: string) {
  db.query(`INSERT INTO report_schema_tables (datasource_id, db, name, engine, partition_key, sorting_key, primary_key, total_rows, total_bytes, comment, columns_json, search_name, search_columns, synced_at)
    VALUES ($ds, $db, $name, $engine, $partition, $sorting, $primary, $rows, $bytes, $comment, $columns, $searchName, $searchColumns, $at)
    ON CONFLICT (datasource_id, db, name) DO UPDATE SET engine = excluded.engine, partition_key = excluded.partition_key, sorting_key = excluded.sorting_key,
      primary_key = excluded.primary_key, total_rows = excluded.total_rows, total_bytes = excluded.total_bytes, comment = excluded.comment,
      columns_json = excluded.columns_json, search_name = excluded.search_name, search_columns = excluded.search_columns, synced_at = excluded.synced_at`).run({
    ds: datasourceId, db: table.db, name: table.name, engine: table.engine, partition: table.partitionKey, sorting: table.sortingKey, primary: table.primaryKey,
    rows: table.totalRows, bytes: table.totalBytes, comment: table.comment.slice(0, 4000), columns: JSON.stringify(table.columns),
    searchName: `${table.db} ${table.name}`, searchColumns: searchColumns(table.columns), at
  });
}

const BIG = { maxResultRows: 2_000_000, responseBytes: 96 * 1024 * 1024 };

/** The tables and columns of `system`, for the allowlisted tables (the bulk path). */
async function fetchFromSystem(target: ChTarget, patterns: readonly string[], only?: { db: string; name: string }): Promise<{ tables: Fetched[]; truncated: boolean }> {
  const where = only ? `database = ${sqlString(only.db)} AND name = ${sqlString(only.name)}` : `database NOT IN ${SYSTEM_DATABASES} AND NOT is_temporary`;
  const tablesResult = await chQuery(target, `SELECT database, name, engine, partition_key, sorting_key, primary_key, total_rows, total_bytes, comment FROM system.tables WHERE ${where} ORDER BY database, name`,
    { queryId: queryIdFor("schema", "tables", crypto.randomUUID().slice(0, 8)), ...BIG });
  let rows = tablesResult.rows.filter((row) => tableAllowed(patterns, text(row[0]), text(row[1])));
  const truncated = rows.length > REPORT_LIMITS.catalogTables;
  rows = rows.slice(0, REPORT_LIMITS.catalogTables);
  const tables = new Map<string, Fetched>();
  for (const row of rows) {
    tables.set(`${text(row[0])}\u0000${text(row[1])}`, {
      db: text(row[0]), name: text(row[1]), engine: text(row[2]), partitionKey: text(row[3]), sortingKey: text(row[4]), primaryKey: text(row[5]),
      totalRows: toNumber(row[6]), totalBytes: toNumber(row[7]), comment: text(row[8]), columns: []
    });
  }
  const databases = [...new Set(rows.map((row) => text(row[0])))];
  if (databases.length) {
    const columnWhere = only ? `database = ${sqlString(only.db)} AND table = ${sqlString(only.name)}` : `database IN (${databases.map(sqlString).join(", ")})`;
    const columnsResult = await chQuery(target, `SELECT database, table, name, type, comment, default_kind FROM system.columns WHERE ${columnWhere} ORDER BY database, table, position`,
      { queryId: queryIdFor("schema", "columns", crypto.randomUUID().slice(0, 8)), ...BIG });
    for (const row of columnsResult.rows) {
      const table = tables.get(`${text(row[0])}\u0000${text(row[1])}`);
      if (table) table.columns.push({ name: text(row[2]), type: text(row[3]), comment: text(row[4]).slice(0, 1000), defaultKind: text(row[5]) });
    }
  }
  return { tables: [...tables.values()], truncated };
}

const firstColumn = (result: ChResult) => result.rows.map((row) => text(row[0]));

/** DESCRIBE TABLE as catalog columns. */
async function describe(target: ChTarget, dbName: string, name: string): Promise<CatalogColumn[]> {
  const result = await chQuery(target, `DESCRIBE TABLE ${sqlIdentifier(dbName)}.${sqlIdentifier(name)}`, { queryId: queryIdFor("schema", "describe", crypto.randomUUID().slice(0, 8)) });
  const index = (column: string) => result.columns.findIndex((item) => item.name === column);
  const [nameAt, typeAt, kindAt, commentAt] = [index("name"), index("type"), index("default_type"), index("comment")];
  return result.rows.map((row) => ({ name: text(row[nameAt]), type: text(row[typeAt]), defaultKind: kindAt >= 0 ? text(row[kindAt]) : "", comment: commentAt >= 0 ? text(row[commentAt]).slice(0, 1000) : "" }));
}

/** The SHOW / DESCRIBE path, for users who cannot read `system`. */
async function fetchWithShow(target: ChTarget, patterns: readonly string[], only?: { db: string; name: string }): Promise<{ tables: Fetched[]; truncated: boolean }> {
  let names: Array<{ db: string; name: string }> = [];
  if (only) names = [only];
  else {
    const databases = firstColumn(await chQuery(target, "SHOW DATABASES", { queryId: queryIdFor("schema", "dbs", crypto.randomUUID().slice(0, 8)) })).filter((name) => databaseAllowed(patterns, name));
    for (const dbName of databases) {
      const tables = firstColumn(await chQuery(target, `SHOW TABLES FROM ${sqlIdentifier(dbName)}`, { queryId: queryIdFor("schema", "show", crypto.randomUUID().slice(0, 8)), ...BIG }));
      names.push(...tables.filter((name) => tableAllowed(patterns, dbName, name)).map((name) => ({ db: dbName, name })));
      if (names.length > SHOW_MODE_TABLES) break;
    }
  }
  const truncated = names.length > SHOW_MODE_TABLES;
  const tables: Fetched[] = [];
  for (const item of names.slice(0, SHOW_MODE_TABLES)) {
    try {
      tables.push({ db: item.db, name: item.name, engine: "", partitionKey: "", sortingKey: "", primaryKey: "", totalRows: null, totalBytes: null, comment: "", columns: await describe(target, item.db, item.name) });
    } catch (error) {
      if (only) throw error;
    }
  }
  return { tables, truncated };
}

/** Whether a ClickHouse error means "this user cannot read system tables" (so SHOW/DESCRIBE is tried). */
const systemRefused = (error: unknown) => error instanceof ChError && (error.chCode === 497 || error.chName === "ACCESS_DENIED" || error.chCode === 60 || error.chName === "UNKNOWN_TABLE");

async function fetchTables(target: ChTarget, patterns: readonly string[], only?: { db: string; name: string }) {
  try {
    return { ...(await fetchFromSystem(target, patterns, only)), mode: "system" as const };
  } catch (error) {
    if (!systemRefused(error)) throw error;
    return { ...(await fetchWithShow(target, patterns, only)), mode: "show" as const };
  }
}

const inflight = new Map<string, Promise<SchemaSyncResult>>();

/**
 * Re-reads the whole allowlisted layout of a data source and replaces its cache in one transaction.
 * Concurrent calls for one data source share one sync. A failure is recorded on the data source
 * (`schema_error`, shown in Settings) and thrown; the old cache stays.
 */
export function syncSchema(datasourceId: string): Promise<SchemaSyncResult> {
  const running = inflight.get(datasourceId);
  if (running) return running;
  const work = (async (): Promise<SchemaSyncResult> => {
    const row = datasourceRow(datasourceId);
    const patterns = allowlistOf(row);
    const started = Date.now();
    try {
      const fetched = patterns.length ? await fetchTables(datasourceTarget(row), patterns) : { tables: [], truncated: false, mode: "system" as const };
      const at = now();
      db.transaction(() => {
        if (!db.query("SELECT 1 FROM report_datasources WHERE id = ?").get(datasourceId)) return;
        for (const table of fetched.tables) upsert(datasourceId, table, at);
        db.query("DELETE FROM report_schema_tables WHERE datasource_id = ? AND synced_at <> ?").run(datasourceId, at);
        db.query("UPDATE report_datasources SET schema_synced_at = ?, schema_table_count = ?, schema_truncated = ?, schema_error = NULL WHERE id = ?")
          .run(at, fetched.tables.length, fetched.truncated ? 1 : 0, datasourceId);
      })();
      const synced = { tables: fetched.tables.length, columns: fetched.tables.reduce((sum, table) => sum + table.columns.length, 0), mode: fetched.mode, truncated: fetched.truncated, ms: Date.now() - started };
      logger("reports").info("Schema synced", { datasource: shortId(datasourceId), ...synced });
      return synced;
    } catch (error) {
      logger("reports").warn("Schema sync failed", { datasource: shortId(datasourceId), ms: Date.now() - started, err: error });
      const message = error instanceof Error && error.name !== "Error" ? error.message : "The schema could not be read";
      db.query("UPDATE report_datasources SET schema_error = ? WHERE id = ?").run(message.slice(0, 500), datasourceId);
      throw error;
    }
  })().finally(() => inflight.delete(datasourceId));
  inflight.set(datasourceId, work);
  return work;
}

/** Starts a sync without waiting (data source saved); a failure is recorded, never thrown. */
export function startSchemaSync(datasourceId: string) {
  void syncSchema(datasourceId).catch(() => undefined);
}

const lastDailyAttempt = new Map<string, number>();
const DAY_MS = 86_400_000;

/** The sweeper's daily re-sync: enabled data sources whose cache is a day old (one attempt an hour at most when it fails). */
export function sweepSchemaSync(nowMs = Date.now()): number {
  const rows = db.query("SELECT id, schema_synced_at FROM report_datasources WHERE enabled = 1").all() as Array<{ id: string; schema_synced_at: string | null }>;
  let started = 0;
  for (const row of rows) {
    const synced = row.schema_synced_at ? Date.parse(row.schema_synced_at) : 0;
    if (nowMs - synced < DAY_MS) continue;
    if (nowMs - (lastDailyAttempt.get(row.id) ?? 0) < DAY_MS / 24) continue;
    lastDailyAttempt.set(row.id, nowMs);
    startSchemaSync(row.id);
    started += 1;
  }
  return started;
}

// ------------------------------------------------------------------------------------- reading

/** `db.table` (or `table` in the data source's database) as its parts; null when malformed. */
export function parseTableName(value: string, defaultDb: string): { db: string; name: string } | null {
  const trimmed = value.trim().replace(/`/g, "");
  const match = /^([A-Za-z0-9_]{1,128})(?:\.([A-Za-z0-9_.-]{1,256}))?$/.exec(trimmed);
  if (!match) return null;
  return match[2] === undefined ? { db: defaultDb, name: match[1]! } : { db: match[1]!, name: match[2]! };
}

function cachedTable(datasourceId: string, dbName: string, name: string): TableRow | null {
  return db.query("SELECT * FROM report_schema_tables WHERE datasource_id = ? AND db = ? AND name = ?").get(datasourceId, dbName, name) as TableRow | null;
}

/** FTS words of a free-text query (letters and digits; at most 8). */
export function searchTerms(query: string): string[] {
  return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 2 || /\d/.test(word)))].slice(0, 8);
}

/**
 * `search_schema`: FTS over the catalog, best first (table names weigh most, then table comments,
 * then columns), an exact `table` or `db.table` match first of all. No ClickHouse round trip.
 */
export function searchSchema(row: DatasourceRow, query: string, limit: number = REPORT_LIMITS.searchResults): SchemaSearchHit[] {
  const terms = searchTerms(query);
  const take = Math.min(Math.max(1, Math.floor(limit)), REPORT_LIMITS.searchResults);
  if (!terms.length) return [];
  const patterns = allowlistOf(row);
  const match = terms.map((term) => `"${term.replace(/"/g, "")}"*`).join(" OR ");
  const rows = db.query(`SELECT t.*, bm25(report_schema_fts, 10.0, 3.0, 1.0) AS score FROM report_schema_fts JOIN report_schema_tables t ON t.id = report_schema_fts.rowid
    WHERE report_schema_fts MATCH ? AND t.datasource_id = ? ORDER BY score LIMIT ?`).all(match, row.id, take * 4) as Array<TableRow & { score: number }>;
  const exact = query.trim().toLowerCase();
  const allowed = rows.filter((item) => tableAllowed(patterns, item.db, item.name));
  allowed.sort((left, right) => {
    const leftExact = left.name.toLowerCase() === exact || `${left.db}.${left.name}`.toLowerCase() === exact ? 0 : 1;
    const rightExact = right.name.toLowerCase() === exact || `${right.db}.${right.name}`.toLowerCase() === exact ? 0 : 1;
    return leftExact - rightExact || left.score - right.score;
  });
  return allowed.slice(0, take).map((item) => {
    const columns = parseColumns(item.columns_json);
    const matching = columns.filter((column) => terms.some((term) => column.name.toLowerCase().includes(term) || column.comment.toLowerCase().includes(term))).map((column) => column.name);
    return { table: `${item.db}.${item.name}`, comment: item.comment.slice(0, 300), totalRows: item.total_rows, matchingColumns: matching.slice(0, 10) };
  });
}

export type TableListItem = { table: string; comment: string; totalRows: number | null; columns: number; engine: string };

/** `list_tables`: the catalog in name order, 50 a page, optionally one database and a name filter. */
export function listTables(row: DatasourceRow, options: { db?: string; like?: string; page?: number } = {}): { tables: TableListItem[]; page: number; hasMore: boolean; databases: string[] } {
  const patterns = allowlistOf(row);
  const page = Math.max(0, Math.floor(options.page ?? 0));
  const size = REPORT_LIMITS.listPage;
  const like = options.like?.trim().toLowerCase().slice(0, 100) ?? "";
  const rows = (db.query(`SELECT db, name, comment, total_rows, engine, json_array_length(columns_json) AS columns FROM report_schema_tables
    WHERE datasource_id = $ds AND ($db IS NULL OR db = $db) AND ($like = '' OR instr(lower(name), $like) > 0 OR instr(lower(comment), $like) > 0)
    ORDER BY db, name`).all({ ds: row.id, db: options.db ?? null, like }) as Array<{ db: string; name: string; comment: string; total_rows: number | null; engine: string; columns: number }>)
    .filter((item) => tableAllowed(patterns, item.db, item.name));
  const databases = [...new Set((db.query("SELECT DISTINCT db FROM report_schema_tables WHERE datasource_id = ? ORDER BY db").all(row.id) as Array<{ db: string }>).map((item) => item.db))]
    .filter((name) => databaseAllowed(patterns, name));
  const slice = rows.slice(page * size, page * size + size);
  return {
    tables: slice.map((item) => ({ table: `${item.db}.${item.name}`, comment: item.comment.slice(0, 300), totalRows: item.total_rows, columns: item.columns, engine: item.engine })),
    page, hasMore: rows.length > (page + 1) * size, databases
  };
}

/**
 * `describe_tables`: up to 10 tables with their keys and columns. A table missing from the cache but
 * on the allowlist is read from ClickHouse now and cached (lazy miss); anything else is `missing`
 * (not on the allowlist and not existing look the same).
 */
export async function describeTables(row: DatasourceRow, names: readonly string[]): Promise<{ tables: CatalogTable[]; missing: string[] }> {
  const patterns = allowlistOf(row);
  const tables: CatalogTable[] = [];
  const missing: string[] = [];
  for (const raw of [...new Set(names)].slice(0, REPORT_LIMITS.describeBatch)) {
    const parsed = parseTableName(raw, row.database);
    if (!parsed || !tableAllowed(patterns, parsed.db, parsed.name)) {
      missing.push(raw.slice(0, 200));
      continue;
    }
    let cached = cachedTable(row.id, parsed.db, parsed.name);
    if (!cached) {
      const fetched = await fetchTables(datasourceTarget(row), patterns, parsed);
      const table = fetched.tables.find((item) => item.db === parsed.db && item.name === parsed.name);
      if (table) {
        upsert(row.id, table, now());
        db.query("UPDATE report_datasources SET schema_table_count = (SELECT COUNT(*) FROM report_schema_tables WHERE datasource_id = ?) WHERE id = ?").run(row.id, row.id);
        cached = cachedTable(row.id, parsed.db, parsed.name);
      }
    }
    if (cached) tables.push(tableOf(cached));
    else missing.push(`${parsed.db}.${parsed.name}`);
  }
  return { tables, missing };
}

/** Catalog tables named in a text (backticked identifiers and `db.table` words), for doc-first seeding (wave 46). */
export function tablesNamedIn(row: DatasourceRow, textValue: string, limit = 20): CatalogTable[] {
  const patterns = allowlistOf(row);
  const candidates = new Set<string>();
  for (const match of textValue.matchAll(/`([A-Za-z0-9_.]{2,200})`/g)) candidates.add(match[1]!);
  for (const match of textValue.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{0,127}\.[A-Za-z_][A-Za-z0-9_]{0,127})\b/g)) candidates.add(match[1]!);
  const found: CatalogTable[] = [];
  for (const candidate of candidates) {
    const parsed = parseTableName(candidate, row.database);
    if (!parsed || !tableAllowed(patterns, parsed.db, parsed.name)) continue;
    const cached = cachedTable(row.id, parsed.db, parsed.name) ?? (db.query("SELECT * FROM report_schema_tables WHERE datasource_id = ? AND name = ? LIMIT 1").get(row.id, candidate) as TableRow | null);
    if (cached && !found.some((table) => table.db === cached.db && table.name === cached.name)) found.push(tableOf(cached));
    if (found.length >= limit) break;
  }
  return found;
}
