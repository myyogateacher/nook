import { useState } from "react";
import { Eye, EyeOff, Pencil, Plus, Rss, Share2, Trash2 } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import type { CalendarColor, CalendarSummary } from "./calendarApi";
import { CALENDAR_COLORS } from "./calendarFormat";
import { Select } from "../ui/Select";
import { useRole } from "../team/roleAccess";
import { MuteEmailsButton, useEmailMutes } from "../notifications/emailMutes";

const colourOptions = CALENDAR_COLORS.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1), swatch: value }));

type CalendarsDialogProps = {
  calendars: CalendarSummary[];
  hidden: Set<string>;
  busy: boolean;
  onToggle: (calendar: CalendarSummary) => void;
  onCreate: (name: string, color: CalendarColor) => Promise<void>;
  onUpdate: (calendar: CalendarSummary, patch: { name?: string; color?: CalendarColor }) => Promise<void>;
  onShare: (calendar: CalendarSummary) => void;
  /** Subscribe links (any reader). */
  onFeeds: (calendar: CalendarSummary) => void;
  onDelete: (calendar: CalendarSummary) => void;
  onClose: () => void;
  showTasks: boolean;
  onToggleTasks: () => void;
};

// The owner's line: the everyone-signed-in level only for that audience; chosen people and groups
// each have their own level (a manager among them), so it claims none for them (QA v0.13.0 B6).
const roleLabel = (calendar: CalendarSummary) => calendar.role === "owner"
  ? calendar.visibility === "private" ? "Private" : calendar.visibility === "all_users"
    ? calendar.share_role === "editor" ? "Shared with everyone · others can edit" : "Shared with everyone · others can view"
    : "Shared with people you chose"
  : `${calendar.owner_name} · ${calendar.level === "manage" ? "you manage it" : calendar.role === "editor" ? "you can edit" : "view only"}`;

