// Multi-board lanes on the client (lane VIEWS, docs/plan/TASK_VIEWS.md D640–D646; grouped lanes,
// lane VIEWS2, D650–D654). Pure: which lanes each loaded card is in, where a drop goes and why it is
// refused, the optimistic state after a move or a change, and which boards Add a card offers.
import {
  cardLaneKeys, isGroupLaneMode, LANE_MODE_NOUNS, LANE_STATE_LABELS, NONE_LANE, READ_ONLY_LANE_MODES, resolveGroupDrop, resolveLaneDrop,
  type DropRefusal, type GroupChange, type LaneBoard, type LaneColumn, type LaneMode, type QueryLane
} from "../../../shared/taskLanes";
import { addQueryDays } from "../../../shared/taskQuery";
import { columnFullMessage } from "../taskActions";
import type { BoardTag, CardSummary } from "../tasksApi";
import { levelAtLeast, type ItemLevel } from "../../access/accessLevels";
import type { QueriedCard, QueryLanes, StatefulColumn } from "./homeApi";
import { columnStatuses, type ColumnStatus } from "../ColumnStatusIcon";

/** The viewer's today and the end of this week (today + 6), for due lanes. */
export const laneDates = (today: string) => ({ today, weekEnd: /^\d{4}-\d{2}-\d{2}$/.test(today) ? addQueryDays(today, 6) : today });

/** Every lane a loaded card is in (one, or one per person or tag for those lanes). */
export const cardLaneKeysOf = (layout: Pick<QueryLanes, "lanes">, card: QueriedCard, today: string) => cardLaneKeys(layout.lanes, card, laneDates(today));

/** The lane a loaded card is in for column and state lanes (its first lane otherwise). */
export const cardLaneKey = (layout: Pick<QueryLanes, "lanes">, card: QueriedCard, today = "") => cardLaneKeysOf(layout, card, today)[0]!;

/** The loaded cards per lane, in the query's order. A card whose lane is not listed (a column added since) goes nowhere. */
export function cardsByLane(layout: QueryLanes, cards: readonly QueriedCard[], today = "") {
  const lanes = new Map<string, QueriedCard[]>(layout.columns.map((lane) => [lane.key, []]));
  for (const card of cards) for (const key of cardLaneKeysOf(layout, card, today)) lanes.get(key)?.push(card);
  return lanes;
}

export type LaneDrop =
  | { kind: "column"; columnId: string; column: LaneColumn }
  | { kind: "group"; change: GroupChange }
  /** A tag lane whose name the card's board has no tag for (D666): create it there, then retag. */
  | { kind: "createTag"; tagName: string; color: string; boardId: string; boardName: string }
  | { refusal: DropRefusal; message: string };

export const isDropAllowed = (drop: LaneDrop): drop is Exclude<LaneDrop, { refusal: DropRefusal }> => !("refusal" in drop);

/** Whether this layout's lanes can take a drop at all (due dates and boards cannot, D650). */
export const lanesAcceptDrops = (layout: Pick<QueryLanes, "lanes">) => !READ_ONLY_LANE_MODES.includes(layout.lanes);

/**
 * Where a card dragged from lane `fromKey` and dropped on `lane` goes (D641, D642, D651), or why it
 * cannot, in words: a column on its own board, or a change of its people, tags, or sprint.
 */
export function laneDrop(layout: QueryLanes, lane: QueryLane, card: QueriedCard, canEdit: boolean, fromKey?: string | null): LaneDrop {
  const mode = layout.lanes;
  if (isGroupLaneMode(mode)) {
    const board = layout.laneBoards?.find((item) => item.id === card.board_id) ?? null;
    const resolved = resolveGroupDrop(mode, lane, card, canEdit, { fromKey, board });
    // D666: a tag the card's board lacks can be made there by someone who edits its cards (any reader may add tags).
    if ("refusal" in resolved && resolved.refusal === "NO_TAG") return { kind: "createTag", tagName: lane.label, color: lane.color ?? "gray", boardId: card.board_id, boardName: card.board_name };
    if ("refusal" in resolved) return { refusal: resolved.refusal, message: refusalMessage(resolved.refusal, lane, card, mode) };
    return { kind: "group", change: resolved };
  }
  const resolved = resolveLaneDrop(lane, card, canEdit);
  if ("columnId" in resolved) return { kind: "column", columnId: resolved.columnId, column: lane.columns.find((column) => column.id === resolved.columnId)! };
  return { refusal: resolved.refusal, message: refusalMessage(resolved.refusal, lane, card, mode) };
}

const stateLabel = (lane: QueryLane) => lane.state ? LANE_STATE_LABELS[lane.state] : "";
const laneName = (lane: QueryLane) => lane.key.startsWith("s:") ? stateLabel(lane) : lane.label.replace(/ · .*$/, "");

