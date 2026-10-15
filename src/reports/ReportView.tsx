import { lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, CircleCheck, CircleX, Clock3, ExternalLink, LoaderCircle, MoreHorizontal, RefreshCw, ScanSearch, TriangleAlert } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { Markdown, type RenderContext } from "../chat/markdown/render";
import { notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { defaultWidth, reportLayout, type ChartBlock, type ReportBlock, type ReportDetail, type ReportResult, type ReportRun } from "../../shared/reports";
import { reportCssVariables } from "../../shared/reportTheme";
import type { QueryResultView, ReportResultsView, ScheduleView } from "../../shared/reportsView";
import { buildChartOption, paletteFor, type ChartBuild, type ChartPalette } from "./chartOption";
import type { MeterModel } from "./chartKinds";
import { InspectSheet, type DataBlock } from "./InspectSheet";
import { INSPECT_TABS, type InspectTab } from "./inspectHistory";
import { useLayerOpener } from "../historyDialogs";
import { KpiTile, type ResultLookup } from "./KpiTile";
import { ResultTable } from "./ResultTable";
import { PAGE_METRICS_RUN_MARKER } from "../../shared/reportsMetrics";
import { previewVersionOf, getParamResults, getResults, getRun, listRuns, refreshReport, runParamSet, RUN_STATUS_TEXT, timeAgo } from "./reportViewApi";
import { ReportParamsBar, ReportParamsContext } from "./ReportParamsBar";
import { canonicalValues, isDefaultSet, valuesFromSearch, valuesToSearch, type ParamValues } from "../../shared/reportParams";
import { codeOf, messageOf } from "./reportsApi";
import { scheduleBadge, ScheduleSheet } from "./ScheduleSheet";
import { CommentOnBlockButton } from "./reportComment";
import { useHeaderActions, useRegisterReportCommands } from "./reportCommands";
import "./reportView.css";

/** ECharts and its option renderer load only when a report with a chart opens (charts.tsx). */
const EChart = lazy(() => import("./charts"));

const POLL_MS = 1000;

/** Whether the system asks for forced colours (texture fills then stand in for hue). */
const forcedColors = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(forced-colors: active)").matches;

/**
 * The chart theme from the page's one theme source (review L4, wave 48b): the root's `color-scheme`
 * (what the app's CSS sets, src/styles.css) picks the mode; every colour then comes from that mode's
 * tokens in shared/reportTheme.ts, the same tokens the view's CSS variables are made of.
 */
export function readChartPalette(): ChartPalette {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return paletteFor("dark");
  try {
    return paletteFor(getComputedStyle(document.documentElement).colorScheme, { forcedColors: forcedColors() });
  } catch {
    return paletteFor("dark");
  }
}

/** Re-reads the theme whenever it can have changed: the root's attributes or style, the OS scheme, or forced colours. */
export function useChartPalette(): ChartPalette {
  const [palette, setPalette] = useState<ChartPalette>(() => readChartPalette());
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const update = () => setPalette((current) => {
      const next = readChartPalette();
      return next.mode === current.mode && next.forcedColors === current.forcedColors ? current : next;
    });
    update();
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    observer?.observe(document.documentElement, { attributes: true });
    if (document.body) observer?.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const media = typeof window.matchMedia === "function" ? [window.matchMedia("(prefers-color-scheme: dark)"), window.matchMedia("(forced-colors: active)")] : [];
    media.forEach((query) => query?.addEventListener?.("change", update));
    return () => { observer?.disconnect(); media.forEach((query) => query?.removeEventListener?.("change", update)); };
  }, []);
  return palette;
}

/** The layout class of a block: its width slot (the grid's 12/6/1 columns follow the view's width). */
export const widthClass = (block: ReportBlock) => `report-w-${block.width ?? defaultWidth(block)}`;

const isDataBlock = (block: ReportBlock): block is DataBlock => block.type !== "markdown";

/**
 * When the viewer (re)loads its results and run history: on open, and whenever the report gets a new
 * revision (a generation saved a new spec), so the new spec's first results show with no manual refresh.
 */
