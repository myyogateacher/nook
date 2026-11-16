import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Globe } from "lucide-react";
import { timeLabel, zones, type SlotDays } from "./api";
import "./slots.css";

/**
 * The date-then-time picker (the public booking page, the manage page's reschedule, and the host's
 * reschedule): a month calendar with the days that have free times marked, then the day's times in
 * the chosen zone (the viewer's by default, changeable). Fetches one month at a time (≤ 31 days,
 * T575). Keyboard: arrows move between days, Enter picks; times are a list of buttons.
 */

const pad = (value: number) => String(value).padStart(2, "0");
const monthStart = (year: number, month: number) => `${year}-${pad(month + 1)}-01`;
const addMonths = (year: number, month: number, by: number) => { const date = new Date(Date.UTC(year, month + by, 1)); return { year: date.getUTCFullYear(), month: date.getUTCMonth() }; };
const todayIn = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export function SlotPicker({ load, tz, onTz, onPick, picked, weekStart = 1, label = "Pick a time" }: {
  load: (from: string, to: string, tz: string) => Promise<SlotDays>;
  tz: string;
  onTz: (tz: string) => void;
  onPick: (start: string) => void;
  picked?: string | null;
  /** D1383: the in-app pickers pass the viewer's "Week starts on"; public pages keep Monday. */
  weekStart?: 0 | 1 | 6;
  label?: string;
}) {
  const today = todayIn(tz);
  const [cursor, setCursor] = useState(() => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 }));
  const [days, setDays] = useState<Record<string, string[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let live = true;
    setDays(null);
    setError(null);
    const next = addMonths(cursor.year, cursor.month, 1);
    loadRef.current(monthStart(cursor.year, cursor.month), monthStart(next.year, next.month), tz)
      .then((result) => {
        if (!live) return;
        setDays(result.days);
        setSelected((current) => current && result.days[current]?.length ? current : Object.keys(result.days).sort()[0] ?? null);
      })
      .catch((reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : "Could not load times"); });
    return () => { live = false; };
  }, [cursor.year, cursor.month, tz]);

  const cells = useMemo(() => {
    const first = new Date(Date.UTC(cursor.year, cursor.month, 1));
    const offset = (first.getUTCDay() - weekStart + 7) % 7;
    const count = new Date(Date.UTC(cursor.year, cursor.month + 1, 0)).getUTCDate();
    return [...Array(offset).fill(null), ...Array.from({ length: count }, (_, index) => `${cursor.year}-${pad(cursor.month + 1)}-${pad(index + 1)}`)] as Array<string | null>;
  }, [cursor, weekStart]);
  const weekdayNames = useMemo(() => Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 1, 1 + ((index + weekStart) % 7))))), [weekStart]);
  const monthName = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(cursor.year, cursor.month, 1)));
  const thisMonth = cursor.year === Number(today.slice(0, 4)) && cursor.month === Number(today.slice(5, 7)) - 1;
  const zoneList = useMemo(() => { const list = zones(); return list.includes(tz) ? list : [tz, ...list]; }, [tz]);
  const times = selected && days ? days[selected] ?? [] : [];

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const by = moves[event.key];
    if (by === undefined || !selected) return;
    event.preventDefault();
    const dates = cells.filter((cell): cell is string => cell !== null);
    const next = dates[dates.indexOf(selected) + by];
    if (next && days?.[next]?.length) { setSelected(next); grid.current?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)?.focus(); }
  };

  return <div className="bk-slots" aria-label={label} role="group">
    <div className="bk-slots-calendar">
      <div className="bk-slots-month">
        <button type="button" className="bk-slots-nav" aria-label="Previous month" disabled={thisMonth} onClick={() => setCursor(addMonths(cursor.year, cursor.month, -1))}><ChevronLeft /></button>
        <strong aria-live="polite">{monthName}</strong>
        <button type="button" className="bk-slots-nav" aria-label="Next month" onClick={() => setCursor(addMonths(cursor.year, cursor.month, 1))}><ChevronRight /></button>
      </div>
      <div className="bk-slots-grid" role="grid" ref={grid} onKeyDown={onGridKey} aria-busy={days === null}>
        {weekdayNames.map((name) => <span key={name} className="bk-slots-weekday" aria-hidden="true">{name}</span>)}
        {cells.map((date, index) => {
          if (!date) return <span key={`blank-${index}`} />;
          const count = days?.[date]?.length ?? 0;
          const isSelected = date === selected;
          return <button key={date} type="button" data-date={date} className={`bk-slots-day${count ? " open" : ""}${isSelected ? " selected" : ""}${date === today ? " today" : ""}`}
            disabled={!count} tabIndex={isSelected || (!selected && count) ? 0 : -1} aria-pressed={isSelected}
            aria-label={`${new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`))}${count ? `, ${count} times` : ", no times"}`}
            onClick={() => setSelected(date)}>{Number(date.slice(8))}</button>;
        })}
      </div>
      <label className="bk-slots-zone">
        <Globe aria-hidden="true" />
        <span className="bk-visually-hidden">Time zone</span>
        <ZoneInput tz={tz} zones={zoneList} onTz={onTz} />
      </label>
    </div>
    <div className="bk-slots-times">
      {error ? <p className="bk-slots-note" role="alert">{error}</p>
        : days === null ? <p className="bk-slots-note" role="status">Loading times…</p>
        : !selected ? <p className="bk-slots-note">No free times this month. Try the next one.</p>
        : <>
          <h3>{new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${selected}T00:00:00Z`))}</h3>
          <ul aria-label="Free times">
            {times.map((iso) => <li key={iso}><button type="button" className={`bk-slots-time${picked === iso ? " picked" : ""}`} aria-pressed={picked === iso} onClick={() => onPick(iso)}>{timeLabel(iso, tz)}</button></li>)}
          </ul>
        </>}
    </div>
  </div>;
}

/** The zone field: type to search every IANA zone (a datalist, so it works the same on public pages); applied when it names a real zone. */
function ZoneInput({ tz, zones: list, onTz }: { tz: string; zones: readonly string[]; onTz: (tz: string) => void }) {
  const [text, setText] = useState(tz.replace(/_/g, " "));
  useEffect(() => { setText(tz.replace(/_/g, " ")); }, [tz]);
  const listId = `bk-zones-${useMemo(() => Math.random().toString(36).slice(2, 8), [])}`;
  const apply = (value: string) => {
    const zone = list.find((item) => item.replace(/_/g, " ").toLowerCase() === value.trim().toLowerCase());
    if (zone && zone !== tz) onTz(zone);
  };
  return <>
    <input className="bk-slots-zone-input" list={listId} value={text} spellCheck={false} autoComplete="off"
      onChange={(event) => { setText(event.target.value); apply(event.target.value); }} onBlur={() => setText(tz.replace(/_/g, " "))} />
    <datalist id={listId}>{list.map((zone) => <option key={zone} value={zone.replace(/_/g, " ")} />)}</datalist>
  </>;
}
