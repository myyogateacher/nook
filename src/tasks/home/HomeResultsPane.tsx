import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { RotateCcw, SlidersHorizontal, TriangleAlert } from "lucide-react";
import type { FilterKey } from "../../../shared/taskQuery";
import { api } from "../../api";
import type { User } from "../../types";
import { Select } from "../../ui/Select";
import { useHistoryDialogGuard } from "../../ui/useHistoryDialogGuard";
import { BoardViewSwitch } from "../BoardViewSwitch";
import { localDateString, type TaskNotify } from "../taskActions";
import { listBoards } from "../tasksApi";
import { useRole } from "../../team/roleAccess";
import type { QueriedCard } from "./homeApi";
import { HomeFilterBar } from "./HomeFilterBar";
import { refNames } from "./homeResults";
import { HOME_GROUPS, HOME_SORTS, type HomeGroup, type HomeLayout, type HomeQuery, type HomeSort } from "./homeUrl";
import { QueryResults } from "./QueryResults";
import { ResultMoveSheet } from "./ResultMoveSheet";
import { useCardQuery, type CardSource } from "./useCardQuery";

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
export const SORT_LABELS: Record<HomeSort, string> = { due: "Due date", updated: "Recently updated", created: "Recently created", title: "Title", board: "Board" };

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
};

/** The filters a viewer set (the Filters button's count): locked and hidden keys (My work's assignee and state) are not theirs to count. */
export function activeFilterCount(terms: ReadonlyArray<{ key: FilterKey }>, lockedKeys: readonly FilterKey[] = [], hiddenKeys: readonly FilterKey[] = []) {
  return terms.filter((term) => !lockedKeys.includes(term.key) && !hiddenKeys.includes(term.key)).length;
}

/** The toolbar, filter bar, and results shared by My work and the view page (§9.1 "same controls, same place"). */
export function HomeResultsPane({ userId, query, onQuery, source, idle, directory, notify, onOpenCard, lockedKeys, hiddenKeys, readOnly = false, above, actions, emptyText }: HomeResultsPaneProps) {
  const result = useCardQuery(source);
  const [moving, setMoving] = useState<QueriedCard | null>(null);
  const closeMove = useCallback(() => setMoving(null), []);
  useHistoryDialogGuard(moving !== null, closeMove);
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

  return <div className={`task-home-pane${filtersOpen ? " filters-open" : ""}`}>
    <div className="task-home-toolbar">
      {above}
      <BoardViewSwitch value={query.layout} views={["list", "table", "board"]} onChange={(layout) => onQuery({ ...query, layout: layout as HomeLayout }, { push: true })} />
      <button type="button" className="secondary-button task-home-filters-toggle" aria-expanded={filtersOpen} aria-controls={filtersId} onClick={() => setFiltersOpen((open) => !open)}>
        <SlidersHorizontal aria-hidden="true" /><span>{filterCount ? `Filters · ${filterCount}` : "Filters"}</span>
      </button>
      <span className="task-home-collapsible task-home-sorts">
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
        onOpenCard={onOpenCard} onMoveCard={(card) => setMoving(card)} emptyText={emptyText} />}
      {source && result.status === "ready" && result.error && <p className="file-dialog-error" role="alert">{result.error}</p>}
    </div>
    {moving && <ResultMoveSheet card={moving} onCancel={closeMove} onError={onMoveError} onMoved={(change, message) => {
      result.patchCard(moving.id, change);
      setMoving(null);
      notify(message);
    }} />}
  </div>;
}
