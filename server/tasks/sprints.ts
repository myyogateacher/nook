import { audit, db, now } from "../db";
import { mailSprint, sprintAssignees } from "../mail/laterMail";
import { readableBoardPredicate } from "./access";
import { planInsert } from "./boardOrder";
import { boardStructure } from "./hierarchy";
import { applyRenumber, limitReached, managerRequired, requireBoardAt, requireReadableBoard, TaskError, withBoardLock } from "./service";
import { boardLevel, type BoardRow } from "./access";
import { atLeast } from "../access/levels";
import {
  completedSprintRows,
  openSprintRows,
  SPRINT_LIMITS,
  sprintById,
  sprintCounts,
  sprintOfBoard,
  toSummary,
  type SprintRow
} from "./sprintData";
import { SPRINT_DEFAULT_DAYS, sprintEndFor, type SprintState } from "../../shared/sprintPlan";

/**
 * Sprint lifecycle (research 2026-09-26 D124, D131, D132, D135, §6.2, T118).
 *
 * - Any reader of the board lists its sprints and plans work-level cards into them (a card
 *   field, `service.ts`). Only the owner creates, edits, starts, completes, and deletes a sprint.
 * - At most one sprint per board is active (the partial unique index of migration 019, checked
 *   first here so the refusal names the active sprint).
 * - Completing a sprint runs under the board lock in one transaction: the unfinished live cards
 *   it stores (work level; their subtasks follow by derivation) move to the chosen target, and
 *   cards in a done column stay with the completed sprint.
 * - A sprint id from another board, or on a board the caller cannot read, is 404.
 */

export type SprintInput = { name?: string; goal?: string; startOn?: string | null; endOn?: string | null };
export type SprintPatch = SprintInput & { afterSprintId?: string | null; state?: "active" };

export const sprintNotFound = () => new TaskError(404, "Sprint not found");

/** The sprint and its board when the caller can read the board, else 404. */
function readableSprint(sprintId: string, userId: string) {
  const sprint = sprintById(sprintId.toLowerCase());
  if (!sprint) throw sprintNotFound();
  const board = db.query(`SELECT b.* FROM boards b WHERE b.id = $boardId AND ${readableBoardPredicate}`)
    .get({ boardId: sprint.board_id, userId }) as BoardRow | null;
  if (!board) throw sprintNotFound();
  return { sprint, board };
}

/** A sprint on a board the caller owns or manages (D273); 403 MANAGER_REQUIRED for other readers. */
export function ownedSprint(sprintId: string, userId: string) {
  const found = readableSprint(sprintId, userId);
  if (!atLeast(boardLevel(found.board, userId), "manage")) throw managerRequired();
  return found;
}

const summaryOf = (sprint: SprintRow) => toSummary(sprint, sprintCounts(sprint.board_id));

/** 400 unless start ≤ end when both are set. */
export function requireDateOrder(startOn: string | null, endOn: string | null) {
  if (startOn && endOn && startOn > endOn) throw new TaskError(400, "The sprint cannot end before it starts");
}

function requireSprintsOn(boardId: string) {
  if (!boardStructure(boardId).sprints) throw new TaskError(409, "Turn sprints on in Board settings first", "SPRINTS_OFF");
}

export const openCount = (boardId: string) =>
  (db.query("SELECT COUNT(*) AS count FROM board_sprints WHERE board_id = ? AND state IN ('planned', 'active')").get(boardId) as { count: number }).count;

/**
 * A board's sprints (any reader). Without `state`: every open sprint (active first, then planned by
 * position) and the first page of completed ones. `state=completed` pages completed sprints newest
 * first with `cursor`.
 */
