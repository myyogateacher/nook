import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { MentionTextarea } from "../ui/mentions/MentionTextarea";
import { CheckSquare, Plus, Square, Trash2 } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { Select, type Option } from "../ui/Select";
import { PersonPicker } from "../ui/people/People";
import { errorText } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { HEALTH_LABEL } from "../ui/tone";
import {
  addKeyResult, boardParts, checkIn, closeGoal, closePeriod, createGoal, createPeriod, deletePeriod, listBoards, listGoals, listGroups, listPeriods, listSources, listUsers,
  listViews, previewSource, updateGoal, updateKeyResult, updatePeriod, type GoalDetail, type GoalSummary, type KeyResult, type KrInput, type Period, type SourceInfo
} from "./goalsApi";
import { resolveRef } from "../ui/workspaceApi";
import {
  CADENCE_LABEL, CHECKIN_CADENCES, formatKrValue, KR_DIRECTION_LABEL, KR_DIRECTIONS, KR_METRIC_LABEL, KR_METRICS,
  type CheckinCadence, type GoalHealth, type GoalKind, type KrDirection, type KrMetric, type ProgressMode
} from "../../shared/goals";
import type { PersonSummary } from "../../shared/people";

/**
 * The Goals sheets (§E.4: quick create and edit, max 560 px on desktop, full screen on phones, Esc and
 * Back close): New/Edit goal, Key result (with its progress source), Check in, Close, and Periods.
 */

function Sheet({ title, eyebrow, onClose, busy, children, onSubmit, submitLabel, error, danger }: {
  title: string; eyebrow?: string; onClose: () => void; busy: boolean; children: ReactNode; onSubmit: () => void | Promise<void>; submitLabel: string; error: string | null; danger?: ReactNode;
}) {
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  const submit = (event: FormEvent) => { event.preventDefault(); void onSubmit(); };
  return <ModalDialog title={title} eyebrow={eyebrow ?? "Goals"} onClose={onClose} variant="sheet" busy={busy} className="goals-sheet">
    <form onSubmit={submit} noValidate style={{ display: "contents" }}>
      <div className="goals-sheet-body">{children}</div>
      {error && <p className="ui-field-error" role="alert" style={{ margin: "0 20px 8px" }}>{error}</p>}
      <footer className="file-dialog-actions">
        {danger}
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : submitLabel}</button>
      </footer>
    </form>
  </ModalDialog>;
}

/** A labelled control whose own component carries the accessible name (Select's `label`). */
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <div className="ui-field">
    <span aria-hidden="true">{label}</span>
    {children}
    {hint && <span className="ui-field-hint">{hint}</span>}
  </div>;
}

function TextField({ label, value, onChange, required, type = "text", hint, autoFocus, placeholder, step }: {
  label: string; value: string; onChange: (value: string) => void; required?: boolean; type?: string; hint?: string; autoFocus?: boolean; placeholder?: string; step?: string;
}) {
  const id = useId();
  return <div className="ui-field">
    <label htmlFor={id}>{label}</label>
    <input id={id} type={type} value={value} required={required} autoFocus={autoFocus} placeholder={placeholder} step={step} onChange={(event) => onChange(event.target.value)} maxLength={type === "text" ? 200 : undefined} />
    {hint && <span className="ui-field-hint">{hint}</span>}
  </div>;
}

const num = (value: string) => value.trim() === "" ? undefined : Number(value);

// ------------------------------------------------------------------------------------------------
// Goal editor.

type Choices = { periods: Period[]; teams: Option[]; users: Option[]; goals: GoalSummary[] };

function useChoices(): Choices | null {
  const [choices, setChoices] = useState<Choices | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      listPeriods().catch(() => ({ periods: [] as Period[] })),
      listGroups().catch(() => ({ groups: [] as Array<{ id: string; name: string }> })),
      listUsers().catch(() => ({ users: [] as Array<{ id: string; displayName: string; role?: string; kind?: string }> })),
      listGoals({ view: "tree" }).catch(() => ({ goals: [] as GoalSummary[] }))
    ]).then(([periods, groups, users, goals]) => {
      if (!live) return;
      setChoices({
        periods: periods.periods, teams: groups.groups.map((group) => ({ value: group.id, label: group.name })),
        users: users.users.filter((user) => user.kind !== "service" && user.role !== "guest").map((user) => ({ value: user.id, label: user.displayName })), goals: goals.goals
      });
    });
    return () => { live = false; };
  }, []);
  return choices;
}

