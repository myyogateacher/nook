/**
 * Analytics reports (module id `reports`, waves 45–48, docs/plan/WAVES_45-48_REPORTS.md, D410–D429).
 * The vocabulary the server, the client, and the later waves share. **Frozen after Wave 45**: waves 46
 * (generation) and 47 (viewer, refresh, scheduler) are built against these types in parallel, so a
 * change here is a change to all three; add, never rename.
 *
 * Pure: no imports from server or client code, no zod, so the client bundle and tests load it as is.
 */

// ------------------------------------------------------------------------------------------ limits

export const REPORT_LIMITS = {
  /** Queries one report spec may hold (plan: ≤12). */
  queries: 12,
  /** Blocks one report spec may hold (plan: ≤20). */
  blocks: 20,
  /** Agent steps for one generation or edit run (plan: ≤12). */
  steps: 12,
  /** A query's SQL, in characters. */
  sqlChars: 20_000,
  /** A query key: `[a-z][a-z0-9_]{0,39}`. */
  queryKey: 40,
  /** A query's purpose line. */
  purpose: 300,
  /** A block id: `[a-z0-9_-]{1,40}`. */
  blockId: 40,
  /** A block title. */
  blockTitle: 120,
  /** A markdown block's text. */
  markdown: 20_000,
  /** y columns on one chart. */
  chartSeries: 8,
  /** Columns shown by a table block (empty: every column). */
  tableColumns: 30,
  /** A report title. */
  title: 200,
  /** Rows a data source may return per query (the admin's max_rows ceiling). */
  maxRowsCeiling: 100_000,
  /** The default max_rows of a new data source. */
  maxRowsDefault: 10_000,
  /** A data source's per-query timeout, seconds (default and ceiling). */
  timeoutDefaultS: 20,
  timeoutCeilingS: 120,
  /** Rows a stored result keeps (report_results.rows_json); more is `truncated`. */
  storedRows: 10_000,
  /** Bytes a stored result keeps. */
  storedResultBytes: 2 * 1024 * 1024,
  /** Response bytes read from ClickHouse per query (the plan's ~8 MiB). */
  responseBytes: 8 * 1024 * 1024,
  /** Rows the manual SQL console shows. */
  consoleRows: 1_000,
  /** Allowlist patterns on one data source. */
  allowlistPatterns: 100,
  /** search_schema results. */
  searchResults: 20,
  /** list_tables page size. */
  listPage: 50,
  /** describe_tables batch. */
  describeBatch: 10,
  /** sample_rows rows. */
  sampleRows: 5,
  /** Cached tables per data source (the sync stops there and says so). */
  catalogTables: 20_000,
  /** Doc snapshot markdown, bytes. */
  docBytes: 512 * 1024,
  /** Runs kept per report (wave 47). */
  runsKept: 20,
  /** Consecutive scheduled failures before a schedule turns itself off (wave 47). */
  scheduleFailures: 5
} as const;

export const QUERY_KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const BLOCK_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

// --------------------------------------------------------------------------------------- the spec

export const CHART_KINDS = ["line", "area", "bar", "stacked_bar", "horizontal_bar", "pie", "scatter"] as const;
export type ChartKind = typeof CHART_KINDS[number];

/** How a number is shown (KPI tiles, chart axes, table cells). */
export const VALUE_FORMATS = ["number", "integer", "percent", "currency", "bytes", "duration_s", "date", "datetime", "text"] as const;
export type ValueFormat = typeof VALUE_FORMATS[number];

/**
 * Who made or last changed a block (the inspect panel's Provenance tab, wave 47): the report run that
 * produced it, the instruction that caused it (wave 48), and the spec version it was stamped in.
 */
export type BlockProvenance = { runId: string | null; instructionId?: string | null; version: number; /** The doc snapshot the run worked from (report_runs.doc_snapshot_id). */ docSnapshotId?: string | null };

type BlockBase = { id: string; title?: string; provenance?: BlockProvenance };

