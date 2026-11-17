import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson } from "../validation";
import { workKindAdapter } from "../links/adapters";
import { listItemActivity } from "./service";
import { addComment, CommentError, deleteComment, editComment, listComments } from "./comments";
import { ITEM_COMMENT_FILES_MAX, ITEM_COMMENT_MAX } from "../../shared/itemActivity";

/**
 * Item activity and comments over HTTP (docs/plan/WORKSPACE_MODULES.md §D.0): for any registered work
 * kind; unknown kinds, missing items, and unreadable items are the same 404 (T501).
 */

function respond(c: Context<AppEnv>, error: unknown) {
  if (error instanceof CommentError) return c.json({ error: error.message, code: error.code }, error.status);
  throw error;
}

const readable = (c: Context<AppEnv>) => {
  const adapter = workKindAdapter(c.req.param("kind") ?? "");
  const id = (c.req.param("id") ?? "").toLowerCase();
  if (!adapter || !id || id.length > 64) return null;
  return adapter.level(id, { userId: c.get("user").id }) === "none" ? null : { kind: adapter.kind, id };
};

export function registerItemActivityRoutes(app: Hono<AppEnv>) {
  app.get("/api/items/:kind/:id/activity", (c) => {
    const item = readable(c);
    if (!item) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    const limit = Number(c.req.query("limit") ?? "50");
    return c.json(listItemActivity(item.kind, item.id, { viewer: { userId: c.get("user").id }, order: c.req.query("order") === "asc" ? "asc" : "desc", cursor: c.req.query("cursor") ?? null, limit: Number.isFinite(limit) ? limit : 50 }));
  });
  app.get("/api/items/:kind/:id/comments", (c) => {
    try {
      return c.json({ comments: listComments(c.req.param("kind"), (c.req.param("id") ?? "").toLowerCase(), c.get("user").id) });
    } catch (error) {
      return respond(c, error);
    }
  });
  app.post("/api/items/:kind/:id/comments", async (c) => {
    // With files (D1363) the text may be empty; the files are the author's own (uploaded with ?attachTo=item_comment).
    const body = await parseJson(c.req.raw, z.object({
      body: z.string().max(ITEM_COMMENT_MAX).optional(), parentId: z.string().uuid().nullish(),
      attachmentIds: z.array(z.string().uuid()).max(ITEM_COMMENT_FILES_MAX).optional(), confirmed: z.boolean().optional()
    }).strict());
    try {
      return c.json({ comment: addComment({ kind: c.req.param("kind"), itemId: (c.req.param("id") ?? "").toLowerCase(), authorId: c.get("user").id, body: body.body ?? null, parentId: body.parentId ?? null, attachmentIds: body.attachmentIds, confirmed: body.confirmed }) }, 201);
    } catch (error) {
      return respond(c, error);
    }
  });
  app.patch("/api/items/:kind/:id/comments/:cid", async (c) => {
    const body = await parseJson(c.req.raw, z.object({ body: z.string().min(1).max(ITEM_COMMENT_MAX) }).strict());
    try {
      return c.json({ comment: editComment({ kind: c.req.param("kind"), itemId: (c.req.param("id") ?? "").toLowerCase(), commentId: c.req.param("cid"), userId: c.get("user").id, body: body.body }) });
    } catch (error) {
      return respond(c, error);
    }
  });
  app.delete("/api/items/:kind/:id/comments/:cid", (c) => {
    try {
      return c.json(deleteComment({ kind: c.req.param("kind"), itemId: (c.req.param("id") ?? "").toLowerCase(), commentId: c.req.param("cid"), userId: c.get("user").id }));
    } catch (error) {
      return respond(c, error);
    }
  });
}
