import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { CalendarClock, ChartColumn, Check, ChevronDown, Copy, Database, ExternalLink, Folder as FolderIcon, FolderInput, House, Inbox, ListFilter, LoaderCircle, Pencil, Plus, RotateCcw, Search, Sparkles, Star, Trash2, TriangleAlert, Users } from "lucide-react";
import { AccountActions, AppPageName } from "../AppShell";
import { appName } from "../appName";
import { notifyBinned, onBinRestored } from "../bin/binUndo";
import { ModalDialog } from "../files/Dialog";
import { NameDialog } from "../files/RenameDialog";
import { relativeTime } from "../files/format";
import { useLayerOpener, whenHistorySettled } from "../historyDialogs";
import type { ReportsFilter, ReportsFolderView } from "../router";
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
import { CADENCE_LABELS, folderPath, orderedFolders, placeOf, REPORT_DRAG_TYPE, viewTitle, type FolderPlace } from "./reportFolderTree";
import { activeFilterCount, ReportFilterBar, ReportFilterSheet } from "./ReportFilters";
import { StarButton } from "./StarButton";
import { copyReportLink, LinkSheet, reportLink } from "./reportLink";
import { createFolder, datasourceChoices, deleteFolder, deleteReport, fileReport, listFolders, listReports, messageOf, updateFolder, type ReportListQuery } from "./reportsApi";

export const STATUS_LABELS: Record<ReportStatus, string> = { draft: "Draft", ready: "Ready", stale: "Stale", error: "Error" };
const LEVEL_LABELS: Record<ReportSummary["level"], string> = { owner: "Owner", comment: "Can comment", view: "Can view" };
const LEVEL_HINTS: Record<ReportSummary["level"], string> = { owner: "You own this report", comment: "Shared with you: you can view it and ask for changes", view: "Shared with you to view" };

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
  /** Phase 1: the list's filters in the URL, and the move to others (a history entry). */
  filter?: ReportsFilter;
  onFilter?: (filter: ReportsFilter | undefined) => void;
  flash?: (message: string) => void;
};

/** The server query for a view, its filters, and the title search (Search all reports drops the view). */
export function listQueryFor(view: ReportsFolderView | null, filter: ReportsFilter | undefined, q: string, searchAll: boolean): ReportListQuery {
  const scope: ReportListQuery = (q.trim() && searchAll) || !view ? {} : view === "unfiled" ? { folderId: "unfiled" } : view === "shared" ? { shared: true } : view === "favorites" ? { favorites: true } : { folderId: view };
  return {
    ...(q.trim() ? { q: q.trim() } : {}), ...scope,
    ...(filter?.owner ? { ownerId: filter.owner } : {}), ...(filter?.status?.length ? { statuses: filter.status as ReportStatus[] } : {}),
    ...(filter?.datasource ? { datasourceId: filter.datasource } : {}), ...(filter?.schedule ? { scheduled: filter.schedule === "on" } : {})
  };
}

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
 *
 * Report organization phase 1: the server pages the list (100 at a time, newest change first; infinite
 * scroll with a Load more button) and filters it: the view, the title, and the filter bar (owner,
 * status, data source, schedule; in the URL, a bottom sheet on a phone). ☆/★ on each row stars a
 * report (optimistic, rolled back with a toast on error), and Favorites in the nav lists the starred.
 */
