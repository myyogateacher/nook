import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Archive, CalendarClock, ChartColumn, Check, ChevronDown, Copy, Database, ExternalLink, FolderInput, House, Pencil, Plus, RotateCcw, Search, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { AccountActions, AppPageName } from "../AppShell";
import { appName } from "../appName";
import { notifyBinned, onBinRestored } from "../bin/binUndo";
import { ModalDialog } from "../files/Dialog";
import { NameDialog } from "../files/RenameDialog";
import { relativeTime } from "../files/format";
import { useLayerOpener, whenHistorySettled } from "../historyDialogs";
import type { ReportsFolderView } from "../router";
import { ReadOnlyBanner, useRole } from "../team/roleAccess";
import { errorText, notify } from "../ui/notify";
import { useConfirm } from "../ui/useConfirm";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { REPORT_FOLDER_NAME_MAX, type DatasourceChoice, type ReportFolder, type ReportFolderTree, type ReportStatus, type ReportSummary } from "../../shared/reports";
import { NewReportSheet } from "./NewReportSheet";
import { ReportFolderNav, type FolderActions } from "./ReportFolderNav";
import { ReportMoveSheet } from "./ReportMoveSheet";
import { ReportFolderMoveSheet } from "./ReportFolderMoveSheet";
import { RenameSheet } from "./ReportPage";
import { ReportOverflowMenu, type MenuItem } from "./reportCommands";
import { CADENCE_LABELS, folderPath, orderedFolders, placeOf, REPORT_DRAG_TYPE, reportsInView, viewTitle, type FolderPlace } from "./reportFolderTree";
import { copyReportLink, LinkSheet, reportLink } from "./reportLink";
import { createFolder, datasourceChoices, deleteFolder, deleteReport, fileReport, listFolders, listReports, messageOf, updateFolder } from "./reportsApi";

export const STATUS_LABELS: Record<ReportStatus, string> = { draft: "Draft", ready: "Ready", stale: "Stale", error: "Error" };

type HomeProps = {
  displayName: string;
  role: string;
  onHome: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  onOpen: (id: string) => void;
  onOpenDatasources: () => void;
  /** Opens Settings → AI → Tool servers (admins; New report's "From a doc" reasons). */
  onOpenToolServers?: () => void;
  /** Lane I: the view in the URL (null: All reports) and the move to another (a history entry). */
  folder?: ReportsFolderView | null;
  onFolder?: (view: ReportsFolderView | null, options?: { replace?: boolean }) => void;
  flash?: (message: string) => void;
};

type NameRequest = { kind: "new"; parent: ReportFolder | null } | { kind: "rename"; folder: ReportFolder };

function checkFolderName(initial: string) {
  return (input: string) => {
    const name = input.trim();
    if (!name) return { ok: false as const, error: "Enter a folder name." };
    if (name.length > REPORT_FOLDER_NAME_MAX) return { ok: false as const, error: `Use at most ${REPORT_FOLDER_NAME_MAX} characters.` };
    return { ok: true as const, name, changed: name !== initial };
  };
}

/**
 * The Reports home (Wave 45; Lane I): a left nav of folders (All reports, Unfiled, the owner's folder
 * tree with counts, Shared with me) beside the reports of the chosen view as rows. A row drags onto a
 * folder or Unfiled to move it (Undo in the toast); its ⋯ menu has Move to… for keyboards and phones.
 * Each view is a URL (/reports, /reports/folder/:id, /reports/unfiled, /reports/shared), so Back and
 * Forward step between folders; every sheet is a history layer (D18). Under 1024 px the nav is a sheet
 * opened from the folder button at the top. New report in a folder files the report there. K2: a folder
 * drags in the nav to nest or reorder it (Undo in the toast); its ⋯ menu has Move folder to… (a sheet
 * that Forward reopens) and Move up / Move down.
 */
