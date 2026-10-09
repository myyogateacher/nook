import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson, uuid } from "../validation";
// Registers calendars and events as Bin providers (server/bin.ts).
import "./calendarBin";
// Lends event responses their attachments (uploads everywhere U1).
import "./attachments";
import { LINK_TARGET_TYPES } from "./links";
import { MAX_COUNT, MAX_DURATION_MINUTES, MAX_EXDATES, MAX_INTERVAL, rangeFor, RecurrenceError, WEEKDAYS } from "./recurrence";
import {
  addEventLink,
  addExdate,
  CalendarError,
  createCalendar,
  createEvent,
  deleteCalendar,
  deleteEvent,
  getCalendarSharing,
  getEvent,
  listCalendars,
  listOccurrences,
  patchCalendar,
  patchEvent,
  putCalendarSharing,
  removeEventLink,
  undoEvent
} from "./service";
import { listDueTasks, type DueTask } from "./tasksOverlay";
import { registerPushRoutes } from "./pushRoutes";
import { registerReminderRoutes } from "./reminderRoutes";
import { registerFeedRoutes } from "./feeds";

// C0/C1 controls and bidi overrides never belong in a name, title, or location.
const controlCharacters = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;
const label = (max: number) => z.string().trim().min(1).max(max).refine((value) => !controlCharacters.test(value), "Names cannot contain control characters");
const plain = (max: number) => z.string().trim().max(max).refine((value) => !controlCharacters.test(value), "Text cannot contain control characters");
// Descriptions keep line breaks and tabs; the 8 KiB byte cap matches the column CHECK.
const description = z.string().refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/.test(value), "Text cannot contain control characters")
  .refine((value) => Buffer.byteLength(value, "utf8") <= 8192, "The description is too long");

const color = z.enum(["blue", "green", "amber", "red", "violet", "slate"]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates are yyyy-mm-dd");
const rule = z.object({
  freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).max(MAX_INTERVAL).default(1),
  byDay: z.array(z.enum(WEEKDAYS as [string, ...string[]])).min(1).max(7).optional(),
  until: date.optional(),
  count: z.number().int().min(1).max(MAX_COUNT).optional()
}).strict();

export const calendarCreateSchema = z.object({ name: label(80), color: color.default("blue") }).strict();
export const calendarPatchSchema = z.object({ name: label(80).optional(), color: color.optional() }).strict()
  .refine((value) => value.name !== undefined || value.color !== undefined, "Provide a name or a color");
export const calendarSharingSchema = z.object({
  visibility: z.enum(["private", "selected", "all_users"]),
  shareRole: z.enum(["viewer", "editor"]).default("viewer"),
  userIds: z.array(uuid).max(100).default([])
}).strict();

const eventFields = {
  title: label(200),
  description: description.optional(),
  location: plain(200).optional(),
  allDay: z.boolean(),
  startDate: date.optional(),
  endDate: date.optional(),
  startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Times are yyyy-mm-ddTHH:MM").optional(),
  tz: z.string().max(64).optional(),
  durationMinutes: z.number().int().min(1).max(MAX_DURATION_MINUTES).optional(),
  repeat: rule.nullable().optional()
};
export const eventCreateSchema = z.object(eventFields).strict();
export const eventPatchSchema = z.object({
  ...eventFields,
  title: eventFields.title.optional(),
  allDay: eventFields.allDay.optional(),
  revision: z.number().int().min(1)
}).strict();
export const revisionSchema = z.object({ revision: z.number().int().min(1) }).strict();
export const exdateSchema = z.object({ date, revision: z.number().int().min(1).optional() }).strict();
export const linkSchema = z.object({ targetType: z.enum(LINK_TARGET_TYPES as unknown as [string, ...string[]]), targetId: uuid }).strict();

const MAX_CALENDAR_FILTER = 50;

const id = (c: Context<AppEnv>, name: string) => uuid.parse(c.req.param(name));

/** Runs a service call and maps CalendarError to its JSON response; other errors reach app.onError. */
async function respond(c: Context<AppEnv>, operation: () => unknown, status: 200 | 201 = 200) {
  try {
    return c.json(await operation() as Record<string, unknown>, status);
  } catch (error) {
    if (error instanceof CalendarError) return c.json(error.body(), error.status);
    if (error instanceof RecurrenceError) return c.json({ error: error.message }, 400);
    throw error;
  }
}

type EventsQuery = { from: string; to: string; tz: string; calendarIds: string[] | null; includeTasks: boolean };

