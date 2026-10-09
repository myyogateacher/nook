// Pure helpers for the Files actions (rename, move, delete, toasts). No DOM or network access, so
// they are unit tested directly.
import type { DocumentSummary, Folder, Visibility } from "../types";

export const MAX_DISPLAY_NAME_BYTES = 255;

// Same character classes as server/validation.ts: C0/C1 controls, DEL, bidi embeddings, overrides,
// isolates and marks, and zero-width characters.
const strippedCharacters = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const encoder = new TextEncoder();
export const utf8Length = (value: string) => encoder.encode(value).length;
const cleanEdges = (value: string) => value.replace(/^[\s.]+|[\s.]+$/g, "");

/** Client mirror of the server's `sanitizeDisplayName(input, "rename")`: the name the server will store, or null. */
export function sanitizeRenameInput(input: string): string | null {
  const cleaned = cleanEdges(
    input
      .replace(/\p{Cs}/gu, "")
      .normalize("NFC")
      .replace(strippedCharacters, "")
      .replace(/[/\\:]/g, "-")
      .replace(/\s+/g, " ")
  );
  if (cleaned === "" || cleaned === "." || cleaned === "..") return null;
  return utf8Length(cleaned) <= MAX_DISPLAY_NAME_BYTES ? cleaned : null;
}

export type RenameCheck = { ok: true; name: string; changed: boolean } | { ok: false; error: string };

/** Validates a rename before it is sent. `changed` is false when the stored name would stay the same. */
export function validateRename(input: string, currentName: string): RenameCheck {
  const name = sanitizeRenameInput(input);
  if (name === null) {
    const stripped = input.replace(strippedCharacters, "").trim();
    if (!stripped || /^[\s.]+$/.test(stripped)) return { ok: false, error: "Enter a name." };
    return { ok: false, error: `Use at most ${MAX_DISPLAY_NAME_BYTES} bytes. This name is ${utf8Length(stripped)}.` };
  }
  return { ok: true, name, changed: name !== currentName };
}

/** The selection a rename field starts with: the base name, without the extension. */
export function baseNameRange(name: string): [number, number] {
  const dot = name.lastIndexOf(".");
  return [0, dot > 0 ? dot : name.length];
}

export type MoveTarget = { id: string; name: string; isDefault: boolean; current: boolean };

/** Whether a folder is managed by Nook (the Attachments folder, D391): no share, rename, delete, or moving in. */
export const isSystemFolder = (folder: Pick<Folder, "system_kind"> | null | undefined) => Boolean(folder?.system_kind);

/** Folders a document can be moved into: owned folders only (never a system folder), Default first, the current one disabled. */
export function moveTargets(folders: Folder[], currentFolderId: string | null): MoveTarget[] {
  return folders
    .filter((folder) => folder.is_owner === 1 && !isSystemFolder(folder))
    .sort((left, right) => right.is_default - left.is_default || left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
    .map((folder) => ({ id: folder.id, name: folder.name, isDefault: folder.is_default === 1, current: folder.id === currentFolderId }));
}

const effectiveLabels: Record<Visibility, string> = { private: "private", selected: "shared with selected people", all_users: "shared with everyone" };

export function effectiveVisibilityLabel(visibility: Visibility) {
  return Object.hasOwn(effectiveLabels, visibility) ? effectiveLabels[visibility] : effectiveLabels.private;
}

/** Toast after a move. It always names who can now see the file, because a move can widen access. */
export function movedMessage(folderName: string, visibility: Visibility) {
  return `Moved to ${folderName} · ${effectiveVisibilityLabel(visibility)}`;
}

export function deleteConfirmMessage(name: string) {
  return `Move “${name}” to the Bin? You can restore it for 30 days.`;
}

export const canManage = (document: Pick<DocumentSummary, "is_owner">) => document.is_owner === 1;

// A single toast slot owned by Files, so a delete can offer Undo. The id lets a timer dismiss only
// the toast it was started for.
export type FileToast = { id: number; message: string; undoDocumentId: string | null };
export type FileToastState = { next: number; toast: FileToast | null };
export type FileToastAction =
  | { type: "show"; message: string; undoDocumentId?: string | null }
  | { type: "dismiss"; id: number }
  | { type: "clear" };

export const emptyToastState: FileToastState = { next: 1, toast: null };

export function fileToastReducer(state: FileToastState, action: FileToastAction): FileToastState {
  switch (action.type) {
    case "show":
      return { next: state.next + 1, toast: { id: state.next, message: action.message, undoDocumentId: action.undoDocumentId ?? null } };
    case "dismiss":
      return state.toast?.id === action.id ? { ...state, toast: null } : state;
    case "clear":
      return state.toast ? { ...state, toast: null } : state;
  }
}

/** How long a toast stays: long enough to reach Undo. */
export const toastDuration = (toast: FileToast) => toast.undoDocumentId ? 8000 : 3200;

export type FileSort = "name-asc" | "name-desc" | "updated-desc" | "updated-asc" | "size-desc" | "size-asc";

export const fileSortOptions: Array<{ value: FileSort; label: string }> = [
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "updated-desc", label: "Newest modified" },
  { value: "updated-asc", label: "Oldest modified" },
  { value: "size-desc", label: "Largest" },
  { value: "size-asc", label: "Smallest" }
];