export function refusalMessage(refusal: DropRefusal, lane: QueryLane, card: Pick<QueriedCard, "board_id" | "board_name">, mode: LaneMode = "columns") {
  switch (refusal) {
    case "NO_COLUMN": return lane.key.startsWith("s:")
      ? `${card.board_name} has no ${stateLabel(lane).toLowerCase()} column`
      : `${card.board_name} has no ${laneName(lane)} column${lane.label.includes(" · ") ? ` that is ${stateLabel(lane).toLowerCase()}` : ""}`;
    case "COLUMN_FULL": {
      const column = lane.columns.find((item) => item.board_id === card.board_id);
      return columnFullMessage(column?.name ?? laneName(lane), column?.wip_limit);
    }
    case "READ_ONLY": return `You can't change cards on ${card.board_name}`;
    case "SAME_LANE": return `Already in ${lane.label}`;
    case "NO_TAG": return `${card.board_name} has no ${lane.label} tag`;
    case "NO_SPRINT": return `${card.board_name} has no sprint named ${lane.label}`;
    case "SPRINT_CLOSED": return `${lane.label} is completed on ${card.board_name}`;
    case "SPRINT_LEVEL": return "Only cards at the board's work level are planned in sprints; the others follow their parent";
    case "SPRINTS_OFF": return `${card.board_name} does not use sprints`;
    case "LOCKED": return `Lanes by ${LANE_MODE_NOUNS[mode] === "due dates" ? "due date" : "board"} only show cards; open a card to change it`;
  }
}

/**
 * The state after moving `cardId` to `column` (optimistic, D641): the card takes the column's name
 * and state (and leaves any archive, as the server does), the lane counts move by one, and so do
 * the two columns' live counts that WIP checks read.
 */
export function withLaneMove<T extends { cards: QueriedCard[]; lanes?: QueryLanes }>(state: T, cardId: string, column: LaneColumn): T {
  const card = state.cards.find((item) => item.id === cardId);
  if (!card || !state.lanes) return state;
  const layout = state.lanes;
  const moved: QueriedCard = { ...card, column_id: column.id, column_name: column.name, column_state: column.state, is_done: column.state === "done" ? 1 : 0, archived_at: null };
  const columns = layout.columns.map((lane) => ({
    ...lane,
    columns: lane.columns.map((item) => item.id === column.id ? { ...item, card_count: (item.card_count ?? 0) + 1 }
      : item.id === card.column_id && !card.archived_at ? { ...item, card_count: Math.max(0, (item.card_count ?? 1) - 1) } : item)
  }));
  return { ...state, cards: state.cards.map((item) => item.id === cardId ? moved : item), lanes: { ...layout, laneCounts: movedCounts(layout, card, moved), columns } };
}

/** Lane counts after a card changed lanes: one less in each lane it left, one more in each it joined. */
function movedCounts(layout: QueryLanes, before: QueriedCard, after: QueriedCard, today = "") {
  const from = cardLaneKeysOf(layout, before, today);
  const to = cardLaneKeysOf(layout, after, today);
  const laneCounts = { ...layout.laneCounts };
  for (const key of from) if (!to.includes(key)) laneCounts[key] = Math.max(0, (laneCounts[key] ?? 1) - 1);
  for (const key of to) if (!from.includes(key)) laneCounts[key] = (laneCounts[key] ?? 0) + 1;
  return laneCounts;
}

/**
 * The card after a grouped drop (optimistic, D651): its people, tags, or sprint as the change sets
 * them, named from the lanes (a person's lane label, a board's tag of that name, the sprint's name).
 */
export function changedCard(card: QueriedCard, change: GroupChange, lanes: readonly QueryLane[]): QueriedCard {
  if (change.field === "assignees") {
    const known = new Map(card.assignees.map((person) => [person.id.toLowerCase(), person]));
    return { ...card, assignees: change.assigneeIds.map((id) => known.get(id) ?? { id, display_name: lanes.find((lane) => lane.userId === id)?.label ?? "Someone", can_read: 1 as const }) };
  }
  if (change.field === "tags") {
    const known = new Map(card.tags.map((tag) => [tag.id, tag]));
    const targets = lanes.flatMap((lane) => lane.targets ?? []).filter((target) => target.board_id === card.board_id);
    return { ...card, tags: change.tagIds.map((id) => known.get(id) ?? (() => { const target = targets.find((item) => item.id === id); return { id, name: target?.name ?? "Tag", color: target?.color ?? "gray" }; })()) };
  }
  const target = lanes.flatMap((lane) => lane.targets ?? []).find((item) => item.id === change.sprintId);
  return { ...card, sprint_id: change.sprintId, sprint_name: change.sprintId ? target?.name ?? null : null };
}

/** The state after a grouped drop (optimistic): the card and the lane counts. */
export function withGroupChange<T extends { cards: QueriedCard[]; lanes?: QueryLanes }>(state: T, cardId: string, change: GroupChange): T {
  const card = state.cards.find((item) => item.id === cardId);
  if (!card || !state.lanes) return state;
  const changed = changedCard(card, change, state.lanes.columns);
  return { ...state, cards: state.cards.map((item) => item.id === cardId ? changed : item), lanes: { ...state.lanes, laneCounts: movedCounts(state.lanes, card, changed) } };
}

