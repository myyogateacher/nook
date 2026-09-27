import * as z from "zod/v4";
import type { ZodType } from "zod";
import { withAuditContext } from "../db";
import { defineTool, McpToolError, type McpErrorCode, type McpKeyContext, type McpToolSpec } from "../mcpToolKit";
import { searchText } from "../search";
import { listAttachments } from "./attachments";
import { createRelation, getBoardWithRelationCounts, listRelations, type CardRelation, type RelationCounts } from "./cardRelations";
import { searchCards } from "./cardSearch";
import { parseCardSearchQuery, relationCreateSchema } from "./relationRoutes";
import { RELATION_TYPES, type RelationType } from "./relations";
import { createComment, listComments } from "./comments";
import { QUERY_LIMITS, TASK_FLAGS, type CardFilter } from "../../shared/taskQuery";
import { filterBoardCardIds } from "./cardQuery";
import { cardCreateSchema, cardMoveSchema, cardPatchSchema, commentCreateSchema, isCalendarDate } from "./routes";
import { cardDetail, createCard, getBoard, getCard, listBoards, moveCard, patchCard, TaskError, type CardSummary } from "./service";
import { listBoardTags, type BoardTag } from "./tags";
import { taskViewTools } from "./viewMcpTools";
import { boardStructure, cardHierarchy } from "./hierarchy";
import { levelName, type BoardStructure } from "../../shared/boardStructure";
import { SPRINT_STATES } from "../../shared/sprintPlan";
import { openSprintRows, sprintNames } from "./sprintData";
import { listSprints } from "./sprints";

/**
 * MCP tools for Task Boards (docs/plan/WAVES_7-9.md §4.2, D38–D40, D70).
 *
 * Every tool calls the same service functions as the /api/tasks routes, as the
 * key's owner, so board membership, owner-only rules, IDOR joins, ordering,
 * and caps are enforced in one place. A board the user cannot read is
 * NOT_FOUND whether it is missing, private, or binned. There are no delete,
 * unlink, edit-description, column, WIP, or sharing tools: writes are create,
 * update (fields other than the description, with a revision compare-and-swap,
 * WAVE_13 §5.5, T99), move, comment, and link_cards. Writes are audited through the usual task.* events with
 * `{via: "mcp", keyId}` merged in, and count against the per-key and per-user
 * `task_write` daily buckets.
 */

const DESCRIPTION_PREVIEW_CHARS = 280;

/**
 * Maps a TaskError to the MCP error shape, keeping its code and extra fields
 * (STALE_POSITION's order, COLUMN_FULL's counts). CARD_CHANGED carries only
 * `currentRevision`, not the stored card: agents re-read it with get_card,
 * which returns plain text. Other 400s (ASSIGNEE_NOT_MEMBER among them) are
 * INVALID, with the service code as `reason`.
 */
export function taskErrorToMcp(error: TaskError) {
  const known: Partial<Record<string, McpErrorCode>> = {
    STALE_POSITION: "STALE_POSITION",
    LIMIT_REACHED: "LIMIT_REACHED",
    CARD_CHANGED: "CARD_CHANGED",
    OWNER_ONLY: "OWNER_ONLY",
    COLUMN_FULL: "COLUMN_FULL",
    RELATION_EXISTS: "RELATION_EXISTS",
    // A level change on a card with children (17A): reported as INVALID with the reason and childCount.
    HAS_CHILDREN: "INVALID",
    // Planning a card into a completed sprint (17B): INVALID with the reason and sprintId.
    SPRINT_COMPLETED: "INVALID"
  };
  const code = (error.code ? known[error.code] : undefined) ?? (error.status === 404 ? "NOT_FOUND" : error.status === 400 ? "INVALID" : "INTERNAL");
  if (code === "CARD_CHANGED") {
    const current = error.extra.card as { revision?: unknown } | undefined;
    return new McpToolError(code, error.message, typeof current?.revision === "number" ? { currentRevision: current.revision } : undefined);
  }
  if (code === "RELATION_EXISTS") {
    const existing = error.extra.relation as CardRelation | undefined;
    return new McpToolError(code, error.message, existing ? { relation: mcpRelation(existing) } : undefined);
  }
  if (code === "INVALID" && error.code) return new McpToolError(code, error.message, { reason: error.code, ...error.extra });
  return new McpToolError(code, error.message, error.extra);
}

