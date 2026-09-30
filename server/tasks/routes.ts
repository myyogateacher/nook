import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson, uuid } from "../validation";
import { MAX_ASSIGNEES } from "./assignees";
import { isDueTime, isDueTimeZone } from "./dueTime";
import { attachToCard, detachFromCard, listAttachments } from "./attachments";
import { boardPayload, listRelations, MAX_RELATIONS_PER_CARD } from "./cardRelations";
import { RELATION_TYPES, type RelationType } from "./relations";
import { registerCardRelationRoutes } from "./relationRoutes";
import { CARD_FLAGS, createTag, deleteTag, MAX_TAGS_PER_CARD, TAG_COLORS, TAG_NAME_MAX, updateTag } from "./tags";
import { registerTaskQueryRoutes } from "./queryRoutes";
import { cardHierarchy } from "./hierarchy";
import { COMMENT_MAX_BYTES, COMMENT_PAGE_SIZE, createComment, deleteComment, listComments, updateComment } from "./comments";
import { avatarUrlsFor, integrationIdsAmong } from "../avatars";

/** Web payloads only (MCP output unchanged): each comment author's picture, beside the name (QA U4). */
function withAuthorAvatars<T extends { author_id: string | null }>(comments: T[]) {
  const urls = avatarUrlsFor(comments.flatMap((comment) => comment.author_id ? [comment.author_id] : []));
  return comments.map((comment) => ({ ...comment, author_avatar_url: comment.author_id ? urls.get(comment.author_id) ?? null : null }));
}
const withAuthorAvatar = <T extends { author_id: string | null }>(result: { comment: T }) => ({ ...result, comment: withAuthorAvatars([result.comment])[0]! });
/** Q7: a card in a web answer carries each assignee's picture, as the board payload does; Q-L4: and the integration mark. */
function withAssigneeAvatars<T extends { card: { assignees: Array<{ id: string }> } }>(result: T): T {
  const ids = result.card.assignees.map((assignee) => assignee.id);
  const urls = avatarUrlsFor(ids);
  const integrations = integrationIdsAmong(ids);
  return { ...result, card: { ...result.card, assignees: result.card.assignees.map((assignee) => ({ ...assignee, avatar_url: urls.get(assignee.id) ?? null, ...(integrations.has(assignee.id) ? { is_integration: true } : {}) })) } };
}
import {
  createBoard,
  createCard,
  createColumn,
  deleteCard,
  getCard,
  moveCard,
  patchCard,
  deleteBoard,
  deleteColumn,
  getSharing,
  listBoardReaders,
  listBoards,
  patchColumn,
  putSharing,
  updateBoard,
  TaskError
} from "./service";
import { BOARD_TEMPLATES, validateStructure } from "../../shared/boardStructure";
import { validTimeZone } from "../today/registry";

// C0/C1 controls and bidi overrides never belong in a board, column, or card name.
const controlCharacters = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/;
const label = (max: number) => z.string().trim().min(1).max(max).refine((value) => !controlCharacters.test(value), "Names cannot contain control characters");

export const boardNameSchema = z.object({ name: label(120) }).strict();
/** `POST /boards`: a name and an optional template (D136). */
/** `tz`: the creator's IANA zone, so a template's first sprint starts on their today (QA 0.9.0). */
export const boardCreateSchema = z.object({
  name: label(120), template: z.enum(BOARD_TEMPLATES).optional(),
  tz: z.string().max(64).refine((value) => validTimeZone(value) !== null, "Unknown time zone").optional()
}).strict();
/** `PATCH /boards/:b`: a new name and/or a new structure (checked by `validateStructure`, D122). */
export const boardPatchSchema = z.object({ name: label(120).optional(), structure: z.unknown().optional() }).strict()
  .refine((value) => value.name !== undefined || value.structure !== undefined, "Provide a name or a structure");
export const boardSharingSchema = z.object({
  visibility: z.enum(["private", "selected", "all_users"]),
  userIds: z.array(uuid).max(100).default([])
}).strict();
export const columnCreateSchema = z.object({ name: label(60), afterColumnId: uuid.nullable().optional() }).strict();
export const columnPatchSchema = z.object({
  name: label(60).optional(),
  afterColumnId: uuid.nullable().optional(),
  isDone: z.boolean().optional(),
  /** Normalized workflow state (migration 020, D141); `done` also sets isDone. */
  state: z.enum(["todo", "doing", "done"]).optional(),
  /** WIP limit (D108): 1–1000 or null for none. */
  wipLimit: z.number().int().min(1).max(1000).nullable().optional()
}).strict()
  .refine((value) => value.name !== undefined || value.afterColumnId !== undefined || value.isDone !== undefined || value.state !== undefined || value.wipLimit !== undefined,
    "Provide a name, an afterColumnId, isDone, state, or wipLimit");

