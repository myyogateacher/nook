import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CalendarClock, ChevronLeft, CircleStop, Cpu, Database, FileSearch, History, LoaderCircle, MessageSquare, Pencil, Play, RefreshCw, Share2, Sparkles, TableProperties, Trash2, TriangleAlert } from "lucide-react";
import { AccountActions } from "../AppShell";
import { appName } from "../appName";
import { notifyBinned } from "../bin/binUndo";
import { ModalDialog } from "../files/Dialog";
import { ReadOnlyBanner, useRole } from "../team/roleAccess";
import { notify } from "../ui/notify";
import { useConfirm } from "../ui/useConfirm";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { REPORT_LIMITS, type QueryOutcome, type ReportDetail } from "../../shared/reports";
import { cancelConsole, cellText, codeOf, countLabel, deleteReport, getReport, messageOf, runConsole, updateReport } from "./reportsApi";
import { STATUS_LABELS } from "./ReportsHome";
import { ReportGeneration } from "./ReportGeneration";
import { SchemaBrowser } from "./SchemaBrowser";
import { ModelSheet } from "./ModelSheet";
import { ChangesPanel, useReportRights } from "./ChangesPanel";
import { ReportCommentContext } from "./reportComment";
import { ShareSheet } from "./ShareSheet";
import { ReportRunsContext, RunsSheet } from "./RunsSheet";
import { ReportCommandsContext, ReportOverflowMenu, type MenuItem, type ReportCommands } from "./reportCommands";

type PageProps = {
  reportId: string;
  displayName: string;
  flash: (message: string) => void;
  onBack: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  /** The report is gone (deleted here, or no longer readable): its entry is replaced by the list. */
  onGone: () => void;
};

const CONSOLE_DRAFT = (id: string) => `mynotes:reports-console:${id}`;
function readDraft(id: string) {
  try { return window.sessionStorage.getItem(CONSOLE_DRAFT(id)) ?? ""; } catch { return ""; }
}
function saveDraft(id: string, sql: string) {
  try { if (sql) window.sessionStorage.setItem(CONSOLE_DRAFT(id), sql.slice(0, REPORT_LIMITS.sqlChars)); else window.sessionStorage.removeItem(CONSOLE_DRAFT(id)); } catch { /* private mode */ }
}

/**
 * One report (Wave 45): its title, status, and data source, the guarded SQL console (SELECT and the
 * metadata statements: SHOW, DESCRIBE, EXISTS, EXPLAIN, and the allowed system tables), and the
 * Schema browser sheet. Charts and the spec arrive with waves 46 and 47.
 */
