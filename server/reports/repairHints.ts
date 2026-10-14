import { db } from "../db";
import type { CatalogTable } from "../../shared/reports";
import type { DatasourceRow } from "./datasources";
import { editDistance } from "./planner";
import { tableOf } from "./schemaCatalog";
import { queryShape } from "./sqlShape";

/**
 * ClickHouse error repair hints (lane E, E3): a failed query's ClickHouse error code becomes one
 * concrete next step for the model, built from the schema catalog. The hint names only tables and
 * columns of the data source's allowlisted catalog and identifiers that appear in the query's own
 * text, never ClickHouse's message, so it is safe even when the message itself is withheld (the
 * guard's tree check never shows ClickHouse's text, review M2).
 *
 * - UNKNOWN_IDENTIFIER: the three closest columns of the query's tables (edit distance or shared
 *   name tokens); UNKNOWN_TABLE / UNKNOWN_DATABASE: the three closest allowlisted tables.
 * - ILLEGAL_TYPE_OF_ARGUMENT, TYPE_MISMATCH, NO_COMMON_TYPE, CANNOT_PARSE_*: a cast to suggest.
 * - ILLEGAL_AGGREGATION (an aggregate in WHERE): HAVING. NOT_AN_AGGREGATE: GROUP BY it or aggregate it.
 * - Memory, rows, bytes, or time limits: filter on the table's partition key and sorting key (named
 *   from the catalog), and narrow the date range.
 * - ILLEGAL_FINAL: the table's engine has no FINAL. Any hint also says when the query reads a
 *   ReplacingMergeTree (or another collapsing engine) without FINAL (`finalNote`).
 */

export type ChFailure = { chName: string | null; chCode: number | null; message: string };

type Catalog = { tables: CatalogTable[]; find: (dbName: string, name: string) => CatalogTable | null };

function catalogFor(row: Pick<DatasourceRow, "id">): Catalog {
  const tables = (db.query("SELECT * FROM report_schema_tables WHERE datasource_id = ?").all(row.id) as Array<Parameters<typeof tableOf>[0]>).map(tableOf);
  return { tables, find: (dbName, name) => tables.find((table) => table.db.toLowerCase() === dbName.toLowerCase() && table.name.toLowerCase() === name.toLowerCase()) ?? null };
}

const tokensOf = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 1);

/** The `count` closest names: edit distance, with a bonus for each shared name token (amount ~ order_amount). */
export function closestNames(wanted: string, names: readonly string[], count = 3): string[] {
  const target = wanted.toLowerCase();
  const wantedTokens = new Set(tokensOf(wanted));
  return [...new Set(names)].map((name) => {
    const lower = name.toLowerCase();
    const shared = tokensOf(name).filter((token) => wantedTokens.has(token)).length;
    const contains = lower.includes(target) || target.includes(lower) ? 2 : 0;
    return { name, score: editDistance(target, lower) - 2 * shared - contains };
  }).sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).filter((item) => item.score <= Math.max(3, target.length * 0.6)).slice(0, count).map((item) => item.name);
}

/** The catalog tables a query reads (FROM and JOIN, not subqueries). */
function tablesOf(sql: string, row: Pick<DatasourceRow, "database">, catalog: Catalog): Array<{ table: CatalogTable; final: boolean; alias: string | null }> {
  const shape = queryShape(sql);
  const uses = [shape.from, ...shape.joins.filter((join) => !join.subquery)].filter((use): use is NonNullable<typeof use> => Boolean(use && use.name));
  const fromText = [...sql.matchAll(/\b(?:FROM|JOIN)\s+`?([A-Za-z_][\w]*)`?\.`?([A-Za-z_][\w]*)`?(\s+(?:AS\s+)?[A-Za-z_]\w*)?(\s+FINAL)?/gi)].map((match) => ({ db: match[1]!, name: match[2]!, alias: null as string | null, final: Boolean(match[4]) || /^\s+FINAL$/i.test(match[3] ?? "") }));
  const out = new Map<string, { table: CatalogTable; final: boolean; alias: string | null }>();
  for (const use of [...uses.map((use) => ({ db: use.db ?? row.database, name: use.name, alias: use.alias, final: use.final })), ...fromText]) {
    const table = catalog.find(use.db, use.name);
    if (!table) continue;
    const key = `${table.db}.${table.name}`;
    const existing = out.get(key);
    out.set(key, { table, final: (existing?.final ?? false) || use.final, alias: existing?.alias ?? use.alias });
  }
  return [...out.values()];
}

