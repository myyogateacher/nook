import { useContext, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ArrowLeftRight, ChevronLeft, ChevronRight, Eye, GitCompareArrows, History, LoaderCircle, Play, RotateCcw } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { useLayerOpener } from "../historyDialogs";
import { notify } from "../ui/notify";
import { Select } from "../ui/Select";
import { useConfirm } from "../ui/useConfirm";
import { newLayerReopenMemory, useHistoryDialogGuard, useLayerReopen, type LayerReopenMemory } from "../ui/useHistoryDialogGuard";
import type { ReportDetail } from "../../shared/reports";
import { versionSourceLabel, versionWhoLabel, type DiffLine, type VersionDiff, type VersionHistoryItem, type VersionSnapshot } from "../../shared/reportVersions";
import { getVersion, getVersionDiff, listVersions, previewVersion, restoreVersion } from "./reportEditApi";
import { timeAgo } from "./reportViewApi";
import { codeOf, messageOf } from "./reportsApi";
import { ReportView } from "./ReportView";
import { ReportRunsContext } from "./RunsSheet";
import "./reportEdit.css";
import "./reportView.css";
import "./versions.css";

const exactTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

/** When: a relative time, the exact one in the tooltip. */
function When({ iso }: { iso: string }) {
  return <time dateTime={iso} title={exactTime(iso)}>{timeAgo(iso)}</time>;
}

/** "Open run": the Runs panel at the run that made the version (the owner's). */
function RunButton({ item, onRun }: { item: VersionHistoryItem; onRun: ((runId: string) => void) | null }) {
  if (!item.runId || !onRun) return null;
  return <button type="button" className="secondary-button report-vrow-run" onClick={() => onRun(item.runId!)}><History aria-hidden="true" />Open run</button>;
}

/** A version's facts: number and Current, the source in plain words, who and when, the instruction, the change line, the note, and the model. */
function VersionFacts({ item, heading = false }: { item: VersionHistoryItem; heading?: boolean }) {
  const Title = heading ? "h3" : "span";
  return <>
    <Title className="report-vrow-title">
      <strong>v{item.version}</strong>
      {item.current && <span className="reports-status reports-status-ready">Current</span>}
      <span className="report-vrow-source">{versionSourceLabel(item)}</span>
    </Title>
    <span className="report-vrow-who">{versionWhoLabel(item)} · <When iso={item.createdAt} /></span>
    {item.instructionText && <span className="report-vrow-ask">“{item.instructionText}”</span>}
    {item.changeSummary && <span className="report-vrow-change">{item.changeSummary}</span>}
    {item.note && !item.renamedTo && <span className="report-vrow-note">{item.note}</span>}
    {item.model && <span className="report-vrow-meta">Model {item.model}</span>}
  </>;
}

