import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { config, isEmailAllowed, isOriginAllowed } from "./config";
import { db } from "./db";
import { registerMcpTools, type McpKeyContext } from "./mcpTools";
import { registerRoutinePrompts } from "./inbox/prompts";
import { DEFAULT_MCP_SCOPES, normalizeScopes, type McpScope } from "./mcpScopes";
import { HTTPException } from "hono/http-exception";
import { boundedRequest } from "./validation";
import { type Role } from "./team/roles";
import { countKeyUsage, createApiKey, hashKeyToken, isKeyDenial, listApiKeys, markKeyUsed, noteKeyDenied, resolveKeyActor, revokeOwnKey, type KeyActor } from "./apiKeys";
import { grantsForScopes, type KeySurfaces } from "./keyGrants";
import { addressAllowed, ipAllowlistAvailable } from "./ipAllowlist";
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
  /** 'service' when the key belongs to an integration (D287). */
  kind: "person" | "service";
  /** The key's effective grants and scopes for this request (Nook keys, D263). */
  actor: KeyActor;
  /** The surface the key was checked for (Wave 34). */
  surface: "mcp" | "rest";
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

/** Failed Bearer authentications per surface per minute; past 60, every failure answers 429. */
const invalidAuth = { mcp: { count: 0, resetAt: Date.now() + 60_000 }, rest: { count: 0, resetAt: Date.now() + 60_000 } };
let activeRequests = 0;

function mcpResponse(body: BodyInit | null, init: ResponseInit) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store, private");
  headers.set("Vary", "Authorization");
  return new Response(body, { ...init, headers });
}

function mcpJsonError(error: string, status: number, authenticate = false, code?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authenticate) headers["WWW-Authenticate"] = "Bearer";
  return mcpResponse(JSON.stringify(code ? { error, code } : { error }), { status, headers });
}

function recordInvalidAuth(surface: "mcp" | "rest") {
  const bucket = invalidAuth[surface];
  const time = Date.now();
  if (time >= bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = time + 60_000;
  }
  bucket.count += 1;
  return bucket.count > 60;
}

