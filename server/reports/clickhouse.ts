import { REPORT_LIMITS, type ResultColumn } from "../../shared/reports";
import { egressFetch, EgressError, readEgressText } from "../agents/egress";

/**
 * The ClickHouse HTTP client for reports (plan wave 45, D414, T357, T358). Every request goes through
 * `egressFetch` (https, or http only for hosts in AGENT_ALLOWED_PRIVATE_HOSTS; private addresses refused
 * unless listed; no redirects; pinned to the checked address; a byte cap and three timeouts), as a POST
 * with the statement as the body, Basic auth, `JSONCompact` output, and a query id (`nook-<run>-<key>`).
 *
 * The per-query settings are the resource ceiling (T358) and the second layer of the write ban:
 * `readonly=2` (no writes, settings may still be set by Nook), `max_execution_time`, `max_result_rows`
 * with `result_overflow_mode=break`, `max_memory_usage`, `max_rows_to_read` / `max_bytes_to_read`,
 * `max_threads`, and `cancel_http_readonly_queries_on_client_close`, so an aborted request stops the
 * query. A user whose profile has `readonly=1` refuses every setting; Test connection says so.
 *
 * Nothing here logs; errors carry ClickHouse's message (trimmed) but never the password or the URL's query.
 */

export type ChTarget = { url: string; username: string; password: string | null; database: string; timeoutS: number; maxRows: number };

export type ChErrorCode = "CLICKHOUSE" | "TIMEOUT" | "TOO_LARGE" | "UNREACHABLE";

export class ChError extends Error {
  constructor(readonly code: ChErrorCode, message: string, readonly chCode: number | null = null, readonly chName: string | null = null) {
    super(message);
    this.name = "ChError";
  }
}

export type ChResult = {
  columns: ResultColumn[];
  rows: unknown[][];
  rowsRead: number | null;
  bytesRead: number | null;
  elapsedMs: number;
  queryId: string;
};

export const CH_DEFAULTS = {
  maxMemoryUsage: 2_000_000_000,
  maxRowsToRead: 2_000_000_000,
  maxBytesToRead: 200 * 1024 ** 3,
  maxThreads: 4,
  maxQuerySize: 262_144
} as const;

export type ChOptions = {
  queryId: string;
  /** Rows ClickHouse returns at most (`max_result_rows`, overflow `break`); default the target's max_rows + 1. */
  maxResultRows?: number;
  maxRowsToRead?: number;
  maxBytesToRead?: number;
  /** `read_overflow_mode=break` instead of an error when the read limit is hit (sample_rows). */
  breakOnReadLimit?: boolean;
  /** Response bytes read at most (default REPORT_LIMITS.responseBytes). */
  responseBytes?: number;
  signal?: AbortSignal;
  /**
   * Leave out `readonly=2` and every limit (Test connection reads the user's own profile values with
   * it; only Nook's fixed statements ever run this way).
   */
  profileSettings?: boolean;
};

/** A query id ClickHouse accepts and the inspect panel can show: `nook-` plus letters, digits, `-`, `_`. */
export function queryIdFor(...parts: string[]) {
  return `nook-${parts.map((part) => part.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)).filter(Boolean).join("-")}`.slice(0, 120);
}

/** The settings sent with every query (URL parameters). */
export function querySettings(target: ChTarget, options: ChOptions): Record<string, string> {
  if (options.profileSettings) return {};
  const settings: Record<string, string> = {
    readonly: "2",
    max_execution_time: String(Math.min(Math.max(1, target.timeoutS), REPORT_LIMITS.timeoutCeilingS)),
    max_result_rows: String(options.maxResultRows ?? target.maxRows + 1),
    result_overflow_mode: "break",
    max_memory_usage: String(CH_DEFAULTS.maxMemoryUsage),
    max_rows_to_read: String(options.maxRowsToRead ?? CH_DEFAULTS.maxRowsToRead),
    max_bytes_to_read: String(options.maxBytesToRead ?? CH_DEFAULTS.maxBytesToRead),
    max_threads: String(CH_DEFAULTS.maxThreads),
    max_query_size: String(CH_DEFAULTS.maxQuerySize),
    cancel_http_readonly_queries_on_client_close: "1"
  };
  if (options.breakOnReadLimit) settings.read_overflow_mode = "break";
  return settings;
}

/** The request URL: the data source's URL (its path kept) with the database, query id, format, and settings. */
export function requestUrl(target: ChTarget, options: ChOptions): string {
  const url = new URL(target.url);
  url.search = "";
  url.hash = "";
  url.searchParams.set("database", target.database);
  url.searchParams.set("query_id", options.queryId);
  url.searchParams.set("default_format", "JSONCompact");
  for (const [name, value] of Object.entries(querySettings(target, options))) url.searchParams.set(name, value);
  return url.toString();
}