export const resultsLoadKey = (report: Pick<ReportDetail, "id" | "revision">) => `${report.id}@${report.revision}`;

type Props = {
  report: ReportDetail;
  canWrite: boolean;
  /** Review L2: a generation is starting or running (ReportGeneration knows before the run row shows here). */
  generating?: boolean;
  /** Tests and server-side rendering: the results to show without a request. */
  initial?: { results: ReportResultsView; schedule?: ScheduleView | null; runs?: ReportRun[] };
  /** Lane J: a past version (Versions → View this version): no toolbar, no inspect or menu, nothing runs; pass `initial`. */
  readOnly?: { emptyText: string };
};

/**
 * The report viewer (plan wave 47): the spec's blocks over their latest results, one column on a phone
 * and two from 768 px; markdown through the chat's sanitized renderer; charts drawn by ECharts from
 * options Nook builds (chartOption.ts). Every chart, KPI, and table has an inspect button ("How was
 * this built") and a menu with "Re-run this query"; the toolbar has "Refresh all" and the schedule.
 * A refresh is a run: the page polls it and reloads the results when it ends.
 */
export function ReportView({ report, canWrite, generating = false, initial, readOnly }: Props) {
  const [view, setView] = useState<ReportResultsView | null>(initial?.results ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState<ReportRun | null>(initial?.results.running ?? null);
  const [schedule, setSchedule] = useState<ScheduleView | null>(initial?.schedule ?? null);
  const [runs, setRuns] = useState<ReportRun[]>(initial?.runs ?? []);
  const [inspect, setInspect] = useState<{ blockId: string; tab: InspectTab } | null>(null);
  // Forward after Back reopens the last Inspect sheet (its first tab), as Changes and Share do.
  const lastInspect = useRef<{ blockId: string; tab: InspectTab } | null>(null);
  if (inspect) lastInspect.current = inspect;
  // D480: Forward after Back went past the report page remounts it; the layer key names the block and tab.
  useLayerOpener("reports.inspect", (arg) => {
    const [blockId, tab] = arg.split(":");
    if (blockId) setInspect({ blockId, tab: INSPECT_TABS.includes(tab as InspectTab) ? tab as InspectTab : "query" });
  });
  const [menuBlock, setMenuBlock] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [externalLink, setExternalLink] = useState<string | null>(null);
  const palette = useChartPalette();
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // Spec v3 (D489): the report's parameter values come from the URL (ReportParamsContext); the default
  // set reads the stored results, any other set its cached results, running what is missing first.
  const paramsContext = useContext(ReportParamsContext);
  const parameters = report.spec.parameters ?? [];
  const withParams = parameters.length > 0 && !readOnly && !initial && paramsContext !== null;
  const values = useMemo(() => valuesFromSearch(parameters, paramsContext?.search), [parameters, paramsContext?.search]);
  const setKey = withParams && !isDefaultSet(parameters, values) ? canonicalValues(parameters, values) : "";
  const valuesRef = useRef<ParamValues>(values);
  valuesRef.current = values;
  /** The queries a parameter set is still running (their blocks show spinners); null when none. */
  const [pending, setPending] = useState<string[] | null>(null);
  const ticket = useRef(0);

  const loadResults = useCallback(async () => {
    const mine = ++ticket.current;
    const current = () => alive.current && mine === ticket.current;
    try {
      if (!setKey) {
        const next = await getResults(report.id);
        if (!current()) return null;
        setView(next);
        setPending(null);
        setLoadError(null);
        return next;
      }
      const shown = valuesRef.current;
      const first = await getParamResults(report.id, shown);
      if (!current()) return null;
      if (!first.set.missing.length) {
        setView(first);
        setPending(null);
        setLoadError(null);
        return first;
      }
      setPending(first.set.missing);
      // Another run (a refresh, another reader's set) holds the report: wait for it, then run this set.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const ran = await runParamSet(report.id, shown);
          if (!current()) return null;
          setView(ran);
          setPending(null);
          setLoadError(null);
          return ran;
        } catch (reason) {
          if (codeOf(reason).code !== "RUN_IN_PROGRESS" || attempt >= 80) throw reason;
          await new Promise((resolve) => setTimeout(resolve, 1500));
          if (!current()) return null;
        }
      }
    } catch (reason) {
      if (current()) {
        setPending(null);
        setLoadError(messageOf(reason, "Could not load the results"));
      }
      return null;
    }
  }, [report.id, setKey]);
  const changeParams = useCallback((next: ParamValues) => {
    const search = valuesToSearch(parameters, next);
    paramsContext?.onChange(Object.keys(search).length ? search : undefined);
  }, [parameters, paramsContext]);
  const loadRuns = useCallback(async () => {
    try {
      const history = await listRuns(report.id);
      if (!alive.current) return;
      setRuns(history.runs);
      setSchedule(history.schedule);
    } catch { /* the toolbar works without the history */ }
  }, [report.id]);

  const loadKey = resultsLoadKey(report);
  useEffect(() => {
    if (initial) return;
    void loadResults().then((next) => { if (next?.running) setRunning(next.running); });
  }, [initial, loadResults, loadKey]);
  useEffect(() => {
    if (initial) return;
    void loadRuns();
  }, [initial, loadRuns, loadKey]);

  // While a run goes: poll it, then reload the results and say how it went.
  useEffect(() => {
    if (!running || running.status !== "running" || initial) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const { run } = await getRun(report.id, running.id);
        if (!alive.current) return;
        if (run.status === "running") {
          // A 409 names only the holder's id: once the server says it is a generation, show it as one.
          if (run.kind !== running.kind) { setRunning(run); return; }
          timer = setTimeout(() => { void tick(); }, POLL_MS);
          return;
        }
        setRunning(null);
        await loadResults();
        void loadRuns();
        // A generation's end is told by ReportGeneration (its progress and toast).
        if (run.kind === "generate") return;
        // L2: Check doc re-reading catalog metrics says how it went itself (the Doc changed banner).
        if (run.queryKeys?.[0] === PAGE_METRICS_RUN_MARKER) return;
        if (run.status === "succeeded") notify.success(run.queryKeys?.length ? "Query re-ran" : "Report refreshed");
        else if (run.status === "partial") notify.warning(`Refreshed with errors: ${run.error ?? "some queries failed"}. Their blocks keep the last good result.`);
        else notify.error(`The refresh ${run.status === "abandoned" ? "stopped" : "failed"}${run.error ? `: ${run.error}` : ""}`);
      } catch {
        if (alive.current) timer = setTimeout(() => { void tick(); }, POLL_MS * 3);
      }
    };
    timer = setTimeout(() => { void tick(); }, POLL_MS);
    return () => { if (timer) clearTimeout(timer); };
  }, [initial, loadResults, loadRuns, report.id, running]);

  async function startRefresh(queryKey?: string) {
    if (running || generating) return;
    try {
      const { run } = await refreshReport(report.id, queryKey);
      setRunning(run);
    } catch (reason) {
      const { code } = codeOf(reason);
      const holder = reason && typeof reason === "object" && "payload" in reason ? (reason as { payload?: { runId?: string } }).payload?.runId : undefined;
      if (code === "RUN_IN_PROGRESS") {
        notify.info("This report is already running; it reloads when the run ends");
        if (holder) setRunning({ id: holder, reportId: report.id, kind: "refresh", trigger: "user", status: "running", agentRunId: null, docSnapshotId: null, queryKeys: null, startedAt: new Date().toISOString(), finishedAt: null, error: null });
      } else notify.error(messageOf(reason, "Could not start the refresh"));
    }
  }

  const results = useMemo(() => new Map((view?.results ?? []).map((item) => [item.queryKey, item])), [view]);
  const queries = useMemo(() => new Map(report.spec.queries.map((query) => [query.key, query])), [report.spec.queries]);
  const blocks = report.spec.blocks;
  const inspected = inspect ? blocks.find((block) => block.id === inspect.blockId) : undefined;
  const menuTarget = menuBlock ? blocks.find((block) => block.id === menuBlock) : undefined;
  const badge = scheduleBadge(schedule);
  const staleCount = [...results.values()].filter((item) => item.stale || (!item.result && item.failed)).length;
  const lastRun = runs.find((run) => run.status !== "running");
  const layout = useMemo(() => reportLayout(report.spec), [report.spec]);
  const cssVars = useMemo(() => reportCssVariables(palette.mode) as React.CSSProperties, [palette.mode]);
  const lookup = useCallback<ResultLookup>((key) => results.get(key)?.result ?? null, [results]);
  const markdownContext = useMemo<RenderContext>(() => ({ onExternalLink: setExternalLink, onNookLink: (path) => window.location.assign(path), images: { mode: "public" } }), []);

  // A refresh, a re-run, or a generation (starting or running) holds the report: nothing else starts.
  const busy = Boolean(running) || generating;
  // On the report page, Refresh all and Schedule live in the page header (reportCommands.tsx).
  const inHeader = useHeaderActions();
  useRegisterReportCommands({
    refreshAll: canWrite ? { run: () => { void startRefresh(); }, busy: busy, disabled: busy || !report.spec.queries.length } : null,
    schedule: { open: () => setScheduleOpen(true), badge: badge?.text ?? null }
  }, readOnly ? [] : ["refreshAll", "schedule"]);

  const card = (block: DataBlock) => <DataBlockCard key={block.id} block={block} view={results.get(block.queryKey)} hasQuery={queries.has(block.queryKey)} palette={palette}
    running={running} loaded={view !== null} lookup={lookup} readOnly={readOnly} pending={Boolean(pending?.includes(block.queryKey))} filtered={withParams}
    onInspect={() => setInspect({ blockId: block.id, tab: "query" })} onMenu={() => setMenuBlock(block.id)} />;

  if (!blocks.length) return null;
  return <section className={`report-view report-theme-${palette.mode}`} style={cssVars} aria-label="Report">
    {withParams && <ReportParamsBar reportId={report.id} parameters={parameters} values={values} busy={Boolean(pending)} onChange={changeParams} />}
    {!readOnly && <div className="report-view-toolbar">
      <p className="report-view-status" role="status">
        {busy ? <span className="report-view-running"><LoaderCircle className="spin" aria-hidden="true" />{!running || running.kind === "generate" ? "Generating…" : previewVersionOf(running.queryKeys) !== null ? `Running v${previewVersionOf(running.queryKeys)} on today's data…` : running.queryKeys?.[0] === PAGE_METRICS_RUN_MARKER ? "Re-reading metrics…" : running.queryKeys?.length ? `Re-running ${running.queryKeys.join(", ")}…` : "Refreshing…"}</span>
          : <span><Clock3 aria-hidden="true" />{report.lastRunAt ? `Updated ${timeAgo(lastRun?.finishedAt ?? report.lastRunAt)}` : "Not refreshed yet"}</span>}
        {staleCount > 0 && <span className="reports-status reports-status-stale">{`${staleCount} stale`}</span>}
        {badge && <span className={`reports-status reports-status-${badge.tone}`}><CalendarClock aria-hidden="true" />{badge.text}</span>}
      </p>
      {!inHeader && <div className="report-view-actions">
        <button type="button" className="secondary-button" onClick={() => setScheduleOpen(true)}><CalendarClock aria-hidden="true" />Schedule</button>
        {canWrite && <button type="button" className="primary-button" onClick={() => { void startRefresh(); }} disabled={busy || !report.spec.queries.length}>
          {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}Refresh all
        </button>}
      </div>}
    </div>}
    {loadError && <p className="form-error" role="alert">{loadError} <button type="button" className="secondary-button" onClick={() => { void loadResults(); }}>Try again</button></p>}
    {layout.narrative.map((block) => <div key={block.id} className="report-narrative">
      {block.title && <h2 className="report-narrative-title">{block.title}</h2>}
      <div className="report-markdown"><Markdown text={block.markdown} context={markdownContext} /></div>
    </div>)}
    {layout.strip.length > 0 && <div className="report-kpi-area" role="group" aria-label="Key figures">
      {/* The one hero figure takes its own row; the other KPIs share the strip evenly (each at least 150 px). */}
      {layout.strip.filter((block) => block.hero).map((block) => card(block))}
      {layout.strip.some((block) => !block.hero) && <div className="report-kpi-strip">{layout.strip.filter((block) => !block.hero).map((block) => card(block))}</div>}
    </div>}
    {layout.sections.map((section) => <section key={section.id ?? "_"} className="report-section" aria-label={section.title ?? undefined}>
      {section.title && <h2 className="report-section-title">{section.title}</h2>}
      {section.summary && <p className="report-section-summary">{section.summary}</p>}
      <div className="report-grid">
        {section.blocks.map((block) => block.type === "markdown"
          ? <article key={block.id} className={`report-block report-block-markdown ${widthClass(block)}`}>
            {block.title && <h3 className="report-block-title">{block.title}</h3>}
            <div className="report-markdown"><Markdown text={block.markdown} context={markdownContext} /></div>
          </article>
          : card(block))}
      </div>
    </section>)}
    {menuTarget && isDataBlock(menuTarget) && <BlockMenu block={menuTarget} canWrite={canWrite} busy={busy}
      onClose={() => setMenuBlock(null)}
      onInspect={(tab) => { setMenuBlock(null); setInspect({ blockId: menuTarget.id, tab }); }}
      onRerun={() => { setMenuBlock(null); void startRefresh(menuTarget.queryKey); }} />}
    {inspected && isDataBlock(inspected) && <InspectSheet report={report} block={inspected} query={queries.get(inspected.queryKey)} view={results.get(inspected.queryKey)}
      palette={palette} canRerun={canWrite} busy={busy} onRerun={(key) => { void startRefresh(key); }} initialTab={inspect!.tab} layerKey={`reports.inspect:${inspected.id}:${inspect!.tab}`} onClose={() => setInspect(null)} reopen={() => setInspect(lastInspect.current)} />}
    {scheduleOpen && <ScheduleSheet reportId={report.id} schedule={schedule} runs={runs} canWrite={canWrite} reopen={() => setScheduleOpen(true)}
      onSaved={(next) => { setSchedule(next); setScheduleOpen(false); notify.success(next.enabled ? "Schedule saved" : "Schedule off"); }} onClose={() => setScheduleOpen(false)} />}
    {externalLink && <ExternalLinkSheet href={externalLink} onClose={() => setExternalLink(null)} />}
  </section>;
}

