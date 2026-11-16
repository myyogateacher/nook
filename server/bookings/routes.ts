import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../auth";
import { db } from "../db";
import type { ModuleRouter } from "../workspaceRegistry";
import { QuestionError } from "../questions/service";
import { PeopleError, readableBookIds, readableContact } from "../people/contacts";
import { addDays, isValidTimeZone, zonedToUtc } from "../../shared/calendarRecurrence";
import { ASSIGNMENTS, BOOKING_STATUSES, LOCATION_KINDS, MAX_SLOT_WINDOW_DAYS, slotsByDate, windowProblem, type BookingStatus } from "../../shared/bookings";
import { BookingError, readableBookingSql, requireBooking, requireType, typeRow, type BookingRow } from "./model";
import { createSchedule, deleteOverride, deleteSchedule, ensureProfile, listSchedules, putOverride, resetHandle, updateProfile, updateSchedule } from "./setup";
import { createSecretLink, createType, deleteType, listSecretLinks, listTypes, revokeSecretLink, saveTypeQuestions, typeQuestions, typeView, updateType } from "./types";
import { availability } from "./availability";
import { approveBooking, bookingView, cancelBooking, createBooking, declineBooking, markNoShow, rescheduleBooking } from "./service";
import { addFeed, FeedError, listFeeds, refreshFeed, removeFeed } from "./feeds";
import { bookingsInsights } from "./insights";
import { bookableByHost, bookingForm, MAX_BOOKABLE_HOSTS, requireTypeForBooking } from "./bookable";
import { workKindAdapter } from "../links/adapters";
import { csvResponse } from "../csvExport";
import { bookingsCsv } from "./export";

/**
 * The app's Bookings routes (§D.6 HTTP), behind every session, CSRF, two-factor, and role-write
 * guard (D815). Errors are `{ error, code }`; anything unreadable is NOT_FOUND (T90 pattern).
 * Guests have no Bookings (§G.1 Q8): every route answers them 404.
 */

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/);
const range = z.object({ from: time, to: time });
const weekly = z.record(z.string(), z.array(range).max(8));
const uuid = z.string().min(6).max(64);

const typeFields = {
  title: z.string().min(1).max(120).optional(),
  slug: z.string().min(1).max(60).optional(),
  description: z.string().max(4000).optional(),
  durations: z.array(z.number().int()).min(1).max(6).optional(),
  locationKind: z.enum(LOCATION_KINDS).optional(),
  locationValue: z.string().max(500).optional(),
  assignment: z.enum(ASSIGNMENTS).optional(),
  scheduleId: uuid.nullable().optional(),
  calendarId: uuid.nullable().optional(),
  busyCalendarIds: z.array(uuid).max(20).optional(),
  includeAllDayBusy: z.boolean().optional(),
  bufferBefore: z.number().int().min(0).max(240).optional(),
  bufferAfter: z.number().int().min(0).max(240).optional(),
  minNotice: z.number().int().min(0).max(43200).optional(),
  maxDaysAhead: z.number().int().min(1).max(365).optional(),
  dateFrom: z.string().nullable().optional(),
  dateTo: z.string().nullable().optional(),
  slotInterval: z.number().int().optional(),
  dailyLimit: z.number().int().min(1).max(100).nullable().optional(),
  weeklyLimit: z.number().int().min(1).max(500).nullable().optional(),
  confirm: z.enum(["auto", "manual"]).optional(),
  pendingHours: z.number().int().min(1).max(168).optional(),
  verifyEmail: z.boolean().optional(),
  hourlyCap: z.number().int().min(1).max(500).optional(),
  contactBookId: uuid.nullable().optional(),
  card: z.object({ boardId: uuid, columnId: uuid, titleTemplate: z.string().max(200), assignHost: z.boolean() }).nullable().optional(),
  reminders: z.object({ offsets: z.array(z.number().int()).max(3), booker: z.boolean(), host: z.boolean() }).optional(),
  color: z.string().max(9).optional(),
  public: z.boolean().optional(),
  status: z.enum(["active", "hidden"]).optional(),
  hosts: z.array(z.object({ userId: uuid, priority: z.number().int().min(0).max(10).optional(), calendarId: uuid.nullable().optional(), scheduleId: uuid.nullable().optional() })).max(20).optional(),
  expectedRevision: z.number().int().min(1).optional()
};
export const typeCreateSchema = z.object({ ...typeFields, title: z.string().min(1).max(120) }).strict();
export const typePatchSchema = z.object(typeFields).strict();
export const bookerSchema = z.object({
  name: z.string().min(1).max(120), email: z.string().min(3).max(254), guests: z.array(z.string().max(254)).max(10).optional(), tz: z.string().max(64),
  location: z.string().max(500).nullable().optional(), answers: z.record(z.string(), z.unknown()).optional()
});

