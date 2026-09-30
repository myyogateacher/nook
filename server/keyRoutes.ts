import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./auth";
import { audit } from "./db";
import {
  checkCreateAllowlist, createApiKey, createKeySchema, checkCreatePolicy, checkKeyCount, checkRotation, KeyError, listApiKeys, narrowApiKey, narrowKeySchema, ownApiKey, parseLimits,
  revokeOwnKey, rotateApiKey, rotateKeySchema, validateGrants, type GrantInput
} from "./apiKeys";
import { keyEvents } from "./access/events";
import { grantsForScopes } from "./keyGrants";
import type { McpScope } from "./mcpScopes";
import { BINNED_WINDOWS, binnedCountsByKey, isBinnedWindow, listKeyBinned, restoreKeyBinned } from "./mcpBinned";
import { pendingProposalsByKey } from "./inbox/service";
import { mailApiKeyCreated, mailTwoFactor } from "./mail/triggers";
import { verifyReauth } from "./reauth";
import { readPolicies } from "./team/policies";
import type { Role } from "./team/roles";
import { parseJson, uuid } from "./validation";

/**
 * `/api/keys` (docs/plan/research/2026-09-28-access-management-api-keys.md §C.7, D276–D278): the
 * caller's own Nook keys. Session auth, CSRF, Origin, TOTP setup, and the role write gate come from
 * the global `/api/*` middleware; viewers keep read-only keys (the allowlist in writeGate.ts, the
 * scopes by role here). Create and rotate re-authenticate (password plus a fresh code); narrowing
 * and revoking do not (D278). Every change is audited and lands in `access_events`. Keys never
 * reach these routes: they need a session (D265).
 */

/** Creations and rotations per user per hour (T205: guessing resource ids through key creation). */
const CREATE_LIMIT = 20;
const createWindows = new Map<string, { count: number; resetAt: number }>();

