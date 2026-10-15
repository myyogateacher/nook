import { useState, type DragEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChartColumn, FilePlus2, Folder as FolderIcon, FolderInput, FolderPlus, Inbox, Pencil, Star, Trash2, Users } from "lucide-react";
import type { ReportFolder, ReportFolderTree } from "../../shared/reports";
import type { ReportsFolderView } from "../router";
import { ReportOverflowMenu, type MenuItem } from "./reportCommands";
import { canNest, dropZoneAt, FOLDER_DRAG_TYPE, isFolderDrag, isReportDrag, orderedFolders, planFolderDrop, planStep, REPORT_DRAG_TYPE, type FolderDropPlan, type FolderDropZone, type FolderPlace } from "./reportFolderTree";

export type FolderActions = {
  rename: (folder: ReportFolder) => void;
  newSubfolder: (folder: ReportFolder) => void;
  newReportIn: (folder: ReportFolder) => void;
  remove: (folder: ReportFolder) => void;
  /** K2: the keyboard and phone way to nest a folder (a sheet), and to reorder it among its siblings. */
  moveTo: (folder: ReportFolder) => void;
  place: (folder: ReportFolder, place: FolderPlace) => void;
};

type NavProps = {
  tree: ReportFolderTree | null;
  view: ReportsFolderView | null;
  onSelect: (view: ReportsFolderView | null) => void;
  /** Files reports (drop targets for an owner's report rows). */
  canWrite: boolean;
  /** Phase 2 (D483): any member creates folders; only admins rename, move, reorder, or delete them. */
  canCreate?: boolean;
  canManage?: boolean;
  /** A report row is being dragged (its id); folders and Unfiled are drop targets meanwhile. */
  dragging: string | null;
  onDropReport: (reportId: string, folderId: string | null) => void;
  onNewFolder: () => void;
  actions: FolderActions;
};

/** Phase 2: two sibling folders with the same name (two people's, from before the shared tree) show who made each. */
function sameNameSiblings(folders: readonly ReportFolder[]): Set<string> {
  const seen = new Map<string, string[]>();
  for (const folder of folders) {
    const key = `${folder.parentId ?? ""}\u0000${folder.name.toLocaleLowerCase()}`;
    seen.set(key, [...seen.get(key) ?? [], folder.id]);
  }
  return new Set([...seen.values()].filter((ids) => ids.length > 1).flat());
}

/**
 * The Reports home's left nav (Lane I), in the Notes folder sidebar's look: All reports, Favorites (phase 1), Unfiled, the
 * workspace's shared folder tree (phase 2, D483) with per-reader counts (up to three levels), Shared with me, and New folder.
 * Members get New folder and New subfolder; only admins get Rename, Move, Move up/down, Delete, and folder drags. Each folder has a
 * ⋯ menu (rename, new subfolder, new report here, delete). While a report row is dragged, Unfiled and
 * every folder are drop targets, highlighted under the pointer. On a phone the same list sits in a sheet.
 * K2: a folder drags too: onto the middle of another folder to nest it there, or onto its top or bottom
 * edge to put it before or after it (an insertion line). A drop into its own subfolder or past the
 * depth limit is refused under the pointer with the reason. The ⋯ menu has Move folder to…, Move up and
 * Move down for keyboards and phones.
 */
type Handlers = Record<string, unknown>;
/** Both drop targets on one row: the report drop's handlers and the folder drag's, each ignoring the other's drags. */
function mergeHandlers(first: Handlers, second: Handlers): Handlers {
  const out: Handlers = { ...first, ...second };
  for (const key of Object.keys(first)) {
    const a = first[key];
    const b = second[key];
    if (typeof a === "function" && typeof b === "function") out[key] = (event: unknown) => { (a as (event: unknown) => void)(event); (b as (event: unknown) => void)(event); };
  }
  return out;
}

