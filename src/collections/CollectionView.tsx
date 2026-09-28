import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Bookmark, Columns3, Download, Eye, Pencil, RotateCcw, Save, Share2, SlidersHorizontal, Trash2, TriangleAlert, Upload, X } from "lucide-react";
import { ApiError } from "../api";
import { ConfirmDialog } from "../files/Dialog";
import { NameDialog } from "../files/RenameDialog";
import { formatRoute } from "../router";
import { collectionsRoute } from "../collectionsRoute";
import type { GoOptions } from "./CollectionsApp";
import {
  createView,
  deleteCollection,
  deleteRow,
  deleteView,
  errorCode,
  errorMessage,
  errorPayload,
  exportUrl,
  getCollection,
  renameCollection,
  undoRow,
  updateView,
  type CollectionDetail,
  type CollectionRole,
  type CollectionRow,
  type CollectionView as SavedView,
  type FieldValue,
  type ViewConfig
} from "./collectionsApi";
import { Attachments } from "./Attachments";
import { CollectionCards, useIsPhone } from "./CollectionCards";
import { AccessSheet } from "../access/AccessSheet";
import { CollectionTable } from "./CollectionTable";
import { useDialogLayer } from "./dialogLayers";
import { FieldEditor } from "./FieldEditor";
import { ImportDialog } from "./ImportDialog";
import { CollectionIcon } from "./icons";
import { OptionPicker } from "./OptionPicker";
import { RowActionSheet } from "./RowActionSheet";
import { RowPanel } from "./RowPanel";
import { SortFilterSheet, type SortFilter } from "./SortFilterSheet";
import { useRows } from "./useRows";
import { collectionBinMessage, roleLabel, rowCountLabel, validateCollectionName, validateName } from "./values";
import { useRole } from "../team/roleAccess";

type CollectionViewProps = {
  userId: string;
  collectionId: string;
  /** The saved view on screen (for a row entry, the view it was opened over). */
  viewId: string | null;
  rowId: string | null;
  go: (route: ReturnType<typeof collectionsRoute>, options?: GoOptions) => void;
  onBack: () => void;
  onMissing: (what: "collection" | "view" | "row") => void;
  notify: (message: string) => void;
  /** Open the CSV import once loaded (New collection → Create and import CSV). */
  openImport?: boolean;
  onImportOpened?: () => void;
};

type Dialog =
  | { kind: "fields" }
  | { kind: "rename" }
  | { kind: "sortFilter" }
  | { kind: "share" }
  | { kind: "saveView"; value: SortFilter }
  | { kind: "renameView" }
  | { kind: "deleteView" }
  | { kind: "deleteCollection" }
  | { kind: "import" }
  | { kind: "picker"; rowId: string; fieldId: string }
  | { kind: "actions"; rowId: string };