/** Lines of a diff, red and green, monospace; long unchanged runs fold to a count. Scrolls sideways, never wraps. */
export function DiffLines({ lines, label }: { lines: DiffLine[]; label: string }) {
  const folded = useMemo(() => {
    const out: Array<DiffLine | { op: "fold"; count: number }> = [];
    let index = 0;
    while (index < lines.length) {
      if (lines[index]!.op !== "same") { out.push(lines[index]!); index += 1; continue; }
      let end = index;
      while (end < lines.length && lines[end]!.op === "same") end += 1;
      const run = end - index;
      const head = index === 0 ? 0 : 2;
      const tail = end === lines.length ? 0 : 2;
      if (run > head + tail + 2) {
        out.push(...lines.slice(index, index + head), { op: "fold", count: run - head - tail }, ...lines.slice(end - tail, end));
      } else out.push(...lines.slice(index, end));
      index = end;
    }
    return out;
  }, [lines]);
  // The first change in view: scrolled to sideways (and down) once, the rest stays where the person puts it.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    const first = element?.querySelector<HTMLElement>(".report-vdiff-word, .report-vdiff-line.is-del, .report-vdiff-line.is-add");
    if (!element || !first) return;
    const target = first.classList.contains("report-vdiff-word") ? first : first.querySelector<HTMLElement>(".report-vdiff-word") ?? first;
    const right = target.offsetLeft + target.offsetWidth;
    if (right > element.scrollLeft + element.clientWidth) element.scrollLeft = Math.max(0, target.offsetLeft - 48);
    const line = first.closest<HTMLElement>(".report-vdiff-line") ?? first;
    if (line.offsetTop + line.offsetHeight > element.scrollTop + element.clientHeight) element.scrollTop = Math.max(0, line.offsetTop - 24);
  }, [lines]);
  if (!lines.length) return null;
  return <div ref={box} className="report-vdiff-code" role="region" tabIndex={0} aria-label={label}>
    {folded.map((line, index) => line.op === "fold"
      ? <div key={index} className="report-vdiff-fold">⋯ {line.count} unchanged {line.count === 1 ? "line" : "lines"}</div>
      : <div key={index} className={`report-vdiff-line is-${line.op}`}><span className="report-vdiff-sign" aria-hidden="true">{line.op === "add" ? "+" : line.op === "del" ? "−" : " "}</span><span className="sr-only">{line.op === "add" ? "Added: " : line.op === "del" ? "Removed: " : ""}</span>{line.parts
        ? line.parts.map((part, at) => part.changed ? <mark key={at} className="report-vdiff-word">{part.text}</mark> : <span key={at}>{part.text}</span>)
        : line.text || " "}</div>)}
  </div>;
}

const CHANGE_LABEL = { added: "Added", removed: "Removed", moved: "Moved", changed: "Changed" } as const;
const TYPE_LABEL = { chart: "Chart", kpi: "KPI", table: "Table", markdown: "Text" } as const;

/** The structured diff: blocks (changed fields, text), queries (SQL line diffs), and sections. */
export function DiffView({ diff }: { diff: VersionDiff }) {
  const empty = !diff.blocks.length && !diff.queries.length && !diff.sections.length;
  return <div className="report-vdiff">
    <p className="report-vdiff-summary" role="status">v{diff.from} → v{diff.to}: {diff.summary}</p>
    {diff.title && <section aria-label="Report title" className="report-vdiff-group">
      <h4>Report</h4>
      <article className="report-vdiff-item is-changed">
        <dl className="report-vdiff-fields"><div><dt>title</dt><dd><span className="report-vdiff-before">{diff.title.before}</span><span aria-hidden="true"> → </span><span className="report-vdiff-after">{diff.title.after}</span></dd></div></dl>
      </article>
    </section>}
    {empty && !diff.title && <p className="report-changes-empty">These versions have the same blocks, queries, and sections.</p>}
    {diff.blocks.length > 0 && <section aria-label="Blocks" className="report-vdiff-group">
      <h4>Blocks</h4>
      {diff.blocks.map((block) => <article key={`${block.change}-${block.blockId}`} className={`report-vdiff-item is-${block.change}`}>
        <p className="report-vdiff-head"><span className={`reports-status report-vdiff-badge is-${block.change}`}>{CHANGE_LABEL[block.change]}</span><span className="report-vdiff-type">{TYPE_LABEL[block.type]}</span><strong>{block.title}</strong></p>
        {block.position && <p className="report-vdiff-note">Position {block.position.before} → {block.position.after}</p>}
        {block.fields.length > 0 && <dl className="report-vdiff-fields">
          {block.fields.map((field) => <div key={field.field}>
            <dt>{field.field}</dt>
            <dd>{field.before !== null && <span className="report-vdiff-before">{field.before}</span>}{field.before !== null && field.after !== null && <span aria-hidden="true"> → </span>}{field.after !== null && <span className="report-vdiff-after">{field.after}</span>}</dd>
          </div>)}
        </dl>}
        {block.text && <DiffLines lines={block.text} label={`Text of ${block.title}`} />}
      </article>)}
    </section>}
    {diff.queries.length > 0 && <section aria-label="Queries" className="report-vdiff-group">
      <h4>Queries</h4>
      {diff.queries.map((query) => <article key={`${query.change}-${query.key}`} className={`report-vdiff-item is-${query.change}`}>
        <p className="report-vdiff-head"><span className={`reports-status report-vdiff-badge is-${query.change}`}>{CHANGE_LABEL[query.change]}</span><code>{query.key}</code></p>
        {query.purpose && <dl className="report-vdiff-fields"><div><dt>purpose</dt><dd><span className="report-vdiff-before">{query.purpose.before}</span> → <span className="report-vdiff-after">{query.purpose.after}</span></dd></div></dl>}
        <DiffLines lines={query.lines} label={`SQL of ${query.key}`} />
      </article>)}
    </section>}
    {diff.sections.length > 0 && <section aria-label="Sections" className="report-vdiff-group">
      <h4>Sections</h4>
      {diff.sections.map((section) => <article key={`${section.change}-${section.id}`} className={`report-vdiff-item is-${section.change}`}>
        <p className="report-vdiff-head"><span className={`reports-status report-vdiff-badge is-${section.change}`}>{CHANGE_LABEL[section.change]}</span><strong>{section.title}</strong></p>
        {section.fields.length > 0 && <dl className="report-vdiff-fields">{section.fields.map((field) => <div key={field.field}><dt>{field.field}</dt><dd>
          {field.before !== null && <span className="report-vdiff-before">{field.before}</span>}{field.before !== null && field.after !== null && " → "}{field.after !== null && <span className="report-vdiff-after">{field.after}</span>}
        </dd></div>)}</dl>}
      </article>)}
    </section>}
    {diff.truncated && <p className="file-dialog-hint">Some of this diff was cut to keep it readable.</p>}
  </div>;
}