export function ReportPage({ reportId, displayName, flash, onBack, onSettings, onSignOut, onGone }: PageProps) {
  const { canWrite } = useRole();
  const [report, setReport] = useState<ReportDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sql, setSql] = useState(() => readDraft(reportId));
  const [running, setRunning] = useState(false);
  const runAbort = useRef<AbortController | null>(null);
  const [outcome, setOutcome] = useState<QueryOutcome | null>(null);
  const [runError, setRunError] = useState<{ message: string; code?: string } | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const confirm = useConfirm();
  const consoleId = useId();
  // Wave 48: the Changes panel (instructions, proposals, versions), aimed at a block or the whole report, and Share.
  const [changes, setChanges] = useState<{ blockId: string | null } | null>(null);
  const lastChanges = useRef<{ blockId: string | null }>({ blockId: null });
  const [sharing, setSharing] = useState(false);
  // The Runs panel (owner only), opened at a run from Inspect → Provenance.
  const [runsAt, setRunsAt] = useState<{ runId: string | null } | null>(null);
  const lastRuns = useRef<{ runId: string | null }>({ runId: null });
  const openRuns = useCallback((runId: string | null) => { lastRuns.current = { runId }; setRunsAt({ runId }); }, []);
  const rights = useReportRights(reportId);
  const openChanges = useCallback((blockId: string | null) => { lastChanges.current = { blockId }; setChanges({ blockId }); }, []);
  // The header's actions that live in the viewer and the generation part (reportCommands.tsx).
  const [commands, setCommands] = useState<ReportCommands>({});
  const registry = useMemo(() => ({ set: (part: Partial<ReportCommands>) => setCommands((current) => ({ ...current, ...part })) }), []);

  const load = useCallback(async () => {
    try {
      setReport((await getReport(reportId)).report);
      setLoadError(null);
    } catch (reason) {
      if (codeOf(reason).code === "NOT_FOUND") {
        notify.warning("That report is not available");
        onGone();
        return;
      }
      setLoadError(messageOf(reason, "Could not open the report"));
    }
  }, [onGone, reportId]);
  useEffect(() => { void load(); }, [load]);
  const reloadReport = useCallback(() => { void load(); }, [load]);
  // Changing the report (refresh, schedule, regenerate, apply, edits, the console) is its owner's (D455).
  const ownerWrite = canWrite && Boolean(report?.isOwner);
  useEffect(() => { if (report) document.title = `${report.title} · Reports · ${appName()}`; }, [report]);
  useEffect(() => { saveDraft(reportId, sql); }, [reportId, sql]);

  async function run() {
    if (!sql.trim() || running) return;
    const controller = new AbortController();
    runAbort.current = controller;
    setRunning(true);
    setRunError(null);
    try {
      setOutcome((await runConsole(reportId, sql, controller.signal)).outcome);
    } catch (reason) {
      if (controller.signal.aborted || codeOf(reason).code === "CANCELLED") setRunError({ message: "Cancelled." });
      else {
        const { code, guard } = codeOf(reason);
        setRunError({ message: messageOf(reason, "The query failed"), code: guard ?? code });
      }
      setOutcome(null);
    } finally {
      if (runAbort.current === controller) runAbort.current = null;
      setRunning(false);
    }
  }

  /** Cancel: the server aborts the query and sends KILL QUERY (best effort); then the request is dropped. */
  async function cancel() {
    const controller = runAbort.current;
    if (!controller) return;
    try { await cancelConsole(reportId); } catch { /* the abort below still stops it */ }
    controller.abort();
  }
  // Leaving the page stops a running query.
  useEffect(() => () => runAbort.current?.abort(), []);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void run();
    }
  };

  async function remove() {
    if (!report) return;
    if (!await confirm.ask({ title: `Move ${report.title} to the Bin?`, message: "You can restore it from Settings → Bin for 30 days.", confirmLabel: "Move to Bin", danger: true })) return;
    try {
      await deleteReport(report.id);
      notifyBinned("Moved the report to the Bin", [{ type: "report", id: report.id }]);
      onGone();
    } catch (reason) {
      notify.error(messageOf(reason, "Could not move the report to the Bin"));
    }
  }

  const insertTable = (table: string) => {
    setSql((current) => current.trim() ? current : `SELECT *\nFROM ${table}\nLIMIT 100`);
    setSchemaOpen(false);
    flash(`Inserted ${table}`);
  };

  return <main className="app-page reports-app report-page">
    <header className="app-page-header">
      <button className="app-home-button" onClick={onBack}><ChevronLeft />Reports</button>
      <span className="app-home-brand report-page-brand"><span className="brand-text"><strong>{report?.title ?? "Report"}</strong></span></span>
      <AccountActions displayName={displayName} onSettings={onSettings} onSignOut={onSignOut} />
    </header>
    <ReadOnlyBanner />
    {loadError && <section className="reports-state" role="alert"><span className="reports-state-icon"><TriangleAlert /></span><h2>Could not open the report</h2><p>{loadError}</p><button className="secondary-button" onClick={() => { void load(); }}>Try again</button></section>}
    {!loadError && !report && <p className="reports-loading" role="status">Opening the report…</p>}
    {report && <section className="reports-body report-body" aria-labelledby="report-title">
      <div className="report-heading">
        <h1 id="report-title">{report.title}</h1>
        <p className="report-facts">
          <span className={`reports-status reports-status-${report.status}`}>{STATUS_LABELS[report.status]}</span>
          <span><Database aria-hidden="true" />{report.datasourceName ?? "No data source"}</span>
        </p>
        {/* The header: Refresh all first; Changes, Share, and Schedule beside it (on a phone only Changes);
            everything else in the overflow menu, Move to Bin last. Owner-only actions are hidden from readers. */}
        <div className="report-actions report-header-actions">
          {ownerWrite && commands.refreshAll && <button type="button" className="primary-button" onClick={commands.refreshAll.run} disabled={commands.refreshAll.disabled} aria-busy={commands.refreshAll.busy || undefined}>
            {commands.refreshAll.busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}Refresh all
          </button>}
          <button type="button" className="secondary-button" onClick={() => openChanges(null)}><MessageSquare aria-hidden="true" />Changes</button>
          {report.isOwner && <button type="button" className="secondary-button report-wide-only" onClick={() => openRuns(null)}><History aria-hidden="true" />Runs</button>}
          {ownerWrite && <button type="button" className="secondary-button report-wide-only" onClick={() => setSharing(true)}><Share2 aria-hidden="true" />Share</button>}
          {commands.schedule && <button type="button" className="secondary-button report-wide-only" onClick={commands.schedule.open}><CalendarClock aria-hidden="true" />Schedule</button>}
          <ReportOverflowMenu label="More report actions" items={overflowItems({ ownerWrite, owner: report.isOwner, commands, runs: () => openRuns(null), share: () => setSharing(true), rename: () => setRenaming(true), model: () => setModelOpen(true), remove: () => { void remove(); } })} />
        </div>
      </div>

      {/* Wave 46: generation progress, the doc banner, and the actions; inside it, wave 47's viewer (blocks, refresh, schedule, inspect). */}
      <ReportCommandsContext.Provider value={registry}>
        <ReportCommentContext.Provider value={rights?.canComment ? openChanges : null}>
          <ReportRunsContext.Provider value={report.isOwner ? openRuns : null}>
            <ReportGeneration report={report} canWrite={ownerWrite} onChanged={() => { void load(); }} />
          </ReportRunsContext.Provider>
        </ReportCommentContext.Provider>
      </ReportCommandsContext.Provider>

      {report.isOwner && <section className="report-console" aria-labelledby={`${consoleId}-heading`}>
        <div className="report-console-head">
          <h2 id={`${consoleId}-heading`}>SQL console</h2>
          <button type="button" className="secondary-button" onClick={() => setSchemaOpen(true)} disabled={!report.datasourceId}><TableProperties />Schema</button>
        </div>
        <label htmlFor={consoleId} className="sr-only">SQL</label>
        <textarea id={consoleId} className="report-sql" value={sql} spellCheck={false} autoCapitalize="off" autoCorrect="off" maxLength={REPORT_LIMITS.sqlChars}
          placeholder={"SELECT toStartOfWeek(day) AS week, sum(revenue)\nFROM analytics.orders\nGROUP BY week ORDER BY week"}
          onChange={(event) => setSql(event.target.value)} onKeyDown={onKeyDown} rows={7} />
        <div className="report-console-actions">
          <p className="file-dialog-hint">One SELECT, or SHOW, DESCRIBE, EXISTS, EXPLAIN. Read-only, at most {REPORT_LIMITS.consoleRows.toLocaleString()} rows; no SETTINGS, FORMAT, or external table functions.</p>
          {canWrite && <span className="report-run-buttons">
            {running && <button type="button" className="secondary-button" onClick={() => { void cancel(); }}><CircleStop />Cancel</button>}
            <button type="button" className="primary-button" onClick={() => { void run(); }} disabled={running || !sql.trim() || !report.datasourceId} aria-busy={running || undefined}>
              {running ? <LoaderCircle className="spin" /> : <Play />}{running ? "Running…" : "Run"}
            </button>
          </span>}
        </div>
        {runError && <p className="form-error report-run-error" role="alert">{runError.code ? <code>{runError.code}</code> : null} {runError.message}</p>}
        {outcome && <ResultView outcome={outcome} />}
      </section>}
    </section>}
    {schemaOpen && report && <SchemaBrowser reportId={report.id} onClose={() => setSchemaOpen(false)} onInsert={canWrite ? insertTable : undefined} />}
    {modelOpen && report && <ModelSheet reportId={report.id} onClose={() => setModelOpen(false)} reopen={() => setModelOpen(true)} />}
    {changes && report && <ChangesPanel key={`${changes.blockId ?? ""}`} report={report} initialBlockId={changes.blockId} onClose={() => setChanges(null)}
      reopen={() => setChanges(lastChanges.current)} onReportChanged={reloadReport} />}
    {runsAt && report && <RunsSheet key={runsAt.runId ?? ""} reportId={report.id} title={report.title} focusRunId={runsAt.runId} onClose={() => setRunsAt(null)} reopen={() => setRunsAt(lastRuns.current)} />}
    {sharing && report && <ShareSheet reportId={report.id} title={report.title} onClose={() => setSharing(false)} reopen={() => setSharing(true)} />}
    {renaming && report && <RenameSheet report={report} reopen={() => setRenaming(true)} onCancel={() => setRenaming(false)} onSaved={(next) => { setReport(next); setRenaming(false); }} />}
    {confirm.confirmElement}
  </main>;
}

