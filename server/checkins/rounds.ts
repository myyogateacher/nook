import { audit, db, now } from "../db";
import { notifyMentions } from "../activity/mentions";
import { cancelSchedules, upsertSchedule } from "../schedules/service";
import { notify } from "../notify";
import { recordItemActivity } from "../activity/service";
import { currentSet, getResponse, setVersion, submitResponse, updateResponse, QuestionError } from "../questions/service";
import { keyedHash } from "../public/secret";
import { resolveRef, syncMentions } from "../links/service";
import { readableCard, boardLevel } from "../tasks/access";
import { flagsForCard, replaceCardFlags } from "../tasks/tags";
import { recordCardActivity } from "../tasks/activity";
import { cardPath } from "../friendlyPaths";
import { canWriteContent } from "../team/userRole";
import { LEVEL_RANK } from "../access/levels";
import { nextFires } from "../../shared/schedules";
import { utcToZoned, zonedToUtc } from "../../shared/calendarRecurrence";
import { ANSWER_GRACE_MS, ANSWER_REF_PATTERN, answerText, type ParticipationState } from "../../shared/checkins";
import type { QuestionSet, ResponseSummary } from "../../shared/questions";
import { CheckinError, checkinHref, checkinLevel, checkinRow, notFound, roundRow, scheduleOf, summaryOptions, type CheckinRow, type ParticipantRow, type RoundRow, type RoundParticipantRow } from "./store";
import { runGoalUpdaters, type StandupGoalUpdate } from "./goalUpdates";
import { queueRoundNote } from "./noteDigest";
import { logger } from "../log";

const clog = logger("checkins");

/**
 * Rounds (docs/plan/WORKSPACE_MODULES.md §D.4, D930–D937): when they open, remind, and close, and
 * how answers, skips, and blockers are stored.
 *
 * One schedule per standup (`checkins.drive`, a `{ once }` rule at the standup's next event) drives
 * everything (D939): a participant's round opening in their zone, a reminder before their deadline,
 * a round closing. The handler (`driveCheckin`) does every event that is due, then re-arms the
 * schedule at the next one. That is one schedule row however many people and zones take part (T552),
 * and the dispatcher's at-most-once fire rows keep each event single.
 *
 * A round's date is the cadence date in the zone that reaches it (D931): with people in Tokyo and
 * Lisbon, Tuesday's round is created when Tokyo's Tuesday 09:30 arrives, and Lisbon's people get
 * their own open and deadline instants (their Tuesday 09:30) in `checkin_round_participants`.
 */

export const DRIVE_PURPOSE = "checkins.drive";
const MINUTE = 60_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** The standup's participants who can still take part: blocked (disabled) people are left out of rounds, counts, and lists (D1161). */
export const participantsOf = (checkinId: string) => db.query(`SELECT p.* FROM checkin_participants p JOIN users u ON u.id = p.user_id AND u.disabled_at IS NULL
  WHERE p.checkin_id = ? ORDER BY p.joined_at, p.user_id`).all(checkinId) as ParticipantRow[];

/** The zone a participant's round opens in. */
export const zoneOf = (row: CheckinRow, participant: Pick<ParticipantRow, "tz">) => scheduleOf(row).zoneMode === "each" ? participant.tz ?? row.tz : row.tz;

const ruleOf = (row: CheckinRow) => {
  const schedule = scheduleOf(row);
  return { cadence: { weekdays: [...schedule.weekdays].sort(), at: schedule.at, ...(schedule.everyNWeeks > 1 ? { everyNWeeks: schedule.everyNWeeks } : {}) } };
};

/** Re-expands participant groups into rows (`via_group_id`): new members join, people who left a group leave (direct rows stay). */
export function syncGroupParticipants(checkinId: string, timestamp = now()) {
  const groups = (db.query("SELECT group_id FROM checkin_participant_groups WHERE checkin_id = ?").all(checkinId) as Array<{ group_id: string }>).map((row) => row.group_id);
  const members = groups.length
    ? db.query(`SELECT gm.user_id, MIN(gm.group_id) AS group_id FROM group_members gm JOIN users u ON u.id = gm.user_id AND u.disabled_at IS NULL AND u.kind = 'person'
        WHERE gm.group_id IN (SELECT value FROM json_each(?)) GROUP BY gm.user_id`).all(JSON.stringify(groups)) as Array<{ user_id: string; group_id: string }>
    : [];
  const wanted = new Map(members.map((row) => [row.user_id, row.group_id]));
  for (const row of db.query("SELECT user_id FROM checkin_participants WHERE checkin_id = ? AND via_group_id IS NOT NULL").all(checkinId) as Array<{ user_id: string }>) {
    if (!wanted.has(row.user_id)) db.query("DELETE FROM checkin_participants WHERE checkin_id = ? AND user_id = ? AND via_group_id IS NOT NULL").run(checkinId, row.user_id);
  }
  const insert = db.query("INSERT OR IGNORE INTO checkin_participants (checkin_id, user_id, joined_at, via_group_id) VALUES (?, ?, ?, ?)");
  for (const [userId, groupId] of wanted) insert.run(checkinId, userId, timestamp, groupId);
}