/** "Moved to Asha", "Tagged Urgent", "Planned in Sprint 2", "Took the people off". */
export function changeMessage(change: GroupChange, lane: QueryLane) {
  if (change.field === "assignees") return lane.key === NONE_LANE.assignee ? "Took everyone off the card" : `Assigned to ${lane.label}`;
  if (change.field === "tags") return lane.key === NONE_LANE.tag ? "Took the tags off the card" : `Tagged ${lane.label}`;
  return change.sprintId ? `Planned in ${lane.label}` : "Moved to the backlog";
}

/** The lane card's face reads a board card; a cross-board card has its tags inline. */
export function faceOf(card: QueriedCard): { card: CardSummary; tags: BoardTag[] } {
  return {
    card: {
      id: card.id, board_id: card.board_id, column_id: card.column_id, position: card.position, title: card.title,
      has_description: card.description_excerpt ? 1 : 0, revision: card.revision, created_by: card.created_by, creator_name: card.creator_name,
      due_on: card.due_on, due_time: card.due_time, due_tz: card.due_tz, due_at: card.due_at, assignees: card.assignees,
      start_on: card.start_on ?? null, start_time: card.start_time ?? null, start_tz: card.start_tz ?? null, start_at: card.start_at ?? null,
      description_excerpt: card.description_excerpt, tag_ids: card.tags.map((tag) => tag.id), flags: card.flags as CardSummary["flags"], priority: (card.priority ?? null) as CardSummary["priority"],
      comment_count: 0, attachment_count: 0, archived_at: card.archived_at ?? null,
      // The card's key (lane KEYS, D710), shown quietly on the face.
      ...(card.key ? { key: card.key } : {})
    } as CardSummary,
    tags: card.tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color })) as unknown as BoardTag[]
  };
}

/** The next lane left or right of `fromIndex` that takes the card, or null (Alt+←/→, D641). */
export function nextOpenLane(layout: QueryLanes, fromIndex: number, direction: -1 | 1, card: QueriedCard, canEdit: boolean) {
  const lanes = layout.columns;
  const fromKey = lanes[fromIndex]?.key ?? null;
  for (let index = fromIndex + direction; index >= 0 && index < lanes.length; index += direction) {
    const drop = laneDrop(layout, lanes[index]!, card, canEdit, fromKey);
    if (isDropAllowed(drop)) return { index, drop };
  }
  return null;
}

/** Each lane's status icon, as a board's columns get theirs (COLICON, D629): from its state and place; none for grouped lanes. */
export function laneStatuses(lanes: readonly QueryLane[]): Array<ColumnStatus | null> {
  const stated = lanes.filter((lane) => lane.state);
  const statuses = columnStatuses(stated.map((lane) => ({ id: lane.key, state: lane.state, is_done: lane.state === "done" ? 1 : 0 }) as unknown as StatefulColumn));
  return lanes.map((lane) => statuses.get(lane.key) ?? null);
}

/** Where Add a card on a lane puts the card on one board (D654): its column, and what it starts with. */
export type LaneAddTarget = { board: LaneBoard; columnId: string | null; assignee?: { id: string; display_name: string }; tagId?: string; sprintId?: string | null };

/**
 * The boards Add a card on `lane` offers (D654): boards with matches where the viewer can edit cards
 * and the lane has a place: its column (column and state lanes, the first column of that state),
 * its tag, or an open sprint; any editable board for people and the backlog; the board itself for a
 * board lane. Due lanes offer none (a lane's due date is a range, not a value).
 */
export function laneAddTargets(layout: QueryLanes, lane: QueryLane, roleReadOnly: boolean): LaneAddTarget[] {
  if (roleReadOnly || layout.lanes === "due") return [];
  const editable = (layout.laneBoards ?? []).filter((board) => levelAtLeast(board.level as ItemLevel | undefined, "edit"));
  const targets: LaneAddTarget[] = [];
  for (const board of editable) {
    switch (layout.lanes) {
      case "columns":
      case "state": {
        const column = lane.columns.find((item) => item.board_id === board.id);
        if (column) targets.push({ board, columnId: column.id });
        break;
      }
      case "board":
        if (lane.key === `b:${board.id}`) targets.push({ board, columnId: null });
        break;
      case "assignee":
        targets.push({ board, columnId: null, ...(lane.userId ? { assignee: { id: lane.userId, display_name: lane.label } } : {}) });
        break;
      case "tag": {
        if (lane.key === NONE_LANE.tag) { targets.push({ board, columnId: null }); break; }
        const tag = lane.targets?.find((item) => item.board_id === board.id);
        if (tag) targets.push({ board, columnId: null, tagId: tag.id });
        break;
      }
      case "sprint": {
        if (lane.key === NONE_LANE.sprint) { targets.push({ board, columnId: null, sprintId: null }); break; }
        const sprint = lane.targets?.find((item) => item.board_id === board.id && item.state !== "closed");
        if (sprint && board.sprints) targets.push({ board, columnId: null, sprintId: sprint.id });
        break;
      }
    }
  }
  return targets;
}
