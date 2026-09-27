import { useEffect, useRef, useState } from "react";
import { Check, ListFilter, Search, X } from "lucide-react";
import type { FilterKey, TaskQuery } from "../../shared/taskQuery";
import { useModuleEnabled } from "../modules";
import { Combobox } from "../ui/Combobox";
import { Select } from "../ui/Select";
import { FILTER_FIELDS, termFieldLabel, termValueLabel, termValues, textTerm, withoutTerm, withTermValues, withText, type BoardContext, type BoardData } from "./boardQuery";
import { focusWhenRendered } from "./cardFocus";
import { committableDueDate } from "./taskActions";

type FilterBarProps = {
  board: BoardData;
  context: BoardContext;
  filter: TaskQuery;
  /** Every edit replaces the history entry (§4.7); the text box is debounced by 300 ms. */
  onChange: (filter: TaskQuery) => void;
  /** Cards shown and on the board, for the live count. */
  shown: number;
  total: number;
};

export const TEXT_DEBOUNCE_MS = 300;
const DATE_OPERATORS = [{ value: "<", label: "Before" }, { value: "", label: "On" }, { value: ">", label: "After" }] as const;
type DateOperator = typeof DATE_OPERATORS[number]["value"];

const DUE_PHRASES: Record<string, string> = { overdue: "Overdue", today: "Due today", week: "Due in the next 7 days", "next-week": "Due in the 7 days after", none: "No due date" };
const HAS_PHRASES: Record<string, [string, string]> = { relation: ["Has relations", "No relations"], blocked: ["Blocked by a card", "Not blocked by a card"] };

/** A chip's words: "Assignee is Asha, Me", "Flag is not Urgent", "Due before Oct 1, 2026 or No due date", "Text contains “login”". */
export function chipLabel(term: TaskQuery["terms"][number], board: BoardData, context: BoardContext) {
  if (term.key === "text") return `Text ${term.negate ? "does not contain" : "contains"} “${term.values[0] ?? ""}”`;
  if (term.key === "has") return term.values.map((value) => HAS_PHRASES[value]?.[term.negate ? 1 : 0] ?? value).join(" or ");
  if (term.key === "due") {
    const phrases = term.values.map((value) => DUE_PHRASES[value] ?? `Due ${termValueLabel("due", value, board, context)}`).join(" or ");
    return term.negate ? `Not: ${phrases}` : phrases;
  }
  const values = term.values.map((value) => termValueLabel(term.key, value, board, context)).join(", ");
  return `${termFieldLabel(term.key)} ${term.negate ? "is not" : "is"} ${values}`;
}

/** A tag term's colours as dots before its words; hidden from screen readers (the words name it). */
export function termSwatches(values: readonly string[], board: BoardData) {
  const colors = values.map((value) => board.tags.find((tag) => tag.id === value || tag.name.toLowerCase() === value.toLowerCase())?.color).filter(Boolean);
  if (!colors.length) return null;
  return <span className="task-filter-swatches" aria-hidden="true">
    {colors.map((color, index) => <span key={index} className={`ui-option-swatch color-${color}`} />)}
  </span>;
}

/**
 * The Linear-style filter bar (§4.6): one removable chip per term, a "+ Filter" dropdown that
 * picks a field and then its values, a text box, and Clear. Values of one field OR together and
 * fields AND. The filters live in the URL query as the one task grammar (`q=`); with the Search
 * module off, the text box is hidden (§4.8) and a text filter from a link shows as a chip.
 */
