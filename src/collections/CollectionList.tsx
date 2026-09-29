import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, RotateCcw, Search, Share2, Table2, Trash2, TriangleAlert, Users } from "lucide-react";
import { ConfirmDialog } from "../files/Dialog";
import { relativeTime } from "../files/format";
import { NameDialog } from "../files/RenameDialog";
import { deleteCollection, errorMessage, listCollections, renameCollection, searchRows, type CollectionDetail, type CollectionSummary, type RowSearchHit, type Segment } from "./collectionsApi";
import { readCollectionsSearch, withCollectionsSearch } from "../collectionsRoute";
import { useDialogLayer } from "./dialogLayers";
import { CollectionIcon } from "./icons";
import { AccessSheet } from "../access/AccessSheet";
import { NewCollectionDialog } from "./NewCollectionDialog";
import { collectionBinMessage, ownerSharingLabel, roleLabel, rowCountLabel, validateCollectionName } from "./values";
import { useRole } from "../team/roleAccess";

type CollectionListProps = {
  userId?: string;
  onOpen: (collection: Pick<CollectionSummary, "id">) => void;
  onOpenRow: (collectionId: string, rowId: string) => void;
  notify: (message: string) => void;
  /** Opens a new collection straight into the CSV import (stage D). */
  onCreatedForImport?: (collection: CollectionDetail) => void;
};

type RowAction = "rename" | "share" | "delete";
type ListDialog = { kind: "new" } | { kind: RowAction; collectionId: string };

type CollectionListRowProps = {
  collection: CollectionSummary;
  onOpen: (collection: CollectionSummary) => void;
  onAction: (kind: RowAction, collection: CollectionSummary) => void;
};

/** One collection in the list. Owners get Rename, Share, and Move to Bin, as on the Tasks board list. */
export function CollectionListRow({ collection, onOpen, onAction }: CollectionListRowProps) {
  const { canWrite } = useRole();
  return <li className="collection-row">
    <button className="collection-open" onClick={() => onOpen(collection)}>
      <span className="collection-icon"><CollectionIcon name={collection.icon} /></span>
      <span className="collection-copy">
        <span className="collection-name" title={collection.name}>{collection.name}</span>
        <span className="collection-meta">
          <span>{rowCountLabel(collection.row_count)}</span>
          <time dateTime={collection.updated_at}>Updated {relativeTime(collection.updated_at)}</time>
          {collection.is_owner === 0
            ? <><span className="owner-badge">{collection.owner_name}</span><span className={`collection-role role-${collection.role}`}>{roleLabel(collection.role, collection.level)}</span></>
            : collection.visibility !== "private" && <span className="collection-shared"><Users aria-hidden="true" />{ownerSharingLabel(collection.visibility, collection.share_role)}</span>}
        </span>
      </span>
    </button>
    {collection.is_owner === 1 && canWrite && <span className="collection-list-actions">
      <button className="icon-button" onClick={() => onAction("rename", collection)} aria-haspopup="dialog" aria-label={`Rename ${collection.name}`} title="Rename"><Pencil /></button>
      <button className="icon-button" onClick={() => onAction("share", collection)} aria-haspopup="dialog" aria-label={`Share ${collection.name}`} title="Share"><Share2 /></button>
      <button className="icon-button" onClick={() => onAction("delete", collection)} aria-haspopup="dialog" aria-label={`Delete ${collection.name}`} title="Move to the Bin"><Trash2 /></button>
    </span>}
  </li>;
}

/** Plain-text segments from the search API; hits are marked, nothing is parsed as HTML. */
function Segments({ segments, fallback = "" }: { segments: Segment[]; fallback?: string }) {
  if (!segments.some((segment) => segment.text.trim())) return <>{fallback}</>;
  return <>{segments.map((segment, index) => segment.hit ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>)}</>;
}

