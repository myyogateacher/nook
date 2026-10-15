import { DATE_PRESETS, PARAM_LIMITS } from "../../shared/reportParams";

/**
 * What the generation and edit agents are taught about report parameters (spec v3, D489). Kept in its
 * own module so the prompts (generate.ts, edit.ts) only spread these lines in.
 */

/** The guard line on `{}`: only the report's typed parameters. */
export const PLACEHOLDER_GUARD_LINE = "- One statement per query: SELECT or WITH … SELECT. No INTO, OUTFILE, INFILE, SETTINGS, FORMAT, no DDL or writes, no `#` comments, no `$` heredocs. `{name:Type}` is only for the report's declared parameters (below).";

export function PARAMETER_RULES(mode: "report" | "change"): string[] {
  return [
    "## Parameters: the report's date range and filters",
    `- When the ${mode === "report" ? "document names" : "instruction asks for"} a time window ("last 30 days", "this quarter", "a date filter") or a dimension readers would filter by ("by route", "per country", "a route filter"), give the report parameters, so readers change them on the page and every block re-runs. At most ${PARAM_LIMITS.parameters}; none when nothing calls for them.`,
    `- date_range {id, label, type: "date_range", default: {preset}}: presets ${DATE_PRESETS.filter((preset) => preset !== "custom").join(", ")} (the doc's window, e.g. "last 30 days" is 30d), or {preset: "custom", from, to} (YYYY-MM-DD).`,
    "- multi_select {id, label, type: \"multi_select\", chType: \"Array(String)\", default: [], optionsQuery} for a dimension; [] is All. select (one value, chType String or an integer type), number (chType Int64, Float64, …; min?, max?), and text (one line) exist too.",
    "- optionsQuery: a SELECT whose first column lists the choices, e.g. SELECT DISTINCT route FROM db.t WHERE route != '' ORDER BY route LIMIT 200. No placeholders in it.",
    "- Queries read parameters only as typed ClickHouse placeholders, never as text you write into the SQL: a date range `period` gives {period_from:Date} and {period_to:Date}, both days included: `WHERE ts >= {period_from:Date} AND ts < {period_to:Date} + 1` (or `toDate(ts) BETWEEN {period_from:Date} AND {period_to:Date}`). A multi-select `routes`: `AND (empty({routes:Array(String)}) OR route IN {routes:Array(String)})`, so All keeps every row. A select or number: `{id:<chType>}`. With a date range, never also hard-code the window (`now() - INTERVAL 30 DAY`).",
    "- A previous-period comparison is the same number of days just before: `ts >= {period_from:Date} - (dateDiff('day', {period_from:Date}, {period_to:Date}) + 1) AND ts < {period_from:Date}`.",
    "- Every placeholder must be a declared parameter with exactly its chType, and every parameter must be read by a query (each query that should follow the filter reads it). run_sql binds placeholders to the defaults of its `parameters` argument (the same list as the spec's)" + (mode === "change" ? ", or of the report's current parameters when you leave it out." : "; pass it whenever the SQL has placeholders.") + " Before saving, Nook runs every query with the defaults and once with other values.",
    ...(mode === "change"
      ? ["- Patch ops: add_parameter {parameter, after?}; update_parameter {id, set} (label, default, optionsQuery, …); remove_parameter {id}. \"Add a route filter\" is add_parameter (a multi_select on route) plus update_query on each query that should follow it, adding the empty(…) OR route IN … condition to its WHERE."]
      : ["- In plan_report, list the parameters you will add (`parameters`: id, type, label); submit_report must declare them."])
  ];
}
