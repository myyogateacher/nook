import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { recordRecent } from "../shell/recents";
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronsLeftRight, ChevronsRightLeft, CircleCheck, Download, Gauge, Pencil, Plus, RotateCcw, Rows3, Settings2, Trash2, TriangleAlert } from "lucide-react";
import { BoardSettingsSheet } from "./BoardSettingsSheet";
import { BoardHeaderItemsOutlet } from "../ui/CardSlotOutlets";
import { keyedSendQueue } from "./keyedSendQueue";
import { useBoardHierarchy } from "./useBoardHierarchy";
import { useBoardSprints } from "./useBoardSprints";
import { SprintBar } from "./SprintBar";
import { SprintCompleteDialog } from "./SprintCompleteDialog";
import { SprintSettingsSection } from "./SprintSettingsSection";
import { SprintDefaultsSection } from "./SprintDefaultsSection";
import { SprintsSheet } from "./SprintsSheet";
import { NewSprintDialog } from "./NewSprintForm";
import { activeSprint, sprintFilterConflict, withLocalCounts } from "./sprintModel";
import { binConfirmMessage, type TaskNotify } from "./taskActions";
import { ApiError } from "../api";
import { ConfirmDialog, ModalDialog } from "../files/Dialog";
import { NameDialog } from "../files/RenameDialog";
import { BoardColumnView } from "./BoardColumnView";
import { ColumnStatusIcon, columnStatuses, columnStatusId } from "./ColumnStatusIcon";
import { AccessSheet } from "../access/AccessSheet";
import { CardComposer, type ComposerMode } from "./CardComposer";
import { CardDialog } from "./CardDialog";
import { CardPage } from "./CardPage";
import { useRole } from "../team/roleAccess";
import { MoveCardSheet } from "./MoveCardSheet";
import { copyCardLink } from "./cardLink";
import { focusBoardCard } from "./cardFocus";
import { afterCardIdAt, applyLocalMove, applyPositions, byPosition, cardPlace, columnCards, columnIndexFromScroll, columnMoveAnchor, isNoopMove, keyboardMoveTarget, mergeMovedCard, moveChangesBlockers, readCardDragPayload, sheetMoveAnchor, type MoveKey } from "./boardOrder";
import { isMobileViewport } from "../mobileNavigation";
import { useIsPhone } from "../ui/Listbox";
import { formatRoute } from "../router";
import { tasksRoute } from "../tasksRoute";
import { columnIndexFor, createTasksHistoryState } from "../tasksNavigation";
import { addCardRefusal, canEnterColumn, cardCountLabel, cardsReadOnly, columnBadge, columnFullMessage, validateBoardName, validateColumnName } from "./taskActions";
import { WipLimitDialog } from "./WipLimitDialog";
import { ColumnStateField } from "./views/ColumnStateField";
import { columnState } from "./home/homeApi";
import { STATE_LABELS } from "./home/homeResults";
import { BoardGroupedList } from "./BoardGroupedList";
import { BoardTable } from "./BoardTable";
import { BoardViewSwitch } from "./BoardViewSwitch";
import { applyBoardQuery, boardData, filterBoardCards, type BoardContext } from "./boardQuery";
import { hasBoardFilter, withBoardQuery, type BoardQuery, type BoardViewId } from "./boardUrl";
import type { TaskQuery } from "../../shared/taskQuery";
import { isSwimlaneMode, type Swimlane, type SwimlaneMode, swimlaneChange } from "../../shared/swimlanes";
import { BoardSwimlanes } from "./BoardSwimlanes";
import type { ComposerPrefill } from "./composerDraft";
import { Select } from "../ui/Select";
import type { FilterField } from "./boardQuery";
import { useBoardSavedViews } from "./views/BoardSavedViews";
import { composerStartFor, sameFilter, widenToBoards } from "./views/boardViewModel";
import type { TaskView } from "./home/homeApi";
import { localDateString, viewerTimeZone } from "./taskActions";
import { FilterBar } from "./FilterBar";
import { KeyboardMoveHint } from "./boardViewParts";
import { useTasksTitle } from "./home/HomeSegments";
import { BoardCalendar } from "./BoardCalendar";
import { displayedDay, displayedTime, dueAnnouncement, shiftedDueAt, shiftedStartOn } from "./calendarPlacement";
import { daysBetween } from "../calendarRoute";
import { BoardTimeline } from "./BoardTimeline";
import { barLabel, barOf, type DateChange } from "./timelinePlacement";
import "./boardViews.css";
import { applyCardDetail, applyTagChange, recountTags } from "./cardTags";
import {
  createColumn,
  listBoards,
  deleteBoard,
  deleteCard,
  deleteColumn,
  restoreTaskItem,
  getBoard,
  getArchivedCards,
  saveBoardView,
  archiveCard,
  unarchiveCard,
  updateCard,
  moveCard,
  renameBoard,
  taskErrorCode,
  taskErrorMessage,
  updateColumn,
  moveCardToBoard,
  type BoardDetail,
  type BoardSummary,
  type CardDetail,
  type CardSummary,
  nameBoardCards
} from "./tasksApi";
import { cardKey } from "../../shared/boardKeys";
import { useHistoryDialogGuard } from "./useHistoryDialogGuard";
import { useLayerOpener } from "../historyDialogs";
import { estimateSettingsOf } from "../../shared/estimates";

type BoardViewProps = {
  userId: string;
  boardId: string;
  /** The card the URL names; its dialog is open over the board. */
  openCardId: string | null;
  /** The card is open as a full page (/card/:k/full) in the board's place. */
  openCardFull?: boolean;
  onExpandCard?: () => void;
  onCollapseCard?: () => void;
  onOpenCard: (cardId: string) => void;
  onCloseCard: () => void;
  onBack: () => void;
  onMissing: () => void;
  notify: TaskNotify;
  /** After the board moved to the Bin: leave it for the list. */
  onBoardDeleted: () => void;
  onOpenBoard: (boardId: string) => void;
  /** Opens a card on any board (a relation link): pushes its route. */
  onOpenCardRoute?: (boardId: string, cardId: string) => void;
  /**
   * The open card is on another board now (lane KEYS, D716: it moved, or an old link named this
   * board): the host replaces the entry with the card on its board.
   */
  onCardElsewhere?: (boardId: string, cardId: string) => void;
  /** The Sprints sheet (/tasks/:b/sprints) is open over the board; the host opens and closes its route. */
  sprintsOpen?: boolean;
  onOpenSprints?: () => void;
  onCloseSprints?: () => void;
  /** The view, grouping, sort, and filters from the URL query (D112). */
  query: BoardQuery;
  /**
   * `push` for a view switch; filter, sort, and group edits replace the entry (§4.7). Under a saved
   * view, `unsaved` says the filter differs from the view's (the URL then carries it).
   */
  onQueryChange: (query: BoardQuery, options?: { push?: boolean; unsaved?: boolean }) => void;
  /** Lane VIEWS (D635–D638): the saved view the route names on this board, and whether its filter has an unsaved change. */
  savedViewId?: string | null;
  viewUnsaved?: boolean;
  /** Shows a saved view on this board, or All cards (null); `replace` after a save or delete. */
  onSavedView?: (view: TaskView | null, options?: { replace?: boolean }) => void;
  /** The saved view is no longer on this board: its cross-board page, with an unsaved filter that spans more boards (D661). */
  onLeaveSavedView?: (viewId: string, change?: { filter: TaskQuery; layout: BoardViewId }) => void;
  /** The viewer's name, for a view's "assignee:me" on a new card. */
  displayName?: string;
};

type BoardDialog =
  | { kind: "settings" }
  // `overSettings`: opened from Board settings, which stays open underneath (one Back, one layer).
  | { kind: "rename" | "share" | "addColumn" | "deleteBoard"; overSettings?: boolean }
  | { kind: "columnMenu" | "renameColumn" | "deleteColumn" | "wipLimit"; columnId: string }
  | { kind: "moveCard"; cardId: string }
  | { kind: "completeSprint"; sprintId: string }
  | { kind: "newSprint" };

export const MAX_COLUMNS = 20;

