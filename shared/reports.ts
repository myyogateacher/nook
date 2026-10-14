/**
 * Analytics reports (module id `reports`, waves 45–48, docs/plan/WAVES_45-48_REPORTS.md, D410–D429).
 * The vocabulary the server, the client, and the later waves share. Frozen after Wave 45 for waves
 * 46 and 47; wave 48b (D430–D436) adds spec v2 (intents, layout slots, sections, number formats) with
 * a v1 → v2 upgrade on read, so stored specs keep rendering. Add, never rename.
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

export const CHART_KINDS = [
  "line", "area", "bar", "stacked_bar", "horizontal_bar", "pie", "scatter",
  // Round 2 (docs/plan/REPORT_THEME.md § Chart kinds, round 2; D462–D468).
  "heatmap", "calendar", "funnel", "gauge", "treemap", "sankey", "boxplot", "histogram", "waterfall", "combo", "bullet"
] as const;
export type ChartKind = typeof CHART_KINDS[number];
/** Kinds that draw without an x column (a gauge reads one value; a histogram bins its one y column). */
export const KINDS_WITHOUT_X: readonly ChartKind[] = ["gauge", "histogram"];
/** Kinds that read a second dimension `x2`: heatmap rows (required), sankey targets (required), a treemap's second level (optional). */
export const KINDS_WITH_X2: readonly ChartKind[] = ["heatmap", "sankey", "treemap"];
/** Kinds that may stack (`stack`): stacked area, and normal or 100 % stacked bars. */
export const STACKABLE_KINDS: readonly ChartKind[] = ["area", "bar", "stacked_bar", "horizontal_bar"];
/** Kinds that may split into small multiples (`facet`). */
export const FACETABLE_KINDS: readonly ChartKind[] = ["line", "bar", "area"];
export const STACK_MODES = ["normal", "percent"] as const;
export type StackMode = typeof STACK_MODES[number];

/**
 * The v1 formats (wave 45): still read and rendered, so stored specs show as before. A v2 spec the
 * model writes uses SPEC_FORMATS instead (number, percent, currency:<ISO>, duration).
 */
export const VALUE_FORMATS = ["number", "integer", "percent", "currency", "bytes", "duration_s", "date", "datetime", "text"] as const;
export type LegacyValueFormat = typeof VALUE_FORMATS[number];
/** Spec v2's number formats (D431): an enum, never a format string. `currency:<ISO 4217>`, `duration` in seconds. */
export const SPEC_FORMATS = ["number", "percent", "currency:<ISO>", "duration"] as const;
export const SPEC_FORMAT = /^(?:number|percent|duration|currency:[A-Z]{3})$/;
export type SpecFormat = "number" | "percent" | "duration" | `currency:${string}`;
/** How a number is shown (KPI tiles, chart axes, table cells). */
export type ValueFormat = LegacyValueFormat | SpecFormat;
/** A unit word shown after a value ("orders", "ms", "users"): letters, spaces, `/`, `%`, `°`, `µ`; never CSS or a pixel size. */
export const UNIT = /^(?!.*\b\d*px\b)[A-Za-z%°µ/ .-]{1,24}$/;

/** What a block is for (D431): drives the chart choice and the design rules. */
export const BLOCK_INTENTS = ["trend", "compare", "rank", "share", "distribution", "relationship", "headline", "detail", "delta", "matrix", "conversion", "attainment", "flow"] as const;
export type BlockIntent = typeof BLOCK_INTENTS[number];
/** Layout slots: full = 12 columns, half = 6, third = 4 (docs/plan/REPORT_THEME.md § Layout). */
export const BLOCK_WIDTHS = ["full", "half", "third"] as const;
export type BlockWidth = typeof BLOCK_WIDTHS[number];

/**
 * Who made or last changed a block (the inspect panel's Provenance tab, wave 47): the report run that
 * produced it, the instruction that caused it (wave 48), and the spec version it was stamped in.
 */
export type BlockProvenance = { runId: string | null; instructionId?: string | null; version: number; /** The doc snapshot the run worked from (report_runs.doc_snapshot_id). */ docSnapshotId?: string | null };

