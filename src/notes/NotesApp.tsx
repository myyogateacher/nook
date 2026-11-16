import { useEffect, useMemo, useState, type Dispatch, type KeyboardEvent, type MutableRefObject, type ReactNode, type RefObject, type SetStateAction } from "react";
import { Archive, ArrowUpDown, Bot, Check, ChevronLeft, FileDown, FilePlus2, FileText, Folder as FolderIcon, FolderInput, FolderPlus, History, Menu, MoreHorizontal, Pencil, PenTool, Search, Share2, Sparkles, Trash2, Users, X } from "lucide-react";
import { api } from "../api";
import { AccessSheet } from "../access/AccessSheet";
import { lineDiff } from "../diff/lineDiff";
import { BinnedFilesConfirm } from "../editor/BinnedFilesConfirm";
import { NoteEditor, type NoteUploadControl } from "../editor/NoteEditor";
import { ConfirmDialog } from "../files/Dialog";
import { MoveSheet } from "../files/MoveSheet";
import { NameDialog } from "../files/RenameDialog";
import { validateFolderName } from "../files/fileActions";
import type { FolderSelection, MobilePanel } from "../mobileNavigation";
import { SearchResults, searchListId, searchOptionId } from "../search/SearchResults";
import { SEARCH_MAX_CHARS, type NoteSearchHit } from "../search/searchApi";
import type { useNoteSearch } from "../search/useNoteSearch";
import { WhiteboardSearchResults, type useWhiteboardSearch } from "../search/WhiteboardSearchResults";
import { FileSearchResults, type useFileSearch } from "../search/FileSearchResults";
import { mcpDraftBadge } from "../noteFinalization";
import { ShellMenuButton, ShellSidebarPortal } from "../shell/shellContext";
import { SidebarFolderTree } from "../shell/SidebarFolderTree";
import { canRenameFolder, InlineRenameField } from "../shell/folderRename";
import { ReportOverflowMenu } from "../reports/reportCommands";
import { countByFolder } from "../shell/folderTree";
import { formatRoute } from "../router";
import { notesRoute } from "../notesRoute";
import { ReadOnlyBanner } from "../team/roleAccess";
import type { Folder, NoteDetail, NoteSummary, Version } from "../types";
import { IntegrationBadge } from "../ui/IntegrationBadge";
import { errorText, notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";

/**
 * Notes (docs/plan/LEFT_NAV.md §5, phase 3): the folders pane, the note list, and the editor, moved
 * out of App.tsx as they were. App keeps Notes' state and its moves (the save-on-leave guard
 * `leaveNotes`, the `mynotes:last:<user>` restore, Ctrl/Cmd+K and `/` to search, the phone panels and
 * their history entries), because every app switch and Back or Forward goes through them; this
 * component renders what that state says.
 */

export type NoteSort = "updated-desc" | "updated-asc" | "created-desc" | "created-asc" | "title-asc" | "title-desc";

export const noteSortOptions: Array<{ value: NoteSort; label: string }> = [
  { value: "updated-desc", label: "Recently edited" },
  { value: "updated-asc", label: "Oldest edited" },
  { value: "created-desc", label: "Recently added" },
  { value: "created-asc", label: "Oldest added" },
  { value: "title-asc", label: "Title A–Z" },
  { value: "title-desc", label: "Title Z–A" }
];

export function relativeTime(value: string) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function HistoryPanel({ note, canRestore = true, onClose, onRestored }: { note: NoteDetail; canRestore?: boolean; onClose: () => void; onRestored: () => void }) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [currentContent, setCurrentContent] = useState("");
  const [previousContent, setPreviousContent] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ versions: Version[] }>(`/notes/${note.id}/versions`).then(({ versions: items }) => {
      setVersions(items);
      setSelected(items[0]?.version_number ?? null);
    });
  }, [note.id]);

  useEffect(() => {
    if (selected === null) return;
    const index = versions.findIndex((version) => version.version_number === selected);
    Promise.all([
      api<{ markdown: string }>(`/notes/${note.id}/versions/${selected}`),
      index >= 0 && versions[index + 1]
        ? api<{ markdown: string }>(`/notes/${note.id}/versions/${versions[index + 1].version_number}`)
        : Promise.resolve({ markdown: "" })
    ]).then(([current, previous]) => {
      setCurrentContent(current.markdown);
      setPreviousContent(previous.markdown);
    });
  }, [note.id, selected, versions]);

  const diff = useMemo(() => lineDiff(previousContent, currentContent), [previousContent, currentContent]);

  async function restore() {
    if (selected === null) return;
    setBusy(true);
    await api(`/notes/${note.id}/versions/${selected}/restore`, { method: "POST", body: "{}" });
    setBusy(false);
    onRestored();
  }

  return (
    <aside className="side-panel history-panel">
      <header><div><span className="eyebrow">Timeline</span><h2>Version history</h2></div><button className="icon-button" onClick={onClose} aria-label="Close history"><X /></button></header>
      <div className="version-list">
        {versions.map((version) => (
          <button key={version.id} className={selected === version.version_number ? "selected" : ""} onClick={() => setSelected(version.version_number)}>
            <span>Version {version.version_number}</span>
            <small>{version.author_name}{version.author_is_integration === 1 && <IntegrationBadge />} · {relativeTime(version.created_at)}</small>
          </button>
        ))}
        {!versions.length && <p className="empty-copy">Publish a draft to create the first version.</p>}
      </div>
      {selected !== null && <>
        <div className="diff-heading"><span>Changes in v{selected}</span><span><i className="diff-add" /> Added <i className="diff-remove" /> Removed</span></div>
        <pre className="diff-view">{diff.map((line, index) => <span key={`${index}-${line.kind}`} className={line.kind}>{line.kind === "add" ? "+ " : line.kind === "remove" ? "− " : "  "}{line.text || " "}</span>)}</pre>
        {note.isOwner && canRestore && <button className="secondary-button restore-button" disabled={busy} onClick={restore}>Restore as draft</button>}
      </>}
    </aside>
  );
}