export type MarkdownBlock = BlockBase & { type: "markdown"; markdown: string };
/** One value: `column` of the first row of `queryKey`'s result; `compareColumn` an optional previous value. */
export type KpiBlock = BlockBase & { type: "kpi"; queryKey: string; column: string; format?: ValueFormat; compareColumn?: string; label?: string };
export type ChartBlock = BlockBase & {
  type: "chart";
  queryKey: string;
  kind: ChartKind;
  /** The category or time column. */
  x: string;
  /** One or more numeric columns. */
  y: string[];
  /** A column whose values split y into series (long-format results). */
  series?: string;
  format?: ValueFormat;
};
export type TableBlock = BlockBase & { type: "table"; queryKey: string; columns?: string[]; formats?: Record<string, ValueFormat> };
export type ReportBlock = MarkdownBlock | KpiBlock | ChartBlock | TableBlock;
export const BLOCK_TYPES = ["markdown", "kpi", "chart", "table"] as const;
export type BlockType = typeof BLOCK_TYPES[number];

export type QueryAuthor = "agent" | "user";

/** A saved query: the exact SQL as saved (the guard wraps it at run time; `sent_sql` is stored per result). */
export type ReportQuery = { key: string; sql: string; purpose: string; createdBy: QueryAuthor };

export type ReportSpec = { version: 1; blocks: ReportBlock[]; queries: ReportQuery[] };
export const EMPTY_SPEC: ReportSpec = { version: 1, blocks: [], queries: [] };

/** Every query key a spec's blocks reference. */
export const blockQueryKeys = (spec: ReportSpec) => [...new Set(spec.blocks.flatMap((block) => block.type === "markdown" ? [] : [block.queryKey]))];

// ----------------------------------------------------------------------------- reports and runs

export const REPORT_STATUSES = ["draft", "ready", "stale", "error"] as const;
export type ReportStatus = typeof REPORT_STATUSES[number];

export const RUN_KINDS = ["generate", "refresh", "edit"] as const;
export type RunKind = typeof RUN_KINDS[number];
export const RUN_TRIGGERS = ["user", "schedule", "mcp"] as const;
export type RunTrigger = typeof RUN_TRIGGERS[number];
export const RUN_STATUSES = ["running", "succeeded", "partial", "failed", "abandoned"] as const;
export type RunStatus = typeof RUN_STATUSES[number];

