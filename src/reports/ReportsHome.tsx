import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ChartColumn, Database, House, Plus, RotateCcw, Search, Sparkles, TriangleAlert } from "lucide-react";
import { AccountActions, AppPageName } from "../AppShell";
import { appName } from "../appName";
import { onBinRestored } from "../bin/binUndo";
import { ModalDialog } from "../files/Dialog";
import { relativeTime } from "../files/format";
import { ReadOnlyBanner, useRole } from "../team/roleAccess";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { REPORT_LIMITS, type DatasourceChoice, type ReportStatus, type ReportSummary } from "../../shared/reports";
import { createReport, datasourceChoices, listReports, messageOf } from "./reportsApi";

export const STATUS_LABELS: Record<ReportStatus, string> = { draft: "Draft", ready: "Ready", stale: "Stale", error: "Error" };

type HomeProps = {
  displayName: string;
  role: string;
  onHome: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  onOpen: (id: string) => void;
  onOpenDatasources: () => void;
};

/**
 * The Reports list (Wave 45): the person's reports, newest change first, a title filter, and New
 * report (a title and a data source; the report starts as a draft with a SQL console). When no data
 * source exists, admins get a way to Settings → Report data sources and everyone else is told to ask one.
 */
export function ReportsHome({ displayName, role, onHome, onSettings, onSignOut, onOpen, onOpenDatasources }: HomeProps) {
  const { canWrite } = useRole();
  const [reports, setReports] = useState<ReportSummary[] | null>(null);
  const [sources, setSources] = useState<DatasourceChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(null);
    try {
      const [{ reports: list }, { datasources }] = await Promise.all([listReports(query), datasourceChoices()]);
      if (current !== generation.current) return;
      setReports(list);
      setSources(datasources);
    } catch (reason) {
      if (current === generation.current) setError(messageOf(reason, "Could not load your reports"));
    }
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, query ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query]);
  useEffect(() => onBinRestored(["report"], () => { void load(); }), [load]);
  useEffect(() => { document.title = `Reports · ${appName()}`; }, []);

  const noSources = sources !== null && sources.length === 0;
  return <main className="app-page reports-app">
    <header className="app-page-header">
      <button className="app-home-button" onClick={onHome}><House />Home</button>
      <span className="app-home-brand"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>Reports</strong></span></span><AppPageName name="Reports" />
      <AccountActions displayName={displayName} onSettings={onSettings} onSignOut={onSignOut} />
    </header>
    <ReadOnlyBanner />
    <section className="reports-body" aria-labelledby="reports-title">
      <div className="reports-toolbar">
        <h1 id="reports-title">Reports{reports && <span className="reports-count"> · {reports.length}</span>}</h1>
        <label className="reports-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Filter reports by title</span>
          <input type="search" value={query} maxLength={200} placeholder="Filter by title" onChange={(event) => setQuery(event.target.value)} />
        </label>
        {canWrite && <button type="button" className="primary-button reports-new" onClick={() => setCreating(true)} disabled={noSources}><Plus />New report</button>}
      </div>

      {error && <div className="reports-state" role="alert">
        <span className="reports-state-icon"><TriangleAlert /></span>
        <h2>Could not load your reports</h2>
        <p>{error}</p>
        <button className="secondary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
      </div>}
      {!error && !reports && <p className="reports-loading" role="status">Loading reports…</p>}
      {!error && reports && reports.length === 0 && <div className="reports-state">
        <span className="reports-state-icon"><ChartColumn /></span>
        <h2>{query ? "No report has that title" : "No reports yet"}</h2>
        {!query && noSources && (role === "admin"
          ? <><p>Reports query a ClickHouse data source. Add one first.</p><button className="primary-button" onClick={onOpenDatasources}><Database />Add a data source</button></>
          : <p>Reports query a ClickHouse data source, and none is set up yet. Ask an admin to add one.</p>)}
        {!query && !noSources && <p>Write SQL against your team's warehouse and keep the result as a report.</p>}
        {!query && !noSources && canWrite && <button className="primary-button" onClick={() => setCreating(true)}><Plus />New report</button>}
      </div>}
      {!error && reports && reports.length > 0 && <ul className="reports-list" aria-label="Reports">
        {reports.map((report) => <li key={report.id}>
          <button type="button" className="reports-card" onClick={() => onOpen(report.id)}>
            <span className="reports-card-icon" aria-hidden="true"><ChartColumn /></span>
            <span className="reports-card-copy">
              <span className="reports-card-title">{report.title}</span>
              <span className="reports-card-meta">
                <span className={`reports-status reports-status-${report.status}`}>{STATUS_LABELS[report.status]}</span>
                <span>{report.datasourceName ?? "No data source"}</span>
                <time dateTime={report.updatedAt}>{relativeTime(report.updatedAt)}</time>
              </span>
            </span>
          </button>
        </li>)}
      </ul>}
    </section>
    {creating && sources && <NewReportSheet sources={sources} onCancel={() => setCreating(false)} onCreated={(id) => { setCreating(false); onOpen(id); }} />}
  </main>;
}

/** New report: a title and a data source. Back or Escape closes it (a history layer, D18). */
export function NewReportSheet({ sources, onCancel, onCreated }: { sources: DatasourceChoice[]; onCancel: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [source, setSource] = useState<string | null>(sources[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { title: useId(), source: useId() };
  useHistoryDialogGuard(true, onCancel, { blocked: busy });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return setError("Enter a title.");
    if (!source) return setError("Choose a data source.");
    setBusy(true);
    setError(null);
    try {
      const { report } = await createReport(title.trim(), source);
      onCreated(report.id);
    } catch (reason) {
      setError(messageOf(reason, "Could not create the report"));
      setBusy(false);
    }
  }

  return <ModalDialog title="New report" eyebrow="Reports" onClose={onCancel} busy={busy} variant="sheet" className="reports-dialog">
    <form className="file-dialog-form" onSubmit={submit} noValidate>
      <label htmlFor={ids.title}>Title</label>
      <input id={ids.title} value={title} maxLength={REPORT_LIMITS.title} autoFocus autoComplete="off" placeholder="Weekly revenue" onChange={(event) => setTitle(event.target.value)} />
      <span className="reports-label" id={ids.source}>Data source</span>
      <Select labelledBy={ids.source} label="Data source" value={source} onChange={setSource} options={sources.map((item) => ({ value: item.id, label: item.name, description: `Default database ${item.database}` }))} />
      <p className="file-dialog-hint">The report starts as a draft with a SQL console. Queries run on that data source, read-only, on the tables an admin allowed.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Creating…" : "Create report"}</button>
      </footer>
    </form>
  </ModalDialog>;
}