export const DEFAULT_FILE_SORT: FileSort = "updated-desc";

export function isFileSort(value: unknown): value is FileSort {
  return fileSortOptions.some((option) => option.value === value);
}

/** localStorage key for the remembered sort, one per signed-in user. */
export const fileSortStorageKey = (userId: string) => `mynotes:files-sort:${userId}`;

export function readFileSort(storage: Pick<Storage, "getItem"> | null, userId: string): FileSort {
  try {
    const value = storage?.getItem(fileSortStorageKey(userId));
    return isFileSort(value) ? value : DEFAULT_FILE_SORT;
  } catch {
    return DEFAULT_FILE_SORT;
  }
}

export function writeFileSort(storage: Pick<Storage, "setItem"> | null, userId: string, sort: FileSort) {
  try { storage?.setItem(fileSortStorageKey(userId), sort); } catch { /* private mode or full storage: keep it for this visit only */ }
}

const compareNames = (left: string, right: string) => left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });

type Sortable = Pick<DocumentSummary, "id" | "name" | "updated_at" | "size_bytes">;

/** Comparator for the file list. Ties fall back to the name, then the id, so the order is stable. */
export function compareDocuments(sort: FileSort) {
  return (left: Sortable, right: Sortable) => {
    let delta = 0;
    if (sort === "name-asc") delta = compareNames(left.name, right.name);
    else if (sort === "name-desc") delta = compareNames(right.name, left.name);
    else if (sort === "updated-desc") delta = right.updated_at.localeCompare(left.updated_at);
    else if (sort === "updated-asc") delta = left.updated_at.localeCompare(right.updated_at);
    else if (sort === "size-desc") delta = right.size_bytes - left.size_bytes;
    else if (sort === "size-asc") delta = left.size_bytes - right.size_bytes;
    return delta || compareNames(left.name, right.name) || left.id.localeCompare(right.id);
  };
}

export function sortDocuments<T extends Sortable>(documents: T[], sort: FileSort): T[] {
  return [...documents].sort(compareDocuments(sort));
}

const normalizeQuery = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();

/** Client-side filter: every word of the query must appear in the name (or the owner's name). */
export function filterDocuments<T extends Pick<DocumentSummary, "name" | "owner_name">>(documents: T[], query: string): T[] {
  const words = normalizeQuery(query).split(" ").filter(Boolean);
  if (!words.length) return documents;
  return documents.filter((document) => {
    const haystack = normalizeQuery(`${document.name} ${document.owner_name}`);
    return words.every((word) => haystack.includes(word));
  });
}

export function fileCountLabel(shown: number, total: number) {
  const noun = (count: number) => count === 1 ? "1 file" : `${count} files`;
  return shown === total ? noun(total) : `${shown} of ${noun(total)}`;
}

export type FolderNameCheck = { ok: true; name: string; changed: boolean } | { ok: false; error: string };

/** Mirrors the server's folder rules: 1 to 120 characters after trimming, and not "Default". */
export function validateFolderName(input: string): FolderNameCheck {
  const name = input.trim();
  if (!name) return { ok: false, error: "Enter a folder name." };
  if (name.length > 120) return { ok: false, error: "Use at most 120 characters." };
  if (name.toLowerCase() === "default") return { ok: false, error: "The Default folder already exists." };
  return { ok: true, name, changed: true };
}

