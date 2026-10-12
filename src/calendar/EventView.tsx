import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, CalendarX2, Clock, MapPin, Pencil, Repeat, RotateCcw, Trash2, TriangleAlert, Undo2 } from "lucide-react";
import { ApiError } from "../api";
import { getEvent, viewerTimeZone, type EventResponse } from "./calendarApi";
import { eventWhen, repeatSummary, shortDate } from "./calendarFormat";
import { useRole } from "../team/roleAccess";

type EventViewProps = {
  eventId: string;
  occurrence: string | null;
  reloadKey: number;
  onBack: () => void;
  onMissing: () => void;
  onEdit: (data: EventResponse) => void;
  onUndo: (data: EventResponse) => void;
  onSkip: (data: EventResponse, date: string) => void;
  onDelete: (data: EventResponse) => void;
  onLoaded?: (data: EventResponse) => void;
  renderLinks?: (data: EventResponse) => ReactNode;
  renderReminders?: (data: EventResponse) => ReactNode;
  /** The event's files (uploads everywhere U1), above its links. */
  renderAttachments?: (data: EventResponse) => ReactNode;
};

/** /calendar/event/:e: the event, what it links to, and the viewer's own reminders. */
export function EventView({ eventId, occurrence, reloadKey, onBack, onMissing, onEdit, onUndo, onSkip, onDelete, onLoaded, renderLinks, renderReminders, renderAttachments }: EventViewProps) {
  const { canWrite } = useRole();
  const [data, setData] = useState<EventResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    getEvent(eventId).then((result) => {
      if (!active) return;
      setData(result);
      onLoaded?.(result);
    }).catch((reason) => {
      if (!active) return;
      if (reason instanceof ApiError && reason.status === 404) onMissing();
      else setError(reason instanceof Error ? reason.message : "Could not load this event");
    });
    return () => { active = false; };
    // Callbacks are recreated on every render; the event id and reload key decide when to fetch.
  }, [eventId, reloadKey, attempt]);

  const back = <button className="calendar-back" onClick={onBack}><ArrowLeft />Back</button>;
  if (error) return <section className="calendar-event">
    {back}
    <div className="calendar-state" role="alert">
      <TriangleAlert />
      <h2>Could not load this event</h2>
      <p>{error}</p>
      <button className="primary-button" onClick={() => setAttempt((value) => value + 1)}><RotateCcw />Try again</button>
    </div>
  </section>;
  if (!data || data.event.id !== eventId) return <section className="calendar-event">{back}<p className="calendar-loading" role="status">Loading the event…</p></section>;

  const { event, calendar, role } = data;
  const canEdit = canWrite && role !== "viewer";
  const startDate = event.start_date ?? event.start_local?.slice(0, 10) ?? "";
  const skippable = canEdit && event.repeat !== null && occurrence !== null && !event.exdates.includes(occurrence);

  return <article className="calendar-event" aria-labelledby="calendar-event-title">
    {back}
    <header className="calendar-event-header">
      <span className={`calendar-dot large color-${calendar.color}`} aria-hidden="true" />
      <div>
        <span className="eyebrow">{calendar.name}{calendar.is_owner ? "" : ` · ${calendar.owner_name}`}</span>
        <h1 id="calendar-event-title">{event.title}</h1>
      </div>
      {!canEdit && <span className="calendar-badge">View only</span>}
    </header>

    <dl className="calendar-event-facts">
      <div><dt><Clock aria-label="When" /></dt><dd>{eventWhen(event, viewerTimeZone())}</dd></div>
      {event.repeat && <div><dt><Repeat aria-label="Repeats" /></dt><dd>{repeatSummary(event.repeat, startDate)}{event.exdates.length > 0 && <small>{event.exdates.length === 1 ? "1 date skipped" : `${event.exdates.length} dates skipped`}</small>}</dd></div>}
      {event.location && <div><dt><MapPin aria-label="Where" /></dt><dd>{event.location}</dd></div>}
    </dl>
    {event.description && <p className="calendar-event-description">{event.description}</p>}
    {event.changedByKey && <p className="calendar-note">Changed by {event.changedByKeyName ? `the MCP key “${event.changedByKeyName}”` : "an MCP key"}{canEdit && event.canUndo ? " · use Undo last change to revert it." : "."}</p>}

    {canEdit && <div className="calendar-event-actions">
      <button className="primary-button" onClick={() => onEdit(data)}><Pencil />Edit</button>
      {event.canUndo && <button className="secondary-button" onClick={() => onUndo(data)}><Undo2 />Undo last change</button>}
      {skippable && <button className="secondary-button" onClick={() => onSkip(data, occurrence)}><CalendarX2 />Skip {shortDate(occurrence)}</button>}
      <button className="danger-button" onClick={() => onDelete(data)}><Trash2 />Move to Bin</button>
    </div>}

    {renderAttachments?.(data)}

    {renderLinks?.(data)}

    {renderReminders?.(data)}
  </article>;
}
