import { useState } from "react";
import { ArrowDownToLine, ArrowUpToLine, Check, ChevronLeft, Columns3, Layers, Link as LinkIcon } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { canEnterColumn } from "./taskActions";
import type { BoardColumn, CardSummary } from "./tasksApi";

export type MovePlace = "top" | "bottom";

type MoveCardSheetProps = {
  card: CardSummary;
  columns: BoardColumn[];
  /** The board's cards, to tell which columns are full (D108). */
  cards?: readonly CardSummary[];
  onMove: (columnId: string, place: MovePlace) => Promise<void>;
  onCancel: () => void;
  /** Hierarchy (17A, D128): "Set parent…", the path to reparent without drag (phones, keyboard). */
  parentPicker?: {
    label: string;
    /** "No epic"; left out when the card needs a parent (a subtask, operator QA 0.9.1). */
    noneLabel?: string;
    currentParentId: string | null;
    options: Array<{ id: string; title: string; disabled?: boolean }>;
    onPick: (parentId: string | null) => Promise<void>;
  };
  /** The card's ⋯ menu: "Copy link" copies its permalink without opening the card, then closes the sheet. */
  onCopyLink?: () => void;
  /**
   * The caller may not change this card (below Can edit on the board, or a read-only Team role):
   * the ⋯ menu offers Copy link only, never Move (which the server would refuse, READ_ONLY).
   */
  readOnly?: boolean;
};

// "Move to…": a dialog on desktop, a full-screen sheet on phones. Lists the board's columns and
// Top or Bottom; the current column is allowed, so a card can jump to the top or bottom of its own.
// A column at its WIP limit is listed but disabled.
export function MoveCardSheet({ card, columns, cards = [], onMove, onCancel, parentPicker, onCopyLink, readOnly = false }: MoveCardSheetProps) {
  const [picking, setPicking] = useState(false);
  // Back on the "Set epic…" list returns to Move to… (as its Back to columns button does), not the board.
  useHistoryDialogGuard(picking, () => setPicking(false));
  const [chosen, setChosen] = useState<string | null>(null);
  const [place, setPlace] = useState<MovePlace>("bottom");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = columns.find((column) => column.id === chosen) ?? null;
  const full = (column: BoardColumn) => !canEnterColumn(cards, column, card.id);
  const firstOpen = columns.findIndex((column) => !full(column));

  async function confirm() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await onMove(target.id, place);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not move the card");
      setBusy(false);
    }
  }

  async function pickParent(parentId: string | null) {
    if (!parentPicker) return;
    setBusy(true);
    await parentPicker.onPick(parentId);
    onCancel();
  }

  if (readOnly) {
    return <ModalDialog title={card.title} eyebrow="Card" onClose={onCancel}>
      {onCopyLink && <div className="move-list task-move-parent">
        <button className="move-option" autoFocus onClick={() => { onCopyLink(); onCancel(); }}><LinkIcon aria-hidden="true" /><span>Copy link<small>A link to this card</small></span></button>
      </div>}
      <p className="file-dialog-copy">You can read this card here but not move or change it.</p>
      <footer className="file-dialog-actions">
        <button className="secondary-button" onClick={onCancel}>Close</button>
      </footer>
    </ModalDialog>;
  }

  if (picking && parentPicker) {
    return <ModalDialog title={`${parentPicker.label.replace(/…$/, "")} for “${card.title}”`} eyebrow="Parent" onClose={onCancel} variant="sheet" busy={busy}>
      <div className="move-list" role="radiogroup" aria-label="Parent">
        <button className="move-option" onClick={() => setPicking(false)} disabled={busy}><ChevronLeft aria-hidden="true" /><span>Back to columns</span></button>
        {[...(parentPicker.noneLabel ? [{ id: null as string | null, title: parentPicker.noneLabel, disabled: false }] : []), ...parentPicker.options].map((option, index) => {
          const current = option.id === parentPicker.currentParentId;
          return <button key={option.id ?? "none"} role="radio" aria-checked={current} className={`move-option${current ? " active" : ""}`} autoFocus={index === 0}
            disabled={busy || option.disabled || current} onClick={() => { void pickParent(option.id); }}>
            <Layers aria-hidden="true" /><span>{option.title}{current ? <small>Current</small> : option.disabled && <small>Full (100 children)</small>}</span>
            {current && <Check aria-hidden="true" />}
          </button>;
        })}
        {!parentPicker.options.length && <p className="task-comment-empty">No cards one level up on this board yet.</p>}
      </div>
    </ModalDialog>;
  }

  return <ModalDialog title={`Move “${card.title}”`} eyebrow="Move to" onClose={onCancel} variant="sheet" busy={busy}>
    {onCopyLink && <div className="move-list task-move-parent">
      <button className="move-option" onClick={() => { onCopyLink(); onCancel(); }} disabled={busy}><LinkIcon aria-hidden="true" /><span>Copy link<small>A link to this card</small></span></button>
    </div>}
    {parentPicker && <div className="move-list task-move-parent">
      <button className="move-option" onClick={() => setPicking(true)} disabled={busy}><Layers aria-hidden="true" /><span>{parentPicker.label}<small>{parentPicker.currentParentId ? `Now: ${parentPicker.options.find((option) => option.id === parentPicker.currentParentId)?.title ?? "its parent"}` : "It has none now"}</small></span></button>
    </div>}
    <div className="move-list" role="radiogroup" aria-label="Column">
      {columns.map((column, index) => {
        const current = column.id === card.column_id;
        const refused = full(column);
        return <button key={column.id} role="radio" aria-checked={chosen === column.id} className={`move-option${chosen === column.id ? " active" : ""}`} disabled={busy || refused} autoFocus={index === firstOpen} onClick={() => setChosen(column.id)}>
          <Columns3 aria-hidden="true" />
          <span>{column.name}{current ? <small>Current column</small> : refused && <small>Full (limit {column.wip_limit})</small>}</span>
          {chosen === column.id && <Check aria-hidden="true" />}
        </button>;
      })}
    </div>
    <div className="task-move-place" role="radiogroup" aria-label="Position">
      <button role="radio" aria-checked={place === "top"} className={place === "top" ? "active" : ""} onClick={() => setPlace("top")} disabled={busy}><ArrowUpToLine aria-hidden="true" />Top</button>
      <button role="radio" aria-checked={place === "bottom"} className={place === "bottom" ? "active" : ""} onClick={() => setPlace("bottom")} disabled={busy}><ArrowDownToLine aria-hidden="true" />Bottom</button>
    </div>
    {error && <p className="file-dialog-error" role="alert">{error}</p>}
    <footer className="file-dialog-actions">
      <button className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
      <button className="primary-button" onClick={() => { void confirm(); }} disabled={!target || busy}>{busy ? "Moving…" : target ? `Move to ${place === "top" ? "top" : "bottom"} of ${target.name}` : "Move"}</button>
    </footer>
  </ModalDialog>;
}
