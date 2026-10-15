import { createContext, useEffect, useState } from "react";
import { Check, ChevronDown, ListFilter, LoaderCircle, RotateCcw } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import type { ReportParamsSearch } from "../router";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import {
  DATE_PRESET_LABELS, DATE_PRESETS, defaultValues, isDefaultSet, PARAM_LIMITS, resolveDateRange, todayUtc, validDay, valueLabel, valueProblem,
  type DatePreset, type DateRangeValue, type MultiSelectParameter, type ParamOptions, type ParamValue, type ParamValues, type ReportParameter
} from "../../shared/reportParams";
import { getParamOptions } from "./reportViewApi";
import { messageOf } from "./reportsApi";

/**
 * The report's control bar (spec v3, D489, docs/plan/REPORT_THEME.md § Parameters): its date range and
 * filters at the top of the report. From 761 px the parameters are a row of pills (the shared Select,
 * D91) with Reset to defaults; on a phone one Filters button opens them in a bottom sheet over a draft
 * (a history layer with its key, so Forward after Back reopens it), applied with Show results. The
 * values live in the URL (ReportPage → ReportsApp), so Back, Forward, and shared links reproduce them.
 */

/** The report page's URL parameter values and how to change them (absent: a view with no URL, such as a version's). */
export type ReportParamsContextValue = { search: ReportParamsSearch | undefined; onChange: (next: ReportParamsSearch | undefined, options?: { replace?: boolean }) => void };
export const ReportParamsContext = createContext<ReportParamsContextValue | null>(null);

export type OptionsState = Record<string, ParamOptions | "loading" | { error: string }>;

/** Each select's options, read once when the report opens (the server caches them per report). */
export function useParamOptions(reportId: string, parameters: readonly ReportParameter[], enabled: boolean): OptionsState {
  const [state, setState] = useState<OptionsState>({});
  const ids = parameters.filter((param) => param.type === "select" || param.type === "multi_select").map((param) => param.id).join(",");
  useEffect(() => {
    if (!enabled || !ids) return undefined;
    let alive = true;
    for (const id of ids.split(",")) {
      setState((current) => ({ ...current, [id]: "loading" }));
      getParamOptions(reportId, id).then(
        ({ options }) => { if (alive) setState((current) => ({ ...current, [id]: options })); },
        (reason) => { if (alive) setState((current) => ({ ...current, [id]: { error: messageOf(reason, "Could not load the choices") } })); }
      );
    }
    return () => { alive = false; };
  }, [reportId, ids, enabled]);
  return state;
}

const optionList = (state: OptionsState[string] | undefined): string[] => state && state !== "loading" && "options" in state ? state.options : [];
const optionsNote = (state: OptionsState[string] | undefined) => state === "loading" ? "Loading choices…" : state && "error" in state && state.error ? state.error : null;

/** "Sep 1 – Sep 30" for a custom range (the pill is short); presets read as their label. */
function rangeText(value: DateRangeValue) {
  if (value.preset !== "custom") return DATE_PRESET_LABELS[value.preset];
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC", ...(iso.slice(0, 4) !== todayUtc().slice(0, 4) ? { year: "numeric" } : {}) });
  return `${day(value.from)} – ${day(value.to)}`;
}

type Sheet = { kind: "range"; param: ReportParameter } | { kind: "multi"; param: MultiSelectParameter } | null;

type FieldProps = {
  param: ReportParameter;
  value: ParamValue;
  options: OptionsState;
  variant: "chip" | "field";
  disabled: boolean;
  onChange: (value: ParamValue) => void;
  onSheet: (sheet: Sheet) => void;
};

/** One parameter's control: a pill in the bar, a labelled field in the phone's sheet. */
function ParamField({ param, value, options, variant, disabled, onChange, onSheet }: FieldProps) {
  const isDefault = JSON.stringify(value) === JSON.stringify(param.default);
  let control: React.ReactNode;
  switch (param.type) {
    case "date_range": {
      const range = value as DateRangeValue;
      control = <Select<DatePreset> variant={variant} label={param.label} value={range.preset} searchable={false} disabled={disabled}
        placeholder={rangeText(range)}
        options={DATE_PRESETS.map((preset) => ({ value: preset, label: preset === "custom" && range.preset === "custom" ? `Custom: ${rangeText(range)}` : preset === "custom" ? "Custom range…" : DATE_PRESET_LABELS[preset] }))}
        onChange={(preset) => preset === "custom" ? onSheet({ kind: "range", param }) : onChange({ preset })} />;
      break;
    }
    case "select": {
      const choices = optionList(options[param.id]);
      const all = choices.includes(value as string) ? choices : [value as string, ...choices];
      control = <Select<string> variant={variant} label={param.label} value={value as string} searchable="auto" disabled={disabled}
        options={all.map((choice) => ({ value: choice, label: choice || "(blank)" }))} onChange={onChange} />;
      break;
    }
    case "multi_select": {
      const picked = value as string[];
      // The shared Select's trigger look; the choices open as a checkbox sheet (none checked is All).
      control = <button type="button" className={`ui-select ui-select-${variant} report-param-multi`} disabled={disabled} aria-haspopup="dialog" onClick={() => onSheet({ kind: "multi", param })}
        aria-label={`${param.label}: ${valueLabel(param, picked)}`}>
        <span className="ui-select-value">{variant === "chip" ? `${param.label}: ` : ""}{valueLabel(param, picked)}</span>
        <ChevronDown className="ui-select-chevron" aria-hidden="true" />
      </button>;
      break;
    }
    default:
      control = <ParamInput param={param} value={value} disabled={disabled} onChange={onChange} />;
  }
  return variant === "chip"
    ? <span className={`report-param${isDefault ? "" : " active"}`} title={param.label}>{control}</span>
    : <div className="report-param-field"><span className="report-param-label">{param.label}</span>{control}</div>;
}