export function listSprints(userId: string, boardId: string, options: { state?: SprintState; cursor?: string; limit?: number } = {}) {
  requireReadableBoard(boardId, userId);
  const counts = sprintCounts(boardId);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? SPRINT_LIMITS.page), 1), 100);
  const open = options.state === "completed" ? [] : openSprintRows(boardId).filter((row) => !options.state || row.state === options.state);
  let completed: SprintRow[] = [];
  let nextCursor: string | null = null;
  if (!options.state || options.state === "completed") {
    const after = options.cursor ? decodeCursor(options.cursor) : undefined;
    const rows = completedSprintRows(boardId, limit + 1, after);
    completed = rows.slice(0, limit);
    const last = completed[completed.length - 1];
    if (rows.length > limit && last) nextCursor = Buffer.from(JSON.stringify([last.closed_at, last.id])).toString("base64url");
  }
  return { sprints: [...open, ...completed].map((row) => toSummary(row, counts)), nextCursor };
}

function decodeCursor(value: string) {
  const invalid = () => new TaskError(400, "The page cursor is not valid. Start again from the first page.", "CURSOR_INVALID");
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") return { closedAt: parsed[0], id: parsed[1] };
  } catch {
    // Falls through to the 400.
  }
  throw invalid();
}

export function insertSprint(userId: string, boardId: string, input: { name: string; goal: string; startOn: string | null; endOn: string | null }) {
  const plan = planInsert(db.query("SELECT id, position FROM board_sprints WHERE board_id = ? AND state IN ('planned', 'active')").all(boardId) as Array<{ id: string; position: number }>, undefined)!;
  applyRenumber("board_sprints", plan.renumbered);
  const id = crypto.randomUUID();
  const timestamp = now();
  db.query(`INSERT INTO board_sprints (id, board_id, name, goal, start_on, end_on, state, position, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?)`).run(id, boardId, input.name, input.goal, input.startOn, input.endOn, plan.position, userId, timestamp, timestamp);
  db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(timestamp, boardId);
  audit(userId, null, "task.sprint_create", { boardId, sprintId: id });
  return sprintOfBoard(id, boardId)!;
}

/**
 * Omitted dates for a sprint an agent adds (1l): the start is `today`, the end the board's default
 * length later (sprint defaults, else two weeks), so a sprint started over MCP always has dates. An
 * explicit null keeps that date empty; a given end before today leaves the start empty.
 */
export function defaultedSprintDates(input: { startOn?: string | null; endOn?: string | null }, days: number, today: string) {
  const startOn = input.startOn !== undefined ? input.startOn : input.endOn && input.endOn < today ? null : today;
  const endOn = input.endOn !== undefined ? input.endOn : startOn ? sprintEndFor(startOn, days) : null;
  return { startOn, endOn };
}

/**
 * Creates a planned sprint at the end (owner only; the board has sprints on; at most 50 open).
 * `defaultDates` (MCP create_sprint) fills omitted dates with defaultedSprintDates.
 */
export function createSprint(userId: string, boardId: string, input: SprintInput & { name: string }, options: { defaultDates?: boolean; today?: string } = {}) {
  return withBoardLock(boardId, () => {
    requireBoardAt(boardId, userId, "manage");
    requireSprintsOn(boardId);
    if (openCount(boardId) >= SPRINT_LIMITS.openPerBoard) throw limitReached(`A board can have up to ${SPRINT_LIMITS.openPerBoard} planned or active sprints`);
    if (options.defaultDates) {
      input = { ...input, ...defaultedSprintDates(input, boardStructure(boardId).sprintDefaults?.days ?? SPRINT_DEFAULT_DAYS, options.today ?? now().slice(0, 10)) };
    }
    requireDateOrder(input.startOn ?? null, input.endOn ?? null);
    const sprint = db.transaction(() => insertSprint(userId, boardId, { name: input.name, goal: input.goal ?? "", startOn: input.startOn ?? null, endOn: input.endOn ?? null }))();
    return { sprint: summaryOf(sprint) };
  });
}

/**
 * Edits a sprint (owner only): name, goal, and dates at any state; `afterSprintId` reorders an
 * open sprint among the open ones; `state: "active"` starts a planned sprint (409 SPRINT_ACTIVE
 * with the active sprint's id when another is active). A completed sprint keeps its state.
 */