export function sendError(c: Context<AppEnv>, error: unknown) {
  if (error instanceof BookingError) return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
  if (error instanceof FeedError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof QuestionError) return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
  if (error instanceof PeopleError) return c.json({ error: error.message, code: error.code }, error.status);
  throw error;
}

const handle = (fn: (c: Context<AppEnv>, userId: string) => Response | Promise<Response>) => async (c: Context<AppEnv>) => {
  const user = c.get("user");
  if (user.role === "guest") return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
  try {
    return await fn(c, user.id);
  } catch (error) {
    return sendError(c, error);
  }
};

async function body<S extends z.ZodType>(c: Context<AppEnv>, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new BookingError(400, "INVALID", "Send JSON"); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BookingError(400, "INVALID", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ").slice(0, 300));
  return parsed.data;
}

/** A slot window from the query (dates in `tz`, at most 62 days). */
export function windowFrom(query: { from?: string; to?: string; tz?: string }, maxDays: number, nowMs = Date.now()) {
  const tz = query.tz && isValidTimeZone(query.tz) ? query.tz : "UTC";
  const from = query.from ?? new Date(nowMs).toISOString().slice(0, 10);
  const to = query.to ?? addDays(from, Math.min(maxDays, 31));
  const problem = windowProblem(from, to, maxDays);
  if (problem) throw new BookingError(400, "INVALID", problem);
  return { tz, from, to, fromMs: zonedToUtc(`${from}T00:00`, tz), toMs: zonedToUtc(`${to}T00:00`, tz) };
}

export type ListFilter = { status?: string; from?: string; to?: string; type?: string; cursor?: string; limit?: number; typeIds?: string[] | null; view?: "upcoming" | "past" | "cancelled" | "pending" };

/** Keyset pages of readable bookings (T583): upcoming ascending; past and cancelled descending. */
export function listBookings(userId: string, filter: ListFilter, nowMs = Date.now()) {
  const limit = Math.min(100, Math.max(1, filter.limit ?? 50));
  const nowIso = new Date(nowMs).toISOString();
  const where = [readableBookingSql("b")];
  const params: Record<string, string | number> = { userId, limit: limit + 1 };
  let order: "ASC" | "DESC" = "ASC";
  const view = filter.view;
  if (view === "upcoming") { where.push("b.status IN ('pending','confirmed') AND b.end_utc > $now"); params.now = nowIso; }
  else if (view === "pending") { where.push("b.status = 'pending' AND b.end_utc > $now"); params.now = nowIso; }
  else if (view === "past") { where.push("b.status IN ('confirmed','completed','no_show') AND b.end_utc <= $now"); params.now = nowIso; order = "DESC"; }
  else if (view === "cancelled") { where.push("b.status IN ('cancelled','declined','expired')"); order = "DESC"; }
  if (filter.status) {
    const statuses = filter.status.split(",").filter((status) => (BOOKING_STATUSES as readonly string[]).includes(status)) as BookingStatus[];
    if (statuses.length) where.push(`b.status IN (${statuses.map((status) => `'${status}'`).join(",")})`);
  }
  if (filter.from) { where.push("b.start_utc >= $from"); params.from = filter.from; }
  if (filter.to) { where.push("b.start_utc < $to"); params.to = filter.to; }
  if (filter.type) { where.push("b.type_id = (SELECT id FROM booking_types WHERE id = $type OR short_id = $type)"); params.type = filter.type.toLowerCase(); }
  if (filter.typeIds) { where.push("b.type_id IN (SELECT value FROM json_each($typeIds))"); params.typeIds = JSON.stringify(filter.typeIds); }
  if (filter.cursor) {
    const [start, id] = Buffer.from(filter.cursor, "base64url").toString("utf8").split("|");
    if (start && id) { where.push(order === "ASC" ? "(b.start_utc, b.id) > ($cs, $ci)" : "(b.start_utc, b.id) < ($cs, $ci)"); params.cs = start; params.ci = id; }
  }
  const rows = db.query(`SELECT b.* FROM bookings b WHERE ${where.join(" AND ")} ORDER BY b.start_utc ${order}, b.id ${order} LIMIT $limit`).all(params) as BookingRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map((row) => bookingView(row, userId)), nextCursor: rows.length > limit && last ? Buffer.from(`${last.start_utc}|${last.id}`).toString("base64url") : null };
}

