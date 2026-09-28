import type { Hono } from "hono";
import type { AppEnv } from "../auth";
import { todayRateLimited as rateLimited } from "./rateLimit";
import { loadToday, todayContext, todaySectionNames, validTimeZone } from "./registry";
import "./providers";
import "../inbox/today";

export { resetTodayRateLimit, TODAY_RATE_LIMIT, TODAY_RATE_WINDOW_MS } from "./rateLimit";

const invalid = (detail: string) => ({ error: "Invalid request", details: [detail] });

export function registerTodayRoutes(app: Hono<AppEnv>) {
  app.get("/api/today", async (c) => {
    const userId = c.get("user").id;
    const retryAfter = rateLimited(userId);
    if (retryAfter) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Too many requests. Try again in a moment.", code: "RATE_LIMITED" }, 429);
    }
    const tz = validTimeZone(c.req.query("tz"));
    if (!tz) return c.json(invalid("tz must be an IANA time zone"), 400);
    // `sections=a,b` reloads only those (the per-section Retry); unknown names are refused.
    const sectionsParam = c.req.query("sections");
    let only: string[] | undefined;
    if (sectionsParam !== undefined) {
      const installed = todaySectionNames();
      only = [...new Set(sectionsParam.split(","))];
      if (only.length === 0 || only.length > installed.length || only.some((name) => !installed.includes(name))) {
        return c.json(invalid("sections must list installed Today sections"), 400);
      }
    }
    return c.json(await loadToday(todayContext(userId, tz), only));
  });
}
