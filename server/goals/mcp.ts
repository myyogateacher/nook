import * as z from "zod/v4";
import { BIN_BUCKETS, BIN_DESCRIPTION, defineTool, McpToolError, notFound, restoreResult, type McpErrorCode, type McpKeyContext } from "../mcpToolKit";
import { restoreItem } from "../bin";
import { keyFilter } from "../keyResources";
import { linksOf } from "../links/service";
import {
  addKeyResult, checkIn, closeGoal, createGoal, createPeriod, currentPeriodId, deleteGoal, getGoal, GoalError, listCheckins, listGoals, listPeriods,
  progressSources, requireGoal, updateGoal, updateKeyResult
} from "./service";
import { checkinSchema, closeSchema, goalInputSchema, goalPatchSchema, krInputSchema, krPatchSchema, periodSchema } from "./schemas";
import { GOAL_HEALTHS, GOAL_STATES } from "../../shared/goals";

/**
 * Goals MCP tools (lane GOALS, §D.3, §B.15, D814): `goals:read` / `goals:write`. Every tool runs the
 * service as the key's owner, so a key reads and changes only goals its person can (T542: checking in
 * needs edit, which contributors hold); chosen-item keys reach the goals they name (key results anchor
 * on their goal). Linking work is the cross-module `link_items` (relation `contributes`). Nothing is
 * deleted forever: `bin_goal` moves a goal to the Bin.
 */

const CODES: Record<string, McpErrorCode> = { NOT_FOUND: "NOT_FOUND", READ_ONLY: "READ_ONLY", OWNER_ONLY: "OWNER_ONLY", CONFLICT: "CARD_CHANGED", INVALID: "INVALID" };

async function run<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GoalError) {
      if (error.status === 404) throw notFound(error.message.replace(/ not found$/, ""));
      throw new McpToolError(error.code === "CONFLICT" ? "CARD_CHANGED" : CODES[error.code] ?? "INVALID", error.message);
    }
    if (error instanceof z.ZodError) throw new McpToolError("INVALID", "Invalid arguments", { details: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) });
    throw error;
  }
}

const goalId = z.string().uuid().describe("The goal's id (list_goals returns it)");
const krId = z.string().uuid().describe("The key result's id (get_goal lists them)");

/** A chosen-items key may name a goal only inside its reach (runTool checks `items`); lists narrow by SQL. */
const listFilter = (key: McpKeyContext) => keyFilter(key, "goals:read", { goal: "g.id" });