/** A deterministic fix Nook applied instead of a retry (design rules 3 and 5, sorting, compaction); the Mapping tab lists them. */
export const AUTO_FIX_RULES = ["fold_series", "fold_categories", "sort", "compact", "facet", "fold_panels", "fold_groups", "bin", "quartiles"] as const;
export type AutoFix = { rule: typeof AUTO_FIX_RULES[number]; detail: string };

type BlockBase = {
  id: string;
  title?: string;
  provenance?: BlockProvenance;
  /** v2: what the block is for. */
  intent?: BlockIntent;
  /** v2: its layout slot (default: full for markdown and tables, half for charts). */
  width?: BlockWidth;
  /** v2: the id of the section it sits in (none: the KPI strip for KPIs, else the untitled section). */
  section?: string;
  /** v2: set by Nook, never by the model. */
  autoFixes?: AutoFix[];
  /**
   * Set by the v1 → v2 upgrade (never by the model): the block predates the design rules, so it is
   * exempt from the per-block rules until it is edited, and its bars keep the order of its rows.
   */
  legacy?: boolean;
};

/** A query and column (KPI comparisons and sparklines may read another query). */
export type ColumnRef = { queryKey?: string; column: string };

export type MarkdownBlock = BlockBase & { type: "markdown"; markdown: string };
/**
 * One value: `column` of the first row of `queryKey`'s result. `compareTo` is the previous value (a
 * column of the same row, or the first row of another query); `compareColumn` is v1's form of it.
 */
export type KpiBlock = BlockBase & {
  type: "kpi"; queryKey: string; column: string; format?: ValueFormat; label?: string;
  /** v1: read on upgrade as `compareTo: {column}`. */
  compareColumn?: string;
  compareTo?: ColumnRef;
  /** Whether a rise is good (default true): the delta's colour. */
  upIsGood?: boolean;
  /** What the delta compares against, as plain text ("vs prior 2 weeks"); default "vs previous period", never a column name. */
  compareLabel?: string;
  unit?: string;
  /** The one hero figure of the report (≥ 48 px). */
  hero?: boolean;
  /** A small trend under the value: `y` over `x` of a query's rows. */
  sparkline?: { queryKey: string; x: string; y: string };
};
export type ChartBlock = BlockBase & {
  type: "chart";
  queryKey: string;
  kind: ChartKind;
  /** The category or time column (every kind but gauge and histogram). */
  x: string;
  /** One or more numeric columns. */
  y: string[];
  /** A column whose values split y into series (long-format results). */
  series?: string;
  format?: ValueFormat;
  unit?: string;
  /** Emphasis mode: this series (a y column or a series value), or this category of a one-series chart, in amber; the rest grey. */
  emphasis?: string;
  upIsGood?: boolean;
  /** A comparison measure (a column of the same result), drawn muted and dashed. */
  compareTo?: ColumnRef;
  // ---- round 2 (D462): each field belongs to the kinds named; checkSpecShape refuses it elsewhere.
  /** The second dimension: heatmap rows (cohorts), sankey target nodes, a treemap's second level. */
  x2?: string;
  /** heatmap: values on both sides of it draw on the diverging ramp, centred here. */
  midpoint?: number;
  /** heatmap: rows are cohorts and columns periods (rows keep their order; percent values label the cells). */
  cohort?: boolean;
  /** gauge and bullet: the column holding the target. */
  target?: string;
  /** gauge: the scale's maximum when there is no target column. */
  max?: number;
  /** bullet: up to three columns of ascending band limits (poor, fair, good). */
  ranges?: string[];
  /** waterfall: the first row is the starting total, not a step. */
  start?: boolean;
  /** waterfall: a total bar after the last step. */
  total?: boolean;
  /** combo: each measure's unit, which must be the same (there is never a second axis). */
  yUnits?: string[];
  /** area and bars: stacked (`normal`), or each category's parts as shares of 100 % (`percent`). */
  stack?: StackMode;
  /** line, bar, area: one small chart per value of this column, on a shared y scale. */
  facet?: string;
};
export type TableBlock = BlockBase & { type: "table"; queryKey: string; columns?: string[]; formats?: Record<string, ValueFormat> };
export type ReportBlock = MarkdownBlock | KpiBlock | ChartBlock | TableBlock;
export const BLOCK_TYPES = ["markdown", "kpi", "chart", "table"] as const;
export type BlockType = typeof BLOCK_TYPES[number];

