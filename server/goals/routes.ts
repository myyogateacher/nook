import type { Context } from "hono";
import * as z from "zod/v4";
import type { AppEnv } from "../auth";
import type { ModuleRouter } from "../workspaceRegistry";
import { parseJson } from "../validation";
import { LinkError, linksOf } from "../links/service";
import {
  addKeyResult, checkIn, checkinTargets, closeGoal, closePeriod, createGoal, createPeriod, deleteGoal, deleteKeyResult, deletePeriod, ensureSweep, getGoal, goalHistory, goalsOfItem,
  GoalError, goalsOfCards, krHistory, MAX_BADGE_CARDS, listCheckins, listGoals, listPeriods, previewSource, progressSources, reopenGoal, requireGoal, updateGoal, updateKeyResult, updatePeriod
} from "./service";
import { checkinSchema, closeSchema, goalInputSchema, goalPatchSchema, krInputSchema, krPatchSchema, periodPatchSchema, periodSchema, sourceSchema } from "./schemas";
import { isWorkKind } from "../../shared/workRefs";
import { csvResponse } from "../csvExport";
import { goalsCsv } from "./export";

/**
 * Goals HTTP (lane GOALS, §D.3): JSON under /api, errors `{ error, code }`; unreadable is NOT_FOUND (T90).
 * `:id` accepts a goal's UUID or short id.
 */

