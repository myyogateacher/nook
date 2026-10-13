import { describe, expect, test } from "bun:test";
import {
  assertMetadataAllowed, assertQueryTreeAllowed, assertTablesAllowed, classify, filterSystemRefs, GuardError, isBannedFunction, lex, queryTreeTables, wrapSelect
} from "../server/reports/sqlGuard";
import { clickhouseRegex, databaseAllowed, normalizeAllowlist, normalizePattern, tableAllowed } from "../server/reports/allowlist";

/**
 * The report SQL guard (Wave 45, D411, D412, T356): one statement, select or metadata class, banned
 * keywords, functions, and system tables refused however they are spelled, the LIMIT wrap, the
 * allowlist, and the EXPLAIN QUERY TREE check. About sixty bypass attempts, each refused with a code.
 */

const ALLOW = normalizeAllowlist(["analytics", "staging.orders_*"]);

function refused(sql: string): string {
  try {
    const classified = classify(sql);
    assertTablesAllowed(classified.tables, ALLOW, "analytics");
    assertMetadataAllowed(classified, ALLOW, "analytics");
  } catch (error) {
    if (error instanceof GuardError) return error.code;
    throw error;
  }
  return "ALLOWED";
}

describe("allowed statements", () => {
  test.each([
    ["SELECT 1", "select"],
    ["select count() from events", "select"],
    ["SELECT toStartOfDay(ts) AS day, sum(amount) FROM analytics.orders WHERE ts > now() - INTERVAL 7 DAY GROUP BY day ORDER BY day DESC", "select"],
    ["WITH totals AS (SELECT user_id, sum(x) AS s FROM orders GROUP BY user_id) SELECT * FROM totals ORDER BY s DESC LIMIT 10", "select"],
    ["SELECT * FROM staging.orders_2026 LIMIT 5;", "select"],
    ["SELECT a FROM events -- a trailing comment", "select"],
    ["SELECT /* inline */ a FROM events", "select"],
    ["SELECT 'it''s; a string with -- and /* */ and system.users', `weird name` FROM events", "select"],
    ["SELECT \"col\" FROM \"analytics\".\"events\"", "select"],
    ["SELECT formatDateTime(ts, '%Y'), concat(a, ' x') FROM events", "select"],
    ["SELECT x > 1 ? 'a' : 'b', arrayMap(v -> v * 2, [1, 2]) FROM events", "select"],
    ["SELECT number FROM numbers(10)", "select"],
    ["SELECT a FROM events ORDER BY a DESC", "select"],
    ["SELECT name, comment FROM system.tables", "metadata"],
    ["SELECT t.name, c.name FROM system.tables AS t JOIN system.columns AS c ON c.table = t.name AND c.database = t.database", "metadata"],
    ["SHOW DATABASES", "metadata"],
    ["SHOW TABLES", "metadata"],
    ["SHOW TABLES FROM analytics LIKE '%order%'", "metadata"],
    ["SHOW CREATE TABLE analytics.events", "metadata"],
    ["DESCRIBE TABLE events", "metadata"],
    ["DESC analytics.events", "metadata"],
    ["EXISTS TABLE analytics.events", "metadata"],
    ["EXPLAIN SELECT count() FROM events", "metadata"],
    ["EXPLAIN ESTIMATE SELECT count() FROM events", "metadata"],
    ["EXPLAIN SYNTAX SELECT a FROM events", "metadata"],
    // Review H1: commas after WHERE and ORDER BY are not tables; ARRAY JOIN names columns; IN (subquery) and IN a CTE.
    ["SELECT a, b FROM events WHERE a = 1 ORDER BY a, b", "select"],
    ["SELECT a FROM events ARRAY JOIN arr AS x, other_arr", "select"],
    ["SELECT * FROM events AS e, analytics.orders AS o WHERE e.id = o.id", "select"],
    ["SELECT * FROM events WHERE id IN (SELECT id FROM orders)", "select"],
    ["WITH ids AS (SELECT 1) SELECT * FROM events WHERE id IN ids", "select"],
    ["SELECT * FROM events WHERE id NOT IN tuple(1, 2)", "select"],
    // Follow-up: IN an alias the query defines is not a table.
    ["WITH [1, 2] AS ids SELECT * FROM events WHERE id IN ids", "select"],
    ["SELECT id AS picked FROM events WHERE id IN picked", "select"]
  ])("%s", (sql, expected) => {
    expect(refused(sql)).toBe("ALLOWED");
    expect(classify(sql).class).toBe(expected as "select" | "metadata");
  });
});

