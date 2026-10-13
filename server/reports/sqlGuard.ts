import type { GuardCode, StatementClass } from "../../shared/reports";
import { clickhouseRegex, databaseAllowed, tableAllowed } from "./allowlist";

/**
 * The SQL guard for report queries (plan wave 45, D411, D412, T356). Defence in depth in front of the
 * real boundary, which is ClickHouse itself: a read-only user with grants only on the allowed tables
 * (Test connection warns when the user can write), plus the per-query settings `clickhouse.ts` sends.
 *
 * 1. **Lex** the text: strings, quoted identifiers, and comments are recognised the way ClickHouse
 *    reads them, and anything this lexer is not sure ClickHouse reads the same way is refused rather
 *    than interpreted: `#` comments, nested block comments, heredocs and `$`, `{}` query parameters,
 *    backslashes, and any non-ASCII character outside a string or a quoted identifier.
 * 2. **One statement**: a `;` is allowed only at the very end.
 * 3. **Classify** (`select | metadata`): SELECT or WITH is the select class; SHOW DATABASES, SHOW TABLES,
 *    SHOW CREATE TABLE, DESCRIBE [TABLE], EXISTS [TABLE], and EXPLAIN [PLAN|SYNTAX|ESTIMATE] <select>
 *    are the metadata class, and so is a SELECT that reads only the allowed system tables
 *    (`system.tables`, `system.columns`, `system.parts`, `system.dictionaries`,
 *    `system.data_skipping_indices`). Any other `system.*` or `information_schema.*` is refused.
 * 4. **Banned anywhere** in a select: INTO (OUTFILE), INFILE, SETTINGS, a FORMAT clause, and the
 *    external or unbounded table functions and functions (`url`, `s3*`, `file`, `remote*`,
 *    `cluster*`, `mysql`, `postgresql`, `jdbc`, `odbc`, `hdfs*`, `executable`, `input`, `merge`,
 *    `dictionary`, `dictGet*`, `sleep*`, …), whether named bare or as a quoted identifier.
 * 5. **Wrap** a select as `SELECT * FROM (\n…\n) LIMIT max+1` (the +1 says "truncated"); the text sent
 *    is the comment-stripped statement, so nothing hides in a comment.
 * 6. **Tables**: the FROM/JOIN names a lexer can see are checked against the allowlist here; the
 *    authoritative check is `EXPLAIN QUERY TREE` (`queryTreeTables` parses it), run by the caller
 *    before the query, which lists every table and table function the analyzer resolved.
 *
 * Pure: no database and no network.
 */

export class GuardError extends Error {
  constructor(readonly code: GuardCode, message: string) {
    super(message);
    this.name = "GuardError";
  }
}

export const MAX_SQL_CHARS = 20_000;

type TokenKind = "word" | "quoted" | "string" | "number" | "punct";
export type Token = { kind: TokenKind; text: string; /** words: lower case; quoted: the unescaped name; strings: the unescaped value. */ value: string; start: number; end: number };

const WORD_START = /[A-Za-z_]/;
const WORD = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const PUNCT = new Set(["(", ")", ",", ".", "+", "-", "*", "/", "%", "=", "<", ">", "!", "|", "[", "]", ":", "?", ";"]);

