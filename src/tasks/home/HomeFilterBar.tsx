import { useEffect, useRef, useState } from "react";
import { Check, ListFilter, Search, X } from "lucide-react";
import { format, parse, TASK_FLAGS, type FilterKey, type FilterTerm, type TaskQuery } from "../../../shared/taskQuery";
import { useModuleEnabled } from "../../modules";
import { Combobox } from "../../ui/Combobox";
import { Select } from "../../ui/Select";
import { dueValueLabel, FLAG_LABELS, flagLabel, HAS_LABELS } from "../boardQuery";
import { priorityLabel, TASK_PRIORITIES } from "../priority";
import { TEXT_DEBOUNCE_MS } from "../FilterBar";
import { committableDueDate } from "../taskActions";
import { STATE_LABELS, type RefNames } from "./homeResults";

/**
 * The cross-board fields (§10.3): `column:` needs one board, so it is not offered here. `sprint:`,
 * `level:`, and `parent:` (17A, 17B) offer only their board-independent values (`current`, `next`,
 * `none`, `work`, level numbers); a sprint or parent id from a link or a saved view shows as a chip.
 */
type HomeField = "board" | "state" | "assignee" | "tag" | "priority" | "flag" | "due" | "sprint" | "parent" | "level" | "has";
const FIELD_LABELS: Record<HomeField, string> = { board: "Board", state: "State", assignee: "Assignee", tag: "Tag", priority: "Priority", flag: "Flag", due: "Due", sprint: "Sprint", parent: "Parent", level: "Level", has: "Relations" };
const FIELD_ORDER: HomeField[] = ["board", "state", "assignee", "tag", "priority", "flag", "due", "sprint", "parent", "level", "has"];
const SPRINT_LABELS: Record<string, string> = { current: "Current sprint", next: "Next sprint", none: "Backlog" };
const LEVEL_LABELS: Record<string, string> = { work: "Work level", 0: "Top level", 1: "Second level", 2: "Third level" };

export type HomeFilterOptions = {
  boards: Array<{ id: string; name: string }>;
  users: Array<{ id: string; displayName: string }>;
  /** Tag names seen on the loaded cards; tags match by name across boards. */
  tagNames: string[];
};

type HomeFilterBarProps = {
  filter: TaskQuery;
  /** `push` when a filter is added or removed (§9.5); value edits and typing replace the entry. */
  onChange: (filter: TaskQuery, options: { push: boolean }) => void;
  names: RefNames;
  options: HomeFilterOptions;
  /** Keys shown but not editable here (My work's `assignee:me`, and its state chips). */
  lockedKeys?: readonly FilterKey[];
  hiddenKeys?: readonly FilterKey[];
  /** A shared view for a recipient: chips only (§10.2, Q13). */
  readOnly?: boolean;
  shown?: string;
};

const DUE_PHRASES: Record<string, string> = { overdue: "Overdue", today: "Due today", week: "Due in the next 7 days", "next-week": "Due in the 7 days after", none: "No due date" };
const HAS_PHRASES: Record<string, [string, string]> = { relation: ["Has relations", "No relations"], blocked: ["Blocked by a card", "Not blocked by a card"], subtasks: ["Has subtasks", "No subtasks"] };

/** A term value in words, resolved for this viewer (restricted ids are never named, T116). */
export function homeValueLabel(key: string, value: string, names: RefNames) {
  switch (key) {
    case "board": return names.board(value);
    case "column": return names.column(value);
    case "state": return STATE_LABELS[value as keyof typeof STATE_LABELS] ?? value;
    case "assignee": case "creator": return names.user(value);
    case "tag": return names.tag(value);
    case "flag": return flagLabel(value);
    case "priority": return priorityLabel(value);
    case "due": return dueValueLabel(value);
    case "has": return HAS_LABELS[value] ?? value;
    // Ids are never named across boards (T116): a sprint or parent id reads generically.
    case "sprint": return SPRINT_LABELS[value] ?? "a sprint";
    case "parent": return value === "none" ? "No parent" : "a parent card";
    case "level": return LEVEL_LABELS[value] ?? value;
    default: return value;
  }
}