describe("bypass attempts are refused", () => {
  test.each([
    // Not a select, or more than one statement.
    ["", "EMPTY"],
    ["  ;; ", "EMPTY"],
    ["-- only a comment", "EMPTY"],
    ["INSERT INTO events VALUES (1)", "NOT_SELECT"],
    ["DROP TABLE events", "NOT_SELECT"],
    ["ALTER TABLE events DELETE WHERE 1", "NOT_SELECT"],
    ["SET readonly = 0", "NOT_SELECT"],
    ["KILL QUERY WHERE 1", "NOT_SELECT"],
    ["SYSTEM SHUTDOWN", "NOT_SELECT"],
    ["(SELECT 1)", "NOT_SELECT"],
    ["SELECT 1; DROP TABLE events", "MULTI_STATEMENT"],
    ["SELECT 1; SELECT 2", "MULTI_STATEMENT"],
    ["SELECT 1 /* ; */ ; INSERT INTO t VALUES (1)", "MULTI_STATEMENT"],
    // Clauses that write, change settings, or change the format.
    ["SELECT * FROM events INTO OUTFILE '/tmp/x'", "BANNED_KEYWORD"],
    ["SELECT * FROM events SETTINGS readonly = 0", "BANNED_KEYWORD"],
    ["SELECT * FROM events settings max_execution_time = 100000", "BANNED_KEYWORD"],
    ["SELECT * FROM events FORMAT TabSeparated", "BANNED_KEYWORD"],
    ["SELECT * FROM (SELECT * FROM events SETTINGS max_threads = 64)", "BANNED_KEYWORD"],
    ["SELECT * FROM (EXPLAIN SELECT * FROM secret.t)", "BANNED_KEYWORD"],
    ["SELECT * FROM (SHOW GRANTS)", "BANNED_KEYWORD"],
    ["SELECT * FROM (DESCRIBE TABLE secret.t)", "BANNED_KEYWORD"],
    // External and unbounded table functions, however spelled, wherever they sit.
    ["SELECT * FROM url('http://169.254.169.254/latest/meta-data/', CSV, 'a String')", "BANNED_FUNCTION"],
    ["SELECT * FROM URL ('http://x', CSV, 'a String')", "BANNED_FUNCTION"],
    ["SELECT * FROM `url`('http://x', CSV, 'a String')", "BANNED_FUNCTION"],
    ["SELECT * FROM \"url\"('http://x', CSV, 'a String')", "BANNED_FUNCTION"],
    ["SELECT * FROM url/**/('http://x', CSV, 'a String')", "BANNED_FUNCTION"],
    ["SELECT * FROM url --\n('http://x', CSV, 'a String')", "BANNED_FUNCTION"],
    ["SELECT * FROM s3('https://bucket/x.csv')", "BANNED_FUNCTION"],
    ["SELECT * FROM s3Cluster('c', 'https://bucket/x.csv')", "BANNED_FUNCTION"],
    ["SELECT * FROM file('/etc/passwd', 'LineAsString')", "BANNED_FUNCTION"],
    ["SELECT * FROM remote('10.0.0.5', default.t)", "BANNED_FUNCTION"],
    ["SELECT * FROM remoteSecure('10.0.0.5', default.t)", "BANNED_FUNCTION"],
    ["SELECT * FROM cluster('default', system.users)", "BANNED_FUNCTION"],
    ["SELECT * FROM clusterAllReplicas('default', analytics.events)", "BANNED_FUNCTION"],
    ["SELECT * FROM mysql('db:3306', 'x', 't', 'u', 'p')", "BANNED_FUNCTION"],
    ["SELECT * FROM postgresql('db:5432', 'x', 't', 'u', 'p')", "BANNED_FUNCTION"],
    ["SELECT * FROM jdbc('jdbc:x', 't')", "BANNED_FUNCTION"],
    ["SELECT * FROM odbc('dsn', 't')", "BANNED_FUNCTION"],
    ["SELECT * FROM hdfs('hdfs://x', 'CSV', 'a String')", "BANNED_FUNCTION"],
    ["SELECT * FROM executable('cat /etc/passwd', 'CSV', 'a String')", "BANNED_FUNCTION"],
    ["SELECT * FROM input('a String')", "BANNED_FUNCTION"],
    ["SELECT * FROM merge('secret', '.*')", "BANNED_FUNCTION"],
    ["SELECT * FROM icebergS3('https://x')", "BANNED_FUNCTION"],
    ["SELECT * FROM azureBlobStorage('x')", "BANNED_FUNCTION"],
    ["SELECT * FROM dictionary('secret_dict')", "BANNED_FUNCTION"],
    // format() is also a table function, so the string function of that name is refused too (use concat).
    ["SELECT * FROM format(CSV, 'a String', '1')", "BANNED_FUNCTION"],
    ["WITH x AS (SELECT * FROM url('http://x', CSV, 'a String')) SELECT * FROM x", "BANNED_FUNCTION"],
    ["SELECT a FROM events WHERE a IN (SELECT b FROM s3('https://x'))", "BANNED_FUNCTION"],
    ["SELECT (SELECT count() FROM remote('h', 'db.t')) AS n", "BANNED_FUNCTION"],
    ["SELECT dictGetString('secret', 'v', toUInt64(1))", "BANNED_FUNCTION"],
    ["SELECT joinGet('secret.join_table', 'v', 1)", "BANNED_FUNCTION"],
    ["SELECT sleepEachRow(3) FROM events", "BANNED_FUNCTION"],
    ["SELECT hostName(), getMacro('replica')", "BANNED_FUNCTION"],
    ["SELECT hasColumnInTable('secret', 't', 'c')", "BANNED_FUNCTION"],
    ["SELECT filesystemAvailable()", "BANNED_FUNCTION"],
    // System tables: only five, and never mixed with other tables.
    ["SELECT * FROM system.users", "BANNED_TABLE"],
    ["SELECT * FROM SYSTEM.grants", "BANNED_TABLE"],
    ["SELECT * FROM `system`.`query_log`", "BANNED_TABLE"],
    ["SELECT * FROM \"system\".\"processes\"", "BANNED_TABLE"],
    ["SELECT * FROM system . quotas", "BANNED_TABLE"],
    ["SELECT * FROM system/**/.users", "BANNED_TABLE"],
    ["SELECT * FROM events WHERE user_id IN (SELECT name FROM system.users)", "BANNED_TABLE"],
    ["WITH u AS (SELECT * FROM system.users) SELECT * FROM u", "BANNED_TABLE"],
    ["SELECT * FROM view(SELECT * FROM system.quotas)", "BANNED_TABLE"],
    ["SELECT * FROM system.tables JOIN analytics.events ON 1", "BANNED_TABLE"],
    ["SELECT * FROM information_schema.tables", "BANNED_TABLE"],
    ["SELECT * FROM INFORMATION_SCHEMA.COLUMNS", "BANNED_TABLE"],
    ["EXPLAIN SELECT * FROM system.users", "BANNED_TABLE"],
    ["EXPLAIN SELECT * FROM system.tables", "BANNED_TABLE"],
    ["DESCRIBE system.users", "BANNED_TABLE"],
    ["SHOW CREATE TABLE system.users", "BANNED_TABLE"],
    ["SHOW TABLES FROM system", "BANNED_TABLE"],
    // Metadata statements that are not on the list.
    ["SHOW GRANTS", "METADATA_FORBIDDEN"],
    ["SHOW USERS", "METADATA_FORBIDDEN"],
    ["SHOW PROCESSLIST", "METADATA_FORBIDDEN"],
    ["SHOW SETTINGS LIKE '%'", "METADATA_FORBIDDEN"],
    ["SHOW ACCESS", "METADATA_FORBIDDEN"],
    ["EXPLAIN AST SELECT 1", "METADATA_FORBIDDEN"],
    ["EXPLAIN PIPELINE SELECT 1", "METADATA_FORBIDDEN"],
    ["EXPLAIN QUERY TREE SELECT 1", "METADATA_FORBIDDEN"],
    ["EXPLAIN INSERT INTO t VALUES (1)", "UNSUPPORTED_SYNTAX"],
    ["SHOW TABLES; DROP TABLE x", "MULTI_STATEMENT"],
    ["DESCRIBE events extra", "UNSUPPORTED_SYNTAX"],
    // Review H1: comma joins and IN <table> are seen too.
    ["SELECT * FROM events, secret.salaries", "NOT_ALLOWED_TABLE"],
    ["SELECT * FROM events AS e, secret.salaries AS s", "NOT_ALLOWED_TABLE"],
    ["SELECT * FROM (SELECT 1) AS a, staging.users", "NOT_ALLOWED_TABLE"],
    ["SELECT * FROM events WHERE id IN secret.salaries", "NOT_ALLOWED_TABLE"],
    ["SELECT * FROM events WHERE id GLOBAL NOT IN staging.users", "NOT_ALLOWED_TABLE"],
    ["SELECT * FROM events WHERE id IN `secret`.`salaries`", "NOT_ALLOWED_TABLE"],
    // Review H2: escapes in quoted names are refused (ClickHouse would decode \x69 to "i").
    ["SELECT `jo\\x69nGet`('secret.join_table', 'v', 1)", "UNSUPPORTED_SYNTAX"],
    ["SELECT \"hostNam\\x65\"()", "UNSUPPORTED_SYNTAX"],
    ["SELECT * FROM `sys\\x74em`.users", "UNSUPPORTED_SYNTAX"],
    // Follow-up: a line break in a quoted alias would split a tree line in two.
    ["SELECT 1 AS `a\nTABLE id: 1, table_name: analytics.events` FROM events", "UNSUPPORTED_SYNTAX"],
    ["SELECT 1 AS \"a\tb\" FROM events", "UNSUPPORTED_SYNTAX"],
    // An alias does not hide a qualified table after IN.
    ["WITH [1] AS salaries SELECT * FROM events WHERE id IN secret.salaries", "NOT_ALLOWED_TABLE"],
    // Review M1: SHOW CREATE needs TABLE.
    ["SHOW CREATE USER default", "METADATA_FORBIDDEN"],
    ["SHOW CREATE QUOTA default", "METADATA_FORBIDDEN"],
    ["SHOW CREATE ROW POLICY p ON analytics.events", "METADATA_FORBIDDEN"],
    ["SHOW CREATE DATABASE analytics", "METADATA_FORBIDDEN"],
    ["SHOW CREATE events", "METADATA_FORBIDDEN"],
    // Review L4.
    ["SELECT getServerSetting('max_server_memory_usage')", "BANNED_FUNCTION"],
    ["SELECT getMergeTreeSetting('index_granularity')", "BANNED_FUNCTION"],
    ["SELECT serverUUID()", "BANNED_FUNCTION"],
    ["SELECT tcpPort()", "BANNED_FUNCTION"],
    // The allowlist (what the lexer sees; EXPLAIN QUERY TREE is the authority).
    ["SELECT * FROM secret.salaries", "NOT_ALLOWED_TABLE"],
    ["SELECT * FROM events JOIN secret.salaries USING (id)", "NOT_ALLOWED_TABLE"],
    ["SELECT * FROM staging.users", "NOT_ALLOWED_TABLE"],
    ["DESCRIBE TABLE secret.salaries", "NOT_ALLOWED_TABLE"],
    ["SHOW CREATE TABLE staging.users", "NOT_ALLOWED_TABLE"],
    ["SHOW TABLES FROM secret", "NOT_ALLOWED_TABLE"],
    ["EXPLAIN ESTIMATE SELECT * FROM secret.t", "NOT_ALLOWED_TABLE"],
    // Lexer ambiguity: refused, never interpreted.
    ["SELECT 1 # comment\n FROM url('x')", "UNSUPPORTED_SYNTAX"],
    ["SELECT 1 /* outer /* inner */ FROM url('x') */", "UNSUPPORTED_SYNTAX"],
    ["SELECT 1 /* never closed", "UNTERMINATED"],
    ["SELECT 'never closed", "UNTERMINATED"],
    ["SELECT `never closed FROM t", "UNTERMINATED"],
    ["SELECT $$heredoc$$", "UNSUPPORTED_SYNTAX"],
    ["SELECT {name:String}", "UNSUPPORTED_SYNTAX"],
    ["SELECT 1 \\G", "UNSUPPORTED_SYNTAX"],
    ["SELECT 1\u0000; DROP TABLE t", "UNSUPPORTED_SYNTAX"],
    ["SELECT 1 FROM ｓystem.users", "NON_ASCII"],
    ["SELECT 1 FROM events", "NON_ASCII"],
    ["SELECT 1 FROM events ; DROP TABLE t", "UNSUPPORTED_SYNTAX"],
    ["SELECT 1 FROM e​vents", "NON_ASCII"],
    ["SELECT a FROM events WHERE a = 1 & 2", "UNSUPPORTED_SYNTAX"],
    ["SELECT " + "x".repeat(20_001), "TOO_LONG"],
    // A column named like a clause must be quoted.
    ["SELECT format FROM events", "BANNED_KEYWORD"],
    ["SELECT settings FROM events", "BANNED_KEYWORD"]
  ])("%s", (sql, code) => {
    expect(refused(sql)).toBe(code);
  });
});

