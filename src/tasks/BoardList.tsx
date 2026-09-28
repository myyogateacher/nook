import { useCallback, useEffect, useState, type ReactNode } from "react";
import { KanbanSquare, Pencil, Plus, RotateCcw, Share2, Trash2, TriangleAlert, Users } from "lucide-react";
import { ConfirmDialog } from "../files/Dialog";
import { relativeTime } from "../files/format";
import { NameDialog } from "../files/RenameDialog";
import { AccessSheet } from "../access/AccessSheet";
import { NewBoardDialog } from "./NewBoardDialog";
import { structureLabel, type BoardTemplateId } from "../../shared/boardStructure";
import { binConfirmMessage, cardCountLabel, sharingLabel, validateBoardName, viewerTimeZone, type TaskNotify } from "./taskActions";
import { createBoard, deleteBoard, listBoards, renameBoard, restoreTaskItem, taskErrorCode, taskErrorMessage, type BoardSummary } from "./tasksApi";
import { useHistoryDialogGuard } from "./useHistoryDialogGuard";

type BoardListProps = {
  onOpen: (board: BoardSummary) => void;
  /** Opens a board by id (after Undo restores it). */
  onOpenBoard?: (boardId: string) => void;
  notify: TaskNotify;
  /** Under the intro: the Tasks home segments (17C). */
  header?: ReactNode;
};

type ListDialog = { kind: "new" } | { kind: "rename" | "share" | "delete"; boardId: string };