const RECORD_CONTACTS: Record<"contact" | "company" | "deal", string> = {
  contact: "SELECT id FROM contacts WHERE id = $id",
  company: "SELECT id FROM contacts WHERE company_id = $id",
  deal: "SELECT contact_id AS id FROM deal_contacts WHERE deal_id = $id"
};

/**
 * Bookings of a CRM record (C20, D1058): a contact's, a company's people's, or a deal's contacts', newest
 * first, at most 20. The viewer must read the record (its work kind's level) and each booking
 * (readableBookingSql, T583), so a CRM reader never sees bookings they could not open in Bookings.
 */
export function bookingsForRecord(userId: string, kind: string, ref: string) {
  if (kind !== "contact" && kind !== "company" && kind !== "deal") throw new BookingError(400, "INVALID", "Bookings are listed for a contact, a company, or a deal");
  const id = ref.toLowerCase();
  if ((workKindAdapter(kind)?.level(id, { userId }) ?? "none") === "none") throw new BookingError(404, "NOT_FOUND", "Record not found");
  const rows = db.query(`SELECT b.* FROM bookings b WHERE b.contact_id IN (${RECORD_CONTACTS[kind]}) AND ${readableBookingSql("b")} ORDER BY b.start_utc DESC, b.id DESC LIMIT 21`)
    .all({ id, userId }) as BookingRow[];
  return { items: rows.slice(0, 20).map((row) => bookingView(row, userId)), truncated: rows.length > 20 };
}