/** Loads and shows the diff between two versions (the owner's). */
function DiffLoader({ reportId, to, from }: { reportId: string; to: number; from: number | null }) {
  const [state, setState] = useState<{ key: string; diff?: VersionDiff; error?: string } | null>(null);
  const key = `${from ?? ""}>${to}`;
  useEffect(() => {
    let alive = true;
    setState(null);
    getVersionDiff(reportId, to, from).then(({ diff }) => { if (alive) setState({ key, diff }); })
      .catch((reason) => { if (alive) setState({ key, error: codeOf(reason).code === "NOT_FOUND" ? "There is no version before this one to compare with." : messageOf(reason, "Could not load the changes") }); });
    return () => { alive = false; };
  }, [reportId, to, from, key]);
  if (!state || state.key !== key) return <p className="reports-loading" role="status">Loading the changes…</p>;
  if (state.error) return <p className="report-changes-empty">{state.error}</p>;
  return <DiffView diff={state.diff!} />;
}

/** "View this version": its spec drawn by the viewer, read-only, over the results stored for its SQL. */
function VersionView({ report, version, onRestore, canRestore, busy }: { report: ReportDetail; version: number; onRestore: (item: VersionHistoryItem) => void; canRestore: boolean; busy: boolean }) {
  const [snapshot, setSnapshot] = useState<VersionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSnapshot(null);
    getVersion(report.id, version).then((next) => { if (alive) setSnapshot(next); }).catch((reason) => { if (alive) setError(messageOf(reason, "Could not load that version")); });
    return () => { alive = false; };
  }, [report.id, version]);
  // "Run with today's data": the owner's explicit one-off run of this version's queries (never automatic).
  const [today, setToday] = useState<{ results: VersionSnapshot["results"]; status: string } | null>(null);
  const [running, setRunning] = useState(false);
  const shownResults = today?.results ?? snapshot?.results ?? [];
  const stored = shownResults.filter((item) => item.result);
  const newest = stored.map((item) => item.result!.createdAt).sort().at(-1) ?? null;
  const viewed = useMemo(() => snapshot ? { ...report, spec: snapshot.spec, lastRunAt: newest } : null, [newest, report, snapshot]);
  async function runToday() {
    setRunning(true);
    try {
      const outcome = await previewVersion(report.id, version);
      setToday({ results: outcome.results, status: outcome.status });
      if (outcome.status === "succeeded") notify.success(`Ran v${version}'s queries on today's data; the run is in Runs`);
      else notify.warning(`v${version}'s queries ran with errors; see Runs`);
    } catch (reason) {
      const { code } = codeOf(reason);
      notify.error(code === "RUN_IN_PROGRESS" ? "The report is running; try when it finishes." : code === "STALE_VERSION" ? messageOf(reason, "That version no longer passes today's checks") : messageOf(reason, "Could not run that version"));
    } finally {
      setRunning(false);
    }
  }
  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!snapshot || !viewed) return <p className="reports-loading" role="status">Loading version {version}…</p>;
  const missing = shownResults.length - stored.length;
  return <div className="report-vview">
    <div className="report-vview-banner" role="note">
      <p><strong>Viewing v{version} (read-only)</strong>
        <span>{today ? `Today's data, run just now${missing ? `; ${missing} ${missing === 1 ? "query" : "queries"} failed` : ""}. The run is in Runs; the report is unchanged.`
          : snapshot.results.length === 0 ? "This version has no queries." : stored.length === 0 ? "Data from this version was not stored."
          : `Data stored ${newest ? exactTime(newest) : ""}${missing ? `; ${missing} ${missing === 1 ? "query has" : "queries have"} no stored data from then` : ""}.`}</span>
      </p>
      <span className="report-vview-actions">
        {canRestore && snapshot.spec.queries.length > 0 && <button type="button" className="secondary-button" onClick={() => { void runToday(); }} disabled={running || busy} aria-busy={running || undefined}>
          {running ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}{running ? "Running…" : "Run with today's data"}
        </button>}
        {canRestore && !snapshot.version.current && <button type="button" className="secondary-button" onClick={() => onRestore(snapshot.version)} disabled={busy || running}><RotateCcw aria-hidden="true" />Restore</button>}
      </span>
    </div>
    {viewed.spec.blocks.length ? <ReportView key={`${version}-${today ? "today" : "stored"}`} report={viewed} canWrite={false} readOnly={{ emptyText: today ? "This query failed on today's data; Runs has the error." : "No data stored from this version. Run it with today's data to see it." }}
      initial={{ results: { results: shownResults, running: null }, runs: [] }} />
      : <p className="report-changes-empty">This version has no blocks.</p>}
  </div>;
}


