import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createUser, db, request } from "./support/harness";
import { startFakeClickhouse } from "./support/fakeClickhouse";
import { sampleAnswer, sampleSpec } from "./support/reportSeed";

const { captureLogs, logger, redact, redactText, maskEmail, withLogContext } = await import("../server/log");
const { isPolledRequest, noteRequestError, POLLED_ROUTES, requestLog, resetRepeatCounts, templatePath } = await import("../server/httpLog");

/**
 * The server log (server/log.ts, server/httpLog.ts, server/auditLog.ts; docs/OPERATIONS.md "Logs"):
 * the two formats and level filtering, redaction of every secret shape we know, the request line
 * (request id, route template, status classes), and a few workflow lines carrying their run id.
 */

type Line = Record<string, any>;
const parse = (lines: Array<{ line: string }>) => lines.map((entry) => JSON.parse(entry.line) as Line);

describe("logger", () => {
  test("pretty: one line with time, level, scope, message, and logfmt fields; context rides along", () => {
    const capture = captureLogs({ level: "info", format: "pretty" });
    try {
      withLogContext({ req: "ab12cd34" }, () => logger("reports", { run: "9f3a12bc" }).info("Refresh finished", { status: "succeeded", queries: 4, note: "two words" }));
    } finally {
      capture.restore();
    }
    expect(capture.lines).toHaveLength(1);
    expect(capture.lines[0]!.line).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z INFO  reports  Refresh finished status=succeeded queries=4 note="two words" run=9f3a12bc req=ab12cd34$/);
  });

  test("json: one object per line with time, level, scope, msg, and the fields", () => {
    const capture = captureLogs({ level: "info", format: "json" });
    try {
      logger("mcp").warn("Tool call", { tool: "list_notes", ok: false, code: "SCOPE_REQUIRED" });
    } finally {
      capture.restore();
    }
    const [line] = parse(capture.lines);
    expect(line).toMatchObject({ level: "warn", scope: "mcp", msg: "Tool call", tool: "list_notes", ok: false, code: "SCOPE_REQUIRED" });
    expect(Date.parse(line!.time)).not.toBeNaN();
  });

  test("levels filter, debug is cheap when off, silent writes nothing, errors carry their stack", () => {
    const capture = captureLogs({ level: "warn", format: "json" });
    const log = logger("db");
    let built = 0;
    try {
      log.debug("hidden");
      log.info("hidden");
      if (log.enabled("debug")) built += 1;
      log.warn("shown");
      log.error("failed", new Error("disk full"));
    } finally {
      capture.restore();
    }
    expect(built).toBe(0);
    const lines = parse(capture.lines);
    expect(lines.map((line) => line.level)).toEqual(["warn", "error"]);
    expect(lines[1]!.err).toMatchObject({ name: "Error", message: "disk full" });
    expect(lines[1]!.err.stack).toContain("logging.test.ts");
    expect(capture.lines[1]!.level).toBe("error");
    const silent = captureLogs({ level: "silent" });
    try {
      log.error("nothing");
    } finally {
      silent.restore();
    }
    expect(silent.lines).toHaveLength(0);
  });

  test("pretty puts an error's stack on indented lines after the event", () => {
    const capture = captureLogs({ level: "error", format: "pretty" });
    try {
      logger("http").error("GET /api/x 500 3ms", { err: new TypeError("boom") });
    } finally {
      capture.restore();
    }
    const [first, ...rest] = capture.lines[0]!.line.split("\n");
    expect(first).toContain("err=TypeError errMsg=boom");
    expect(rest.length).toBeGreaterThan(0);
    for (const frame of rest) expect(frame).toStartWith("    ");
  });
});

