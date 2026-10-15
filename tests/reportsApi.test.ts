import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse } from "./support/fakeClickhouse";

const { config } = await import("../server/config");
const { rotateSecretsKey, verifySecrets, openSecret } = await import("../server/agents/secrets");
const { reportTools } = await import("../server/reports/mcpTools");
const { visibleTools } = await import("../server/mcpTools");
const { syncSchema } = await import("../server/reports/schemaCatalog");

/**
 * Analytics reports, Wave 45 over HTTP (API_CONTRACTS § Analytics reports): admin data sources
 * (write-only password, Test connection warnings, the allowlist preview, Re-sync), drafts and the
 * Bin, the guarded console (what reaches ClickHouse), the Schema browser routes, guests and members
 * kept out of admin routes, data source secrets under key rotation, and the MCP read tools.
 */

const fake = startFakeClickhouse(0);
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

const PASSWORD = `ch-CANARY-${crypto.randomUUID()}`;
type Json = Record<string, any>;

async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json; text: string }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {}, text };
}

async function role(label: string, value: "admin" | "member" | "viewer" | "guest") {
  const session = await createUser(label);
  db.query("UPDATE users SET role = ? WHERE id = ?").run(value, session.userId);
  return session;
}

const admin = await role("Reports admin", "admin");
const member = await role("Reports member", "member");
const other = await role("Reports other", "member");
const viewer = await role("Reports viewer", "viewer");
const guest = await role("Reports guest", "guest");

async function newDatasource(name: string, extra: Json = {}) {
  const created = await send(admin, "POST", "/reports/admin/datasources", { name, url: fake.url, username: "nook_ro", password: PASSWORD, database: "analytics", allowlist: ["analytics", "staging.orders_*"], ...extra });
  expect(created.status).toBe(201);
  // Saving starts a schema sync in the background: let it settle, so no request of it lands mid-test.
  await syncSchema(created.body.datasource.id).catch(() => undefined);
  fake.requests.length = 0;
  return created.body.datasource as Json;
}

