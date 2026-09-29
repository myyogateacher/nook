import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { validTimeZone } from "../today/registry";
import { parseJson, uuid } from "../validation";
import { TASK_QUERY_LIMITS } from "../../shared/taskQuery";
import { QUERY_GROUPS, QUERY_PAGE, QUERY_SORTS, queryCards, withBoardLevels } from "./query";
import { TaskError } from "./service";
import { withAssigneeAvatars } from "../avatars";
import {
  createView,
  deleteView,
  duplicateView,
  getView,
  getViewSharing,
  listViews,
  patchView,
  putViewSharing,
  VIEW_FIELDS,
  VIEW_GROUPS,
  VIEW_LAYOUTS,
  VIEW_LIMITS,
  viewCards
} from "./views";

/**
 * `POST /api/tasks/query` (research 2026-09-26 §10.4, D144): a read sent as
 * POST, like the Collections query. Rate limited per user, 30 per 10 s (T117),
 * shared with running a saved view (`GET /api/tasks/views/:v/cards`).
 *
 * Saved views (`/api/tasks/views`, D140): CRUD, sharing, and duplicate. Only
 * the owner changes a view; a view always runs as the viewer (T115).
 */

export const TASK_QUERY_RATE_LIMIT = 30;
export const TASK_QUERY_RATE_WINDOW_MS = 10_000;
const queryRequests = new Map<string, number[]>();

/** Sliding window per user, in memory (one app instance per data directory), as for search. Returns Retry-After seconds or 0. */
export function taskQueryRateLimited(userId: string, time = Date.now()) {
  const windowStart = time - TASK_QUERY_RATE_WINDOW_MS;
  if (queryRequests.size > 1000) {
    for (const [key, stamps] of queryRequests) if ((stamps[stamps.length - 1] ?? 0) <= windowStart) queryRequests.delete(key);
  }
  const stamps = (queryRequests.get(userId) ?? []).filter((stamp) => stamp > windowStart);
  if (stamps.length >= TASK_QUERY_RATE_LIMIT) {
    queryRequests.set(userId, stamps);
    return Math.max(1, Math.ceil((stamps[0]! + TASK_QUERY_RATE_WINDOW_MS - time) / 1000));
  }
  stamps.push(time);
  queryRequests.set(userId, stamps);
  return 0;
}

/** Test hook: forget the query rate-limit history. */
export function resetTaskQueryRateLimit() {
  queryRequests.clear();
}

export const tzSchema = z.string().max(64).refine((value) => validTimeZone(value) !== null, "tz must be an IANA time zone");
export const cursorSchema = z.string().min(1).max(1024);
export const pageLimitSchema = z.number().int().min(1).max(QUERY_PAGE.max);

export const taskQuerySchema = z.object({
  q: z.string().max(TASK_QUERY_LIMITS.length).default(""),
  sort: z.enum(QUERY_SORTS).optional(),
  group: z.enum(QUERY_GROUPS).optional(),
  cursor: cursorSchema.optional(),
  limit: pageLimitSchema.optional(),
  tz: tzSchema.default("UTC")
}).strict();

/** 429 with Retry-After when the caller is over the query limit, else null. */
export function rateLimitedResponse(c: Context<AppEnv>) {
  const retryAfter = taskQueryRateLimited(c.get("user").id);
  if (!retryAfter) return null;
  c.header("Retry-After", String(retryAfter));
  return c.json({ error: "Too many queries. Try again in a moment.", code: "RATE_LIMITED" }, 429);
}

// C0/C1 controls and bidi overrides never belong in a view name (as for boards).
const controlCharacters = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;
const viewName = z.string().trim().min(1).max(80).refine((value) => !controlCharacters.test(value), "Names cannot contain control characters");
export const viewDisplaySchema = z.object({
  layout: z.enum(VIEW_LAYOUTS).optional(),
  group: z.enum(VIEW_GROUPS).optional(),
  sort: z.enum(QUERY_SORTS).optional(),
  fields: z.array(z.enum(VIEW_FIELDS)).max(VIEW_FIELDS.length).refine((values) => new Set(values).size === values.length, "Fields must be unique").optional()
}).strict();
export const viewCreateSchema = z.object({
  name: viewName,
  query: z.string().max(TASK_QUERY_LIMITS.length),
  display: viewDisplaySchema.optional()
}).strict();
export const viewPatchSchema = z.object({
  name: viewName.optional(),
  query: z.string().max(TASK_QUERY_LIMITS.length).optional(),
  display: viewDisplaySchema.optional(),
  afterViewId: uuid.nullable().optional(),
  revision: z.number().int().positive()
}).strict().refine((value) => value.name !== undefined || value.query !== undefined || value.display !== undefined || value.afterViewId !== undefined,
  "Provide a name, query, display, or afterViewId");