/** A real calendar date `YYYY-MM-DD` between 1900 and 2999 (T71). */
export function isCalendarDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900 || year > 2999) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
export const dueOnSchema = z.string().refine(isCalendarDate, "Use a real date as YYYY-MM-DD");
/** `HH:MM`, 00:00–23:59 (D100, T94). */
export const dueTimeSchema = z.string().refine(isDueTime, "Use a time as HH:MM (00:00 to 23:59)");
/** An IANA zone, as `isValidTimeZone` accepts it (browser aliases included, T71, T94). */
export const dueTzSchema = z.string().refine(isDueTimeZone, "Use a known time zone");

export const DESCRIPTION_MAX_BYTES = 65_536;
const description = z.string().refine((value) => Buffer.byteLength(value, "utf8") <= DESCRIPTION_MAX_BYTES, `Descriptions can be at most ${DESCRIPTION_MAX_BYTES} bytes`);
/** Assignee ids (D102): at most 20 after deduplication; the service dedupes and checks each can read the board. */
const assigneeIdsSchema = z.array(uuid).max(MAX_ASSIGNEES * 2);
/** Tag ids (D109): at most 10 after deduplication; the service dedupes and checks each is a tag of the card's board. */
const tagIdsSchema = z.array(uuid).max(MAX_TAGS_PER_CARD * 2);
/** Flags (D110): unique values from the fixed set. */
const flagsSchema = z.array(z.enum(CARD_FLAGS)).max(CARD_FLAGS.length).refine((flags) => new Set(flags).size === flags.length, "Each flag can appear once");
/**
 * Relations to create with a new card (§5.1 composer): each target must be readable; same rules as
 * POST /cards/:k/relations. A target listed twice is a 400 here: the new card has no relations yet,
 * so a 409 RELATION_EXISTS would point at a relation the same call rolled back.
 */
const createRelationsSchema = z.array(z.object({ targetCardId: uuid, type: z.enum(RELATION_TYPES as [RelationType, ...RelationType[]]) }).strict())
  .max(MAX_RELATIONS_PER_CARD)
  .refine((relations) => new Set(relations.map((relation) => relation.targetCardId.toLowerCase())).size === relations.length, "Each card can be related once");
/** A card level (migration 019): 0–2; the service also checks the board's level count (D121). */
const levelSchema = z.number().int().min(0).max(2);
export const tagCreateSchema = z.object({ name: label(TAG_NAME_MAX), color: z.enum(TAG_COLORS).optional() }).strict();
export const tagPatchSchema = z.object({ name: label(TAG_NAME_MAX).optional(), color: z.enum(TAG_COLORS).optional() }).strict()
  .refine((value) => value.name !== undefined || value.color !== undefined, "Provide a name or a color");
export const cardCreateSchema = z.object({
  columnId: uuid,
  title: label(200),
  description: description.optional(),
  dueOn: dueOnSchema.nullable().optional(),
  dueTime: dueTimeSchema.nullable().optional(),
  dueTz: dueTzSchema.nullable().optional(),
  assigneeIds: assigneeIdsSchema.optional(),
  tagIds: tagIdsSchema.optional(),
  flags: flagsSchema.optional(),
  relations: createRelationsSchema.optional(),
  /** The caller's own unlinked task-attachment uploads (LIMITS.attachmentsPerCard). */
  attachmentIds: z.array(uuid).max(50).optional(),
  /** A live card of this board one level up (D121). */
  parentId: uuid.nullable().optional(),
  level: levelSchema.optional(),
  /** A planned or active sprint of this board (17B); work-level cards only. */
  sprintId: uuid.nullable().optional(),
  afterCardId: uuid.nullable().optional()
}).strict();
export const cardPatchSchema = z.object({
  title: label(200).optional(),
  description: description.optional(),
  dueOn: dueOnSchema.nullable().optional(),
  dueTime: dueTimeSchema.nullable().optional(),
  dueTz: dueTzSchema.nullable().optional(),
  /** Legacy (D103), kept for the Wave 10 client and MCP; 400 together with assigneeIds. */
  assigneeId: uuid.nullable().optional(),
  assigneeIds: assigneeIdsSchema.optional(),
  tagIds: tagIdsSchema.optional(),
  flags: flagsSchema.optional(),
  /** Reparent (D128): a live card of this board one level up, or null to detach. */
  parentId: uuid.nullable().optional(),
  /** Change level (D128); 409 HAS_CHILDREN while the card has live children. */
  level: levelSchema.optional(),
  /** Plan the card in a sprint of its board, or null for the backlog (17B); work-level cards only. */
  sprintId: uuid.nullable().optional(),
  revision: z.number().int().positive()
}).strict()
  .refine((value) => value.assigneeId === undefined || value.assigneeIds === undefined, "Send assigneeIds or the legacy assigneeId, not both")
  .refine((value) => value.title !== undefined || value.description !== undefined || value.dueOn !== undefined || value.dueTime !== undefined
    || value.dueTz !== undefined || value.assigneeId !== undefined || value.assigneeIds !== undefined || value.tagIds !== undefined || value.flags !== undefined
    || value.parentId !== undefined || value.level !== undefined || value.sprintId !== undefined,
  "Provide a title, description, dueOn, dueTime, assigneeIds, tagIds, flags, parentId, level, or sprintId");