/** The notes list's "Move to the Bin?" (Friction 14, D91): the app's confirm, closed by Back or Forward. */
export function NoteDeleteConfirm({ title, onConfirm, onCancel }: { title: string; onConfirm: () => void; onCancel: () => void }) {
  useHistoryDialogGuard(true, onCancel);
  return <ConfirmDialog title="Move to the Bin?" message={noteDeleteMessage(title)} confirmLabel="Move to Bin" danger onConfirm={onConfirm} onCancel={onCancel} />;
}

export const noteDeleteMessage = (title: string) => `Move “${title || "Untitled"}” to the Bin? You can restore it for 30 days.`;

export type NotesAppProps = {
  activeSearchHit: NoteSearchHit | null;
  activeSearchIndex: number;
  askDeleteNote: (noteId: string, title: string, opener: HTMLElement) => void;
  binnedFiles: { noteId: string; documentIds: string[] } | null;
  boardFacetAvailable: boolean;
  boardSearch: ReturnType<typeof useWhiteboardSearch>;
  boardsFacet: boolean;
  canWrite: boolean;
  clearSearch: () => void;
  closeMoveNote: () => void;
  closeNewFolder: () => void;
  confirmedFilesRef: MutableRefObject<Map<string, Set<string>>>;
  createFolder: (name: string) => Promise<void>;
  createNote: () => Promise<void>;
  deleteNote: (noteId: string) => Promise<void>;
  deletingNote: { id: string; title: string } | null;
  discard: (opener?: HTMLElement | null) => Promise<void>;
  downloadPdf: () => void;
  draftBadge: string | null;
  draggingNoteId: string | null;
  dropFolderId: string | null;
  editorLocked: boolean;
  fileFacetAvailable: boolean;
  fileSearch: ReturnType<typeof useFileSearch>;
  filesFacet: boolean;
  focusAfterDeleteConfirm: () => void;
  folders: Folder[];
  hasPublishableDelta: boolean;
  loadNavigation: () => Promise<unknown>;
  loadNote: (id: string) => Promise<void>;
  markdown: string;
  mobileActions: boolean;
  mobileBack: (fallback: MobilePanel) => void;
  mobilePanel: MobilePanel;
  moveNote: (noteId: string, folder: Folder) => Promise<void>;
  movingNote: boolean;
  newFolderOpen: boolean;
  note: NoteDetail | null;
  noteSort: NoteSort;
  noteUploadControl: MutableRefObject<NoteUploadControl | null>;
  notes: NoteSummary[];
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  openContentPath: (href: string) => Promise<void>;
  openFileHit: (documentId: string) => Promise<void>;
  openMoveNote: (trigger: HTMLElement | null) => void;
  openNewFolder: (trigger: HTMLElement) => void;
  openSearchHit: (hit: NoteSearchHit) => void;
  panel: "history" | "share" | null;
  publish: (reloadCurrent?: boolean, interactive?: boolean) => Promise<boolean>;
  /** D1302: renames one of the person's folders in place (optimistic, rolled back with a toast on failure). */
  renameFolder: (folder: Folder, name: string) => void;
  query: string;
  saveState: "saved" | "saving" | "error" | "conflict";
  search: ReturnType<typeof useNoteSearch>;
  searchAll: boolean;
  searchEnabled: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  selectFolder: (folder: FolderSelection) => Promise<void>;
  selectNote: (noteId: string, folder?: FolderSelection) => Promise<void>;
  selectedFolder: FolderSelection;
  selectedNoteId: string | null;
  sessionEditedRef: MutableRefObject<string | null>;
  setActiveSearchIndex: (index: number) => void;
  setBinnedFiles: (value: null) => void;
  setDeletingNote: (value: null) => void;
  setDraggingNoteId: Dispatch<SetStateAction<string | null>>;
  setDropFolderId: Dispatch<SetStateAction<string | null>>;
  setMarkdown: (value: string) => void;
  setMobileActions: Dispatch<SetStateAction<boolean>>;
  setNoteSort: (value: NoteSort) => void;
  setNoteUploads: (count: number) => void;
  setPanel: (value: "history" | "share" | null) => void;
  setQuery: (value: string) => void;
  setSearchAll: Dispatch<SetStateAction<boolean>>;
  setSearchKind: (kind: "notes" | "whiteboards" | "files") => void;
  setSharingFolder: (folder: Folder | null) => void;
  setSortOpen: Dispatch<SetStateAction<boolean>>;
  sharingFolder: Folder | null;
  showMobilePanel: (panel: MobilePanel, mode?: "push" | "replace") => void;
  showingBoards: boolean;
  showingFacet: boolean;
  showingFiles: boolean;
  showingSearchResults: boolean;
  sortOpen: boolean;
  toastStatus: ReactNode;
  visibleNotes: NoteSummary[];
};