/** Reads a quoted run (`'…'`, `"…"`, or `` `…` ``) from `start`; backslash escapes and doubled quotes, as ClickHouse does. */
function readQuoted(sql: string, start: number, quote: string): { end: number; value: string } {
  let value = "";
  let index = start + 1;
  while (index < sql.length) {
    const char = sql[index]!;
    if (char === "\\") {
      // Review H2: ClickHouse decodes \xNN, \a, \e, … inside quoted names, which this lexer would read
      // as other letters (`jo\x69nGet`). A backslash in a quoted name is refused; strings keep theirs
      // (their value never names anything here, and an escaped quote ends neither reader's string).
      if (quote !== "'") throw new GuardError("UNSUPPORTED_SYNTAX", "A backslash is not allowed in a quoted name");
      if (index + 1 >= sql.length) break;
      const next = sql[index + 1]!;
      value += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next === "0" ? "\0" : next;
      index += 2;
      continue;
    }
    // A line break in a quoted name (an alias) would split a line of EXPLAIN QUERY TREE output in two.
    if (quote !== "'" && (char === "\n" || char === "\r" || char === "\t")) throw new GuardError("UNSUPPORTED_SYNTAX", "A quoted name cannot contain a line break or a tab");
    if (char === quote) {
      if (sql[index + 1] === quote) {
        value += quote;
        index += 2;
        continue;
      }
      return { end: index + 1, value };
    }
    value += char;
    index += 1;
  }
  throw new GuardError("UNTERMINATED", quote === "'" ? "A string is not closed" : "A quoted name is not closed");
}

/**
 * Tokens of `sql` and the text with every comment replaced by spaces (the text that is sent). Throws
 * GuardError for anything ambiguous (see the module comment).
 */
export function lex(sql: string): { tokens: Token[]; stripped: string } {
  if (sql.length > MAX_SQL_CHARS) throw new GuardError("TOO_LONG", `A query may be at most ${MAX_SQL_CHARS} characters`);
  // C0 controls other than tab and line breaks, DEL, and the Unicode line and paragraph separators, anywhere.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/.test(sql)) throw new GuardError("UNSUPPORTED_SYNTAX", "The query contains control characters");
  const tokens: Token[] = [];
  let stripped = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      stripped += char;
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      const stop = end === -1 ? sql.length : end;
      stripped += " ".repeat(stop - index);
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = sql.indexOf("*/", index + 2);
      if (close === -1) throw new GuardError("UNTERMINATED", "A /* comment is not closed");
      // ClickHouse nests block comments; this guard does not try to: a nested opener is refused.
      if (sql.slice(index + 2, close).includes("/*")) throw new GuardError("UNSUPPORTED_SYNTAX", "Nested /* comments are not supported");
      stripped += sql.slice(index, close + 2).replace(/[^\n]/g, " ");
      index = close + 2;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      const { end, value } = readQuoted(sql, index, char);
      tokens.push({ kind: char === "'" ? "string" : "quoted", text: sql.slice(index, end), value, start: index, end });
      stripped += sql.slice(index, end);
      index = end;
      continue;
    }
    if (WORD_START.test(char)) {
      let end = index + 1;
      while (end < sql.length && WORD.test(sql[end]!)) end += 1;
      const text = sql.slice(index, end);
      tokens.push({ kind: "word", text, value: text.toLowerCase(), start: index, end });
      stripped += text;
      index = end;
      continue;
    }
    if (DIGIT.test(char) || (char === "." && next !== undefined && DIGIT.test(next) && (tokens.length === 0 || tokens.at(-1)!.kind === "punct"))) {
      let end = index + 1;
      while (end < sql.length && (/[0-9A-Za-z_.]/.test(sql[end]!) || ((sql[end] === "+" || sql[end] === "-") && /[eEpP]/.test(sql[end - 1]!)))) end += 1;
      const text = sql.slice(index, end);
      tokens.push({ kind: "number", text, value: text.toLowerCase(), start: index, end });
      stripped += text;
      index = end;
      continue;
    }
    if (char === "#") throw new GuardError("UNSUPPORTED_SYNTAX", "Use -- for comments; # comments are not supported");
    if (char === "$") throw new GuardError("UNSUPPORTED_SYNTAX", "$ (heredoc strings and parameters) is not supported");
    if (char === "{" || char === "}") throw new GuardError("UNSUPPORTED_SYNTAX", "Query parameters ({name:Type}) are not supported");
    if (char === "\\") throw new GuardError("UNSUPPORTED_SYNTAX", "A backslash is allowed only inside a string");
    if (char.charCodeAt(0) > 0x7e) throw new GuardError("NON_ASCII", "Characters outside ASCII are allowed only inside strings and quoted names");
    if (PUNCT.has(char)) {
      tokens.push({ kind: "punct", text: char, value: char, start: index, end: index + 1 });
      stripped += char;
      index += 1;
      continue;
    }
    throw new GuardError("UNSUPPORTED_SYNTAX", `The character ${JSON.stringify(char)} is not supported here`);
  }
  return { tokens, stripped };
}

