import { HTTPException } from "hono/http-exception";
import { z, ZodError } from "zod";
import { countKeyUsage, type KeyActor } from "../apiKeys";
import { mcpResponse } from "../mcp";
import { consumeMcpLimits } from "../mcpRateLimit";
import { canWriteContent } from "../team/userRole";
import { readBoundedBody } from "../validation";
import { hasControlChars, isTag, SECRET_TYPES, VAULT_BOUNDS } from "../../shared/vault";
import { VaultError, type VaultKeyActor } from "./access";
import { vaultKeyActor } from "./keys";
import { noteKeyLimited, presentSecret, presentVault, safeDetails } from "./keyApi";
import { KeyLimitError } from "./limits";
import { createSecret, getSecret, getVault, listSecrets, listVaults, listVersions, readValue, setValue } from "./service";
import { requireVaultEnabled } from "./status";

/**
 * The vault's REST API for `nkv_` keys, `/api/v1/vault/*` (Wave 27, vault plan §7, D220, T183, T184).
 * server/restV1.ts authenticates first (Bearer only, never a cookie or a URL; Host and Origin
 * checks; the key's surfaces, policy, IP list) and sends vault keys here; a general key gets 403
 * `KEY_POLICY` on these paths and a vault key gets 403 `KEY_POLICY` on every other `/api/v1` path
 * (the kind wall, T217).
 *
 *   GET  /vaults                                              the vaults the key reaches
 *   GET  /vaults/:v                                           one vault and the environments the key reaches
 *   GET  /vaults/:v/secrets?q=&tag=&cursor=                   names, types, tags, per-environment status
 *   POST /vaults/:v/secrets                                   create a secret, with values
 *   GET  /vaults/:v/secrets/:s                                metadata and the secret's comment (a read)
 *   GET  /vaults/:v/secrets/:s/values/:e                      one value (a read)
 *   PUT  /vaults/:v/secrets/:s/values/:e                      set one value (CAS on expectedVersion)
 *   GET  /vaults/:v/secrets/:s/values/:e/versions             the history, metadata only
 *
 * Values over REST need the key's read grant on that environment (and, for a protected one, a grant
 * naming it on a key with `protectedAccess`); `allowMcpValueReads` is about MCP only (T191: values an
 * LLM client reads leave the host), and REST is the path the plan recommends for CI. JSON only,
 * `no-store`, and the same error shape and codes as `/api/v1` (`{error, code}`). Every read and write
 * is a `vault_events` row with the key's id and `via: api`; the key's own buckets limit it (reads 20
 * a minute, writes 10), on top of the general per-key REST buckets.
 */

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  mcpResponse(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
const refuse = (status: number, error: string, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => json(status, { error, code, ...extra }, headers);

const uuid = z.string().uuid();
const line = (max: number) => z.string().trim().min(1).max(max).refine((value) => !hasControlChars(value), "must be one line of text");
const text = z.string().refine((item) => !item.includes("\u0000"), "must not contain NUL characters");
const tags = z.array(z.string().refine(isTag, "must be 1–32 characters without spaces or commas")).max(VAULT_BOUNDS.tags)
  .refine((list) => new Set(list).size === list.length, "must not repeat");
const createSecretSchema = z.object({
  name: line(VAULT_BOUNDS.secretName), type: z.enum(SECRET_TYPES).default("value"), comment: text.nullable().optional(), tags: tags.optional(),
  values: z.record(uuid, z.object({ value: text, comment: text.nullable().optional() }).strict())
    .refine((record) => Object.keys(record).length <= VAULT_BOUNDS.applyBatch, "has too many environments").optional()
}).strict();
const setValueSchema = z.object({ value: text, comment: text.nullable().optional(), expectedVersion: z.number().int().min(0) }).strict();

type Route =
  | { name: "vaults" } | { name: "vault"; vaultId: string } | { name: "secrets"; vaultId: string } | { name: "secret"; vaultId: string; secretId: string }
  | { name: "value"; vaultId: string; secretId: string; envId: string } | { name: "versions"; vaultId: string; secretId: string; envId: string };

const ID = "([0-9a-fA-F-]{36})";
const ROUTES: Array<{ pattern: RegExp; methods: string[]; build: (match: RegExpExecArray) => Route }> = [
  { pattern: /^\/vaults$/, methods: ["GET"], build: () => ({ name: "vaults" }) },
  { pattern: new RegExp(`^/vaults/${ID}$`), methods: ["GET"], build: (m) => ({ name: "vault", vaultId: m[1]! }) },
  { pattern: new RegExp(`^/vaults/${ID}/secrets$`), methods: ["GET", "POST"], build: (m) => ({ name: "secrets", vaultId: m[1]! }) },
  { pattern: new RegExp(`^/vaults/${ID}/secrets/${ID}$`), methods: ["GET"], build: (m) => ({ name: "secret", vaultId: m[1]!, secretId: m[2]! }) },
  { pattern: new RegExp(`^/vaults/${ID}/secrets/${ID}/values/${ID}$`), methods: ["GET", "PUT"], build: (m) => ({ name: "value", vaultId: m[1]!, secretId: m[2]!, envId: m[3]! }) },
  { pattern: new RegExp(`^/vaults/${ID}/secrets/${ID}/values/${ID}/versions$`), methods: ["GET"], build: (m) => ({ name: "versions", vaultId: m[1]!, secretId: m[2]!, envId: m[3]! }) }
];

/** The route for a path under `/api/v1/vault` and the methods it allows, or null (404). Ids that are not UUIDs are 404. */
export function matchVaultRoute(subpath: string): { route: Route; methods: string[] } | null {
  for (const entry of ROUTES) {
    const match = entry.pattern.exec(subpath);
    if (!match) continue;
    if (match.slice(1).some((part) => !uuid.safeParse(part).success)) return null;
    const route = entry.build(match);
    for (const key of ["vaultId", "secretId", "envId"] as const) if (key in route) (route as Record<string, string>)[key] = (route as Record<string, string>)[key]!.toLowerCase();
    return { route, methods: entry.methods };
  }
  return null;
}

async function readJson(request: Request): Promise<unknown | Response> {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return refuse(415, "Send JSON with Content-Type: application/json", "UNSUPPORTED_MEDIA_TYPE");
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBody(request);
  } catch (error) {
    if (error instanceof HTTPException && error.status === 413) return refuse(413, "Request is too large", "TOO_LARGE");
    throw error;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) return refuse(400, "The body must be a JSON object", "INVALID_JSON");
    return value;
  } catch {
    return refuse(400, "The body must be a JSON object", "INVALID_JSON");
  }
}