export function refreshRoundCounts(roundId: string) {
  db.query(`UPDATE checkin_rounds SET
      answered_count = (SELECT COUNT(*) FROM checkin_round_participants WHERE round_id = $id AND status IN ('answered','late')),
      participant_count = (SELECT COUNT(*) FROM checkin_round_participants WHERE round_id = $id AND status <> 'out')
    WHERE id = $id`).run({ id: roundId });
}

/** The participant rows a new round gets (open and deadline per person, `out` when paused over the date). */
function participantPlan(row: CheckinRow, date: string, nowMs: number, manual: boolean) {
  const schedule = scheduleOf(row);
  return participantsOf(row.id).map((participant) => {
    const opens = manual ? nowMs : zonedToUtc(`${date}T${schedule.at}`, zoneOf(row, participant));
    const status: ParticipationState = participant.paused_until && participant.paused_until >= date ? "out" : "pending";
    return { userId: participant.user_id, opens, deadline: opens + row.deadline_minutes * MINUTE, status };
  });
}

/** Creates the round of `date` (scheduled or manual). Null when there is nobody to ask or (scheduled) it would already be over. */
export function createRound(row: CheckinRow, date: string, nowMs: number, manual: boolean): RoundRow | null {
  syncGroupParticipants(row.id, iso(nowMs));
  const plan = participantPlan(row, date, nowMs, manual);
  if (!plan.length) return null;
  const closes = Math.max(...plan.map((entry) => entry.deadline));
  if (!manual && closes <= nowMs) return null;
  const id = Bun.randomUUIDv7();
  const timestamp = iso(nowMs);
  const inserted = db.query(`INSERT OR IGNORE INTO checkin_rounds (id, checkin_id, round_date, opens_at, closes_at, status, manual, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`)
    .run(id, row.id, date, iso(Math.min(...plan.map((entry) => entry.opens))), iso(closes), manual ? 1 : 0, timestamp).changes;
  if (inserted !== 1) return null;
  const insert = db.query("INSERT INTO checkin_round_participants (round_id, user_id, status, opens_at, deadline_at) VALUES (?, ?, ?, ?, ?)");
  for (const entry of plan) insert.run(id, entry.userId, entry.status, iso(entry.opens), iso(entry.deadline));
  refreshRoundCounts(id);
  recordItemActivity({ itemKind: "checkin", itemId: row.id, actorId: null, via: "system", kind: "round_opened", payload: { item: { id, label: date, kind: "checkin_round" } }, at: timestamp });
  return roundRow(id);
}

/** Adds participants who joined after a round opened to its still-open rounds (their own open time, not later than the close). */
export function joinOpenRounds(row: CheckinRow, userIds: readonly string[], nowMs: number) {
  if (!userIds.length) return;
  const schedule = scheduleOf(row);
  const participants = new Map(participantsOf(row.id).map((participant) => [participant.user_id, participant]));
  for (const round of db.query("SELECT * FROM checkin_rounds WHERE checkin_id = ? AND status = 'open'").all(row.id) as RoundRow[]) {
    const closes = Date.parse(round.closes_at);
    for (const userId of userIds) {
      const participant = participants.get(userId);
      if (!participant) continue;
      const scheduled = round.manual ? nowMs : zonedToUtc(`${round.round_date}T${schedule.at}`, zoneOf(row, participant));
      const opens = Math.min(Math.max(scheduled, nowMs), closes);
      db.query("INSERT OR IGNORE INTO checkin_round_participants (round_id, user_id, status, opens_at, deadline_at) VALUES (?, ?, 'pending', ?, ?)")
        .run(round.id, userId, iso(opens), iso(Math.min(opens + row.deadline_minutes * MINUTE, closes)));
    }
    refreshRoundCounts(round.id);
  }
}

/** Removes people who left from the open rounds where they had not answered yet. */
export function leaveOpenRounds(checkinId: string, userIds: readonly string[]) {
  if (!userIds.length) return;
  for (const round of db.query("SELECT id FROM checkin_rounds WHERE checkin_id = ? AND status = 'open'").all(checkinId) as Array<{ id: string }>) {
    db.query("DELETE FROM checkin_round_participants WHERE round_id = ? AND status IN ('pending','out') AND user_id IN (SELECT value FROM json_each(?))").run(round.id, JSON.stringify(userIds));
    refreshRoundCounts(round.id);
  }
}

const zonesOf = (row: CheckinRow) => [...new Set(participantsOf(row.id).map((participant) => zoneOf(row, participant)))];

