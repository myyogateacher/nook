import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Copy, Ellipsis, Filter, Lock, Pencil, RotateCcw, Save, Share2, Trash2, TriangleAlert, Undo2 } from "lucide-react";
import { format } from "../../../shared/taskQuery";
import { ApiError } from "../../api";
import { ConfirmDialog, ModalDialog } from "../../files/Dialog";
import { NameDialog } from "../../files/RenameDialog";
import { useHistoryDialogGuard } from "../../ui/useHistoryDialogGuard";
import { taskErrorCode, taskErrorMessage } from "../tasksApi";
import { viewerTimeZone, type TaskNotify } from "../taskActions";
import { createView, deleteView, duplicateView, getView, saveViewSharing, updateView, type QueriedCard, type TaskView } from "../home/homeApi";
import { HomeResultsPane, type HomeDirectory } from "../home/HomeResultsPane";
import { useTasksTitle } from "../home/HomeSegments";
import { isSelectiveQuery, NEW_VIEW, newViewDefault, sameHomeQuery, serverGroup, viewHomeQuery, type HomeQuery } from "../home/homeUrl";
import { useRole } from "../../team/roleAccess";
import { announceViewsChanged, ownedViewActions, validateViewName, viewNameHint, viewRoleAccess, viewUndoBody, viewVisibilityLabel } from "./viewActions";
import { AccessSheet } from "../../access/AccessSheet";

type ViewPageProps = {
  userId: string;
  viewId: string;
  /** The URL's unsaved change to the view, or undefined for the saved one. */
  query: HomeQuery | undefined;
  /**
   * Replace: the view's filter, group, and sort; push: layouts and committed filter changes.
   * `saved`: after Save (the host may step back onto an identical entry instead of replacing).
   */
  onQuery: (next: HomeQuery | undefined, options: { push: boolean; saved?: boolean }) => void;
  directory: HomeDirectory;
  notify: TaskNotify;
  onOpenCard: (card: QueriedCard) => void;
  /** Opens another view (after Save as or Duplicate); `replace` when this entry should go (a saved new view). */
  onOpenView: (view: TaskView, options?: { replace?: boolean }) => void;
  onBack: () => void;
  /** After a delete: the views list, replacing this entry. */
  onDeleted: () => void;
  onMissing: () => void;
};

type ViewDialog = { kind: "menu" | "saveAs" | "rename" | "share" | "delete" } | { kind: "conflict"; latest: TaskView };

const displayOf = (query: HomeQuery) => ({ layout: query.layout, group: query.group, sort: query.sort });

/**
 * One saved view (§10.2): its filter bar, layouts, and Save / Save as / Duplicate / Share / Delete.
 * Only the owner changes it (revision CAS; 409 VIEW_CHANGED offers a reload); a recipient sees it
 * read-only with Duplicate. `new` is an unsaved view. Nothing runs until the filter has a key
 * other than text (Q11).
 */