describe("admin data sources", () => {
  test("CRUD; the password is write-only and never reaches a response or the audit log", async () => {
    const datasource = await newDatasource("Warehouse A");
    expect(datasource).toMatchObject({ name: "Warehouse A", kind: "clickhouse", username: "nook_ro", database: "analytics", allowlist: ["analytics.*", "staging.orders_*"], maxRows: 10000, timeoutS: 20, enabled: true, hasPassword: true });
    expect(JSON.stringify(datasource)).not.toContain(PASSWORD);
    const stored = db.query("SELECT password_ct FROM report_datasources WHERE id = ?").get(datasource.id) as { password_ct: string };
    expect(stored.password_ct.startsWith("v1:")).toBe(true);
    expect(openSecret("datasource", datasource.id, stored.password_ct)).toBe(PASSWORD);
    // Bound to its row: another owner or row cannot open it.
    expect(() => openSecret("provider", datasource.id, stored.password_ct)).toThrow();

    const list = await send(admin, "GET", "/reports/admin/datasources");
    expect(list.text).not.toContain(PASSWORD);
    const patched = await send(admin, "PATCH", `/reports/admin/datasources/${datasource.id}`, { expectedRevision: datasource.revision, maxRows: 500, enabled: false });
    expect(patched.body.datasource).toMatchObject({ maxRows: 500, enabled: false, hasPassword: true, revision: datasource.revision + 1 });
    expect((await send(admin, "PATCH", `/reports/admin/datasources/${datasource.id}`, { expectedRevision: datasource.revision, maxRows: 5 })).status).toBe(409);
    const removed = await send(admin, "PATCH", `/reports/admin/datasources/${datasource.id}`, { expectedRevision: datasource.revision + 1, removePassword: true });
    expect(removed.body.datasource.hasPassword).toBe(false);
    // Review L3: a new password, then a new host without one, clears it; a new path on the same host keeps it.
    const withPassword = await send(admin, "PATCH", `/reports/admin/datasources/${datasource.id}`, { expectedRevision: datasource.revision + 2, password: PASSWORD });
    expect(withPassword.body.datasource.hasPassword).toBe(true);
    const samePath = await send(admin, "PATCH", `/reports/admin/datasources/${datasource.id}`, { expectedRevision: datasource.revision + 3, url: `${fake.url}proxy` });
    expect(samePath.body.datasource.hasPassword).toBe(true);
    const newHost = await send(admin, "PATCH", `/reports/admin/datasources/${datasource.id}`, { expectedRevision: datasource.revision + 4, url: "https://ch.example.test:8443/" });
    expect(newHost.body.datasource.hasPassword).toBe(false);
    const audits = db.query("SELECT metadata_json FROM audit_log WHERE event_type LIKE 'reports.datasource.%'").all() as Array<{ metadata_json: string }>;
    expect(audits.length).toBeGreaterThanOrEqual(3);
    for (const row of audits) expect(row.metadata_json).not.toContain(PASSWORD);
    expect((await send(admin, "DELETE", `/reports/admin/datasources/${datasource.id}`)).status).toBe(200);
    expect((await send(admin, "GET", `/reports/admin/datasources/${datasource.id}`)).status).toBe(404);
  });

  test("bad URLs, databases, and allowlists are refused at save", async () => {
    const base = { name: "Bad", url: fake.url, username: "u" };
    expect((await send(admin, "POST", "/reports/admin/datasources", { ...base, url: "http://10.1.2.3:8123/" })).body.code).toBe("INVALID_URL");
    expect((await send(admin, "POST", "/reports/admin/datasources", { ...base, url: "https://user:pw@ch.example.test/" })).body.code).toBe("INVALID_URL");
    expect((await send(admin, "POST", "/reports/admin/datasources", { ...base, url: `${fake.url}?readonly=0` })).body.code).toBe("INVALID_URL");
    expect((await send(admin, "POST", "/reports/admin/datasources", { ...base, database: "system" })).body.code).toBe("INVALID_DATABASE");
    expect((await send(admin, "POST", "/reports/admin/datasources", { ...base, allowlist: ["system.*"] })).body.code).toBe("INVALID_ALLOWLIST");
    expect((await send(admin, "POST", "/reports/admin/datasources", { ...base, allowlist: ["*"] })).body.code).toBe("INVALID_ALLOWLIST");
    await newDatasource("Unique name");
    expect((await send(admin, "POST", "/reports/admin/datasources", { ...base, name: "unique NAME" })).body.code).toBe("NAME_TAKEN");
  });

  test("members, viewers, and guests never reach admin routes; guests reach nothing", async () => {
    const datasource = await newDatasource("Hidden admin");
    for (const session of [member, viewer]) {
      expect((await send(session, "GET", "/reports/admin/datasources")).status).toBe(404);
      expect((await send(session, "GET", `/reports/admin/datasources/${datasource.id}`)).status).toBe(404);
    }
    expect((await send(member, "POST", `/reports/admin/datasources/${datasource.id}/test`)).status).toBe(404);
    // Viewers are refused every write by the role gate first.
    expect((await send(viewer, "POST", "/reports", { title: "x", datasourceId: datasource.id })).status).toBe(403);
    for (const path of ["/reports", "/reports/datasources", `/reports/${crypto.randomUUID()}`]) expect((await send(guest, "GET", path)).status).toBe(404);
    // Authors see enabled data sources' names only.
    const choices = await send(member, "GET", "/reports/datasources");
    expect(choices.body.datasources.find((item: Json) => item.id === datasource.id)).toEqual({ id: datasource.id, name: "Hidden admin", database: "analytics" });
  });

  test("Test connection reports the version and user, and warns about write grants and readonly=1", async () => {
    const datasource = await newDatasource("Probe");
    fake.state.grants = ["GRANT SELECT ON analytics.* TO writer", "GRANT INSERT, ALTER UPDATE ON analytics.* TO writer"];
    fake.state.readonly = 0;
    const tested = await send(admin, "POST", `/reports/admin/datasources/${datasource.id}/test`);
    expect(tested.body.test).toMatchObject({ ok: true, version: "24.8.1.1", user: "nook_ro", readonly: 0, writeGrants: ["GRANT INSERT, ALTER UPDATE ON analytics.* TO writer"] });
    expect(tested.body.test.warnings.join(" ")).toContain("can change data");
    // The probes ran without Nook's settings (to see the profile), then once with them.
    expect(fake.requests.filter((item) => item.params.readonly === undefined).map((item) => item.sql)).toEqual([expect.stringContaining("SELECT version()"), "SHOW GRANTS"]);
    expect(fake.requests.at(-1)).toMatchObject({ sql: "SELECT 1", user: "nook_ro", password: PASSWORD, params: { readonly: "2" } });

    fake.reset();
    fake.state.readonly = 1;
    const readonlyOne = await send(admin, "POST", `/reports/admin/datasources/${datasource.id}/test`);
    expect(readonlyOne.body.test.ok).toBe(true);
    expect(readonlyOne.body.test.warnings.join(" ")).toContain("readonly=1");

    const bad = await newDatasource("Bad user", { username: "bad" });
    const failed = await send(admin, "POST", `/reports/admin/datasources/${bad.id}/test`);
    expect(failed.body.test).toMatchObject({ ok: false });
    expect(failed.body.test.error).toContain("Authentication failed");
  });

  test("regression (2026-10-14): the profile probe works on a server that types getSetting('readonly') as UInt8", async () => {
    const { readonlyOf } = await import("../server/reports/datasources");
    fake.reset();
    const datasource = await newDatasource("Typed setting");
    const tested = await send(admin, "POST", `/reports/admin/datasources/${datasource.id}/test`);
    expect(tested.body.test).toMatchObject({ ok: true, readonly: 2, error: null });
    expect(fake.requests[0]!.sql).toContain("toUInt8OrNull(toString(getSetting('readonly')))");
    // JSONCompact may send the value as a number or a string.
    expect([readonlyOf(2), readonlyOf("1"), readonlyOf(null), readonlyOf("x"), readonlyOf(1.5)]).toEqual([2, 1, null, null, null]);
  });

  test("the allowlist preview counts matching tables", async () => {
    const datasource = await newDatasource("Preview");
    fake.state.tables = [
      { db: "analytics", name: "events", columns: [] }, { db: "analytics", name: "orders", columns: [] },
      { db: "staging", name: "orders_2026", columns: [] }, { db: "staging", name: "users", columns: [] }, { db: "raw", name: "dump", columns: [] }
    ];
    const preview = await send(admin, "POST", `/reports/admin/datasources/${datasource.id}/allowlist-preview`, { allowlist: ["analytics", "staging.orders_*"] });
    expect(preview.body.preview).toEqual({ matched: 3, total: 5, databases: 2, sample: ["analytics.events", "analytics.orders", "staging.orders_2026"] });
    expect((await send(admin, "POST", `/reports/admin/datasources/${datasource.id}/allowlist-preview`, { allowlist: ["system"] })).body.code).toBe("INVALID_ALLOWLIST");
  });
});

