// A saved view on its board (lane VIEWS, docs/plan/TASK_VIEWS.md D635–D638). Pure: the view's filter
// as the board engine runs it (without its board term), the stored text for a filter, the layout,
// and what a new card starts with. No DOM access.
import { format, isTaskPriority, parse, type FilterTerm, type TaskQuery } from "../../../shared/taskQuery";
import { columnState, type StatefulColumn, type TaskView } from "../home/homeApi";
import type { BoardViewId } from "../boardUrl";
import type { BoardTag, CardAssignee, SprintSummary } from "../tasksApi";
import type { ComposerPrefill } from "../composerDraft";

const isBoardTerm = (term: FilterTerm, boardId: string) => term.key === "board" && !term.negate && term.values.length === 1 && term.values[0] === boardId;

/**
 * The view's filter as its board runs it: the terms minus the one positive `board:` term (the board
 * engine matches cards it already loaded, which carry no board to match, D635).
 */
export function boardViewFilter(query: TaskQuery, boardId: string): TaskQuery {
  return { terms: query.terms.filter((term) => !isBoardTerm(term, boardId)) };
}

/** A stored view's filter on its board; unreadable text (a newer build) reads as no filter. */
export function savedBoardFilter(view: Pick<TaskView, "query">, boardId: string): TaskQuery {
  const parsed = parse(view.query, { lenient: true });
  return boardViewFilter(parsed.ok ? parsed.query : { terms: [] }, boardId);
}

/** The text a board view stores: its board term and the board's filter, canonical. */
export function boardViewQueryText(boardId: string, filter: TaskQuery) {
  return format({ terms: [{ key: "board", negate: false, values: [boardId] }, ...boardViewFilter(filter, boardId).terms] });
}

/** Whether two filters are the same question (canonical text). */
export const sameFilter = (left: TaskQuery, right: TaskQuery) => format(left) === format(right);

export type SavedLayout = "list" | "table" | "board" | "timeline";

/** The board layout a saved display opens in; the board keeps the calendar as its own. A timeline view opens as the timeline (D760). */
export function boardLayoutOf(display: { layout?: string } | undefined): BoardViewId {
  return display?.layout === "table" || display?.layout === "list" || display?.layout === "timeline" ? display.layout : "board";
}

/** The view display for a board layout: the calendar has no saved twin, so it keeps the saved one. */
export function displayLayoutOf(view: BoardViewId, saved: string | undefined): SavedLayout {
  if (view === "table" || view === "list" || view === "board" || view === "timeline") return view;
  return saved === "table" || saved === "list" || saved === "timeline" ? saved : "board";
}

/** A board layout on the cross-board view page, which has no timeline (D760): it shows as the list there. */
export function homeLayoutOf(view: BoardViewId): "list" | "table" | "board" {
  const layout = displayLayoutOf(view, undefined);
  return layout === "timeline" ? "list" : layout;
}

const single = (filter: TaskQuery, key: FilterTerm["key"]) => {
  const terms = filter.terms.filter((term) => term.key === key && !term.negate);
  return terms.length === 1 && terms[0]!.values.length === 1 ? terms[0]!.values[0]! : null;
};

export type ComposerStart = { columnId: string | null; prefill: ComposerPrefill; sprintId?: string | null };

/**
 * What New card starts with in a board view (D637): the view's single-value positive terms — a
 * column (or the first column of a state), a person (me, or someone already on the board), a tag, a
 * flag, a sprint. Anything else is left for the person to pick.
 */
export function composerStartFor(filter: TaskQuery, board: {
  columns: readonly StatefulColumn[]; tags: readonly BoardTag[]; people: readonly CardAssignee[]; sprints: readonly SprintSummary[]; userId: string; userName: string;
}): ComposerStart {
  const ordered = [...board.columns].sort((a, b) => a.position - b.position);
  const columnId = single(filter, "column");
  const state = single(filter, "state");
  const column = (columnId && ordered.find((item) => item.id === columnId)) || (state && ordered.find((item) => columnState(item) === state)) || null;
  const prefill: ComposerPrefill = {};
  const assignee = single(filter, "assignee");
  if (assignee === "me") prefill.assignees = [{ id: board.userId, display_name: board.userName, can_read: 1 }];
  else if (assignee && assignee !== "none") {
    const person = board.people.find((item) => item.id === assignee && item.can_read === 1);
    if (person) prefill.assignees = [person];
  }
  const tag = single(filter, "tag");
  const found = tag && tag !== "none" ? board.tags.find((item) => item.id === tag || item.name.toLowerCase() === tag.toLowerCase()) : undefined;
  if (found) prefill.tagIds = [found.id];
  const flag = single(filter, "flag");
  if (flag && flag !== "none") prefill.flags = [flag];
  const priority = single(filter, "priority");
  if (isTaskPriority(priority)) prefill.priority = priority;
  const sprint = single(filter, "sprint");
  const open = board.sprints.filter((item) => item.state !== "completed");
  const sprintId = sprint === "none" ? null
    : sprint === "current" ? open.find((item) => item.state === "active")?.id
    : sprint === "next" ? open.find((item) => item.state === "planned")?.id
    : sprint ? open.find((item) => item.id === sprint)?.id : undefined;
  return { columnId: column ? column.id : null, prefill, ...(sprintId !== undefined ? { sprintId } : {}) };
}

/**
 * A board view's filter after its Board field picked more boards (lane VIEWS2, D661): one `board:`
 * term with this board and the others, and the rest of the filter; column terms are left out (a
 * column filter needs exactly one board). Null while the filter stays on this board alone.
 */
export function widenToBoards(filter: TaskQuery, boardId: string): { filter: TaskQuery; droppedColumns: boolean } | null {
  const isBoard = (term: FilterTerm) => term.key === "board" && !term.negate;
  const picked = filter.terms.filter(isBoard).flatMap((term) => term.values);
  const boards = [...new Set([boardId, ...picked])];
  if (!picked.length || boards.length === 1) return null;
  const rest = filter.terms.filter((term) => !isBoard(term));
  return { filter: { terms: [{ key: "board", negate: false, values: boards }, ...rest.filter((term) => term.key !== "column")] }, droppedColumns: rest.some((term) => term.key === "column") };
}
