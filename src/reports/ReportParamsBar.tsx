import { createContext, useContext, useEffect, useState } from "react";
import { Check, ChevronDown, ListFilter, LoaderCircle, RotateCcw } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import type { ReportParamsSearch } from "../router";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import {
  DATE_PRESET_LABELS, DATE_PRESETS, defaultValues, isDefaultSet, PARAM_LIMITS, resolveDateRange, todayIn, validDay, valueLabel, valueProblem, zoneLabel,
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
/** Whether a select's list stopped at 200 (its options query has more): then the search asks the server (D491). */
const optionsCut = (state: OptionsState[string] | undefined) => Boolean(state && state !== "loading" && "options" in state && state.truncated);

/** The report the bar belongs to, for the option search (D491). */
const ReportIdContext = createContext<string>("");

/**
 * D491: search-as-you-type against ClickHouse for a select whose list stops at 200. Debounced (250 ms);
 * the latest answer is kept while the next one loads, so the list never empties under the pointer. An
 * empty box is the cached list (nothing is asked).
 */
export function useOptionSearch(reportId: string, paramId: string, enabled: boolean, query: string) {
  const [found, setFound] = useState<{ query: string; options: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const term = query.trim();
  useEffect(() => {
    if (!enabled || !term || !reportId) { setError(null); return undefined; }
    let alive = true;
    const timer = setTimeout(() => {
      getParamOptions(reportId, paramId, term).then(
        ({ options }) => { if (alive) { setFound({ query: term, options: options.options }); setError(null); } },
        (reason) => { if (alive) setError(messageOf(reason, "Could not search the choices")); }
      );
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [reportId, paramId, enabled, term]);
  const active = enabled && term !== "";
  return { found: active ? found?.options ?? [] : [], searching: active && found?.query !== term && !error, error: active ? error : null };
}

/** The listed choices, then the server's matches not listed (D491), each once. */
const withFound = (listed: readonly string[], found: readonly string[]) => found.length ? [...listed, ...found.filter((item) => !listed.includes(item))] : [...listed];
const optionsNote = (state: OptionsState[string] | undefined) => state === "loading" ? "Loading choices…" : state && "error" in state && state.error ? state.error : null;

/** "Sep 1 – Sep 30" for a custom range (the pill is short); presets read as their label. */
/** D489: the zone the report's presets resolve in (its schedule's, else the instance's), named on the picker. */
const ZoneContext = createContext<string>("UTC");
const presetText = (preset: Exclude<DateRangeValue["preset"], "custom">, zone: string) => `${DATE_PRESET_LABELS[preset]} (${zoneLabel(zone)})`;

function rangeText(value: DateRangeValue, zone: string) {
  if (value.preset !== "custom") return presetText(value.preset, zone);
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC", ...(iso.slice(0, 4) !== todayIn(zone).slice(0, 4) ? { year: "numeric" } : {}) });
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
  const zone = useContext(ZoneContext);
  const isDefault = JSON.stringify(value) === JSON.stringify(param.default);
  let control: React.ReactNode;
  switch (param.type) {
    case "date_range": {
      const range = value as DateRangeValue;
      control = <Select<DatePreset> variant={variant} label={param.label} value={range.preset} searchable={false} disabled={disabled}
        placeholder={rangeText(range, zone)}
        options={DATE_PRESETS.map((preset) => ({ value: preset, label: preset === "custom" && range.preset === "custom" ? `Custom: ${rangeText(range, zone)}` : preset === "custom" ? "Custom range…" : presetText(preset, zone) }))}
        onChange={(preset) => preset === "custom" ? onSheet({ kind: "range", param }) : onChange({ preset })} />;
      break;
    }
    case "select":
      control = <SelectParamControl param={param} value={value as string} state={options[param.id]} variant={variant} disabled={disabled} onChange={onChange} />;
      break;
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

/** A single select: the cached choices; past 200 its search box also asks ClickHouse (D491). */
function SelectParamControl({ param, value, state, variant, disabled, onChange }: { param: ReportParameter; value: string; state: OptionsState[string] | undefined; variant: "chip" | "field"; disabled: boolean; onChange: (value: ParamValue) => void }) {
  const reportId = useContext(ReportIdContext);
  const [query, setQuery] = useState("");
  const cut = optionsCut(state);
  const search = useOptionSearch(reportId, param.id, cut, query);
  const choices = withFound(optionList(state), search.found);
  const all = choices.includes(value) ? choices : [value, ...choices];
  return <Select<string> variant={variant} label={param.label} value={value} searchable={cut ? true : "auto"} disabled={disabled}
    onSearch={cut ? setQuery : undefined} emptyText={search.searching ? "Searching…" : search.error ?? undefined}
    options={all.map((choice) => ({ value: choice, label: choice || "(blank)" }))} onChange={onChange} />;
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
  /** D489: the report's zone (IANA), from the results. */
  timeZone?: string;
};

/** The control bar: pills from 761 px, the Filters button and sheet on a phone. */
export function ReportParamsBar({ reportId, parameters, values, busy, onChange, timeZone = "UTC" }: BarProps) {
  const options = useParamOptions(reportId, parameters, true);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const isDefault = isDefaultSet(parameters, values);
  const changed = parameters.filter((param) => JSON.stringify(values[param.id]) !== JSON.stringify(param.default)).length;
  const set = (param: ReportParameter, value: ParamValue) => onChange({ ...values, [param.id]: value });
  const reset = () => onChange(defaultValues(parameters));
  const summary = (param: ReportParameter) => param.type === "date_range" ? rangeText((values[param.id] ?? param.default) as DateRangeValue, timeZone) : valueLabel(param, values[param.id] ?? param.default);
  return <ReportIdContext.Provider value={reportId}><ZoneContext.Provider value={timeZone}><div className="report-params" role="group" aria-label="Report filters">
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
      <span className="report-params-summary">{parameters.map(summary).join(" · ")}</span>
      {busy && <LoaderCircle className="spin report-params-spinner" aria-label="Updating" />}
    </div>
    {sheet?.kind === "range" && <CustomRangeSheet param={sheet.param} value={values[sheet.param.id] as DateRangeValue} onClose={() => setSheet(null)}
      onApply={(value) => { setSheet(null); set(sheet.param, value); }} />}
    {sheet?.kind === "multi" && <MultiSelectSheet param={sheet.param} value={values[sheet.param.id] as string[]} options={options[sheet.param.id]} onClose={() => setSheet(null)}
      onApply={(value) => { setSheet(null); set(sheet.param, value); }} />}
    {phoneOpen && <ParamsSheet parameters={parameters} values={values} options={options} onClose={() => setPhoneOpen(false)} reopen={() => setPhoneOpen(true)}
      onApply={(next) => { setPhoneOpen(false); onChange(next); }} />}
  </div></ZoneContext.Provider></ReportIdContext.Provider>;
}

/** Custom from–to days (both included); Apply keeps a valid range only. */
function CustomRangeSheet({ param, value, onApply, onClose }: { param: ReportParameter; value: DateRangeValue; onApply: (value: DateRangeValue) => void; onClose: () => void }) {
  const zone = useContext(ZoneContext);
  const start = resolveDateRange(value ?? { preset: "30d" }, todayIn(zone));
  const [from, setFrom] = useState(start.from);
  const [to, setTo] = useState(start.to);
  useHistoryDialogGuard(true, onClose, { reopen: null });
  const problem = !validDay(from) || !validDay(to) ? "Pick both days" : from > to ? "The start is after the end" : null;
  return <ModalDialog title={param.label} eyebrow="Custom range" onClose={onClose} variant="sheet" className="reports-dialog report-params-sheet">
    <div className="report-params-fields">
      <label className="report-param-field"><span className="report-param-label">From ({zoneLabel(zone)} days)</span><input type="date" className="report-param-input" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></label>
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
  // D491: a list cut at 200 searches ClickHouse too.
  const cut = optionsCut(options);
  const search = useOptionSearch(useContext(ReportIdContext), param.id, cut, query);
  // The options in their order (a pick never moves under the pointer), then any picked value no longer listed.
  const listed = optionList(options);
  const choices = [...listed, ...picked.filter((item) => !listed.includes(item))];
  const shown = query ? withFound(choices, search.found).filter((choice) => choice.toLowerCase().includes(query.trim().toLowerCase())) : choices;
  const note = optionsNote(options) ?? (search.error ? search.error : query.trim() && search.searching ? "Searching…" : cut && !query.trim() ? `Showing the first ${listed.length}; search to find more.` : null);
  const toggle = (choice: string) => setPicked((current) => current.includes(choice) ? current.filter((item) => item !== choice) : current.length >= PARAM_LIMITS.selected ? current : [...current, choice]);
  return <ModalDialog title={param.label} eyebrow={picked.length ? `${picked.length} selected` : "All"} onClose={onClose} variant="sheet" className="reports-dialog report-params-sheet">
    <div className="report-params-fields">
      {(choices.length > 8 || cut) && <input className="report-param-input" type="search" placeholder={`Search ${param.label.toLowerCase()}`} aria-label={`Search ${param.label}`} value={query} onChange={(event) => setQuery(event.target.value)} />}
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