export function ReportFolderNav({ tree, view, onSelect, canWrite, canCreate = canWrite, canManage = canWrite, dragging, onDropReport, onNewFolder, actions }: NavProps) {
  const [over, setOver] = useState<string | null>(null);
  const [draggingFolder, setDraggingFolder] = useState<string | null>(null);
  const [folderOver, setFolderOver] = useState<{ id: string; zone: FolderDropZone; plan: FolderDropPlan } | null>(null);
  const folders = tree?.folders ?? [];
  const folderDropProps = (folder: ReportFolder) => {
    const planAt = (event: DragEvent<HTMLElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      const zone = dropZoneAt(event.clientY - box.top, box.height);
      return { id: folder.id, zone, plan: planFolderDrop(folders, draggingFolder ?? "", folder.id, zone) };
    };
    return {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!draggingFolder || !isFolderDrag(event.dataTransfer.types)) return;
        event.preventDefault();
        const next = planAt(event);
        event.dataTransfer.dropEffect = next.plan.ok === true ? "move" : "none";
        if (folderOver?.id !== next.id || folderOver.zone !== next.zone) setFolderOver(next);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFolderOver((current) => current?.id === folder.id ? null : current); },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!draggingFolder || !isFolderDrag(event.dataTransfer.types)) return;
        event.preventDefault();
        const { plan } = planAt(event);
        const moving = folders.find((item) => item.id === draggingFolder);
        setFolderOver(null);
        setDraggingFolder(null);
        if (moving && plan.ok === true) actions.place(moving, plan.place);
      }
    };
  };
  const startFolderDrag = (event: DragEvent<HTMLElement>, folder: ReportFolder) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(FOLDER_DRAG_TYPE, folder.id);
    event.dataTransfer.setData("text/plain", folder.name);
    setDraggingFolder(folder.id);
  };
  const endFolderDrag = () => { setDraggingFolder(null); setFolderOver(null); };
  const refused = folderOver && folderOver.plan.ok === false ? folderOver.plan.reason : null;
  const dropProps = (key: string, folderId: string | null) => canWrite ? {
    onDragEnter: (event: DragEvent) => { if (!isReportDrag(event.dataTransfer.types)) return; event.preventDefault(); setOver(key); },
    onDragOver: (event: DragEvent) => { if (!isReportDrag(event.dataTransfer.types)) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; if (over !== key) setOver(key); },
    onDragLeave: (event: DragEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver((current) => current === key ? null : current); },
    onDrop: (event: DragEvent) => {
      if (!isReportDrag(event.dataTransfer.types)) return;
      event.preventDefault();
      setOver(null);
      const reportId = event.dataTransfer.getData(REPORT_DRAG_TYPE) || dragging;
      if (reportId) onDropReport(reportId, folderId);
    }
  } : {};
  const item = (key: string, label: ReactNode, icon: ReactNode, count: number | undefined, selected: boolean, onClick: () => void, extra: object = {}, more = "") =>
    <button type="button" className={`reports-nav-link${selected ? " active" : ""}${dragging && over === key ? " drop-target" : ""}${more}`} aria-current={selected ? "page" : undefined} onClick={onClick} {...extra}>
      {icon}<span className="reports-nav-name">{label}</span>{count !== undefined && <b>{count}</b>}
    </button>;

  const nodes = tree ? orderedFolders(tree.folders) : [];
  const twins = sameNameSiblings(folders);
  const dropClass = (id: string) => {
    if (!draggingFolder) return "";
    if (id === draggingFolder) return " folder-dragging";
    if (folderOver?.id !== id || folderOver.plan.ok === "same") return "";
    if (folderOver.plan.ok === false) return " drop-refused";
    return folderOver.zone === "into" ? " drop-target" : ` drop-${folderOver.zone}`;
  };
  return <nav className={`reports-nav${dragging || draggingFolder ? " is-dragging" : ""}`} aria-label="Report folders">
    {item("all", "All reports", <ChartColumn aria-hidden="true" />, tree?.counts.all, view === null, () => onSelect(null))}
    {item("favorites", "Favorites", <Star aria-hidden="true" />, tree?.counts.favorites, view === "favorites", () => onSelect("favorites"), {}, " reports-nav-favorites")}
    {item("unfiled", "Unfiled", <Inbox aria-hidden="true" />, tree?.counts.unfiled, view === "unfiled", () => onSelect("unfiled"), dropProps("unfiled", null))}
    <div className="reports-nav-label">Folders</div>
    <ul className="reports-nav-tree" role="list">
      {nodes.map(({ folder, depth }) => {
        const menu: MenuItem[] = [
          ...(canManage ? [{ id: "rename", label: "Rename", icon: <Pencil aria-hidden="true" />, onSelect: () => actions.rename(folder) }] : []),
          ...(canCreate && canNest(depth) ? [{ id: "sub", label: "New subfolder", icon: <FolderPlus aria-hidden="true" />, onSelect: () => actions.newSubfolder(folder) }] : []),
          ...(canWrite ? [{ id: "report", label: "New report here", icon: <FilePlus2 aria-hidden="true" />, onSelect: () => actions.newReportIn(folder) }] : []),
          ...(canManage ? [
            { id: "move", label: "Move folder to…", icon: <FolderInput aria-hidden="true" />, onSelect: () => actions.moveTo(folder) },
            { id: "up", label: "Move up", icon: <ArrowUp aria-hidden="true" />, disabled: !planStep(folders, folder.id, -1), onSelect: () => { const place = planStep(folders, folder.id, -1); if (place) actions.place(folder, place); } },
            { id: "down", label: "Move down", icon: <ArrowDown aria-hidden="true" />, disabled: !planStep(folders, folder.id, 1), onSelect: () => { const place = planStep(folders, folder.id, 1); if (place) actions.place(folder, place); } },
            { id: "delete", label: "Delete folder", icon: <Trash2 aria-hidden="true" />, danger: true, onSelect: () => actions.remove(folder) }
          ] : [])
        ];
        const label = twins.has(folder.id) && folder.createdBy ? <>{folder.name}<small className="reports-nav-creator"> · {folder.createdBy.name}</small></> : folder.name;
        const folderDrag = canManage ? { draggable: true, onDragStart: (event: DragEvent<HTMLElement>) => startFolderDrag(event, folder), onDragEnd: endFolderDrag, ...folderDropProps(folder) } : {};
        return <li key={folder.id} className="reports-nav-entry" style={{ paddingLeft: `${(depth - 1) * 16}px` }}>
          {item(folder.id, label, <FolderIcon aria-hidden="true" />, folder.count, view === folder.id, () => onSelect(folder.id), mergeHandlers(dropProps(folder.id, folder.id), folderDrag), dropClass(folder.id))}
          {menu.length > 0 && <ReportOverflowMenu compact className="reports-nav-menu" label={`${folder.name} folder actions`} items={menu} />}
        </li>;
      })}
    </ul>
    {draggingFolder && <p className={`reports-nav-drop-note${refused ? " refused" : ""}`} role="status">{refused ?? "Drop on a folder to nest it, or on its top or bottom edge to reorder."}</p>}
    {tree && !nodes.length && <p className="reports-nav-empty">{canCreate ? "No folders yet. Create one to group the team's reports." : "No folders yet."}</p>}
    {canCreate && <button type="button" className="reports-nav-new" onClick={onNewFolder}><FolderPlus aria-hidden="true" /><span>New folder</span></button>}
    <div className="reports-nav-sep" />
    {item("shared", "Shared with me", <Users aria-hidden="true" />, tree?.counts.shared, view === "shared", () => onSelect("shared"))}
  </nav>;
}
