import * as z from "zod/v4";
import { BIN_BUCKETS, BIN_DESCRIPTION, defineTool, McpToolError, notFound, restoreResult, type McpKeyContext, type McpToolSpec } from "../mcpToolKit";
import { restoreItem } from "../bin";
import { anchorsOf, keyFilter, keyReach, reachCovers } from "../keyResources";
import { LinkError } from "../links/service";
import { ROUNDING_MINUTES, type RoundingMinutes } from "../../shared/duration";
import { SUMMARY_GROUPS, type SummaryGroup } from "../../shared/time";
import {
  bulkEntries, createEntry, deleteEntry, entryRow, listEntries, parseSeconds, runningEntry, runningView, startTimer, stopTimer, TimeError, updateEntry, type Actor
} from "./service";
import { binProject, createProject, listProjects, projectView, updateProject } from "./projects";
import { suggestions, summarize, timeForTarget } from "./reports";

/**
 * Time's MCP tools (lane TIME, §D.2 "MCP", §B.15): `time:read` / `time:write`. Every tool calls the
 * same service as the web app. Entries anchor on their project for keys limited to chosen projects;
 * an entry without a project is reachable only by a key over the whole module (T531), so such a key
 * must name a project to start a timer or log time.
 */

const PROJECT_COLUMNS = { time_project: "e.project_id" } as const;

/** Runs a service call, mapping its errors to the tool vocabulary (NOT_FOUND parity with HTTP). */
function run<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof TimeError) {
      const code = error.status === 404 ? "NOT_FOUND" : error.status === 403 ? "READ_ONLY" : error.code === "LOCKED" || error.code === "WEEK_LOCKED" ? "READ_ONLY" : error.code === "ENTRY_CHANGED" || error.code === "PROJECT_CHANGED" ? "CARD_CHANGED" : "INVALID";
      throw new McpToolError(code, error.message, { reason: error.code });
    }
    if (error instanceof LinkError) throw new McpToolError(error.status === 404 ? "NOT_FOUND" : "INVALID", error.status === 404 ? "Work item not found" : error.message);
    throw error;
  }
}

const actorOf = (key: McpKeyContext): Actor => ({ userId: key.userId, via: key.person ? "proposal" : "mcp" });

/** Whether the key reaches an entry (its project) for a scope. */
function reachesEntry(key: McpKeyContext, entryId: string, scope: "time:read" | "time:write") {
  const anchors = anchorsOf("time_entry", entryId);
  return reachCovers(keyReach(key, scope), anchors);
}

const ref = z.string().max(2048).describe("A card key (MYT-12), an in-app URL, or kind:id (goal:…, contact:…, event:…)");
const tz = z.string().max(64).optional().describe("IANA time zone for dates and days (default: the person's)");
const entryOut = z.object({}).passthrough();