/**
 * The overflow menu's items: on a phone Share and Schedule first (the header hides them there), then
 * Rename, Model, Check doc, Regenerate, and Move to Bin last (dangerous). Readers see Schedule only.
 */
export function overflowItems({ ownerWrite, owner = false, commands, runs, share, rename, model, remove }: { ownerWrite: boolean; owner?: boolean; commands: ReportCommands; runs?: () => void; share: () => void; rename: () => void; model: () => void; remove: () => void }): MenuItem[] {
  const items: MenuItem[] = [];
  if (owner && runs) items.push({ id: "runs", label: "Runs", icon: <History aria-hidden="true" />, onSelect: runs, narrowOnly: true });
  if (ownerWrite) items.push({ id: "share", label: "Share", icon: <Share2 aria-hidden="true" />, onSelect: share, narrowOnly: true });
  if (commands.schedule) items.push({ id: "schedule", label: commands.schedule.badge ? `Schedule (${commands.schedule.badge})` : "Schedule", icon: <CalendarClock aria-hidden="true" />, onSelect: commands.schedule.open, narrowOnly: true });
  if (!ownerWrite) return items;
  items.push({ id: "rename", label: "Rename", icon: <Pencil aria-hidden="true" />, onSelect: rename });
  items.push({ id: "model", label: "Model", icon: <Cpu aria-hidden="true" />, onSelect: model });
  if (commands.checkDoc) items.push({ id: "check-doc", label: commands.checkDoc.busy ? "Checking the doc…" : "Check doc", icon: <FileSearch aria-hidden="true" />, onSelect: commands.checkDoc.run, disabled: commands.checkDoc.busy || Boolean(commands.regenerate?.busy) });
  if (commands.regenerate) items.push({ id: "regenerate", label: commands.regenerate.busy ? "Starting…" : "Regenerate", icon: <Sparkles aria-hidden="true" />, onSelect: commands.regenerate.run, disabled: commands.regenerate.busy || Boolean(commands.checkDoc?.busy) });
  items.push({ id: "bin", label: "Move to Bin", icon: <Trash2 aria-hidden="true" />, onSelect: remove, danger: true });
  return items;
}