/** Table functions and functions a report query may never call (lower case; exact names). */
export const BANNED_FUNCTIONS: ReadonlySet<string> = new Set([
  "url", "urlcluster", "file", "filecluster", "input", "mysql", "postgresql", "jdbc", "odbc", "mongodb", "redis", "sqlite", "hive", "merge",
  "loop", "dictionary", "format", "generaterandom", "gcs", "oss", "cosn", "paimon", "ytsaurus", "fuzzjson", "fuzzquery", "viewifpermitted",
  "viewexplain", "prometheusquery", "prometheusqueryrange", "getmacro", "getsetting", "getserverport", "fqdn", "hostname", "hascolumnintable",
  "modelevaluate", "getclienthttpheader",
  // Review L4: server settings and identity.
  "getserversetting", "getmergetreesetting", "serveruuid", "tcpport"
]);

/**
 * Prefixes of banned names: external storage (`s3Cluster`, `remoteSecure`, `icebergS3`, `hdfsCluster`,
 * `azureBlobStorage`, `deltaLake`, `kafka…`), other tables reached by name (`dictGet…`, `joinGet…`,
 * `mergeTreeIndex`), and the host (`filesystem…`, `executable…`, `sleep…`, `catboost…`).
 */
export const BANNED_PREFIXES: readonly string[] = ["s3", "remote", "cluster", "hdfs", "azure", "iceberg", "deltalake", "hudi", "dict", "joinget", "sleep", "filesystem", "mergetree", "timeseries", "arrowflight", "executable", "kafka", "nats", "rabbitmq", "catboost"];

/** Words never allowed unquoted in a select (a FORMAT clause is FORMAT without a following "("). */
const BANNED_WORDS: ReadonlySet<string> = new Set(["into", "outfile", "infile", "settings", "explain", "show", "describe", "attach", "detach", "insert", "alter", "create", "drop", "truncate", "optimize", "grant", "revoke", "kill", "undrop"]);

/** The system tables the metadata class may read, and the column each names its table with. */
export const ALLOWED_SYSTEM_TABLES: Readonly<Record<string, "name" | "table">> = {
  tables: "name", columns: "table", parts: "table", dictionaries: "name", data_skipping_indices: "table"
};

export const isBannedFunction = (name: string) => {
  const lower = name.toLowerCase();
  return BANNED_FUNCTIONS.has(lower) || BANNED_PREFIXES.some((prefix) => lower.startsWith(prefix));
};

const isName = (token: Token | undefined): token is Token => token !== undefined && (token.kind === "word" || token.kind === "quoted");
const isPunct = (token: Token | undefined, text: string) => token !== undefined && token.kind === "punct" && token.text === text;
const isWord = (token: Token | undefined, ...words: string[]) => token !== undefined && token.kind === "word" && words.includes(token.value);

export type TableRef = { db: string | null; table: string };
export type SystemRef = { table: string; start: number; end: number };

/** Words that end a FROM list at their depth (after them, a comma no longer separates tables). */
const FROM_END: ReadonlySet<string> = new Set(["where", "prewhere", "group", "order", "limit", "having", "union", "except", "intersect", "window", "qualify", "on", "using", "select", "offset"]);

const nameText = (token: Token) => token.kind === "word" ? token.text : token.value;