/** The hosts `/mcp` and `/api/v1` answer on: the app origins, plus the loopback spellings of a local origin. */
function allowedHosts() {
  const hosts = new Set<string>();
  for (const allowedOrigin of config.appOrigins) {
    const appUrl = new URL(allowedOrigin);
    hosts.add(appUrl.host);
    if (["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname)) {
      const port = appUrl.port ? `:${appUrl.port}` : "";
      hosts.add(`localhost${port}`);
      hosts.add(`127.0.0.1${port}`);
      hosts.add(`[::1]${port}`);
    }
  }
  return hosts;
}

/**
 * Which surface a request authenticates for: `/mcp` is "mcp", `/api/v1` is "rest", and an upload's
 * PUT (`/mcp/uploads/:id`) is "upload": it only finishes a ticket a tool call already opened, so a
 * key may use it on whichever surface it holds (REST-only keys too).
 */
export type AuthSurface = "mcp" | "rest" | "upload";

/**
 * The Host/Origin checks, the Bearer key lookup, and the per-key IP allowlist of every key entry
 * point: /mcp, PUT /mcp/uploads/:id (server/mcpUploads.ts), and /api/v1 (server/restV1.ts, Wave 34).
 * Returns the live key, its holder, and the surface it was checked for, or the error response (401
 * with WWW-Authenticate, 403 for a bad host or origin, a surface or policy refusal, or an address
 * outside the key's allowlist; 429 after many failures). Keys are read only from the Authorization
 * header, never from a URL or a cookie; nothing here logs or echoes the token.
 */
export function authenticateKeyRequest(request: Request, options: { surface: AuthSurface; clientIp?: string | null }): McpKeyRow | Response {
  const limiter = options.surface === "rest" ? "rest" : "mcp";
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  if (!host || !allowedHosts().has(host)) return mcpJsonError("Invalid host", 403, false, "HOST_INVALID");
  if (origin && !isOriginAllowed(origin)) return mcpJsonError("Invalid origin", 403, false, "ORIGIN_INVALID");

  const authorization = request.headers.get("authorization") ?? "";
  // The scheme is case-insensitive (RFC 9110, review S7); the key itself is exact.
  const match = /^bearer ([A-Za-z0-9_-]{40,80})$/i.exec(authorization.trim());
  if (!match) {
    const limited = recordInvalidAuth(limiter);
    return limited ? mcpJsonError("Too many authentication failures", 429, true, "RATE_LIMITED")
      : mcpJsonError("Send an API key as Authorization: Bearer <key>", 401, true, "AUTH_REQUIRED");
  }
  const token = match[1]!;
  // Found even when revoked or its holder blocked, so the owner's key row can say why (review Q1);
  // the caller always gets the one code KEY_INVALID for a key that does not authenticate (review Q5).
  const row = db.query(`
    SELECT k.id, k.user_id, k.name, k.key_prefix, k.created_at, k.last_used_at, k.scopes, k.surfaces, u.email, u.role, u.kind
    FROM mcp_api_keys k JOIN users u ON u.id = k.user_id
    WHERE k.token_hash = ?
  `).get(hashMcpToken(token)) as (Omit<McpKeyRow, "actor" | "surface"> & { surfaces: KeySurfaces }) | null;
  const invalid = () => {
    const limited = recordInvalidAuth(limiter);
    return limited ? mcpJsonError("Too many authentication failures", 429, true, "RATE_LIMITED")
      : mcpJsonError("This API key is not valid or no longer active", 401, true, "KEY_INVALID");
  };
  // An integration's synthetic address is never on ALLOWED_EMAILS (D287): its keys live by its block state alone.
  if (!row || (row.kind !== "service" && !isEmailAllowed(row.email))) return invalid();
  const surface: "mcp" | "rest" = options.surface === "upload" ? (row.surfaces === "rest" ? "rest" : "mcp") : options.surface;
  // Expired, past its rotation grace, revoked, not allowed on this surface, or blocked by team policy (D263, D276, D277, D279, T209).
  const actor = resolveKeyActor(row.id, surface);
  if (isKeyDenial(actor)) {
    countKeyUsage(row.id, "denied", surface);
    if (actor.code === "KEY_POLICY") return mcpResponse(JSON.stringify({ error: actor.message, code: "KEY_POLICY" }), { status: 403, headers: { "Content-Type": "application/json" } });
    return invalid();
  }
  // Wave 34 (D284, T211): a key limited to addresses works only from inside its list, and only
  // where the server can see client addresses; the refusal never echoes the list or the address.
  if (actor.ipAllowlist !== null) {
    const refused = !ipAllowlistAvailable() ? "This API key is limited to certain addresses, and this server cannot check addresses. Ask an admin."
      : !addressAllowed(actor.ipAllowlist, options.clientIp ?? null) ? "This API key cannot be used from this address" : null;
    if (refused) {
      countKeyUsage(row.id, "denied", surface);
      noteKeyDenied(row, "ip", surface, options.clientIp ?? null);
      return mcpJsonError(refused, 403, false, "IP_NOT_ALLOWED");
    }
  }
  markKeyUsed(row.id, surface);
  return { ...row, actor, surface };
}

/** The MCP endpoint's authentication (kept for callers and tests from before Wave 34). */
export const authenticateMcpRequest = (request: Request, clientIp: string | null = null) => authenticateKeyRequest(request, { surface: "mcp", clientIp });

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

export async function handleMcpRequest(request: Request, clientIp: string | null = null) {
  const authenticated = authenticateMcpRequest(request, clientIp);
  if (authenticated instanceof Response) return authenticated;
  const key = authenticated;
  const token = /^bearer (.+)$/i.exec((request.headers.get("authorization") ?? "").trim())![1]!;
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
