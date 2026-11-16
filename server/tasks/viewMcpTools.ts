import * as z from "zod/v4";
import { defineTool, McpToolError, type McpToolSpec } from "../mcpToolKit";
import { keyContainerIds } from "../keyResources";
import { validTimeZone } from "../today/registry";
import { TASK_QUERY_LIMITS } from "../../shared/taskQuery";
import { QUERY_GROUPS, QUERY_SORTS, queryCards, type QueriedCard, type QueryResult } from "./query";
import { taskQueryRateLimited } from "./queryRoutes";
import { TaskError } from "./service";
import { LANE_MODES } from "../../shared/taskLanes";
import { listViews, pinnedViewsFor, saveView, viewCards, VIEW_GROUPS, VIEW_LAYOUTS } from "./views";

/**
 * MCP tools for saved views and the cross-board query (research 2026-09-26
 * §10.5, D145): `list_views` and `query_cards`, both `tasks:read`, in the read
 * bucket, not audited, as other reads. They call the same services as
 * `GET /api/tasks/views` and `POST /api/tasks/query`, as the key's owner, so a
 * view or filter never reaches a board the owner cannot read (T115) and ids
 * of such boards resolve as `restricted` (T116). `save_view` is the one view write.
 * `query_cards` shares the per-user query limit with the REST routes (T117). Lane VIEWS2 adds
 * `save_view` (`tasks:write`, D660): create a private view or change an owned one.
 */

export const MCP_QUERY_PAGE_MAX = 50;

const uuid = z.string().uuid();

/** A card as MCP lists it: names instead of ids for people and tags, the plain-text excerpt, no description. */
function mcpCard(card: QueriedCard) {
  return {
    id: card.id,
    board_id: card.board_id,
    board_name: card.board_name,
    column_id: card.column_id,
    column_name: card.column_name,
    state: card.column_state,
    title: card.title,
    description_excerpt: card.description_excerpt,
    revision: card.revision,
    creator_name: card.creator_name,
    due_on: card.due_on,
    due_time: card.due_time,
    due_tz: card.due_tz,
    due_at: card.due_at,
    start_on: card.start_on,
    start_time: card.start_time,
    start_tz: card.start_tz,
    start_at: card.start_at,
    assignees: card.assignees.map((assignee) => assignee.display_name),
    assignee_name: card.assignees[0]?.display_name ?? null,
    tags: card.tags.map((tag) => tag.name),
    flags: card.flags,
    priority: card.priority,
    // Hierarchy (17A, D138): the level and the parent on the same board.
    parent_id: card.parent_card_id,
    parent_title: card.parent_title,
    level: card.level,
    // Sprints (17B): the card's sprint (inherited below the work level) and its name.
    sprint_id: card.sprint_id,
    sprint_name: card.sprint_name,
    updated_at: card.updated_at
  };
}

const mcpResult = (result: QueryResult) => ({
  query: result.query,
  cards: result.cards.map(mcpCard),
  nextCursor: result.nextCursor,
  ...(result.total !== undefined ? { total: result.total } : {}),
  ...(result.refs ? { refs: result.refs } : {})
});

/** TaskError to the MCP error shape: 404 is NOT_FOUND, 400 is INVALID with the service code (FILTER_INVALID, CURSOR_INVALID, …) as `reason`. */
function run<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof TaskError)) throw error;
    if (error.status === 404) throw new McpToolError("NOT_FOUND", error.message);
    if (error.status === 400) throw new McpToolError("INVALID", error.message, { ...(error.code ? { reason: error.code } : {}), ...error.extra });
    throw new McpToolError("INTERNAL", error.message);
  }
}

