import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { presentItem, readabilityChecker } from "../access/effective";
import { ACTIVITY_CATEGORIES, listAccessActivity } from "../access/events";
import { ACCESS_KINDS, LEVELS, type AccessKind } from "../access/levels";
import { parseJson, uuid } from "../validation";
import { vaultTitleFor } from "../vault/access";
import { accessItems, accessSummary, lowerAccess, MemberAccessError, removeAccess, removeFromGroup, resetAccess } from "./memberAccess";
import { applyTemplateToMember, createTemplate, createTemplateSchema, deleteTemplate, deleteTemplateSchema, listTemplates, patchTemplate, patchTemplateSchema, TemplateError } from "./templates";

/**
 * Central access management routes (Wave 33, access plan §C.6, §C.7, D268, D286, D288):
 *
 * - `GET /api/team/members/:userId/access[?kind&cursor]` (admins): the summary, or one page (200)
 *   of one item kind. Titles redacted per D269; each row carries an opaque handle (T204).
 * - `DELETE` / `PATCH /api/team/members/:userId/access/:handle`: remove or lower (reduction only).
 * - `DELETE /api/team/members/:userId/groups/:groupId`, `POST …/access/reset`, and
 *   `POST …/templates/:templateId/apply`.
 * - `GET/POST /api/team/templates`, `PATCH/DELETE /api/team/templates/:templateId`.
 * - `GET /api/team/activity`: access events with filters.
 * - `GET /api/me/access[?kind&cursor]`: the same page for yourself, read-only; every role but guest.
 *
 * Admin routes answer guests 404 and everyone else 403 ADMIN_ONLY, and writes share the Team write
 * rate limit (T218). They are registered before `/api/team/:userId`.
 */

type Gate = (c: Context<AppEnv>) => Response | null;

const kindSchema = z.enum(ACCESS_KINDS as unknown as [AccessKind, ...AccessKind[]]);
const itemsQuery = z.object({ kind: kindSchema.optional(), cursor: z.string().min(1).max(600).optional() });
const lowerSchema = z.object({ level: z.enum(LEVELS) }).strict();
const emptySchema = z.object({}).strict();
const activityQuery = z.object({
  user: z.string().uuid().transform((value) => value.toLowerCase()).optional(),
  group: z.string().uuid().transform((value) => value.toLowerCase()).optional(),
  key: z.string().uuid().transform((value) => value.toLowerCase()).optional(),
  action: z.enum(ACTIVITY_CATEGORIES).optional(),
  cursor: z.string().max(200).optional()
});

const notFound = (c: Context<AppEnv>, message = "Not found") => c.json({ error: message, code: "NOT_FOUND" }, 404);
const invalid = (c: Context<AppEnv>, message = "Invalid request") => c.json({ error: message, code: "INVALID" }, 400);

function respond(c: Context<AppEnv>, operation: () => unknown, status: 200 | 201 = 200) {
  try {
    return c.json(operation() as object, status);
  } catch (error) {
    if (error instanceof MemberAccessError || error instanceof TemplateError) return c.json({ error: error.message, code: error.code, ...("details" in error ? error.details : {}) }, error.status);
    throw error;
  }
}

/** The member's access: the summary without `kind`, one page of that kind with it. */
function readAccess(c: Context<AppEnv>, viewerId: string, userId: string, withHandles: boolean) {
  const query = itemsQuery.safeParse({ kind: c.req.query("kind") || undefined, cursor: c.req.query("cursor") || undefined });
  if (!query.success) return invalid(c);
  c.header("Cache-Control", "no-store");
  if (!query.data.kind) return respond(c, () => accessSummary(viewerId, userId));
  const kind = query.data.kind;
  return respond(c, () => accessItems(viewerId, userId, kind, query.data.cursor, withHandles));
}