export const timeTools: McpToolSpec[] = [
  defineTool({
    name: "get_running_timer", title: "Get the running timer",
    description: "The key owner's running timer (description, project, work item, elapsed seconds), or null, with today's total.",
    scopes: ["time:read"], access: { mode: "list", lists: ["time_project"] }, write: false,
    inputSchema: z.object({ tz }),
    handler: (args, key) => run(() => {
      const row = runningEntry(key.userId);
      const visible = row && (row.project_id ? reachCovers(keyReach(key, "time:read"), [{ kind: "time_project", id: row.project_id }]) : keyReach(key, "time:read") === "all");
      return { entry: visible ? runningView(key.userId) : null };
    })
  }),
  defineTool({
    name: "start_timer", title: "Start a timer",
    description: "Starts the key owner's timer, stopping a running one at the same instant (one timer per person). Optional description, project, work item (a card key such as MYT-12, or a URL), billable, tags. A card on a board linked to a project uses that project.",
    scopes: ["time:write"], access: { mode: "items", items: [{ arg: "projectId", kind: "time_project" }] }, write: true,
    inputSchema: z.object({
      description: z.string().max(500).optional(), projectId: z.string().max(64).optional(), target: ref.optional(), billable: z.boolean().optional(),
      tags: z.array(z.string().max(40)).max(5).optional(), startedAt: z.string().max(40).optional().describe("Start in the past (ISO instant, within 24 hours)"), tz
    }),
    handler: (args, key) => run(() => {
      // Starting stops the running timer: a key that could not stop it (stop_timer's reach check) cannot
      // stop it this way either (TG5, D1144).
      const row = runningEntry(key.userId);
      if (row && !(row.project_id ? reachCovers(keyReach(key, "time:write"), [{ kind: "time_project", id: row.project_id }]) : keyReach(key, "time:write") === "all")) {
        throw new McpToolError("READ_ONLY", "A timer is running on a project this key cannot reach; stop it in Nook first", { reason: "TIMER_OUT_OF_REACH" });
      }
      return startTimer(actorOf(key), args);
    })
  }),
  defineTool({
    name: "stop_timer", title: "Stop the timer",
    description: "Stops the key owner's running timer (now, or at `at`) and returns the finished entry, or null when none runs.",
    scopes: ["time:write"], access: { mode: "derived" }, write: true, annotations: { idempotentHint: true },
    inputSchema: z.object({ at: z.string().max(40).optional() }),
    handler: (args, key) => run(() => {
      const row = runningEntry(key.userId);
      if (row && !(row.project_id ? reachCovers(keyReach(key, "time:write"), [{ kind: "time_project", id: row.project_id }]) : keyReach(key, "time:write") === "all")) return { entry: null };
      return { entry: stopTimer(actorOf(key), args.at) };
    })
  }),
  defineTool({
    name: "log_time", title: "Log time",
    description: "Logs a finished block of time for the key owner: `duration` (\"1h30\", \"90m\", \"1:30\", or seconds) or `startedAt`+`endedAt`. Start defaults to now minus the duration. Optional description, project, work item (MYT-12 or a URL), billable, tags.",
    scopes: ["time:write"], access: { mode: "items", items: [{ arg: "projectId", kind: "time_project" }] }, write: true,
    inputSchema: z.object({
      duration: z.union([z.string().max(32), z.number().int().min(0).max(86_400)]).optional(), startedAt: z.string().max(40).optional(), endedAt: z.string().max(40).optional(),
      description: z.string().max(500).optional(), projectId: z.string().max(64).optional(), target: ref.optional(), billable: z.boolean().optional(), tags: z.array(z.string().max(40)).max(5).optional(), tz
    }),
    outputSchema: z.object({ entry: entryOut }),
    handler: (args, key) => run(() => {
      let startedAt = args.startedAt;
      if (!startedAt) {
        if (args.endedAt) throw new TimeError(400, "INVALID", "Give startedAt with endedAt");
        const seconds = typeof args.duration === "number" ? args.duration : null;
        startedAt = new Date(Date.now() - (seconds ?? 0) * 1000).toISOString();
        if (seconds === null && typeof args.duration === "string") {
          const parsed = parseSeconds(args.duration, key.userId);
          if (parsed === null) throw new TimeError(400, "INVALID", "duration is like 1h30, 90m, or 1:30");
          startedAt = new Date(Date.now() - parsed * 1000).toISOString();
        }
      }
      return { entry: createEntry(actorOf(key), { ...args, startedAt, source: key.person ? "proposal" : "mcp" }) };
    })
  }),
  defineTool({
    name: "list_time_entries", title: "List time entries",
    description: "Time entries the key owner may see, newest first: theirs by default (`user`: me, all, or a person id), by date range (YYYY-MM-DD in `tz`), project, work item (kind:id), billable, tag, or text. Paged by `cursor` (at most 100).",
    scopes: ["time:read"], access: { mode: "list", lists: ["time_project"], related: ["projectId", "user"] }, write: false,
    inputSchema: z.object({
      from: z.string().max(40).optional(), to: z.string().max(40).optional(), user: z.string().max(64).optional(), projectId: z.string().max(64).optional(),
      target: z.string().max(100).optional().describe("kind:id"), billable: z.boolean().optional(), tag: z.string().max(40).optional(), q: z.string().max(200).optional(), tz,
      cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional()
    }),
    handler: (args, key) => run(() => {
      const [kind, id] = args.target?.split(":") ?? [];
      const page = listEntries(key.userId, { ...args, target: kind && id ? { kind: kind as never, id: id.toLowerCase() } : undefined, extra: keyFilter(key, "time:read", PROJECT_COLUMNS) });
      return { items: page.entries, nextCursor: page.nextCursor };
    })
  }),
  defineTool({
    name: "update_time_entry", title: "Update a time entry",
    description: "Changes an entry's description, project, work item, billable, tags, start, duration, or end. Your own unlocked entries; a project manager may change entries on their project. Optional `expectedRevision`.",
    scopes: ["time:write"], access: { mode: "items", items: [{ arg: "entryId", kind: "time_entry" }, { arg: "projectId", kind: "time_project", ifAbsent: "allow" }] }, write: true,
    inputSchema: z.object({
      entryId: z.string().max(64), description: z.string().max(500).optional(), projectId: z.string().max(64).nullable().optional(), target: ref.nullable().optional(),
      billable: z.boolean().optional(), tags: z.array(z.string().max(40)).max(5).optional(), startedAt: z.string().max(40).optional(),
      duration: z.union([z.string().max(32), z.number().int().min(0).max(86_400)]).optional(), endedAt: z.string().max(40).optional(), expectedRevision: z.number().int().optional()
    }),
    handler: ({ entryId, ...patch }, key) => run(() => ({ entry: updateEntry(actorOf(key), entryId, patch) }))
  }),
  defineTool({
    name: "discard_time_entry", title: "Delete a time entry",
    description: "Deletes an entry (your own unlocked one, or one on a project you manage). The person can undo it in the app for 10 minutes.",
    scopes: ["time:write"], access: { mode: "items", items: [{ arg: "entryId", kind: "time_entry" }] }, write: true, annotations: { destructiveHint: true },
    inputSchema: z.object({ entryId: z.string().max(64) }),
    handler: ({ entryId }, key) => run(() => { deleteEntry(actorOf(key), entryId); return { deleted: true }; })
  }),
  defineTool({
    name: "bulk_log_time", title: "Log, change, or delete many entries",
    description: "Up to 100 entries at once, all or nothing: `op` create (each like log_time with startedAt), update (each with entryId), or delete. `dryRun: true` checks everything and returns what would happen without saving.",
    scopes: ["time:write"], access: { mode: "derived", related: ["items"] }, write: true,
    inputSchema: z.object({
      op: z.enum(["create", "update", "delete"]), dryRun: z.boolean().optional(),
      items: z.array(z.object({
        entryId: z.string().max(64).optional(), startedAt: z.string().max(40).optional(), duration: z.union([z.string().max(32), z.number().int().min(0).max(86_400)]).optional(),
        endedAt: z.string().max(40).optional(), description: z.string().max(500).optional(), projectId: z.string().max(64).nullable().optional(), target: ref.nullable().optional(),
        billable: z.boolean().optional(), tags: z.array(z.string().max(40)).max(5).optional(), tz
      })).min(1).max(100)
    }),
    handler: (args, key) => run(() => {
      const reach = keyReach(key, "time:write");
      for (const [index, item] of args.items.entries()) {
        if (item.entryId && !reachesEntry(key, item.entryId, "time:write")) throw new McpToolError("NOT_FOUND", `Item ${index + 1}: Time entry not found`);
        if (item.projectId && !reachCovers(reach, anchorsOf("time_project", item.projectId))) throw new McpToolError("NOT_FOUND", `Item ${index + 1}: Project not found`);
        if (reach !== "all" && args.op === "create" && !item.projectId) throw new McpToolError("NOT_FOUND", `Item ${index + 1}: name a project this key can reach`);
      }
      const items = args.items.map(({ entryId, ...rest }) => args.op === "create" ? { ...rest, startedAt: rest.startedAt ?? "", source: "mcp" as const } : { id: entryId ?? "", ...rest });
      const result = bulkEntries(actorOf(key), { op: args.op, items, dryRun: args.dryRun } as never);
      return { dryRun: result.dryRun, count: result.count, entries: result.entries };
    })
  }),
  defineTool({
    name: "time_summary", title: "Summarize time",
    description: "Totals of the entries the key owner may see over a range, grouped by up to two of project, client, user, target, tag, day, week, month, billable; seconds, billable seconds, and amounts where the owner may see money. Optional rounding per entry (6, 15, 30 minutes).",
    scopes: ["time:read"], access: { mode: "list", lists: ["time_project"], related: ["projectId", "user"] }, write: false,
    inputSchema: z.object({
      from: z.string().max(40).optional(), to: z.string().max(40).optional(), groupBy: z.array(z.enum(SUMMARY_GROUPS)).max(2).optional(), user: z.string().max(64).optional(),
      projectId: z.string().max(64).optional(), billable: z.boolean().optional(), tag: z.string().max(40).optional(), rounding: z.number().int().optional(), tz
    }),
    handler: (args, key) => run(() => summarize(key.userId, {
      ...args, user: args.user ?? "all", groupBy: (args.groupBy ?? ["project"]) as SummaryGroup[],
      rounding: ((ROUNDING_MINUTES as readonly number[]).includes(args.rounding ?? 0) ? args.rounding ?? 0 : 0) as RoundingMinutes,
      extra: keyFilter(key, "time:read", PROJECT_COLUMNS)
    }))
  }),
  defineTool({
    name: "list_time_projects", title: "List time projects",
    description: "Time projects the key owner can open: name, client, linked board, billable default, budget and use; rates only where they manage the project.",
    scopes: ["time:read"], access: { mode: "list", lists: ["time_project"] }, write: false,
    inputSchema: z.object({ q: z.string().max(120).optional(), includeArchived: z.boolean().optional(), cursor: z.string().max(20).optional(), limit: z.number().int().min(1).max(100).optional() }),
    handler: (args, key) => run(() => {
      const offset = args.cursor ? Number(args.cursor) || 0 : 0;
      const limit = args.limit ?? 50;
      const all = listProjects(key.userId, { q: args.q, archived: args.includeArchived ? undefined : false, extra: keyFilter(key, "time:read", { time_project: "p.id" }) });
      return { items: all.slice(offset, offset + limit), nextCursor: offset + limit < all.length ? String(offset + limit) : null };
    })
  }),
  defineTool({
    name: "create_time_project", title: "Create a time project",
    description: "Creates a project owned by the key owner: name, optional code, color, client (an existing company id, or `newClient` by name), linked board, billable default, hourly rate in minor units, currency, budget.",
    scopes: ["time:write"], access: { mode: "global", related: ["clientId", "boardId", "memberIds"] }, write: true,
    inputSchema: z.object({
      name: z.string().max(120), code: z.string().max(12).optional(), color: z.string().max(24).optional(), clientId: z.string().max(64).optional(), newClient: z.string().max(200).optional(),
      boardId: z.string().max(64).optional(), billableDefault: z.boolean().optional(), rateMinor: z.number().int().min(0).optional(), currency: z.string().length(3).optional(),
      budget: z.object({ kind: z.enum(["none", "hours", "money"]), value: z.number().int().min(0).optional(), period: z.enum(["total", "monthly"]).optional() }).optional(),
      memberIds: z.array(z.string().uuid()).max(50).optional()
    }),
    handler: (args, key) => run(() => ({ project: createProject(key.userId, args) }))
  }),
  defineTool({
    name: "update_time_project", title: "Update a time project",
    description: "Changes a project you manage: name, code, color, client, linked board, billable default, rate, currency, budget, private entries, archived. Optional `expectedRevision`.",
    scopes: ["time:write"], access: { mode: "items", items: [{ arg: "projectId", kind: "time_project" }], related: ["clientId", "boardId"] }, write: true,
    inputSchema: z.object({
      projectId: z.string().max(64), name: z.string().max(120).optional(), code: z.string().max(12).nullable().optional(), color: z.string().max(24).optional(),
      clientId: z.string().max(64).nullable().optional(), newClient: z.string().max(200).optional(), boardId: z.string().max(64).nullable().optional(), billableDefault: z.boolean().optional(),
      rateMinor: z.number().int().min(0).nullable().optional(), currency: z.string().length(3).optional(),
      budget: z.object({ kind: z.enum(["none", "hours", "money"]), value: z.number().int().min(0).nullable().optional(), period: z.enum(["total", "monthly"]).optional() }).optional(),
      settings: z.object({ privateEntries: z.boolean().optional(), requireDescription: z.boolean().optional() }).optional(), archived: z.boolean().optional(), expectedRevision: z.number().int().optional()
    }),
    handler: ({ projectId, ...input }, key) => run(() => ({ project: updateProject(key.userId, projectId, input) }))
  }),
  defineTool({
    name: "bin_time_project", title: "Move a time project to the Bin",
    description: `Moves a project you own to the Bin; its entries stay but cannot be logged to it. ${BIN_DESCRIPTION} Restore it with restore_time_project.`,
    scopes: ["time:write"], alsoRequires: ["bin:write"], buckets: BIN_BUCKETS, access: { mode: "items", items: [{ arg: "projectId", kind: "time_project" }] }, write: true, annotations: { destructiveHint: true },
    inputSchema: z.object({ projectId: z.string().max(64) }).strict(),
    // D1385: the REST DELETE /api/time/projects/:id, over MCP.
    handler: ({ projectId }, key) => run(() => binProject(key.userId, projectId))
  }),
  defineTool({
    name: "restore_time_project", title: "Restore a time project from the Bin",
    description: "Restores a project you own from the Bin; logging to it works again.",
    scopes: ["time:write"], alsoRequires: ["bin:write"], access: { mode: "items", items: [{ arg: "projectId", kind: "time_project" }] }, write: true,
    inputSchema: z.object({ projectId: z.string().uuid() }).strict(),
    // D1385: the restore every bin_* tool's description promises, through the module's Bin provider.
    handler: async ({ projectId }, key) => restoreResult(await restoreItem("time_project", projectId.toLowerCase(), key.userId), "Project")
  }),
  defineTool({
    name: "get_time_for_item", title: "Get time on a work item",
    description: "Time logged on a card (MYT-12), goal, contact, company, deal, booking, or event: total, the owner's share, the card's estimate in hours when its board estimates in hours, and the entries the owner may see.",
    scopes: ["time:read"], access: { mode: "derived" }, write: false,
    inputSchema: z.object({ target: ref }),
    handler: ({ target }, key) => run(() => {
      // A key over chosen projects sees totals of those projects only, like its entries (D1147).
      const reach = keyReach(key, "time:read");
      return timeForTarget(key.userId, target, reach === "all" ? undefined : (projectId) => projectId !== null && reachCovers(reach, [{ kind: "time_project", id: projectId }]));
    })
  }),
  defineTool({
    name: "suggest_time_entries", title: "Suggest time entries",
    description: "Calendar events and cards the key owner worked on that day which have no time logged yet, as suggestions for log_time (nothing is saved).",
    scopes: ["time:read"], access: { mode: "global" }, write: false,
    inputSchema: z.object({ date: z.string().max(10).describe("YYYY-MM-DD"), tz }),
    handler: ({ date, tz: zone }, key) => run(() => ({ suggestions: suggestions(key.userId, date, zone) }))
  })
];

export const TIME_AGENT_ALLOWED = ["get_running_timer", "list_time_entries", "time_summary", "list_time_projects", "get_time_for_item", "suggest_time_entries", "log_time"] as const;
export const TIME_AGENT_NEVER = ["start_timer", "stop_timer", "update_time_entry", "discard_time_entry", "bulk_log_time", "create_time_project", "update_time_project"] as const;

export { entryRow, projectView, notFound };
