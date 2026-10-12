// Uploads everywhere U6 (Files polish, G9): where Files uploads come from besides the chooser and a
// file drop. Pasted files and screenshots, the phone camera, and whole folders (a folder chooser or a
// dragged folder, recreated as subfolders). Pure helpers, unit tested; FilesApp owns the I/O.
import { pastedFiles } from "../ui/attachments";
import type { Folder } from "../types";

// ---------------------------------------------------------------------------------------------
// Where an upload goes (shared by every source, so none of them can target the Attachments folder).
// ---------------------------------------------------------------------------------------------

type UploadFolder = Pick<Folder, "id" | "is_owner" | "system_kind">;

/**
 * The folder files go to: Default in All files, the open folder when the caller owns it, and nothing
 * (undefined) in Shared with me, someone else's folder, or the Attachments system folder (T342: that
 * folder only takes attached files).
 */
export function uploadFolderFor(view: string, current: UploadFolder | null, defaultFolder: Pick<Folder, "id"> | null): string | null | undefined {
  if (view === "all") return defaultFolder?.id ?? null;
  if (!current || current.is_owner !== 1 || current.system_kind) return undefined;
  return current.id;
}

/**
 * Where a folder upload creates its top folder: at the top level in All files, inside the open folder
 * when the caller owns it, and nowhere in Shared with me, a shared folder, or the Attachments folder.
 */
export function folderUploadParentFor(view: string, current: UploadFolder | null): string | null | undefined {
  if (view === "all") return null;
  if (!current || current.is_owner !== 1 || current.system_kind) return undefined;
  return current.id;
}

// ---------------------------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------------------------

type EditableLike = { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined;
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

/** Whether a paste lands in something that takes text (the filter box, a dialog field). */
export function isEditableTarget(target: EditableLike) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA") return true;
  return tag === "INPUT" && TEXT_INPUT_TYPES.has((target.type ?? "").toLowerCase());
}

const GENERIC_PASTE_NAME = /^image\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;
const pad = (value: number) => String(value).padStart(2, "0");

