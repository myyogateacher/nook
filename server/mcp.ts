import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { config, isEmailAllowed, isOriginAllowed } from "./config";
import { db, now } from "./db";
import { registerMcpTools, type McpKeyContext } from "./mcpTools";
import { registerRoutinePrompts } from "./inbox/prompts";
import { DEFAULT_MCP_SCOPES, normalizeScopes, type McpScope } from "./mcpScopes";
import { HTTPException } from "hono/http-exception";
import { boundedRequest } from "./validation";
import { type Role } from "./team/roles";
import { createApiKey, hashKeyToken, isKeyDenial, listApiKeys, resolveKeyActor, revokeOwnKey, type KeyActor } from "./apiKeys";
import { grantsForScopes } from "./keyGrants";
import { readPolicies } from "./team/policies";

type McpKeyRow = {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  scopes: string;
  email: string;
  role: Role;
  /** The key's effective grants and scopes for this request (Nook keys, D263). */
  actor: KeyActor;
};

export const hashMcpToken = hashKeyToken;

/**
 * Creates a general MCP key over "all" of each scope (write scopes add their read scope), expiring
 * after the policy's default lifetime (D276). This is the `/api/mcp/keys` alias's shape (one release,
 * access plan §C.7); `/api/keys` creates keys from grants. The token is returned once.
 */
export function createMcpApiKey(userId: string, name: string, requestedScopes: readonly McpScope[] = DEFAULT_MCP_SCOPES) {
  const scopes = normalizeScopes(requestedScopes);
  if (scopes.length === 0) throw new Error("An MCP key needs at least one scope");
  const created = createApiKey(userId, { name, surfaces: "mcp", grants: grantsForScopes(scopes), expiresInDays: readPolicies().keyDefaultDays });
  return { id: created.id, userId, name, prefix: created.prefix, scopes: created.scopes, createdAt: created.createdAt, expiresAt: created.expiresAt, token: created.token };
}

/**
 * The caller's live keys in the pre-grants shape (the alias `GET /api/mcp/keys`). `scopes` are
 * what the grants amount to; `effectiveScopes` are what the key can use right now under the
 * owner's current role and team policy, so Settings can show the difference.
 */
export function listMcpApiKeys(userId: string) {
  return listApiKeys(userId).keys.filter((key) => key.state !== "revoked").map((key) => ({
    id: key.id, name: key.name, key_prefix: key.prefix, scopes: key.scopes, effectiveScopes: key.state === "blocked" ? [] : key.effectiveScopes,
    created_at: key.createdAt, last_used_at: key.lastUsedAt, expires_at: key.expiresAt, state: key.state
  }));
}

/**
 * Revokes a key. Its pending proposals are withdrawn with it (review M1): they become
 * `superseded` with KEY_REVOKED, so nothing a revoked key suggested can be approved. A note draft
 * the key wrote stays in the note, as after any resolved proposal; only the proposal changes.
 */
export const revokeMcpApiKey = (userId: string, keyId: string) => revokeOwnKey(userId, keyId);

const mcpHandler = createMcpHandler(({ authInfo }) => {
  const server = new McpServer({ name: "nook", version: config.appVersion });
  const key = authInfo?.extra?.key as McpKeyContext | undefined;
  if (key) {
    registerMcpTools(server, key);
    // Agent inbox O7: each routine this key may run is also an MCP prompt.
    registerRoutinePrompts(server, key);
  }
  return server;
}, { maxSubscriptions: 0 });

let invalidAuthCount = 0;
let invalidAuthResetAt = Date.now() + 60_000;
let activeRequests = 0;

function mcpResponse(body: BodyInit | null, init: ResponseInit) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store, private");
  headers.set("Vary", "Authorization");
  return new Response(body, { ...init, headers });
}

function mcpJsonError(error: string, status: number, authenticate = false) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authenticate) headers["WWW-Authenticate"] = "Bearer";
  return mcpResponse(JSON.stringify({ error }), { status, headers });
}

function recordInvalidAuth() {
  const time = Date.now();
  if (time >= invalidAuthResetAt) {
    invalidAuthCount = 0;
    invalidAuthResetAt = time + 60_000;
  }
  invalidAuthCount += 1;
  return invalidAuthCount > 60;
}