export const goalTools = [
  defineTool({
    name: "list_goals",
    title: "List goals",
    description: "Goals the user can open: filter by period, owner, team, parent (\"root\" for top-level), state, health, or text; `mine` for goals they own or contribute to. `tree: true` returns a whole period's alignment tree (up to 500, each with parentId); otherwise pages of up to 100 with `cursor`. Each goal has progress 0–1 (owner-computed; hiddenChildCount says how many sub-goals the user cannot open), health, and checkinDue.",
    scopes: ["goals:read"],
    access: { mode: "list", lists: ["goal"], related: ["periodId", "ownerId", "teamId", "parentId"] },
    write: false,
    inputSchema: z.object({
      periodId: z.string().uuid().optional(), ownerId: z.string().uuid().optional(), teamId: z.string().uuid().optional(),
      parentId: z.union([z.literal("root"), z.string().uuid()]).optional(), state: z.enum(GOAL_STATES).optional(), health: z.enum(GOAL_HEALTHS).optional(),
      mine: z.boolean().optional(), query: z.string().max(200).optional(), includeClosed: z.boolean().optional(), tree: z.boolean().optional(),
      cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional()
    }).strict(),
    handler: (args, key) => run(() => listGoals(key.userId, {
      period: args.periodId, owner: args.ownerId, team: args.teamId, parent: args.parentId, state: args.state, health: args.health, mine: args.mine, q: args.query,
      includeClosed: args.includeClosed, view: args.tree ? "tree" : "list", keyFilter: listFilter(key)
    }, { cursor: args.cursor, limit: args.limit ?? 50 }))
  }),
  defineTool({
    name: "get_goal",
    title: "Get a goal",
    description: "One goal: its key results (current, start, target, progress, and source, recomputed when stale), sub-goals the user can open, contributors, the last check-in, and linked work (cards, notes, deals… that contribute to it).",
    scopes: ["goals:read"],
    access: { mode: "items", items: [{ arg: "goalId", kind: "goal" }] },
    write: false,
    inputSchema: z.object({ goalId }).strict(),
    handler: ({ goalId: id }, key) => run(async () => {
      const goal = await getGoal(id, key.userId);
      const links = linksOf({ kind: "goal", id: goal.id }, { userId: key.userId }).filter((link) => link.relation === "contributes" || link.relation === "relates")
        .map((link) => ({ relation: link.relation, direction: link.direction, item: link.other }));
      return { goal, linkedWork: links };
    })
  }),
  defineTool({
    name: "create_goal",
    title: "Create a goal",
    description: "Create a goal (objective or KPI) owned by the user unless ownerId is given, optionally aligned to a parent goal, in a period (the current period when periodId is left out; null for none), with key results. A key result's `source` makes it update itself: `{ kind: \"tasks\", config: { scope: \"board\", id: <boardId>, measure: \"cards\" } }` counts done cards of a board (scopes: board, view, filter with `query`, sprint, epic, tag). list_goal_sources lists every source.",
    scopes: ["goals:write"],
    access: { mode: "global", related: ["parentId", "periodId", "teamId", "ownerId", "contributorIds", "keyResults"] },
    write: true,
    annotations: { idempotentHint: false },
    inputSchema: goalInputSchema,
    // Left out, the period is the current one, as in the web app's New goal sheet (D1148).
    handler: (args, key) => run(() => createGoal(key.userId, (args.periodId === undefined ? { ...args, periodId: currentPeriodId() } : args) as never))
  }),
  defineTool({
    name: "update_goal",
    title: "Update a goal",
    description: "Change a goal's title, description, parent, period, team, dates, state (draft/active), health, progress mode, check-in cadence, or contributors. Changing the owner or who can open it needs the owner or a manager. Send expectedRevision to refuse a change made meanwhile.",
    scopes: ["goals:write"],
    access: { mode: "items", items: [{ arg: "goalId", kind: "goal" }], related: ["parentId", "periodId", "teamId", "ownerId", "contributorIds"] },
    write: true,
    inputSchema: goalPatchSchema.extend({ goalId }).strict(),
    handler: ({ goalId: id, ...patch }, key) => run(() => updateGoal(key.userId, id, patch as never))
  }),
  defineTool({
    name: "add_kr",
    title: "Add a key result",
    description: "Add a key result to a goal: metric number, percent, currency, boolean, or milestones; direction increase, decrease, stay_above, stay_below; start, target, current; optional weight and source (see create_goal).",
    scopes: ["goals:write"],
    access: { mode: "items", items: [{ arg: "goalId", kind: "goal" }], related: ["ownerId", "milestones"] },
    write: true,
    annotations: { idempotentHint: false },
    inputSchema: krInputSchema.extend({ goalId }).strict(),
    handler: ({ goalId: id, ...input }, key) => run(() => addKeyResult(key.userId, id, input as never))
  }),
  defineTool({
    name: "update_kr",
    title: "Update a key result",
    description: "Change a key result: title, owner, metric, direction, start, target, current (manual ones), weight, milestones, or source (`{ kind: \"manual\" }` turns automatic updates off).",
    scopes: ["goals:write"],
    access: { mode: "items", items: [{ arg: "keyResultId", kind: "key_result" }], related: ["ownerId", "milestones"] },
    write: true,
    inputSchema: krPatchSchema.extend({ keyResultId: krId }).strict(),
    handler: ({ keyResultId, ...patch }, key) => run(() => updateKeyResult(key.userId, keyResultId, patch as never))
  }),
  defineTool({
    name: "check_in_goal",
    title: "Check in on a goal",
    description: "Record a check-in: health (on_track, at_risk, off_track, none), confidence 1–10, a note, and new values for manual key results (`values: { <keyResultId>: number }`; true/false for boolean ones; `milestonesDone: { <keyResultId>: [milestoneId…] }`). Automatic key results update themselves. Needs edit on the goal (owners, contributors, editors).",
    scopes: ["goals:write"],
    access: { mode: "items", items: [{ arg: "goalId", kind: "goal" }] },
    write: true,
    annotations: { idempotentHint: false },
    inputSchema: checkinSchema.extend({ goalId }).strict(),
    handler: ({ goalId: id, ...input }, key) => run(() => {
      const result = checkIn(key.userId, id, input as never);
      return { checkin: result.checkin, progress: result.goal.progress, health: result.goal.health };
    })
  }),
  defineTool({
    name: "list_goal_checkins",
    title: "List a goal's check-ins",
    description: "A goal's check-ins, newest first, with health, confidence, note, values typed, and the goal's progress then. Pages with cursor.",
    scopes: ["goals:read"],
    access: { mode: "items", items: [{ arg: "goalId", kind: "goal" }] },
    write: false,
    inputSchema: z.object({ goalId, cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    handler: ({ goalId: id, cursor, limit }, key) => run(() => listCheckins(key.userId, id, { cursor, limit }))
  }),
  defineTool({
    name: "close_goal",
    title: "Close a goal",
    description: "Close a goal as achieved, missed, dropped, or carried_over (with carryOver.periodId: a copy continues in that period, linked to this one). Its final progress is kept.",
    scopes: ["goals:write"],
    access: { mode: "items", items: [{ arg: "goalId", kind: "goal" }], related: ["carryOver"] },
    write: true,
    inputSchema: closeSchema.extend({ goalId }).strict(),
    handler: ({ goalId: id, ...input }, key) => run(async () => {
      const result = await closeGoal(key.userId, id, input as never);
      return { state: result.goal.state, finalProgress: result.goal.finalProgress, carriedOver: result.carriedOver };
    })
  }),
  defineTool({
    name: "list_goal_periods",
    title: "List goal periods",
    description: "The workspace's goal periods (\"Q1 2027\"), newest first, with dates, whether each is current, and how many goals the user can open in it.",
    scopes: ["goals:read"],
    access: { mode: "global" },
    write: false,
    inputSchema: z.object({ includeArchived: z.boolean().optional() }).strict(),
    handler: ({ includeArchived }, key) => run(() => ({ periods: listPeriods(key.userId, { includeArchived }) }))
  }),
  defineTool({
    name: "create_goal_period",
    title: "Create a goal period",
    description: "Create a workspace goal period with a name and start and end dates (YYYY-MM-DD).",
    scopes: ["goals:write"],
    access: { mode: "global" },
    write: true,
    annotations: { idempotentHint: false },
    inputSchema: periodSchema,
    handler: (args, key) => run(() => ({ period: createPeriod(key.userId, args) }))
  }),
  defineTool({
    name: "list_goal_sources",
    title: "List progress sources",
    description: "The progress sources a key result can use (manual, tasks, and those other modules provide, such as time or contacts when installed).",
    scopes: ["goals:read"],
    access: { mode: "global" },
    write: false,
    inputSchema: z.object({}).strict(),
    handler: () => ({ sources: progressSources() })
  }),
  defineTool({
    name: "get_goal_tree",
    title: "Get the goal alignment tree",
    description: "A period's goals as a nested tree (company → team → personal), each node with progress, health, and its children the user can open. Omit periodId for goals without a period.",
    scopes: ["goals:read"],
    access: { mode: "list", lists: ["goal"], related: ["periodId"] },
    write: false,
    inputSchema: z.object({ periodId: z.string().uuid().optional(), includeClosed: z.boolean().optional() }).strict(),
    handler: ({ periodId, includeClosed }, key) => run(() => {
      const { goals } = listGoals(key.userId, { period: periodId ?? "none", includeClosed, view: "tree", keyFilter: listFilter(key) });
      type Node = { id: string; title: string; progress: number; health: string; state: string; owner: string; children: Node[] };
      const nodes = new Map<string, Node>(goals.map((goal) => [goal.id, { id: goal.id, title: goal.title, progress: goal.progress, health: goal.health, state: goal.state, owner: goal.owner.name, children: [] }]));
      const roots: Node[] = [];
      for (const goal of goals) {
        const node = nodes.get(goal.id)!;
        const parent = goal.parentId ? nodes.get(goal.parentId) : undefined;
        if (parent) parent.children.push(node); else roots.push(node);
      }
      return { tree: roots };
    })
  }),
  defineTool({
    name: "bin_goal",
    title: "Move a goal to the Bin",
    description: `Move a goal (with its key results and check-ins) to the Bin. Needs the owner or a manager. ${BIN_DESCRIPTION}`,
    scopes: ["goals:write"],
    alsoRequires: ["bin:write"],
    access: { mode: "items", items: [{ arg: "goalId", kind: "goal" }] },
    write: true,
    buckets: BIN_BUCKETS,
    annotations: { destructiveHint: true },
    inputSchema: z.object({ goalId }).strict(),
    handler: ({ goalId: id }, key) => run(() => deleteGoal(key.userId, id))
  }),
  defineTool({
    name: "restore_goal", title: "Restore a goal from the Bin",
    description: "Restores a goal you own from the Bin, with its key results and check-ins.",
    scopes: ["goals:write"], alsoRequires: ["bin:write"], access: { mode: "items", items: [{ arg: "goalId", kind: "goal" }] }, write: true,
    inputSchema: z.object({ goalId: z.string().uuid() }).strict(),
    // D1385: the restore every bin_* tool's description promises, through the module's Bin provider.
    handler: async ({ goalId }, key) => restoreResult(await restoreItem("goal", goalId.toLowerCase(), key.userId), "Goal")
  })
];

/** Reads are offered to chat agents; writes too except binning (agents check in through proposals where the mode asks, §B.15). */
export const goalAgentTools = {
  allowed: ["list_goals", "get_goal", "list_goal_checkins", "list_goal_periods", "list_goal_sources", "get_goal_tree", "check_in_goal", "create_goal", "update_goal", "add_kr", "update_kr"],
  never: ["bin_goal", "close_goal", "create_goal_period"]
};

export { requireGoal };