export function GoalEditor({ goal, defaults, me, onClose, onSaved }: {
  /** `periodId` left out: the current period once the periods load (D1148); null: no period. */
  goal?: GoalDetail; defaults?: { periodId?: string | null; parentId?: string | null }; me: { id: string; name: string };
  onClose: () => void; onSaved: (goal: GoalDetail) => void;
}) {
  const choices = useChoices();
  const [title, setTitle] = useState(goal?.title ?? "");
  const [description, setDescription] = useState(goal?.description ?? "");
  const [kind, setKind] = useState<GoalKind>(goal?.kind ?? "objective");
  const [periodId, setPeriodIdState] = useState(goal?.period?.id ?? defaults?.periodId ?? "");
  const [periodTouched, setPeriodTouched] = useState(false);
  const setPeriodId = (next: string) => { setPeriodIdState(next); setPeriodTouched(true); };
  const wantsCurrent = !goal && defaults?.periodId === undefined;
  useEffect(() => {
    if (!wantsCurrent || periodTouched || !choices) return;
    const current = choices.periods.find((period) => period.current);
    if (current) setPeriodIdState((value) => value || current.id);
  }, [wantsCurrent, periodTouched, choices]);
  const [parentId, setParentId] = useState(goal?.parentId ?? defaults?.parentId ?? "");
  const [teamId, setTeamId] = useState(goal?.team?.id ?? "");
  const [ownerId, setOwnerId] = useState(goal?.owner.id ?? me.id);
  const [startOn, setStartOn] = useState(goal?.startOn ?? "");
  const [dueOn, setDueOn] = useState(goal?.dueOn ?? "");
  const [mode, setMode] = useState<ProgressMode>(goal?.progressMode ?? "key_results");
  const [cadence, setCadence] = useState<CheckinCadence>(goal?.cadence ?? "weekly");
  // A new goal starts from a preset; an existing goal's sharing is the Access sheet (D1050).
  const [audience, setAudience] = useState<string>("all_users:view");
  const [contributors, setContributors] = useState<PersonSummary[]>(goal?.contributors.map((person) => ({ kind: "user" as const, id: person.id, name: person.name })) ?? []);
  const [krs, setKrs] = useState<Array<{ title: string; target: string; metric: KrMetric }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = goal ? goal.canManage : true;

  const save = async () => {
    if (!title.trim()) { setError("Give the goal a title"); return; }
    setBusy(true); setError(null);
    const [visibility, shareRole] = audience.split(":") as ["private" | "all_users", "view" | "comment" | "edit" | undefined];
    const common = {
      title: title.trim(), description, kind, periodId: periodId || null, parentId: parentId || null, teamId: teamId || null, startOn: startOn || null, dueOn: dueOn || null,
      progressMode: mode, cadence, contributorIds: contributors.filter((person) => person.kind === "user").map((person) => (person as { id: string }).id)
    };
    try {
      if (goal) {
        const changedOwner = owner && ownerId !== goal.owner.id;
        onSaved((await updateGoal(goal.id, { ...common, ...(changedOwner ? { ownerId } : {}), expectedRevision: goal.revision })).goal);
      } else {
        const keyResults = krs.filter((kr) => kr.title.trim()).map((kr): KrInput => ({ title: kr.title.trim(), metric: kr.metric, ...(kr.metric === "boolean" ? {} : { targetValue: num(kr.target) ?? 100 }) }));
        onSaved((await createGoal({ ...common, ownerId, visibility, ...(shareRole ? { shareRole } : {}), keyResults })).goal);
      }
    } catch (reason) {
      setError(errorText(reason, "Could not save the goal"));
      setBusy(false);
    }
  };

  const goalOptions: Option[] = [{ value: "", label: "Not aligned (top level)" }, ...(choices?.goals ?? []).filter((item) => item.id !== goal?.id).map((item) => ({ value: item.id, label: item.title, description: item.period?.name ?? undefined }))];
  return <Sheet title={goal ? "Edit goal" : "New goal"} onClose={onClose} busy={busy} onSubmit={save} submitLabel={goal ? "Save" : "Create goal"} error={error}>
    <TextField label="Title" value={title} onChange={setTitle} required autoFocus placeholder="Grow MRR 20%" />
    <div className="ui-field">
      <label htmlFor="goal-description">Description</label>
      <textarea id="goal-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={20000} placeholder="Why it matters and what done looks like" />
    </div>
    <div className="goals-grid-2">
      <Field label="Kind"><Select label="Kind" value={kind} onChange={(value) => setKind(value as GoalKind)} options={[{ value: "objective", label: "Objective", description: "Change something by a date" }, { value: "kpi", label: "KPI", description: "Keep a number healthy, no end date" }]} /></Field>
      <Field label="Period"><Select label="Period" value={periodId} onChange={setPeriodId} options={[{ value: "", label: "No period" }, ...(choices?.periods ?? []).map((period) => ({ value: period.id, label: period.name, description: `${period.startsOn} – ${period.endsOn}` }))]} /></Field>
    </div>
    <Field label="Aligned to"><Select label="Aligned to" value={parentId} onChange={setParentId} options={goalOptions} /></Field>
    <div className="goals-grid-2">
      <Field label="Owner"><Select label="Owner" value={ownerId} disabled={!owner} onChange={setOwnerId} options={[{ value: me.id, label: `${me.name} (you)` }, ...(choices?.users ?? []).filter((user) => user.value !== me.id)]} /></Field>
      <Field label="Team"><Select label="Team" value={teamId} onChange={setTeamId} options={[{ value: "", label: "No team" }, ...(choices?.teams ?? [])]} /></Field>
    </div>
    <PersonPicker label="Contributors" value={contributors} onChange={setContributors} allow={["user"]} placeholder="Add people who work on it" />
    <div className="goals-grid-2">
      <TextField label="Start" type="date" value={startOn} onChange={setStartOn} hint="Defaults to the period" />
      <TextField label="Due" type="date" value={dueOn} onChange={setDueOn} />
    </div>
    <div className="goals-grid-2">
      <Field label="Progress from"><Select label="Progress from" value={mode} onChange={(value) => setMode(value as ProgressMode)} options={[
        { value: "key_results", label: "Key results", description: "Weighted average of its key results" },
        { value: "children", label: "Sub-goals", description: "Average of goals aligned to it" },
        { value: "manual", label: "Set by hand" }
      ]} /></Field>
      <Field label="Check-in reminders"><Select label="Check-in reminders" value={cadence} onChange={(value) => setCadence(value as CheckinCadence)} options={CHECKIN_CADENCES.map((value) => ({ value, label: CADENCE_LABEL[value] }))} /></Field>
    </div>
    {!goal && <Field label="Who can open it" hint="Later, Who has access on the goal adds people and groups"><Select label="Who can open it" value={audience} onChange={setAudience} options={[
      { value: "all_users:view", label: "Everyone signed in can view" },
      { value: "all_users:comment", label: "Everyone signed in can comment" },
      { value: "all_users:edit", label: "Everyone signed in can edit" },
      { value: "private", label: "Only the owner and contributors" }
    ]} /></Field>}
    {!goal && <fieldset className="goals-sheet-kr" style={{ margin: 0 }}>
      <legend className="goals-sheet-kr-head" style={{ padding: "0 4px" }}>Key results</legend>
      {krs.map((kr, index) => <div key={index} className="goals-inline-row">
        <TextField label={`Key result ${index + 1}`} value={kr.title} onChange={(value) => setKrs((list) => list.map((item, at) => at === index ? { ...item, title: value } : item))} placeholder="Reach 1,200 paying teams" />
        <TextField label="Target" type="number" value={kr.target} onChange={(value) => setKrs((list) => list.map((item, at) => at === index ? { ...item, target: value } : item))} />
        <button type="button" className="icon-button" aria-label={`Remove key result ${index + 1}`} onClick={() => setKrs((list) => list.filter((_, at) => at !== index))}><Trash2 /></button>
      </div>)}
      <button type="button" className="secondary-button ui-small-button" style={{ justifySelf: "start" }} onClick={() => setKrs((list) => [...list, { title: "", target: "100", metric: "number" }])}><Plus aria-hidden="true" />Add key result</button>
      <span className="ui-field-hint">Add automatic ones (from Tasks and other modules) on the goal page.</span>
    </fieldset>}
  </Sheet>;
}