export type QueryAuthor = "agent" | "user";

/** A saved query: the exact SQL as saved (the guard wraps it at run time; `sent_sql` is stored per result). */
export type ReportQuery = { key: string; sql: string; purpose: string; createdBy: QueryAuthor };

/** A section: an optional heading and summary over the blocks that name it. */
export type ReportSection = { id: string; title: string; summary?: string };

/** The spec as wave 45–47 stored it. */
export type ReportSpecV1 = { version: 1; blocks: ReportBlock[]; queries: ReportQuery[] };
/**
 * Spec v2 (wave 48b): `version` stays 1 (the stored family), `specVersion: 2` marks the shape with
 * sections and the v2 block fields. Read every stored spec through `upgradeSpec`.
 */
export type ReportSpec = { version: 1; specVersion: 2; sections: ReportSection[]; blocks: ReportBlock[]; queries: ReportQuery[] };
export const SPEC_VERSION = 2;
export const EMPTY_SPEC: ReportSpec = { version: 1, specVersion: 2, sections: [], blocks: [], queries: [] };
export const SECTION_LIMITS = { sections: 10, title: 120, summary: 600 } as const;

/** Every query key a spec's blocks reference (KPI comparisons and sparklines included). */
export const blockQueryKeys = (spec: Pick<ReportSpec, "blocks">) => [...new Set(spec.blocks.flatMap(blockKeys))];
/** The query keys one block reads. */
export function blockKeys(block: ReportBlock): string[] {
  if (block.type === "markdown") return [];
  const keys = [block.queryKey];
  if (block.type === "kpi") {
    if (block.compareTo?.queryKey) keys.push(block.compareTo.queryKey);
    if (block.sparkline) keys.push(block.sparkline.queryKey);
  }
  return [...new Set(keys)];
}

/** The intent a v1 block implies (upgrade, and v2 blocks that leave it out). */
export function defaultIntent(block: ReportBlock): BlockIntent | undefined {
  switch (block.type) {
    case "markdown": return undefined;
    case "kpi": return "headline";
    case "table": return "detail";
    default:
      switch (block.kind) {
        case "line": case "area": case "calendar": return "trend";
        case "horizontal_bar": return "rank";
        case "stacked_bar": case "pie": case "treemap": return "share";
        case "scatter": return "relationship";
        case "heatmap": return "matrix";
        case "funnel": return "conversion";
        case "gauge": case "bullet": return "attainment";
        case "sankey": return "flow";
        case "boxplot": case "histogram": return "distribution";
        case "waterfall": return "delta";
        default: return "compare";
      }
  }
}

/** The slot a block takes when the spec names none: charts half, everything else full (wave 47's two-column layout). */
export const defaultWidth = (block: ReportBlock): BlockWidth => block.type === "chart" ? "half" : "full";

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * The v1 → v2 upgrade on read (pure, D431). A v1 spec keeps its blocks, queries, and formats as they
 * are, gains `specVersion: 2` and no sections, and each block gains the intent and width its kind
 * implies (so it lays out as wave 47 drew it: charts in halves, tables and markdown full width). A
 * v1 KPI's `compareColumn` reads as `compareTo: {column}`. A v2 spec is returned as is (missing
 * `sections` read as none). Anything else is the empty spec.
 */
