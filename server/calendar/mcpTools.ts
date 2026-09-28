import * as z from "zod/v4";
import type { ZodType } from "zod";
import { config } from "../config";
import { withAuditContext } from "../db";
import { restoreItem } from "../bin";
import { BIN_BUCKETS, BIN_DESCRIPTION, defineTool, McpToolError, restoreResult, type McpErrorCode, type McpKeyContext, type McpToolSpec } from "../mcpToolKit";
import { readableEvent } from "./access";
import { keyMayRead } from "../keyReach";
import { RecurrenceError, rangeFor, zonedToUtc } from "./recurrence";
import { reminderSchema } from "./reminderRoutes";
import { createReminder, ReminderError } from "./reminders";
import { eventCreateSchema, eventPatchSchema } from "./routes";
import { CalendarError, createEvent, deleteEvent, getEvent, listCalendars, listOccurrences, patchEvent, type EventInput, type EventPatch } from "./service";

/**
 * MCP tools for Calendar (docs/plan/WAVES_10-12.md §4.5, D70, T72–T75).
 *
 * Tools call the same services as /api/calendars, /api/events, and /api/reminders, as the key's
 * owner, so readable/editable checks, IDOR joins, recurrence limits, and caps live in one place.
 * A calendar or event the user cannot read is NOT_FOUND whether it is missing, private, or
 * binned. Writes are create and update, with a revision compare-and-swap, plus (Wave 19)
 * bin_event/restore_event with bin:write; there are no delete-forever, exdate, share, or feed tools. Every write is audited with `{via: "mcp", keyId}`, marks
 * `updated_via_key_id` (the "Changed by key" note, undoable in the app), and counts against the
 * per-key and per-user daily buckets. Reminders are always the key owner's own.
 */

const eventUrl = (eventId: string) => `${config.appOrigin}/calendar/event/${eventId}`;

export function calendarErrorToMcp(error: CalendarError | ReminderError) {
  const known: Partial<Record<string, McpErrorCode>> = {
    EVENT_CHANGED: "EVENT_CHANGED",
    READ_ONLY: "READ_ONLY",
    OWNER_ONLY: "OWNER_ONLY",
    LIMIT_REACHED: "LIMIT_REACHED",
    REMINDER_EXISTS: "REMINDER_EXISTS"
  };
  const code = (error.code ? known[error.code] : undefined) ?? (error.status === 404 ? "NOT_FOUND" : error.status === 400 ? "INVALID" : "INTERNAL");
  const extra = error instanceof CalendarError && typeof error.extra.revision === "number" ? { currentRevision: error.extra.revision } : undefined;
  return new McpToolError(code, error.message, extra);
}

async function service<T>(key: McpKeyContext, operation: () => T | Promise<T>): Promise<T> {
  try {
    return await withAuditContext({ via: "mcp", keyId: key.keyId }, operation);
  } catch (error) {
    if (error instanceof CalendarError || error instanceof ReminderError) throw calendarErrorToMcp(error);
    if (error instanceof RecurrenceError) throw new McpToolError("INVALID", error.message);
    throw error;
  }
}

/** Validates with the HTTP route's schema, so MCP accepts exactly what the API accepts. */
function routeInput<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new McpToolError("INVALID", "Invalid arguments", { details: parsed.error.issues.map((issue) => issue.message) });
  return parsed.data;
}

