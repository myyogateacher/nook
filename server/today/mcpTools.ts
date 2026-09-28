import * as z from "zod/v4";
import { defineTool, McpToolError, type McpToolSpec } from "../mcpToolKit";
import { todayRateLimited } from "./rateLimit";
import { loadToday, todayContext, todaySectionsForScopes, validTimeZone } from "./registry";
import "./providers";
import "../inbox/today";

/**
 * get_today (docs/plan/WAVES_10-12.md §2.3, D70, T74): the Today aggregate as
 * plain JSON with titles and ids only. A section is returned only when the key
 * also holds its module's read scope (notes, files, tasks, collections, calendar); binSoon and storage
 * need today:read alone. Reads are not audited, like the other read tools.
 */
export const todayTools: McpToolSpec[] = [
  defineTool({
    name: "get_today",
    title: "Get Today",
    description: "The user's Today summary: tasks due within seven days and their open cards, recent notes and drafts, recent files, recently edited collection rows, upcoming events, Bin items deleted soon, and storage. Only sections this key may read are included; each has at most ten items and `more`.",
    scopes: ["today:read"],
    write: false,
    inputSchema: z.object({ tz: z.string().max(64).optional().describe("IANA time zone for today's date and overdue flags; defaults to UTC") }),
    handler: async ({ tz }, key) => {
      // The same per-user budget as GET /api/today, on top of the MCP call limits.
      const retryAfter = todayRateLimited(key.userId);
      if (retryAfter) throw new McpToolError("RATE_LIMITED", "Too many Today requests. Try again in a moment.", { retryAfterSeconds: retryAfter });
      const zone = validTimeZone(tz ?? "UTC");
      if (!zone) throw new McpToolError("INVALID", "tz must be an IANA time zone");
      const allowed = todaySectionsForScopes(key.scopes);
      if (allowed.length === 0) return { generatedAt: new Date().toISOString(), date: todayContext(key.userId, zone).today, sections: {} };
      return loadToday(todayContext(key.userId, zone, new Date(), key.scopes, key.keyId), allowed);
    }
  })
];
