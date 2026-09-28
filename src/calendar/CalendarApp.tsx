import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, CalendarRange, House, Layers, List, Plus, Sparkles } from "lucide-react";
import { ApiError } from "../api";
import { AccountActions, AppPageName } from "../AppShell";
import { readHistoryDepth } from "../appShellNavigation";
import { createCalendarHistoryState, readCalendarHint, type CalendarHint } from "../calendarNavigation";
import { agendaRoute, calendarBackAction, eventRoute, localDate, monthOf, monthRoute, resolveMonth, shiftMonth, type CalendarRoute } from "../calendarRoute";
import { ConfirmDialog } from "../files/Dialog";
import { popStateClosedDialog } from "../historyDialogs";
import { formatRoute, parseRoute, type Route } from "../router";
import { AgendaView } from "./AgendaView";
import {
  createCalendar,
  createEvent,
  deleteCalendar,
  addEventLink,
  deleteEvent,
  removeEventLink,
  listCalendars,
  skipOccurrence,
  undoEvent,
  updateCalendar,
  updateEvent,
  viewerTimeZone,
  type CalendarColor,
  type CalendarSummary,
  type EventDetail,
  type EventResponse,
  type Occurrence
} from "./calendarApi";
import { formFromEvent, formToInput, newEventForm, sameForm, shortDate, type EventForm } from "./calendarFormat";
import { CalendarSharePanel, CalendarsDialog } from "./CalendarsDialog";
import { FeedDialog } from "./FeedDialog";
import { DiscardEventPrompt, EventSheet, RepeatSheet } from "./EventSheet";
import { EventLinks, linkLabel, NoteLinkPicker } from "./EventLinks";
import { addEventReminder, EventReminders, reminderLabel, ReminderPicker, removeReminder, type ReminderSummary } from "./EventReminders";
import { EventView } from "./EventView";
import { PHONE_QUERY, useDialogBackGuard, useMediaQuery } from "./hooks";
import { MonthView } from "./MonthView";
import "../bin/bin.css";
import "../files/files.css";
import "./calendar.css";
import { ReadOnlyBanner, useRole } from "../team/roleAccess";

export type CalendarNavigate = (route: Route, options?: { replace?: boolean }) => void;

type CalendarAppProps = {
  userId: string;
  displayName: string;
  navigate: CalendarNavigate;
  flash: (message: string) => void;
  onHome: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  /** Opens a linked note in Notes (a new history entry). */
  onOpenNote: (noteId: string) => void;
};

type Sheet = {
  mode: "create" | "edit";
  initial: EventForm;
  form: EventForm;
  calendarId: string;
  event: EventDetail | null;
  busy: boolean;
  error: string | null;
  conflict: EventDetail | null;
};

type Confirm =
  | { kind: "discard" }
  | { kind: "deleteEvent"; data: EventResponse }
  | { kind: "deleteCalendar"; calendar: CalendarSummary };

const currentCalendarRoute = (): CalendarRoute => {
  const route = parseRoute(window.location.pathname);
  return route.app === "calendar" ? route : agendaRoute();
};

const errorCode = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object"
  ? (reason.payload as { code?: unknown; event?: unknown }).code
  : undefined;
const errorMessage = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;

const hiddenKey = (userId: string) => `mynotes:calendar-hidden:${userId}`;
function readHidden(userId: string) {
  try {
    const value = JSON.parse(window.localStorage.getItem(hiddenKey(userId)) ?? "[]") as unknown;
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set<string>();
  }
}
const tasksKey = (userId: string) => `mynotes:calendar-tasks:${userId}`;
function readShowTasks(userId: string) {
  try { return window.localStorage.getItem(tasksKey(userId)) !== "hidden"; } catch { return true; }
}
function writeShowTasks(userId: string, shown: boolean) {
  try { window.localStorage.setItem(tasksKey(userId), shown ? "shown" : "hidden"); } catch { /* storage blocked */ }
}
function writeHidden(userId: string, hidden: Set<string>) {
  try { window.localStorage.setItem(hiddenKey(userId), JSON.stringify([...hidden])); } catch { /* storage blocked */ }
}

/**
 * Calendar: agenda (/calendar), month (/calendar/month/:yyyy-mm), and event (/calendar/event/:e).
 * Views are history entries; month paging replaces the entry; dialogs and sheets push nothing and
 * are closed by Back through the dialog guard (D69).
 */
