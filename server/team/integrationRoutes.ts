import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { audit, db } from "../db";
import {
  adminRevokeKey, grantsForKind, checkKeyCount, checkRotation, createApiKey, createKeySchema, KeyError, listApiKeys, narrowApiKey, narrowKeySchema, ownApiKey, parseLimits,
  rotateApiKey, rotateKeySchema
} from "../apiKeys";
import { keyEvents } from "../access/events";
import { GENERAL_KEY_MODULES, type GrantModule } from "../keyGrants";
import { createLimited, precheckKeyCreate } from "../keyRoutes";
import { mailTwoFactor } from "../mail/triggers";
import { verifyReauth } from "../reauth";
import { readPolicies } from "./policies";
import { parseJson, uuid } from "../validation";
import { BLOCK_REASON_MAX, TeamError } from "./service";
import {
  blockIntegration, createIntegration, deleteIntegration, INTEGRATION_DESCRIPTION_MAX, INTEGRATION_EXCLUDED_MODULES, INTEGRATION_NAME_MAX, INTEGRATION_ROLES,
  integrationDetail, IntegrationError, integrationResources, listIntegrations, RETIRED_MESSAGE, unblockIntegration, updateIntegration
} from "./serviceAccounts";

/**
 * Team → Integrations (Wave 36, D287): `/api/team/integrations`, admins only (guests 404, everyone
 * else 403 ADMIN_ONLY), behind the session, CSRF, Origin, and TOTP middleware like the rest of
 * `/api/team`. Keys never reach these routes (D265), and there are no MCP tools for any of this.
 *
 * An integration's keys are managed here by admins with the same rules as a person's own keys: the
 * checks run against the integration (its role, its policy, the items shared with it), creation and
 * rotation re-authenticate the admin (password plus a fresh code), narrowing and revoking do not.
 * The admin is recorded as the actor and as the key's `created_by`.
 */

type Gate = (c: Context<AppEnv>) => Response | null;

const createSchema = z.object({
  name: z.string().trim().min(1).max(INTEGRATION_NAME_MAX),
  role: z.enum(INTEGRATION_ROLES),
  description: z.string().trim().max(INTEGRATION_DESCRIPTION_MAX).nullish()
}).strict();
const patchSchema = z.object({
  name: z.string().trim().min(1).max(INTEGRATION_NAME_MAX).optional(),
  description: z.string().trim().max(INTEGRATION_DESCRIPTION_MAX).nullable().optional(),
  role: z.enum(INTEGRATION_ROLES).optional(),
  expectedRole: z.enum(INTEGRATION_ROLES).optional()
}).strict();
const blockSchema = z.object({ reason: z.string().max(BLOCK_REASON_MAX).optional() }).strict();
const emptySchema = z.object({}).strict();
const moduleSchema = z.enum(GENERAL_KEY_MODULES as [GrantModule, ...GrantModule[]]);

const REVOKE_REASON = "Revoked in Team → Integrations";

const notFound = (c: Context<AppEnv>) => c.json({ error: "Integration not found", code: "NOT_FOUND" }, 404);
const keyNotFound = (c: Context<AppEnv>) => c.json({ error: "API key not found", code: "NOT_FOUND" }, 404);
const idOf = (c: Context<AppEnv>, name: string) => uuid.safeParse(c.req.param(name)?.toLowerCase()).data ?? null;

async function run<T>(c: Context<AppEnv>, operation: () => T | Promise<T>, status: 200 | 201 = 200) {
  try {
    return c.json(await operation() as object, status);
  } catch (error) {
    if (error instanceof IntegrationError || error instanceof TeamError || error instanceof KeyError) {
      return c.json({ error: error.message, code: error.code, ...("details" in error && error.details ? error.details : {}) }, error.status);
    }
    throw error;
  }
}

/** The integration as the key checks see it, or null (unknown, or a person's id). */
const integrationAccount = (id: string) => db.query("SELECT id, role, disabled_at, retired_at FROM users WHERE id = ? AND kind = 'service'").get(id) as { id: string; role: "member" | "viewer"; disabled_at: string | null; retired_at: string | null } | null;
/** A deleted integration kept for attribution never gets a key again (R3). */
function refuseRetired(integration: { retired_at: string | null }) {
  if (integration.retired_at !== null) throw new KeyError(409, "INTEGRATION_RETIRED", RETIRED_MESSAGE);
}
/** One of the integration's keys (any state), or null. */
const keyOf = (integrationId: string, keyId: string) => db.query("SELECT id FROM mcp_api_keys WHERE id = ? AND user_id = ?").get(keyId, integrationId) as { id: string } | null;