/**
 * Notes' folders in the global sidebar (phase 3, D1288): All notes, Shared with me, then the folders
 * as a tree, with the same counts, note drops, Share buttons, and New folder as the pane had. A click
 * goes through `selectFolder`, which saves or publishes the open note first, as the pane did.
 */
function NotesSidebarTree({ notes, folders, selectedFolder, selectFolder, canWrite, openNewFolder, draggingNoteId, dropFolderId, setDropFolderId, moveNote, setSharingFolder, renameFolder }: Pick<NotesAppProps, "notes" | "folders" | "selectedFolder" | "selectFolder" | "canWrite" | "openNewFolder" | "draggingNoteId" | "dropFolderId" | "setDropFolderId" | "moveNote" | "setSharingFolder" | "renameFolder">) {
  const counts = useMemo(() => countByFolder(notes), [notes]);
  const groups = useMemo(() => [{ id: "folders", heading: "Folders", folders, onNew: canWrite ? openNewFolder : undefined, newLabel: "New folder", empty: "Create a folder to organize your notes." }], [folders, canWrite, openNewFolder]);
  return <SidebarFolderTree
    app="notes"
    label="Note folders"
    entries={[
      { id: "all", label: "All notes", icon: Archive, href: formatRoute(notesRoute("all", null)), count: notes.length, current: selectedFolder === "all", onSelect: () => { void selectFolder("all"); } },
      { id: "shared", label: "Shared with me", icon: Users, href: formatRoute(notesRoute("shared", null)), count: notes.filter((item) => item.is_owner === 0).length, current: selectedFolder === "shared", onSelect: () => { void selectFolder("shared"); } }
    ]}
    groups={groups}
    current={selectedFolder === "all" || selectedFolder === "shared" ? null : selectedFolder}
    hrefFor={(folder) => formatRoute(notesRoute(folder.id, null))}
    onSelect={(folder) => { void selectFolder(folder.id); }}
    name={(folder) => folder.name}
    sub={(folder) => folder.is_owner !== 1 ? folder.owner_name : null}
    count={(folder) => counts.get(folder.id) ?? 0}
    drop={(folder) => ({
      className: dropFolderId === folder.id ? "drop-target" : undefined,
      handlers: {
        onDragEnter: (event) => { if (draggingNoteId && folder.is_owner === 1 && canWrite) { event.preventDefault(); setDropFolderId(folder.id); } },
        onDragOver: (event) => { if (draggingNoteId && folder.is_owner === 1 && canWrite) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } },
        onDragLeave: (event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropFolderId((current) => current === folder.id ? null : current); },
        onDrop: (event) => {
          event.preventDefault();
          if (folder.is_owner !== 1) return;
          const noteId = event.dataTransfer.getData("application/x-mynotes-note") || draggingNoteId;
          if (noteId) moveNote(noteId, folder).catch((reason) => notify.error(errorText(reason, "Could not move note")));
        }
      }
    })}
    action={(folder) => folder.is_owner === 1 && canWrite ? <button type="button" className="app-sidebar-tree-action" onClick={() => setSharingFolder(folder)} aria-label={`Share ${folder.name}`} title={`Share ${folder.name}`}><Share2 aria-hidden="true" /></button> : null}
    rename={{ can: (folder) => canRenameFolder(folder, canWrite), onRename: renameFolder }}
  />;
}