/** Drag type for moving a document onto a folder; Notes uses application/x-mynotes-note. */
export const DOCUMENT_DRAG_TYPE = "application/x-mynotes-document";

type DragTypes = ArrayLike<string> | readonly string[];
const hasType = (types: DragTypes | null | undefined, type: string) => Boolean(types) && Array.from(types as ArrayLike<string>).includes(type);

/** Files dragged in from the operating system (not one of our own rows, and not a note). */
export function isOsFileDrag(types: DragTypes | null | undefined) {
  return hasType(types, "Files") && !hasType(types, DOCUMENT_DRAG_TYPE) && !hasType(types, "application/x-mynotes-note");
}

export function isDocumentDrag(types: DragTypes | null | undefined) {
  return hasType(types, DOCUMENT_DRAG_TYPE);
}

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The document id carried by a row drag, or null when the payload is not one. */
export function readDocumentDragPayload(value: string | null | undefined) {
  const id = value?.trim() ?? "";
  return idPattern.test(id) ? id.toLowerCase() : null;
}

/** A row can be dropped on a folder the caller owns, other than the one it is already in. */
export function canDropOnFolder(folder: Pick<Folder, "id" | "is_owner" | "system_kind">, document: Pick<DocumentSummary, "is_owner" | "folder_id"> | null) {
  // T342, D392: nothing is moved or uploaded into a system folder (Attachments); files only leave it.
  if (folder.is_owner !== 1 || isSystemFolder(folder)) return false;
  return !document || (document.is_owner === 1 && document.folder_id !== folder.id);
}

/** Overlay copy while OS files are dragged over the list. */
export function uploadDropMessage(destination: string | null) {
  return destination === null ? "You can only upload to your own folders" : `Drop to upload to ${destination}`;
}

export type FilesView = { kind: "all" } | { kind: "shared" } | { kind: "folder"; name: string; owned: boolean; ownerName: string };

/** Empty-state copy for each Files view. */
export function filesEmptyState(view: FilesView): { title: string; body: string } {
  switch (view.kind) {
    case "all":
      return { title: "No files yet", body: "Upload documents, images, and PDFs to keep them next to your notes. They go to Default." };
    case "shared":
      return { title: "Nothing shared with you", body: "Files other people share with you will appear here." };
    case "folder":
      return view.owned
        ? { title: "This folder is empty", body: `Upload a file, or drop files here, to add it to ${view.name}.` }
        : { title: "No files in this folder", body: `Nothing in ${view.ownerName}’s folder is shared with you yet.` };
  }
}

/** Marks the list item wrapping a row and its ⋯ button, so shortcuts work from either. */
export const ROW_ITEM_ATTRIBUTE = "data-row-document-id";

type ClosestCapable = { closest: (selector: string) => { getAttribute: (name: string) => string | null } | null };

/** The document a list shortcut acts on: the item holding the focused element, else the selection. */
export function shortcutDocumentId(target: ClosestCapable | null, selectedId: string | null) {
  const item = target && typeof target.closest === "function" ? target.closest(`[${ROW_ITEM_ATTRIBUTE}]`) : null;
  return item?.getAttribute(ROW_ITEM_ATTRIBUTE) || selectedId;
}

/**
 * Puts a saved document into the list: replaces it in place when listed, adds it otherwise, and leaves
 * the list alone for a document that is only shown because the URL named it (beyond the list limit).
 */
export function upsertListedDocument(documents: DocumentSummary[], document: DocumentSummary, unlistedId: string | null) {
  if (documents.some((item) => item.id === document.id)) return documents.map((item) => item.id === document.id ? document : item);
  if (unlistedId === document.id) return documents;
  return [document, ...documents].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

/** Undoes an optimistic rename after the server refused it, unless something renamed the file since. */
export function rollbackRename<T extends Pick<DocumentSummary, "id" | "name">>(documents: T[], id: string, attempted: string, previous: string): T[] {
  return documents.map((item) => item.id === id && item.name === attempted ? { ...item, name: previous } : item);
}
