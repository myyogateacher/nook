import { audit, auditVia, db, now } from "../db";
import { itemLevel, readableContainerSql } from "../access/workspaceItems";
import { LEVEL_RANK, type ItemLevel } from "../access/levels";
import { canWriteContent } from "../team/userRole";
import { keyedHash } from "../public/secret";
import { listPublicLinks, publicPolicyAllows, revokePublicLinksOf } from "../public";
import { tokenHash } from "../public/links";
import { currentSet, publishSet, saveDraftSet, submitResponse, updateResponse, QuestionError } from "../questions/service";
import { notify } from "../notify";
import { recordItemActivity, registerActivityKinds } from "../activity/service";
import { cancelSchedules, upsertSchedule } from "../schedules/service";
import { readableEvent } from "../calendar/access";
import { cardPath, notePath } from "../friendlyPaths";
import { emptyQuestionSet, type Question, type QuestionSet } from "../../shared/questions";
import { isShortId } from "../../shared/friendlyUrls";
import {
  TOWNHALL_LIMITS, authorLabel, townhallPath,
  type TownhallLiveState, type TownhallModeration, type TownhallPollKind, type TownhallPollView, type TownhallQuestionStatus, type TownhallQuestionView,
  type TownhallAuthorKind, type TownhallRecap, type TownhallSessionSummary, type TownhallSessionView, type TownhallState, type TownhallYou
} from "../../shared/townhall";
import { newTokenSeed, tokenFromSeed } from "./seal";
import { sessionChanged } from "./live";

/**
 * Townhall's service (docs/plan/WORKSPACE_MODULES.md §D.7 Townhall). Every write runs in one
 * transaction with its audit row and item activity, then wakes the session's live streams, so the web
 * app, the public page, MCP, and REST v1 behave the same (the D742 pattern).
 *
 * Who may do what (D1071): the session is a `townhall_session` container (§B.9). Anyone who can open
 * it may ask, upvote, vote in polls, and (when comments are on) comment, the way answering a form is
 * not access (§B.9 "responding is not access"); guests and viewers too (registered read-only writes,
 * D817). Editors (edit and up) moderate, run polls, and change the session; managers and the owner
 * share it and bin it. Public participants (the audience link) ask, upvote, and vote, nothing else.
 */

export class TownhallError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 429, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

const notFound = (what = "Townhall") => new TownhallError(404, "NOT_FOUND", `${what} not found`);
const invalid = (message: string, code = "INVALID") => new TownhallError(400, code, message);

registerActivityKinds("townhall", {
  townhall_live: { shape: "event", coalesce: false },
  townhall_ended: { shape: "event", coalesce: false },
  townhall_asked: { shape: "event", coalesce: false },
  townhall_moderated: { shape: "change", coalesce: false },
  townhall_poll: { shape: "item", coalesce: false },
  townhall_card: { shape: "item", coalesce: false }
});

// ---------------------------------------------------------------- viewers and rows

/** Who is acting: a signed-in person (web, MCP, REST) or a public participant of the audience link. */
export type Viewer =
  | { kind: "user"; userId: string }
  | { kind: "public"; participant: string; name: string | null };

export type SessionRow = {
  id: string; short_id: string; owner_id: string; title: string; description: string; starts_at: string | null; ends_at: string | null; event_id: string | null;
  state: TownhallState; questions_open: number; allow_anonymous: number; moderation: "off" | "review"; allow_comments: number; reminder_minutes: number;
  pinned_question_id: string | null; active_poll_id: string | null; public_token_seed: string | null; recap_note_id: string | null;
  went_live_at: string | null; ended_at: string | null; visibility: "private" | "selected" | "all_users"; share_role: string; revision: number;
  created_at: string; updated_at: string; deleted_at: string | null; deleted_by: string | null; purge_after: string | null; purge_started_at: string | null;
};

type QuestionRow = {
  id: string; session_id: string; author_id: string | null; author_label: string | null; anonymous: number; asker_hash: string; body: string;
  status: TownhallQuestionStatus; starred: number; merged_into: string | null; vote_count: number; card_id: string | null; answered_at: string | null;
  answered_by: string | null; via: string; revision: number; created_at: string; updated_at: string;
};