/** A chip's words: "Board is Web app, Restricted board", "State is not Done", "Text contains “x”". */
export function homeChipLabel(term: FilterTerm, names: RefNames) {
  if (term.key === "text") return `Text ${term.negate ? "does not contain" : "contains"} “${term.values[0] ?? ""}”`;
  if (term.key === "has") return term.values.map((value) => HAS_PHRASES[value]?.[term.negate ? 1 : 0] ?? value).join(" or ");
  if (term.key === "due") {
    const phrases = term.values.map((value) => DUE_PHRASES[value] ?? `Due ${dueValueLabel(value)}`).join(" or ");
    return term.negate ? `Not: ${phrases}` : phrases;
  }
  const label = ({ board: "Board", column: "Column", state: "State", assignee: "Assignee", creator: "Created by", tag: "Tag", flag: "Flag", sprint: "Sprint", parent: "Parent", level: "Level" } as Record<string, string>)[term.key] ?? term.key;
  return `${label} ${term.negate ? "is not" : "is"} ${term.values.map((value) => homeValueLabel(term.key, value, names)).join(", ")}`;
}

function canonical(terms: FilterTerm[]): TaskQuery {
  const parsed = parse(format({ terms }), { lenient: true });
  return parsed.ok ? parsed.query : { terms: [] };
}

export const homeTermValues = (query: TaskQuery, key: string) => query.terms.find((term) => term.key === key && !term.negate)?.values ?? [];

/** Replaces the positive term for `key` with `values` (or removes it), keeping the rest; canonical. */
export function withHomeTerm(query: TaskQuery, key: FilterKey, values: readonly string[]): TaskQuery {
  const others = query.terms.filter((term) => term.key !== key || term.negate);
  return canonical(values.length ? [...others, { key, negate: false, values: [...values] }] : others);
}

const textOf = (query: TaskQuery) => homeTermValues(query, "text")[0] ?? "";

/**
 * The cross-board filter bar for My work and views: the board filter bar's chips, "+ Filter", and
 * text box over the same grammar, with Board and State in place of Column. Pills are custom
 * Selects and Comboboxes (D91), which become sheets at 390 px.
 */