/** Restore behind a confirmation (the existing restore: re-checked, a new version, its queries run again). */
function useRestore(report: ReportDetail, latest: number | null, onRestored: () => void) {
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  async function restore(item: VersionHistoryItem) {
    const ok = await confirm.ask({
      title: `Restore v${item.version}?`,
      message: `Its blocks and queries become a new version (v${(latest ?? item.version) + 1}); nothing is deleted, and the current version stays in the list. It is checked against the data source first, and its queries run again on today's data.`,
      confirmLabel: `Restore v${item.version}`
    });
    if (!ok) return;
    setBusy(true);
    try {
      const restored = await restoreVersion(report.id, item.version);
      notify.success(`Restored v${item.version} as v${restored.version}${restored.refreshRunId ? "; refreshing its queries" : ""}`);
      setBusy(false);
      onRestored();
    } catch (reason) {
      const { code } = codeOf(reason);
      notify.error(code === "RUN_IN_PROGRESS" ? "The report is running; restore when it finishes." : code === "STALE_VERSION" ? messageOf(reason, "That version no longer passes today's checks") : messageOf(reason, "Could not restore"));
      setBusy(false);
    }
  }
  return { busy, restore, confirmElement: confirm.confirmElement };
}

/** The layers over the list (D478): a version's detail or Compare, and the read-only view over a detail. */
type Layer = { kind: "detail"; version: number } | { kind: "compare"; from?: number; to?: number };
/** What Forward shows again once the panel (or the detail) is back: kept above them so it outlives a remount. */
export type VersionsMemory = { layer: MutableRefObject<LayerReopenMemory<Layer>>; view: MutableRefObject<LayerReopenMemory<number>> };
export const newVersionsMemory = (): VersionsMemory => ({ layer: { current: newLayerReopenMemory<Layer>() }, view: { current: newLayerReopenMemory<number>() } });

