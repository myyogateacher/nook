import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { config, isOriginAllowed } from "../config";
import { email, parseJson, uuid } from "../validation";
import { createInvite, emailInvite, INVITE_MAX_DAYS, INVITE_NOTE_MAX, INVITE_ROLES, InviteError, listInvites, resendInviteEmail, revokeInvite } from "./invites";
import { can, ROLES } from "./roles";
import { policiesState, policyImpact, PolicyError, previewPoliciesSchema, putPoliciesSchema, writePolicies } from "./policies";
import { BLOCK_REASON_MAX, blockUser, listTeam, revokeSessions, setRole, TeamError, teamMember, unblockUser } from "./service";

/**
 * `/api/team` (docs/plan/research/2026-09-26-team-module.md §6.4). Session auth, CSRF, Origin, and
 * the TOTP gate come from the global `/api/*` middleware (T82). Guests get 404 on every route
 * (404, never 403, for existence); members and viewers read names and roles and get 403 on writes.
 * Admin writes need only the signed-in admin session plus CSRF: re-authentication was removed by
 * operator decision 2026-09-27 (T77, T82).
 */

export const roleChangeSchema = z.object({ role: z.enum(ROLES), expectedRole: z.enum(ROLES) }).strict();
export const blockSchema = z.object({ reason: z.string().max(BLOCK_REASON_MAX).optional() }).strict();
const emptySchema = z.object({}).strict();
/** `POST /api/team/invites` (D161–D164). The role can never be admin (D163, T138). */
export const createInviteSchema = z.object({
  role: z.enum(INVITE_ROLES),
  email: email.nullish(),
  expiresInDays: z.number().int().min(1).max(INVITE_MAX_DAYS).optional(),
  note: z.string().max(INVITE_NOTE_MAX).nullish(),
  /** Also email the link to the bound address (only there, never elsewhere). */
  sendEmail: z.boolean().optional()
}).strict();

