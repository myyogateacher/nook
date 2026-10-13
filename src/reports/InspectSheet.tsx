import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Copy, Download, LoaderCircle, RefreshCw } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { registerHistoryDialogGuard } from "../historyDialogs";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { AutoFix, ChartBlock, KpiBlock, ReportBlock, ReportDetail, ReportQuery, ReportResult, TableBlock } from "../../shared/reports";
import type { ProvenanceView, QueryResultView } from "../../shared/reportsView";
import { AUTO_FIX_TEXT, buildChartOption, chartMapping, optionJson, type ChartPalette } from "./chartOption";
import { kpiCompare } from "./KpiTile";
import { createInspectTabHistory, INSPECT_TAB_LABELS, INSPECT_TABS, type InspectTab } from "./inspectHistory";
import { ResultTable } from "./ResultTable";
import { CommentOnBlockButton } from "./reportComment";
import { getProvenance, RUN_STATUS_TEXT, runLabel, timeAgo, toCsv } from "./reportViewApi";
import { countLabel, messageOf } from "./reportsApi";

export type DataBlock = KpiBlock | ChartBlock | TableBlock;

type Props = {
  report: Pick<ReportDetail, "id" | "title" | "doc">;
  block: DataBlock;
  query: ReportQuery | undefined;
  view: QueryResultView | undefined;
  palette: ChartPalette;
  canRerun: boolean;
  /** The report's run in progress (Re-run waits for it). */
  busy: boolean;
  onRerun: (queryKey: string) => void;
  onClose: () => void;
  initialTab?: InspectTab;
  /** Tests: the Provenance tab's answer without a request. */
  provenance?: ProvenanceView;
};

/** The columns a block maps, by role (highlighted in the Data tab). */
export function blockMapping(block: DataBlock): Record<string, string> {
  if (block.type === "chart") return chartMapping(block);
  if (block.type === "kpi") {
    const compare = kpiCompare(block);
    return { [block.column]: "value", ...(compare && !compare.queryKey ? { [compare.column]: "compare" } : {}) };
  }
  return Object.fromEntries((block.columns ?? []).map((name) => [name, "shown"]));
}