type Shared = { report: ReportDetail; versions: VersionHistoryItem[]; loaded: boolean; canRestore: boolean; onRestored: () => void; closeAll: () => void; runLink: ((runId: string) => void) | null };
const versionOptions = (versions: VersionHistoryItem[]) => versions.map((item) => ({ value: String(item.version), label: `v${item.version}${item.current ? " (current)" : ""} · ${versionSourceLabel(item)}` }));

/** "View this version": a wide sheet of its own over the detail (Back closes it; "Back to current" closes the whole panel). */
function ViewSheet({ shared, version, onClose, reopen }: { shared: Shared; version: number; onClose: () => void; reopen: () => void }) {
  const { report, versions, canRestore, onRestored, closeAll } = shared;
  const { busy, restore, confirmElement } = useRestore(report, versions[0]?.version ?? null, onRestored);
  // D480: a layer key, so Forward reopens this view after Back went past the page and came back.
  useHistoryDialogGuard(true, onClose, { blocked: busy, reopen, layerKey: `reports.versions-view:${version}` });
  return <ModalDialog title={`Viewing v${version}`} eyebrow={report.title} onClose={onClose} busy={busy} variant="sheet" className="reports-dialog report-changes report-versions-panel report-versions-wide">
    <div className="report-changes-body report-versions-body">
      <div className="report-versions-nav">
        <button type="button" className="secondary-button" onClick={onClose}><ChevronLeft aria-hidden="true" />Back</button>
        <button type="button" className="secondary-button" onClick={closeAll}>Back to current</button>
      </div>
      <VersionView report={report} version={version} canRestore={canRestore} busy={busy} onRestore={(item) => { void restore(item); }} />
    </div>
    {confirmElement}
  </ModalDialog>;
}

/** One version: its facts, View this version, Restore, and what changed against the one before (or any other). */
function DetailSheet({ shared, version, onClose, reopen, viewMemory }: { shared: Shared; version: number; onClose: () => void; reopen: () => void; viewMemory: VersionsMemory["view"] }) {
  const { report, versions, canRestore, onRestored, runLink } = shared;
  const detail = versions.find((item) => item.version === version) ?? null;
  const before = versions.find((item) => item.version < version)?.version ?? null;
  // The version before by default (also when Forward reopened this before the list loaded); a pick replaces it.
  const [picked, setPicked] = useState<number | null>(null);
  const against = picked ?? before;
  const [viewing, setViewing] = useState<number | null>(null);
  const viewLayer = useLayerReopen<number>(setViewing, viewMemory);
  useLayerOpener("reports.versions-view", (arg) => { const n = Number(arg); if (Number.isInteger(n) && n > 0) viewLayer.open(n); });
  const { busy, restore, confirmElement } = useRestore(report, versions[0]?.version ?? null, onRestored);
  useHistoryDialogGuard(true, onClose, { blocked: busy, reopen, layerKey: `reports.versions-detail:${version}` });
  return <>
    <ModalDialog title={`Version ${version}`} eyebrow={report.title} onClose={onClose} busy={busy} variant="sheet" className="reports-dialog report-changes report-versions-panel">
      <div className="report-changes-body report-versions-body">
        <div className="report-versions-nav"><button type="button" className="secondary-button" onClick={onClose}><ChevronLeft aria-hidden="true" />Back</button></div>
        {!shared.loaded ? <p className="reports-loading" role="status">Loading version {version}…</p> : detail ? <section className="report-vdetail" aria-label={`Version ${detail.version}`}>
          <div className="report-vrow report-vdetail-facts"><div className="report-vrow-main"><VersionFacts item={detail} heading /></div></div>
          <div className="report-vdetail-actions">
            <button type="button" className="secondary-button" onClick={() => viewLayer.open(detail.version)}><Eye aria-hidden="true" />View this version</button>
            <RunButton item={detail} onRun={runLink} />
            {canRestore && !detail.current && <button type="button" className="primary-button" onClick={() => { void restore(detail); }} disabled={busy}><RotateCcw aria-hidden="true" />{busy ? "Restoring…" : "Restore"}</button>}
          </div>
          <h3 className="report-vdetail-heading">What changed</h3>
          {versions.length > 1 && <label className="report-vdetail-against"><span>Compared with</span>
            <Select value={against === null ? null : String(against)} label="Compared with" options={versionOptions(versions).filter((option) => option.value !== String(detail.version))}
              onChange={(next) => setPicked(Number(next))} />
          </label>}
          {against === null
            ? <p className="report-changes-empty">This is the first kept version: {detail.blocks} {detail.blocks === 1 ? "block" : "blocks"}, {detail.queries} {detail.queries === 1 ? "query" : "queries"}.</p>
            : <DiffLoader reportId={report.id} to={detail.version} from={against} />}
        </section> : <p className="report-changes-empty">That version is no longer kept.</p>}
      </div>
      {confirmElement}
    </ModalDialog>
    {viewing !== null && <ViewSheet shared={shared} version={viewing} onClose={() => setViewing(null)} reopen={viewLayer.reopen} />}
  </>;
}