export function BoardList({ onOpen, onOpenBoard, notify, header }: BoardListProps) {
  const [deleting, setDeleting] = useState(false);
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ListDialog | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setBoards((await listBoards()).boards);
    } catch (reason) {
      setLoadError(taskErrorMessage(reason, "Could not load your boards"));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const closeDialog = useCallback(() => setDialog(null), []);
  useHistoryDialogGuard(dialog !== null, closeDialog);

  const all = boards ?? [];
  const owned = all.filter((board) => board.is_owner === 1);
  const shared = all.filter((board) => board.is_owner !== 1);
  const dialogBoard = dialog && dialog.kind !== "new" ? all.find((board) => board.id === dialog.boardId) ?? null : null;

  async function create(name: string, template: BoardTemplateId) {
    const { board } = await createBoard(name, template, viewerTimeZone());
    setDialog(null);
    setBoards((current) => current ? [...current, board] : [board]);
    onOpen(board);
  }

  async function rename(board: BoardSummary, name: string) {
    const { board: saved } = await renameBoard(board.id, name);
    setBoards((current) => current?.map((item) => item.id === saved.id ? saved : item) ?? current);
    setDialog(null);
    notify(`Renamed to “${saved.name}”`);
  }

  async function remove(board: BoardSummary) {
    setDeleting(true);
    try {
      await deleteBoard(board.id);
      setBoards((current) => current?.filter((item) => item.id !== board.id) ?? current);
      setDialog(null);
      notify(`Moved “${board.name}” to the Bin`, { label: "Undo", run: () => { void undoDelete(board); } });
    } catch (reason) {
      setDialog(null);
      notify(taskErrorMessage(reason, "Could not delete the board"));
      void load();
    } finally {
      setDeleting(false);
    }
  }

  async function undoDelete(board: BoardSummary) {
    try {
      await restoreTaskItem("board", board.id);
      notify(`Restored the board “${board.name}”`, onOpenBoard ? { label: "Open", run: () => onOpenBoard(board.id) } : undefined);
    } catch (reason) {
      notify(taskErrorCode(reason) === "LIMIT_REACHED" ? "You already have 50 boards" : taskErrorMessage(reason, "Could not restore the board"));
    }
    void load();
  }

  const row = (board: BoardSummary) => <li key={board.id} className="task-board-row">
    <button className="task-board-open" onClick={() => onOpen(board)}>
      <span className="task-board-icon" aria-hidden="true"><KanbanSquare /></span>
      <span className="task-board-copy">
        <span className="task-board-name" title={board.name}>{board.name}</span>
        <span className="task-board-meta">
          <span>{cardCountLabel(board.card_count)}</span>
          {board.structure && (board.structure.levels.length > 1 || board.structure.sprints) && <span>{structureLabel(board.structure)}</span>}
          <time dateTime={board.updated_at}>Updated {relativeTime(board.updated_at)}</time>
          {board.is_owner === 0 ? <span className="owner-badge">{board.owner_name}</span> : board.visibility !== "private" && <span className="task-shared"><Users aria-hidden="true" />{sharingLabel(board.visibility)}</span>}
        </span>
      </span>
    </button>
    {board.is_owner === 1 && <span className="task-board-actions">
      <button className="icon-button" onClick={() => setDialog({ kind: "rename", boardId: board.id })} aria-haspopup="dialog" aria-label={`Rename ${board.name}`} title="Rename"><Pencil /></button>
      <button className="icon-button" onClick={() => setDialog({ kind: "share", boardId: board.id })} aria-haspopup="dialog" aria-label={`Share ${board.name}`} title="Share"><Share2 /></button>
      <button className="icon-button" onClick={() => setDialog({ kind: "delete", boardId: board.id })} aria-haspopup="dialog" aria-label={`Delete ${board.name}`} title="Move to the Bin"><Trash2 /></button>
    </span>}
  </li>;

  return <section className="tasks-content" aria-labelledby="tasks-title">
    <div className="tasks-intro">
      <div>
        <span className="eyebrow">Task boards</span>
        <h1 id="tasks-title">Tasks</h1>
        <p>Plan work on boards you share. Everyone with access can add, edit, and move cards.</p>
      </div>
      <button className="primary-button tasks-new-button" onClick={() => setDialog({ kind: "new" })} aria-haspopup="dialog"><Plus />New board</button>
    </div>
    {header}

    {loadError && <div className="bin-state bin-error" role="alert">
      <span className="bin-state-icon"><TriangleAlert /></span>
      <h2>Could not load your boards</h2>
      <p>{loadError}</p>
      <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
    </div>}
    {!loadError && !boards && <p className="bin-loading" role="status">Loading boards…</p>}
    {!loadError && boards && !all.length && <div className="bin-state">
      <span className="bin-state-icon"><KanbanSquare /></span>
      <h2>No boards yet</h2>
      <p>Create a board from a template: a simple kanban, a to-do list, epics and stories, and more.</p>
      <button className="primary-button" onClick={() => setDialog({ kind: "new" })}><Plus />New board</button>
    </div>}
    {owned.length > 0 && <><h2 className="tasks-section-label">Your boards</h2><ul className="task-board-list" aria-label="Your boards">{owned.map(row)}</ul></>}
    {shared.length > 0 && <><h2 className="tasks-section-label">Shared with you</h2><ul className="task-board-list" aria-label="Boards shared with you">{shared.map(row)}</ul></>}

    {dialog?.kind === "new" && <NewBoardDialog onSubmit={create} onCancel={closeDialog} />}
    {dialog?.kind === "rename" && dialogBoard && <NameDialog title="Rename board" eyebrow="Tasks" label="Board name" initialValue={dialogBoard.name} submitLabel="Rename" hint="Up to 120 characters." validate={(value) => validateBoardName(value, dialogBoard.name)} onSubmit={(name) => rename(dialogBoard, name)} onCancel={closeDialog} />}
    {dialog?.kind === "delete" && dialogBoard && <ConfirmDialog title="Move to the Bin?" message={binConfirmMessage("board", dialogBoard.name)} confirmLabel="Move to Bin" danger busy={deleting} onConfirm={() => { void remove(dialogBoard); }} onCancel={closeDialog} />}
    {dialog?.kind === "share" && dialogBoard && <AccessSheet kind="board" id={dialogBoard.id} title={dialogBoard.name} onClose={closeDialog} onSaved={() => {
      setDialog(null);
      notify("Access updated");
      void load();
    }} />}
  </section>;
}
