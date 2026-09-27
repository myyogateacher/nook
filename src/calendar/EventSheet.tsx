import { useId, useState } from "react";
import { Repeat } from "lucide-react";
import { ConfirmDialog, ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { CalendarSummary, RepeatRule, Weekday } from "./calendarApi";
import { repeatSummary, WEEKDAYS, weekdayNames, weekdayOf, type EventForm } from "./calendarFormat";

type EventSheetProps = {
  mode: "create" | "edit";
  form: EventForm;
  calendars: CalendarSummary[];
  calendarId: string;
  busy: boolean;
  error: string | null;
  conflict: boolean;
  onChange: (form: EventForm) => void;
  onCalendarChange: (calendarId: string) => void;
  onRepeat: () => void;
  onSave: () => void;
  onReload: () => void;
  onClose: () => void;
};

// The event sheet, its Repeat sheet, and the Discard prompt are shown one at a time, and each holds its
// own history guard while it is on screen (the task composer's pattern): Back closes only the layer on
// top, so Repeat goes back to the form, the form asks before losing changes, and Back or Cancel on the
// prompt returns to the form with the draft. Each guard also holds the phone's depth-0 sentinel, which
// is pushed again when one layer hands over to the next, so the next Back still stays in Calendar.

/**
 * Create or edit an event. A full-screen sheet on phones; it pushes no history entry (D69). From
 * 1100 px it is two columns (operator QA 0.9.2): the title, all day, the dates and times, the zone,
 * and Repeat on the left; the calendar, Location, and Notes (which grows) on the right. Narrower,
 * the columns are `display: contents` and the fields keep one column, the calendar after the title.
 */
export function EventSheet({ mode, form, calendars, calendarId, busy, error, conflict, onChange, onCalendarChange, onRepeat, onSave, onReload, onClose }: EventSheetProps) {
  // Back closes the sheet, or asks first when it was edited (the caller's onClose decides).
  useHistoryDialogGuard(true, onClose);
  const set = <K extends keyof EventForm>(key: K, value: EventForm[K]) => onChange({ ...form, [key]: value });
  const calendarLabelId = useId();
  return <ModalDialog title={mode === "create" ? "New event" : "Edit event"} eyebrow="Calendar" onClose={onClose} variant="sheet" busy={busy} className="calendar-event-dialog">
    <form className="calendar-form calendar-event-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <div className="calendar-event-when">
      <label className="calendar-field calendar-event-title">
        <span>Title</span>
        <input value={form.title} maxLength={200} onChange={(event) => set("title", event.target.value)} autoFocus required />
      </label>
      <label className="calendar-toggle">
        <input type="checkbox" checked={form.allDay} onChange={(event) => set("allDay", event.target.checked)} />
        <span>All day</span>
      </label>
      <div className="calendar-field-row">
        <label className="calendar-field"><span>Starts</span><input type="date" value={form.startDate} onChange={(event) => {
          // Moving the start moves the end with it, keeping the length.
          const start = event.target.value;
          if (!start) return;
          const shift = Math.round((Date.parse(`${start}T00:00Z`) - Date.parse(`${form.startDate}T00:00Z`)) / 86_400_000);
          const end = Number.isFinite(shift) ? new Date(Date.parse(`${form.endDate}T00:00Z`) + shift * 86_400_000).toISOString().slice(0, 10) : start;
          onChange({ ...form, startDate: start, endDate: end < start ? start : end });
        }} required /></label>
        {!form.allDay && <label className="calendar-field"><span>Time</span><input type="time" value={form.startTime} onChange={(event) => set("startTime", event.target.value)} required /></label>}
      </div>
      <div className="calendar-field-row">
        <label className="calendar-field"><span>Ends</span><input type="date" value={form.endDate} min={form.startDate} onChange={(event) => set("endDate", event.target.value)} required /></label>
        {!form.allDay && <label className="calendar-field"><span>Time</span><input type="time" value={form.endTime} onChange={(event) => set("endTime", event.target.value)} required /></label>}
      </div>
      {!form.allDay && <p className="calendar-hint">Time zone: {form.tz}</p>}
      <button type="button" className="calendar-repeat-button" onClick={onRepeat}>
        <Repeat /><span><strong>Repeat</strong><small>{repeatSummary(form.repeat, form.startDate)}</small></span>
      </button>
      </div>
      <div className="calendar-event-details">
      {mode === "create" && calendars.length > 1 && <div className="calendar-field calendar-event-calendar">
        <span id={calendarLabelId}>Calendar</span>
        <Select value={calendarId} onChange={onCalendarChange} label="Calendar" labelledBy={calendarLabelId}
          options={calendars.map((calendar) => ({ value: calendar.id, label: calendar.name, swatch: calendar.color, description: calendar.is_owner ? undefined : `Shared by ${calendar.owner_name}` }))} />
      </div>}
      <label className="calendar-field">
        <span>Location</span>
        <input value={form.location} maxLength={200} onChange={(event) => set("location", event.target.value)} />
      </label>
      <label className="calendar-field calendar-event-notes">
        <span>Notes</span>
        <textarea value={form.description} rows={4} onChange={(event) => set("description", event.target.value)} />
      </label>
      </div>
      {error && <p className="file-dialog-error" role="alert">{error}{conflict && <> <button type="button" className="calendar-link-button" onClick={onReload}>Load their changes</button></>}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : mode === "create" ? "Add event" : "Save"}</button>
      </footer>
    </form>
  </ModalDialog>;
}

type RepeatSheetProps = {
  rule: RepeatRule | null;
  startDate: string;
  onDone: (rule: RepeatRule | null) => void;
  onCancel: () => void;
};

type Ends = "never" | "until" | "count";

/** The Repeat sheet: the D63 subset. Shown in place of the event sheet, so only one dialog is open. */
export function RepeatSheet({ rule, startDate, onDone, onCancel }: RepeatSheetProps) {
  // Back returns to the event form, keeping the rule it had.
  useHistoryDialogGuard(true, onCancel);
  const startDay = weekdayOf(startDate);
  const [freq, setFreq] = useState<RepeatRule["freq"] | "none">(rule?.freq ?? "none");
  const [interval, setIntervalValue] = useState(String(rule?.interval ?? 1));
  const [byDay, setByDay] = useState<Weekday[]>(rule?.byDay ?? [startDay]);
  const [ends, setEnds] = useState<Ends>(rule?.until ? "until" : rule?.count ? "count" : "never");
  const [until, setUntil] = useState(rule?.until ?? startDate);
  const [count, setCount] = useState(String(rule?.count ?? 10));
  const [error, setError] = useState<string | null>(null);
  const repeatsLabelId = useId();

  function done() {
    if (freq === "none") return onDone(null);
    const every = Number(interval);
    if (!Number.isInteger(every) || every < 1 || every > 99) return setError("Repeat every 1 to 99");
    const next: RepeatRule = { freq, interval: every };
    if (freq === "weekly") {
      // The start's own weekday is always included (the server requires it).
      const days = WEEKDAYS.filter((day) => day === startDay || byDay.includes(day));
      next.byDay = days;
    }
    if (ends === "until") {
      if (!until || until < startDate) return setError("The repeat must end on or after the start date");
      next.until = until;
    }
    if (ends === "count") {
      const times = Number(count);
      if (!Number.isInteger(times) || times < 1 || times > 730) return setError("Repeat 1 to 730 times");
      next.count = times;
    }
    onDone(next);
  }

  const unit = { daily: "days", weekly: "weeks", monthly: "months", yearly: "years", none: "" }[freq];
  return <ModalDialog title="Repeat" eyebrow="Event" onClose={onCancel} variant="sheet">
    <div className="calendar-form">
      <div className="calendar-field">
        <span id={repeatsLabelId}>Repeats</span>
        <Select value={freq} onChange={setFreq} label="Repeats" labelledBy={repeatsLabelId} autoFocus options={[
          { value: "none", label: "Does not repeat" },
          { value: "daily", label: "Daily" },
          { value: "weekly", label: "Weekly" },
          { value: "monthly", label: `Monthly (on day ${Number(startDate.slice(8, 10))})` },
          { value: "yearly", label: "Yearly" }
        ]} />
      </div>
      {freq !== "none" && <>
        <label className="calendar-field calendar-inline-field">
          <span>Every</span>
          <input type="number" inputMode="numeric" min={1} max={99} value={interval} onChange={(event) => setIntervalValue(event.target.value)} />
          <em>{unit}</em>
        </label>
        {freq === "monthly" && Number(startDate.slice(8, 10)) > 28 && <p className="calendar-hint">Months without day {Number(startDate.slice(8, 10))} are skipped.</p>}
        {freq === "weekly" && <fieldset className="calendar-weekday-picker">
          <legend>On</legend>
          {WEEKDAYS.map((day) => <label key={day} className={byDay.includes(day) || day === startDay ? "active" : undefined}>
            <input type="checkbox" checked={byDay.includes(day) || day === startDay} disabled={day === startDay}
              onChange={(event) => setByDay((current) => event.target.checked ? [...current, day] : current.filter((item) => item !== day))} />
            <span>{weekdayNames[day]}</span>
          </label>)}
        </fieldset>}
        <fieldset className="calendar-ends">
          <legend>Ends</legend>
          <label><input type="radio" name="repeat-ends" checked={ends === "never"} onChange={() => setEnds("never")} /><span>Never</span></label>
          <label><input type="radio" name="repeat-ends" checked={ends === "until"} onChange={() => setEnds("until")} /><span>On</span>
            <input type="date" value={until} min={startDate} disabled={ends !== "until"} onChange={(event) => setUntil(event.target.value)} aria-label="End date" /></label>
          <label><input type="radio" name="repeat-ends" checked={ends === "count"} onChange={() => setEnds("count")} /><span>After</span>
            <input type="number" inputMode="numeric" min={1} max={730} value={count} disabled={ends !== "count"} onChange={(event) => setCount(event.target.value)} aria-label="Number of times" /><em>times</em></label>
        </fieldset>
      </>}
      {error && <p className="file-dialog-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel}>Back</button>
        <button type="button" className="primary-button" onClick={done}>Done</button>
      </footer>
    </div>
  </ModalDialog>;
}

/**
 * "Discard changes?" for an edited event sheet, in place of the sheet. Back and Cancel both keep
 * editing: the form comes back with everything entered.
 */
export function DiscardEventPrompt({ onDiscard, onKeep }: { onDiscard: () => void; onKeep: () => void }) {
  useHistoryDialogGuard(true, onKeep);
  return <ConfirmDialog title="Discard changes?" message="Your changes to this event will be lost." confirmLabel="Discard" danger onConfirm={onDiscard} onCancel={onKeep} />;
}