export function CollectionList({ userId = "", onOpen, onOpenRow, notify, onCreatedForImport }: CollectionListProps) {
  const [collections, setCollections] = useState<CollectionSummary[] | null>(null);
  const { canWrite } = useRole();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ListDialog | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState(() => typeof window === "undefined" ? "" : readCollectionsSearch(window.history.state, userId));
  const [hits, setHits] = useState<RowSearchHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Row search: from 2 characters, debounced, the newest request wins. The query rides in the
  // list entry's history state so Back from a result shows the results again.
  useEffect(() => {
    const term = query.trim();
    window.history.replaceState(withCollectionsSearch(userId, query, window.history.state), "", window.location.pathname);
    if (term.length < 2) {
      setHits(null);
      setSearchError(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchRows(term, controller.signal).then((result) => { setHits(result.results); setSearchError(null); }).catch((reason) => {
        if (!controller.signal.aborted) setSearchError(errorMessage(reason, "Search failed"));
      });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, userId]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setCollections((await listCollections()).collections);
    } catch (reason) {
      setLoadError(errorMessage(reason, "Could not load your collections"));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const closeDialog = useCallback(() => setDialog(null), []);
  useDialogLayer(dialog !== null, closeDialog);

  const all = collections ?? [];
  const owned = all.filter((collection) => collection.is_owner === 1);
  const shared = all.filter((collection) => collection.is_owner !== 1);
  const dialogCollection = dialog && dialog.kind !== "new" ? all.find((collection) => collection.id === dialog.collectionId) ?? null : null;

  async function rename(collection: CollectionSummary, name: string) {
    const { collection: saved } = await renameCollection(collection.id, name);
    setCollections((current) => current?.map((item) => item.id === saved.id ? { ...item, ...saved } : item) ?? current);
    setDialog(null);
    notify(`Renamed to “${saved.name}”`);
  }

  async function remove(collection: CollectionSummary) {
    setDeleting(true);
    try {
      await deleteCollection(collection.id);
      setCollections((current) => current?.filter((item) => item.id !== collection.id) ?? current);
      setDialog(null);
      notify(`Moved “${collection.name}” to the Bin`);
    } catch (reason) {
      setDialog(null);
      notify(errorMessage(reason, "Could not delete the collection"));
      void load();
    } finally {
      setDeleting(false);
    }
  }

  const onAction = (kind: RowAction, collection: CollectionSummary) => setDialog({ kind, collectionId: collection.id });
  const row = (collection: CollectionSummary) => <CollectionListRow key={collection.id} collection={collection} onOpen={onOpen} onAction={onAction} />;

  return <section className="collections-content" aria-labelledby="collections-title">
    <div className="collections-intro">
      <div>
        <span className="eyebrow">Typed tables</span>
        <h1 id="collections-title">Collections</h1>
        <p>Track anything in typed tables: inventories, subscriptions, recipes, contacts. Share them view-only or let people edit rows.</p>
      </div>
      {canWrite && <button className="primary-button collections-new-button" onClick={() => setDialog({ kind: "new" })} aria-haspopup="dialog"><Plus />New collection</button>}
    </div>

    {all.length > 0 && <div className="collections-search">
      <Search aria-hidden="true" />
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search rows in all collections" aria-label="Search rows in all collections" maxLength={200} />
    </div>}
    {query.trim().length >= 2 && <section className="collections-results" aria-label="Matching rows" aria-live="polite">
      {searchError && <p className="file-dialog-error" role="alert">{searchError}</p>}
      {!searchError && hits === null && <p className="bin-loading" role="status">Searching…</p>}
      {!searchError && hits?.length === 0 && <p className="collection-empty">No rows match “{query.trim()}”.</p>}
      {hits && hits.length > 0 && <ul className="collection-list">
        {hits.map((hit) => <li key={hit.rowId} className="collection-row">
          <button className="collection-open collection-hit" onClick={() => onOpenRow(hit.collectionId, hit.rowId)}>
            <span className="collection-copy">
              <span className="collection-name"><Segments segments={hit.title} fallback="Untitled" /></span>
              <span className="collection-meta"><span className="owner-badge">{hit.collectionName}</span>{hit.snippet.length > 0 && <span className="collection-snippet"><Segments segments={hit.snippet} /></span>}</span>
            </span>
          </button>
        </li>)}
      </ul>}
    </section>}

    {loadError && <div className="bin-state bin-error" role="alert">
      <span className="bin-state-icon"><TriangleAlert /></span>
      <h2>Could not load your collections</h2>
      <p>{loadError}</p>
      <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
    </div>}
    {!loadError && !collections && <p className="bin-loading" role="status">Loading collections…</p>}
    {!loadError && collections && !all.length && <div className="bin-state">
      <span className="bin-state-icon"><Table2 /></span>
      <h2>No collections yet</h2>
      <p>{canWrite ? "Start from a template such as Home inventory or Recipes, or from a blank table." : "Collections shared with you appear here."}</p>
      {canWrite && <button className="primary-button" onClick={() => setDialog({ kind: "new" })}><Plus />New collection</button>}
    </div>}
    {owned.length > 0 && <><h2 className="collections-section-label">Your collections</h2><ul className="collection-list" aria-label="Your collections">{owned.map(row)}</ul></>}
    {shared.length > 0 && <><h2 className="collections-section-label">Shared with you</h2><ul className="collection-list" aria-label="Collections shared with you">{shared.map(row)}</ul></>}

    {dialog?.kind === "new" && <NewCollectionDialog
      onCancel={closeDialog}
      onCreated={(collection) => {
        setDialog(null);
        notify(`Created “${collection.name}”`);
        onOpen(collection);
      }}
      onImport={onCreatedForImport ? (collection) => { setDialog(null); onCreatedForImport(collection); } : undefined}
    />}
    {dialog?.kind === "rename" && dialogCollection && <NameDialog title="Rename collection" eyebrow="Collections" label="Name" initialValue={dialogCollection.name} submitLabel="Rename" hint="Up to 120 characters."
      validate={(value) => validateCollectionName(value, dialogCollection.name)} onSubmit={(name) => rename(dialogCollection, name)} onCancel={closeDialog} />}
    {dialog?.kind === "delete" && dialogCollection && <ConfirmDialog title="Move to the Bin?" message={collectionBinMessage(dialogCollection)} confirmLabel="Move to Bin" danger busy={deleting} onConfirm={() => { void remove(dialogCollection); }} onCancel={closeDialog} />}
    {dialog?.kind === "share" && dialogCollection && <AccessSheet kind="collection" id={dialogCollection.id} title={dialogCollection.name} onClose={closeDialog} onSaved={() => {
      setDialog(null);
      notify("Access updated");
      void load();
    }} />}
  </section>;
}
