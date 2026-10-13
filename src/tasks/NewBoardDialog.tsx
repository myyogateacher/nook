import { useId, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { BOARD_TEMPLATES, structureLabel, TEMPLATES, type BoardTemplateId } from "../../shared/boardStructure";
import { validateBoardName } from "./taskActions";
import { FormError } from "../ui/FormError";

type NewBoardDialogProps = {
  onSubmit: (name: string, template: BoardTemplateId) => Promise<void>;
  onCancel: () => void;
};

/**
 * "New board" (research 2026-09-26 §7.4, D136): a name and a template. Each template shows its
 * columns and structure in one line; everything can be changed later in Board settings. A dialog
 * on desktop and a full-screen sheet on phones; the list's dialog guard closes it on Back.
 */
export function NewBoardDialog({ onSubmit, onCancel }: NewBoardDialogProps) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<BoardTemplateId>("kanban");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const check = validateBoardName(name);
  const shown = error ?? (touched && !check.ok ? check.error : null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!check.ok) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(check.name, template);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the board");
      setBusy(false);
    }
  }

  return <ModalDialog title="New board" eyebrow="Tasks" onClose={onCancel} busy={busy} variant="sheet">
    <form className="file-dialog-form task-new-board" onSubmit={submit} noValidate>
      <label htmlFor={inputId}>Board name</label>
      <input id={inputId} value={name} autoFocus autoComplete="off" maxLength={200} aria-invalid={shown ? true : undefined}
        onChange={(event) => { setName(event.target.value); setTouched(true); setError(null); }} />
      <FormError message={shown} className="file-dialog-error" />
      <span className="task-template-label" id={`${inputId}-templates`}>Start from</span>
      <div className="task-template-grid" role="radiogroup" aria-labelledby={`${inputId}-templates`}>
        {BOARD_TEMPLATES.map((id) => {
          const item = TEMPLATES[id];
          const checked = template === id;
          return <button key={id} type="button" role="radio" aria-checked={checked} className={`task-preset task-template${checked ? " active" : ""}`} disabled={busy} onClick={() => setTemplate(id)}>
            <span className="task-preset-copy">
              <strong>{item.label}</strong>
              <small>{item.description}</small>
              <small className="task-template-columns">{item.columns.map((column) => column.name).join(" · ")}{item.structure.levels.length > 1 || item.structure.sprints ? ` — ${structureLabel(item.structure)}` : ""}</small>
            </span>
            {checked && <Check className="task-preset-check" aria-hidden="true" />}
          </button>;
        })}
      </div>
      <p className="task-settings-note">Templates set columns and levels only; they add no cards. Change anything later in Board settings.</p>
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Creating…" : "Create board"}</button>
      </footer>
    </form>
  </ModalDialog>;
}