/** A table name (`db.t` or `t`) starting at `index` that is not a function call; null otherwise. */
function tableAt(tokens: readonly Token[], index: number): TableRef | null {
  const first = tokens[index];
  if (!isName(first) || (first.kind === "word" && (FROM_END.has(first.value) || first.value === "with"))) return null;
  if (isPunct(tokens[index + 1], ".") && isName(tokens[index + 2])) {
    return isPunct(tokens[index + 3], "(") ? null : { db: nameText(first), table: nameText(tokens[index + 2]!) };
  }
  return isPunct(tokens[index + 1], "(") ? null : { db: null, table: nameText(first) };
}

/**
 * The select checks over a token slice: banned words, banned functions, `system.*` and
 * `information_schema.*` references (returned, for the caller to allow or refuse), and the tables the
 * lexer can see: after FROM and JOIN, after each comma of a FROM list (`FROM a, db.b`), and after
 * `[GLOBAL] [NOT] IN` when no "(" follows (review H1). CTE names are left out; ARRAY JOIN names
 * columns, not tables. EXPLAIN QUERY TREE stays the authority.
 */
function checkSelect(tokens: readonly Token[]): { systemRefs: SystemRef[]; tables: TableRef[] } {
  const systemRefs: SystemRef[] = [];
  const tables: TableRef[] = [];
  const cteNames = new Set<string>();
  // Names this query defines (`name AS (` and `… AS name`): `IN name` may be one of them, never a table.
  const aliases = new Set<string>();
  const inTables: TableRef[] = [];
  const inFrom = new Set<number>();
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const next = tokens[index + 1];
    if (token.kind === "word") {
      if (BANNED_WORDS.has(token.value)) throw new GuardError("BANNED_KEYWORD", `${token.text.toUpperCase()} is not allowed in a report query`);
      if (token.value === "format" && !isPunct(next, "(")) throw new GuardError("BANNED_KEYWORD", "A FORMAT clause is not allowed (Nook picks the format); quote a column named format as `format`");
      // DESC TABLE as a subquery, never ORDER BY … DESC.
      if (token.value === "desc" && (isWord(next, "table") || isPunct(tokens[index - 1], "("))) throw new GuardError("BANNED_KEYWORD", "DESCRIBE is a metadata statement; run it on its own");
    }
    if (isName(token) && isPunct(next, "(") && isBannedFunction(nameText(token))) {
      throw new GuardError("BANNED_FUNCTION", `${nameText(token)}() is not allowed in a report query`);
    }
    // `name AS (` in a WITH list names a CTE.
    if (isName(token) && isWord(next, "as") && isPunct(tokens[index + 2], "(")) cteNames.add(token.value.toLowerCase());
    if (isWord(token, "as") && isName(next) && !isPunct(tokens[index + 2], "(")) aliases.add(next.value.toLowerCase());
    if (isName(token) && isPunct(next, ".") && isName(tokens[index + 2])) {
      const db = token.value.toLowerCase();
      if (db === "system") systemRefs.push({ table: tokens[index + 2]!.value.toLowerCase(), start: token.start, end: tokens[index + 2]!.end });
      if (db === "information_schema") throw new GuardError("BANNED_TABLE", "information_schema is not readable from reports");
    }
    if (isPunct(token, "(")) depth += 1;
    if (isPunct(token, ")")) {
      depth -= 1;
      for (const level of inFrom) if (level > depth) inFrom.delete(level);
    }
    if (token.kind === "word" && FROM_END.has(token.value)) inFrom.delete(depth);
    if (isWord(token, "join") && isWord(tokens[index - 1], "array")) {
      inFrom.delete(depth);
      continue;
    }
    if (isWord(token, "from", "join")) {
      inFrom.add(depth);
      const ref = tableAt(tokens, index + 1);
      if (ref) tables.push(ref);
    }
    if (isPunct(token, ",") && inFrom.has(depth)) {
      const ref = tableAt(tokens, index + 1);
      if (ref) tables.push(ref);
    }
    if (isWord(token, "in")) {
      const ref = tableAt(tokens, index + 1);
      if (ref) inTables.push(ref);
    }
  }
  for (const ref of inTables) if (ref.db !== null || !(cteNames.has(ref.table.toLowerCase()) || aliases.has(ref.table.toLowerCase()))) tables.push(ref);
  return { systemRefs, tables: tables.filter((ref) => ref.db !== null || !cteNames.has(ref.table.toLowerCase())) };
}

