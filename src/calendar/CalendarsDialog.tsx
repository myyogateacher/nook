import { useEffect, useState } from "react";
import { Eye, EyeOff, Lock, Pencil, Plus, Rss, Share2, Trash2, Users, X } from "lucide-react";
import { api } from "../api";
import { ModalDialog, trapTabKey } from "../files/Dialog";
import type { User, Visibility } from "../types";
import { getCalendarSharing, saveCalendarSharing, type CalendarColor, type CalendarSummary, type ShareRole } from "./calendarApi";
import { CALENDAR_COLORS } from "./calendarFormat";
import { Select } from "../ui/Select";
import { ShareRoleHint } from "../team/roleAccess";
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

const roleLabel = (calendar: CalendarSummary) => calendar.role === "owner"
  ? calendar.visibility === "private" ? "Private" : calendar.share_role === "editor" ? "Shared · others can edit" : "Shared · others can view"
  : `${calendar.owner_name} · ${calendar.role === "editor" ? "you can edit" : "view only"}`;

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

type CalendarSharePanelProps = { calendar: CalendarSummary; onClose: () => void; onSaved: () => void };

/** Owner-only sharing: who sees the calendar, and whether they may edit events (D54). */
export function CalendarSharePanel({ calendar, onClose, onSaved }: CalendarSharePanelProps) {
  const [users, setUsers] = useState<User[]>([]);
  const [visibility, setVisibility] = useState<Visibility>(calendar.visibility);
  const [shareRole, setShareRole] = useState<ShareRole>(calendar.share_role);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api<{ users: User[] }>("/users"), getCalendarSharing(calendar.id)]).then(([allUsers, sharing]) => {
      if (!active) return;
      setUsers(allUsers.users);
      setVisibility(sharing.visibility);
      setShareRole(sharing.shareRole);
      setSelected(sharing.users.map((user) => user.id));
      setBusy(false);
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Could not load sharing"); });
    return () => { active = false; };
  }, [calendar.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await saveCalendarSharing(calendar.id, visibility, shareRole, selected);
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update sharing");
      setBusy(false);
    }
  }

  const option = (value: Visibility, Icon: typeof Lock, label: string, hint: string) =>
    <label><input type="radio" name="calendar-visibility" checked={visibility === value} onChange={() => setVisibility(value)} /><span><Icon />{label}<small>{hint}</small></span></label>;

  return <>
    <button className="panel-scrim" onClick={onClose} aria-label="Close sharing" tabIndex={-1} />
    <aside className="side-panel share-panel calendar-share-panel" role="dialog" aria-modal="true" aria-labelledby="calendar-share-title" onKeyDown={trapTabKey}>
      <header><div><span className="eyebrow">Access</span><h2 id="calendar-share-title" title={calendar.name}>Share “{calendar.name}”</h2></div><button className="icon-button" onClick={onClose} aria-label="Close sharing"><X /></button></header>
      <div className="share-options" role="radiogroup" aria-label="Who can see this calendar">
        {option("private", Lock, "Private", "Only you can see this calendar")}
        {option("selected", Users, "Selected people", "Choose registered users below")}
        {option("all_users", Share2, "Everyone here", "Everyone signed in except guests; never public")}
      </div>
      {visibility !== "private" && <div className="share-options calendar-role-options" role="radiogroup" aria-label="What they can do">
        <label><input type="radio" name="calendar-role" checked={shareRole === "viewer"} onChange={() => setShareRole("viewer")} /><span><Eye />Can view<small>See events; only you and editors change them</small></span></label>
        <label><input type="radio" name="calendar-role" checked={shareRole === "editor"} onChange={() => setShareRole("editor")} /><span><Pencil />Can edit events<small>Add, change, and remove events; only you manage the calendar</small></span></label>
      </div>}
      {visibility === "selected" && <div className="user-picker" role="group" aria-label="People">
        {users.map((user) => <label key={user.id}><input type="checkbox" checked={selected.includes(user.id)} onChange={() => setSelected((items) => items.includes(user.id) ? items.filter((id) => id !== user.id) : [...items, user.id])} /><span>{user.displayName}<ShareRoleHint role={user.role} /></span></label>)}
        {!users.length && <p className="empty-copy">Create another account before sharing with selected people.</p>}
      </div>}
      {error && <p className="file-dialog-error file-share-error" role="alert">{error}</p>}
      <button className="primary-button share-save" onClick={() => { void save(); }} disabled={busy || (visibility === "selected" && !selected.length)}>Save access</button>
    </aside>
  </>;
}
