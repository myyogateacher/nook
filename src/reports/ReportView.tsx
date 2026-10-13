import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Clock3, ExternalLink, LoaderCircle, MoreHorizontal, RefreshCw, ScanSearch, TriangleAlert } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { Markdown, type RenderContext } from "../chat/markdown/render";
import { notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { ChartBlock, ReportBlock, ReportDetail, ReportRun } from "../../shared/reports";
import type { QueryResultView, ReportResultsView, ScheduleView } from "../../shared/reportsView";
import { buildChartOption, themedPalette, type ChartPalette } from "./chartOption";
import { InspectSheet, type DataBlock } from "./InspectSheet";
import type { InspectTab } from "./inspectHistory";
import { KpiTile } from "./KpiTile";
import { ResultTable } from "./ResultTable";
import { getResults, getRun, listRuns, refreshReport, RUN_STATUS_TEXT, timeAgo } from "./reportViewApi";
import { codeOf, messageOf } from "./reportsApi";
import { scheduleBadge, ScheduleSheet } from "./ScheduleSheet";
import "./reportView.css";

/** ECharts and its option renderer load only when a report with a chart opens (charts.tsx). */
const EChart = lazy(() => import("./charts"));

const POLL_MS = 1000;

/**
 * The chart palette from the page's one theme source (review L4): the root's `color-scheme` (what the
 * app's CSS sets, src/styles.css) picks the series steps, and the report view's own resolved tokens
 * (reportView.css, built on the app's variables) give the surface, text, grid, and tooltip colors.
 */
export function readChartPalette(element: Element | null): ChartPalette {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return themedPalette("dark");
  try {
    const scheme = getComputedStyle(document.documentElement).colorScheme;
    if (!element) return themedPalette(scheme);
    const css = getComputedStyle(element);
    const token = (name: string) => css.getPropertyValue(name).trim();
    return themedPalette(scheme, {
      surface: token("--report-surface"), text: css.color, muted: token("--report-muted"), grid: token("--report-border"),
      axis: token("--report-border"), tooltipBg: token("--report-raised"), tooltipBorder: token("--report-border")
    });
  } catch {
    return themedPalette("dark");
  }
}

/** Re-reads the palette whenever the theme can have changed: the root's attributes or style, or the OS scheme. */
function useChartPalette(ref: React.RefObject<HTMLElement | null>): ChartPalette {
  const [palette, setPalette] = useState<ChartPalette>(() => readChartPalette(null));
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const update = () => setPalette((current) => {
      const next = readChartPalette(ref.current);
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
    update();
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    observer?.observe(document.documentElement, { attributes: true });
    if (document.body) observer?.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    media?.addEventListener?.("change", update);
    return () => { observer?.disconnect(); media?.removeEventListener?.("change", update); };
  }, [ref]);
  return palette;
}

const isDataBlock = (block: ReportBlock): block is DataBlock => block.type !== "markdown";

type Props = {
  report: ReportDetail;
  canWrite: boolean;
  /** Tests and server-side rendering: the results to show without a request. */
  initial?: { results: ReportResultsView; schedule?: ScheduleView | null; runs?: ReportRun[] };
};

/**
 * The report viewer (plan wave 47): the spec's blocks over their latest results, one column on a phone
 * and two from 768 px; markdown through the chat's sanitized renderer; charts drawn by ECharts from
 * options Nook builds (chartOption.ts). Every chart, KPI, and table has an inspect button ("How was
 * this built") and a menu with "Re-run this query"; the toolbar has "Refresh all" and the schedule.
 * A refresh is a run: the page polls it and reloads the results when it ends.
 */
export function ReportView({ report, canWrite, initial }: Props) {
  const [view, setView] = useState<ReportResultsView | null>(initial?.results ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState<ReportRun | null>(initial?.results.running ?? null);
  const [schedule, setSchedule] = useState<ScheduleView | null>(initial?.schedule ?? null);
  const [runs, setRuns] = useState<ReportRun[]>(initial?.runs ?? []);
  const [inspect, setInspect] = useState<{ blockId: string; tab: InspectTab } | null>(null);
  const [menuBlock, setMenuBlock] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [externalLink, setExternalLink] = useState<string | null>(null);
  const viewRef = useRef<HTMLElement>(null);
  const palette = useChartPalette(viewRef);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const loadResults = useCallback(async () => {
    try {
      const next = await getResults(report.id);
      if (!alive.current) return null;
      setView(next);
      setLoadError(null);
      return next;
    } catch (reason) {
      if (alive.current) setLoadError(messageOf(reason, "Could not load the results"));
      return null;
    }
  }, [report.id]);
  const loadRuns = useCallback(async () => {
    try {
      const history = await listRuns(report.id);
      if (!alive.current) return;
      setRuns(history.runs);
      setSchedule(history.schedule);
    } catch { /* the toolbar works without the history */ }
  }, [report.id]);

  useEffect(() => {
    if (initial) return;
    void loadResults().then((next) => { if (next?.running) setRunning(next.running); });
    void loadRuns();
  }, [initial, loadResults, loadRuns]);

  // While a run goes: poll it, then reload the results and say how it went.
  useEffect(() => {
    if (!running || running.status !== "running" || initial) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const { run } = await getRun(report.id, running.id);
        if (!alive.current) return;
        if (run.status === "running") { timer = setTimeout(() => { void tick(); }, POLL_MS); return; }
        setRunning(null);
        await loadResults();
        void loadRuns();
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
    if (running) return;
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
  const markdownContext = useMemo<RenderContext>(() => ({ onExternalLink: setExternalLink, onNookLink: (path) => window.location.assign(path), images: { mode: "public" } }), []);

  if (!blocks.length) return null;
  return <section ref={viewRef} className="report-view" aria-label="Report">
    <div className="report-view-toolbar">
      <p className="report-view-status" role="status">
        {running ? <span className="report-view-running"><LoaderCircle className="spin" aria-hidden="true" />{running.queryKeys?.length ? `Re-running ${running.queryKeys.join(", ")}…` : "Refreshing…"}</span>
          : <span><Clock3 aria-hidden="true" />{report.lastRunAt ? `Updated ${timeAgo(lastRun?.finishedAt ?? report.lastRunAt)}` : "Not refreshed yet"}</span>}
        {staleCount > 0 && <span className="reports-status reports-status-stale">{`${staleCount} stale`}</span>}
        {badge && <span className={`reports-status reports-status-${badge.tone}`}><CalendarClock aria-hidden="true" />{badge.text}</span>}
      </p>
      <div className="report-view-actions">
        <button type="button" className="secondary-button" onClick={() => setScheduleOpen(true)}><CalendarClock aria-hidden="true" />Schedule</button>
        {canWrite && <button type="button" className="primary-button" onClick={() => { void startRefresh(); }} disabled={Boolean(running) || !report.spec.queries.length}>
          {running ? <LoaderCircle className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}Refresh all
        </button>}
      </div>
    </div>
    {loadError && <p className="form-error" role="alert">{loadError} <button type="button" className="secondary-button" onClick={() => { void loadResults(); }}>Try again</button></p>}
    <div className="report-grid">
      {blocks.map((block) => block.type === "markdown"
        ? <article key={block.id} className="report-block report-block-wide report-block-markdown">
          {block.title && <h3 className="report-block-title">{block.title}</h3>}
          <div className="report-markdown"><Markdown text={block.markdown} context={markdownContext} /></div>
        </article>
        : <DataBlockCard key={block.id} block={block} view={results.get(block.queryKey)} hasQuery={queries.has(block.queryKey)} palette={palette}
          running={running} loaded={view !== null}
          onInspect={() => setInspect({ blockId: block.id, tab: "query" })} onMenu={() => setMenuBlock(block.id)} />)}
    </div>
    {menuTarget && isDataBlock(menuTarget) && <BlockMenu block={menuTarget} canWrite={canWrite} busy={Boolean(running)}
      onClose={() => setMenuBlock(null)}
      onInspect={(tab) => { setMenuBlock(null); setInspect({ blockId: menuTarget.id, tab }); }}
      onRerun={() => { setMenuBlock(null); void startRefresh(menuTarget.queryKey); }} />}
    {inspected && isDataBlock(inspected) && <InspectSheet report={report} block={inspected} query={queries.get(inspected.queryKey)} view={results.get(inspected.queryKey)}
      palette={palette} canRerun={canWrite} busy={Boolean(running)} onRerun={(key) => { void startRefresh(key); }} initialTab={inspect!.tab} onClose={() => setInspect(null)} />}
    {scheduleOpen && <ScheduleSheet reportId={report.id} schedule={schedule} runs={runs} canWrite={canWrite}
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
  onInspect: () => void;
  onMenu: () => void;
};

/** One chart, KPI, or table: its title, stale/error badges, the inspect and menu buttons, and the body. */
export function DataBlockCard({ block, view, hasQuery, palette, running, loaded, onInspect, onMenu }: CardProps) {
  const result = view?.result ?? null;
  const failed = view?.failed ?? null;
  const rerunning = Boolean(running && (!running.queryKeys || running.queryKeys.includes(block.queryKey)));
  const title = block.title ?? (block.type === "kpi" ? block.label ?? block.column : block.queryKey);
  const wide = block.type === "table";
  return <article className={`report-block report-block-${block.type}${wide ? " report-block-wide" : ""}`} aria-label={title}>
    <header className="report-block-head">
      <h3 className="report-block-title">{title}</h3>
      <span className="report-block-badges">
        {rerunning && <LoaderCircle className="spin report-block-spinner" aria-label="Running" />}
        {view?.stale && <span className="reports-status reports-status-stale" title={failed ? `The last run failed: ${failed.error ?? ""}` : "The query changed since this result"}>Stale</span>}
        {!result && failed && <span className="reports-status reports-status-error">Error</span>}
      </span>
      <span className="report-block-buttons">
        <button type="button" className="icon-button report-block-button" onClick={onInspect} aria-label={`How was ${title} built`} title="How was this built"><ScanSearch /></button>
        <button type="button" className="icon-button report-block-button" onClick={onMenu} aria-label={`More for ${title}`} aria-haspopup="dialog"><MoreHorizontal /></button>
      </span>
    </header>
    <div className="report-block-body">
      {!hasQuery ? <p className="report-block-problem">This block names a query the report does not have ({block.queryKey}).</p>
        : result ? <BlockBody block={block} result={result} palette={palette} />
          : failed ? <p className="report-block-problem"><TriangleAlert aria-hidden="true" />{failed.error ?? "The query failed"}</p>
            : <p className="report-block-empty">{loaded ? "No results yet. Refresh the report to run its queries." : "Loading…"}</p>}
    </div>
    {view?.stale && failed && result && <p className="report-block-note">Showing results from {timeAgo(result.createdAt)}; the last run failed.</p>}
  </article>;
}

function BlockBody({ block, result, palette }: { block: DataBlock; result: NonNullable<QueryResultView["result"]>; palette: ChartPalette }) {
  if (block.type === "kpi") return <KpiTile block={block} result={result} />;
  if (block.type === "table") return <ResultTable columns={result.columns} rows={result.rows} show={block.columns} formats={block.formats} label={block.title ?? block.queryKey} />;
  return <ChartBody block={block} result={result} palette={palette} />;
}

function ChartBody({ block, result, palette }: { block: ChartBlock; result: NonNullable<QueryResultView["result"]>; palette: ChartPalette }) {
  const built = useMemo(() => buildChartOption(block, result, palette), [block, result, palette]);
  if (!built.option || built.problems.length) return <ul className="report-block-problem">{built.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>;
  return <div className={`report-chart report-chart-${block.kind}`}>
    <Suspense fallback={<div className="report-chart-canvas report-chart-loading" role="status">Loading chart…</div>}>
      <EChart option={built.option} label={`${block.title ?? block.queryKey}: ${block.kind.replace("_", " ")} chart of ${block.y.join(", ")} by ${block.x}`} />
    </Suspense>
    {built.cutRows > 0 && <p className="report-block-note">Showing the first {(result.rows.length - built.cutRows).toLocaleString()} rows; the Data tab has them all.</p>}
  </div>;
}

function BlockMenu({ block, canWrite, busy, onClose, onInspect, onRerun }: { block: DataBlock; canWrite: boolean; busy: boolean; onClose: () => void; onInspect: (tab: InspectTab) => void; onRerun: () => void }) {
  useHistoryDialogGuard(true, onClose);
  const title = block.title ?? block.queryKey;
  return <ModalDialog title={title} eyebrow="Block" onClose={onClose} variant="sheet" className="reports-dialog report-block-menu">
    <div className="report-menu-list" role="menu" aria-label={`Actions for ${title}`}>
      <button type="button" role="menuitem" onClick={() => onInspect("query")}><ScanSearch aria-hidden="true" />How was this built</button>
      <button type="button" role="menuitem" onClick={() => onInspect("data")}><ScanSearch aria-hidden="true" />View data</button>
      {canWrite && <button type="button" role="menuitem" onClick={onRerun} disabled={busy}><RefreshCw aria-hidden="true" />{busy ? "A run is in progress" : "Re-run this query"}</button>}
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