export type MetadataForm =
  | { kind: "show_databases" }
  | { kind: "show_tables"; db: string | null }
  | { kind: "show_create"; target: TableRef }
  | { kind: "describe"; target: TableRef }
  | { kind: "exists"; target: TableRef }
  | { kind: "explain"; mode: "plan" | "syntax" | "estimate"; inner: string }
  | { kind: "system_select" };

export type Classified = {
  class: StatementClass;
  /** The statement without comments and trailing semicolons. */
  sql: string;
  tokens: Token[];
  /** Tables the lexer saw after FROM/JOIN (select class, and the inner select of EXPLAIN). */
  tables: TableRef[];
  /** Allowed system tables this statement reads (metadata class only). */
  systemRefs: SystemRef[];
  metadata: MetadataForm | null;
};

/** `db.table` or `table` starting at `index`; the index after it. */
function readTableName(tokens: readonly Token[], index: number): { ref: TableRef; next: number } | null {
  const first = tokens[index];
  if (!isName(first)) return null;
  const name = (token: Token) => token.kind === "word" ? token.text : token.value;
  if (isPunct(tokens[index + 1], ".") && isName(tokens[index + 2])) return { ref: { db: name(first), table: name(tokens[index + 2]!) }, next: index + 3 };
  return { ref: { db: null, table: name(first) }, next: index + 1 };
}

const reservedDb = (db: string | null) => db !== null && /^(system|information_schema)$/i.test(db);