export type ReportSummary = {
  id: string;
  title: string;
  datasourceId: string | null;
  datasourceName: string | null;
  status: ReportStatus;
  isOwner: boolean;
  ownerName: string;
  blockCount: number;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type ReportDetail = ReportSummary & {
  spec: ReportSpec;
  /** Wave 46: the doc the report was generated from (tool server, tool, reference). */
  doc: { serverId: string | null; tool: string | null; ref: string | null; hash: string | null } | null;
  lastError: string | null;
};

export type ReportRun = {
  id: string;
  reportId: string;
  kind: RunKind;
  trigger: RunTrigger;
  status: RunStatus;
  agentRunId: string | null;
  /** The doc snapshot a generate or edit run worked from. */
  docSnapshotId: string | null;
  /** A per-block refresh names its one query; null is every query. */
  queryKeys: string[] | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

export type ResultColumn = { name: string; type: string };

/**
 * One query's result in one run (report_results). `sentSql` is the wrapped SQL actually sent (guard
 * LIMIT added), `chQueryId` the ClickHouse query id, `rowsRead` ClickHouse's rows read.
 */
export type ReportResult = {
  runId: string;
  queryKey: string;
  sql: string;
  sentSql: string | null;
  columns: ResultColumn[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  rowsRead: number | null;
  bytesRead: number | null;
  chQueryId: string | null;
  ms: number | null;
  error: string | null;
  errorCode: string | null;
  createdAt: string;
};

// -------------------------------------------------------------------------------- schedules (47)

/** `cadence` is one of shared/routineSchedule.ts CADENCES; `weekday` 0 is Sunday. */
export type ReportSchedule = { cadence: string; atTime: string | null; weekday: number | null; tz: string; enabled: boolean; nextDueAt: string | null; failCount: number };

// ----------------------------------------------------------------------------------- data sources

export const DATASOURCE_KINDS = ["clickhouse"] as const;
export type DatasourceKind = typeof DATASOURCE_KINDS[number];

/** What an admin sees (the password never leaves the server; only `hasPassword`). */
export type DatasourceSummary = {
  id: string;
  name: string;
  kind: DatasourceKind;
  url: string;
  username: string;
  database: string;
  allowlist: string[];
  maxRows: number;
  timeoutS: number;
  enabled: boolean;
  hasPassword: boolean;
  schema: { syncedAt: string | null; tables: number; error: string | null; truncated: boolean };
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/** What a report author sees when picking a data source. */
export type DatasourceChoice = { id: string; name: string; database: string };

export type ConnectionTest = {
  ok: boolean;
  version: string | null;
  user: string | null;
  /** The user's profile `readonly` setting (0 can write unless grants forbid it). */
  readonly: number | null;
  /** Grants that let this user change data (INSERT, ALTER, CREATE, DROP, …). */
  writeGrants: string[];
  warnings: string[];
  error: string | null;
  ms: number;
};

// ---------------------------------------------------------------------------------- schema catalog

export type CatalogColumn = { name: string; type: string; comment: string; defaultKind: string };
export type CatalogTable = {
  db: string;
  name: string;
  engine: string;
  partitionKey: string;
  sortingKey: string;
  primaryKey: string;
  totalRows: number | null;
  totalBytes: number | null;
  comment: string;
  columns: CatalogColumn[];
  syncedAt: string;
};
export type SchemaSearchHit = { table: string; comment: string; totalRows: number | null; matchingColumns: string[] };
export type SchemaSyncResult = { tables: number; columns: number; mode: "system" | "show"; truncated: boolean; ms: number };

// -------------------------------------------------------------------------------------- the guard

export const GUARD_CODES = [
  "EMPTY", "TOO_LONG", "MULTI_STATEMENT", "NOT_SELECT", "BANNED_KEYWORD", "BANNED_FUNCTION", "BANNED_TABLE",
  "NOT_ALLOWED_TABLE", "UNSUPPORTED_SYNTAX", "UNTERMINATED", "NON_ASCII", "METADATA_FORBIDDEN"
] as const;
export type GuardCode = typeof GUARD_CODES[number];

/** `select`: rows from allowlisted tables; `metadata`: SHOW / DESCRIBE / EXISTS / EXPLAIN, or a read of the allowed system tables. */
export type StatementClass = "select" | "metadata";

/** A query's outcome in the manual console and the schema tools. */
export type QueryOutcome = {
  class: StatementClass;
  columns: ResultColumn[];
  rows: unknown[][];
  truncated: boolean;
  sentSql: string;
  chQueryId: string;
  rowsRead: number | null;
  bytesRead: number | null;
  ms: number;
};

/** Every `code` the reports routes answer with (review L5). */
export const REPORT_ERROR_CODES = [
  "GUARD", "CLICKHOUSE", "TIMEOUT", "TOO_LARGE", "UNREACHABLE", "NOT_CONFIGURED", "RUN_IN_PROGRESS", "DOC_FETCH", "MCP_AUTH",
  "NOT_FOUND", "INVALID", "BUSY", "CANCELLED", "NO_DATASOURCE", "DATASOURCE_DISABLED", "LIMIT_REACHED", "REVISION_CONFLICT", "NAME_TAKEN",
  "INVALID_URL", "INVALID_DATABASE", "INVALID_ALLOWLIST", "ROLE_READ_ONLY"
] as const;
export type ReportErrorCode = typeof REPORT_ERROR_CODES[number];