export function ViewPage({ userId, viewId, query, onQuery, directory, notify, onOpenCard, onOpenView, onBack, onDeleted, onMissing }: ViewPageProps) {
  const isNew = viewId === NEW_VIEW;
  const [view, setView] = useState<TaskView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ViewDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeDialog = useCallback(() => {
    setDialog(null);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target) window.setTimeout(() => { if (target.isConnected) target.focus(); }, 0);
  }, []);
  useHistoryDialogGuard(dialog !== null, closeDialog);
  const open = (next: ViewDialog, trigger?: HTMLElement | null) => {
    if (trigger) returnFocusRef.current = trigger;
    setDialog(next);
  };

  const load = useCallback(async () => {
    if (isNew) return;
    setLoadError(null);
    try {
      setView((await getView(viewId)).view);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) onMissing();
      else setLoadError(taskErrorMessage(reason, "Could not open this view"));
    }
  }, [isNew, viewId, onMissing]);
  useEffect(() => {
    setView(null);
    void load();
  }, [load]);

  useTasksTitle(isNew ? "New view · Tasks" : view ? `${view.name} · Views · Tasks` : "Views · Tasks");

  const saved = view ? viewHomeQuery(view) : newViewDefault();
  const effective = query ?? saved;
  const { canCreate, canShare } = viewRoleAccess(useRole());
  // A guest edits no view, even one kept from before a role change (the write gate refuses it).
  const owner = canCreate && (isNew || view?.is_owner === 1);
  const actions = ownedViewActions(canShare, view?.visibility ?? "private");
  // A read-only owner's shared view is read only until they make it private.
  const editable = owner && actions.edit;
  const dirty = isNew ? isSelectiveQuery(effective.filter) : Boolean(view && query && !sameHomeQuery(query, saved));
  const selective = isSelectiveQuery(effective.filter);
  const tz = viewerTimeZone();
  const source = !selective || (!isNew && !view) ? null
    : !isNew && !query ? { kind: "view" as const, viewId, tz }
    : { kind: "query" as const, request: { q: format(effective.filter), sort: effective.sort, group: serverGroup(effective.group), tz } };

  /** The 409 VIEW_CHANGED answer carries the current view: offer to reload it. */
  function conflictOr(reason: unknown, fallback: string) {
    const latest = reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? (reason.payload as { view?: TaskView }).view : undefined;
    if (taskErrorCode(reason) === "VIEW_CHANGED" && latest) {
      setDialog({ kind: "conflict", latest });
      return;
    }
    notify(taskErrorMessage(reason, fallback));
  }

  async function save() {
    if (!view || !editable || busy) return;
    setBusy(true);
    try {
      const { view: next } = await updateView(view.id, { query: format(effective.filter), display: displayOf(effective), revision: view.revision });
      setView(next);
      onQuery(undefined, { push: false, saved: true });
      notify(`Saved “${next.name}”`);
    } catch (reason) {
      conflictOr(reason, "Could not save the view");
    } finally {
      setBusy(false);
    }
  }

  async function saveAs(name: string) {
    const { view: next } = await createView({ name, query: format(effective.filter), display: displayOf(effective) });
    setDialog(null);
    notify(`Saved “${next.name}” to your views`);
    onOpenView(next, { replace: isNew });
  }

  async function rename(name: string) {
    if (!view) return;
    try {
      const { view: next } = await updateView(view.id, { name, revision: view.revision });
      setView(next);
      setDialog(null);
      notify(`Renamed to “${next.name}”`);
    } catch (reason) {
      if (taskErrorCode(reason) === "VIEW_CHANGED") conflictOr(reason, "Could not rename the view");
      else throw reason;
    }
  }

  async function duplicate() {
    if (!view) return;
    setDialog(null);
    try {
      const { view: copy } = await duplicateView(view.id);
      notify(`Duplicated as “${copy.name}”`);
      onOpenView(copy);
    } catch (reason) {
      notify(taskErrorCode(reason) === "LIMIT_REACHED" ? "You already have 50 views" : taskErrorMessage(reason, "Could not duplicate the view"));
    }
  }

  async function remove() {
    if (!view) return;
    setBusy(true);
    try {
      await deleteView(view.id);
      setDialog(null);
      returnFocusRef.current = null;
      onDeleted();
      const body = viewUndoBody(view);
      notify(`Deleted “${view.name}”`, { label: "Undo", run: () => {
        createView(body).then(({ view: restored }) => {
          announceViewsChanged();
          notify(`Restored “${restored.name}” as a private view`, { label: "Open", run: () => onOpenView(restored) });
        }, (reason) => notify(taskErrorMessage(reason, "Could not restore the view")));
      } });
    } catch (reason) {
      closeDialog();
      notify(taskErrorMessage(reason, "Could not delete the view"));
    } finally {
      setBusy(false);
    }
  }

  /** A read-only owner withdraws a share: the view becomes private (and editable again). */
  async function makePrivate() {
    if (!view || busy) return;
    setBusy(true);
    try {
      await saveViewSharing(view.id, "private", []);
      setDialog(null);
      notify(`“${view.name}” is private now`);
      void load();
    } catch (reason) {
      closeDialog();
      notify(taskErrorMessage(reason, "Could not make the view private"));
    } finally {
      setBusy(false);
    }
  }

  const title = isNew ? "New view" : view?.name ?? (loadError ? "View" : "Loading…");
  const readOnly = !editable;

  return <div className="task-view-page">
    <header className="task-view-header">
      <button className="icon-button task-back" onClick={onBack} aria-label="Back to views" title="Back to views"><ChevronLeft /></button>
      <div className="task-board-heading">
        <span className="eyebrow">{isNew ? "Unsaved view" : view && !owner ? `${view.owner_name}’s view · read only` : view && !editable ? `View · ${viewVisibilityLabel(view.visibility)} · view only` : view ? `View · ${viewVisibilityLabel(view.visibility)}` : "View"}</span>
        <h2 id="task-view-title" title={title}>{title}</h2>
      </div>
      {dirty && !isNew && <span className="task-view-dirty" role="status">Unsaved changes</span>}
      <span className="task-view-actions">
        {!isNew && view && editable && dirty && <button className="icon-button" onClick={() => onQuery(undefined, { push: true })} aria-label="Discard changes" title="Discard changes"><Undo2 /></button>}
        {!isNew && view && editable && <button className="primary-button task-home-action" onClick={() => { void save(); }} disabled={!dirty || busy}><Save aria-hidden="true" /><span>{busy ? "Saving…" : "Save"}</span></button>}
        {isNew && canCreate && <button className="primary-button task-home-action" onClick={(event) => open({ kind: "saveAs" }, event.currentTarget)} disabled={!selective} aria-haspopup="dialog"><Save aria-hidden="true" /><span>Save view</span></button>}
        {!isNew && view && !owner && canCreate && <button className="primary-button task-home-action" onClick={() => { void duplicate(); }}><Copy aria-hidden="true" /><span>Duplicate</span></button>}
        {!isNew && view && owner && <button className="icon-button" onClick={(event) => open({ kind: "menu" }, event.currentTarget)} aria-haspopup="dialog" aria-label="View options" title="View options"><Ellipsis /></button>}
      </span>
    </header>
    {loadError && <div className="bin-state bin-error" role="alert">
      <span className="bin-state-icon"><TriangleAlert /></span>
      <h2>Could not open this view</h2>
      <p>{loadError}</p>
      <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
    </div>}
    {(isNew || view) && <HomeResultsPane userId={userId} query={effective} directory={directory} notify={notify} onOpenCard={onOpenCard} readOnly={readOnly}
      onQuery={(next, options) => onQuery(!isNew && sameHomeQuery(next, saved) ? undefined : next, options)}
      source={source}
      idle={<div className="bin-state task-home-empty">
        <span className="bin-state-icon"><Filter /></span>
        <h2>{readOnly ? "This view has no filter yet" : "Add a filter to see cards"}</h2>
        <p>{readOnly ? "Its owner has not chosen a board, person, state, or other filter." : "Choose a board, a person, a state, a tag, or a due date with + Filter. Views search across every board you can open, so they start with at least one filter."}</p>
      </div>}
      emptyText="No cards on your boards match this view." />}

    {dialog?.kind === "menu" && view && <ModalDialog title={view.name} eyebrow="View" onClose={closeDialog}>
      <div className="move-list task-menu">
        {actions.withdraw && <button className="move-option" autoFocus onClick={() => { void makePrivate(); }} disabled={busy}><Lock aria-hidden="true" /><span>Make private<small>Your Team role is view only: stop sharing to change this view</small></span></button>}
        {actions.edit && <button className="move-option" autoFocus onClick={() => setDialog({ kind: "rename" })}><Pencil aria-hidden="true" /><span>Rename</span></button>}
        <button className="move-option" onClick={() => setDialog({ kind: "saveAs" })}><Save aria-hidden="true" /><span>Save as a new view…<small>Keeps this one as it is</small></span></button>
        <button className="move-option" onClick={() => { void duplicate(); }}><Copy aria-hidden="true" /><span>Duplicate<small>A private copy of the saved view</small></span></button>
        {canShare && <button className="move-option" onClick={() => setDialog({ kind: "share" })}><Share2 aria-hidden="true" /><span>Share…<small>{viewVisibilityLabel(view.visibility)}</small></span></button>}
        {actions.edit && <button className="move-option danger" onClick={() => setDialog({ kind: "delete" })}><Trash2 aria-hidden="true" /><span>Delete view</span></button>}
      </div>
    </ModalDialog>}
    {dialog?.kind === "saveAs" && <NameDialog title={isNew ? "Save view" : "Save as a new view"} eyebrow="Views" label="View name" initialValue={isNew ? "" : `${view?.name ?? "View"} (copy)`.slice(0, 80)} submitLabel="Save view"
      hint={viewNameHint(canShare)} validate={(value) => validateViewName(value)} onSubmit={saveAs} onCancel={closeDialog} />}
    {dialog?.kind === "rename" && view && <NameDialog title="Rename view" eyebrow="Views" label="View name" initialValue={view.name} submitLabel="Rename" hint="Up to 80 characters."
      validate={(value) => validateViewName(value, view.name)} onSubmit={rename} onCancel={closeDialog} />}
    {dialog?.kind === "share" && view && canShare && <AccessSheet kind="task_view" id={view.id} title={view.name} onClose={closeDialog} onSaved={() => {
      closeDialog();
      notify("Access updated");
      // Sharing bumps the view's revision.
      void load();
    }} />}
    {dialog?.kind === "delete" && view && <ConfirmDialog title="Delete this view?" danger busy={busy} confirmLabel="Delete view"
      message={`Delete “${view.name}”? Its cards stay on their boards.${view.visibility !== "private" ? " People you shared it with lose it too." : ""}`}
      onConfirm={() => { void remove(); }} onCancel={closeDialog} />}
    {dialog?.kind === "conflict" && <ConfirmDialog title="This view changed" confirmLabel="Reload the view"
      message={`“${dialog.latest.name}” was changed somewhere else since you opened it. Reload it to see the latest version; your unsaved changes here are dropped.`}
      onConfirm={() => { setView(dialog.latest); setDialog(null); onQuery(undefined, { push: false }); }} onCancel={closeDialog} />}
  </div>;
}