/** Minutes between two local wall times in `tz`, for callers that give an end instead of a duration. */
function minutesBetween(startLocal: string, endLocal: string, tz: string) {
  try {
    const minutes = Math.round((zonedToUtc(endLocal, tz) - zonedToUtc(startLocal, tz)) / 60_000);
    if (minutes < 1) throw new McpToolError("INVALID", "end must be after start");
    return minutes;
  } catch (error) {
    if (error instanceof McpToolError) throw error;
    throw new McpToolError("INVALID", "start and end must be local times as yyyy-mm-ddTHH:MM in a valid tz");
  }
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates are yyyy-mm-dd");
const moment = z.string().max(16).describe("All-day: yyyy-mm-dd. Timed: local time yyyy-mm-ddTHH:MM in tz");
const repeat = z.object({
  freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().optional(),
  byDay: z.array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"])).optional(),
  until: date.optional(),
  count: z.number().int().optional()
}).describe("Repeat rule: freq, interval 1-99, byDay for weekly, and until (a date) or count (up to 730)");

const eventFields = {
  title: z.string().max(200),
  allDay: z.boolean(),
  start: moment,
  end: moment.optional().describe("All-day: exclusive end date (defaults to the next day). Timed: local end time; or give durationMinutes"),
  durationMinutes: z.number().int().optional(),
  tz: z.string().max(64).optional().describe("IANA time zone of a timed event, such as Europe/Berlin"),
  repeat: repeat.nullable().optional(),
  description: z.string().optional().describe("Plain text, up to 8 KiB"),
  location: z.string().max(200).optional()
};

/** Maps the MCP event shape to the HTTP body (EventInput) for a create. */
function createBody(args: { title: string; allDay: boolean; start: string; end?: string; durationMinutes?: number; tz?: string; repeat?: unknown; description?: string; location?: string }) {
  const body: Record<string, unknown> = { title: args.title, allDay: args.allDay };
  if (args.description !== undefined) body.description = args.description;
  if (args.location !== undefined) body.location = args.location;
  if (args.repeat !== undefined) body.repeat = args.repeat;
  if (args.allDay) {
    body.startDate = args.start;
    body.endDate = args.end ?? (date.safeParse(args.start).success ? nextDay(args.start) : undefined);
  } else {
    body.startLocal = args.start;
    body.tz = args.tz;
    body.durationMinutes = args.durationMinutes ?? (args.end && args.tz ? minutesBetween(args.start, args.end, args.tz) : undefined);
  }
  return routeInput(eventCreateSchema, body) as EventInput;
}

function nextDay(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10);
}

/**
 * Plain event fields for an agent: descriptions are plain text, links are titles or `restricted`.
 * A link is restricted when the user cannot open its target (T59) or the key may not (T203: the
 * key needs the target module's read grant, inside its chosen boards or collections if it has any).
 */
function eventOutput(result: ReturnType<typeof getEvent>, key: McpKeyContext) {
  const { event, calendar, role, links } = result;
  return {
    event: {
      id: event.id,
      calendarId: event.calendar_id,
      calendarName: calendar.name,
      title: event.title,
      description: event.description,
      location: event.location,
      allDay: event.all_day,
      start: event.all_day ? event.start_date : event.start_local,
      end: event.all_day ? event.end_date : null,
      tz: event.tz,
      durationMinutes: event.duration_minutes,
      repeat: event.repeat,
      exdates: event.exdates,
      updatedAt: event.updated_at
    },
    revision: event.revision,
    role,
    links: links.map((link) => link.restricted || !keyMayRead(key, { type: link.targetType, id: link.targetId }) ? { targetType: link.targetType, restricted: true } : { targetType: link.targetType, targetId: link.targetId, title: link.title }),
    url: eventUrl(event.id)
  };
}

const uuid = z.string().uuid();