export const COLLAPSING_ENGINE = /(Replacing|Collapsing|VersionedCollapsing)MergeTree/;

/** A note for each table the query reads with a collapsing engine but without FINAL (the catalog's engine). */
export function finalNote(sql: string, row: Pick<DatasourceRow, "id" | "database">, catalog = catalogFor(row)): string | null {
  const missing = tablesOf(sql, row, catalog).filter((use) => COLLAPSING_ENGINE.test(use.table.engine) && !use.final);
  if (!missing.length) return null;
  return missing.map(({ table }) => {
    const deleted = table.columns.find((column) => /^_?peerdb_is_deleted$|^is_deleted$|^_is_deleted$|^deleted$/i.test(column.name));
    return `${table.db}.${table.name} is a ${table.engine.split("(")[0]}: rows repeat until merged, so read it with FINAL (FROM ${table.db}.${table.name} FINAL)${deleted ? ` and exclude deleted rows (${deleted.name} = 0)` : ""}.`;
  }).join(" ");
}

const quoted = (message: string, pattern: RegExp) => pattern.exec(message)?.[1] ?? null;

/** The repair hint for a failed query, or null when the error has none. */
export function repairHint(failure: ChFailure, sql: string, row: Pick<DatasourceRow, "id" | "database">): string | null {
  const catalog = catalogFor(row);
  const used = tablesOf(sql, row, catalog);
  const name = failure.chName ?? "";
  const code = failure.chCode ?? 0;
  const message = failure.message;
  const inSql = (text: string | null) => text !== null && sql.includes(text) ? text : null;
  let hint: string | null = null;

  if (name === "UNKNOWN_IDENTIFIER" || code === 47) {
    const raw = quoted(message, /identifier `([^`]{1,120})`/i) ?? quoted(message, /Identifier '([^']{1,120})'/i) ?? quoted(message, /Missing columns: '([^']{1,120})'/i);
    const identifier = inSql(raw) ?? inSql(raw?.split(".").pop() ?? null);
    const bare = identifier?.split(".").pop() ?? null;
    const columns = used.flatMap(({ table }) => table.columns.map((column) => column.name));
    // Explicit aliases only (an item without AS is named after its own, unknown, column).
    const aliases = queryShape(sql).items.filter((item) => item.alias !== item.expr && !item.expr.endsWith(`.${item.alias}`)).map((item) => item.alias).filter((alias) => /^[A-Za-z_]\w*$/.test(alias));
    const near = bare ? closestNames(bare, [...columns, ...aliases]).filter((name) => name !== bare) : [];
    const where = used.map(({ table }) => `${table.db}.${table.name}`).join(", ");
    // The unknown name itself is not repeated (Lane F: a name on no allowlisted table is never echoed).
    hint = `A column or function name is not one of ${where || "the query's tables"}${near.length ? `; the closest columns are ${near.join(", ")}` : ""}. Check the names with describe_tables; an alias defined in the SELECT list cannot be used inside an aggregate of the same name.`;
  } else if (name === "UNKNOWN_TABLE" || code === 60 || name === "UNKNOWN_DATABASE" || code === 81) {
    const raw = quoted(message, /identifier '([^']{1,200})'/i) ?? quoted(message, /Table ([\w.`]{1,200}) does(?:n't| not) exist/i) ?? quoted(message, /Database `?(\w{1,128})`? does(?:n't| not) exist/i);
    const wanted = inSql(raw?.replace(/`/g, "") ?? null);
    const names = catalog.tables.map((table) => `${table.db}.${table.name}`);
    const bareNames = new Map(catalog.tables.map((table) => [table.name, `${table.db}.${table.name}`]));
    const near = wanted ? [...new Set([...closestNames(wanted, names), ...closestNames(wanted.split(".").pop()!, [...bareNames.keys()]).map((bareName) => bareNames.get(bareName)!)])].slice(0, 3) : [];
    hint = `${wanted ? `There is no allowlisted table ${wanted}` : "That table or database is not in this data source"}${near.length ? `; the closest tables are ${near.join(", ")}` : "; use search_schema to find the table"}. Qualify tables as db.table.`;
  } else if (name === "ILLEGAL_TYPE_OF_ARGUMENT" || code === 43 || name === "TYPE_MISMATCH" || code === 53 || name === "NO_COMMON_TYPE" || code === 386) {
    const type = quoted(message, /Illegal type (\w+(?:\([^)]*\))?)/) ?? "";
    const fn = quoted(message, /function (\w+)/);
    hint = `A value has the wrong type${type ? ` (${type}${fn && sql.includes(fn) ? ` passed to ${fn}` : ""})` : ""}. Cast it: toFloat64(x) or toDecimal64(x, 2) for numbers stored as text, toString(x) to compare with text, toDate(x) / toDateTime(x) for dates, and give both branches of if/multiIf the same type.`;
  } else if (name === "CANNOT_PARSE_DATETIME" || name === "CANNOT_PARSE_DATE" || name === "CANNOT_PARSE_TEXT" || code === 41 || code === 38 || code === 6) {
    hint = "A string could not be read as a date or number. Compare dates with literals such as '2026-09-01' or toDate('2026-09-01'), or functions such as today() - 30; cast text columns with toDateOrNull / toFloat64OrNull.";
  } else if (name === "ILLEGAL_AGGREGATION" || code === 184) {
    hint = /WHERE/i.test(message) ? "An aggregate function is in WHERE. Filter groups in HAVING (after GROUP BY), or aggregate in a subquery and filter its result." : "An aggregate is nested inside another aggregate or used where it is not allowed; compute the inner aggregate in a subquery first.";
  } else if (name === "NOT_AN_AGGREGATE" || code === 215) {
    const raw = quoted(message, /Column '([^']{1,200})' is not under aggregate/i);
    const bare = raw?.split(".").pop() ?? null;
    const column = inSql(bare);
    hint = `${column ? `${column} is` : "A selected column is"} neither in GROUP BY nor inside an aggregate. Add ${column ?? "it"} to GROUP BY, or aggregate it (any(${column ?? "x"}), sum(${column ?? "x"}), max(${column ?? "x"})).`;
  } else if (["MEMORY_LIMIT_EXCEEDED", "TOO_MANY_ROWS", "TOO_MANY_BYTES", "TOO_MANY_ROWS_OR_BYTES", "TIMEOUT_EXCEEDED"].includes(name) || [241, 158, 307, 396, 159].includes(code)) {
    const keys = used.map(({ table }) => {
      const parts = [table.partitionKey && `partitioned by ${table.partitionKey}`, table.sortingKey && `sorted by (${table.sortingKey})`].filter(Boolean);
      return parts.length ? `${table.db}.${table.name} is ${parts.join(" and ")}` : null;
    }).filter(Boolean);
    hint = `The query ${name === "TIMEOUT_EXCEEDED" || code === 159 ? "ran past the time limit" : "read or kept too much"}. Narrow it: filter on the partition and sorting keys${keys.length ? ` (${keys.join("; ")})` : ""} with a date range, aggregate before a JOIN, join the smaller table on the right, and prefer uniq() to uniqExact() on large tables. estimate shows what a query would read.`;
  } else if (name === "ILLEGAL_FINAL" || code === 181) {
    const plain = used.filter(({ table, final }) => final && !COLLAPSING_ENGINE.test(table.engine) && !/Summing|Aggregating/.test(table.engine)).map(({ table }) => `${table.db}.${table.name} (${table.engine.split("(")[0] || "MergeTree"})`);
    hint = `FINAL works only on Replacing, Collapsing, Summing, and Aggregating MergeTree tables${plain.length ? `; remove it from ${plain.join(", ")}` : ""}.`;
  }
  const final = finalNote(sql, row, catalog);
  if (!hint) return final;
  return final ? `${hint} Also: ${final}` : hint;
}
