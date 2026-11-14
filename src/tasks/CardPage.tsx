import type { ReactNode } from "react";
import { useShellRail } from "../shell/shellContext";
import { ChevronLeft } from "lucide-react";

type CardPageProps = {
  /** Off: the card is a dialog over the board, and the children render as they are. */
  enabled: boolean;
  boardName: string;
  /** Close: back to the board (§4.7). */
  onBackToBoard: () => void;
  /** The card view (`CardDialog` with `layout="page"` when enabled). */
  children: ReactNode;
};

/**
 * The card as a full page at /tasks/:b/card/:k/full (WAVE_13_TASK_CARD_UX.md §4.3, §4.7): the card
 * view in its page layout, in the board's place rather than over it and not modal, with the
 * description and comments on the left and the fields and relations on the right above 1024 px.
 * Expand in the dialog pushes it; Collapse and Back return to the dialog; a direct load shows it
 * with this Back to board control.
 */
export function CardPage({ enabled, boardName, onBackToBoard, children }: CardPageProps) {
  // D1279: the full-page card wants the width, so the global sidebar stays in the rail meanwhile.
  useShellRail(enabled);
  // The same element tree in both layouts, so Expand and Collapse keep the card view mounted (an
  // unsaved description survives the switch); the dialog's host box has display: contents.
  return <div className={enabled ? "task-card-page-wrap" : "task-card-dialog-host"}>
    {enabled && <nav className="task-card-page-bar" aria-label="Card page">
      <button type="button" className="task-card-page-back" onClick={onBackToBoard} aria-label={`Back to board ${boardName}`} title="Back to board">
        <ChevronLeft aria-hidden="true" /><span>{boardName}</span>
      </button>
    </nav>}
    {children}
  </div>;
}