export function FilterBar({ board, context, filter, onChange, shown, total }: FilterBarProps) {
  const searchEnabled = useModuleEnabled("search");
  const [editing, setEditing] = useState<FilterKey | null>(null);
  const [text, setText] = useState(() => textTerm(filter));
  const [dateOperator, setDateOperator] = useState<DateOperator>("<");
  const [date, setDate] = useState("");
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const typedRef = useRef(false);
  const barRef = useRef<HTMLDivElement>(null);

  // Back/Forward or a chip removal changes the text term from outside: follow it.
  const current = textTerm(filter);
  useEffect(() => {
    if (!typedRef.current) setText(current);
  }, [current]);

  useEffect(() => {
    if (!typedRef.current) return;
    const timer = window.setTimeout(() => {
      typedRef.current = false;
      if (text.trim() !== textTerm(filterRef.current)) onChangeRef.current(withText(filterRef.current, text));
    }, TEXT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  const field = editing ? FILTER_FIELDS[editing] : null;
  const values = editing ? termValues(filter, editing) : [];
  const setValues = (next: string[]) => { if (editing) onChange(withTermValues(filter, editing, next)); };
  const options = field ? field.optionsFor(board, context) : [];
  // Chosen values keep their option's swatch (a tag's colour), not only its label.
  const selectedOptions = values.map((value) => options.find((option) => option.value === value) ?? { value, label: field!.labelFor(value, board, context) });
  const chips = filter.terms.map((term, index) => ({ term, index }))
    // The text box shows the positive text term; with Search off it is a chip instead.
    .filter(({ term }) => !(searchEnabled && term.key === "text" && !term.negate));
  const hasFilter = filter.terms.length > 0;

  function finishSheetEdit() {
    setEditing(null);
    focusWhenRendered(() => barRef.current?.querySelector<HTMLElement>(".task-filter-add"));
  }

  function addDate() {
    const valid = committableDueDate(date, null);
    if (!valid || !editing) return;
    setValues([...values, `${dateOperator}${valid}`]);
    setDate("");
  }

  return <div ref={barRef} className="task-filter-bar" role="group" aria-label="Filters">
    {chips.map(({ term, index }) => {
      const label = chipLabel(term, board, context);
      const editable = !term.negate && term.key in FILTER_FIELDS;
      const swatches = term.key === "tag" ? termSwatches(term.values, board) : null;
      return <span key={`${term.key}:${term.negate}:${index}`} className={`task-filter-chip${term.negate ? " negated" : ""}`}>
        {editable
          ? <button type="button" className="task-filter-chip-body" onClick={() => setEditing(term.key)} aria-label={`Edit filter: ${label}`}>{swatches}{label}</button>
          : <span className="task-filter-chip-body">{swatches}{label}</span>}
        <button type="button" className="task-filter-chip-remove" onClick={() => { if (editing === term.key) setEditing(null); onChange(withoutTerm(filter, index)); }} aria-label={`Remove filter: ${label}`}><X /></button>
      </span>;
    })}
    {!editing && <Select<string> variant="chip" className="task-filter-add" label="Add filter" placeholder="+ Filter" value={null} searchable={false}
      options={Object.entries(FILTER_FIELDS).filter(([, item]) => !item.available || item.available(board)).map(([key, item]) => ({ value: key, label: item.label, icon: <ListFilter /> }))}
      onChange={(key) => setEditing(key as FilterKey)} />}
    {editing && field && <span className="task-filter-editor" role="group" aria-label={`${field.label} filter`}>
      <span className="task-filter-editor-label">{field.label} is</span>
      <Combobox<string> multiple defaultOpen label={`${field.label} filter values`} placeholder={`Choose ${field.label.toLowerCase()}…`} value={values}
        options={options} selectedOptions={selectedOptions} maxSelected={20} onChange={setValues} emptyText="Nothing to choose"
        // Phones: the sheet is the editor, so closing it finishes the edit instead of leaving a focused
        // field (and the keyboard) behind. The due filter keeps its editor for the date row.
        onSheetClose={editing === "due" ? undefined : finishSheetEdit} />
      {editing === "due" && <span className="task-filter-date">
        <Select<DateOperator> variant="chip" label="Date comparison" value={dateOperator} onChange={setDateOperator} searchable={false} options={DATE_OPERATORS.map((item) => ({ value: item.value, label: item.label }))} />
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="Due date" min="1900-01-01" max="2999-12-31"
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addDate(); } }} />
        <button type="button" className="secondary-button" onClick={addDate} disabled={!committableDueDate(date, null)}>Add date</button>
      </span>}
      <button type="button" className="icon-button task-filter-done" onClick={() => setEditing(null)} aria-label="Done editing the filter" title="Done"><Check /></button>
    </span>}
    {searchEnabled && <label className="task-filter-text">
      <Search aria-hidden="true" />
      <input type="search" value={text} maxLength={100} placeholder="Filter cards" aria-label="Filter cards by text"
        onChange={(event) => { typedRef.current = true; setText(event.target.value); }}
        onKeyDown={(event) => { if (event.key === "Escape" && text) { event.preventDefault(); event.stopPropagation(); typedRef.current = true; setText(""); } }} />
    </label>}
    {hasFilter && <button type="button" className="task-filter-clear" onClick={() => { typedRef.current = false; setText(""); setEditing(null); onChange({ terms: [] }); }}>Clear</button>}
    <span className="task-filter-count" role="status" aria-live="polite">{hasFilter ? `${shown} of ${total} ${total === 1 ? "card" : "cards"}` : ""}</span>
  </div>;
}
