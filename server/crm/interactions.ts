import { audit, db, now } from "../db";
import { recordItemActivity, listItemActivity } from "../activity/service";
import { notifyMentions } from "../activity/mentions";
import { captureUndo } from "../undo";
import { cancelSchedules, upsertSchedule } from "../schedules/service";
import { createLink, linksOf } from "../links/service";
import { createCard } from "../tasks/service";
import { LEVEL_RANK } from "../access/levels";
import {
  crmCompanyPath, crmContactPath, crmDealPath, INTERACTION_KINDS, type CrmEntity, type CrmFollowup, type CrmInteraction, type InteractionKind, type InteractionSource
} from "../../shared/crm";
import type { ItemActivityEntry } from "../../shared/itemActivity";
import type { WorkLinkView } from "../../shared/workRefs";
import { cleanRef, cleanText, CrmError, decodeCursor, encodeCursor, invalid, levelOnBook, notFound, notifyReaders, readableBooksSql, refColumn, requireBook, userRef } from "./core";

/**
 * Interactions, follow-ups, tasks, and the record timeline (§D.5, D963). An interaction belongs to a
 * book and names contacts, companies, and deals of that book; logging one moves their "last
 * interaction" (and a deal's rotting clock). Deleting is immediate with an Undo ticket (D813). A
 * follow-up is a reminder for one person at a time (`crm.followup` schedule → inbox notification).
 */

const TABLE: Record<CrmEntity, string> = { contact: "contacts", company: "companies", deal: "deals" };

/** A live record the user reads: its id, book, and title. */
export function readRecord(kind: CrmEntity, ref: string, userId: string): { id: string; bookId: string; title: string; href: string } {
  const clean = cleanRef(ref);
  if (!clean || !TABLE[kind]) throw notFound();
  const titleColumn = kind === "contact" ? "display_name" : kind === "company" ? "name" : "title";
  const row = db.query(`SELECT r.id, r.book_id, r.short_id, r.${titleColumn} AS title FROM ${TABLE[kind]} r JOIN contact_books b ON b.id = r.book_id
    WHERE r.${refColumn(clean)} = $ref AND r.deleted_at IS NULL AND ${readableBooksSql("b")}`).get({ ref: clean, userId }) as { id: string; book_id: string; short_id: string; title: string } | null;
  if (!row) throw notFound(`${kind === "contact" ? "Contact" : kind === "company" ? "Company" : "Deal"} not found`);
  const href = kind === "contact" ? crmContactPath(row.title, row.short_id) : kind === "company" ? crmCompanyPath(row.title, row.short_id) : crmDealPath(row.title, row.short_id);
  return { id: row.id, bookId: row.book_id, title: row.title, href };
}

type InteractionRow = { id: string; book_id: string; kind: InteractionKind; direction: "in" | "out" | "none"; occurred_at: string; duration_s: number | null; title: string; body_md: string;
  author_id: string | null; author_name: string | null; source: InteractionSource; created_at: string; updated_at: string };