/** Compare: any two versions, each picker in place (no history step). */
function CompareSheet({ shared, initial, onClose, reopen }: { shared: Shared; initial: { from?: number; to?: number }; onClose: () => void; reopen: () => void }) {
  const { report, versions } = shared;
  const [picked, setPair] = useState<{ from: number; to: number } | null>(initial.from && initial.to ? { from: initial.from, to: initial.to } : null);
  const pair = picked ?? { from: versions[1]?.version ?? 0, to: versions[0]?.version ?? 0 };
  const options = versionOptions(versions);
  // The pair it opened with names the layer (D480); picking another one changes the view in place.
  const [opened] = useState(pair);
  useHistoryDialogGuard(true, onClose, { reopen, layerKey: `reports.versions-compare:${opened.from}-${opened.to}` });
  const kept = (version: number) => versions.some((item) => item.version === version);
  return <ModalDialog title="Compare versions" eyebrow={report.title} onClose={onClose} variant="sheet" className="reports-dialog report-changes report-versions-panel">
    <div className="report-changes-body report-versions-body">
      <div className="report-versions-nav"><button type="button" className="secondary-button" onClick={onClose}><ChevronLeft aria-hidden="true" />Back</button></div>
      <section className="report-vcompare" aria-label="Compare versions">
        <div className="report-vcompare-pickers">
          <label><span>From</span><Select value={String(pair.from)} label="From version" options={options} onChange={(next) => setPair({ ...pair, from: Number(next) })} /></label>
          <button type="button" className="secondary-button report-vcompare-swap" onClick={() => setPair({ from: pair.to, to: pair.from })} title="Swap the versions"><ArrowLeftRight aria-hidden="true" />Swap</button>
          <label><span>To</span><Select value={String(pair.to)} label="To version" options={options} onChange={(next) => setPair({ ...pair, to: Number(next) })} /></label>
        </div>
        {!shared.loaded ? <p className="reports-loading" role="status">Loading versions…</p> : pair.from === pair.to ? <p className="report-changes-empty">Pick two different versions.</p>
          : kept(pair.from) && kept(pair.to) ? <DiffLoader reportId={report.id} to={pair.to} from={pair.from} /> : <p className="report-changes-empty">One of these versions is no longer kept.</p>}
      </section>
    </div>
  </ModalDialog>;
}

type Props = {
  report: ReportDetail; canRestore: boolean; onClose: () => void; reopen: () => void; onRestored: () => void;
  /** Kept by the owner when the panel itself is reopened by Forward, so the layers over it come back too (D478). */
  memory?: VersionsMemory;
  /** H3: which opener shows this sheet again after its page remounted (the header's or the Changes panel's). */
  layerKey?: string;
};

/**
 * A report's versions (plan wave 48; lane J): newest first, each with where it came from in plain words
 * ("Applied a change", "Restored v3"), who asked and who applied, when, the instruction, what changed,
 * and the model and run. The owner opens a version (a sheet over the list): what changed against the
 * one before (or any other), a read-only view of it (a sheet over the detail), a compare of any two,
 * and Restore (confirmed; a new version, nothing is rewritten). Commenters and viewers see the list's
 * who, when, and source only (D459). Each sheet is its own history layer (D478): Back closes the top
 * one, Forward reopens them in order.
 */
