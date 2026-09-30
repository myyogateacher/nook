import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowUpDown, Check, TriangleAlert, ChevronDown, Ellipsis, ChevronLeft, ChevronUp, Files, Folder as FolderIcon, FolderPlus, House, LayoutGrid, List as ListIcon, LogOut, Menu, PanelLeftClose, PanelLeftOpen, RotateCcw, Search, Settings, Sparkles, Trash2, Upload, Users, X } from "lucide-react";
import { api, ApiError } from "../api";
import { restoreBinItem } from "../bin/binApi";
import { restoredMessage } from "../bin/binFormat";
import { readHistoryDepth } from "../appShellNavigation";
import { dialogPopDirection, popStateClosedDialog, registerHistoryDialogGuard, undoDialogPop, useDialogSentinel } from "../historyDialogs";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { useConfirm } from "../ui/useConfirm";
import { NotificationBell } from "../notifications/NotificationBell";
import { HeaderInboxButton } from "../AppShell";
import { readFilesHistorySnapshot, type FilesNavigationSnapshot, type FilesPanel } from "../filesNavigation";
import { closedPreviewTarget, documentInFolder, filesRoute, resolveFilesPanel, resolveFilesRoute, type FilesRoute } from "../filesRoute";
import { isMobileViewport } from "../mobileNavigation";
import { formatRoute, parseRoute, type Route } from "../router";
import type { DocumentSummary, Folder } from "../types";
import { ConfirmDialog } from "./Dialog";
import {
  canDropOnFolder,
  canManage as ownsDocument,
  deleteConfirmMessage,
  DOCUMENT_DRAG_TYPE,
  emptyToastState,
  fileCountLabel,
  fileSortOptions,
  fileToastReducer,
  filesEmptyState,
  filterDocuments,
  isDocumentDrag,
  isOsFileDrag,
  movedMessage,
  readDocumentDragPayload,
  rollbackRename,
  upsertListedDocument,
  ROW_ITEM_ATTRIBUTE,
  shortcutDocumentId,
  readFileSort,
  sortDocuments,
  toastDuration,
  uploadDropMessage,
  validateFolderName,
  writeFileSort,
  type FileSort
} from "./fileActions";
import { contentUrl, deleteFile, formatBytes, getFile, listFiles, moveFile, renameFile, uploadFile, UploadRequestError } from "./filesApi";
import { FileActionSheet, type FileSheetAction } from "./FileActionSheet";
import { FilePreview } from "./FilePreview";
import { gridColumnCount, moveFileSelection, readFileView, writeFileView, type FileView } from "./fileView";
import { AccessSheet } from "../access/AccessSheet";
import { MoveSheet } from "./MoveSheet";
import { NameDialog, RenameDialog } from "./RenameDialog";
import { documentIcon, relativeTime } from "./format";
import { canRetryUpload, emptyUploadQueue, uploadAnnouncement, uploadQueueReducer, uploadQueueSummary, uploadsToStart, type UploadItem } from "./uploadQueue";
import "./files.css";
import { Avatar } from "../ui/Avatar";
import { useSelfAvatar } from "../ui/selfAvatar";
import { ReadOnlyBanner, useRole } from "../team/roleAccess";

export type FilesNavigate = (route: Route, options?: { replace?: boolean; removed?: boolean; filesPanel?: FilesPanel }) => void;

type FilesAppProps = {
  userId: string;
  displayName: string;
  navigate: FilesNavigate;
  flash: (message: string) => void;
  onHome: () => void;
  /** Opens the Bin; the rail footer entry is hidden when the host does not wire it. */
  onBin?: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  /** Opens a whiteboard's canvas (Wave 23); unset while the Whiteboards module is off, so boards preview as files. */
  onOpenWhiteboard?: (id: string) => void;
};

type LoadedData = { folders: Folder[]; documents: DocumentSummary[] };

// Owned folders with Default first, then folders other people shared with the caller.
function orderFolders(folders: Folder[]) {
  const owned = folders.filter((folder) => folder.is_owner === 1);
  owned.sort((left, right) => right.is_default - left.is_default);
  return { owned, shared: folders.filter((folder) => folder.is_owner !== 1) };
}