function toInteractions(rows: InteractionRow[], userId: string): CrmInteraction[] {
  if (!rows.length) return [];
  const subjects = db.query(`SELECT s.interaction_id, s.subject_kind, s.subject_id,
      CASE s.subject_kind WHEN 'contact' THEN (SELECT display_name FROM contacts WHERE id = s.subject_id AND deleted_at IS NULL)
        WHEN 'company' THEN (SELECT name FROM companies WHERE id = s.subject_id AND deleted_at IS NULL) ELSE (SELECT title FROM deals WHERE id = s.subject_id AND deleted_at IS NULL) END AS title
    FROM interaction_subjects s WHERE s.interaction_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(rows.map((row) => row.id))) as Array<{ interaction_id: string; subject_kind: CrmEntity; subject_id: string; title: string | null }>;
  const levels = new Map<string, number>();
  const level = (bookId: string) => { if (!levels.has(bookId)) levels.set(bookId, LEVEL_RANK[levelOnBook(bookId, userId)]); return levels.get(bookId)!; };
  return rows.map((row) => ({
    id: row.id, bookId: row.book_id, kind: row.kind, direction: row.direction, occurredAt: row.occurred_at, durationS: row.duration_s, title: row.title, body: row.body_md,
    author: userRef(row.author_id, row.author_name), source: row.source, createdAt: row.created_at, updatedAt: row.updated_at,
    subjects: subjects.filter((subject) => subject.interaction_id === row.id).map((subject) => ({ kind: subject.subject_kind, id: subject.subject_id, title: subject.title })),
    canEdit: (row.author_id === userId && level(row.book_id) >= LEVEL_RANK.edit) || level(row.book_id) >= LEVEL_RANK.manage
  }));
}

const INTERACTION_SELECT = `SELECT i.id, i.book_id, i.kind, i.direction, i.occurred_at, i.duration_s, i.title, i.body_md, i.author_id, u.display_name AS author_name, i.source, i.created_at, i.updated_at
  FROM interactions i JOIN contact_books b ON b.id = i.book_id LEFT JOIN users u ON u.id = i.author_id`;

export type InteractionInput = {
  kind?: InteractionKind; direction?: "in" | "out" | "none"; occurredAt?: string | null; durationS?: number | null; title?: string | null; body?: string | null;
  subjects?: Array<{ kind: CrmEntity; id: string }>; source?: InteractionSource; sourceRef?: string | null;
};

function cleanOccurred(value: unknown) {
  if (value === undefined || value === null || value === "") return now();
  if (typeof value !== "string" || value.length > 40 || Number.isNaN(Date.parse(value))) throw invalid("When is a date and time");
  return new Date(value).toISOString();
}

/** Moves the subjects' "last interaction" forward (and restarts a deal's rotting clock). */
function touchSubjects(subjects: ReadonlyArray<{ kind: CrmEntity; id: string }>, at: string) {
  for (const subject of subjects) {
    if (subject.kind === "deal") db.query("UPDATE deals SET last_activity_at = MAX(last_activity_at, ?), rot_notified_at = CASE WHEN last_activity_at < ? THEN NULL ELSE rot_notified_at END WHERE id = ?").run(at, at, subject.id);
    else db.query(`UPDATE ${TABLE[subject.kind]} SET last_interaction_at = CASE WHEN last_interaction_at IS NULL OR last_interaction_at < ? THEN ? ELSE last_interaction_at END WHERE id = ?`).run(at, at, subject.id);
  }
}

/** Logs an interaction on one or more records of one book (edit on the book). */
export function logInteraction(userId: string, input: InteractionInput): CrmInteraction {
  return db.transaction(() => {
    const kind = input.kind ?? "note";
    if (!(INTERACTION_KINDS as readonly string[]).includes(kind)) throw invalid("Choose what kind of interaction");
    if (!Array.isArray(input.subjects) || !input.subjects.length || input.subjects.length > 20) throw invalid("Name 1 to 20 contacts, companies, or deals");
    const subjects = input.subjects.map((subject) => ({ kind: subject.kind, ...readRecord(subject.kind, subject.id, userId) }));
    const bookId = subjects[0]!.bookId;
    if (subjects.some((subject) => subject.bookId !== bookId)) throw new CrmError(400, "OTHER_BOOK", "An interaction's records are in one book");
    requireBook(bookId, userId, "edit");
    const title = cleanText(input.title, 200, "The title") ?? "";
    const body = cleanText(input.body, 20_000, "The notes") ?? "";
    if (!title && !body) throw invalid("Write what happened");
    const durationS = input.durationS === undefined || input.durationS === null ? null : Number(input.durationS);
    if (durationS !== null && (!Number.isInteger(durationS) || durationS < 0 || durationS > 86_400)) throw invalid("A duration is 0 to 24 hours");
    const direction = input.direction ?? "none";
    if (!["in", "out", "none"].includes(direction)) throw invalid("Direction is in, out, or none");
    const occurredAt = cleanOccurred(input.occurredAt);
    const sourceRef = cleanText(input.sourceRef, 80, "The source");
    if (sourceRef) {
      const existing = db.query("SELECT id FROM interactions WHERE source = ? AND source_ref = ?").get(input.source ?? "manual", sourceRef) as { id: string } | null;
      if (existing) return readInteraction(existing.id, userId);
    }
    const id = Bun.randomUUIDv7();
    const timestamp = now();
    db.query(`INSERT INTO interactions (id, book_id, kind, direction, occurred_at, duration_s, title, body_md, author_id, source, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, bookId, kind, direction, occurredAt, durationS, title, body, userId, input.source ?? "manual", sourceRef, timestamp, timestamp);
    const unique = new Map(subjects.map((subject) => [`${subject.kind}:${subject.id}`, subject]));
    for (const subject of unique.values()) {
      db.query("INSERT INTO interaction_subjects (interaction_id, subject_kind, subject_id) VALUES (?, ?, ?)").run(id, subject.kind, subject.id);
      recordItemActivity({ itemKind: subject.kind, itemId: subject.id, container: { kind: "contact_book", id: bookId }, actorId: userId, kind: "crm_interaction", payload: { item: { id, label: `${kind[0]!.toUpperCase()}${kind.slice(1)}` }, extra: { kind } } });
    }
    touchSubjects([...unique.values()], occurredAt);
    // @mentions in the notes (docs/plan/MENTIONS.md, phase B): readers of the book, on the first record named.
    if (body) notifyMentions({ kind: subjects[0]!.kind, itemId: subjects[0]!.id, authorId: userId, text: body, where: `in a note on a ${subjects[0]!.kind}` });
    audit(userId, null, "crm.interaction_create", { bookId, interactionId: id, kind, subjects: unique.size });
    return readInteraction(id, userId);
  })();
}

