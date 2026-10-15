import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { startFakeClickhouse, type FakeRequest } from "./support/fakeClickhouse";
import type { ReportSpec } from "../shared/reports";
import { parseArrayLiteral, placeholderInput, placeholderValue, unescapeParamString, escapeParamString, type ReportParameter } from "../shared/reportParams";

const { syncSchema } = await import("../server/reports/schemaCatalog");
const params = await import("../server/reports/params");
const { consoleBindings } = await import("../server/reports/service");

/**
 * D490: the SQL console binds a saved query's `{name:Type}` placeholders (Inspect → Open in console) as
 * `param_<name>` on the reports' guarded path. D491: a select's options search past the first 200 values
 * with a bound ILIKE on the options query's first column (read access, rate-limited), and a value found
 * that way is accepted by a parameter run.
 */

retireUsersAfterFile();
const fake = startFakeClickhouse(0);
afterAll(() => fake.stop());

/** 250 customers: more than a select lists (200). */
const CUSTOMERS = Array.from({ length: 250 }, (_, at) => `customer-${String(at).padStart(3, "0")}`);
/** ClickHouse's ILIKE on a value as sent (escaped text format): `\x` is a literal x, `%` any run, `_` one character. */
function likeToRegex(sent: string) {
  const pattern = sent.replace(/\\\\/g, "\\");
  let source = "";
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at]!;
    if (char === "\\" && at + 1 < pattern.length) { source += pattern[at + 1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); at += 1; }
    else if (char === "%") source += ".*";
    else if (char === "_") source += ".";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

function answer(sql: string, req: FakeRequest) {
  const meta = [{ name: "customer", type: "String" }];
  if (sql.includes("ILIKE {nook_search:String}")) {
    const pattern = likeToRegex(req.params.param_nook_search ?? "");
    return { meta, data: CUSTOMERS.filter((name) => pattern.test(name)).map((name) => [name]) };
  }
  if (sql.includes("IN {nook_values:Array(String)}")) {
    const wanted = [...(req.params.param_nook_values ?? "").matchAll(/'([^']*)'/g)].map((match) => match[1]!);
    return { meta, data: CUSTOMERS.filter((name) => wanted.includes(name)).map((name) => [name]) };
  }
  if (sql.includes("DISTINCT customer")) {
    // The options query keeps its own LIMIT 200 (exactly 200 rows come back); the wraps take it off.
    const limited = /LIMIT 200\s*\n\) LIMIT/.test(sql);
    return { meta, data: (limited ? CUSTOMERS.slice(0, 200) : CUSTOMERS).map((name) => [name]) };
  }
  return { meta: [{ name: "orders", type: "UInt64" }], data: [["5"]] };
}
beforeEach(() => {
  fake.reset();
  fake.state.select = answer;
  params.resetParamRateLimit();
  params.resetOptionSearchLimit();
});

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const OPTIONS_SQL = "SELECT DISTINCT customer FROM analytics.orders ORDER BY customer LIMIT 200";
const CUSTOMER: ReportParameter = { id: "customer", label: "Customer", type: "select", chType: "String", default: "customer-000", optionsQuery: OPTIONS_SQL };
const SAVED_SQL = "SELECT count() AS orders FROM analytics.orders WHERE customer = {customer:String} AND day >= {period_from:Date} AND id IN {ids:Array(UInt64)}";

function spec(): ReportSpec {
  return {
    version: 1, specVersion: 3, sections: [], parameters: [CUSTOMER],
    queries: [{ key: "totals", sql: "SELECT count() AS orders FROM analytics.orders WHERE customer = {customer:String}", purpose: "Orders", createdBy: "agent" }],
    blocks: [{ id: "kpi-orders", type: "kpi", title: "Orders", intent: "headline", queryKey: "totals", column: "orders" }]
  };
}

// ------------------------------------------------------------------------------- pure

