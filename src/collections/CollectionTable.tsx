import { useState, type FormEvent } from "react";
import { Ellipsis, Maximize2, Plus, RotateCcw } from "lucide-react";
import type { CollectionRow, FieldDefinition, FieldValue } from "./collectionsApi";
import { CellEditor } from "./cells";
import { FieldIcon } from "./icons";
import { rowTitle, submitOnEnter } from "./values";

type CollectionTableProps = {
  fields: FieldDefinition[];
  rows: CollectionRow[];
  editable: boolean;
  conflicts: Record<string, CollectionRow>;
  activeRowId: string | null;
  onSave: (row: CollectionRow, values: Record<string, FieldValue | null>) => Promise<boolean>;
  onOpenRow: (row: CollectionRow) => void;
  onRowActions: (row: CollectionRow, trigger: HTMLElement) => void;
  onOpenPicker: (row: CollectionRow, field: FieldDefinition) => void;
  onReloadRow: (row: CollectionRow) => void;
  onAdd?: (title: string) => Promise<boolean>;
};

// The desktop table: one column per visible field. Cells save on blur (CAS on the row's revision);
// a row another user changed shows a Reload action instead of overwriting their change.
export function CollectionTable({ fields, rows, editable, conflicts, activeRowId, onSave, onOpenRow, onRowActions, onOpenPicker, onReloadRow, onAdd }: CollectionTableProps) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const primary = fields[0];

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!onAdd || !draft.trim() || adding) return;
    setAdding(true);
    if (await onAdd(draft)) setDraft("");
    setAdding(false);
  }

  return <div className="collection-table-wrap">
    <table className="collection-table">
      <thead>
        <tr>
          <th className="collection-table-lead" scope="col"><span className="sr-only">Row</span></th>
          {fields.map((field) => <th key={field.id} scope="col" className={`col-${field.type}`}><span className="collection-th"><FieldIcon type={field.type} />{field.name}</span></th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const conflict = conflicts[row.id];
          return <tr key={row.id} className={`${conflict ? "row-conflict" : ""}${activeRowId === row.id ? " row-active" : ""}`}>
            <td className="collection-table-lead">
              <span className="collection-row-actions">
                <button className="icon-button" onClick={() => onOpenRow(row)} aria-label={`Open ${rowTitle(row)}`} title="Open row"><Maximize2 /></button>
                <button className="icon-button" onClick={(event) => onRowActions(row, event.currentTarget)} aria-haspopup="dialog" aria-label={`Actions for ${rowTitle(row)}`} title="Row actions"><Ellipsis /></button>
                {conflict && <button className="collection-reload" onClick={() => onReloadRow(row)} title="Someone else changed this row"><RotateCcw />Reload</button>}
              </span>
            </td>
            {fields.map((field) => <td key={field.id} className={`col-${field.type}`}>
              <CellEditor field={field} row={row} editable={editable && !conflict} onSave={(values) => onSave(row, values)} onOpenPicker={(target) => target.type === "text" || target.type === "note" || target.type === "file" ? onOpenRow(row) : onOpenPicker(row, target)} />
            </td>)}
          </tr>;
        })}
      </tbody>
    </table>
    {editable && onAdd && primary && <form className="collection-quick-add" onSubmit={(event) => { void add(event); }} noValidate>
      <Plus aria-hidden="true" />
      <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`New row: ${primary.name}`} aria-label={`New row ${primary.name}`} maxLength={4000} onKeyDown={submitOnEnter} readOnly={adding} aria-busy={adding || undefined} />
      <button className="secondary-button" type="submit" disabled={adding || !draft.trim()}>{adding ? "Adding…" : "Add row"}</button>
    </form>}
  </div>;
}