export function readInteraction(id: string, userId: string): CrmInteraction {
  if (!cleanRef(id)) throw notFound("Interaction not found");
  const row = db.query(`${INTERACTION_SELECT} WHERE i.id = $id AND ${readableBooksSql("b")}`).get({ id: id.toLowerCase(), userId }) as InteractionRow | null;
  if (!row) throw notFound("Interaction not found");
  return toInteractions([row], userId)[0]!;
}

export function updateInteraction(id: string, userId: string, patch: InteractionInput): CrmInteraction {
  return db.transaction(() => {
    const current = readInteraction(id, userId);
    if (!current.canEdit) throw new CrmError(403, "READ_ONLY", "Only its author or a manager can change this");
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.kind !== undefined) { if (!(INTERACTION_KINDS as readonly string[]).includes(patch.kind)) throw invalid("Choose what kind of interaction"); sets.push("kind = ?"); values.push(patch.kind); }
    if (patch.title !== undefined) { sets.push("title = ?"); values.push(cleanText(patch.title, 200, "The title") ?? ""); }
    if (patch.body !== undefined) { sets.push("body_md = ?"); values.push(cleanText(patch.body, 20_000, "The notes") ?? ""); }
    if (patch.occurredAt !== undefined) { sets.push("occurred_at = ?"); values.push(cleanOccurred(patch.occurredAt)); }
    if (patch.direction !== undefined) { if (!["in", "out", "none"].includes(patch.direction)) throw invalid("Direction is in, out, or none"); sets.push("direction = ?"); values.push(patch.direction); }
    if (patch.durationS !== undefined) sets.push("duration_s = ?"), values.push(patch.durationS === null ? null : Math.max(0, Math.min(86_400, Math.round(Number(patch.durationS)))));
    if (!sets.length) return current;
    db.query(`UPDATE interactions SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ?`).run(...values, now(), current.id);
    // Only people the edit newly mentions are notified (D1326).
    const subject = current.subjects[0];
    if (patch.body !== undefined && subject) notifyMentions({ kind: subject.kind, itemId: subject.id, authorId: userId, text: patch.body ?? "", before: current.body, where: `in a note on a ${subject.kind}` });
    audit(userId, null, "crm.interaction_update", { bookId: current.bookId, interactionId: current.id });
    return readInteraction(current.id, userId);
  })();
}