export const viewSharingSchema = z.object({
  visibility: z.enum(["private", "selected", "all_users"]),
  userIds: z.array(uuid).max(VIEW_LIMITS.members).default([])
}).strict();

const invalid = (detail: string) => ({ error: "Invalid request", details: [detail] });

/** Runs a service call and maps TaskError to its JSON response. */
async function respond(c: Context<AppEnv>, operation: () => unknown, status: 200 | 201 = 200) {
  try {
    return c.json(await operation() as Record<string, unknown>, status);
  } catch (error) {
    if (error instanceof TaskError) return c.json(error.body(), error.status);
    throw error;
  }
}

export function registerTaskQueryRoutes(app: Hono<AppEnv>) {
  const viewId = (c: Context<AppEnv>) => uuid.parse(c.req.param("viewId"));

  app.get("/api/tasks/views", (c) => c.json(listViews(c.get("user").id)));

  app.post("/api/tasks/views", async (c) => {
    const body = await parseJson(c.req.raw, viewCreateSchema);
    return respond(c, () => createView(c.get("user").id, body), 201);
  });

  app.get("/api/tasks/views/:viewId", (c) => {
    const id = viewId(c);
    return respond(c, () => getView(c.get("user").id, id));
  });

  app.patch("/api/tasks/views/:viewId", async (c) => {
    const id = viewId(c);
    const body = await parseJson(c.req.raw, viewPatchSchema);
    return respond(c, () => patchView(c.get("user").id, id, body));
  });

  app.delete("/api/tasks/views/:viewId", (c) => {
    const id = viewId(c);
    return respond(c, () => deleteView(c.get("user").id, id));
  });

  app.get("/api/tasks/views/:viewId/sharing", (c) => {
    const id = viewId(c);
    return respond(c, () => getViewSharing(c.get("user").id, id));
  });

  app.put("/api/tasks/views/:viewId/sharing", async (c) => {
    const id = viewId(c);
    const body = await parseJson(c.req.raw, viewSharingSchema);
    return respond(c, () => putViewSharing(c.get("user").id, id, body.visibility, body.userIds));
  });

  app.post("/api/tasks/views/:viewId/duplicate", (c) => {
    const id = viewId(c);
    return respond(c, () => duplicateView(c.get("user").id, id), 201);
  });

  app.get("/api/tasks/views/:viewId/cards", async (c) => {
    const id = viewId(c);
    const limited = rateLimitedResponse(c);
    if (limited) return limited;
    const cursor = c.req.query("cursor");
    const limitParam = c.req.query("limit");
    const tz = c.req.query("tz") ?? "UTC";
    if (cursor !== undefined && !cursorSchema.safeParse(cursor).success) return c.json(invalid("cursor is invalid"), 400);
    if (limitParam !== undefined && (!/^\d+$/.test(limitParam) || !pageLimitSchema.safeParse(Number(limitParam)).success)) {
      return c.json(invalid(`limit must be an integer from 1 to ${QUERY_PAGE.max}`), 400);
    }
    if (!tzSchema.safeParse(tz).success) return c.json(invalid("tz must be an IANA time zone"), 400);
    return respond(c, () => withAssigneeAvatars(withBoardLevels(c.get("user").id, viewCards(c.get("user").id, id, { cursor, limit: limitParam === undefined ? undefined : Number(limitParam), tz }))));
  });

  app.post("/api/tasks/query", async (c) => {
    const limited = rateLimitedResponse(c);
    if (limited) return limited;
    const body = await parseJson(c.req.raw, taskQuerySchema);
    try {
      return c.json(withAssigneeAvatars(withBoardLevels(c.get("user").id, queryCards(c.get("user").id, body))));
    } catch (error) {
      if (error instanceof TaskError) return c.json(error.body(), error.status);
      throw error;
    }
  });
}
