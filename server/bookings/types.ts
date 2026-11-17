import { audit, db, now } from "../db";
import { purgeAfterFrom, registerBinProvider, SWEEP_BATCH_SIZE, type BinItem, type BinSweepCounts, type PurgeOutcome, type RestoreOutcome } from "../bin";
import { withResourceLock } from "../storage";
import { recordItemActivity } from "../activity/service";
import { readableContainerSql } from "../access/workspaceItems";
import { canEditBook } from "../people/contacts";
import { readableCalendar } from "../calendar/access";
import { createPublicLink, listPublicLinks, revokePublicLink, revokePublicLinksOf } from "../public";
import { currentSet, draftSet, publishSet, saveDraftSet } from "../questions/service";
import { slugify } from "../../shared/friendlyUrls";
import { isValidDate } from "../../shared/calendarRecurrence";
import { emptyQuestionSet, type QuestionSet } from "../../shared/questions";
import { ASSIGNMENTS, LOCATION_KINDS, MAX_DURATIONS, MAX_HOSTS, MAX_REMINDERS, SLOT_INTERVALS, SLUG_PATTERN, type Assignment, type CardTemplate, type LocationKind, type ReminderSettings } from "../../shared/bookings";
import { atLeast, BookingError, cardTemplateOf, durationsOf, hostsOf, invalid, notFound, parseJson, remindersOf, requireType, typeHref, typeLevel, typeRow, userName, type TypeRow } from "./model";
import { ensureProfile, profileRow } from "./setup";

/**
 * Booking types (§D.6): the `booking_type` access container. Owners and managers edit everything;
 * editors edit the type's content; readers see it. Writes are one transaction with audit and item
 * activity; `expectedRevision` makes concurrent edits a 409 `TYPE_CHANGED`. Deleting moves the type
 * to the Bin (bookings stay, showing its saved title, D1015) and revokes its secret links.
 */

export const MAX_TYPES_PER_OWNER = 50;
export const MAX_SECRET_LINKS = 20;

export type TypeInput = {
  title?: string; slug?: string; description?: string; durations?: number[]; locationKind?: LocationKind; locationValue?: string; assignment?: Assignment;
  scheduleId?: string | null; calendarId?: string | null; busyCalendarIds?: string[]; includeAllDayBusy?: boolean; bufferBefore?: number; bufferAfter?: number;
  minNotice?: number; maxDaysAhead?: number; dateFrom?: string | null; dateTo?: string | null; slotInterval?: number; dailyLimit?: number | null; weeklyLimit?: number | null;
  confirm?: "auto" | "manual"; pendingHours?: number; verifyEmail?: boolean; hourlyCap?: number; contactBookId?: string | null; card?: CardTemplate | null;
  reminders?: ReminderSettings; color?: string; public?: boolean; status?: "active" | "hidden";
  hosts?: Array<{ userId: string; priority?: number; calendarId?: string | null; scheduleId?: string | null }>;
  expectedRevision?: number;
};

export type TypeView = ReturnType<typeof typeView>;

export function typeView(type: TypeRow, viewerId: string) {
  const level = typeLevel(type.id, viewerId);
  const profile = profileRow(type.owner_id);
  const shared = parseJson<string[]>(type.busy_calendar_ids_json, []);
  return {
    id: type.id, shortId: type.short_id, slug: type.slug, title: type.title, description: type.description_md, durations: durationsOf(type),
    locationKind: type.location_kind, locationValue: type.location_value, assignment: type.assignment, scheduleId: type.schedule_id, calendarId: type.calendar_id,
    busyCalendarIds: shared, includeAllDayBusy: type.include_all_day_busy === 1, bufferBefore: type.buffer_before_min, bufferAfter: type.buffer_after_min,
    minNotice: type.min_notice_min, maxDaysAhead: type.max_days_ahead, dateFrom: type.date_from, dateTo: type.date_to, slotInterval: type.slot_interval_min,
    dailyLimit: type.daily_limit, weeklyLimit: type.weekly_limit, confirm: type.confirm, pendingHours: type.pending_hours, verifyEmail: type.verify_email === 1,
    hourlyCap: type.hourly_cap, contactBookId: type.contact_book_id, card: cardTemplateOf(type), reminders: remindersOf(type), color: type.color,
    public: type.public === 1, status: type.status, visibility: type.visibility, shareRole: type.share_role, revision: type.revision,
    ownerId: type.owner_id, ownerName: userName(type.owner_id), level, href: typeHref(type),
    publicPath: profile && type.public === 1 && type.status === "active" ? `/p/book/${profile.handle}/${type.slug}` : null,
    hosts: hostsOf(type.id).map((host) => ({ userId: host.user_id, name: userName(host.user_id), priority: host.priority, calendarId: host.calendar_id, scheduleId: host.schedule_id })),
    createdAt: type.created_at, updatedAt: type.updated_at
  };
}

