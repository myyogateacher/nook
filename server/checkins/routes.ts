import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson } from "../validation";
import type { ModuleRouter } from "../workspaceRegistry";
import { CHECKIN_TEMPLATES } from "../../shared/checkins";
import { CheckinError, checkinLevel, checkinRow, notFound, roundRow } from "./store";
import { createCheckin, deleteCheckin, publishQuestions, readQuestions, saveQuestions, setAutoTimeZone, setMyParticipation, setParticipants, setSubscription, updateCheckin } from "./service";
import { goalUpdatesSchema } from "./goalUpdates";
import { answerRound, closeRound, nudgeRound, skipRound, startRoundNow, unblockCard } from "./rounds";
import { detailOf, dueRounds, feed, listCheckins, prefill, roundByDate, roundSummary, roundsPage, roundView, stats } from "./views";
import { LEVEL_RANK } from "../access/levels";
import { canWriteContent } from "../team/userRole";
import { csvFileName, csvResponse } from "../csvExport";
import { checkinCsv } from "./export";

/**
 * Standups over HTTP (docs/plan/WORKSPACE_MODULES.md §D.4 HTTP, docs/plan/API_CONTRACTS.md
 * "Standups"). JSON under /api, errors `{ error, code }`; `:id` takes the UUID or the short id; a
 * standup or round the caller cannot read is 404 (T90). Guests and viewers send only the answering
 * writes (registered as the module's read-only writes, D817); the handlers check participation.
 */

const id = z.string().min(1).max(200);
const schedule = z.object({
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  everyNWeeks: z.number().int().min(1).max(8).default(1),
  zoneMode: z.enum(["each", "fixed"]),
  tz: z.string().min(1).max(64)
}).partial().strict();
const participants = z.object({ people: z.array(z.string().uuid()).max(200).default([]), groups: z.array(z.string().uuid()).max(20).default([]) }).strict();
const summary = z.object({ notifyParticipants: z.boolean().optional(), email: z.boolean().optional(), noteId: z.string().uuid().nullable().optional() }).strict();
export const createSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  template: z.enum(CHECKIN_TEMPLATES),
  description: z.string().max(4000).optional(),
  schedule: schedule.optional(),
  deadlineMinutes: z.number().int().min(30).max(10_080).optional(),
  reminderMinutesBefore: z.number().int().min(5).max(10_080).nullable().optional(),
  participants: participants.optional(),
  privateAnswers: z.boolean().optional(),
  summary: summary.optional()
}).strict();
export const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(4000).optional(),
  schedule: schedule.optional(),
  deadlineMinutes: z.number().int().min(30).max(10_080).optional(),
  reminderMinutesBefore: z.number().int().min(5).max(10_080).nullable().optional(),
  status: z.enum(["active", "paused"]).optional(),
  privateAnswers: z.boolean().optional(),
  summary: summary.optional(),
  expectedRevision: z.number().int().positive().optional()
}).strict();
const answerSchema = z.object({ answers: z.record(z.string(), z.unknown()), expectedRevision: z.number().int().positive().optional(), goalUpdates: goalUpdatesSchema.optional() }).strict();

type Handler = (c: Context<AppEnv>) => Promise<Response> | Response;

