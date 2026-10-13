import { useEffect, useMemo, useState } from "react";
import { Check, NotebookText } from "lucide-react";
import { api } from "../api";
import { ModalDialog } from "../files/Dialog";
import type { NoteSummary } from "../types";
import type { FieldDefinition } from "./collectionsApi";
import { FormError } from "../ui/FormError";

type NotePickerProps = {
  field: FieldDefinition;
  selected: string | null;
  onSave: (noteId: string | null) => Promise<boolean>;
  onClose: () => void;
};

// Links a note the caller can read (the server re-checks at write time). Linking never shares the
// note: other readers of the collection see its title only if they can read it too (D58, T59).
export function NotePicker({ field, selected, onSave, onClose }: NotePickerProps) {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api<{ notes: NoteSummary[] }>("/notes").then((result) => { if (active) setNotes(result.notes); }).catch(() => { if (active) setError("Could not load your notes"); });
    return () => { active = false; };
  }, []);

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return (notes ?? []).filter((note) => note.current_version > 0 || note.is_owner).filter((note) => !term || note.title.toLowerCase().includes(term)).slice(0, 100);
  }, [filter, notes]);

  async function choose(noteId: string | null) {
    setBusy(true);
    if (await onSave(noteId)) onClose();
    else setBusy(false);
  }

  return <ModalDialog title={field.name} eyebrow="Link a note" onClose={onClose} variant="sheet" busy={busy}>
    <div className="file-dialog-form">
      <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter notes by title" aria-label="Filter notes" autoFocus disabled={busy} />
    </div>
    <div className="move-list" role="listbox" aria-label="Notes">
      {notes === null && !error && <p className="bin-loading" role="status">Loading notes…</p>}
      {visible.map((note) => <button key={note.id} role="option" aria-selected={note.id === selected} className={`move-option${note.id === selected ? " active" : ""}`} disabled={busy} onClick={() => { void choose(note.id); }}>
        <NotebookText aria-hidden="true" />
        <span>{note.title || "Untitled note"}{note.is_owner ? null : <small>{note.owner_name}</small>}</span>
        {note.id === selected ? <Check aria-hidden="true" /> : <span aria-hidden="true" />}
      </button>)}
      {notes && !visible.length && <p className="empty-copy">No matching notes.</p>}
    </div>
    <FormError message={error} className="file-dialog-error" />
    <footer className="file-dialog-actions">
      {selected && <button className="secondary-button" onClick={() => { void choose(null); }} disabled={busy}>Remove link</button>}
      <button className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
    </footer>
  </ModalDialog>;
}