export function HomeFilterBar({ filter, onChange, names, options, lockedKeys = [], hiddenKeys = [], readOnly = false, shown }: HomeFilterBarProps) {
  const searchEnabled = useModuleEnabled("search");
  const [editing, setEditing] = useState<HomeField | null>(null);
  const [text, setText] = useState(() => textOf(filter));
  const [dateOperator, setDateOperator] = useState<"<" | "" | ">">("<");
  const [date, setDate] = useState("");
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const typedRef = useRef(false);

  const current = textOf(filter);
  useEffect(() => {
    if (!typedRef.current) setText(current);
  }, [current]);
  useEffect(() => {
    if (!typedRef.current) return;
    const timer = window.setTimeout(() => {
      typedRef.current = false;
      const next = text.trim().slice(0, 100);
      if (next !== textOf(filterRef.current)) onChangeRef.current(withHomeTerm(filterRef.current, "text", next ? [next] : []), { push: false });
    }, TEXT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  const values = editing ? homeTermValues(filter, editing) : [];
  const setValues = (next: string[]) => {
    if (!editing) return;
    const had = values.length > 0;
    onChange(withHomeTerm(filter, editing, next), { push: had !== next.length > 0 });
  };
  const fieldOptions = (field: HomeField) => {
    switch (field) {
      case "board": return options.boards.map((board) => ({ value: board.id, label: board.name }));
      case "state": return (["todo", "doing", "done"] as const).map((state) => ({ value: state, label: STATE_LABELS[state] }));
      case "assignee": return [{ value: "me", label: "Me" }, ...options.users.map((user) => ({ value: user.id, label: user.displayName })), { value: "none", label: "No assignee" }];
      case "tag": return [...[...new Set(options.tagNames)].sort().map((name) => ({ value: name, label: name })), { value: "none", label: "No tag" }];
      case "priority": return [...TASK_PRIORITIES.map((priority) => ({ value: priority, label: priorityLabel(priority) })), { value: "none", label: "No priority" }];
      case "flag": return [...TASK_FLAGS.map((flag) => ({ value: flag, label: FLAG_LABELS[flag] })), { value: "none", label: "No flag" }];
      case "due": return [{ value: "overdue", label: "Overdue" }, { value: "today", label: "Today" }, { value: "week", label: "Next 7 days" }, { value: "next-week", label: "The 7 days after" }, { value: "none", label: "No date" }];
      case "sprint": return (["current", "next", "none"] as const).map((value) => ({ value, label: SPRINT_LABELS[value] }));
      case "parent": return [{ value: "none", label: "No parent" }];
      case "level": return ["work", "0", "1", "2"].map((value) => ({ value, label: LEVEL_LABELS[value] }));
      case "has": return [{ value: "relation", label: "Has relations" }, { value: "blocked", label: "Is blocked" }, { value: "subtasks", label: "Has subtasks" }];
    }
  };
  const chips = filter.terms.map((term, index) => ({ term, index }))
    .filter(({ term }) => !hiddenKeys.includes(term.key))
    .filter(({ term }) => readOnly || !(searchEnabled && term.key === "text" && !term.negate));
  const removable = (term: FilterTerm) => !readOnly && !lockedKeys.includes(term.key);
  const hasClearable = filter.terms.some((term) => removable(term) && !hiddenKeys.includes(term.key));

  function addDate() {
    const valid = committableDueDate(date, null);
    if (!valid || editing !== "due") return;
    setValues([...values, `${dateOperator}${valid}`]);
    setDate("");
  }

  return <div className="task-filter-bar task-home-filter" role="group" aria-label="Filters">
    {/* The order never changes (operator, 2026-10-22, D608): "+ Filter" and the text box first, so
        they stay put; the applied filters after them, then the one being edited, Clear, and the count. */}
    {!readOnly && <Select<string> variant="chip" className="task-filter-add" label="Add filter" placeholder="+ Filter" value={null} searchable={false}
      options={FIELD_ORDER.filter((key) => !lockedKeys.includes(key) && !hiddenKeys.includes(key)).map((key) => ({ value: key, label: FIELD_LABELS[key], icon: <ListFilter /> }))}
      onChange={(key) => setEditing(key as HomeField)} />}
    {!readOnly && searchEnabled && <label className="task-filter-text">
      <Search aria-hidden="true" />
      <input type="search" value={text} maxLength={100} placeholder="Find cards" aria-label="Find cards by text"
        onChange={(event) => { typedRef.current = true; setText(event.target.value); }}
        onKeyDown={(event) => { if (event.key === "Escape" && text) { event.preventDefault(); event.stopPropagation(); typedRef.current = true; setText(""); } }} />
    </label>}
    {chips.map(({ term, index }) => {
      const label = homeChipLabel(term, names);
      const editable = removable(term) && !term.negate && (FIELD_ORDER as string[]).includes(term.key);
      return <span key={`${term.key}:${term.negate}:${index}`} className={`task-filter-chip${term.negate ? " negated" : ""}${removable(term) ? "" : " locked"}`}>
        {editable
          ? <button type="button" className="task-filter-chip-body" onClick={() => setEditing(term.key as HomeField)} aria-label={`Edit filter: ${label}`}>{label}</button>
          : <span className="task-filter-chip-body">{label}</span>}
        {removable(term) && <button type="button" className="task-filter-chip-remove" onClick={() => {
          if (editing === term.key) setEditing(null);
          onChange(canonical(filter.terms.filter((_, at) => at !== index)), { push: true });
        }} aria-label={`Remove filter: ${label}`}><X /></button>}
      </span>;
    })}
    {!readOnly && editing && <span className="task-filter-editor" role="group" aria-label={`${FIELD_LABELS[editing]} filter`}>
      <span className="task-filter-editor-label">{FIELD_LABELS[editing]} is</span>
      <Combobox<string> multiple defaultOpen label={`${FIELD_LABELS[editing]} filter values`} placeholder={`Choose ${FIELD_LABELS[editing].toLowerCase()}…`} value={values}
        options={fieldOptions(editing)} selectedOptions={values.map((value) => ({ value, label: homeValueLabel(editing, value, names) }))} maxSelected={20} onChange={setValues} emptyText="Nothing to choose"
        onCreate={editing === "tag" ? async (label) => ({ value: label.trim().slice(0, 40), label: label.trim().slice(0, 40) }) : undefined} />
      {editing === "due" && <span className="task-filter-date">
        <Select<"<" | "" | ">"> variant="chip" label="Date comparison" value={dateOperator} onChange={setDateOperator} searchable={false} options={[{ value: "<", label: "Before" }, { value: "", label: "On" }, { value: ">", label: "After" }]} />
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="Due date" min="1900-01-01" max="2999-12-31"
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addDate(); } }} />
        <button type="button" className="secondary-button" onClick={addDate} disabled={!committableDueDate(date, null)}>Add date</button>
      </span>}
      <button type="button" className="icon-button task-filter-done" onClick={() => setEditing(null)} aria-label="Done editing the filter" title="Done"><Check /></button>
    </span>}
    {hasClearable && <button type="button" className="task-filter-clear" onClick={() => {
      typedRef.current = false;
      setText("");
      setEditing(null);
      onChange(canonical(filter.terms.filter((term) => !removable(term) || hiddenKeys.includes(term.key))), { push: true });
    }}>Clear</button>}
    {shown && <span className="task-filter-count" role="status" aria-live="polite">{shown}</span>}
  </div>;
}