export function ReportsHome({ displayName, role, onHome, onSettings, onSignOut, onOpen, onOpenDatasources, onOpenToolServers, folder: view = null, onFolder, filter, onFilter, flash = (message) => notify.info(message) }: HomeProps) {
  const { canWrite } = useRole();
  const [reports, setReports] = useState<ReportSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
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

  const filterKey = JSON.stringify(filter ?? {});
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the filter by value (a new object each render of the route)
  const listQuery = useMemo(() => listQueryFor(view, filter, query, searchAll), [view, filterKey, query, searchAll]);
  const listQueryRef = useRef(listQuery);
  listQueryRef.current = listQuery;
  /** The first page of the list for the current view and filters; with `everything`, the nav and the data sources too. */
  const load = useCallback(async (everything = true) => {
    const current = ++generation.current;
    setError(null);
    try {
      const [page, folders, choices] = await Promise.all([listReports(listQueryRef.current), everything ? listFolders() : null, everything ? datasourceChoices() : null]);
      if (current !== generation.current) return;
      setReports(page.reports);
      setNextCursor(page.nextCursor ?? null);
      if (folders) setTree(folders);
      if (choices) setSources(choices.datasources);
    } catch (reason) {
      if (current === generation.current) setError(messageOf(reason, "Could not load your reports"));
    }
  }, []);
  const loadedOnce = useRef(false);
  // Another view or other filters: the rows shown belong to the old ones, so show the list loading instead
  // (typing a title search keeps the rows until the answer comes).
  const scopeKey = JSON.stringify({ ...listQuery, q: undefined });
  const shownScope = useRef(scopeKey);
  if (shownScope.current !== scopeKey) {
    shownScope.current = scopeKey;
    generation.current += 1;
    if (reports !== null) { setReports(null); setNextCursor(null); }
  }
  useEffect(() => {
    const first = !loadedOnce.current;
    loadedOnce.current = true;
    const timer = window.setTimeout(() => { void load(first); }, listQuery.q ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [load, listQuery]);
  /** The next page (infinite scroll, or Load more); dropped when the list was reloaded meanwhile. */
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      const page = await listReports({ ...listQueryRef.current, cursor: nextCursor });
      if (current !== generation.current) return;
      setReports((list) => {
        const seen = new Set((list ?? []).map((report) => report.id));
        return [...(list ?? []), ...page.reports.filter((report) => !seen.has(report.id))];
      });
      setNextCursor(page.nextCursor ?? null);
    } catch (reason) {
      if (current === generation.current) notify.error(errorText(reason, "Could not load more reports"));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor]);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = moreRef.current;
    if (!node || !nextCursor || loadingMore || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void loadMore(); }, { rootMargin: "320px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore, loadingMore, nextCursor]);
  useEffect(() => onBinRestored(["report", "report_folder"], () => { void load(); }), [load]);
  useEffect(() => { document.title = `${viewTitle(view, tree?.folders ?? [])} · Reports · ${appName()}`; }, [view, tree]);

  const closeNaming = useCallback(() => setNaming(null), []);
  useHistoryDialogGuard(naming !== null, closeNaming);
  const closeDrawer = useCallback(() => setDrawer(false), []);
  useHistoryDialogGuard(drawer, closeDrawer, { reopen: () => setDrawer(true) });
  const closeFilters = useCallback(() => setFiltersOpen(false), []);
  useLayerOpener("reports.filters", () => setFiltersOpen(true));
  const applyFilters = (next: ReportsFilter | undefined) => {
    setFiltersOpen(false);
    whenHistorySettled(() => onFilter?.(next));
  };

  const folders = useMemo(() => tree?.folders ?? [], [tree]);
  const folderLabels = useMemo(() => orderedFolders(folders).map(({ folder }) => ({ id: folder.id, label: folderPath(folders, folder.id) })), [folders]);
  const isFolderView = Boolean(view && view !== "unfiled" && view !== "shared" && view !== "favorites");
  const currentFolder = isFolderView ? folders.find((item) => item.id === view) ?? null : null;
  const missingFolder = Boolean(tree && isFolderView && !currentFolder);
  // A folder made elsewhere since the list loaded (another tab, MCP): load once more before calling it gone.
  const recheckedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!missingFolder || !view || recheckedFor.current === view) return;
    recheckedFor.current = view;
    void load();
  }, [missingFolder, view, load]);
  const scoped = reports ?? [];
  const title = viewTitle(view, folders);
  const filtered = activeFilterCount(filter) > 0;
  // Without a search or filters the nav knows the view's total; otherwise the rows loaded so far (and more to come).
  const viewTotal = !tree || query.trim() || filtered ? null : !view ? tree.counts.all : view === "unfiled" ? tree.counts.unfiled : view === "shared" ? tree.counts.shared
    : view === "favorites" ? tree.counts.favorites : currentFolder?.count ?? null;
  const shownCount = viewTotal ?? `${scoped.length}${nextCursor ? "+" : ""}`;

  /** ☆/★ (D486), optimistic: the row and the Favorites count change at once; StarButton puts them back on error. */
  const setStar = useCallback((report: ReportSummary, favorite: boolean) => {
    setReports((list) => {
      if (!list) return list;
      if (view === "favorites" && !favorite) return list.filter((item) => item.id !== report.id);
      if (!list.some((item) => item.id === report.id)) { void load(false); return list; }
      return list.map((item) => item.id === report.id ? { ...item, favorite } : item);
    });
    setTree((current) => current && { ...current, counts: { ...current.counts, favorites: Math.max(0, current.counts.favorites + (favorite ? 1 : -1)) } });
  }, [load, view]);

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
    canCreate={canWrite && (tree?.canCreateFolders ?? false)} canManage={canWrite && (tree?.canManageFolders ?? false)}
    onNewFolder={() => { if (inDrawer) setDrawer(false); setNaming({ kind: "new", parent: null }); }}
    actions={inDrawer ? { ...actions, newReportIn: (folder) => { setDrawer(false); actions.newReportIn(folder); }, moveTo: (folder) => { setDrawer(false); whenHistorySettled(() => setMovingFolder(folder)); } } : actions} />;

  const noSources = sources !== null && sources.length === 0;
  const newReport = () => setCreating({ folderId: currentFolder?.id ?? null });
  const emptyCopy = query ? "No report has that title" : missingFolder ? "This folder is gone" : filtered ? "No reports match these filters"
    : view === "favorites" ? "No favorites yet" : view === "shared" ? "Nothing is shared with you yet" : view === "unfiled" ? "Every report is in a folder" : currentFolder ? "This folder is empty" : "No reports yet";
  // The view's own hints and actions show only when nothing narrows it.
  const plain = !query && !filtered;
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
          <ViewIcon view={view} /><span>{title}</span>{reports && <small>{shownCount}</small>}<ChevronDown aria-hidden="true" />
        </button>
        <div className="reports-toolbar">
          <h1 id="reports-title">{title}{reports && <span className="reports-count"> · {shownCount}</span>}</h1>
          <label className="reports-search">
            <Search aria-hidden="true" />
            <span className="sr-only">Filter reports by title</span>
            <input type="search" value={query} maxLength={200} placeholder={view === "unfiled" ? "Filter Unfiled" : view === "favorites" ? "Filter Favorites" : isFolderView ? "Filter this folder" : "Filter by title"} onChange={(event) => setQuery(event.target.value)} />
          </label>
          {canWrite && !missingFolder && <button type="button" className="primary-button reports-new" onClick={newReport} disabled={noSources}><Plus />New report</button>}
        </div>
        {tree && sources && <ReportFilterBar filter={filter} choices={{ owners: tree.owners, sources }} onChange={(next) => onFilter?.(next)} onOpenSheet={() => setFiltersOpen(true)} />}
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
          <span className="reports-state-icon">{view === "favorites" && plain ? <Star /> : filtered && !query ? <ListFilter /> : <ChartColumn />}</span>
          <h2>{emptyCopy}</h2>
          {!query && filtered && <><p>Change or clear the filters to see more reports.</p><button className="secondary-button" onClick={() => onFilter?.(undefined)}>Clear filters</button></>}
          {plain && view === "favorites" && <p>Star a report with ☆ on its row or its page to keep it here.</p>}
          {plain && !view && noSources && (role === "admin"
            ? <><p>Reports query a ClickHouse data source. Add one first.</p><button className="primary-button" onClick={onOpenDatasources}><Database />Add a data source</button></>
            : <p>Reports query a ClickHouse data source, and none is set up yet. Ask an admin to add one.</p>)}
          {plain && !view && !noSources && <p>Paste a doc that describes your metrics and let AI build the report, or write SQL against your team's warehouse yourself.</p>}
          {plain && currentFolder && <p>Drag a report here, use Move to… in a report's ⋯ menu, or create one in this folder.</p>}
          {plain && view === "shared" && <p>Reports other people share with you appear here.</p>}
          {!query && missingFolder && <button className="secondary-button" onClick={() => select(null, { replace: true })}>Show all reports</button>}
          {plain && !noSources && canWrite && (view === null || currentFolder) && <button className="primary-button" onClick={newReport}><Plus />{currentFolder ? "New report here" : "New report"}</button>}
          {plain && !view && canWrite && tree && !tree.folders.length && reports.length > 0 && <p>No folders yet: use New folder in the list to group your reports.</p>}
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
                  {/* Phase 2 (D482): the person's own level on this report, then whose it is and where it is filed. */}
                  <em className="reports-row-sub">
                    {report.level && <i className={`reports-level reports-level-${report.level}`} title={LEVEL_HINTS[report.level]}>{LEVEL_LABELS[report.level]}</i>}
                    {!report.isOwner && <small>by {report.ownerName}{report.ownerCount > 1 ? ` and ${report.ownerCount - 1} more` : ""}</small>}
                    {!view && report.folderId && <small className="reports-row-folder">{folderPath(folders, report.folderId)}</small>}
                  </em>
                </span>
                <span className="reports-row-meta">
                  <span className={`reports-status reports-status-${report.status}`}>{STATUS_LABELS[report.status]}</span>
                  <span className="reports-row-source"><Database aria-hidden="true" />{report.datasourceName ?? "No data source"}</span>
                  <span className="reports-row-schedule">{report.scheduleCadence && <span title="Refreshes on a schedule"><CalendarClock aria-hidden="true" />{CADENCE_LABELS[report.scheduleCadence] ?? report.scheduleCadence}</span>}</span>
                  <time dateTime={report.updatedAt}>{relativeTime(report.updatedAt)}</time>
                </span>
              </button>
              <StarButton reportId={report.id} title={report.title} favorite={report.favorite} onChange={(favorite) => setStar(report, favorite)} className="reports-row-star" />
              <ReportOverflowMenu compact className="reports-row-menu" label={`${report.title} actions`} items={rowMenu(report)} />
            </li>;
          })}
        </ul>}
        {!error && reports && nextCursor && <div className="reports-more" ref={moreRef}>
          <button type="button" className="secondary-button" onClick={() => { void loadMore(); }} disabled={loadingMore} aria-busy={loadingMore || undefined}>
            {loadingMore ? <LoaderCircle className="spin" aria-hidden="true" /> : null}{loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>}
      </section>
    </div>
    {filtersOpen && tree && sources && <ReportFilterSheet filter={filter} choices={{ owners: tree.owners, sources }} onApply={applyFilters} onClose={closeFilters} reopen={() => setFiltersOpen(true)} />}
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

/** The phone's folder switcher shows the view's own icon, as the nav does: All, Favorites (a star), Unfiled, Shared, a folder. */
function ViewIcon({ view }: { view: string | null }) {
  if (view === null) return <ChartColumn aria-hidden="true" />;
  if (view === "favorites") return <Star aria-hidden="true" />;
  if (view === "unfiled") return <Inbox aria-hidden="true" />;
  if (view === "shared") return <Users aria-hidden="true" />;
  return <FolderIcon aria-hidden="true" />;
}