async function service<T>(key: McpKeyContext, operation: () => T | Promise<T>): Promise<T> {
  try {
    return await withAuditContext({ via: "mcp", keyId: key.keyId }, operation);
  } catch (error) {
    if (error instanceof TaskError) throw taskErrorToMcp(error);
    throw error;
  }
}

/** Validates with the HTTP route's schema, so MCP accepts exactly what the API accepts. */
function routeInput<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new McpToolError("INVALID", "Invalid arguments", { details: parsed.error.issues.map((issue) => issue.message) });
  return parsed.data;
}

/** Card Markdown as plain text; the MCP client never receives markup to render. */
const plainText = (markdown: string) => searchText(markdown);

function preview(markdown: string) {
  const text = plainText(markdown).replace(/\s+/g, " ").trim();
  return text.length > DESCRIPTION_PREVIEW_CHARS ? `${text.slice(0, DESCRIPTION_PREVIEW_CHARS - 1)}…` : text;
}

/**
 * A relation as agents see it, from the card they asked about (WAVE_13 §5.5): the other card's id,
 * title, and board name, or only `{ type, restricted: true }` when the user cannot read it (T90).
 */
export function mcpRelation(relation: CardRelation) {
  if (relation.restricted) return { type: relation.type, restricted: true as const };
  return { type: relation.type, cardId: relation.card.id, title: relation.card.title, boardName: relation.card.board_name, columnName: relation.card.column_name, isDone: relation.card.is_done === 1 };
}

const attachmentNames = (cardId: string) => listAttachments(cardId).map((attachment) => attachment.name);

type CardWithDescription = CardSummary & { description?: string };

/** Tag names by id for one board; card tags are always tags of the card's own board. */
const tagNames = (tags: readonly BoardTag[]) => new Map(tags.map((tag) => [tag.id, tag.name]));

/**
 * Fields every card view shares (Wave 13): the zone and instant with a time,
 * assignees and tags as names, flags, and the plain-text excerpt.
 */
const cardFields = (card: CardSummary, tags: Map<string, string>, structure?: BoardStructure, sprints?: Map<string, string>) => ({
  description_excerpt: card.description_excerpt,
  due_on: card.due_on,
  due_time: card.due_time,
  due_tz: card.due_tz,
  due_at: card.due_at,
  assignees: card.assignees.map((assignee) => assignee.display_name),
  assignee_name: card.assignee_name,
  tags: card.tag_ids.map((id) => tags.get(id)).filter((name): name is string => name !== undefined),
  flags: card.flags,
  // Hierarchy (17A, D139): the parent on the same board, the level and its name, and live direct children.
  parent_id: card.parent_card_id,
  level: card.level,
  ...(structure ? { level_name: levelName(structure, card.level) } : {}),
  child_count: card.child_count,
  done_child_count: card.done_child_count,
  // Sprints (17B, D139): the card's sprint (inherited below the work level) and its name.
  sprint_id: card.sprint_id,
  ...(sprints ? { sprint_name: card.sprint_id ? sprints.get(card.sprint_id) ?? null : null } : {})
});

/**
 * Tag references (names, ignoring case, or ids) to ids of this board's tags.
 * `none` is kept for filters only. Anything else is INVALID with the unknown
 * values, so an agent can correct a typo; MCP never creates tags.
 */
function resolveTags(tags: readonly BoardTag[], refs: readonly string[], allowNone: boolean) {
  const unknown: string[] = [];
  const ids = refs.flatMap((ref) => {
    if (allowNone && ref === "none") return ["none"];
    const key = ref.trim().toLowerCase();
    const tag = tags.find((candidate) => candidate.id === key) ?? tags.find((candidate) => candidate.name.toLowerCase() === key);
    if (!tag) unknown.push(ref);
    return tag ? [tag.id] : [];
  });
  if (unknown.length) throw new McpToolError("INVALID", "Unknown tag", { reason: "UNKNOWN_TAG", tags: unknown, known: tags.map((tag) => tag.name) });
  return ids;
}

function listedCard(card: CardWithDescription, columnName: string | undefined, tags: Map<string, string>, counts: RelationCounts, structure?: BoardStructure, sprints?: Map<string, string>) {
  return {
    id: card.id,
    column_id: card.column_id,
    column_name: columnName ?? null,
    position: card.position,
    title: card.title,
    description_preview: card.description === undefined ? undefined : preview(card.description),
    revision: card.revision,
    creator_name: card.creator_name,
    ...cardFields(card, tags, structure, sprints),
    comment_count: card.comment_count,
    relation_count: counts.relation_count,
    open_blockers: counts.open_blockers,
    attachments: attachmentNames(card.id),
    updated_at: card.updated_at
  };
}