/** A number or text parameter: applied on Enter or when the field loses focus, if it fits. */
function ParamInput({ param, value, disabled, onChange }: { param: ReportParameter; value: ParamValue; disabled: boolean; onChange: (value: ParamValue) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const parsed = param.type === "number" ? (draft.trim() === "" ? NaN : Number(draft)) : draft;
  const problem = valueProblem(param, parsed);
  const apply = () => { if (!problem && parsed !== value) onChange(parsed); };
  return <input className={`report-param-input${problem ? " invalid" : ""}`} aria-label={param.label} placeholder={param.label} value={draft} disabled={disabled}
    inputMode={param.type === "number" ? "decimal" : undefined} maxLength={param.type === "text" ? PARAM_LIMITS.text : 40}
    aria-invalid={problem ? true : undefined} title={problem ?? undefined}
    onChange={(event) => setDraft(event.target.value)} onBlur={apply} onKeyDown={(event) => { if (event.key === "Enter") apply(); }} />;
}

type BarProps = {
  reportId: string;
  parameters: readonly ReportParameter[];
  values: ParamValues;
  /** A set is loading (its blocks show their own spinners). */
  busy: boolean;
  onChange: (values: ParamValues) => void;
};

/** The control bar: pills from 761 px, the Filters button and sheet on a phone. */
export function ReportParamsBar({ reportId, parameters, values, busy, onChange }: BarProps) {
  const options = useParamOptions(reportId, parameters, true);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const isDefault = isDefaultSet(parameters, values);
  const changed = parameters.filter((param) => JSON.stringify(values[param.id]) !== JSON.stringify(param.default)).length;
  const set = (param: ReportParameter, value: ParamValue) => onChange({ ...values, [param.id]: value });
  const reset = () => onChange(defaultValues(parameters));
  return <div className="report-params" role="group" aria-label="Report filters">
    <div className="report-params-chips">
      {parameters.map((param) => <ParamField key={param.id} param={param} value={values[param.id] ?? param.default} options={options} variant="chip" disabled={false}
        onChange={(value) => set(param, value)} onSheet={setSheet} />)}
      {!isDefault && <button type="button" className="secondary-button report-params-reset" onClick={reset}><RotateCcw aria-hidden="true" />Reset to defaults</button>}
      {busy && <span className="report-params-busy" role="status"><LoaderCircle className="spin" aria-hidden="true" />Updating…</span>}
    </div>
    <div className="report-params-narrow">
      <button type="button" className={`secondary-button report-params-open${changed ? " active" : ""}`} onClick={() => setPhoneOpen(true)} aria-haspopup="dialog">
        <ListFilter aria-hidden="true" />Filters{changed > 0 && <b aria-label={`${changed} changed`}>{changed}</b>}
      </button>
      <span className="report-params-summary">{parameters.map((param) => valueLabel(param, values[param.id] ?? param.default)).join(" · ")}</span>
      {busy && <LoaderCircle className="spin report-params-spinner" aria-label="Updating" />}
    </div>
    {sheet?.kind === "range" && <CustomRangeSheet param={sheet.param} value={values[sheet.param.id] as DateRangeValue} onClose={() => setSheet(null)}
      onApply={(value) => { setSheet(null); set(sheet.param, value); }} />}
    {sheet?.kind === "multi" && <MultiSelectSheet param={sheet.param} value={values[sheet.param.id] as string[]} options={options[sheet.param.id]} onClose={() => setSheet(null)}
      onApply={(value) => { setSheet(null); set(sheet.param, value); }} />}
    {phoneOpen && <ParamsSheet parameters={parameters} values={values} options={options} onClose={() => setPhoneOpen(false)} reopen={() => setPhoneOpen(true)}
      onApply={(next) => { setPhoneOpen(false); onChange(next); }} />}
  </div>;
}

/** Custom from–to days (both included); Apply keeps a valid range only. */
function CustomRangeSheet({ param, value, onApply, onClose }: { param: ReportParameter; value: DateRangeValue; onApply: (value: DateRangeValue) => void; onClose: () => void }) {
  const start = resolveDateRange(value ?? { preset: "30d" }, todayUtc());
  const [from, setFrom] = useState(start.from);
  const [to, setTo] = useState(start.to);
  useHistoryDialogGuard(true, onClose, { reopen: null });
  const problem = !validDay(from) || !validDay(to) ? "Pick both days" : from > to ? "The start is after the end" : null;
  return <ModalDialog title={param.label} eyebrow="Custom range" onClose={onClose} variant="sheet" className="reports-dialog report-params-sheet">
    <div className="report-params-fields">
      <label className="report-param-field"><span className="report-param-label">From</span><input type="date" className="report-param-input" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></label>
      <label className="report-param-field"><span className="report-param-label">To (included)</span><input type="date" className="report-param-input" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></label>
      {problem && <p className="report-param-problem" role="alert">{problem}</p>}
    </div>
    <footer className="file-dialog-actions">
      <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
      <button type="button" className="primary-button" disabled={Boolean(problem)} onClick={() => onApply({ preset: "custom", from, to })}><Check aria-hidden="true" />Apply</button>
    </footer>
  </ModalDialog>;
}

/** A multi-select's choices as checkboxes; none checked is All. */
function MultiSelectSheet({ param, value, options, onApply, onClose }: { param: MultiSelectParameter; value: string[]; options: OptionsState[string] | undefined; onApply: (value: string[]) => void; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>(value ?? []);
  const [query, setQuery] = useState("");
  useHistoryDialogGuard(true, onClose, { reopen: null });
  // The options in their order (a pick never moves under the pointer), then any picked value no longer listed.
  const listed = optionList(options);
  const choices = [...listed, ...picked.filter((item) => !listed.includes(item))];
  const shown = query ? choices.filter((choice) => choice.toLowerCase().includes(query.toLowerCase())) : choices;
  const note = optionsNote(options);
  const toggle = (choice: string) => setPicked((current) => current.includes(choice) ? current.filter((item) => item !== choice) : current.length >= PARAM_LIMITS.selected ? current : [...current, choice]);
  return <ModalDialog title={param.label} eyebrow={picked.length ? `${picked.length} selected` : "All"} onClose={onClose} variant="sheet" className="reports-dialog report-params-sheet">
    <div className="report-params-fields">
      {choices.length > 8 && <input className="report-param-input" type="search" placeholder={`Search ${param.label.toLowerCase()}`} aria-label={`Search ${param.label}`} value={query} onChange={(event) => setQuery(event.target.value)} />}
      <label className="report-param-check"><input type="checkbox" checked={picked.length === 0} onChange={() => setPicked([])} />All</label>
      <div className="report-param-checks" role="group" aria-label={param.label}>
        {shown.map((choice) => <label key={choice} className="report-param-check"><input type="checkbox" checked={picked.includes(choice)} onChange={() => toggle(choice)} />{choice || "(blank)"}</label>)}
      </div>
      {note && <p className="report-param-problem">{note}</p>}
    </div>
    <footer className="file-dialog-actions">
      <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
      <button type="button" className="primary-button" onClick={() => onApply(picked)}><Check aria-hidden="true" />Apply</button>
    </footer>
  </ModalDialog>;
}

/** The phone's sheet: every parameter as a field over a draft; Show results applies it. */
function ParamsSheet({ parameters, values, options, onApply, onClose, reopen }: { parameters: readonly ReportParameter[]; values: ParamValues; options: OptionsState; onApply: (values: ParamValues) => void; onClose: () => void; reopen: () => void }) {
  const [draft, setDraft] = useState<ParamValues>(values);
  const [sheet, setSheet] = useState<Sheet>(null);
  useHistoryDialogGuard(true, onClose, { reopen, layerKey: "reports.params" });
  const set = (param: ReportParameter, value: ParamValue) => setDraft((current) => ({ ...current, [param.id]: value }));
  return <ModalDialog title="Filters" eyebrow="Report" onClose={onClose} variant="sheet" className="reports-dialog report-params-sheet">
    <div className="report-params-fields">
      {parameters.map((param) => <ParamField key={param.id} param={param} value={draft[param.id] ?? param.default} options={options} variant="field" disabled={false}
        onChange={(value) => set(param, value)} onSheet={setSheet} />)}
    </div>
    <footer className="file-dialog-actions">
      <button type="button" className="secondary-button" onClick={() => setDraft(defaultValues(parameters))} disabled={isDefaultSet(parameters, draft)}><RotateCcw aria-hidden="true" />Reset</button>
      <button type="button" className="primary-button" onClick={() => onApply(draft)}><Check aria-hidden="true" />Show results</button>
    </footer>
    {sheet?.kind === "range" && <CustomRangeSheet param={sheet.param} value={draft[sheet.param.id] as DateRangeValue} onClose={() => setSheet(null)} onApply={(value) => { setSheet(null); set(sheet.param, value); }} />}
    {sheet?.kind === "multi" && <MultiSelectSheet param={sheet.param} value={draft[sheet.param.id] as string[]} options={options[sheet.param.id]} onClose={() => setSheet(null)} onApply={(value) => { setSheet(null); set(sheet.param, value); }} />}
  </ModalDialog>;
}