export const calendarTools: McpToolSpec[] = [
  defineTool({
    name: "list_calendars",
    title: "List calendars",
    description: "List the calendars the user owns or that are shared with them, with the user's role on each (owner, editor, or viewer).",
    scopes: ["calendar:read"],
    listFilter: { field: "calendars", kind: "calendar" },
    write: false,
    inputSchema: z.object({}),
    handler: (_args, key) => ({
      calendars: listCalendars(key.userId).calendars.map((calendar) => ({ id: calendar.id, name: calendar.name, role: calendar.role, color: calendar.color, ownerName: calendar.owner_name }))
    })
  }),
  defineTool({
    name: "list_events",
    title: "List events",
    description: "List event occurrences between two dates (at most 100 days), repeats expanded. Timed starts and ends are UTC instants; all-day ones are dates with an exclusive end. Use get_event for descriptions and links.",
    scopes: ["calendar:read"],
    write: false,
    inputSchema: z.object({
      from: date,
      to: date.describe("Exclusive end date; at most 100 days after from"),
      calendarIds: z.array(uuid).max(50).optional().describe("Only these calendars"),
      tz: z.string().max(64).optional().describe("IANA time zone that from and to are in; defaults to UTC")
    }),
    handler: async ({ from, to, calendarIds, tz }, key) => service(key, () => {
      const range = rangeFor(from, to, tz ?? "UTC");
      const result = listOccurrences(key.userId, range, calendarIds ? [...new Set(calendarIds.map((id) => id.toLowerCase()))] : null);
      return {
        occurrences: result.occurrences.map((item) => ({
          eventId: item.eventId, calendarId: item.calendarId, title: item.title, location: item.location,
          start: item.start, end: item.end, allDay: item.allDay, recurring: item.recurring, date: item.date
        })),
        truncated: result.truncated
      };
    })
  }),
  defineTool({
    name: "get_event",
    title: "Get an event",
    description: "Read one event: timing, repeat rule, skipped dates, plain-text description, links (titles, or restricted when the user cannot open them), and the revision update_event needs.",
    scopes: ["calendar:read"],
    resource: { arg: "eventId", kind: "event" },
    write: false,
    inputSchema: z.object({ eventId: uuid }),
    handler: async ({ eventId }, key) => service(key, () => eventOutput(getEvent(key.userId, eventId.toLowerCase()), key))
  }),
  defineTool({
    name: "create_event",
    title: "Create an event",
    description: "Add an event to a calendar the user owns or may edit. All-day: start and end are dates (end exclusive). Timed: start is a local time in tz, with durationMinutes or a local end.",
    scopes: ["calendar:write"],
    resource: { arg: "calendarId", kind: "calendar" },
    write: true,
    dailyBucket: "event_write",
    inputSchema: z.object({ calendarId: uuid, ...eventFields }),
    handler: async ({ calendarId, ...fields }, key) => {
      const input = createBody(fields);
      return service(key, () => {
        const { event } = createEvent(key.userId, calendarId.toLowerCase(), input, { keyId: key.keyId });
        return { eventId: event.id, revision: event.revision, url: eventUrl(event.id) };
      });
    }
  }),
  defineTool({
    name: "update_event",
    title: "Update an event",
    description: "Change fields of an event on a calendar the user owns or may edit. baseRevision must be the revision from get_event; if the event changed since, the call fails with EVENT_CHANGED and the current revision. The change can be undone in Nook.",
    scopes: ["calendar:write"],
    resource: { arg: "eventId", kind: "event" },
    write: true,
    dailyBucket: "event_write",
    inputSchema: z.object({
      eventId: uuid,
      baseRevision: z.number().int().min(1),
      title: eventFields.title.optional(),
      allDay: z.boolean().optional(),
      start: moment.optional(),
      end: moment.optional(),
      durationMinutes: z.number().int().optional(),
      tz: eventFields.tz,
      repeat: eventFields.repeat,
      description: eventFields.description,
      location: eventFields.location
    }),
    handler: async ({ eventId, baseRevision, start, end, ...fields }, key) => service(key, () => {
      const id = eventId.toLowerCase();
      const current = readableEvent(id, key.userId);
      if (!current) throw new McpToolError("NOT_FOUND", "Event not found");
      const allDay = fields.allDay ?? current.event.all_day === 1;
      const body: Record<string, unknown> = { revision: baseRevision };
      for (const [name, value] of Object.entries(fields)) if (value !== undefined) body[name] = value;
      if (allDay) {
        if (start !== undefined) body.startDate = start;
        if (end !== undefined) body.endDate = end;
        else if (start !== undefined && date.safeParse(start).success) body.endDate = nextDay(start);
      } else {
        if (start !== undefined) body.startLocal = start;
        if (end !== undefined && fields.durationMinutes === undefined) {
          const zone = fields.tz ?? current.event.tz;
          const from = start ?? current.event.start_local;
          if (!zone || !from) throw new McpToolError("INVALID", "A timed event needs start and tz to use end");
          body.durationMinutes = minutesBetween(from, end, zone);
        }
      }
      const patch = routeInput(eventPatchSchema, body) as EventPatch;
      const { event } = patchEvent(key.userId, id, patch, { keyId: key.keyId });
      return { eventId: event.id, revision: event.revision, url: eventUrl(event.id) };
    })
  }),
  defineTool({
    name: "create_reminder",
    title: "Create a reminder",
    description: "Set a reminder for the user who owns this key (never anyone else): either offsetMinutes before each occurrence of an event they can read (negative is after the start; 09:00 on an all-day event is -540), or a standalone title at a local fireAt time in tz.",
    scopes: ["calendar:write"],
    resource: { arg: "eventId", kind: "event" },
    write: true,
    dailyBucket: "reminder_write",
    inputSchema: z.object({
      eventId: uuid.optional(),
      offsetMinutes: z.number().int().optional(),
      title: z.string().max(200).optional(),
      fireAt: z.string().max(16).optional().describe("Local time yyyy-mm-ddTHH:MM in tz"),
      tz: z.string().max(64).optional().describe("IANA time zone; defaults to UTC")
    }),
    handler: async ({ eventId, offsetMinutes, title, fireAt, tz }, key) => {
      const zone = tz ?? "UTC";
      const body = eventId !== undefined
        ? { eventId, offsetMinutes, tz: zone }
        : { title, fireAt, tz: zone };
      if (eventId !== undefined && (title !== undefined || fireAt !== undefined)) throw new McpToolError("INVALID", "Give eventId and offsetMinutes, or title and fireAt, not both");
      const input = routeInput(reminderSchema, body);
      return service(key, () => {
        const normalized = "eventId" in input ? { ...input, eventId: input.eventId.toLowerCase() } : input;
        const { reminder } = createReminder(key.userId, normalized, { keyId: key.keyId });
        return { reminderId: reminder.id, nextFireAt: reminder.nextFireAt, eventId: reminder.eventId };
      });
    }
  }),
  // Wave 19 (§2.3): the Bin, with bin:write as well (D172, D174).
  defineTool({
    name: "bin_event",
    title: "Move an event to the Bin",
    description: `Move an event on a calendar the user may edit to the Bin, with all its occurrences. ${BIN_DESCRIPTION} Restore it with restore_event.`,
    scopes: ["calendar:write"],
    resource: { arg: "eventId", kind: "event" },
    alsoRequires: ["bin:write"],
    write: true,
    buckets: BIN_BUCKETS,
    inputSchema: z.object({ eventId: uuid }).strict(),
    handler: async ({ eventId }, key) => service(key, () => {
      const { purgeAfter } = deleteEvent(key.userId, eventId.toLowerCase());
      return { eventId, binned: true, purgeAfter };
    })
  }),
  defineTool({
    name: "restore_event",
    title: "Restore an event from the Bin",
    description: "Restore a binned event. Only the calendar owner, or whoever binned it while they can still edit the calendar, can restore it. An event whose calendar is in the Bin fails with PARENT_IN_BIN.",
    scopes: ["calendar:write"],
    resource: { arg: "eventId", kind: "event" },
    alsoRequires: ["bin:write"],
    write: true,
    inputSchema: z.object({ eventId: uuid }).strict(),
    handler: async ({ eventId }, key) => service(key, async () => {
      const result = restoreResult(await restoreItem("event", eventId.toLowerCase(), key.userId), "Event") as Record<string, unknown>;
      return { eventId, restored: true, ...(result.alreadyRestored ? { alreadyRestored: true } : {}), calendarId: result.calendarId, url: eventUrl(eventId) };
    })
  })
];
