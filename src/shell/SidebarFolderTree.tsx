import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEventHandler, type ReactNode } from "react";
import { ChevronRight, Folder as FolderIcon, Plus, type LucideIcon } from "lucide-react";
import { isPlainClick } from "./AppSidebar";
import { folderAncestors, folderForest, folderOpen, readClosedFolders, writeClosedFolders, type FolderNode, type TreeFolder } from "./folderTree";
import "./sidebar.css";

export type TreeDropHandlers = { onDragEnter?: DragEventHandler<HTMLElement>; onDragOver?: DragEventHandler<HTMLElement>; onDragLeave?: DragEventHandler<HTMLElement>; onDrop?: DragEventHandler<HTMLElement> };

/** A row above the folders (All notes, Shared with me). */
export type TreeEntry = { id: string; label: string; icon: LucideIcon; href: string; count?: number; current: boolean; onSelect: () => void; drop?: TreeDropHandlers; className?: string };

export type TreeGroup<F extends TreeFolder> = {
  id: string;
  heading: string;
  /** The heading's small + (New folder), for the roles that may create one. */
  onNew?: (trigger: HTMLElement) => void;
  newLabel?: string;
  /** The group's folders in display order; they nest by `parent_id`. */
  folders: readonly F[];
  empty?: string;
};

type Props<F extends TreeFolder> = {
  /** Keys the closed folders kept in this browser (`nook.sidebar.folders.<app>`). */
  app: string;
  label: string;
  entries: readonly TreeEntry[];
  groups: ReadonlyArray<TreeGroup<F>>;
  /** The folder on screen (its row is aria-current="page"; the folders above it stay open). */
  current: string | null;
  hrefFor: (folder: F) => string;
  onSelect: (folder: F) => void;
  name: (folder: F) => string;
  count?: (folder: F) => number | undefined;
  /** A second line: the owner of a folder someone shared. */
  sub?: (folder: F) => string | null | undefined;
  icon?: (folder: F) => LucideIcon;
  /** Something after the name (Files' lock on the Attachments folder). */
  badge?: (folder: F) => ReactNode;
  /** Drop handlers and a state class (drop-target, drop-candidate) for each folder. */
  drop?: (folder: F) => { handlers: TreeDropHandlers; className?: string } | null;
  /** A small action at the row's end (Share a note folder). */
  action?: (folder: F) => ReactNode;
};

const readStore = () => { try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; } };

/**
 * An app's folders in the global sidebar (D1288): its top rows (All, Shared with me), then each group
 * (Folders, Shared folders) as a tree that nests by parent, with counts, a chevron on folders that
 * have subfolders (kept closed across reloads), and the app's own drops and actions on each row. Every
 * row is a real link; a plain click goes through the app's own handler (Notes saves the open note
 * first). The folder on screen is aria-current="page", the folders above it stay open, and it is
 * scrolled into view when it changes. Indentation stops at four levels; deeper names still truncate.
 * In the rail the labels are hidden and each row names itself in a tooltip (`data-sidebar-tip`).
 */
