/**
 * A fake ClickHouse HTTP interface for the reports tests (Wave 45): `POST /` on 127.0.0.1 (allowed
 * through AGENT_ALLOWED_PRIVATE_HOSTS in the harness), answering the statements Nook sends with
 * JSONCompact bodies, and recording every request (settings, query id, user, password, statement) so
 * tests can prove what left Nook. It never calls anything.
 *
 * What it understands: the Test connection probes (`SELECT version(), …`, `SHOW GRANTS`, `SELECT 1`),
 * the schema reads (`system.tables`, `system.columns`, `SHOW DATABASES`, `SHOW TABLES FROM`,
 * `DESCRIBE TABLE`), `EXPLAIN QUERY TREE` (tables after FROM/JOIN, table functions after FROM), and
 * `EXPLAIN ESTIMATE`. Any other statement is answered by `state.select` (default: three rows of `n`).
 */

export type FakeColumn = { name: string; type: string; comment?: string; default_kind?: string };
export type FakeTable = { db: string; name: string; engine?: string; partition_key?: string; sorting_key?: string; primary_key?: string; total_rows?: number | null; total_bytes?: number | null; comment?: string; columns: FakeColumn[] };
export type FakeRequest = { params: Record<string, string>; user: string; password: string; sql: string };
export type FakeAnswer = { meta: Array<{ name: string; type: string }>; data: unknown[][]; rowsRead?: number } | { error: string; status?: number };

export type FakeClickhouseState = {
  tables: FakeTable[];
  /** `system.*` reads answer ACCESS_DENIED (the SHOW / DESCRIBE fallback). */
  systemDenied: boolean;
  grants: string[];
  /** The profile's `readonly`; 1 refuses every setting Nook sends. */
  readonly: number;
  version: string;
  /** Overrides EXPLAIN QUERY TREE (the text it returns). */
  queryTree: ((select: string) => string | null) | null;
  /** Answers every other statement. */
  select: (sql: string, request: FakeRequest) => FakeAnswer;
  /** Milliseconds to wait before answering a wrapped select. */
  delayMs: number;
};

const json = (meta: Array<{ name: string; type: string }>, data: unknown[][], rowsRead = data.length) =>
  JSON.stringify({ meta, data, rows: data.length, statistics: { elapsed: 0.002, rows_read: rowsRead, bytes_read: rowsRead * 8 } });

const exception = (code: number, message: string, name: string) => `Code: ${code}. DB::Exception: ${message}. (${name}) (version 24.8.1.1)\n`;