/** Show or hide calendars, and (for owners) rename, recolour, share, or bin them. Pushes no history entry. */
export function CalendarsDialog({ calendars, hidden, busy, onToggle, onCreate, onUpdate, onShare, onFeeds, onDelete, onClose, showTasks, onToggleTasks }: CalendarsDialogProps) {
  // Read-only Team roles manage no calendars and create no feed links (O5).
  const { canWrite } = useRole();
  const [name, setName] = useState("");
  const [color, setColor] = useState<CalendarColor>("green");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const owned = calendars.filter((calendar) => calendar.is_owner);
  // Mute emails per calendar (D249): anyone who can read it, for event-change mail about it.
  const mutes = useEmailMutes();

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) return setError("Name the calendar");
    setError(null);
    try {
      await onCreate(trimmed, color);
      setName("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the calendar");
    }
  }

  async function rename(calendar: CalendarSummary) {
    const trimmed = draft.trim();
    setEditing(null);
    if (!trimmed || trimmed === calendar.name) return;
    try {
      await onUpdate(calendar, { name: trimmed });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not rename the calendar");
    }
  }

  return <ModalDialog title="Calendars" eyebrow="Calendar" onClose={onClose} variant="sheet" busy={busy}>
    <ul className="calendar-list" aria-label="Your calendars">
      {calendars.map((calendar) => {
        const shown = !hidden.has(calendar.id);
        return <li key={calendar.id} className="calendar-list-row">
          <button className="icon-button calendar-visibility" onClick={() => onToggle(calendar)} aria-pressed={shown} aria-label={`${shown ? "Hide" : "Show"} ${calendar.name}`}>
            {shown ? <Eye /> : <EyeOff />}
          </button>
          <span className={`calendar-dot large color-${calendar.color}`} aria-hidden="true" />
          <span className="calendar-list-copy">
            {editing === calendar.id
              ? <input value={draft} maxLength={80} autoFocus aria-label="Calendar name" onChange={(event) => setDraft(event.target.value)}
                onBlur={() => { void rename(calendar); }}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void rename(calendar); } if (event.key === "Escape") { event.stopPropagation(); setEditing(null); } }} />
              : <strong>{calendar.name}</strong>}
            <small>{roleLabel(calendar)}</small>
          </span>
          {(() => {
            const mute = mutes.loaded && (calendar.is_owner !== 1 || calendar.visibility !== "private")
              ? <MuteEmailsButton type="calendar" id={calendar.id} name={calendar.name} muted={mutes.isMuted("calendar", calendar.id)} busy={mutes.isBusy("calendar", calendar.id)}
                onToggle={() => { void mutes.toggle("calendar", calendar.id, calendar.name); }} />
              : null;
            if (calendar.is_owner === 1 && canWrite) return <span className="calendar-list-actions">
              <Select variant="compact" swatchOnly value={calendar.color} label={`Colour of ${calendar.name}`} options={colourOptions}
                onChange={(next) => { void onUpdate(calendar, { color: next }).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not update the calendar")); }} />
              <button className="icon-button" onClick={() => { setDraft(calendar.name); setEditing(calendar.id); }} aria-label={`Rename ${calendar.name}`}><Pencil /></button>
              <button className="icon-button" onClick={() => onShare(calendar)} aria-label={`Share ${calendar.name}`}><Share2 /></button>
              <button className="icon-button" onClick={() => onFeeds(calendar)} aria-label={`Subscribe links for ${calendar.name}`}><Rss /></button>
              {mute}
              <button className="icon-button danger" onClick={() => onDelete(calendar)} aria-label={`Move ${calendar.name} to the Bin`}><Trash2 /></button>
            </span>;
            // Managers (Wave 32, D273) rename, recolour, and share up to Can edit; only the owner deletes.
            if (calendar.is_owner !== 1 && canWrite && calendar.level === "manage") return <span className="calendar-list-actions">
              <Select variant="compact" swatchOnly value={calendar.color} label={`Colour of ${calendar.name}`} options={colourOptions}
                onChange={(next) => { void onUpdate(calendar, { color: next }).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not update the calendar")); }} />
              <button className="icon-button" onClick={() => { setDraft(calendar.name); setEditing(calendar.id); }} aria-label={`Rename ${calendar.name}`}><Pencil /></button>
              <button className="icon-button" onClick={() => onShare(calendar)} aria-label={`Share ${calendar.name}`}><Share2 /></button>
              <button className="icon-button" onClick={() => onFeeds(calendar)} aria-label={`Subscribe links for ${calendar.name}`}><Rss /></button>
              {mute}
            </span>;
            if (calendar.is_owner !== 1 && (canWrite || mute)) return <span className="calendar-list-actions">
              {canWrite && <button className="icon-button" onClick={() => onFeeds(calendar)} aria-label={`Subscribe links for ${calendar.name}`}><Rss /></button>}
              {mute}
            </span>;
            return mute ? <span className="calendar-list-actions">{mute}</span> : null;
          })()}
        </li>;
      })}
      <li className="calendar-list-row">
        <button className="icon-button calendar-visibility" onClick={onToggleTasks} aria-pressed={showTasks} aria-label={`${showTasks ? "Hide" : "Show"} tasks due`}>
          {showTasks ? <Eye /> : <EyeOff />}
        </button>
        <span className="calendar-dot large task" aria-hidden="true" />
        <span className="calendar-list-copy"><strong>Tasks due</strong><small>Cards with a due date on boards you can open</small></span>
      </li>
    </ul>
    {owned.length < 20 && canWrite && <form className="calendar-new" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <input value={name} maxLength={80} placeholder="New calendar" aria-label="New calendar name" onChange={(event) => setName(event.target.value)} />
      <Select variant="compact" value={color} label="Colour" options={colourOptions} onChange={setColor} />
      <button className="primary-button" type="submit" disabled={busy}><Plus />Add</button>
    </form>}
    {(error ?? mutes.error) && <p className="file-dialog-error" role="alert">{error ?? mutes.error}</p>}
  </ModalDialog>;
}