/** Maps the module's errors to `{ error, code }` with their status. */
const handle = (fn: Handler): Handler => async (c) => {
  try {
    return await fn(c);
  } catch (error) {
    if (error instanceof CheckinError) return c.json({ error: error.message, code: error.code, ...(error.details ?? {}) }, error.status);
    if (error instanceof z.ZodError) return c.json({ error: "Invalid request", code: "INVALID", details: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, 400);
    throw error;
  }
};

const user = (c: Context<AppEnv>) => c.get("user").id;
const param = (c: Context<AppEnv>, name: string) => id.parse(c.req.param(name) ?? "");

/** A round the caller may manage (edit on its standup and a writing role). */
function managedRound(c: Context<AppEnv>) {
  const round = roundRow(param(c, "rid"));
  const row = round ? checkinRow(round.checkin_id) : null;
  const level = checkinLevel(row, user(c));
  if (!round || !row || level === "none") throw notFound("Round");
  if (LEVEL_RANK[level] < LEVEL_RANK.edit || !canWriteContent(user(c))) throw new CheckinError(403, "READ_ONLY", "Only people who can edit this standup can do that");
  return { round, row };
}

export function checkinRoutes(router: ModuleRouter) {
  // Specific paths first (the dispatcher matches in order).
  router.get("/api/checkins/due", handle((c) => c.json({ items: dueRounds(user(c)) })));
  router.get("/api/checkins/feed", handle((c) => c.json(feed(user(c), {
    checkin: c.req.query("checkin") || null, person: c.req.query("person") || null, blockers: c.req.query("blockers") === "1",
    q: c.req.query("q")?.slice(0, 200) || null, cursor: c.req.query("cursor") || null, limit: Number(c.req.query("limit") ?? 30) || 30
  }))));
  router.put("/api/checkin-participation/timezone", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ tz: z.string().min(1).max(64) }).strict());
    return c.json(setAutoTimeZone(user(c), body.tz));
  }));
  router.get("/api/checkins", handle((c) => {
    const mine = c.req.query("mine");
    return c.json(listCheckins(user(c), { mine: mine === "participant" ? "participant" : "all", cursor: c.req.query("cursor") || null, limit: Number(c.req.query("limit") ?? 50) || 50 }));
  }));
  router.post("/api/checkins", handle(async (c) => {
    const body = await parseJson(c.req.raw, createSchema);
    const row = createCheckin(user(c), body as never);
    return c.json({ checkin: detailOf(row.id, user(c)) }, 201);
  }));
  router.get("/api/checkins/:id", handle((c) => c.json({ checkin: detailOf(param(c, "id"), user(c)) })));
  // D1387: the rounds' answers the viewer can read, as CSV.
  router.get("/api/checkins/:id/export.csv", handle((c) => { const file = checkinCsv(param(c, "id"), user(c)); return csvResponse(file.text, csvFileName(file.name, "standup")); }));
  router.patch("/api/checkins/:id", handle(async (c) => {
    const body = await parseJson(c.req.raw, patchSchema);
    const row = updateCheckin(user(c), param(c, "id"), body as never);
    return c.json({ checkin: detailOf(row.id, user(c)) });
  }));
  router.delete("/api/checkins/:id", handle((c) => c.json(deleteCheckin(user(c), param(c, "id")))));
  router.get("/api/checkins/:id/questions", handle((c) => c.json(readQuestions(user(c), param(c, "id")))));
  router.put("/api/checkins/:id/questions", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ set: z.unknown() }).strict());
    return c.json(saveQuestions(user(c), param(c, "id"), body.set));
  }));
  router.post("/api/checkins/:id/questions/publish", handle((c) => c.json(publishQuestions(user(c), param(c, "id")))));
  router.get("/api/checkins/:id/participants", handle((c) => {
    const detail = detailOf(param(c, "id"), user(c));
    return c.json({ people: detail.people, groups: detail.groups });
  }));
  router.put("/api/checkins/:id/participants", handle(async (c) => {
    const body = await parseJson(c.req.raw, participants);
    return c.json(setParticipants(user(c), param(c, "id"), body));
  }));
  router.patch("/api/checkins/:id/participants/me", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ tz: z.string().min(1).max(64).nullable().optional(), pausedUntil: z.string().length(10).nullable().optional() }).strict());
    return c.json(setMyParticipation(user(c), param(c, "id"), body));
  }));
  router.put("/api/checkins/:id/subscription", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ summaries: z.boolean() }).strict());
    return c.json(setSubscription(user(c), param(c, "id"), body.summaries));
  }));
  router.get("/api/checkins/:id/rounds", handle((c) => c.json(roundsPage(param(c, "id"), user(c), c.req.query("cursor") || null))));
  router.post("/api/checkins/:id/rounds", handle((c) => {
    const row = checkinRow(param(c, "id"));
    const level = checkinLevel(row, user(c));
    if (!row || level === "none") throw notFound();
    if (LEVEL_RANK[level] < LEVEL_RANK.edit || !canWriteContent(user(c))) throw new CheckinError(403, "READ_ONLY", "Only people who can edit this standup can start a round");
    const round = startRoundNow(row, user(c));
    return c.json({ round: roundView(round.id, user(c)) }, 201);
  }));
  router.get("/api/checkins/:id/rounds/:date", handle((c) => c.json(roundView(roundByDate(param(c, "id"), c.req.param("date") ?? "", user(c)), user(c)))));
  router.get("/api/checkins/:id/stats", handle((c) => c.json(stats(param(c, "id"), user(c), { from: c.req.query("from") || null, to: c.req.query("to") || null }))));
  router.post("/api/checkins/:id/unblock", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ cardId: z.string().uuid() }).strict());
    if (checkinLevel(checkinRow(param(c, "id")), user(c)) === "none") throw notFound();
    return c.json(unblockCard(user(c), body.cardId));
  }));

  router.get("/api/checkin-rounds/:rid", handle((c) => c.json(roundView(param(c, "rid"), user(c)))));
  router.get("/api/checkin-rounds/:rid/me", handle((c) => c.json(prefill(param(c, "rid"), user(c)))));
  router.get("/api/checkin-rounds/:rid/summary", handle((c) => c.json(roundSummary(param(c, "rid"), user(c)))));
  const answer = handle(async (c) => {
    const body = await parseJson(c.req.raw, answerSchema);
    const result = answerRound(user(c), param(c, "rid"), body);
    return c.json({ status: result.status, edited: result.edited, blockers: result.blockers, round: roundView(param(c, "rid"), user(c)) }, result.edited ? 200 : 201);
  });
  router.post("/api/checkin-rounds/:rid/answer", answer);
  router.put("/api/checkin-rounds/:rid/answer", answer);
  router.post("/api/checkin-rounds/:rid/skip", handle((c) => c.json(skipRound(user(c), param(c, "rid")))));
  router.post("/api/checkin-rounds/:rid/close", handle((c) => {
    const { round, row } = managedRound(c);
    closeRound(row, round, Date.now(), user(c));
    return c.json(roundView(round.id, user(c)));
  }));
  router.post("/api/checkin-rounds/:rid/nudge", handle((c) => {
    const { round, row } = managedRound(c);
    return c.json(nudgeRound(row, round, user(c)));
  }));
}

/** The answering writes guests and viewers may send (D817); the handlers check participation. */
export const CHECKIN_READ_ONLY_WRITES = [
  { method: "POST" as const, path: "/api/checkin-rounds/:rid/answer", roles: ["guest", "viewer"] as const, why: "answer a standup round you take part in" },
  { method: "PUT" as const, path: "/api/checkin-rounds/:rid/answer", roles: ["guest", "viewer"] as const, why: "edit your standup answer" },
  { method: "POST" as const, path: "/api/checkin-rounds/:rid/skip", roles: ["guest", "viewer"] as const, why: "skip a standup round you take part in" },
  { method: "PATCH" as const, path: "/api/checkins/:id/participants/me", roles: ["guest", "viewer"] as const, why: "your own standup time zone and pause" },
  { method: "PUT" as const, path: "/api/checkin-participation/timezone", roles: ["guest", "viewer"] as const, why: "your browser's time zone for your standups" },
  { method: "PUT" as const, path: "/api/checkins/:id/subscription", roles: ["guest", "viewer"] as const, why: "your own standup summary choice" }
];