const blockKindLabel = (block: DataBlock) => block.type === "chart" ? `Chart (${block.kind.replace("_", " ")})` : block.type === "kpi" ? "KPI tile" : "Table";

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function downloadCsv(name: string, result: Pick<ReportResult, "columns" | "rows">) {
  const url = URL.createObjectURL(new Blob([toCsv(result.columns, result.rows)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "result"}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** An http(s) doc reference is a link; anything else (an id, a path) is shown as text. */
export function docLink(ref: string | null | undefined): string | null {
  if (!ref) return null;
  try {
    const url = new URL(ref);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return <button type="button" className="secondary-button report-copy" onClick={() => { void copy(text).then(setCopied); }}>
    <Copy aria-hidden="true" />{copied === true ? "Copied" : copied === false ? "Copy failed" : label}
  </button>;
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return <div><dt>{term}</dt><dd>{children}</dd></div>;
}

/**
 * "How was this built" (plan wave 47, user request): one block's query, data, mapping, and provenance.
 * Each tab is a real history step (inspectHistory.ts): Back and Forward move through the tabs; Back
 * from the first one closes the sheet.
 */
export function InspectSheet({ report, block, query, view, palette, canRerun, busy, onRerun, onClose, initialTab = "query", provenance: given }: Props) {
  const [shownTab, setShownTab] = useState<{ tab: InspectTab; step: number }>({ tab: initialTab, step: 0 });
  const tab = shownTab.tab;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [tabs] = useState(() => createInspectTabHistory({
    history: typeof window === "undefined" ? { state: null, pushState: () => undefined, go: () => undefined } : window.history,
    href: () => window.location.href,
    initialTab,
    show: (next, step) => setShownTab({ tab: next, step }),
    close: () => onCloseRef.current()
  }));
  // Back from the first tab: the sheet's own layer closes (no tab entry is left above it then).
  useHistoryDialogGuard(true, onClose);
  // Registered after the sheet's guard, so the tabs answer Back and Forward first.
  useEffect(() => registerHistoryDialogGuard((state) => tabs.guard(state)), [tabs]);
  const close = () => tabs.requestClose();

  const result = view?.result ?? null;
  const failed = view?.failed ?? null;
  const shown = result ?? failed;
  const mapping = blockMapping(block);
  const title = block.title ?? (block.type === "kpi" ? block.label ?? block.column : block.queryKey);

  const first = shownTab.step === 0;
  return <ModalDialog title={title} eyebrow="How was this built" onClose={close} variant="sheet" className="reports-dialog report-inspect">
    <div className="report-inspect-tabs" role="tablist" aria-label="Inspect">
      {/* Always laid out, so the tabs never move under a finger; hidden on the first step. */}
      <button type="button" className={`icon-button report-inspect-back${first ? " report-inspect-back-idle" : ""}`} disabled={first} aria-hidden={first || undefined}
        aria-label="Back to the previous tab" onClick={() => tabs.back()}><ChevronLeft /></button>
      {INSPECT_TABS.map((name) => <button key={name} type="button" role="tab" id={`inspect-tab-${name}`} aria-selected={tab === name} aria-controls="inspect-panel"
        className={tab === name ? "active" : undefined} onClick={() => tabs.select(name, tab)}>{INSPECT_TAB_LABELS[name]}</button>)}
    </div>
    <div className="report-inspect-body" role="tabpanel" id="inspect-panel" aria-labelledby={`inspect-tab-${tab}`}>
      {tab === "query" && <QueryTab block={block} query={query} result={result} failed={failed} canRerun={canRerun} busy={busy} onRerun={onRerun} />}
      {/* Wave 48: ask the edit agent to change this block (the report page decides whether the caller may). */}
      {tab === "query" && <div className="report-inspect-actions report-inspect-comment"><CommentOnBlockButton blockId={block.id} /></div>}
      {tab === "data" && (shown && shown.columns.length ? <section className="report-inspect-section">
        <p className="report-inspect-facts">
          <span>{countLabel(shown.rowCount)}{shown.truncated ? " (cut off at the stored limit)" : ""}</span>
          <span>Run {timeAgo(shown.createdAt)}</span>
          {Object.keys(mapping).length > 0 && <span>Highlighted: the columns this block maps</span>}
        </p>
        <ResultTable columns={shown.columns} rows={shown.rows} highlight={mapping} raw label={`Rows of ${block.queryKey}`} />
        <div className="report-inspect-actions"><button type="button" className="secondary-button" onClick={() => downloadCsv(`${report.title}-${block.queryKey}`, shown)}><Download aria-hidden="true" />Export CSV</button></div>
      </section> : <p className="report-inspect-empty">No rows yet: this query has not run successfully.</p>)}
      {tab === "mapping" && <MappingTab block={block} view={view} palette={palette} />}
      {tab === "provenance" && <ProvenanceTab report={report} block={block} given={given} />}
    </div>
  </ModalDialog>;
}

function QueryTab({ block, query, result, failed, canRerun, busy, onRerun }: { block: DataBlock; query: ReportQuery | undefined; result: ReportResult | null; failed: ReportResult | null; canRerun: boolean; busy: boolean; onRerun: (key: string) => void }) {
  const latest = failed && (!result || failed.createdAt >= result.createdAt) ? failed : result;
  return <section className="report-inspect-section">
    {!query && <p className="form-error">This block names the query <code>{block.queryKey}</code>, which the report does not have.</p>}
    {query?.purpose && <p className="report-inspect-purpose">{query.purpose}</p>}
    <div className="report-inspect-head"><h3>SQL as saved</h3>{query && <CopyButton text={query.sql} label="Copy" />}</div>
    <pre className="report-code"><code>{query?.sql ?? "—"}</code></pre>
    <div className="report-inspect-head"><h3>SQL as sent</h3>{latest?.sentSql && <CopyButton text={latest.sentSql} label="Copy" />}</div>
    {latest?.sentSql ? <pre className="report-code"><code>{latest.sentSql}</code></pre> : <p className="report-inspect-empty">{latest ? "Nothing was sent: the guard refused it, or it never reached ClickHouse." : "Not run yet."}</p>}
    {latest && <dl className="report-facts-list">
      <Fact term="ClickHouse query id"><code>{latest.chQueryId ?? "—"}</code></Fact>
      <Fact term="Run time">{latest.ms === null ? "—" : `${latest.ms.toLocaleString()} ms`}</Fact>
      <Fact term="Rows read">{latest.rowsRead === null ? "—" : latest.rowsRead.toLocaleString()}</Fact>
      <Fact term="Rows returned">{latest.rowCount.toLocaleString()}</Fact>
      <Fact term="Truncated">{latest.truncated ? "Yes, more rows than the limit" : "No"}</Fact>
      <Fact term="Last run">{timeAgo(latest.createdAt)} <small>({new Date(latest.createdAt).toLocaleString()})</small></Fact>
      <Fact term="Written by">{query?.createdBy === "agent" ? "The AI" : "A person"}</Fact>
    </dl>}
    {failed && <div className="report-inspect-error" role="alert">
      <strong>{failed.errorCode ? <code>{failed.errorCode}</code> : null} The last run failed {timeAgo(failed.createdAt)}</strong>
      <p>{failed.error}</p>
      {result && <p>The block shows the last good result, from {timeAgo(result.createdAt)}.</p>}
    </div>}
    {canRerun && query && <div className="report-inspect-actions">
      <button type="button" className="primary-button" disabled={busy} onClick={() => onRerun(block.queryKey)}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}{busy ? "Running…" : "Re-run this query"}</button>
    </div>}
  </section>;
}

function MappingTab({ block, view, palette }: { block: DataBlock; view: QueryResultView | undefined; palette: ChartPalette }) {
  const shown = view?.result ?? null;
  const built = useMemo(() => block.type === "chart" && shown ? buildChartOption(block, shown, palette) : null, [block, shown, palette]);
  const mapping = blockMapping(block);
  return <section className="report-inspect-section">
    <dl className="report-facts-list">
      <Fact term="Block">{blockKindLabel(block)} <code>{block.id}</code></Fact>
      <Fact term="Query"><code>{block.queryKey}</code></Fact>
      {block.type === "chart" && <>
        <Fact term="x →"><code className="report-mapped">{block.x}</code></Fact>
        <Fact term="y →">{block.y.map((name) => <code key={name} className="report-mapped">{name}</code>)}</Fact>
        <Fact term="series →">{block.series ? <code className="report-mapped">{block.series}</code> : "—"}</Fact>
      </>}
      {block.type === "kpi" && <>
        <Fact term="value →"><code className="report-mapped">{block.column}</code></Fact>
        <Fact term="compare →">{kpiCompare(block) ? <code className="report-mapped">{kpiCompare(block)!.queryKey ? `${kpiCompare(block)!.queryKey}.` : ""}{kpiCompare(block)!.column}</code> : "—"}</Fact>
        {block.sparkline && <Fact term="sparkline →"><code>{block.sparkline.queryKey}</code> {block.sparkline.y} by {block.sparkline.x}</Fact>}
      </>}
      {block.type === "table" && <Fact term="columns →">{block.columns?.length ? block.columns.map((name) => <code key={name} className="report-mapped">{name}</code>) : "every column"}</Fact>}
      <Fact term="intent · width">{block.intent ?? "—"} · {block.width ?? "default"}{block.section ? <> · section <code>{block.section}</code></> : null}</Fact>
      {block.type !== "table" && (block.unit || (block.type === "chart" && block.emphasis !== undefined)) && <Fact term="unit · emphasis">{block.unit ?? "—"} · {block.type === "chart" && block.emphasis !== undefined ? block.emphasis : "—"}</Fact>}
      <Fact term="format">{block.type === "table" ? (block.formats && Object.keys(block.formats).length ? Object.entries(block.formats).map(([name, format]) => `${name}: ${format}`).join(", ") : "—") : block.format ?? "—"}</Fact>
    </dl>
    <AutoFixes recorded={block.autoFixes ?? []} live={built?.autoFixes ?? []} />
    {Object.keys(mapping).length > 0 && <p className="report-inspect-hint">The Data tab highlights {Object.keys(mapping).length === 1 ? "this column" : "these columns"}.</p>}
    {block.type === "chart" && <>
      <div className="report-inspect-head"><h3>ECharts option</h3>{built?.option && <CopyButton text={optionJson(built.option)} label="Copy" />}</div>
      <p className="report-inspect-hint">Built by Nook from the block above and the result (chartOption.ts); nothing in it comes from the AI.{built?.cutRows ? ` ${built.cutRows.toLocaleString()} rows past the chart's limit are left out.` : ""}{built?.foldedSeries ? ` ${built.foldedSeries} series fold into "Other".` : ""}</p>
      {built?.problems.length ? <ul className="form-error">{built.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : null}
      {built?.option ? <pre className="report-code report-option"><code>{optionJson(built.option)}</code></pre> : !shown ? <p className="report-inspect-empty">No result yet, so no option.</p> : null}
    </>}
    {block.type !== "chart" && <p className="report-inspect-hint">{block.type === "kpi" ? "A KPI tile is drawn by Nook directly, without ECharts." : "A table is drawn by Nook directly, without ECharts."}</p>}
  </section>;
}

/**
 * "Auto-fixed: …" (wave 48b, design rules 3 and 5, sorting, compaction): what this build of the chart
 * fixed for the current result, then any rule recorded when the spec was saved that no longer applies,
 * marked "at save" (review).
 */
export function AutoFixes({ recorded, live }: { recorded: readonly AutoFix[]; live: readonly AutoFix[] }) {
  const liveRules = new Set(live.map((fix) => fix.rule));
  const all = [...live.map((fix) => ({ fix, atSave: false })), ...recorded.filter((fix) => !liveRules.has(fix.rule)).map((fix) => ({ fix, atSave: true }))];
  if (!all.length) return null;
  const names = [...new Set(all.map(({ fix }) => AUTO_FIX_TEXT[fix.rule] ?? fix.rule))];
  return <div className="report-inspect-autofix">
    <p className="report-inspect-hint">Auto-fixed: {names.join(", ")}</p>
    <ul className="report-autofix-list" aria-label="Auto-fixes">{all.map(({ fix, atSave }) => <li key={`${atSave ? "s" : "l"}:${fix.rule}:${fix.detail}`}>
      <strong>{AUTO_FIX_TEXT[fix.rule] ?? fix.rule}:</strong> {fix.detail}{atSave && <em className="report-autofix-at-save"> · at save</em>}
    </li>)}</ul>
  </div>;
}

function ProvenanceTab({ report, block, given }: { report: Pick<ReportDetail, "id" | "doc">; block: ReportBlock; given?: ProvenanceView }) {
  const [state, setState] = useState<{ view: ProvenanceView | null; error: string | null }>({ view: given ?? null, error: null });
  const runId = block.provenance?.runId ?? null;
  const snapshotId = block.provenance?.docSnapshotId ?? null;
  useEffect(() => {
    if (given || (!runId && !snapshotId)) return;
    let live = true;
    getProvenance(report.id, { runId, snapshotId })
      .then((view) => { if (live) setState({ view, error: null }); })
      .catch((reason: unknown) => { if (live) setState({ view: null, error: messageOf(reason, "Could not load the provenance") }); });
    return () => { live = false; };
  }, [given, report.id, runId, snapshotId]);
  const run = state.view?.run ?? null;
  const snapshot = state.view?.snapshot ?? null;
  const link = docLink(report.doc?.ref);
  return <section className="report-inspect-section">
    <dl className="report-facts-list">
      <Fact term="Version">{block.provenance ? `v${block.provenance.version}` : "—"}</Fact>
      <Fact term="Made by">{!runId ? "Written by hand (no AI run)" : run ? <>{runLabel(run)} · {RUN_STATUS_TEXT[run.status]} · {timeAgo(run.startedAt)}<br /><code>{run.id}</code></> : state.error ? state.error : <code>{runId}</code>}</Fact>
      <Fact term="Instruction">{block.provenance?.instructionId ? <code>{block.provenance.instructionId}</code> : "—"}</Fact>
      <Fact term="Doc snapshot">{snapshot ? <>{snapshot.title ?? "Untitled doc"} · fetched {timeAgo(snapshot.fetchedAt)}<br /><code title={snapshot.sha256}>sha256 {snapshot.sha256.slice(0, 12)}…</code></> : snapshotId || run?.docSnapshotId ? "Snapshot no longer kept" : "—"}</Fact>
      <Fact term="Doc">{link ? <a href={link} target="_blank" rel="noopener noreferrer">{link}</a> : report.doc?.ref ? <code>{report.doc.ref}</code> : "No doc (the report was built by hand)"}</Fact>
    </dl>
  </section>;
}