/** The console's result: what ran, and the rows in a table that scrolls sideways on a phone. */
export function ResultView({ outcome }: { outcome: QueryOutcome }) {
  return <div className="report-result">
    <p className="report-result-facts" role="status">
      <span className="reports-status">{outcome.class === "select" ? "Select" : "Metadata"}</span>
      <span>{countLabel(outcome.rows.length)}{outcome.truncated && outcome.class === "select" ? " (more were cut off)" : ""}</span>
      {outcome.rowsRead !== null && <span>{countLabel(outcome.rowsRead)} read</span>}
      <span>{outcome.ms} ms</span>
    </p>
    {/* A SHOW list that reached its read cap is cut short even when few rows pass the allowlist (wave 45). */}
    {outcome.truncated && outcome.class === "metadata" && <p className="file-dialog-hint report-list-cut" role="note">
      List cut short: ClickHouse returned more than Nook reads, so some names may be missing. Narrow it with <code>LIKE</code> or a database name.
    </p>}
    <details className="report-sent">
      <summary>SQL as sent</summary>
      <pre><code>{outcome.sentSql}</code></pre>
      <p className="file-dialog-hint">ClickHouse query id <code>{outcome.chQueryId}</code></p>
    </details>
    {outcome.columns.length > 0 && <div className="report-table-scroll" tabIndex={0} role="region" aria-label="Query result">
      <table className="report-table">
        <thead><tr>{outcome.columns.map((column, index) => <th key={`${column.name}-${index}`} scope="col"><span>{column.name}</span><small>{column.type}</small></th>)}</tr></thead>
        <tbody>{outcome.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className={cell === null ? "report-null" : undefined}>{cellText(cell)}</td>)}</tr>)}</tbody>
      </table>
    </div>}
  </div>;
}

function RenameSheet({ report, onCancel, onSaved, reopen }: { report: ReportDetail; onCancel: () => void; onSaved: (report: ReportDetail) => void; reopen?: () => void }) {
  const [title, setTitle] = useState(report.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  useHistoryDialogGuard(true, onCancel, { blocked: busy, reopen });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return setError("Enter a title.");
    setBusy(true);
    try {
      onSaved((await updateReport(report.id, { title: title.trim(), expectedRevision: report.revision })).report);
    } catch (reason) {
      setError(codeOf(reason).code === "REVISION_CONFLICT" ? "This report changed elsewhere; close and reopen it." : messageOf(reason, "Could not rename the report"));
      setBusy(false);
    }
  }
  return <ModalDialog title="Rename report" eyebrow="Reports" onClose={onCancel} busy={busy} variant="sheet" className="reports-dialog">
    <form className="file-dialog-form" onSubmit={submit} noValidate>
      <label htmlFor={inputId}>Title</label>
      <input id={inputId} value={title} maxLength={REPORT_LIMITS.title} autoFocus autoComplete="off" onChange={(event) => setTitle(event.target.value)} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </footer>
    </form>
  </ModalDialog>;
}