type CardProps = {
  block: DataBlock;
  view: QueryResultView | undefined;
  hasQuery: boolean;
  palette: ChartPalette;
  running: ReportRun | null;
  loaded: boolean;
  /** Other queries' results (KPI comparisons and sparklines). */
  lookup?: ResultLookup;
  onInspect: () => void;
  onMenu: () => void;
  /** Lane J: a past version's view: no inspect or menu buttons, and this text where a query has no stored result. */
  readOnly?: { emptyText: string };
  /** D489: its query is running for the parameter set on show (the block keeps its last rows, dimmed). */
  pending?: boolean;
  /** D489: the report has parameters (an empty result is "no rows for these filters"). */
  filtered?: boolean;
};

/** One chart, KPI, or table: its title, stale/error badges, the inspect and menu buttons, and the body. */
export function DataBlockCard({ block, view, hasQuery, palette, running, loaded, lookup, onInspect, onMenu, readOnly, pending = false, filtered = false }: CardProps) {
  const result = view?.result ?? null;
  const failed = view?.failed ?? null;
  const rerunning = pending || Boolean(running && (!running.queryKeys || running.queryKeys.includes(block.queryKey)));
  const title = block.title ?? (block.type === "kpi" ? block.label ?? block.column : block.queryKey);
  return <article className={`report-block report-block-${block.type} ${widthClass(block)}${block.type === "kpi" && block.hero ? " report-block-hero" : ""}${pending ? " report-block-pending" : ""}`} aria-label={title} aria-busy={pending || undefined}>
    <header className="report-block-head">
      <h3 className="report-block-title">{title}</h3>
      <span className="report-block-badges">
        {rerunning && <LoaderCircle className="spin report-block-spinner" aria-label="Running" />}
        {view?.stale && <span className="reports-status reports-status-stale" title={failed ? `The last run failed: ${failed.error ?? ""}` : "The query changed since this result"}>Stale</span>}
        {!result && failed && <span className="reports-status reports-status-error">Error</span>}
      </span>
      {!readOnly && <span className="report-block-buttons">
        <button type="button" className="icon-button report-block-button" onClick={onInspect} aria-label={`How was ${title} built`} title="How was this built"><ScanSearch /></button>
        <button type="button" className="icon-button report-block-button" onClick={onMenu} aria-label={`More for ${title}`} aria-haspopup="dialog"><MoreHorizontal /></button>
      </span>}
    </header>
    <div className="report-block-body">
      {!hasQuery ? <p className="report-block-problem">This block names a query the report does not have ({block.queryKey}).</p>
        // D489: a chart or table with no rows for the chosen filters says so (not a mapping problem).
        : result && filtered && !result.rows.length && block.type !== "kpi" ? <p className="report-block-empty">No rows for these filters.</p>
        : result ? <BlockBody block={block} result={result} palette={palette} lookup={lookup} />
          : failed ? <p className="report-block-problem"><TriangleAlert aria-hidden="true" />{failed.error ?? "The query failed"}</p>
            : <p className="report-block-empty">{readOnly ? readOnly.emptyText : loaded ? "No results yet. Refresh the report to run its queries." : "Loading…"}</p>}
    </div>
    {view?.stale && failed && result && <p className="report-block-note">Showing results from {timeAgo(result.createdAt)}; the last run failed.</p>}
  </article>;
}