describe("console placeholder values (shared/reportParams.ts)", () => {
  test("each type is checked and encoded as report parameters are; never SQL text", () => {
    expect(placeholderValue("Date", " 2026-10-01 ")).toEqual({ value: "2026-10-01" });
    expect(placeholderValue("Date", "2026-02-30")).toMatchObject({ problem: expect.stringContaining("YYYY-MM-DD") });
    expect(placeholderValue("UInt64", "42")).toEqual({ value: "42" });
    expect(placeholderValue("UInt64", "-1")).toMatchObject({ problem: "must not be negative" });
    expect(placeholderValue("Int32", "1 OR 1=1")).toMatchObject({ problem: expect.stringContaining("whole number") });
    expect(placeholderValue("Float64", "1.50")).toEqual({ value: "1.5" });
    expect(placeholderValue("Float64", "abc")).toMatchObject({ problem: "must be a number" });
    expect(placeholderValue("String", "o'k\\\tx")).toEqual({ value: "o'k\\\\\\tx" });
    expect(placeholderValue("String", "a\u0001")).toMatchObject({ problem: expect.stringContaining("control") });
    expect(placeholderValue("Array(String)", "['it\\'s', 'b']")).toEqual({ value: "['it\\'s','b']" });
    expect(placeholderValue("Array(String)", "[]")).toEqual({ value: "[]" });
    expect(placeholderValue("Array(String)", "['a'] || 1")).toMatchObject({ problem: expect.stringContaining("list") });
    expect(placeholderValue("Array(UInt64)", "[1, 2,3]")).toEqual({ value: "[1,2,3]" });
    expect(placeholderValue("Array(UInt64)", "[1, -2]")).toMatchObject({ problem: "must not be negative" });
    expect(placeholderValue("Identifier", "orders")).toMatchObject({ problem: expect.stringContaining("not supported") });
    expect(parseArrayLiteral("['a,b', 'c']", "String")).toEqual(["a,b", "c"]);
    expect(parseArrayLiteral("['a'", "String")).toBeNull();
  });

  test("a bound String reads back as typed (the console's prefill)", () => {
    for (const text of ["plain", "tab\there", "back\\slash", "line\nbreak"]) expect(unescapeParamString(escapeParamString(text))).toBe(text);
    expect(placeholderInput("String", "a\\tb")).toBe("a\tb");
    expect(placeholderInput("Array(String)", "['a']")).toBe("['a']");
  });

  test("consoleBindings: every placeholder needs a fitting value; one name, one type", () => {
    expect(consoleBindings(SAVED_SQL, { customer: "c'1", period_from: "2026-10-01", ids: "[7, 8]", extra: "ignored" })).toEqual([
      { name: "customer", type: "String", value: "c'1" },
      { name: "period_from", type: "Date", value: "2026-10-01" },
      { name: "ids", type: "Array(UInt64)", value: "[7,8]" }
    ]);
    expect(() => consoleBindings(SAVED_SQL, { customer: "x", period_from: "2026-10-01" })).toThrow("Enter a value for {ids:Array(UInt64)}");
    expect(() => consoleBindings(SAVED_SQL, { customer: "x", period_from: "yesterday", ids: "[]" })).toThrow("{period_from:Date} must be a day");
    expect(() => consoleBindings("SELECT {a:String}, {a:UInt64}", { a: "1" })).toThrow("two types");
    // A statement the guard refuses binds nothing (runGuarded refuses it with the guard's own error).
    expect(consoleBindings("SELECT {a:Identifier}", {})).toEqual([]);
    expect(consoleBindings("SELECT 1", {})).toEqual([]);
  });

  test("the options query loses only a plain trailing LIMIT", () => {
    expect(params.unlimitedOptionsSql(OPTIONS_SQL)).toBe("SELECT DISTINCT customer FROM analytics.orders ORDER BY customer");
    expect(params.unlimitedOptionsSql("SELECT DISTINCT c FROM t LIMIT 10 OFFSET 5;")).toBe("SELECT DISTINCT c FROM t");
    expect(params.unlimitedOptionsSql("SELECT DISTINCT c FROM t LIMIT 5, 10")).toBe("SELECT DISTINCT c FROM t");
    expect(params.unlimitedOptionsSql("SELECT c FROM (SELECT c FROM t LIMIT 3) ORDER BY c")).toBe("SELECT c FROM (SELECT c FROM t LIMIT 3) ORDER BY c");
    expect(params.unlimitedOptionsSql("SELECT c FROM t LIMIT 1 BY c")).toBe("SELECT c FROM t LIMIT 1 BY c");
    expect(params.likePattern("50%_a\\b")).toBe("%50\\%\\_a\\\\b%");
  });
});