// ------------------------------------------------------------------------------------------------
// Key result editor, with its progress source.

const TASK_SCOPES: Option[] = [
  { value: "board", label: "A board", description: "Cards on one board" }, { value: "view", label: "A saved view" }, { value: "filter", label: "A filter", description: "board:MYT tag:launch" },
  { value: "sprint", label: "A sprint" }, { value: "tag", label: "A tag on a board" }, { value: "epic", label: "An epic (a card's sub-cards)" }
];

type TasksConfig = { scope: string; id?: string; query?: string; measure: string };

function TasksSourceFields({ config, onChange }: { config: TasksConfig; onChange: (config: TasksConfig) => void }) {
  const [boards, setBoards] = useState<Option[]>([]);
  const [views, setViews] = useState<Option[]>([]);
  const [boardId, setBoardId] = useState("");
  const [parts, setParts] = useState<{ tags: Option[]; sprints: Option[] }>({ tags: [], sprints: [] });
  const [epicRef, setEpicRef] = useState("");
  const [epicError, setEpicError] = useState<string | null>(null);
  useEffect(() => { listBoards().then((body) => setBoards(body.boards.map((board) => ({ value: board.id, label: board.name })))).catch(() => undefined); listViews().then((list) => setViews(list.map((view) => ({ value: view.id, label: view.name })))).catch(() => undefined); }, []);
  useEffect(() => {
    if (!boardId) return;
    boardParts(boardId).then((body) => setParts({ tags: body.tags.map((tag) => ({ value: tag.id, label: tag.name })), sprints: (body.sprints ?? []).map((sprint) => ({ value: sprint.id, label: sprint.name })) })).catch(() => setParts({ tags: [], sprints: [] }));
  }, [boardId]);
  const set = (patch: Partial<TasksConfig>) => onChange({ ...config, ...patch });
  return <>
    <div className="goals-grid-2">
      <Field label="Count cards in"><Select label="Count cards in" value={config.scope} onChange={(scope) => set({ scope, id: undefined, query: undefined })} options={TASK_SCOPES} /></Field>
      <Field label="Measure"><Select label="Measure" value={config.measure} onChange={(measure) => set({ measure })} options={[{ value: "cards", label: "Done cards" }, { value: "points", label: "Points done (estimates)" }, { value: "hours", label: "Estimated hours done" }]} /></Field>
    </div>
    {config.scope === "board" && <Field label="Board"><Select label="Board" value={config.id ?? ""} onChange={(id) => set({ id })} options={boards} placeholder="Choose a board" /></Field>}
    {config.scope === "view" && <Field label="Saved view"><Select label="Saved view" value={config.id ?? ""} onChange={(id) => set({ id })} options={views} placeholder={views.length ? "Choose a view" : "No saved views"} /></Field>}
    {config.scope === "filter" && <TextField label="Filter" value={config.query ?? ""} onChange={(query) => set({ query })} placeholder="board:MYT tag:launch" hint="The same filter words as Tasks search" />}
    {(config.scope === "sprint" || config.scope === "tag") && <>
      <Field label="Board"><Select label="Board" value={boardId} onChange={setBoardId} options={boards} placeholder="Choose a board" /></Field>
      {boardId && <Field label={config.scope === "sprint" ? "Sprint" : "Tag"}><Select label={config.scope === "sprint" ? "Sprint" : "Tag"} value={config.id ?? ""} onChange={(id) => set({ id })} options={config.scope === "sprint" ? parts.sprints : parts.tags} placeholder="Choose one" /></Field>}
    </>}
    {config.scope === "epic" && <div className="ui-field">
      <TextField label="Epic card" value={epicRef} onChange={(value) => { setEpicRef(value); setEpicError(null); }} placeholder="MYT-12 or a card link" />
      <button type="button" className="secondary-button ui-small-button" style={{ justifySelf: "start" }} onClick={() => {
        resolveRef(epicRef.trim()).then((body) => { if (body.summary.kind !== "card") throw new Error("That is not a card"); set({ id: body.summary.id }); setEpicError(`Using ${body.summary.key ?? ""} ${body.summary.title}`.trim()); }, (reason) => setEpicError(errorText(reason, "No card you can open has that key")));
      }}>Use this card</button>
      {epicError && <span className="ui-field-hint" role="status">{epicError}</span>}
    </div>}
  </>;
}