/** Browsers name every pasted screenshot `image.png`; give it a findable, dated name instead. */
export function pastedFileName(name: string, at: Date) {
  const match = GENERIC_PASTE_NAME.exec(name.trim());
  if (!match && name.trim()) return name;
  const extension = match ? match[1].toLowerCase().replace("jpeg", "jpg") : "png";
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} at ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`;
  return `Pasted image ${stamp}.${extension}`;
}

/**
 * The files a paste in Files should upload, or [] to leave the paste alone. The kit's rule (rich text
 * with any words stays text) applies everywhere; in a text field, a clipboard that also holds plain
 * text (a file copied in a file manager carries its name) stays a text paste too.
 */
export function filesToUploadFromPaste(data: Pick<DataTransfer, "files" | "getData"> | null, target: EditableLike): File[] {
  const files = pastedFiles(data);
  if (!files.length || !data) return [];
  if (isEditableTarget(target) && data.getData("text/plain").trim()) return [];
  return files;
}

/** Same file, renamed when it carries a browser's generic paste name. */
export function renamePastedFile(file: File, at: Date): File {
  const name = pastedFileName(file.name, at);
  return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
}

// ---------------------------------------------------------------------------------------------
// Folder upload
// ---------------------------------------------------------------------------------------------

/** One upload holds at most this many files (refused as a whole above it, before anything is created). */
export const FOLDER_UPLOAD_MAX_FILES = 1000;
/** At most this many folders are created by one upload (the chosen folder included). */
export const FOLDER_UPLOAD_MAX_FOLDERS = 200;
/** Folder levels kept, the chosen folder being level 1; files deeper than this are listed as failed. */
export const FOLDER_UPLOAD_MAX_DEPTH = 10;
export const FOLDER_NAME_MAX = 120;
export const UNTITLED_FOLDER = "Untitled folder";

/** Operating-system clutter that is never uploaded from a folder. */
export function isSystemClutter(name: string) {
  const lower = name.toLowerCase();
  return lower === ".ds_store" || lower === "thumbs.db" || lower === "desktop.ini" || lower.startsWith("._");
}

// C0/C1 controls, bidi embeddings/overrides/isolates and marks, zero-width characters, and the BOM.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

const truncate = (value: string, max: number) => Array.from(value).slice(0, max).join("").trim();

/**
 * A folder name that is safe to show and store: no control or direction-changing characters, no
 * slashes, collapsed whitespace, at most 120 characters, and never empty, "." or "..".
 */
export function safeFolderName(raw: string) {
  const cleaned = raw.normalize("NFC").replace(UNSAFE_CHARACTERS, "").replace(/[\\/]/g, "-").replace(/\s+/g, " ").trim();
  const name = truncate(cleaned, FOLDER_NAME_MAX);
  return !name || name === "." || name === ".." ? UNTITLED_FOLDER : name;
}

/** `name`, or `name (2)`, `name (3)`… when a sibling already uses it (case-insensitive), within 120 characters. */
export function uniqueFolderName(name: string, taken: Iterable<string>) {
  const used = new Set(Array.from(taken, (item) => item.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let index = 2; ; index += 1) {
    const suffix = ` (${index})`;
    const candidate = `${truncate(name, FOLDER_NAME_MAX - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** A file from a folder chooser or a dragged folder, with its path from the chosen folder ("Photos/2024/a.jpg"). */
export type FolderFile<T> = { item: T; path: string };

export type PlannedFolder = { key: string; name: string; parentKey: string | null; depth: number };
export type PlannedFile<T> = { item: T; path: string; name: string; folderKey: string };
export type RejectedFile<T> = { item: T; path: string; name: string; reason: string };

export type FolderUploadPlan<T> = {
  /** Folders to create, parents before children; `parentKey` null means the upload's parent. */
  folders: PlannedFolder[];
  files: Array<PlannedFile<T>>;
  rejected: Array<RejectedFile<T>>;
  /** Operating-system clutter left out (.DS_Store and the like). */
  skipped: number;
  /** The top folders as created ("Photos", or "Photos (2)" when the name was taken). */
  roots: string[];
  /** Set when the whole upload is refused; nothing is created then. */
  error: string | null;
};

const splitPath = (path: string) => path.split(/[\\/]+/).filter((part) => part && part !== "." && part !== "..");
const count = (value: number) => value.toLocaleString("en-US");

/**
 * Turns a folder's files into the folders to create and the uploads to queue. Top folders whose names
 * are taken by `siblingNames` (the folders already in the upload's parent) get "(2)", so an upload
 * never merges into an existing folder. Over the file or folder cap the whole upload is refused.
 */
export function planFolderUpload<T>(entries: Array<FolderFile<T>>, siblingNames: Iterable<string>): FolderUploadPlan<T> {
  const plan: FolderUploadPlan<T> = { folders: [], files: [], rejected: [], skipped: 0, roots: [], error: null };
  const taken = new Set(Array.from(siblingNames, (name) => name.toLowerCase()));
  const rootNames = new Map<string, string>(); // raw top segment → created name
  const keys = new Map<string, PlannedFolder>();
  const kept: Array<FolderFile<T> & { parts: string[] }> = [];
  for (const entry of entries) {
    const parts = splitPath(entry.path);
    const name = parts.at(-1) ?? "";
    if (!name) continue;
    if (isSystemClutter(name)) { plan.skipped += 1; continue; }
    kept.push({ ...entry, parts });
  }
  if (kept.length > FOLDER_UPLOAD_MAX_FILES) {
    plan.error = `A folder upload takes at most ${count(FOLDER_UPLOAD_MAX_FILES)} files; this one has ${count(kept.length)}. Upload its subfolders one at a time.`;
    return plan;
  }
  for (const entry of kept) {
    const name = entry.parts.at(-1)!;
    const folders = entry.parts.slice(0, -1);
    if (folders.length > FOLDER_UPLOAD_MAX_DEPTH) {
      plan.rejected.push({ item: entry.item, path: entry.parts.join("/"), name, reason: `In a folder more than ${FOLDER_UPLOAD_MAX_DEPTH} levels deep` });
      continue;
    }
    let parentKey: string | null = null;
    let key = "";
    folders.forEach((segment, index) => {
      let folderName = safeFolderName(segment);
      if (index === 0) {
        const existing = rootNames.get(folderName.toLowerCase());
        if (existing) folderName = existing;
        else {
          const unique = uniqueFolderName(folderName, taken);
          rootNames.set(folderName.toLowerCase(), unique);
          taken.add(unique.toLowerCase());
          folderName = unique;
        }
      }
      key = parentKey === null ? folderName : `${parentKey}/${folderName}`;
      if (!keys.has(key)) {
        const planned = { key, name: folderName, parentKey, depth: index + 1 };
        keys.set(key, planned);
        plan.folders.push(planned);
        if (index === 0) plan.roots.push(folderName);
      }
      parentKey = key;
    });
    plan.files.push({ item: entry.item, path: key ? `${key}/${name}` : name, name, folderKey: key });
  }
  if (plan.folders.length > FOLDER_UPLOAD_MAX_FOLDERS) {
    return { folders: [], files: [], rejected: [], skipped: plan.skipped, roots: [], error: `A folder upload creates at most ${count(FOLDER_UPLOAD_MAX_FOLDERS)} folders; this one has ${count(plan.folders.length)}. Upload its subfolders one at a time.` };
  }
  return plan;
}

/** What the toast says when a folder upload ends. */
export function folderUploadSummary(roots: string[], counts: { done: number; failed: number; canceled: number; skipped: number }) {
  const label = roots.length === 1 ? `Folder “${roots[0]}”` : `${roots.length} folders`;
  const total = counts.done + counts.failed + counts.canceled;
  const parts = [`${counts.done} of ${total} ${total === 1 ? "file" : "files"} uploaded`];
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.canceled) parts.push(`${counts.canceled} canceled`);
  if (counts.skipped) parts.push(`${counts.skipped} system ${counts.skipped === 1 ? "file" : "files"} skipped`);
  return `${label}: ${parts.join(", ")}`;
}

// ---------------------------------------------------------------------------------------------
// Dragged folders (FileSystemEntry API). Read until the file cap is passed, then stop.
// ---------------------------------------------------------------------------------------------

type Entry = { isFile: boolean; isDirectory: boolean; name: string; fullPath: string };
type FileEntry = Entry & { file: (success: (file: File) => void, failure?: (error: unknown) => void) => void };
type DirectoryEntry = Entry & { createReader: () => { readEntries: (success: (entries: Entry[]) => void, failure?: (error: unknown) => void) => void } };

export type DroppedItems = { files: File[]; folders: Array<FolderFile<File>>; folderCount: number; unreadable: number; overflow: boolean };

/**
 * The entries of a drop, taken synchronously (the DataTransfer is emptied once the handler returns).
 * Null when the browser has no entry API or nothing dropped is a folder, so the caller uses `files`.
 */
export function droppedEntries(data: DataTransfer | null): Entry[] | null {
  const items = Array.from(data?.items ?? []).filter((item) => item.kind === "file");
  if (!items.length || typeof (items[0] as DataTransferItem & { webkitGetAsEntry?: unknown }).webkitGetAsEntry !== "function") return null;
  const entries = items.map((item) => item.webkitGetAsEntry() as Entry | null).filter((entry): entry is Entry => Boolean(entry));
  return entries.some((entry) => entry.isDirectory) ? entries : null;
}

/** Reads dropped entries: loose files as they are, folders as path-tagged files (at most `limit` + 1). */
export async function readDroppedEntries(entries: Entry[], limit = FOLDER_UPLOAD_MAX_FILES): Promise<DroppedItems> {
  const result: DroppedItems = { files: [], folders: [], folderCount: 0, unreadable: 0, overflow: false };
  const readFile = (entry: FileEntry) => new Promise<File | null>((resolve) => entry.file(resolve, () => resolve(null)));
  const readAll = async (directory: DirectoryEntry) => {
    const reader = directory.createReader();
    const all: Entry[] = [];
    for (;;) {
      const batch = await new Promise<Entry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
      if (!batch.length) return all;
      all.push(...batch);
    }
  };
  const walk = async (directory: DirectoryEntry, depth: number) => {
    for (const child of await readAll(directory)) {
      if (result.folders.length > limit) { result.overflow = true; return; }
      if (child.isDirectory) {
        // Deeper levels are still listed (as failed) up to a bound, never walked forever.
        if (depth <= FOLDER_UPLOAD_MAX_DEPTH + 1) await walk(child as DirectoryEntry, depth + 1);
        continue;
      }
      const file = await readFile(child as FileEntry);
      if (file) result.folders.push({ item: file, path: child.fullPath.replace(/^\/+/, "") });
      else result.unreadable += 1;
    }
  };
  for (const entry of entries) {
    if (entry.isDirectory) {
      result.folderCount += 1;
      await walk(entry as DirectoryEntry, 1);
    } else if (entry.isFile) {
      const file = await readFile(entry as FileEntry);
      if (file) result.files.push(file);
      else result.unreadable += 1;
    }
  }
  return result;
}

/** The files of a folder chooser (`webkitdirectory`), with their paths. */
export function chosenFolderFiles(list: FileList | File[] | null): Array<FolderFile<File>> {
  return Array.from(list ?? []).map((file) => ({ item: file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }));
}

/** Whether this browser offers a folder chooser. */
export function supportsFolderChooser() {
  return typeof document !== "undefined" && "webkitdirectory" in document.createElement("input");
}

// ---------------------------------------------------------------------------------------------
// The sidebar shows subfolders under their parent.
// ---------------------------------------------------------------------------------------------

/** Owned folders in their given order with each one's children right after it, and its depth. */
export function nestFolders<F extends Pick<Folder, "id" | "parent_id">>(folders: F[]): Array<{ folder: F; depth: number }> {
  const ids = new Set(folders.map((folder) => folder.id));
  const children = new Map<string, F[]>();
  const roots: F[] = [];
  for (const folder of folders) {
    if (folder.parent_id && folder.parent_id !== folder.id && ids.has(folder.parent_id)) {
      const list = children.get(folder.parent_id) ?? [];
      list.push(folder);
      children.set(folder.parent_id, list);
    } else roots.push(folder);
  }
  const out: Array<{ folder: F; depth: number }> = [];
  const seen = new Set<string>();
  const visit = (folder: F, depth: number) => {
    if (seen.has(folder.id)) return;
    seen.add(folder.id);
    out.push({ folder, depth });
    for (const child of children.get(folder.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  // A parent loop (never made by Nook, but possible through the API) still lists every folder.
  for (const folder of folders) visit(folder, 0);
  return out;
}
