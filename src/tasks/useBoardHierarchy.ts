import { useCallback, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { aLevel, childName, levelName, parentRequired, type BoardStructure } from "../../shared/boardStructure";
import { columnCards } from "./boardOrder";
import { applyCardDetail } from "./cardTags";
import { canNest, checklistColumn, childrenOf, hasLevels, hiddenAboveNote, hiddenColumnHint, hiddenLevels, levelOf, newChildColumn, parentCandidates, rollupMap, structureOf, visibleOnBoard, type Rollup } from "./hierarchyModel";
import type { TaskNotify } from "./taskActions";
import { createCard, taskErrorCode, taskErrorMessage, updateCard, type BoardDetail, type CardDetail, type CardSummary } from "./tasksApi";

/** What the lane cards need for chips and nesting by drag (§7.3, D128). */
export type ColumnNesting = {
  parentOf: (card: CardSummary) => { id: string; title: string; levelName: string } | null;
  rollupOf: (card: CardSummary) => Rollup | null;
  /** "subtasks" / "stories": what a card's children are called. */
  childLabel: (card: CardSummary) => string;
  onOpenCardId: (cardId: string) => void;
  canNest: (draggedId: string, targetId: string) => boolean;
  nestTarget: string | null;
  onNestOver: (targetId: string | null) => void;
  onNestDrop: (draggedId: string, targetId: string) => void;
  nestLabel: (targetId: string) => string;
};

/** What the card dialog needs for the breadcrumb, the Parent field, and the Subtasks section (§7.2). */
export type CardHierarchyContext = {
  structure: BoardStructure;
  cards: readonly CardSummary[];
  columns: BoardDetail["columns"];
  openCard: (cardId: string) => void;
  /** Checks or unchecks a child: moves it to the first done column or back to the first open one (D127). */
  setChildDone: (child: CardSummary, done: boolean) => Promise<void>;
  addChild: (parent: CardDetail, title: string) => Promise<boolean>;
  /** Opens the composer with the parent filled in ("Add with details…"). */
  composeChild: (parent: CardDetail) => void;
  /** Takes a child out of its parent (it keeps its level). */
  detachChild: (child: CardSummary) => Promise<void>;
};

type Options = {
  detail: BoardDetail | null;
  detailRef: MutableRefObject<BoardDetail | null>;
  setDetail: Dispatch<SetStateAction<BoardDetail | null>>;
  move: (cardId: string, columnId: string, afterCardId: string | null) => Promise<void>;
  notify: TaskNotify;
  load: () => Promise<void>;
  onOpenCard: (cardId: string) => void;
  openComposer: (options: { parentId: string; level: number }) => void;
};

const storageKey = (boardId: string) => `nook.tasks.showAllLevels.${boardId}`;
function readShowAll(boardId: string | undefined) {
  if (!boardId) return false;
  try {
    return window.localStorage.getItem(storageKey(boardId)) === "1";
  } catch {
    return false;
  }
}

/**
 * The board's hierarchy state and actions (research 2026-09-26 §7.2–§7.3), kept out of BoardView:
 * which cards the columns show (with the per-viewer "Show all levels", D126), roll-ups from the
 * loaded cards, reparenting by drag or menu (D128), and the card dialog's checklist.
 */
export function useBoardHierarchy({ detail, detailRef, setDetail, move, notify, load, onOpenCard, openComposer }: Options) {
  const boardId = detail?.board.id;
  const structure = structureOf(detail?.board);
  const cards = useMemo(() => detail?.cards ?? [], [detail]);
  const columns = useMemo(() => detail?.columns ?? [], [detail]);
  const rollups = useMemo(() => rollupMap(cards, columns), [cards, columns]);
  const [showAllState, setShowAllState] = useState<{ boardId?: string; value: boolean }>({ boardId, value: readShowAll(boardId) });
  const showAll = showAllState.boardId === boardId ? showAllState.value : readShowAll(boardId);
  const [nestTarget, setNestTarget] = useState<string | null>(null);
  const moveRef = useRef(move);
  moveRef.current = move;

  const setShowAll = useCallback((value: boolean) => {
    setShowAllState({ boardId, value });
    try {
      if (boardId) window.localStorage.setItem(storageKey(boardId), value ? "1" : "0");
    } catch {
      // Private mode: the choice lasts for this visit only.
    }
  }, [boardId]);

  const replaceCard = useCallback((card: CardDetail) => setDetail((current) => current ? applyCardDetail(current, card) : current), [setDetail]);

  /** PATCH parentId (and level) with the card's revision; a conflict reloads the board. */
  const reparent = useCallback(async (cardId: string, parentId: string | null, level?: number) => {
    const current = detailRef.current?.cards.find((card) => card.id === cardId);
    if (!current) return;
    const parent = parentId ? detailRef.current?.cards.find((card) => card.id === parentId) : null;
    try {
      const { card } = await updateCard(cardId, { parentId, ...(level === undefined ? {} : { level }), revision: current.revision });
      replaceCard(card);
      notify(parent ? `Moved “${current.title}” under “${parent.title}”`
        : level !== undefined && level !== levelOf(current) ? `“${current.title}” is ${aLevel(structure, level)} now` : `“${current.title}” has no parent now`);
    } catch (reason) {
      notify(taskErrorCode(reason) === "CARD_CHANGED" ? "Someone else changed that card. Showing the latest board." : taskErrorMessage(reason, "Could not change the parent"));
      void load();
    }
  }, [detailRef, load, notify, replaceCard, structure]);

  const bottomOf = (columnId: string, cardId: string) => {
    const others = columnCards(detailRef.current?.cards ?? [], columnId).filter((card) => card.id !== cardId);
    return others.length ? others[others.length - 1]!.id : null;
  };

  const nesting: ColumnNesting = {
    parentOf: (card) => {
      const parent = card.parent_card_id ? cards.find((item) => item.id === card.parent_card_id) : undefined;
      return parent ? { id: parent.id, title: parent.title, levelName: levelName(structure, levelOf(parent)) } : null;
    },
    rollupOf: (card) => rollups.get(card.id) ?? null,
    childLabel: (card) => (structure.levels[levelOf(card) + 1]?.plural ?? "Subtasks").toLowerCase(),
    onOpenCardId: onOpenCard,
    canNest: (draggedId, targetId) => hasLevels(structure) && canNest(cards, draggedId, targetId, rollups),
    nestTarget,
    onNestOver: (targetId) => setNestTarget((current) => current === targetId ? current : targetId),
    onNestDrop: (draggedId, targetId) => {
      setNestTarget(null);
      if (canNest(detailRef.current?.cards ?? [], draggedId, targetId, rollups)) void reparent(draggedId, targetId);
    },
    nestLabel: (targetId) => {
      const target = cards.find((card) => card.id === targetId);
      return target ? `Make ${childName(structure, levelOf(target)).toLowerCase()} of “${target.title}”` : "";
    }
  };

  const dialog: CardHierarchyContext = {
    structure,
    cards,
    columns,
    openCard: onOpenCard,
    setChildDone: async (child, done) => {
      const columnId = checklistColumn(detailRef.current?.columns ?? [], done);
      if (!columnId) return;
      await moveRef.current(child.id, columnId, bottomOf(columnId, child.id));
      // D125 (a): the last child done suggests finishing the parent; nothing moves on its own.
      const board = detailRef.current;
      const parent = child.parent_card_id ? board?.cards.find((card) => card.id === child.parent_card_id) : undefined;
      if (!done || !board || !parent) return;
      const doneIds = new Set(board.columns.filter((column) => column.is_done === 1).map((column) => column.id));
      const siblings = childrenOf(board.cards, board.columns, parent.id);
      if (siblings.length && siblings.every((item) => doneIds.has(item.column_id)) && !doneIds.has(parent.column_id)) {
        notify(`All ${(structure.levels[levelOf(parent) + 1]?.plural ?? "subtasks").toLowerCase()} are done. Move “${parent.title}” to done?`, {
          label: "Move", run: () => { void moveRef.current(parent.id, columnId, bottomOf(columnId, parent.id)); }
        });
      }
    },
    addChild: async (parent, title) => {
      const columnId = newChildColumn(detailRef.current?.columns ?? []);
      if (!columnId) return false;
      try {
        const { card } = await createCard(parent.board_id, { columnId, title, parentId: parent.id, sprintId: null });
        setDetail((current) => current ? { ...current, cards: [...current.cards, card], board: { ...current.board, card_count: current.board.card_count + 1 } } : current);
        return true;
      } catch (reason) {
        notify(taskErrorCode(reason) === "COLUMN_FULL" ? "The first open column is full. Make room there, or add it with details." : taskErrorMessage(reason, "Could not add it"));
        return false;
      }
    },
    composeChild: (parent) => openComposer({ parentId: parent.id, level: levelOf(parent) + 1 }),
    // A subtask cannot lose its parent (PARENT_REQUIRED): it becomes a work-level card instead.
    detachChild: (child) => reparent(child.id, null, parentRequired(structure, levelOf(child)) ? structure.workLevel : undefined)
  };

  /** The Move sheet's "Set parent…" list (the 390 px path, D128). */
  const parentPicker = (card: CardSummary) => {
    if (!hasLevels(structure) || levelOf(card) === 0) return undefined;
    const candidates = parentCandidates(cards, card);
    return {
      label: `Set ${levelName(structure, levelOf(card) - 1).toLowerCase()}…`,
      ...(parentRequired(structure, levelOf(card)) ? {} : { noneLabel: `No ${levelName(structure, levelOf(card) - 1).toLowerCase()}` }),
      currentParentId: card.parent_card_id ?? null,
      options: candidates.map((candidate) => ({ id: candidate.id, title: candidate.title, disabled: (rollups.get(candidate.id)?.total ?? 0) >= 100 && candidate.id !== card.parent_card_id })),
      onPick: (parentId: string | null) => reparent(card.id, parentId)
    };
  };

  return {
    structure,
    showAll,
    setShowAll,
    /** The lane cards (D126); a filtered board shows every match whatever its level. */
    visible: (laneCards: CardSummary[], filtered: boolean) => filtered ? laneCards : visibleOnBoard(laneCards, structure, showAll),
    /**
     * A column's hidden levels (QA 0.9.0): the "1 epic not shown" note (with "Show all levels")
     * and the empty column's level-aware hint. `lane` is the column's cards in scope, `shown` the listed ones.
     */
    hiddenIn: (lane: readonly CardSummary[], shown: readonly CardSummary[]) => {
      const hidden = hiddenLevels(lane, shown, structure);
      return { note: showAll ? null : hiddenAboveNote(structure, hidden.above), hint: hiddenColumnHint(structure, hidden) };
    },
    nesting,
    dialog,
    parentPicker,
    clearNest: () => setNestTarget(null)
  };
}
