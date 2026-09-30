import type { Context, Hono, Next } from "hono";
import { z, ZodError } from "zod";
import type { AppEnv } from "../auth";
import { parseJson, uuid } from "../validation";
import { VaultError, type VaultActor } from "./access";
import {
  clearValue, createEnvironment, createSecret, createVault, deleteEnvironment, deleteSecret, deleteVault, getSecret, getVault, listSecrets, listVaults,
  listVersions, readValue, readVersion, reorderEnvironments, restoreVersion, revealCells, setValue, setValues, updateEnvironment, updateSecret, updateVault
} from "./service";
import { requireVaultEnabled, vaultStatus } from "./status";
import { hasControlChars, isTag, SECRET_TYPES, SLUG_PATTERN, VAULT_BOUNDS } from "../../shared/vault";
import "./bin";

/**
 * The Vault's session API, `/api/vault/*` (docs/plan/API_CONTRACTS.md § Vault; vault plan §7). Every
 * route needs a session; mutations also need CSRF and a role that writes (the global write gate
 * refuses viewers and guests, except a viewer's reveal batch, which is a read sent as POST). Guests
 * get 404 on every read. With the module off every route but `/api/vault/status` answers 503
 * `VAULT_DISABLED`. Responses are `no-store` (all of /api), and no error carries a value or echoes
 * input: validation failures name the field only (T188).
 *
 * Wave 25 builds no API keys and no MCP tools (owner-only vaults): `/api/v1/vault/*` and the `nkv_`
 * MCP tools arrive in Wave 27.
 */

const actorOf = (c: Context<AppEnv>): VaultActor => ({ kind: "session", userId: c.get("user").id });

const line = (max: number) => z.string().trim().min(1).max(max).refine((value) => !hasControlChars(value), "must be one line of text");
const vaultName = line(VAULT_BOUNDS.vaultName);
const description = z.string().max(VAULT_BOUNDS.description).refine((value) => !/[\u0000\u202a-\u202e\u2066-\u2069]/.test(value), "has characters that are not allowed");
const slug = z.string().regex(SLUG_PATTERN, "must be lowercase letters, digits, and hyphens");
const envName = line(VAULT_BOUNDS.envName);
const secretName = line(VAULT_BOUNDS.secretName);
const tags = z.array(z.string().refine(isTag, "must be 1–32 characters without spaces or commas")).max(VAULT_BOUNDS.tags)
  .refine((list) => new Set(list).size === list.length, "must not repeat")
  .refine((list) => JSON.stringify(list).length <= 1024, "are too long together");
const value = z.string().max(VAULT_BOUNDS.valueBytes).refine((item) => !item.includes("\u0000"), "must not contain NUL characters");
const comment = z.string().max(VAULT_BOUNDS.commentBytes).refine((item) => !item.includes("\u0000"), "must not contain NUL characters").nullable();
const revision = z.number().int().min(1);
const version = z.number().int().min(0);

const newEnvironment = z.object({ slug, name: envName, protected: z.boolean().optional() }).strict();
const createVaultSchema = z.object({ name: vaultName, description: description.optional(), environments: z.array(newEnvironment).min(1).max(VAULT_BOUNDS.environments).optional() }).strict();
const updateVaultSchema = z.object({ name: vaultName.optional(), description: description.optional(), expectedRevision: revision }).strict();
const updateEnvironmentSchema = z.object({ name: envName.optional(), protected: z.boolean().optional() }).strict();
const reorderSchema = z.object({ ids: z.array(uuid).min(1).max(VAULT_BOUNDS.environments), expectedRevision: revision }).strict();
const newValue = z.object({ value, comment: comment.optional() }).strict();
const createSecretSchema = z.object({
  name: secretName, type: z.enum(SECRET_TYPES).default("value"), comment: comment.optional(), tags: tags.optional(),
  values: z.record(uuid, newValue).refine((record) => Object.keys(record).length <= VAULT_BOUNDS.applyBatch, "has too many environments").optional()
}).strict();
const updateSecretSchema = z.object({ name: secretName.optional(), type: z.enum(SECRET_TYPES).optional(), comment: comment.optional(), tags: tags.optional(), expectedRevision: revision }).strict();
const setValueSchema = z.object({ value, comment: comment.optional(), expectedVersion: version }).strict();
const setValuesSchema = z.object({ values: z.array(z.object({ envId: uuid, value, comment: comment.optional(), expectedVersion: version }).strict()).min(1).max(VAULT_BOUNDS.applyBatch) }).strict();
const revealSchema = z.object({ cells: z.array(z.object({ secretId: uuid, envId: uuid }).strict()).min(1).max(VAULT_BOUNDS.revealBatch) }).strict();
const restoreSchema = z.object({ expectedVersion: version }).strict();