describe("lexing, wrapping, and filtering", () => {
  test("comments are blanked in the text that is sent; strings stay as written", () => {
    const { stripped } = lex("SELECT 'a -- b' /* c */ -- d\nFROM events");
    expect(stripped).toBe(`SELECT 'a -- b'${" ".repeat(13)}\nFROM events`);
    expect(classify("SELECT 1 -- trailing").sql).toBe("SELECT 1");
    expect(classify("SELECT 1;;").sql).toBe("SELECT 1");
  });

  test("the wrap caps rows at max + 1 and survives a trailing comment", () => {
    const sql = classify("SELECT a FROM events -- note").sql;
    expect(wrapSelect(sql, 100)).toBe("SELECT * FROM (\nSELECT a FROM events\n) LIMIT 101");
    expect(wrapSelect("SELECT 1", 0)).toBe("SELECT * FROM (\nSELECT 1\n) LIMIT 2");
  });

  test("system tables are read through allowlist-filtered subqueries", () => {
    const classified = classify("SELECT t.name, c.name FROM system.tables AS t JOIN system . columns c ON c.table = t.name");
    const sent = filterSystemRefs(classified, ["analytics.*"]);
    expect(sent).toBe("SELECT t.name, c.name FROM (SELECT * FROM system.tables WHERE match(concat(database, '.', name), '^(?:analytics\\\\..*)$')) AS t JOIN (SELECT * FROM system.columns WHERE match(concat(database, '.', table), '^(?:analytics\\\\..*)$')) c ON c.table = t.name");
    expect(filterSystemRefs(classify("SELECT count() FROM system.parts"), [])).toContain("'^(?!)$'");
  });

  test("banned names by prefix and exactly", () => {
    for (const name of ["s3", "S3Cluster", "remoteSecure", "clusterAllReplicas", "hdfsCluster", "deltaLakeCluster", "dictGetOrDefault", "joinGetOrNull", "sleep", "url", "URL", "kafkaTopic"]) expect(isBannedFunction(name)).toBe(true);
    for (const name of ["sum", "count", "formatDateTime", "urlDecode", "URLHierarchy", "toStartOfDay", "numbers", "arrayMap"]) expect(isBannedFunction(name)).toBe(false);
  });
});