/**
 * The Host/Origin checks and the Bearer key lookup of every MCP entry point: /mcp and, since Wave 19,
 * PUT /mcp/uploads/:id (server/mcpUploads.ts). Returns the live key and its holder, or the error
 * response (401 with WWW-Authenticate, 403 for a bad host or origin, 429 after many failures).
 */
export function authenticateMcpRequest(request: Request): McpKeyRow | Response {
  const allowedHosts = new Set<string>();
  for (const allowedOrigin of config.appOrigins) {
    const appUrl = new URL(allowedOrigin);
    allowedHosts.add(appUrl.host);
    if (["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname)) {
      const port = appUrl.port ? `:${appUrl.port}` : "";
      allowedHosts.add(`localhost${port}`);
      allowedHosts.add(`127.0.0.1${port}`);
      allowedHosts.add(`[::1]${port}`);
    }
  }
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  if (!host || !allowedHosts.has(host)) return mcpJsonError("Invalid host", 403);
  if (origin && !isOriginAllowed(origin)) return mcpJsonError("Invalid origin", 403);

  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{40,80})$/.exec(authorization);
  if (!match) {
    const limited = recordInvalidAuth();
    return mcpJsonError(limited ? "Too many authentication failures" : "A valid Bearer API key is required", limited ? 429 : 401, true);
  }
  const token = match[1]!;
  const row = db.query(`
    SELECT k.id, k.user_id, k.name, k.key_prefix, k.created_at, k.last_used_at, k.scopes, u.email, u.role
    FROM mcp_api_keys k JOIN users u ON u.id = k.user_id
    WHERE k.token_hash = ? AND k.revoked_at IS NULL AND u.disabled_at IS NULL
  `).get(hashMcpToken(token)) as Omit<McpKeyRow, "actor"> | null;
  if (!row || !isEmailAllowed(row.email)) {
    const limited = recordInvalidAuth();
    return mcpJsonError(limited ? "Too many authentication failures" : "Invalid or revoked API key", limited ? 429 : 401, true);
  }
  // Expired, past its rotation grace, or blocked by team policy (D263, D276, D277, T209).
  const actor = resolveKeyActor(row.id, "mcp");
  if (isKeyDenial(actor)) {
    if (actor.code === "KEY_POLICY") return mcpResponse(JSON.stringify({ error: actor.message, code: "KEY_POLICY" }), { status: 403, headers: { "Content-Type": "application/json" } });
    const limited = recordInvalidAuth();
    return mcpJsonError(limited ? "Too many authentication failures" : actor.message, limited ? 429 : 401, true);
  }

  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 300_000) {
    db.query("UPDATE mcp_api_keys SET last_used_at = ? WHERE id = ?").run(now(), row.id);
  }
  return { ...row, actor };
}

/** Runs `operation` in one of the shared MCP request slots (24 at once), or answers 503. */
export async function withMcpRequestSlot(operation: () => Promise<Response>) {
  if (activeRequests >= 24) return mcpJsonError("MCP server is busy", 503);
  activeRequests += 1;
  try {
    return await operation();
  } finally {
    activeRequests -= 1;
  }
}

export { mcpJsonError, mcpResponse };

export async function handleMcpRequest(request: Request) {
  const authenticated = authenticateMcpRequest(request);
  if (authenticated instanceof Response) return authenticated;
  const key = authenticated;
  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")![1]!;
  if (activeRequests >= 24) return mcpJsonError("MCP server is busy", 503);
  activeRequests += 1;
  try {
    let bounded: Request;
    try {
      bounded = await boundedRequest(request);
    } catch (error) {
      if (error instanceof HTTPException && error.status === 413) return mcpJsonError("Request is too large", 413);
      throw error;
    }
    // Effective grants and scopes: grants ∩ the holder's current role ∩ team policy (T81, D263).
    const { scopes, grants } = key.actor;
    const context: McpKeyContext = { keyId: key.id, userId: key.user_id, name: key.name, scopes, grants };
    const authInfo: AuthInfo = { token, clientId: key.user_id, scopes, extra: { key: context } };
    const response = await mcpHandler.fetch(bounded, { authInfo });
    return mcpResponse(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally {
    activeRequests -= 1;
  }
}