describe("redaction", () => {
  const secrets = {
    password: "correct horse battery staple",
    nookKey: "mynotes_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z",
    vaultKey: "nkv_Zx9cVb8nMq7wEr6tYu5iOp4aSd3fGh2j",
    providerKey: "sk-ant-api03-Qw3rTy7uIoP1aSdFgHjK",
    jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    session: "q7Vd2kP9xL4mN8bR1tY6wZ3cF5hJ0gS2aE7uI9oK4nM",
    totp: "492817",
    email: "pankaj.someone@example.org",
    s3Secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1",
    urlPassword: "hunter2hunter2"
  };

  test("known secret shapes never reach the output, in fields or in text, in either format", () => {
    for (const format of ["pretty", "json"] as const) {
      const capture = captureLogs({ level: "debug", format });
      try {
        const log = logger("auth");
        log.info("Sign-in", { email: secrets.email, password: secrets.password, totpCode: secrets.totp, recoveryCode: "ABCD-EFGH", token: secrets.nookKey });
        log.info("Headers", { authorization: `Bearer ${secrets.nookKey}`, cookie: `mynotes_session=${secrets.session}`, apiKey: secrets.providerKey, headers: { Authorization: `Basic ${btoa("u:p")}`, "X-Api-Key": secrets.vaultKey } });
        log.warn(`Request carried Bearer ${secrets.vaultKey} and ?token=${secrets.session}&code=${secrets.totp}`);
        log.error("Upstream failed", { url: `https://nook:${secrets.urlPassword}@ch.example.test:8443/?password=${secrets.password}`, err: new Error(`auth failed for ${secrets.email} with ${secrets.jwt}`) });
        log.info("Config", { s3: { secretAccessKey: secrets.s3Secret }, detail: `secret=${secrets.s3Secret}` });
        log.debug("Content", { markdown: "# Private note", prompt: "what is my salary", reply: "you earn", rows: [[1, "alice"]], body: "<p>mail</p>" });
      } finally {
        capture.restore();
      }
      const output = capture.text();
      for (const [name, value] of Object.entries(secrets)) expect({ format, name, leaked: output.includes(value) }).toEqual({ format, name, leaked: false });
      for (const content of ["Private note", "salary", "you earn", "alice", "<p>mail</p>", "ABCD-EFGH"]) expect(output).not.toContain(content);
      expect(output).toContain("p***@e***.org");
      expect(output).toContain("[redacted]");
    }
  });

  test("redact keeps codes, ids, counts, and the key id; masks emails", () => {
    expect(redact({ code: "KEY_INVALID", keyId: "1a2b3c4d", count: 3, status: 200, ok: true })).toEqual({ code: "KEY_INVALID", keyId: "1a2b3c4d", count: 3, status: 200, ok: true });
    expect(maskEmail("ops@nook.example.com")).toBe("o***@n***.com");
    expect(redactText("GET /api/reports/7f1e")).toBe("GET /api/reports/7f1e");
  });
});