describe("reports and the console", () => {
  async function ready() {
    const datasource = await newDatasource(`Console ${crypto.randomUUID().slice(0, 6)}`);
    fake.state.tables = [{ db: "analytics", name: "orders", comment: "Orders", columns: [{ name: "amount", type: "UInt64" }] }];
    // Saving started a schema sync; let it finish so the requests below are only the console's.
    await syncSchema(datasource.id);
    fake.requests.length = 0;
    const created = await send(member, "POST", "/reports", { title: "Revenue by week", datasourceId: datasource.id });
    expect(created.status).toBe(201);
    return { datasource, report: created.body.report as Json };
  }

  test("a draft is created, listed, renamed, searched by title, and owner-private", async () => {
    const { report, datasource } = await ready();
    expect(report).toMatchObject({ title: "Revenue by week", status: "draft", datasourceName: datasource.name, isOwner: true, blockCount: 0, spec: { version: 1, blocks: [], queries: [] } });
    expect((await send(member, "GET", "/reports")).body.reports.some((item: Json) => item.id === report.id)).toBe(true);
    expect((await send(member, "GET", "/reports?q=REVENUE")).body.reports.map((item: Json) => item.id)).toContain(report.id);
    expect((await send(member, "GET", "/reports?q=nothing-like-this")).body.reports).toEqual([]);
    expect((await send(member, "GET", "/search?scope=reports&q=revenue")).body.results.map((item: Json) => item.id)).toContain(report.id);
    expect((await send(other, "GET", "/search?scope=reports&q=revenue")).body.results.map((item: Json) => item.id)).not.toContain(report.id);
    const renamed = await send(member, "PATCH", `/reports/${report.id}`, { title: "Weekly revenue", expectedRevision: report.revision });
    expect(renamed.body.report.title).toBe("Weekly revenue");
    // Someone else: the same 404 as missing.
    expect((await send(other, "GET", `/reports/${report.id}`)).status).toBe(404);
    expect((await send(other, "POST", `/reports/${report.id}/console`, { sql: "SELECT 1" })).status).toBe(404);
    expect((await send(member, "POST", "/reports", { title: "No source", datasourceId: crypto.randomUUID() })).status).toBe(404);
  });

  test("the Bin: delete, list, restore, purge (grants that name it go)", async () => {
    const { report } = await ready();
    expect((await send(member, "DELETE", `/reports/${report.id}`)).body.ok).toBe(true);
    expect((await send(member, "GET", `/reports/${report.id}`)).status).toBe(404);
    const bin = await send(member, "GET", "/bin?type=report");
    expect(bin.body.items.find((item: Json) => item.id === report.id)).toMatchObject({ type: "report", title: "Revenue by week", folder_name: "Reports" });
    expect((await send(member, "POST", `/bin/report/${report.id}/restore`)).status).toBe(200);
    expect((await send(member, "GET", `/reports/${report.id}`)).status).toBe(200);
    await send(member, "DELETE", `/reports/${report.id}`);
    expect((await send(member, "DELETE", `/bin/report/${report.id}`)).status).toBe(200);
    expect(db.query("SELECT 1 FROM reports WHERE id = ?").get(report.id)).toBeNull();
  });

  test("the console runs a select through EXPLAIN QUERY TREE and the LIMIT wrap, with the settings", async () => {
    const { report } = await ready();
    const ran = await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT count() FROM orders -- how many\n;" });
    expect(ran.status).toBe(200);
    expect(ran.body.outcome).toMatchObject({ class: "select", columns: [{ name: "n", type: "UInt64" }], truncated: false, sentSql: "SELECT * FROM (\nSELECT count() FROM orders\n) LIMIT 1001", rowsRead: 1234 });
    expect(ran.body.outcome.chQueryId).toMatch(/^nook-console-[0-9a-f]{12}$/);
    expect(fake.requests.map((item) => item.sql)).toEqual(["EXPLAIN QUERY TREE SELECT count() FROM orders", "SELECT * FROM (\nSELECT count() FROM orders\n) LIMIT 1001"]);
    for (const item of fake.requests) expect(item.params).toMatchObject({ readonly: "2", database: "analytics", max_threads: "4" });
    // The tree check throws on overflow (review H1); the statement itself breaks at its cap.
    expect(fake.requests.map((item) => item.params.result_overflow_mode)).toEqual(["throw", "break"]);
    // Audited by query id and hash, never the text.
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'reports.console.run' ORDER BY created_at DESC LIMIT 1").get() as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({ reportId: report.id, class: "select", queryId: ran.body.outcome.chQueryId });
    expect(audit.metadata_json).not.toContain("count()");
  });

  test("more rows than the cap say truncated", async () => {
    const { report } = await ready();
    fake.state.select = () => ({ meta: [{ name: "n", type: "UInt64" }], data: Array.from({ length: 1001 }, (_, index) => [String(index)]) });
    const ran = await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT number FROM numbers(5000)" });
    expect(ran.body.outcome.rows).toHaveLength(1000);
    expect(ran.body.outcome.truncated).toBe(true);
  });

  test("the guard refuses before anything is sent; the query tree refuses what the lexer cannot see", async () => {
    const { report } = await ready();
    const banned = await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT * FROM url('http://169.254.169.254/', CSV, 'a String')" });
    expect(banned.status).toBe(400);
    expect(banned.body).toMatchObject({ code: "GUARD", guard: "BANNED_FUNCTION" });
    expect((await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT * FROM secret.salaries" })).body.guard).toBe("NOT_ALLOWED_TABLE");
    expect(fake.requests).toHaveLength(0);
    // A view the analyzer resolves to a table off the allowlist.
    fake.state.queryTree = () => "QUERY id: 0\n  JOIN TREE\n    TABLE id: 3, alias: __table1, table_name: secret.salaries";
    const tree = await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT * FROM orders_view" });
    expect(tree.body).toMatchObject({ code: "GUARD", guard: "NOT_ALLOWED_TABLE" });
    expect(tree.text).not.toContain("salaries");
    expect(fake.requests.map((item) => item.sql)).toEqual(["EXPLAIN QUERY TREE SELECT * FROM orders_view"]);
    // A ClickHouse error comes back with its name.
    fake.state.queryTree = null;
    fake.state.select = () => ({ error: "Code: 47. DB::Exception: Missing columns: 'nope'. (UNKNOWN_IDENTIFIER) (version 24.8.1.1)", status: 404 });
    const failed = await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT nope FROM orders" });
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ code: "CLICKHOUSE", chName: "UNKNOWN_IDENTIFIER" });
  });

  test("metadata statements: system tables through filtered subqueries, SHOW TABLES rows filtered", async () => {
    const { report } = await ready();
    const system = await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT name FROM system.tables" });
    expect(system.body.outcome.class).toBe("metadata");
    expect(fake.requests.at(-1)!.sql).toContain("(SELECT * FROM system.tables WHERE match(concat(database, '.', name), ");
    fake.state.tables = [{ db: "analytics", name: "orders", columns: [] }, { db: "analytics", name: "events", columns: [] }];
    fake.state.select = (sql) => sql === "SHOW TABLES" ? { meta: [{ name: "name", type: "String" }], data: [["orders"], ["events"]] } : sql === "SHOW DATABASES" ? { meta: [{ name: "name", type: "String" }], data: [["analytics"], ["secret"], ["system"]] } : { meta: [], data: [] };
    expect((await send(member, "POST", `/reports/${report.id}/console`, { sql: "SHOW TABLES" })).body.outcome.rows).toEqual([["orders"], ["events"]]);
    expect((await send(member, "POST", `/reports/${report.id}/console`, { sql: "SHOW DATABASES" })).body.outcome.rows).toEqual([["analytics"]]);
    expect((await send(member, "POST", `/reports/${report.id}/console`, { sql: "SHOW GRANTS" })).body.guard).toBe("METADATA_FORBIDDEN");
  });

  test("review H1: the tree check throws on overflow and refuses a tree at its cap, so no TABLE line is ever dropped", async () => {
    const { report } = await ready();
    fake.state.queryTree = () => ["QUERY id: 0", ...Array.from({ length: 20_000 }, (_, index) => `    CONSTANT id: ${index + 1}, constant_value: 1`), "    TABLE id: 99999, table_name: secret.salaries"].join("\n");
    const huge = await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT count() FROM orders" });
    expect(huge.body).toMatchObject({ code: "GUARD", guard: "UNSUPPORTED_SYNTAX" });
    expect(fake.requests[0]!.params).toMatchObject({ result_overflow_mode: "throw", max_result_rows: "20000" });
    expect(fake.requests.map((item) => item.sql)).toEqual(["EXPLAIN QUERY TREE SELECT count() FROM orders"]);
  });

  test("review M2: a failed tree check is always generic", async () => {
    const { report } = await ready();
    fake.state.queryTree = () => "Code: 60. DB::Exception: Table secret.salaries does not exist. (UNKNOWN_TABLE) (version 24.8.1.1)";
    const hidden = await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT * FROM orders" });
    expect(hidden.body).toMatchObject({ code: "GUARD", guard: "UNSUPPORTED_SYNTAX" });
    expect(hidden.text).not.toContain("salaries");
    fake.state.queryTree = () => "Code: 47. DB::Exception: Unknown expression identifier `secret.salaries.pay` in scope SELECT. (UNKNOWN_IDENTIFIER) (version 24.8.1.1)";
    expect((await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT * FROM orders" })).text).not.toContain("salaries");
    fake.state.queryTree = () => "Code: 47. DB::Exception: Unknown expression identifier `nope` in scope SELECT nope FROM orders. (UNKNOWN_IDENTIFIER) (version 24.8.1.1)";
    // Follow-up: a failed check never shows ClickHouse's text, even when it names nothing sensitive.
    const plain = await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT nope FROM orders" });
    expect(plain.body).toMatchObject({ code: "GUARD", guard: "UNSUPPORTED_SYNTAX" });
    expect(plain.text).not.toContain("Code: 47");
    expect(plain.text).not.toContain("UNKNOWN_IDENTIFIER");
  });

  test("Lane F: a failed tree check on a qualified column the author wrote gets Nook's hint, naming only allowlisted catalog tables", async () => {
    const { report } = await ready();
    // ClickHouse 26.6's texts (tests/fixtures/clickhouse-26.6/error_*.error), with a suggestion that must never be shown.
    fake.state.queryTree = (select) => `Code: 47. DB::Exception: Identifier 'x.amount' cannot be resolved from table with name x. In scope ${select}. Maybe you meant: ['x.secret_col']. (UNKNOWN_IDENTIFIER) (version 26.6.8.7 (official build))`;
    const unknown = await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT x.amount FROM orders AS o, (SELECT 1) AS x" });
    expect(unknown.body).toMatchObject({ code: "GUARD", guard: "UNSUPPORTED_SYNTAX" });
    expect(unknown.body.error ?? unknown.text).toContain("amount is a column of analytics.orders; check which table x stands for");
    expect(unknown.text).not.toContain("secret_col");
    expect(unknown.text).not.toContain("Code: 47");
    fake.state.queryTree = () => "Code: 215. DB::Exception: Column 'o.amount' is not under aggregate function and not in GROUP BY keys. In query SELECT o.amount, count() FROM orders AS o. (NOT_AN_AGGREGATE) (version 26.6.8.7 (official build))";
    const aggregate = await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT o.amount, count() FROM orders AS o" });
    expect(aggregate.text).toContain("o.amount is not under an aggregate function and not in GROUP BY");
    // A column on no allowlisted table keeps the generic message.
    fake.state.queryTree = () => "Code: 47. DB::Exception: Identifier 'o.pay' cannot be resolved from table with name o. (UNKNOWN_IDENTIFIER) (version 26.6.8.7 (official build))";
    const generic = await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT o.pay FROM orders AS o" });
    expect(generic.text).toContain("ClickHouse could not check this query");
    expect(generic.text).not.toContain("pay");
  });

  test("follow-up M2: a run's ClickHouse text is shown only when every name in it is on the allowlist", async () => {
    const { report } = await ready();
    fake.state.select = () => ({ error: "Code: 241. DB::Exception: Memory limit exceeded while reading secret.salaries. (MEMORY_LIMIT_EXCEEDED) (version 24.8.1.1)", status: 500 });
    const hidden = await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT count() FROM orders" });
    expect(hidden.body.code).toBe("CLICKHOUSE");
    expect(hidden.text).not.toContain("salaries");
    expect(hidden.body.chName).toBeUndefined();
    fake.state.select = () => ({ error: "Code: 241. DB::Exception: Memory limit exceeded while reading analytics.orders. (MEMORY_LIMIT_EXCEEDED) (version 24.8.1.1)", status: 500 });
    const shown = await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT count() FROM orders" });
    expect(shown.body).toMatchObject({ code: "CLICKHOUSE", chName: "MEMORY_LIMIT_EXCEEDED" });
    expect(shown.text).toContain("analytics.orders");
  });

  test("review L1: SHOW TABLES rows are filtered to the allowlist before the row cap", async () => {
    const { report } = await ready();
    fake.state.select = (sql) => sql === "SHOW TABLES FROM staging" ? { meta: [{ name: "name", type: "String" }], data: [...Array.from({ length: 1500 }, (_, index) => [`users_${index}`]), ["orders_2026"]] } : { meta: [], data: [] };
    const shown = await send(member, "POST", `/reports/${report.id}/console`, { sql: "SHOW TABLES FROM staging" });
    expect(shown.body.outcome.rows).toEqual([["orders_2026"]]);
    expect(fake.requests.at(-1)!.params.max_result_rows).toBe("100000");
    expect(shown.body.outcome.truncated).toBe(false);
    // Follow-up: a list that reached the read cap says it was cut short, even when the allowed rows fit.
    fake.state.select = (sql) => sql === "SHOW TABLES FROM staging" ? { meta: [{ name: "name", type: "String" }], data: [["orders_2026"], ...Array.from({ length: 99_999 }, (_, index) => [`users_${index}`])] } : { meta: [], data: [] };
    const cut = await send(member, "POST", `/reports/${report.id}/console`, { sql: "SHOW TABLES FROM staging" });
    expect(cut.body.outcome).toMatchObject({ rows: [["orders_2026"]], truncated: true });
  });

  test("Cancel aborts the running console query and sends KILL QUERY for it and its tree check", async () => {
    const { report } = await ready();
    fake.state.delayMs = 1500;
    const pending = send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT count() FROM orders" });
    await Bun.sleep(300);
    const cancelled = await send(member, "POST", `/reports/${report.id}/console/cancel`);
    expect(cancelled.body.cancelled).toBe(true);
    const outcome = await pending;
    expect(outcome.body).toMatchObject({ code: "CANCELLED" });
    const kill = fake.requests.find((item) => item.sql.startsWith("KILL QUERY"));
    expect(kill!.sql).toBe(`KILL QUERY WHERE query_id IN ('${cancelled.body.queryId}', '${cancelled.body.queryId}-tree') ASYNC`);
    // Nothing running: nothing to cancel; someone else's report is 404.
    expect((await send(member, "POST", `/reports/${report.id}/console/cancel`)).body).toEqual({ cancelled: false, queryId: null });
    expect((await send(other, "POST", `/reports/${report.id}/console/cancel`)).status).toBe(404);
  });

  test("a disabled data source stops the console", async () => {
    const { report, datasource } = await ready();
    await send(admin, "PATCH", `/reports/admin/datasources/${datasource.id}`, { expectedRevision: datasource.revision, enabled: false });
    expect((await send(member, "POST", `/reports/${report.id}/console`, { sql: "SELECT 1" })).body.code).toBe("DATASOURCE_DISABLED");
  });
});

describe("data source secrets under key rotation (D415)", () => {
  test("rotate re-seals data source passwords and verify counts them", async () => {
    const datasource = await newDatasource(`Rotate ${crypto.randomUUID().slice(0, 6)}`);
    const current = config.agents.key!;
    const next = Buffer.alloc(32, 42);
    expect(verifySecrets(current).failed).toBe(0);
    const rotated = rotateSecretsKey(current, next);
    expect(rotated.datasources).toBeGreaterThanOrEqual(1);
    const row = db.query("SELECT password_ct FROM report_datasources WHERE id = ?").get(datasource.id) as { password_ct: string };
    expect(openSecret("datasource", datasource.id, row.password_ct, next)).toBe(PASSWORD);
    expect(verifySecrets(next).failed).toBe(0);
    expect(verifySecrets(current).failed).toBeGreaterThan(0);
    rotateSecretsKey(next, current);
    expect(verifySecrets(current).failed).toBe(0);
    // A ciphertext moved to another row does not open.
    const second = await newDatasource(`Rotate other ${crypto.randomUUID().slice(0, 6)}`);
    db.query("UPDATE report_datasources SET password_ct = ? WHERE id = ?").run(row.password_ct, second.id);
    expect(verifySecrets(current).failed).toBeGreaterThan(0);
    db.query("DELETE FROM report_datasources WHERE id = ?").run(second.id);
    expect(verifySecrets(current).failed).toBe(0);
  });
});

describe("MCP (reports:read)", () => {
  test("list_reports and list_report_datasources: names only, chosen reports narrowed, no SQL tool", async () => {
    const datasource = await newDatasource(`Mcp ${crypto.randomUUID().slice(0, 6)}`);
    const first = (await send(member, "POST", "/reports", { title: "Mcp one", datasourceId: datasource.id })).body.report as Json;
    const second = (await send(member, "POST", "/reports", { title: "Mcp two", datasourceId: datasource.id })).body.report as Json;
    const listReports = reportTools.find((tool) => tool.name === "list_reports")!;
    const listSources = reportTools.find((tool) => tool.name === "list_report_datasources")!;
    const key = { keyId: "k", userId: member.userId, name: "k", scopes: ["reports:read" as const] };
    const all = await listReports.handler({ query: "Mcp" }, key) as { reports: Json[] };
    expect(all.reports.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
    expect(Object.keys(all.reports[0]!).sort()).toEqual(["blocks", "datasource", "favorite", "folderId", "id", "lastRunAt", "owner", "status", "title", "updatedAt", "url"]);
    const chosen = { ...key, grants: [{ module: "reports" as const, permission: "read" as const, resourceKind: "report" as const, resourceId: first.id }] };
    expect(((await listReports.handler({}, chosen)) as { reports: Json[] }).reports.map((item) => item.id)).toEqual([first.id]);
    const sources = await listSources.handler({}, key) as { datasources: Json[] };
    expect(sources.datasources.find((item) => item.id === datasource.id)).toEqual({ id: datasource.id, name: datasource.name, database: "analytics" });
    expect(JSON.stringify(sources)).not.toContain("127.0.0.1");
    // A key over chosen reports sees the per-report tools, not the global data source list; nobody gets an
    // ad-hoc SQL tool (wave 48's update_report_query changes a saved query, guarded and re-validated).
    expect(visibleTools(chosen).filter((tool) => tool.name.includes("report")).map((tool) => tool.name)).toEqual(["list_reports", "list_report_folders", "get_report_metrics", "get_report", "get_report_block", "get_report_run", "get_report_instruction", "list_report_versions", "get_report_version_diff", "list_report_owners"]);
    expect(visibleTools(key).filter((tool) => tool.name.includes("report")).map((tool) => tool.name)).toEqual(["list_reports", "list_report_datasources", "list_report_folders", "get_report_metrics", "get_report", "get_report_block", "get_report_run", "get_report_instruction", "list_report_versions", "get_report_version_diff", "list_report_owners"]);
    expect(visibleTools({ ...key, scopes: ["reports:read", "reports:write"] }).some((tool) => /sql/i.test(tool.name))).toBe(false);
    expect(visibleTools({ ...key, scopes: ["reports:read", "reports:write"] }).filter((tool) => /query/i.test(tool.name)).map((tool) => tool.name)).toEqual(["update_report_query"]);
    // The key owner turned guest: nothing.
    const guestKey = { ...key, userId: guest.userId };
    expect(await listReports.handler({}, guestKey)).toEqual({ reports: [], nextCursor: null });
  });
});