export function listTypes(userId: string, options: { mine?: boolean } = {}) {
  const rows = db.query(`SELECT bt.* FROM booking_types bt WHERE ${readableContainerSql("booking_type", "bt")}
    ${options.mine ? "AND (bt.owner_id = $userId OR EXISTS (SELECT 1 FROM booking_type_hosts h WHERE h.type_id = bt.id AND h.user_id = $userId))" : ""}
    ORDER BY bt.owner_id = $userId DESC, bt.title COLLATE NOCASE, bt.id LIMIT 200`).all({ userId }) as TypeRow[];
  return rows.map((row) => typeView(row, userId));
}

function uniqueSlug(ownerId: string, wanted: string, exceptId: string | null) {
  let slug = wanted;
  for (let attempt = 2; db.query("SELECT 1 FROM booking_types WHERE owner_id = ? AND slug = ? AND id IS NOT ?").get(ownerId, slug, exceptId); attempt += 1) slug = `${wanted.slice(0, 55)}-${attempt}`;
  return slug;
}

/** Checks and normalizes the parts of an input that need the database (calendars, schedules, books, boards, hosts). */
function checkInput(actorId: string, ownerId: string, input: TypeInput) {
  if (input.durations !== undefined) {
    const durations = [...new Set(input.durations)].sort((a, b) => a - b);
    if (!durations.length || durations.length > MAX_DURATIONS || durations.some((value) => !Number.isInteger(value) || value < 5 || value > 720)) throw invalid(`Choose 1 to ${MAX_DURATIONS} durations of 5 minutes to 12 hours`, { field: "durations" });
    input.durations = durations;
  }
  if (input.slotInterval !== undefined && !(SLOT_INTERVALS as readonly number[]).includes(input.slotInterval)) throw invalid("Choose a slot interval", { field: "slotInterval" });
  if (input.locationKind !== undefined && !(LOCATION_KINDS as readonly string[]).includes(input.locationKind)) throw invalid("Choose a location", { field: "locationKind" });
  if (input.assignment !== undefined && !(ASSIGNMENTS as readonly string[]).includes(input.assignment)) throw invalid("Choose who hosts", { field: "assignment" });
  for (const field of ["dateFrom", "dateTo"] as const) if (input[field] && !isValidDate(input[field]!)) throw invalid("Enter a real date", { field });
  if (input.dateFrom && input.dateTo && input.dateTo < input.dateFrom) throw invalid("The date range ends before it starts", { field: "dateTo" });
  if (input.color !== undefined && !/^#[0-9a-f]{6}$/i.test(input.color)) throw invalid("Choose a color", { field: "color" });
  if (input.scheduleId && !db.query("SELECT 1 FROM availability_schedules WHERE id = ? AND user_id = ?").get(input.scheduleId, ownerId)) throw invalid("Choose one of the owner's schedules", { field: "scheduleId" });
  if (input.calendarId && !db.query("SELECT 1 FROM calendars WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").get(input.calendarId, ownerId)) throw invalid("Choose one of the owner's calendars", { field: "calendarId" });
  if (input.busyCalendarIds !== undefined) {
    input.busyCalendarIds = [...new Set(input.busyCalendarIds)].slice(0, 20);
    if (input.busyCalendarIds.some((id) => !readableCalendar(id, ownerId))) throw invalid("Choose calendars the owner can read", { field: "busyCalendarIds" });
  }
  if (input.contactBookId && !canEditBook(input.contactBookId, actorId)) throw invalid("Choose a contact book you can edit", { field: "contactBookId" });
  if (input.card) {
    const board = db.query("SELECT b.id FROM boards b JOIN board_columns c ON c.board_id = b.id WHERE b.id = ? AND c.id = ? AND b.deleted_at IS NULL").get(input.card.boardId, input.card.columnId);
    if (!board) throw invalid("Choose a board and a column", { field: "card" });
    input.card = { boardId: input.card.boardId, columnId: input.card.columnId, titleTemplate: (input.card.titleTemplate ?? "").slice(0, 200), assignHost: input.card.assignHost !== false };
  }
  if (input.reminders) {
    const offsets = [...new Set(input.reminders.offsets)].sort((a, b) => b - a);
    if (offsets.length > MAX_REMINDERS || offsets.some((value) => !Number.isInteger(value) || value < 5 || value > 10_080)) throw invalid(`At most ${MAX_REMINDERS} reminders, 5 minutes to 7 days before`, { field: "reminders" });
    input.reminders = { offsets, booker: input.reminders.booker !== false, host: input.reminders.host !== false };
  }
  if (input.hosts !== undefined) {
    if (input.hosts.length > MAX_HOSTS) throw invalid(`At most ${MAX_HOSTS} hosts`, { field: "hosts" });
    for (const host of input.hosts) {
      // Guests cannot host (§G.1 Q8); neither can integrations or blocked people.
      const user = db.query("SELECT role, kind, disabled_at FROM users WHERE id = ?").get(host.userId) as { role: string; kind: string; disabled_at: string | null } | null;
      if (!user || user.kind !== "person" || user.disabled_at !== null || !["admin", "member"].includes(user.role)) throw invalid("Hosts are members of the workspace", { field: "hosts" });
      if (host.calendarId && !db.query("SELECT 1 FROM calendars WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").get(host.calendarId, host.userId)) throw invalid("A host's calendar must be their own", { field: "hosts" });
      if (host.scheduleId && !db.query("SELECT 1 FROM availability_schedules WHERE id = ? AND user_id = ?").get(host.scheduleId, host.userId)) throw invalid("A host's schedule must be their own", { field: "hosts" });
    }
  }
}

function writeHosts(type: TypeRow, hosts: NonNullable<TypeInput["hosts"]>) {
  db.query("DELETE FROM booking_type_hosts WHERE type_id = ?").run(type.id);
  const list = type.assignment === "single" ? [{ userId: type.owner_id }] : hosts.length ? hosts : [{ userId: type.owner_id }];
  for (const host of list) {
    const existing = hosts.find((item) => item.userId === host.userId);
    db.query("INSERT OR IGNORE INTO booking_type_hosts (type_id, user_id, priority, calendar_id, schedule_id) VALUES (?, ?, ?, ?, ?)")
      .run(type.id, host.userId, Math.min(10, Math.max(0, existing?.priority ?? 0)), existing?.calendarId ?? null, existing?.scheduleId ?? null);
    ensureProfile(host.userId);
  }
}

export function createType(userId: string, input: TypeInput & { title: string }, nowMs = Date.now()) {
  const user = db.query("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | null;
  if (!user || !["admin", "member"].includes(user.role)) throw new BookingError(403, "READ_ONLY", "Only members can create booking types");
  checkInput(userId, userId, input);
  ensureProfile(userId);
  return db.transaction(() => {
    if ((db.query("SELECT COUNT(*) AS count FROM booking_types WHERE owner_id = ? AND deleted_at IS NULL").get(userId) as { count: number }).count >= MAX_TYPES_PER_OWNER) throw new BookingError(409, "LIMIT_REACHED", `At most ${MAX_TYPES_PER_OWNER} booking types`);
    const title = input.title.trim().slice(0, 120);
    if (!title) throw invalid("Give it a title", { field: "title" });
    const wanted = input.slug ? input.slug.trim().toLowerCase() : slugify(title, 60).replace(/^-+|-+$/g, "") || "meeting";
    if (!SLUG_PATTERN.test(wanted)) throw invalid("Use lower-case letters, digits, and hyphens", { field: "slug" });
    const id = crypto.randomUUID();
    const timestamp = new Date(nowMs).toISOString();
    db.query(`INSERT INTO booking_types (id, owner_id, slug, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, userId, uniqueSlug(userId, wanted, null), title, timestamp, timestamp);
    applyFields(id, input);
    writeHosts(typeRow(id)!, input.hosts ?? []);
    saveDraftSet({ kind: "booking_type", id }, emptyQuestionSet(), userId);
    publishSet({ kind: "booking_type", id }, userId, { audience: "public" });
    recordItemActivity({ itemKind: "booking_type", itemId: id, container: { kind: "booking_type", id }, actorId: userId, kind: "created", payload: { from: null, to: { label: title } } });
    audit(userId, null, "bookings.type_create", { typeId: id });
    return typeView(typeRow(id)!, userId);
  })();
}

function applyFields(id: string, input: TypeInput) {
  const columns: Record<string, unknown> = {
    title: input.title?.trim().slice(0, 120), description_md: input.description?.slice(0, 4000), durations_json: input.durations && JSON.stringify(input.durations),
    location_kind: input.locationKind, location_value: input.locationValue?.slice(0, 500), assignment: input.assignment, schedule_id: input.scheduleId,
    calendar_id: input.calendarId, busy_calendar_ids_json: input.busyCalendarIds && JSON.stringify(input.busyCalendarIds),
    include_all_day_busy: input.includeAllDayBusy === undefined ? undefined : input.includeAllDayBusy ? 1 : 0, buffer_before_min: input.bufferBefore, buffer_after_min: input.bufferAfter,
    min_notice_min: input.minNotice, max_days_ahead: input.maxDaysAhead, date_from: input.dateFrom, date_to: input.dateTo, slot_interval_min: input.slotInterval,
    daily_limit: input.dailyLimit, weekly_limit: input.weeklyLimit, confirm: input.confirm, pending_hours: input.pendingHours,
    verify_email: input.verifyEmail === undefined ? undefined : input.verifyEmail ? 1 : 0, hourly_cap: input.hourlyCap, contact_book_id: input.contactBookId,
    card_json: input.card === undefined ? undefined : input.card === null ? null : JSON.stringify(input.card), reminders_json: input.reminders && JSON.stringify(input.reminders),
    color: input.color, public: input.public === undefined ? undefined : input.public ? 1 : 0, status: input.status
  };
  const set = Object.entries(columns).filter(([, value]) => value !== undefined);
  if (!set.length) return;
  try {
    db.query(`UPDATE booking_types SET ${set.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`).run(...set.map(([, value]) => value as string | number | null), id);
  } catch (error) {
    if (error instanceof Error && /CHECK constraint/.test(error.message)) throw invalid("A value is out of range");
    throw error;
  }
}

export function updateType(userId: string, ref: string, input: TypeInput) {
  const { type, level } = requireType(ref, userId, "edit");
  if (input.expectedRevision !== undefined && input.expectedRevision !== type.revision) throw new BookingError(409, "TYPE_CHANGED", "This booking type was changed by someone else", { revision: type.revision });
  // Who hosts and where things land are the owner's or a manager's call.
  const managing = atLeast(level, "manage");
  if (!managing && (input.hosts !== undefined || input.assignment !== undefined || input.calendarId !== undefined || input.contactBookId !== undefined || input.card !== undefined || input.public !== undefined))
    throw new BookingError(403, "READ_ONLY", "Only the type's owner or a manager can change hosts, calendars, or sharing");
  checkInput(userId, type.owner_id, input);
  return db.transaction(() => {
    if (input.slug !== undefined) {
      const slug = input.slug.trim().toLowerCase();
      if (!SLUG_PATTERN.test(slug)) throw invalid("Use lower-case letters, digits, and hyphens", { field: "slug" });
      if (db.query("SELECT 1 FROM booking_types WHERE owner_id = ? AND slug = ? AND id <> ?").get(type.owner_id, slug, type.id)) throw new BookingError(409, "SLUG_TAKEN", "Another of your types uses that link", { field: "slug" });
      db.query("UPDATE booking_types SET slug = ? WHERE id = ?").run(slug, type.id);
    }
    applyFields(type.id, input);
    const updated = typeRow(type.id)!;
    if (input.hosts !== undefined || input.assignment !== undefined) writeHosts(updated, input.hosts ?? hostsOf(type.id).map((host) => ({ userId: host.user_id, priority: host.priority, calendarId: host.calendar_id, scheduleId: host.schedule_id })));
    db.query("UPDATE booking_types SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now(), type.id);
    if (input.title !== undefined && input.title.trim() !== type.title) recordItemActivity({ itemKind: "booking_type", itemId: type.id, container: { kind: "booking_type", id: type.id }, actorId: userId, kind: "type_renamed", payload: { from: { label: type.title }, to: { label: input.title.trim() } } });
    else recordItemActivity({ itemKind: "booking_type", itemId: type.id, container: { kind: "booking_type", id: type.id }, actorId: userId, kind: "type_updated", payload: {} });
    audit(userId, null, "bookings.type_update", { typeId: type.id, fields: Object.keys(input).filter((key) => key !== "expectedRevision") });
    return typeView(typeRow(type.id)!, userId);
  })();
}

export function deleteType(userId: string, ref: string) {
  const { type } = requireType(ref, userId, "manage");
  const deletedAt = new Date();
  db.transaction(() => {
    db.query("UPDATE booking_types SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND deleted_at IS NULL").run(deletedAt.toISOString(), userId, purgeAfterFrom(deletedAt), type.id);
    revokePublicLinksOf("booking_type", type.id, userId);
    recordItemActivity({ itemKind: "booking_type", itemId: type.id, container: { kind: "booking_type", id: type.id }, actorId: userId, kind: "binned" });
    audit(userId, null, "bookings.type_delete", { typeId: type.id });
  })();
  return { ok: true as const, purgeAfter: purgeAfterFrom(deletedAt) };
}

// ---------------------------------------------------------------- intake questions (§B.2)

export function typeQuestions(userId: string, ref: string) {
  const { type } = requireType(ref, userId);
  const host = { kind: "booking_type" as const, id: type.id };
  return { published: currentSet(host), draft: draftSet(host) };
}

export function saveTypeQuestions(userId: string, ref: string, set: unknown, publish: boolean) {
  const { type } = requireType(ref, userId, "edit");
  const host = { kind: "booking_type" as const, id: type.id };
  return db.transaction(() => {
    const saved: QuestionSet = saveDraftSet(host, set, userId);
    // Members-only types (files, people, cards) are refused on public submissions by the engine.
    const published = publish ? publishSet(host, userId, { audience: "public" }) : null;
    audit(userId, null, "bookings.type_questions", { typeId: type.id, published: Boolean(published) });
    return { draft: saved, published };
  })();
}

// ---------------------------------------------------------------- secret links (one-off / expiring)

export function listSecretLinks(userId: string, ref: string) {
  const { type } = requireType(ref, userId, "manage");
  return listPublicLinks("booking_type", type.id).map((link) => ({ id: link.id, prefix: link.tokenPrefix, expiresAt: link.expiresAt, maxUses: link.maxUses, useCount: link.useCount, createdAt: link.createdAt, label: String(link.settings.label ?? "") }));
}

export function createSecretLink(userId: string, ref: string, input: { singleUse?: boolean; expiresInDays?: number | null; label?: string }) {
  const { type } = requireType(ref, userId, "manage");
  return db.transaction(() => {
    if (listPublicLinks("booking_type", type.id).length >= MAX_SECRET_LINKS) throw new BookingError(409, "LIMIT_REACHED", `At most ${MAX_SECRET_LINKS} secret links per type`);
    const days = input.expiresInDays ?? (input.singleUse ? 30 : null);
    const { link, token } = createPublicLink({
      kind: "booking_type", itemId: type.id, createdBy: userId, maxUses: input.singleUse ? 1 : null,
      expiresAt: days ? new Date(Date.now() + Math.min(365, Math.max(1, days)) * 86_400_000).toISOString() : null, settings: { label: (input.label ?? "").slice(0, 80) }
    });
    audit(userId, null, "bookings.secret_link_create", { typeId: type.id, linkId: link.id, singleUse: Boolean(input.singleUse) });
    return { id: link.id, path: `/p/book/link/${token}`, expiresAt: link.expiresAt, maxUses: link.maxUses };
  })();
}

export function revokeSecretLink(userId: string, ref: string, linkId: string) {
  const { type } = requireType(ref, userId, "manage");
  const link = listPublicLinks("booking_type", type.id).find((item) => item.id === linkId);
  if (!link) throw notFound("Link");
  revokePublicLink(link.id, userId);
  audit(userId, null, "bookings.secret_link_revoke", { typeId: type.id, linkId });
}

// ---------------------------------------------------------------- Bin (booking_type)

const binDefaults = { folder_id: null, folder_name: "Bookings", size_bytes: null, board_id: null, board_name: null, attachment: false, attachment_of: null, attachment_kind: null } as const;

function purgeType(id: string, actorId: string | null, reason: string): PurgeOutcome {
  return db.transaction((): PurgeOutcome => {
    const row = db.query("SELECT deleted_at FROM booking_types WHERE id = ?").get(id) as { deleted_at: string | null } | null;
    if (!row || row.deleted_at === null) return "not_found";
    db.query("DELETE FROM booking_types WHERE id = ?").run(id);
    audit(actorId, null, "bookings.type_purge", { typeId: id, reason });
    return "purged";
  })();
}

export function registerTypeBin() {
  return {
    type: "booking_type" as const,
    provider: {
      list(userId: string): BinItem[] {
        return (db.query("SELECT id, title, short_id, deleted_at, purge_after, purge_started_at FROM booking_types WHERE deleted_at IS NOT NULL AND (owner_id = ? OR deleted_by = ?) ORDER BY deleted_at DESC LIMIT 500").all(userId, userId) as Array<{ id: string; title: string; short_id: string; deleted_at: string; purge_after: string; purge_started_at: string | null }>)
          .map((row) => ({ type: "booking_type" as BinItem["type"], id: row.id, title: row.title, deleted_at: row.deleted_at, purge_after: row.purge_after, purging: row.purge_started_at !== null, ...binDefaults, can_purge: true, href: typeHref(row) }));
      },
      restore(id: string, userId: string) {
        return withResourceLock(`booking_types:${id}`, async (): Promise<RestoreOutcome> => {
          const row = db.query("SELECT owner_id, deleted_by, deleted_at FROM booking_types WHERE id = ?").get(id) as { owner_id: string; deleted_by: string | null; deleted_at: string | null } | null;
          if (!row || (row.owner_id !== userId && row.deleted_by !== userId)) return { status: "not_found" };
          if (row.deleted_at === null) return { status: "already_restored", folderId: null, folderName: "Bookings" };
          db.transaction(() => {
            db.query("UPDATE booking_types SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ? WHERE id = ?").run(now(), id);
            recordItemActivity({ itemKind: "booking_type", itemId: id, container: { kind: "booking_type", id }, actorId: userId, kind: "restored" });
            audit(userId, null, "bookings.type_restore", { typeId: id });
          })();
          return { status: "restored", folderId: null, folderName: "Bookings", visibility: "private" } as RestoreOutcome;
        });
      },
      purge(id: string, userId: string) {
        return withResourceLock(`booking_types:${id}`, async () => {
          const row = db.query("SELECT owner_id, deleted_at FROM booking_types WHERE id = ?").get(id) as { owner_id: string; deleted_at: string | null } | null;
          if (!row || row.owner_id !== userId) return "not_found" as const;
          if (row.deleted_at === null) return "live" as const;
          return purgeType(id, userId, "user");
        });
      },
      async sweep(cutoff: string): Promise<BinSweepCounts> {
        const due = db.query("SELECT id FROM booking_types WHERE deleted_at IS NOT NULL AND purge_after <= ? LIMIT ?").all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string }>;
        const counts = { purged: 0, pending: 0 };
        for (const { id } of due) if (purgeType(id, null, "retention") === "purged") counts.purged += 1;
        return counts;
      },
      async empty(userId: string): Promise<BinSweepCounts> {
        const ids = db.query("SELECT id FROM booking_types WHERE owner_id = ? AND deleted_at IS NOT NULL").all(userId) as Array<{ id: string }>;
        const counts = { purged: 0, pending: 0 };
        for (const { id } of ids) if (purgeType(id, userId, "user") === "purged") counts.purged += 1;
        return counts;
      }
    }
  };
}
export { registerBinProvider };
