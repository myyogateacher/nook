import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, CalendarRange, House, Layers, List, Plus, Sparkles } from "lucide-react";
import { ApiError } from "../api";
import { AccountActions, AppPageName } from "../AppShell";
import { readHistoryDepth } from "../appShellNavigation";
import { createCalendarHistoryState, readCalendarHint, type CalendarHint } from "../calendarNavigation";
import { agendaRoute, calendarBackAction, eventRoute, localDate, monthOf, monthRoute, resolveMonth, shiftMonth, type CalendarRoute } from "../calendarRoute";
import { ConfirmDialog } from "../files/Dialog";
import { holdDialogSentinel, offerDialogReopen, popStateClosedDialog, useLayerOpener } from "../historyDialogs";
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
import { CalendarsDialog } from "./CalendarsDialog";
import { AccessSheet } from "../access/AccessSheet";
import { FeedDialog } from "./FeedDialog";
import { DiscardEventPrompt, EventSheet, RepeatSheet } from "./EventSheet";
import { EventLinks, linkLabel, NoteLinkPicker } from "./EventLinks";
import { addEventReminder, EventReminders, reminderLabel, ReminderPicker, removeReminder, type ReminderChannels, type ReminderSummary } from "./EventReminders";
import { EventView } from "./EventView";
import {
  applySheetAttachments,
  applySheetAttachmentChanges,
  notifySheetSaved,
  savedWithRemovals,
  attachmentRights,
  attachmentRoom,
  canRemoveAttachment,
  DEFAULT_EVENT_ATTACHMENT_LIMIT,
  discardSheetUploads,
  emptySheetAttachments,
  EventAttachmentsSection,
  limitMessage,
  SheetAttachmentsField,
  sheetAttachmentsDirty,
  sheetUploading,
  stagedFromDocument,
  stagedFromFile,
  uploadStaged,
  type SheetAttachmentState,
  type StagedAttachment
} from "./EventAttachments";
import { AttachmentPreview, AttachSheet } from "../ui/attachments";
import type { DocumentSummary } from "../types";
import { deleteFile } from "../files/filesApi";
import { notifyBinned } from "../bin/binUndo";
import { PHONE_QUERY, useDialogBackGuard, useMediaQuery, useReturnFocus } from "./hooks";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { MonthView } from "./MonthView";
import "../bin/bin.css";
import "../files/files.css";
import "./calendar.css";
import { ReadOnlyBanner, useRole } from "../team/roleAccess";
import { notify } from "../ui/notify";

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
  /** U1: the event's files and the sheet's staged changes to them, applied on Save. */
  attachments: SheetAttachmentState;
  attachmentLimit: number;
  /** The calendar's owner or a manager: may remove anyone's file from the event. */
  canManage: boolean;
};