export function upgradeSpec(raw: unknown): ReportSpec {
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.blocks) || !Array.isArray(raw.queries)) return EMPTY_SPEC;
  const sections = Array.isArray(raw.sections) ? (raw.sections as ReportSection[]).filter((section) => isObject(section) && typeof section.id === "string") : [];
  if (raw.specVersion === SPEC_VERSION) return { version: 1, specVersion: 2, sections, blocks: raw.blocks as ReportBlock[], queries: raw.queries as ReportQuery[] };
  const blocks = (raw.blocks as ReportBlock[]).filter(isObject).map((block): ReportBlock => {
    const intent = block.intent ?? defaultIntent(block);
    const upgraded = { ...block, ...(intent ? { intent } : {}), width: block.width ?? defaultWidth(block), ...(block.type === "markdown" ? {} : { legacy: true }) } as ReportBlock;
    if (upgraded.type === "kpi" && upgraded.compareColumn && !upgraded.compareTo) {
      const { compareColumn, ...rest } = upgraded;
      return { ...rest, compareTo: { column: compareColumn } };
    }
    return upgraded;
  });
  return { version: 1, specVersion: 2, sections: [], blocks, queries: raw.queries as ReportQuery[] };
}

// ------------------------------------------------------------------------------------- the layout

export type LayoutSection = { id: string | null; title: string | null; summary: string | null; blocks: ReportBlock[] };
/**
 * The page order (docs/plan/REPORT_THEME.md § Layout): the narrative (markdown blocks before the
 * first other block, with no section), the KPI strip (KPIs with no section), then the sections in the
 * spec's order with their blocks in spec order. Blocks with no section (or one the spec does not
 * declare) form an untitled section first.
 */
export function reportLayout(spec: Pick<ReportSpec, "blocks"> & { sections?: ReportSection[] }): { narrative: MarkdownBlock[]; strip: KpiBlock[]; sections: LayoutSection[] } {
  const declaredSections = spec.sections ?? [];
  const declared = new Set(declaredSections.map((section) => section.id));
  const sectionOf = (block: ReportBlock) => block.section && declared.has(block.section) ? block.section : null;
  const narrative: MarkdownBlock[] = [];
  let leading = true;
  const strip: KpiBlock[] = [];
  const loose: ReportBlock[] = [];
  const grouped = new Map<string, ReportBlock[]>();
  for (const block of spec.blocks) {
    const section = sectionOf(block);
    if (leading && block.type === "markdown" && section === null) { narrative.push(block); continue; }
    if (block.type !== "kpi" || section !== null) leading = false;
    if (block.type === "kpi" && section === null) { strip.push(block); continue; }
    if (section === null) loose.push(block);
    else grouped.set(section, [...(grouped.get(section) ?? []), block]);
  }
  const sections: LayoutSection[] = [];
  if (loose.length) sections.push({ id: null, title: null, summary: null, blocks: loose });
  for (const section of declaredSections) {
    const blocks = grouped.get(section.id) ?? [];
    if (blocks.length || section.summary) sections.push({ id: section.id, title: section.title, summary: section.summary ?? null, blocks });
  }
  return { narrative, strip, sections };
}

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

/**
 * The report's run history (the "Runs" panel, owner only): every generate, regenerate, edit, refresh,
 * and scheduled refresh run Nook still keeps (the last REPORT_LIMITS.runsKept, plus runs a block's
 * provenance or a query's latest result names). Steps come from the agent run's audit timeline, which
 * the audit retention (AGENT_AUDIT_DAYS) purges: an older run keeps its row and results, not its steps.
 */
export type ReportRunHistoryItem = ReportRun & {
  startedBy: { id: string; name: string } | null;
  durationMs: number | null;
  model: string | null;
  provider: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  tokensEstimated: boolean;
  costMicros: number | null;
  toolCalls: number | null;
  /** The instruction an edit run carried (its text, for the owner). */
  instruction: string | null;
};
export type ReportRunStep =
  | { seq: number; kind: "tool"; tool: string; args: string | null; result: string | null; ok: boolean | null; truncated: boolean; durationMs: number; recovered: boolean }
  | { seq: number; kind: "model"; text: string | null; toolNames: string[]; promptTokens: number | null; completionTokens: number | null; durationMs: number };
