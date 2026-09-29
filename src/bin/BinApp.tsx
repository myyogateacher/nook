import { useCallback, useEffect, useRef, useState } from "react";
import { ArchiveRestore, CalendarClock, CalendarDays, Ellipsis, File as FileIcon, House, KanbanSquare, NotebookText, PenTool, RotateCcw, Rows3, Sparkles, SquareCheck, Table2, Trash2, TriangleAlert, X } from "lucide-react";
import { ApiError } from "../api";
import { AccountActions, AppPageName } from "../AppShell";
import { formatBytes } from "../files/filesApi";
import { useDialogSentinel } from "../historyDialogs";
import { useConfirm } from "../ui/useConfirm";
import { relativeTime } from "../files/format";
import type { BinItem } from "../types";
import { deleteBinItem, emptyBin, listBin, restoreBinItem } from "./binApi";
import {
  binFolderLabel,
  binItemLabel,
  binKindLabel,
  attachmentLabel,
  deleteForeverConfirm,
  emptiedMessage,
  emptyBinConfirm,
  filterBinItems,
  purgeCountdownLabel,
  restoreResultMessage,
  subitemLabel,
  type BinFilter
} from "./binFormat";
import "./bin.css";
import { ReadOnlyBanner, useRole } from "../team/roleAccess";

type BinAppProps = {
  displayName: string;
  flash: (message: string) => void;
  onHome: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  /** Called after an item is restored, so the owning app can refresh its lists. */
  onRestored?: (item: BinItem) => void;
};

type PendingAction = "restore" | "delete";

const filters: Array<{ value: BinFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "note", label: "Notes" },
  { value: "document", label: "Files" },
  { value: "tasks", label: "Tasks" },
  { value: "collections", label: "Collections" },
  { value: "calendar", label: "Calendar" }
];

const itemIcons = { note: NotebookText, document: FileIcon, card: SquareCheck, board: KanbanSquare, collection: Table2, collection_row: Rows3, calendar: CalendarDays, event: CalendarClock } as const;

const itemKey = (item: Pick<BinItem, "type" | "id">) => `${item.type}:${item.id}`;
const errorCode = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object"
  ? (reason.payload as { code?: unknown }).code
  : undefined;