// ------------------------------------------------------------------------------- server

const admin = await createUser("Console admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const owner = await createUser("Console owner");
const viewer = await createUser("Console team viewer");
db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
const stranger = await createUser("Console stranger");

const created = await send(admin, "POST", "/reports/admin/datasources", { name: "Console warehouse", url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
const datasourceId = created.body.datasource.id as string;
await syncSchema(datasourceId).catch(() => undefined);

async function seededReport() {
  const report = await send(owner, "POST", "/reports", { title: "Orders by customer", datasourceId });
  const id = report.body.report.id as string;
  db.query("UPDATE reports SET spec_json = ? WHERE id = ?").run(JSON.stringify(spec()), id);
  expect((await send(owner, "PUT", `/reports/${id}/sharing`, { visibility: "selected", shares: [{ kind: "user", id: viewer.userId, level: "view" }] })).status).toBe(200);
  return id;
}

const reportId = await seededReport();
const wrapped = () => fake.requests.filter((item) => item.sql.startsWith("SELECT * FROM ("));

describe("the SQL console binds placeholders (D490)", () => {
  test("values go as param_<name> with the tree check and the run; the SQL text never holds them", async () => {
    const ran = await send(owner, "POST", `/reports/${reportId}/console`, { sql: SAVED_SQL, params: { customer: "x'); DROP TABLE t; --", period_from: "2026-10-01", ids: "[1,2]" } });
    expect(ran.status).toBe(200);
    expect(ran.body.outcome.params).toEqual({ customer: "x'); DROP TABLE t; --", period_from: "2026-10-01", ids: "[1,2]" });
    const sent = wrapped();
    expect(sent.length).toBe(1);
    expect(sent[0]!.sql).toContain("{customer:String}");
    expect(sent[0]!.sql).not.toContain("DROP");
    expect(sent[0]!.params).toMatchObject({ param_customer: "x'); DROP TABLE t; --", param_period_from: "2026-10-01", param_ids: "[1,2]" });
    const tree = fake.requests.find((item) => item.sql.startsWith("EXPLAIN QUERY TREE"));
    expect(tree?.params.param_ids).toBe("[1,2]");
  });

  test("refused: a missing or misfit value (400 INVALID), placeholders with no values (the guard), an Identifier type; nothing reaches ClickHouse", async () => {
    const missing = await send(owner, "POST", `/reports/${reportId}/console`, { sql: SAVED_SQL, params: { customer: "x", period_from: "2026-10-01" } });
    expect(missing).toMatchObject({ status: 400, body: { code: "INVALID" } });
    expect(missing.body.error).toContain("{ids:Array(UInt64)}");
    const misfit = await send(owner, "POST", `/reports/${reportId}/console`, { sql: SAVED_SQL, params: { customer: "x", period_from: "2026-10-01", ids: "[1] OR 1" } });
    expect(misfit).toMatchObject({ status: 400, body: { code: "INVALID" } });
    const bare = await send(owner, "POST", `/reports/${reportId}/console`, { sql: SAVED_SQL });
    expect(bare).toMatchObject({ status: 400, body: { code: "GUARD" } });
    const identifier = await send(owner, "POST", `/reports/${reportId}/console`, { sql: "SELECT * FROM {t:Identifier}", params: { t: "orders" } });
    expect(identifier).toMatchObject({ status: 400, body: { code: "GUARD" } });
    const metadata = await send(owner, "POST", `/reports/${reportId}/console`, { sql: "SHOW TABLES LIKE {p:String}", params: { p: "x" } });
    expect(metadata).toMatchObject({ status: 400, body: { code: "GUARD" } });
    expect(wrapped().length).toBe(0);
    // The console stays the owner's.
    expect((await send(viewer, "POST", `/reports/${reportId}/console`, { sql: "SELECT {a:String}", params: { a: "x" } })).status).toBe(403);
    expect((await send(stranger, "POST", `/reports/${reportId}/console`, { sql: "SELECT {a:String}", params: { a: "x" } })).status).toBe(404);
  });
});

describe("option search past the first 200 (D491)", () => {
  test("the cached list stops at 200; q searches the whole column with a bound ILIKE, at most 200", async () => {
    const first = await send(viewer, "GET", `/reports/${reportId}/parameters/customer/options`);
    expect(first.body.options).toMatchObject({ truncated: true });
    expect(first.body.options.options.length).toBe(200);
    expect(first.body.options.options).not.toContain("customer-240");
    fake.requests.length = 0;
    const found = await send(viewer, "GET", `/reports/${reportId}/parameters/customer/options?q=${encodeURIComponent("ER-24")}`);
    expect(found.status).toBe(200);
    expect(found.body.options).toMatchObject({ paramId: "customer", query: "ER-24", truncated: false, error: null });
    expect(found.body.options.options).toEqual(CUSTOMERS.filter((name) => name.includes("er-24")));
    const search = wrapped().find((item) => item.sql.includes("ILIKE"))!;
    expect(search.sql).toContain("ORDER BY customer\n) AS nook_options WHERE toString(`customer`) ILIKE {nook_search:String}");
    expect(search.sql).not.toContain("LIMIT 200\n)");
    expect(search.params.param_nook_search).toBe("%ER-24%");
    // A wildcard is a plain character: "%" finds nothing.
    const literal = await send(viewer, "GET", `/reports/${reportId}/parameters/customer/options?q=${encodeURIComponent("%")}`);
    expect(literal.body.options.options).toEqual([]);
    // An empty box is the cached list.
    fake.requests.length = 0;
    const empty = await send(viewer, "GET", `/reports/${reportId}/parameters/customer/options?q=%20`);
    expect(empty.body.options.options.length).toBe(200);
    expect(wrapped().length).toBe(0);
  });

  test("read access is checked; searches are rate-limited per person", async () => {
    expect((await send(stranger, "GET", `/reports/${reportId}/parameters/customer/options?q=1`)).status).toBe(404);
    expect((await send(viewer, "GET", `/reports/${reportId}/parameters/nope/options?q=1`)).status).toBe(404);
    let limited = 0;
    for (let at = 0; at < params.OPTION_SEARCH.perMinute + 2; at += 1) {
      const result = await send(viewer, "GET", `/reports/${reportId}/parameters/customer/options?q=${at}`);
      if (result.status === 429) limited += 1;
    }
    expect(limited).toBe(2);
  });

  test("a value found by search runs (checked past the 200 with a bound IN); a made-up one is refused", async () => {
    const ran = await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { customer: "customer-240" } });
    expect(ran.status).toBe(200);
    const check = wrapped().find((item) => item.sql.includes("IN {nook_values:Array(String)}"))!;
    expect(check.params.param_nook_values).toBe("['customer-240']");
    expect(ran.body.results.find((item: Json) => item.queryKey === "totals").result.rows).toEqual([["5"]]);
    const madeUp = await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { customer: "customer-999" } });
    expect(madeUp).toMatchObject({ status: 400, body: { code: "INVALID" } });
    expect(madeUp.body.error).toContain("not one of the choices for Customer");
  });
});