function BlockBody({ block, result, palette, lookup }: { block: DataBlock; result: ReportResult; palette: ChartPalette; lookup?: ResultLookup }) {
  if (block.type === "kpi") return <KpiTile block={block} result={result} lookup={lookup} />;
  if (block.type === "table") return <ResultTable columns={result.columns} rows={result.rows} show={block.columns} formats={block.formats} label={block.title ?? block.queryKey} />;
  return <ChartBody block={block} result={result} palette={palette} />;
}

/** The width of an element, re-read when it resizes (small multiples and heatmaps lay out by their tile's width). */
function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number | undefined] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    // Panel columns change at 520 and 800 px; round so a resize does not rebuild the option on every pixel.
    const read = () => setWidth((current) => {
      const next = Math.round(element.clientWidth / 8) * 8;
      return next > 0 && next !== current ? next : current;
    });
    read();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function ChartBody({ block, result, palette }: { block: ChartBlock; result: ReportResult; palette: ChartPalette }) {
  const [box, width] = useElementWidth<HTMLDivElement>();
  const built = useMemo(() => buildChartOption(block, result, palette, { width }), [block, result, palette, width]);
  const label = `${block.title ?? block.queryKey}: ${block.kind.replace("_", " ")} chart of ${block.y.join(", ")}${block.x && block.x !== block.y[0] ? ` by ${block.x}` : ""}`;
  return <div ref={box} className={`report-chart report-chart-${block.kind}`}>
    {!built.option || built.problems.length ? <ul className="report-block-problem">{built.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
      : built.view === "meter" ? <MeterView model={built.option as unknown as MeterModel} label={label} />
        : <ChartCanvas built={built} label={label} mode={palette.mode} />}
    {built.cutRows > 0 && <p className="report-block-note">Showing the first {(result.rows.length - built.cutRows).toLocaleString()} rows; the Data tab has them all.</p>}
  </div>;
}

/** The ECharts canvas; a heatmap or calendar wider than its tile scrolls sideways inside the tile, never the page. */
function ChartCanvas({ built, label, mode }: { built: ChartBuild; label: string; mode: ChartPalette["mode"] }) {
  const canvas = <Suspense fallback={<div className="report-chart-canvas report-chart-loading" role="status" style={{ height: built.height }}>Loading chart…</div>}>
    <EChart option={built.option!} mode={mode} height={built.height} minWidth={built.minWidth} label={label} />
  </Suspense>;
  return <>
    {built.minWidth ? <div className="report-chart-scroll" tabIndex={0} role="group" aria-label={`${label} (scrolls sideways)`}>{canvas}</div> : canvas}
    {built.scale && <ScaleLegend steps={built.scale} />}
  </>;
}

/** A stepped colour scale (low → high) under a value-coloured chart: a swatch row and the low and high values. */
export function ScaleLegend({ steps }: { steps: NonNullable<ChartBuild["scale"]> }) {
  const low = steps[0]?.from ?? "";
  const high = steps[steps.length - 1]?.to ?? "";
  return <div className="report-scale" aria-label={`Colour scale from ${low} to ${high}`}>
    <span className="report-scale-end">{low}</span>
    <span className="report-scale-steps" aria-hidden="true">{steps.map((step, at) => <span key={at} style={{ background: step.color }} title={step.label} />)}</span>
    <span className="report-scale-end">{high}</span>
  </div>;
}

const STATUS_ICONS = { check: CircleCheck, alert: TriangleAlert, cross: CircleX } as const;

/** The gauge kind: a meter (value, a same-ramp track, the target's tick) with a status that always shows an icon and a label. */
export function MeterView({ model, label }: { model: MeterModel; label: string }) {
  const Icon = model.status ? STATUS_ICONS[model.status.icon] : null;
  return <div className="report-meter" role="img" aria-label={`${label}: ${model.valueText}, ${model.caption}${model.status ? `, ${model.status.label}` : ""}`}>
    <div className="report-meter-head">
      <span className="report-meter-value">{model.valueText}</span>
      {model.status && Icon && <span className={`report-meter-status report-meter-${model.status.tone}`}><Icon aria-hidden="true" style={{ color: model.status.color }} />{model.status.label}</span>}
    </div>
    <div className="report-meter-track" style={{ background: model.track }}>
      <span className="report-meter-fill" style={{ width: `${(model.ratio * 100).toFixed(2)}%`, background: model.fill }} />
      {model.targetRatio !== null && <span className="report-meter-target" style={{ left: `${(model.targetRatio * 100).toFixed(2)}%` }} />}
    </div>
    <p className="report-meter-caption">{model.caption}</p>
  </div>;
}

export function BlockMenu({ block, canWrite, busy, onClose, onInspect, onRerun }: { block: DataBlock; canWrite: boolean; busy: boolean; onClose: () => void; onInspect: (tab: InspectTab) => void; onRerun: () => void }) {
  useHistoryDialogGuard(true, onClose);
  const title = block.title ?? block.queryKey;
  return <ModalDialog title={title} eyebrow="Block" onClose={onClose} variant="sheet" className="reports-dialog report-block-menu">
    <div className="report-menu-list" role="menu" aria-label={`Actions for ${title}`}>
      <button type="button" role="menuitem" onClick={() => onInspect("query")}><ScanSearch aria-hidden="true" />How was this built</button>
      <button type="button" role="menuitem" onClick={() => onInspect("data")}><ScanSearch aria-hidden="true" />View data</button>
      {canWrite && <button type="button" role="menuitem" onClick={onRerun} disabled={busy}><RefreshCw aria-hidden="true" />{busy ? "A run is in progress" : "Re-run this query"}</button>}
      {/* Wave 48: a comment on this block opens the Changes panel aimed at it (only for those who may comment). */}
      <CommentOnBlockButton blockId={block.id} className="report-menu-comment" onBefore={onClose} />
    </div>
  </ModalDialog>;
}

function ExternalLinkSheet({ href, onClose }: { href: string; onClose: () => void }) {
  useHistoryDialogGuard(true, onClose);
  let host = href;
  try { host = new URL(href).host; } catch { /* shown as is */ }
  return <ModalDialog title={`Open ${host}?`} eyebrow="Link" onClose={onClose} variant="sheet" className="reports-dialog">
    <div className="file-dialog-form">
      <p className="report-link-full"><code>{href}</code></p>
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
        <a className="primary-button report-link-open" href={href} target="_blank" rel="noopener noreferrer" onClick={onClose}><ExternalLink aria-hidden="true" />Open</a>
      </footer>
    </div>
  </ModalDialog>;
}
