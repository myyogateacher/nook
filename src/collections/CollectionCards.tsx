import { useEffect, useState, type FormEvent } from "react";
import { Ellipsis, Plus, RotateCcw } from "lucide-react";
import type { CollectionRow, FieldDefinition } from "./collectionsApi";
import { cardFields, displayValue, rowTitle, submitOnEnter } from "./values";
import { FileThumb, firstImage } from "./Attachments";

/** The phone card's cover: the first image in the row's file fields, in field order (U3, D399). */
export function coverImage(fields: FieldDefinition[], row: CollectionRow) {
  for (const field of fields) {
    if (field.type !== "file") continue;
    const image = firstImage(row, field);
    if (image) return image;
  }
  return null;
}

/** True at phone widths (the 760 px breakpoint used everywhere), following resizes. */
export function useIsPhone() {
  const query = "(max-width: 760px)";
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return phone;
}

type CollectionCardsProps = {
  fields: FieldDefinition[];
  rows: CollectionRow[];
  editable: boolean;
  conflicts: Record<string, CollectionRow>;
  onOpenRow: (row: CollectionRow) => void;
  onRowActions: (row: CollectionRow) => void;
  onReloadRow: (row: CollectionRow) => void;
  onAdd?: (title: string) => Promise<boolean>;
};

// The phone list: one 56 px card per row with the primary field and up to three more fields that
// have values. Tapping a card opens the full-screen row panel (a history entry).
export function CollectionCards({ fields, rows, editable, conflicts, onOpenRow, onRowActions, onReloadRow, onAdd }: CollectionCardsProps) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!onAdd || !draft.trim() || adding) return;
    setAdding(true);
    if (await onAdd(draft)) setDraft("");
    setAdding(false);
  }

  return <>
    {editable && onAdd && fields[0] && <form className="collection-quick-add collection-card-add" onSubmit={(event) => { void add(event); }} noValidate>
      <Plus aria-hidden="true" />
      <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`New row: ${fields[0].name}`} aria-label={`New row ${fields[0].name}`} maxLength={4000} onKeyDown={submitOnEnter} readOnly={adding} aria-busy={adding || undefined} />
      <button className="secondary-button" type="submit" disabled={adding || !draft.trim()}>{adding ? "Adding…" : "Add"}</button>
    </form>}
    <ul className="collection-cards" aria-label="Rows">
      {rows.map((row) => {
        const extras = cardFields(fields, row);
        const title = rowTitle(row);
        const cover = coverImage(fields, row);
        return <li key={row.id} className={`collection-card${conflicts[row.id] ? " row-conflict" : ""}${cover ? " has-cover" : ""}`}>
          {cover && <FileThumb file={cover} className="file-thumb collection-card-cover" />}
          <button className="collection-card-open" onClick={() => onOpenRow(row)}>
            <span className="collection-card-title">{title}</span>
            {extras.length > 0 && <span className="collection-card-fields">
              {extras.map((field) => <span key={field.id} className="collection-card-field"><span className="sr-only">{field.name}: </span>{displayValue(field, row)}</span>)}
            </span>}
          </button>
          {conflicts[row.id]
            ? <button className="icon-button" onClick={() => onReloadRow(row)} aria-label={`Reload ${title}`}><RotateCcw /></button>
            : <button className="icon-button" onClick={() => onRowActions(row)} aria-haspopup="dialog" aria-label={`Actions for ${title}`}><Ellipsis /></button>}
        </li>;
      })}
    </ul>
  </>;
}
