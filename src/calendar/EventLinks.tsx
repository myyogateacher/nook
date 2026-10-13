import { useEffect, useState } from "react";
import { KanbanSquare, Link2, Lock, NotebookText, Plus, Table2, X } from "lucide-react";
import { api } from "../api";
import { ModalDialog } from "../files/Dialog";
import type { NoteSummary } from "../types";
import type { EventLink, EventResponse } from "./calendarApi";
import { FormError } from "../ui/FormError";

const typeLabels: Record<EventLink["targetType"], string> = { note: "Note", card: "Task", collection_row: "Collection item" };
const typeIcons = { note: NotebookText, card: KanbanSquare, collection_row: Table2 } as const;

/** The text a link shows: its title when the viewer can read the target, never more (T59). */
export function linkLabel(link: EventLink) {
  if (link.restricted || link.title === null) return `${typeLabels[link.targetType]} you can't open`;
  return link.title;
}

type EventLinksProps = {
  data: EventResponse;
  canEdit: boolean;
  onOpenNote: (noteId: string) => void;
  onAddNote: () => void;
  onRemove: (link: EventLink) => void;
};

/** What the event links to. Note links open the note; other types, and anything unreadable, stay restricted. */
export function EventLinks({ data, canEdit, onOpenNote, onAddNote, onRemove }: EventLinksProps) {
  if (!data.links.length && !canEdit) return null;
  return <section className="calendar-event-section" aria-labelledby="calendar-links-title">
    <h2 id="calendar-links-title"><Link2 />Linked</h2>
    {!data.links.length && <p className="calendar-note">Link notes this event needs, such as an agenda or a packing list.</p>}
    <ul className="calendar-links">
      {data.links.map((link) => {
        const Icon = link.restricted ? Lock : typeIcons[link.targetType];
        const label = linkLabel(link);
        const openable = !link.restricted && link.targetType === "note";
        return <li key={`${link.targetType}:${link.targetId}`} className={link.restricted ? "restricted" : undefined}>
          {openable
            ? <button className="calendar-link" onClick={() => onOpenNote(link.targetId)}><Icon aria-hidden="true" /><span><strong>{label}</strong><small>{typeLabels[link.targetType]}</small></span></button>
            : <span className="calendar-link"><Icon aria-hidden="true" /><span><strong>{label}</strong><small>{link.restricted ? "Restricted" : typeLabels[link.targetType]}</small></span></span>}
          {canEdit && <button className="icon-button" onClick={() => onRemove(link)} aria-label={`Remove link to ${label}`}><X /></button>}
        </li>;
      })}
    </ul>
    {canEdit && <button className="secondary-button calendar-link-add" onClick={onAddNote}><Plus />Link a note</button>}
  </section>;
}

type NotePickerProps = {
  linkedIds: string[];
  onPick: (note: NoteSummary) => Promise<void>;
  onClose: () => void;
};

/** Pick a note to link. Lists the notes the caller can read (GET /api/notes); pushes no history entry. */
export function NoteLinkPicker({ linkedIds, onPick, onClose }: NotePickerProps) {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api<{ notes: NoteSummary[] }>("/notes").then((result) => { if (active) setNotes(result.notes); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Could not load your notes"); });
    return () => { active = false; };
  }, []);

  const needle = query.trim().toLowerCase();
  const visible = (notes ?? []).filter((note) => !linkedIds.includes(note.id) && (!needle || note.title.toLowerCase().includes(needle))).slice(0, 50);

  async function pick(note: NoteSummary) {
    setBusy(true);
    setError(null);
    try {
      await onPick(note);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not link the note");
      setBusy(false);
    }
  }

  return <ModalDialog title="Link a note" eyebrow="Event" onClose={onClose} variant="sheet" busy={busy}>
    <div className="calendar-form file-dialog-body">
      <label className="calendar-field"><span>Find</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Note title" autoFocus /></label>
    </div>
    <div className="move-list" role="list" aria-label="Notes">
      {notes === null && !error && <p className="file-dialog-copy">Loading notes…</p>}
      {notes !== null && !visible.length && <p className="file-dialog-copy">{needle ? "No notes match." : "No notes to link."}</p>}
      {visible.map((note) => <button key={note.id} role="listitem" className="move-option" disabled={busy} onClick={() => { void pick(note); }}>
        <NotebookText aria-hidden="true" />
        <span>{note.title || "Untitled"}{note.is_owner ? null : <small>{note.owner_name}</small>}</span>
      </button>)}
    </div>
    <FormError message={error} className="file-dialog-error" />
  </ModalDialog>;
}