export type ReportRunLog = {
  run: ReportRunHistoryItem;
  /** The doc the run read (title, size, hash), when it read one. */
  doc: { id: string; title: string | null; bytes: number; sha256: string; fetchedAt: string } | null;
  /** The agent run's timeline; null when there was none (a refresh) or the audit retention purged it. */
  steps: ReportRunStep[] | null;
  /** A generate or edit run's plan (2c) with its final statuses; null for a refresh or an older run. */
  plan: import("./reportsGenerate").RunPlan | null;
  /** A refresh's per-query outcome. */
  queries: Array<{ key: string; ms: number | null; rows: number; truncated: boolean; rowsRead: number | null; errorCode: string | null; error: string | null; sql: string }>;
};

export type ResultColumn = { name: string; type: string };

/** A ClickHouse type with Nullable(…) and LowCardinality(…) taken off. */
export function baseType(type: string): string {
  let value = type.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    const inner = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(value);
    if (!inner) break;
    value = inner[1]!.trim();
  }
  return value;
}
/** Whether a ClickHouse type is a number (Nullable and LowCardinality unwrapped). */
export const isNumericType = (type: string) => /^(?:U?Int(?:8|16|32|64|128|256)|Float(?:32|64)|BFloat16|Decimal(?:32|64|128|256)?(?:\(.*\))?)$/.test(baseType(type));
/** Whether a ClickHouse type is a date or time (Date, Date32, DateTime, DateTime64, with or without a zone). */
export const isTimeType = (type: string) => /^(?:Date|Date32|DateTime|DateTime64)(?:\(.*\))?$/.test(baseType(type));
/** KPI comparison text: plain, one line, at most 60 characters. */
export const COMPARE_LABEL_MAX = 60;

/** Category labels that are periods in order: 2026-10, 2026-10-13, 2026-W41, 2026-Q4, Q4, Q4 2026, Jan–Dec. */
const PERIOD_LABEL = /^(?:\d{4}-(?:0[1-9]|1[0-2])(?:-\d{2})?(?:[ T]\d{2}:\d{2}(?::\d{2})?)?|\d{4}-?W\d{2}|(?:\d{4}[- ]?)?Q[1-4](?:[- ]?\d{4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?: \d{4})?)$/i;

/** Weekday names and labels that end in a period number (Week 3, M0, Day 14, P1): ordered, for heatmap axes. */
const ORDINAL_LABEL = /^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?|[A-Za-z][A-Za-z ._-]{0,11}\d{1,4}|\d{1,4}[A-Za-z ._-]{0,12})$/i;

/**
 * Whether a column reads as an ordered axis (heatmap rows and columns): a date or number type, or
 * string values that are all periods, weekdays, or numbered steps (Week 3, M0).
 */
export function ordinalColumn(type: string, values: readonly unknown[]): boolean {
  if (isTimeType(type) || isNumericType(type)) return true;
  if (!values.length) return false;
  return values.every((value) => typeof value === "string" && (PERIOD_LABEL.test(value.trim()) || ORDINAL_LABEL.test(value.trim())));
}

/**
 * Whether a chart's x is ordinal or time (never re-sorted, never folded): a trend or distribution, a
 * date or number column, a block from a v1 spec (`legacy`, its rows' order is the author's), or
 * (given the rows) a string column whose every value reads as a period (YYYY-MM, YYYY-MM-DD, YYYY-Www,
 * quarters, month names).
 */
export function ordinalX(block: { x: string; intent?: BlockIntent; legacy?: boolean }, columns: readonly ResultColumn[], rows?: readonly (readonly unknown[])[]): boolean {
  if (block.legacy || block.intent === "distribution" || block.intent === "trend") return true;
  const index = columns.findIndex((column) => column.name === block.x);
  const type = columns[index]?.type ?? "";
  if (isTimeType(type) || isNumericType(type)) return true;
  if (!rows || index < 0 || !rows.length) return false;
  return rows.every((row) => typeof row[index] === "string" && PERIOD_LABEL.test((row[index] as string).trim()));
}

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
