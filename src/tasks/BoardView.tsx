import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronLeft, CircleCheck, Gauge, Pencil, Plus, RotateCcw, Settings2, Trash2, TriangleAlert } from "lucide-react";
import { BoardSettingsSheet } from "./BoardSettingsSheet";
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
import { hasBoardFilter, withBoardQuery, type BoardQuery } from "./boardUrl";
import { localDateString, viewerTimeZone } from "./taskActions";
import { FilterBar } from "./FilterBar";
import { KeyboardMoveHint } from "./boardViewParts";
import { useTasksTitle } from "./home/HomeSegments";
import { BoardCalendar } from "./BoardCalendar";
import { displayedDay, displayedTime, dueAnnouncement, shiftedDueAt } from "./calendarPlacement";
import { daysBetween } from "../calendarRoute";
import "./boardViews.css";
import { applyCardDetail, applyTagChange, recountTags } from "./cardTags";
import {
  createColumn,
  deleteBoard,
  deleteCard,
  deleteColumn,
  restoreTaskItem,
  getBoard,
  updateCard,
  moveCard,
  renameBoard,
  taskErrorCode,
  taskErrorMessage,
  updateColumn,
  type BoardDetail,
  type CardDetail,
  type CardSummary
} from "./tasksApi";
import { useHistoryDialogGuard } from "./useHistoryDialogGuard";

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
  /** The Sprints sheet (/tasks/:b/sprints) is open over the board; the host opens and closes its route. */
  sprintsOpen?: boolean;
  onOpenSprints?: () => void;
  onCloseSprints?: () => void;
  /** The view, grouping, sort, and filters from the URL query (D112). */
  query: BoardQuery;
  /** `push` for a view switch; filter, sort, and group edits replace the entry (§4.7). */
  onQueryChange: (query: BoardQuery, options?: { push?: boolean }) => void;
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