async function run(route: Route, method: string, request: Request, url: URL, actor: VaultKeyActor): Promise<unknown | Response> {
  switch (route.name) {
    case "vaults": return { vaults: listVaults(actor).map(presentVault) };
    case "vault": return { vault: presentVault(getVault(actor, route.vaultId)) };
    case "secrets": {
      if (method === "POST") {
        const body = await readJson(request);
        if (body instanceof Response) return body;
        const input = createSecretSchema.parse(body);
        const values = input.values ? Object.fromEntries(Object.entries(input.values).map(([envId, entry]) => [envId.toLowerCase(), { value: entry.value, comment: entry.comment ?? null }])) : undefined;
        const created = createSecret(actor, route.vaultId, { name: input.name, type: input.type, comment: input.comment ?? null, tags: input.tags, values });
        return json(201, { secret: presentSecret(created.secret) });
      }
      const q = url.searchParams.get("q") ?? undefined;
      const tag = url.searchParams.get("tag") ?? undefined;
      if (q !== undefined && q.length > VAULT_BOUNDS.secretName) throw new VaultError(400, "INVALID", "q is too long");
      if (tag !== undefined && !isTag(tag)) throw new VaultError(400, "INVALID", "tag is not valid");
      const page = listSecrets(actor, route.vaultId, { q, tag, cursor: url.searchParams.get("cursor") });
      return { vault: presentVault(page.vault), secrets: page.secrets.map(presentSecret), nextCursor: page.nextCursor };
    }
    case "secret": {
      const detail = getSecret(actor, route.vaultId, route.secretId);
      return { secret: { ...presentSecret(detail.secret), comment: detail.secret.comment } };
    }
    case "value": {
      if (method === "PUT") {
        const body = await readJson(request);
        if (body instanceof Response) return body;
        const input = setValueSchema.parse(body);
        const written = setValue(actor, route.vaultId, route.secretId, route.envId, { value: input.value, comment: input.comment ?? null, expectedVersion: input.expectedVersion });
        return json(200, { value: written }, { ETag: `"v${written.version}"` });
      }
      const value = readValue(actor, route.vaultId, route.secretId, route.envId);
      return json(200, { value }, { ETag: `"v${value.version}"` });
    }
    case "versions": return listVersions(actor, route.vaultId, route.secretId, route.envId);
  }
}

/**
 * One `/api/v1/vault/*` request for an authenticated vault key (server/restV1.ts checked the key,
 * its kind, and the method first). `subpath` is the path after `/api/v1/vault`.
 */
export async function handleVaultRest(request: Request, url: URL, subpath: string, key: { id: string; user_id: string; name: string; actor: KeyActor }): Promise<Response> {
  const matched = matchVaultRoute(subpath)!;
  const method = request.method === "HEAD" ? "GET" : request.method;
  const write = method !== "GET";
  const actor = vaultKeyActor({ keyId: key.id, userId: key.user_id, name: key.name, grants: key.actor.grants, vault: key.actor.vault }, "api");
  if (write && !canWriteContent(actor.userId)) {
    countKeyUsage(key.id, "denied", "rest");
    return refuse(403, "Your team role is read-only", "READ_ONLY");
  }
  const retryAfter = consumeMcpLimits({ keyId: key.id, userId: key.user_id, limits: key.actor.limits, surface: "rest" }, write ? ["call", "write"] : ["call"]);
  if (retryAfter) {
    countKeyUsage(key.id, "denied", "rest");
    return refuse(429, "Too many requests for this API key. Try again later.", "RATE_LIMITED", { retryAfterSeconds: retryAfter }, { "Retry-After": String(retryAfter) });
  }
  countKeyUsage(key.id, write ? "write" : "call", "rest");
  try {
    requireVaultEnabled();
    const result = await run(matched.route, method, request, url, actor);
    return result instanceof Response ? result : json(200, result);
  } catch (error) {
    if (error instanceof KeyLimitError) noteKeyLimited(actor, error, "vaultId" in matched.route ? matched.route.vaultId : null);
    if (error instanceof VaultError) {
      const details = safeDetails(error);
      const retry = typeof details.retryAfterSeconds === "number" ? { "Retry-After": String(details.retryAfterSeconds) } : undefined;
      return refuse(error.status, error.message, error.code, details, retry);
    }
    // Field paths and rules only: zod messages never quote the input (T188).
    if (error instanceof ZodError) return refuse(400, "Invalid request", "INVALID", { details: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`) });
    if (error instanceof Error && error.name === "VaultIntegrityError") return refuse(500, "Stored vault data failed its integrity check", "VAULT_INTEGRITY");
    console.error("Vault REST request failed", error instanceof Error ? error.name : "Unknown error");
    return refuse(500, "Something went wrong", "INTERNAL");
  }
}