function createLimited(userId: string) {
  const time = Date.now();
  if (createWindows.size > 500) for (const [key, entry] of createWindows) if (entry.resetAt <= time) createWindows.delete(key);
  const entry = createWindows.get(userId);
  if (!entry || entry.resetAt <= time) {
    createWindows.set(userId, { count: 1, resetAt: time + 3_600_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > CREATE_LIMIT;
}

/** Test hook. */
export function resetKeyRouteLimits() {
  createWindows.clear();
}

const keyError = (c: Context<AppEnv>, error: KeyError) => c.json({ error: error.message, code: error.code, ...error.details }, error.status);
const notFound = (c: Context<AppEnv>) => c.json({ error: "API key not found", code: "NOT_FOUND" }, 404);
const keyId = (c: Context<AppEnv>) => uuid.safeParse(c.req.param("id")?.toLowerCase()).data ?? null;

async function run<T>(c: Context<AppEnv>, operation: () => T | Promise<T>, status: 200 | 201 = 200) {
  try {
    return c.json(await operation() as object, status);
  } catch (error) {
    if (error instanceof KeyError) return keyError(c, error);
    throw error;
  }
}

/**
 * The checks every key creation runs before the password (no code is consumed on a refusal):
 * role, policy (surfaces, expiry cap, modules), grants (scopes by role, access to chosen items),
 * then the count. Shared with the `/api/mcp/keys` alias. Returns the validated grants and days.
 */
export function precheckKeyCreate(user: { id: string; role: Role }, input: { surfaces: "mcp" | "rest" | "both"; expiresInDays?: number | null; grants: readonly GrantInput[]; ipAllowlist?: readonly string[] }) {
  const policies = readPolicies();
  const days = checkCreatePolicy(user.id, user.role, input, policies);
  const grants = validateGrants(user.id, user.role, input.grants, policies);
  // Wave 34 (D284): only where the server can see client addresses (TRUSTED_PROXY_HOPS ≥ 1).
  const ipAllowlist = checkCreateAllowlist(input.ipAllowlist);
  checkKeyCount(user.id, policies);
  return { grants, days, ipAllowlist };
}

/** The alias's scopes as grant inputs over "all" (the pre-grants `/api/mcp/keys` body). */
export const scopesAsGrantInputs = (scopes: readonly McpScope[]): GrantInput[] =>
  grantsForScopes(scopes).map((grant) => ({ module: grant.module, permission: grant.permission, resourceIds: null }));

/** The alias `POST /api/mcp/keys` runs the same policy checks; null when the key may be created. */
export function aliasKeyRefusal(user: { id: string; role: Role }, scopes: readonly McpScope[]): KeyError | null {
  try {
    precheckKeyCreate(user, { surfaces: "mcp", grants: scopesAsGrantInputs(scopes) });
    return null;
  } catch (error) {
    if (error instanceof KeyError) return error;
    throw error;
  }
}

/** What a rotation changes besides the secret (review Q2). */
const rotationChanges = (body: z.infer<typeof rotateKeySchema>) => ({ grants: body.grants, surfaces: body.surfaces, ipAllowlist: body.ipAllowlist });

const restoreBinnedSchema = z.object({ window: z.enum(["1h", "24h", "7d"]) }).strict();

export function registerKeyRoutes(app: Hono<AppEnv>) {
  app.get("/api/keys", (c) => {
    const userId = c.get("user").id;
    const listed = listApiKeys(userId);
    // What each key moved to the Bin in the last 24 hours, for the key row's Review line (D175).
    const binned = binnedCountsByKey(userId, new Date(Date.now() - BINNED_WINDOWS["24h"]).toISOString());
    // Its pending Inbox suggestions, which a revoke withdraws (the revoke confirm says so only then).
    const pending = pendingProposalsByKey(userId);
    return c.json({ ...listed, keys: listed.keys.map((key) => ({ ...key, binnedToday: binned.get(key.id) ?? 0, pendingProposals: pending.get(key.id) ?? 0 })) });
  });

  app.get("/api/keys/:id", (c) => {
    const id = keyId(c);
    const key = id ? ownApiKey(c.get("user").id, id) : null;
    return key ? c.json({ key, events: keyEvents(key.id) }) : notFound(c);
  });

  app.post("/api/keys", async (c) => {
    const body = await parseJson(c.req.raw, createKeySchema);
    const user = c.get("user");
    try {
      const { grants, days, ipAllowlist } = precheckKeyCreate(user, body);
      if (createLimited(user.id)) return c.json({ error: "Too many API keys created. Try again later.", code: "RATE_LIMITED" }, 429);
      if (!await verifyReauth(user.id, body, "api_key", c.get("sessionId"))) {
        audit(user.id, null, "mcp.key_create_failed");
        return c.json({ error: "Invalid password or authentication code", code: "REAUTH_FAILED" }, 401);
      }
      if (body.recoveryCode) mailTwoFactor(user.id, "recovery_used");
      // Counted again after the password check, which awaits: two parallel requests cannot both pass.
      checkKeyCount(user.id, readPolicies());
      const created = createApiKey(user.id, { name: body.name, description: body.description ?? null, surfaces: body.surfaces, grants, expiresInDays: days, limits: parseLimits(body.limits ? JSON.stringify(body.limits) : null), ipAllowlist });
      // Security mail (outbound email #5): the key's name and permissions, read at send time.
      mailApiKeyCreated(user.id, created.id);
      return c.json({ key: { ...ownApiKey(user.id, created.id), token: created.token } }, 201);
    } catch (error) {
      if (error instanceof KeyError) return keyError(c, error);
      throw error;
    }
  });

  app.patch("/api/keys/:id", async (c) => {
    const id = keyId(c);
    if (!id) return notFound(c);
    const body = await parseJson(c.req.raw, narrowKeySchema);
    const userId = c.get("user").id;
    return run(c, () => {
      const { changed } = narrowApiKey(userId, id, body);
      return { changed, key: ownApiKey(userId, id) };
    });
  });

  app.post("/api/keys/:id/rotate", async (c) => {
    const id = keyId(c);
    if (!id) return notFound(c);
    const body = await parseJson(c.req.raw, rotateKeySchema);
    const user = c.get("user");
    // Refusals that need no password come first, so no code is consumed: missing key, already
    // rotating, and the creation checks (role, policy, count; review L1).
    try {
      checkRotation(user.id, id, body.graceHours, body.expiresInDays, rotationChanges(body));
    } catch (error) {
      if (error instanceof KeyError) return keyError(c, error);
      throw error;
    }
    if (createLimited(user.id)) return c.json({ error: "Too many API keys created. Try again later.", code: "RATE_LIMITED" }, 429);
    if (!await verifyReauth(user.id, body, "api_key_rotate", c.get("sessionId"))) {
      audit(user.id, null, "key.rotate_failed", { keyId: id });
      return c.json({ error: "Invalid password or authentication code", code: "REAUTH_FAILED" }, 401);
    }
    if (body.recoveryCode) mailTwoFactor(user.id, "recovery_used");
    return run(c, () => {
      const rotated = rotateApiKey(user.id, id, body.graceHours, body.expiresInDays, rotationChanges(body));
      // A rotation makes a new secret, so it gets the same security mail as a new key.
      mailApiKeyCreated(user.id, rotated.id);
      return { key: { ...ownApiKey(user.id, rotated.id), token: rotated.token }, oldKey: ownApiKey(user.id, id) };
    }, 201);
  });

  app.delete("/api/keys/:id", (c) => {
    const id = keyId(c);
    if (!id || !revokeOwnKey(c.get("user").id, id)) return notFound(c);
    return c.json({ ok: true });
  });

  // Review / Restore all for one key (Wave 19, D175), also under /api/keys: the owner's only.
  app.get("/api/keys/:id/binned", (c) => {
    const id = keyId(c);
    const window = c.req.query("window") ?? "24h";
    if (!isBinnedWindow(window)) return c.json({ error: "Invalid request", details: ["window must be 1h, 24h, or 7d"] }, 400);
    const listed = id ? listKeyBinned(c.get("user").id, id, window) : null;
    return listed ? c.json(listed) : notFound(c);
  });

  app.post("/api/keys/:id/restore-binned", async (c) => {
    const id = keyId(c);
    const body = await parseJson(c.req.raw, restoreBinnedSchema);
    const result = id ? await restoreKeyBinned(c.get("user").id, id, body.window) : null;
    return result ? c.json(result) : notFound(c);
  });
}