/** Ids in the path: anything that is not a UUID is the same 404 as a missing item (T194). */
function id(c: Context<AppEnv>, name: string) {
  const parsed = uuid.safeParse(c.req.param(name)?.toLowerCase());
  if (!parsed.success) throw new VaultError(404, "NOT_FOUND", "Not found");
  return parsed.data;
}

function fail(c: Context<AppEnv>, error: unknown) {
  if (error instanceof VaultError) {
    if (error.status === 429 && typeof error.details.retryAfterSeconds === "number") c.header("Retry-After", String(error.details.retryAfterSeconds));
    return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
  }
  // Field paths and rules only: zod messages never quote the input, and nothing else is added.
  if (error instanceof ZodError) return c.json({ error: "Invalid request", code: "INVALID", details: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`) }, 400);
  if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON", code: "INVALID" }, 400);
  throw error;
}

type Handler = (c: Context<AppEnv>) => unknown | Promise<unknown>;
const handle = (handler: Handler) => async (c: Context<AppEnv>) => {
  try {
    requireVaultEnabled();
    const result = await handler(c);
    return result instanceof Response ? result : c.json(result as object);
  } catch (error) {
    return fail(c, error);
  }
};

/** Guests never reach the vault (V-O3): every vault path is 404 for them, as if it did not exist. */
async function vaultGate(c: Context<AppEnv>, next: Next) {
  if (c.get("user")?.role === "guest") return c.json({ error: "Not found" }, 404);
  await next();
}

export function registerVaultRoutes(app: Hono<AppEnv>) {
  app.use("/api/vault/*", vaultGate);
  app.use("/api/vault", vaultGate);

  // Whether the module is on. Why it is off (no key, or a key that does not open the vaults) is for admins only.
  app.get("/api/vault/status", (c) => {
    const status = vaultStatus();
    return c.json({ enabled: status.enabled, reason: c.get("user").role === "admin" ? status.reason : null });
  });

  app.get("/api/vault/vaults", handle((c) => ({ vaults: listVaults(actorOf(c)) })));
  app.post("/api/vault/vaults", handle(async (c) => {
    const body = await parseJson(c.req.raw, createVaultSchema);
    return c.json({ vault: createVault(actorOf(c), body) }, 201);
  }));
  app.get("/api/vault/vaults/:vaultId", handle((c) => ({ vault: getVault(actorOf(c), id(c, "vaultId")) })));
  app.patch("/api/vault/vaults/:vaultId", handle(async (c) => {
    const vaultId = id(c, "vaultId");
    return { vault: updateVault(actorOf(c), vaultId, await parseJson(c.req.raw, updateVaultSchema)) };
  }));
  app.delete("/api/vault/vaults/:vaultId", handle((c) => deleteVault(actorOf(c), id(c, "vaultId"))));

  app.post("/api/vault/vaults/:vaultId/environments", handle(async (c) => {
    const vaultId = id(c, "vaultId");
    return c.json({ environment: createEnvironment(actorOf(c), vaultId, await parseJson(c.req.raw, newEnvironment)) }, 201);
  }));
  app.put("/api/vault/vaults/:vaultId/environments/order", handle(async (c) => {
    const vaultId = id(c, "vaultId");
    const body = await parseJson(c.req.raw, reorderSchema);
    return { vault: reorderEnvironments(actorOf(c), vaultId, body.ids.map((item) => item.toLowerCase()), body.expectedRevision) };
  }));
  app.patch("/api/vault/vaults/:vaultId/environments/:envId", handle(async (c) => {
    const [vaultId, envId] = [id(c, "vaultId"), id(c, "envId")];
    return { environment: updateEnvironment(actorOf(c), vaultId, envId, await parseJson(c.req.raw, updateEnvironmentSchema)) };
  }));
  app.delete("/api/vault/vaults/:vaultId/environments/:envId", handle((c) => deleteEnvironment(actorOf(c), id(c, "vaultId"), id(c, "envId"))));

  app.get("/api/vault/vaults/:vaultId/secrets", handle((c) => {
    const tag = c.req.query("tag");
    if (tag !== undefined && !isTag(tag)) throw new VaultError(400, "INVALID", "tag is not valid");
    const q = c.req.query("q");
    if (q !== undefined && q.length > VAULT_BOUNDS.secretName) throw new VaultError(400, "INVALID", "q is too long");
    return listSecrets(actorOf(c), id(c, "vaultId"), { q, tag, cursor: c.req.query("cursor") ?? null });
  }));
  app.post("/api/vault/vaults/:vaultId/secrets", handle(async (c) => {
    const vaultId = id(c, "vaultId");
    const body = await parseJson(c.req.raw, createSecretSchema);
    const values = body.values ? Object.fromEntries(Object.entries(body.values).map(([envId, entry]) => [envId.toLowerCase(), entry])) : undefined;
    return c.json(createSecret(actorOf(c), vaultId, { ...body, values }), 201);
  }));
  app.get("/api/vault/vaults/:vaultId/secrets/:secretId", handle((c) => getSecret(actorOf(c), id(c, "vaultId"), id(c, "secretId"))));
  app.patch("/api/vault/vaults/:vaultId/secrets/:secretId", handle(async (c) => {
    const [vaultId, secretId] = [id(c, "vaultId"), id(c, "secretId")];
    return updateSecret(actorOf(c), vaultId, secretId, await parseJson(c.req.raw, updateSecretSchema));
  }));
  app.delete("/api/vault/vaults/:vaultId/secrets/:secretId", handle((c) => deleteSecret(actorOf(c), id(c, "vaultId"), id(c, "secretId"))));

  // One value: read (audited), set with CAS, clear with CAS; and several at once ("apply to other environments").
  app.get("/api/vault/vaults/:vaultId/secrets/:secretId/values/:envId", handle((c) => {
    const result = readValue(actorOf(c), id(c, "vaultId"), id(c, "secretId"), id(c, "envId"));
    c.header("ETag", `"v${result.version}"`);
    return { value: result };
  }));
  app.put("/api/vault/vaults/:vaultId/secrets/:secretId/values/:envId", handle(async (c) => {
    const [vaultId, secretId, envId] = [id(c, "vaultId"), id(c, "secretId"), id(c, "envId")];
    const result = setValue(actorOf(c), vaultId, secretId, envId, await parseJson(c.req.raw, setValueSchema));
    c.header("ETag", `"v${result.version}"`);
    return { value: result };
  }));
  app.delete("/api/vault/vaults/:vaultId/secrets/:secretId/values/:envId", handle((c) => {
    const [vaultId, secretId, envId] = [id(c, "vaultId"), id(c, "secretId"), id(c, "envId")];
    const raw = c.req.query("expectedVersion");
    if (raw === undefined || !/^\d{1,9}$/.test(raw)) throw new VaultError(400, "INVALID", "Send expectedVersion");
    return clearValue(actorOf(c), vaultId, secretId, envId, Number(raw));
  }));
  app.put("/api/vault/vaults/:vaultId/secrets/:secretId/values", handle(async (c) => {
    const [vaultId, secretId] = [id(c, "vaultId"), id(c, "secretId")];
    const body = await parseJson(c.req.raw, setValuesSchema);
    return { values: setValues(actorOf(c), vaultId, secretId, body.values.map((entry) => ({ ...entry, envId: entry.envId.toLowerCase() }))) };
  }));
  app.post("/api/vault/vaults/:vaultId/reveal", handle(async (c) => {
    const vaultId = id(c, "vaultId");
    const body = await parseJson(c.req.raw, revealSchema);
    return revealCells(actorOf(c), vaultId, body.cells.map((cell) => ({ secretId: cell.secretId.toLowerCase(), envId: cell.envId.toLowerCase() })));
  }));

  // History (D224): metadata, one version (audited), and restore as a new version.
  app.get("/api/vault/vaults/:vaultId/secrets/:secretId/values/:envId/versions", handle((c) => listVersions(actorOf(c), id(c, "vaultId"), id(c, "secretId"), id(c, "envId"))));
  app.get("/api/vault/vaults/:vaultId/secrets/:secretId/values/:envId/versions/:version", handle((c) => {
    const raw = c.req.param("version") ?? "";
    if (!/^\d{1,9}$/.test(raw)) throw new VaultError(404, "NOT_FOUND", "Not found");
    return { version: readVersion(actorOf(c), id(c, "vaultId"), id(c, "secretId"), id(c, "envId"), Number(raw)) };
  }));
  app.post("/api/vault/vaults/:vaultId/secrets/:secretId/values/:envId/versions/:version/restore", handle(async (c) => {
    const [vaultId, secretId, envId] = [id(c, "vaultId"), id(c, "secretId"), id(c, "envId")];
    const raw = c.req.param("version") ?? "";
    if (!/^\d{1,9}$/.test(raw)) throw new VaultError(404, "NOT_FOUND", "Not found");
    const body = await parseJson(c.req.raw, restoreSchema);
    return { value: restoreVersion(actorOf(c), vaultId, secretId, envId, Number(raw), body.expectedVersion) };
  }));
}