function classifyMetadata(tokens: Token[], sql: string): Classified {
  const first = tokens[0]!;
  const done = (metadata: MetadataForm, rest: number): Classified => {
    if (rest !== tokens.length) throw new GuardError("UNSUPPORTED_SYNTAX", "This form of the statement is not supported");
    return { class: "metadata", sql, tokens, tables: [], systemRefs: [], metadata };
  };
  const target = (index: number) => {
    const read = readTableName(tokens, index);
    if (!read) throw new GuardError("UNSUPPORTED_SYNTAX", "Name a table");
    if (reservedDb(read.ref.db)) throw new GuardError("BANNED_TABLE", "System tables are read through SELECT … FROM system.tables (or columns, parts, dictionaries, data_skipping_indices)");
    return read;
  };
  if (first.value === "show") {
    const second = tokens[1];
    if (isWord(second, "databases")) {
      // SHOW DATABASES [LIKE 'pattern']
      if (isWord(tokens[2], "like") && tokens[3]?.kind === "string") return done({ kind: "show_databases" }, 4);
      return done({ kind: "show_databases" }, 2);
    }
    if (isWord(second, "tables")) {
      let index = 2;
      let db: string | null = null;
      if (isWord(tokens[index], "from", "in")) {
        const name = tokens[index + 1];
        if (!isName(name)) throw new GuardError("UNSUPPORTED_SYNTAX", "Name a database after FROM");
        db = name.kind === "word" ? name.text : name.value;
        if (reservedDb(db)) throw new GuardError("BANNED_TABLE", "The system database is not listed from reports");
        index += 2;
      }
      if (isWord(tokens[index], "like", "ilike") && tokens[index + 1]?.kind === "string") index += 2;
      if (isWord(tokens[index], "limit") && tokens[index + 1]?.kind === "number") index += 2;
      return done({ kind: "show_tables", db }, index);
    }
    if (isWord(second, "create")) {
      // Review M1: TABLE is required, so SHOW CREATE USER / ROLE / QUOTA / PROFILE / POLICY / DATABASE /
      // DICTIONARY / VIEW never get through as a "table" named USER.
      if (!isWord(tokens[2], "table")) throw new GuardError("METADATA_FORBIDDEN", "Only SHOW CREATE TABLE is allowed");
      const read = target(3);
      return done({ kind: "show_create", target: read.ref }, read.next);
    }
    throw new GuardError("METADATA_FORBIDDEN", "Only SHOW DATABASES, SHOW TABLES, and SHOW CREATE TABLE are allowed");
  }
  if (first.value === "describe" || first.value === "desc") {
    const index = isWord(tokens[1], "table") ? 2 : 1;
    if (isPunct(tokens[index], "(")) throw new GuardError("METADATA_FORBIDDEN", "DESCRIBE takes a table name");
    const read = target(index);
    return done({ kind: "describe", target: read.ref }, read.next);
  }
  if (first.value === "exists") {
    const index = isWord(tokens[1], "table") ? 2 : 1;
    const read = target(index);
    return done({ kind: "exists", target: read.ref }, read.next);
  }
  // EXPLAIN [PLAN | SYNTAX | ESTIMATE] <select>
  let index = 1;
  let mode: "plan" | "syntax" | "estimate" = "plan";
  if (isWord(tokens[1], "plan", "syntax", "estimate")) {
    mode = tokens[1]!.value as typeof mode;
    index = 2;
  } else if (isWord(tokens[1], "ast", "pipeline", "query", "table", "current")) {
    throw new GuardError("METADATA_FORBIDDEN", "Only EXPLAIN PLAN, EXPLAIN SYNTAX, and EXPLAIN ESTIMATE are allowed");
  }
  const innerTokens = tokens.slice(index);
  if (!isWord(innerTokens[0], "select", "with")) throw new GuardError("UNSUPPORTED_SYNTAX", "EXPLAIN must be followed by a SELECT");
  const innerSql = sql.slice(innerTokens[0]!.start);
  const checked = checkSelect(innerTokens);
  if (checked.systemRefs.length) throw new GuardError("BANNED_TABLE", "EXPLAIN works on report queries, not on system tables");
  return { class: "metadata", sql, tokens, tables: checked.tables, systemRefs: [], metadata: { kind: "explain", mode, inner: innerSql } };
}

/**
 * Classifies one statement, or throws GuardError. A select that reads only allowed system tables is
 * the metadata class (`system_select`); one that mixes them with other tables is refused, since its
 * rows could not be filtered.
 */
export function classify(raw: string): Classified {
  const { tokens: all, stripped } = lex(raw);
  let tokens = all;
  while (tokens.length && isPunct(tokens.at(-1), ";")) tokens = tokens.slice(0, -1);
  if (!tokens.length) throw new GuardError("EMPTY", "Write a query");
  if (tokens.some((token) => isPunct(token, ";"))) throw new GuardError("MULTI_STATEMENT", "Run one statement at a time");
  const sql = stripped.slice(tokens[0]!.start, tokens.at(-1)!.end);
  const first = tokens[0]!;
  if (first.kind !== "word") throw new GuardError("NOT_SELECT", "A report query starts with SELECT or WITH");
  if (["show", "describe", "desc", "exists", "explain"].includes(first.value)) return classifyMetadata(tokens, sql);
  if (first.value !== "select" && first.value !== "with") throw new GuardError("NOT_SELECT", "Only SELECT (or WITH … SELECT) and the metadata statements are allowed");
  const { systemRefs, tables } = checkSelect(tokens);
  if (!systemRefs.length) return { class: "select", sql, tokens, tables, systemRefs: [], metadata: null };
  for (const ref of systemRefs) {
    if (!Object.hasOwn(ALLOWED_SYSTEM_TABLES, ref.table)) throw new GuardError("BANNED_TABLE", `system.${ref.table} is not readable from reports`);
  }
  const others = tables.filter((ref) => !(ref.db && ref.db.toLowerCase() === "system"));
  if (others.length) throw new GuardError("BANNED_TABLE", "A query on system tables cannot also read other tables");
  return { class: "metadata", sql, tokens, tables: [], systemRefs, metadata: { kind: "system_select" } };
}