export function VersionsSheet({ report, canRestore, onClose, reopen, onRestored, memory, layerKey }: Props) {
  const owner = report.isOwner;
  const [versions, setVersions] = useState<VersionHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layer, setLayer] = useState<Layer | null>(null);
  const own = useRef<VersionsMemory | null>(null);
  own.current ??= newVersionsMemory();
  const slots = memory ?? own.current;
  const layers = useLayerReopen<Layer>(setLayer, slots.layer);
  const openRun = useContext(ReportRunsContext);
  const { busy, restore, confirmElement } = useRestore(report, versions?.[0]?.version ?? null, onRestored);
  useHistoryDialogGuard(true, onClose, { blocked: busy, reopen, layerKey });
  // D480: the sheets over the list come back by key when Forward returns to a remounted page.
  useLayerOpener("reports.versions-detail", (arg) => { const n = Number(arg); if (Number.isInteger(n) && n > 0) layers.open({ kind: "detail", version: n }); });
  useLayerOpener("reports.versions-compare", (arg) => { const [from, to] = arg.split("-").map(Number); layers.open({ kind: "compare", ...(from && to ? { from, to } : {}) }); });

  useEffect(() => {
    let alive = true;
    listVersions(report.id).then(({ versions: next }) => { if (alive) setVersions(next); }).catch((reason) => { if (alive) setError(messageOf(reason, "Could not load the versions")); });
    return () => { alive = false; };
  }, [report.id, report.revision]);

  const runLink = owner && openRun ? (runId: string) => openRun(runId) : null;
  // The layers mount at once (Forward adopts their entries as they open), loading or not.
  const shared: Shared = { report, versions: versions ?? [], loaded: versions !== null, canRestore, onRestored, closeAll: onClose, runLink };

  return <>
    <ModalDialog title="Versions" eyebrow={report.title} onClose={onClose} busy={busy} variant="sheet" className="reports-dialog report-changes report-versions-panel">
      <div className="report-changes-body report-versions-body">
        {error && <p className="form-error" role="alert">{error}</p>}
        {!versions && !error && <p className="reports-loading" role="status">Loading versions…</p>}
        {versions && !versions.length && <p className="report-changes-empty">No versions yet: the report has no blocks.</p>}
        {versions && owner && versions.length > 1 && <div className="report-versions-tools">
          <button type="button" className="secondary-button" onClick={() => layers.open({ kind: "compare" })}><GitCompareArrows aria-hidden="true" />Compare versions</button>
        </div>}
        {versions && !owner && versions.length > 0 && <p className="file-dialog-hint">You see who made each version and when; what changed is shown to the report's owner.</p>}
        {versions && <ol className="report-vlist">
          {versions.map((item) => <li key={item.version} className={`report-vrow${item.current ? " is-current" : ""}`}>
            <div className="report-vrow-main">
              {owner && <button type="button" className="report-vrow-open" aria-label={`Open v${item.version}: ${versionSourceLabel(item)}`} onClick={() => layers.open({ kind: "detail", version: item.version })}>
                <ChevronRight aria-hidden="true" className="report-vrow-chevron" />
              </button>}
              <VersionFacts item={item} />
              {((canRestore && !item.current) || (item.runId && runLink)) && <span className="report-vrow-actions">
                <RunButton item={item} onRun={runLink} />
                {canRestore && !item.current && <button type="button" className="secondary-button report-vrow-run" onClick={() => { void restore(item); }} disabled={busy}><RotateCcw aria-hidden="true" />Restore</button>}
              </span>}
            </div>
          </li>)}
        </ol>}
      </div>
      {confirmElement}
    </ModalDialog>
    {layer?.kind === "detail" && <DetailSheet key={layer.version} shared={shared} version={layer.version} onClose={() => setLayer(null)} reopen={layers.reopen} viewMemory={slots.view} />}
    {layer?.kind === "compare" && <CompareSheet shared={shared} initial={layer} onClose={() => setLayer(null)} reopen={layers.reopen} />}
  </>;
}