export function SidebarFolderTree<F extends TreeFolder>({ app, label, entries, groups, current, hrefFor, onSelect, name, count, sub, icon, badge, drop, action }: Props<F>) {
  const [closed, setClosed] = useState<string[]>(() => readClosedFolders(readStore(), app));
  const closedSet = useMemo(() => new Set(closed), [closed]);
  const allFolders = useMemo(() => groups.flatMap((group) => group.folders), [groups]);
  // Opening a folder opens the folders above it, so the current row never hides under a closed one.
  const reveal = useMemo(() => folderAncestors(allFolders, current), [allFolders, current]);
  const revealKey = reveal.join(",");
  useEffect(() => {
    if (!reveal.length) return;
    setClosed((list) => {
      if (!list.some((id) => reveal.includes(id))) return list;
      const next = list.filter((id) => !reveal.includes(id));
      writeClosedFolders(readStore(), app, next);
      return next;
    });
  }, [revealKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const none = useMemo(() => new Set<string>(), []);
  const forests = useMemo(() => groups.map((group) => folderForest(group.folders)), [groups]);
  const toggle = (id: string, open: boolean) => setClosed((list) => {
    const next = open ? list.filter((entry) => entry !== id) : [...list.filter((entry) => entry !== id), id];
    writeClosedFolders(readStore(), app, next);
    return next;
  });

  // The current row stays in view (after the sidebar's own scroll to the app, D1281).
  const rootRef = useRef<HTMLElement>(null);
  const currentKey = current ?? entries.find((entry) => entry.current)?.id ?? "";
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const row = rootRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
      if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentKey]);

  const link = (key: string, href: string, isCurrent: boolean, onClick: () => void, body: ReactNode, tip: string, extra: { className?: string; handlers?: TreeDropHandlers; style?: CSSProperties } = {}) =>
    <a className={`app-sidebar-sublink app-sidebar-tree-link${isCurrent ? " active" : ""}${extra.className ? ` ${extra.className}` : ""}`} href={href} aria-current={isCurrent ? "page" : undefined}
      data-sidebar-tip={tip} style={extra.style} {...extra.handlers} key={key}
      onClick={(event) => { if (!isPlainClick(event)) return; event.preventDefault(); onClick(); }}>{body}</a>;

  const folderRow = (node: FolderNode<F>, groupId: string): ReactNode => {
    const folder = node.folder;
    const open = folderOpen(folder.id, closedSet, none);
    const hasChildren = node.children.length > 0;
    const Icon = icon?.(folder) ?? FolderIcon;
    const label = name(folder);
    const total = count?.(folder);
    const owner = sub?.(folder);
    const dropping = drop?.(folder) ?? null;
    const childrenId = `app-sidebar-tree-${groupId}-${folder.id}`;
    const indent = Math.min(node.depth, 4);
    return <li key={folder.id} className="app-sidebar-tree-item">
      <div className="app-sidebar-tree-row" style={{ "--tree-indent": indent } as CSSProperties}>
        {hasChildren
          ? <button type="button" className="app-sidebar-tree-toggle" aria-expanded={open} aria-controls={childrenId} aria-label={`${open ? "Hide" : "Show"} subfolders of ${label}`}
            onClick={() => toggle(folder.id, !open)}><ChevronRight aria-hidden="true" /></button>
          : <span className="app-sidebar-tree-spacer" aria-hidden="true" />}
        {link(folder.id, hrefFor(folder), current === folder.id, () => onSelect(folder), <>
          <Icon aria-hidden="true" />
          <span className="app-sidebar-label app-sidebar-tree-name" title={label}>{label}{owner && <small>{owner}</small>}</span>
          {badge?.(folder)}
          {total !== undefined && <b className="app-sidebar-tree-count" aria-label={`, ${total}`}>{total}</b>}
        </>, label, { className: dropping?.className, handlers: dropping?.handlers })}
        {action?.(folder)}
      </div>
      {hasChildren && open && <ul id={childrenId} className="app-sidebar-tree-children">{node.children.map((child) => folderRow(child, groupId))}</ul>}
    </li>;
  };

  return <nav ref={rootRef} className="app-sidebar-tree" aria-label={label}>
    <ul className="app-sidebar-tree-list">
      {entries.map((entry) => {
        const Icon = entry.icon;
        return <li key={entry.id} className="app-sidebar-tree-item"><div className="app-sidebar-tree-row app-sidebar-tree-top">
          {link(entry.id, entry.href, entry.current, entry.onSelect, <>
            <Icon aria-hidden="true" /><span className="app-sidebar-label">{entry.label}</span>
            {entry.count !== undefined && <b className="app-sidebar-tree-count" aria-label={`, ${entry.count}`}>{entry.count}</b>}
          </>, entry.label, { className: entry.className, handlers: entry.drop })}
        </div></li>;
      })}
    </ul>
    {groups.map((group, index) => <div key={group.id} className="app-sidebar-tree-group">
      <div className="app-sidebar-tree-heading">
        <span id={`app-sidebar-tree-${app}-${group.id}`}>{group.heading}</span>
        {group.onNew && <button type="button" className="app-sidebar-tree-new" aria-label={group.newLabel ?? "New folder"} aria-haspopup="dialog" title={group.newLabel ?? "New folder"}
          data-sidebar-tip={group.newLabel ?? "New folder"} onClick={(event) => group.onNew?.(event.currentTarget)}><Plus aria-hidden="true" /></button>}
      </div>
      <ul className="app-sidebar-tree-list" aria-labelledby={`app-sidebar-tree-${app}-${group.id}`}>{forests[index]!.map((node) => folderRow(node, group.id))}</ul>
      {group.folders.length === 0 && group.empty && <p className="app-sidebar-tree-empty">{group.empty}</p>}
    </div>)}
  </nav>;
}
