import * as z from "zod/v4";
import { defineTool, McpToolError, type McpToolSpec } from "../mcpToolKit";
import { keyContainerIds, keyFilter } from "../keyResources";
import { grantsToScopes } from "../keyGrants";
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
    access: { mode: "derived" },
    write: false,
    inputSchema: z.object({ tz: z.string().max(64).optional().describe("IANA time zone for today's date and overdue flags; defaults to UTC") }),
    handler: async ({ tz }, key) => {
      // The same per-user budget as GET /api/today, on top of the MCP call limits.
      const retryAfter = todayRateLimited(key.userId);
      if (retryAfter) throw new McpToolError("RATE_LIMITED", "Too many Today requests. Try again in a moment.", { retryAfterSeconds: retryAfter });
      const zone = validTimeZone(tz ?? "UTC");
      if (!zone) throw new McpToolError("INVALID", "tz must be an IANA time zone");
      // Sections follow every scope the key holds, also over chosen items (Wave 34); each section
      // then narrows its own query by that module's reach. `scopes` in the context stays the
      // whole-module scopes, for the Bin section, which lists items of many modules.
      const held = key.grants ? grantsToScopes(key.grants) : key.scopes;
      const allowed = todaySectionsForScopes(held);
      if (allowed.length === 0) return { generatedAt: new Date().toISOString(), date: todayContext(key.userId, zone).today, sections: {} };
      const context = todayContext(key.userId, zone, new Date(), key.scopes, key.keyId);
      return loadToday({ ...context, keyScope: (scope, columns) => keyFilter(key, scope, columns), keyIds: (scope, kind) => keyContainerIds(key, scope, kind) }, allowed);
    }
  })
];