/** Wraps a select for its row cap: one more than `maxRows`, so the caller can say "truncated". */
export function wrapSelect(sql: string, maxRows: number): string {
  return `SELECT * FROM (\n${sql}\n) LIMIT ${Math.max(1, Math.floor(maxRows)) + 1}`;
}

/** A ClickHouse string literal. */
export const sqlString = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** A ClickHouse identifier, back-quoted. */
export const sqlIdentifier = (value: string) => `\`${value.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;

/**
 * The statement with every allowed system table replaced by a subquery that keeps only allowlisted
 * rows, so joins and aggregates over it never see another table (the metadata class's filter).
 */
export function filterSystemRefs(classified: Classified, allowlist: readonly string[]): string {
  if (!classified.systemRefs.length) return classified.sql;
  const regex = sqlString(clickhouseRegex(allowlist));
  const base = classified.tokens[0]!.start;
  let out = "";
  let cursor = 0;
  for (const ref of [...classified.systemRefs].sort((a, b) => a.start - b.start)) {
    const column = ALLOWED_SYSTEM_TABLES[ref.table]!;
    out += classified.sql.slice(cursor, ref.start - base);
    out += `(SELECT * FROM system.${ref.table} WHERE match(concat(database, '.', ${column}), ${regex}))`;
    cursor = ref.end - base;
  }
  return out + classified.sql.slice(cursor);
}

/**
 * The lexer's view of the tables a statement reads, checked against the allowlist; `database` is
 * the data source's default database for unqualified names. Throws NOT_ALLOWED_TABLE.
 */
export function assertTablesAllowed(tables: readonly TableRef[], allowlist: readonly string[], database: string) {
  for (const ref of tables) {
    const db = ref.db ?? database;
    if (!tableAllowed(allowlist, db, ref.table)) throw new GuardError("NOT_ALLOWED_TABLE", `${db}.${ref.table} is not on this data source's allowlist`);
  }
}

/** The metadata targets checked before the statement runs (SHOW CREATE, DESCRIBE, EXISTS, SHOW TABLES FROM). */
export function assertMetadataAllowed(classified: Classified, allowlist: readonly string[], database: string) {
  const form = classified.metadata;
  if (!form) return;
  if (form.kind === "show_create" || form.kind === "describe" || form.kind === "exists") assertTablesAllowed([form.target], allowlist, database);
  if (form.kind === "show_tables" && !databaseAllowed(allowlist, form.db ?? database)) throw new GuardError("NOT_ALLOWED_TABLE", `${form.db ?? database} has no allowlisted tables`);
  if (form.kind === "explain") assertTablesAllowed(classified.tables, allowlist, database);
}

/**
 * Tables and table functions in `EXPLAIN QUERY TREE` output (`TABLE id: 3, alias: __table1,
 * table_name: db.t` and `TABLE_FUNCTION id: 4, …, table_function_name: numbers`).
 */
export type QueryTree = { tables: Array<{ db: string; table: string }>; functions: string[]; /** Every `FUNCTION … function_name:` the analyzer resolved (review H2). */ calls?: string[] };

const TREE_NAME = /^[A-Za-z0-9_]+$/;
const treeRefused = () => new GuardError("UNSUPPORTED_SYNTAX", "Nook could not check which tables this query reads; plain names (letters, digits, _) and simple aliases are required");

/**
 * Parses the tree strictly and fails closed (review follow-up): every line that carries
 * `table_name:`, `table_function_name:`, or `function_name:` must be a well-formed TABLE,
 * TABLE_FUNCTION, or FUNCTION line with exactly one such field, and the names must be plain
 * (`db.table` with letters, digits, and _). A quoted name with a dot or a comma, an alias that
 * repeats a field, or a line an alias split in two refuses the query instead of being guessed at.
 */
