import * as z from "zod/v4";
import type { Context } from "hono";
import { db } from "./harness";
import { registerWorkspaceModule } from "../../server/workspaceModules";
import { unregisterWorkspaceModuleForTests } from "../../server/workspaceRegistry";
import { defineTool, notFound } from "../../server/mcpToolKit";
import type { AppEnv } from "../../server/auth";
import { checkSubmission, consumePublicLink, createPublicLink, readPublicJson, readPublicLink, publicNotFound, startEmailVerification, confirmEmailVerification } from "../../server/public";
import { clientIp } from "../../server/clientAddress";
import { currentSet, publishSet, saveDraftSet, submitResponse, QuestionError } from "../../server/questions/service";
import { upsertSchedule } from "../../server/schedules/service";
import { notify } from "../../server/notify";
import { recordItemActivity } from "../../server/activity/service";
import { registerActivityKinds } from "../../shared/itemActivity";
import { layout, paragraph } from "../../server/mail/layout";
import { defineTemplate } from "../../server/mail/templates/types";
import { page as todayPage } from "../../server/today/registry";
import { WORK_KIND_ICONS, type WorkKind } from "../../shared/workRefs";
import { emptyQuestionSet, type QuestionSet } from "../../shared/questions";
import { HONEYPOT_FIELD, NONCE_FIELD } from "../../shared/publicPages";

/**
 * The throwaway workspace module of the tests (docs/plan/WORKSPACE_MODULES.md §F.2 acceptance): one
 * module that registers through every server registry (routes, a guest write, public routes, an MCP
 * tool, a work kind, a dataset, a schedule handler, a search scope, a Today section, a mail template,
 * a digest section) and uses the foundation services end to end (questions, public links and
 * anti-abuse, schedules, notifications, item activity). It lives in tests only and unregisters itself.
 */

export const TEST_MODULE = "test_widgets";
export const TEST_KIND = "test_widget" as WorkKind;

db.exec(`CREATE TABLE IF NOT EXISTS test_widgets (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS test_pings (schedule_id TEXT NOT NULL, fire_at TEXT NOT NULL, payload TEXT NOT NULL)`);

registerActivityKinds("test", { widget_answered: { shape: "event", coalesce: false } });

type Widget = { id: string; owner_id: string; name: string; shared: number; created_at: string };
const widget = (id: string) => db.query("SELECT * FROM test_widgets WHERE id = ?").get(id) as Widget | null;
const readable = (id: string, userId: string) => {
  const row = widget(id);
  return row && (row.owner_id === userId || row.shared === 1) ? row : null;
};

export const WIDGET_QUESTIONS: QuestionSet = {
  ...emptyQuestionSet(),
  questions: [
    { id: "name", type: "short_text", title: "Your name", required: true },
    { id: "email", type: "email", title: "Email", role: "contact_email" },
    { id: "score", type: "nps", title: "How likely are you to recommend us?" },
    { id: "file", type: "file", title: "Members only upload" }
  ]
};

const helloTemplate = defineTemplate<{ name: string; stopHref?: string }>({
  name: "test.hello",
  class: "activity",
  category: "forms",
  render: (data, context) => layout({
    instanceName: context.instanceName, subject: `Hello ${data.name}`, preheader: "Hello", eyebrow: "Test", title: `Hello ${data.name}`, blocks: [paragraph("A test mail.")],
    footer: { reason: "A test.", ...(data.stopHref ? { unsubscribe: { href: data.stopHref, label: "Stop emails about this" } } : {}) }
  }),
  fixture: () => ({ name: "Ana" })
});

const answerSchema = z.object({ answers: z.record(z.string(), z.unknown()), [NONCE_FIELD]: z.string().optional(), [HONEYPOT_FIELD]: z.string().optional(), verify: z.boolean().optional() });

async function publicSubmit(c: Context<AppEnv>) {
  const link = readPublicLink("form", c.req.param("token") ?? "", { opens: (found) => widget(found.itemId) !== null });
  if (!link) return publicNotFound(c);
  const body = await readPublicJson(c, answerSchema);
  if (!body) return c.json({ error: "Invalid request", code: "INVALID" }, 400);
  const check = checkSubmission({ kind: "test", itemId: link.itemId, linkId: link.id, address: clientIp(c), body: body as Record<string, unknown> });
  if (!check.ok) {
    if (check.retryAfter) c.header("Retry-After", String(check.retryAfter));
    return check.status === 404 ? publicNotFound(c) : c.json({ error: "This submission was not accepted", code: check.outcome.toUpperCase() }, check.status);
  }
  return db.transaction(() => {
    if (body.verify && typeof body.answers.email === "string") {
      const started = startEmailVerification({ kind: "test", itemId: link.itemId, linkId: link.id, email: body.answers.email, payload: body.answers, address: clientIp(c) });
      return c.json({ verificationId: started.verificationId, mailQueued: started.mailQueued }, 202);
    }
    if (!consumePublicLink(link)) return c.json({ error: "Too many responses", code: "RATE_LIMITED" }, 429);
    try {
      const response = submitResponse({ host: { kind: "form", id: link.itemId }, respondent: { kind: "guest", name: String(body.answers.name ?? "Guest") }, answers: body.answers, audience: "public" });
      recordItemActivity({ itemKind: TEST_KIND, itemId: link.itemId, actorId: null, via: "public", kind: "widget_answered" });
      return c.json({ responseId: response.id }, 201);
    } catch (error) {
      if (error instanceof QuestionError) return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
      throw error;
    }
  })();
}