describe("EXPLAIN QUERY TREE", () => {
  const tree = [
    "QUERY id: 0",
    "  JOIN TREE",
    "    JOIN id: 3, strictness: ALL, kind: INNER",
    "      LEFT TABLE EXPRESSION",
    "        TABLE id: 4, alias: __table1, table_name: analytics.events",
    "      RIGHT TABLE EXPRESSION",
    "        TABLE id: 5, alias: __table2, table_name: secret.salaries",
    "    TABLE_FUNCTION id: 6, alias: __table3, table_function_name: numbers"
  ].join("\n");

  test("lists every table and table function the analyzer resolved", () => {
    expect(queryTreeTables(tree)).toEqual({ tables: [{ db: "analytics", table: "events" }, { db: "secret", table: "salaries" }], functions: ["numbers"], calls: [] });
  });

  test("a banned function the lexer did not see (review H2) is refused from the tree's FUNCTION lines", () => {
    const calls = queryTreeTables("QUERY id: 0\n  PROJECTION\n    LIST id: 1, nodes: 1\n      FUNCTION id: 2, function_name: joinGet, function_type: ordinary, result_type: String\n      FUNCTION id: 3, function_name: plus, function_type: ordinary");
    expect(calls.calls).toEqual(["joinGet", "plus"]);
    expect(() => assertQueryTreeAllowed({ ...calls, tables: [] }, ALLOW, "analytics", "select")).toThrow(/joinGet/);
    expect(() => assertQueryTreeAllowed({ tables: [], functions: [], calls: ["plus", "sum", "toStartOfDay"] }, ALLOW, "analytics", "select")).not.toThrow();
  });

  test("follow-up: TABLE, TABLE_FUNCTION, and FUNCTION lines are parsed strictly; anything odd refuses the query", () => {
    const refused = (text: string) => { try { queryTreeTables(text); return "parsed"; } catch (error) { return error instanceof GuardError ? error.code : "other"; } };
    // Accepted: plain names, an alias, FINAL and sample modifiers.
    expect(queryTreeTables("    TABLE id: 3, alias: __table1, table_name: analytics.events, final").tables).toEqual([{ db: "analytics", table: "events" }]);
    expect(queryTreeTables("    TABLE id: 3, table_name: analytics.events, sample_size: 1/10").tables).toEqual([{ db: "analytics", table: "events" }]);
    // Refused: a quoted name with a dot or a comma, no database, odd characters.
    expect(refused("    TABLE id: 3, alias: __table1, table_name: analytics.a.b")).toBe("UNSUPPORTED_SYNTAX");
    expect(refused("    TABLE id: 3, alias: __table1, table_name: analytics.a,b")).toBe("UNSUPPORTED_SYNTAX");
    expect(refused("    TABLE id: 3, alias: __table1, table_name: analytics.x, y")).toBe("UNSUPPORTED_SYNTAX");
    expect(refused("    TABLE id: 3, table_name: events")).toBe("UNSUPPORTED_SYNTAX");
    expect(refused("    TABLE id: 3, table_name: analytics.ev-nts")).toBe("UNSUPPORTED_SYNTAX");
    // Refused: an alias that repeats the field, a line an alias split, a TABLE line with no name.
    expect(refused("    TABLE id: 3, alias: x, table_name: analytics.events, table_name: secret.salaries")).toBe("UNSUPPORTED_SYNTAX");
    expect(refused("    TABLE id: 3, alias: a\nb, table_name: secret.salaries")).toBe("UNSUPPORTED_SYNTAX");
    expect(refused("    TABLE id: 3, alias: x")).toBe("UNSUPPORTED_SYNTAX");
    expect(refused("    TABLE_FUNCTION id: 4, table_function_name: url(x)")).toBe("UNSUPPORTED_SYNTAX");
    expect(refused("    FUNCTION id: 5, function_name: join\"Get")).toBe("UNSUPPORTED_SYNTAX");
    expect(refused("    CONSTANT id: 6, function_name: joinGet")).toBe("UNSUPPORTED_SYNTAX");
  });

  test("follow-up: view() is not an allowed table function yet", () => {
    expect(() => assertQueryTreeAllowed({ tables: [], functions: ["view"] }, ALLOW, "analytics", "select")).toThrow(GuardError);
    expect(() => assertQueryTreeAllowed({ tables: [], functions: ["numbers", "values"] }, ALLOW, "analytics", "select")).not.toThrow();
  });

  test("follow-up: IN skips the query's own aliases only for unqualified names", () => {
    const allow = ["analytics.events"];
    expect(() => assertTablesAllowed(classify("SELECT * FROM events WHERE id IN salaries").tables, allow, "analytics")).toThrow(GuardError);
    expect(() => assertTablesAllowed(classify("WITH [1] AS salaries SELECT * FROM events WHERE id IN salaries").tables, allow, "analytics")).not.toThrow();
    expect(() => assertTablesAllowed(classify("WITH salaries AS (SELECT 1) SELECT * FROM events WHERE id IN salaries").tables, allow, "analytics")).not.toThrow();
    // A CTE name does not hide a FROM table of another database.
    expect(() => assertTablesAllowed(classify("WITH salaries AS (SELECT 1) SELECT * FROM secret.salaries").tables, allow, "analytics")).toThrow(GuardError);
  });

  test("a table off the allowlist, a system table, or an unknown table function is refused", () => {
    expect(() => assertQueryTreeAllowed(queryTreeTables(tree), ALLOW, "analytics", "select")).toThrow(/not on this data source/);
    expect(() => assertQueryTreeAllowed({ tables: [{ db: "analytics", table: "events" }], functions: ["numbers"] }, ALLOW, "analytics", "select")).not.toThrow();
    expect(() => assertQueryTreeAllowed({ tables: [{ db: "system", table: "tables" }], functions: [] }, ALLOW, "analytics", "select")).toThrow(GuardError);
    expect(() => assertQueryTreeAllowed({ tables: [{ db: "system", table: "tables" }], functions: [] }, ALLOW, "analytics", "metadata")).not.toThrow();
    expect(() => assertQueryTreeAllowed({ tables: [{ db: "system", table: "users" }], functions: [] }, ALLOW, "analytics", "metadata")).toThrow(GuardError);
    expect(() => assertQueryTreeAllowed({ tables: [], functions: ["url"] }, ALLOW, "analytics", "select")).toThrow(/url/);
    // A view or an IN table the lexer cannot see is still caught here.
    expect(() => assertQueryTreeAllowed({ tables: [{ db: "", table: "secret_view" }], functions: [] }, ["analytics.events"], "analytics", "select")).toThrow(/names behind views are not shown/);
  });
});

describe("allowlists", () => {
  test("patterns are normalized, globbed, and never reach system databases", () => {
    expect(normalizePattern(" analytics ")).toBe("analytics.*");
    expect(normalizePattern("staging.events_*")).toBe("staging.events_*");
    for (const bad of ["system", "system.*", "INFORMATION_SCHEMA.tables", "*.*", "*", "s?stem.x", "a.b.c", "db.`x`", "", "db;drop"]) expect(() => normalizePattern(bad)).toThrow();
    expect(tableAllowed(ALLOW, "analytics", "anything")).toBe(true);
    expect(tableAllowed(ALLOW, "staging", "orders_2026")).toBe(true);
    expect(tableAllowed(ALLOW, "staging", "users")).toBe(false);
    expect(tableAllowed(["*_prod.*"], "system", "users")).toBe(false);
    expect(databaseAllowed(ALLOW, "staging")).toBe(true);
    expect(databaseAllowed(ALLOW, "raw")).toBe(false);
    expect(clickhouseRegex(["analytics.ev?nts_*"])).toBe("^(?:analytics\\.ev.nts_.*)$");
  });
});
