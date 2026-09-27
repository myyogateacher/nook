import { audit, db, now } from "../db";
import { limitReached, TaskError, withBoardLock } from "./service";
import { insertSprint, openCount, ownedSprint, requireDateOrder, sprintNotFound } from "./sprints";
import { openSprintRows, SPRINT_LIMITS, sprintById, sprintCounts, sprintNames, sprintOfBoard, toSummary, type SprintRow, type SprintSummary } from "./sprintData";
import { boardStructure } from "./hierarchy";
import { carryOverPlan } from "../../shared/sprintPlan";

/** `next`: the first planned sprint; `backlog`: no sprint; `new`: a sprint created in the same call; or a planned sprint's id. */
export type CarryTo = "next" | "backlog" | "new" | string;

export type CompleteSprintInput = { carryTo: CarryTo; name?: string; startOn?: string | null; endOn?: string | null; today?: string };

export type CompleteSprintResult = { sprint: SprintSummary; carried: number; doneCount: number; target: SprintSummary | null; created: boolean };

/**
 * Completes the active sprint (owner only, D131, T118). In one transaction under the board lock:
 * the sprint becomes completed, and its live cards outside a done column at that moment move to
 * `carryTo`, each with a revision bump (a stale editor then gets CARD_CHANGED rather than
 * overwriting). Cards in a done column stay with the completed sprint; subtasks follow their
 * parent by derivation. `new` creates the next sprint in the same transaction ("Sprint 13", as long
 * as this one and starting the day after it ends) unless `name` or dates are given.
 */
export async function completeSprint(userId: string, sprintId: string, input: CompleteSprintInput): Promise<CompleteSprintResult> {
  const { board } = ownedSprint(sprintId, userId);
  return withBoardLock(board.id, () => {
    const { sprint } = ownedSprint(sprintId, userId);
    if (sprint.state !== "active") throw new TaskError(409, "Only the active sprint can be completed", "SPRINT_NOT_ACTIVE");
    const keyword = input.carryTo === "next" || input.carryTo === "backlog" || input.carryTo === "new";
    const carryTo = keyword ? input.carryTo : input.carryTo.toLowerCase();
    let target: SprintRow | null = null;
    if (carryTo === "next") {
      target = openSprintRows(board.id).find((row) => row.state === "planned") ?? null;
      if (!target) throw new TaskError(409, "There is no planned sprint to move the unfinished cards to", "NO_NEXT_SPRINT");
    } else if (!keyword) {
      target = sprintOfBoard(carryTo, board.id);
      // Only a planned sprint of this board; any other id reads as missing.
      if (!target || target.state !== "planned") throw sprintNotFound();
    }
    let planned: { name: string; goal: string; startOn: string | null; endOn: string | null } | null = null;
    if (carryTo === "new") {
      if (openCount(board.id) >= SPRINT_LIMITS.openPerBoard) throw limitReached(`A board can have up to ${SPRINT_LIMITS.openPerBoard} planned or active sprints`);
      // Named and dated by the board's sprint defaults when it has them (Board settings).
      const suggested = carryOverPlan(sprint, input.today ?? now().slice(0, 10), sprintNames(board.id).values(), boardStructure(board.id).sprintDefaults);
      const startOn = input.startOn === undefined ? suggested.startOn : input.startOn;
      const endOn = input.endOn === undefined ? suggested.endOn : input.endOn;
      requireDateOrder(startOn, endOn);
      planned = { name: input.name ?? suggested.name, goal: "", startOn, endOn };
    }
    const result = db.transaction(() => {
      const timestamp = now();
      const created = planned ? insertSprint(userId, board.id, planned) : null;
      const destination = created ?? target;
      const params = { sprintId: sprint.id, boardId: board.id };
      const inSprint = "sprint_id = $sprintId AND deleted_at IS NULL AND board_id = $boardId";
      const doneCount = (db.query(`SELECT COUNT(*) AS count FROM cards WHERE ${inSprint}
        AND column_id IN (SELECT id FROM board_columns WHERE board_id = $boardId AND is_done = 1)`).get(params) as { count: number }).count;
      // Unfinished: live, stored in this sprint, in a column that is not done at this moment.
      const carried = db.query(`UPDATE cards SET sprint_id = $target, revision = revision + 1, updated_at = $timestamp
        WHERE ${inSprint} AND column_id IN (SELECT id FROM board_columns WHERE board_id = $boardId AND is_done = 0)`)
        .run({ ...params, target: destination?.id ?? null, timestamp }).changes;
      db.query("UPDATE board_sprints SET state = 'closed', closed_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, sprint.id);
      db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(timestamp, board.id);
      audit(userId, null, "task.sprint_complete", {
        boardId: board.id, sprintId: sprint.id, carried, doneCount,
        carryTo: keyword ? carryTo : "sprint",
        ...(destination ? { targetSprintId: destination.id } : {})
      });
      return { carried, doneCount, destinationId: destination?.id ?? null, created: created !== null };
    })();
    const counts = sprintCounts(board.id);
    return {
      sprint: toSummary(sprintById(sprint.id)!, counts),
      carried: result.carried,
      doneCount: result.doneCount,
      target: result.destinationId ? toSummary(sprintById(result.destinationId)!, counts) : null,
      created: result.created
    };
  });
}