/** 30 Team writes a minute per admin (§5.5). In memory, like the auth limits. */
const WRITE_LIMIT = 30;
const writeWindows = new Map<string, { count: number; resetAt: number }>();
function writeLimited(userId: string) {
  const time = Date.now();
  if (writeWindows.size > 500) for (const [key, entry] of writeWindows) if (entry.resetAt <= time) writeWindows.delete(key);
  const entry = writeWindows.get(userId);
  if (!entry || entry.resetAt <= time) {
    writeWindows.set(userId, { count: 1, resetAt: time + 60_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > WRITE_LIMIT;
}

/** Test hook. */
export function resetTeamRateLimits() {
  writeWindows.clear();
}

const notFound = (c: Context<AppEnv>) => c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
const teamError = (c: Context<AppEnv>, error: TeamError) => c.json({ error: error.message, code: error.code, ...error.details }, error.status);

/** The target id from the path, or null when it is not a UUID (answered as 404). */
const targetId = (c: Context<AppEnv>) => uuid.safeParse(c.req.param("userId")?.toLowerCase()).data ?? null;

/**
 * Common gate for writes: guests see nothing, non-admins are refused, and the rate limit applies.
 * Returns a response to send, or null to continue.
 */
function writeGate(c: Context<AppEnv>) {
  const user = c.get("user");
  if (!can(user.role, "team.read")) return notFound(c);
  if (!can(user.role, "team.manage")) return c.json({ error: "Only admins can manage the team", code: "ADMIN_ONLY" }, 403);
  if (writeLimited(user.id)) return c.json({ error: "Too many team changes. Try again soon.", code: "RATE_LIMITED" }, 429);
  return null;
}

async function run<T>(c: Context<AppEnv>, operation: () => T | Promise<T>, status: 200 | 201 = 200) {
  try {
    return c.json(await operation() as object, status);
  } catch (error) {
    if (error instanceof TeamError) return teamError(c, error);
    if (error instanceof InviteError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
}

/** The origin the admin is using, for the invite link (any configured origin), else APP_ORIGIN. */
function linkOrigin(c: Context<AppEnv>) {
  const origin = c.req.header("Origin");
  return origin && isOriginAllowed(origin) ? origin : config.appOrigin;
}

/**
 * Invites (docs/plan/WAVES_18-20_SMALL.md §1.4). Registered before `/api/team/:userId` so
 * "invites" is never read as a user id. Admins only: guests 404, members and viewers 403.
 */
function registerInviteRoutes(app: Hono<AppEnv>) {
  app.get("/api/team/invites", (c) => {
    const user = c.get("user");
    if (!can(user.role, "team.read")) return notFound(c);
    if (!can(user.role, "team.manage")) return c.json({ error: "Only admins can manage invites", code: "ADMIN_ONLY" }, 403);
    return c.json(listInvites(user));
  });

  app.post("/api/team/invites", async (c) => {
    const refused = writeGate(c);
    if (refused) return refused;
    const body = await parseJson(c.req.raw, createInviteSchema);
    const actor = c.get("user");
    return run(c, async () => {
      const { row, ...created } = createInvite(actor, body, linkOrigin(c));
      // The invite stands even when the email cannot go out; the outcome says why.
      return body.sendEmail ? { ...created, email: await emailInvite(actor, row, created.url) } : created;
    }, 201);
  });

  app.post("/api/team/invites/:inviteId/email", async (c) => {
    const refused = writeGate(c);
    if (refused) return refused;
    const id = uuid.safeParse(c.req.param("inviteId")?.toLowerCase()).data;
    if (!id) return notFound(c);
    await parseJson(c.req.raw, emptySchema);
    const actor = c.get("user");
    return run(c, () => resendInviteEmail(actor, id, linkOrigin(c)));
  });

  app.post("/api/team/invites/:inviteId/revoke", async (c) => {
    const refused = writeGate(c);
    if (refused) return refused;
    const id = uuid.safeParse(c.req.param("inviteId")?.toLowerCase()).data;
    if (!id) return notFound(c);
    await parseJson(c.req.raw, emptySchema);
    return run(c, () => revokeInvite(c.get("user"), id));
  });
}

/**
 * Team → Policies (Wave 31, access plan §C.6, §C.7): admins only (guests 404,
 * everyone else 403 ADMIN_ONLY). The inventory is metadata only (T215): prefix, name, owner, grant
 * summary, expiry, last use, state; never a hash or token, never an item title (T204). Registered
 * before `/api/team/:userId` so "keys" and "policies" are never read as user ids.
 */
function registerAccessRoutes(app: Hono<AppEnv>) {
  const readGate = (c: Context<AppEnv>) => {
    const user = c.get("user");
    if (!can(user.role, "team.read")) return notFound(c);
    if (!can(user.role, "team.manage")) return c.json({ error: "Only admins can manage keys and policies", code: "ADMIN_ONLY" }, 403);
    return null;
  };
  const accessError = (c: Context<AppEnv>, error: unknown) => {
    if (error instanceof PolicyError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  };

  app.get("/api/team/policies", (c) => {
    const refused = readGate(c);
    if (refused) return refused;
    const state = policiesState();
    return c.json({ ...state, impact: policyImpact(state.policies) });
  });

  app.post("/api/team/policies/preview", async (c) => {
    const refused = readGate(c);
    if (refused) return refused;
    const body = await parseJson(c.req.raw, previewPoliciesSchema);
    return c.json({ impact: policyImpact(body.policies) });
  });

  app.put("/api/team/policies", async (c) => {
    const refused = writeGate(c);
    if (refused) return refused;
    const body = await parseJson(c.req.raw, putPoliciesSchema);
    try {
      const { changed } = writePolicies(c.get("user").id, body.policies, body.revision);
      const state = policiesState();
      return c.json({ ...state, changed, impact: policyImpact(state.policies) });
    } catch (error) {
      return accessError(c, error);
    }
  });
}

export function registerTeamRoutes(app: Hono<AppEnv>) {
  registerInviteRoutes(app);
  registerAccessRoutes(app);

  app.get("/api/team", (c) => {
    const user = c.get("user");
    if (!can(user.role, "team.read")) return notFound(c);
    return c.json(listTeam(user));
  });

  app.get("/api/team/:userId", (c) => {
    const user = c.get("user");
    const id = targetId(c);
    if (!can(user.role, "team.read") || !id) return notFound(c);
    const member = teamMember(user, id);
    return member ? c.json({ member }) : notFound(c);
  });

  app.put("/api/team/:userId/role", async (c) => {
    const refused = writeGate(c);
    if (refused) return refused;
    const id = targetId(c);
    if (!id) return notFound(c);
    const body = await parseJson(c.req.raw, roleChangeSchema);
    const actor = c.get("user");
    return run(c, () => {
      const result = setRole(actor, id, { role: body.role, expectedRole: body.expectedRole }, { via: "web" });
      return { ...result, member: teamMember(actor, id) };
    });
  });

  app.post("/api/team/:userId/block", async (c) => {
    const refused = writeGate(c);
    if (refused) return refused;
    const id = targetId(c);
    if (!id) return notFound(c);
    const body = await parseJson(c.req.raw, blockSchema);
    const actor = c.get("user");
    return run(c, () => {
      const result = blockUser(actor, id, body.reason ?? null, { via: "web" });
      return { ...result, member: teamMember(actor, id) };
    });
  });

  app.post("/api/team/:userId/unblock", async (c) => {
    const refused = writeGate(c);
    if (refused) return refused;
    const id = targetId(c);
    if (!id) return notFound(c);
    await parseJson(c.req.raw, emptySchema);
    const actor = c.get("user");
    return run(c, () => {
      unblockUser(actor, id, { via: "web" });
      return { ok: true, member: teamMember(actor, id) };
    });
  });

  app.post("/api/team/:userId/sessions/revoke", async (c) => {
    const refused = writeGate(c);
    if (refused) return refused;
    const id = targetId(c);
    if (!id) return notFound(c);
    await parseJson(c.req.raw, emptySchema);
    const actor = c.get("user");
    return run(c, () => ({ ...revokeSessions(actor, id, { via: "web" }), member: teamMember(actor, id) }));
  });
}