export async function patchSprint(userId: string, sprintId: string, input: SprintPatch) {
  const { board } = ownedSprint(sprintId, userId);
  return withBoardLock(board.id, () => {
    const { sprint } = ownedSprint(sprintId, userId);
    const startOn = input.startOn === undefined ? sprint.start_on : input.startOn;
    const endOn = input.endOn === undefined ? sprint.end_on : input.endOn;
    requireDateOrder(startOn, endOn);
    let plan: ReturnType<typeof planInsert> = null;
    if (input.afterSprintId !== undefined) {
      if (sprint.state === "closed") throw new TaskError(409, "A completed sprint keeps its place", "SPRINT_COMPLETED");
      if (input.afterSprintId === sprint.id) throw new TaskError(400, "A sprint cannot be placed after itself");
      const siblings = db.query("SELECT id, position FROM board_sprints WHERE board_id = ? AND state IN ('planned', 'active') AND id <> ?").all(board.id, sprint.id) as Array<{ id: string; position: number }>;
      plan = planInsert(siblings, input.afterSprintId?.toLowerCase() ?? null);
      if (!plan) throw sprintNotFound();
    }
    const start = input.state === "active" && sprint.state !== "active";
    if (start) {
      if (sprint.state === "closed") throw new TaskError(409, "A completed sprint cannot be started again", "SPRINT_COMPLETED");
      requireSprintsOn(board.id);
      const active = db.query("SELECT id, name FROM board_sprints WHERE board_id = ? AND state = 'active'").get(board.id) as { id: string; name: string } | null;
      if (active) throw new TaskError(409, `Complete ${active.name} before starting another sprint`, "SPRINT_ACTIVE", { activeSprintId: active.id });
    }
    const fields = (["name", "goal", "startOn", "endOn"] as const).filter((field) => input[field] !== undefined);
    db.transaction(() => {
      const timestamp = now();
      db.query(`UPDATE board_sprints SET name = COALESCE($name, name), goal = COALESCE($goal, goal), start_on = $startOn, end_on = $endOn,
          state = CASE WHEN $start THEN 'active' ELSE state END, updated_at = $timestamp WHERE id = $id`)
        .run({ name: input.name ?? null, goal: input.goal ?? null, startOn, endOn, start: start ? 1 : 0, timestamp, id: sprint.id });
      if (plan) {
        applyRenumber("board_sprints", plan.renumbered);
        db.query("UPDATE board_sprints SET position = ? WHERE id = ?").run(plan.position, sprint.id);
      }
      db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(timestamp, board.id);
      if (fields.length || plan) audit(userId, null, "task.sprint_update", { boardId: board.id, sprintId: sprint.id, fields: [...fields, ...(plan ? ["position"] : [])] });
      if (start) {
        audit(userId, null, "task.sprint_start", { boardId: board.id, sprintId: sprint.id });
        // "Sprint started" mail to assignees in it (outbound email #20; off by default, D236).
        mailSprint(userId, board.id, sprint.id, "started", sprintAssignees(sprint.id, board.id));
      }
    })();
    return { sprint: summaryOf(sprintById(sprint.id)!) };
  });
}

/** Deletes a planned sprint that no live card is planned in (owner only). Binned cards in it fall back to no sprint. */
export async function deleteSprint(userId: string, sprintId: string) {
  const { board } = ownedSprint(sprintId, userId);
  return withBoardLock(board.id, () => {
    const { sprint } = ownedSprint(sprintId, userId);
    if (sprint.state !== "planned") throw new TaskError(409, "Only a planned sprint can be deleted", "SPRINT_NOT_PLANNED");
    const cards = (db.query("SELECT COUNT(*) AS count FROM cards WHERE sprint_id = ? AND deleted_at IS NULL").get(sprint.id) as { count: number }).count;
    if (cards) throw new TaskError(409, "Move its cards to another sprint or the backlog first", "SPRINT_NOT_EMPTY", { cardCount: cards });
    db.transaction(() => {
      db.query("DELETE FROM board_sprints WHERE id = ?").run(sprint.id);
      db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(now(), board.id);
      audit(userId, null, "task.sprint_delete", { boardId: board.id, sprintId: sprint.id });
    })();
    return { ok: true as const };
  });
}