/** Every event of the standup still to come after `nowMs`: the next instant to wake for, or null. */
export function nextEventMs(row: CheckinRow, nowMs: number): number | null {
  const candidates: number[] = [];
  const createdMs = Date.parse(row.created_at);
  if (row.status === "active" && row.deleted_at === null) {
    const rule = ruleOf(row);
    for (const tz of zonesOf(row)) {
      const [next] = nextFires(rule, tz, Math.max(nowMs, createdMs - 1), 1);
      if (next !== undefined) candidates.push(next);
    }
  }
  if (row.deleted_at === null) {
    const pending = db.query(`SELECT rp.opens_at, rp.deadline_at, rp.notified_at, rp.reminded_at FROM checkin_round_participants rp JOIN checkin_rounds r ON r.id = rp.round_id
      WHERE r.checkin_id = ? AND r.status = 'open' AND rp.status = 'pending'`).all(row.id) as Array<{ opens_at: string; deadline_at: string; notified_at: string | null; reminded_at: string | null }>;
    for (const entry of pending) {
      const opens = Date.parse(entry.opens_at);
      if (!entry.notified_at && opens > nowMs) candidates.push(opens);
      if (row.reminder_minutes_before && !entry.reminded_at) {
        const remind = Date.parse(entry.deadline_at) - row.reminder_minutes_before * MINUTE;
        if (remind > nowMs && remind > opens) candidates.push(remind);
      }
    }
    const close = db.query("SELECT MIN(closes_at) AS at FROM checkin_rounds WHERE checkin_id = ? AND status = 'open'").get(row.id) as { at: string | null };
    if (close.at) candidates.push(Math.max(Date.parse(close.at), nowMs + 1));
  }
  const future = candidates.filter((at) => at > nowMs);
  return future.length ? Math.min(...future) : null;
}

/**
 * Points the standup's one schedule at its next event (or removes it). The schedule is replaced, not
 * updated, so the dispatcher's own advance after a handler never overwrites it.
 */
export function rearm(row: CheckinRow, nowMs = Date.now()) {
  ensureWatchdog();
  cancelSchedules({ kind: "checkin", id: row.id }, DRIVE_PURPOSE);
  const next = nextEventMs(row, nowMs);
  if (next === null) return null;
  upsertSchedule({ kind: "checkin", id: row.id }, DRIVE_PURPOSE, { once: iso(next) }, {}, { tz: "UTC", userId: row.owner_id, fromMs: nowMs });
  return iso(next);
}

const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
export { dateLabel };