export function registerTestModule() {
  registerWorkspaceModule({
    id: TEST_MODULE,
    routes: (router) => {
      router.get("/api/test-widgets", (c) => c.json({ widgets: db.query("SELECT * FROM test_widgets WHERE owner_id = ? OR shared = 1 ORDER BY created_at").all(c.get("user").id) }));
      router.post("/api/test-widgets", async (c) => {
        const body = await c.req.json() as { name: string; shared?: boolean };
        const userId = c.get("user").id;
        const id = crypto.randomUUID();
        return db.transaction(() => {
          db.query("INSERT INTO test_widgets (id, owner_id, name, shared, created_at) VALUES (?, ?, ?, ?, ?)").run(id, userId, body.name, body.shared ? 1 : 0, new Date().toISOString());
          saveDraftSet({ kind: "form", id }, WIDGET_QUESTIONS, userId);
          publishSet({ kind: "form", id }, userId);
          const { token } = createPublicLink({ kind: "form", itemId: id, createdBy: userId });
          upsertSchedule({ kind: TEST_KIND, id }, "test.ping", { once: new Date(Date.now() + 1000).toISOString() }, { widget: id }, { userId });
          return c.json({ id, token }, 201);
        })();
      });
      router.post("/api/test-widgets/:id/answers", async (c) => {
        const userId = c.get("user").id;
        const found = readable(c.req.param("id") ?? "", userId);
        if (!found) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
        const body = await c.req.json() as { answers: Record<string, unknown> };
        try {
          return db.transaction(() => {
            const response = submitResponse({ host: { kind: "form", id: found.id }, respondent: { kind: "user", userId }, answers: body.answers, audience: "member" });
            notify({ userIds: [found.owner_id], module: "forms", topic: "forms.response", title: "New response", href: `/forms/${found.id}`, item: { kind: "form", id: found.id }, actor: userId, dedupeKey: `responses:${found.id}`,
              email: { template: "test.hello", payload: { widgetId: found.id } } });
            return c.json({ responseId: response.id }, 201);
          })();
        } catch (error) {
          if (error instanceof QuestionError) return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
          throw error;
        }
      });
    },
    // Guests answer widgets shared with them (the handler checks who may).
    readOnlyWrites: [{ method: "POST", path: "/api/test-widgets/:id/answers", roles: ["guest", "viewer"], why: "answer a shared widget (test module)" }],
    publicRoutes: (router) => {
      router.page("/p/test/:token", (c) => readPublicLink("form", c.req.param("token") ?? "", { opens: (link) => widget(link.itemId) !== null }) !== null);
      router.get("/api/public/test/:token", (c) => {
        const link = readPublicLink("form", c.req.param("token") ?? "", { opens: (found) => widget(found.itemId) !== null });
        if (!link) return publicNotFound(c);
        return c.json({ title: widget(link.itemId)!.name, questions: currentSet({ kind: "form", id: link.itemId })!.set });
      });
      router.post("/api/public/test/:token", publicSubmit);
      router.post("/api/public/test/:token/verify", async (c) => {
        const link = readPublicLink("form", c.req.param("token") ?? "");
        const body = await readPublicJson(c, z.object({ id: z.string(), code: z.string() }));
        if (!link || !body) return publicNotFound(c);
        const result = confirmEmailVerification({ id: body.id, code: body.code, kind: "test", itemId: link.itemId });
        if (!result.ok) return c.json({ error: "That code did not work", code: result.reason.toUpperCase() }, 400);
        const answers = result.payload as Record<string, unknown>;
        const response = submitResponse({ host: { kind: "form", id: link.itemId }, respondent: { kind: "guest", name: String(answers.name ?? "Guest"), email: String(answers.email ?? "") }, answers, audience: "public" });
        return c.json({ responseId: response.id }, 201);
      });
    },
    mcpTools: [defineTool({
      name: "list_test_widgets",
      title: "List test widgets",
      description: "The caller's test widgets (the tests' throwaway module).",
      scopes: ["forms:read"],
      access: { mode: "global" },
      write: false,
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: z.object({}),
      outputSchema: z.object({ widgets: z.array(z.object({ id: z.string(), name: z.string() })) }),
      handler: (_args, key) => ({ widgets: (db.query("SELECT id, name FROM test_widgets WHERE owner_id = ? ORDER BY created_at").all(key.userId) as Array<{ id: string; name: string }>) })
    }), defineTool({
      name: "get_test_widget",
      title: "Get a test widget",
      description: "One test widget.",
      scopes: ["forms:read"],
      access: { mode: "derived", related: ["widgetId"] },
      write: false,
      inputSchema: z.object({ widgetId: z.string().uuid() }),
      handler: ({ widgetId }, key) => {
        const found = readable(widgetId, key.userId);
        if (!found) throw notFound("Widget");
        return { id: found.id, name: found.name };
      }
    })],
    agentTools: { never: ["list_test_widgets", "get_test_widget"] },
    workKinds: [{
      kind: TEST_KIND, scopes: { read: "forms:read", write: "forms:write" },
      level: (id, viewer) => { const found = readable(id, viewer.userId); return !found ? "none" : found.owner_id === viewer.userId ? "owner" : "comment"; },
      resolve: (ids, viewer) => new Map(ids.map((id) => {
        const found = readable(id, viewer.userId);
        return [id, found ? { kind: TEST_KIND, id, title: found.name, href: `/test-widgets/${id}`, icon: WORK_KIND_ICONS.form } : null];
      }))
    }],
    datasets: [{
      id: "test.widgets", module: "forms", label: "Widgets", description: "Test widgets.", readScope: "forms:read",
      from: "test_widgets w", scope: () => ({ sql: "(w.owner_id = $userId OR w.shared = 1)" }), timeColumn: "created_at",
      columns: [
        { name: "name", sql: "w.name", type: "string", label: "Name", dimension: true },
        { name: "shared", sql: "w.shared", type: "bool", label: "Shared", dimension: true },
        { name: "created_at", sql: "w.created_at", type: "datetime", label: "Created", dimension: true }
      ]
    }],
    scheduleHandlers: {
      "test.ping": { run: (schedule, fireAt) => { db.query("INSERT INTO test_pings (schedule_id, fire_at, payload) VALUES (?, ?, ?)").run(schedule.id, fireAt, JSON.stringify(schedule.payload)); } },
      "test.boom": { run: () => { throw new Error("boom"); } },
      "test.late": { run: () => undefined, skipIfLateMs: 60_000 }
    },
    searchScopes: [{
      scope: "test_widgets", label: "Widgets", module: "forms",
      search: ({ userId, q }) => {
        const rows = db.query("SELECT id, name FROM test_widgets WHERE (owner_id = ? OR shared = 1) AND instr(lower(name), lower(?)) > 0 LIMIT 6").all(userId, q) as Array<{ id: string; name: string }>;
        return { results: rows.slice(0, 5).map((row) => ({ kind: TEST_KIND, id: row.id, title: row.name, href: `/test-widgets/${row.id}` })), truncated: rows.length > 5 };
      }
    }],
    todayProviders: [{ name: "testWidgets", provider: { href: "/test-widgets", mcpScope: "forms:read", load: (context) => todayPage(db.query("SELECT id, name AS title FROM test_widgets WHERE owner_id = ? ORDER BY created_at DESC LIMIT 11").all(context.userId)) } }],
    mailTemplates: {
      "test.hello": {
        ...helloTemplate,
        resolve: (payload) => { const found = typeof payload.widgetId === "string" ? widget(payload.widgetId) : null; return found ? { data: { name: found.name } } : { skip: "access_lost" }; },
        resolveExternal: (payload) => ({ data: { name: String(payload.name ?? "there") } })
      } as never
    },
    digestSections: [{
      id: "test.widgets", label: "Your widgets", module: "forms",
      rows: (recipient) => {
        const rows = db.query("SELECT id, name FROM test_widgets WHERE owner_id = ? ORDER BY created_at LIMIT 21").all(recipient.id) as Array<{ id: string; name: string }>;
        return { rows: rows.map((row) => ({ title: row.name, href: `/test-widgets/${row.id}` })), total: rows.length };
      }
    }]
  });
}

/**
 * Unregisters the module and drops its rows: the suite shares one database, so a widget one file shared
 * would otherwise count in the next file's searches and datasets (tests/workLinks.test.ts before
 * tests/workspaceRegistry.test.ts), and its pending schedules would outlive their handler.
 */
export const unregisterTestModule = () => {
  unregisterWorkspaceModuleForTests(TEST_MODULE);
  db.transaction(() => {
    db.query("DELETE FROM schedules WHERE owner_kind = ?").run(TEST_KIND);
    db.exec("DELETE FROM test_pings; DELETE FROM test_widgets");
  })();
};