export function KrEditor({ goal, kr, onClose, onSaved }: { goal: GoalDetail; kr?: KeyResult; onClose: () => void; onSaved: (message: string) => void }) {
  const [sources, setSources] = useState<SourceInfo[]>([{ kind: "manual", label: "Manual", module: "goals" }]);
  const [title, setTitle] = useState(kr?.title ?? "");
  const [metric, setMetric] = useState<KrMetric>(kr?.metric ?? "number");
  const [direction, setDirection] = useState<KrDirection>(kr?.direction ?? "increase");
  const [start, setStart] = useState(String(kr?.startValue ?? 0));
  const [target, setTarget] = useState(String(kr?.targetValue ?? 100));
  const [current, setCurrent] = useState(String(kr?.currentValue ?? 0));
  const [unit, setUnit] = useState(kr?.unit ?? "");
  const [currency, setCurrency] = useState(kr?.currency ?? "USD");
  const [weight, setWeight] = useState(String(kr?.weight ?? 1));
  const [sourceKind, setSourceKind] = useState(kr?.source.kind ?? "manual");
  const [tasks, setTasks] = useState<TasksConfig>(kr?.source.kind === "tasks" ? { ...(kr.source.config as TasksConfig), measure: (kr.source.config as TasksConfig).measure ?? "cards" } : { scope: "board", measure: "cards" });
  const [otherConfig, setOtherConfig] = useState(kr && kr.source.kind !== "manual" && kr.source.kind !== "tasks" ? JSON.stringify(kr.source.config, null, 2) : "{}");
  const [milestones, setMilestones] = useState<Array<{ id?: string; title: string; done?: boolean }>>(kr?.milestones ?? []);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { listSources().then((body) => setSources(body.sources)).catch(() => undefined); }, []);

  const sourceConfig = (): unknown => {
    if (sourceKind === "tasks") return Object.fromEntries(Object.entries(tasks).filter(([, value]) => value !== undefined && value !== ""));
    try { return JSON.parse(otherConfig); } catch { throw new Error("The source settings are not valid JSON"); }
  };
  const runPreview = async () => {
    setPreview("Counting…");
    try { const { preview: result } = await previewSource(goal.id, { kind: sourceKind, config: sourceConfig() }); setPreview(`${result.description}: ${result.detail ?? result.value}`); }
    catch (reason) { setPreview(errorText(reason, "Could not count it")); }
  };
  const save = async () => {
    if (!title.trim()) { setError("Give the key result a title"); return; }
    setBusy(true); setError(null);
    try {
      const auto = sourceKind !== "manual";
      const input: KrInput = {
        title: title.trim(), metric, direction, unit: unit.trim() || null, currency: metric === "currency" ? currency.toUpperCase() : null, weight: num(weight) ?? 1,
        ...(metric === "boolean" || metric === "milestones" ? {} : { startValue: num(start) ?? 0, targetValue: num(target) ?? 100 }),
        ...(auto || metric === "milestones" ? {} : { currentValue: metric === "boolean" ? (current === "1" ? 1 : 0) : num(current) ?? 0 }),
        source: { kind: sourceKind, ...(auto ? { config: sourceConfig() } : {}) },
        ...(metric === "milestones" ? { milestones: milestones.filter((item) => item.title.trim()) } : {})
      };
      if (kr) await updateKeyResult(kr.id, input); else await addKeyResult(goal.id, input);
      onSaved(kr ? "Key result saved" : "Key result added");
    } catch (reason) {
      setError(errorText(reason, "Could not save the key result"));
      setBusy(false);
    }
  };
  const auto = sourceKind !== "manual";
  return <Sheet title={kr ? "Edit key result" : "New key result"} eyebrow={goal.title} onClose={onClose} busy={busy} onSubmit={save} submitLabel={kr ? "Save" : "Add key result"} error={error}>
    <TextField label="Title" value={title} onChange={setTitle} required autoFocus placeholder="Close 30 new deals" />
    <div className="goals-grid-2">
      <Field label="Measured as"><Select label="Measured as" value={metric} onChange={(value) => setMetric(value as KrMetric)} options={KR_METRICS.map((value) => ({ value, label: KR_METRIC_LABEL[value] }))} /></Field>
      <Field label="Updates from"><Select label="Updates from" value={sourceKind} onChange={(value) => { setSourceKind(value); setPreview(null); }} options={sources.map((source) => ({ value: source.kind, label: source.kind === "manual" ? "Check-ins (manual)" : source.label, description: source.kind === "manual" ? undefined : "Automatic" }))} /></Field>
    </div>
    {sourceKind === "tasks" && <TasksSourceFields config={tasks} onChange={(config) => { setTasks(config); setPreview(null); }} />}
    {auto && sourceKind !== "tasks" && <div className="ui-field">
      <label htmlFor="kr-source-config">Source settings (JSON)</label>
      <textarea id="kr-source-config" value={otherConfig} onChange={(event) => setOtherConfig(event.target.value)} spellCheck={false} />
      <span className="ui-field-hint">This source comes from another module; its settings are described in its help.</span>
    </div>}
    {auto && <div style={{ display: "grid", gap: 6 }}>
      <button type="button" className="secondary-button ui-small-button" style={{ justifySelf: "start" }} onClick={() => { void runPreview(); }}>Preview</button>
      {preview && <p className="goals-preview" role="status">{preview}</p>}
      <span className="ui-field-hint">It counts only what the key result's owner can open, and updates within minutes of a change.</span>
    </div>}
    {metric !== "boolean" && metric !== "milestones" && <>
      <Field label="Direction"><Select label="Direction" value={direction} onChange={(value) => setDirection(value as KrDirection)} options={KR_DIRECTIONS.map((value) => ({ value, label: KR_DIRECTION_LABEL[value] }))} /></Field>
      <div className="goals-grid-3">
        <TextField label="Start" type="number" step="any" value={start} onChange={setStart} />
        <TextField label={auto && sourceKind === "tasks" ? "Target (from the source)" : "Target"} type="number" step="any" value={target} onChange={setTarget} />
        {!auto && <TextField label="Current" type="number" step="any" value={current} onChange={setCurrent} />}
      </div>
      <div className="goals-grid-2">
        {metric === "currency" ? <TextField label="Currency" value={currency} onChange={(value) => setCurrency(value.slice(0, 3))} /> : <TextField label="Unit" value={unit} onChange={setUnit} placeholder="deals, users, ms" />}
        <TextField label="Weight" type="number" step="any" value={weight} onChange={setWeight} hint="How much it counts toward the goal" />
      </div>
    </>}
    {metric === "boolean" && !auto && <label className="goals-sheet-kr-head" style={{ justifyContent: "flex-start" }}><input type="checkbox" checked={current === "1"} onChange={(event) => setCurrent(event.target.checked ? "1" : "0")} />Done</label>}
    {metric === "milestones" && <fieldset className="goals-sheet-kr" style={{ margin: 0 }}>
      <legend className="goals-sheet-kr-head" style={{ padding: "0 4px" }}>Milestones</legend>
      {milestones.map((milestone, index) => <div key={milestone.id ?? index} className="goals-inline-row" style={{ gridTemplateColumns: "auto minmax(0,1fr) auto", alignItems: "center" }}>
        <input type="checkbox" aria-label={`Milestone ${index + 1} done`} checked={!!milestone.done} onChange={(event) => { const checked = event.target.checked; setMilestones((list) => list.map((item, at) => at === index ? { ...item, done: checked } : item)); }} />
        <input aria-label={`Milestone ${index + 1}`} className="goals-milestone-input" value={milestone.title} maxLength={200} onChange={(event) => { const title = event.target.value; setMilestones((list) => list.map((item, at) => at === index ? { ...item, title } : item)); }} style={{ minHeight: 36, border: "1px solid var(--field-border)", borderRadius: "var(--field-radius)", background: "var(--field-bg)", color: "#ededee", padding: "0 10px" }} />
        <button type="button" className="icon-button" aria-label={`Remove milestone ${index + 1}`} onClick={() => setMilestones((list) => list.filter((_, at) => at !== index))}><Trash2 /></button>
      </div>)}
      <button type="button" className="secondary-button ui-small-button" style={{ justifySelf: "start" }} onClick={() => setMilestones((list) => [...list, { title: "" }])}><Plus aria-hidden="true" />Add milestone</button>
    </fieldset>}
  </Sheet>;
}

