import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { db } from "../db";
import { parseJson, uuid } from "../validation";
import { approveProposal, BULK_MAX, bulkProposals, countPending, getProposal, InboxError, listInbox, proposalPushEnabled, REJECT_REASON_MAX, rejectProposal, setProposalPush } from "./service";
import "./today";

/**
 * /api/inbox (docs/plan/research/2026-09-28-agent-inbox-routines.md §8): session, CSRF, and the
 * TOTP gate apply as for every /api route. Only the proposal's owner sees or acts on it (D147);
 * anyone else gets 404. Approve is refused for read-only roles by the write gate (ROLE_READ_ONLY);
 * reject and the push setting are allowlisted for viewers (D152). Guests have no inbox.
 */

const rejectSchema = z.object({ reason: z.string().max(REJECT_REASON_MAX * 2).optional() }).strict();
const bulkSchema = z.object({
  action: z.enum(["approve", "reject"]),
  ids: z.array(uuid).min(1).max(BULK_MAX).optional(),
  runId: uuid.optional(),
  reason: z.string().max(REJECT_REASON_MAX * 2).optional()
}).strict().refine((body) => (body.ids === undefined) !== (body.runId === undefined), "Send ids or runId");
const settingsSchema = z.object({ push: z.boolean() }).strict();
const listQuery = z.object({
  status: z.enum(["pending", "resolved"]).default("pending"),
  group: z.enum(["run", "none"]).default("run"),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional()
});

const notFound = { error: "Not found" } as const;

async function answer(c: Context<AppEnv>, operation: () => unknown) {
  if (c.get("user").role === "guest") return c.json(notFound, 404);
  try {
    return c.json(await operation() as object);
  } catch (error) {
    if (error instanceof InboxError) return c.json(error.body(), error.status);
    throw error;
  }
}

export function registerInboxRoutes(app: Hono<AppEnv>) {
  app.get("/api/inbox/proposals", (c) => answer(c, () => {
    const query = listQuery.parse(c.req.query());
    return listInbox(c.get("user").id, query);
  }));

  app.get("/api/inbox/count", (c) => answer(c, () => countPending(c.get("user").id)));

  app.get("/api/inbox/proposals/:id", (c) => answer(c, () => getProposal(c.get("user").id, uuid.parse(c.req.param("id")))));

  app.post("/api/inbox/proposals/:id/approve", (c) => answer(c, async () => {
    const id = uuid.parse(c.req.param("id"));
    const outcome = await approveProposal(c.get("user").id, id);
    if (outcome.status === "failed") throw new InboxError(409, outcome.error, outcome.code, { status: "failed" });
    return outcome;
  }));

  app.post("/api/inbox/proposals/:id/reject", (c) => answer(c, async () => {
    const id = uuid.parse(c.req.param("id"));
    const body = await parseJson(c.req.raw, rejectSchema);
    return rejectProposal(c.get("user").id, id, body.reason);
  }));

  app.post("/api/inbox/proposals/bulk", (c) => answer(c, async () => {
    const body = await parseJson(c.req.raw, bulkSchema);
    const userId = c.get("user").id;
    const ids = body.ids ?? (db.query("SELECT id FROM proposals WHERE owner_id = ? AND run_id = ? AND status = 'pending' ORDER BY created_at, rowid LIMIT ?")
      .all(userId, body.runId!.toLowerCase(), BULK_MAX) as Array<{ id: string }>).map((row) => row.id);
    return bulkProposals(userId, { action: body.action, ids, reason: body.reason });
  }));

  app.get("/api/inbox/settings", (c) => answer(c, () => ({ push: proposalPushEnabled(c.get("user").id) })));

  app.put("/api/inbox/settings", (c) => answer(c, async () => {
    const body = await parseJson(c.req.raw, settingsSchema);
    return setProposalPush(c.get("user").id, body.push);
  }));
}