function durationText(ms: number) {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

const answerHref = (row: CheckinRow, round: Pick<RoundRow, "round_date">) => `${checkinHref(row)}/${round.round_date}/answer`;

function notifyOpened(row: CheckinRow, nowMs: number) {
  const due = db.query(`SELECT rp.*, r.round_date FROM checkin_round_participants rp JOIN checkin_rounds r ON r.id = rp.round_id
    WHERE r.checkin_id = ? AND r.status = 'open' AND rp.status = 'pending' AND rp.notified_at IS NULL AND rp.opens_at <= ?`).all(row.id, iso(nowMs)) as Array<RoundParticipantRow & { round_date: string }>;
  for (const entry of due) {
    const left = Date.parse(entry.deadline_at) - nowMs;
    notify({
      userIds: [entry.user_id], module: "checkins", topic: "checkins.open", title: `Time for ${row.name}`,
      body: left > 0 ? `Answer in the next ${durationText(left)}.` : "Answer when you can.", href: answerHref(row, entry), item: { kind: "checkin_round", id: entry.round_id },
      dedupeKey: `checkin-round:${entry.round_id}`, nowMs
    });
    db.query("UPDATE checkin_round_participants SET notified_at = ? WHERE round_id = ? AND user_id = ?").run(iso(nowMs), entry.round_id, entry.user_id);
  }
}

function remindDue(row: CheckinRow, nowMs: number) {
  if (!row.reminder_minutes_before) return;
  const due = db.query(`SELECT rp.*, r.round_date FROM checkin_round_participants rp JOIN checkin_rounds r ON r.id = rp.round_id
    WHERE r.checkin_id = ? AND r.status = 'open' AND rp.status = 'pending' AND rp.reminded_at IS NULL AND rp.opens_at <= ? AND rp.deadline_at > ?`).all(row.id, iso(nowMs), iso(nowMs)) as Array<RoundParticipantRow & { round_date: string }>;
  for (const entry of due) {
    const deadline = Date.parse(entry.deadline_at);
    if (deadline - row.reminder_minutes_before * MINUTE > nowMs) continue;
    notify({
      userIds: [entry.user_id], module: "checkins", topic: "checkins.remind", title: `Reminder: ${row.name}`, body: `Closes in ${durationText(deadline - nowMs)}.`,
      href: answerHref(row, entry), item: { kind: "checkin_round", id: entry.round_id }, dedupeKey: `checkin-round:${entry.round_id}`, nowMs
    });
    db.query("UPDATE checkin_round_participants SET reminded_at = ?, notified_at = COALESCE(notified_at, ?) WHERE round_id = ? AND user_id = ?").run(iso(nowMs), iso(nowMs), entry.round_id, entry.user_id);
  }
}

/** Who gets a round's summary: the owner and (by default) participants, adjusted by each person's own choice, readers only. */
export function summaryRecipients(row: CheckinRow): string[] {
  const options = summaryOptions(row);
  const ids = new Set<string>([row.owner_id]);
  if (options.notifyParticipants) for (const participant of participantsOf(row.id)) ids.add(participant.user_id);
  for (const sub of db.query("SELECT user_id, summaries FROM checkin_subscriptions WHERE checkin_id = ?").all(row.id) as Array<{ user_id: string; summaries: number }>) {
    if (sub.summaries) ids.add(sub.user_id);
    else ids.delete(sub.user_id);
  }
  return [...ids].filter((userId) => checkinLevel(row, userId) !== "none");
}

/** The one-line summary of a round: "3 of 4 answered · 1 blocker · mood 3.8". */
export function roundSummaryLine(row: CheckinRow, roundId: string) {
  const round = roundRow(roundId)!;
  const blockers = row.anonymous ? 0 : (db.query("SELECT COUNT(DISTINCT card_id) AS count FROM checkin_blockers WHERE round_id = ?").get(roundId) as { count: number }).count;
  const mood = roundMood(row, roundId);
  return [`${round.answered_count} of ${round.participant_count} answered`, blockers ? `${blockers} blocker${blockers === 1 ? "" : "s"}` : null, mood?.average != null ? `mood ${mood.average.toFixed(1)}` : null].filter(Boolean).join(" · ");
}

/** Mood of a round: the mean of answers to `mood`-role questions (anonymous: only from the threshold on). */
export function roundMood(row: CheckinRow, roundId: string) {
  const ids = moodQuestionIds(row.id);
  if (!ids.length) return null;
  const rows = db.query(`SELECT a.value_num AS value, COUNT(*) AS count FROM response_answers a JOIN responses r ON r.id = a.response_id
    WHERE r.host_kind = 'checkin' AND r.host_id = ? AND r.subject_id = ? AND r.status = 'submitted' AND a.question_id IN (SELECT value FROM json_each(?)) AND a.value_num IS NOT NULL
    GROUP BY a.value_num ORDER BY a.value_num`).all(row.id, roundId, JSON.stringify(ids)) as Array<{ value: number; count: number }>;
  const count = rows.reduce((sum, entry) => sum + entry.count, 0);
  if (row.anonymous && count < 3) return { average: null, count, distribution: [] };
  return { average: count ? rows.reduce((sum, entry) => sum + entry.value * entry.count, 0) / count : null, count, distribution: rows };
}

/** Question ids with a role in any published version of the standup's questions. */
export function roleQuestionIds(checkinId: string, role: string): string[] {
  const ids = new Set<string>();
  for (const entry of db.query("SELECT set_json FROM question_sets WHERE host_kind = 'checkin' AND host_id = ? AND status = 'published'").all(checkinId) as Array<{ set_json: string }>) {
    for (const question of (JSON.parse(entry.set_json) as QuestionSet).questions) if (question.role === role) ids.add(question.id);
  }
  return [...ids];
}
export const moodQuestionIds = (checkinId: string) => roleQuestionIds(checkinId, "mood");

export function closeRound(row: CheckinRow, round: RoundRow, nowMs: number, actorId: string | null) {
  if (round.status === "closed") return false;
  const timestamp = iso(nowMs);
  db.query("UPDATE checkin_rounds SET status = 'closed', closed_at = ?, closes_at = CASE WHEN closes_at > ? THEN ? ELSE closes_at END WHERE id = ?").run(timestamp, timestamp, timestamp, round.id);
  refreshRoundCounts(round.id);
  const line = roundSummaryLine(row, round.id);
  db.query("UPDATE checkin_rounds SET summary_md = ? WHERE id = ?").run(line, round.id);
  const recipients = summaryRecipients(row);
  if (recipients.length) {
    const options = summaryOptions(row);
    notify({
      userIds: recipients, module: "checkins", topic: "checkins.summary", title: `${row.name} · ${dateLabel(round.round_date)}`, body: line,
      href: `${checkinHref(row)}/${round.round_date}`, item: { kind: "checkin_round", id: round.id }, dedupeKey: `checkin-summary:${row.id}`, nowMs, includeActor: true,
      ...(options.email ? { email: { template: "checkins.summary", payload: { roundId: round.id }, coalesceKey: `checkin-summary:${round.id}` } } : {})
    });
  }
  // C23 (D1044): the round goes to the standup's note after this transaction.
  if (summaryOptions(row).noteId) queueRoundNote(row.id, round.id);
  recordItemActivity({ itemKind: "checkin", itemId: row.id, actorId, via: actorId ? undefined : "system", kind: "round_closed", payload: { item: { id: round.id, label: round.round_date, kind: "checkin_round" } }, at: timestamp });
  audit(actorId, null, "checkins.round_close", { checkinId: row.id, roundId: round.id });
  return true;
}

/**
 * The `checkins.drive` handler (and tests' clock): opens every round whose date has come in some
 * participant's zone, notifies people whose open time has come, reminds those near their deadline,
 * closes rounds past their close, then re-arms the schedule. Idempotent at any `nowMs`.
 */
export function driveCheckin(checkinId: string, nowMs: number) {
  const row = checkinRow(checkinId);
  if (!row || row.deleted_at !== null) {
    if (row) cancelSchedules({ kind: "checkin", id: row.id }, DRIVE_PURPOSE);
    return { opened: 0, closed: 0 };
  }
  let opened = 0;
  let closed = 0;
  if (row.status === "active") {
    const rule = ruleOf(row);
    const lookback = row.deadline_minutes * MINUTE + 2 * DAY;
    const createdMs = Date.parse(row.created_at);
    for (const tz of zonesOf(row)) {
      for (const fire of nextFires(rule, tz, Math.max(nowMs - lookback, createdMs - 1), 8).filter((at) => at <= nowMs)) {
        const date = utcToZoned(fire, tz).slice(0, 10);
        if (db.query("SELECT 1 FROM checkin_rounds WHERE checkin_id = ? AND round_date = ?").get(row.id, date)) continue;
        if (createRound(row, date, nowMs, false)) opened += 1;
      }
    }
  }
  notifyOpened(row, nowMs);
  remindDue(row, nowMs);
  for (const round of db.query("SELECT * FROM checkin_rounds WHERE checkin_id = ? AND status = 'open' AND closes_at <= ?").all(row.id, iso(nowMs)) as RoundRow[]) {
    if (closeRound(row, round, nowMs, null)) closed += 1;
  }
  rearm(checkinRow(row.id)!, nowMs);
  return { opened, closed };
}

export const WATCHDOG_PURPOSE = "checkins.watchdog";
const WATCHDOG_MINUTES = 15;
let watchdogEnsured = false;

/**
 * The module's safety net (D1160): the drive schedule is a `{ once }` rule re-armed by its own
 * handler, so a handler that throws (its transaction, re-arm included, rolls back) or a crash after
 * the dispatcher recorded the fire row (that occurrence never runs again, T504) would leave it with
 * no next fire, and the standup would stop. One recurring schedule for the whole module (created on
 * first use, like goals.sweep) drives every standup that has something to come but no armed drive.
 */
export function ensureWatchdog() {
  if (watchdogEnsured) return;
  if (!db.query("SELECT 1 FROM schedules WHERE owner_kind = 'checkins_module' AND owner_id = 'watchdog' AND purpose = ?").get(WATCHDOG_PURPOSE)) {
    upsertSchedule({ kind: "checkins_module", id: "watchdog" }, WATCHDOG_PURPOSE, { everyMinutes: WATCHDOG_MINUTES });
  }
  watchdogEnsured = true;
}
export const resetWatchdogForTests = () => { watchdogEnsured = false; };

/** Standups that should have an armed drive schedule and do not. */
export function strandedCheckins(): string[] {
  return (db.query(`SELECT c.id FROM checkins c WHERE c.deleted_at IS NULL
      AND ((c.status = 'active' AND EXISTS (SELECT 1 FROM checkin_participants p JOIN users u ON u.id = p.user_id AND u.disabled_at IS NULL WHERE p.checkin_id = c.id))
        OR EXISTS (SELECT 1 FROM checkin_rounds r WHERE r.checkin_id = c.id AND r.status = 'open'))
      AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.owner_kind = 'checkin' AND s.owner_id = c.id AND s.purpose = ? AND s.enabled = 1 AND s.next_fire_at IS NOT NULL)
    ORDER BY c.id LIMIT 500`).all(DRIVE_PURPOSE) as Array<{ id: string }>).map((row) => row.id);
}

/** The watchdog handler: drives (and so re-arms) each stranded standup in its own transaction; one that fails never stops the rest. */
export function driveStranded(nowMs = Date.now()) {
  let driven = 0;
  let failed = 0;
  for (const id of strandedCheckins()) {
    try {
      db.transaction(() => driveCheckin(id, nowMs))();
      driven += 1;
    } catch (error) {
      failed += 1;
      clog.error(`Standup drive failed: checkin=${id}`, error);
    }
  }
  return { driven, failed };
}

/** "Start a round now" (D940): today's date in the standup's zone, open for everyone at once. */
export function startRoundNow(row: CheckinRow, actorId: string, nowMs = Date.now()) {
  const date = utcToZoned(nowMs, row.tz).slice(0, 10);
  const existing = db.query("SELECT * FROM checkin_rounds WHERE checkin_id = ? AND round_date = ?").get(row.id, date) as RoundRow | null;
  if (existing) throw new CheckinError(409, "ROUND_EXISTS", existing.status === "open" ? "Today's round is already open" : "Today's round has already run", { roundId: existing.id, date });
  const round = createRound(row, date, nowMs, true);
  if (!round) throw new CheckinError(400, "NO_PARTICIPANTS", "Add participants first");
  audit(actorId, null, "checkins.round_start", { checkinId: row.id, roundId: round.id });
  notifyOpened(row, nowMs);
  rearm(row, nowMs);
  return round;
}

/** A manual nudge of everyone still pending (at most once an hour per person). */
export function nudgeRound(row: CheckinRow, round: RoundRow, actorId: string, nowMs = Date.now()) {
  if (round.status !== "open") throw new CheckinError(409, "ROUND_CLOSED", "This round is closed");
  const pending = db.query("SELECT user_id FROM checkin_round_participants WHERE round_id = ? AND status = 'pending' AND opens_at <= ? AND (nudged_at IS NULL OR nudged_at < ?)")
    .all(round.id, iso(nowMs), iso(nowMs - 3_600_000)) as Array<{ user_id: string }>;
  const ids = pending.map((entry) => entry.user_id).filter((id) => id !== actorId);
  if (ids.length) {
    const actor = (db.query("SELECT display_name FROM users WHERE id = ?").get(actorId) as { display_name: string } | null)?.display_name ?? "Someone";
    notify({ userIds: ids, module: "checkins", topic: "checkins.nudge", title: `${actor} is waiting on your ${row.name}`, href: answerHref(row, round), item: { kind: "checkin_round", id: round.id }, actor: actorId, dedupeKey: `checkin-round:${round.id}`, nowMs });
    db.query("UPDATE checkin_round_participants SET nudged_at = ? WHERE round_id = ? AND user_id IN (SELECT value FROM json_each(?))").run(iso(nowMs), round.id, JSON.stringify(ids));
  }
  audit(actorId, null, "checkins.nudge", { checkinId: row.id, roundId: round.id, count: ids.length });
  return { nudged: ids.length };
}

// ---------------------------------------------------------------- answers

export type AnswerInput = { answers: Record<string, unknown>; expectedRevision?: number; nowMs?: number;
  /** New values for the person's key results beside a `goal_update` question (§C5, D1043). */
  goalUpdates?: readonly StandupGoalUpdate[] };

/** The round a person may answer, with their row; NOT_FOUND for a round they cannot read, 403 when they do not take part. */
export function answerableRound(roundId: string, userId: string, nowMs: number) {
  const round = roundRow(roundId);
  const row = round ? checkinRow(round.checkin_id) : null;
  if (!round || !row || checkinLevel(row, userId) === "none") throw notFound("Round");
  const participant = db.query("SELECT * FROM checkin_round_participants WHERE round_id = ? AND user_id = ?").get(round.id, userId) as RoundParticipantRow | null;
  if (!participant) throw new CheckinError(403, "NOT_PARTICIPANT", "You're not taking part in this round");
  if (round.status === "closed" && nowMs > Date.parse(round.closes_at) + ANSWER_GRACE_MS) throw new CheckinError(409, "ROUND_CLOSED", "This round closed more than a day ago");
  return { round, row, participant };
}

const anonymousHash = (roundId: string, userId: string) => keyedHash("checkin-respondent", `${roundId}:${userId}`);

/** The person's current response in a round (anonymous ones found by their keyed hash), or null. */
export function currentResponseId(row: CheckinRow, roundId: string, userId: string): string | null {
  if (row.anonymous) {
    return (db.query("SELECT id FROM responses WHERE host_kind = 'checkin' AND host_id = ? AND subject_id = ? AND dedupe_hash = ?").get(row.id, roundId, anonymousHash(roundId, userId)) as { id: string } | null)?.id ?? null;
  }
  return (db.query("SELECT response_id FROM checkin_round_participants WHERE round_id = ? AND user_id = ?").get(roundId, userId) as { response_id: string | null } | null)?.response_id ?? null;
}

/**
 * Submits or edits the person's answer to a round (D933): late after their deadline, accepted and
 * editable until a day after the round closes. Named answers are indexed for search, their refs
 * become `mentions` links, and blockers flag cards (D935). Anonymous answers keep no link to the
 * person (D934): only the participation row knows they answered.
 */
export function answerRound(userId: string, roundId: string, input: AnswerInput): { response: ResponseSummary; status: ParticipationState; edited: boolean; blockers: number } {
  const nowMs = input.nowMs ?? Date.now();
  return db.transaction(() => {
    const { round, row, participant } = answerableRound(roundId, userId, nowMs);
    if (row.anonymous && input.goalUpdates?.length) throw new CheckinError(400, "ANONYMOUS", "Anonymous standups can't check in on goals");
    const host = { kind: "checkin" as const, id: row.id };
    const existing = currentResponseId(row, round.id, userId);
    let response: ResponseSummary;
    try {
      response = existing
        ? updateResponse({ responseId: existing, answers: input.answers, audience: "member", expectedRevision: input.expectedRevision, nowMs })
        : submitResponse({ host, subject: { kind: "checkin_round", id: round.id }, respondent: row.anonymous ? { kind: "anonymous", dedupeHash: anonymousHash(round.id, userId) } : { kind: "user", userId }, answers: input.answers, audience: "member", nowMs });
    } catch (error) {
      if (error instanceof QuestionError) throw new CheckinError(error.status, error.code, error.message, error.details);
      throw error;
    }
    const late = nowMs > Date.parse(participant.deadline_at);
    const answeredBefore = participant.status === "answered" || participant.status === "late";
    const status: ParticipationState = answeredBefore ? participant.status : late ? "late" : "answered";
    db.query("UPDATE checkin_round_participants SET status = ?, answered_at = COALESCE(answered_at, ?), response_id = ? WHERE round_id = ? AND user_id = ?")
      .run(status, iso(nowMs), row.anonymous ? null : response.id, round.id, userId);
    refreshRoundCounts(round.id);
    let blockers = 0;
    if (!row.anonymous) {
      const set = setVersion(host, response.setVersion)!;
      const text = answerText(set, response.answers);
      // The answer's text before this edit (the search row holds it), so only new @mentions notify.
      const before = (db.query("SELECT body FROM checkins_fts WHERE response_id = ?").get(response.id) as { body: string } | null)?.body ?? null;
      db.query("DELETE FROM checkins_fts WHERE response_id = ?").run(response.id);
      if (text.trim()) db.query("INSERT INTO checkins_fts (response_id, body) VALUES (?, ?)").run(response.id, text.slice(0, 50_000));
      syncMentions({ kind: "checkin_round", id: response.id }, text, userId);
      // @mentions (docs/plan/MENTIONS.md, phase B): readers of the round hear about it. Anonymous answers never notify (the title names the author).
      notifyMentions({ kind: "checkin_round", itemId: round.id, authorId: userId, text, before, where: "in a standup answer" });
      blockers = syncBlockers(row, round, response, set, userId, nowMs);
      runGoalUpdaters({ userId, checkinId: row.id, checkinName: row.name, roundId: round.id, responseId: response.id, set, answers: response.answers, goalUpdates: input.goalUpdates ?? [] });
      recordItemActivity({ itemKind: "checkin_round", itemId: round.id, container: { kind: "checkin", id: row.id }, actorId: userId, kind: existing ? "answer_edited" : "answered", payload: { item: { id: response.id, label: "Answer" } } });
    }
    audit(userId, null, "checkins.answer", { checkinId: row.id, roundId: round.id, edited: Boolean(existing), ...(row.anonymous ? {} : { responseId: response.id }) });
    return { response, status, edited: Boolean(existing), blockers };
  })();
}

/** Skips a round (D932): pending → skipped. An answered round is not skipped. */
export function skipRound(userId: string, roundId: string, nowMs = Date.now()) {
  return db.transaction(() => {
    const { round, row, participant } = answerableRound(roundId, userId, nowMs);
    if (participant.status === "answered" || participant.status === "late") throw new CheckinError(409, "ALREADY_ANSWERED", "You already answered this round");
    db.query("UPDATE checkin_round_participants SET status = 'skipped' WHERE round_id = ? AND user_id = ?").run(round.id, userId);
    refreshRoundCounts(round.id);
    audit(userId, null, "checkins.skip", { checkinId: row.id, roundId: round.id });
    return { status: "skipped" as const };
  })();
}

// ---------------------------------------------------------------- blockers (D935, T554)

/** Cards an answer names in its blockers questions (text refs and card answers) that the author can read. */
export function blockerCards(set: QuestionSet, answers: ResponseSummary["answers"], userId: string): string[] {
  const cards = new Set<string>();
  for (const question of set.questions) {
    if (question.role !== "blockers") continue;
    const value = answers[question.id];
    const tokens = typeof value === "string" ? value.match(ANSWER_REF_PATTERN) ?? [] : Array.isArray(value) ? value.map(String) : [];
    for (const token of tokens.slice(0, 50)) {
      const resolved = /^[0-9a-f-]{36}$/i.test(token) ? (readableCard(token.toLowerCase(), userId) ? { ref: { kind: "card", id: token.toLowerCase() } } : null) : resolveRef(token, { userId });
      if (resolved && resolved.ref.kind === "card") cards.add(resolved.ref.id);
    }
  }
  return [...cards].slice(0, 20);
}

/** Sets the card's Blocked flag as `userId` with card history; false when it was set already. */
export function flagCardBlocked(cardId: string, userId: string, standup: { id: string; name: string }, timestamp = now()) {
  const found = readableCard(cardId, userId);
  if (!found) return false;
  const flags = flagsForCard(cardId);
  if (flags.includes("blocked")) return false;
  replaceCardFlags(cardId, [...flags, "blocked"], timestamp);
  db.query("UPDATE cards SET revision = revision + 1, updated_at = ? WHERE id = ?").run(timestamp, cardId);
  db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(timestamp, found.board.id);
  recordCardActivity({ cardId, boardId: found.board.id, actorId: userId, kind: "blocked_by_checkin", payload: { item: { id: standup.id, label: standup.name } }, at: timestamp });
  audit(userId, null, "checkins.blocker_flagged", { checkinId: standup.id, cardId });
  return true;
}

/** Whether the person may change the card (edit on its board and a writing role): only then is its flag set (T554). */
export const canFlagCard = (cardId: string, userId: string) => {
  const found = readableCard(cardId, userId);
  return found !== null && LEVEL_RANK[boardLevel(found.board, userId)] >= LEVEL_RANK.edit && canWriteContent(userId);
};

function syncBlockers(row: CheckinRow, round: RoundRow, response: ResponseSummary, set: QuestionSet, userId: string, nowMs: number) {
  const wanted = new Set(blockerCards(set, response.answers, userId));
  const existing = db.query("SELECT card_id FROM checkin_blockers WHERE response_id = ?").all(response.id) as Array<{ card_id: string }>;
  for (const entry of existing) {
    if (wanted.delete(entry.card_id)) continue;
    db.query("DELETE FROM checkin_blockers WHERE response_id = ? AND card_id = ?").run(response.id, entry.card_id);
    db.query("DELETE FROM work_links WHERE a_kind = 'checkin_round' AND a_id = ? AND b_kind = 'card' AND b_id = ? AND relation = 'blocks'").run(response.id, entry.card_id);
  }
  const timestamp = iso(nowMs);
  for (const cardId of wanted) {
    let flagged = false;
    if (canFlagCard(cardId, userId)) flagged = flagCardBlocked(cardId, userId, { id: row.id, name: row.name }, timestamp);
    db.query("INSERT OR IGNORE INTO checkin_blockers (round_id, response_id, user_id, card_id, flagged, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(round.id, response.id, userId, cardId, flagged ? 1 : 0, timestamp);
    db.query("INSERT OR IGNORE INTO work_links (id, a_kind, a_id, b_kind, b_id, relation, created_by, created_via, created_at) VALUES (?, 'checkin_round', ?, 'card', ?, 'blocks', ?, 'system', ?)")
      .run(Bun.randomUUIDv7(), response.id, cardId, userId, timestamp);
    // The card's assignees hear about it (they can read the card; the standup's name is not shown, T505).
    const found = readableCard(cardId, userId)!;
    const assignees = (db.query("SELECT user_id FROM card_assignees WHERE card_id = ?").all(cardId) as Array<{ user_id: string }>).map((entry) => entry.user_id).filter((id) => id !== userId && readableCard(cardId, id));
    if (assignees.length) {
      const key = (db.query("SELECT b.code, k.number FROM cards k JOIN boards b ON b.id = k.board_id WHERE k.id = ?").get(cardId) as { code: string | null; number: number | null } | null);
      const label = key?.code && key.number ? `${key.code}-${key.number}` : "A card";
      notify({ userIds: assignees, module: "checkins", topic: "checkins.blocked", title: `${label} was named as a blocker in a standup`, href: cardPath(found.board.id, cardId), item: { kind: "card", id: cardId } as never, actor: userId, dedupeKey: `checkin-blocked:${cardId}`, nowMs });
    }
  }
  return (db.query("SELECT COUNT(*) AS count FROM checkin_blockers WHERE response_id = ?").get(response.id) as { count: number }).count;
}

/** Clears a card's Blocked flag (the "Unblock" offer of the next round). */
export function unblockCard(userId: string, cardId: string) {
  return db.transaction(() => {
    const found = readableCard(cardId.toLowerCase(), userId);
    if (!found) throw notFound("Card");
    if (!canFlagCard(found.card.id, userId)) throw new CheckinError(403, "READ_ONLY", "You can read this card but not change it");
    const flags = flagsForCard(found.card.id);
    if (!flags.includes("blocked")) return { unblocked: false };
    const timestamp = now();
    replaceCardFlags(found.card.id, flags.filter((flag) => flag !== "blocked"), timestamp);
    db.query("UPDATE cards SET revision = revision + 1, updated_at = ? WHERE id = ?").run(timestamp, found.card.id);
    db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(timestamp, found.board.id);
    recordCardActivity({ cardId: found.card.id, boardId: found.board.id, actorId: userId, kind: "flag_cleared", payload: { item: { id: "blocked", label: "blocked" } }, at: timestamp });
    audit(userId, null, "checkins.blocker_cleared", { cardId: found.card.id });
    return { unblocked: true };
  })();
}

export const responseOf = (id: string) => getResponse(id);
export { currentSet };