const uuid = z.string().uuid();

/** A card as create_card and update_card return it. */
const writtenCard = (card: CardSummary) => ({
  id: card.id, board_id: card.board_id, column_id: card.column_id, title: card.title, revision: card.revision,
  ...cardFields(card, tagNames(listBoardTags(card.board_id)), boardStructure(card.board_id), sprintNames(card.board_id))
});

/** A child as get_card and list_children return it (live, by column then position, at most 100). */
const mcpChild = (child: ReturnType<typeof cardHierarchy>["children"][number], structure: BoardStructure) => ({
  id: child.id, title: child.title, level: child.level, level_name: levelName(structure, child.level), column_id: child.column_id, column_name: child.column_name,
  is_done: child.is_done === 1, due_on: child.due_on, child_count: child.child_count, done_child_count: child.done_child_count
});

const dueTimeInput = z.string().describe("Due time as HH:MM (24-hour), in dueTz; needs a due date");
const dueTzInput = z.string().describe("IANA time zone of dueTime, for example Europe/Berlin");
const assigneeIdsInput = z.array(uuid).max(20).describe("User ids who can open the board (see the board's readers); replaces the whole set");
const tagsInput = z.array(z.string().min(1).max(64)).max(10).describe("Existing tags of the board, by name (any case) or id; replaces the whole set. Unknown tags are INVALID; tags are created in the app");
const flagsInput = z.array(z.enum(TASK_FLAGS)).max(TASK_FLAGS.length).describe("Flags from the fixed set; replaces the whole set");
const dateInput = z.string().refine(isCalendarDate, "Use a real date as YYYY-MM-DD");

/** list_cards filters (D113, §5.5): values inside one filter are OR-ed, filters are AND-ed. */
const listFilters = {
  assigneeIds: z.array(z.union([uuid, z.literal("me"), z.literal("none")])).max(QUERY_LIMITS.values).optional()
    .describe("Only cards assigned to any of these user ids; \"me\" is the key's user, \"none\" matches unassigned cards"),
  tags: z.array(z.string().min(1).max(64)).max(QUERY_LIMITS.values).optional()
    .describe("Only cards with any of these tags (names in any case, or ids); \"none\" matches untagged cards. Unknown tags are INVALID"),
  flags: z.array(z.enum([...TASK_FLAGS, "none"])).max(TASK_FLAGS.length + 1).optional().describe("Only cards with any of these flags; \"none\" matches unflagged cards"),
  dueBefore: dateInput.optional().describe("Only cards due strictly before this date (YYYY-MM-DD, the card's own calendar date)"),
  dueAfter: dateInput.optional().describe("Only cards due strictly after this date; with dueBefore, a range"),
  dueNone: z.boolean().optional().describe("true: also (or, alone, only) cards without a due date"),
  text: z.string().min(1).max(QUERY_LIMITS.textMax).optional().describe("Only cards whose title or description excerpt contains this text, ignoring case and accents"),
  sprint: z.union([z.enum(["current", "next", "none"]), uuid]).optional()
    .describe("Only cards in this sprint (see list_sprints): current (the active sprint), next (the first planned one), none (the backlog), or a sprint id. Subtasks count in their task's sprint")
};

