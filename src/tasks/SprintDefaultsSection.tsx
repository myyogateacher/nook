import { useId, useState } from "react";
import { ListChecks, Timer } from "lucide-react";
import { Select } from "../ui/Select";
import { validateSprintDefaults } from "../../shared/boardStructure";
import { SPRINT_DAYS_MAX, SPRINT_DEFAULT_DAYS, SPRINT_PATTERN_MAX, sprintNameFromPattern, type SprintDefaults, type SprintStartRule } from "../../shared/sprintPlan";
import { CUSTOM_DURATION, durationLabel, durationOptions, durationValue, START_RULE_OPTIONS } from "./sprintModel";

type SprintDefaultsSectionProps = {
  /** The board's saved sprint defaults; none on boards made before them. */
  defaults: SprintDefaults | null | undefined;
  owner: boolean;
  /** Saves them into the board's structure (owner). Resolves true when saved. */
  onSave: (defaults: SprintDefaults) => Promise<boolean>;
  /** Opens the Sprints sheet (the list and lifecycle). */
  onManage: () => void;
};

type Draft = { duration: string; days: string; start: SprintStartRule; name: string };

const draftOf = (defaults: SprintDefaults | null | undefined): Draft => {
  const days = defaults?.days ?? SPRINT_DEFAULT_DAYS;
  return { duration: durationValue(days), days: String(days), start: defaults?.start ?? "next", name: defaults?.name ?? "" };
};

/** The draft as sprint defaults, or the reason it cannot be saved. */
export function sprintDefaultsFromDraft(draft: Draft): { ok: true; defaults: SprintDefaults } | { ok: false; error: string } {
  const days = draft.duration === CUSTOM_DURATION ? Number(draft.days) : Number(draft.duration);
  const name = draft.name.trim();
  return validateSprintDefaults({ days, start: draft.start, ...(name ? { name } : {}) });
}

/** "New sprints last 2 weeks, start the day after the previous sprint, and are named Sprint 4." */
export function sprintDefaultsSummary(defaults: SprintDefaults | null | undefined) {
  if (!defaults) return "New sprints last as long as the latest one, start the day after it, and follow its name.";
  const start = START_RULE_OPTIONS.find((option) => option.value === defaults.start)?.label ?? "";
  return `New sprints last ${durationLabel(defaults.days)}, start ${defaults.start === "today" ? "today" : start.replace(/^A /, "on a ").replace(/^The /, "the ")}, and are named ${defaults.name ? `like ${sprintNameFromPattern(defaults.name)}` : "after the latest one"}.`;
}

/**
 * Board settings → Sprint defaults: what a new sprint starts with on this board (stored in the
 * board's structure, owner only): the Duration (1–4 weeks, or Custom 1–60 days), Start on (the day
 * after the previous sprint, a weekday on or after it, or today), and an optional Name pattern with
 * `{n}`. The sprint list and lifecycle live in the Sprints sheet ("Manage sprints").
 */
export function SprintDefaultsSection({ defaults, owner, onSave, onManage }: SprintDefaultsSectionProps) {
  const id = useId();
  const saved = draftOf(defaults);
  const [draft, setDraft] = useState<Draft>(saved);
  const [busy, setBusy] = useState(false);
  const check = sprintDefaultsFromDraft(draft);
  const dirty = !defaults || JSON.stringify(check.ok ? check.defaults : draft) !== JSON.stringify(defaults);

  async function save() {
    if (!check.ok) return;
    setBusy(true);
    try {
      await onSave(check.defaults);
    } finally {
      setBusy(false);
    }
  }

  return <section className="task-settings-section" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}><Timer aria-hidden="true" />Sprint defaults</h3>
    {!owner && <p className="task-settings-note">{sprintDefaultsSummary(defaults)} Only the owner changes them.</p>}
    {owner && <div className="task-sprint-defaults">
      <div className="task-card-field">
        <label id={`${id}-duration`}>Default duration</label>
        <Select labelledBy={`${id}-duration`} label="Default duration" value={draft.duration} options={durationOptions()} disabled={busy} searchable={false}
          onChange={(value) => setDraft({ ...draft, duration: value, days: value === CUSTOM_DURATION ? draft.days : value })} />
      </div>
      {draft.duration === CUSTOM_DURATION && <div className="task-card-field">
        <label htmlFor={`${id}-days`}>Days</label>
        <input id={`${id}-days`} className="task-settings-input" type="number" inputMode="numeric" min={1} max={SPRINT_DAYS_MAX} step={1} value={draft.days} disabled={busy}
          onChange={(event) => setDraft({ ...draft, days: event.target.value })} />
      </div>}
      <div className="task-card-field">
        <label id={`${id}-start`}>Start on</label>
        <Select labelledBy={`${id}-start`} label="Start on" value={draft.start} options={START_RULE_OPTIONS} disabled={busy} searchable={false}
          onChange={(value) => setDraft({ ...draft, start: value })} />
      </div>
      <div className="task-card-field">
        <label htmlFor={`${id}-name`}>Name pattern</label>
        <input id={`${id}-name`} className="task-settings-input" value={draft.name} maxLength={SPRINT_PATTERN_MAX} placeholder="Sprint {n}" disabled={busy}
          aria-describedby={`${id}-name-hint`} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <small id={`${id}-name-hint`} className="task-settings-note">{"{n} counts up: Sprint 1, Sprint 2. Empty: follow the latest sprint's name."}</small>
      </div>
      <p className="task-settings-note" aria-live="polite">{check.ok ? sprintDefaultsSummary(check.defaults) : check.error}</p>
      <span className="task-settings-actions">
        <button type="button" className="primary-button" disabled={busy || !dirty || !check.ok} onClick={() => { void save(); }}>{busy ? "Saving…" : "Save defaults"}</button>
      </span>
    </div>}
    <button type="button" className="secondary-button task-small-button task-sprint-manage" onClick={onManage}><ListChecks />Manage sprints</button>
  </section>;
}