export function BoardView({ userId, boardId, openCardId, openCardFull = false, onExpandCard, onCollapseCard, onOpenCard, onCloseCard, onBack, onMissing, notify, onBoardDeleted, onOpenBoard, onOpenCardRoute, query, onQueryChange, sprintsOpen = false, onOpenSprints, onCloseSprints }: BoardViewProps) {
  const focusCardId = openCardId;
  const [detail, setDetail] = useState<BoardDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<BoardDialog | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ columnId: string; index: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // The card composer (a guarded dialog, no history entry): the column it was opened from, or null.
  const [composer, setComposer] = useState<{ columnId: string | null; parentId?: string } | null>(null);
  // Read-only Team roles never get the composer (the card dialog hides its Add controls too), and
  // neither do members below `edit` on this board (Wave 32, D272: viewers and commenters).
  const { readOnly: roleReadOnly } = useRole();
  const detailRef = useRef(detail);
  detailRef.current = detail;
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
  useHistoryDialogGuard(dialog !== null, closeDialog);

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
  useHistoryDialogGuard(overSettings, backToSettings);
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
    if (!openCardIdRef.current || !binnedRef.current.has(openCardIdRef.current)) notify("Card not found");
    onCloseCard();
  }, [notify, onCloseCard]);

  const board = detail?.board ?? null;
  const owner = board?.is_owner === 1;
  const readOnly = cardsReadOnly(roleReadOnly, board?.level);
  // Managers (Wave 32, D273) change the structure, columns, tags, sprints, and sharing up to Can edit.
  const canManage = !roleReadOnly && (owner || board?.level === "manage");
  // The tab names the board, and the open card before it (QA 0.9.0).
  const openCardTitle = openCardId ? detail?.cards.find((card) => card.id === openCardId)?.title ?? null : null;
  useTasksTitle(board ? `${openCardTitle ? `${openCardTitle} · ` : ""}${board.name} · Tasks` : null);
  const cardPage = Boolean(openCardId && openCardFull && board);
  // Back on the board from the full page: the phone track shows the column this entry was on.
  useEffect(() => {
    const track = trackRef.current;
    if (!cardPage && track && isMobileViewport()) track.scrollTo({ left: activeColumnRef.current * track.clientWidth, behavior: "instant" as ScrollBehavior });
  }, [cardPage]);
  const columns = [...(detail?.columns ?? [])].sort(byPosition);
  const cards = detail?.cards ?? [];
  const shownColumn = Math.max(0, Math.min(activeColumn, columns.length - 1));
  const dialogColumn = dialog && "columnId" in dialog ? columns.find((column) => column.id === dialog.columnId) ?? null : null;
  const dialogCard = dialog?.kind === "moveCard" ? cards.find((card) => card.id === dialog.cardId) ?? null : null;

  // One pipeline for every view (§4.5): filter, sort, and (in the list view) group the loaded board.
  const data = useMemo(() => detail ? boardData(detail) : null, [detail]);
  const viewContext: BoardContext = { userId, today: localDateString(), now: Date.now(), timeZone: viewerTimeZone() };
  // Sprints (17B): the sprint on screen (`?sprint=`, the active one by default) scopes every view
  // through one more grammar term; the filter bar keeps only the viewer's own terms.
  const sprints = useBoardSprints({ detail, setDetail, query, onQueryChange, notify, load });
  const sprintScoped = sprints.term !== null;
  const scopedQuery = sprints.term ? { ...query, filter: { terms: [...query.filter.terms, sprints.term] } } : query;
  const result = data ? applyBoardQuery(data, scopedQuery, viewContext) : null;
  const scopedTotal = data && sprints.term ? filterBoardCards(data, { terms: [sprints.term] }, viewContext).length : cards.length;
  const filtered = hasBoardFilter(query);
  const view = query.view;
  // The lanes show the matching cards; drag and keyboard moves anchor on the cards in view.
  const laneCards: CardSummary[] = (filtered || sprintScoped) && result ? result.cards : cards;
  const laneCardsRef = useRef(laneCards);
  laneCardsRef.current = laneCards;
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
      if (window.location.pathname !== formatRoute(tasksRoute(boardId))) return;
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
  async function move(cardId: string, columnId: string, afterCardId: string | null, options: { focus?: boolean } = {}) {
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
      setAnnouncement(`Moved to ${place}`);
    } catch (reason) {
      setCards(() => before);
      const code = taskErrorCode(reason);
      if (code === "STALE_POSITION") notify("The board changed while you moved that card. Showing the latest order.");
      else if (code === "COLUMN_FULL") notify(fullMessage(reason, columnId));
      else notify(taskErrorMessage(reason, "Could not move the card"));
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
    void move(card.id, target.columnId, target.afterCardId, { focus: true });
  }

  /**
   * The calendar view's date change (D115): only `dueOn` is sent with the card's revision, so the
   * server keeps the time and zone; `null` clears the date and time. The card moves at once; on
   * CARD_CHANGED (or any failure) it moves back and the board reloads. WIP limits do not apply.
   */
  async function setDue(cardId: string, dueOn: string | null) {
    const current = detailRef.current;
    const card = current?.cards.find((item) => item.id === cardId);
    if (!current || !card || card.due_on === dueOn) return;
    const before = current.cards;
    const shift = dueOn && card.due_on ? daysBetween(card.due_on, dueOn) : 0;
    setCards((items) => items.map((item) => item.id !== cardId ? item : dueOn === null
      ? { ...item, due_on: null, due_time: null, due_tz: null, due_at: null }
      : { ...item, due_on: dueOn, due_at: shiftedDueAt(item.due_at, shift) }));
    try {
      const { card: saved } = await updateCard(cardId, { dueOn, revision: card.revision });
      setCards((items) => items.map((item) => item.id === cardId
        ? { ...item, revision: saved.revision, due_on: saved.due_on, due_time: saved.due_time, due_tz: saved.due_tz, due_at: saved.due_at, updated_at: saved.updated_at }
        : item));
      const zone = viewerTimeZone();
      setAnnouncement(`${card.title}: ${dueAnnouncement(displayedDay(saved, zone), displayedTime(saved, zone))}`);
      focusCard(cardId);
    } catch (reason) {
      setCards(() => before);
      notify(taskErrorCode(reason) === "CARD_CHANGED" ? "Someone else changed this card. It was reloaded." : taskErrorMessage(reason, "Could not change the due date"));
      void load();
    }
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
    if (mode === "another") return;
    setComposer(null);
    if (mode === "open") {
      onOpenCard(card.id);
      return;
    }
    notify(`Added “${card.title}”`);
    const index = [...(detailRef.current?.columns ?? [])].sort(byPosition).findIndex((column) => column.id === card.column_id);
    if (isMobileViewport() && index >= 0 && index !== activeColumnRef.current) showColumn(index);
    focusCard(card.id);
  }

  async function rename(name: string) {
    const { board: saved } = await renameBoard(boardId, name);
    setDetail((current) => current ? { ...current, board: saved } : current);
    closeLayer();
    notify(`Renamed to “${saved.name}”`);
  }

  async function addColumn(name: string) {
    const { columns: saved } = await createColumn(boardId, name);
    setDetail((current) => current ? { ...current, columns: saved } : current);
    closeLayer();
    notify(`Added column ${name}`);
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
    notify(wipLimit === null ? `Removed the limit on ${name}` : `${name} takes at most ${cardCountLabel(wipLimit)}`);
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
      notify(taskErrorMessage(reason, "Could not move the column"));
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
      notify(`Moved “${name}” to the Bin`, { label: "Undo", run: () => {
        restoreTaskItem("board", boardId).then(() => onOpenBoard(boardId), (reason) => notify(taskErrorMessage(reason, "Could not restore the board")));
      } });
    } catch (reason) {
      closeLayer();
      notify(taskErrorMessage(reason, "Could not delete the board"));
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
    notify(`Moved “${card?.title ?? "card"}”${descendantCount ? ` and ${descendantCount === 1 ? "1 card" : `${descendantCount} cards`} under it` : ""} to the Bin`, { label: "Undo", run: () => {
      restoreTaskItem("card", cardId, place).then((result) => {
        for (const id of gone) binnedRef.current.delete(id);
        notify(`Restored to ${result.columnName ?? "the board"}${result.descendantCount ? ` with ${result.descendantCount === 1 ? "1 card" : `${result.descendantCount} cards`} under it` : ""}${result.detached ? ", without its parent (it is in the Bin)" : ""}`);
        void load();
      }, (reason) => notify(taskErrorMessage(reason, "Could not restore the card")));
    } });
  }

  async function removeColumn(columnId: string) {
    setDeleting(true);
    try {
      const { columns: saved } = await deleteColumn(columnId);
      setDetail((current) => current ? { ...current, columns: saved } : current);
      setDialog(null);
      returnFocusRef.current = null;
      notify("Column deleted");
    } catch (reason) {
      const code = taskErrorCode(reason);
      // Someone added a card meanwhile: stay open; the reload disables Delete and says why.
      if (code !== "COLUMN_NOT_EMPTY") closeDialog();
      notify(code === "COLUMN_NOT_EMPTY" ? "This column has cards now. Move or delete them first." : code === "LAST_COLUMN" ? "A board needs at least one column" : taskErrorMessage(reason, "Could not delete the column"));
      void load();
    } finally {
      setDeleting(false);
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
      {board && <span className="task-board-count">{cardCountLabel(board.card_count)}</span>}
      {detail && !readOnly && <button className="primary-button task-new-card" onClick={() => setComposer({ columnId: null })} aria-haspopup="dialog" aria-label="New card" title="New card"><Plus /><span>New card</span></button>}
      {detail && <BoardViewSwitch value={view} onChange={(next) => onQueryChange(withBoardQuery(query, { view: next }), { push: true })} />}
      {board && <span className="task-board-actions">
        <button className="icon-button" onClick={(event) => openDialog({ kind: "settings" }, event.currentTarget)} aria-haspopup="dialog" aria-label="Board settings" title="Board settings"><Settings2 /></button>
      </span>}
    </header>
    {data && sprints.selection && <SprintBar sprints={sprints.sprints} selection={sprints.selection} cards={data.cards} columns={columns} workLevel={hierarchy.structure.workLevel}
      name={hierarchy.structure.levels[hierarchy.structure.workLevel]?.name ?? "Card"} plural={hierarchy.structure.levels[hierarchy.structure.workLevel]?.plural ?? "Cards"}
      today={viewContext.today} owner={canManage} onSelect={sprints.select} onStart={(sprint) => { void sprints.start(sprint); }}
      onComplete={(sprint, trigger) => openDialog({ kind: "completeSprint", sprintId: sprint.id }, trigger)}
      onNewSprint={(trigger) => openDialog({ kind: "newSprint" }, trigger)} onManage={onOpenSprints} />}
    <KeyboardMoveHint id="task-card-keys">Press Alt with an arrow key to move a card up, down, or to the next column.</KeyboardMoveHint>
    <p className="sr-only" aria-live="polite">{announcement}</p>

    {loadError && <div className="bin-state bin-error task-board-state" role="alert">
      <span className="bin-state-icon"><TriangleAlert /></span>
      <h2>Could not load this board</h2>
      <p>{loadError}</p>
      <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
    </div>}
    {!loadError && !detail && <p className="bin-loading task-board-state" role="status">Loading the board…</p>}
    {detail && data && result && <FilterBar board={data} context={viewContext} filter={query.filter} shown={result.cards.length} total={scopedTotal}
      onChange={(filter) => onQueryChange(withBoardQuery(query, { filter }))} />}
    {detail && sprintConflict && <p className="task-sprint-conflict" role="status">{sprintConflict}</p>}
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
        onOpenCard={(card) => onOpenCard(card.id)} onSetDue={(card, dueOn) => { void setDue(card.id, dueOn); }} readOnly={readOnly} />
    </div>}
    {detail && view === "board" && <nav className="task-column-tabs" aria-label="Columns">
      {columns.map((column, index) => {
        // The cards on screen; a WIP limit counts every live card (QA 0.9.0).
        const badge = columnBadge(columnCards(shownLane, column.id).length, columnCards(cards, column.id).length, column.wip_limit);
        return <button key={column.id} id={`task-tab-${column.id}`} className={index === shownColumn ? "active" : ""} aria-current={index === shownColumn ? "true" : undefined} onClick={() => showColumn(index)}>
          <span>{column.name}</span><b className={badge.wip ? `task-wip ${badge.wip}` : undefined} aria-label={badge.label}>{badge.text}</b>
        </button>;
      })}
      {canManage && columns.length < MAX_COLUMNS && <button className="task-tab-add" onClick={(event) => openDialog({ kind: "addColumn" }, event.currentTarget)} aria-haspopup="dialog" aria-label="Add column"><Plus /></button>}
    </nav>}
    {detail && view === "board" && <div className="task-columns" ref={trackRef} onScroll={onTrackScroll}>
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
        tags={detail.tags}
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
          if (refusal) { notify(refusal); setAnnouncement(refusal); } else setComposer({ columnId: column.id });
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
      notify={notify}
      onMove={(card) => openDialog({ kind: "moveCard", cardId: card.id })}
      onDelete={removeCard}
      onChanged={(card) => setDetail((current) => current ? applyCardDetail(current, card) : current)}
      tags={detail.tags ?? []}
      onTagsChange={(change) => setDetail((current) => current ? applyTagChange(current, change) : current)}
      onOpenRelated={(target) => onOpenCardRoute?.(target.board_id, target.id)}
      onRelationsChanged={(id, counts) => setCards((items) => items.map((item) => item.id === id ? { ...item, ...counts } : item))}
      hierarchy={hierarchy.dialog}
      sprints={sprints.enabled ? sprints.sprints : undefined}
    /></CardPage>}
    {composer && !readOnly && detail && board && <CardComposer
      boardId={boardId}
      boardName={board.name}
      userId={userId}
      columns={columns}
      cards={cards}
      initialColumnId={composer.columnId}
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
      initialSprintId={sprints.composerSprintId}
    />}
    {(dialog?.kind === "settings" || overSettings) && board && <BoardSettingsSheet board={board} owner={canManage} isOwner={owner} showAllLevels={hierarchy.showAll} onShowAllLevels={hierarchy.setShowAll}
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
      notify("Access updated");
      void load();
    }} />}
    {dialog?.kind === "deleteBoard" && board && <ConfirmDialog title="Move to the Bin?" message={binConfirmMessage("board", board.name)} confirmLabel="Move to Bin" danger busy={deleting} onConfirm={() => { void removeBoard(); }} onCancel={closeLayer} />}
    {dialog?.kind === "addColumn" && <NameDialog title="Add column" eyebrow={board?.name ?? "Board"} label="Column name" initialValue="" submitLabel="Add column" hint="Up to 60 characters. It is added at the end." validate={(value) => validateColumnName(value)} onSubmit={addColumn} onCancel={closeLayer} />}
    {dialog?.kind === "columnMenu" && dialogColumn && <ModalDialog title={dialogColumn.name} eyebrow="Column" onClose={closeDialog}>
      <div className="move-list task-menu">
        <button className="move-option" autoFocus onClick={() => setDialog({ kind: "renameColumn", columnId: dialogColumn.id })}><Pencil aria-hidden="true" /><span>Rename</span></button>
        <ColumnStateField column={dialogColumn} onError={notify} onChanged={(saved, changed) => {
          setDetail((current) => current ? { ...current, columns: saved } : current);
          notify(`${changed.name} is now ${STATE_LABELS[columnState(changed)].toLowerCase()}${changed.is_done === 1 ? ": its cards count as done" : ""}`);
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
      onCopyLink={() => { void copyCardLink(boardId, dialogCard.id, notify); }} onMove={async (columnId, place) => {
      const current = detailRef.current;
      setDialog(null);
      returnFocusRef.current = null;
      if (current) await move(dialogCard.id, columnId, sheetMoveAnchor(current.cards, dialogCard.id, columnId, place), { focus: true });
    }} />}
  </section>;
}
