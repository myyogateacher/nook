import { useState, type DragEvent, type ReactNode } from "react";
import { ChartColumn, FilePlus2, Folder as FolderIcon, FolderPlus, Inbox, Pencil, Trash2, Users } from "lucide-react";
import type { ReportFolder, ReportFolderTree } from "../../shared/reports";
import type { ReportsFolderView } from "../router";
import { ReportOverflowMenu, type MenuItem } from "./reportCommands";
import { canNest, isReportDrag, orderedFolders, REPORT_DRAG_TYPE } from "./reportFolderTree";

export type FolderActions = {
  rename: (folder: ReportFolder) => void;
  newSubfolder: (folder: ReportFolder) => void;
  newReportIn: (folder: ReportFolder) => void;
  remove: (folder: ReportFolder) => void;
};

type NavProps = {
  tree: ReportFolderTree | null;
  view: ReportsFolderView | null;
  onSelect: (view: ReportsFolderView | null) => void;
  canWrite: boolean;
  /** A report row is being dragged (its id); folders and Unfiled are drop targets meanwhile. */
  dragging: string | null;
  onDropReport: (reportId: string, folderId: string | null) => void;
  onNewFolder: () => void;
  actions: FolderActions;
};

/**
 * The Reports home's left nav (Lane I), in the Notes folder sidebar's look: All reports, Unfiled, the
 * owner's folder tree with counts (up to three levels), Shared with me, and New folder. Each folder has a
 * ⋯ menu (rename, new subfolder, new report here, delete). While a report row is dragged, Unfiled and
 * every folder are drop targets, highlighted under the pointer. On a phone the same list sits in a sheet.
 */
export function ReportFolderNav({ tree, view, onSelect, canWrite, dragging, onDropReport, onNewFolder, actions }: NavProps) {
  const [over, setOver] = useState<string | null>(null);
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
  const item = (key: string, label: ReactNode, icon: ReactNode, count: number | undefined, selected: boolean, onClick: () => void, extra: object = {}) =>
    <button type="button" className={`reports-nav-link${selected ? " active" : ""}${dragging && over === key ? " drop-target" : ""}`} aria-current={selected ? "page" : undefined} onClick={onClick} {...extra}>
      {icon}<span className="reports-nav-name">{label}</span>{count !== undefined && <b>{count}</b>}
    </button>;

  const nodes = tree ? orderedFolders(tree.folders) : [];
  return <nav className={`reports-nav${dragging ? " is-dragging" : ""}`} aria-label="Report folders">
    {item("all", "All reports", <ChartColumn aria-hidden="true" />, tree?.counts.all, view === null, () => onSelect(null))}
    {item("unfiled", "Unfiled", <Inbox aria-hidden="true" />, tree?.counts.unfiled, view === "unfiled", () => onSelect("unfiled"), dropProps("unfiled", null))}
    <div className="reports-nav-label">Folders</div>
    <ul className="reports-nav-tree" role="list">
      {nodes.map(({ folder, depth }) => {
        const menu: MenuItem[] = canWrite ? [
          { id: "rename", label: "Rename", icon: <Pencil aria-hidden="true" />, onSelect: () => actions.rename(folder) },
          ...(canNest(depth) ? [{ id: "sub", label: "New subfolder", icon: <FolderPlus aria-hidden="true" />, onSelect: () => actions.newSubfolder(folder) }] : []),
          { id: "report", label: "New report here", icon: <FilePlus2 aria-hidden="true" />, onSelect: () => actions.newReportIn(folder) },
          { id: "delete", label: "Delete folder", icon: <Trash2 aria-hidden="true" />, danger: true, onSelect: () => actions.remove(folder) }
        ] : [];
        return <li key={folder.id} className="reports-nav-entry" style={{ paddingLeft: `${(depth - 1) * 16}px` }}>
          {item(folder.id, folder.name, <FolderIcon aria-hidden="true" />, folder.count, view === folder.id, () => onSelect(folder.id), dropProps(folder.id, folder.id))}
          {menu.length > 0 && <ReportOverflowMenu compact className="reports-nav-menu" label={`${folder.name} folder actions`} items={menu} />}
        </li>;
      })}
    </ul>
    {tree && !nodes.length && <p className="reports-nav-empty">{canWrite ? "No folders yet. Create one to group your reports." : "No folders yet."}</p>}
    {canWrite && <button type="button" className="reports-nav-new" onClick={onNewFolder}><FolderPlus aria-hidden="true" /><span>New folder</span></button>}
    <div className="reports-nav-sep" />
    {item("shared", "Shared with me", <Users aria-hidden="true" />, tree?.counts.shared, view === "shared", () => onSelect("shared"))}
  </nav>;
}