/** Deletes an interaction at once; returns an Undo ticket (D813). */
export function deleteInteraction(id: string, userId: string): { undoTicket: string } {
  return db.transaction(() => {
    const current = readInteraction(id, userId);
    if (!current.canEdit) throw new CrmError(403, "READ_ONLY", "Only its author or a manager can delete this");
    const undoTicket = captureUndo({ actorId: userId, kind: "crm_interaction", label: "Interaction", rows: [{ table: "interactions", where: { id: current.id } }, { table: "interaction_subjects", where: { interaction_id: current.id } }] });
    db.query("DELETE FROM interactions WHERE id = ?").run(current.id);
    audit(userId, null, "crm.interaction_delete", { bookId: current.bookId, interactionId: current.id });
    return { undoTicket };
  })();
}

/** Interactions of one record (a company's include its contacts'), newest first, keyset paged; or of readable books. */
export function listInteractions(userId: string, input: { subject?: { kind: CrmEntity; id: string } | null; bookIds?: readonly string[] | null; kind?: InteractionKind | null; cursor?: string | null; limit?: number; keyFilter?: { sql: string; params: Record<string, string> } }) {
  const where = [readableBooksSql("b")];
  const params: Record<string, string | number> = { userId };
  if (input.subject) {
    const record = readRecord(input.subject.kind, input.subject.id, userId);
    params.subjectKind = input.subject.kind;
    params.subjectId = record.id;
    where.push(input.subject.kind === "company"
      ? `i.id IN (SELECT interaction_id FROM interaction_subjects WHERE (subject_kind = 'company' AND subject_id = $subjectId) OR (subject_kind = 'contact' AND subject_id IN (SELECT id FROM contacts WHERE company_id = $subjectId)))`
      : "i.id IN (SELECT interaction_id FROM interaction_subjects WHERE subject_kind = $subjectKind AND subject_id = $subjectId)");
  }
  if (input.bookIds) { where.push("i.book_id IN (SELECT value FROM json_each($bookIds))"); params.bookIds = JSON.stringify(input.bookIds); }
  if (input.kind) { where.push("i.kind = $kind"); params.kind = input.kind; }
  if (input.keyFilter) { where.push(input.keyFilter.sql); Object.assign(params, input.keyFilter.params); }
  const cursor = decodeCursor(input.cursor);
  if (cursor) { where.push("(i.occurred_at < $cv OR (i.occurred_at = $cv AND i.id < $cid))"); params.cv = String(cursor[0]); params.cid = cursor[1]; }
  const limit = Math.min(Math.max(1, input.limit ?? 50), 100);
  params.limit = limit + 1;
  const rows = db.query(`${INTERACTION_SELECT} WHERE ${where.join(" AND ")} ORDER BY i.occurred_at DESC, i.id DESC LIMIT $limit`).all(params) as InteractionRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: toInteractions(page, userId), nextCursor: rows.length > limit && last ? encodeCursor(last.occurred_at, last.id) : null };
}

// ----------------------------------------------------------------------------- follow-ups

type FollowupRow = { id: string; book_id: string; subject_kind: CrmEntity; subject_id: string; user_id: string; due_at: string; note: string; done_at: string | null };

function toFollowup(row: FollowupRow, userId: string): CrmFollowup | null {
  try {
    const record = readRecord(row.subject_kind, row.subject_id, userId);
    return { id: row.id, bookId: row.book_id, subject: { kind: row.subject_kind, id: record.id, title: record.title, href: record.href }, userId: row.user_id, dueAt: row.due_at, note: row.note, doneAt: row.done_at };
  } catch { return null; }
}

