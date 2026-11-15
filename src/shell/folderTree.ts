/**
 * The folder trees Notes and Files draw in the global sidebar (docs/plan/LEFT_NAV.md §2.3, phase 3;
 * D1288). Pure, so it is unit tested directly: folders nest by `parent_id` in the order given (a
 * folder whose parent is not in the list, such as a shared subfolder, sits at the top), cycles and
 * runaway depth are cut, and what shows depends on which folders the person closed, except that the
 * folders above the one on screen are always open, so the current folder is never hidden.
 */

export type TreeFolder = { id: string; parent_id: string | null };

export type FolderNode<F extends TreeFolder> = {
  folder: F;
  /** 0 for a top-level folder. */
  depth: number;
  children: FolderNode<F>[];
};

/** How deep a tree goes before deeper folders are cut (Files' folder uploads stop well before this). */
export const FOLDER_TREE_MAX_DEPTH = 12;
/** Indentation stops growing past this depth, so deep folders keep room for their names. */
export const FOLDER_INDENT_CAP = 4;

/** The folders as a forest, siblings in the order given. */
export function folderForest<F extends TreeFolder>(folders: readonly F[]): FolderNode<F>[] {
  const ids = new Set(folders.map((folder) => folder.id));
  const byParent = new Map<string | null, F[]>();
  for (const folder of folders) {
    const parent = folder.parent_id && folder.parent_id !== folder.id && ids.has(folder.parent_id) ? folder.parent_id : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), folder]);
  }
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number): FolderNode<F>[] => (byParent.get(parent) ?? []).flatMap((folder) => {
    if (seen.has(folder.id)) return [];
    seen.add(folder.id);
    return [{ folder, depth, children: depth + 1 < FOLDER_TREE_MAX_DEPTH ? walk(folder.id, depth + 1) : [] }];
  });
  const forest = walk(null, 0);
  // A cycle (a ↔ b) has no way in from the top: its folders show at the top rather than vanish.
  for (const folder of folders) {
    if (seen.has(folder.id)) continue;
    seen.add(folder.id);
    forest.push({ folder, depth: 0, children: [] });
  }
  return forest;
}

/** The ids of the folders above `id` (its parent first), within the given folders. */
export function folderAncestors<F extends TreeFolder>(folders: readonly F[], id: string | null): string[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const out: string[] = [];
  for (let at = id ? byId.get(id) : undefined; at?.parent_id && byId.has(at.parent_id) && !out.includes(at.parent_id) && out.length < FOLDER_TREE_MAX_DEPTH; at = byId.get(at.parent_id)) out.push(at.parent_id);
  return out;
}

/** Whether a folder's subfolders show: not closed by the person, or above the folder on screen. */
export const folderOpen = (id: string, closed: ReadonlySet<string>, reveal: ReadonlySet<string>) => reveal.has(id) || !closed.has(id);

export type VisibleFolder<F extends TreeFolder> = { folder: F; depth: number; indent: number; hasChildren: boolean; open: boolean };

/** The rows that show, top to bottom, with each row's indentation (capped) and disclosure state. */
export function visibleFolders<F extends TreeFolder>(forest: readonly FolderNode<F>[], closed: ReadonlySet<string>, current: string | null, folders: readonly F[]): VisibleFolder<F>[] {
  const reveal = new Set(folderAncestors(folders, current));
  const out: VisibleFolder<F>[] = [];
  const walk = (nodes: readonly FolderNode<F>[]) => {
    for (const node of nodes) {
      const open = folderOpen(node.folder.id, closed, reveal);
      out.push({ folder: node.folder, depth: node.depth, indent: Math.min(node.depth, FOLDER_INDENT_CAP), hasChildren: node.children.length > 0, open });
      if (open) walk(node.children);
    }
  };
  walk(forest);
  return out;
}

/** Per-folder counts of the items directly in each folder (notes, files). */
export function countByFolder(items: ReadonlyArray<{ folder_id: string | null }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) if (item.folder_id) counts.set(item.folder_id, (counts.get(item.folder_id) ?? 0) + 1);
  return counts;
}

/** The folders the person closed in one app's tree (localStorage `nook.sidebar.folders.<app>`). */
export const closedFoldersKey = (app: string) => `nook.sidebar.folders.${app}`;
export function readClosedFolders(storage: Pick<Storage, "getItem"> | null | undefined, app: string): string[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(closedFoldersKey(app)) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 64).slice(0, 200) : [];
  } catch {
    return [];
  }
}
export function writeClosedFolders(storage: Pick<Storage, "setItem"> | null | undefined, app: string, ids: readonly string[]) {
  try { storage?.setItem(closedFoldersKey(app), JSON.stringify(ids.slice(0, 200))); } catch { /* private mode: this visit only */ }
}