export function BoardView({ userId, boardId, openCardId, openCardFull = false, onExpandCard, onCollapseCard, onOpenCard, onCloseCard, onBack, onMissing, notify, onBoardDeleted, onOpenBoard, onOpenCardRoute, onCardElsewhere, query: routeQuery, onQueryChange: routeQueryChange, sprintsOpen = false, onOpenSprints, onCloseSprints,
  savedViewId = null, viewUnsaved = false, onSavedView, onLeaveSavedView, displayName = "Me" }: BoardViewProps) {
  const focusCardId = openCardId;
  const [boardDetail, setDetail] = useState<BoardDetail | null>(null);
  // A saved view on this board (D635–D638): the board engine runs the view's filter (or the URL's
  // unsaved change to it); the board waits until the view has loaded.
  const savedViews = useBoardSavedViews({
    boardId, savedViewId, routeFilter: routeQuery.filter, unsaved: viewUnsaved, layout: routeQuery.view, notify,
    onSelect: (view, options) => onSavedView?.(view, options),
    onLeave: (viewId) => onLeaveSavedView?.(viewId),
    swim: routeQuery.swim === "none" ? null : routeQuery.swim ?? undefined,
    boardCollapse: { columns: boardDetail?.view?.collapsedColumnIds ?? [], rows: boardDetail?.view?.collapsedRows ?? [] }
  });
  const savedFilterRef = useRef(savedViews.savedFilter);
  savedFilterRef.current = savedViews.savedFilter;
  const query: BoardQuery = savedViewId ? { ...routeQuery, filter: savedViews.filter } : routeQuery;
  const onQueryChange = useCallback((next: BoardQuery, options: { push?: boolean } = {}) => {
    if (!savedViewId) {
      routeQueryChange(next, options);
      return;
    }
    // Lane VIEWS2 (D661): a Board filter widens the view to more boards; it goes on as the
    // cross-board view, with this board and the change (column filters stay on one board).
    const widened = widenToBoards(next.filter, boardId);
    if (widened) {
      if (widened.droppedColumns) notify("Column filters apply to one board, so they were left out");
      onLeaveSavedView?.(savedViewId, { filter: widened.filter, layout: next.view });
      return;
    }
    // Only this board picked: nothing to widen (the board engine has no board to match on, D635).
    next = { ...next, filter: { terms: next.filter.terms.filter((term) => !(term.key === "board" && !term.negate)) } };
    const saved = savedFilterRef.current;
    const unsaved = !saved || !sameFilter(next.filter, saved);
    routeQueryChange(unsaved ? next : { ...next, filter: { terms: [] } }, { ...options, unsaved });
  }, [boardId, notify, onLeaveSavedView, routeQueryChange, savedViewId]);
  const detail = savedViews.pending ? null : boardDetail;
  const [loadError, setLoadError] = useState<string | null>(null);
  // A saved view's Board field (D661) offers the other boards the viewer can open.
  const [otherBoards, setOtherBoards] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    if (!savedViewId) return;
    let active = true;
    listBoards().then(({ boards }) => { if (active) setOtherBoards(boards.map((item) => ({ id: item.id, name: item.name }))); }, () => undefined);
    return () => { active = false; };
  }, [savedViewId]);
  const [dialog, setDialog] = useState<BoardDialog | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ columnId: string; index: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // The card composer (a guarded dialog, no history entry): the column it was opened from, or null.
  const [composer, setComposer] = useState<{ columnId: string | null; parentId?: string; prefill?: ComposerPrefill } | null>(null);
  // Read-only Team roles never get the composer (the card dialog hides its Add controls too), and
  // neither do members below `edit` on this board (Wave 32, D272: viewers and commenters).
  const { readOnly: roleReadOnly } = useRole();
  const detailRef = useRef(boardDetail);
  detailRef.current = boardDetail;
  // The control that opened the current dialog, so focus can return to it.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // Phones show one column at a time on a scroll-snap track; the index lives in the entry's hint.
  const [activeColumn, setActiveColumn] = useState(0);
  const activeColumnRef = useRef(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const hintTimerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setDetail(await getBoard(boardId));
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) onMissing();
      else setLoadError(taskErrorMessage(reason, "Could not load this board"));
    }
  }, [boardId, onMissing]);
  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);

  // First load: show the column this entry was on (Back/Forward and reloads return to it).
  const loaded = detail !== null;
  useEffect(() => {
    if (!loaded) return;
    const current = detailRef.current!;
    const focusColumn = focusCardId ? current.cards.find((card) => card.id === focusCardId)?.column_id : undefined;
    const ordered = [...current.columns].sort(byPosition);
    const fromCard = focusColumn ? ordered.findIndex((column) => column.id === focusColumn) : -1;
    const index = fromCard >= 0 ? fromCard : columnIndexFor(window.history.state, userId, boardId, ordered.length);
    activeColumnRef.current = index;
    setActiveColumn(index);
    const track = trackRef.current;
    if (track && isMobileViewport()) track.scrollTo({ left: index * track.clientWidth, behavior: "instant" as ScrollBehavior });
    // Only once per board load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, boardId]);

  useEffect(() => () => { if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current); }, []);

  // Closing the card dialog returns focus to the card on the board.
  const lastOpenCardRef = useRef<string | null>(null);
  useEffect(() => {
    if (openCardId) lastOpenCardRef.current = openCardId;
    else if (lastOpenCardRef.current) {
      focusCard(lastOpenCardRef.current);
      lastOpenCardRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCardId]);

  const closeDialog = useCallback(() => {
    setDialog(null);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target) window.setTimeout(() => { if (target.isConnected) target.focus(); }, 0);
  }, []);
  // Dialogs over the Sprints sheet (Complete, New sprint) are the board's dialog: Back closes only them.
  // Forward after Back closed Board settings opens it again, then the layer that was over it (D478);
  // the other board dialogs and Move to Bin are not reopened.
  const overSettingsNow = dialog !== null && "overSettings" in dialog && dialog.overSettings === true;
  const lastSettingsLayerRef = useRef<BoardDialog | null>(null);
  if (overSettingsNow && dialog.kind !== "deleteBoard") lastSettingsLayerRef.current = dialog;
  useHistoryDialogGuard(dialog !== null, closeDialog, {
    reopen: dialog?.kind === "settings" || overSettingsNow ? () => setDialog({ kind: "settings" }) : null,
    layerKey: dialog?.kind === "settings" ? "tasks.board-settings" : undefined
  });
  // H3: Forward after Back went past the board and came back reopens Board settings and the layer over it.
  useLayerOpener("tasks.board-settings", () => setDialog({ kind: "settings" }));
  useLayerOpener("tasks.settings-layer", (kind) => {
    if (kind === "rename" || kind === "share" || kind === "addColumn") setDialog({ kind, overSettings: true });
  });

  // Rename, Share, Add column, and Move to Bin opened from Board settings are a layer above it: the
  // settings sheet stays mounted (its unsaved structure draft too), and closing the layer by Back,
  // Close, Escape, the scrim, Cancel, or a successful save shows it again; the next Back closes it.
  // This guard registers after the board's, so it is asked first (historyDialogs.ts).
  const overSettings = dialog !== null && "overSettings" in dialog && dialog.overSettings === true;
  const settingsChildOpenerRef = useRef<HTMLElement | null>(null);
  const backToSettings = useCallback(() => {
    setDialog({ kind: "settings" });
    const target = settingsChildOpenerRef.current;
    settingsChildOpenerRef.current = null;
    if (target) window.setTimeout(() => { if (target.isConnected) target.focus(); }, 0);
  }, []);
  useHistoryDialogGuard(overSettings, backToSettings, {
    reopen: dialog?.kind === "deleteBoard" ? null : () => { if (lastSettingsLayerRef.current) setDialog(lastSettingsLayerRef.current); },
    layerKey: overSettings && dialog.kind !== "deleteBoard" ? `tasks.settings-layer:${dialog.kind}` : undefined
  });
  const openOverSettings = (kind: "rename" | "share" | "addColumn" | "deleteBoard") => {
    settingsChildOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialog({ kind, overSettings: true });
  };
  /** Closes the top layer: back to Board settings when it is underneath, else the board. */
  const closeLayer = overSettings ? backToSettings : closeDialog;

  const openDialog = (next: BoardDialog, trigger?: HTMLElement | null) => {
    returnFocusRef.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setDialog(next);
  };

  // Cards this view just moved to the Bin with a tree (D129): Back may land on one (a subtask opened
  // from its parent's breadcrumb); it then steps on quietly, keeping the Undo toast.
  const binnedRef = useRef(new Set<string>());
  const openCardIdRef = useRef(openCardId);
  openCardIdRef.current = openCardId;
  const onCardMissing = useCallback(() => {
    if (!openCardIdRef.current || !binnedRef.current.has(openCardIdRef.current)) notify.warning("Card not found");
    onCloseCard();
  }, [notify, onCloseCard]);

  const board = detail?.board ?? null;
  const owner = board?.is_owner === 1;
  // Lane ESTIMATES (D754, D755): what card estimates mean here; off hides them everywhere.
  const estimates = estimateSettingsOf(board);
  const readOnly = cardsReadOnly(roleReadOnly, board?.level);
  // Managers (Wave 32, D273) change the structure, columns, tags, sprints, and sharing up to Can edit.
  const canManage = !roleReadOnly && (owner || board?.level === "manage");
  // The tab names the board, and the open card before it (QA 0.9.0).
  const openCardTitle = openCardId ? detail?.cards.find((card) => card.id === openCardId)?.title ?? null : null;
  useTasksTitle(board ? `${openCardTitle ? `${openCardTitle} · ` : ""}${savedViews.view ? `${savedViews.view.name} · ` : ""}${board.name} · Tasks` : null);
  // The sidebar's recent boards (D1282): this board, by its own URL.
  const boardName = board?.name ?? null;
  useEffect(() => { if (boardName !== null) recordRecent("tasks", userId, { id: boardId, name: boardName, href: formatRoute(tasksRoute(boardId)) }); }, [userId, boardId, boardName]);
  const cardPage = Boolean(openCardId && openCardFull && board);
  // Back on the board from the full page: the phone track shows the column this entry was on.
  useEffect(() => {
    const track = trackRef.current;
    if (!cardPage && track && isMobileViewport()) track.scrollTo({ left: activeColumnRef.current * track.clientWidth, behavior: "instant" as ScrollBehavior });
  }, [cardPage]);
  const columns = [...(detail?.columns ?? [])].sort(byPosition);
  // Each column's status icon (D629): from its state and its place, left to right.
  const statuses = columnStatuses(columns);
  const cards = detail?.cards ?? [];
  const shownColumn = Math.max(0, Math.min(activeColumn, columns.length - 1));
  const dialogColumn = dialog && "columnId" in dialog ? columns.find((column) => column.id === dialog.columnId) ?? null : null;
  const dialogCard = dialog?.kind === "moveCard" ? cards.find((card) => card.id === dialog.cardId) ?? null : null;

  // One pipeline for every view (§4.5): filter, sort, and (in the list view) group the loaded board.
  const data = useMemo(() => detail ? boardData(detail) : null, [detail]);
  const viewContext: BoardContext = { userId, today: localDateString(), now: Date.now(), timeZone: viewerTimeZone() };
  // Sprints (17B): the sprint on screen (`?sprint=`, the active one by default) scopes every view
  // through one more grammar term; the filter bar keeps only the viewer's own terms.
  const sprints = useBoardSprints({ detail, setDetail, query, onQueryChange, notify, load, defaultAll: savedViewId !== null });
  const sprintScoped = sprints.term !== null;
  const scopedQuery = sprints.term ? { ...query, filter: { terms: [...query.filter.terms, sprints.term] } } : query;
  // The timeline groups by the list's dimensions when one is picked (D768); it is not grouped by default.
  const timelineGrouped = query.view === "timeline" && query.group !== null;
  const result = data ? applyBoardQuery(data, timelineGrouped ? { ...scopedQuery, view: "list" } : scopedQuery, viewContext) : null;
  const timelineGroups = timelineGrouped ? result?.groups ?? null : null;
  const scopedTotal = data && sprints.term ? filterBoardCards(data, { terms: [sprints.term] }, viewContext).length : cards.length;
  const filtered = hasBoardFilter(query);
  const view = query.view;
  const phone = useIsPhone();
  // The lanes show the matching cards; drag and keyboard moves anchor on the cards in view.
  const laneCards: CardSummary[] = (filtered || sprintScoped) && result ? result.cards : cards;
  const laneCardsRef = useRef(laneCards);
  laneCardsRef.current = laneCards;
  // The viewer's collapsed columns (D602), from their own saved view of the board, or a saved view's
  // own while it keeps them (lane VIEWS2, D657); and the swimlanes they collapsed (D656).
  const ownCollapse = savedViews.ownCollapse;
  const collapsedIds = ownCollapse ? ownCollapse.columns : detail?.view?.collapsedColumnIds;
  const collapsed = useMemo(() => new Set(collapsedIds ?? []), [collapsedIds]);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const collapsedRowKeys = ownCollapse ? ownCollapse.rows : detail?.view?.collapsedRows;
  const collapsedRows = useMemo(() => new Set(collapsedRowKeys ?? []), [collapsedRowKeys]);
  const showArchived = detail?.view?.showArchived ?? false;
  // Hierarchy (17A): which levels the lanes show, chips, nesting by drag, and the card dialog's checklist.
  const hierarchy = useBoardHierarchy({
    detail, detailRef, setDetail, notify, load, onOpenCard,
    move: (cardId, columnId, afterCardId) => move(cardId, columnId, afterCardId),
    openComposer: ({ parentId }) => setComposer({ columnId: null, parentId })
  });

  const shownLane = hierarchy.visible(laneCards, filtered);
  const sprintConflict = sprintFilterConflict(query.filter.terms, sprints.selection, sprints.sprints);
  const showAllLevels = () => {
    hierarchy.setShowAll(true);
    notify("Showing all levels. Turn it off in Board settings.");
  };

  const setCards = (change: (cards: CardSummary[]) => CardSummary[]) =>
    setDetail((current) => current ? { ...current, cards: change(current.cards) } : current);

  /** Keeps the column index on the current entry with replaceState: swiping never adds history entries. */
  function rememberColumn(index: number) {
    if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = window.setTimeout(() => {
      hintTimerRef.current = null;
      // Only on this board's own entry (not a card's); the URL, query included, stays as it is.
      if (window.location.pathname !== formatRoute(tasksRoute(boardId, null, false, null, savedViewId ? { viewId: savedViewId } : null)).split("?")[0]) return;
      window.history.replaceState(createTasksHistoryState(userId, { boardId, column: index }, window.history.state), "", `${window.location.pathname}${window.location.search}`);
    }, 150);
  }

  function onTrackScroll() {
    const track = trackRef.current;
    if (!track || !isMobileViewport()) return;
    const index = columnIndexFromScroll(track.scrollLeft, track.clientWidth, columns.length);
    if (index === activeColumnRef.current) return;
    activeColumnRef.current = index;
    setActiveColumn(index);
    rememberColumn(index);
    window.document.getElementById(`task-tab-${columns[index]?.id}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function showColumn(index: number) {
    const track = trackRef.current;
    activeColumnRef.current = index;
    setActiveColumn(index);
    rememberColumn(index);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    track?.scrollTo({ left: index * track.clientWidth, behavior: reduce ? "instant" as ScrollBehavior : "smooth" });
  }

  function focusCard(cardId: string) {
    // Lane cards are focusable themselves; table, list, and calendar rows focus their open button.
    focusBoardCard(cardId);
  }

  /**
   * Optimistic move: the card jumps at once and the server's position replaces the local one. A
   * 409 (someone else changed the column) or any failure rolls back, says so, and reloads.
   */
  async function move(cardId: string, columnId: string, afterCardId: string | null, options: { focus?: boolean; announce?: string } = {}) {
    const current = detailRef.current;
    if (!current || isNoopMove(current.cards, cardId, columnId, afterCardId)) return;
    const before = current.cards;
    const place = cardPlace(applyLocalMove(before, cardId, columnId, afterCardId), current.columns, cardId);
    setCards((items) => applyLocalMove(items, cardId, columnId, afterCardId));
    if (options.focus) {
      focusCard(cardId);
      const index = [...current.columns].sort(byPosition).findIndex((column) => column.id === columnId);
      if (isMobileViewport() && index >= 0 && index !== activeColumnRef.current) showColumn(index);
    }
    try {
      const result = await moveCard(cardId, columnId, afterCardId);
      setCards((items) => {
        const moved = mergeMovedCard(items, result.card);
        return result.positions ? applyPositions(moved, result.positions) : moved;
      });
      if (moveChangesBlockers(before, current.columns, cardId, columnId)) void load();
      setAnnouncement(options.announce ?? `Moved to ${place}`);
    } catch (reason) {
      setCards(() => before);
      const code = taskErrorCode(reason);
      if (code === "STALE_POSITION") notify.warning("The board changed while you moved that card. Showing the latest order.");
      else if (code === "COLUMN_FULL") notify.warning(fullMessage(reason, columnId));
      else notify.error(taskErrorMessage(reason, "Could not move the card"));
      void load();
    }
  }

  /** The 409 COLUMN_FULL copy, with the limit the server reported (D108). */
  function fullMessage(reason: unknown, columnId: string) {
    const column = detailRef.current?.columns.find((item) => item.id === columnId);
    const payload = reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? reason.payload as { wipLimit?: unknown } : {};
    return columnFullMessage(column?.name ?? "This column", typeof payload.wipLimit === "number" ? payload.wipLimit : column?.wip_limit);
  }

  /** Refuses a move into a full column before asking the server, which would say 409 COLUMN_FULL. */
  function refuseFull(cardId: string, columnId: string) {
    const current = detailRef.current;
    const column = current?.columns.find((item) => item.id === columnId);
    if (!current || !column || canEnterColumn(current.cards, column, cardId)) return false;
    const message = columnFullMessage(column.name, column.wip_limit);
    notify(message);
    setAnnouncement(message);
    return true;
  }

  function dropAt(columnId: string, payload: string | null, index: number) {
    const cardId = readCardDragPayload(payload) ?? draggingId;
    setDraggingId(null);
    setDropTarget(null);
    const current = detailRef.current;
    // Only cards of this board; a foreign or malformed payload is ignored.
    if (!cardId || !current?.cards.some((card) => card.id === cardId)) return;
    if (refuseFull(cardId, columnId)) return;
    void move(cardId, columnId, afterCardIdAt(columnCards(laneCardsRef.current, columnId), index, cardId));
  }

  function keyMove(card: CardSummary, key: MoveKey) {
    const current = detailRef.current;
    if (!current) return;
    const target = keyboardMoveTarget(laneCardsRef.current, current.columns, card.id, key);
    if (!target || refuseFull(card.id, target.columnId)) return;
    if (target.columnId !== card.column_id && collapsedRef.current.has(target.columnId) && !phone) {
      // Into a collapsed column (D602): to its top, like a drop on the strip; focus goes to the strip.
      const name = current.columns.find((column) => column.id === target.columnId)?.name ?? "the column";
      void move(card.id, target.columnId, null, { announce: `Moved to the top of ${name}, which is collapsed` });
      window.setTimeout(() => document.querySelector<HTMLElement>(`[data-column-id="${target.columnId}"] .task-column-strip`)?.focus(), 0);
      return;
    }
    void move(card.id, target.columnId, target.afterCardId, { focus: true });
  }

  /**
   * Collapse or expand a column for this viewer (D602): at once on screen, then saved to their own
   * view of the board (or, in a saved view that keeps its own, to the view's, D657); a failed save
   * puts it back and says so.
   */
  async function toggleCollapsed(columnId: string) {
    const current = detailRef.current;
    if (!current) return;
    const own = savedViews.ownCollapse;
    const before = own ? own.columns : current.view?.collapsedColumnIds ?? [];
    const collapsing = !before.includes(columnId);
    const next = collapsing ? [...before, columnId] : before.filter((id) => id !== columnId);
    const name = current.columns.find((column) => column.id === columnId)?.name ?? "Column";
    setAnnouncement(`${name} ${collapsing ? "collapsed" : "expanded"}`);
    if (!collapsing) window.setTimeout(() => document.querySelector<HTMLElement>(`[data-column-id="${columnId}"] .task-column-collapse`)?.focus(), 0);
    else if (!phone) window.setTimeout(() => document.querySelector<HTMLElement>(`[data-column-id="${columnId}"] .task-column-strip, [data-column-id="${columnId}"] .task-column-collapse`)?.focus(), 0);
    if (own) {
      savedViews.saveOwnColumns(next);
      return;
    }
    setBoardPrefs({ collapsedColumnIds: next });
    try {
      await saveBoardView(boardId, { collapsedColumnIds: next });
    } catch (reason) {
      setBoardPrefs({ collapsedColumnIds: before });
      notify.error(taskErrorMessage(reason, `Could not ${collapsing ? "collapse" : "expand"} ${name}`));
    }
  }

  /** Changes this viewer's board prefs on screen, keeping the fields not named. */
  function setBoardPrefs(change: Partial<NonNullable<BoardDetail["view"]>>) {
    setDetail((value) => value ? { ...value, view: { collapsedColumnIds: [], showArchived: false, ...value.view, ...change } } : value);
  }

  /** Collapse or expand a swimlane (D656): the board's prefs, or a saved view's own (D657). */
  async function toggleRow(row: Swimlane) {
    const own = savedViews.ownCollapse;
    const before = own ? own.rows : detailRef.current?.view?.collapsedRows ?? [];
    const collapsing = !before.includes(row.key);
    const next = collapsing ? [...before, row.key] : before.filter((key) => key !== row.key);
    setAnnouncement(`${row.label} ${collapsing ? "collapsed" : "expanded"}`);
    if (own) {
      savedViews.saveOwnRows(next);
      return;
    }
    setBoardPrefs({ collapsedRows: next });
    try {
      await saveBoardView(boardId, { collapsedRows: next });
    } catch (reason) {
      setBoardPrefs({ collapsedRows: before });
      notify.error(taskErrorMessage(reason, `Could not ${collapsing ? "collapse" : "expand"} ${row.label}`));
    }
  }

  /**
   * A drop in a swimlane (D656): the row's change first (the source row's person replaced by the
   * target's, or the new parent), then the move to its place in the column. Each is refused or rolled
   * back on its own terms (a parent one level up, the column's WIP limit, the card's revision).
   */
  async function dropInSwimlane(mode: SwimlaneMode, cardId: string, fromRow: string, row: Swimlane, columnId: string, cellCardIds: string[], index: number) {
    const current = detailRef.current;
    const card = current?.cards.find((item) => item.id === cardId);
    if (!current || !card) return;
    if (columnId !== card.column_id && refuseFull(cardId, columnId)) return;
    const change = swimlaneChange(mode, fromRow, row, card);
    if (change && "parentId" in change) {
      if (change.parentId && !hierarchy.nesting?.canNest(cardId, change.parentId)) {
        notify.warning(`“${card.title}” can't go under “${row.label}”: a parent is one level up`);
        return;
      }
      await hierarchy.reparent(cardId, change.parentId);
    } else if (change && "assigneeIds" in change) {
      try {
        const { card: saved } = await updateCard(cardId, { assigneeIds: change.assigneeIds, revision: card.revision });
        setDetail((value) => value ? applyCardDetail(value, saved) : value);
        notify.success(change.assigneeIds.length ? `Assigned “${card.title}” to ${row.label}` : `Took everyone off “${card.title}”`);
      } catch (reason) {
        notify.error(taskErrorCode(reason) === "CARD_CHANGED" ? "Someone else changed that card. Showing the latest board." : taskErrorMessage(reason, "Could not change the assignees"));
        void load();
        return;
      }
    }
    // Its place in the column: after the cell's card above the drop, else just above the cell's first card.
    const ordered = columnCards(detailRef.current?.cards ?? [], columnId).filter((item) => item.id !== cardId);
    const after = index > 0 ? cellCardIds[index - 1]! : cellCardIds.length ? ordered[ordered.findIndex((item) => item.id === cellCardIds[0]) - 1]?.id ?? null : ordered.at(-1)?.id ?? null;
    await move(cardId, columnId, after);
  }
  /**
   * Archive or unarchive a card by hand (D610), from its ⋯ menu or its dialog. Archived, it leaves
   * the board (or stays marked when archived cards are shown) and the toast offers Undo.
   */
  async function setArchived(cardId: string, archive: boolean, options: { undo?: boolean } = {}) {
    const card = detailRef.current?.cards.find((item) => item.id === cardId);
    const title = card?.title ?? "card";
    try {
      const { card: saved } = archive ? await archiveCard(cardId) : await unarchiveCard(cardId);
      const showing = detailRef.current?.view?.showArchived ?? false;
      setDetail((current) => {
        if (!current) return current;
        const delta = archive ? 1 : -1;
        const board = { ...current.board, archived_count: Math.max(0, (current.board.archived_count ?? 0) + delta) };
        const cards = archive && !showing
          ? current.cards.filter((item) => item.id !== cardId)
          : current.cards.map((item) => item.id === cardId ? { ...item, archived_at: saved.archived_at, done_at: saved.done_at } : item);
        return { ...current, board, cards };
      });
      // Unarchiving a card the board does not list (archived cards hidden): fetch it.
      if (!archive && !detailRef.current?.cards.some((item) => item.id === cardId)) void load();
      if (archive) {
        if (openCardIdRef.current === cardId) { lastOpenCardRef.current = null; onCloseCard(); }
        setAnnouncement(`Archived ${title}`);
        notify.success(`Archived “${title}”`, { action: { label: "Undo", onClick: () => { void setArchived(cardId, false, { undo: true }); } } });
      } else {
        setAnnouncement(`${title} is back on the board`);
        notify.success(options.undo ? `“${title}” is back on the board` : `Restored “${title}” to the board`);
      }
    } catch (reason) {
      notify.error(taskErrorMessage(reason, archive ? "Could not archive the card" : "Could not restore the card"));
    }
  }

  /**
   * D634: the board sends at most 200 archived cards, newest archived first; "Show more" appends the
   * next page (cards already listed, from a local archive meanwhile, are not repeated).
   */
  const [loadingArchived, setLoadingArchived] = useState(false);
  async function showMoreArchived() {
    const next = detailRef.current?.archivedPage?.next;
    if (!next || loadingArchived) return;
    setLoadingArchived(true);
    try {
      const page = await getArchivedCards(boardId, next, detailRef.current?.board.code);
      setDetail((current) => {
        if (!current) return current;
        const listed = new Set(current.cards.map((card) => card.id));
        return { ...current, cards: [...current.cards, ...page.cards.filter((card) => !listed.has(card.id))], archivedPage: page.archivedPage };
      });
      setAnnouncement(`Showing ${page.cards.length} more archived ${page.cards.length === 1 ? "card" : "cards"}`);
    } catch (reason) {
      notify.error(taskErrorMessage(reason, "Could not load more archived cards"));
    } finally {
      setLoadingArchived(false);
    }
  }

  /** Board settings → Show auto-archived cards (D606): saved to this viewer's view, then the board reloads with or without them. */
  async function setShowArchived(showArchived: boolean) {
    try {
      await saveBoardView(boardId, { showArchived });
      await load();
    } catch (reason) {
      notify.error(taskErrorMessage(reason, "Could not change the archived cards setting"));
    }
  }

  /**
   * The calendar view's date change (D115): only `dueOn` is sent with the card's revision, so the
   * server keeps the time and zone; `null` clears the date and time. The card moves at once; on
   * CARD_CHANGED (or any failure) it moves back and the board reloads. WIP limits do not apply.
   */
  async function setDue(cardId: string, dueOn: string | null, keepSpan = false) {
    const current = detailRef.current;
    const card = current?.cards.find((item) => item.id === cardId);
    if (!current || !card || card.due_on === dueOn) return;
    const before = current.cards;
    const shift = dueOn && card.due_on ? daysBetween(card.due_on, dueOn) : 0;
    // A drag or Alt+Arrow moves a card's whole range (D724): its start shifts by as many days.
    const startOn = keepSpan ? shiftedStartOn(card, dueOn) : undefined;
    setCards((items) => items.map((item) => item.id !== cardId ? item : dueOn === null
      ? { ...item, due_on: null, due_time: null, due_tz: null, due_at: null }
      : { ...item, due_on: dueOn, due_at: shiftedDueAt(item.due_at, shift), ...(startOn ? { start_on: startOn, start_at: shiftedDueAt(item.start_at, shift) } : {}) }));
    try {
      const { card: saved } = await updateCard(cardId, { dueOn, ...(startOn ? { startOn } : {}), revision: card.revision });
      setCards((items) => items.map((item) => item.id === cardId
        ? { ...item, revision: saved.revision, due_on: saved.due_on, due_time: saved.due_time, due_tz: saved.due_tz, due_at: saved.due_at,
          start_on: saved.start_on, start_time: saved.start_time, start_tz: saved.start_tz, start_at: saved.start_at, updated_at: saved.updated_at }
        : item));
      const zone = viewerTimeZone();
      setAnnouncement(`${card.title}: ${dueAnnouncement(displayedDay(saved, zone), displayedTime(saved, zone))}`);
      focusCard(cardId);
    } catch (reason) {
      setCards(() => before);
      notify.error(taskErrorCode(reason) === "CARD_CHANGED" ? "Someone else changed this card. It was reloaded." : taskErrorMessage(reason, "Could not change the due date"));
      void load();
    }
  }

  /**
   * The timeline's date change (D764, D765): `startOn` and/or `dueOn`, one PATCH with the card's
   * revision; the server keeps each side's time and zone when only its date changes. The bar moves at
   * once; on CARD_CHANGED, START_AFTER_DUE, or any failure it moves back, says so, and the board reloads.
   */
  // Date changes to one card are sent in order (D764): quick Alt+Arrow presses each wait for the
  // revision the one before them saved, while every bar move shows at once.
  // A failed send drops the ones queued behind it (keyedSendQueue): the board reloads instead.
  const datesQueueRef = useRef(keyedSendQueue());
  function setDates(cardId: string, change: DateChange) {
    const current = detailRef.current;
    const card = current?.cards.find((item) => item.id === cardId);
    if (!current || !card) return;
    const startOn = change.startOn !== undefined && change.startOn !== card.start_on ? change.startOn : undefined;
    const dueOn = change.dueOn !== undefined && change.dueOn !== card.due_on ? change.dueOn : undefined;
    if (startOn === undefined && dueOn === undefined) return;
    const shift = (from: string | null | undefined, to: string | null | undefined) => from && to ? daysBetween(from, to) : 0;
    const prior = { start_on: card.start_on, start_at: card.start_at, due_on: card.due_on, due_at: card.due_at };
    setCards((items) => items.map((item) => item.id !== cardId ? item : {
      ...item,
      ...(dueOn !== undefined ? { due_on: dueOn, due_at: shiftedDueAt(item.due_at, shift(item.due_on, dueOn)) } : {}),
      ...(startOn !== undefined ? { start_on: startOn, start_at: shiftedDueAt(item.start_at, shift(item.start_on, startOn)) } : {})
    }));
    void datesQueueRef.current(cardId, async (isLast) => {
      const latest = detailRef.current?.cards.find((item) => item.id === cardId);
      if (!latest) return;
      const { card: saved } = await updateCard(cardId, { ...(startOn !== undefined ? { startOn } : {}), ...(dueOn !== undefined ? { dueOn } : {}), revision: latest.revision });
      const last = isLast();
      // A later change already shows on screen: take only the revision, so the bar does not step back.
      setCards((items) => items.map((item) => item.id !== cardId ? item : last
        ? { ...item, revision: saved.revision, due_on: saved.due_on, due_time: saved.due_time, due_tz: saved.due_tz, due_at: saved.due_at,
          start_on: saved.start_on, start_time: saved.start_time, start_tz: saved.start_tz, start_at: saved.start_at, updated_at: saved.updated_at }
        : { ...item, revision: saved.revision, updated_at: saved.updated_at }));
      if (detailRef.current) detailRef.current = { ...detailRef.current, cards: detailRef.current.cards.map((item) => item.id === cardId ? { ...item, revision: saved.revision } : item) };
      const bar = barOf(saved, viewerTimeZone());
      if (last) setAnnouncement(`${card.title}: ${bar ? barLabel(bar) : "no dates"}`);
    }, async (reason) => {
      const code = taskErrorCode(reason);
      notify.error(code === "CARD_CHANGED" ? "Someone else changed this card. It was reloaded."
        : code === "START_AFTER_DUE" ? "The start must be on or before the due date"
        : taskErrorMessage(reason, "Could not change the dates"));
      // The bar goes back at once (with any moves queued behind this one, which are dropped), then to what the server has.
      setCards((items) => items.map((item) => item.id === cardId ? { ...item, ...prior } : item));
      await load();
    });
  }

  /** The composer created a card: it joins the board, then closes, opens, or starts another (§4.3). */
  function cardCreated(card: CardDetail, mode: ComposerMode, options: { hadRelations: boolean }) {
    setDetail((current) => current ? {
      ...current,
      cards: [...current.cards, card],
      board: { ...current.board, card_count: current.board.card_count + 1 },
      // The new card's tags count toward the board's tag usage (13C).
      ...(current.tags ? { tags: recountTags(current.tags, [], card.tag_ids ?? []) } : {})
    } : current);
    // Relation counts for the lane come with the board.
    if (options.hadRelations) void load();
    // A saved view's filter may hide the new card (D637): say so rather than let it vanish.
    const current = detailRef.current;
    const hidden = savedViewId !== null && current !== null && !filterBoardCards(boardData({ ...current, cards: [...current.cards.filter((item) => item.id !== card.id), card] }), scopedQuery.filter, viewContext).some((item) => item.id === card.id);
    if (mode === "another") {
      if (hidden) notify("Added — hidden by this view's filters");
      return;
    }
    setComposer(null);
    if (mode === "open") {
      onOpenCard(card.id);
      return;
    }
    if (hidden) {
      notify.success(`Added “${card.title}” — hidden by this view's filters`);
      return;
    }
    notify.success(`Added “${card.title}”`);
    const index = [...(detailRef.current?.columns ?? [])].sort(byPosition).findIndex((column) => column.id === card.column_id);
    if (isMobileViewport() && index >= 0 && index !== activeColumnRef.current) showColumn(index);
    focusCard(card.id);
  }

  async function rename(name: string) {
    const { board: saved } = await renameBoard(boardId, name);
    setDetail((current) => current ? { ...current, board: saved } : current);
    closeLayer();
    notify.success(`Renamed to “${saved.name}”`);
  }

  async function addColumn(name: string) {
    const { columns: saved } = await createColumn(boardId, name);
    setDetail((current) => current ? { ...current, columns: saved } : current);
    closeLayer();
    notify.success(`Added column ${name}`);
  }

  async function renameColumn(columnId: string, name: string) {
    const { columns: saved } = await updateColumn(columnId, { name });
    setDetail((current) => current ? { ...current, columns: saved } : current);
    closeDialog();
  }

  async function setWipLimit(columnId: string, wipLimit: number | null) {
    const { columns: saved } = await updateColumn(columnId, { wipLimit });
    setDetail((current) => current ? { ...current, columns: saved } : current);
    closeDialog();
    const name = saved.find((column) => column.id === columnId)?.name ?? "this column";
    notify.success(wipLimit === null ? `Removed the limit on ${name}` : `${name} takes at most ${cardCountLabel(wipLimit)}`);
  }

  async function moveColumn(columnId: string, direction: -1 | 1) {
    const anchor = columnMoveAnchor(columns, columnId, direction);
    if (anchor === undefined) return;
    try {
      const { columns: saved } = await updateColumn(columnId, { afterColumnId: anchor });
      setDetail((current) => current ? { ...current, columns: saved } : current);
      const moved = saved.find((column) => column.id === columnId);
      setAnnouncement(`${moved?.name ?? "Column"} moved ${direction < 0 ? "left" : "right"}`);
    } catch (reason) {
      notify.error(taskErrorMessage(reason, "Could not move the column"));
      void load();
    }
  }

  async function removeBoard() {
    const name = detailRef.current?.board.name ?? "board";
    setDeleting(true);
    try {
      await deleteBoard(boardId);
      setDialog(null);
      returnFocusRef.current = null;
      onBoardDeleted();
      notify.success(`Moved “${name}” to the Bin`, { action: { label: "Undo", onClick: () => {
        restoreTaskItem("board", boardId).then(() => onOpenBoard(boardId), (reason) => notify.error(taskErrorMessage(reason, "Could not restore the board")));
      } } });
    } catch (reason) {
      closeLayer();
      notify.error(taskErrorMessage(reason, "Could not delete the board"));
    } finally {
      setDeleting(false);
    }
  }

  /** The card dialog asked to bin its card (after its own confirm). */
  async function removeCard(cardId: string) {
    const card = detailRef.current?.cards.find((item) => item.id === cardId);
    // Remember where it was so Undo can put it back between the same neighbours.
    const siblings = card ? columnCards(detailRef.current!.cards, card.column_id) : [];
    const index = siblings.findIndex((item) => item.id === cardId);
    const place = card ? { columnId: card.column_id, afterCardId: index > 0 ? siblings[index - 1]!.id : null } : {};
    const { descendantCount = 0 } = await deleteCard(cardId);
    // Its live children and grandchildren went to the Bin with it (D129).
    const gone = new Set([cardId]);
    for (let step = 0; step < 2; step += 1) for (const item of detailRef.current?.cards ?? []) if (item.parent_card_id && gone.has(item.parent_card_id)) gone.add(item.id);
    for (const id of gone) binnedRef.current.add(id);
    setDetail((current) => current ? { ...current, cards: current.cards.filter((item) => !gone.has(item.id)), board: { ...current.board, card_count: Math.max(0, current.board.card_count - gone.size) } } : current);
    lastOpenCardRef.current = null;
    onCloseCard();
    notify.success(`Moved “${card?.title ?? "card"}”${descendantCount ? ` and ${descendantCount === 1 ? "1 card" : `${descendantCount} cards`} under it` : ""} to the Bin`, { action: { label: "Undo", onClick: () => {
      restoreTaskItem("card", cardId, place).then((result) => {
        for (const id of gone) binnedRef.current.delete(id);
        notify.success(`Restored to ${result.columnName ?? "the board"}${result.descendantCount ? ` with ${result.descendantCount === 1 ? "1 card" : `${result.descendantCount} cards`} under it` : ""}${result.detached ? ", without its parent (it is in the Bin)" : ""}`);
        void load();
      }, (reason) => notify.error(taskErrorMessage(reason, "Could not restore the card")));
    } } });
  }

  async function removeColumn(columnId: string) {
    setDeleting(true);
    try {
      const { columns: saved } = await deleteColumn(columnId);
      setDetail((current) => current ? { ...current, columns: saved } : current);
      setDialog(null);
      returnFocusRef.current = null;
      notify.success("Column deleted");
    } catch (reason) {
      const code = taskErrorCode(reason);
      // Someone added a card meanwhile: stay open; the reload disables Delete and says why.
      if (code !== "COLUMN_NOT_EMPTY") closeDialog();
      notify.error(code === "COLUMN_NOT_EMPTY" ? "This column has cards now. Move or delete them first." : code === "LAST_COLUMN" ? "A board needs at least one column" : taskErrorMessage(reason, "Could not delete the column"));
      void load();
    } finally {
      setDeleting(false);
    }
  }

  // Phones: two rows under the title, nothing hidden. Row one is the view switch with the
  // per-view controls as icon chips (Swimlanes, the saved view); row two is + Filter and the search
  // (with the saved view's ⋯ and Save). boardViews.css, .task-board-controls.
  const viewSwitch = <BoardViewSwitch value={view} onChange={(next) => onQueryChange(withBoardQuery(query, { view: next }), { push: true })} />;
  // Swimlanes (lane VIEWS2, D655): rows by assignee, or by parent on a board with levels.
  const parentLevel = hierarchy.structure.levels.length > 1 ? hierarchy.structure.levels[Math.max(0, hierarchy.structure.workLevel - 1)] : undefined;
  // The URL's choice, else (in a saved view) the view's own, else none.
  const swimChoice = query.swim === "none" ? null : isSwimlaneMode(query.swim) ? query.swim : savedViewId ? savedViews.view?.display.swimlanes ?? null : null;
  const swimMode: SwimlaneMode | null = swimChoice && (swimChoice === "assignee" || (swimChoice === "parent" && parentLevel)) ? swimChoice : null;
  const swimSelect = view === "board" ? <Select<string> variant="chip" label="Swimlanes" value={swimMode ?? "none"} searchable={false}
    className={`task-swim-select${phone && swimMode ? " active" : ""}`} iconOnly={phone} icon={<Rows3 />}
    options={[{ value: "none", label: "Swimlanes: None" }, { value: "assignee", label: "Swimlanes: Assignee" }, ...(parentLevel ? [{ value: "parent", label: `Swimlanes: ${parentLevel.name}` }] : [])]}
    onChange={(value) => onQueryChange(withBoardQuery(query, { swim: isSwimlaneMode(value) ? value : savedViewId ? "none" : null }))} /> : null;
  // A saved view's Board field (D661): more boards make it a cross-board view.
  const boardField: Record<string, FilterField> | undefined = savedViewId && otherBoards.length ? { board: {
    label: "Board", key: "board",
    optionsFor: () => otherBoards.filter((item) => item.id !== boardId).map((item) => ({ value: item.id, label: item.name })),
    labelFor: (value) => otherBoards.find((item) => item.id === value)?.name ?? "Board"
  } } : undefined;
  const filterBar = data && result ? <FilterBar board={data} context={viewContext} filter={query.filter} shown={result.cards.length} total={scopedTotal}
    onChange={(filter) => onQueryChange(withBoardQuery(query, { filter }))} actions={phone ? <>{savedViews.filterActions}{savedViews.more}</> : savedViews.filterActions} extraFields={boardField} /> : null;
  const savedViewPicker = savedViews.showPicker ? phone ? savedViews.compactPicker : savedViews.picker : null;
  // New card in a saved view starts where the view looks (D637).
  const composerStart = savedViewId && detail ? composerStartFor(query.filter, {
    columns, tags: detail.tags ?? [], sprints: detail.sprints ?? [], userId, userName: displayName,
    people: cards.flatMap((card) => card.assignees ?? [])
  }) : null;

  /**
   * Move to another board (lane KEYS, D716): the card leaves this board. From its open dialog the
   * route follows it to the other board; from the board, a toast offers to open it there.
   */
  async function moveToBoard(card: CardSummary, target: BoardSummary, columnId: string) {
    const result = await moveCardToBoard(card.id, target.id, columnId);
    setDialog(null);
    returnFocusRef.current = null;
    setDetail((current) => current ? { ...current, cards: current.cards.filter((item) => item.id !== card.id) } : current);
    const dropped = result.droppedTags.length === 1 ? ` “${result.droppedTags[0]}” is not a tag there, so it was dropped.`
      : result.droppedTags.length > 1 ? ` ${result.droppedTags.length} tags are not on that board, so they were dropped.` : "";
    const message = `Moved to ${target.name}${result.card.key ? ` as ${result.card.key}` : ""}.${dropped}`;
    if (openCardIdRef.current === card.id) {
      onCardElsewhere?.(target.id, card.id);
      notify.success(message);
    } else {
      notify.success(message, onOpenCardRoute ? { action: { label: "Open", onClick: () => onOpenCardRoute(target.id, card.id) } } : undefined);
    }
  }

  return <section className="task-board" data-read-only={readOnly && !roleReadOnly ? "true" : undefined} aria-labelledby={cardPage ? undefined : "task-board-title"}>
    {!cardPage && <>
    <header className="task-board-header">
      <button className="icon-button task-back" onClick={onBack} aria-label="Back to boards" title="Back to boards"><ChevronLeft /></button>
      <div className="task-board-heading">
        <span className="eyebrow">{board && !owner ? `${board.owner_name}’s board` : "Board"}</span>
        <h1 id="task-board-title" title={board?.name}>{board?.name ?? "Loading…"}</h1>
      </div>
      {board && <span className="task-board-count">{cardCountLabel(showArchived ? board.card_count : board.card_count - (board.archived_count ?? 0))}</span>}
      {board && <BoardHeaderItemsOutlet board={{ id: board.id, name: board.name }} />}
      {detail && !readOnly && <button className="primary-button task-new-card" onClick={() => setComposer({ columnId: null })} aria-haspopup="dialog" aria-label="New card" title="New card"><Plus /><span>New card</span></button>}
      {detail && !phone && viewSwitch}
      {detail && !phone && swimSelect}
      {detail && !phone && savedViewPicker}
      {board && <span className="task-board-actions">
        {/* D1387: the board's cards as CSV (archived ones too while they are shown). */}
        <a className="icon-button" href={`/api/tasks/boards/${encodeURIComponent(board.id)}/export.csv${showArchived ? "?archived=1" : ""}`} download aria-label="Export cards (CSV)" title="Export cards (CSV)"><Download /></a>
        <button className="icon-button" onClick={(event) => openDialog({ kind: "settings" }, event.currentTarget)} aria-haspopup="dialog" aria-label="Board settings" title="Board settings"><Settings2 /></button>
      </span>}
    </header>
    {data && sprints.selection && <SprintBar sprints={sprints.sprints} selection={sprints.selection} cards={data.cards} columns={columns} workLevel={hierarchy.structure.workLevel}
      name={hierarchy.structure.levels[hierarchy.structure.workLevel]?.name ?? "Card"} plural={hierarchy.structure.levels[hierarchy.structure.workLevel]?.plural ?? "Cards"}
      today={viewContext.today} owner={canManage} onSelect={sprints.select} onStart={(sprint) => { void sprints.start(sprint); }}
      onComplete={(sprint, trigger) => openDialog({ kind: "completeSprint", sprintId: sprint.id }, trigger)}
      onNewSprint={(trigger) => openDialog({ kind: "newSprint" }, trigger)} onManage={onOpenSprints} estimateKind={estimates.kind} />}
    <KeyboardMoveHint id="task-card-keys">Press Alt with an arrow key to move a card up, down, or to the next column.</KeyboardMoveHint>
    <p className="sr-only" aria-live="polite">{announcement}</p>

    {loadError && <div className="bin-state bin-error task-board-state" role="alert">
      <span className="bin-state-icon"><TriangleAlert /></span>
      <h2>Could not load this board</h2>
      <p>{loadError}</p>
      <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
    </div>}
    {!loadError && !detail && <p className="bin-loading task-board-state" role="status">Loading the board…</p>}
    {detail && (phone ? <div className="task-board-controls">{viewSwitch}{swimSelect}{savedViewPicker}{filterBar}</div> : filterBar)}
    {detail && sprintConflict && <p className="task-sprint-conflict" role="status">{sprintConflict}</p>}
    {detail && showArchived && detail.archivedPage?.next && (() => {
      const shown = detail.cards.filter((card) => card.archived_at).length;
      const total = Math.max(shown, board?.archived_count ?? shown);
      return <p className="task-archived-note">
        <span>Showing the latest {shown.toLocaleString()} of {total.toLocaleString()} archived cards</span>
        <button className="task-column-show-all" onClick={() => { void showMoreArchived(); }} disabled={loadingArchived}>{loadingArchived ? "Loading…" : "Show more"}</button>
      </p>;
    })()}
    {detail && data && result && view === "table" && <div className="task-view-body">
      <BoardTable board={data} cards={result.cards} sort={query.sort} today={viewContext.today} filtered={filtered}
        onSort={(sort) => onQueryChange(withBoardQuery(query, { sort }))}
        onOpenCard={(card) => onOpenCard(card.id)} onCardMenu={(card, trigger) => openDialog({ kind: "moveCard", cardId: card.id }, trigger)} />
    </div>}
    {detail && data && result?.groups && view === "list" && <div className="task-view-body">
      <BoardGroupedList board={data} groups={result.groups} group={query.group ?? "column"} today={viewContext.today} filtered={filtered}
        onGroup={(group) => onQueryChange(withBoardQuery(query, { group: group === "column" ? null : group }))}
        onOpenCard={(card) => onOpenCard(card.id)} onCardMenu={(card, trigger) => openDialog({ kind: "moveCard", cardId: card.id }, trigger)} />
    </div>}
    {detail && data && result && view === "calendar" && <div className="task-view-body">
      <BoardCalendar board={data} cards={result.cards} layout={query.cal} month={query.month} today={viewContext.today} viewerZone={viewContext.timeZone} filtered={filtered}
        onMonth={(month) => onQueryChange(withBoardQuery(query, { month }))}
        onLayout={(cal) => onQueryChange(withBoardQuery(query, { cal }), { push: true })}
        onOpenCard={(card) => onOpenCard(card.id)} onSetDue={(card, dueOn, keepSpan) => { void setDue(card.id, dueOn, keepSpan); }} readOnly={readOnly} />
    </div>}
    {detail && data && result && view === "timeline" && <div className="task-view-body task-view-body-timeline">
      <BoardTimeline board={data} cards={result.cards} groups={timelineGroups} group={query.group} scale={query.zoom ?? "month"}
        today={viewContext.today} viewerZone={viewContext.timeZone} filtered={filtered} readOnly={readOnly}
        onGroup={(group) => onQueryChange(withBoardQuery(query, { group }))}
        onScale={(zoom) => onQueryChange(withBoardQuery(query, { zoom: zoom === "month" ? null : zoom }))}
        onOpenCard={(card) => onOpenCard(card.id)} onChangeDates={(card, change) => setDates(card.id, change)}
        onAddCard={readOnly ? undefined : () => setComposer({ columnId: null })} />
    </div>}
    {detail && view === "board" && <nav className="task-column-tabs" aria-label="Columns">
      {columns.map((column, index) => {
        // The cards on screen; a WIP limit counts every live card (QA 0.9.0).
        const badge = columnBadge(columnCards(shownLane, column.id).length, columnCards(cards, column.id).length, column.wip_limit);
        const folded = collapsed.has(column.id);
        const status = statuses.get(column.id);
        return <button key={column.id} id={`task-tab-${column.id}`} className={`${index === shownColumn ? "active" : ""}${folded ? " collapsed" : ""}`} aria-current={index === shownColumn ? "true" : undefined}
          aria-describedby={status ? columnStatusId(column.id) : undefined} onClick={() => showColumn(index)}>
          {status && <ColumnStatusIcon status={status} />}<span>{column.name}</span><b className={badge.wip ? `task-wip ${badge.wip}` : undefined} aria-label={folded ? `${badge.label}, collapsed` : badge.label}>{badge.text}</b>
        </button>;
      })}
      {canManage && columns.length < MAX_COLUMNS && <button className="task-tab-add" onClick={(event) => openDialog({ kind: "addColumn" }, event.currentTarget)} aria-haspopup="dialog" aria-label="Add column"><Plus /></button>}
    </nav>}
    {detail && view === "board" && swimMode && <BoardSwimlanes mode={swimMode} columns={columns} statuses={statuses} cards={shownLane} allCards={cards} tags={detail.tags ?? []} estimateKind={estimates.kind}
      today={viewContext.today} noneLabel={swimMode === "parent" ? `No ${(parentLevel?.name ?? "parent").toLowerCase()}` : "No assignee"}
      collapsedColumns={collapsed} onToggleColumn={(columnId) => { void toggleCollapsed(columnId); }} collapsedRows={collapsedRows} onToggleRow={(row) => { void toggleRow(row); }}
      readOnly={readOnly} phone={phone} trackRef={trackRef} onTrackScroll={onTrackScroll}
      canEnter={(cardId, columnId) => { const column = columns.find((item) => item.id === columnId); return !column || canEnterColumn(cards, column, cardId); }}
      onDrop={(cardId, fromRow, row, columnId, cellCardIds, index) => { void dropInSwimlane(swimMode, cardId, fromRow, row, columnId, cellCardIds, index); }}
      onKeyRefused={(message) => { notify(message); setAnnouncement(message); }}
      onAddCard={readOnly ? undefined : (row, columnId) => {
        const column = columns.find((item) => item.id === columnId);
        const refusal = column ? addCardRefusal(cards, column) : null;
        if (refusal) { notify.warning(refusal); setAnnouncement(refusal); return; }
        setComposer({ columnId, ...(row.parentId ? { parentId: row.parentId } : {}), ...(row.userId ? { prefill: { assignees: [{ id: row.userId, display_name: row.label, can_read: 1 as const }] } } : {}) });
      }}
      onKeyMove={keyMove} onOpenCard={(card) => onOpenCard(card.id)} onCardMenu={(card, trigger) => openDialog({ kind: "moveCard", cardId: card.id }, trigger)} />}
    {detail && view === "board" && !swimMode && <div className="task-columns" ref={trackRef} onScroll={onTrackScroll}>
      {columns.map((column, index) => {
        const lane = columnCards(laneCards, column.id);
        const shown = columnCards(shownLane, column.id);
        const hidden = hierarchy.hiddenIn(lane, shown);
        return <BoardColumnView
        key={column.id}
        column={column}
        cards={shown}
        totalCount={columnCards(cards, column.id).length}
        hiddenNote={hidden.note ? { text: hidden.note, onShowAll: showAllLevels } : undefined}
        emptyText={filtered ? "No matching cards" : sprintScoped && !lane.length ? (sprints.selection?.kind === "backlog" ? "Nothing from the backlog here" : "Nothing from this sprint here") : hidden.hint ?? "No matching cards"}
        nesting={hierarchy.nesting}
        readOnly={readOnly}
        collapsed={collapsed.has(column.id)}
        status={statuses.get(column.id)}
        onToggleCollapsed={() => { void toggleCollapsed(column.id); }}
        phone={phone}
        tags={detail.tags}
        estimateKind={estimates.kind}
        owner={owner}
        isFirst={index === 0}
        isLast={index === columns.length - 1}
        draggingId={draggingId}
        dropIndex={dropTarget?.columnId === column.id ? dropTarget.index : null}
        refuseDrop={draggingId !== null && !canEnterColumn(cards, column, draggingId)}
        onDragStart={(card) => setDraggingId(card.id)}
        onDragEnd={() => { setDraggingId(null); setDropTarget(null); hierarchy.clearNest(); }}
        onDragOverIndex={(slot) => setDropTarget((current) => slot === null
          ? current?.columnId === column.id ? null : current
          : current?.columnId === column.id && current.index === slot ? current : { columnId: column.id, index: slot })}
        onDropAt={(payload, slot) => dropAt(column.id, payload, slot)}
        onKeyMove={keyMove}
        onCardMenu={(card, trigger) => openDialog({ kind: "moveCard", cardId: card.id }, trigger)}
        onOpenCard={(card) => onOpenCard(card.id)}
        onColumnMenu={(trigger) => openDialog({ kind: "columnMenu", columnId: column.id }, trigger)}
        onMoveColumn={(direction) => { void moveColumn(column.id, direction); }}
        onAddCard={() => {
          const refusal = addCardRefusal(cards, column);
          if (refusal) { notify.warning(refusal); setAnnouncement(refusal); } else setComposer({ columnId: column.id });
        }}
      />;
      })}
      {canManage && columns.length < MAX_COLUMNS && <button className="task-add-column" onClick={(event) => openDialog({ kind: "addColumn" }, event.currentTarget)} aria-haspopup="dialog"><Plus />Add column</button>}
    </div>}
    </>}

    {openCardId && detail && <CardPage enabled={cardPage} boardName={board?.name ?? ""} onBackToBoard={onCloseCard}><CardDialog
      key={openCardId}
      layout={cardPage ? "page" : "dialog"}
      onExpand={onExpandCard}
      onCollapse={onCollapseCard}
      userId={userId}
      cardId={openCardId}
      columns={columns}
      columnId={cards.find((card) => card.id === openCardId)?.column_id}
      boardOwner={owner}
      boardLevel={board?.level}
      onClose={cardPage && onCollapseCard ? onCollapseCard : onCloseCard}
      onMissing={onCardMissing}
      boardId={boardId}
      onElsewhere={(card) => onCardElsewhere?.(card.board_id, card.id)}
      notify={notify}
      onMove={(card) => openDialog({ kind: "moveCard", cardId: card.id })}
      onDelete={removeCard}
      onArchive={readOnly ? undefined : (card) => { void setArchived(card.id, true); }}
      onChanged={(card) => {
        // A card restored from the archive while archived cards are hidden is not on the board yet: fetch it.
        const listed = detailRef.current?.cards.find((item) => item.id === card.id);
        if (!card.archived_at && (!listed || listed.archived_at)) void load();
        setDetail((current) => current ? applyCardDetail(current, card) : current);
      }}
      tags={detail.tags ?? []}
      onTagsChange={(change) => setDetail((current) => current ? applyTagChange(current, change) : current)}
      onOpenRelated={(target) => onOpenCardRoute?.(target.board_id, target.id)}
      onRelationsChanged={(id, counts) => setCards((items) => items.map((item) => item.id === id ? { ...item, ...counts } : item))}
      hierarchy={hierarchy.dialog}
      sprints={sprints.enabled ? sprints.sprints : undefined}
      estimates={estimates}
    /></CardPage>}
    {composer && !readOnly && detail && board && <CardComposer
      boardId={boardId}
      boardName={board.name}
      userId={userId}
      columns={columns}
      cards={cards}
      initialColumnId={composer.columnId ?? composerStart?.columnId ?? null}
      onClose={() => setComposer(null)}
      onCreated={cardCreated}
      notify={notify}
      tags={detail.tags ?? []}
      owner={owner}
      onTagsChange={(change) => setDetail((current) => current ? applyTagChange(current, change) : current)}
      structure={hierarchy.structure}
      parentCards={cards}
      initialParentId={composer.parentId}
      sprints={sprints.enabled ? sprints.sprints : undefined}
      initialSprintId={composerStart && composerStart.sprintId !== undefined ? composerStart.sprintId : sprints.composerSprintId}
      prefill={composer.prefill ?? composerStart?.prefill}
    />}
    {savedViews.dialogs}
    {(dialog?.kind === "settings" || overSettings) && board && <BoardSettingsSheet board={board} owner={canManage} isOwner={owner} showAllLevels={hierarchy.showAll} onShowAllLevels={hierarchy.setShowAll}
      showArchived={showArchived} onShowArchived={(value) => { void setShowArchived(value); }}
      onBoardSaved={(saved) => {
        setDetail((current) => current ? withBoardKeys({ ...current, board: saved }) : current);
        // Estimates turned on or changed kind (D752): the cards' kept values come with a fresh read.
        if (estimateSettingsOf(saved).kind !== estimates.kind) void load();
      }}
      onClose={closeDialog} notify={notify} suspended={overSettings}
      onRename={() => openOverSettings("rename")} onShare={() => openOverSettings("share")} onDelete={() => openOverSettings("deleteBoard")} onAddColumn={() => openOverSettings("addColumn")}
      onStructureSaved={(saved) => setDetail((current) => current ? { ...current, board: saved } : current)}
      sprintsSection={<SprintDefaultsSection defaults={sprints.defaults} owner={canManage} onSave={sprints.saveDefaults} onManage={() => { closeDialog(); onOpenSprints?.(); }} />} />}
    {sprintsOpen && sprints.enabled && board && onCloseSprints && <SprintsSheet boardName={board.name} onClose={onCloseSprints} suspended={dialog !== null}>
      <SprintSettingsSection boardId={boardId} sprints={data ? withLocalCounts(sprints.sprints, data.cards, columns, hierarchy.structure.workLevel) : sprints.sprints} owner={canManage} today={viewContext.today}
        plural={hierarchy.structure.levels[hierarchy.structure.workLevel]?.plural ?? "Cards"} defaults={sprints.defaults}
        onCreate={sprints.create} onUpdate={sprints.update} onStart={sprints.start} onDelete={sprints.remove}
        onComplete={(sprint) => openDialog({ kind: "completeSprint", sprintId: sprint.id })} />
    </SprintsSheet>}
    {dialog?.kind === "newSprint" && board && <NewSprintDialog boardName={board.name} sprints={sprints.sprints} today={viewContext.today} defaults={sprints.defaults}
      canStart={!activeSprint(sprints.sprints)} onCancel={closeDialog} onStartPlanned={(sprint) => { closeDialog(); void sprints.start(sprint); }}
      onSubmit={async (fields, start) => { const made = await sprints.createAndMaybeStart(fields, start); if (made) closeDialog(); return made; }} />}
    {(() => {
      // From the sprint bar or the Sprints sheet, it is the board's dialog.
      const sprintId = dialog?.kind === "completeSprint" ? dialog.sprintId : null;
      const sprint = sprintId && data ? sprints.sprints.find((item) => item.id === sprintId && item.state === "active") : undefined;
      if (!sprint || !data) return null;
      const { structure } = hierarchy;
      return <SprintCompleteDialog sprint={sprint} sprints={sprints.sprints} cards={data.cards} columns={columns} workLevel={structure.workLevel}
        name={structure.levels[structure.workLevel]?.name ?? "Card"} plural={structure.levels[structure.workLevel]?.plural ?? "Cards"}
        childPlural={structure.levels[structure.workLevel + 1]?.plural ?? null} today={viewContext.today} defaults={sprints.defaults} onCancel={closeDialog}
        onComplete={async (carryTo, next) => {
          await sprints.complete(sprint, carryTo, next);
          setDialog(null);
          returnFocusRef.current = null;
        }} />;
    })()}
    {dialog?.kind === "rename" && board && <NameDialog title="Rename board" eyebrow="Tasks" label="Board name" initialValue={board.name} submitLabel="Rename" hint="Up to 120 characters." validate={(value) => validateBoardName(value, board.name)} onSubmit={rename} onCancel={closeLayer} />}
    {dialog?.kind === "share" && board && <AccessSheet kind="board" id={board.id} title={board.name} onClose={closeLayer} onSaved={() => {
      closeLayer();
      notify.success("Access updated");
      void load();
    }} />}
    {dialog?.kind === "deleteBoard" && board && <ConfirmDialog title="Move to the Bin?" message={binConfirmMessage("board", board.name)} confirmLabel="Move to Bin" danger busy={deleting} onConfirm={() => { void removeBoard(); }} onCancel={closeLayer} />}
    {dialog?.kind === "addColumn" && <NameDialog title="Add column" eyebrow={board?.name ?? "Board"} label="Column name" initialValue="" submitLabel="Add column" hint="Up to 60 characters. It is added at the end." validate={(value) => validateColumnName(value)} onSubmit={addColumn} onCancel={closeLayer} />}
    {dialog?.kind === "columnMenu" && dialogColumn && <ModalDialog title={dialogColumn.name} eyebrow="Column" onClose={closeDialog}>
      <div className="move-list task-menu">
        <button className="move-option" autoFocus onClick={() => setDialog({ kind: "renameColumn", columnId: dialogColumn.id })}><Pencil aria-hidden="true" /><span>Rename</span></button>
        <button className="move-option" onClick={() => { closeDialog(); void toggleCollapsed(dialogColumn.id); }}>
          {collapsed.has(dialogColumn.id) ? <ChevronsLeftRight aria-hidden="true" /> : <ChevronsRightLeft aria-hidden="true" />}
          <span>{collapsed.has(dialogColumn.id) ? "Expand" : "Collapse"}<small>{collapsed.has(dialogColumn.id) ? "Show its cards again" : "Narrow it and hide its cards, only for you"}</small></span>
        </button>
        <ColumnStateField column={dialogColumn} onError={notify} onChanged={(saved, changed) => {
          setDetail((current) => current ? { ...current, columns: saved } : current);
          notify.success(`${changed.name} is now ${STATE_LABELS[columnState(changed)].toLowerCase()}${changed.is_done === 1 ? ": its cards count as done" : ""}`);
        }} />
        <button className="move-option" onClick={() => setDialog({ kind: "wipLimit", columnId: dialogColumn.id })}><Gauge aria-hidden="true" /><span>{dialogColumn.wip_limit ? `WIP limit: ${dialogColumn.wip_limit}` : "Set WIP limit…"}<small>{dialogColumn.wip_limit ? "Change or remove the most cards it holds" : "Stop cards coming in once it holds this many"}</small></span></button>
        <button className="move-option" disabled={columns[0]?.id === dialogColumn.id} onClick={() => { closeDialog(); void moveColumn(dialogColumn.id, -1); }}><ArrowLeft aria-hidden="true" /><span>Move left</span></button>
        <button className="move-option" disabled={columns[columns.length - 1]?.id === dialogColumn.id} onClick={() => { closeDialog(); void moveColumn(dialogColumn.id, 1); }}><ArrowRight aria-hidden="true" /><span>Move right</span></button>
        <button className="move-option danger" disabled={columns.length <= 1} onClick={() => setDialog({ kind: "deleteColumn", columnId: dialogColumn.id })}><Trash2 aria-hidden="true" /><span>Delete column{columns.length <= 1 && <small>A board needs at least one column</small>}</span></button>
      </div>
    </ModalDialog>}
    {dialog?.kind === "wipLimit" && dialogColumn && <WipLimitDialog columnName={dialogColumn.name} limit={dialogColumn.wip_limit ?? null} count={columnCards(cards, dialogColumn.id).length}
      onSubmit={(limit) => setWipLimit(dialogColumn.id, limit)} onCancel={closeDialog} />}
    {dialog?.kind === "renameColumn" && dialogColumn && <NameDialog title="Rename column" eyebrow="Column" label="Column name" initialValue={dialogColumn.name} submitLabel="Rename" hint="Up to 60 characters." validate={(value) => validateColumnName(value, dialogColumn.name)} onSubmit={(name) => renameColumn(dialogColumn.id, name)} onCancel={closeDialog} />}
    {dialog?.kind === "deleteColumn" && dialogColumn && <ConfirmDialog
      title="Delete this column?"
      message={columnCards(cards, dialogColumn.id).length
        ? `“${dialogColumn.name}” still has ${cardCountLabel(columnCards(cards, dialogColumn.id).length)}. Move or delete them before deleting the column.`
        : `Delete “${dialogColumn.name}”? This cannot be undone.`}
      confirmLabel="Delete column"
      danger
      busy={deleting}
      confirmDisabled={columnCards(cards, dialogColumn.id).length > 0}
      onConfirm={() => { void removeColumn(dialogColumn.id); }}
      onCancel={closeDialog}
    />}
    {dialog?.kind === "moveCard" && dialogCard && <MoveCardSheet card={dialogCard} columns={columns} cards={cards} onCancel={closeDialog} readOnly={readOnly} parentPicker={readOnly ? undefined : hierarchy.parentPicker(dialogCard)}
      onArchive={readOnly ? undefined : () => { void setArchived(dialogCard.id, !dialogCard.archived_at); }}
      onCopyLink={() => { void copyCardLink(boardId, dialogCard.id, notify, undefined, dialogCard.key); }} onMove={async (columnId, place) => {
      const current = detailRef.current;
      setDialog(null);
      returnFocusRef.current = null;
      if (current) await move(dialogCard.id, columnId, sheetMoveAnchor(current.cards, dialogCard.id, columnId, place), { focus: true });
    }}
      onMoveToBoard={readOnly ? undefined : (target, columnId) => moveToBoard(dialogCard, target, columnId)} />}
  </section>;
}

/** Each card's key from the board's code (D710), after the code changed in Board settings (D714). */
function withBoardKeys(detail: BoardDetail): BoardDetail {
  nameBoardCards(detail.board.id, detail.board.code, detail.cards);
  return { ...detail, cards: detail.cards.map((card) => ({ ...card, key: cardKey(detail.board.code, card.number) })) };
}