/** "Remind me" on a record (§D.5): an inbox notification at `dueAt` for the caller (readers may set their own). */
export function createFollowup(userId: string, input: { subject: { kind: CrmEntity; id: string }; dueAt: string; note?: string | null }): CrmFollowup {
  return db.transaction(() => {
    const record = readRecord(input.subject?.kind, input.subject?.id ?? "", userId);
    requireBook(record.bookId, userId, "comment");
    if (typeof input.dueAt !== "string" || Number.isNaN(Date.parse(input.dueAt))) throw invalid("When is a date and time");
    const dueAt = new Date(input.dueAt).toISOString();
    const open = (db.query("SELECT COUNT(*) AS n FROM crm_followups WHERE user_id = ? AND done_at IS NULL").get(userId) as { n: number }).n;
    if (open >= 1000) throw new CrmError(400, "LIMIT_REACHED", "You have 1,000 open follow-ups; finish some first");
    const id = Bun.randomUUIDv7();
    const note = cleanText(input.note, 500, "The note") ?? "";
    db.query("INSERT INTO crm_followups (id, book_id, subject_kind, subject_id, user_id, due_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, record.bookId, input.subject.kind, record.id, userId, dueAt, note, now());
    const schedule = upsertSchedule({ kind: "crm_followup", id }, "crm.followup", { once: dueAt }, { followupId: id }, { userId, fromMs: Math.min(Date.now(), Date.parse(dueAt) - 1) });
    db.query("UPDATE crm_followups SET schedule_id = ? WHERE id = ?").run(schedule.id, id);
    recordItemActivity({ itemKind: input.subject.kind, itemId: record.id, container: { kind: "contact_book", id: record.bookId }, actorId: userId, kind: "crm_followup", payload: { extra: { due: dueAt } } });
    audit(userId, null, "crm.followup_create", { bookId: record.bookId, followupId: id });
    return toFollowup(db.query("SELECT * FROM crm_followups WHERE id = ?").get(id) as FollowupRow, userId)!;
  })();
}

export function updateFollowup(id: string, userId: string, patch: { done?: boolean; dueAt?: string; note?: string | null }): CrmFollowup {
  return db.transaction(() => {
    const row = cleanRef(id) ? db.query("SELECT * FROM crm_followups WHERE id = ? AND user_id = ?").get(id.toLowerCase(), userId) as FollowupRow | null : null;
    if (!row || !toFollowup(row, userId)) throw notFound("Follow-up not found");
    if (patch.done !== undefined) {
      db.query("UPDATE crm_followups SET done_at = ? WHERE id = ?").run(patch.done ? now() : null, row.id);
      if (patch.done) cancelSchedules({ kind: "crm_followup", id: row.id });
    }
    if (patch.note !== undefined) db.query("UPDATE crm_followups SET note = ? WHERE id = ?").run(cleanText(patch.note, 500, "The note") ?? "", row.id);
    if (patch.dueAt !== undefined) {
      if (typeof patch.dueAt !== "string" || Number.isNaN(Date.parse(patch.dueAt))) throw invalid("When is a date and time");
      const dueAt = new Date(patch.dueAt).toISOString();
      db.query("UPDATE crm_followups SET due_at = ?, notified_at = NULL, done_at = NULL WHERE id = ?").run(dueAt, row.id);
      upsertSchedule({ kind: "crm_followup", id: row.id }, "crm.followup", { once: dueAt }, { followupId: row.id }, { userId, fromMs: Math.min(Date.now(), Date.parse(dueAt) - 1) });
    }
    audit(userId, null, "crm.followup_update", { bookId: row.book_id, followupId: row.id });
    return toFollowup(db.query("SELECT * FROM crm_followups WHERE id = ?").get(row.id) as FollowupRow, userId)!;
  })();
}

/** The caller's follow-ups: open ones by due time (or one record's, every person's being private, only the caller's). */
export function listFollowups(userId: string, options: { subject?: { kind: CrmEntity; id: string }; dueBefore?: string; includeDone?: boolean; limit?: number } = {}) {
  const where = ["user_id = $userId"];
  const params: Record<string, string | number> = { userId, limit: Math.min(options.limit ?? 100, 200) };
  if (!options.includeDone) where.push("done_at IS NULL");
  if (options.dueBefore) { where.push("due_at <= $before"); params.before = options.dueBefore; }
  if (options.subject) { const record = readRecord(options.subject.kind, options.subject.id, userId); where.push("subject_kind = $kind AND subject_id = $id"); params.kind = options.subject.kind; params.id = record.id; }
  const rows = db.query(`SELECT * FROM crm_followups WHERE ${where.join(" AND ")} ORDER BY done_at IS NOT NULL, due_at LIMIT $limit`).all(params) as FollowupRow[];
  return rows.map((row) => toFollowup(row, userId)).filter((item): item is CrmFollowup => item !== null);
}

/** The `crm.followup` schedule handler: notifies the person when the follow-up is still open and they still read its record. */
export function fireFollowup(followupId: string, nowMs = Date.now()) {
  const row = db.query("SELECT * FROM crm_followups WHERE id = ?").get(followupId) as FollowupRow | null;
  if (!row || row.done_at) return;
  const followup = toFollowup(row, row.user_id);
  if (!followup) return;
  notifyReaders(row.book_id, {
    userIds: [row.user_id], module: "crm", topic: "crm.followup_due", title: `Follow up: ${followup.subject.title.slice(0, 160)}`, body: row.note || null,
    href: followup.subject.href, item: { kind: row.subject_kind, id: row.subject_id }, dedupeKey: `followup:${row.id}`, includeActor: true, nowMs,
    email: { template: "crm.update", payload: { topic: "crm.followup_due", kind: row.subject_kind, id: row.subject_id, followupId: row.id }, coalesceKey: `crm.followup:${row.id}` }
  });
  db.query("UPDATE crm_followups SET notified_at = ? WHERE id = ?").run(new Date(nowMs).toISOString(), row.id);
}

// ----------------------------------------------------------------------------- tasks and the timeline

/** "Create task" (C17): a card on a chosen board and column, linked to the record. */
export async function createTask(userId: string, input: { subject: { kind: CrmEntity; id: string }; boardId: string; columnId: string; title: string; dueOn?: string | null }) {
  const record = readRecord(input.subject.kind, input.subject.id, userId);
  requireBook(record.bookId, userId, "edit");
  const title = cleanText(input.title, 200, "The title");
  if (!title) throw invalid("Name the task");
  const { card } = await createCard(userId, input.boardId, { columnId: input.columnId, title, dueOn: input.dueOn ?? null, description: `For ${record.title}` });
  const link = createLink({ a: { kind: input.subject.kind, id: record.id }, b: { kind: "card", id: card.id }, relation: "relates", actorId: userId });
  return { cardId: card.id, linkId: link.id };
}

export type CrmTimeline = { interactions: CrmInteraction[]; nextCursor: string | null; activity: ItemActivityEntry[]; links: WorkLinkView[]; followups: CrmFollowup[] };

/** A record's timeline (§D.5 GET /records/:kind/:id/timeline): interactions, activity, linked items, and the caller's follow-ups. */
export function recordTimeline(kind: CrmEntity, ref: string, userId: string, cursor?: string | null): CrmTimeline {
  const record = readRecord(kind, ref, userId);
  const interactions = listInteractions(userId, { subject: { kind, id: record.id }, cursor, limit: 50 });
  return {
    interactions: interactions.items, nextCursor: interactions.nextCursor,
    activity: cursor ? [] : listItemActivity(kind, record.id, { limit: 50 }).entries,
    links: cursor ? [] : linksOf({ kind, id: record.id }, { userId }),
    followups: cursor ? [] : listFollowups(userId, { subject: { kind, id: record.id }, includeDone: false })
  };
}
