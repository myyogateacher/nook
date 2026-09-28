import { api } from "../api";
import type { ItemLevel } from "../access/accessLevels";
import type { Visibility } from "../types";

export type CalendarColor = "blue" | "green" | "amber" | "red" | "violet" | "slate";
export type CalendarRole = "owner" | "editor" | "viewer";
export type ShareRole = "viewer" | "editor";
export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
export type RepeatRule = { freq: "daily" | "weekly" | "monthly" | "yearly"; interval: number; byDay?: Weekday[]; until?: string; count?: number };

export type CalendarSummary = {
  id: string;
  owner_id: string;
  owner_name: string;
  is_owner: 0 | 1;
  role: CalendarRole;
  /** The caller's level (Wave 32, §D.3): owner, manage, edit, or view; older servers omit it. */
  level?: ItemLevel;
  name: string;
  color: CalendarColor;
  visibility: Visibility;
  share_role: ShareRole;
  created_at: string;
  updated_at: string;
};

export type EventDetail = {
  id: string;
  calendar_id: string;
  title: string;
  description: string;
  location: string;
  all_day: boolean;
  start_date: string | null;
  end_date: string | null;
  start_local: string | null;
  tz: string | null;
  duration_minutes: number | null;
  repeat: RepeatRule | null;
  exdates: string[];
  revision: number;
  canUndo: boolean;
  changedByKey: boolean;
  changedByKeyName: string | null;
  created_by_name: string | null;
  updated_by_name: string | null;
  created_at: string;
  updated_at: string;
};

export type EventLink = { targetType: "note" | "card" | "collection_row"; targetId: string; title: string | null; restricted: boolean };
export type EventResponse = { event: EventDetail; calendar: CalendarSummary; role: CalendarRole; links: EventLink[] };

export type Occurrence = {
  eventId: string;
  calendarId: string;
  title: string;
  location: string;
  color: CalendarColor;
  allDay: boolean;
  date: string;
  start: string;
  end: string;
  recurring: boolean;
};

export type EventInput = {
  title: string;
  description?: string;
  location?: string;
  allDay: boolean;
  startDate?: string;
  endDate?: string;
  startLocal?: string;
  tz?: string;
  durationMinutes?: number;
  repeat?: RepeatRule | null;
};

/**
 * A card in the "Tasks due" overlay. Wave 13 (D100): a timed card carries its wall time and zone and
 * the exact instant, and `date` is the viewer's local day for it (`dueOn` for date-only cards).
 */
export type DueTask = {
  cardId: string; boardId: string; boardName: string; title: string; dueOn: string;
  /** The parent card on the same board (task hierarchy D138). */
  parentTitle?: string | null;
  dueTime?: string | null; dueTz?: string | null; dueAt?: string | null; date?: string;
};
export type OccurrenceList = { occurrences: Occurrence[]; truncated: boolean; tasks?: DueTask[] };

const json = (body: unknown) => JSON.stringify(body);

/** The viewer's IANA zone, as the browser reports it. */
export function viewerTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export const listCalendars = () => api<{ calendars: CalendarSummary[] }>("/calendars");
export const createCalendar = (name: string, color: CalendarColor) => api<{ calendar: CalendarSummary }>("/calendars", { method: "POST", body: json({ name, color }) });
export const updateCalendar = (id: string, patch: { name?: string; color?: CalendarColor }) => api<{ calendar: CalendarSummary }>(`/calendars/${id}`, { method: "PATCH", body: json(patch) });
export const deleteCalendar = (id: string) => api<{ ok: true; purgeAfter: string }>(`/calendars/${id}`, { method: "DELETE", body: "{}" });
export const getCalendarSharing = (id: string) => api<{ visibility: Visibility; shareRole: ShareRole; users: Array<{ id: string; display_name: string }> }>(`/calendars/${id}/sharing`);
export const saveCalendarSharing = (id: string, visibility: Visibility, shareRole: ShareRole, userIds: string[]) =>
  api<{ ok: true }>(`/calendars/${id}/sharing`, { method: "PUT", body: json({ visibility, shareRole, userIds: visibility === "selected" ? userIds : [] }) });

export function listOccurrences(from: string, to: string, options: { calendarIds?: string[]; includeTasks?: boolean } = {}) {
  const params = new URLSearchParams({ from, to, tz: viewerTimeZone() });
  if (options.calendarIds) params.set("calendars", options.calendarIds.join(","));
  if (options.includeTasks) params.set("include", "tasks");
  return api<OccurrenceList>(`/events?${params.toString()}`);
}

export const getEvent = (id: string) => api<EventResponse>(`/events/${id}`);
export const createEvent = (calendarId: string, input: EventInput) => api<EventResponse>(`/calendars/${calendarId}/events`, { method: "POST", body: json(input) });
export const updateEvent = (id: string, patch: Partial<EventInput> & { revision: number }) => api<EventResponse>(`/events/${id}`, { method: "PATCH", body: json(patch) });
export const undoEvent = (id: string, revision: number) => api<EventResponse>(`/events/${id}/undo`, { method: "POST", body: json({ revision }) });
export const skipOccurrence = (id: string, date: string, revision: number) => api<EventResponse>(`/events/${id}/exdates`, { method: "POST", body: json({ date, revision }) });
export const deleteEvent = (id: string) => api<{ ok: true; purgeAfter: string }>(`/events/${id}`, { method: "DELETE", body: "{}" });
export const addEventLink = (id: string, targetType: EventLink["targetType"], targetId: string) => api<{ link: EventLink }>(`/events/${id}/links`, { method: "POST", body: json({ targetType, targetId }) });
export const removeEventLink = (id: string, targetType: EventLink["targetType"], targetId: string) => api<{ ok: true }>(`/events/${id}/links`, { method: "DELETE", body: json({ targetType, targetId }) });

export type FeedDetail = "busy" | "full";
export type CalendarFeed = { id: string; calendarId: string; prefix: string; detail: FeedDetail; createdAt: string; lastUsedAt: string | null };
export const listFeeds = (calendarId: string) => api<{ feeds: CalendarFeed[] }>(`/calendars/${calendarId}/feeds`);
export const createFeed = (calendarId: string, detail: FeedDetail) => api<{ feed: CalendarFeed; token: string; url: string }>(`/calendars/${calendarId}/feeds`, { method: "POST", body: json({ detail }) });
export const revokeFeed = (feedId: string) => api<{ ok: true }>(`/feeds/${feedId}`, { method: "DELETE", body: "{}" });
