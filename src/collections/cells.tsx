import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { CollectionRow, FieldDefinition, FieldValue } from "./collectionsApi";
import { displayValue, inputText, optionById, parseInput } from "./values";
import { Select } from "../ui/Select";
import { FileThumb, firstImage } from "./Attachments";

export type SaveValues = (values: Record<string, FieldValue | null>) => Promise<boolean>;

type CellProps = {
  field: FieldDefinition;
  row: CollectionRow;
  editable: boolean;
  onSave: SaveValues;
  /** Multi-select, note, and file fields are edited in a picker or the row panel. */
  onOpenPicker: (field: FieldDefinition) => void;
  /** Mobile row panel editors are taller (≥ 44 px) and labelled. */
  variant?: "table" | "panel";
  labelId?: string;
};

/**
 * One value editor. Text-like inputs save on blur (Enter blurs, Escape reverts); checkboxes and
 * selects save on change (a select opens with Enter; Escape closes it and keeps focus on the cell). The caller sends the change with the row's revision (CAS).
 */
export function CellEditor({ field, row, editable, onSave, onOpenPicker, variant = "table", labelId }: CellProps) {
  const value = row.values[field.id];
  const shown = displayValue(field, row);
  if (!editable) {
    if (field.type === "file") return <span className="cell-readonly cell-file" title={shown || undefined}><FileCellContent field={field} row={row} shown={shown} empty={<span className="cell-empty" aria-label="Empty">—</span>} /></span>;
    return <span className={`cell-readonly cell-${field.type}`} title={shown || undefined}>{field.type === "select" && typeof value === "string" ? <OptionChip field={field} id={value} /> : field.type === "multi_select" && Array.isArray(value) ? <OptionChips field={field} ids={value} /> : shown || <span className="cell-empty" aria-label="Empty">—</span>}</span>;
  }
  switch (field.type) {
    case "checkbox": {
      const box = <input type="checkbox" id={variant === "panel" && labelId ? checkboxInputId(labelId) : undefined} className="cell-checkbox" aria-labelledby={labelId} aria-label={labelId ? undefined : field.name} checked={value === true} onChange={(event) => { void onSave({ [field.id]: event.target.checked }); }} />;
      // The row panel wraps it in a 44 px label, so the whole line toggles it on a phone.
      return variant === "panel" ? <label className="cell-checkbox-target">{box}<span aria-hidden="true">{value === true ? "Yes" : "No"}</span></label> : box;
    }
    case "select": {
      // "Clear" replaces the native select's empty "—" option; it is offered only when a value is set.
      const current = typeof value === "string" && value ? value : null;
      return <Select variant={variant === "panel" ? "field" : "cell"} className="cell-select" labelledBy={labelId} label={field.name} value={current} placeholder="—"
        options={[...(current ? [{ value: "", label: "Clear" }] : []), ...(field.options ?? []).map((option) => ({ value: option.id, label: option.label, swatch: option.color }))]}
        onChange={(next) => { void onSave({ [field.id]: next || null }); }} />;
    }
    case "multi_select":
    case "note":
    case "file":
      return <button type="button" className={`cell-picker cell-${field.type}`} aria-labelledby={labelId} aria-haspopup="dialog" onClick={() => onOpenPicker(field)} title={shown || undefined}>
        {field.type === "multi_select" && Array.isArray(value) && value.length ? <OptionChips field={field} ids={value} />
          : field.type === "file" ? <FileCellContent field={field} row={row} shown={shown} empty={<span className="cell-empty">{variant === "panel" ? pickerPrompt(field) : "—"}</span>} />
          : shown || <span className="cell-empty">{variant === "panel" ? pickerPrompt(field) : "—"}</span>}
      </button>;
    case "text":
      // A single-line input would drop line breaks, so multi-line text is edited in the row panel.
      if (variant === "table" && typeof value === "string" && value.includes("\n")) {
        return <button type="button" className="cell-picker cell-text" onClick={() => onOpenPicker(field)} title={value}>{value.split("\n")[0]}…</button>;
      }
      return <TextCell field={field} value={value} onSave={onSave} variant={variant} labelId={labelId} />;
    default:
      return <TextCell field={field} value={value} onSave={onSave} variant={variant} labelId={labelId} />;
  }
}

/** A file cell: the first image's thumbnail (U3, D399), then the name or "N files". */
function FileCellContent({ field, row, shown, empty }: { field: FieldDefinition; row: CollectionRow; shown: string; empty: ReactNode }) {
  if (!shown) return <>{empty}</>;
  const image = firstImage(row, field);
  return <span className="cell-file-content">{image && <FileThumb file={image} className="file-thumb cell-file-thumb" />}<span className="cell-file-name">{shown}</span></span>;
}

/** The row panel's checkbox id, so the field's own label can toggle it too. */
export const checkboxInputId = (labelId: string) => `${labelId}-input`;

const pickerPrompt = (field: FieldDefinition) => field.type === "multi_select" ? "Choose options" : field.type === "note" ? "Link a note" : "Attach files";

function TextCell({ field, value, onSave, variant, labelId }: { field: FieldDefinition; value: FieldValue | undefined; onSave: SaveValues; variant: "table" | "panel"; labelId?: string }) {
  const original = inputText(field, value);
  const [draft, setDraft] = useState(original);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const editingRef = useRef(false);
  // Follow the stored value (a save, a reload, or an undo) unless the user is typing.
  useEffect(() => { if (!editingRef.current) setDraft(original); }, [original]);

  async function commit() {
    editingRef.current = false;
    if (draft === original) {
      setError(null);
      return;
    }
    const parsed = parseInput(field, draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    const saved = await onSave({ [field.id]: parsed.value });
    if (!saved) setDraft(original);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDraft(original);
      setError(null);
      editingRef.current = false;
      event.currentTarget.blur();
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing && (event.currentTarget.tagName === "INPUT" || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  const common = {
    className: `cell-input cell-${field.type}${error ? " invalid" : ""}`,
    value: draft,
    "aria-labelledby": labelId,
    "aria-label": labelId ? undefined : field.name,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? errorId : undefined,
    onFocus: () => { editingRef.current = true; },
    onChange: (event: { target: { value: string } }) => { editingRef.current = true; setDraft(event.target.value); setError(null); },
    onBlur: () => { void commit(); },
    onKeyDown
  };
  const input = variant === "panel" && field.type === "text"
    ? <textarea {...common} rows={Math.min(8, Math.max(2, draft.split("\n").length))} maxLength={4000} />
    : <input {...common} type={field.type === "date" ? "date" : field.type === "url" ? "url" : "text"} inputMode={field.type === "number" ? "decimal" : undefined} maxLength={field.type === "url" ? 2048 : 4000} placeholder={variant === "panel" ? field.type === "url" ? "https://" : field.number?.unit ?? "" : undefined} />;
  // The message is shown under the input in both layouts, not only as a red border.
  const message = error && <span id={errorId} className={variant === "panel" ? "file-dialog-error" : "file-dialog-error cell-error"} role="alert">{error}</span>;
  return message ? <>{input}{message}</> : input;
}

export function OptionChip({ field, id }: { field: FieldDefinition; id: string }) {
  const option = optionById(field, id);
  if (!option) return null;
  return <span className={`option-chip color-${option.color}`}>{option.label}</span>;
}

export function OptionChips({ field, ids }: { field: FieldDefinition; ids: string[] }) {
  return <span className="option-chips">{ids.map((id) => <OptionChip key={id} field={field} id={id} />)}</span>;
}