function fail(c: Context<AppEnv>, error: unknown) {
  if (error instanceof GoalError) return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
  if (error instanceof LinkError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof z.ZodError) return c.json({ error: "Invalid request", code: "INVALID", details: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, 400);
  throw error;
}

const handle = (run: (c: Context<AppEnv>, userId: string) => unknown) => async (c: Context<AppEnv>) => {
  try {
    const result = await run(c, c.get("user").id);
    if (result instanceof Response) return result;
    return c.json(result as object);
  } catch (error) {
    return fail(c, error);
  }
};

const created = (c: Context<AppEnv>, body: object) => c.json(body, 201);
const param = (c: Context<AppEnv>, name: string) => (c.req.param(name) ?? "").slice(0, 64);

export function registerGoalRoutes(router: ModuleRouter) {
  // Static paths first (the dispatcher matches in registration order).
  router.get("/api/goals/sources", handle(() => ({ sources: progressSources() })));
  // Goals you can check in on from a standup answer (§C5, D1043).
  router.get("/api/goals/checkin-targets", handle((_c, userId) => ({ goals: checkinTargets(userId) })));
  // D1387: the goals list as CSV, with the list's filters (before /api/goals/:id).
  router.get("/api/goals/export.csv", handle((c, userId) => {
    const query = (name: string) => c.req.query(name)?.slice(0, 200) || null;
    return csvResponse(goalsCsv(userId, { period: query("period"), owner: query("owner"), team: query("team"), state: query("state"), health: query("health"), mine: query("mine") === "1", q: query("q"), includeClosed: query("closed") === "1" }), "goals.csv");
  }));
  // D1386: the card face's goal badge, for every card on screen in one read.
  router.get("/api/goals/for-cards", handle((c, userId) => {
    const ids = (c.req.query("ids") ?? "").split(",").map((id) => id.trim().toLowerCase()).filter((id) => /^[0-9a-f-]{36}$/.test(id));
    if (ids.length > MAX_BADGE_CARDS) return c.json({ error: `Ask for at most ${MAX_BADGE_CARDS} cards at a time`, code: "INVALID" }, 400);
    return { cards: goalsOfCards(userId, ids) };
  }));
  router.get("/api/goals/for-item", handle((c, userId) => {
    const kind = c.req.query("kind") ?? "";
    const id = (c.req.query("id") ?? "").toLowerCase();
    if (!isWorkKind(kind) || !/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    return { goals: goalsOfItem(userId, kind, id) };
  }));
  router.get("/api/goals", handle((c, userId) => {
    ensureSweep();
    const query = (name: string) => c.req.query(name)?.slice(0, 200) || null;
    const view = query("view") === "list" ? "list" : "tree";
    return listGoals(userId, {
      period: query("period"), owner: query("owner"), team: query("team"), parent: query("parent"), state: query("state"), health: query("health"),
      mine: query("mine") === "1", q: query("q"), includeClosed: query("closed") === "1", view
    }, { cursor: query("cursor"), limit: Number(query("limit") ?? 50) || 50 });
  }));
  router.post("/api/goals", handle(async (c, userId) => created(c, { goal: await createGoal(userId, await parseJson(c.req.raw, goalInputSchema)) })));
  router.get("/api/goals/:id", handle(async (c, userId) => ({ goal: await getGoal(param(c, "id"), userId) })));
  router.patch("/api/goals/:id", handle(async (c, userId) => ({ goal: updateGoal(userId, param(c, "id"), await parseJson(c.req.raw, goalPatchSchema)) })));
  router.delete("/api/goals/:id", handle((c, userId) => deleteGoal(userId, param(c, "id"))));
  router.post("/api/goals/:id/key-results", handle(async (c, userId) => created(c, { keyResult: await addKeyResult(userId, param(c, "id"), await parseJson(c.req.raw, krInputSchema)) })));
  router.post("/api/goals/:id/preview-source", handle(async (c, userId) => {
    const body = await parseJson(c.req.raw, sourceSchema);
    return { preview: await previewSource(userId, param(c, "id"), body.kind, body.config) };
  }));
  router.post("/api/goals/:id/checkins", handle(async (c, userId) => created(c, checkIn(userId, param(c, "id"), await parseJson(c.req.raw, checkinSchema)))));
  router.get("/api/goals/:id/checkins", handle((c, userId) => listCheckins(userId, param(c, "id"), { cursor: c.req.query("cursor") ?? null })));
  router.get("/api/goals/:id/history", handle((c, userId) => goalHistory(userId, param(c, "id"))));
  router.post("/api/goals/:id/close", handle(async (c, userId) => closeGoal(userId, param(c, "id"), await parseJson(c.req.raw, closeSchema))));
  router.post("/api/goals/:id/reopen", handle((c, userId) => ({ goal: reopenGoal(userId, param(c, "id")) })));
  router.get("/api/goals/:id/work", handle((c, userId) => {
    const { goal } = requireGoal(param(c, "id"), userId, "view");
    return { links: linksOf({ kind: "goal", id: goal.id }, { userId }) };
  }));
  router.patch("/api/key-results/:id", handle(async (c, userId) => ({ keyResult: await updateKeyResult(userId, param(c, "id"), await parseJson(c.req.raw, krPatchSchema)) })));
  router.delete("/api/key-results/:id", handle((c, userId) => deleteKeyResult(userId, param(c, "id"))));
  router.get("/api/key-results/:id/values", handle((c, userId) => krHistory(userId, param(c, "id"), { from: c.req.query("from") ?? null, to: c.req.query("to") ?? null })));
  router.get("/api/goal-periods", handle((c, userId) => ({ periods: listPeriods(userId, { includeArchived: c.req.query("archived") === "1" }) })));
  router.post("/api/goal-periods", handle(async (c, userId) => created(c, { period: createPeriod(userId, await parseJson(c.req.raw, periodSchema)) })));
  router.patch("/api/goal-periods/:id", handle(async (c, userId) => ({ period: updatePeriod(userId, param(c, "id"), await parseJson(c.req.raw, periodPatchSchema)) })));
  router.delete("/api/goal-periods/:id", handle((c, userId) => { deletePeriod(userId, param(c, "id")); return { deleted: true }; }));
  router.post("/api/goal-periods/:id/close", handle(async (c, userId) => {
    const body = await parseJson(c.req.raw, z.object({ carryOverTo: z.string().uuid().nullish() }).strict());
    return { closed: await closePeriod(userId, param(c, "id"), body) };
  }));
}
