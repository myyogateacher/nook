import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as z from "zod/v4";
import type { AppEnv } from "./auth";
import { countKeyUsage } from "./apiKeys";
import { clientIp } from "./clientAddress";
import { db } from "./db";
import { authenticateKeyRequest, mcpResponse } from "./mcp";
import { consumeMcpLimits, MCP_LIMITS, MCP_USER_LIMITS } from "./mcpRateLimit";
import { mcpToolSpecs, runTool, toolVisible, visibleTools } from "./mcpTools";
import type { McpErrorCode, McpKeyContext } from "./mcpToolKit";
import { readBoundedBody } from "./validation";
import { handleVaultRest, matchVaultRoute } from "./vault/rest";

/**
 * The REST surface `/api/v1` (Wave 34, access plan D280, O-A12, T210): the MCP tools over plain
 * HTTP for scripts, CI jobs, and automation that do not speak MCP.
 *
 * - `GET /api/v1/me`: the key and its owner (display name and role), its effective grants, surfaces,
 *   limits, and expiry. Never the token, its hash, or the addresses of its allowlist.
 * - `GET /api/v1/tools`: the tools this key may call now, with their JSON input schemas.
 * - `POST /api/v1/tools/:name`: runs the SAME tool definition through the same `runTool` as MCP:
 *   the same validation, grants and chosen items, rate limits (per surface), audit (`via: "rest"`),
 *   and output bounds. The body is the tool's JSON result, not MCP's text wrapper.
 *
 * Authentication is a Bearer key only (server/mcp.ts authenticateKeyRequest): never a session
 * cookie, never a key in the URL. The route sits before the `/api/*` session, CSRF, and role
 * middleware (keys never carry a CSRF token; there is no ambient credential to forge). A key works
 * here only when its surfaces include REST and team policy's `rest_roles` holds its owner's role,
 * both checked on every request. JSON only: a POST must send `Content-Type: application/json` and
 * a JSON object. No CORS headers are ever sent, preflights are refused, and a request whose Origin
 * is not one of the app's own origins is refused (403), so browsers on other sites cannot use it.
 * Keys never manage access (D265): no tool here shares, deletes forever, or touches keys.
 */