export function ReportsHome({ displayName, role, onHome, onSettings, onSignOut, onOpen, onOpenDatasources, onOpenToolServers, folder: view = null, onFolder, flash = (message) => notify.info(message) }: HomeProps) {
  const { canWrite } = useRole();
  const [reports, setReports] = useState<ReportSummary[] | null>(null);
  const [tree, setTree] = useState<ReportFolderTree | null>(null);
  const [sources, setSources] = useState<DatasourceChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchAll, setSearchAll] = useState(false);
  const [creating, setCreating] = useState<{ folderId: string | null } | null>(null);
  const [naming, setNaming] = useState<NameRequest | null>(null);
  const [moving, setMoving] = useState<ReportSummary | null>(null);
  const [movingFolder, setMovingFolder] = useState<ReportFolder | null>(null);
  const [renaming, setRenaming] = useState<ReportSummary | null>(null);
  const [linkFor, setLinkFor] = useState<ReportSummary | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const confirm = useConfirm();
  const generation = useRef(0);
  const select = useCallback((next: ReportsFolderView | null, options?: { replace?: boolean }) => { onFolder?.(next, options); }, [onFolder]);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(null);
    try {
      const [{ reports: list }, folders, { datasources }] = await Promise.all([listReports(query), listFolders(), datasourceChoices()]);
      if (current !== generation.current) return;
      setReports(list);
      setTree(folders);
      setSources(datasources);
    } catch (reason) {
      if (current === generation.current) setError(messageOf(reason, "Could not load your reports"));
    }
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, query ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query]);
  useEffect(() => onBinRestored(["report", "report_folder"], () => { void load(); }), [load]);
  useEffect(() => { document.title = `${viewTitle(view, tree?.folders ?? [])} · Reports · ${appName()}`; }, [view, tree]);

  const closeNaming = useCallback(() => setNaming(null), []);
  useHistoryDialogGuard(naming !== null, closeNaming);
  const closeDrawer = useCallback(() => setDrawer(false), []);
  useHistoryDialogGuard(drawer, closeDrawer, { reopen: () => setDrawer(true) });

  const folders = useMemo(() => tree?.folders ?? [], [tree]);
  const folderLabels = useMemo(() => orderedFolders(folders).map(({ folder }) => ({ id: folder.id, label: folderPath(folders, folder.id) })), [folders]);
  const currentFolder = view && view !== "unfiled" && view !== "shared" ? folders.find((item) => item.id === view) ?? null : null;
  const missingFolder = Boolean(tree && view && view !== "unfiled" && view !== "shared" && !currentFolder);
  // A folder made elsewhere since the list loaded (another tab, MCP): load once more before calling it gone.
  const recheckedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!missingFolder || !view || recheckedFor.current === view) return;
    recheckedFor.current = view;
    void load();
  }, [missingFolder, view, load]);
  const scoped = query.trim() && searchAll ? reports ?? [] : reportsInView(reports ?? [], view);
  const title = viewTitle(view, folders);

  /** Files a report (drag, Move to…), with Undo in the toast like the app's other moves. */
  const move = useCallback(async (reportId: string, folderId: string | null, options: { undo?: boolean } = { undo: true }) => {
    const report = reports?.find((item) => item.id === reportId);
    if (!report || !report.isOwner || report.folderId === folderId) return;
    const { previousFolderId } = await fileReport(reportId, folderId);
    await load();
    const where = folderId ? folderPath(folders, folderId) : "Unfiled";
    if (options.undo) notify.success(`Moved “${report.title}” to ${where}`, { action: { label: "Undo", onClick: () => { void fileReport(reportId, previousFolderId).then(() => load(), (reason) => notify.error(errorText(reason, "Could not undo the move"))); } } });
  }, [folders, load, reports]);
  /** K2: nests or reorders a folder (a drag in the nav, Move folder to…, Move up/down), with Undo in the toast. */
  const placeFolder = useCallback(async (folder: ReportFolder, place: FolderPlace) => {
    const before = placeOf(folders, folder.id);
    await updateFolder(folder.id, place);
    await load();
    const message = place.parentId === before.parentId ? `Reordered the folder ${folder.name}`
      : place.parentId ? `Moved the folder ${folder.name} into ${folderPath(folders, place.parentId)}` : `Moved the folder ${folder.name} to the top level`;
    notify.success(message, { action: { label: "Undo", onClick: () => { void updateFolder(folder.id, before).then(() => load(), (reason) => notify.error(errorText(reason, "Could not undo the move"))); } } });
  }, [folders, load]);
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  const closeFolderMove = useCallback(() => setMovingFolder(null), []);
  useLayerOpener("report-folder-move", (id) => { const found = foldersRef.current.find((item) => item.id === id); if (found) setMovingFolder(found); });

  const dropReport = (reportId: string, folderId: string | null) => {
    setDragging(null);
    move(reportId, folderId).catch((reason) => notify.error(errorText(reason, "Could not move the report")));
  };

  async function submitName(name: string) {
    if (!naming) return;
    if (naming.kind === "rename") {
      await updateFolder(naming.folder.id, { name });
      notify.success(`Renamed the folder to ${name}`);
    } else {
      const { folder } = await createFolder(name, naming.parent?.id ?? null);
      notify.success(`Created folder ${folder.name}`);
      select(folder.id);
    }
    setNaming(null);
    await load();
  }

  async function removeFolder(target: ReportFolder) {
    const inside = folders.filter((item) => item.parentId === target.id).length;
    if (!await confirm.ask({
      title: `Delete the folder ${target.name}?`,
      message: `Its reports${inside ? " and the reports in its subfolders" : ""} move to Unfiled; no report is deleted. You can restore the folder from Settings → Bin for 30 days.`,
      confirmLabel: "Delete folder", danger: true
    })) return;
    try {
      await deleteFolder(target.id);
      if (view && (view === target.id || folders.some((item) => item.id === view && item.parentId === target.id))) select(null, { replace: true });
      await load();
      notifyBinned(`Deleted the folder ${target.name}`, [{ type: "report_folder", id: target.id }], load);
    } catch (reason) {
      notify.error(errorText(reason, "Could not delete the folder"));
    }
  }

  async function removeReport(report: ReportSummary) {
    if (!await confirm.ask({ title: `Move ${report.title} to the Bin?`, message: "You can restore it from Settings → Bin for 30 days.", confirmLabel: "Move to Bin", danger: true })) return;
    try {
      await deleteReport(report.id);
      await load();
      notifyBinned(`Moved “${report.title}” to the Bin`, [{ type: "report", id: report.id }], load);
    } catch (reason) {
      notify.error(errorText(reason, "Could not move the report to the Bin"));
    }
  }

  const actions: FolderActions = {
    rename: (folder) => setNaming({ kind: "rename", folder }),
    newSubfolder: (folder) => setNaming({ kind: "new", parent: folder }),
    newReportIn: (folder) => { select(folder.id); setCreating({ folderId: folder.id }); },
    remove: (folder) => { void removeFolder(folder); },
    moveTo: (folder) => setMovingFolder(folder),
    place: (folder, place) => { placeFolder(folder, place).catch((reason) => notify.error(errorText(reason, "Could not move the folder"))); }
  };
  const chooseInDrawer = (next: ReportsFolderView | null) => {
    setDrawer(false);
    whenHistorySettled(() => select(next));
  };

  const startDrag = (event: DragEvent<HTMLElement>, report: ReportSummary) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(REPORT_DRAG_TYPE, report.id);
    event.dataTransfer.setData("text/plain", report.title);
    // The drag ghost: a small chip with the report's title, not a picture of the whole row.
    const ghost = document.createElement("div");
    ghost.className = "reports-drag-ghost";
    ghost.textContent = report.title;
    document.body.appendChild(ghost);
    try { event.dataTransfer.setDragImage(ghost, 14, 18); } catch { /* the default ghost */ }
    window.setTimeout(() => ghost.remove(), 0);
    setDragging(report.id);
  };

  const rowMenu = (report: ReportSummary): MenuItem[] => [
    { id: "open", label: "Open", icon: <ExternalLink aria-hidden="true" />, onSelect: () => onOpen(report.id) },
    ...(report.isOwner && canWrite ? [
      { id: "move", label: "Move to…", icon: <FolderInput aria-hidden="true" />, onSelect: () => setMoving(report) },
      { id: "rename", label: "Rename", icon: <Pencil aria-hidden="true" />, onSelect: () => setRenaming(report) }
    ] : []),
    { id: "link", label: "Copy link", icon: <Copy aria-hidden="true" />, onSelect: () => { void copyReportLink(reportLink(report.id), { flash, onFallback: () => setLinkFor(report) }); } },
    ...(report.isOwner && canWrite ? [{ id: "delete", label: "Move to Bin", icon: <Trash2 aria-hidden="true" />, danger: true, onSelect: () => { void removeReport(report); } }] : [])
  ];

  const nav = (inDrawer: boolean) => <ReportFolderNav tree={tree} view={view} onSelect={inDrawer ? chooseInDrawer : select} canWrite={canWrite} dragging={dragging} onDropReport={dropReport}
    onNewFolder={() => { if (inDrawer) setDrawer(false); setNaming({ kind: "new", parent: null }); }}
    actions={inDrawer ? { ...actions, newReportIn: (folder) => { setDrawer(false); actions.newReportIn(folder); }, moveTo: (folder) => { setDrawer(false); whenHistorySettled(() => setMovingFolder(folder)); } } : actions} />;

  const noSources = sources !== null && sources.length === 0;
  const newReport = () => setCreating({ folderId: currentFolder?.id ?? null });
  const emptyCopy = query ? "No report has that title" : missingFolder ? "This folder is gone" : view === "shared" ? "Nothing is shared with you yet" : view === "unfiled" ? "Every report is in a folder" : currentFolder ? "This folder is empty" : "No reports yet";
  return <main className="app-page reports-app">
    <header className="app-page-header">
      <button className="app-home-button" onClick={onHome}><House />Home</button>
      <span className="app-home-brand"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>Reports</strong></span></span><AppPageName name="Reports" />
      <AccountActions displayName={displayName} onSettings={onSettings} onSignOut={onSignOut} />
    </header>
    <ReadOnlyBanner />
    <div className="reports-layout">
      <aside className="reports-sidebar" aria-label="Folders">{nav(false)}</aside>
      <section className="reports-body reports-main" aria-labelledby="reports-title">
        <button type="button" className="reports-folder-chip" onClick={() => setDrawer(true)} aria-haspopup="dialog" aria-label={`Folders: ${title}`}>
          <Archive aria-hidden="true" /><span>{title}</span>{reports && <small>{scoped.length}</small>}<ChevronDown aria-hidden="true" />
        </button>
        <div className="reports-toolbar">
          <h1 id="reports-title">{title}{reports && <span className="reports-count"> · {scoped.length}</span>}</h1>
          <label className="reports-search">
            <Search aria-hidden="true" />
            <span className="sr-only">Filter reports by title</span>
            <input type="search" value={query} maxLength={200} placeholder={view && view !== "shared" ? `Filter ${view === "unfiled" ? "Unfiled" : "this folder"}` : "Filter by title"} onChange={(event) => setQuery(event.target.value)} />
          </label>
          {canWrite && !missingFolder && <button type="button" className="primary-button reports-new" onClick={newReport} disabled={noSources}><Plus />New report</button>}
        </div>
        {query.trim() && view && <div className="reports-scope">
          {!searchAll && <span>Filtering {title}</span>}
          <button type="button" className="reports-scope-chip" aria-pressed={searchAll} onClick={() => setSearchAll((all) => !all)}>{searchAll ? <Check aria-hidden="true" /> : <ChartColumn aria-hidden="true" />}Search all reports</button>
        </div>}

        {error && <div className="reports-state" role="alert">
          <span className="reports-state-icon"><TriangleAlert /></span>
          <h2>Could not load your reports</h2>
          <p>{error}</p>
          <button className="secondary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
        </div>}
        {!error && !reports && <p className="reports-loading" role="status">Loading reports…</p>}
        {!error && reports && scoped.length === 0 && <div className="reports-state">
          <span className="reports-state-icon"><ChartColumn /></span>
          <h2>{emptyCopy}</h2>
          {!query && !view && noSources && (role === "admin"
            ? <><p>Reports query a ClickHouse data source. Add one first.</p><button className="primary-button" onClick={onOpenDatasources}><Database />Add a data source</button></>
            : <p>Reports query a ClickHouse data source, and none is set up yet. Ask an admin to add one.</p>)}
          {!query && !view && !noSources && <p>Paste a doc that describes your metrics and let AI build the report, or write SQL against your team's warehouse yourself.</p>}
          {!query && currentFolder && <p>Drag a report here, use Move to… in a report's ⋯ menu, or create one in this folder.</p>}
          {!query && view === "shared" && <p>Reports other people share with you appear here.</p>}
          {!query && missingFolder && <button className="secondary-button" onClick={() => select(null, { replace: true })}>Show all reports</button>}
          {!query && !noSources && canWrite && (view === null || currentFolder) && <button className="primary-button" onClick={newReport}><Plus />{currentFolder ? "New report here" : "New report"}</button>}
          {!query && !view && canWrite && tree && !tree.folders.length && reports.length > 0 && <p>No folders yet: use New folder in the list to group your reports.</p>}
        </div>}
        {!error && reports && scoped.length > 0 && <ul className="reports-rows" aria-label={`Reports in ${title}`}>
          {scoped.map((report) => {
            const draggable = report.isOwner && canWrite;
            return <li key={report.id} className={`reports-row${dragging === report.id ? " dragging" : ""}`} draggable={draggable}
              onDragStart={draggable ? (event) => startDrag(event, report) : undefined} onDragEnd={() => setDragging(null)}>
              <button type="button" className="reports-row-open" onClick={() => onOpen(report.id)}>
                <span className="reports-row-icon" aria-hidden="true"><ChartColumn /></span>
                <span className="reports-row-title">
                  <span>{report.title}</span>
                  {!report.isOwner && <small>by {report.ownerName}</small>}
                  {report.isOwner && !view && report.folderId && <small className="reports-row-folder">{folderPath(folders, report.folderId)}</small>}
                </span>
                <span className="reports-row-meta">
                  <span className={`reports-status reports-status-${report.status}`}>{STATUS_LABELS[report.status]}</span>
                  <span className="reports-row-source"><Database aria-hidden="true" />{report.datasourceName ?? "No data source"}</span>
                  <span className="reports-row-schedule">{report.scheduleCadence && <span title="Refreshes on a schedule"><CalendarClock aria-hidden="true" />{CADENCE_LABELS[report.scheduleCadence] ?? report.scheduleCadence}</span>}</span>
                  <time dateTime={report.updatedAt}>{relativeTime(report.updatedAt)}</time>
                </span>
              </button>
              <ReportOverflowMenu compact className="reports-row-menu" label={`${report.title} actions`} items={rowMenu(report)} />
            </li>;
          })}
        </ul>}
      </section>
    </div>
    {drawer && <ModalDialog title="Folders" eyebrow="Reports" onClose={closeDrawer} variant="sheet" className="reports-dialog reports-folder-sheet">
      {nav(true)}
    </ModalDialog>}
    {creating && sources && <NewReportSheet sources={sources} role={role} onOpenToolServers={onOpenToolServers} folders={folderLabels} initialFolderId={creating.folderId}
      onCancel={() => setCreating(null)} onCreated={(id) => { setCreating(null); onOpen(id); }} />}
    {naming && <NameDialog title={naming.kind === "rename" ? "Rename folder" : naming.parent ? `New folder in ${naming.parent.name}` : "New folder"} eyebrow="Reports" label="Folder name"
      initialValue={naming.kind === "rename" ? naming.folder.name : ""} submitLabel={naming.kind === "rename" ? "Rename" : "Create folder"} hint={`Up to ${REPORT_FOLDER_NAME_MAX} characters.`}
      validate={checkFolderName(naming.kind === "rename" ? naming.folder.name : "")} onSubmit={submitName} onCancel={closeNaming} />}
    {moving && <ReportMoveSheet title={moving.title} currentFolderId={moving.folderId} folders={folders} onCancel={() => setMoving(null)}
      onMove={async (folderId) => { await move(moving.id, folderId); setMoving(null); }} />}
    {movingFolder && <ReportFolderMoveSheet folder={movingFolder} folders={folders} onCancel={closeFolderMove} onReopen={() => setMovingFolder(movingFolder)}
      onMove={async (place) => { await placeFolder(movingFolder, place); setMovingFolder(null); }} />}
    {renaming && <RenameSheet report={renaming} onCancel={() => setRenaming(null)} onSaved={() => { setRenaming(null); void load(); }} />}
    {linkFor && <LinkSheet url={reportLink(linkFor.id)} title={linkFor.title} onClose={() => setLinkFor(null)} flash={flash} />}
    {confirm.confirmElement}
  </main>;
}
