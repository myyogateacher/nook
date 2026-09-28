import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson, uuid } from "../validation";
import { db } from "../db";
import { mailEnabled } from "../mail";
import {
  createReminder,
  deleteReminder,
  listNotifications,
  listReminders,
  markNotificationsRead,
  MAX_NOTIFICATIONS_PAGE,
  MAX_OFFSET_MINUTES,
  MAX_READ_IDS,
  MIN_OFFSET_MINUTES,
  REMINDER_CHANNELS,
  ReminderError
} from "./reminders";

const controlCharacters = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;
const tz = z.string().min(1).max(64);
/** Wave 29: where the reminder goes besides the bell. Push only when left out. */
const channels = z.enum(REMINDER_CHANNELS).optional();

export const reminderSchema = z.union([
  z.object({ eventId: uuid, offsetMinutes: z.number().int().min(MIN_OFFSET_MINUTES).max(MAX_OFFSET_MINUTES), tz, channels }).strict(),
  z.object({
    title: z.string().trim().min(1).max(200).refine((value) => !controlCharacters.test(value), "Titles cannot contain control characters"),
    fireAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Times are yyyy-mm-ddTHH:MM"),
    tz,
    channels
  }).strict()
]);
export const readSchema = z.union([
  z.object({ ids: z.array(uuid).min(1).max(MAX_READ_IDS) }).strict(),
  z.object({ all: z.literal(true) }).strict()
]);

function respond(c: Context<AppEnv>, operation: () => unknown, status: 200 | 201 = 200) {
  try {
    return c.json(operation() as Record<string, unknown>, status);
  } catch (error) {
    if (error instanceof ReminderError) return c.json(error.body(), error.status);
    throw error;
  }
}

const invalid = (c: Context<AppEnv>, detail: string) => c.json({ error: "Invalid request", details: [detail] }, 400);

/** docs/plan/API_CONTRACTS.md § Reminders and notifications. Everything is scoped to the caller. */
export function registerReminderRoutes(app: Hono<AppEnv>) {
  app.get("/api/reminders", (c) => {
    const eventId = c.req.query("eventId");
    if (eventId !== undefined && !uuid.safeParse(eventId).success) return invalid(c, "eventId must be an event id");
    return c.json(listReminders(c.get("user").id, eventId?.toLowerCase() ?? null));
  });

  app.post("/api/reminders", async (c) => {
    const body = await parseJson(c.req.raw, reminderSchema);
    // Email needs mail on and a verified address (D244); the picker says so before anyone gets here.
    if (body.channels && body.channels !== "push") {
      if (!mailEnabled()) return c.json({ error: "Email is off on this Nook", code: "EMAIL_OFF" }, 409);
      const verified = (db.query("SELECT email_verified_at FROM users WHERE id = ?").get(c.get("user").id) as { email_verified_at: string | null }).email_verified_at;
      if (!verified) return c.json({ error: "Verify your email address in Settings → Notifications first", code: "EMAIL_UNVERIFIED" }, 409);
    }
    const input = "eventId" in body ? { ...body, eventId: body.eventId.toLowerCase() } : body;
    return respond(c, () => createReminder(c.get("user").id, input), 201);
  });

  app.delete("/api/reminders/:reminderId", (c) => {
    const reminderId = uuid.parse(c.req.param("reminderId")).toLowerCase();
    return respond(c, () => deleteReminder(c.get("user").id, reminderId));
  });

  app.get("/api/notifications", (c) => {
    const unread = c.req.query("unread");
    const limitText = c.req.query("limit");
    if (unread !== undefined && !["1", "0", "true", "false"].includes(unread)) return invalid(c, "unread must be 1 or 0");
    const limit = limitText === undefined ? 20 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NOTIFICATIONS_PAGE) return invalid(c, `limit must be 1 to ${MAX_NOTIFICATIONS_PAGE}`);
    return c.json(listNotifications(c.get("user").id, { unread: unread === "1" || unread === "true", limit }));
  });

  app.post("/api/notifications/read", async (c) => {
    const body = await parseJson(c.req.raw, readSchema);
    return c.json(markNotificationsRead(c.get("user").id, "all" in body ? { all: true } : { ids: body.ids.map((value) => value.toLowerCase()) }));
  });
}