const commentBody = z.string().refine((value) => value.trim().length > 0, "Write a comment")
  .refine((value) => Buffer.byteLength(value, "utf8") <= COMMENT_MAX_BYTES, `Comments can be at most ${COMMENT_MAX_BYTES} bytes`);
export const commentCreateSchema = z.object({ body: commentBody, attachmentIds: z.array(uuid).max(10).optional() }).strict();
export const attachmentSchema = z.object({ documentId: uuid, commentId: uuid.nullable().optional() }).strict();
export const commentPatchSchema = z.object({ body: commentBody }).strict();
export const cardMoveSchema = z.object({ columnId: uuid, afterCardId: uuid.nullable() }).strict();

const id = (c: Context<AppEnv>, name: string) => uuid.parse(c.req.param(name));
const invalid = (detail: string) => ({ error: "Invalid request", details: [detail] });

export const READERS_QUERY_MAX = 64;
export const READERS_LIMIT_MAX = 50;
const READERS_RATE_LIMIT = 60;
const READERS_RATE_WINDOW_MS = 60_000;
const readerRequests = new Map<string, number[]>();

/**
 * The assignee picker's sliding window per user (T92): 60 requests a minute,
 * in memory (one app instance per data directory). Returns seconds to wait, or 0.
 */
function readersRateLimited(userId: string, time = Date.now()) {
  const windowStart = time - READERS_RATE_WINDOW_MS;
  if (readerRequests.size > 1000) {
    for (const [key, stamps] of readerRequests) if ((stamps[stamps.length - 1] ?? 0) <= windowStart) readerRequests.delete(key);
  }
  const stamps = (readerRequests.get(userId) ?? []).filter((stamp) => stamp > windowStart);
  if (stamps.length >= READERS_RATE_LIMIT) {
    readerRequests.set(userId, stamps);
    return Math.max(1, Math.ceil((stamps[0]! + READERS_RATE_WINDOW_MS - time) / 1000));
  }
  stamps.push(time);
  readerRequests.set(userId, stamps);
  return 0;
}

/** Test hook: forget the assignee picker's rate-limit history. */
export function resetReadersRateLimit() {
  readerRequests.clear();
}

/** Runs a service call and maps TaskError to its JSON response; other errors reach app.onError. */
async function respond(c: Context<AppEnv>, operation: () => unknown, status: 200 | 201 = 200) {
  try {
    return c.json(await operation() as Record<string, unknown>, status);
  } catch (error) {
    if (error instanceof TaskError) return c.json(error.body(), error.status);
    throw error;
  }
}

