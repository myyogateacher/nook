/**
 * The metric catalog (lane E, E4): the doc's metric definitions as structured rows, extracted once per
 * doc snapshot by the report model and checked against the data source, then edited by the report's
 * owner (each save is a new version). Generation plans its todos against it, and SQL for a catalog
 * metric must use its expression and required filters.
 */

export type CatalogMetric = {
  /** A short id: lower case letters, digits, and _ (unique in the catalog). */
  id: string;
  name: string;
  /** The doc's definition, in its words. */
  definition: string;
  /** A ClickHouse expression or fragment, e.g. `sum(amount)` or `countIf(status = 'paid')`. */
  expression: string;
  /** The table it reads (db.table). */
  table: string;
  /** Conditions every query for the metric must include, e.g. `_peerdb_is_deleted = 0`. */
  filters: string[];
  /** Read the table with FINAL. */
  final: boolean;
  /** day, week, month, total… */
  grain: string | null;
  /** A format (number, percent, duration, currency:USD) or a unit word. */
  unit: string | null;
  timeColumn: string | null;
  /** The doc's text around the definition when the catalog was extracted ("Doc changed" compares it). */
  excerpt: string | null;
  /** E6: the title of the linked page that defines it (null or absent: the main doc). */
  page?: string | null;
  /** What Nook's checks found (unknown table, an expression that does not run); empty when fine. */
  problems: string[];
};

export type MetricCatalogView = {
  version: number;
  source: "extract" | "edit";
  docSha256: string;
  snapshotId: string | null;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  metrics: CatalogMetric[];
  /** Versions kept (newest first): number, source, and time. */
  versions: Array<{ version: number; source: "extract" | "edit"; createdAt: string }>;
};

export const METRIC_LIMITS = { metrics: 24, id: 40, name: 80, definition: 600, expression: 1000, table: 260, filter: 300, filters: 6, grain: 20, unit: 30, column: 128, excerpt: 600, versionsKept: 20 } as const;
export const METRIC_ID = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * L2: the marker a run's query keys start with when Check doc re-read catalog metrics from a changed
 * linked page (a refresh-kind run in Runs that runs no query; `~` is never in a saved query's key).
 */
export const PAGE_METRICS_RUN_MARKER = "~metrics";

/** The editable fields (a save sends the whole list). */
export type CatalogMetricInput = Omit<CatalogMetric, "problems" | "excerpt"> & { excerpt?: string | null };