export const taskTools: McpToolSpec[] = [
  defineTool({
    name: "list_boards",
    title: "List task boards",
    description: "List the task boards the user owns or is a member of, with card counts.",
    scopes: ["tasks:read"],
    write: false,
    inputSchema: z.object({}),
    handler: (_args, key) => ({ boards: listBoards(key.userId) })
  }),
  defineTool({
    name: "list_cards",
    title: "List cards on a board",
    description: "List a board's columns, its tags, and its cards in order. Optional filters narrow the cards: columnId, assigneeIds, tags, flags, dueBefore/dueAfter/dueNone, text, and sprint; values inside one filter are alternatives, and different filters must all match. Descriptions are shortened plain text; attachments are file names only. Use get_card for a full card.",
    scopes: ["tasks:read"],
    write: false,
    inputSchema: z.object({ boardId: uuid, columnId: uuid.optional().describe("Only cards in this column"), ...listFilters }),
    handler: async ({ boardId, columnId, assigneeIds, tags, flags, dueBefore, dueAfter, dueNone, text, sprint }, key) => service(key, () => {
      const { board, columns, cards, tags: boardTags } = getBoardWithRelationCounts(key.userId, boardId);
      if (columnId && !columns.some((column) => column.id === columnId)) throw new McpToolError("NOT_FOUND", "Column not found");
      const filter: CardFilter = {
        columns: columnId ? [columnId] : undefined,
        assignees: assigneeIds,
        tags: tags ? resolveTags(boardTags, tags, true) : undefined,
        flags,
        due: { before: dueBefore, after: dueAfter, none: dueNone },
        text
      };
      // Filtered on the server with bound SQL (D113); the listing keeps the board's order.
      const matching = new Set(filterBoardCardIds(board.id, filter, { userId: key.userId }));
      const names = new Map(columns.map((column) => [column.id, column.name]));
      const tagName = tagNames(boardTags);
      const structure = board.structure;
      const sprints = sprintNames(board.id);
      // The sprint filter (17B) reads each card's sprint as the board lists it (inherited below the work level).
      const open = sprint === "current" || sprint === "next" ? openSprintRows(board.id) : [];
      const wanted = sprint === "current" ? open.find((row) => row.state === "active")?.id ?? "" : sprint === "next" ? open.find((row) => row.state === "planned")?.id ?? "" : sprint;
      const inSprint = (card: CardSummary) => wanted === undefined || (wanted === "none" ? card.sprint_id === null : card.sprint_id === wanted.toLowerCase());
      return {
        board: {
          id: board.id, name: board.name, owner_name: board.owner_name, is_owner: board.is_owner, levels: structure.levels.map((level) => level.name), work_level: structure.workLevel,
          sprints_enabled: structure.sprints,
          // Read-only here; the owner sets them in Board settings (PATCH /boards/:b {structure}).
          ...(structure.sprintDefaults ? { sprint_defaults: { days: structure.sprintDefaults.days, start: structure.sprintDefaults.start, name_pattern: structure.sprintDefaults.name ?? null } } : {})
        },
        columns: columns.map((column) => ({ id: column.id, name: column.name, position: column.position, wip_limit: column.wip_limit })),
        tags: boardTags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color })),
        // Cards come from the board just authorized above.
        cards: cards.filter((card) => matching.has(card.id) && inSprint(card)).map((card) => listedCard(cardDetail(card.id) ?? card, names.get(card.column_id), tagName, card, structure, sprints))
      };
    })
  }),
  defineTool({
    name: "get_card",
    title: "Get a card",
    description: "Read one card: title, plain-text description, column, the latest comments, attachment names, and its relations to other cards (a card the user cannot open shows only as restricted).",
    scopes: ["tasks:read"],
    write: false,
    inputSchema: z.object({ cardId: uuid }),
    handler: async ({ cardId }, key) => service(key, () => {
      const { card, board } = getCard(key.userId, cardId);
      const { columns, tags } = getBoard(key.userId, board.id);
      const page = listComments(key.userId, cardId);
      const hierarchy = cardHierarchy(cardId);
      return {
        card: {
          id: card.id,
          board_id: board.id,
          board_name: board.name,
          column_id: card.column_id,
          column_name: columns.find((column) => column.id === card.column_id)?.name ?? null,
          title: card.title,
          description: plainText(card.description),
          revision: card.revision,
          creator_name: card.creator_name,
          ...cardFields(card, tagNames(tags), boardStructure(board.id), sprintNames(board.id)),
          parent_title: hierarchy.parent?.title ?? null,
          created_at: card.created_at,
          updated_at: card.updated_at
        },
        children: hierarchy.children.map((child) => mcpChild(child, boardStructure(board.id))),
        comments: page.comments.map((comment) => ({ id: comment.id, author_name: comment.author_name, body: comment.body, created_at: comment.created_at, edited_at: comment.edited_at })),
        hasMoreComments: page.hasMore,
        attachments: attachmentNames(cardId),
        relations: listRelations(key.userId, cardId).map(mcpRelation)
      };
    })
  }),
  defineTool({
    name: "list_children",
    title: "List a card's children",
    description: "List the live direct children of a card (its subtasks, or the stories of an epic), in checklist order: by column, then position. At most 100. Children are always on the card's own board.",
    scopes: ["tasks:read"],
    write: false,
    inputSchema: z.object({ cardId: uuid }),
    handler: async ({ cardId }, key) => service(key, () => {
      const { board } = getCard(key.userId, cardId);
      const structure = boardStructure(board.id);
      return { children: cardHierarchy(cardId).children.map((child) => mcpChild(child, structure)) };
    })
  }),
  defineTool({
    name: "list_sprints",
    title: "List a board's sprints",
    description: "List the sprints of a board the user can open: the active sprint first, then planned ones in order, then completed ones newest first (at most 20; pass nextCursor back as cursor for older ones). Counts are cards at the board's work level. Sprints are planned and completed by the board owner in the app; plan a card into one with create_card or update_card sprintId.",
    scopes: ["tasks:read"],
    write: false,
    inputSchema: z.object({
      boardId: uuid,
      state: z.enum(SPRINT_STATES).optional().describe("Only planned, active, or completed sprints"),
      cursor: z.string().min(1).max(256).optional().describe("nextCursor from the previous page of completed sprints")
    }).strict(),
    handler: async ({ boardId, state, cursor }, key) => service(key, () => {
      const { sprints, nextCursor } = listSprints(key.userId, boardId, { state, cursor });
      return {
        sprints: sprints.map((sprint) => ({
          id: sprint.id, name: sprint.name, goal: sprint.goal, state: sprint.state, is_active: sprint.is_active, start_on: sprint.start_on, end_on: sprint.end_on,
          completed_at: sprint.completed_at, card_count: sprint.card_count, done_count: sprint.done_count
        })),
        nextCursor
      };
    })
  }),
  defineTool({
    name: "search_cards",
    title: "Search cards by title",
    description: "Find cards by title across every board the user can open (case-insensitive substring match on titles only, not descriptions), for example to pick a card for link_cards. Cards on boardId come first. At most 20 results.",
    scopes: ["tasks:read"],
    write: false,
    inputSchema: z.object({
      query: z.string().min(1).max(100),
      boardId: uuid.optional().describe("List this board's cards first"),
      limit: z.number().int().min(1).max(20).optional()
    }),
    handler: ({ query, boardId, limit }, key) => {
      const parsed = parseCardSearchQuery({ q: query, boardId, limit: limit === undefined ? undefined : String(limit) });
      if ("error" in parsed) throw new McpToolError("INVALID", "Invalid arguments", { details: [parsed.error] });
      const { q, ...options } = parsed.value!;
      return searchCards(key.userId, q, options);
    }
  }),
  defineTool({
    name: "create_card",
    title: "Create a card",
    description: "Add a card to a column of a board the user can use. afterCardId: omit for the bottom, null for the top, or a card in that column to go after it. A column at its WIP limit refuses new cards with COLUMN_FULL.",
    scopes: ["tasks:write"],
    write: true,
    dailyBucket: "task_write",
    inputSchema: z.object({
      boardId: uuid,
      columnId: uuid,
      title: z.string().min(1).max(200),
      description: z.string().optional().describe("Markdown, up to 64 KiB"),
      dueOn: z.string().optional().describe("Due date as YYYY-MM-DD"),
      dueTime: dueTimeInput.optional(),
      dueTz: dueTzInput.optional(),
      assigneeIds: assigneeIdsInput.optional(),
      tags: tagsInput.optional(),
      flags: flagsInput.optional(),
      parentId: uuid.nullable().optional().describe("A card on the same board one level up to put this card under (see the board's levels in list_cards); its level then defaults to the parent's plus one"),
      level: z.number().int().min(0).max(2).optional().describe("0 is the top level; defaults to the parent's level plus one, else the board's work level"),
      sprintId: uuid.nullable().optional().describe("A planned or active sprint of the board (see list_sprints) to plan the card in; only for cards at the board's work level, since subtasks follow their parent"),
      afterCardId: uuid.nullable().optional()
    }),
    handler: async ({ boardId, tags, ...fields }, key) => {
      const input = routeInput(cardCreateSchema, fields);
      return service(key, async () => {
        // Tags resolve against this board, after the board's own read check (NOT_FOUND first).
        if (tags) input.tagIds = resolveTags(getBoard(key.userId, boardId).tags, tags, false);
        const { card } = await createCard(key.userId, boardId, input);
        return { card: writtenCard(card) };
      });
    }
  }),
  defineTool({
    name: "update_card",
    title: "Update a card",
    description: "Change a card's title, due date, due time, assignees, tags, flags, parent, level, or sprint on a board the user can use. The description cannot be changed here. baseRevision must be the revision from get_card or list_cards; if the card changed since, the call fails with CARD_CHANGED and the current revision. dueOn null clears the date and time; dueTime null clears only the time; assigneeIds, tags, and flags each replace the whole set ([] clears it). Tags must already exist on the board (by name or id).",
    scopes: ["tasks:write"],
    write: true,
    dailyBucket: "task_write",
    inputSchema: z.object({
      cardId: uuid,
      baseRevision: z.number().int().min(1),
      title: z.string().min(1).max(200).optional(),
      dueOn: z.string().nullable().optional().describe("Due date as YYYY-MM-DD, or null to clear"),
      dueTime: dueTimeInput.nullable().optional(),
      dueTz: dueTzInput.nullable().optional(),
      assigneeIds: assigneeIdsInput.optional(),
      tags: tagsInput.optional(),
      flags: flagsInput.optional(),
      parentId: uuid.nullable().optional().describe("Move the card under a card on the same board one level up, or null to take it out of its parent; the level stays unless level is also sent"),
      level: z.number().int().min(0).max(2).optional().describe("Change the card's level; refused (reason HAS_CHILDREN) while it has children"),
      sprintId: uuid.nullable().optional().describe("Plan the card in a planned or active sprint of its board, or null for the backlog; only at the board's work level (reason SPRINT_LEVEL otherwise)")
    }).strict(),
    handler: async ({ cardId, baseRevision, tags, ...fields }, key) => {
      return service(key, async () => {
        // Tags resolve against the card's own board, which the caller must be able to read.
        const tagIds = tags ? resolveTags(listBoardTags(getCard(key.userId, cardId).board.id), tags, false) : undefined;
        const input = routeInput(cardPatchSchema, { ...fields, ...(tagIds ? { tagIds } : {}), revision: baseRevision });
        const { card } = await patchCard(key.userId, cardId, input);
        return { card: writtenCard(card) };
      });
    }
  }),
  defineTool({
    name: "move_card",
    title: "Move a card",
    description: "Move a card to a column on the same board. afterCardId: omit for the bottom, null for the top, or a card in the target column. If the board changed, the call fails with STALE_POSITION and the column's current order. Moving into another column at its WIP limit fails with COLUMN_FULL.",
    scopes: ["tasks:write"],
    write: true,
    dailyBucket: "task_write",
    inputSchema: z.object({ cardId: uuid, columnId: uuid, afterCardId: uuid.nullable().optional() }),
    handler: async ({ cardId, columnId, afterCardId }, key) => {
      const input = afterCardId === undefined ? { columnId } : routeInput(cardMoveSchema, { columnId, afterCardId });
      return service(key, async () => {
        const { card } = await moveCard(key.userId, cardId, input);
        return { card: { id: card.id, column_id: card.column_id, position: card.position } };
      });
    }
  }),
  defineTool({
    name: "link_cards",
    title: "Link two cards",
    description: "Relate a card to another card the user can open, on the same or another board. type is seen from cardId toward targetCardId: relates_to, depends_on (the target must be done first), needed_by (this card must be done first), duplicates, or duplicated_by. Two cards have at most one relation (RELATION_EXISTS returns it); a card has at most 50. Links cannot be removed here. Linking never changes either card's revision.",
    scopes: ["tasks:write"],
    write: true,
    dailyBucket: "task_write",
    inputSchema: z.object({
      cardId: uuid,
      targetCardId: uuid,
      type: z.enum(RELATION_TYPES as [RelationType, ...RelationType[]])
    }).strict(),
    handler: async ({ cardId, targetCardId, type }, key) => {
      const input = routeInput(relationCreateSchema, { type, cardId: targetCardId });
      return service(key, async () => {
        const { relation } = await createRelation(key.userId, cardId, input);
        return { relation: mcpRelation(relation) };
      });
    }
  }),
  defineTool({
    name: "comment_on_card",
    title: "Comment on a card",
    description: "Add a comment, as the user, to a card on a board they can use. Plain text or Markdown, up to 16 KiB.",
    scopes: ["tasks:write"],
    write: true,
    dailyBucket: "task_write",
    inputSchema: z.object({ cardId: uuid, body: z.string().min(1) }),
    handler: async ({ cardId, body }, key) => {
      const input = routeInput(commentCreateSchema, { body });
      return service(key, async () => {
        const { comment } = await createComment(key.userId, cardId, input);
        return { comment: { id: comment.id, card_id: comment.card_id, created_at: comment.created_at } };
      });
    }
  }),
  // Saved views and the cross-board query (17C, D145): list_views and query_cards.
  ...taskViewTools
];