const trimMessage = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 600);

/** ClickHouse's error text (`Code: 60. DB::Exception: … (UNKNOWN_TABLE) (version …)`) as a ChError. */
export function parseChError(text: string, status: number): ChError {
  const match = /Code:\s*(\d+)\.\s*DB::Exception:\s*([\s\S]*?)(?:\s*\(([A-Z_]+)\))?(?:\s*\(version [^)]*\))?\s*$/.exec(text.trim());
  if (match) {
    const name = match[3] ?? null;
    const code = Number(match[1]);
    // 159 TIMEOUT_EXCEEDED, 394 QUERY_WAS_CANCELLED by the time limit.
    if (code === 159) return new ChError("TIMEOUT", trimMessage(`The query ran past its time limit. ${match[2]}`), code, name);
    return new ChError("CLICKHOUSE", trimMessage(match[2]!), code, name);
  }
  if (status === 401 || status === 403) return new ChError("CLICKHOUSE", "ClickHouse refused the user name or password", null, "AUTHENTICATION_FAILED");
  return new ChError("CLICKHOUSE", trimMessage(text) || `ClickHouse answered HTTP ${status}`);
}

type JsonCompact = { meta?: Array<{ name: string; type: string }>; data?: unknown[][]; statistics?: { elapsed?: number; rows_read?: number; bytes_read?: number } };

/** Parses a JSONCompact body; an exception ClickHouse appended mid-stream is a ChError. */
export function parseJsonCompact(text: string): Omit<ChResult, "queryId"> {
  let parsed: JsonCompact;
  try {
    parsed = JSON.parse(text) as JsonCompact;
  } catch {
    if (/Code:\s*\d+\.\s*DB::Exception/.test(text)) throw parseChError(text.slice(text.search(/Code:\s*\d+\.\s*DB::Exception/)), 200);
    throw new ChError("CLICKHOUSE", "ClickHouse sent a response that is not JSONCompact");
  }
  if (!parsed || !Array.isArray(parsed.meta) || !Array.isArray(parsed.data)) throw new ChError("CLICKHOUSE", "ClickHouse sent a response that is not JSONCompact");
  const statistics = parsed.statistics ?? {};
  return {
    columns: parsed.meta.map((column) => ({ name: String(column.name), type: String(column.type) })),
    rows: parsed.data,
    rowsRead: typeof statistics.rows_read === "number" ? statistics.rows_read : null,
    bytesRead: typeof statistics.bytes_read === "number" ? statistics.bytes_read : null,
    elapsedMs: typeof statistics.elapsed === "number" ? Math.round(statistics.elapsed * 1000) : 0
  };
}

/** Runs one statement. Throws ChError (or EgressError mapped onto it). */
export async function chQuery(target: ChTarget, sql: string, options: ChOptions): Promise<ChResult> {
  const responseBytes = options.responseBytes ?? REPORT_LIMITS.responseBytes;
  const timeoutMs = (Math.min(Math.max(1, target.timeoutS), REPORT_LIMITS.timeoutCeilingS) + 5) * 1000;
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${target.username}:${target.password ?? ""}`, "utf8").toString("base64")}`,
    "Content-Type": "text/plain; charset=utf-8",
    Accept: "application/json"
  };
  const started = Date.now();
  let text: string;
  let status: number;
  let exceptionCode: string | null;
  try {
    const response = await egressFetch(requestUrl(target, options), { method: "POST", headers, body: sql, signal: options.signal }, { maxBytes: responseBytes, firstByteMs: timeoutMs, idleMs: timeoutMs, totalMs: timeoutMs + 5000 });
    status = response.status;
    exceptionCode = response.headers.get("x-clickhouse-exception-code");
    text = await readEgressText(response, responseBytes);
  } catch (error) {
    if (error instanceof EgressError) {
      if (error.code === "TOO_LARGE") throw new ChError("TOO_LARGE", "The result is larger than reports read (8 MiB); select fewer columns or aggregate");
      if (error.code === "TIMEOUT") throw new ChError("TIMEOUT", "ClickHouse did not answer in time");
      throw new ChError("UNREACHABLE", error.message);
    }
    throw error;
  }
  if (status !== 200 || exceptionCode) throw parseChError(text, status);
  const parsed = parseJsonCompact(text);
  return { ...parsed, elapsedMs: parsed.elapsedMs || Date.now() - started, queryId: options.queryId };
}