export function CollectionView({ collectionId, viewId, rowId, go, onBack, onMissing, notify, openImport = false, onImportOpened }: CollectionViewProps) {
  const [collection, setCollection] = useState<CollectionDetail | null>(null);
  const [role, setRole] = useState<CollectionRole>("viewer");
  const [views, setViews] = useState<SavedView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const rows = useRows(collectionId, notify);
  // min(Team role, item role) (§2.4): a read-only Team role never edits, even its own collection.
  const { canWrite } = useRole();
  const editable = canWrite && role !== "viewer";
  const isOwner = canWrite && role === "owner";
  // Managers (Wave 32, D273) also rename, change fields and views, and share up to Can edit; only the owner deletes.
  const canManage = isOwner || (canWrite && collection?.level === "manage");

  const loadCollection = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await getCollection(collectionId);
      setCollection(result.collection);
      setRole(result.role);
      setViews(result.views);
      return result;
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) onMissing("collection");
      else setLoadError(errorMessage(reason, "Could not open this collection"));
      return null;
    }
  }, [collectionId, onMissing]);

  useEffect(() => { void loadCollection(); }, [loadCollection]);
  useEffect(() => {
    if (!openImport || !collection) return;
    setDialog({ kind: "import" });
    onImportOpened?.();
  }, [collection, onImportOpened, openImport]);

  const view = viewId ? views.find((item) => item.id === viewId) ?? null : null;
  // Sort and filters chosen in the sheet override the saved view's until the view changes.
  const [local, setLocal] = useState<SortFilter | null>(null);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [detached, setDetached] = useState<Record<string, CollectionRow>>({});
  const phone = useIsPhone();
  useEffect(() => { setLocal(null); }, [viewId]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!collection) return;
    if (viewId && !view) {
      onMissing("view");
      return;
    }
    void rows.load({ ...(viewId ? { viewId } : {}), ...(local ? { sort: local.sort, filters: local.filters } : {}), ...(q ? { q } : {}) });
    // rows.load is stable per collection; reload when the view, the schema, or the spec changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection?.id, collection?.schema_version, viewId, view?.id, local, q]);

  const closeDialog = useCallback(() => setDialog(null), []);
  useDialogLayer(dialog !== null, closeDialog);

  const effective: SortFilter = local ?? { sort: view?.config.sort ?? [], filters: view?.config.filters ?? [], hiddenFieldIds: view?.config.hiddenFieldIds ?? [] };
  const activeCount = effective.sort.length + effective.filters.length;
  const closeRow = useCallback(() => onBack(), [onBack]);
  const rowMissing = useCallback(() => onMissing("row"), [onMissing]);

  const hiddenKey = effective.hiddenFieldIds.join(",");
  const fields = useMemo(() => {
    const hidden = new Set(hiddenKey ? hiddenKey.split(",") : []);
    return (collection?.fields ?? []).filter((field, index) => index === 0 || !hidden.has(field.id));
  }, [collection?.fields, hiddenKey]);

  const configOf = (value: SortFilter): ViewConfig => ({
    ...(value.sort.length ? { sort: value.sort } : {}),
    ...(value.filters.length ? { filters: value.filters } : {}),
    ...(value.hiddenFieldIds.length ? { hiddenFieldIds: value.hiddenFieldIds } : {})
  });

  async function saveAsView(name: string, value: SortFilter) {
    const { view: saved } = await createView(collectionId, name, configOf(value));
    setViews((items) => [...items, saved]);
    setDialog(null);
    setLocal(null);
    notify(`Saved view “${saved.name}”`);
    go(collectionsRoute(collectionId, { viewId: saved.id }));
  }

  async function updateCurrentView() {
    if (!view || !local) return;
    try {
      const { view: saved } = await updateView(view.id, { config: configOf(local) });
      setViews((items) => items.map((item) => item.id === saved.id ? saved : item));
      setLocal(null);
      notify(`Updated “${saved.name}”`);
    } catch (reason) {
      notify(errorMessage(reason, "Could not update the view"));
    }
  }

  async function removeCollection() {
    setDialog(null);
    try {
      await deleteCollection(collectionId);
      notify("Collection moved to the Bin");
      go(collectionsRoute(), { replace: true });
    } catch (reason) {
      notify(errorMessage(reason, "Could not delete the collection"));
    }
  }

  async function removeCurrentView() {
    if (!view) return;
    setDialog(null);
    try {
      await deleteView(view.id);
      setViews((items) => items.filter((item) => item.id !== view.id));
      notify(`Deleted view “${view.name}”`);
      go(collectionsRoute(collectionId), { replace: true });
    } catch (reason) {
      notify(errorMessage(reason, "Could not delete the view"));
    }
  }

  const findRow = (id: string) => rows.rows.find((row) => row.id === id) ?? detached[id] ?? null;
  // Rows outside the loaded page (a deep link, a filtered-out row) are kept here after an undo.
  const showRow = (row: CollectionRow) => {
    rows.replaceRow(row);
    if (!rows.rows.some((item) => item.id === row.id)) setDetached((items) => ({ ...items, [row.id]: row }));
  };

  function openRow(row: CollectionRow) {
    go(collectionsRoute(collectionId, { rowId: row.id }), { underlyingViewId: viewId });
  }

  async function undo(row: CollectionRow) {
    setDialog(null);
    try {
      showRow((await undoRow(row.id, row.revision)).row);
      notify("Change undone");
    } catch (reason) {
      if (errorCode(reason) === "ROW_CHANGED") {
        const current = errorPayload<{ row?: CollectionRow }>(reason)?.row;
        if (current) showRow(current);
        notify("Someone else changed this row since. Check it before undoing.");
      } else notify(errorMessage(reason, "Could not undo"));
    }
  }

  async function remove(row: CollectionRow) {
    setDialog(null);
    try {
      await deleteRow(row.id);
      rows.removeRow(row.id);
      if (rowId === row.id) onBack();
      notify("Row moved to the Bin");
    } catch (reason) {
      notify(errorMessage(reason, "Could not delete the row"));
    }
  }

  async function copyLink(row: CollectionRow) {
    setDialog(null);
    const url = `${window.location.origin}${formatRoute(collectionsRoute(collectionId, { rowId: row.id }))}`;
    try {
      await navigator.clipboard.writeText(url);
      notify("Link copied");
    } catch {
      notify(url);
    }
  }

  async function add(title: string) {
    const primary = collection?.fields[0];
    if (!primary) return false;
    return Boolean(await rows.create({ [primary.id]: title }));
  }

  if (loadError) return <section className="collection-view"><div className="bin-state bin-error collection-state" role="alert">
    <span className="bin-state-icon"><TriangleAlert /></span>
    <h2>Could not open this collection</h2>
    <p>{loadError}</p>
    <button className="primary-button" onClick={() => { void loadCollection(); }}><RotateCcw />Try again</button>
  </div></section>;
  if (!collection) return <section className="collection-view"><p className="bin-loading collection-state" role="status">Opening collection…</p></section>;

  const dialogRow = dialog && (dialog.kind === "picker" || dialog.kind === "actions") ? findRow(dialog.rowId) : null;
  const pickerField = dialog?.kind === "picker" ? collection.fields.find((field) => field.id === dialog.fieldId) ?? null : null;

  return <section className="collection-view" aria-labelledby="collection-title">
    <header className="collection-header">
      <button className="icon-button" onClick={onBack} aria-label="Back"><ArrowLeft /></button>
      <span className="collection-icon"><CollectionIcon name={collection.icon} /></span>
      <div className="collection-heading">
        <span className="eyebrow">{view ? view.name : collection.is_owner ? "Collection" : `${collection.owner_name}'s collection`}</span>
        <h1 id="collection-title" title={collection.name}>{collection.name}</h1>
      </div>
      <span className="collection-count">{rowCountLabel(rows.total)}</span>
      {!editable && <span className="collection-role role-viewer"><Eye aria-hidden="true" />{roleLabel(role)}</span>}
      {role === "editor" && <span className="collection-role role-editor">{roleLabel(role)}</span>}
      <span className="collection-header-actions collection-data-actions">
        {editable && <button className="icon-button" onClick={() => setDialog({ kind: "import" })} aria-haspopup="dialog" aria-label="Import CSV" title="Import CSV"><Upload /></button>}
        <a className="icon-button" href={exportUrl(collectionId, viewId)} download aria-label="Export CSV" title="Export CSV"><Download /></a>
      </span>
      {canManage && <span className="collection-header-actions">
        <button className="icon-button" onClick={() => setDialog({ kind: "rename" })} aria-haspopup="dialog" aria-label="Rename collection" title="Rename"><Pencil /></button>
        <button className="secondary-button collection-action" onClick={() => setDialog({ kind: "fields" })} aria-haspopup="dialog" aria-label="Fields"><Columns3 /><span>Fields</span></button>
        <button className="secondary-button collection-action" onClick={() => setDialog({ kind: "share" })} aria-haspopup="dialog" aria-label="Share collection"><Share2 /><span>Share</span></button>
        {isOwner && <button className="icon-button" onClick={() => setDialog({ kind: "deleteCollection" })} aria-haspopup="dialog" aria-label="Move collection to the Bin" title="Move to Bin"><Trash2 /></button>}
      </span>}
    </header>

    <div className="collection-toolbar" role="toolbar" aria-label="Rows">
      {views.length > 0 && <>
        <button className={`collection-chip collection-view-chip${viewId ? "" : " active"}`} aria-pressed={!viewId} onClick={() => { if (viewId) go(collectionsRoute(collectionId)); }}>All rows</button>
        {views.map((item) => <button key={item.id} className={`collection-chip collection-view-chip${item.id === viewId ? " active" : ""}`} aria-pressed={item.id === viewId} title={item.name}
          onClick={() => { if (item.id !== viewId) go(collectionsRoute(collectionId, { viewId: item.id })); }}><Bookmark />{item.name}</button>)}
      </>}
      {canManage && view && <>
        <button className="icon-button" onClick={() => setDialog({ kind: "renameView" })} aria-haspopup="dialog" aria-label={`Rename view ${view.name}`} title="Rename view"><Pencil /></button>
        <button className="icon-button" onClick={() => setDialog({ kind: "deleteView" })} aria-haspopup="dialog" aria-label={`Delete view ${view.name}`} title="Delete view"><Trash2 /></button>
      </>}
      <input className="collection-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find rows" aria-label="Find rows" maxLength={200} />
      <button className={`collection-chip${activeCount ? " active" : ""}`} onClick={() => setDialog({ kind: "sortFilter" })} aria-haspopup="dialog"><SlidersHorizontal />{activeCount ? `Sort & filter · ${activeCount}` : "Sort & filter"}</button>
      {local && canManage && view && <button className="collection-chip active" onClick={() => { void updateCurrentView(); }}><Save />Update view</button>}
      {local && <button className="collection-chip" onClick={() => setLocal(null)}><X />{view ? `Reset to ${view.name}` : "Clear"}</button>}
    </div>

    <div className="collection-main">
      {rows.loadError && <div className="bin-state bin-error collection-state" role="alert">
        <h2>Could not load the rows</h2>
        <p>{rows.loadError}</p>
        <button className="primary-button" onClick={() => { void rows.reload(); }}><RotateCcw />Try again</button>
      </div>}
      {!rows.loadError && rows.loading && !rows.rows.length && <p className="bin-loading collection-state" role="status">Loading rows…</p>}
      {!rows.loadError && !(rows.loading && !rows.rows.length) && <div className="collection-body">
        {phone
          ? <CollectionCards fields={fields} rows={rows.rows} editable={editable} conflicts={rows.conflicts} onOpenRow={openRow}
            onRowActions={(row) => setDialog({ kind: "actions", rowId: row.id })} onReloadRow={(row) => rows.acceptConflict(row.id)} onAdd={editable ? add : undefined} />
          : <CollectionTable
            fields={fields}
            rows={rows.rows}
            editable={editable}
            conflicts={rows.conflicts}
            activeRowId={rowId}
            onSave={async (row, values: Record<string, FieldValue | null>) => (await rows.save(row.id, values)) !== null}
            onOpenRow={openRow}
            onRowActions={(row) => setDialog({ kind: "actions", rowId: row.id })}
            onOpenPicker={(row, field) => setDialog({ kind: "picker", rowId: row.id, fieldId: field.id })}
            onReloadRow={(row) => rows.acceptConflict(row.id)}
            onAdd={editable ? add : undefined}
          />}
        {!rows.rows.length && <p className="collection-empty">{q || activeCount ? "No rows match." : editable ? "No rows yet. Add one above." : "No rows yet."}</p>}
        {rows.nextCursor && <button className="secondary-button collection-more" onClick={() => { void rows.loadMore(); }}>Load more ({rows.rows.length} of {rows.total})</button>}
      </div>}

      {rowId && <RowPanel
        key={rowId}
        collection={collection}
        rowId={rowId}
        editable={editable}
        listed={findRow(rowId)}
        conflict={rows.conflicts[rowId] ?? null}
        save={rows.save}
        onAcceptConflict={() => rows.acceptConflict(rowId)}
        onActions={(row) => {
          if (!findRow(row.id)) setDetached((items) => ({ ...items, [row.id]: row }));
          setDialog({ kind: "actions", rowId: row.id });
        }}
        onUndo={(row) => { void undo(row); }}
        onClose={closeRow}
        onMissing={rowMissing}
        renderFiles={(row, field, replace) => <Attachments row={row} field={field} editable={editable} notify={notify} onChanged={(saved) => { replace(saved); rows.replaceRow(saved); }} />}
      />}
    </div>

    {dialog?.kind === "fields" && <FieldEditor collection={collection} onClose={closeDialog} onReload={() => { setDialog(null); void loadCollection(); }} onSaved={(saved) => {
      setDialog(null);
      setCollection(saved);
      notify("Fields saved");
    }} />}
    {dialog?.kind === "rename" && <NameDialog title="Rename collection" eyebrow="Collections" label="Name" initialValue={collection.name} submitLabel="Rename" hint="Up to 120 characters."
      validate={(value) => validateCollectionName(value, collection.name)} onCancel={closeDialog} onSubmit={async (name) => {
        const { collection: saved } = await renameCollection(collection.id, name);
        setCollection(saved);
        setDialog(null);
      }} />}
    {dialog?.kind === "import" && <ImportDialog collection={collection} onClose={closeDialog} onImported={(count) => {
      setDialog(null);
      notify(`Imported ${rowCountLabel(count)}`);
      void rows.reload();
    }} />}
    {dialog?.kind === "share" && <AccessSheet kind="collection" id={collection.id} title={collection.name} onClose={closeDialog} onSaved={() => {
      setDialog(null);
      notify("Access updated");
      void loadCollection();
    }} />}
    {dialog?.kind === "sortFilter" && <SortFilterSheet fields={collection.fields} value={effective} onClose={closeDialog} onApply={(next) => {
      setDialog(null);
      setLocal(next);
    }} onSaveAsView={canManage ? (next) => setDialog({ kind: "saveView", value: next }) : undefined} />}
    {dialog?.kind === "saveView" && <NameDialog title="Save as view" eyebrow={collection.name} label="View name" initialValue="" submitLabel="Save view" hint="Up to 60 characters. Everyone with access can use it."
      validate={(value) => validateName(value, 60)} onCancel={closeDialog} onSubmit={(name) => saveAsView(name, dialog.value)} />}
    {dialog?.kind === "renameView" && view && <NameDialog title="Rename view" eyebrow={collection.name} label="View name" initialValue={view.name} submitLabel="Rename" hint="Up to 60 characters."
      validate={(value) => validateName(value, 60, view.name)} onCancel={closeDialog} onSubmit={async (name) => {
        const { view: saved } = await updateView(view.id, { name });
        setViews((items) => items.map((item) => item.id === saved.id ? saved : item));
        setDialog(null);
      }} />}
    {dialog?.kind === "deleteView" && view && <ConfirmDialog title="Delete view" message={`Delete the view “${view.name}”? Rows are not affected.`} confirmLabel="Delete view" danger onCancel={closeDialog} onConfirm={() => { void removeCurrentView(); }} />}
    {dialog?.kind === "deleteCollection" && <ConfirmDialog title="Move to Bin" message={collectionBinMessage(collection)} confirmLabel="Move to Bin" danger onCancel={closeDialog} onConfirm={() => { void removeCollection(); }} />}
    {dialog?.kind === "picker" && dialogRow && pickerField && <OptionPicker field={pickerField} selected={Array.isArray(dialogRow.values[pickerField.id]) ? dialogRow.values[pickerField.id] as string[] : []}
      onClose={closeDialog} onSave={async (ids) => (await rows.save(dialogRow.id, { [pickerField.id]: ids.length ? ids : null })) !== null} />}
    {dialog?.kind === "actions" && dialogRow && <RowActionSheet row={dialogRow} editable={editable} onClose={closeDialog}
      onUndo={() => { void undo(dialogRow); }} onDelete={() => { void remove(dialogRow); }} onCopyLink={() => { void copyLink(dialogRow); }} />}
  </section>;
}