/** A tree like ClickHouse's analyzer prints: a TABLE line per FROM/JOIN name, a TABLE_FUNCTION line per FROM fn(. */
export function fakeQueryTree(select: string, defaultDb: string): string {
  const lines = ["QUERY id: 0", "  PROJECTION COLUMNS", "  JOIN TREE"];
  let id = 1;
  for (const match of select.matchAll(/\b(?:FROM|JOIN)\s+(`?[A-Za-z0-9_]+`?(?:\.`?[A-Za-z0-9_]+`?)?)\s*(\()?/gi)) {
    const name = match[1]!.replace(/`/g, "");
    if (match[2]) lines.push(`    TABLE_FUNCTION id: ${id++}, alias: __table${id}, table_function_name: ${name}`);
    else if (/^(select|with)$/i.test(name)) continue;
    else lines.push(`    TABLE id: ${id++}, alias: __table${id}, table_name: ${name.includes(".") ? name : `${defaultDb}.${name}`}`);
  }
  return lines.join("\n");
}

export function generatedTables(count: number): FakeTable[] {
  const topics = ["orders", "events", "sessions", "users", "payments", "refunds", "pageviews", "signups", "invoices", "shipments"];
  return Array.from({ length: count }, (_, index) => {
    const topic = topics[index % topics.length]!;
    return {
      db: index % 3 === 0 ? "analytics" : index % 3 === 1 ? "staging" : "raw",
      name: `${topic}_${String(index).padStart(4, "0")}`,
      engine: "MergeTree", partition_key: "toYYYYMM(event_date)", sorting_key: "event_date, id", primary_key: "event_date, id",
      total_rows: index * 1000, total_bytes: index * 64_000, comment: `Table ${index} about ${topic}`,
      columns: [
        { name: "id", type: "UInt64", comment: "row id", default_kind: "" },
        { name: "event_date", type: "Date", comment: "partition day", default_kind: "" },
        { name: `${topic}_amount`, type: "Decimal(18, 2)", comment: `${topic} amount in cents`, default_kind: "" }
      ]
    };
  });
}

export function startFakeClickhouse(port: number, options: { database?: string } = {}) {
  const database = options.database ?? "analytics";
  const requests: FakeRequest[] = [];
  const defaults = (): FakeClickhouseState => ({
    tables: [], systemDenied: false, grants: ["GRANT SELECT ON analytics.* TO nook_ro"], readonly: 2, version: "24.8.1.1", queryTree: null, delayMs: 0,
    select: (sql) => {
      const limit = /LIMIT (\d+)\s*$/.exec(sql);
      const count = Math.min(3, limit ? Number(limit[1]) : 3);
      return { meta: [{ name: "n", type: "UInt64" }], data: Array.from({ length: count }, (_, index) => [String(index)]), rowsRead: 1234 };
    }
  });
  const state: FakeClickhouseState = defaults();

  const answer = (request: FakeRequest): { status: number; body: string; headers?: Record<string, string> } => {
    const sql = request.sql.trim();
    const hasSettings = Object.keys(request.params).some((name) => !["database", "query_id", "default_format"].includes(name));
    if (state.readonly === 1 && hasSettings) return { status: 500, body: exception(164, "Cannot modify 'readonly' setting in readonly mode", "READONLY"), headers: { "X-ClickHouse-Exception-Code": "164" } };
    if (request.user === "bad") return { status: 516, body: exception(516, "bad: Authentication failed: password is incorrect, or there is no user with such name", "AUTHENTICATION_FAILED") };
    // Real ClickHouse types getSetting('readonly') as UInt8, and toUInt8OrNull accepts only a String (Code 43).
    if (/toUInt8OrNull\(\s*getSetting\(/.test(sql)) return { status: 400, body: exception(43, "Illegal type UInt8 of first argument of function toUInt8OrNull. Expected String or FixedString", "ILLEGAL_TYPE_OF_ARGUMENT"), headers: { "X-ClickHouse-Exception-Code": "43" } };
    if (sql.startsWith("SELECT version(), currentUser()")) return { status: 200, body: json([{ name: "version()", type: "String" }, { name: "currentUser()", type: "String" }, { name: "r", type: "Nullable(UInt8)" }], [[state.version, request.user, state.readonly]]) };
    if (sql === "SHOW GRANTS") return { status: 200, body: json([{ name: "GRANTS", type: "String" }], state.grants.map((line) => [line])) };
    if (sql === "SELECT 1") return { status: 200, body: json([{ name: "1", type: "UInt8" }], [[1]]) };
    if (/FROM system\.(tables|columns)\b/.test(sql) && !/^SELECT \* FROM \(/.test(sql) && !/^EXPLAIN/.test(sql)) {
      if (state.systemDenied) return { status: 500, body: exception(497, `${request.user}: Not enough privileges. To execute this query, it's necessary to have the grant SELECT ON system.tables`, "ACCESS_DENIED") };
      const one = /database = '([^']*)' AND (?:name|table) = '([^']*)'/.exec(sql);
      const inList = /database IN \(([^)]*)\)/.exec(sql);
      const dbs = inList ? [...inList[1]!.matchAll(/'([^']*)'/g)].map((item) => item[1]!) : null;
      const pick = state.tables.filter((table) => (!one || (table.db === one[1] && table.name === one[2])) && (!dbs || dbs.includes(table.db)));
      if (/^SELECT database, name FROM system\.tables/.test(sql)) return { status: 200, body: json([{ name: "database", type: "String" }, { name: "name", type: "String" }], pick.map((table) => [table.db, table.name])) };
      if (/FROM system\.tables/.test(sql)) {
        return { status: 200, body: json(["database", "name", "engine", "partition_key", "sorting_key", "primary_key", "total_rows", "total_bytes", "comment"].map((name) => ({ name, type: "String" })),
          pick.map((table) => [table.db, table.name, table.engine ?? "", table.partition_key ?? "", table.sorting_key ?? "", table.primary_key ?? "", table.total_rows === null || table.total_rows === undefined ? null : String(table.total_rows), table.total_bytes === null || table.total_bytes === undefined ? null : String(table.total_bytes), table.comment ?? ""])) };
      }
      return { status: 200, body: json(["database", "table", "name", "type", "comment", "default_kind"].map((name) => ({ name, type: "String" })),
        pick.flatMap((table) => table.columns.map((column) => [table.db, table.name, column.name, column.type, column.comment ?? "", column.default_kind ?? ""]))) };
    }
    if (sql === "SHOW DATABASES") return { status: 200, body: json([{ name: "name", type: "String" }], [...new Set(["system", ...state.tables.map((table) => table.db)])].map((name) => [name])) };
    const showTables = /^SHOW TABLES FROM `([^`]+)`$/.exec(sql);
    if (showTables) return { status: 200, body: json([{ name: "name", type: "String" }], state.tables.filter((table) => table.db === showTables[1]).map((table) => [table.name])) };
    const describe = /^DESCRIBE TABLE `([^`]+)`\.`([^`]+)`$/.exec(sql);
    if (describe) {
      const table = state.tables.find((item) => item.db === describe[1] && item.name === describe[2]);
      if (!table) return { status: 404, body: exception(60, `Table ${describe[1]}.${describe[2]} does not exist`, "UNKNOWN_TABLE") };
      return { status: 200, body: json(["name", "type", "default_type", "default_expression", "comment", "codec_expression", "ttl_expression"].map((name) => ({ name, type: "String" })),
        table.columns.map((column) => [column.name, column.type, column.default_kind ?? "", "", column.comment ?? "", "", ""])) };
    }
    if (sql.startsWith("EXPLAIN QUERY TREE ")) {
      const select = sql.slice("EXPLAIN QUERY TREE ".length);
      const tree = state.queryTree?.(select) ?? fakeQueryTree(select, request.params.database ?? database);
      // A tree override that is ClickHouse error text answers as an error.
      if (tree.startsWith("Code: ")) return { status: 404, body: tree };
      return { status: 200, body: json([{ name: "explain", type: "String" }], tree.split("\n").map((line) => [line])) };
    }
    if (sql.startsWith("EXPLAIN ESTIMATE ")) {
      return { status: 200, body: json(["database", "table", "parts", "rows", "marks"].map((name) => ({ name, type: name === "database" || name === "table" ? "String" : "UInt64" })), [["analytics", "orders", "4", "120000", "15"]]) };
    }
    const result = state.select(sql, request);
    if ("error" in result) return { status: result.status ?? 500, body: result.error };
    return { status: 200, body: json(result.meta, result.data, result.rowsRead) };
  };

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const auth = request.headers.get("authorization") ?? "";
      const decoded = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString("utf8") : ":";
      const colon = decoded.indexOf(":");
      const record: FakeRequest = { params: Object.fromEntries(url.searchParams), user: decoded.slice(0, colon), password: decoded.slice(colon + 1), sql: await request.text() };
      requests.push(record);
      // Only the statements themselves are slow (never probes, tree checks, or KILL QUERY).
      if (state.delayMs && record.sql.startsWith("SELECT * FROM (")) await Bun.sleep(state.delayMs);
      const { status, body, headers } = answer(record);
      return new Response(body, { status, headers: { "Content-Type": status === 200 ? "application/json; charset=UTF-8" : "text/plain; charset=UTF-8", ...(headers ?? {}) } });
    }
  });
  return {
    url: `http://127.0.0.1:${port}/`,
    state,
    requests,
    reset() {
      Object.assign(state, defaults());
      requests.length = 0;
    },
    stop: () => server.stop(true)
  };
}