/** docs/plan/API_CONTRACTS.md § Tasks. JSON only; the global session, Origin, CSRF, and TOTP middleware apply. */
export function registerTaskRoutes(app: Hono<AppEnv>) {
  // First, so GET /cards/search is not taken for a card id.
  registerCardRelationRoutes(app);

  app.get("/api/tasks/boards", (c) => c.json({ boards: listBoards(c.get("user").id) }));

  app.post("/api/tasks/boards", async (c) => {
    const body = await parseJson(c.req.raw, boardCreateSchema);
    return respond(c, () => createBoard(c.get("user").id, body.name, body.template, body.tz), 201);
  });

  app.get("/api/tasks/boards/:boardId", (c) => {
    const boardId = id(c, "boardId");
    return respond(c, () => boardPayload(c.get("user").id, boardId));
  });

  app.patch("/api/tasks/boards/:boardId", async (c) => {
    const boardId = id(c, "boardId");
    const body = await parseJson(c.req.raw, boardPatchSchema);
    const structure = body.structure === undefined ? null : validateStructure(body.structure);
    if (structure && !structure.ok) return c.json(invalid(structure.error), 400);
    const userId = c.get("user").id;
    // One lock and one transaction for both (review L5): never a renamed board with a refused structure.
    // Sprint defaults are kept unless the structure names them (`null` clears them).
    const keepSprintDefaults = Boolean(body.structure && typeof body.structure === "object" && !("sprintDefaults" in body.structure));
    return respond(c, () => updateBoard(userId, boardId, { ...(body.name !== undefined ? { name: body.name } : {}), ...(structure?.ok ? { structure: structure.structure, keepSprintDefaults } : {}) }));
  });

  app.delete("/api/tasks/boards/:boardId", (c) => {
    const boardId = id(c, "boardId");
    return respond(c, () => deleteBoard(c.get("user").id, boardId));
  });

  app.get("/api/tasks/boards/:boardId/sharing", (c) => {
    const boardId = id(c, "boardId");
    return respond(c, () => getSharing(c.get("user").id, boardId));
  });

  app.put("/api/tasks/boards/:boardId/sharing", async (c) => {
    const boardId = id(c, "boardId");
    const body = await parseJson(c.req.raw, boardSharingSchema);
    return respond(c, () => putSharing(c.get("user").id, boardId, body.visibility, body.userIds));
  });

  app.get("/api/tasks/boards/:boardId/readers", async (c) => {
    const boardId = id(c, "boardId");
    const userId = c.get("user").id;
    const retryAfter = readersRateLimited(userId);
    if (retryAfter) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Too many requests. Try again in a moment.", code: "RATE_LIMITED" }, 429);
    }
    const q = c.req.query("q");
    const limitParam = c.req.query("limit");
    if (q !== undefined && (q.length < 1 || q.length > READERS_QUERY_MAX)) return c.json(invalid(`q must be 1 to ${READERS_QUERY_MAX} characters`), 400);
    if (limitParam !== undefined && (!/^\d+$/.test(limitParam) || Number(limitParam) < 1 || Number(limitParam) > READERS_LIMIT_MAX)) {
      return c.json(invalid(`limit must be an integer from 1 to ${READERS_LIMIT_MAX}`), 400);
    }
    if (limitParam !== undefined && q === undefined) return c.json(invalid("limit needs q"), 400);
    return respond(c, () => {
      const result = listBoardReaders(userId, boardId, { q, limit: limitParam === undefined ? undefined : Number(limitParam) });
      // Q7: the picker shows each person's picture, not a letter (web payload only; MCP unchanged).
      const urls = avatarUrlsFor(result.users.map((user) => user.id));
      // Q-L4: an integration is drawn with its icon and marked, never with initials.
      const integrations = integrationIdsAmong(result.users.map((user) => user.id));
      return { ...result, users: result.users.map((user) => ({ ...user, avatarUrl: urls.get(user.id) ?? null, ...(integrations.has(user.id) ? { isIntegration: true } : {}) })) };
    });
  });

  app.post("/api/tasks/boards/:boardId/tags", async (c) => {
    const boardId = id(c, "boardId");
    const body = await parseJson(c.req.raw, tagCreateSchema);
    return respond(c, () => createTag(c.get("user").id, boardId, body), 201);
  });

  app.patch("/api/tasks/tags/:tagId", async (c) => {
    const tagId = id(c, "tagId");
    const body = await parseJson(c.req.raw, tagPatchSchema);
    return respond(c, () => updateTag(c.get("user").id, tagId, body));
  });

  app.delete("/api/tasks/tags/:tagId", (c) => {
    const tagId = id(c, "tagId");
    return respond(c, () => deleteTag(c.get("user").id, tagId));
  });

  app.post("/api/tasks/boards/:boardId/columns", async (c) => {
    const boardId = id(c, "boardId");
    const body = await parseJson(c.req.raw, columnCreateSchema);
    return respond(c, () => createColumn(c.get("user").id, boardId, body), 201);
  });

  app.patch("/api/tasks/columns/:columnId", async (c) => {
    const columnId = id(c, "columnId");
    const body = await parseJson(c.req.raw, columnPatchSchema);
    return respond(c, () => patchColumn(c.get("user").id, columnId, body));
  });

  app.delete("/api/tasks/columns/:columnId", (c) => {
    const columnId = id(c, "columnId");
    return respond(c, () => deleteColumn(c.get("user").id, columnId));
  });

  app.post("/api/tasks/boards/:boardId/cards", async (c) => {
    const boardId = id(c, "boardId");
    const body = await parseJson(c.req.raw, cardCreateSchema);
    return respond(c, async () => withAssigneeAvatars(await createCard(c.get("user").id, boardId, body)), 201);
  });

  app.get("/api/tasks/cards/:cardId", (c) => {
    const cardId = id(c, "cardId");
    const userId = c.get("user").id;
    return respond(c, () => {
      const { card } = withAssigneeAvatars(getCard(userId, cardId));
      const page = listComments(userId, cardId);
      // Parent, ancestors, and children are on the card's own board (D133, T112).
      return { card: { ...card, ...cardHierarchy(cardId) }, comments: withAuthorAvatars(page.comments), hasMoreComments: page.hasMore, attachments: listAttachments(cardId), relations: listRelations(userId, cardId) };
    });
  });

  app.get("/api/tasks/cards/:cardId/children", (c) => {
    const cardId = id(c, "cardId");
    return respond(c, () => {
      getCard(c.get("user").id, cardId);
      return { children: cardHierarchy(cardId).children };
    });
  });

  app.get("/api/tasks/cards/:cardId/comments", async (c) => {
    const cardId = id(c, "cardId");
    const userId = c.get("user").id;
    const before = c.req.query("before");
    const limitParam = c.req.query("limit");
    const limit = limitParam === undefined ? COMMENT_PAGE_SIZE : Number(limitParam);
    if (!/^\d+$/.test(limitParam ?? "50") || limit < 1 || limit > COMMENT_PAGE_SIZE) {
      return c.json({ error: "Invalid request", details: [`limit must be an integer from 1 to ${COMMENT_PAGE_SIZE}`] }, 400);
    }
    const beforeId = before === undefined ? undefined : uuid.parse(before);
    return respond(c, () => {
      getCard(userId, cardId);
      const page = listComments(userId, cardId, { before: beforeId, limit });
      return { ...page, comments: withAuthorAvatars(page.comments) };
    });
  });

  app.post("/api/tasks/cards/:cardId/comments", async (c) => {
    const cardId = id(c, "cardId");
    const body = await parseJson(c.req.raw, commentCreateSchema);
    // Q3: the new comment carries its author's picture like listed ones, so it never shows initials first.
    return respond(c, async () => withAuthorAvatar(await createComment(c.get("user").id, cardId, body)), 201);
  });

  app.post("/api/tasks/cards/:cardId/attachments", async (c) => {
    const cardId = id(c, "cardId");
    const body = await parseJson(c.req.raw, attachmentSchema);
    try {
      const result = await attachToCard(c.get("user").id, cardId, body);
      return c.json({ attachment: result.attachment }, result.status);
    } catch (error) {
      if (error instanceof TaskError) return c.json(error.body(), error.status);
      throw error;
    }
  });

  app.delete("/api/tasks/cards/:cardId/attachments/:documentId", (c) => {
    const cardId = id(c, "cardId");
    const documentId = id(c, "documentId");
    return respond(c, () => detachFromCard(c.get("user").id, cardId, documentId));
  });

  app.patch("/api/tasks/comments/:commentId", async (c) => {
    const commentId = id(c, "commentId");
    const body = await parseJson(c.req.raw, commentPatchSchema);
    return respond(c, async () => withAuthorAvatar(await updateComment(c.get("user").id, commentId, body.body)));
  });

  app.delete("/api/tasks/comments/:commentId", (c) => {
    const commentId = id(c, "commentId");
    return respond(c, () => deleteComment(c.get("user").id, commentId));
  });

  app.patch("/api/tasks/cards/:cardId", async (c) => {
    const cardId = id(c, "cardId");
    const body = await parseJson(c.req.raw, cardPatchSchema);
    return respond(c, async () => withAssigneeAvatars(await patchCard(c.get("user").id, cardId, body)));
  });

  app.post("/api/tasks/cards/:cardId/move", async (c) => {
    const cardId = id(c, "cardId");
    const body = await parseJson(c.req.raw, cardMoveSchema);
    return respond(c, () => moveCard(c.get("user").id, cardId, body));
  });

  app.delete("/api/tasks/cards/:cardId", (c) => {
    const cardId = id(c, "cardId");
    return respond(c, () => deleteCard(c.get("user").id, cardId));
  });

  registerTaskQueryRoutes(app);
}
