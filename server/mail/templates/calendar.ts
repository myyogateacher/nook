import { cleanLine } from "../html";
import { context, layout, note, type ContextRow } from "../layout";
import { appLink, paths } from "../links";
import { formatDay, formatInstant } from "../format";
import { activityFooter, actorsPhrase, itemTitle } from "./common";
import { defineTemplate } from "./types";

/** When an occurrence happens: a day for all-day events, else an instant in the given zone. */
export type OccurrenceTime = { allDay: boolean; start: string };
export const formatOccurrence = (time: OccurrenceTime, tz: string) => time.allDay ? `${formatDay(time.start.slice(0, 10))} (all day)` : formatInstant(time.start, tz);

// --- Reminder by email (#22) -------------------------------------------------------------------

export type ReminderMail = {
  /** An event reminder, or a standalone one with the user's own title. */
  kind: "event" | "standalone";
  title: string;
  eventId: string | null;
  /** The occurrence the reminder is for (event reminders), else null. */
  time: OccurrenceTime | null;
  location: string | null;
  calendarName: string | null;
  /** The reminder's own zone (§A.2 #22: "start in reminder tz"). */
  tz: string;
  /** Fired more than 15 minutes after its time (the server was down, or mail was held). */
  late: boolean;
};

/** A reminder counts as late in mail after this (§A.2 #22). */
export const REMINDER_LATE_MS = 15 * 60_000;

export const reminderTemplate = defineTemplate<ReminderMail>({
  name: "calendar.reminder",
  class: "reminders",
  category: "reminders",
  render(data, ctx) {
    const title = itemTitle(data.title, data.kind === "event" ? "Untitled event" : "Reminder");
    const when = data.time ? formatOccurrence(data.time, data.tz) : null;
    const rows: ContextRow[] = [{
      title,
      meta: [when, data.location ? cleanLine(data.location, 120) : null, data.calendarName ? `Calendar ${itemTitle(data.calendarName)}` : null].filter(Boolean).join(" · ") || undefined
    }];
    const late = data.late ? " (late)" : "";
    return layout({
      instanceName: ctx.instanceName,
      subject: `Reminder: ‘${title}’${when ? ` at ${when}` : ""}${late}`,
      preheader: when ? `${title}, ${when}.` : `${title}.`,
      eyebrow: data.kind === "event" ? "Calendar · Reminder" : "Reminder",
      title: data.kind === "event" ? "Your event is coming up" : "Your reminder",
      lead: data.late ? "This reminder is late: Nook could not send it on time." : undefined,
      blocks: [context(rows), note("You set this reminder yourself. Only you get it.")],
      action: data.kind === "event" && data.eventId ? { label: "Open event", href: appLink(paths.event(data.eventId)) } : { label: "Open notifications", href: appLink(paths.notifications()) },
      footer: activityFooter("reminders", "You got this because you chose email for this reminder in Nook.", ctx)
    });
  },
  fixture: () => ({
    kind: "event",
    title: "Design review",
    eventId: "9d4a9e02-5f6b-4a7c-8d8e-555555555555",
    time: { allDay: false, start: "2026-10-01T09:30:00.000Z" },
    location: "Room 2",
    calendarName: "Team calendar",
    tz: "Europe/Berlin",
    late: false
  })
});

// --- Event changed or cancelled (#24) ---------------------------------------------------------

export type EventChangeMail = {
  eventId: string;
  title: string;
  calendarName: string;
  change: "changed" | "cancelled";
  actors: string[];
  before: { time: OccurrenceTime | null; location: string };
  /** The event now (changed only). */
  after: { time: OccurrenceTime | null; location: string } | null;
};

export const eventChangedTemplate = defineTemplate<EventChangeMail>({
  name: "calendar.event_changed",
  class: "reminders",
  category: "reminders",
  render(data, ctx) {
    const title = itemTitle(data.title, "Untitled event");
    const who = actorsPhrase(data.actors);
    const cancelled = data.change === "cancelled";
    const was = data.before.time ? formatOccurrence(data.before.time, ctx.tz) : null;
    const now = data.after?.time ? formatOccurrence(data.after.time, ctx.tz) : null;
    const rows: ContextRow[] = cancelled
      ? [{ title, meta: [was ? `Was ${was}` : null, data.before.location ? cleanLine(data.before.location, 120) : null].filter(Boolean).join(" · ") || undefined }]
      : [{
        title,
        meta: [
          was && now && was !== now ? `Was ${was}` : null,
          now ? `Now ${now}` : null,
          data.after && data.after.location !== data.before.location ? `Place ${data.after.location ? cleanLine(data.after.location, 120) : "removed"}` : null
        ].filter(Boolean).join(" · ") || undefined
      }];
    return layout({
      instanceName: ctx.instanceName,
      subject: cancelled ? `‘${title}’ was cancelled` : `‘${title}’ changed${now ? `: now ${now}` : ""}`,
      preheader: `On the calendar ${itemTitle(data.calendarName)}.`,
      eyebrow: cancelled ? "Calendar · Cancelled" : "Calendar · Changed",
      title: cancelled ? `${who} cancelled an event` : `${who} changed an event`,
      lead: `On the calendar ${itemTitle(data.calendarName)}. You have a reminder on it.`,
      blocks: [context(rows), ...(cancelled ? [note("It is in the Bin now. Your reminder on it is paused.")] : [])],
      action: cancelled ? { label: "Open calendar", href: appLink(paths.calendar()) } : { label: "Open event", href: appLink(paths.event(data.eventId)) },
      footer: activityFooter("reminders", "You got this because you set a reminder on this event, and someone else changed it.", ctx)
    });
  },
  fixture: () => ({
    eventId: "9d4a9e02-5f6b-4a7c-8d8e-555555555555",
    title: "Design review",
    calendarName: "Team calendar",
    change: "changed",
    actors: ["Priya Shah"],
    before: { time: { allDay: false, start: "2026-10-01T09:30:00.000Z" }, location: "Room 2" },
    after: { time: { allDay: false, start: "2026-10-01T11:00:00.000Z" }, location: "Room 4" }
  })
});