/** Routines and the Inbox are a person's, and Team reads are admin-only: an integration's key never holds them. */
function refuseExcludedModules(modules: readonly string[] | undefined) {
  if (modules?.some((module) => (INTEGRATION_EXCLUDED_MODULES as readonly string[]).includes(module))) {
    throw new KeyError(403, "KEY_POLICY", "An integration's key cannot hold Inbox or Team permissions");
  }
}

/** The key list for the integration detail: its keys and the policy summary for its role, minus the modules it can never hold. */
function integrationKeys(id: string) {
  const listed = listApiKeys(id);
  return { ...listed, policy: { ...listed.policy, modules: listed.policy.modules.filter((module) => !INTEGRATION_EXCLUDED_MODULES.includes(module)) } };
}

export function registerIntegrationRoutes(app: Hono<AppEnv>, gates: { read: Gate; write: Gate }) {
  app.get("/api/team/integrations", (c) => gates.read(c) ?? c.json(listIntegrations()));

  app.post("/api/team/integrations", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const body = await parseJson(c.req.raw, createSchema);
    return run(c, () => ({ integration: createIntegration(c.get("user"), body) }), 201);
  });

  app.get("/api/team/integrations/:integrationId", (c) => {
    const refused = gates.read(c);
    if (refused) return refused;
    const id = idOf(c, "integrationId");
    const integration = id ? integrationDetail(id) : null;
    return integration ? c.json({ integration, keys: integrationKeys(integration.id) }) : notFound(c);
  });

  app.patch("/api/team/integrations/:integrationId", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const id = idOf(c, "integrationId");
    if (!id) return notFound(c);
    const body = await parseJson(c.req.raw, patchSchema);
    return run(c, () => updateIntegration(c.get("user"), id, body));
  });

  app.post("/api/team/integrations/:integrationId/block", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const id = idOf(c, "integrationId");
    if (!id) return notFound(c);
    const body = await parseJson(c.req.raw, blockSchema);
    return run(c, () => blockIntegration(c.get("user"), id, body.reason ?? null));
  });

  app.post("/api/team/integrations/:integrationId/unblock", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const id = idOf(c, "integrationId");
    if (!id) return notFound(c);
    await parseJson(c.req.raw, emptySchema);
    return run(c, () => unblockIntegration(c.get("user"), id));
  });

  app.delete("/api/team/integrations/:integrationId", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const id = idOf(c, "integrationId");
    if (!id) return notFound(c);
    return run(c, () => deleteIntegration(c.get("user"), id));
  });

  /** What a chosen-items grant may name: items shared with the integration, never the admin's own. */
  app.get("/api/team/integrations/:integrationId/resources", (c) => {
    const refused = gates.read(c);
    if (refused) return refused;
    const id = idOf(c, "integrationId");
    if (!id || !integrationAccount(id)) return notFound(c);
    const module = moduleSchema.safeParse(c.req.query("module"));
    if (!module.success) return c.json({ error: "Invalid request", details: ["module is not a key module"] }, 400);
    return c.json({ resources: integrationResources(id, module.data) });
  });

  // ------------------------------------------------------------------ the integration's keys

  app.get("/api/team/integrations/:integrationId/keys/:keyId", (c) => {
    const refused = gates.read(c);
    if (refused) return refused;
    const id = idOf(c, "integrationId");
    const keyId = idOf(c, "keyId");
    const key = id && keyId && integrationAccount(id) ? ownApiKey(id, keyId) : null;
    return key ? c.json({ key, events: keyEvents(key.id) }) : keyNotFound(c);
  });

  app.post("/api/team/integrations/:integrationId/keys", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const id = idOf(c, "integrationId");
    const integration = id ? integrationAccount(id) : null;
    if (!integration) return notFound(c);
    const body = await parseJson(c.req.raw, createKeySchema);
    const admin = c.get("user");
    return run(c, async () => {
      refuseRetired(integration);
      if (integration.disabled_at !== null) throw new KeyError(409, "INTEGRATION_BLOCKED", "Unblock this integration before creating a key for it");
      // Integrations are never vault members (Wave 26), so their keys are never vault keys (Wave 27).
      if (body.kind === "vault" || body.allowMcpValueReads || body.protectedAccess) throw new KeyError(403, "INTEGRATION_NOT_ALLOWED", "Integrations cannot hold vault keys");
      const general = grantsForKind("general", body.grants).general;
      refuseExcludedModules(general.map((grant) => grant.module));
      // Every check that needs no password runs first, against the integration (its role, policy, and shares).
      const { grants, days, ipAllowlist } = precheckKeyCreate({ id: integration.id, role: integration.role }, { ...body, grants: general });
      if (createLimited(admin.id)) throw new KeyError(429, "RATE_LIMITED", "Too many API keys created. Try again later.");
      if (!await verifyReauth(admin.id, body, "integration_key", c.get("sessionId"))) {
        audit(admin.id, null, "mcp.key_create_failed", { ownerId: integration.id });
        throw new KeyError(401, "REAUTH_FAILED", "Invalid password or authentication code");
      }
      if (body.recoveryCode) mailTwoFactor(admin.id, "recovery_used");
      checkKeyCount(integration.id, readPolicies());
      const created = createApiKey(integration.id, { name: body.name, description: body.description ?? null, surfaces: body.surfaces, grants, expiresInDays: days, limits: parseLimits(body.limits ? JSON.stringify(body.limits) : null), ipAllowlist }, { actorId: admin.id });
      return { key: { ...ownApiKey(integration.id, created.id), token: created.token } };
    }, 201);
  });

  app.patch("/api/team/integrations/:integrationId/keys/:keyId", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const id = idOf(c, "integrationId");
    const keyId = idOf(c, "keyId");
    if (!id || !keyId || !integrationAccount(id)) return notFound(c);
    const body = await parseJson(c.req.raw, narrowKeySchema);
    const admin = c.get("user");
    return run(c, () => {
      const { changed } = narrowApiKey(id, keyId, body, admin.id);
      return { changed, key: ownApiKey(id, keyId) };
    });
  });

  app.post("/api/team/integrations/:integrationId/keys/:keyId/rotate", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const id = idOf(c, "integrationId");
    const keyId = idOf(c, "keyId");
    const integration = id ? integrationAccount(id) : null;
    if (!integration || !keyId) return notFound(c);
    const body = await parseJson(c.req.raw, rotateKeySchema);
    const admin = c.get("user");
    const changes = { grants: body.grants, surfaces: body.surfaces, ipAllowlist: body.ipAllowlist };
    return run(c, async () => {
      refuseRetired(integration);
      if (integration.disabled_at !== null) throw new KeyError(409, "INTEGRATION_BLOCKED", "Unblock this integration before rotating its keys");
      refuseExcludedModules(body.grants?.map((grant) => grant.module));
      checkRotation(integration.id, keyId, body.graceHours, body.expiresInDays, changes);
      if (createLimited(admin.id)) throw new KeyError(429, "RATE_LIMITED", "Too many API keys created. Try again later.");
      if (!await verifyReauth(admin.id, body, "integration_key_rotate", c.get("sessionId"))) {
        audit(admin.id, null, "key.rotate_failed", { keyId, ownerId: integration.id });
        throw new KeyError(401, "REAUTH_FAILED", "Invalid password or authentication code");
      }
      if (body.recoveryCode) mailTwoFactor(admin.id, "recovery_used");
      const rotated = rotateApiKey(integration.id, keyId, body.graceHours, body.expiresInDays, changes, admin.id);
      return { key: { ...ownApiKey(integration.id, rotated.id), token: rotated.token }, oldKey: ownApiKey(integration.id, keyId) };
    }, 201);
  });

  app.delete("/api/team/integrations/:integrationId/keys/:keyId", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const id = idOf(c, "integrationId");
    const keyId = idOf(c, "keyId");
    if (!id || !keyId || !integrationAccount(id) || !keyOf(id, keyId)) return keyNotFound(c);
    const result = adminRevokeKey(c.get("user").id, keyId, REVOKE_REASON, { notify: false, meta: { integration: true } });
    return result ? c.json({ ok: true }) : keyNotFound(c);
  });
}