/** A layer shown in place of the event sheet (U1): the Attach sheet, or one file's preview. */
type SheetLayer = { kind: "attach" } | { kind: "preview"; documentId: string; name: string };

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
  const [sheetLayer, setSheetLayer] = useState<SheetLayer | null>(null);
  const sheetUploads = useRef(new Map<string, AbortController>());
  const droppedUploads = useRef(new Set<string>());
  const [pendingConfirm, setConfirm] = useState<Confirm | null>(null);
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
      notify.error(errorMessage(reason, "Could not load your calendars"));
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
  const dialogOpen = (pendingConfirm !== null && pendingConfirm.kind !== "discard") || calendarsOpen || sharing !== null || feeds !== null || picker !== null || reminderPicker !== null;
  const sheetDirty = sheet !== null && (!sameForm(sheet.initial, sheet.form) || sheetAttachmentsDirty(sheet.attachments));
  // Each layer hands focus back to what opened it: the Calendars button, the Add reminder button,
  // and, for the Share, Subscribe, and Move-to-Bin layers that replace the Calendars sheet, that
  // calendar's button in the sheet once it is back (QA 0.12 item 3).
  useReturnFocus(calendarsOpen);
  useReturnFocus(reminderPicker !== null, ".calendar-link-add");
  useReturnFocus(sharing !== null);
  useReturnFocus(feeds !== null);
  useReturnFocus(pendingConfirm?.kind === "deleteCalendar", ".calendar-list .calendar-visibility");

  function closeSheet() {
    setSheet(null);
    setRepeatOpen(false);
    setSheetLayer(null);
  }
  /** Closes the sheet without saving: uploads in flight stop, and the ones it made go to the Bin (U1). */
  function discardSheet() {
    for (const item of sheet?.attachments.added ?? []) if (item.status === "uploading") dropSheetUpload(item);
    if (sheet) discardSheetUploads(sheet.attachments);
    closeSheet();
  }
  /**
   * Stops a staged upload the person no longer wants. Bytes still going up are aborted; an upload
   * whose bytes are all sent may already be stored, so it is left to finish and then moved to the
   * Bin (otherwise only the next-day sweep would find it).
   */
  function dropSheetUpload(item: StagedAttachment) {
    if (item.progress >= 1) droppedUploads.current.add(item.key);
    else sheetUploads.current.get(item.key)?.abort();
    sheetUploads.current.delete(item.key);
  }
  function requestCloseSheet() {
    if (sheetDirty) setConfirm({ kind: "discard" });
    else closeSheet();
  }
  const keepEditing = useCallback(() => setConfirm(null), []);

  // Back or Forward while a dialog is open closes the top one (D69).
  useDialogBackGuard(dialogOpen, (forced) => {
    // Share, Subscribe, and Move to Bin replace the Calendars sheet, which comes back when they close.
    // Back off the landing-entry sentinel closes only that layer: the Calendars sheet is still open,
    // so the sentinel goes back under it and the next Back closes it (one Back, one layer).
    if (forced && calendarsOpen && (sharing || feeds || pendingConfirm?.kind === "deleteCalendar") && holdDialogSentinel()) {
      if (sharing) setSharing(null);
      else if (feeds) setFeeds(null);
      else setConfirm(null);
      return "keep";
    }
    if (forced) {
      // Back off the phone sentinel lands here (the depths match): Forward onto the sentinel shows
      // the same layers again instead of a dead entry (Friction 12). A confirm is not reopened.
      const shown = { calendarsOpen, sharing, feeds, picker, reminderPicker };
      if (calendarsOpen || sharing || feeds || picker || reminderPicker) offerDialogReopen(() => {
        setCalendarsOpen(shown.calendarsOpen);
        setSharing(shown.sharing);
        setFeeds(shown.feeds);
        setPicker(shown.picker);
        setReminderPicker(shown.reminderPicker);
      });
      setConfirm(null);
      discardSheet();
      setSharing(null);
      setFeeds(null);
      setPicker(null);
      setReminderPicker(null);
      setCalendarsOpen(false);
      return;
    }
    if (pendingConfirm) setConfirm(null);
    else if (picker) setPicker(null);
    else if (reminderPicker) setReminderPicker(null);
    else if (sharing) setSharing(null);
    else if (feeds) setFeeds(null);
    else setCalendarsOpen(false);
  }, calendarsOpen ? "calendar.calendars" : undefined);

  // H3: Forward after Back went past Calendar and came back reopens the Calendars sheet, then Share or
  // Subscribe over it (once the calendars have loaded).
  const pendingCalendarLayer = useRef<{ kind: "share" | "feeds"; id: string } | null>(null);
  function openCalendarLayer(kind: "share" | "feeds", id: string) {
    const calendar = calendars?.find((item) => item.id === id);
    if (!calendar) { pendingCalendarLayer.current = { kind, id }; return; }
    if (kind === "share") setSharing(calendar);
    else setFeeds(calendar);
  }
  useLayerOpener("calendar.calendars", () => setCalendarsOpen(true));
  useLayerOpener("calendar.share", (id) => openCalendarLayer("share", id));
  useLayerOpener("calendar.feeds", (id) => openCalendarLayer("feeds", id));
  useEffect(() => {
    const pending = pendingCalendarLayer.current;
    if (!pending || !calendars) return;
    pendingCalendarLayer.current = null;
    const calendar = calendars.find((item) => item.id === pending.id);
    if (calendar && pending.kind === "share") setSharing(calendar);
    else if (calendar) setFeeds(calendar);
  }, [calendars]);

  // D479: Share, Subscribe, and Move to Bin replace the Calendars sheet and are a layer of their own,
  // on their own history entry (registered after the guard above, so asked first). Back closes only
  // that layer and the Calendars sheet comes back; Forward after Back shows Share or Subscribe again.
  // The Move-to-Bin confirm is never reopened.
  const overCalendars = calendarsOpen && (sharing !== null || feeds !== null || pendingConfirm?.kind === "deleteCalendar");
  const closeOverCalendars = useCallback(() => {
    if (sharing) setSharing(null);
    else if (feeds) setFeeds(null);
    else setConfirm(null);
  }, [feeds, sharing]);
  useHistoryDialogGuard(overCalendars, closeOverCalendars, {
    reopen: sharing ? () => setSharing(sharing) : feeds ? () => setFeeds(feeds) : null,
    layerKey: sharing ? `calendar.share:${sharing.id}` : feeds ? `calendar.feeds:${feeds.id}` : undefined
  });

  function startCreate(day: string) {
    const target = writable[0] ?? writableAll[0];
    if (!target) {
      notify.warning("You can only view the calendars shared with you. Create your own calendar first.");
      return;
    }
    const form = newEventForm(day, today, new Date(), zone);
    setSheet({ mode: "create", initial: form, form, calendarId: target.id, event: null, busy: false, error: null, conflict: null,
      attachments: emptySheetAttachments(), attachmentLimit: DEFAULT_EVENT_ATTACHMENT_LIMIT, canManage: true });
  }

  function startEdit(data: EventResponse) {
    const form = formFromEvent(data.event, zone);
    setSheet({ mode: "edit", initial: form, form, calendarId: data.event.calendar_id, event: data.event, busy: false, error: null, conflict: null,
      attachments: emptySheetAttachments(data.attachments), attachmentLimit: data.attachmentLimit ?? DEFAULT_EVENT_ATTACHMENT_LIMIT, canManage: attachmentRights(data, canWrite).canManage });
  }

  // ---- the event sheet's attachments (U1): staged until Save --------------------------------------

  const updateSheetAttachments = useCallback((change: (state: SheetAttachmentState) => SheetAttachmentState) => {
    setSheet((current) => current && { ...current, attachments: change(current.attachments) });
  }, []);

  const updateStaged = useCallback((key: string, patch: Partial<StagedAttachment>) => {
    updateSheetAttachments((state) => ({ ...state, added: state.added.map((item) => item.key === key ? { ...item, ...patch } : item) }));
  }, [updateSheetAttachments]);

  function startSheetUpload(item: StagedAttachment) {
    const controller = new AbortController();
    sheetUploads.current.set(item.key, controller);
    void uploadStaged(item, controller.signal, (key, patch) => {
      if (!droppedUploads.current.has(key)) return updateStaged(key, patch);
      if (!patch.documentId) return;
      droppedUploads.current.delete(key);
      void deleteFile(patch.documentId).catch(() => undefined);
    }).finally(() => { sheetUploads.current.delete(item.key); droppedUploads.current.delete(item.key); });
  }

  function addSheetFiles(files: File[]) {
    if (!sheet || !files.length) return;
    const room = attachmentRoom(sheet.attachments, sheet.attachmentLimit);
    if (files.length > room) notify.warning(room === 0 ? limitMessage(sheet.attachmentLimit) : `${limitMessage(sheet.attachmentLimit)} Only the first ${room} ${room === 1 ? "was" : "were"} added.`);
    const staged = files.slice(0, room).map(stagedFromFile);
    if (!staged.length) return;
    updateSheetAttachments((state) => ({ ...state, added: [...state.added, ...staged] }));
    for (const item of staged) startSheetUpload(item);
  }

  function pickSheetDocument(document: DocumentSummary, options: { confirmed: boolean }) {
    if (!sheet) return;
    const already = sheet.attachments.existing.some((item) => item.documentId === document.id && !sheet.attachments.removed.includes(document.id))
      || sheet.attachments.added.some((item) => item.documentId === document.id);
    if (already) {
      notify.warning(`“${document.name}” is already on this event`);
      return;
    }
    if (sheet.attachments.removed.includes(document.id)) {
      // Picked again after removing it: keep the link instead.
      updateSheetAttachments((state) => ({ ...state, removed: state.removed.filter((id) => id !== document.id) }));
      return;
    }
    if (attachmentRoom(sheet.attachments, sheet.attachmentLimit) === 0) {
      notify.warning(limitMessage(sheet.attachmentLimit));
      return;
    }
    updateSheetAttachments((state) => ({ ...state, added: [...state.added, stagedFromDocument(document, options.confirmed)] }));
  }

  function removeSheetStaged(key: string) {
    const item = sheet?.attachments.added.find((added) => added.key === key);
    if (item?.status === "uploading") dropSheetUpload(item);
    if (item) discardSheetUploads({ existing: [], removed: [], added: [item] });
    updateSheetAttachments((state) => ({ ...state, added: state.added.filter((added) => added.key !== key) }));
  }

  function retrySheetUpload(key: string) {
    const item = sheet?.attachments.added.find((added) => added.key === key);
    if (!item?.file) return;
    updateStaged(key, { status: "uploading", progress: 0, error: null });
    startSheetUpload({ ...item, status: "uploading" });
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
        const failures = await applySheetAttachments(created.event.id, sheet.attachments);
        closeSheet();
        setReloadKey((value) => value + 1);
        (failures.length ? notify.warning : notify.success)(failures.length ? `Added “${created.event.title}”, but ${failures.join("; ")}` : `Added “${created.event.title}”`);
      } else if (sheet.event) {
        const eventId = sheet.event.id;
        await updateEvent(eventId, { ...result.input, revision: sheet.event.revision });
        const { failures, removed } = await applySheetAttachmentChanges(eventId, sheet.attachments);
        closeSheet();
        setReloadKey((value) => value + 1);
        // One toast; when Save removed files, its Undo puts them all back in their places (the relink route).
        notifySheetSaved(failures.length ? `Event saved, but ${failures.join("; ")}` : savedWithRemovals("Event saved", removed),
          { warning: failures.length > 0, eventId, removals: removed, onUndone: () => setReloadKey((value) => value + 1) });
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
      notify.success("Undid the last change");
    } catch (reason) {
      notify.error(errorCode(reason) === "EVENT_CHANGED" ? "The event changed again; reloaded the latest version" : errorMessage(reason, "Could not undo"));
      setReloadKey((value) => value + 1);
    }
  }

  async function skip(data: EventResponse, date: string) {
    try {
      await skipOccurrence(data.event.id, date, data.event.revision);
      setReloadKey((value) => value + 1);
      notify.success(`Skipped ${shortDate(date)}. Undo brings it back.`);
    } catch (reason) {
      notify.error(errorMessage(reason, "Could not skip this date"));
      setReloadKey((value) => value + 1);
    }
  }

  async function confirmAction() {
    if (!pendingConfirm) return;
    if (pendingConfirm.kind === "discard") {
      setConfirm(null);
      discardSheet();
      return;
    }
    setBusy(true);
    try {
      if (pendingConfirm.kind === "deleteEvent") {
        const eventId = pendingConfirm.data.event.id;
        await deleteEvent(eventId);
        setConfirm(null);
        // Undo restores it through the Bin and redraws the grid (v0.35.0).
        notifyBinned("Moved to the Bin", [{ type: "event", id: eventId }], () => { setReloadKey((value) => value + 1); });
        setReloadKey((value) => value + 1);
        back();
      } else {
        const calendarId = pendingConfirm.calendar.id;
        await deleteCalendar(calendarId);
        setConfirm(null);
        notifyBinned(`Moved “${pendingConfirm.calendar.name}” to the Bin`, [{ type: "calendar", id: calendarId }], async () => {
          await loadCalendars();
          setReloadKey((value) => value + 1);
        });
        await loadCalendars();
        setReloadKey((value) => value + 1);
      }
    } catch (reason) {
      notify.error(errorMessage(reason, "Could not move it to the Bin"));
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

  async function addReminder(eventId: string, offset: number, channels: ReminderChannels) {
    await addEventReminder(eventId, offset, zone, channels);
    setReminderPicker(null);
    setReloadKey((value) => value + 1);
    notify.success("Reminder added. Only you will see it.");
  }

  async function dropReminder(reminder: ReminderSummary, allDay: boolean) {
    try {
      await removeReminder(reminder.id);
      notify.success(`Removed the reminder ${reminderLabel(reminder.offsetMinutes ?? 0, allDay).toLowerCase()}`);
    } catch (reason) {
      notify.error(errorMessage(reason, "Could not remove the reminder"));
    }
    setReloadKey((value) => value + 1);
  }

  async function linkNote(data: EventResponse, noteId: string) {
    await addEventLink(data.event.id, "note", noteId);
    setPicker(null);
    setReloadKey((value) => value + 1);
    notify.success("Note linked");
  }

  async function removeLink(data: EventResponse, link: EventResponse["links"][number]) {
    try {
      await removeEventLink(data.event.id, link.targetType, link.targetId);
      notify.success(`Removed the link to ${linkLabel(link)}`);
    } catch (reason) {
      notify.error(errorMessage(reason, "Could not remove the link"));
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
      onMissing={() => { notify.warning("Event not found"); go(agendaRoute(), true); }}
      onEdit={startEdit}
      onUndo={(data) => { void undo(data); }}
      onSkip={(data, date) => { void skip(data, date); }}
      onDelete={(data) => setConfirm({ kind: "deleteEvent", data })}
      renderReminders={(data) => <EventReminders eventId={data.event.id} allDay={data.event.all_day} reloadKey={reloadKey}
        onAdd={(existing) => setReminderPicker({ eventId: data.event.id, allDay: data.event.all_day, existing, event: data.event })}
        onRemove={(reminder) => { void dropReminder(reminder, data.event.all_day); }} />}
      renderAttachments={(data) => {
        const rights = attachmentRights(data, canWrite);
        return <EventAttachmentsSection data={data} canEdit={rights.canEdit} canManage={rights.canManage} flash={flash} onChanged={() => setReloadKey((value) => value + 1)} />;
      }}
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

    {sheet && !repeatOpen && !sheetLayer && pendingConfirm?.kind !== "discard" && <EventSheet
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
      onFiles={canWrite ? addSheetFiles : undefined}
      uploading={sheetUploading(sheet.attachments)}
      attachments={<SheetAttachmentsField
        state={sheet.attachments}
        limit={sheet.attachmentLimit}
        canAttach={canWrite}
        canRemoveExisting={(item) => canRemoveAttachment(item, { canEdit: canWrite, canManage: sheet.canManage })}
        onAttach={() => setSheetLayer({ kind: "attach" })}
        onOpen={(item) => setSheetLayer({ kind: "preview", documentId: item.documentId, name: item.name })}
        onRemove={(item) => {
          updateSheetAttachments((state) => ({ ...state, removed: [...state.removed, item.documentId] }));
          // Staged until Save: Undo takes the removal back (nothing has changed on the server yet).
          notify.success(`Removed ${item.removed ? "the removed file" : item.name}. It comes off the event when you save.`, {
            action: { label: "Undo", onClick: () => updateSheetAttachments((state) => ({ ...state, removed: state.removed.filter((id) => id !== item.documentId) })) }
          });
        }}
        onRetry={retrySheetUpload}
        onRemoveStaged={removeSheetStaged}
      />}
    />}
    {/* U1: the Attach sheet and a file's preview replace the event sheet while open (one dialog at a time); Back closes them first. */}
    {sheet && sheetLayer?.kind === "attach" && <AttachSheet hostNoun="event" closeOnPick onClose={() => setSheetLayer(null)} onFiles={addSheetFiles} onPickDocument={pickSheetDocument}
      disabledReason={attachmentRoom(sheet.attachments, sheet.attachmentLimit) === 0 ? limitMessage(sheet.attachmentLimit) : null} />}
    {sheet && sheetLayer?.kind === "preview" && <AttachmentPreview documentId={sheetLayer.documentId} name={sheetLayer.name} onClose={() => setSheetLayer(null)} />}
    {sheet && repeatOpen && <RepeatSheet
      rule={sheet.form.repeat}
      startDate={sheet.form.startDate}
      onDone={(repeat) => { setSheet((current) => current && { ...current, form: { ...current.form, repeat } }); setRepeatOpen(false); }}
      onCancel={() => setRepeatOpen(false)}
    />}
    {calendarsOpen && !sharing && !feeds && !pendingConfirm && calendars && <CalendarsDialog
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
    {reminderPicker && <ReminderPicker allDay={reminderPicker.allDay} existing={reminderPicker.existing} event={reminderPicker.event} timeZone={zone} onPick={(offset, channels) => addReminder(reminderPicker.eventId, offset, channels)} onClose={() => setReminderPicker(null)} />}
    {picker && <NoteLinkPicker linkedIds={picker.links.filter((link) => link.targetType === "note").map((link) => link.targetId)} onPick={(note) => linkNote(picker, note.id)} onClose={() => setPicker(null)} />}
    {feeds && <FeedDialog calendar={feeds} onClose={() => setFeeds(null)} flash={flash} />}
    {sharing && <AccessSheet kind="calendar" id={sharing.id} title={sharing.name} onClose={() => setSharing(null)} onSaved={() => { setSharing(null); notify.success("Access updated"); void loadCalendars(); }} />}
    {pendingConfirm?.kind === "discard" && <DiscardEventPrompt onDiscard={() => { void confirmAction(); }} onKeep={keepEditing} />}
    {pendingConfirm?.kind === "deleteEvent" && <ConfirmDialog title="Move to the Bin?" message={`Move “${pendingConfirm.data.event.title}”${pendingConfirm.data.event.repeat ? " and all its repeats" : ""} to the Bin? You can restore it for 30 days.`} confirmLabel="Move to Bin" danger busy={busy} onConfirm={() => { void confirmAction(); }} onCancel={() => setConfirm(null)} />}
    {pendingConfirm?.kind === "deleteCalendar" && <ConfirmDialog title="Move calendar to the Bin?" message={`Move “${pendingConfirm.calendar.name}” and its events to the Bin? You can restore it for 30 days.`} confirmLabel="Move to Bin" danger busy={busy} onConfirm={() => { void confirmAction(); }} onCancel={() => setConfirm(null)} />}
  </main>;
}