function mergeDocument(documents: DocumentSummary[], document: DocumentSummary) {
  return [document, ...documents.filter((item) => item.id !== document.id)].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

const errorCode = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object"
  ? (reason.payload as { code?: unknown }).code
  : undefined;
const errorMessage = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;

type FilesDialog = { kind: "actions" | "rename" | "move" | "share" | "delete"; documentId: string } | { kind: "newFolder" };

// localStorage can be missing (server render) or throw (blocked storage).
function browserStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

const statusLabels: Record<UploadItem["status"], string> = { queued: "Waiting", uploading: "Uploading", done: "Uploaded", failed: "Failed", canceled: "Canceled" };

/** The confirm for leaving Files while uploads run (Home, Bin, Sign out, and browser Back or Forward). */
export function leaveUploadsRequest(pending: number) {
  return {
    title: "Leave Files?",
    message: `${pending === 1 ? "An upload is" : `${pending} uploads are`} still in progress and will be canceled if you leave.`,
    confirmLabel: "Leave and cancel",
    danger: true
  };
}

export function FilesApp({ userId, displayName, navigate, flash, onHome, onBin, onSettings, onSignOut, onOpenWhiteboard }: FilesAppProps) {
  const selfAvatar = useSelfAvatar();
  // Viewers and guests read and download; upload, new folder, rename, move, share, and delete are hidden.
  const { canWrite } = useRole();
  const canManage = (document: Pick<DocumentSummary, "is_owner">) => canWrite && ownsDocument(document);
  const [data, setData] = useState<LoadedData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [folder, setFolder] = useState<string>("all");
  const [documentId, setDocumentId] = useState<string | null>(null);
  // A document the URL named that the list does not include (for example beyond the list limit).
  const [extraDocument, setExtraDocument] = useState<DocumentSummary | null>(null);
  const [panel, setPanel] = useState<FilesPanel>("folders");
  const [collapsed, setCollapsed] = useState(false);
  const [queueOpen, setQueueOpen] = useState(true);
  const [queue, dispatch] = useReducer(uploadQueueReducer, emptyUploadQueue);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef(new Map<string, File>());
  const controllersRef = useRef(new Map<string, AbortController>());
  const startedRef = useRef(new Set<string>());
  const dataRef = useRef<LoadedData | null>(null);
  dataRef.current = data;
  const folderRef = useRef(folder);
  folderRef.current = folder;
  const routeGenerationRef = useRef(0);
  const [dialog, setDialog] = useState<FilesDialog | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toastState, toastDispatch] = useReducer(fileToastReducer, emptyToastState);
  // The row (document id) or control that opened the current dialog, so focus can go back to it.
  const returnFocusRef = useRef<string | HTMLElement | null>(null);
  const [sort, setSort] = useState<FileSort>(() => readFileSort(browserStorage(), userId));
  const [sortOpen, setSortOpen] = useState(false);
  const [view, setView] = useState<FileView>(() => readFileView(browserStorage(), userId));
  const [query, setQuery] = useState("");
  // Row drag (move onto a folder) and OS file drag (upload) state.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);
  const [fileDragOver, setFileDragOver] = useState(false);
  const fileDragDepthRef = useRef(0);
  const notify = useCallback((message: string, undoDocumentId: string | null = null) => toastDispatch({ type: "show", message, undoDocumentId }), []);

  useEffect(() => {
    if (!sortOpen) return;
    const closeSort = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && event.target instanceof Element && event.target.closest(".file-sort-control")) return;
      setSortOpen(false);
    };
    window.addEventListener("click", closeSort);
    window.addEventListener("keydown", closeSort);
    return () => { window.removeEventListener("click", closeSort); window.removeEventListener("keydown", closeSort); };
  }, [sortOpen]);
  // The sort menu is a history layer like any dropdown (D69): Back closes only the menu.
  useHistoryDialogGuard(sortOpen, () => setSortOpen(false));

  // Files dropped outside the list would make the browser navigate to them; swallow those drops.
  useEffect(() => {
    const guard = (event: DragEvent) => {
      if (!isOsFileDrag(event.dataTransfer?.types)) return;
      event.preventDefault();
      if (event.type === "dragover" && event.dataTransfer) event.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => { window.removeEventListener("dragover", guard); window.removeEventListener("drop", guard); };
  }, []);

  const toast = toastState.toast;
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => toastDispatch({ type: "dismiss", id: toast.id }), toastDuration(toast));
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Applies a Files URL (first load or Back/Forward) to the loaded data.
  const applyRoute = useCallback(async (route: FilesRoute, snapshot: FilesNavigationSnapshot | null, loaded: LoadedData) => {
    const generation = ++routeGenerationRef.current;
    let named: DocumentSummary | null = null;
    if (route.documentId) {
      named = loaded.documents.find((item) => item.id === route.documentId) ?? null;
      if (!named) named = await getFile(route.documentId).then(({ document }) => document).catch(() => null);
      if (generation !== routeGenerationRef.current) return;
    }
    const resolved = resolveFilesRoute(route, { folders: loaded.folders, document: named }, { snapshot, lastFolder: folderRef.current });
    const nextPanel = resolveFilesPanel(resolved, snapshot);
    setFolder(resolved.folder);
    setDocumentId(resolved.documentId);
    setExtraDocument(named && !loaded.documents.some((item) => item.id === named.id) ? named : null);
    setPanel(nextPanel);
    if (resolved.missing) flash(resolved.missing === "document" ? "File not found" : "Folder not found");
    const target = filesRoute(resolved.folder, resolved.documentId);
    if (resolved.missing || formatRoute(target) !== window.location.pathname) navigate(target, { replace: true, filesPanel: nextPanel });
  }, [flash, navigate]);

  const currentFilesRoute = () => {
    const route = parseRoute(window.location.pathname);
    return route.app === "files" ? route : filesRoute("all", null);
  };

  useEffect(() => {
    let active = true;
    setLoadError(null);
    Promise.all([api<{ folders: Folder[] }>("/folders"), listFiles()]).then(([{ folders }, { documents }]) => {
      if (!active) return;
      const loaded = { folders, documents };
      setData(loaded);
      void applyRoute(currentFilesRoute(), readFilesHistorySnapshot(window.history.state, userId), loaded);
    }).catch((reason) => {
      if (active) setLoadError(reason instanceof Error && reason.message ? reason.message : "Could not load your files");
    });
    return () => { active = false; };
    // The first load (and Try again); later URL changes arrive through popstate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, loadAttempt]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (popStateClosedDialog(event)) return;
      const route = parseRoute(window.location.pathname);
      if (route.app !== "files" || !dataRef.current) return;
      void applyRoute(route, readFilesHistorySnapshot(event.state, userId), dataRef.current);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [applyRoute, userId]);

  // D18: browser Back (or Forward) while a dialog or sheet is open only closes it. Dialogs have no
  // history entry of their own, so the browser's move is undone with history.go() and the panel stays.
  const dialogOpenRef = useRef(false);
  dialogOpenRef.current = dialog !== null;
  // The history depth of the entry the dialog was opened on, to tell Back from Forward.
  const dialogDepthRef = useRef(0);
  const dialogWasOpenRef = useRef(false);
  if (dialog !== null && !dialogWasOpenRef.current) dialogDepthRef.current = readHistoryDepth(window.history.state);
  dialogWasOpenRef.current = dialog !== null;
  useDialogSentinel(dialog !== null);
  const closeDialogRef = useRef<() => void>(() => undefined);
  useEffect(() => registerHistoryDialogGuard((poppedState) => {
    if (!dialogOpenRef.current) return false;
    dialogOpenRef.current = false;
    closeDialogRef.current();
    const direction = dialogPopDirection(dialogDepthRef.current, readHistoryDepth(poppedState));
    // Direction unknown: let the route handlers follow the browser instead of leaving a stale URL.
    if (!direction) return false;
    undoDialogPop(direction);
    return true;
  }), []);

  // Leaving Files cancels whatever is still uploading.
  useEffect(() => {
    const controllers = controllersRef.current;
    return () => { for (const controller of controllers.values()) controller.abort(); controllers.clear(); };
  }, []);

  const folders = data?.folders ?? [];
  const documents = data?.documents ?? [];
  const { owned, shared } = useMemo(() => orderFolders(folders), [folders]);
  const defaultFolder = owned.find((item) => item.is_default === 1 || item.name === "Default") ?? owned[0] ?? null;
  const currentFolder = folders.find((item) => item.id === folder) ?? null;
  const uploadFolderId = folder === "all" ? defaultFolder?.id ?? null : currentFolder?.is_owner === 1 ? currentFolder.id : undefined;
  const canUpload = canWrite && uploadFolderId !== undefined && data !== null;
  const inFolder = useMemo(() => documents.filter((item) => documentInFolder(item, folder)), [documents, folder]);
  const visible = useMemo(() => sortDocuments(filterDocuments(inFolder, query), sort), [inFolder, query, sort]);
  const selected = documents.find((item) => item.id === documentId) ?? (extraDocument?.id === documentId ? extraDocument : null);
  const folderTitle = folder === "all" ? "All files" : folder === "shared" ? "Shared with me" : currentFolder?.name ?? "Folder";
  const pendingUploads = queue.items.filter((item) => item.status === "queued" || item.status === "uploading").length;
  const { ask: askLeave, confirmElement: leaveConfirm } = useConfirm();

  // Q1: browser Back or Forward that would leave Files while uploads run asks first, as Home, Bin,
  // and Sign out do. The move is undone at once; Cancel keeps the uploads and the page; "Leave and
  // cancel" stops the uploads and repeats the move exactly once. Moves within Files, and Back with a
  // Files dialog open (it closes the dialog), are left alone.
  const uploadsRef = useRef(0);
  uploadsRef.current = pendingUploads;
  const entryDepthRef = useRef(0);
  useEffect(() => { entryDepthRef.current = readHistoryDepth(window.history.state); });
  const leavingRef = useRef(false);
  useEffect(() => registerHistoryDialogGuard((poppedState) => {
    if (!uploadsRef.current || leavingRef.current || dialogOpenRef.current) return false;
    if (parseRoute(window.location.pathname).app === "files") return false;
    const direction = dialogPopDirection(entryDepthRef.current, readHistoryDepth(poppedState));
    if (!direction) return false;
    undoDialogPop(direction);
    void askLeave(leaveUploadsRequest(uploadsRef.current)).then((leave) => {
      if (!leave) return;
      for (const controller of controllersRef.current.values()) controller.abort();
      leavingRef.current = true;
      window.history.go(direction === "back" ? -1 : 1);
    });
    return true;
  }), [askLeave]);
  const summary = uploadQueueSummary(queue);
  const emptyCopy = filesEmptyState(folder === "all" ? { kind: "all" } : folder === "shared" ? { kind: "shared" } : { kind: "folder", name: currentFolder?.name ?? "this folder", owned: currentFolder?.is_owner === 1, ownerName: currentFolder?.owner_name ?? "Its owner" });

  const findDocument = (id: string) => documents.find((item) => item.id === id) ?? (extraDocument?.id === id ? extraDocument : null);
  const dialogDocument = dialog && dialog.kind !== "newFolder" ? findDocument(dialog.documentId) : null;

  const setDocuments = (change: (documents: DocumentSummary[]) => DocumentSummary[]) =>
    setData((current) => current ? { ...current, documents: change(current.documents) } : current);
  const storeDocument = (document: DocumentSummary) => {
    const unlistedId = extraDocument?.id ?? null;
    setDocuments((items) => upsertListedDocument(items, document, unlistedId));
    setExtraDocument((current) => current?.id === document.id ? document : current);
  };

  function focusRow(target: string | HTMLElement | null) {
    if (!target) return;
    // After React commits (a restored row only exists then). A timer, unlike requestAnimationFrame, also runs in background tabs.
    window.setTimeout(() => {
      const element = typeof target === "string" ? window.document.querySelector<HTMLElement>(`[data-document-id="${CSS.escape(target)}"]`) : target;
      // The row can be gone (moved out of this folder, deleted): fall back to the list itself.
      if (element?.isConnected) element.focus();
      else window.document.getElementById("file-list")?.focus();
    }, 0);
  }

  function openDialog(kind: Exclude<FilesDialog["kind"], "newFolder" | "actions">, document: DocumentSummary) {
    if (!canManage(document)) return;
    returnFocusRef.current = document.id;
    setDialog({ kind, documentId: document.id });
  }

  // The ⋯ sheet is open to everyone (Download, Open preview); it hands off to the owner dialogs.
  function openActions(document: DocumentSummary, trigger: HTMLElement) {
    returnFocusRef.current = trigger;
    setDialog({ kind: "actions", documentId: document.id });
  }

  function chooseSheetAction(document: DocumentSummary, action: FileSheetAction) {
    if (!canManage(document)) return;
    setDialog({ kind: action, documentId: document.id });
  }

  const closeDialog = useCallback(() => {
    setDialog(null);
    focusRow(returnFocusRef.current);
  }, []);
  closeDialogRef.current = closeDialog;

  function chooseSort(next: FileSort) {
    setSort(next);
    setSortOpen(false);
    writeFileSort(browserStorage(), userId, next);
  }

  function chooseView(next: FileView) {
    setView(next);
    writeFileView(browserStorage(), userId, next);
  }

  function openNewFolder(trigger: HTMLElement) {
    returnFocusRef.current = trigger;
    setDialog({ kind: "newFolder" });
  }

  async function createFolder(name: string) {
    const { folder: created } = await api<{ folder: { id: string; name: string } }>("/folders", { method: "POST", body: JSON.stringify({ name, parentId: null }) });
    const { folders: reloaded } = await api<{ folders: Folder[] }>("/folders");
    setData((current) => current ? { ...current, folders: reloaded } : current);
    setDialog(null);
    returnFocusRef.current = null;
    selectFolder(created.id);
    notify(`Created folder ${created.name}`);
  }

  // Optimistic: the list shows the new name at once and goes back to the old one if the server refuses.
  function renameDocument(document: DocumentSummary, name: string) {
    closeDialog();
    const previous = document.name;
    storeDocument({ ...document, name });
    renameFile(document.id, name).then(({ document: saved }) => {
      storeDocument(saved);
      notify(`Renamed to “${saved.name}”`);
    }).catch((reason) => {
      setDocuments((items) => rollbackRename(items, document.id, name, previous));
      setExtraDocument((current) => current ? rollbackRename([current], document.id, name, previous)[0] : current);
      notify(errorMessage(reason, "Could not rename the file"));
    });
  }

  async function moveDocument(document: DocumentSummary, target: Folder) {
    const { document: moved } = await moveFile(document.id, target.id);
    storeDocument(moved);
    // An open file follows the move, like Notes; otherwise the list stays where it is.
    if (documentId === moved.id && folder !== "all" && folder !== "shared") {
      setFolder(target.id);
      navigate(filesRoute(target.id, moved.id), { replace: true, filesPanel: panel });
    }
    notify(movedMessage(target.name, moved.visibility));
  }

  async function refreshDocument(id: string) {
    const { document } = await getFile(id);
    storeDocument(document);
  }

  async function deleteDocument(document: DocumentSummary) {
    setDeleting(true);
    // Focus moves to the neighbouring row once the deleted one is gone.
    const index = visible.findIndex((item) => item.id === document.id);
    const neighbour = index >= 0 ? visible[index + 1] ?? visible[index - 1] ?? null : null;
    try {
      await deleteFile(document.id);
      setDocuments((items) => items.filter((item) => item.id !== document.id));
      setExtraDocument((current) => current?.id === document.id ? null : current);
      if (documentId === document.id) {
        setDocumentId(null);
        setPanel("files");
        navigate(filesRoute(folder, null), { replace: true, removed: true, filesPanel: "files" });
      }
      setDialog(null);
      returnFocusRef.current = null;
      focusRow(neighbour?.id ?? null);
      notify(`Moved “${document.name}” to the Bin`, document.id);
    } catch (reason) {
      setDialog(null);
      if (reason instanceof ApiError && reason.status === 404) {
        setDocuments((items) => items.filter((item) => item.id !== document.id));
        notify("This file no longer exists");
      } else {
        focusRow(returnFocusRef.current);
        notify(errorMessage(reason, "Could not delete the file"));
      }
    } finally {
      setDeleting(false);
    }
  }

  async function undoDelete(id: string) {
    toastDispatch({ type: "clear" });
    try {
      const result = await restoreBinItem({ type: "document", id });
      try {
        await refreshDocument(id);
      } catch {
        notify(`${restoredMessage(result.folderName ?? "Default", result.visibility)}, but the list could not be refreshed. Reload to see the file.`);
        return;
      }
      notify(result.alreadyRestored ? `Already restored to ${result.folderName ?? "Default"}` : restoredMessage(result.folderName ?? "Default", result.visibility));
      focusRow(id);
    } catch (reason) {
      if (errorCode(reason) === "PURGING") notify("This file is being deleted forever and can't be restored");
      else if (reason instanceof ApiError && reason.status === 404) notify("This file is no longer in the Bin");
      else notify(errorMessage(reason, "Could not restore the file"));
    }
  }

  // ↑/↓ (and ←/→ in the grid) move the selection, Enter opens the preview (the item's own click),
  // F2 renames, Delete/Backspace deletes.
  function onListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || dialogOpenRef.current) return;
    const rowId = shortcutDocumentId(event.target instanceof Element ? event.target : null, documentId);
    const index = rowId ? visible.findIndex((item) => item.id === rowId) : -1;
    const columns = view === "grid" ? gridColumnCount(window.getComputedStyle(event.currentTarget).gridTemplateColumns) : 1;
    const nextIndex = moveFileSelection(index, event.key, visible.length, columns, view);
    if (nextIndex !== null) {
      event.preventDefault();
      const next = visible[nextIndex];
      if (next.id !== documentId) {
        setDocumentId(next.id);
        navigate(filesRoute(folder, next.id), { replace: true, filesPanel: panel });
      }
      focusRow(next.id);
      return;
    }
    const current = index >= 0 ? visible[index] : null;
    if (!current || !canManage(current)) return;
    if (event.key === "F2") {
      event.preventDefault();
      openDialog("rename", current);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      openDialog("delete", current);
    }
  }

  function endRowDrag() {
    setDraggingId(null);
    setDropFolderId(null);
  }

  function startRowDrag(event: ReactDragEvent<HTMLElement>, document: DocumentSummary) {
    if (!canManage(document)) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, document.id);
    event.dataTransfer.effectAllowed = "move";
    setDraggingId(document.id);
  }

  function folderDragOver(event: ReactDragEvent<HTMLElement>, target: Folder) {
    if (!isDocumentDrag(event.dataTransfer.types)) return;
    const dragged = draggingId ? findDocument(draggingId) : null;
    // Not calling preventDefault leaves the drop refused (non-owned folders, or the file's own folder).
    if (!canDropOnFolder(target, dragged)) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dropFolderId !== target.id) setDropFolderId(target.id);
  }

  function folderDrop(event: ReactDragEvent<HTMLElement>, target: Folder) {
    event.preventDefault();
    const id = readDocumentDragPayload(event.dataTransfer.getData(DOCUMENT_DRAG_TYPE)) ?? draggingId;
    endRowDrag();
    const dragged = id ? findDocument(id) : null;
    if (!dragged || !canDropOnFolder(target, dragged)) return;
    moveDocument(dragged, target).catch((reason) => notify(errorMessage(reason, "Could not move the file")));
  }

  const uploadTarget = canUpload ? (folder === "all" ? defaultFolder?.name ?? "Default" : currentFolder?.name ?? "") : null;

  function paneDragEnter(event: ReactDragEvent<HTMLElement>) {
    if (!isOsFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    fileDragDepthRef.current += 1;
    setFileDragOver(true);
  }

  function paneDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!isOsFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = canUpload ? "copy" : "none";
  }

  function paneDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!isOsFileDrag(event.dataTransfer.types)) return;
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (!fileDragDepthRef.current) setFileDragOver(false);
  }

  function paneDrop(event: ReactDragEvent<HTMLElement>) {
    if (!isOsFileDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = 0;
    setFileDragOver(false);
    if (!canUpload) {
      notify(uploadDropMessage(null));
      return;
    }
    chooseFiles(event.dataTransfer.files);
  }

  function folderLabel(document: DocumentSummary) {
    if (!document.folder_id) return "No folder";
    return folders.find((item) => item.id === document.folder_id)?.name ?? "A folder you cannot see";
  }

  function selectFolder(next: string) {
    setFolder(next);
    setDocumentId(null);
    setExtraDocument(null);
    setPanel("files");
    navigate(filesRoute(next, null), { filesPanel: "files" });
  }

  function openDocument(document: DocumentSummary) {
    // A whiteboard opens its canvas (§10.1) as a new entry, so Back returns to Files.
    if (document.kind === "whiteboard" && onOpenWhiteboard) {
      onOpenWhiteboard(document.id);
      return;
    }
    setDocumentId(document.id);
    setPanel("preview");
    navigate(filesRoute(folder, document.id), { filesPanel: "preview" });
  }

  // Desktop Close (×) and Esc in the preview pane: deselect and go back to the folder's URL in place.
  function closePreview() {
    const closedId = documentId;
    const { route, panel: nextPanel } = closedPreviewTarget(folder);
    setDocumentId(null);
    setExtraDocument(null);
    setPanel(nextPanel);
    navigate(route, { replace: true, filesPanel: nextPanel });
    focusRow(closedId);
  }

  function showPanel(next: FilesPanel, replace = false) {
    setPanel(next);
    navigate(filesRoute(folder, documentId), { filesPanel: next, replace });
  }

  // Same contract as the Notes Back button: step back through entries this visit pushed, otherwise
  // switch panels in place so the in-app Back never leaves Nook.
  function back(fallback: FilesPanel) {
    if (isMobileViewport() && readHistoryDepth(window.history.state) > 0 && readFilesHistorySnapshot(window.history.state, userId)) {
      window.history.back();
      return;
    }
    showPanel(fallback, true);
  }

  // Leaving Files in the app while uploads run asks first (C1). Closing the browser tab is not guarded.
  async function leaveFiles(action: () => void) {
    if (pendingUploads && !await askLeave(leaveUploadsRequest(pendingUploads))) return;
    action();
  }

  function chooseFiles(list: FileList | null) {
    if (!list?.length || uploadFolderId === undefined) return;
    const uploads = Array.from(list).map((file) => {
      const id = crypto.randomUUID();
      filesRef.current.set(id, file);
      return { id, key: crypto.randomUUID(), name: file.name, size: file.size, folderId: uploadFolderId };
    });
    dispatch({ type: "enqueue", uploads });
    setQueueOpen(true);
  }

  // Starts queued uploads as slots free up. Each attempt runs once, even if React re-runs the effect.
  useEffect(() => {
    for (const item of uploadsToStart(queue)) {
      const attemptKey = `${item.id}:${item.attempt + 1}`;
      if (startedRef.current.has(attemptKey)) continue;
      startedRef.current.add(attemptKey);
      const file = filesRef.current.get(item.id);
      dispatch({ type: "start", id: item.id });
      if (!file) {
        dispatch({ type: "fail", id: item.id, error: "The file is no longer available. Choose it again." });
        continue;
      }
      const controller = new AbortController();
      controllersRef.current.set(item.id, controller);
      uploadFile(file, item.folderId, item.key, (loaded, total) => dispatch({ type: "progress", id: item.id, loaded, total }), controller.signal)
        .then(({ document }) => {
          dispatch({ type: "succeed", id: item.id, documentId: document.id });
          filesRef.current.delete(item.id);
          setData((current) => current ? { ...current, documents: mergeDocument(current.documents, document) } : current);
        })
        .catch((reason) => {
          if (reason instanceof DOMException && reason.name === "AbortError") return;
          dispatch({ type: "fail", id: item.id, error: reason instanceof Error ? reason.message : "Upload failed", code: reason instanceof UploadRequestError ? reason.code : null, status: reason instanceof UploadRequestError ? reason.status : undefined });
        })
        .finally(() => { if (controllersRef.current.get(item.id) === controller) controllersRef.current.delete(item.id); });
    }
  }, [queue]);

  function cancelUpload(id: string) {
    dispatch({ type: "cancel", id });
    controllersRef.current.get(id)?.abort();
  }

  function clearFinished() {
    for (const item of queue.items) if (item.status === "done" || item.status === "canceled") filesRef.current.delete(item.id);
    dispatch({ type: "clearFinished" });
  }

  const uploadDestination = folder === "all" ? defaultFolder?.name ?? "Default" : currentFolder?.name ?? "";

  return <main className={`workspace files-workspace${collapsed ? " nav-collapsed" : ""}${selected ? " preview-open" : ""}`} data-mobile-panel={panel === "files" ? "notes" : panel === "preview" ? "editor" : "folders"}>
    <aside className="folder-pane" id="file-folders">
      <header className="sidebar-header">
        <button className="sidebar-brand sidebar-home-button" onClick={() => { void leaveFiles(onHome); }} aria-label="Open Nook home" title="Back to Home"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>Files</strong></span></button>
        <button className="icon-button desktop-only" onClick={() => setCollapsed(true)} aria-label="Collapse folders sidebar" aria-controls="file-folders" aria-expanded={!collapsed} title="Collapse folders"><PanelLeftClose /></button>
      </header>
      <nav className="folder-nav" aria-label="File folders">
        <button className="nav-home" onClick={() => { void leaveFiles(onHome); }} title="Back to Home"><House /><span>Home</span></button>
        <button className={folder === "all" ? "active" : ""} aria-current={folder === "all" ? "page" : undefined} onClick={() => selectFolder("all")}><Files /><span>All files</span><b>{documents.length}</b></button>
        <button className={folder === "shared" ? "active" : ""} aria-current={folder === "shared" ? "page" : undefined} onClick={() => selectFolder("shared")}><Users /><span>Shared with me</span><b>{documents.filter((item) => item.is_owner === 0).length}</b></button>
        <div className="nav-label"><span>Folders</span>{canWrite && <button id="files-new-folder" onClick={(event) => openNewFolder(event.currentTarget)} aria-label="New folder" aria-haspopup="dialog" title="New folder"><FolderPlus /></button>}</div>
        {owned.map((item) => <button
          key={item.id}
          className={`folder-link${folder === item.id ? " active" : ""}${draggingId && canDropOnFolder(item, findDocument(draggingId)) ? " drop-candidate" : ""}${dropFolderId === item.id ? " drop-target" : ""}`}
          aria-current={folder === item.id ? "page" : undefined}
          onClick={() => selectFolder(item.id)}
          onDragEnter={(event) => folderDragOver(event, item)}
          onDragOver={(event) => folderDragOver(event, item)}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropFolderId((current) => current === item.id ? null : current); }}
          onDrop={(event) => folderDrop(event, item)}
        >
          <FolderIcon /><span className="folder-copy">{item.name}</span><b>{documents.filter((document) => document.folder_id === item.id).length}</b>
        </button>)}
        {shared.length > 0 && <div className="nav-label"><span>Shared folders</span></div>}
        {shared.map((item) => <button key={item.id} className={`folder-link${folder === item.id ? " active" : ""}`} aria-current={folder === item.id ? "page" : undefined} onClick={() => selectFolder(item.id)}>
          <FolderIcon /><span className="folder-copy">{item.name}<small>{item.owner_name}</small></span><b>{documents.filter((document) => document.folder_id === item.id).length}</b>
        </button>)}
      </nav>
      <footer className="sidebar-footer">
        <button className="footer-settings" title={displayName} onClick={onSettings} aria-label={`Open settings for ${displayName}`}>
          <strong className="footer-identity"><Avatar className="app-user-avatar" name={displayName} url={selfAvatar} /><span>{displayName}</span></strong>
          <span><Settings />Settings</span>
        </button>
        {onBin && <button className="footer-bin" onClick={() => { void leaveFiles(onBin); }}><Trash2 />Bin</button>}
        <button className="footer-signout" onClick={() => { void leaveFiles(onSignOut); }}><LogOut />Sign out</button>
      </footer>
    </aside>

    <section className={`note-pane file-pane${fileDragOver ? " file-drag-over" : ""}`} onDragEnter={paneDragEnter} onDragOver={paneDragOver} onDragLeave={paneDragLeave} onDrop={paneDrop}>
      {fileDragOver && <div className={`file-drop-overlay${canUpload ? "" : " refused"}`} aria-hidden="true"><Upload /><strong>{uploadDropMessage(uploadTarget)}</strong></div>}
      <header className="note-pane-header">
        <button className="icon-button collapsed-trigger collapsed-sidebar-toggle" onClick={() => setCollapsed(false)} aria-label="Open folders sidebar" aria-controls="file-folders" aria-expanded={!collapsed} title="Open folders"><PanelLeftOpen /><span>Folders</span></button>
        <div className="mobile-header"><button className="icon-button" onClick={() => back("folders")} aria-label="Back to folders"><ChevronLeft /></button><strong>{folderTitle}</strong></div>
        <div className="note-heading"><span className="eyebrow">{folder === "shared" || currentFolder?.is_owner === 0 ? "Shared" : "Library"}</span><h1 title={folderTitle}>{folderTitle}</h1></div>
        <div className="file-header-row">
          <span className="file-count" aria-live="polite">{fileCountLabel(visible.length, inFolder.length)}</span>
          <div className="file-view-toggle" role="group" aria-label="View">
            <button className="icon-button" onClick={() => chooseView("list")} aria-pressed={view === "list"} aria-label="List view" title="List view"><ListIcon /></button>
            <button className="icon-button" onClick={() => chooseView("grid")} aria-pressed={view === "grid"} aria-label="Grid view" title="Grid view"><LayoutGrid /></button>
          </div>
          <div className="sort-control file-sort-control">
            <button className="icon-button" onClick={() => setSortOpen((open) => !open)} aria-label={`Sort files: ${fileSortOptions.find((option) => option.value === sort)?.label}`} aria-haspopup="menu" aria-expanded={sortOpen} title="Sort"><ArrowUpDown /></button>
            {sortOpen && <div className="sort-menu" role="menu" aria-label="Sort files">
              {fileSortOptions.map((option) => <button key={option.value} className={sort === option.value ? "active" : ""} onClick={() => chooseSort(option.value)} role="menuitemradio" aria-checked={sort === option.value}><span>{option.label}</span>{sort === option.value && <Check />}</button>)}
            </div>}
          </div>
          <HeaderInboxButton />
          <NotificationBell />
          {canUpload && <button className="primary-button files-upload-button" onClick={() => fileInputRef.current?.click()} title={`Upload to ${uploadDestination}`}><Upload /><span className="files-upload-label">Upload</span></button>}
          <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { chooseFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
        </div>
        <ReadOnlyBanner />
        <label className="search-box file-search"><Search aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); } }} placeholder="Filter files" aria-label="Filter files by name" /></label>
      </header>
      <p id="file-list-keys" className="sr-only">{view === "grid" ? "Use the arrow keys to move between files." : "Use the up and down arrow keys to move between files."} On your own files, F2 renames and Delete moves the file to the Bin.</p>
      <div id="file-list" tabIndex={-1} className={`note-list file-list${view === "grid" ? " file-grid" : ""}`} data-view={view} role="list" aria-label={folderTitle} aria-describedby="file-list-keys" aria-busy={!data && !loadError ? true : undefined} onKeyDown={onListKeyDown}>
        {visible.map((item) => {
          const Icon = documentIcon(item);
          const grid = view === "grid";
          const sharedIcon = item.visibility !== "private" && <Users className="file-row-shared" aria-label="Shared" />;
          return <div role="listitem" className={`file-row-item${grid ? " file-tile-item" : ""}`} key={item.id} {...{ [ROW_ITEM_ATTRIBUTE]: item.id }}>
            <button
              className={`file-row${grid ? " file-tile" : ""}${documentId === item.id ? " selected" : ""}${draggingId === item.id ? " dragging" : ""}`}
              draggable={canManage(item)}
              onDragStart={(event) => startRowDrag(event, item)}
              onDragEnd={endRowDrag}
              data-document-id={item.id} aria-current={documentId === item.id ? "true" : undefined} aria-keyshortcuts={canManage(item) ? "F2 Delete" : undefined} onClick={() => openDocument(item)}>
              {grid
                ? <span className="file-tile-thumb">{item.preview_kind === "image" ? <img src={contentUrl(item.id, "inline")} loading="lazy" alt="" draggable={false} /> : <Icon aria-hidden="true" />}</span>
                : <span className="file-row-icon"><Icon aria-hidden="true" /></span>}
              <span className="file-row-copy">
                <span className="file-row-name" title={item.name}>{item.name}</span>
                {grid
                  ? <span className="file-row-meta"><span>{formatBytes(item.size_bytes)}</span>{item.is_owner === 0 && <span className="owner-badge">{item.owner_name}</span>}{sharedIcon}</span>
                  : <span className="file-row-meta"><span>{formatBytes(item.size_bytes)}</span><time dateTime={item.updated_at}>{relativeTime(item.updated_at)}</time>{item.is_owner === 0 && <span className="owner-badge">{item.owner_name}</span>}</span>}
              </span>
              {!grid && sharedIcon}
            </button>
            <button className="icon-button file-row-more" onClick={(event) => openActions(item, event.currentTarget)} aria-haspopup="dialog" aria-label={`Actions for ${item.name}`}><Ellipsis /></button>
          </div>;
        })}
        {data && inFolder.length > 0 && !visible.length && <div className="empty-state"><div><Search /></div><h2>No matches</h2><p>No file names here match “{query.trim()}”.</p><button onClick={() => setQuery("")}>Clear filter</button></div>}
        {data && !inFolder.length && <div className="empty-state"><div><Files /></div><h2>{emptyCopy.title}</h2><p>{emptyCopy.body}</p>{canUpload && <button onClick={() => fileInputRef.current?.click()}>Upload files</button>}</div>}
        {!data && loadError && <div className="empty-state file-load-error" role="alert"><div><TriangleAlert /></div><h2>Could not load your files</h2><p>{loadError}</p><button onClick={() => setLoadAttempt((attempt) => attempt + 1)}><RotateCcw />Try again</button></div>}
        {!data && !loadError && <p className="file-preview-note" role="status">Loading files…</p>}
      </div>
      <p className="sr-only" aria-live="polite">{uploadAnnouncement(queue)}</p>
      {queue.items.length > 0 && <section className={`upload-queue${pendingUploads ? " active" : ""}`} aria-label="Uploads">
        <header className="upload-queue-header">
          <button className="upload-queue-toggle" onClick={() => setQueueOpen((open) => !open)} aria-expanded={queueOpen} aria-controls="upload-queue-items">{queueOpen ? <ChevronDown /> : <ChevronUp />}<span>{summary}</span></button>
          {queue.items.some((item) => item.status === "done" || item.status === "canceled") && <button className="text-action" onClick={clearFinished}>Clear</button>}
        </header>
        {queueOpen && <ul id="upload-queue-items" className="upload-queue-items">
          {queue.items.map((item) => <li key={item.id} className={`upload-item ${item.status}`}>
            <div className="upload-item-row">
              <span className="upload-item-name" title={item.name}>{item.name}</span>
              <span className="upload-item-status">{item.status === "uploading" ? `${Math.round(item.progress * 100)}%` : statusLabels[item.status]}</span>
              {(item.status === "queued" || item.status === "uploading") && <button className="icon-button" onClick={() => cancelUpload(item.id)} aria-label={`Cancel upload of ${item.name}`} title="Cancel"><X /></button>}
              {canRetryUpload(item) && <button className="icon-button" onClick={() => dispatch({ type: "retry", id: item.id })} aria-label={`Retry upload of ${item.name}`} title="Retry"><RotateCcw /></button>}
            </div>
            <div className="upload-progress" role="progressbar" aria-label={`${item.name} upload progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}><span style={{ width: `${Math.round(item.progress * 100)}%` }} /></div>
            {item.error && <p className="upload-item-error">{item.error}</p>}
          </li>)}
        </ul>}
      </section>}
    </section>

    <section className="editor-pane file-preview-pane" aria-label="File preview" onKeyDown={(event) => {
      if (event.key !== "Escape" || event.defaultPrevented || dialogOpenRef.current || !selected || isMobileViewport()) return;
      event.preventDefault();
      closePreview();
    }}>
      {selected
        ? <FilePreview
          key={selected.id}
          document={selected}
          folderName={folderLabel(selected)}
          onBack={() => back("files")}
          onClose={closePreview}
          onMore={(trigger) => openActions(selected, trigger)}
          onOpenWhiteboard={selected.kind === "whiteboard" && onOpenWhiteboard ? () => onOpenWhiteboard(selected.id) : undefined}
          actions={canManage(selected) ? {
            rename: () => openDialog("rename", selected),
            move: () => openDialog("move", selected),
            share: () => openDialog("share", selected),
            remove: () => openDialog("delete", selected)
          } : null}
        />
        : <div className="editor-empty"><div className="empty-glyph"><Files /></div><h2>Select a file</h2><p>Choose one from the list to preview it and see its details.</p></div>}
    </section>

    {dialog?.kind === "actions" && dialogDocument && <FileActionSheet document={dialogDocument} onAction={(action) => chooseSheetAction(dialogDocument, action)} onClose={closeDialog}
      onOpenWhiteboard={dialogDocument.kind === "whiteboard" && onOpenWhiteboard ? () => { setDialog(null); onOpenWhiteboard(dialogDocument.id); } : undefined} />}
    {dialog?.kind === "newFolder" && <NameDialog
      title="New folder"
      eyebrow="Files"
      label="Folder name"
      initialValue=""
      submitLabel="Create folder"
      validate={validateFolderName}
      onSubmit={createFolder}
      onCancel={closeDialog}
    />}
    {dialog?.kind === "rename" && dialogDocument && <RenameDialog document={dialogDocument} onSubmit={(name) => renameDocument(dialogDocument, name)} onCancel={closeDialog} />}
    {dialog?.kind === "move" && dialogDocument && <MoveSheet document={dialogDocument} folders={folders} onMove={async (target) => { await moveDocument(dialogDocument, target); closeDialog(); }} onCancel={closeDialog} />}
    {dialog?.kind === "share" && dialogDocument && <AccessSheet kind="document" id={dialogDocument.id} title={dialogDocument.name} onClose={closeDialog} onSaved={() => {
      closeDialog();
      notify("Access updated");
      refreshDocument(dialogDocument.id).catch(() => undefined);
    }} />}
    {dialog?.kind === "delete" && dialogDocument && <ConfirmDialog
      title="Move to the Bin?"
      message={deleteConfirmMessage(dialogDocument.name)}
      confirmLabel="Move to Bin"
      danger
      busy={deleting}
      onConfirm={() => { void deleteDocument(dialogDocument); }}
      onCancel={closeDialog}
    />}
    {toast && <div className="toast file-toast" role="status">
      <span>{toast.message}</span>
      {toast.undoDocumentId && <button className="file-toast-action" onClick={() => { void undoDelete(toast.undoDocumentId!); }}>Undo</button>}
    </div>}

    <nav className="mobile-tabbar" aria-label="Files panels">
      <button className={panel === "folders" ? "active" : ""} onClick={() => showPanel("folders")}><Menu />Folders</button>
      <button className={panel === "files" ? "active" : ""} onClick={() => showPanel("files")}><Files />Files</button>
      <button className={panel === "preview" ? "active" : ""} disabled={!selected} onClick={() => showPanel("preview")}><Sparkles />Preview</button>
    </nav>
    {leaveConfirm}
  </main>;
}