export const taskViewTools: McpToolSpec[] = [
  defineTool({
    name: "list_views",
    title: "List saved task views",
    description: "List the saved cross-board task views the user can open: their own, views shared with them, and views shared with everyone. Each has a filter in the task query language; run one with query_cards. board_id is set when the view is on one board the user can read (it opens as that board with the filter); pinned_board_ids lists the boards a board owner pinned it on for everyone who reads them; lanes is how its board layout groups cards across boards (columns: merged by column name and state; state: to do, in progress, done).",
    scopes: ["tasks:read"],
    access: { mode: "list", lists: ["task_view"] },
    write: false,
    inputSchema: z.object({}).strict(),
    handler: (_args, key) => {
      const { mine, shared, everyone } = listViews(key.userId);
      // A key limited to chosen items lists only the views it was given (T203); board grants give
      // no views, since a view reaches across boards.
      const chosen = keyContainerIds(key, "tasks:read", "task_view");
      // Lane VIEWS2 (D663): views pinned on boards the user can read are listed too, marked with the
      // boards they are pinned on (only boards the key reaches).
      const pins = pinnedViewsFor(key.userId);
      const chosenBoards = keyContainerIds(key, "tasks:read", "board");
      const listed = [...mine, ...shared, ...everyone];
      const all = [...listed, ...pins.views.filter((view) => !listed.some((item) => item.id === view.id))];
      return {
        views: all.filter((view) => chosen === null || chosen.includes(view.id)).map((view) => ({
          pinned_board_ids: (pins.boardsOf.get(view.id) ?? []).filter((boardId) => chosenBoards === null || chosenBoards.includes(boardId)),
          id: view.id, name: view.name, owner_name: view.owner_name, is_owner: view.is_owner, visibility: view.visibility, query: view.query,
          // Lane VIEWS (D645): the one board the view is on (null across boards), and its board lanes.
          board_id: view.board_id, lanes: view.display.lanes ?? "columns",
          // Lane VIEWS2 (D660): what save_view needs to change it.
          layout: view.display.layout, revision: view.revision
        }))
      };
    }
  }),
  defineTool({
    name: "query_cards",
    title: "Query cards across boards",
    description: [
      "Find cards across every board the user can open, with a saved view (viewId) or a filter in the task query language (filter); give exactly one.",
      "Terms are separated by spaces and must all match; values after a colon are alternatives: assignee:me,none state:todo,doing due:overdue,week.",
      "Keys: board:<id>, state:todo|doing|done, column:<id> (needs exactly one board:), assignee:me|none|<userId>, creator:me|<userId>, tag:<id>|<name>|none,",
      "priority:urgent|high|medium|low|none, flag:blocked|needs_review|on_hold|none (flag:urgent is read as priority:urgent), due:overdue|today|week|next-week|none|YYYY-MM-DD|<YYYY-MM-DD|>YYYY-MM-DD, has:relation|blocked|subtasks, parent:<cardId>|none, level:0|1|2|work, sprint:current|next|none|<sprintId> (current and next per board; subtasks follow their task),",
      "and \"quoted text\" for title or excerpt text. A leading - negates a term. Results are paged: pass nextCursor back as cursor."
    ].join(" "),
    scopes: ["tasks:read"],
    access: { mode: "list", lists: ["board"], items: [{ arg: "viewId", kind: "task_view", ifAbsent: "allow" }] },
    write: false,
    inputSchema: z.object({
      viewId: uuid.optional().describe("A saved view from list_views; runs its filter, sort, and grouping as this user"),
      filter: z.string().max(TASK_QUERY_LIMITS.length).optional().describe("A filter in the task query language; an empty string matches every card"),
      sort: z.enum(QUERY_SORTS).optional().describe("With filter: due (default), updated, created, title, board, start, or priority (urgent first, none last)"),
      group: z.enum(QUERY_GROUPS).optional().describe("With filter: none (default), board, state, or due (overdue, today, this week, later, none)"),
      cursor: z.string().min(1).max(1024).optional().describe("nextCursor from the previous page of the same query"),
      limit: z.number().int().min(1).max(MCP_QUERY_PAGE_MAX).optional().describe(`Cards per page, 1 to ${MCP_QUERY_PAGE_MAX} (default 50)`),
      tz: z.string().max(64).optional().describe("IANA time zone for today, week, and overdue; defaults to UTC")
    }).strict(),
    handler: ({ viewId, filter, sort, group, cursor, limit, tz }, key) => {
      if ((viewId === undefined) === (filter === undefined)) throw new McpToolError("INVALID", "Give exactly one of viewId or filter");
      if (viewId !== undefined && (sort !== undefined || group !== undefined)) throw new McpToolError("INVALID", "A view has its own sort and grouping; sort and group go with filter");
      const zone = validTimeZone(tz ?? "UTC");
      if (!zone) throw new McpToolError("INVALID", "tz must be an IANA time zone");
      const page = { cursor, limit: limit ?? MCP_QUERY_PAGE_MAX, tz: zone };
      // Views and filters alike: a cross-board query is the expensive read (T117).
      const retryAfter = taskQueryRateLimited(key.userId);
      if (retryAfter) throw new McpToolError("RATE_LIMITED", "Too many queries. Try again in a moment.", { retryAfterSeconds: retryAfter });
      return run(() => {
        if (viewId !== undefined) {
          // runTool checked the view is one this key was given (or the key reaches every item): a
          // view grant runs the view as its owner reads it, across boards.
          const { view, ...result } = viewCards(key.userId, viewId, page);
          return { view: { id: view.id, name: view.name, owner_name: view.owner_name }, ...mcpResult(result) };
        }
        // A filter runs only over the boards a key limited to chosen items was given.
        const boardIds = keyContainerIds(key, "tasks:read", "board");
        return mcpResult(queryCards(key.userId, { q: filter!, sort, group, ...page, ...(boardIds ? { boardIds } : {}) }));
      });
    }
  }),
  // Lane VIEWS2 (D660, T449): the one view write. Sharing and pinning stay in the app (D180).
  defineTool({
    name: "save_view",
    title: "Save a task view",
    description: [
      "Create a private saved view of cards (omit viewId; name and filter required), or change a view the user owns (viewId and baseRevision from list_views, plus any of name, filter, layout, group, sort, lanes).",
      "The filter is the task query language of query_cards; a view whose filter has exactly one board: term opens as that board in the app.",
      "If the view changed since baseRevision the call fails with VIEW_CHANGED and the current revision. Views are private when made here; sharing and pinning are done in the app. Up to 50 views per person."
    ].join(" "),
    scopes: ["tasks:write"],
    // A view reaches across every board the user can read, so only a key over the whole module may write one (T449).
    access: { mode: "global", related: ["viewId"] },
    write: true,
    dailyBucket: "task_write",
    inputSchema: z.object({
      viewId: uuid.optional().describe("The view to change (from list_views); omit to create a view"),
      baseRevision: z.number().int().min(1).optional().describe("With viewId: the revision from list_views"),
      name: z.string().trim().min(1).max(80).optional().describe("Up to 80 characters"),
      filter: z.string().max(TASK_QUERY_LIMITS.length).optional().describe("A filter in the task query language, as for query_cards"),
      layout: z.enum(VIEW_LAYOUTS).optional().describe("list (default), table, board, or timeline (a Gantt of start and due dates; a view on one board opens in it, a cross-board view shows it as the list)"),
      group: z.enum(VIEW_GROUPS).optional().describe("The list's grouping: none, board, state, due, assignee, or tag"),
      sort: z.enum(QUERY_SORTS).optional().describe("due (default), updated, created, title, board, start, or priority (urgent first, none last)"),
      lanes: z.enum(LANE_MODES).optional().describe("The board layout's lanes across boards: columns (default), state, assignee, tag, sprint, due, or board")
    }).strict(),
    handler: async ({ viewId, baseRevision, name, filter, layout, group, sort, lanes }, key) => {
      if (name !== undefined && /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/.test(name)) throw new McpToolError("INVALID", "Names cannot contain control characters");
      const display = { ...(layout ? { layout } : {}), ...(group ? { group } : {}), ...(sort ? { sort } : {}), ...(lanes ? { lanes } : {}) };
      try {
        const saved = await saveView(key.userId, { viewId, baseRevision, name, filter, ...(Object.keys(display).length ? { display } : {}) });
        const view = saved.view;
        return { created: saved.created, view: { id: view.id, name: view.name, query: view.query, visibility: view.visibility, board_id: view.board_id, layout: view.display.layout, lanes: view.display.lanes ?? "columns", revision: view.revision } };
      } catch (error) {
        if (!(error instanceof TaskError)) throw error;
        if (error.status === 404) throw new McpToolError("NOT_FOUND", error.message);
        if (error.code === "VIEW_CHANGED") {
          const current = (error.extra as { view?: { revision: number } } | undefined)?.view;
          throw new McpToolError("VIEW_CHANGED", error.message, current ? { currentRevision: current.revision } : {});
        }
        if (error.code === "OWNER_ONLY") throw new McpToolError("OWNER_ONLY", error.message);
        if (error.code === "LIMIT_REACHED") throw new McpToolError("LIMIT_REACHED", error.message);
        if (error.code === "VIEW_SHARED_READ_ONLY") throw new McpToolError("READ_ONLY", error.message, { reason: error.code });
        if (error.status === 400) throw new McpToolError("INVALID", error.message, { ...(error.code ? { reason: error.code } : {}), ...error.extra });
        throw new McpToolError("INTERNAL", error.message);
      }
    }
  })
];