const REST_SLOTS = 24;
let activeRequests = 0;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  mcpResponse(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

const refuse = (status: number, error: string, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json(status, { error, code, ...extra }, headers);

/** Tool error codes to HTTP statuses (plan §C.7); anything unlisted is a 400. */
export const REST_STATUS: Partial<Record<McpErrorCode, number>> = {
  INVALID: 400,
  NOT_TEXT: 422,
  HASH_MISMATCH: 422,
  SCOPE_REQUIRED: 403,
  READ_ONLY: 403,
  KEY_POLICY: 403,
  OWNER_ONLY: 403,
  KIND_NOT_ALLOWED: 403,
  TARGET_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  UPLOAD_EXPIRED: 410,
  TOO_LARGE: 413,
  DRAFT_CHANGED: 409,
  CARD_CHANGED: 409,
  EVENT_CHANGED: 409,
  ROW_CHANGED: 409,
  SCHEMA_CHANGED: 409,
  DRAFT_NOT_SEEN: 409,
  NO_DRAFT: 409,
  NO_CHANGES: 409,
  STALE_POSITION: 409,
  LIMIT_REACHED: 409,
  COLUMN_FULL: 409,
  RELATION_EXISTS: 409,
  REMINDER_EXISTS: 409,
  PURGING: 409,
  PARENT_IN_BIN: 409,
  AUDIENCE_CHANGE: 409,
  NAME_TAKEN: 409,
  SPRINT_ACTIVE: 409,
  UPLOAD_PENDING: 409,
  QUOTA_EXCEEDED: 409,
  RUN_ACTIVE: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500
};

/** Query parameters that look like a credential: a key never belongs in a URL (it ends up in logs). */
const CREDENTIAL_PARAMS = /^(api[_-]?key|apikey|key|token|access[_-]?token|bearer|auth|authorization)$/i;
function keyInUrl(url: URL) {
  for (const [name, value] of url.searchParams) {
    if (CREDENTIAL_PARAMS.test(name) || /^(mynotes|nkv)_/.test(value)) return true;
  }
  return /(mynotes|nkv)_[A-Za-z0-9_-]{20,}/.test(url.pathname);
}

/** One request slot of the REST pool (separate from MCP's, so neither surface starves the other). */
async function withRestSlot(operation: () => Promise<Response>) {
  if (activeRequests >= REST_SLOTS) return refuse(503, "The REST API is busy. Try again in a moment.", "BUSY", {}, { "Retry-After": "1" });
  activeRequests += 1;
  try {
    return await operation();
  } finally {
    activeRequests -= 1;
  }
}

/** Charges a REST read (me, tools) against the key's per-minute call bucket; the seconds to wait, or 0. */
function chargeRead(key: McpKeyContext & { limits?: { callsPerMinute?: number; writesPerMinute?: number } }) {
  const retryAfter = consumeMcpLimits({ keyId: key.keyId, userId: key.userId, limits: key.limits, surface: "rest" }, ["call"]);
  countKeyUsage(key.keyId, retryAfter ? "denied" : "call", "rest");
  return retryAfter;
}

const rateLimited = (retryAfter: number) =>
  refuse(429, "Too many requests for this API key. Try again later.", "RATE_LIMITED", { retryAfterSeconds: retryAfter }, { "Retry-After": String(retryAfter) });

type Authenticated = Exclude<ReturnType<typeof authenticateKeyRequest>, Response>;

function presentMe(auth: Authenticated) {
  const row = db.query(`SELECT k.id, k.name, k.key_prefix, k.kind, k.surfaces, k.created_at, k.expires_at, k.revoke_after, k.ip_allowlist, u.display_name, u.role, u.kind AS owner_kind
      FROM mcp_api_keys k JOIN users u ON u.id = k.user_id WHERE k.id = ?`).get(auth.id) as {
    id: string; name: string; key_prefix: string; kind: string; surfaces: string; created_at: string; expires_at: string | null; revoke_after: string | null;
    ip_allowlist: string | null; display_name: string; role: string; owner_kind: "person" | "service";
  };
  const own = auth.actor.limits;
  return {
    key: {
      id: row.id, name: row.name, prefix: row.key_prefix, kind: row.kind, surfaces: row.surfaces, createdAt: row.created_at,
      expiresAt: row.expires_at, rotationEndsAt: row.revoke_after, ipRestricted: row.ip_allowlist !== null
    },
    // `kind` is 'service' for an integration's key (D287).
    owner: { id: auth.user_id, displayName: row.display_name, role: row.role, kind: row.owner_kind },
    // Effective grants: stored grants ∩ the owner's role ∩ team policy, as every call checks them. Ids only.
    grants: auth.actor.grants.map((grant) => ({ module: grant.module, permission: grant.permission, resource: grant.resourceKind ? { kind: grant.resourceKind, id: grant.resourceId } : null })),
    scopes: auth.actor.scopes,
    limits: {
      perKey: { callsPerMinute: own.callsPerMinute ?? MCP_LIMITS.call.limit, writesPerMinute: own.writesPerMinute ?? MCP_LIMITS.write.limit },
      perUser: { callsPerMinute: MCP_USER_LIMITS.call!.limit, writesPerMinute: MCP_USER_LIMITS.write!.limit },
      perSurface: true,
      note: "Per-minute limits apply per surface: a key used over both MCP and REST gets these limits on each. Daily limits are shared."
    }
  };
}

function toolListing(key: McpKeyContext) {
  return visibleTools(key).map((spec) => ({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    write: spec.write,
    annotations: { readOnlyHint: !spec.write, destructiveHint: false, idempotentHint: !spec.write, openWorldHint: false },
    inputSchema: z.toJSONSchema(spec.inputSchema, { io: "input", unrepresentable: "any" })
  }));
}

const liveContext = (auth: Authenticated): McpKeyContext & { limits: Authenticated["actor"]["limits"] } =>
  ({ keyId: auth.id, userId: auth.user_id, name: auth.name, scopes: auth.actor.scopes, grants: auth.actor.grants, limits: auth.actor.limits });

async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return refuse(415, "Send the arguments as JSON with Content-Type: application/json", "UNSUPPORTED_MEDIA_TYPE");
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBody(request);
  } catch (error) {
    if (error instanceof HTTPException && error.status === 413) return refuse(413, "Request is too large", "TOO_LARGE");
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return refuse(400, "The body must be a JSON object (send {} for a tool without arguments)", "INVALID_JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse(400, "The body must be a JSON object (send {} for a tool without arguments)", "INVALID_JSON");
  return value as Record<string, unknown>;
}

async function handle(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url);
  if (keyInUrl(url)) {
    // Refused before anything else, and never logged: the key may now be in proxy logs, so say so.
    return refuse(400, "Send API keys only in the Authorization header, never in the URL. If this was a real key, revoke it: it may now be in logs.", "KEY_IN_URL");
  }
  const path = url.pathname.replace(/\/+$/, "");
  const method = c.req.method;
  // No CORS: a preflight gets no Access-Control-* headers, so browsers on other sites stop there.
  if (method === "OPTIONS") return refuse(405, "Method not allowed", "METHOD_NOT_ALLOWED");
  // The vault's resource routes (Wave 27, D220): vault keys only, and vault keys only there (T217).
  if (path === "/api/v1/vault" || path.startsWith("/api/v1/vault/")) {
    const subpath = path.slice("/api/v1/vault".length);
    const matched = matchVaultRoute(subpath);
    if (!matched) return refuse(404, "Not found", "NOT_FOUND");
    const allowedMethods = matched.methods.includes("GET") ? [...matched.methods, "HEAD"] : matched.methods;
    if (!allowedMethods.includes(method)) return refuse(405, "Method not allowed", "METHOD_NOT_ALLOWED", {}, { Allow: matched.methods.join(", ") });
    const auth = authenticateKeyRequest(c.req.raw, { surface: "rest", clientIp: clientIp(c) });
    if (auth instanceof Response) return auth;
    if (auth.actor.kind !== "vault") {
      countKeyUsage(auth.id, "denied", "rest");
      return refuse(403, "This API key cannot use the vault API. Create a vault key (nkv_) in Settings → API keys.", "KEY_POLICY");
    }
    return withRestSlot(() => handleVaultRest(c.req.raw, url, subpath, auth));
  }
  const toolMatch = /^\/api\/v1\/tools\/([a-z_]{1,64})$/.exec(path);
  const route = path === "/api/v1/me" ? "me" : path === "/api/v1/tools" ? "tools" : toolMatch ? "tool" : null;
  if (!route) return refuse(404, "Not found", "NOT_FOUND");
  const allowed = route === "tool" ? "POST" : "GET";
  if (method !== allowed && !(allowed === "GET" && method === "HEAD")) return refuse(405, "Method not allowed", "METHOD_NOT_ALLOWED", {}, { Allow: allowed });

  const auth = authenticateKeyRequest(c.req.raw, { surface: "rest", clientIp: clientIp(c) });
  if (auth instanceof Response) return auth;
  // A vault key works only on /api/v1/vault/* (and the vault MCP tools), never on the general tools (T217).
  if (auth.actor.kind === "vault") {
    countKeyUsage(auth.id, "denied", "rest");
    return refuse(403, "A vault key (nkv_) works only on /api/v1/vault/* and the vault MCP tools.", "KEY_POLICY");
  }

  return withRestSlot(async () => {
    const key = liveContext(auth);
    if (route === "me") {
      const retryAfter = chargeRead(key);
      return retryAfter ? rateLimited(retryAfter) : json(200, presentMe(auth));
    }
    if (route === "tools") {
      const retryAfter = chargeRead(key);
      return retryAfter ? rateLimited(retryAfter) : json(200, { tools: toolListing(key) });
    }
    const spec = mcpToolSpecs.find((item) => item.name === toolMatch![1]);
    // A tool this key cannot see looks the same as one that does not exist (as in MCP tools/list).
    if (!spec || !toolVisible(spec, key)) return refuse(404, "No such tool for this API key", "NOT_FOUND");
    const body = await readJsonObject(c.req.raw);
    if (body instanceof Response) return body;
    const result = await runTool(spec, body, auth.id, "rest");
    const value = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    if (!result.isError) return json(200, value);
    const code = value.code as McpErrorCode;
    const status = REST_STATUS[code] ?? 400;
    const retry = code === "RATE_LIMITED" && typeof value.retryAfterSeconds === "number" ? { "Retry-After": String(value.retryAfterSeconds) } : undefined;
    return json(status, value, retry);
  });
}

export function registerRestV1(app: Hono<AppEnv>) {
  app.all("/api/v1", handle);
  app.all("/api/v1/*", handle);
}

/** Test hook: the REST slot count. */
export const restActiveRequests = () => activeRequests;