// ------------------------------------------------------------------------------------------------
// Check in.

const HEALTH_CHOICES: GoalHealth[] = ["on_track", "at_risk", "off_track"];

export function CheckInSheet({ goal, onClose, onSaved }: { goal: GoalDetail; onClose: () => void; onSaved: (goal: GoalDetail) => void }) {
  const [health, setHealth] = useState<GoalHealth>(goal.health !== "none" ? goal.health : goal.suggestedHealth !== "none" ? goal.suggestedHealth : "on_track");
  const [confidence, setConfidence] = useState(goal.lastCheckin?.confidence ?? 7);
  const [note, setNote] = useState("");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(goal.keyResults.map((kr) => [kr.id, String(kr.currentValue)])));
  const [done, setDone] = useState<Record<string, string[]>>(() => Object.fromEntries(goal.keyResults.filter((kr) => kr.metric === "milestones").map((kr) => [kr.id, kr.milestones.filter((item) => item.done).map((item) => item.id)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    const typed: Record<string, number> = {};
    for (const kr of goal.keyResults) {
      if (kr.source.kind !== "manual" || kr.metric === "milestones") continue;
      const value = Number(values[kr.id]);
      if (values[kr.id]?.trim() === "" || !Number.isFinite(value)) { setError(`Enter a number for ${kr.title}`); setBusy(false); return; }
      if (value !== kr.currentValue) typed[kr.id] = value;
    }
    try {
      const result = await checkIn(goal.id, { health, confidence, note: note.trim(), values: typed, milestonesDone: done });
      onSaved(result.goal);
    } catch (reason) {
      setError(errorText(reason, "Could not save the check-in"));
      setBusy(false);
    }
  };
  return <Sheet title="Check in" eyebrow={goal.title} onClose={onClose} busy={busy} onSubmit={save} submitLabel="Check in" error={error}>
    {goal.keyResults.length === 0 && <p className="goals-note">This goal has no key results; record its health and a note.</p>}
    {goal.keyResults.map((kr) => <div key={kr.id} className="goals-sheet-kr">
      <div className="goals-sheet-kr-head"><span>{kr.title}</span><span className="goals-note">{kr.metric === "milestones" ? `${kr.milestones.filter((item) => item.done).length} of ${kr.milestones.length}` : `target ${formatKrValue(kr.targetValue, kr)}`}</span></div>
      {kr.source.kind !== "manual"
        ? <span className="goals-note">Updates itself · now {formatKrValue(kr.currentValue, kr)} ({kr.source.description})</span>
        : kr.metric === "boolean"
          ? <label style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={values[kr.id] === "1"} onChange={(event) => { const value = event.target.checked ? "1" : "0"; setValues((current) => ({ ...current, [kr.id]: value })); }} />Done</label>
          : kr.metric === "milestones"
            ? <ul className="goals-milestones">{kr.milestones.map((milestone) => <li key={milestone.id}><label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={done[kr.id]?.includes(milestone.id) ?? false} onChange={(event) => { const checked = event.target.checked; setDone((current) => ({ ...current, [kr.id]: checked ? [...(current[kr.id] ?? []), milestone.id] : (current[kr.id] ?? []).filter((id) => id !== milestone.id) })); }} />{milestone.title}</label></li>)}</ul>
            : <TextField label={`New value${kr.unit ? ` (${kr.unit})` : kr.metric === "percent" ? " (%)" : kr.metric === "currency" ? ` (${kr.currency})` : ""}`} type="number" step="any" value={values[kr.id] ?? ""} onChange={(value) => setValues((current) => ({ ...current, [kr.id]: value }))} />}
    </div>)}
    <div className="ui-field">
      <span id="checkin-health">Health</span>
      <div className="ui-segmented" role="group" aria-labelledby="checkin-health">
        {HEALTH_CHOICES.map((value) => <button key={value} type="button" aria-pressed={health === value} onClick={() => setHealth(value)}>{HEALTH_LABEL[value]}</button>)}
      </div>
      {goal.suggestedHealth !== "none" && <span className="ui-field-hint">Suggested from progress against time: {HEALTH_LABEL[goal.suggestedHealth]}</span>}
    </div>
    <div className="ui-field">
      <label htmlFor="checkin-confidence">Confidence it will be met</label>
      <div className="goals-confidence"><input id="checkin-confidence" type="range" min={1} max={10} value={confidence} onChange={(event) => setConfidence(Number(event.target.value))} /><output htmlFor="checkin-confidence">{confidence}/10</output></div>
    </div>
    <div className="ui-field">
      <label htmlFor="checkin-note">Note</label>
      <MentionTextarea id="checkin-note" value={note} onValueChange={setNote} target={{ kind: "goal", id: goal.id }} noun="goal" maxLength={10000} placeholder="What moved, what's in the way, what's next. @ to mention someone" />
    </div>
  </Sheet>;
}

// ------------------------------------------------------------------------------------------------
// Close a goal.

export function CloseSheet({ goal, onClose, onSaved }: { goal: GoalDetail; onClose: () => void; onSaved: (message: string, goal: GoalDetail) => void }) {
  const [state, setState] = useState<"achieved" | "missed" | "dropped" | "carried_over">(goal.progress >= 0.7 ? "achieved" : "missed");
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { listPeriods().then((body) => setPeriods(body.periods.filter((period) => period.id !== goal.period?.id))).catch(() => undefined); }, [goal.period?.id]);
  const save = async () => {
    if (state === "carried_over" && !periodId) { setError("Choose the period to carry it over to"); return; }
    setBusy(true); setError(null);
    try {
      const result = await closeGoal(goal.id, { state, carryOver: state === "carried_over" ? { periodId } : null });
      onSaved(result.carriedOver ? `Closed; a copy continues in ${result.carriedOver.period?.name ?? "the next period"}` : "Goal closed", result.goal);
    } catch (reason) { setError(errorText(reason, "Could not close the goal")); setBusy(false); }
  };
  return <Sheet title="Close goal" eyebrow={goal.title} onClose={onClose} busy={busy} onSubmit={save} submitLabel="Close goal" error={error}>
    <p className="goals-note">Its final progress ({Math.round(goal.progress * 100)}%) is kept and it stops asking for check-ins.</p>
    <Field label="Outcome"><Select label="Outcome" value={state} onChange={(value) => setState(value as typeof state)} options={[
      { value: "achieved", label: "Achieved" }, { value: "missed", label: "Missed" }, { value: "dropped", label: "Dropped", description: "No longer pursued" },
      { value: "carried_over", label: "Carry over", description: "Continue it in another period" }
    ]} /></Field>
    {state === "carried_over" && <Field label="Continue in"><Select label="Continue in" value={periodId} onChange={setPeriodId} options={periods.map((period) => ({ value: period.id, label: period.name }))} placeholder="Choose a period" /></Field>}
  </Sheet>;
}

// ------------------------------------------------------------------------------------------------
// Periods.

function nextQuarters(count: number, now = new Date()) {
  const quarters: Array<{ name: string; startsOn: string; endsOn: string }> = [];
  let year = now.getUTCFullYear();
  let quarter = Math.floor(now.getUTCMonth() / 3);
  for (let index = 0; index < count; index += 1) {
    const start = new Date(Date.UTC(year, quarter * 3, 1));
    const end = new Date(Date.UTC(year, quarter * 3 + 3, 0));
    quarters.push({ name: `Q${quarter + 1} ${year}`, startsOn: start.toISOString().slice(0, 10), endsOn: end.toISOString().slice(0, 10) });
    quarter += 1;
    if (quarter === 4) { quarter = 0; year += 1; }
  }
  return quarters;
}

/**
 * D1264: the quarter "Add period" suggests: the first from this one on whose name no period has yet
 * (case aside), so adding twice in a row moves on instead of offering a twin. Null after two years.
 */
export function nextPeriodSuggestion(periods: ReadonlyArray<{ name: string }>, now = new Date()) {
  const taken = new Set(periods.map((period) => period.name.trim().toLowerCase()));
  return nextQuarters(8, now).find((quarter) => !taken.has(quarter.name.toLowerCase())) ?? null;
}

export function PeriodsSheet({ onClose, onChanged, canWrite }: { onClose: () => void; onChanged: (message: string) => void; canWrite: boolean }) {
  const [periods, setPeriods] = useState<Period[] | null>(null);
  const first = useMemo(() => nextQuarters(1)[0]!, []);
  const [name, setName] = useState(first.name);
  const [startsOn, setStartsOn] = useState(first.startsOn);
  const [endsOn, setEndsOn] = useState(first.endsOn);
  const [closing, setClosing] = useState<Period | null>(null);
  const [carryTo, setCarryTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => listPeriods(true).then((body) => setPeriods(body.periods), (reason) => setError(errorText(reason, "Could not load periods")));
  useEffect(() => { void load(); }, []);
  // D1264: once the list is in (first load, or after an add), a name it already has moves on to the next free quarter.
  useEffect(() => {
    if (!periods || !periods.some((period) => period.name.trim().toLowerCase() === name.trim().toLowerCase())) return;
    const next = nextPeriodSuggestion(periods);
    if (next) { setName(next.name); setStartsOn(next.startsOn); setEndsOn(next.endsOn); }
    // Only a new list re-suggests; typing a name never jumps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods]);
  const run = async (operation: () => Promise<string>) => {
    setBusy(true); setError(null);
    try { onChanged(await operation()); await load(); } catch (reason) { setError(errorText(reason, "Could not save")); } finally { setBusy(false); }
  };
  const add = () => run(async () => { await createPeriod({ name: name.trim(), startsOn, endsOn }); return `${name.trim()} added`; });
  return <Sheet title="Periods" onClose={onClose} busy={busy} onSubmit={canWrite ? add : onClose} submitLabel={canWrite ? "Add period" : "Done"} error={error}>
    {periods === null ? <p className="goals-note" role="status">Loading periods…</p> : periods.length === 0 ? <p className="goals-note">No periods yet. Quarters work well: add one below.</p> :
      <ul className="goals-periods">{periods.map((period) => <li key={period.id}>
        <span><strong>{period.name}</strong> <small>{period.startsOn} – {period.endsOn} · {period.goalCount} goal{period.goalCount === 1 ? "" : "s"}{period.current ? " · current" : ""}{period.archived ? " · closed" : ""}</small></span>
        {period.canEdit && !period.archived && <button type="button" className="secondary-button ui-small-button" onClick={() => { setClosing(period); setCarryTo(""); }}>Close…</button>}
        {period.canEdit && period.archived && <button type="button" className="secondary-button ui-small-button" onClick={() => { void run(async () => { await updatePeriod(period.id, { archived: false }); return `${period.name} reopened`; }); }}>Reopen</button>}
        {period.canEdit && <button type="button" className="icon-button" aria-label={`Delete ${period.name}`} title="Delete period (goals keep their dates)" onClick={() => { void run(async () => { await deletePeriod(period.id); return `${period.name} deleted`; }); }}><Trash2 /></button>}
      </li>)}</ul>}
    {closing && <div className="goals-sheet-kr">
      <div className="goals-sheet-kr-head">Close {closing.name}</div>
      <span className="goals-note">Open goals you can edit close as achieved at 70% or more; the rest are carried over (if you choose a period) or missed.</span>
      <Field label="Carry unfinished goals to"><Select label="Carry unfinished goals to" value={carryTo} onChange={setCarryTo} options={[{ value: "", label: "Don't carry over (mark missed)" }, ...(periods ?? []).filter((period) => period.id !== closing.id && !period.archived).map((period) => ({ value: period.id, label: period.name }))]} /></Field>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="primary-button" disabled={busy} onClick={() => { void run(async () => { const { closed } = await closePeriod(closing.id, carryTo || null); setClosing(null); return `${closing.name} closed: ${closed.achieved} achieved, ${closed.carried_over} carried over, ${closed.missed} missed`; }); }}>Close period</button>
        <button type="button" className="secondary-button" onClick={() => setClosing(null)}>Cancel</button>
      </div>
    </div>}
    {canWrite && <fieldset className="goals-sheet-kr" style={{ margin: 0 }}>
      <legend className="goals-sheet-kr-head" style={{ padding: "0 4px" }}>New period</legend>
      <TextField label="Name" value={name} onChange={setName} />
      <div className="goals-grid-2">
        <TextField label="Starts" type="date" value={startsOn} onChange={setStartsOn} />
        <TextField label="Ends" type="date" value={endsOn} onChange={setEndsOn} />
      </div>
    </fieldset>}
  </Sheet>;
}

export const MilestoneIcon = ({ done }: { done: boolean }) => done ? <CheckSquare aria-hidden="true" /> : <Square aria-hidden="true" />;