export function registerBookingRoutes(router: ModuleRouter) {
  router.get("/api/bookings/for/:kind/:id", handle((c, userId) => c.json(bookingsForRecord(userId, c.req.param("kind") ?? "", c.req.param("id") ?? ""))));
  // Profile and outside calendars
  // `?tz=` is the browser's zone: a first visit makes the profile and working hours there, not in UTC (D1129).
  router.get("/api/bookings/profile", handle((c, userId) => c.json({ profile: ensureProfile(userId, c.req.query("tz")?.slice(0, 64)), feeds: listFeeds(userId) })));
  router.put("/api/bookings/profile", handle(async (c, userId) => {
    const input = await body(c, z.object({ handle: z.string().max(40).optional(), displayName: z.string().max(80).optional(), welcome: z.string().max(2000).optional(), tz: z.string().max(64).optional(), enabled: z.boolean().optional(), busyCalendarIds: z.array(uuid).max(20).optional() }).strict());
    return c.json({ profile: updateProfile(userId, input) });
  }));
  router.post("/api/bookings/profile/:userId/reset-handle", handle((c, userId) => {
    if (c.get("user").role !== "admin") throw new BookingError(403, "ADMIN_ONLY", "Only admins can reset a link name");
    return c.json({ profile: resetHandle(userId, c.req.param("userId") ?? "") });
  }));
  // D1384: the members' booking link names for Settings → Team's "Reset booking link name" (admins, one
  // batched read for the members on screen). Members without a booking profile are left out.
  router.get("/api/bookings/admin/handles", handle((c) => {
    if (c.get("user").role !== "admin") throw new BookingError(403, "ADMIN_ONLY", "Only admins see members' booking link names");
    const ids = [...new Set((c.req.query("users") ?? "").split(",").map((id) => id.trim().toLowerCase()).filter((id) => /^[0-9a-f-]{6,64}$/.test(id)))];
    if (ids.length > MAX_BOOKABLE_HOSTS) throw new BookingError(400, "INVALID", `Ask for at most ${MAX_BOOKABLE_HOSTS} members at a time`);
    if (!ids.length) return c.json({ handles: {} });
    const rows = db.query(`SELECT user_id, handle FROM booking_profiles WHERE user_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ user_id: string; handle: string }>;
    return c.json({ handles: Object.fromEntries(rows.map((row) => [row.user_id, row.handle])) });
  }));
  router.get("/api/bookings/feeds", handle((c, userId) => c.json({ feeds: listFeeds(userId) })));
  router.post("/api/bookings/feeds", handle(async (c, userId) => {
    const input = await body(c, z.object({ label: z.string().max(80).default(""), url: z.string().min(8).max(2048) }).strict());
    const feed = addFeed(userId, input);
    await refreshFeed(feed.id);
    return c.json({ feed: listFeeds(userId).find((item) => item.id === feed.id) }, 201);
  }));
  router.post("/api/bookings/feeds/:id/refresh", handle(async (c, userId) => {
    const feed = listFeeds(userId).find((item) => item.id === c.req.param("id"));
    if (!feed) throw new BookingError(404, "NOT_FOUND", "Calendar not found");
    await refreshFeed(feed.id);
    return c.json({ feed: listFeeds(userId).find((item) => item.id === feed.id) });
  }));
  router.delete("/api/bookings/feeds/:id", handle((c, userId) => { removeFeed(userId, c.req.param("id") ?? ""); return c.body(null, 204); }));

  // Schedules and overrides
  router.get("/api/bookings/schedules", handle((c, userId) => c.json({ schedules: listSchedules(userId, c.req.query("tz")?.slice(0, 64)) })));
  router.post("/api/bookings/schedules", handle(async (c, userId) => {
    const input = await body(c, z.object({ name: z.string().max(60), tz: z.string().max(64), weekly: weekly.optional(), isDefault: z.boolean().optional() }).strict());
    return c.json({ schedule: createSchedule(userId, input) }, 201);
  }));
  router.put("/api/bookings/schedules/:id", handle(async (c, userId) => {
    const input = await body(c, z.object({ name: z.string().max(60).optional(), tz: z.string().max(64).optional(), weekly: weekly.optional(), isDefault: z.boolean().optional() }).strict());
    return c.json({ schedule: updateSchedule(userId, c.req.param("id") ?? "", input) });
  }));
  router.delete("/api/bookings/schedules/:id", handle((c, userId) => { deleteSchedule(userId, c.req.param("id") ?? ""); return c.body(null, 204); }));
  router.put("/api/bookings/schedules/:id/overrides", handle(async (c, userId) => {
    const input = await body(c, z.object({ date: z.string().max(10), ranges: z.array(range).max(8).nullable(), note: z.string().max(100).optional() }).strict());
    return c.json({ schedule: putOverride(userId, c.req.param("id") ?? "", input) });
  }));
  router.delete("/api/bookings/schedules/:id/overrides/:date", handle((c, userId) => c.json({ schedule: deleteOverride(userId, c.req.param("id") ?? "", c.req.param("date") ?? "") })));

  // Types
  router.get("/api/bookings/types", handle((c, userId) => c.json({ types: listTypes(userId, { mine: c.req.query("mine") === "1" }) })));
  router.post("/api/bookings/types", handle(async (c, userId) => c.json({ type: createType(userId, await body(c, typeCreateSchema)) }, 201)));
  router.get("/api/bookings/types/:id", handle((c, userId) => c.json({ type: typeView(requireType(c.req.param("id") ?? "", userId).type, userId) })));
  router.patch("/api/bookings/types/:id", handle(async (c, userId) => c.json({ type: updateType(userId, c.req.param("id") ?? "", await body(c, typePatchSchema)) })));
  router.delete("/api/bookings/types/:id", handle((c, userId) => c.json(deleteType(userId, c.req.param("id") ?? ""))));
  // The contact books a type may upsert bookers into (books the caller can edit; the type editor's picker).
  router.get("/api/bookings/contact-books", handle((c, userId) => {
    const ids = readableBookIds(userId, "edit");
    const books = ids.length ? db.query("SELECT id, name FROM contact_books WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND system_kind IS NULL ORDER BY name COLLATE NOCASE").all(JSON.stringify(ids)) : [];
    return c.json({ books });
  }));
  // A booking-link embed in a note (§B.4.4): a public, active type shows its public card to any member
  // (the page is public anyway); otherwise only readers of the type see it.
  router.get("/api/bookings/types/:id/embed", handle((c, userId) => {
    const row = typeRow(c.req.param("id") ?? "");
    if (!row || row.deleted_at !== null) throw new BookingError(404, "NOT_FOUND", "Booking type not found");
    const view = typeView(row, userId);
    if (view.level === "none" && !view.publicPath) throw new BookingError(404, "NOT_FOUND", "Booking type not found");
    return c.json({ title: view.title, publicPath: view.publicPath, durations: view.durations, ownerName: view.ownerName });
  }));
  router.get("/api/bookings/types/:id/questions", handle((c, userId) => c.json(typeQuestions(userId, c.req.param("id") ?? ""))));
  router.put("/api/bookings/types/:id/questions", handle(async (c, userId) => {
    const input = await body(c, z.object({ set: z.unknown(), publish: z.boolean().optional() }).strict());
    return c.json(saveTypeQuestions(userId, c.req.param("id") ?? "", input.set, input.publish === true));
  }));
  // "Book time with …" (D1250): the in-app booking sheet's type, place, and published questions.
  router.get("/api/bookings/types/:id/form", handle((c, userId) => c.json(bookingForm(userId, c.req.param("id") ?? ""))));
  router.get("/api/bookings/types/:id/slots", handle(async (c, userId) => {
    // Readers see any status (the type editor's preview); a public, open type is bookable by any member (D1251).
    const type = requireTypeForBooking(c.req.param("id") ?? "", userId, { preview: true });
    const window = windowFrom(c.req.query(), MAX_SLOT_WINDOW_DAYS);
    const duration = Number(c.req.query("duration") ?? JSON.parse(type.durations_json)[0]);
    const slots = await availability(type, { fromMs: window.fromMs, toMs: window.toMs, durationMin: duration, nowMs: Date.now() });
    return c.json({ tz: window.tz, duration, days: slotsByDate([...slots.keys()], window.tz) });
  }));
  router.get("/api/bookings/types/:id/secret-links", handle((c, userId) => c.json({ links: listSecretLinks(userId, c.req.param("id") ?? "") })));
  router.post("/api/bookings/types/:id/secret-links", handle(async (c, userId) => {
    const input = await body(c, z.object({ singleUse: z.boolean().optional(), expiresInDays: z.number().int().min(1).max(365).nullable().optional(), label: z.string().max(80).optional() }).strict());
    return c.json({ link: createSecretLink(userId, c.req.param("id") ?? "", input) }, 201);
  }));
  router.delete("/api/bookings/types/:id/secret-links/:linkId", handle((c, userId) => { revokeSecretLink(userId, c.req.param("id") ?? "", c.req.param("linkId") ?? ""); return c.body(null, 204); }));

  // Who offers bookable types, for the Team list (D1250): one batched read, `?users=a,b,…` (at most 500) or everyone.
  router.get("/api/bookings/bookable", handle((c, userId) => {
    const raw = c.req.query("users");
    const hostIds = raw === undefined ? null : [...new Set(raw.split(",").map((id) => id.trim().toLowerCase()).filter((id) => /^[0-9a-f-]{6,64}$/.test(id)))];
    if (hostIds && hostIds.length > MAX_BOOKABLE_HOSTS) throw new BookingError(400, "INVALID", `Ask for at most ${MAX_BOOKABLE_HOSTS} members at a time`);
    return c.json({ hosts: bookableByHost(userId, { hostIds }) });
  }));

  // Bookings
  router.get("/api/bookings", handle((c, userId) => {
    const query = c.req.query();
    return c.json(listBookings(userId, { ...query, view: query.view as ListFilter["view"], limit: query.limit ? Number(query.limit) : undefined }));
  }));
  // D1387: the bookings list as CSV, with the list's filters.
  router.get("/api/bookings/export.csv", handle((c, userId) => {
    const query = c.req.query();
    const view = ["upcoming", "past", "cancelled", "pending"].includes(query.view ?? "") ? query.view as ListFilter["view"] : undefined;
    return csvResponse(bookingsCsv(userId, { view, status: query.status, from: query.from, to: query.to, type: query.type }), `bookings-${view ?? "all"}.csv`);
  }));
  router.get("/api/bookings/insights", handle((c, userId) => c.json(bookingsInsights(userId, { days: Number(c.req.query("days") ?? 90), tz: c.req.query("tz") ?? "UTC" }))));
  router.post("/api/bookings", handle(async (c, userId) => {
    // Booking as yourself takes your zone, the place (when the type asks), guests, and intake answers alongside (D1252).
    const input = await body(c, z.object({
      type: z.string().max(64), start: z.string().max(40), duration: z.number().int().optional(), booker: bookerSchema.optional(), contactId: uuid.optional(),
      tz: z.string().max(64).optional(), location: z.string().max(500).nullable().optional(), guests: z.array(z.string().max(254)).max(10).optional(), answers: z.record(z.string(), z.unknown()).optional()
    }).strict());
    // A hidden type books only for its owner; a colleague's public, open type books for any member (D1251).
    const type = requireTypeForBooking(input.type, userId);
    let booker = input.booker;
    let contactId: string | null = null;
    if (input.contactId) {
      const contact = readableContact(input.contactId, userId);
      if (!contact) throw new BookingError(404, "NOT_FOUND", "Contact not found");
      if (!contact.email) throw new BookingError(400, "INVALID", "That contact has no email address");
      booker = { name: contact.displayName, email: contact.email, tz: booker?.tz ?? "UTC", answers: booker?.answers };
      contactId = contact.id;
    }
    if (!booker) {
      const me = db.query("SELECT display_name, email FROM users WHERE id = ?").get(userId) as { display_name: string; email: string };
      booker = { name: me.display_name, email: me.email, tz: input.tz && isValidTimeZone(input.tz) ? input.tz : "UTC", location: input.location ?? null, guests: input.guests, answers: input.answers };
    }
    await availability(type, { fromMs: Date.parse(input.start) - 86_400_000, toMs: Date.parse(input.start) + 86_400_000, durationMin: input.duration ?? JSON.parse(type.durations_json)[0], nowMs: Date.now() }).catch(() => null);
    const created = createBooking({ type, start: input.start, durationMin: input.duration ?? JSON.parse(type.durations_json)[0], booker, source: "internal", actorId: userId, contactId });
    return c.json({ booking: bookingView(created.booking, userId), mailQueued: created.mailQueued }, 201);
  }));
  router.get("/api/bookings/b/:id", handle((c, userId) => c.json({ booking: bookingView(requireBooking(c.req.param("id") ?? "", userId).booking, userId, { answers: true }) })));
  const message = z.object({ message: z.string().max(500).optional() }).strict();
  router.post("/api/bookings/b/:id/approve", handle(async (c, userId) => {
    await body(c, message).catch(() => ({}));
    return c.json({ booking: bookingView(approveBooking(requireBooking(c.req.param("id") ?? "", userId, true).booking, userId), userId) });
  }));
  router.post("/api/bookings/b/:id/decline", handle(async (c, userId) => {
    const input = await body(c, message);
    return c.json({ booking: bookingView(declineBooking(requireBooking(c.req.param("id") ?? "", userId, true).booking, userId, input.message ?? null), userId) });
  }));
  router.post("/api/bookings/b/:id/cancel", handle(async (c, userId) => {
    const input = await body(c, message);
    const { booking, access } = requireBooking(c.req.param("id") ?? "", userId);
    return c.json({ booking: bookingView(cancelBooking(booking, access === "booker" ? "booker" : "host", userId, input.message ?? null), userId) });
  }));
  router.post("/api/bookings/b/:id/reschedule", handle(async (c, userId) => {
    const input = await body(c, z.object({ start: z.string().max(40), message: z.string().max(500).optional() }).strict());
    const { booking, access } = requireBooking(c.req.param("id") ?? "", userId);
    const created = rescheduleBooking(booking, { start: input.start, by: access === "booker" ? "booker" : "host", actorId: userId, reason: input.message ?? null });
    return c.json({ booking: bookingView(created.booking, userId) });
  }));
  router.post("/api/bookings/b/:id/no-show", handle((c, userId) => c.json({ booking: bookingView(markNoShow(requireBooking(c.req.param("id") ?? "", userId, true).booking, userId), userId) })));
  router.get("/api/bookings/b/:id/slots", handle(async (c, userId) => {
    const { booking } = requireBooking(c.req.param("id") ?? "", userId);
    const { type } = requireType(booking.type_id ?? "", userId);
    const window = windowFrom(c.req.query(), MAX_SLOT_WINDOW_DAYS);
    const slots = await availability(type, { fromMs: window.fromMs, toMs: window.toMs, durationMin: booking.duration_min, nowMs: Date.now(), excludeBookingId: booking.id });
    return c.json({ tz: window.tz, duration: booking.duration_min, days: slotsByDate([...slots.keys()], window.tz) });
  }));
}