export function registerCentralAccessRoutes(app: Hono<AppEnv>, gates: { read: Gate; write: Gate }) {
  const memberId = (c: Context<AppEnv>) => uuid.safeParse(c.req.param("userId")?.toLowerCase()).data ?? null;

  app.get("/api/me/access", (c) => {
    const user = c.get("user");
    // Guests have no Team and no access page (§K: the own access page is for every role but guest).
    if (user.role === "guest") return notFound(c);
    return readAccess(c, user.id, user.id, false);
  });

  app.get("/api/team/members/:userId/access", (c) => {
    const refused = gates.read(c);
    if (refused) return refused;
    const id = memberId(c);
    if (!id) return notFound(c, "Team member not found");
    return readAccess(c, c.get("user").id, id, true);
  });

  app.delete("/api/team/members/:userId/access/:handle", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const id = memberId(c);
    if (!id) return notFound(c, "Team member not found");
    await parseJson(c.req.raw, emptySchema);
    return respond(c, () => removeAccess(c.get("user").id, id, c.req.param("handle") ?? ""));
  });

  app.patch("/api/team/members/:userId/access/:handle", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const id = memberId(c);
    if (!id) return notFound(c, "Team member not found");
    const body = await parseJson(c.req.raw, lowerSchema);
    return respond(c, () => lowerAccess(c.get("user").id, id, c.req.param("handle") ?? "", body.level));
  });

  app.post("/api/team/members/:userId/access/reset", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const id = memberId(c);
    if (!id) return notFound(c, "Team member not found");
    await parseJson(c.req.raw, emptySchema);
    return respond(c, () => resetAccess(c.get("user").id, id));
  });

  app.delete("/api/team/members/:userId/groups/:groupId", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const id = memberId(c);
    const groupId = uuid.safeParse(c.req.param("groupId")?.toLowerCase()).data;
    if (!id || !groupId) return notFound(c);
    await parseJson(c.req.raw, emptySchema);
    return respond(c, () => removeFromGroup(c.get("user").id, id, groupId));
  });

  app.post("/api/team/members/:userId/templates/:templateId/apply", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const id = memberId(c);
    const templateId = uuid.safeParse(c.req.param("templateId")?.toLowerCase()).data;
    if (!id || !templateId) return notFound(c);
    await parseJson(c.req.raw, emptySchema);
    return respond(c, () => applyTemplateToMember(c.get("user").id, id, templateId));
  });

  // Templates (D286).
  app.get("/api/team/templates", (c) => gates.read(c) ?? c.json(listTemplates()));

  app.post("/api/team/templates", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const body = await parseJson(c.req.raw, createTemplateSchema);
    return respond(c, () => createTemplate(c.get("user").id, body), 201);
  });

  app.patch("/api/team/templates/:templateId", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const templateId = uuid.safeParse(c.req.param("templateId")?.toLowerCase()).data;
    if (!templateId) return notFound(c, "Template not found");
    const body = await parseJson(c.req.raw, patchTemplateSchema);
    return respond(c, () => patchTemplate(c.get("user").id, templateId, body));
  });

  app.delete("/api/team/templates/:templateId", async (c) => {
    const refused = gates.write(c);
    if (refused) return refused;
    const templateId = uuid.safeParse(c.req.param("templateId")?.toLowerCase()).data;
    if (!templateId) return notFound(c, "Template not found");
    const body = await parseJson(c.req.raw, deleteTemplateSchema);
    return respond(c, () => deleteTemplate(c.get("user").id, templateId, body.revision));
  });

  // Access activity (D288): ids and counts; items redacted for the viewing admin (D269).
  app.get("/api/team/activity", (c) => {
    const refused = gates.read(c);
    if (refused) return refused;
    const query = activityQuery.safeParse({
      user: c.req.query("user") || undefined, group: c.req.query("group") || undefined, key: c.req.query("key") || undefined,
      action: c.req.query("action") || undefined, cursor: c.req.query("cursor") || undefined
    });
    if (!query.success) return invalid(c);
    const viewerId = c.get("user").id;
    const readable = readabilityChecker(viewerId);
    const present = (kind: string, id: string) => {
      if ((ACCESS_KINDS as readonly string[]).includes(kind)) return presentItem(kind as AccessKind, id, viewerId, readable);
      // Vaults (Wave 26): the name only for an admin who can open the vault themselves (D73, D269).
      const vault = kind === "vault" ? vaultTitleFor(viewerId, id) : null;
      return vault ? { kind, title: vault, titleHidden: false } : { kind, title: kind === "vault" ? "A vault" : "An item", titleHidden: true };
    };
    const { user, group, key, action, cursor } = query.data;
    c.header("Cache-Control", "no-store");
    return c.json(listAccessActivity({ userId: user, groupId: group, keyId: key, category: action, cursor }, present));
  });
}
