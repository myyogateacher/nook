import { useId, useState } from "react";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import type { SprintDefaults } from "../../shared/sprintPlan";
import { carryOverSprint, plannedSprints, sprintDateRange, sprintProgress } from "./sprintModel";
import { taskErrorMessage, type BoardColumn, type CardSummary, type SprintCarryTo, type SprintFields, type SprintSummary } from "./tasksApi";

type SprintCompleteDialogProps = {
  sprint: SprintSummary;
  sprints: readonly SprintSummary[];
  cards: ReadonlyArray<Pick<CardSummary, "id" | "column_id" | "level" | "parent_card_id" | "sprint_id">>;
  columns: readonly BoardColumn[];
  workLevel: number;
  /** The work level's names: "Task", "Tasks"; and the level below's plural ("Subtasks"), when there is one. */
  name: string;
  plural: string;
  childPlural: string | null;
  today: string;
  /** The board's sprint defaults: the new sprint's length, start weekday, and name pattern. */
  defaults?: SprintDefaults | null;
  onComplete: (carryTo: SprintCarryTo, next: SprintFields) => Promise<unknown>;
  onCancel: () => void;
};

const NEW = "new";

/**
 * Complete a sprint (owner, research 2026-09-26 §7.5, D131): "9 done · 5 not done", where the
 * unfinished cards go (the next planned sprint, another planned one, the Backlog, or a new sprint
 * named and dated after this one), then one call that does it all. Back and Escape close it (the
 * board's dialog guard); a failure stays in the dialog.
 */
export function SprintCompleteDialog({ sprint, sprints, cards, columns, workLevel, name, plural, childPlural, today, defaults, onComplete, onCancel }: SprintCompleteDialogProps) {
  const id = useId();
  const planned = plannedSprints(sprints);
  const [target, setTarget] = useState<string>(planned[0]?.id ?? NEW);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = sprintProgress(cards, columns, sprint.id, workLevel);
  const open = progress.total - progress.done;
  const next = carryOverSprint(sprint, today, sprints.map((item) => item.name), defaults);
  const nextRange = sprintDateRange({ start_on: next.startOn, end_on: next.endOn });
  const options = [
    ...planned.map((item) => ({ value: item.id, label: item.name, description: ["Planned", sprintDateRange(item)].filter(Boolean).join(" · ") })),
    { value: "backlog", label: "Backlog", description: "No sprint" },
    { value: NEW, label: `New sprint: ${next.name}`, description: nextRange }
  ];
  const noun = (count: number) => (count === 1 ? name : plural).toLowerCase();

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // Nothing left to carry: no new sprint is made for it.
      const carryTo = open === 0 ? "backlog" : target;
      await onComplete(carryTo, carryTo === NEW ? { name: next.name, startOn: next.startOn, endOn: next.endOn } : {});
    } catch (reason) {
      setError(taskErrorMessage(reason, "Could not complete the sprint"));
      setBusy(false);
    }
  }

  return <ModalDialog title={`Complete ${sprint.name}`} eyebrow="Sprint" onClose={onCancel} busy={busy} describedBy={`${id}-summary`}>
    <div className="file-dialog-form task-sprint-complete">
      <p id={`${id}-summary`} className="task-sprint-summary"><strong>{progress.done} done</strong> · <strong>{open} not done</strong></p>
      {open > 0
        ? <div className="task-card-field">
          <label id={`${id}-target`}>Move the {open === 1 ? `unfinished ${noun(1)}` : `${open} unfinished ${noun(open)}`} to</label>
          <Select labelledBy={`${id}-target`} label="Move the unfinished cards to" value={target} options={options} disabled={busy} onChange={setTarget} searchable={false} />
        </div>
        : <p className="task-settings-note">{progress.total ? `Every ${noun(1)} in it is done.` : `This sprint has no ${plural.toLowerCase()}.`}</p>}
      <p className="task-settings-note">{childPlural ? `${childPlural} follow their ${plural.toLowerCase()}. ` : ""}Done {plural.toLowerCase()} stay in {sprint.name}.</p>
      {error && <p className="file-dialog-error" role="alert">{error}</p>}
    </div>
    <footer className="file-dialog-actions">
      {/* Focus starts on Cancel (QA 0.9.0): Enter on open never completes the sprint by accident. */}
      <button type="button" className="secondary-button" autoFocus onClick={onCancel} disabled={busy}>Cancel</button>
      <button type="button" className="primary-button" onClick={() => { void submit(); }} disabled={busy}>{busy ? "Completing…" : "Complete sprint"}</button>
    </footer>
  </ModalDialog>;
}
