import { useId, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { MentionTextarea } from "../mentions/MentionTextarea";
import type { MentionTarget } from "../mentions/mentionsApi";
import { ArrowDown, ArrowUp, Heart, Star } from "lucide-react";
import { Select } from "../Select";
import { YES_NO_OPTIONS, type AnswerValue, type ContactAnswer, type MultiChoiceAnswer, type Question, type QuestionOption, type SlotVote } from "../../../shared/questions";

/**
 * One question's answer control, for every type in QUESTION_TYPES (§B.2). Controlled: `value` is the
 * answer as shared/questions types it (absent = unanswered), `onChange(undefined)` clears it. Choice
 * keys: 1–9 pick the nth option (`onPickKey`, the renderer wires it in stepper mode); scales are radio
 * groups (arrows move, as native radios do). Members-only types (file, person, card) come from the
 * host through `memberField`; without one they say they are not available here.
 */
export type QuestionInputProps = {
  question: Question;
  value: AnswerValue | undefined;
  onChange: (value: AnswerValue | undefined) => void;
  /** Ids for the label and help (the field's accessible name and description). */
  labelId: string;
  describedBy?: string;
  invalid?: boolean;
  disabled?: boolean;
  /** Renders file, person, and card questions (members only; never on public pages, T516). */
  memberField?: (question: Question, value: AnswerValue | undefined, onChange: (value: AnswerValue | undefined) => void) => ReactNode;
  /** The respondent's time zone, for time slots (public pages pass the browser's). */
  timeZone?: string;
  /**
   * Long text answers to a members-only host (a standup round) can @mention the people who can read it
   * (docs/plan/MENTIONS.md, phase B). Never on public pages.
   */
  mentionTarget?: MentionTarget | null;
  mentionNoun?: string;
};

export const optionsOf = (question: Question): readonly QuestionOption[] => question.type === "yes_no" ? YES_NO_OPTIONS : question.options ?? [];

const SCALE_FACES = ["😞", "🙁", "😐", "🙂", "😄"];

/** The numbers a rating or scale offers. */
export function scaleValues(question: Question): number[] {
  if (question.type === "nps") return Array.from({ length: 11 }, (_, index) => index);
  const min = question.scale?.min ?? 1;
  const max = Math.min(10, Math.max(min + 1, question.scale?.max ?? 5));
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

/** Toggles one option in a multi-choice answer, honoring `maxSelect`. Pure. */
export function toggleMulti(question: Question, value: AnswerValue | undefined, optionId: string): MultiChoiceAnswer | undefined {
  const current = (value && typeof value === "object" && !Array.isArray(value) && "options" in value ? value as MultiChoiceAnswer : { options: [] });
  const has = current.options.includes(optionId);
  if (!has && question.maxSelect && current.options.length >= question.maxSelect) return current;
  const options = has ? current.options.filter((id) => id !== optionId) : [...current.options, optionId];
  const next: MultiChoiceAnswer = { options, ...(current.other !== undefined ? { other: current.other } : {}) };
  return next.options.length || next.other ? next : undefined;
}

function ChoiceList({ question, value, onChange, labelId, describedBy, disabled }: QuestionInputProps) {
  const name = useId();
  const options = optionsOf(question);
  const other = value && typeof value === "object" && "other" in value && !("options" in value) ? (value as { other: string }).other : null;
  return <div className="ui-q-choices" role="radiogroup" aria-labelledby={labelId} aria-describedby={describedBy}>
    {options.map((option, index) => <label key={option.id} className="ui-q-choice">
      <input type="radio" name={name} value={option.id} checked={value === option.id} disabled={disabled} onChange={() => onChange(option.id)} />
      {index < 9 && <kbd aria-hidden="true">{index + 1}</kbd>}<span>{option.label}</span>
    </label>)}
    {question.allowOther && <label className="ui-q-choice ui-q-other">
      <input type="radio" name={name} checked={other !== null} disabled={disabled} onChange={() => onChange({ other: other ?? "" })} />
      <span>Other</span>
      <input type="text" aria-label="Other answer" value={other ?? ""} maxLength={200} disabled={disabled} placeholder="Type your answer" onFocus={() => { if (other === null) onChange({ other: "" }); }} onChange={(event) => onChange({ other: event.target.value })} />
    </label>}
  </div>;
}

function MultiList({ question, value, onChange, labelId, describedBy, disabled }: QuestionInputProps) {
  const current = value && typeof value === "object" && "options" in value ? value as MultiChoiceAnswer : null;
  const chosen = new Set(current?.options ?? []);
  const atMax = Boolean(question.maxSelect && chosen.size >= question.maxSelect);
  return <div className="ui-q-choices" role="group" aria-labelledby={labelId} aria-describedby={describedBy}>
    {optionsOf(question).map((option, index) => <label key={option.id} className="ui-q-choice">
      <input type="checkbox" checked={chosen.has(option.id)} disabled={disabled || (atMax && !chosen.has(option.id))} onChange={() => onChange(toggleMulti(question, value, option.id))} />
      {index < 9 && <kbd aria-hidden="true">{index + 1}</kbd>}<span>{option.label}</span>
    </label>)}
    {question.allowOther && <label className="ui-q-choice ui-q-other">
      <input type="checkbox" checked={current?.other !== undefined} disabled={disabled} onChange={(event) => {
        const next: MultiChoiceAnswer = { options: current?.options ?? [], ...(event.target.checked ? { other: "" } : {}) };
        onChange(next.options.length || next.other !== undefined ? next : undefined);
      }} />
      <span>Other</span>
      <input type="text" aria-label="Other answer" value={current?.other ?? ""} maxLength={200} disabled={disabled} placeholder="Type your answer" onChange={(event) => onChange({ options: current?.options ?? [], other: event.target.value })} />
    </label>}
    {(question.minSelect || question.maxSelect) && <small className="ui-q-note">{question.minSelect && question.maxSelect ? `Choose ${question.minSelect} to ${question.maxSelect}` : question.maxSelect ? `Choose up to ${question.maxSelect}` : `Choose at least ${question.minSelect}`}</small>}
  </div>;
}

function Ranking({ question, value, onChange, labelId, describedBy, disabled }: QuestionInputProps) {
  const options = optionsOf(question);
  const order = Array.isArray(value) && value.length === options.length ? value as string[] : options.map((option) => option.id);
  const move = (index: number, by: number) => {
    const next = [...order];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    onChange(next);
  };
  const label = (id: string) => options.find((option) => option.id === id)?.label ?? id;
  return <ol className="ui-q-ranking" aria-labelledby={labelId} aria-describedby={describedBy}>
    {order.map((id, index) => <li key={id}>
      <span className="ui-q-rank ui-tabular">{index + 1}</span><span className="ui-q-rank-label">{label(id)}</span>
      <button type="button" className="icon-button" disabled={disabled || index === 0} onClick={() => move(index, -1)} aria-label={`Move ${label(id)} up`}><ArrowUp /></button>
      <button type="button" className="icon-button" disabled={disabled || index === order.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${label(id)} down`}><ArrowDown /></button>
    </li>)}
  </ol>;
}

function Scale({ question, value, onChange, labelId, describedBy, disabled }: QuestionInputProps) {
  const name = useId();
  const values = scaleValues(question);
  const icon = question.type === "rating" ? question.scale?.icon ?? "star" : "number";
  const chosen = typeof value === "number" ? value : null;
  const minLabel = question.type === "nps" ? question.scale?.minLabel ?? "Not likely" : question.scale?.minLabel;
  const maxLabel = question.type === "nps" ? question.scale?.maxLabel ?? "Very likely" : question.scale?.maxLabel;
  return <div className={`ui-q-scale${question.type === "nps" ? " nps" : ""}${icon !== "number" ? " icons" : ""}`}>
    <div className="ui-q-scale-row" role="radiogroup" aria-labelledby={labelId} aria-describedby={describedBy}>
      {values.map((number, index) => {
        const filled = chosen !== null && (icon === "star" || icon === "heart") ? number <= chosen : number === chosen;
        const face = icon === "emoji" ? SCALE_FACES[Math.round((index / Math.max(1, values.length - 1)) * (SCALE_FACES.length - 1))] : null;
        return <label key={number} className={`ui-q-scale-option${filled ? " filled" : ""}${number === chosen ? " chosen" : ""}`}>
          <input type="radio" name={name} value={number} checked={number === chosen} disabled={disabled} onChange={() => onChange(number)} />
          <span aria-hidden="true">{icon === "star" ? <Star /> : icon === "heart" ? <Heart /> : face ?? number}</span>
          <span className="ui-visually-hidden">{icon === "number" ? number : `${number} of ${values[values.length - 1]}`}</span>
        </label>;
      })}
    </div>
    {(minLabel || maxLabel) && <div className="ui-q-scale-labels" aria-hidden="true"><span>{minLabel}</span><span>{maxLabel}</span></div>}
  </div>;
}

function Matrix({ question, value, onChange, labelId, disabled }: QuestionInputProps) {
  const base = useId();
  const grid = question.matrix ?? { rows: [], columns: [] };
  const answer = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string | string[]> : {};
  const set = (rowId: string, columnId: string, on: boolean) => {
    const next = { ...answer };
    if (grid.multiple) {
      const list = new Set(Array.isArray(next[rowId]) ? next[rowId] as string[] : []);
      if (on) list.add(columnId); else list.delete(columnId);
      if (list.size) next[rowId] = [...list]; else delete next[rowId];
    } else next[rowId] = columnId;
    onChange(Object.keys(next).length ? next : undefined);
  };
  return <div className="ui-q-matrix-wrap"><table className="ui-q-matrix" aria-labelledby={labelId}>
    <thead><tr><td />{grid.columns.map((column) => <th key={column.id} scope="col">{column.label}</th>)}</tr></thead>
    <tbody>{grid.rows.map((row) => <tr key={row.id}>
      <th scope="row" id={`${base}-${row.id}`}>{row.label}</th>
      {grid.columns.map((column) => {
        const on = grid.multiple ? Array.isArray(answer[row.id]) && (answer[row.id] as string[]).includes(column.id) : answer[row.id] === column.id;
        return <td key={column.id}><input type={grid.multiple ? "checkbox" : "radio"} name={`${base}-${row.id}`} checked={on} disabled={disabled} aria-label={`${row.label}: ${column.label}`} onChange={(event) => set(row.id, column.id, grid.multiple ? event.target.checked : true)} /></td>;
      })}
    </tr>)}</tbody>
  </table></div>;
}

function TimeSlots({ question, value, onChange, labelId, disabled, timeZone }: QuestionInputProps) {
  const answer = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, SlotVote> : {};
  const format = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone });
  const end = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZone });
  const votes: SlotVote[] = question.allowMaybe ? ["yes", "maybe", "no"] : ["yes", "no"];
  const words: Record<SlotVote, string> = { yes: "Yes", maybe: "If needed", no: "No" };
  return <ul className="ui-q-slots" aria-labelledby={labelId}>
    {(question.slots ?? []).map((slot) => {
      const label = `${format.format(Date.parse(slot.start))} – ${end.format(Date.parse(slot.end))}`;
      return <li key={slot.id}>
        <span className="ui-q-slot-time ui-tabular">{label}</span>
        <span className="ui-segmented" role="group" aria-label={label}>
          {votes.map((vote) => <button key={vote} type="button" disabled={disabled} aria-pressed={answer[slot.id] === vote} data-vote={vote}
            onClick={() => { const next = { ...answer }; if (next[slot.id] === vote) delete next[slot.id]; else next[slot.id] = vote; onChange(Object.keys(next).length ? next : undefined); }}>{words[vote]}</button>)}
        </span>
      </li>;
    })}
  </ul>;
}

function ContactFields({ value, onChange, labelId, disabled }: QuestionInputProps) {
  const id = useId();
  const answer = (value && typeof value === "object" && "name" in value ? value : { name: "" }) as ContactAnswer;
  const set = (patch: Partial<ContactAnswer>) => {
    const next = { ...answer, ...patch };
    onChange(next.name || next.email || next.phone || next.company ? next : undefined);
  };
  const field = (key: keyof ContactAnswer, label: string, type: string, autoComplete: string) => <label className="ui-q-sub" htmlFor={`${id}-${key}`}>
    <span>{label}</span><input id={`${id}-${key}`} type={type} autoComplete={autoComplete} value={answer[key] ?? ""} disabled={disabled} maxLength={key === "email" ? 254 : 120} onChange={(event) => set({ [key]: event.target.value })} />
  </label>;
  return <div className="ui-q-contact" role="group" aria-labelledby={labelId}>
    {field("name", "Name", "text", "name")}{field("email", "Email", "email", "email")}{field("phone", "Phone", "tel", "tel")}{field("company", "Company", "text", "organization")}
  </div>;
}

/** Number keys 1–9 pick an option of a choice question (stepper mode). Returns true when handled. */
export function pickByKey(question: Question, value: AnswerValue | undefined, key: string, onChange: (value: AnswerValue | undefined) => void): boolean {
  const number = Number(key);
  if (!Number.isInteger(number) || number < 1 || number > 9) return false;
  const option = optionsOf(question)[number - 1];
  if (question.type === "single_choice" || question.type === "yes_no" || question.type === "dropdown") { if (!option) return false; onChange(option.id); return true; }
  if (question.type === "multi_choice") { if (!option) return false; onChange(toggleMulti(question, value, option.id)); return true; }
  if (question.type === "rating" || question.type === "scale") { const values = scaleValues(question); if (!values.includes(number)) return false; onChange(number); return true; }
  return false;
}

export function QuestionInput(props: QuestionInputProps) {
  const { question, value, onChange, labelId, describedBy, invalid, disabled, memberField } = props;
  const text = typeof value === "string" ? value : "";
  const common = { "aria-labelledby": labelId, "aria-describedby": describedBy, "aria-invalid": invalid || undefined, disabled };
  const setText = (next: string) => onChange(next === "" ? undefined : next);
  const stopEnter = (event: ReactKeyboardEvent) => { if (event.key === "Enter" && event.shiftKey) event.stopPropagation(); };
  switch (question.type) {
    case "statement": case "hidden": return null;
    case "short_text": return <input className="ui-q-text" type="text" value={text} maxLength={question.validation?.maxLength ?? 500} onChange={(event) => setText(event.target.value)} {...common} />;
    case "long_text": return props.mentionTarget
      ? <MentionTextarea className="ui-q-text" target={props.mentionTarget} noun={props.mentionNoun} value={text} rows={4} maxLength={question.validation?.maxLength ?? 10_000} onKeyDown={stopEnter} onValueChange={setText} {...common} />
      : <textarea className="ui-q-text" value={text} rows={4} maxLength={question.validation?.maxLength ?? 10_000} onKeyDown={stopEnter} onChange={(event) => setText(event.target.value)} {...common} />;
    case "email": return <input className="ui-q-text" type="email" autoComplete="email" value={text} maxLength={254} onChange={(event) => setText(event.target.value)} {...common} />;
    case "phone": return <input className="ui-q-text" type="tel" autoComplete="tel" value={text} maxLength={40} onChange={(event) => setText(event.target.value)} {...common} />;
    case "url": return <input className="ui-q-text" type="url" inputMode="url" value={text} maxLength={2048} placeholder="https://" onChange={(event) => setText(event.target.value)} {...common} />;
    case "number": return <input className="ui-q-text ui-q-number" type="number" inputMode="decimal" value={typeof value === "number" ? value : ""} min={question.validation?.min} max={question.validation?.max} step={question.validation?.step ?? "any"}
      onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))} {...common} />;
    case "date": return <input className="ui-q-text ui-q-date" type="date" value={text} onChange={(event) => setText(event.target.value)} {...common} />;
    case "time": return <input className="ui-q-text ui-q-date" type="time" value={text} onChange={(event) => setText(event.target.value)} {...common} />;
    case "datetime": {
      // Shown in the respondent's local time; stored as an ISO instant.
      const local = typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";
      return <input className="ui-q-text ui-q-date" type="datetime-local" value={local} onChange={(event) => onChange(event.target.value ? new Date(event.target.value).toISOString() : undefined)} {...common} />;
    }
    case "single_choice": case "yes_no": return <ChoiceList {...props} />;
    case "dropdown": return <Select labelledBy={labelId} value={typeof value === "string" ? value : null} disabled={disabled} placeholder="Choose…" options={optionsOf(question).map((option) => ({ value: option.id, label: option.label }))} onChange={(next) => onChange(next)} />;
    case "multi_choice": return <MultiList {...props} />;
    case "ranking": return <Ranking {...props} />;
    case "rating": case "scale": case "nps": return <Scale {...props} />;
    case "matrix": return <Matrix {...props} />;
    case "time_slots": return <TimeSlots {...props} />;
    case "contact": return <ContactFields {...props} />;
    case "file": case "person": case "card":
      return memberField ? <>{memberField(question, value, onChange)}</> : <p className="ui-q-note">This question can only be answered inside the workspace.</p>;
  }
}
