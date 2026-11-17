import type { Hono } from "hono";
import * as z from "zod/v4";
import type { AppEnv } from "../auth";
import { uuid } from "../validation";
import { avatarUrlsFor } from "../avatars";
import { defineTool, McpToolError, type McpToolSpec } from "../mcpToolKit";
import { withAuditContext } from "../db";
import { keyMayRead } from "../keyReach";
import { anchorsOf, keyReach, reachCovers } from "../keyResources";
import { cardRef } from "./keys";
import { keyReachesRef } from "../links/keyReach";
import { getCard, TaskError } from "./service";
import { decodeActivityCursor, listCardActivity, type ActivityOrder } from "./activity";
import { ACTIVITY_PAGE_DEFAULT, ACTIVITY_PAGE_MAX, CARD_ACTIVITY_KIND_NAMES } from "../../shared/cardActivity";

/**
 * GET /api/tasks/cards/:cardId/activity (lane ACTIVITY, D745): one page of the card's history for
 * anyone who can read the card (non-readers get 404 like a missing card). `order` is `desc` (newest
 * first, the default) or `asc`; `limit` 1–100 (default 50); `cursor` is the last page's `next`.
 * The MCP tool `get_card_activity` (and so POST /api/v1/tools/get_card_activity) returns the same page.
 */
export function registerCardActivityRoutes(app: Hono<AppEnv>) {
  app.get("/api/tasks/cards/:cardId/activity", (c) => {
    const invalid = (detail: string) => c.json({ error: "Invalid request", details: [detail] }, 400);
    const cardId = uuid.parse(c.req.param("cardId"));
    const order = c.req.query("order") ?? "desc";
    if (order !== "asc" && order !== "desc") return invalid("order must be asc or desc");
    const limitParam = c.req.query("limit");
    if (limitParam !== undefined && (!/^\d+$/.test(limitParam) || Number(limitParam) < 1 || Number(limitParam) > ACTIVITY_PAGE_MAX)) {
      return invalid(`limit must be an integer from 1 to ${ACTIVITY_PAGE_MAX}`);
    }
    const rawCursor = c.req.query("cursor");
    const cursor = rawCursor === undefined ? null : decodeActivityCursor(rawCursor);
    if (rawCursor !== undefined && !cursor) return invalid("cursor must be a next value from an earlier page");
    const userId = c.get("user").id;
    try {
      getCard(userId, cardId);
      const page = listCardActivity(userId, cardId, { order, limit: limitParam === undefined ? ACTIVITY_PAGE_DEFAULT : Number(limitParam), cursor });
      // Web payload: each actor's picture, as comments carry theirs.
      const urls = avatarUrlsFor(page.activity.flatMap((entry) => entry.actor_id ? [entry.actor_id] : []));
      return c.json({ ...page, activity: page.activity.map((entry) => ({ ...entry, actor_avatar_url: entry.actor_id ? urls.get(entry.actor_id) ?? null : null })) });
    } catch (error) {
      if (error instanceof TaskError) return c.json(error.body(), error.status);
      throw error;
    }
  });
}

/** The same page for MCP clients and the REST API (`tasks:read`). */
export const cardActivityTool: McpToolSpec = defineTool({
  name: "get_card_activity",
  title: "Get a card's history",
  description: `Read a card's activity history: who created it, changed its title, description, column, assignees, due date, tags, flags, parent, level, start date, estimate, relations, sprint, or files, when it moved to another board, and when it was archived, moved to the Bin, or restored. Newest first unless order is asc; at most ${ACTIVITY_PAGE_MAX} entries a page (default ${ACTIVITY_PAGE_DEFAULT}); pass next back as cursor for the next page. Kinds: ${CARD_ACTIVITY_KIND_NAMES.join(", ")}. Each entry has the actor's name, via (mcp, rest, agent, proposal, system, or null for the web app), and a payload with from/to or item values ({ id, label }) as they were at the time; a linked goal, note, or other item (goal_linked, relation_added with a kind) shows its current title when you can open it, else only its kind word. Comments are not included (get_card lists them).`,
  scopes: ["tasks:read"],
  access: { mode: "items", items: [{ arg: "cardId", kind: "card" }] },
  write: false,
  inputSchema: z.object({
    cardId: cardRef,
    order: z.enum(["asc", "desc"]).optional(),
    limit: z.number().int().min(1).max(ACTIVITY_PAGE_MAX).optional(),
    cursor: z.string().max(200).optional()
  }),
  handler: async ({ cardId, order, limit, cursor }, key) => {
    try {
      return await withAuditContext({ via: "mcp", keyId: key.keyId }, () => {
        const decoded = cursor === undefined ? null : decodeActivityCursor(cursor);
        if (cursor !== undefined && !decoded) throw new McpToolError("INVALID", "cursor is not a next value from an earlier page");
        getCard(key.userId, cardId);
        return listCardActivity(key.userId, cardId, {
          order: order as ActivityOrder | undefined, limit: limit ?? ACTIVITY_PAGE_DEFAULT, cursor: decoded,
          // A key limited to chosen boards sees no related card's title outside them (T203).
          mayRead: (otherId) => keyMayRead(key, { type: "card", id: otherId }),
          // ...nor the name of a board the card moved from or to outside them (board_move).
          mayReadBoard: (boardId) => reachCovers(keyReach(key, "tasks:read"), anchorsOf("board", boardId)),
          // ...nor the title of a work-linked goal, note, or other item it does not reach (D1390).
          mayReadRef: keyReachesRef(key)
        });
      });
    } catch (error) {
      if (error instanceof TaskError) throw new McpToolError(error.status === 404 ? "NOT_FOUND" : "INVALID", error.message);
      throw error;
    }
  }
});
