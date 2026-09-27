import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson, uuid } from "../validation";
import { can, ROLES } from "./roles";
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

async function run<T>(c: Context<AppEnv>, operation: () => T | Promise<T>) {
  try {
    return c.json(await operation() as object);
  } catch (error) {
    if (error instanceof TeamError) return teamError(c, error);
    throw error;
  }
}

export function registerTeamRoutes(app: Hono<AppEnv>) {
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
