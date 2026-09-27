import { useEffect, useState } from "react";
import { Plus, RotateCcw, TriangleAlert } from "lucide-react";
import { addDays, monthGridDays } from "../calendarRoute";
import { MonthGrid } from "../ui/calendarGrid/MonthGrid";
import { listOccurrences, viewerTimeZone, type Occurrence, type OccurrenceList } from "./calendarApi";
import { dayHeading, eventDayLabel, groupByDay, tasksByDay } from "./calendarFormat";
import { OccurrenceRow, TaskRow } from "./AgendaView";

type MonthViewProps = {
  month: string;
  today: string;
  compact: boolean;
  selectedDay: string | null;
  calendarIds: string[] | null;
  showTasks: boolean;
  reloadKey: number;
  canCreate: boolean;
  onSelectDay: (day: string) => void;
  onOpen: (occurrence: Occurrence) => void;
  /** New event on a day: from the day list, or (full grid) a click on a cell's empty area or its "+". */
  onCreate: (day: string) => void;
  onShiftMonth: (delta: number) => void;
  onToday: () => void;
};

const CHIPS_PER_DAY = 3;

/**
 * The month grid (desktop) or a dot grid with the selected day's list (phones). Six Monday-first
 * weeks; prev/next replace the history entry (the caller decides), so Back never walks months.
 * This container loads the month's occurrences; the grid itself is `src/ui/calendarGrid/MonthGrid`.
 */
export function MonthView(props: MonthViewProps) {
  const { month, today, compact, selectedDay, calendarIds, showTasks, reloadKey, canCreate, onSelectDay, onOpen, onCreate, onShiftMonth, onToday } = props;
  const [data, setData] = useState<OccurrenceList | null>(null);
  const [loadedMonth, setLoadedMonth] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const days = monthGridDays(month);
  const from = days[0]!;
  const to = addDays(days[days.length - 1]!, 1);
  const zone = viewerTimeZone();
  const calendarKey = calendarIds?.join(",") ?? "";

  useEffect(() => {
    let active = true;
    setError(null);
    listOccurrences(from, to, { calendarIds: calendarIds ?? undefined, includeTasks: showTasks })
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoadedMonth(month);
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Could not load events"); });
    return () => { active = false; };
    // calendarKey stands in for calendarIds.
  }, [from, to, month, calendarKey, showTasks, reloadKey, attempt]);

  const byDay = data ? groupByDay(data.occurrences, zone, from, to) : new Map<string, Occurrence[]>();
  const day = selectedDay && selectedDay.startsWith(month) ? selectedDay : today.startsWith(month) ? today : `${month}-01`;
  const dayItems = byDay.get(day) ?? [];
  const dueByDay = tasksByDay(showTasks ? data?.tasks ?? [] : []);
  const dayTasks = dueByDay.get(day) ?? [];
  const stale = loadedMonth !== month;

  return <MonthGrid month={month} today={today} selectedDay={day} compact={compact} busy={stale}
    countFor={(cell) => (byDay.get(cell)?.length ?? 0) + (dueByDay.get(cell)?.length ?? 0)}
    onSelectDay={onSelectDay} onShiftMonth={onShiftMonth} onToday={onToday}
    onDayCreate={canCreate && !compact ? onCreate : undefined}
    status={error ? <div className="calendar-state" role="alert">
      <TriangleAlert />
      <h2>Could not load this month</h2>
      <p>{error}</p>
      <button className="primary-button" onClick={() => setAttempt((value) => value + 1)}><RotateCcw />Try again</button>
    </div> : undefined}
    renderDots={(cell) => {
      const items = byDay.get(cell) ?? [];
      const due = dueByDay.get(cell)?.length ?? 0;
      return <>
        {items.slice(0, 3).map((item) => <span key={`${item.eventId}:${item.date}`} className={`calendar-dot color-${item.color}`} />)}
        {due > 0 && items.length < 3 && <span className="calendar-dot task" />}
      </>;
    }}
    renderDay={(cell) => {
      const items = byDay.get(cell) ?? [];
      const due = dueByDay.get(cell)?.length ?? 0;
      return <>
        {items.slice(0, CHIPS_PER_DAY).map((item) => <button key={`${item.eventId}:${item.date}`} className={`calendar-chip color-${item.color}`} onClick={() => onOpen(item)} title={item.title}>
          {!item.allDay && <span>{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: zone }).format(new Date(item.start))}</span>}
          {item.title}
        </button>)}
        {items.length > CHIPS_PER_DAY && <button className="calendar-more" onClick={() => onSelectDay(cell)}>+{items.length - CHIPS_PER_DAY} more</button>}
        {due > 0 && <button className="calendar-more calendar-due" onClick={() => onSelectDay(cell)}>{due === 1 ? "1 task due" : `${due} tasks due`}</button>}
      </>;
    }}>
    {!error && <section className="calendar-day-list" aria-labelledby="calendar-day-title">
      <header>
        <h3 id="calendar-day-title">{dayHeading(day, today)}</h3>
        {canCreate && <button className="secondary-button calendar-add-day" onClick={() => onCreate(day)}><Plus aria-hidden="true" />New event on {eventDayLabel(day, today)}</button>}
      </header>
      {dayTasks.length > 0 && <ul className="calendar-day-tasks">{dayTasks.map((task) => <li key={`task:${task.cardId}`}><TaskRow task={task} /></li>)}</ul>}
      {!stale && !dayItems.length && !dayTasks.length && <p className="calendar-note">No events this day.</p>}
      <ul>
        {dayItems.map((item) => <li key={`${item.eventId}:${item.date}`}><OccurrenceRow occurrence={item} day={day} zone={zone} onOpen={onOpen} /></li>)}
      </ul>
      {data?.truncated && <p className="calendar-note">Showing the first 1000 events. Hide some calendars to see the rest.</p>}
    </section>}
  </MonthGrid>;
}