type PollRow = {
  id: string; session_id: string; question_id: string; kind: TownhallPollKind; status: "draft" | "live" | "closed"; results_hidden: number; position: number;
  opened_at: string | null; closed_at: string | null; created_by: string | null; created_at: string; updated_at: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The session by id, short id, or a friendly segment (`all-hands-k7f3q2ab01`), live or binned. */
export function sessionRow(ref: string): SessionRow | null {
  const value = ref.trim().toLowerCase();
  const tail = value.includes("-") && !UUID.test(value) ? value.slice(value.lastIndexOf("-") + 1) : value;
  if (UUID.test(value)) return db.query("SELECT * FROM townhall_sessions WHERE id = ?").get(value) as SessionRow | null;
  if (isShortId(tail)) return db.query("SELECT * FROM townhall_sessions WHERE short_id = ?").get(tail) as SessionRow | null;
  return null;
}

export const sessionHref = (row: Pick<SessionRow, "title" | "short_id">) => townhallPath(row.title, row.short_id);

/** Whose name is shown (D1104, T621): a member's display name, or a name a public participant typed. */
const authorKindOf = (row: Pick<QuestionRow, "anonymous" | "author_id">): TownhallAuthorKind => row.anonymous ? null : row.author_id ? "member" : "guest";

/** The person's level on a live session (`none` when missing, binned, or unreadable). */
export function levelOn(row: SessionRow | null, userId: string): ItemLevel {
  if (!row || row.deleted_at !== null) return "none";
  return itemLevel("townhall_session", row.id, userId);
}

/** A card's in-app path (its board's), or null when it is gone. */
function cardHref(cardId: string) {
  const card = db.query("SELECT board_id FROM cards WHERE id = ?").get(cardId) as { board_id: string } | null;
  return card ? cardPath(card.board_id, cardId) : null;
}
const cardRef = (cardId: string | null) => {
  const href = cardId ? cardHref(cardId) : null;
  return cardId && href ? { id: cardId, href } : null;
};

const atLeast = (level: ItemLevel, wanted: "view" | "comment" | "edit" | "manage") => LEVEL_RANK[level] >= LEVEL_RANK[wanted];

/** A live session the person can open (NOT_FOUND otherwise, T90), with their level. */
export function readSession(ref: string, userId: string): { row: SessionRow; level: ItemLevel } {
  const row = sessionRow(ref);
  const level = levelOn(row, userId);
  if (!row || level === "none") throw notFound();
  return { row, level };
}

/** Editors moderate and run the session (edit and up, and a role that writes content). */
function requireEditor(ref: string, userId: string) {
  const found = readSession(ref, userId);
  if (!atLeast(found.level, "edit") || !canWriteContent(userId)) throw new TownhallError(403, "READ_ONLY", "Only the session's hosts can do that");
  return found;
}

export const isModerator = (level: ItemLevel, userId: string) => atLeast(level, "edit") && canWriteContent(userId);

// ---------------------------------------------------------------- hashes (D1073)

const voterKey = (viewer: Viewer) => viewer.kind === "user" ? `u:${viewer.userId}` : `p:${viewer.participant}`;
/** One upvote per person per question, stored as a keyed hash (nobody can list who voted). */
export const voterHash = (sessionId: string, viewer: Viewer) => keyedHash("townhall-voter", `${sessionId}:${voterKey(viewer)}`);
/** Who asked, for "my questions" on anonymous questions (no author id is stored for them). */
export const askerHash = (sessionId: string, viewer: Viewer) => keyedHash("townhall-asker", `${sessionId}:${voterKey(viewer)}`);
/**
 * A named question's asker hash, salted with the question id (D1101, T620): it never equals the
 * person's anonymous `askerHash`, so a named row (which stores the author id or typed name) cannot be
 * matched to the same person's anonymous questions by comparing hashes.
 */
const namedAskerHash = (sessionId: string, questionId: string, viewer: Viewer) => keyedHash("townhall-asker-named", `${sessionId}:${questionId}:${voterKey(viewer)}`);
/** Whether the viewer asked this question: anonymous by the session hash, named by author id (members) or the salted hash (public). */
function askedBy(question: Pick<QuestionRow, "id" | "anonymous" | "author_id" | "asker_hash">, sessionId: string, viewer: Viewer, anonymousHash?: string): boolean {
  if (question.anonymous) return question.asker_hash === (anonymousHash ?? askerHash(sessionId, viewer));
  if (question.author_id) return viewer.kind === "user" && viewer.userId === question.author_id;
  return viewer.kind === "public" && question.asker_hash === namedAskerHash(sessionId, question.id, viewer);
}
/** One poll answer per person (word clouds: a few), the engine's dedupe hash. */
const pollHash = (pollId: string, viewer: Viewer) => keyedHash("townhall-poll", `${pollId}:${voterKey(viewer)}`);
const attendeeHash = (sessionId: string, viewer: Viewer) => keyedHash("townhall-attendee", `${sessionId}:${voterKey(viewer)}`);

const currentVia = () => {
  const via = auditVia();
  return via === "mcp" || via === "rest" || via === "agent" ? via : "web";
};

// ---------------------------------------------------------------- sessions

export type SessionInput = {
  title: string; description: string; startsAt: string | null; endsAt: string | null; eventId: string | null;
  questionsOpen: boolean; allowAnonymous: boolean; moderation: "off" | "review"; allowComments: boolean; reminderMinutes: number;
};

function checkTimes(startsAt: string | null | undefined, endsAt: string | null | undefined) {
  for (const value of [startsAt, endsAt]) if (value !== null && value !== undefined && Number.isNaN(Date.parse(value))) throw invalid("Use an ISO date and time");
  if (startsAt && endsAt && Date.parse(endsAt) < Date.parse(startsAt)) throw invalid("The end is before the start");
}

/** The calendar event a session links to, when the person can read it (else refused like a missing one). */
function checkEvent(eventId: string | null | undefined, userId: string) {
  if (!eventId) return null;
  const found = readableEvent(eventId.toLowerCase(), userId);
  if (!found) throw new TownhallError(404, "EVENT_NOT_FOUND", "Event not found");
  return found.event;
}

function scheduleReminder(row: SessionRow) {
  const at = row.starts_at ? Date.parse(row.starts_at) - row.reminder_minutes * 60_000 : NaN;
  if (row.state !== "upcoming" || row.deleted_at !== null || !row.reminder_minutes || !Number.isFinite(at) || at <= Date.now()) {
    cancelSchedules({ kind: "townhall_session", id: row.id }, "townhall.remind");
    return;
  }
  upsertSchedule({ kind: "townhall_session", id: row.id }, "townhall.remind", { once: new Date(at).toISOString() }, { sessionId: row.id }, { userId: row.owner_id });
}

export function createSession(userId: string, input: Partial<SessionInput> & { title: string }) {
  if (!canWriteContent(userId)) throw new TownhallError(403, "ROLE_READ_ONLY", "Your team role is read-only");
  const title = input.title.trim();
  if (!title || title.length > TOWNHALL_LIMITS.title) throw invalid("Give the session a title of up to 200 characters");
  checkTimes(input.startsAt, input.endsAt);
  const event = checkEvent(input.eventId, userId);
  const startsAt = input.startsAt ?? (event && !event.all_day ? event.start_utc : null);
  const id = crypto.randomUUID();
  const timestamp = now();
  return db.transaction(() => {
    const count = (db.query("SELECT COUNT(*) AS count FROM townhall_sessions WHERE owner_id = ? AND deleted_at IS NULL").get(userId) as { count: number }).count;
    if (count >= 1000) throw new TownhallError(409, "LIMIT_REACHED", "You can have up to 1000 townhalls");
    db.query(`INSERT INTO townhall_sessions (id, owner_id, title, description, starts_at, ends_at, event_id, questions_open, allow_anonymous, moderation, allow_comments, reminder_minutes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, title, (input.description ?? "").slice(0, TOWNHALL_LIMITS.description), startsAt ? new Date(startsAt).toISOString() : null,
      input.endsAt ? new Date(input.endsAt).toISOString() : null, event?.id ?? null, input.questionsOpen === false ? 0 : 1, input.allowAnonymous === false ? 0 : 1,
      input.moderation ?? "off", input.allowComments === false ? 0 : 1, input.reminderMinutes ?? 15, timestamp, timestamp);
    const row = sessionRow(id)!;
    scheduleReminder(row);
    recordItemActivity({ itemKind: "townhall_session", itemId: id, actorId: userId, kind: "created", payload: { from: null, to: { label: title } } });
    audit(userId, null, "townhall.session_created", { sessionId: id, linkedEvent: event !== null });
    return sessionView(row, userId);
  })();
}

export function updateSession(ref: string, userId: string, input: Partial<SessionInput>, expectedRevision?: number) {
  const { row } = requireEditor(ref, userId);
  if (expectedRevision !== undefined && expectedRevision !== row.revision) throw new TownhallError(409, "CONFLICT", "Someone else changed this session. Reload and try again.");
  if (input.title !== undefined && (!input.title.trim() || input.title.trim().length > TOWNHALL_LIMITS.title)) throw invalid("Give the session a title of up to 200 characters");
  checkTimes(input.startsAt === undefined ? row.starts_at : input.startsAt, input.endsAt === undefined ? row.ends_at : input.endsAt);
  const event = input.eventId === undefined ? undefined : checkEvent(input.eventId, userId);
  const result = db.transaction(() => {
    const fields: Record<string, string | number | null> = {};
    if (input.title !== undefined) fields.title = input.title.trim();
    if (input.description !== undefined) fields.description = input.description.slice(0, TOWNHALL_LIMITS.description);
    if (input.startsAt !== undefined) fields.starts_at = input.startsAt ? new Date(input.startsAt).toISOString() : null;
    if (input.endsAt !== undefined) fields.ends_at = input.endsAt ? new Date(input.endsAt).toISOString() : null;
    if (event !== undefined) {
      fields.event_id = event?.id ?? null;
      if (event && input.startsAt === undefined && !row.starts_at && !event.all_day) fields.starts_at = event.start_utc;
    }
    if (input.questionsOpen !== undefined) fields.questions_open = input.questionsOpen ? 1 : 0;
    if (input.allowAnonymous !== undefined) fields.allow_anonymous = input.allowAnonymous ? 1 : 0;
    if (input.moderation !== undefined) fields.moderation = input.moderation;
    if (input.allowComments !== undefined) fields.allow_comments = input.allowComments ? 1 : 0;
    if (input.reminderMinutes !== undefined) fields.reminder_minutes = input.reminderMinutes;
    const names = Object.keys(fields);
    if (names.length) {
      db.query(`UPDATE townhall_sessions SET ${names.map((name) => `${name} = $${name}`).join(", ")}, updated_at = $updatedAt, revision = revision + 1 WHERE id = $id`)
        .run({ ...fields, updatedAt: now(), id: row.id });
      if (fields.title !== undefined && fields.title !== row.title) recordItemActivity({ itemKind: "townhall_session", itemId: row.id, actorId: userId, kind: "title", payload: { from: { label: row.title }, to: { label: String(fields.title) } } });
      audit(userId, null, "townhall.session_updated", { sessionId: row.id, fields: names });
    }
    const next = sessionRow(row.id)!;
    scheduleReminder(next);
    return sessionView(next, userId);
  })();
  sessionChanged(row.id);
  return result;
}

registerActivityKinds("townhall", { title: { shape: "change", coalesce: true } });

/** Moves the session along: go live, end, or reopen (D1078). Ending closes the live poll and unpins. */
export function setSessionState(ref: string, userId: string, state: TownhallState) {
  const { row } = requireEditor(ref, userId);
  if (row.state === state) return sessionView(row, userId);
  if (state === "upcoming") throw invalid("A session goes live or ends; it does not go back to upcoming");
  const timestamp = now();
  const result = db.transaction(() => {
    if (state === "live") {
      db.query("UPDATE townhall_sessions SET state = 'live', went_live_at = COALESCE(went_live_at, ?), ended_at = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?").run(timestamp, timestamp, row.id);
      recordItemActivity({ itemKind: "townhall_session", itemId: row.id, actorId: userId, kind: "townhall_live" });
      // Tell the people who asked by name and the session's members that it started.
      const askers = (db.query("SELECT DISTINCT author_id FROM townhall_questions WHERE session_id = ? AND author_id IS NOT NULL").all(row.id) as Array<{ author_id: string }>).map((entry) => entry.author_id);
      const members = (db.query("SELECT user_id FROM item_members WHERE item_kind = 'townhall_session' AND item_id = ?").all(row.id) as Array<{ user_id: string }>).map((entry) => entry.user_id);
      const recipients = [...new Set([...askers, ...members])].filter((id) => levelOn(row, id) !== "none");
      if (recipients.length) notify({ userIds: recipients, module: "townhall", topic: "townhall.live", title: `${row.title} is live`, body: "Join to ask, upvote, and vote in polls.", href: sessionHref(row), item: { kind: "townhall_session", id: row.id }, actor: userId, dedupeKey: `townhall:live:${row.id}` });
    } else {
      db.query("UPDATE townhall_polls SET status = 'closed', closed_at = ?, updated_at = ? WHERE session_id = ? AND status = 'live'").run(timestamp, timestamp, row.id);
      db.query("UPDATE townhall_sessions SET state = 'ended', ended_at = ?, pinned_question_id = NULL, active_poll_id = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?").run(timestamp, timestamp, row.id);
      recordItemActivity({ itemKind: "townhall_session", itemId: row.id, actorId: userId, kind: "townhall_ended" });
    }
    cancelSchedules({ kind: "townhall_session", id: row.id }, "townhall.remind");
    audit(userId, null, `townhall.session_${state === "live" ? "live" : "ended"}`, { sessionId: row.id });
    return sessionView(sessionRow(row.id)!, userId);
  })();
  sessionChanged(row.id);
  return result;
}

/** Moves the session to the Bin (owner or manager). Its audience link stops working at once. */
export function binSession(ref: string, userId: string) {
  const { row, level } = readSession(ref, userId);
  if (!atLeast(level, "manage") || !canWriteContent(userId)) throw new TownhallError(403, "OWNER_ONLY", "Only the owner or a manager can delete this session");
  const timestamp = new Date();
  db.transaction(() => {
    db.query("UPDATE townhall_sessions SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(timestamp.toISOString(), userId, new Date(timestamp.getTime() + 30 * 86_400_000).toISOString(), timestamp.toISOString(), row.id);
    cancelSchedules({ kind: "townhall_session", id: row.id });
    recordItemActivity({ itemKind: "townhall_session", itemId: row.id, actorId: userId, kind: "binned" });
    audit(userId, null, "townhall.session_binned", { sessionId: row.id });
  })();
  sessionChanged(row.id);
  return { binned: true };
}

function ownerName(userId: string) {
  return (db.query("SELECT display_name FROM users WHERE id = ?").get(userId) as { display_name: string } | null)?.display_name ?? "Former member";
}

export function sessionView(row: SessionRow, userId: string | null): TownhallSessionView {
  const event = row.event_id && userId ? readableEvent(row.event_id, userId) : null;
  return {
    id: row.id, shortId: row.short_id, title: row.title, description: row.description, state: row.state, startsAt: row.starts_at, endsAt: row.ends_at,
    questionsOpen: row.questions_open === 1, allowAnonymous: row.allow_anonymous === 1, moderation: row.moderation, allowComments: row.allow_comments === 1,
    reminderMinutes: row.reminder_minutes, pinnedQuestionId: row.pinned_question_id, activePollId: row.active_poll_id,
    event: event ? { id: event.event.id, title: event.event.title, href: `/calendar/event/${event.event.id}`, start: event.event.start_utc } : null,
    owner: { id: row.owner_id, name: ownerName(row.owner_id) }, href: sessionHref(row), revision: row.revision, wentLiveAt: row.went_live_at, endedAt: row.ended_at,
    recapNote: row.recap_note_id && userId && (db.query("SELECT 1 FROM notes WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").get(row.recap_note_id, userId))
      ? { id: row.recap_note_id, href: notePath(row.recap_note_id) } : null,
    visibility: row.visibility
  };
}

/** Sessions the person can open: live ones first, then newest by start (keyset paged by rank, start, id). */
export function listSessions(userId: string, options: { state?: TownhallState | "all"; q?: string; cursor?: string | null; limit?: number; ids?: readonly string[] | null } = {}): { items: TownhallSessionSummary[]; nextCursor: string | null } {
  const limit = Math.min(Math.max(1, options.limit ?? 50), 100);
  const terms = [readableContainerSql("townhall_session", "s")];
  const params: Record<string, string | number> = { userId, limit: limit + 1 };
  if (options.state && options.state !== "all") { terms.push("s.state = $state"); params.state = options.state; }
  if (options.q?.trim()) { terms.push("instr(lower(s.title), lower($q)) > 0"); params.q = options.q.trim().slice(0, 200); }
  if (options.ids) { terms.push("s.id IN (SELECT value FROM json_each($ids))"); params.ids = JSON.stringify(options.ids); }
  // Keyset over the whole order (live first, then newest), so paging never repeats or skips a session (D1106).
  const cursor = decodeCursor(options.cursor);
  if (cursor) {
    terms.push(`(${RANK_SQL} > $cursorRank OR (${RANK_SQL} = $cursorRank AND (COALESCE(s.starts_at, s.created_at), s.id) < ($cursorAt, $cursorId)))`);
    params.cursorRank = cursor[0]; params.cursorAt = cursor[1]; params.cursorId = cursor[2];
  }
  const rows = db.query(`SELECT s.*, COALESCE(s.starts_at, s.created_at) AS sort_at, ${RANK_SQL} AS sort_rank, u.display_name AS owner_name,
      (SELECT COUNT(*) FROM townhall_questions q WHERE q.session_id = s.id AND q.merged_into IS NULL AND q.status IN ('approved','answered')) AS question_count
    FROM townhall_sessions s JOIN users u ON u.id = s.owner_id WHERE ${terms.join(" AND ")}
    ORDER BY sort_rank, sort_at DESC, s.id DESC LIMIT $limit`).all(params) as Array<SessionRow & { sort_at: string; sort_rank: number; owner_name: string; question_count: number }>;
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({ id: row.id, shortId: row.short_id, title: row.title, state: row.state, startsAt: row.starts_at, endsAt: row.ends_at, questionCount: row.question_count, ownerName: row.owner_name, href: sessionHref(row), updatedAt: row.updated_at })),
    nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([page.at(-1)!.sort_rank, page.at(-1)!.sort_at, page.at(-1)!.id])).toString("base64url") : null
  };
}

const RANK_SQL = "(CASE s.state WHEN 'live' THEN 0 ELSE 1 END)";

/** A list cursor: [rank, sort_at, id]. An older two-part cursor reads as none (the list starts over). */
function decodeCursor(value: string | null | undefined): [number, string, string] | null {
  if (!value || value.length > 200) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    return Array.isArray(parsed) && parsed.length === 3 && (parsed[0] === 0 || parsed[0] === 1) && typeof parsed[1] === "string" && typeof parsed[2] === "string" ? [parsed[0], parsed[1], parsed[2]] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the audience link (public, D1076)

export function publicUrlOf(row: SessionRow): string | null {
  if (!publicPolicyAllows("townhall_session")) return null;
  const token = tokenFromSeed(row.id, row.public_token_seed);
  if (!token || !listPublicLinks("townhall_session", row.id).length) return null;
  return `/p/t/${token}`;
}

export function setPublicLink(ref: string, userId: string, enabled: boolean) {
  const { row } = requireEditor(ref, userId);
  if (enabled && !publicPolicyAllows("townhall_session")) throw new TownhallError(403, "POLICY_OFF", "Public townhall links are turned off for this workspace");
  const result = db.transaction(() => {
    revokePublicLinksOf("townhall_session", row.id, userId);
    let seed: string | null = null;
    if (enabled) {
      // The public_links row as createPublicLink writes it (hash only), with the token derived from a seed (D1076).
      seed = newTokenSeed();
      const token = tokenFromSeed(row.id, seed)!;
      const linkId = Bun.randomUUIDv7();
      db.query(`INSERT INTO public_links (id, kind, item_id, token_hash, token_prefix, created_by, created_at, expires_at, max_uses, settings_json)
        VALUES (?, 'townhall_session', ?, ?, ?, ?, ?, NULL, NULL, ?)`).run(linkId, row.id, tokenHash(token), token.slice(0, 6), userId, now(), JSON.stringify({ perHour: 300 }));
      audit(userId, null, "public.link_created", { linkId, kind: "townhall_session", itemId: row.id, expires: false, maxUses: null });
    }
    db.query("UPDATE townhall_sessions SET public_token_seed = ?, updated_at = ? WHERE id = ?").run(seed, now(), row.id);
    audit(userId, null, enabled ? "townhall.public_link_created" : "townhall.public_link_revoked", { sessionId: row.id });
    return { publicUrl: enabled ? publicUrlOf(sessionRow(row.id)!) : null };
  })();
  sessionChanged(row.id);
  return result;
}

// ---------------------------------------------------------------- questions

function questionRow(questionId: string): QuestionRow | null {
  if (!UUID.test(questionId.toLowerCase())) return null;
  return db.query("SELECT * FROM townhall_questions WHERE id = ?").get(questionId.toLowerCase()) as QuestionRow | null;
}

/** The question and its session when the person can open the session (NOT_FOUND otherwise). */
export function readQuestion(questionId: string, userId: string) {
  const question = questionRow(questionId);
  if (!question) throw notFound("Question");
  const session = sessionRow(question.session_id);
  const level = levelOn(session, userId);
  if (!session || level === "none") throw notFound("Question");
  // A pending or hidden question is the moderators' and its asker's only.
  const moderator = isModerator(level, userId);
  if (!moderator && (question.merged_into || question.status === "hidden" || (question.status === "pending" && !askedBy(question, session.id, { kind: "user", userId })))) throw notFound("Question");
  return { question, session, level, moderator };
}

/** Members asking: whether the session takes questions now. */
function requireAsking(row: SessionRow) {
  if (row.state === "ended") throw new TownhallError(409, "SESSION_ENDED", "This session has ended");
  if (!row.questions_open) throw new TownhallError(409, "QUESTIONS_CLOSED", "Questions are closed for now");
}

export function askQuestion(sessionRef: string, viewer: Viewer, input: { text: string; anonymous?: boolean; name?: string | null; via?: "mcp" | "rest" }, publicSession?: SessionRow) {
  const text = input.text.replace(/\s+$/g, "").trim();
  if (!text) throw invalid("Write a question");
  if (text.length > TOWNHALL_LIMITS.question) throw invalid(`A question is at most ${TOWNHALL_LIMITS.question} characters`);
  let row: SessionRow;
  let moderator = false;
  if (viewer.kind === "user") {
    const found = readSession(sessionRef, viewer.userId);
    row = found.row;
    moderator = isModerator(found.level, viewer.userId);
  } else {
    if (!publicSession) throw notFound();
    row = publicSession;
  }
  requireAsking(row);
  const anonymous = viewer.kind === "public" ? !input.name?.trim() : Boolean(input.anonymous);
  if (anonymous && !row.allow_anonymous) throw new TownhallError(400, "ANONYMOUS_OFF", "This session asks for your name");
  const status: TownhallQuestionStatus = row.moderation === "review" && !moderator ? "pending" : "approved";
  const id = crypto.randomUUID();
  const timestamp = now();
  const via = viewer.kind === "public" ? "public" : input.via ?? currentVia();
  const result = db.transaction(() => {
    const count = (db.query("SELECT COUNT(*) AS count FROM townhall_questions WHERE session_id = ?").get(row.id) as { count: number }).count;
    if (count >= TOWNHALL_LIMITS.questionsPerSession) throw new TownhallError(409, "LIMIT_REACHED", "This session has reached its question limit");
    db.query(`INSERT INTO townhall_questions (id, session_id, author_id, author_label, anonymous, asker_hash, body, status, via, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, row.id, viewer.kind === "user" && !anonymous ? viewer.userId : null,
      viewer.kind === "public" && !anonymous ? input.name!.trim().slice(0, TOWNHALL_LIMITS.name) : null, anonymous ? 1 : 0, anonymous ? askerHash(row.id, viewer) : namedAskerHash(row.id, id, viewer), text, status, via, timestamp, timestamp);
    // An anonymous question names nobody anywhere: no actor on its activity, audit row (and so the server log), or notification (D1100, T620).
    const actor = viewer.kind === "user" && !anonymous ? viewer.userId : null;
    recordItemActivity({ itemKind: "townhall_session", itemId: row.id, actorId: actor, kind: "townhall_asked", via: viewer.kind === "public" ? "public" : undefined, payload: { item: { id, label: "Question" } } });
    audit(actor, null, "townhall.question_asked", { sessionId: row.id, ...(anonymous ? {} : { questionId: id }), anonymous, status, via });
    if (status === "pending") {
      const pending = (db.query("SELECT COUNT(*) AS count FROM townhall_questions WHERE session_id = ? AND status = 'pending' AND merged_into IS NULL").get(row.id) as { count: number }).count;
      notify({ userIds: [row.owner_id], module: "townhall", topic: "townhall.review", title: `${pending} ${pending === 1 ? "question" : "questions"} to review in ${row.title}`, href: `${sessionHref(row)}?filter=review`, item: { kind: "townhall_session", id: row.id }, actor, dedupeKey: `townhall:review:${row.id}` });
    }
    return questionView(db.query("SELECT * FROM townhall_questions WHERE id = ?").get(id) as QuestionRow, row, viewer, moderator);
  })();
  sessionChanged(row.id);
  return result;
}

/** The asker withdraws their own question (any time before it is answered). */
export function withdrawQuestion(questionId: string, viewer: Viewer, publicSession?: SessionRow) {
  const question = questionRow(questionId);
  if (!question) throw notFound("Question");
  const session = viewer.kind === "user" ? sessionRow(question.session_id) : publicSession && publicSession.id === question.session_id ? publicSession : null;
  if (!session || (viewer.kind === "user" && levelOn(session, viewer.userId) === "none")) throw notFound("Question");
  if (!askedBy(question, session.id, viewer)) throw notFound("Question");
  if (question.status === "answered") throw new TownhallError(409, "ANSWERED", "An answered question stays in the session");
  db.transaction(() => {
    db.query("DELETE FROM townhall_questions WHERE id = ?").run(question.id);
    if (session.pinned_question_id === question.id) db.query("UPDATE townhall_sessions SET pinned_question_id = NULL WHERE id = ?").run(session.id);
    const anonymous = question.anonymous === 1;
    audit(viewer.kind === "user" && !anonymous ? viewer.userId : null, null, "townhall.question_withdrawn", { sessionId: session.id, ...(anonymous ? { anonymous } : { questionId: question.id }) });
  })();
  sessionChanged(session.id);
  return { withdrawn: true };
}

/** Upvotes or takes back an upvote (idempotent set-state). */
export function voteQuestion(questionId: string, viewer: Viewer, upvote: boolean, publicSession?: SessionRow) {
  const question = questionRow(questionId);
  if (!question || question.merged_into) throw notFound("Question");
  let session: SessionRow | null;
  if (viewer.kind === "user") {
    session = readQuestion(questionId, viewer.userId).session;
  } else {
    session = publicSession && publicSession.id === question.session_id ? publicSession : null;
    if (!session || (question.status !== "approved" && question.status !== "answered" && !(question.status === "pending" && askedBy(question, session.id, viewer)))) throw notFound("Question");
  }
  if (!session) throw notFound("Question");
  if (session.state === "ended") throw new TownhallError(409, "SESSION_ENDED", "This session has ended");
  if (question.status === "hidden") throw notFound("Question");
  const hash = voterHash(session.id, viewer);
  const changed = db.transaction(() => {
    const changes = upvote
      ? db.query("INSERT OR IGNORE INTO townhall_votes (question_id, voter_hash, created_at) VALUES (?, ?, ?)").run(question.id, hash, now()).changes
      : db.query("DELETE FROM townhall_votes WHERE question_id = ? AND voter_hash = ?").run(question.id, hash).changes;
    if (changes) db.query("UPDATE townhall_questions SET vote_count = (SELECT COUNT(*) FROM townhall_votes WHERE question_id = ?) WHERE id = ?").run(question.id, question.id);
    return changes > 0;
  })();
  if (changed) sessionChanged(session.id);
  const votes = (db.query("SELECT vote_count FROM townhall_questions WHERE id = ?").get(question.id) as { vote_count: number }).vote_count;
  return { questionId: question.id, votes, voted: upvote };
}

const MODERATION_WORDS: Record<TownhallModeration, string> = {
  approve: "approved", hide: "hidden", unhide: "shown again", answered: "answered", reopen: "reopened", pin: "pinned", unpin: "unpinned", star: "starred", unstar: "unstarred", merge: "merged"
};

/** Moderates a question (editors of the session, D1072). */
export function moderateQuestion(questionId: string, userId: string, action: TownhallModeration, options: { targetId?: string } = {}) {
  const question = questionRow(questionId);
  if (!question || question.merged_into) throw notFound("Question");
  const { row: session } = requireEditor(question.session_id, userId);
  const timestamp = now();
  const result = db.transaction(() => {
    const setStatus = (status: TownhallQuestionStatus) => db.query("UPDATE townhall_questions SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(status, timestamp, question.id);
    const unpinIfPinned = () => { if (session.pinned_question_id === question.id) db.query("UPDATE townhall_sessions SET pinned_question_id = NULL, updated_at = ? WHERE id = ?").run(timestamp, session.id); };
    switch (action) {
      case "approve": if (question.status === "pending") setStatus("approved"); break;
      case "hide": setStatus("hidden"); unpinIfPinned(); break;
      case "unhide": if (question.status === "hidden") setStatus(question.answered_at ? "answered" : "approved"); break;
      case "answered":
        db.query("UPDATE townhall_questions SET status = 'answered', answered_at = ?, answered_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(timestamp, userId, timestamp, question.id);
        unpinIfPinned();
        if (question.author_id && question.author_id !== userId && question.status !== "answered" && levelOn(session, question.author_id) !== "none") {
          notify({ userIds: [question.author_id], module: "townhall", topic: "townhall.answered", title: "Your question was answered", body: question.body.slice(0, 200), href: sessionHref(session), item: { kind: "townhall_session", id: session.id }, actor: userId });
        }
        break;
      case "reopen": if (question.status === "answered") db.query("UPDATE townhall_questions SET status = 'approved', answered_at = NULL, answered_by = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?").run(timestamp, question.id); break;
      case "pin":
        if (question.status === "hidden") throw new TownhallError(409, "HIDDEN", "Show the question again before pinning it");
        if (question.status === "pending") setStatus("approved");
        db.query("UPDATE townhall_sessions SET pinned_question_id = ?, updated_at = ? WHERE id = ?").run(question.id, timestamp, session.id);
        break;
      case "unpin": unpinIfPinned(); break;
      case "star": case "unstar": db.query("UPDATE townhall_questions SET starred = ?, updated_at = ? WHERE id = ?").run(action === "star" ? 1 : 0, timestamp, question.id); break;
      case "merge": {
        const target = options.targetId ? questionRow(options.targetId) : null;
        if (!target || target.session_id !== session.id || target.merged_into || target.id === question.id) throw invalid("Choose another question of this session to merge into", "MERGE_TARGET");
        // Its votes join the target's (one per voter), and anything merged into it follows.
        db.query("INSERT OR IGNORE INTO townhall_votes (question_id, voter_hash, created_at) SELECT ?, voter_hash, created_at FROM townhall_votes WHERE question_id = ?").run(target.id, question.id);
        db.query("UPDATE townhall_questions SET merged_into = ?, updated_at = ? WHERE merged_into = ?").run(target.id, timestamp, question.id);
        db.query("UPDATE townhall_questions SET merged_into = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(target.id, timestamp, question.id);
        db.query("UPDATE townhall_questions SET vote_count = (SELECT COUNT(*) FROM townhall_votes WHERE question_id = ?), status = CASE WHEN status = 'pending' THEN 'approved' ELSE status END WHERE id = ?").run(target.id, target.id);
        unpinIfPinned();
        break;
      }
    }
    recordItemActivity({ itemKind: "townhall_question", itemId: question.id, container: { kind: "townhall_session", id: session.id }, actorId: userId, kind: "townhall_moderated", payload: { from: null, to: { label: MODERATION_WORDS[action] } } });
    audit(userId, null, "townhall.question_moderated", { sessionId: session.id, questionId: question.id, action, ...(action === "merge" ? { targetId: options.targetId } : {}) });
    const fresh = sessionRow(session.id)!;
    return questionView((questionRow(action === "merge" ? options.targetId! : question.id))!, fresh, { kind: "user", userId }, true);
  })();
  sessionChanged(session.id);
  return result;
}

function questionView(row: QuestionRow, session: SessionRow, viewer: Viewer, moderator: boolean, extra?: { voted?: boolean; merged?: number; comments?: number; names?: Map<string, string>; mineHash?: string }): TownhallQuestionView {
  const name = row.anonymous ? null : row.author_id ? (extra?.names?.get(row.author_id) ?? ownerName(row.author_id)) : row.author_label ?? null;
  return {
    id: row.id, text: row.body, author: name, authorKind: authorKindOf(row), votes: row.vote_count,
    voted: extra?.voted ?? Boolean(db.query("SELECT 1 FROM townhall_votes WHERE question_id = ? AND voter_hash = ?").get(row.id, voterHash(session.id, viewer))),
    status: row.status, pinned: session.pinned_question_id === row.id, starred: moderator && row.starred === 1, mine: askedBy(row, session.id, viewer, extra?.mineHash),
    createdAt: row.created_at, answeredAt: row.answered_at, mergedCount: extra?.merged ?? 0, commentCount: extra?.comments ?? 0,
    card: moderator ? cardRef(row.card_id) : null
  };
}

// ---------------------------------------------------------------- polls (the shared question engine, D1074)

const host = (sessionId: string) => ({ kind: "townhall_session" as const, id: sessionId });
const POLL_MAX_RATING = 5;
const newItemId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

export type PollInput = { kind: TownhallPollKind; title: string; options?: string[]; resultsHidden?: boolean; launch?: boolean };

function pollQuestion(id: string, input: PollInput): Question {
  const title = input.title.trim();
  if (!title || title.length > TOWNHALL_LIMITS.pollTitle) throw invalid("Give the poll a question of up to 300 characters");
  if (input.kind === "single" || input.kind === "multi") {
    const labels = (input.options ?? []).map((label) => label.trim()).filter(Boolean);
    if (labels.length < 2 || labels.length > TOWNHALL_LIMITS.pollOptions) throw invalid("A choice poll has 2 to 10 options");
    if (labels.some((label) => label.length > TOWNHALL_LIMITS.optionLabel)) throw invalid("An option is at most 120 characters");
    return { id, type: input.kind === "single" ? "single_choice" : "multi_choice", title, options: labels.map((label) => ({ id: newItemId(), label })) };
  }
  if (input.kind === "rating") return { id, type: "rating", title, scale: { min: 1, max: POLL_MAX_RATING, icon: "star" } };
  if (input.kind === "word_cloud") return { id, type: "short_text", title, validation: { maxLength: TOWNHALL_LIMITS.word } };
  return { id, type: "long_text", title, validation: { maxLength: TOWNHALL_LIMITS.openText } };
}

function publishQuestion(sessionId: string, userId: string, change: (set: QuestionSet) => QuestionSet) {
  const base = currentSet(host(sessionId))?.set ?? emptyQuestionSet();
  saveDraftSet(host(sessionId), change(structuredClone(base)), userId);
  publishSet(host(sessionId), userId);
}

export function createPoll(sessionRef: string, userId: string, input: PollInput) {
  const { row } = requireEditor(sessionRef, userId);
  if (row.state === "ended" && input.launch) throw new TownhallError(409, "SESSION_ENDED", "This session has ended");
  const count = (db.query("SELECT COUNT(*) AS count FROM townhall_polls WHERE session_id = ?").get(row.id) as { count: number }).count;
  if (count >= TOWNHALL_LIMITS.pollsPerSession) throw new TownhallError(409, "LIMIT_REACHED", "A session has at most 50 polls");
  const questionId = newItemId();
  const question = pollQuestion(questionId, input);
  const id = crypto.randomUUID();
  const timestamp = now();
  const result = db.transaction(() => {
    publishQuestion(row.id, userId, (set) => ({ ...set, questions: [...set.questions, question] }));
    db.query("INSERT INTO townhall_polls (id, session_id, question_id, kind, status, results_hidden, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)")
      .run(id, row.id, questionId, input.kind, input.resultsHidden ? 1 : 0, count, userId, timestamp, timestamp);
    recordItemActivity({ itemKind: "townhall_session", itemId: row.id, actorId: userId, kind: "townhall_poll", payload: { item: { id, label: "Poll added" } } });
    audit(userId, null, "townhall.poll_created", { sessionId: row.id, pollId: id, kind: input.kind });
    if (input.launch) launchPollInTx(row, id, userId);
    return { pollId: id };
  })();
  sessionChanged(row.id);
  return result;
}

function pollRow(pollId: string, sessionId: string): PollRow {
  const poll = UUID.test(pollId.toLowerCase()) ? db.query("SELECT * FROM townhall_polls WHERE id = ? AND session_id = ?").get(pollId.toLowerCase(), sessionId) as PollRow | null : null;
  if (!poll) throw notFound("Poll");
  return poll;
}

function launchPollInTx(row: SessionRow, pollId: string, userId: string) {
  const timestamp = now();
  // One live poll at a time: launching closes the one before it.
  db.query("UPDATE townhall_polls SET status = 'closed', closed_at = ?, updated_at = ? WHERE session_id = ? AND status = 'live' AND id <> ?").run(timestamp, timestamp, row.id, pollId);
  db.query("UPDATE townhall_polls SET status = 'live', opened_at = COALESCE(opened_at, ?), closed_at = NULL, updated_at = ? WHERE id = ?").run(timestamp, timestamp, pollId);
  db.query("UPDATE townhall_sessions SET active_poll_id = ?, updated_at = ? WHERE id = ?").run(pollId, timestamp, row.id);
  audit(userId, null, "townhall.poll_launched", { sessionId: row.id, pollId });
}

export function launchPoll(sessionRef: string, pollId: string, userId: string) {
  const { row } = requireEditor(sessionRef, userId);
  if (row.state === "ended") throw new TownhallError(409, "SESSION_ENDED", "This session has ended");
  const poll = pollRow(pollId, row.id);
  db.transaction(() => launchPollInTx(row, poll.id, userId))();
  sessionChanged(row.id);
  return { pollId: poll.id, status: "live" as const };
}

export function closePoll(sessionRef: string, pollId: string, userId: string) {
  const { row } = requireEditor(sessionRef, userId);
  const poll = pollRow(pollId, row.id);
  const timestamp = now();
  db.transaction(() => {
    db.query("UPDATE townhall_polls SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'live'").run(timestamp, timestamp, poll.id);
    // The presenter keeps showing a closed poll's results until the host moves on.
    audit(userId, null, "townhall.poll_closed", { sessionId: row.id, pollId: poll.id });
  })();
  sessionChanged(row.id);
  return { pollId: poll.id, status: "closed" as const };
}

/** What the presenter shows: a poll (`pollId`), or nothing (the pinned question, or the join screen). */
export function showOnScreen(sessionRef: string, userId: string, pollId: string | null) {
  const { row } = requireEditor(sessionRef, userId);
  if (pollId) pollRow(pollId, row.id);
  db.query("UPDATE townhall_sessions SET active_poll_id = ?, updated_at = ? WHERE id = ?").run(pollId, now(), row.id);
  sessionChanged(row.id);
  return { activePollId: pollId };
}

export function updatePoll(sessionRef: string, pollId: string, userId: string, input: { resultsHidden?: boolean }) {
  const { row } = requireEditor(sessionRef, userId);
  const poll = pollRow(pollId, row.id);
  if (input.resultsHidden !== undefined) db.query("UPDATE townhall_polls SET results_hidden = ?, updated_at = ? WHERE id = ?").run(input.resultsHidden ? 1 : 0, now(), poll.id);
  sessionChanged(row.id);
  return { pollId: poll.id };
}

/** Deletes a poll and its answers (no Undo: the host confirms first). */
export function deletePoll(sessionRef: string, pollId: string, userId: string) {
  const { row } = requireEditor(sessionRef, userId);
  const poll = pollRow(pollId, row.id);
  db.transaction(() => {
    db.query("DELETE FROM responses WHERE host_kind = 'townhall_session' AND host_id = ? AND subject_kind = 'townhall_poll' AND subject_id = ?").run(row.id, poll.id);
    publishQuestion(row.id, userId, (set) => ({ ...set, questions: set.questions.filter((question) => question.id !== poll.question_id) }));
    db.query("DELETE FROM townhall_polls WHERE id = ?").run(poll.id);
    if (row.active_poll_id === poll.id) db.query("UPDATE townhall_sessions SET active_poll_id = NULL WHERE id = ?").run(row.id);
    audit(userId, null, "townhall.poll_deleted", { sessionId: row.id, pollId: poll.id });
  })();
  sessionChanged(row.id);
  return { deleted: true };
}

/** A vote: option ids (choice), a number 1–5 (rating), or text (word cloud, open text). */
export function votePoll(sessionRef: string, pollId: string, viewer: Viewer, value: { optionIds?: string[]; rating?: number; text?: string }, publicSession?: SessionRow) {
  const row = viewer.kind === "user" ? readSession(sessionRef, viewer.userId).row : publicSession;
  if (!row) throw notFound();
  const poll = pollRow(pollId, row.id);
  if (poll.status !== "live") throw new TownhallError(409, "POLL_CLOSED", poll.status === "draft" ? "This poll has not started" : "This poll is closed");
  const set = currentSet(host(row.id));
  const question = set?.set.questions.find((entry) => entry.id === poll.question_id);
  if (!set || !question) throw notFound("Poll");
  let answer: unknown;
  if (poll.kind === "single") answer = value.optionIds?.[0];
  else if (poll.kind === "multi") answer = { options: [...new Set(value.optionIds ?? [])] };
  else if (poll.kind === "rating") answer = value.rating;
  else answer = value.text?.trim();
  if (answer === undefined || answer === "" || (poll.kind === "multi" && !(answer as { options: string[] }).options.length)) throw invalid("Choose or write an answer");
  const dedupe = pollHash(poll.id, viewer);
  const answers = { [question.id]: answer };
  try {
    db.transaction(() => {
      const existing = db.query("SELECT id FROM responses WHERE host_kind = 'townhall_session' AND host_id = ? AND subject_kind = 'townhall_poll' AND subject_id = ? AND dedupe_hash = ? ORDER BY submitted_at").all(row.id, poll.id, dedupe) as Array<{ id: string }>;
      if (poll.kind === "word_cloud") {
        if (existing.length >= TOWNHALL_LIMITS.wordsPerPerson) throw new TownhallError(409, "WORD_LIMIT", `You can add up to ${TOWNHALL_LIMITS.wordsPerPerson} words`);
        submitResponse({ host: host(row.id), subject: { kind: "townhall_poll", id: poll.id }, respondent: { kind: "anonymous", dedupeHash: dedupe }, answers, audience: viewer.kind === "public" ? "public" : "member" });
      } else if (existing[0]) {
        updateResponse({ responseId: existing[0].id, answers, audience: viewer.kind === "public" ? "public" : "member" });
      } else {
        submitResponse({ host: host(row.id), subject: { kind: "townhall_poll", id: poll.id }, respondent: { kind: "anonymous", dedupeHash: dedupe }, answers, audience: viewer.kind === "public" ? "public" : "member" });
      }
    })();
  } catch (error) {
    if (error instanceof QuestionError) throw new TownhallError(400, "INVALID_ANSWER", "That answer does not fit this poll", { errors: error.details?.errors });
    throw error;
  }
  sessionChanged(row.id);
  return { voted: true };
}

function pollViews(row: SessionRow, viewer: Viewer, moderator: boolean): TownhallPollView[] {
  const polls = db.query(`SELECT * FROM townhall_polls WHERE session_id = ?${moderator ? "" : " AND status <> 'draft'"} ORDER BY position, created_at`).all(row.id) as PollRow[];
  if (!polls.length) return [];
  const set = currentSet(host(row.id))?.set;
  const where = "r.host_kind = 'townhall_session' AND r.host_id = $sessionId AND r.subject_kind = 'townhall_poll' AND r.subject_id = $pollId AND r.status = 'submitted'";
  return polls.map((poll) => {
    const question = set?.questions.find((entry) => entry.id === poll.question_id);
    const params = { sessionId: row.id, pollId: poll.id };
    const total = (db.query(`SELECT COUNT(*) AS count FROM responses r WHERE ${where}`).get(params) as { count: number }).count;
    const visible = moderator || !poll.results_hidden || poll.status === "closed";
    const mine = db.query(`SELECT a.option_id, a.value_num, a.value_text FROM response_answers a JOIN responses r ON r.id = a.response_id WHERE ${where} AND r.dedupe_hash = $hash ORDER BY r.submitted_at, r.rowid, a.ord`)
      .all({ ...params, hash: pollHash(poll.id, viewer) }) as Array<{ option_id: string | null; value_num: number | null; value_text: string | null }>;
    const view: TownhallPollView = {
      id: poll.id, kind: poll.kind, title: question?.title ?? "Poll", options: (question?.options ?? []).map((option) => ({ id: option.id, label: option.label })),
      status: poll.status, resultsHidden: poll.results_hidden === 1, counts: null, total, myVote: [], words: [], entries: [], average: null, distribution: {}, myRating: null, myWords: [], max: POLL_MAX_RATING
    };
    if (poll.kind === "single" || poll.kind === "multi") {
      view.myVote = mine.map((entry) => entry.option_id!).filter(Boolean);
      if (visible) {
        const counts = db.query(`SELECT a.option_id AS id, COUNT(*) AS count FROM response_answers a JOIN responses r ON r.id = a.response_id WHERE ${where} GROUP BY a.option_id`).all(params) as Array<{ id: string; count: number }>;
        view.counts = Object.fromEntries(view.options.map((option) => [option.id, counts.find((entry) => entry.id === option.id)?.count ?? 0]));
      }
    } else if (poll.kind === "rating") {
      view.myRating = mine[0]?.value_num ?? null;
      if (visible) {
        const rows = db.query(`SELECT a.value_num AS value, COUNT(*) AS count FROM response_answers a JOIN responses r ON r.id = a.response_id WHERE ${where} GROUP BY a.value_num`).all(params) as Array<{ value: number; count: number }>;
        view.distribution = Object.fromEntries(rows.map((entry) => [entry.value, entry.count]));
        const sum = rows.reduce((acc, entry) => acc + entry.value * entry.count, 0);
        view.average = total ? Math.round((sum / total) * 10) / 10 : null;
        view.counts = {};
      }
    } else if (poll.kind === "word_cloud") {
      view.myWords = mine.map((entry) => entry.value_text ?? "").filter(Boolean);
      if (visible) {
        view.words = (db.query(`SELECT lower(trim(a.value_text)) AS text, COUNT(*) AS count FROM response_answers a JOIN responses r ON r.id = a.response_id WHERE ${where} AND a.value_text IS NOT NULL GROUP BY lower(trim(a.value_text)) ORDER BY count DESC, text LIMIT 60`).all(params) as Array<{ text: string; count: number }>);
        view.counts = {};
      }
    } else {
      view.myWords = mine.map((entry) => entry.value_text ?? "").filter(Boolean);
      if (visible) {
        view.entries = (db.query(`SELECT a.value_text AS text FROM response_answers a JOIN responses r ON r.id = a.response_id WHERE ${where} AND a.value_text IS NOT NULL ORDER BY r.submitted_at DESC LIMIT 50`).all(params) as Array<{ text: string }>).map((entry) => entry.text);
        view.counts = {};
      }
    }
    return view;
  });
}

// ---------------------------------------------------------------- attendance and the live state

/** Notes that the viewer is here (first and last seen), at most once a minute per viewer. */
export function touchAttendance(row: SessionRow, viewer: Viewer) {
  const hash = attendeeHash(row.id, viewer);
  const timestamp = now();
  const fresh = db.query("SELECT last_seen_at FROM townhall_attendance WHERE session_id = ? AND attendee_hash = ?").get(row.id, hash) as { last_seen_at: string } | null;
  if (fresh && Date.parse(fresh.last_seen_at) > Date.now() - 60_000) return;
  db.query(`INSERT INTO townhall_attendance (session_id, attendee_hash, user_id, via, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (session_id, attendee_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at`).run(row.id, hash, viewer.kind === "user" ? viewer.userId : null, viewer.kind === "user" ? "web" : "public", timestamp, timestamp);
}

/** The whole live state for one viewer (the session page, the presenter, the public page, MCP). */
export function liveState(row: SessionRow, viewer: Viewer, level: ItemLevel | "public"): TownhallLiveState {
  const userId = viewer.kind === "user" ? viewer.userId : null;
  const moderator = level !== "public" && userId !== null && isModerator(level, userId);
  const open = row.state !== "ended";
  const you: TownhallYou = {
    level: level === "public" ? "public" : level,
    canModerate: moderator,
    canAsk: open && row.questions_open === 1,
    canVote: open,
    canComment: level !== "public" && row.allow_comments === 1 && userId !== null && canWriteContent(userId),
    canManage: level !== "public" && atLeast(level, "manage") && userId !== null && canWriteContent(userId),
    ...(viewer.kind === "public" ? { name: viewer.name } : {})
  };
  const rows = db.query("SELECT * FROM townhall_questions WHERE session_id = ? AND merged_into IS NULL ORDER BY created_at, id LIMIT 2000").all(row.id) as QuestionRow[];
  const mineHash = askerHash(row.id, viewer);
  const shown = rows.filter((question) => moderator || question.status === "approved" || question.status === "answered" || (question.status === "pending" && askedBy(question, row.id, viewer, mineHash)));
  const voted = new Set((db.query("SELECT v.question_id AS id FROM townhall_votes v JOIN townhall_questions q ON q.id = v.question_id WHERE q.session_id = ? AND v.voter_hash = ?").all(row.id, voterHash(row.id, viewer)) as Array<{ id: string }>).map((entry) => entry.id));
  const merged = new Map((db.query("SELECT merged_into AS id, COUNT(*) AS count FROM townhall_questions WHERE session_id = ? AND merged_into IS NOT NULL GROUP BY merged_into").all(row.id) as Array<{ id: string; count: number }>).map((entry) => [entry.id, entry.count]));
  const comments = level === "public" ? new Map<string, number>() : new Map((db.query(`SELECT c.item_id AS id, COUNT(*) AS count FROM item_comments c JOIN townhall_questions q ON q.id = c.item_id
    WHERE c.item_kind = 'townhall_question' AND q.session_id = ? AND c.deleted_at IS NULL GROUP BY c.item_id`).all(row.id) as Array<{ id: string; count: number }>).map((entry) => [entry.id, entry.count]));
  const authorIds = [...new Set(shown.filter((question) => question.author_id && !question.anonymous).map((question) => question.author_id!))];
  const names = new Map(authorIds.length ? (db.query(`SELECT id, display_name FROM users WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(authorIds)) as Array<{ id: string; display_name: string }>).map((entry) => [entry.id, entry.display_name]) : []);
  const questions = shown.map((question) => questionView(question, row, viewer, moderator, { voted: voted.has(question.id), merged: merged.get(question.id) ?? 0, comments: comments.get(question.id) ?? 0, names, mineHash }));
  const participants = (db.query("SELECT COUNT(*) AS count FROM townhall_attendance WHERE session_id = ?").get(row.id) as { count: number }).count;
  const state: TownhallLiveState = {
    session: sessionView(row, userId),
    you,
    questions,
    polls: pollViews(row, viewer, moderator),
    stats: {
      questions: rows.filter((question) => question.status === "approved" || question.status === "answered").length,
      pending: moderator ? rows.filter((question) => question.status === "pending").length : 0,
      answered: rows.filter((question) => question.status === "answered").length,
      participants
    }
  };
  if (level === "public") {
    // The audience link sees no internal ids it does not need: the event, owner id, and note are left out.
    state.session = { ...state.session, event: null, owner: { id: "", name: state.session.owner.name }, recapNote: null, visibility: "all_users" };
  }
  if (moderator) {
    state.publicAllowed = publicPolicyAllows("townhall_session");
    state.publicUrl = publicUrlOf(row);
  }
  return state;
}

export function stateFor(ref: string, userId: string) {
  const { row, level } = readSession(ref, userId);
  return liveState(row, { kind: "user", userId }, level);
}

// ---------------------------------------------------------------- recap (D1079)

export function recap(ref: string, userId: string): TownhallRecap {
  const { row, level } = readSession(ref, userId);
  const moderator = isModerator(level, userId);
  const questions = db.query(`SELECT q.*, u.display_name AS author_name FROM townhall_questions q LEFT JOIN users u ON u.id = q.author_id
    WHERE q.session_id = ? AND q.merged_into IS NULL ORDER BY q.vote_count DESC, q.created_at LIMIT 2000`).all(row.id) as Array<QuestionRow & { author_name: string | null }>;
  const author = (question: QuestionRow & { author_name: string | null }) => question.anonymous ? null : question.author_name ?? question.author_label ?? null;
  const shownToReader = (question: QuestionRow) => question.status !== "hidden" && (moderator || question.status !== "pending");
  const answered = questions.filter((question) => question.status === "answered");
  const open = questions.filter((question) => question.status === "approved" || (moderator && question.status === "pending"));
  const attendance = db.query("SELECT via, COUNT(*) AS count FROM townhall_attendance WHERE session_id = ? GROUP BY via").all(row.id) as Array<{ via: string; count: number }>;
  const members = attendance.find((entry) => entry.via === "web")?.count ?? 0;
  const publicCount = attendance.find((entry) => entry.via === "public")?.count ?? 0;
  const polls = pollViews(row, { kind: "user", userId }, moderator).filter((poll) => poll.status !== "draft");
  return {
    session: { id: row.id, title: row.title, state: row.state, startsAt: row.starts_at, wentLiveAt: row.went_live_at, endedAt: row.ended_at, href: sessionHref(row) },
    totals: {
      questions: questions.filter((question) => question.status !== "hidden" && question.status !== "pending").length, answered: answered.length, unanswered: open.length,
      hidden: moderator ? questions.filter((question) => question.status === "hidden").length : 0,
      // Upvotes on questions this reader can see: a pending question is the hosts' only (D1109).
      votes: questions.filter(shownToReader).reduce((sum, question) => sum + question.vote_count, 0),
      participants: members + publicCount, members, publicParticipants: publicCount, polls: polls.length
    },
    answered: answered.map((question) => ({ id: question.id, text: question.body, votes: question.vote_count, author: author(question), authorKind: authorKindOf(question), answeredAt: question.answered_at })),
    unanswered: open.map((question) => ({ id: question.id, text: question.body, votes: question.vote_count, author: author(question), authorKind: authorKindOf(question), card: moderator ? cardRef(question.card_id) : null })),
    polls: polls.map((poll) => ({
      id: poll.id, kind: poll.kind, title: poll.title, total: poll.total, average: poll.average,
      results: poll.kind === "single" || poll.kind === "multi" ? poll.options.map((option) => ({ label: option.label, count: poll.counts?.[option.id] ?? 0 }))
        : poll.kind === "rating" ? Array.from({ length: poll.max }, (_, index) => ({ label: `${index + 1} ★`, count: poll.distribution[index + 1] ?? 0 }))
        : poll.kind === "word_cloud" ? poll.words.slice(0, 20).map((word) => ({ label: word.text, count: word.count }))
        : poll.entries.slice(0, 20).map((entry) => ({ label: entry, count: 1 }))
    }))
  };
}

const mdEscape = (text: string) => text.replace(/([\\`*_[\]#<>|])/g, "\\$1").replace(/\n+/g, " ");

export function recapMarkdown(data: TownhallRecap): string {
  const lines = [`# ${mdEscape(data.session.title)}: recap`, ""];
  const when = data.session.wentLiveAt ?? data.session.startsAt;
  if (when) lines.push(`Held ${when.slice(0, 10)}.`, "");
  lines.push(`- ${data.totals.participants} participants, ${data.totals.questions} questions, ${data.totals.votes} upvotes`, `- ${data.totals.answered} answered, ${data.totals.unanswered} still open`, `- ${data.totals.polls} polls`, "");
  lines.push("## Answered", "");
  if (!data.answered.length) lines.push("None.", "");
  for (const question of data.answered) lines.push(`- ${mdEscape(question.text)} (${question.votes} ▲${question.author ? `, ${mdEscape(authorLabel(question) ?? "")}` : ""})`);
  lines.push("", "## Still open", "");
  if (!data.unanswered.length) lines.push("None.", "");
  for (const question of data.unanswered) lines.push(`- [ ] ${mdEscape(question.text)} (${question.votes} ▲${question.author ? `, ${mdEscape(authorLabel(question) ?? "")}` : ""})`);
  if (data.polls.length) {
    lines.push("", "## Polls", "");
    for (const poll of data.polls) {
      lines.push(`### ${mdEscape(poll.title)}`, "", `${poll.total} ${poll.total === 1 ? "answer" : "answers"}${poll.average !== null ? `, average ${poll.average} of 5` : ""}`, "");
      for (const result of poll.results) lines.push(`- ${mdEscape(result.label)}${poll.kind === "open_text" ? "" : `: ${result.count}`}`);
      lines.push("");
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

/** Questions as CSV (formula-injection safe, T514): status, votes, asker (named only), asked, answered. */
export function recapCsv(ref: string, userId: string): string {
  const { row, level } = readSession(ref, userId);
  const moderator = isModerator(level, userId);
  const rows = db.query(`SELECT q.*, u.display_name AS author_name FROM townhall_questions q LEFT JOIN users u ON u.id = q.author_id
    WHERE q.session_id = ? AND q.merged_into IS NULL ${moderator ? "" : "AND q.status IN ('approved','answered')"} ORDER BY q.vote_count DESC, q.created_at LIMIT 2000`).all(row.id) as Array<QuestionRow & { author_name: string | null }>;
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) || text.startsWith("'") ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [["Question", "Status", "Upvotes", "Asked by", "Asked at", "Answered at"].map(cell).join(",")];
  for (const question of rows) lines.push([question.body, question.status, question.vote_count, question.anonymous ? "Anonymous" : question.author_name ?? authorLabel({ author: question.author_label, authorKind: "guest" }) ?? "", question.created_at, question.answered_at ?? ""].map(cell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** Posts the recap as a new note of the person (a draft they publish), linked to the session (D1079). */
export async function postRecapNote(ref: string, userId: string) {
  const { row } = requireEditor(ref, userId);
  const { createDraftNote } = await import("../noteDrafts");
  const { createLink } = await import("../links/service");
  const markdown = recapMarkdown(recap(row.id, userId));
  const note = await createDraftNote(userId, null, markdown);
  db.transaction(() => {
    db.query("UPDATE townhall_sessions SET recap_note_id = ?, updated_at = ? WHERE id = ?").run(note.id, now(), row.id);
    try { createLink({ a: { kind: "townhall_session", id: row.id }, b: { kind: "note", id: note.id }, relation: "relates", actorId: userId }); } catch { /* already linked */ }
    audit(userId, null, "townhall.recap_posted", { sessionId: row.id, noteId: note.id });
  })();
  sessionChanged(row.id);
  return { noteId: note.id, href: notePath(note.id) };
}

// ---------------------------------------------------------------- questions → cards (D1080)

export function questionsToCards(sessionRef: string, userId: string, input: { boardId: string; columnId: string; questionIds: string[] }) {
  const { row } = requireEditor(sessionRef, userId);
  const ids = [...new Set(input.questionIds.map((id) => id.toLowerCase()))];
  if (!ids.length || ids.length > TOWNHALL_LIMITS.cardsAtOnce) throw invalid(`Choose 1 to ${TOWNHALL_LIMITS.cardsAtOnce} questions`);
  const questions = ids.map((id) => questionRow(id)).filter((question): question is QuestionRow => question !== null && question.session_id === row.id && !question.merged_into);
  if (questions.length !== ids.length) throw notFound("Question");
  // Lazy: Tasks is a sibling module; importing it here only when used keeps the module graph light.
  const created: Array<{ questionId: string; cardId: string; href: string }> = [];
  return import("../tasks/service").then(async ({ createCard }) => {
    const { createLink } = await import("../links/service");
    for (const question of questions) {
      const existing = cardRef(question.card_id);
      if (existing) { created.push({ questionId: question.id, cardId: existing.id, href: existing.href }); continue; }
      const title = question.body.length > 200 ? `${question.body.slice(0, 197)}…` : question.body;
      const description = `${question.body.length > 200 ? `${question.body}\n\n` : ""}From the townhall [${mdEscape(row.title)}](${sessionHref(row)}) · ${question.vote_count} ${question.vote_count === 1 ? "upvote" : "upvotes"}`;
      const { card } = await createCard(userId, input.boardId.toLowerCase(), { columnId: input.columnId.toLowerCase(), title, description }) as unknown as { card: { id: string; board_id: string } };
      db.transaction(() => {
        db.query("UPDATE townhall_questions SET card_id = ?, updated_at = ? WHERE id = ?").run(card.id, now(), question.id);
        try { createLink({ a: { kind: "card", id: card.id }, b: { kind: "townhall_question", id: question.id }, relation: "source", actorId: userId }); } catch { /* the link is a convenience */ }
        recordItemActivity({ itemKind: "townhall_question", itemId: question.id, container: { kind: "townhall_session", id: row.id }, actorId: userId, kind: "townhall_card", payload: { item: { id: card.id, label: "Card", kind: "card" } } });
        audit(userId, null, "townhall.question_to_card", { sessionId: row.id, questionId: question.id, cardId: card.id });
      })();
      created.push({ questionId: question.id, cardId: card.id, href: cardPath(card.board_id, card.id) });
    }
    sessionChanged(row.id);
    return { cards: created };
  });
}

// ---------------------------------------------------------------- reminders (schedules, D1081)

export function runReminder(sessionId: string) {
  const row = sessionRow(sessionId);
  if (!row || row.deleted_at !== null || row.state !== "upcoming") return;
  const askers = (db.query("SELECT DISTINCT author_id FROM townhall_questions WHERE session_id = ? AND author_id IS NOT NULL").all(row.id) as Array<{ author_id: string }>).map((entry) => entry.author_id);
  const members = (db.query("SELECT user_id FROM item_members WHERE item_kind = 'townhall_session' AND item_id = ?").all(row.id) as Array<{ user_id: string }>).map((entry) => entry.user_id);
  const recipients = [...new Set([row.owner_id, ...askers, ...members])].filter((id) => levelOn(row, id) !== "none");
  const minutes = row.reminder_minutes;
  notify({ userIds: recipients, includeActor: true, module: "townhall", topic: "townhall.reminder", title: `${row.title} starts in ${minutes >= 60 ? `${Math.round(minutes / 60)} h` : `${minutes} min`}`, body: "Add your questions before it starts.", href: sessionHref(row), item: { kind: "townhall_session", id: row.id }, dedupeKey: `townhall:remind:${row.id}`,
    // And by email under the Townhall switch (D1055); the template re-reads the session at send time.
    email: { template: "townhall.reminder", payload: { sessionId: row.id }, coalesceKey: `townhall-remind:${row.id}` } });
}
