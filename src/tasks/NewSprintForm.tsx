import { useId, useState } from "react";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import { SPRINT_NAME_MAX, sprintEndFor, type SprintDefaults } from "../../shared/sprintPlan";
import { CUSTOM_DURATION, durationOptions, durationValue, newSprintDefaults, plannedSprints, sprintDateRange, sprintLength } from "./sprintModel";
import type { SprintFields, SprintSummary } from "./tasksApi";

export type NewSprintDraft = { name: string; startOn: string; endOn: string; duration: string };

/**
 * The form's first values: the suggested name and start (the board's sprint defaults, else after
 * the latest open sprint), and the Duration as the board's default length (1–4 weeks, or Custom).
 */
export function initialNewSprintDraft(sprints: readonly SprintSummary[], today: string, defaults?: SprintDefaults | null): NewSprintDraft {
  const plan = newSprintDefaults(sprints, today, defaults);
  const days = defaults?.days ?? sprintLength(plan.startOn, plan.endOn) ?? 14;
  return { name: plan.name, startOn: plan.startOn, endOn: sprintEndFor(plan.startOn, days), duration: durationValue(days) };
}

/** The end date for a start and a Duration value: start + weeks (start and end included); Custom keeps `endOn`. */
export function endForDuration(startOn: string, duration: string, endOn: string) {
  if (duration === CUSTOM_DURATION || !startOn) return endOn;
  return sprintEndFor(startOn, Number(duration));
}

/**
 * The dates "Create and start" saves (QA 0.9.2): a sprint that starts now starts today, whatever
 * start the form suggested, and keeps the chosen length (the Duration, or the Custom range's).
 */
export function startTodayDates(draft: NewSprintDraft, today: string) {
  const days = draft.duration === CUSTOM_DURATION ? sprintLength(draft.startOn, draft.endOn) ?? 14 : Number(draft.duration);
  return { startOn: today, endOn: sprintEndFor(today, days) };
}

type NewSprintFormProps = {
  sprints: readonly SprintSummary[];
  today: string;
  defaults?: SprintDefaults | null;
  /** Offer "Create and start" (no sprint is active). */
  canStart: boolean;
  /** Resolves true when the sprint was made (the host closes the form). */
  onSubmit: (fields: SprintFields & { name: string }, start: boolean) => Promise<boolean>;
  onCancel: () => void;
  /** `dialog`: the New sprint dialog's footer; `inline`: in the Sprints sheet. */
  layout?: "dialog" | "inline";
  onBusy?: (busy: boolean) => void;
  /** With a planned sprint and none active, the form offers "Start <name>" instead (QA 0.9.2). */
  onStartPlanned?: (sprint: SprintSummary) => void;
};

/**
 * New sprint (research 2026-09-26 §7.5): the name, the start date, and a Duration of 1–4 weeks or
 * Custom (which shows the end date), prefilled from the board's sprint defaults. The end date
 * follows the start and the duration. Create, or Create and start when no sprint is active.
 */
export function NewSprintForm({ sprints, today, defaults, canStart, onSubmit, onCancel, layout = "inline", onBusy, onStartPlanned }: NewSprintFormProps) {
  const id = useId();
  const [draft, setDraft] = useState(() => initialNewSprintDraft(sprints, today, defaults));
  const [busy, setBusyState] = useState(false);
  const setBusy = (value: boolean) => { setBusyState(value); onBusy?.(value); };
  const name = draft.name.trim();
  const custom = draft.duration === CUSTOM_DURATION;
  const backwards = Boolean(draft.startOn && draft.endOn && draft.startOn > draft.endOn);
  const ready = Boolean(name) && !backwards && !busy;
  const planned = canStart && onStartPlanned ? plannedSprints(sprints)[0] ?? null : null;

  const change = (next: Partial<NewSprintDraft>) => setDraft((current) => {
    const merged = { ...current, ...next };
    return { ...merged, endOn: endForDuration(merged.startOn, merged.duration, merged.endOn) };
  });

  async function submit(start: boolean) {
    if (!ready) return;
    setBusy(true);
    let made = false;
    try {
      const dates = start ? startTodayDates(draft, today) : { startOn: draft.startOn, endOn: draft.endOn };
      made = await onSubmit({ name, startOn: dates.startOn || null, endOn: dates.endOn || null }, start);
    } finally {
      // The host unmounts the form once the sprint is made.
      if (!made) setBusy(false);
    }
  }

  const fields = <div className={layout === "dialog" ? "file-dialog-form task-sprint-form" : "task-sprint-form"}>
    {planned && <p className="task-settings-note task-sprint-planned-hint">{planned.name} is planned — start it instead?{" "}
      <button type="button" className="task-link-button" disabled={busy} onClick={() => onStartPlanned?.(planned)}>Start {planned.name}</button></p>}
    <label htmlFor={`${id}-name`}>Name</label>
    <input id={`${id}-name`} value={draft.name} maxLength={SPRINT_NAME_MAX} autoFocus disabled={busy} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
    <span className="task-sprint-dates">
      <label>Starts<input type="date" value={draft.startOn} min="1900-01-01" max="2999-12-31" disabled={busy} onChange={(event) => change({ startOn: event.target.value })} /></label>
      <span className="task-sprint-duration">
        <span id={`${id}-duration`}>Duration</span>
        <Select labelledBy={`${id}-duration`} label="Duration" value={draft.duration} options={durationOptions()} disabled={busy} searchable={false} onChange={(value) => change({ duration: value })} />
      </span>
    </span>
    {custom
      ? <label className="task-sprint-end">Ends<input type="date" value={draft.endOn} min={draft.startOn || "1900-01-01"} max="2999-12-31" disabled={busy} onChange={(event) => setDraft({ ...draft, endOn: event.target.value })} /></label>
      : <p className="task-settings-note task-sprint-range" aria-live="polite">{sprintDateRange({ start_on: draft.startOn || null, end_on: draft.endOn || null }) || "No dates"}</p>}
    {backwards && <p className="file-dialog-error" role="alert">The sprint cannot end before it starts.</p>}
  </div>;

  const buttons = <>
    <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
    {canStart && <button type="button" className="secondary-button" disabled={!ready} onClick={() => { void submit(true); }}>Create and start</button>}
    <button type="submit" className="primary-button" disabled={!ready}>{busy ? "Creating…" : "Create"}</button>
  </>;

  return <form className="task-new-sprint" noValidate onSubmit={(event) => { event.preventDefault(); void submit(false); }}
    onKeyDown={(event) => {
      // Inline, Escape cancels the form and not the sheet around it; the dialog handles its own.
      if (layout === "inline" && event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onCancel(); }
    }}>
    {fields}
    {layout === "dialog" ? <footer className="file-dialog-actions">{buttons}</footer> : <span className="task-settings-actions">{buttons}</span>}
  </form>;
}

type NewSprintDialogProps = Omit<NewSprintFormProps, "layout" | "onBusy"> & { boardName: string };

/**
 * The New sprint dialog from the header sprint switcher: a centred dialog on desktop and a bottom
 * sheet on phones (ModalDialog). The board's dialog guard closes it on Back and Escape.
 */
export function NewSprintDialog({ boardName, onCancel, ...form }: NewSprintDialogProps) {
  const [busy, setBusy] = useState(false);
  return <ModalDialog title="New sprint" eyebrow={boardName} onClose={onCancel} busy={busy}>
    <NewSprintForm {...form} onCancel={onCancel} layout="dialog" onBusy={setBusy} />
  </ModalDialog>;
}