describe("request log", () => {
  function app() {
    const hono = new Hono();
    hono.use("*", requestLog);
    hono.get("/api/reports/:id", (c) => c.json({ id: c.req.param("id") }));
    hono.get("/api/health", (c) => c.json({ status: "ok" }));
    hono.post("/api/notes", () => { throw new HTTPException(400, { message: "bad" }); });
    hono.get("/api/boom", () => { throw new Error("database is locked"); });
    hono.get("/api/private", (c) => c.json({ error: "Authentication required" }, 401));
    hono.onError((error, c) => {
      if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
      noteRequestError(c.req.raw, error);
      return c.json({ error: "Something went wrong" }, 500);
    });
    hono.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
    return hono;
  }

  test("sets or keeps X-Request-Id, logs the route template without ids or query strings, and the status class", async () => {
    const hono = app();
    const capture = captureLogs({ level: "debug", format: "json" });
    let made: string | null;
    let kept: string | null;
    try {
      made = (await hono.request("/api/reports/0b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f70?token=abcdef0123456789abcdef")).headers.get("X-Request-Id");
      kept = (await hono.request("/api/reports/42", { headers: { "X-Request-Id": "edge-7f3a" } })).headers.get("X-Request-Id");
      await hono.request("/api/health");
      await hono.request("/api/notes", { method: "POST" });
      await hono.request("/api/boom");
      await hono.request("/api/private");
      await hono.request("/api/files/0b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f70/content");
    } finally {
      capture.restore();
    }
    expect(made).toMatch(/^[0-9a-f]{12}$/);
    expect(kept).toBe("edge-7f3a");
    const lines = parse(capture.lines);
    expect(capture.text()).not.toContain("abcdef0123456789abcdef");
    expect(capture.text()).not.toContain("0b8c6a1e-6f53");
    const byMessage = (prefix: string) => lines.find((line) => line.msg.startsWith(prefix))!;
    expect(byMessage("GET /api/reports/:id 200")).toMatchObject({ level: "info", scope: "http", req: made, via: "web" });
    expect(lines.filter((line) => line.msg.startsWith("GET /api/reports/:id 200"))[1]).toMatchObject({ req: "edge-7f3a" });
    expect(byMessage("GET /api/health 200")).toMatchObject({ level: "debug" });
    expect(byMessage("POST /api/notes 400")).toMatchObject({ level: "warn" });
    expect(byMessage("GET /api/boom 500")).toMatchObject({ level: "error", err: { name: "Error", message: "database is locked" } });
    expect(byMessage("GET /api/boom 500").err.stack).toContain("logging.test.ts");
    expect(byMessage("GET /api/private 401")).toMatchObject({ level: "debug" });
    expect(byMessage("GET /api/files/:id/content 404")).toMatchObject({ level: "debug" });
    for (const line of lines) expect(typeof line.bytes === "number" || line.bytes === undefined).toBe(true);
  });

  test("401s repeated by one client become one warn with a count", async () => {
    resetRepeatCounts();
    const hono = app();
    const capture = captureLogs({ level: "info", format: "json" });
    try {
      for (let index = 0; index < 25; index += 1) await hono.request("/api/private");
    } finally {
      capture.restore();
    }
    const lines = parse(capture.lines);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "warn", msg: "GET /api/private 401 " + lines[0]!.msg.split(" ")[3] + " repeated", count: 21 });
  });

  test("templatePath replaces ids, numbers, and long tokens", () => {
    expect(templatePath("/api/reports/0b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f70/runs/12")).toBe("/api/reports/:id/runs/:id");
    expect(templatePath("/api/public/chat-shares/Xk3v9QbR7tLm2NpZ8wYc")).toBe("/api/public/chat-shares/:id");
    expect(templatePath("/api/notes")).toBe("/api/notes");
  });

  test("successful answers to the polled GET routes are debug; errors and other methods keep their level", async () => {
    const hono = new Hono();
    hono.use("*", requestLog);
    hono.get("/api/inbox/count", (c) => c.json({ pending: 0 }));
    hono.get("/api/notes/:id", (c) => c.req.param("id") === "gone" ? c.json({ error: "Not found" }, 404) : c.req.param("id") === "bad" ? c.json({ error: "bad" }, 400) : c.json({}));
    hono.patch("/api/notes/:id", (c) => c.json({}));
    hono.get("/api/reports/:reportId/runs/:runId", (c) => c.body(null, 304));
    hono.get("/api/folders", (c) => c.json({}));
    const capture = captureLogs({ level: "debug", format: "json" });
    try {
      await hono.request("/api/inbox/count");
      await hono.request("/api/notes/0b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f70");
      await hono.request("/api/notes/bad");
      await hono.request("/api/notes/0b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f70", { method: "PATCH" });
      await hono.request("/api/reports/0b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f70/runs/1b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f70");
      await hono.request("/api/folders");
    } finally {
      capture.restore();
    }
    const lines = parse(capture.lines);
    const levelOf = (prefix: string) => lines.find((line) => line.msg.startsWith(prefix))?.level;
    expect(levelOf("GET /api/inbox/count 200")).toBe("debug");
    expect(levelOf("GET /api/notes/:id 200")).toBe("debug");
    expect(levelOf("GET /api/notes/:id 400")).toBe("warn");
    expect(levelOf("PATCH /api/notes/:id 200")).toBe("info");
    expect(levelOf("GET /api/reports/:reportId/runs/:runId 304")).toBe("debug");
    expect(levelOf("GET /api/folders 200")).toBe("info");
    expect(isPolledRequest("GET", "/api/notifications", 200)).toBe(true);
    expect(isPolledRequest("GET", "/api/notifications", 500)).toBe(false);
    expect(isPolledRequest("POST", "/api/notifications", 200)).toBe(false);
  });

  test("every polled route is a GET route the server registers, under the same template", async () => {
    const { Glob } = await import("bun");
    let source = "";
    for await (const file of new Glob("server/**/*.ts").scan(".")) source += await Bun.file(file).text();
    for (const route of POLLED_ROUTES) expect(source).toContain(`app.get("${route}"`);
  });

  test("the real server logs a signed-in request with its user, role, and route", async () => {
    const session = await createUser("Logging user");
    const capture = captureLogs({ level: "info", format: "json" });
    try {
      expect((await request("/folders", {}, session)).status).toBe(200);
    } finally {
      capture.restore();
    }
    const line = parse(capture.lines).find((item) => item.scope === "http" && item.msg.startsWith("GET /api/folders 200"));
    expect(line).toMatchObject({ level: "info", user: session.userId.slice(0, 8), via: "web" });
    expect(typeof line!.role).toBe("string");
  });
});