export function NotesApp(props: NotesAppProps) {
  const { activeSearchHit, activeSearchIndex, askDeleteNote, binnedFiles, boardFacetAvailable, boardSearch, boardsFacet, canWrite, clearSearch, closeMoveNote, closeNewFolder, confirmedFilesRef, createFolder, createNote, deleteNote, deletingNote, discard, downloadPdf, draftBadge, draggingNoteId, dropFolderId, editorLocked, fileFacetAvailable, fileSearch, filesFacet, focusAfterDeleteConfirm, folders, hasPublishableDelta, loadNavigation, loadNote, markdown, mobileActions, mobileBack, mobilePanel, moveNote, movingNote, newFolderOpen, note, noteSort, noteUploadControl, notes, onSearchKeyDown, openContentPath, openFileHit, openMoveNote, openNewFolder, openSearchHit, panel, publish, query, renameFolder, saveState, search, searchAll, searchEnabled, searchInputRef, selectFolder, selectNote, selectedFolder, selectedNoteId, sessionEditedRef, setActiveSearchIndex, setBinnedFiles, setDeletingNote, setDraggingNoteId, setDropFolderId, setMarkdown, setMobileActions, setNoteSort, setNoteUploads, setPanel, setQuery, setSearchAll, setSearchKind, setSharingFolder, setSortOpen, sharingFolder, showMobilePanel, showingBoards, showingFacet, showingFiles, showingSearchResults, sortOpen, toastStatus, visibleNotes } = props;
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  return (
    <main className="workspace" data-mobile-panel={mobilePanel}>
      {/* Phase 3 (D1288): on a computer the folders live in the global sidebar; the pane below is the phone's Folders panel. */}
      <ShellSidebarPortal><NotesSidebarTree {...props} /></ShellSidebarPortal>
      <aside className="folder-pane" id="note-folders">
        {/* D1276: the global sidebar has Home, the apps, and the account (and collapses, D1279), so Notes' own pane keeps only its folders. */}
        <header className="sidebar-header">
          <ShellMenuButton />
          <span className="sidebar-brand"><span className="brand-text"><strong>Notes</strong></span></span>
        </header>
        <nav className="folder-nav" aria-label="Note folders">
          <button className={selectedFolder === "all" ? "active" : ""} onClick={() => { void selectFolder("all"); }}><Archive /><span>All notes</span><b>{notes.length}</b></button>
          <button className={selectedFolder === "shared" ? "active" : ""} onClick={() => { void selectFolder("shared"); }}><Users /><span>Shared with me</span><b>{notes.filter((item) => item.is_owner === 0).length}</b></button>
          <div className="nav-label"><span>Folders</span>{canWrite && <button onClick={(event) => openNewFolder(event.currentTarget)} aria-label="New folder" aria-haspopup="dialog" title="New folder"><FolderPlus /></button>}</div>
          {folders.map((folder) => <div className={`folder-entry${folder.is_owner === 1 && canWrite ? " has-menu" : ""}`} key={folder.id}>
            {/* D1302: the phone's Folders panel renames in place too (⋯ → Rename). */}
            {renamingFolderId === folder.id && canRenameFolder(folder, canWrite) ? <div className="folder-link folder-link-renaming"><FolderIcon />
              <InlineRenameField name={folder.name} onCancel={() => setRenamingFolderId(null)} onSave={(name) => { setRenamingFolderId(null); renameFolder(folder, name); }} /></div> : <button
              className={`folder-link${selectedFolder === folder.id ? " active" : ""}${dropFolderId === folder.id ? " drop-target" : ""}`}
              onClick={() => { void selectFolder(folder.id); }}
              onDragEnter={(event) => { if (draggingNoteId && folder.is_owner === 1 && canWrite) { event.preventDefault(); setDropFolderId(folder.id); } }}
              onDragOver={(event) => { if (draggingNoteId && folder.is_owner === 1 && canWrite) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropFolderId((current) => current === folder.id ? null : current); }}
              onDrop={(event) => {
                event.preventDefault();
                if (folder.is_owner !== 1) return;
                const noteId = event.dataTransfer.getData("application/x-mynotes-note") || draggingNoteId;
                if (noteId) moveNote(noteId, folder).catch((reason) => notify.error(errorText(reason, "Could not move note")));
              }}
            >
              <FolderIcon />
              <span className="folder-copy">{folder.name}{folder.is_owner !== 1 && <small>{folder.owner_name}</small>}</span>
              <b>{notes.filter((item) => item.folder_id === folder.id).length}</b>
            </button>}
            {renamingFolderId !== folder.id && folder.is_owner === 1 && canWrite && <button className="folder-share-button" onClick={() => setSharingFolder(folder)} aria-label={`Share ${folder.name}`}><Share2 /></button>}
            {renamingFolderId !== folder.id && canRenameFolder(folder, canWrite) && <ReportOverflowMenu compact className="folder-pane-menu" label={`${folder.name} folder actions`}
              items={[{ id: "rename", label: "Rename", icon: <Pencil aria-hidden="true" />, onSelect: () => setRenamingFolderId(folder.id) }]} />}
            {/* Default keeps its name: an empty slot keeps its count and Share in line with the rows that have a ⋯. */}
            {folder.is_owner === 1 && canWrite && !canRenameFolder(folder, canWrite) && <span className="folder-pane-menu-spacer" aria-hidden="true" />}
          </div>)}
          {!folders.length && <p className="nav-empty">Create a folder to organize your notes.</p>}
        </nav>
      </aside>

      <section className="note-pane">
        <header className="note-pane-header">
          <div className="mobile-header"><button className="icon-button" onClick={() => mobileBack("folders")} aria-label="Back to folders"><ChevronLeft /></button><strong>Notes</strong></div>
          <div className="note-heading"><span className="eyebrow">{selectedFolder === "shared" ? "Shared" : "Library"}</span><h1>{selectedFolder === "all" ? "All notes" : selectedFolder === "shared" ? "Shared with me" : folders.find((folder) => folder.id === selectedFolder)?.name}</h1></div>
          <div className="note-header-actions">
            <div className="sort-control">
              <button className="icon-button" onClick={() => setSortOpen((open) => !open)} aria-label="Sort notes" aria-expanded={sortOpen}><ArrowUpDown /></button>
              {sortOpen && <div className="sort-menu" role="menu" aria-label="Sort notes">
                {noteSortOptions.map((option) => <button key={option.value} className={noteSort === option.value ? "active" : ""} onClick={() => { setNoteSort(option.value); setSortOpen(false); }} role="menuitem"><span>{option.label}</span>{noteSort === option.value && <Check />}</button>)}
              </div>}
            </div>
            {canWrite && <button className="icon-button new-note-button" onClick={createNote} aria-label="New note"><FilePlus2 /></button>}
          </div>
          {searchEnabled && <div className="search-box">
            <Search aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              maxLength={SEARCH_MAX_CHARS}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search notes"
              aria-label="Search notes"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={showingSearchResults}
              aria-controls={searchListId}
              aria-activedescendant={activeSearchHit ? searchOptionId(activeSearchHit.id) : undefined}
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
            />
            {query ? <button type="button" className="search-clear" onClick={() => { clearSearch(); searchInputRef.current?.focus(); }} aria-label="Clear search"><X /></button> : <kbd aria-hidden="true">/</kbd>}
          </div>}
          {search.active && (boardFacetAvailable || fileFacetAvailable) && <div className="search-scope search-facets" role="group" aria-label="Search in">
            <button type="button" className="search-scope-chip" aria-pressed={!boardsFacet && !filesFacet} onClick={() => setSearchKind("notes")}><FileText aria-hidden="true" />Notes</button>
            {boardFacetAvailable && <button type="button" className="search-scope-chip" aria-pressed={boardsFacet} onClick={() => setSearchKind("whiteboards")}><PenTool aria-hidden="true" />Whiteboards</button>}
            {fileFacetAvailable && <button type="button" className="search-scope-chip" aria-pressed={filesFacet} onClick={() => setSearchKind("files")}><FolderIcon aria-hidden="true" />Files</button>}
          </div>}
          {search.active && !showingFacet && selectedFolder !== "all" && <div className="search-scope">
            {!searchAll && <span>Searching {selectedFolder === "shared" ? "Shared with me" : folders.find((folder) => folder.id === selectedFolder)?.name ?? "this folder"}</span>}
            <button type="button" className="search-scope-chip" aria-pressed={searchAll} onClick={() => setSearchAll((all) => !all)}>{searchAll ? <Check aria-hidden="true" /> : <Archive aria-hidden="true" />}Search all notes</button>
          </div>}
          <p className="sr-only" aria-live="polite" aria-atomic="true">{showingSearchResults ? (search.results.length ? `${search.results.length}${search.truncated ? " or more" : ""} ${search.results.length === 1 && !search.truncated ? "result" : "results"}` : "No results") : ""}</p>
        </header>
        <ReadOnlyBanner />
        <div className="note-list">
          {search.status === "error" && <p className="search-error" role="alert">{search.error}</p>}
          {showingBoards && boardSearch.status === "error" && <p className="search-error" role="alert">{boardSearch.error}</p>}
          {showingBoards && boardSearch.status === "loading" && <p className="search-status" role="status">Searching whiteboards…</p>}
          {showingBoards && boardSearch.status === "ready" && <WhiteboardSearchResults results={boardSearch.results} truncated={boardSearch.truncated} relativeTime={relativeTime} onOpen={(hit) => { void openContentPath(`/whiteboards/${hit.id}`); }} />}
          {showingBoards && boardSearch.status === "ready" && !boardSearch.results.length && <div className="empty-state"><div><PenTool /></div><h2>No whiteboards match</h2><p>Names and the text on boards you can open are searched.</p></div>}
          {showingFiles && fileSearch.status === "error" && <p className="search-error" role="alert">{fileSearch.error}</p>}
          {showingFiles && fileSearch.status === "loading" && <p className="search-status" role="status">Searching files…</p>}
          {showingFiles && fileSearch.status === "ready" && <FileSearchResults results={fileSearch.results} truncated={fileSearch.truncated} relativeTime={relativeTime} onOpen={(hit) => { void openFileHit(hit.id); }} />}
          {showingFiles && fileSearch.status === "ready" && !fileSearch.results.length && <div className="empty-state"><div><FolderIcon /></div><h2>No files match</h2><p>Names, text files, and PDF text you can open are searched.</p></div>}
          {showingSearchResults && <SearchResults
            results={search.results}
            truncated={search.truncated}
            activeIndex={activeSearchIndex}
            selectedNoteId={selectedNoteId}
            folders={folders}
            relativeTime={relativeTime}
            onOpen={openSearchHit}
            onHover={setActiveSearchIndex}
          />}
          {showingSearchResults && !search.results.length && <div className="empty-state"><div><Search /></div><h2>No matches</h2><p>{searchAll || selectedFolder === "all" ? "Try other words, or fewer of them." : "Try other words, or search all notes."}</p></div>}
          {!showingSearchResults && !showingFacet && visibleNotes.map((item) => <article
            key={item.id}
            className={`note-card${selectedNoteId === item.id ? " selected" : ""}${draggingNoteId === item.id ? " dragging" : ""}`}
            draggable={item.is_owner === 1 && canWrite}
            onDragStart={(event) => {
              if (item.is_owner !== 1 || !canWrite) return;
              setDraggingNoteId(item.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("application/x-mynotes-note", item.id);
              event.dataTransfer.setData("text/plain", item.id);
            }}
            onDragEnd={() => { setDraggingNoteId(null); setDropFolderId(null); }}
          >
            <button className="note-card-select" onClick={() => { void selectNote(item.id); }}>
              <span className="note-title">{item.title}</span>
              <span className="note-meta"><time>{relativeTime(item.updated_at)}</time>{item.draft_revision !== null && item.is_owner === 1 ? (item.draft_mcp_key_name ? <em className="mcp-draft-badge"><Bot aria-hidden="true" />{mcpDraftBadge(item.draft_mcp_key_name)}</em> : <em>Draft</em>) : item.visibility !== "private" ? <em><Users /> Shared</em> : null}</span>
              {item.is_owner === 0 && <span className="note-owner">by {item.owner_name}</span>}
            </button>
            {item.is_owner === 1 && canWrite && <button className="note-delete-button" disabled={editorLocked} onClick={(event) => askDeleteNote(item.id, item.title, event.currentTarget)} aria-label={`Delete ${item.title}`} title="Delete note"><Trash2 /></button>}
          </article>)}
          {!showingSearchResults && !showingFacet && !visibleNotes.length && <div className="empty-state"><div><FilePlus2 /></div><h2>No notes here</h2><p>{query ? (search.status === "loading" ? "Searching note text…" : "Try another search.") : selectedFolder === "shared" ? "Notes shared with you will appear here." : (canWrite ? "Create a note and start writing." : "Notes shared with you appear here.")}</p>{!query && selectedFolder !== "shared" && canWrite && <button onClick={createNote}>New note</button>}</div>}
        </div>
      </section>

      <section className="editor-pane">
        {!note ? <div className="editor-empty"><div className="empty-glyph"><Sparkles /></div><h2>Select a note</h2><p>Choose one from the list or create something new.</p></div> : <>
          <header className="editor-toolbar">
            <div className="mobile-editor-nav"><button className="icon-button" onClick={() => mobileBack("notes")} aria-label="Back to notes"><ChevronLeft /></button></div>
            <div className={`save-indicator ${saveState}`}><span />{saveState === "saving" ? "Saving…" : saveState === "conflict" ? "Save conflict" : saveState === "error" ? "Not saved" : note.hasDraft ? "Draft saved" : `Version ${note.current_version}`}</div>
            {draftBadge && <span className="mcp-draft-badge" title="Written through an MCP API key. It stays a draft until you publish it."><Bot aria-hidden="true" />{draftBadge}</span>}
            <div className="toolbar-actions">
              <button className="icon-button" onClick={() => setPanel("history")} aria-label="Version history"><History /></button>
              <button className="icon-button" onClick={downloadPdf} aria-label="Download as PDF" title="Download as PDF"><FileDown /></button>
              {note.isOwner && canWrite && <button className="icon-button" disabled={editorLocked} onClick={(event) => openMoveNote(event.currentTarget)} aria-label="Move to folder…" title="Move to folder"><FolderInput /></button>}
              {note.isOwner && canWrite && <button className="icon-button" onClick={() => setPanel("share")} aria-label="Share note"><Share2 /></button>}
              {note.isOwner && canWrite && note.hasDraft && <button className="text-action" disabled={editorLocked} onClick={() => { void discard(); }}>Discard</button>}
              {hasPublishableDelta && canWrite && <button className="publish-button" disabled={editorLocked} onClick={() => { void publish(true, true); }}>Publish version</button>}
              <button className="icon-button mobile-more" disabled={editorLocked} onClick={() => setMobileActions((open) => !open)} aria-label="More actions"><MoreHorizontal /></button>
            </div>
            {mobileActions && <div className="mobile-actions-menu">
              <button onClick={() => { setPanel("history"); setMobileActions(false); }}><History />Version history</button>
              <button onClick={() => { setMobileActions(false); downloadPdf(); }}><FileDown />Download as PDF</button>
              {note.isOwner && canWrite && <button disabled={editorLocked} onClick={() => openMoveNote(document.querySelector<HTMLElement>(".toolbar-actions .mobile-more"))}><FolderInput />Move to folder…</button>}
              {note.isOwner && canWrite && <button onClick={() => { setPanel("share"); setMobileActions(false); }}><Share2 />Share note</button>}
              {note.isOwner && canWrite && note.hasDraft && <button disabled={editorLocked} onClick={() => { setMobileActions(false); void discard(document.querySelector<HTMLElement>(".toolbar-actions .mobile-more")); }}><X />Discard draft</button>}
              {hasPublishableDelta && canWrite && <button disabled={editorLocked} onClick={() => { setMobileActions(false); void publish(true, true); }}><Sparkles />Publish version</button>}
            </div>}
          </header>
          <article className="document-shell">
            <div className="document-meta"><span>{note.isOwner ? "Private workspace" : note.canEdit ? `Shared by ${note.owner_name} · you can edit` : `Shared by ${note.owner_name}`}</span><i /> <span>{markdown.trim().split(/\s+/).filter(Boolean).length} words</span></div>
            <NoteEditor key={note.id} markdown={markdown} editable={(note.isOwner || note.canEdit === true) && canWrite && !editorLocked} onChange={(value) => { sessionEditedRef.current = note.id; setMarkdown(value); }} folderId={note.folder_id} attachHost="note" onNotice={notify}
              onFileConfirmed={(documentId) => { const files = confirmedFilesRef.current.get(note.id) ?? new Set<string>(); files.add(documentId); confirmedFilesRef.current.set(note.id, files); }}
              onUploadsChange={setNoteUploads} uploadControl={noteUploadControl} mentionTarget={{ kind: "note", id: note.id }} mentionNoun="note" />
          </article>
        </>}
      </section>

      {panel === "history" && note && <HistoryPanel note={note} canRestore={canWrite} onClose={() => setPanel(null)} onRestored={async () => { setPanel(null); await loadNote(note.id); await loadNavigation(); notify.success("Version restored as a draft"); }} />}
      {panel === "share" && note && <AccessSheet kind="note" id={note.id} title={note.title || "Untitled"} guardHistory onClose={() => setPanel(null)} onSaved={async () => { setPanel(null); await loadNote(note.id); await loadNavigation(); notify.success("Access updated"); }} />}
      {binnedFiles && <BinnedFilesConfirm noteId={binnedFiles.noteId} documentIds={binnedFiles.documentIds}
        onCancel={() => setBinnedFiles(null)}
        onDone={(message) => {
          const shown = binnedFiles.noteId;
          setBinnedFiles(null);
          notify.success(message);
          if (note?.id === shown) void loadNote(shown);
        }} />}
      {deletingNote && <NoteDeleteConfirm title={deletingNote.title}
        onCancel={() => { setDeletingNote(null); focusAfterDeleteConfirm(); }}
        onConfirm={() => {
          const target = deletingNote;
          setDeletingNote(null);
          void deleteNote(target.id).catch((reason) => notify.error(errorText(reason, "Could not delete note"))).finally(focusAfterDeleteConfirm);
        }} />}
      {movingNote && note && <MoveSheet
        document={{ name: note.title.trim() || "Untitled", folder_id: note.folder_id }}
        itemLabel="note"
        folders={folders}
        onMove={async (folder) => { await moveNote(note.id, folder); closeMoveNote(); }}
        onCancel={closeMoveNote}
      />}
      {newFolderOpen && <NameDialog
        title="New folder"
        eyebrow="Notes"
        label="Folder name"
        initialValue=""
        submitLabel="Create folder"
        hint="Up to 120 characters."
        validate={validateFolderName}
        onSubmit={createFolder}
        onCancel={closeNewFolder}
      />}
      {sharingFolder && <AccessSheet kind="folder" id={sharingFolder.id} title={sharingFolder.name} guardHistory onClose={() => setSharingFolder(null)} onSaved={async () => { setSharingFolder(null); await loadNavigation(); notify.success("Folder access updated"); }} />}
      {panel && panel !== "share" && <button className="panel-scrim" onClick={() => { setPanel(null); setSharingFolder(null); }} aria-label="Close panel" />}
      {toastStatus}
      <nav className="mobile-tabbar">
        <button className={mobilePanel === "folders" ? "active" : ""} onClick={() => showMobilePanel("folders")}><Menu />Folders</button>
        <button className={mobilePanel === "notes" ? "active" : ""} onClick={() => showMobilePanel("notes")}><Archive />Notes</button>
        <button className={mobilePanel === "editor" ? "active" : ""} disabled={!note} onClick={() => showMobilePanel("editor")}><Sparkles />Editor</button>
      </nav>
    </main>
  );
}