export function CalendarApp({ userId, displayName, navigate, flash, onHome, onSettings, onSignOut, onOpenNote }: CalendarAppProps) {
  const { canWrite } = useRole();
  const [route, setRoute] = useState<CalendarRoute>(currentCalendarRoute);
  const routeRef = useRef(route);
  routeRef.current = route;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const [hint, setHint] = useState<CalendarHint | null>(() => readCalendarHint(window.history.state, userId));
  const [calendars, setCalendars] = useState<CalendarSummary[] | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => readHidden(userId));
  const [reloadKey, setReloadKey] = useState(0);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [calendarsOpen, setCalendarsOpen] = useState(false);
  const [sharing, setSharing] = useState<CalendarSummary | null>(null);
  const [feeds, setFeeds] = useState<CalendarSummary | null>(null);
  const [picker, setPicker] = useState<EventResponse | null>(null);
  const [reminderPicker, setReminderPicker] = useState<{ eventId: string; allDay: boolean; existing: number[]; event: EventResponse["event"] } | null>(null);
  const [showTasks, setShowTasks] = useState(() => readShowTasks(userId));
  const [busy, setBusy] = useState(false);
  const phone = useMediaQuery(PHONE_QUERY);
  const today = localDate(new Date());
  const zone = viewerTimeZone();

  const loadCalendars = useCallback(async () => {
    try {
      setCalendars((await listCalendars()).calendars);
    } catch (reason) {
      flash(errorMessage(reason, "Could not load your calendars"));
      setCalendars((current) => current ?? []);
    }
  }, [flash]);
  useEffect(() => { void loadCalendars(); }, [loadCalendars]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (popStateClosedDialog(event)) return;
      const next = parseRoute(window.location.pathname);
      if (next.app !== "calendar") return;
      setRoute(next);
      setHint(readCalendarHint(event.state, userId));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [userId]);

  /** Records the hint on the current entry in place (never a new entry). */
  const writeHint = useCallback((next: CalendarHint) => {
    window.history.replaceState(createCalendarHistoryState(userId, next, window.history.state), "", window.location.pathname);
    setHint(next);
  }, [userId]);

  const go = useCallback((next: CalendarRoute, replace = false) => {
    setRoute(next);
    setHint(null);
    if (formatRoute(next) !== window.location.pathname || replace) navigateRef.current(next, { replace });
  }, []);

  // A month URL without a valid month shows the current one; normalise it in place.
  useEffect(() => {
    if (route.view === "month" && !route.eventId && !route.month) go(monthRoute(monthOf(today)), true);
  }, [go, route, today]);

  const back = useCallback(() => {
    const action = calendarBackAction(routeRef.current, readHistoryDepth(window.history.state));
    if (action.kind === "history") window.history.back();
    else if (action.kind === "replace") go(action.route, true);
    else onHome();
  }, [go, onHome]);

  function openOccurrence(occurrence: Occurrence) {
    go(eventRoute(occurrence.eventId));
    writeHint({ month: null, day: null, eventId: occurrence.eventId, occurrence: occurrence.date });
  }

  const visibleIds = calendars && hidden.size ? calendars.filter((calendar) => !hidden.has(calendar.id)).map((calendar) => calendar.id) : null;
  // A read-only Team role writes no events, even on calendars it owns (§2.4).
  const writable = canWrite ? (calendars ?? []).filter((calendar) => calendar.role !== "viewer" && !hidden.has(calendar.id)) : [];
  const writableAll = canWrite ? (calendars ?? []).filter((calendar) => calendar.role !== "viewer") : [];

  // ---- dialogs ---------------------------------------------------------------------------------

  // The event sheet, its Repeat sheet, and the Discard prompt guard themselves, one layer at a time (EventSheet.tsx).
  const dialogOpen = (confirm !== null && confirm.kind !== "discard") || calendarsOpen || sharing !== null || feeds !== null || picker !== null || reminderPicker !== null;
  const sheetDirty = sheet !== null && !sameForm(sheet.initial, sheet.form);

  function closeSheet() {
    setSheet(null);
    setRepeatOpen(false);
  }
  function requestCloseSheet() {
    if (sheetDirty) setConfirm({ kind: "discard" });
    else closeSheet();
  }
  const keepEditing = useCallback(() => setConfirm(null), []);

  // Back or Forward while a dialog is open closes the top one (D69).
  useDialogBackGuard(dialogOpen, (forced) => {
    if (forced) {
      setConfirm(null);
      closeSheet();
      setSharing(null);
      setFeeds(null);
      setPicker(null);
      setReminderPicker(null);
      setCalendarsOpen(false);
      return;
    }
    if (confirm) setConfirm(null);
    else if (picker) setPicker(null);
    else if (reminderPicker) setReminderPicker(null);
    else if (sharing) setSharing(null);
    else if (feeds) setFeeds(null);
    else setCalendarsOpen(false);
  });

  function startCreate(day: string) {
    const target = writable[0] ?? writableAll[0];
    if (!target) {
      flash("You can only view the calendars shared with you. Create your own calendar first.");
      return;
    }
    const form = newEventForm(day, today, new Date(), zone);
    setSheet({ mode: "create", initial: form, form, calendarId: target.id, event: null, busy: false, error: null, conflict: null });
  }

  function startEdit(data: EventResponse) {
    const form = formFromEvent(data.event, zone);
    setSheet({ mode: "edit", initial: form, form, calendarId: data.event.calendar_id, event: data.event, busy: false, error: null, conflict: null });
  }

  async function saveSheet() {
    if (!sheet) return;
    const result = formToInput(sheet.form);
    if ("error" in result) {
      setSheet({ ...sheet, error: result.error });
      return;
    }
    setSheet({ ...sheet, busy: true, error: null, conflict: null });
    try {
      if (sheet.mode === "create") {
        const created = await createEvent(sheet.calendarId, result.input);
        closeSheet();
        setReloadKey((value) => value + 1);
        flash(`Added “${created.event.title}”`);
      } else if (sheet.event) {
        await updateEvent(sheet.event.id, { ...result.input, revision: sheet.event.revision });
        closeSheet();
        setReloadKey((value) => value + 1);
        flash("Event saved");
      }
    } catch (reason) {
      if (errorCode(reason) === "EVENT_CHANGED") {
        const latest = ((reason as ApiError).payload as { event?: EventDetail }).event ?? null;
        setSheet((current) => current && { ...current, busy: false, error: "Someone else changed this event. Your edits are still here.", conflict: latest });
      } else {
        setSheet((current) => current && { ...current, busy: false, error: errorMessage(reason, "Could not save the event") });
      }
    }
  }

  function reloadConflict() {
    if (!sheet?.conflict) return;
    const form = formFromEvent(sheet.conflict, zone);
    setSheet({ ...sheet, event: sheet.conflict, initial: form, form, error: null, conflict: null });
  }

  async function undo(data: EventResponse) {
    try {
      await undoEvent(data.event.id, data.event.revision);
      setReloadKey((value) => value + 1);
      flash("Undid the last change");
    } catch (reason) {
      flash(errorCode(reason) === "EVENT_CHANGED" ? "The event changed again; reloaded the latest version" : errorMessage(reason, "Could not undo"));
      setReloadKey((value) => value + 1);
    }
  }

  async function skip(data: EventResponse, date: string) {
    try {
      await skipOccurrence(data.event.id, date, data.event.revision);
      setReloadKey((value) => value + 1);
      flash(`Skipped ${shortDate(date)}. Undo brings it back.`);
    } catch (reason) {
      flash(errorMessage(reason, "Could not skip this date"));
      setReloadKey((value) => value + 1);
    }
  }

  async function confirmAction() {
    if (!confirm) return;
    if (confirm.kind === "discard") {
      setConfirm(null);
      closeSheet();
      return;
    }
    setBusy(true);
    try {
      if (confirm.kind === "deleteEvent") {
        await deleteEvent(confirm.data.event.id);
        setConfirm(null);
        flash("Moved to the Bin");
        setReloadKey((value) => value + 1);
        back();
      } else {
        await deleteCalendar(confirm.calendar.id);
        setConfirm(null);
        flash(`Moved “${confirm.calendar.name}” to the Bin`);
        await loadCalendars();
        setReloadKey((value) => value + 1);
      }
    } catch (reason) {
      flash(errorMessage(reason, "Could not move it to the Bin"));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  function toggleTasks() {
    setShowTasks((current) => {
      writeShowTasks(userId, !current);
      return !current;
    });
  }

  async function addReminder(eventId: string, offset: number) {
    await addEventReminder(eventId, offset, zone);
    setReminderPicker(null);
    setReloadKey((value) => value + 1);
    flash("Reminder added. Only you will see it.");
  }

  async function dropReminder(reminder: ReminderSummary, allDay: boolean) {
    try {
      await removeReminder(reminder.id);
      flash(`Removed the reminder ${reminderLabel(reminder.offsetMinutes ?? 0, allDay).toLowerCase()}`);
    } catch (reason) {
      flash(errorMessage(reason, "Could not remove the reminder"));
    }
    setReloadKey((value) => value + 1);
  }

  async function linkNote(data: EventResponse, noteId: string) {
    await addEventLink(data.event.id, "note", noteId);
    setPicker(null);
    setReloadKey((value) => value + 1);
    flash("Note linked");
  }

  async function removeLink(data: EventResponse, link: EventResponse["links"][number]) {
    try {
      await removeEventLink(data.event.id, link.targetType, link.targetId);
      flash(`Removed the link to ${linkLabel(link)}`);
    } catch (reason) {
      flash(errorMessage(reason, "Could not remove the link"));
    }
    setReloadKey((value) => value + 1);
  }

  function toggleCalendar(calendar: CalendarSummary) {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(calendar.id)) next.delete(calendar.id);
      else next.add(calendar.id);
      writeHidden(userId, next);
      return next;
    });
  }

  async function addCalendar(name: string, color: CalendarColor) {
    setBusy(true);
    try {
      await createCalendar(name, color);
      await loadCalendars();
    } finally {
      setBusy(false);
    }
  }

  async function changeCalendar(calendar: CalendarSummary, patch: { name?: string; color?: CalendarColor }) {
    await updateCalendar(calendar.id, patch);
    await loadCalendars();
    setReloadKey((value) => value + 1);
  }

  // ---- views -----------------------------------------------------------------------------------

  const month = resolveMonth(route.month, today);
  const view = route.eventId ? "event" : route.view;
  const selectedDay = route.view === "month" && hint?.month === month ? hint.day : null;

  function selectDay(day: string) {
    if (!day.startsWith(month)) {
      // A day from the neighbouring month pages there (replacing the entry) with that day selected.
      go(monthRoute(monthOf(day)), true);
      writeHint({ month: monthOf(day), day, eventId: null, occurrence: null });
      return;
    }
    writeHint({ month, day, eventId: null, occurrence: null });
  }

  /** New event on a month day: selects it (paging to its month for a leading or trailing day) and opens the sheet. */
  function createOnDay(day: string) {
    selectDay(day);
    startCreate(day);
  }

  let content;
  if (route.eventId) {
    content = <EventView
      key={route.eventId}
      eventId={route.eventId}
      occurrence={hint?.eventId === route.eventId ? hint.occurrence : null}
      reloadKey={reloadKey}
      onBack={back}
      onMissing={() => { flash("Event not found"); go(agendaRoute(), true); }}
      onEdit={startEdit}
      onUndo={(data) => { void undo(data); }}
      onSkip={(data, date) => { void skip(data, date); }}
      onDelete={(data) => setConfirm({ kind: "deleteEvent", data })}
      renderReminders={(data) => <EventReminders eventId={data.event.id} allDay={data.event.all_day} reloadKey={reloadKey}
        onAdd={(existing) => setReminderPicker({ eventId: data.event.id, allDay: data.event.all_day, existing, event: data.event })}
        onRemove={(reminder) => { void dropReminder(reminder, data.event.all_day); }} />}
      renderLinks={(data) => <EventLinks data={data} canEdit={canWrite && data.role !== "viewer"} onOpenNote={onOpenNote} onAddNote={() => setPicker(data)} onRemove={(link) => { void removeLink(data, link); }} />}
    />;
  } else if (route.view === "month") {
    content = <MonthView
      month={month}
      today={today}
      compact={phone}
      selectedDay={selectedDay}
      calendarIds={visibleIds}
      showTasks={showTasks}
      reloadKey={reloadKey}
      canCreate={writableAll.length > 0}
      onSelectDay={selectDay}
      onOpen={openOccurrence}
      onCreate={createOnDay}
      onShiftMonth={(delta) => go(monthRoute(shiftMonth(month, delta)), true)}
      onToday={() => go(monthRoute(monthOf(today)), true)}
    />;
  } else {
    content = <AgendaView today={today} calendarIds={visibleIds} showTasks={showTasks} reloadKey={reloadKey} onOpen={openOccurrence} />;
  }

  return <main className={`app-page calendar-app calendar-view-${view}`}>
    <header className="app-page-header">
      <button className="app-home-button" onClick={onHome}><House />Home</button>
      <span className="app-home-brand"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><h1 className="app-page-title">Calendar</h1></span></span><AppPageName name="Calendar" />
      <AccountActions displayName={displayName} onSettings={onSettings} onSignOut={onSignOut} />
    </header>
    <ReadOnlyBanner />

    <div className="calendar-content">
      {!route.eventId && <div className="calendar-toolbar">
        <div className="calendar-view-switch" role="group" aria-label="View">
          <button className={route.view === "agenda" ? "active" : undefined} aria-pressed={route.view === "agenda"} onClick={() => { if (route.view !== "agenda") go(agendaRoute()); }}><List />Agenda</button>
          <button className={route.view === "month" ? "active" : undefined} aria-pressed={route.view === "month"} onClick={() => { if (route.view !== "month") go(monthRoute(monthOf(today))); }}><CalendarRange />Month</button>
        </div>
        <button className="secondary-button calendar-toolbar-button" onClick={() => setCalendarsOpen(true)} aria-haspopup="dialog"><Layers /><span>Calendars</span></button>
        {writableAll.length > 0 && <button className="primary-button calendar-toolbar-button" onClick={() => startCreate(route.view === "month" ? selectedDay ?? (today.startsWith(month) ? today : `${month}-01`) : today)}><Plus /><span>New event</span></button>}
      </div>}
      {calendars === null ? <p className="calendar-loading" role="status"><CalendarDays />Loading your calendars…</p> : content}
    </div>

    {sheet && !repeatOpen && confirm?.kind !== "discard" && <EventSheet
      mode={sheet.mode}
      form={sheet.form}
      calendars={writableAll}
      calendarId={sheet.calendarId}
      busy={sheet.busy}
      error={sheet.error}
      conflict={sheet.conflict !== null}
      onChange={(form) => setSheet((current) => current && { ...current, form })}
      onCalendarChange={(calendarId) => setSheet((current) => current && { ...current, calendarId })}
      onRepeat={() => setRepeatOpen(true)}
      onSave={() => { void saveSheet(); }}
      onReload={reloadConflict}
      onClose={requestCloseSheet}
    />}
    {sheet && repeatOpen && <RepeatSheet
      rule={sheet.form.repeat}
      startDate={sheet.form.startDate}
      onDone={(repeat) => { setSheet((current) => current && { ...current, form: { ...current.form, repeat } }); setRepeatOpen(false); }}
      onCancel={() => setRepeatOpen(false)}
    />}
    {calendarsOpen && !sharing && !feeds && !confirm && calendars && <CalendarsDialog
      calendars={calendars}
      hidden={hidden}
      busy={busy}
      onToggle={toggleCalendar}
      onCreate={addCalendar}
      onUpdate={changeCalendar}
      onShare={setSharing}
      onFeeds={setFeeds}
      onDelete={(calendar) => setConfirm({ kind: "deleteCalendar", calendar })}
      onClose={() => setCalendarsOpen(false)}
      showTasks={showTasks}
      onToggleTasks={toggleTasks}
    />}
    {reminderPicker && <ReminderPicker allDay={reminderPicker.allDay} existing={reminderPicker.existing} event={reminderPicker.event} timeZone={zone} onPick={(offset) => addReminder(reminderPicker.eventId, offset)} onClose={() => setReminderPicker(null)} />}
    {picker && <NoteLinkPicker linkedIds={picker.links.filter((link) => link.targetType === "note").map((link) => link.targetId)} onPick={(note) => linkNote(picker, note.id)} onClose={() => setPicker(null)} />}
    {feeds && <FeedDialog calendar={feeds} onClose={() => setFeeds(null)} flash={flash} />}
    {sharing && <CalendarSharePanel calendar={sharing} onClose={() => setSharing(null)} onSaved={() => { setSharing(null); flash("Sharing updated"); void loadCalendars(); }} />}
    {confirm?.kind === "discard" && <DiscardEventPrompt onDiscard={() => { void confirmAction(); }} onKeep={keepEditing} />}
    {confirm?.kind === "deleteEvent" && <ConfirmDialog title="Move to the Bin?" message={`Move “${confirm.data.event.title}”${confirm.data.event.repeat ? " and all its repeats" : ""} to the Bin? You can restore it for 30 days.`} confirmLabel="Move to Bin" danger busy={busy} onConfirm={() => { void confirmAction(); }} onCancel={() => setConfirm(null)} />}
    {confirm?.kind === "deleteCalendar" && <ConfirmDialog title="Move calendar to the Bin?" message={`Move “${confirm.calendar.name}” and its events to the Bin? You can restore it for 30 days.`} confirmLabel="Move to Bin" danger busy={busy} onConfirm={() => { void confirmAction(); }} onCancel={() => setConfirm(null)} />}
  </main>;
}