describe("workflow lines", () => {
  const fake = startFakeClickhouse(0);
  afterAll(() => fake.stop());

  test("a report refresh logs its start, each query, and its finish with run= and report=", async () => {
    fake.state.select = (sql) => sampleAnswer(sql);
    const admin = await createUser("Logging admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const owner = await createUser("Logging owner");
    const created = await request("/reports/admin/datasources", { method: "POST", body: JSON.stringify({ name: "Logging warehouse", url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] }) }, admin);
    const datasourceId = (await created.json() as { datasource: { id: string } }).datasource.id;
    const { syncSchema } = await import("../server/reports/schemaCatalog");
    const { startRefresh } = await import("../server/reports/refresh");
    await syncSchema(datasourceId).catch(() => undefined);
    const report = await request("/reports", { method: "POST", body: JSON.stringify({ title: "Logged revenue", datasourceId }) }, owner);
    const reportId = (await report.json() as { report: { id: string } }).report.id;
    db.query("UPDATE reports SET spec_json = ? WHERE id = ?").run(JSON.stringify(sampleSpec()), reportId);

    const capture = captureLogs({ level: "info", format: "json" });
    let runId: string;
    try {
      const started = startRefresh(owner.userId, reportId, { trigger: "user" });
      runId = (await started.done).id;
    } finally {
      capture.restore();
    }
    const run = runId!.slice(0, 8);
    const lines = parse(capture.lines).filter((line) => line.scope === "reports");
    expect(lines.find((line) => line.msg === "reports.refresh.start")).toMatchObject({ level: "info", run, report: reportId.slice(0, 8), trigger: "user" });
    expect(lines.find((line) => line.msg === "reports.refresh.finish")).toMatchObject({ level: "info", run, status: "succeeded", queries: 4, failed: 0 });
    const queries = lines.filter((line) => line.msg === "ClickHouse query");
    expect(queries).toHaveLength(4);
    for (const query of queries) {
      expect(query).toMatchObject({ run, report: reportId.slice(0, 8), class: "select", rowsRead: 120000 });
      expect(typeof query.ms).toBe("number");
      expect(query.query).toStartWith("nook-");
    }
    // Neither the SQL (debug only) nor any result row is logged at info.
    expect(capture.text()).not.toContain("SELECT");
    expect(capture.text()).not.toContain("48210.50");
  });

  test("an MCP tool call logs the tool, the key, the duration, and ok or the code", async () => {
    const { createMcpApiKey } = await import("../server/mcp");
    const { invokeMcpToolForTests } = await import("../server/mcpTools");
    const user = await createUser("Logging key holder");
    const key = createMcpApiKey(user.userId, "Logging key", ["notes:read"]);
    const capture = captureLogs({ level: "info", format: "json" });
    try {
      await invokeMcpToolForTests("list_notes", {}, key.id);
      await invokeMcpToolForTests("create_note", { title: "x", markdown: "secret body" }, key.id);
    } finally {
      capture.restore();
    }
    const calls = parse(capture.lines).filter((line) => line.msg === "Tool call");
    expect(calls[0]).toMatchObject({ level: "info", scope: "mcp", tool: "list_notes", key: key.id.slice(0, 8), ok: true });
    expect(calls[1]).toMatchObject({ level: "warn", tool: "create_note", ok: false, code: "SCOPE_REQUIRED" });
    expect(capture.text()).not.toContain("secret body");
    expect(capture.text()).not.toContain(key.token);
  });
});