export function BinApp({ displayName, flash, onHome, onSettings, onSignOut, onRestored }: BinAppProps) {
  // O3: viewers and guests see their Bin but cannot restore or delete forever; items age out.
  const { canWrite } = useRole();
  const [items, setItems] = useState<BinItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<BinFilter>("all");
  const [pending, setPending] = useState<Record<string, PendingAction>>({});
  const [emptying, setEmptying] = useState(false);
  const [sheetKey, setSheetKey] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);
  const sheetReturnFocusRef = useRef<HTMLElement | null>(null);
  // Items whose Delete forever request failed or is still finishing. A 404 on the next
  // attempt then means the earlier one completed.
  const retriedDeletesRef = useRef(new Set<string>());
  // Delete forever and Empty Bin ask in the app's own dialog, a history layer (C1).
  const { ask, confirmElement } = useConfirm();

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    setLoadError(null);
    try {
      const { items: loaded } = await listBin();
      if (generation === loadGenerationRef.current) setItems(loaded);
    } catch (reason) {
      if (generation === loadGenerationRef.current) setLoadError(reason instanceof Error ? reason.message : "Could not load the Bin");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const closeSheet = useCallback(() => {
    setSheetKey(null);
    sheetReturnFocusRef.current?.focus();
    sheetReturnFocusRef.current = null;
  }, []);

  // The sheet has no history entry of its own (except the depth-0 sentinel on a phone), so Back/Forward (and Escape) just close it.
  useDialogSentinel(sheetKey !== null);
  useEffect(() => {
    if (!sheetKey) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeSheet(); };
    const onPop = () => setSheetKey(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
    };
  }, [closeSheet, sheetKey]);

  const all = items ?? [];
  const visible = filterBinItems(all, filter);
  const sheetItem = sheetKey ? all.find((item) => itemKey(item) === sheetKey) ?? null : null;
  const busy = emptying || Object.keys(pending).length > 0;

  function setItemPending(item: BinItem, action: PendingAction | null) {
    setPending((current) => {
      const next = { ...current };
      if (action) next[itemKey(item)] = action;
      else delete next[itemKey(item)];
      return next;
    });
  }

  const removeItem = (item: BinItem) => setItems((current) => current?.filter((entry) => itemKey(entry) !== itemKey(item)) ?? current);

  async function restore(item: BinItem) {
    setSheetKey(null);
    setItemPending(item, "restore");
    try {
      const result = await restoreBinItem(item);
      removeItem(item);
      flash(restoreResultMessage(item, result));
      onRestored?.(item);
      // Restoring a board brings its binned cards' board back too; refresh so their rows update.
      if (item.type === "board") void load();
    } catch (reason) {
      if (errorCode(reason) === "PURGING") flash("This item is being deleted forever and can't be restored");
      else if (errorCode(reason) === "BOARD_IN_BIN") flash(`Restore the board ${item.board_name ? `“${item.board_name}” ` : ""}first`);
      else if (errorCode(reason) === "PARENT_IN_BIN" && item.type === "event") flash("Its calendar is in the Bin. Restore the calendar first.");
      else if (errorCode(reason) === "PARENT_IN_BIN") flash(`Restore “${item.folder_name ?? "its collection"}” from the Bin first`);
      else if (errorCode(reason) === "LIMIT_REACHED") flash(reason instanceof Error ? reason.message : "Limit reached");
      else if (reason instanceof ApiError && reason.status === 404) flash("This item is no longer in the Bin");
      else flash(reason instanceof Error ? reason.message : "Could not restore this item");
      void load();
    } finally {
      setItemPending(item, null);
    }
  }

  async function deleteForever(item: BinItem) {
    // From the item's sheet, focus goes back to the row's ⋯ button the sheet opened from.
    const opener = sheetKey ? sheetReturnFocusRef.current : undefined;
    setSheetKey(null);
    if (!await ask({ title: "Delete forever?", message: deleteForeverConfirm(binItemLabel(item)), confirmLabel: "Delete forever", danger: true, opener })) return;
    setItemPending(item, "delete");
    try {
      const result = await deleteBinItem(item);
      if (result.pending) {
        retriedDeletesRef.current.add(itemKey(item));
        setItems((current) => current?.map((entry) => itemKey(entry) === itemKey(item) ? { ...entry, purging: true } : entry) ?? current);
        flash("Deleting forever. This will finish shortly.");
      } else {
        retriedDeletesRef.current.delete(itemKey(item));
        removeItem(item);
        flash("Deleted forever");
      }
    } catch (reason) {
      const retry = retriedDeletesRef.current.has(itemKey(item));
      if (reason instanceof ApiError && reason.status === 404 && retry) {
        // An earlier attempt finished after all.
        retriedDeletesRef.current.delete(itemKey(item));
        removeItem(item);
        flash("Deleted forever");
      } else {
        if (reason instanceof ApiError && reason.status === 404) flash("This item is no longer in the Bin");
        else if (errorCode(reason) === "NOT_IN_BIN") flash("This item was already restored");
        else if (errorCode(reason) === "OWNER_ONLY") flash("Only the board owner can delete this forever");
        else {
          // The request may or may not have reached the server; a later 404 means it did.
          retriedDeletesRef.current.add(itemKey(item));
          flash(reason instanceof Error ? reason.message : "Could not delete this item");
        }
        void load();
      }
    } finally {
      setItemPending(item, null);
    }
  }

  async function emptyAll() {
    if (!all.length || !await ask({ title: "Empty the Bin?", message: emptyBinConfirm(all.length), confirmLabel: "Empty Bin", danger: true })) return;
    setEmptying(true);
    try {
      const result = await emptyBin();
      flash(emptiedMessage(result.purged, result.pending));
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : "Could not empty the Bin");
    } finally {
      setEmptying(false);
      void load();
    }
  }

  function openSheet(item: BinItem, trigger: HTMLElement) {
    sheetReturnFocusRef.current = trigger;
    setSheetKey(itemKey(item));
  }

  const emptyCopy = filter === "note" ? "No notes in the Bin." : filter === "document" ? "No files in the Bin." : filter === "tasks" ? "No cards or boards in the Bin." : filter === "collections" ? "No collections or rows in the Bin." : filter === "calendar" ? "No calendars or events in the Bin." : "Nothing in the Bin.";

  return <main className="app-page bin-app">
    <header className="app-page-header">
      <button className="app-home-button" onClick={onHome}><House />Home</button>
      <span className="app-home-brand"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>Bin</strong></span></span><AppPageName name="Bin" />
      <AccountActions displayName={displayName} onSettings={onSettings} onSignOut={onSignOut} />
    </header>
    <ReadOnlyBanner />

    <section className="bin-content" aria-labelledby="bin-title">
      <div className="bin-intro">
        <div>
          <span className="eyebrow">Bin</span>
          <h1 id="bin-title">Bin</h1>
          <p>Deleted notes, files, cards, boards, collections, rows, calendars, and events stay here for 30 days, then they are deleted forever. Restoring brings back their sharing.</p>
        </div>
        {canWrite && <button className="bin-empty-button" onClick={() => { void emptyAll(); }} disabled={!all.length || busy}><Trash2 />{emptying ? "Emptying…" : "Empty Bin"}</button>}
      </div>

      <div className="bin-filters" role="group" aria-label="Show">
        {filters.map(({ value, label }) => {
          const count = filterBinItems(all, value).length;
          return <button key={value} className={`bin-chip${filter === value ? " active" : ""}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {label}{items && <b>{count}</b>}
          </button>;
        })}
      </div>

      {loadError && <div className="bin-state bin-error" role="alert">
        <span className="bin-state-icon"><TriangleAlert /></span>
        <h2>Could not load the Bin</h2>
        <p>{loadError}</p>
        <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
      </div>}

      {!loadError && !items && <p className="bin-loading" role="status">Loading the Bin…</p>}

      {!loadError && items && !visible.length && <div className="bin-state">
        <span className="bin-state-icon"><Trash2 /></span>
        <h2>{emptyCopy}</h2>
        <p>Deleted items stay here for 30 days.</p>
      </div>}

      {!loadError && visible.length > 0 && <ul className="bin-list" aria-label="Items in the Bin">
        {visible.map((item) => {
          const key = itemKey(item);
          const action = pending[key];
          const Icon = item.type === "document" && item.kind === "whiteboard" ? PenTool : itemIcons[item.type];
          const canPurge = item.can_purge !== false;
          const label = binItemLabel(item);
          const disabled = Boolean(action) || item.purging || emptying;
          return <li key={key} className={`bin-row${action || item.purging ? " pending" : ""}`} aria-busy={action || item.purging ? true : undefined}>
            <span className="bin-row-icon" aria-hidden="true"><Icon /></span>
            <span className="bin-row-copy">
              <span className="bin-row-title" title={label}><span className="sr-only">{binKindLabel(item)}: </span>{label}</span>
              <span className="bin-row-meta">
                <span>{item.type === "card" ? `On ${binFolderLabel(item)}` : item.type === "board" ? "Board" : item.type === "event" ? `In ${binFolderLabel(item)}` : item.attachment ? attachmentLabel(item) : binFolderLabel(item)}</span>
                {item.type === "card" && Boolean(item.descendant_count) && <span>{subitemLabel(item.descendant_count!)}</span>}
                <time dateTime={item.deleted_at}>Deleted {relativeTime(item.deleted_at)}</time>
                {item.purging || action === "delete"
                  ? <span className="bin-row-status">Deleting forever…</span>
                  : action === "restore"
                    ? <span className="bin-row-status">Restoring…</span>
                    : <time className="bin-row-countdown" dateTime={item.purge_after}>{purgeCountdownLabel(item.purge_after)}</time>}
                {item.type === "document" && item.size_bytes !== null && <span>{formatBytes(item.size_bytes)}</span>}
              </span>
            </span>
            {canWrite && <span className="bin-row-actions">
              <button className="bin-action" onClick={() => { void restore(item); }} disabled={disabled} aria-label={`Restore ${label}`}><ArchiveRestore />Restore</button>
              {canPurge && <button className="bin-action danger" onClick={() => { void deleteForever(item); }} disabled={disabled} aria-label={`Delete ${label} forever`}><Trash2 />Delete forever</button>}
            </span>}
            {canWrite && <button className="icon-button bin-more" onClick={(event) => openSheet(item, event.currentTarget)} disabled={disabled} aria-haspopup="dialog" aria-label={`Actions for ${label}`}><Ellipsis /></button>}
          </li>;
        })}
      </ul>}
    </section>

    {sheetItem && <>
      <button className="panel-scrim" onClick={closeSheet} aria-label="Close actions" />
      <div className="bin-sheet" role="dialog" aria-modal="true" aria-label={`Actions for ${binItemLabel(sheetItem)}`}>
        <header>
          <strong id="bin-sheet-title" title={binItemLabel(sheetItem)}>{binItemLabel(sheetItem)}</strong>
          <button className="icon-button" onClick={closeSheet} aria-label="Close actions"><X /></button>
        </header>
        <button autoFocus onClick={() => { void restore(sheetItem); }}><ArchiveRestore />{sheetItem.type === "board" ? "Restore board" : sheetItem.type === "calendar" ? "Restore" : `Restore to ${binFolderLabel(sheetItem)}`}</button>
        {sheetItem.can_purge !== false && <button className="danger" onClick={() => { void deleteForever(sheetItem); }}><Trash2 />Delete forever</button>}
        <button onClick={closeSheet}>Cancel</button>
      </div>
    </>}
    {confirmElement}
  </main>;
}