export function queryTreeTables(text: string): QueryTree {
  const tables: Array<{ db: string; table: string }> = [];
  const functions: string[] = [];
  const calls: string[] = [];
  const count = (line: string, field: string) => line.split(field).length - 1;
  for (const line of text.split("\n")) {
    const tableFields = count(line, "table_name: ");
    const tableFunctionFields = count(line, "table_function_name: ");
    const functionFields = count(line, "function_name: ") - tableFunctionFields;
    if (!tableFields && !tableFunctionFields && !functionFields) {
      if (/^\s*(TABLE|TABLE_FUNCTION|FUNCTION) id:/.test(line)) throw treeRefused();
      continue;
    }
    if (tableFields + tableFunctionFields + functionFields !== 1) throw treeRefused();
    if (tableFields) {
      if (!/^\s*TABLE id: \d+, /.test(line)) throw treeRefused();
      const rest = line.slice(line.indexOf("table_name: ") + "table_name: ".length);
      const match = /^([^.,\s]+)\.([^.,\s]+)((?:, (?:final|sample_size: [0-9./ ]+|sample_offset: [0-9./ ]+))*)\s*$/.exec(rest);
      if (!match || !TREE_NAME.test(match[1]!) || !TREE_NAME.test(match[2]!)) throw treeRefused();
      tables.push({ db: match[1]!, table: match[2]! });
    } else if (tableFunctionFields) {
      if (!/^\s*TABLE_FUNCTION id: \d+, /.test(line)) throw treeRefused();
      const match = /table_function_name: ([A-Za-z0-9_]+)(?:,|\s*$)/.exec(line);
      if (!match) throw treeRefused();
      functions.push(match[1]!);
    } else {
      if (!/^\s*FUNCTION id: \d+, /.test(line)) throw treeRefused();
      const match = /function_name: ([A-Za-z0-9_]+)(?:,|\s*$)/.exec(line);
      if (!match) throw treeRefused();
      calls.push(match[1]!);
    }
  }
  return { tables, functions, calls };
}

/** Table functions a select may use (anything else seen by EXPLAIN QUERY TREE is refused). */
// `view()` is left out until a real ClickHouse confirms its inner tables show up as TABLE nodes.
export const ALLOWED_TABLE_FUNCTIONS: ReadonlySet<string> = new Set(["numbers", "numbers_mt", "zeros", "zeros_mt", "values", "null", "generate_series", "generateseries"]);

/**
 * Checks parsed `EXPLAIN QUERY TREE` output against the allowlist (or, for the metadata class, the
 * allowed system tables). Throws GuardError.
 */
export function assertQueryTreeAllowed(tree: QueryTree, allowlist: readonly string[], database: string, statementClass: StatementClass) {
  for (const call of tree.calls ?? []) {
    if (isBannedFunction(call)) throw new GuardError("BANNED_FUNCTION", `${call}() is not allowed in a report query`);
  }
  for (const fn of tree.functions) {
    if (!ALLOWED_TABLE_FUNCTIONS.has(fn.toLowerCase())) throw new GuardError("BANNED_FUNCTION", `The table function ${fn}() is not allowed in a report query`);
  }
  for (const ref of tree.tables) {
    const db = ref.db || database;
    if (db.toLowerCase() === "system") {
      if (statementClass === "metadata" && Object.hasOwn(ALLOWED_SYSTEM_TABLES, ref.table)) continue;
      throw new GuardError("BANNED_TABLE", "This query reads a system table that reports cannot read");
    }
    if (!tableAllowed(allowlist, db, ref.table)) throw new GuardError("NOT_ALLOWED_TABLE", "This query reads a table that is not on this data source's allowlist (names behind views are not shown)");
  }
}
