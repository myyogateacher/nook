import type { Context, Hono } from "hono";
import type { AppEnv } from "../auth";
import { uuid } from "../validation";
import { ReactionError, setReaction } from "./service";
import { TARGET_KIND_PATTERN } from "./targets";

async function respond(c: Context<AppEnv>, operation: () => Promise<unknown>) {
  try {
    return c.json(await operation() as Record<string, unknown>, 200);
  } catch (error) {
    if (error instanceof ReactionError) {
      if (error.retryAfter) c.header("Retry-After", String(error.retryAfter));
      return c.json(error.body(), error.status);
    }
    throw error;
  }
}

/**
 * docs/plan/API_CONTRACTS.md § Reactions. Empty bodies; the global session, Origin, JSON
 * Content-Type, CSRF, TOTP, and role write gates apply (viewers and guests get 403 ROLE_READ_ONLY).
 * `PUT` adds and `DELETE` removes, both idempotent (D184).
 */
export function registerReactionRoutes(app: Hono<AppEnv>) {
  const handle = async (c: Context<AppEnv>, kind: string, targetId: string, on: boolean) => {
    // A malformed kind or id is as unknown as a missing one (T151).
    if (!TARGET_KIND_PATTERN.test(kind) || !uuid.safeParse(targetId).success) return c.json({ error: "Not found" }, 404);
    return respond(c, () => setReaction(c.get("user").id, kind, targetId, c.req.param("emoji") ?? "", on));
  };
  // The generic form, for every registered target kind.
  app.put("/api/reactions/:kind/:targetId/:emoji", (c) => handle(c, c.req.param("kind"), c.req.param("targetId"), true));
  app.delete("/api/reactions/:kind/:targetId/:emoji", (c) => handle(c, c.req.param("kind"), c.req.param("targetId"), false));
  // Card comments, next to the other comment routes (the client uses these).
  app.put("/api/tasks/comments/:commentId/reactions/:emoji", (c) => handle(c, "card_comment", c.req.param("commentId"), true));
  app.delete("/api/tasks/comments/:commentId/reactions/:emoji", (c) => handle(c, "card_comment", c.req.param("commentId"), false));
}
