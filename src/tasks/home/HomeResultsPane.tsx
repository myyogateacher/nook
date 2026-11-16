import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { RotateCcw, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { format, type FilterKey } from "../../../shared/taskQuery";
import { LANE_MODES, tagLaneKey, type GroupChange, type LaneColumn, type LaneMode, type QueryLane } from "../../../shared/taskLanes";
import { api, ApiError } from "../../api";
import { ConfirmDialog } from "../../files/Dialog";
import type { User } from "../../types";
import { Select } from "../../ui/Select";
import { useHistoryDialogGuard } from "../../ui/useHistoryDialogGuard";
import { BoardViewSwitch } from "../BoardViewSwitch";
import { columnFullMessage, localDateString, type TaskNotify } from "../taskActions";
import { createTag, listBoards, moveCard, taskErrorCode, taskErrorMessage, updateCard, type TagColor } from "../tasksApi";
import { useIsPhone } from "../../ui/Listbox";
import { useRole } from "../../team/roleAccess";
import { canChangeCard, getViewLanePrefs, saveViewLanePrefs, saveViewPrefs, type QueriedCard } from "./homeApi";
import type { Swimlane } from "../../../shared/swimlanes";
import { cardLaneKeysOf, changeMessage, laneAddTargets, laneDrop, withGroupChange, withLaneMove, type LaneAddTarget } from "./laneModel";
import { LaneAddCard } from "./LaneAddCard";
import { HomeFilterBar } from "./HomeFilterBar";
import { refNames, STATE_LABELS } from "./homeResults";
import { HOME_GROUPS, HOME_SORTS, homeLanes, type HomeGroup, type HomeLayout, type HomeQuery, type HomeSort } from "./homeUrl";
import { QueryResults } from "./QueryResults";
import { movedMessage, ResultMoveSheet } from "./ResultMoveSheet";
import { useCardQuery, type CardSource } from "./useCardQuery";

/** A swimlane drop's person change across rows (lane VIEWS2, D665), with its toast. */
export type RowChange = { assigneeIds: string[]; message: string };
export type HomeDirectory = { boards: Array<{ id: string; name: string }>; users: Array<{ id: string; displayName: string }> };

/** The viewer's boards and the user list, for filter options and names (loaded once per visit to the home). */
export function useHomeDirectory(): HomeDirectory {
  const [directory, setDirectory] = useState<HomeDirectory>({ boards: [], users: [] });
  // Viewers and guests have no people directory (403 ROLE_READ_ONLY): do not ask for it.
  const { readOnly } = useRole();
  useEffect(() => {
    let active = true;
    listBoards().then(({ boards }) => { if (active) setDirectory((current) => ({ ...current, boards: boards.map((board) => ({ id: board.id, name: board.name })) })); }, () => undefined);
    if (!readOnly) api<{ users: User[] }>("/users").then(({ users }) => { if (active) setDirectory((current) => ({ ...current, users: users.map((user) => ({ id: user.id, displayName: user.displayName })) })); }, () => undefined);
    return () => { active = false; };
  }, [readOnly]);
  return directory;
}

export const GROUP_LABELS: Record<HomeGroup, string> = { none: "No grouping", board: "Board", state: "State", due: "Due date", assignee: "Assignee", tag: "Tag" };
export const SORT_LABELS: Record<HomeSort, string> = { due: "Due date", updated: "Recently updated", created: "Recently created", title: "Title", board: "Board", start: "Start date", priority: "Priority" };
export const LANE_LABELS: Record<LaneMode, string> = { columns: "Columns", state: "State", assignee: "Assignee", tag: "Tag", sprint: "Sprint", due: "Due date", board: "Board" };

/** The board layout asks for lanes (D643); the other layouts do not. */
export function withLanes(source: CardSource, lanes: LaneMode | null): CardSource {
  if (source.kind === "view") return lanes ? { ...source, lanes } : { kind: "view", viewId: source.viewId, tz: source.tz };
  const request = { ...source.request };
  delete request.lanes;
  return { kind: "query", request: lanes ? { ...request, lanes } : request };
}

/**
 * One person's collapsed lanes (D644): loaded once per view (or My work), changed at once on screen,
 * then saved; a failed save puts it back. `null` (an unsaved new view) keeps them in memory.
 */
function useCollapsedLanes(prefsKey: string | null, enabled: boolean, notify: TaskNotify, myWorkFilter?: string) {
  const filterRef = useRef(myWorkFilter);
  filterRef.current = myWorkFilter;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  useEffect(() => {
    setCollapsed(new Set());
    setRows(new Set());
    if (!prefsKey || !enabled) return;
    let active = true;
    getViewLanePrefs(prefsKey).then(({ collapsedLanes, collapsedRows }) => {
      if (!active) return;
      setCollapsed(new Set(collapsedLanes));
      setRows(new Set(collapsedRows ?? []));
    }, () => undefined);
    return () => { active = false; };
  }, [prefsKey, enabled]);
  // Folded swimlanes across boards (D665, D669), kept with the view's prefs (or My work's).
  const [rows, setRows] = useState<ReadonlySet<string>>(new Set());
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const toggleRow = useCallback((row: Swimlane) => {
    const before = rowsRef.current;
    const next = new Set(before);
    const collapsing = !next.has(row.key);
    if (collapsing) next.add(row.key); else next.delete(row.key);
    setRows(next);
    if (!prefsKey) return;
    saveViewPrefs(prefsKey, { collapsedRows: [...next] }).catch((reason) => {
      setRows(before);
      notify.error(taskErrorMessage(reason, `Could not ${collapsing ? "collapse" : "expand"} ${row.label}`));
    });
  }, [notify, prefsKey]);
  const toggle = useCallback((key: string, label: string) => {
    const before = collapsedRef.current;
    const next = new Set(before);
    const collapsing = !next.has(key);
    if (collapsing) next.add(key); else next.delete(key);
    setCollapsed(next);
    if (!prefsKey) return;
    // My work sends its filter, so the server can drop lanes that are gone (D653).
    saveViewLanePrefs(prefsKey, [...next], prefsKey === "my" ? filterRef.current : undefined).catch((reason) => {
      setCollapsed(before);
      notify.error(taskErrorMessage(reason, `Could not ${collapsing ? "collapse" : "expand"} ${label}`));
    });
  }, [notify, prefsKey]);
  return { collapsed, toggle, rows, toggleRow };
}

type HomeResultsPaneProps = {
  userId: string;
  query: HomeQuery;
  /** Layout switches and committed filter changes push; group, sort, and typing replace (§9.5). */
  onQuery: (next: HomeQuery, options: { push: boolean }) => void;
  /** What to run; null shows `idle` instead (Q11: a view needs a selective filter). */
  source: CardSource | null;
  idle?: ReactNode;
  directory: HomeDirectory;
  notify: TaskNotify;
  onOpenCard: (card: QueriedCard) => void;
  lockedKeys?: readonly FilterKey[];
  hiddenKeys?: readonly FilterKey[];
  readOnly?: boolean;
  /** First in the toolbar (My work's state chips), on the layout switch's row. */
  above?: ReactNode;
  /** Right of the layout controls (Save, Save as, …). */
  actions?: ReactNode;
  emptyText: string;
  /** Where collapsed lanes are kept (D644): a saved view's id, `my`, or null (an unsaved view: in memory only). */
  prefsKey?: string | null;
};

/** The filters a viewer set (the Filters button's count): locked and hidden keys (My work's assignee and state) are not theirs to count. */
export function activeFilterCount(terms: ReadonlyArray<{ key: FilterKey }>, lockedKeys: readonly FilterKey[] = [], hiddenKeys: readonly FilterKey[] = []) {
  return terms.filter((term) => !lockedKeys.includes(term.key) && !hiddenKeys.includes(term.key)).length;
}

/** The toolbar, filter bar, and results shared by My work and the view page (§9.1 "same controls, same place"). */
export function HomeResultsPane({ userId, query, onQuery, source, idle, directory, notify, onOpenCard, lockedKeys, hiddenKeys, readOnly = false, above, actions, emptyText, prefsKey = null }: HomeResultsPaneProps) {
  const lanesMode = query.layout === "board" ? homeLanes(query) : null;
  // Swimlanes across boards (D665): not the same field as the lanes (person rows under person lanes).
  const swimMode = lanesMode && query.swim && query.swim !== lanesMode ? query.swim : null;
  const result = useCardQuery(source ? withLanes(source, lanesMode) : null);
  const phone = useIsPhone();
  const { readOnly: roleReadOnly } = useRole();
  const lanes = useCollapsedLanes(prefsKey, lanesMode !== null, notify, prefsKey === "my" ? format(query.filter) : undefined);
  const resultRef = useRef(result);
  resultRef.current = result;
  const [moving, setMoving] = useState<{ card: QueriedCard; fromKey: string | null } | null>(null);
  const closeMove = useCallback(() => setMoving(null), []);
  useHistoryDialogGuard(moving !== null, closeMove);
  // Add a card on a lane (D654): the lane and the boards it offers.
  const [adding, setAdding] = useState<{ lane: QueryLane; targets: LaneAddTarget[] } | null>(null);
  const closeAdding = useCallback(() => setAdding(null), []);
  // "Create tag ‘X’ on <board> and move" (D666): the drop waiting for the person to confirm.
  const [creatingTag, setCreatingTag] = useState<{ card: QueriedCard; lane: QueryLane; fromKey: string | null; row?: RowChange; tagName: string; color: string; boardId: string; boardName: string } | null>(null);
  const closeCreatingTag = useCallback(() => setCreatingTag(null), []);
  useHistoryDialogGuard(creatingTag !== null, closeCreatingTag);
  const today = localDateString();
  const boards = useMemo(() => new Map(directory.boards.map((board) => [board.id, board.name])), [directory.boards]);
  const users = useMemo(() => new Map(directory.users.map((user) => [user.id, user.displayName])), [directory.users]);
  // Refs arrive with the first page only; keep the latest for the chips.
  const [refs, setRefs] = useState(result.refs);
  useEffect(() => { if (result.refs) setRefs(result.refs); }, [result.refs]);
  const names = refNames(refs, { boards, users, userId });
  const tagNames = useMemo(() => [...new Set(result.cards.flatMap((card) => card.tags.map((tag) => tag.name)))], [result.cards]);
  const onMoveError = useCallback((message: string) => { setMoving(null); notify(message); }, [notify]);
  // At 760 px and below the group, sort, and filter controls fold behind one "Filters" button
  // (QA 0.9.0: they took ~600 px on a phone); above that the toggle is hidden and they always show.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  const filterCount = activeFilterCount(query.filter.terms, lockedKeys, hiddenKeys);

  /**
   * A drop on a lane (D641, D642, D651): to the top of the lane's column on the card's own board, or
   * a change of its people, tags, or sprint, at once on screen; the server stays the judge (edit
   * level, WIP 409, the revision, the done and archive clocks). A refusal says why and fetches the
   * results again (D652), so a change that landed meanwhile shows too.
   */
  /**
   * Runs a drop's changes (D641, D651, D665): a field change and a swimlane's person change in one
   * PATCH with the card's revision, then a column move; at once on screen. A refusal says why and
   * fetches the results again (D652).
   */
  const applyChanges = useCallback(async (card: QueriedCard, plan: { column: { columnId: string; column: LaneColumn } | null; group: GroupChange | null; row?: RowChange; lane: QueryLane | null }) => {
    const { column, group, row, lane } = plan;
    resultRef.current.update((state) => {
      let next = column ? withLaneMove(state, card.id, column.column) : state;
      if (group) next = withGroupChange(next, card.id, group);
      if (row) next = withGroupChange(next, card.id, { field: "assignees", assigneeIds: row.assigneeIds });
      return next;
    });
    const body = {
      ...(group?.field === "assignees" ? { assigneeIds: group.assigneeIds } : group?.field === "tags" ? { tagIds: group.tagIds } : group?.field === "sprint" ? { sprintId: group.sprintId } : {}),
      ...(row ? { assigneeIds: row.assigneeIds } : {})
    };
    try {
      if (Object.keys(body).length) {
        const { card: saved } = await updateCard(card.id, { ...body, revision: card.revision });
        resultRef.current.patchCard(card.id, { revision: saved.revision, updated_at: saved.updated_at, ...("assigneeIds" in body && saved.assignees ? { assignees: saved.assignees } : {}) });
      }
      if (column) {
        const saved = await moveCard(card.id, column.columnId, null);
        resultRef.current.patchCard(card.id, { revision: saved.card.revision, updated_at: saved.card.updated_at, archived_at: saved.card.archived_at ?? null });
      }
      notify([column ? movedMessage(column.column.name, STATE_LABELS[column.column.state]) : null, group && lane ? changeMessage(group, lane) : null, row?.message ?? null].filter(Boolean).join(" · "));
    } catch (reason) {
      const code = taskErrorCode(reason);
      notify.warning(code === "COLUMN_FULL" && column ? columnFullMessage(column.column.name, column.column.wip_limit)
        : code === "CARD_CHANGED" ? "Someone else changed that card. Showing the latest results." : taskErrorMessage(reason, "Could not change the card"));
      void resultRef.current.refresh();
    }
  }, [notify]);

  const dropOnLane = useCallback(async (card: QueriedCard, lane: QueryLane | null, fromKey: string | null, row?: RowChange) => {
    const layout = resultRef.current.lanes;
    if (!layout) return;
    const drop = lane ? laneDrop(layout, lane, card, canChangeCard(card, roleReadOnly), fromKey) : null;
    if (drop && "refusal" in drop && !(drop.refusal === "SAME_LANE" && row)) {
      if (drop.refusal !== "SAME_LANE") notify.warning(drop.message);
      return;
    }
    if (drop && "kind" in drop && drop.kind === "createTag") {
      setCreatingTag({ card, lane: lane!, fromKey, row, tagName: drop.tagName, color: drop.color, boardId: drop.boardId, boardName: drop.boardName });
      return;
    }
    const column = drop && "kind" in drop && drop.kind === "column" ? drop : null;
    const group = drop && "kind" in drop && drop.kind === "group" ? drop.change : null;
    await applyChanges(card, { column, group, row, lane });
  }, [applyChanges, notify, roleReadOnly]);


  /** "Create tag ‘X’ on <board> and move" (D666): the tag first (an existing one of that name is used), then the retag. */
  const confirmCreateTag = useCallback(async () => {
    const pending = creatingTag;
    if (!pending) return;
    setCreatingTag(null);
    let tagId: string;
    try {
      tagId = (await createTag(pending.boardId, pending.tagName, pending.color as TagColor)).tag.id;
    } catch (reason) {
      const existing = reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? (reason.payload as { tag?: { id: string } }).tag : undefined;
      if (taskErrorCode(reason) !== "TAG_EXISTS" || !existing) {
        notify.warning(taskErrorMessage(reason, "Could not create the tag"));
        return;
      }
      tagId = existing.id;
    }
    const from = pending.fromKey?.startsWith("t:") ? pending.fromKey : null;
    const tagIds = [...pending.card.tags.filter((tag) => from === null || tagLaneKey(tag.name) !== from).map((tag) => tag.id), tagId];
    await applyChanges(pending.card, { column: null, group: { field: "tags", tagIds }, row: pending.row, lane: pending.lane });
    // The new tag is a target of the lane now: fetch the lanes again.
    void resultRef.current.refresh();
  }, [applyChanges, creatingTag, notify]);
  const openAdd = useCallback((lane: QueryLane) => {
    const layout = resultRef.current.lanes;
    if (!layout) return;
    const targets = laneAddTargets(layout, lane, roleReadOnly);
    if (!targets.length) notify("None of these boards can take a card here");
    else setAdding({ lane, targets });
  }, [notify, roleReadOnly]);

  return <div className={`task-home-pane${filtersOpen ? " filters-open" : ""}`}>
    <div className="task-home-toolbar">
      {above}
      <BoardViewSwitch value={query.layout} views={["list", "table", "board"]} onChange={(layout) => onQuery({ ...query, layout: layout as HomeLayout }, { push: true })} />
      <button type="button" className="secondary-button task-home-filters-toggle" aria-expanded={filtersOpen} aria-controls={filtersId} onClick={() => setFiltersOpen((open) => !open)}>
        <SlidersHorizontal aria-hidden="true" /><span>{filterCount ? `Filters · ${filterCount}` : "Filters"}</span>
      </button>
      <span className="task-home-collapsible task-home-sorts">
        {lanesMode && <Select<LaneMode> variant="chip" label="Lanes" value={lanesMode} searchable={false}
          options={LANE_MODES.map((mode) => ({ value: mode, label: `Lanes: ${LANE_LABELS[mode]}` }))} onChange={(mode) => onQuery({ ...query, lanes: mode === "columns" ? undefined : mode }, { push: false })} />}
        {lanesMode && <Select<string> variant="chip" label="Swimlanes" value={swimMode ?? "none"} searchable={false} className="task-swim-select"
          options={[{ value: "none", label: "Swimlanes: None" }, ...(lanesMode !== "assignee" ? [{ value: "assignee", label: "Swimlanes: Assignee" }] : []), ...(lanesMode !== "board" ? [{ value: "board", label: "Swimlanes: Board" }] : [])]}
          onChange={(value) => onQuery({ ...query, swim: value === "assignee" || value === "board" ? value : undefined }, { push: false })} />}
        {query.layout === "list" && <Select<HomeGroup> variant="chip" label="Group by" value={query.group} searchable={false}
          options={HOME_GROUPS.map((group) => ({ value: group, label: `Group: ${GROUP_LABELS[group]}` }))} onChange={(group) => onQuery({ ...query, group }, { push: false })} />}
        <Select<HomeSort> variant="chip" label="Sort by" value={query.sort} searchable={false}
          options={HOME_SORTS.map((sort) => ({ value: sort, label: `Sort: ${SORT_LABELS[sort]}` }))} onChange={(sort) => onQuery({ ...query, sort }, { push: false })} />
      </span>
      {actions && <span className="task-home-actions">{actions}</span>}
    </div>
    <div id={filtersId} className="task-home-collapsible">
      <HomeFilterBar filter={query.filter} names={names} options={{ boards: directory.boards, users: directory.users.filter((user) => user.id !== userId), tagNames }}
        lockedKeys={lockedKeys} hiddenKeys={hiddenKeys} readOnly={readOnly} onChange={(filter, options) => onQuery({ ...query, filter }, options)} />
    </div>
    <div className="task-home-results">
      {!source && idle}
      {source && result.status === "loading" && <p className="bin-loading" role="status">Loading cards…</p>}
      {source && result.status === "error" && <div className="bin-state bin-error" role="alert">
        <span className="bin-state-icon"><TriangleAlert /></span>
        <h2>Could not load the cards</h2>
        <p>{result.error}</p>
        <button className="primary-button" onClick={result.retry}><RotateCcw />Try again</button>
      </div>}
      {source && result.status === "ready" && <QueryResults cards={result.cards} layout={query.layout} group={query.group} today={today} userId={userId}
        total={result.total} nextCursor={result.nextCursor} loadingMore={result.loadingMore} onLoadMore={() => { void result.loadMore(); }}
        onOpenCard={onOpenCard} onMoveCard={(card, _trigger, fromKey) => setMoving({ card, fromKey: fromKey ?? null })} emptyText={emptyText}
        lanes={result.lanes && lanesMode ? { layout: result.lanes, collapsed: lanes.collapsed, phone,
          onToggleCollapsed: (key) => lanes.toggle(key, result.lanes?.columns.find((lane) => lane.key === key)?.label ?? "the lane"),
          onDropCard: (card, lane, fromKey, row) => { void dropOnLane(card, lane, fromKey, row); }, onRefused: (message) => notify(message),
          ...(swimMode ? { swim: { mode: swimMode, collapsedRows: lanes.rows, onToggleRow: lanes.toggleRow } } : {}),
          onAddCard: (lane) => openAdd(lane), canAddCard: (lane) => result.lanes ? laneAddTargets(result.lanes, lane, roleReadOnly).length > 0 : false } : undefined} />}
      {source && result.status === "ready" && result.error && <p className="file-dialog-error" role="alert">{result.error}</p>}
    </div>
    {moving && <ResultMoveSheet card={moving.card} onCancel={closeMove} onError={onMoveError}
      lanes={result.lanes && lanesMode ? {
        layout: result.lanes, canEdit: canChangeCard(moving.card, roleReadOnly), today,
        fromKey: moving.fromKey ?? cardLaneKeysOf(result.lanes, moving.card, today)[0]!,
        onLane: (lane) => { const { card, fromKey } = moving; setMoving(null); void dropOnLane(card, lane, fromKey ?? cardLaneKeysOf(result.lanes!, card, today)[0]!); }
      } : undefined}
      onMoved={(change, message) => {
      result.patchCard(moving.card.id, change);
      setMoving(null);
      notify(message);
    }} />}
    {creatingTag && <ConfirmDialog title={`Create tag “${creatingTag.tagName}”?`} confirmLabel="Create tag and move" onCancel={closeCreatingTag} onConfirm={() => { void confirmCreateTag(); }}
      message={`${creatingTag.boardName} has no ${creatingTag.tagName} tag. Create it on ${creatingTag.boardName} and tag “${creatingTag.card.title}” with it?`} />}
    {adding && <LaneAddCard lane={adding.lane} targets={adding.targets} userId={userId} notify={notify} onClose={closeAdding}
      onCreated={(card, board, mode) => {
        if (mode !== "another") setAdding(null);
        notify.success(`Added “${card.title}” to ${board.board.name}`);
        void resultRef.current.refresh();
        if (mode === "open") onOpenCard({ id: card.id, board_id: board.board.id } as QueriedCard);
      }} />}
  </div>;
}

