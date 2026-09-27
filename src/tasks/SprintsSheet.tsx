import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { trapTabKey, useDialogFocus } from "../files/Dialog";

type SprintsSheetProps = {
  boardName: string;
  onClose: () => void;
  /** A dialog is open over the sheet (Complete sprint): it handles Escape, and the sheet waits. */
  suspended?: boolean;
  children: ReactNode;
};

/**
 * The Sprints sheet (`/tasks/:b/sprints`): the board's sprint list, lifecycle, and history, out of
 * Board settings so a long list never crowds them. A right-hand panel on desktop and a full-screen
 * sheet on phones, like Board settings. It is a route, so Back returns to the board and a link
 * opens it; Escape and × close it the same way.
 */
export function SprintsSheet({ boardName, onClose, suspended = false, children }: SprintsSheetProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  useDialogFocus(panelRef);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || suspended) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, suspended]);

  return <>
    <button className="panel-scrim" onClick={onClose} aria-label="Close sprints" tabIndex={-1} />
    <aside ref={panelRef} tabIndex={-1} className="side-panel task-settings-panel task-sprints-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={trapTabKey}>
      <header>
        <div><span className="eyebrow">{boardName}</span><h2 id={titleId}>Sprints</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Close sprints"><X /></button>
      </header>
      <div className="task-settings-body">{children}</div>
    </aside>
  </>;
}
