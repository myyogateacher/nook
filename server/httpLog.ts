/**
 * The request log (docs/OPERATIONS.md "Logs"): one line per request, after it answers.
 *
 * - Every request gets an id: a well-formed incoming X-Request-Id is kept, otherwise one is made, and
 *   the response carries it back. Lines logged while the request runs carry it as req=.
 * - The path is logged as its route template (/api/reports/:id) where the router knows one, or with
 *   id-like segments replaced by :id; the query string never is.
 * - Levels: info for normal requests; warn for 4xx other than 401 and 404 (those are debug, unless one
 *   client repeats them: then one warn per minute with the count); error for 5xx, with the stack;
 *   warn for a request slower than LOG_SLOW_MS. Health checks, static files, and successful answers
 *   to the GET routes the app polls (POLLED_ROUTES) are debug.
 */
import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { clientAddress } from "./clientAddress";
import { elapsed, hashTag, logger, logSlowMs, setLogContext, shortId, withLogContext, type LogContext, type LogLevel } from "./log";

const http = logger("http");
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const errors = new WeakMap<Request, unknown>();

/** app.onError hands the thrown error over here, so the request line logs it once, with its stack. */
export const noteRequestError = (request: Request, error: unknown) => { errors.set(request, error); };

export const newRequestId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("hex");

const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[0-9a-f]{16,}|(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{32,})$/i;
/** A raw path with ids (UUIDs, numbers, long tokens) replaced by :id. */
export function templatePath(path: string) {
  return path.split("/").map((segment) => ID_SEGMENT.test(segment) ? ":id" : segment).join("/").slice(0, 160);
}

/** The responding route's template, or the raw path with its ids replaced. */
export function routeTemplate(c: Context) {
  let template = "";
  try {
    template = routePath(c, c.req.routeIndex);
  } catch {
    template = "";
  }
  return template && !template.includes("*") ? template : templatePath(c.req.path);
}

const STATIC = /^\/(assets|excalidraw|icons|fonts)\/|^\/(sw\.js|favicon[^/]*|manifest[^/]*|robots\.txt|[^/]+\.(png|svg|ico|webmanifest|json|js|css|txt|woff2?))$/;
/** Health checks and the built client: debug only. */
export const isQuietPath = (method: string, path: string) =>
  path === "/api/health" || ((method === "GET" || method === "HEAD") && (STATIC.test(path) || !(path.startsWith("/api/") || path.startsWith("/mcp") || path === "/api")));

/**
 * GET routes the app polls on a timer or on every focus (docs/OPERATIONS.md "Logs"): a successful
 * answer (2xx or 304) is debug, so an open tab does not fill the info log. Errors and slow answers
 * still log as usual. Keep this list explicit: each entry names the client code that polls it.
 */
export const POLLED_ROUTES: readonly string[] = [
  "/api/notes/:id", //                          editor/publishWatch.ts: the open draft re-reads its note
  "/api/inbox/count", //                        AppShell.tsx: the Inbox badge (bell poll, focus, inbox changes)
  "/api/notifications", //                      NotificationBell.tsx: the unread count every 60 s
  "/api/reports/:reportId/runs/:runId", //      reports/ReportView.tsx: a running refresh, every second
  "/api/reports/:reportId/instructions", //     reports/ChangesPanel.tsx: an edit in progress, every 1.5 s
  "/api/knowledge/:kbId" //                     chat/KnowledgeSettings.tsx: sources being indexed
];
const polled = new Set(POLLED_ROUTES);
/** A successful answer to a polled GET route (debug, not info). */
export const isPolledRequest = (method: string, route: string, status: number) =>
  method === "GET" && polled.has(route) && ((status >= 200 && status < 300) || status === 304);

/** The surface: mcp (/mcp), api (the REST /api/v1), or web (the app and everything else). */
export const viaOf = (path: string) =>
  path === "/mcp" || path.startsWith("/mcp/") ? "mcp" : path === "/api/v1" || path.startsWith("/api/v1/") ? "api" : "web";

/** 401 and 404 repeated by one client: counted per minute, warned once the count passes 20. */
const REPEAT_LIMIT = 20;
const repeats = new Map<string, { count: number; resetAt: number; warned: boolean }>();
function repeated(key: string) {
  const time = Date.now();
  let entry = repeats.get(key);
  if (!entry || time >= entry.resetAt) {
    if (repeats.size > 5_000) repeats.clear();
    entry = { count: 0, resetAt: time + 60_000, warned: false };
    repeats.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > REPEAT_LIMIT && !entry.warned) {
    entry.warned = true;
    return entry.count;
  }
  return 0;
}
export const resetRepeatCounts = () => repeats.clear();

export const requestLog: MiddlewareHandler = async (c, next) => {
  const start = performance.now();
  const incoming = c.req.header("X-Request-Id");
  const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : newRequestId();
  const context: LogContext = { req: requestId };
  await withLogContext(context, async () => {
    await next();
  });
  c.header("X-Request-Id", requestId);
  const method = c.req.method;
  const path = c.req.path;
  const status = c.res.status;
  const ms = elapsed(start);
  const user = (c.var as { user?: { id: string; role: string } }).user;
  if (user) Object.assign(context, { user: context.user ?? shortId(user.id), role: context.role ?? user.role });
  const route = routeTemplate(c);
  const length = c.res.headers.get("Content-Length");
  const streaming = c.res.headers.get("Content-Type")?.startsWith("text/event-stream") ?? false;
  const fields = {
    ...context,
    via: viaOf(path),
    bytes: length === null ? undefined : Number(length),
    ...(streaming ? { stream: true } : {})
  };
  const message = `${method} ${route} ${status} ${ms}ms`;
  const error = errors.get(c.req.raw);
  if (status >= 500) {
    http.error(message, { ...fields, ...(error !== undefined ? { err: error } : {}) });
    return;
  }
  let level: LogLevel = "info";
  if (status === 401 || status === 404) {
    level = "debug";
    const count = repeated(`${status} ${clientAddress(c)}`);
    if (count) {
      http.warn(`${message} repeated`, { ...fields, count, client: hashTag(clientAddress(c)), window: "60s" });
      return;
    }
  } else if (status >= 400) level = "warn";
  else if (isQuietPath(method, path) || isPolledRequest(method, route, status)) level = "debug";
  if (level !== "warn" && ms > logSlowMs && !streaming) level = "warn";
  if (!http.enabled(level)) return;
  http[level](ms > logSlowMs && !streaming && level === "warn" && status < 400 ? `${message} slow` : message, fields);
};

/** Key requests (/mcp, /api/v1) name their key and holder once the key checks out. */
export const noteKeyHolder = (keyId: string, userId: string, role: string) => setLogContext({ user: shortId(userId), role, key: shortId(keyId) });