function parseEventsQuery(c: Context<AppEnv>): EventsQuery | string {
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  const tz = c.req.query("tz") ?? "UTC";
  const calendars = c.req.query("calendars");
  const include = c.req.query("include");
  let calendarIds: string[] | null = null;
  if (calendars !== undefined) {
    const ids = calendars.split(",").filter(Boolean);
    if (ids.length > MAX_CALENDAR_FILTER || ids.some((value) => !uuid.safeParse(value).success)) return "calendars must be up to 50 calendar ids";
    calendarIds = [...new Set(ids.map((value) => value.toLowerCase()))];
  }
  if (include !== undefined && include !== "" && include !== "tasks") return "include must be tasks";
  return { from, to, tz, calendarIds, includeTasks: include === "tasks" };
}

/** docs/plan/API_CONTRACTS.md § Calendar. JSON only; the global session, Origin, CSRF, and TOTP middleware apply. */
export function registerCalendarRoutes(app: Hono<AppEnv>) {
  registerReminderRoutes(app);
  registerPushRoutes(app);
  registerFeedRoutes(app);
  app.get("/api/calendars", (c) => c.json(listCalendars(c.get("user").id)));

  app.post("/api/calendars", async (c) => {
    const body = await parseJson(c.req.raw, calendarCreateSchema);
    return respond(c, () => createCalendar(c.get("user").id, body), 201);
  });

  app.patch("/api/calendars/:calendarId", async (c) => {
    const calendarId = id(c, "calendarId");
    const body = await parseJson(c.req.raw, calendarPatchSchema);
    return respond(c, () => patchCalendar(c.get("user").id, calendarId, body));
  });

  app.delete("/api/calendars/:calendarId", (c) => {
    const calendarId = id(c, "calendarId");
    return respond(c, () => deleteCalendar(c.get("user").id, calendarId));
  });

  app.get("/api/calendars/:calendarId/sharing", (c) => {
    const calendarId = id(c, "calendarId");
    return respond(c, () => getCalendarSharing(c.get("user").id, calendarId));
  });

  app.put("/api/calendars/:calendarId/sharing", async (c) => {
    const calendarId = id(c, "calendarId");
    const body = await parseJson(c.req.raw, calendarSharingSchema);
    return respond(c, () => putCalendarSharing(c.get("user").id, calendarId, body));
  });

  app.post("/api/calendars/:calendarId/events", async (c) => {
    const calendarId = id(c, "calendarId");
    const body = await parseJson(c.req.raw, eventCreateSchema);
    return respond(c, () => createEvent(c.get("user").id, calendarId, body as Parameters<typeof createEvent>[2]), 201);
  });

  app.get("/api/events", async (c) => {
    const query = parseEventsQuery(c);
    if (typeof query === "string") return c.json({ error: "Invalid request", details: [query] }, 400);
    return respond(c, () => {
      const userId = c.get("user").id;
      const range = rangeFor(query.from, query.to, query.tz);
      const result: ReturnType<typeof listOccurrences> & { tasks?: DueTask[] } = listOccurrences(userId, range, query.calendarIds);
      // The "Tasks due" overlay (D67): present only when asked for, empty until migration 011 adds cards.due_on.
      if (query.includeTasks) result.tasks = listDueTasks(userId, range, query.tz);
      return result;
    });
  });

  app.get("/api/events/:eventId", (c) => {
    const eventId = id(c, "eventId");
    return respond(c, () => getEvent(c.get("user").id, eventId));
  });

  app.patch("/api/events/:eventId", async (c) => {
    const eventId = id(c, "eventId");
    const body = await parseJson(c.req.raw, eventPatchSchema);
    return respond(c, () => patchEvent(c.get("user").id, eventId, body as Parameters<typeof patchEvent>[2]));
  });

  app.post("/api/events/:eventId/undo", async (c) => {
    const eventId = id(c, "eventId");
    const body = await parseJson(c.req.raw, revisionSchema);
    return respond(c, () => undoEvent(c.get("user").id, eventId, body.revision));
  });

  app.post("/api/events/:eventId/exdates", async (c) => {
    const eventId = id(c, "eventId");
    const body = await parseJson(c.req.raw, exdateSchema);
    return respond(c, () => addExdate(c.get("user").id, eventId, body.date, body.revision));
  });

  app.delete("/api/events/:eventId", (c) => {
    const eventId = id(c, "eventId");
    return respond(c, () => deleteEvent(c.get("user").id, eventId));
  });

  app.post("/api/events/:eventId/links", async (c) => {
    const eventId = id(c, "eventId");
    const body = await parseJson(c.req.raw, linkSchema);
    try {
      const result = addEventLink(c.get("user").id, eventId, body.targetType as never, body.targetId.toLowerCase());
      return c.json({ link: result.link }, result.status);
    } catch (error) {
      if (error instanceof CalendarError) return c.json(error.body(), error.status);
      throw error;
    }
  });

  app.delete("/api/events/:eventId/links", async (c) => {
    const eventId = id(c, "eventId");
    const body = await parseJson(c.req.raw, linkSchema);
    return respond(c, () => removeEventLink(c.get("user").id, eventId, body.targetType as never, body.targetId.toLowerCase()));
  });
}
