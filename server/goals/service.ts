import { audit, auditVia, db, now } from "../db";
import { notifyMentions } from "../activity/mentions";
import { purgeAfterFrom } from "../bin";
import { canWriteContent, userRole } from "../team/userRole";
import { recordItemActivity, recordItemChange } from "../activity/service";
import { cancelSchedules, upsertSchedule } from "../schedules/service";
import { notify } from "../notify";
import { WINDOW_MS } from "../mail/outbox";
import { captureUndo } from "../undo";
import { computeProgress, progressSource, ProgressError, registeredProgressSources } from "../goalsProgress";
import { createLink } from "../links/service";
import { setItemMember } from "../access/workspaceItems";
import { atLeast, goalLevel, goalRow, readableGoalIds, readableGoalSql, type GoalRow } from "./access";
import { slugSegment } from "../../shared/friendlyUrls";
import { isValidTimeZone } from "../../shared/calendarRecurrence";
import {
  checkinDue, CLOSED_STATES, elapsedFraction, GOAL_LIMITS, krProgress, suggestedHealth, weightedProgress,
  type CheckinCadence, type GoalHealth, type GoalKind, type GoalState, type KrDirection, type KrMetric, type ProgressMode
} from "../../shared/goals";
import "../../shared/goalsActivity";
import type { ItemLevel } from "../access/levels";

/**
 * Goals service (lane GOALS, docs/plan/WORKSPACE_MODULES.md §D.3, D900–D929): every write of the web,
 * MCP, REST v1, and proposals goes through these functions, each one transaction with its audit row
 * and item activity (the D742 pattern). Reads take the viewer and return only what they can open.
 */

export class GoalError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}
const notFound = (what = "Goal") => new GoalError(404, "NOT_FOUND", `${what} not found`);
const invalid = (message: string) => new GoalError(400, "INVALID", message);
const readOnly = () => new GoalError(403, "READ_ONLY", "You can read this goal but not change it");

export type KrRow = {
  id: string; goal_id: string; title: string; owner_id: string | null; metric: KrMetric; direction: KrDirection; start_value: number; target_value: number;
  current_value: number; unit: string | null; currency: string | null; weight: number; source_kind: string; source_json: string; source_error: string | null;
  auto_updated_at: string | null; progress: number; position: number; revision: number; created_at: string; updated_at: string;
};
type MilestoneRow = { id: string; kr_id: string; title: string; done_at: string | null; position: number };
type PeriodRow = { id: string; name: string; starts_on: string; ends_on: string; created_by: string | null; created_at: string; updated_at: string; archived_at: string | null };

export const goalHref = (goal: Pick<GoalRow, "title" | "short_id">) => `/goals/${slugSegment(goal.title, goal.short_id)}`;
const isClosed = (state: GoalState) => (CLOSED_STATES as readonly string[]).includes(state);
const today = (nowMs = Date.now()) => new Date(nowMs).toISOString().slice(0, 10);
const viaNow = () => { const via = auditVia(); return via === "mcp" || via === "rest" || via === "agent" || via === "proposal" ? via : "web"; };

function requireWriter(userId: string) {
  if (!canWriteContent(userId)) throw new GoalError(403, "READ_ONLY", "Your team role is read-only");
}

/** The goal and the viewer's level when it is at least `needed`; NOT_FOUND when unreadable (T90), READ_ONLY when too low. */
export function requireGoal(ref: string, userId: string, needed: ItemLevel = "view"): { goal: GoalRow; level: ItemLevel } {
  const goal = goalRow(ref);
  if (!goal || goal.deleted_at !== null) throw notFound();
  const level = goalLevel(goal.id, userId);
  if (level === "none") throw notFound();
  if (!atLeast(level, needed)) throw readOnly();
  if (needed !== "view" && needed !== "comment") requireWriter(userId);
  return { goal, level };
}

// ---------------------------------------------------------------------------------------------------
// Names (owners, teams, periods), in one query per kind.

const namesOf = (table: "users" | "user_groups" | "goal_periods", column: string, ids: Iterable<string | null>) => {
  const list = [...new Set([...ids].filter((id): id is string => !!id))];
  if (!list.length) return new Map<string, string>();
  return new Map((db.query(`SELECT id, ${column} AS name FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(list)) as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]));
};

// ---------------------------------------------------------------------------------------------------
// Summaries.

export type GoalSummary = {
  id: string; shortId: string; href: string; title: string; kind: GoalKind; state: GoalState; health: GoalHealth; suggestedHealth: GoalHealth;
  progress: number; expected: number | null; progressMode: ProgressMode; owner: { id: string; name: string }; team: { id: string; name: string } | null;
  period: { id: string; name: string; startsOn: string; endsOn: string } | null; parentId: string | null; alignedToHidden: boolean;
  startOn: string | null; dueOn: string | null; lastCheckinAt: string | null; checkinDue: boolean; cadence: CheckinCadence;
  krCount: number; childCount: number; hiddenChildCount: number; finalProgress: number | null; closedAt: string | null;
  visibility: GoalRow["visibility"]; revision: number; createdAt: string; updatedAt: string;
};

function periodsOf(ids: Iterable<string | null>) {
  const list = [...new Set([...ids].filter((id): id is string => !!id))];
  if (!list.length) return new Map<string, PeriodRow>();
  return new Map((db.query("SELECT * FROM goal_periods WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(list)) as PeriodRow[]).map((row) => [row.id, row]));
}

/** The dates a goal runs over: its own, else its period's. */
function goalDates(goal: Pick<GoalRow, "start_on" | "due_on">, period: PeriodRow | null | undefined) {
  return { start: goal.start_on ?? period?.starts_on ?? null, end: goal.due_on ?? period?.ends_on ?? null };
}

export function summarize(rows: readonly GoalRow[], viewerId: string, nowMs = Date.now()): GoalSummary[] {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const json = JSON.stringify(ids);
  const owners = namesOf("users", "display_name", rows.map((row) => row.owner_id));
  const teams = namesOf("user_groups", "name", rows.map((row) => row.group_id));
  const periods = periodsOf(rows.map((row) => row.period_id));
  const krCounts = new Map((db.query("SELECT goal_id, COUNT(*) AS count FROM key_results WHERE goal_id IN (SELECT value FROM json_each(?)) GROUP BY goal_id").all(json) as Array<{ goal_id: string; count: number }>).map((row) => [row.goal_id, row.count]));
  const children = db.query(`SELECT c.parent_id, COUNT(*) AS total, SUM(CASE WHEN ${readableGoalSql("c")} THEN 1 ELSE 0 END) AS readable
    FROM goals c WHERE c.parent_id IN (SELECT value FROM json_each($ids)) AND c.deleted_at IS NULL GROUP BY c.parent_id`).all({ ids: json, userId: viewerId }) as Array<{ parent_id: string; total: number; readable: number }>;
  const childMap = new Map(children.map((row) => [row.parent_id, row]));
  const parents = readableGoalIds(rows.map((row) => row.parent_id).filter((id): id is string => !!id), viewerId);
  const day = today(nowMs);
  return rows.map((row) => {
    const period = row.period_id ? periods.get(row.period_id) ?? null : null;
    const dates = goalDates(row, period);
    const elapsed = row.kind === "kpi" ? null : elapsedFraction(dates.start, dates.end, day);
    const counts = childMap.get(row.id);
    const closed = isClosed(row.state);
    return {
      id: row.id, shortId: row.short_id, href: goalHref(row), title: row.title, kind: row.kind, state: row.state, health: row.health,
      suggestedHealth: closed ? "none" : suggestedHealth(row.progress, elapsed), progress: closed && row.final_progress !== null ? row.final_progress : row.progress,
      expected: closed ? null : elapsed, progressMode: row.progress_mode,
      owner: { id: row.owner_id, name: owners.get(row.owner_id) ?? "Former member" },
      team: row.group_id ? { id: row.group_id, name: teams.get(row.group_id) ?? "Team" } : null,
      period: period ? { id: period.id, name: period.name, startsOn: period.starts_on, endsOn: period.ends_on } : null,
      parentId: row.parent_id && parents.has(row.parent_id) ? row.parent_id : null, alignedToHidden: !!row.parent_id && !parents.has(row.parent_id),
      startOn: row.start_on, dueOn: row.due_on, lastCheckinAt: row.last_checkin_at,
      checkinDue: !closed && row.state !== "draft" && checkinDue(row.checkin_cadence, row.last_checkin_at, row.created_at, nowMs), cadence: row.checkin_cadence,
      krCount: krCounts.get(row.id) ?? 0, childCount: counts?.readable ?? 0, hiddenChildCount: counts ? counts.total - counts.readable : 0,
      finalProgress: row.final_progress, closedAt: row.closed_at, visibility: row.visibility, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at
    };
  });
}

// ---------------------------------------------------------------------------------------------------
// Listing.

export type GoalListFilter = {
  period?: string | null; owner?: string | null; team?: string | null; parent?: string | null; state?: string | null; health?: string | null;
  mine?: boolean; q?: string | null; includeClosed?: boolean; view?: "tree" | "list";
  /** A chosen-item key's reach (SQL over `g.id`). */
  keyFilter?: { sql: string; params: Record<string, string> };
};

const LIST_MAX = 500;

function encodeCursor(row: GoalRow) { return Buffer.from(JSON.stringify([row.created_at, row.id])).toString("base64url"); }
function decodeCursor(value: string | null | undefined): [string, string] | null {
  if (!value || value.length > 200) return null;
  try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown; return Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string" ? [parsed[0], parsed[1]] : null; }
  catch { return null; }
}

/**
 * Readable goals matching the filter: `tree` returns up to 500 at once (the alignment tree of a period),
 * `list` pages by creation (`limit` ≤ 100, keyset). Filters run before LIMIT (T90).
 */
export function listGoals(userId: string, filter: GoalListFilter, page: { cursor?: string | null; limit?: number } = {}): { goals: GoalSummary[]; nextCursor: string | null } {
  const where: string[] = [readableGoalSql("g")];
  const params: Record<string, string | number> = { userId };
  if (filter.period === "none") where.push("g.period_id IS NULL");
  else if (filter.period) { where.push("g.period_id = $period"); params.period = filter.period; }
  if (filter.owner) { where.push("g.owner_id = $owner"); params.owner = filter.owner; }
  if (filter.team) { where.push("g.group_id = $team"); params.team = filter.team; }
  if (filter.parent === "root") where.push("g.parent_id IS NULL");
  else if (filter.parent) { where.push("g.parent_id = $parent"); params.parent = filter.parent; }
  if (filter.state) { where.push("g.state = $state"); params.state = filter.state; }
  else if (!filter.includeClosed) where.push("g.state IN ('draft','active')");
  if (filter.health) { where.push("g.health = $health"); params.health = filter.health; }
  if (filter.mine) where.push("(g.owner_id = $userId OR EXISTS (SELECT 1 FROM goal_contributors mc WHERE mc.goal_id = g.id AND mc.user_id = $userId) OR EXISTS (SELECT 1 FROM key_results mk WHERE mk.goal_id = g.id AND mk.owner_id = $userId))");
  if (filter.q?.trim()) { where.push("(instr(lower(g.title), lower($q)) > 0 OR EXISTS (SELECT 1 FROM key_results qk WHERE qk.goal_id = g.id AND instr(lower(qk.title), lower($q)) > 0))"); params.q = filter.q.trim().slice(0, 200); }
  if (filter.keyFilter) { where.push(filter.keyFilter.sql); Object.assign(params, filter.keyFilter.params); }
  const tree = filter.view !== "list";
  const limit = tree ? LIST_MAX : Math.min(Math.max(1, page.limit ?? 50), 100);
  const cursor = tree ? null : decodeCursor(page.cursor);
  if (cursor) { where.push("(g.created_at, g.id) > ($cAt, $cId)"); params.cAt = cursor[0]; params.cId = cursor[1]; }
  const rows = db.query(`SELECT g.* FROM goals g WHERE ${where.join(" AND ")} ORDER BY ${tree ? "g.position, g.created_at, g.id" : "g.created_at, g.id"} LIMIT ${limit + 1}`).all(params) as GoalRow[];
  const pageRows = rows.slice(0, limit);
  return { goals: summarize(pageRows, userId), nextCursor: !tree && rows.length > limit ? encodeCursor(pageRows[pageRows.length - 1]!) : null };
}

// ---------------------------------------------------------------------------------------------------
// Key results.

export type KeyResultView = {
  id: string; goalId: string; title: string; owner: { id: string; name: string } | null; metric: KrMetric; direction: KrDirection;
  startValue: number; targetValue: number; currentValue: number; unit: string | null; currency: string | null; weight: number; progress: number;
  source: { kind: string; label: string; description: string; config: unknown; error: string | null; updatedAt: string | null; available: boolean };
  milestones: Array<{ id: string; title: string; done: boolean }>; position: number; revision: number; updatedAt: string;
};

const krRows = (goalId: string) => db.query("SELECT * FROM key_results WHERE goal_id = ? ORDER BY position, created_at, id").all(goalId) as KrRow[];
const milestonesOf = (krId: string) => db.query("SELECT * FROM kr_milestones WHERE kr_id = ? ORDER BY position, id").all(krId) as MilestoneRow[];

function milestoneCounts(krId: string) {
  const row = db.query("SELECT COUNT(*) AS total, SUM(done_at IS NOT NULL) AS done FROM kr_milestones WHERE kr_id = ?").get(krId) as { total: number; done: number | null };
  return { total: row.total, done: row.done ?? 0 };
}

export function krView(kr: KrRow, viewerId: string): KeyResultView {
  const owner = kr.owner_id ? (db.query("SELECT display_name FROM users WHERE id = ?").get(kr.owner_id) as { display_name: string } | null) : null;
  const source = progressSource(kr.source_kind);
  const config = JSON.parse(kr.source_json) as unknown;
  let description = "Updated by check-ins";
  if (kr.source_kind !== "manual") {
    if (!source) description = "Its source is not available (the module that provides it is off or not installed)";
    else {
      const parsed = source.configSchema.safeParse(config);
      try { description = parsed.success ? source.describe(parsed.data, { viewerId }) : "Invalid source settings"; } catch { description = source.label; }
    }
  }
  return {
    id: kr.id, goalId: kr.goal_id, title: kr.title, owner: kr.owner_id ? { id: kr.owner_id, name: owner?.display_name ?? "Former member" } : null,
    metric: kr.metric, direction: kr.direction, startValue: kr.start_value, targetValue: kr.target_value, currentValue: kr.current_value, unit: kr.unit,
    currency: kr.currency, weight: kr.weight, progress: kr.progress,
    source: { kind: kr.source_kind, label: kr.source_kind === "manual" ? "Manual" : source?.label ?? kr.source_kind, description, config: kr.source_kind === "manual" ? {} : config, error: kr.source_error, updatedAt: kr.auto_updated_at, available: kr.source_kind === "manual" || source !== null },
    milestones: kr.metric === "milestones" ? milestonesOf(kr.id).map((row) => ({ id: row.id, title: row.title, done: row.done_at !== null })) : [],
    position: kr.position, revision: kr.revision, updatedAt: kr.updated_at
  };
}

function storeKrProgress(krId: string) {
  const kr = db.query("SELECT * FROM key_results WHERE id = ?").get(krId) as KrRow;
  const progress = krProgress({ ...kr, milestones: kr.metric === "milestones" ? milestoneCounts(kr.id) : undefined });
  if (Math.abs(progress - kr.progress) > 1e-9) db.query("UPDATE key_results SET progress = ? WHERE id = ?").run(progress, krId);
  return progress;
}

/** One point of a KR's history: auto points keep one per hour (D903), others their instant. */
function recordValue(krId: string, value: number, progress: number, source: "checkin" | "auto" | "edit", nowMs = Date.now()) {
  const at = source === "auto" ? new Date(Math.floor(nowMs / 3_600_000) * 3_600_000).toISOString() : new Date(nowMs).toISOString();
  db.query("INSERT OR REPLACE INTO kr_values (kr_id, at, value, progress, source) VALUES (?, ?, ?, ?, ?)").run(krId, at, value, progress, source);
}

// ---------------------------------------------------------------------------------------------------
// Roll-up (D901, §G.1 Q4: owner-computed, the same number for every viewer).

/** Recomputes a goal's stored progress from its KRs or children, then its ancestors'. */
export function recomputeGoal(goalId: string, seen = new Set<string>()): void {
  if (seen.has(goalId) || seen.size > 20) return;
  seen.add(goalId);
  const goal = db.query("SELECT * FROM goals WHERE id = ?").get(goalId) as GoalRow | null;
  if (!goal) return;
  if (!isClosed(goal.state) && goal.progress_mode !== "manual") {
    const krs = db.query("SELECT progress, weight FROM key_results WHERE goal_id = ?").all(goalId) as Array<{ progress: number; weight: number }>;
    let progress: number;
    if (goal.progress_mode === "key_results" && krs.length) progress = weightedProgress(krs);
    else {
      // A goal carried over counts once (TG3, D1145): its copy in the next period continues it under the
      // same parent, so the closed original drops out while that copy is live (it counts again if the
      // copy goes to the Bin or moves to another parent).
      const children = db.query(`SELECT c.state, c.progress, c.final_progress FROM goals c WHERE c.parent_id = ? AND c.deleted_at IS NULL AND c.state <> 'dropped'
        AND NOT (c.state = 'carried_over' AND EXISTS (SELECT 1 FROM work_links wl JOIN goals copy ON copy.id = wl.a_id
          WHERE wl.a_kind = 'goal' AND wl.b_kind = 'goal' AND wl.b_id = c.id AND wl.relation = 'source' AND copy.deleted_at IS NULL AND copy.parent_id = c.parent_id))`)
        .all(goalId) as Array<{ state: GoalState; progress: number; final_progress: number | null }>;
      progress = children.length ? weightedProgress(children.map((child) => ({ progress: isClosed(child.state) && child.final_progress !== null ? child.final_progress : child.progress }))) : goal.progress_mode === "children" ? 0 : weightedProgress(krs);
    }
    if (Math.abs(progress - goal.progress) > 1e-9) db.query("UPDATE goals SET progress = ?, updated_at = ? WHERE id = ?").run(progress, now(), goalId);
  }
  if (goal.parent_id) recomputeGoal(goal.parent_id, seen);
}

// ---------------------------------------------------------------------------------------------------
// Auto sources (D903, D906, T540, T543).

export const AUTO_DEBOUNCE_MS = 60_000;
export const SOURCE_BUDGET_MS = 2_000;

function sourceContext(kr: KrRow, goal: GoalRow, nowMs: number) {
  const period = goal.period_id ? db.query("SELECT * FROM goal_periods WHERE id = ?").get(goal.period_id) as PeriodRow | null : null;
  const dates = goalDates(goal, period);
  return { ownerId: kr.owner_id ?? goal.owner_id, period: dates.start && dates.end ? { start: dates.start, end: dates.end } : null, tz: "UTC", nowMs };
}

/**
 * Recomputes auto KRs (all of `krIds`, or a goal's) whose last compute is older than the debounce
 * (unless `force`). A source that is not registered (its module off), cannot compute (the owner lost
 * access), or runs over the budget keeps the last value and records `source_error`. The owner is
 * notified when a source starts failing. Returns how many values changed.
 */
export async function refreshAutoKrs(rows: readonly KrRow[], options: { force?: boolean; nowMs?: number } = {}): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  let changed = 0;
  for (const kr of rows) {
    if (kr.source_kind === "manual") continue;
    if (!options.force && kr.auto_updated_at && nowMs - Date.parse(kr.auto_updated_at) < AUTO_DEBOUNCE_MS) continue;
    const goal = db.query("SELECT * FROM goals WHERE id = ?").get(kr.goal_id) as GoalRow | null;
    if (!goal || goal.deleted_at !== null || isClosed(goal.state)) continue;
    let error: string | null = null;
    let value: { value: number; target?: number } | null = null;
    const started = performance.now();
    if (!progressSource(kr.source_kind)) error = "Its source is not available (the module that provides it is off or not installed)";
    else {
      try {
        value = await computeProgress(kr.source_kind, JSON.parse(kr.source_json), sourceContext(kr, goal, nowMs));
        if (!value) error = "The source can no longer be read by the key result's owner";
      } catch (reason) {
        error = reason instanceof ProgressError ? reason.message : "The source failed";
      }
    }
    if (!error && performance.now() - started > SOURCE_BUDGET_MS) error = "The source took too long; the value may be late";
    const timestamp = new Date(nowMs).toISOString();
    db.transaction(() => {
      const fresh = db.query("SELECT * FROM key_results WHERE id = ?").get(kr.id) as KrRow | null;
      if (!fresh || fresh.source_kind !== kr.source_kind) return;
      const wasFailing = fresh.source_error !== null;
      if (value) {
        const target = value.target !== undefined && fresh.metric !== "percent" && fresh.metric !== "boolean" && fresh.metric !== "milestones" ? value.target : fresh.target_value;
        const start = value.target !== undefined && fresh.metric !== "percent" ? 0 : fresh.start_value;
        // A percent KR fed by a count and its target stores the share (D924): compare what is stored
        // with what would be stored, never the stored % with the raw count (every refresh was a change).
        const current = fresh.metric === "percent" && value.target ? Math.round((value.value / value.target) * 10_000) / 100 : value.value;
        const differs = fresh.current_value !== current || fresh.target_value !== target || fresh.start_value !== start;
        db.query("UPDATE key_results SET current_value = ?, target_value = ?, start_value = ?, source_error = ?, auto_updated_at = ? WHERE id = ?")
          .run(current, target, start, error, timestamp, kr.id);
        const progress = storeKrProgress(kr.id);
        if (differs) {
          const stored = db.query("SELECT current_value FROM key_results WHERE id = ?").get(kr.id) as { current_value: number };
          recordValue(kr.id, stored.current_value, progress, "auto", nowMs);
          recomputeGoal(kr.goal_id);
          changed += 1;
        }
      } else {
        db.query("UPDATE key_results SET source_error = ?, auto_updated_at = ? WHERE id = ?").run(error, timestamp, kr.id);
      }
      if (error && !wasFailing) {
        const owner = fresh.owner_id ?? goal.owner_id;
        notify({ userIds: [owner], module: "goals", topic: "goals.source_failing", title: `A key result on ${goal.title} stopped updating`, body: error, href: goalHref(goal), item: { kind: "goal", id: goal.id }, dedupeKey: `goal-source:${kr.id}` });
      }
    })();
  }
  return changed;
}

/** The goal's auto KRs, refreshed when stale (the goal page and get_goal read fresh numbers, D908). */
export async function refreshGoalSources(goalId: string, options: { force?: boolean; nowMs?: number } = {}) {
  const rows = (db.query("SELECT * FROM key_results WHERE goal_id = ? AND source_kind <> 'manual'").all(goalId) as KrRow[]);
  return rows.length ? refreshAutoKrs(rows, options) : 0;
}

/** The sweep (D908): stale auto KRs of live goals, oldest first, at most 200 per run. */
export async function sweepAutoKrs(nowMs = Date.now(), staleMs = 15 * 60_000) {
  const cutoff = new Date(nowMs - staleMs).toISOString();
  const rows = db.query(`SELECT k.* FROM key_results k JOIN goals g ON g.id = k.goal_id WHERE k.source_kind <> 'manual' AND g.deleted_at IS NULL AND g.state IN ('draft','active')
    AND (k.auto_updated_at IS NULL OR k.auto_updated_at < ?) ORDER BY k.auto_updated_at IS NOT NULL, k.auto_updated_at LIMIT 200`).all(cutoff) as KrRow[];
  return refreshAutoKrs(rows, { force: true, nowMs });
}

/** Validates a KR source config for its owner and the editor (T540): both must be able to read what it names. */
async function checkSource(kind: string, config: unknown, ownerId: string, editorId: string, goal: GoalRow): Promise<string> {
  if (kind === "manual") return "{}";
  const source = progressSource(kind);
  if (!source) throw invalid("That progress source is not available");
  const parsed = source.configSchema.safeParse(config ?? {});
  if (!parsed.success) throw invalid(`Invalid ${source.label} source settings`);
  const json = JSON.stringify(parsed.data);
  if (json.length > 8192) throw invalid("The source settings are too large");
  for (const userId of new Set([ownerId, editorId])) {
    const context = { ownerId: userId, period: null, tz: "UTC", nowMs: Date.now() };
    const result = await computeProgress(kind, parsed.data, context).catch(() => null);
    if (!result) throw invalid(userId === editorId ? "You can't open what that source counts" : "The key result's owner can't open what that source counts");
  }
  void goal;
  return json;
}

/** Computes a source without saving (the editor's preview): value, target, and its description. */
export async function previewSource(userId: string, goalRef: string, kind: string, config: unknown) {
  const { goal } = requireGoal(goalRef, userId, "edit");
  const source = progressSource(kind);
  if (!source) throw invalid("That progress source is not available");
  const parsed = source.configSchema.safeParse(config ?? {});
  if (!parsed.success) throw invalid(`Invalid ${source.label} source settings`);
  const result = await computeProgress(kind, parsed.data, { ownerId: userId, period: null, tz: "UTC", nowMs: Date.now() });
  void goal;
  if (!result) throw invalid("You can't open what that source counts");
  return { value: result.value, target: result.target ?? null, detail: result.detail ?? null, description: source.describe(parsed.data, { viewerId: userId }) };
}

export const progressSources = () => [{ kind: "manual", label: "Manual", module: "goals" }, ...registeredProgressSources()];

// ---------------------------------------------------------------------------------------------------
// Detail.

export type GoalDetail = GoalSummary & {
  description: string; level: ItemLevel; canEdit: boolean; canComment: boolean; canManage: boolean;
  keyResults: KeyResultView[]; children: GoalSummary[]; parent: GoalSummary | null;
  contributors: Array<{ id: string; name: string }>; lastCheckin: CheckinView | null; includesHidden: boolean; shareRole: string;
};

export async function getGoal(ref: string, userId: string, options: { refresh?: boolean } = {}): Promise<GoalDetail> {
  let { goal, level } = requireGoal(ref, userId, "view");
  if (options.refresh !== false && await refreshGoalSources(goal.id)) goal = goalRow(goal.id)!;
  return goalDetail(goal, level, userId);
}

export function goalDetail(goal: GoalRow, level: ItemLevel, userId: string): GoalDetail {
  const [summary] = summarize([goal], userId);
  const children = db.query(`SELECT g.* FROM goals g WHERE g.parent_id = $parent AND ${readableGoalSql("g")} ORDER BY g.position, g.created_at LIMIT 200`).all({ parent: goal.id, userId }) as GoalRow[];
  const parent = goal.parent_id && summary!.parentId ? goalRow(goal.parent_id) : null;
  const contributors = db.query("SELECT u.id, u.display_name AS name FROM goal_contributors c JOIN users u ON u.id = c.user_id WHERE c.goal_id = ? ORDER BY u.display_name COLLATE NOCASE").all(goal.id) as Array<{ id: string; name: string }>;
  const last = db.query("SELECT * FROM goal_checkins WHERE goal_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(goal.id) as CheckinRow | null;
  const writer = canWriteContent(userId);
  return {
    ...summary!, description: goal.description_md, level, canEdit: atLeast(level, "edit") && writer, canComment: atLeast(level, "comment") && writer,
    canManage: atLeast(level, "manage") && writer, keyResults: krRows(goal.id).map((kr) => krView(kr, userId)), children: summarize(children, userId),
    parent: parent && parent.deleted_at === null ? summarize([parent], userId)[0]! : null, contributors, lastCheckin: last ? checkinViews([last])[0]! : null,
    includesHidden: summary!.hiddenChildCount > 0 && (goal.progress_mode === "children" || krRows(goal.id).length === 0), shareRole: goal.share_role
  };
}

// ---------------------------------------------------------------------------------------------------
// Create, update, delete.

export type KrInput = {
  title: string; ownerId?: string | null; metric?: KrMetric; direction?: KrDirection; startValue?: number; targetValue?: number; currentValue?: number;
  unit?: string | null; currency?: string | null; weight?: number; source?: { kind: string; config?: unknown } | null;
  milestones?: Array<{ id?: string; title: string; done?: boolean }>; position?: number;
};

export type GoalInput = {
  title: string; description?: string; kind?: GoalKind; parentId?: string | null; periodId?: string | null; teamId?: string | null; ownerId?: string;
  startOn?: string | null; dueOn?: string | null; state?: "draft" | "active"; progressMode?: ProgressMode; cadence?: CheckinCadence;
  visibility?: "private" | "all_users"; shareRole?: "view" | "comment" | "edit"; contributorIds?: string[]; keyResults?: KrInput[]; color?: string | null;
};

const activePerson = (userId: string) => db.query("SELECT 1 FROM users WHERE id = ? AND kind = 'person' AND disabled_at IS NULL AND role <> 'guest'").get(userId) !== null;

function checkPeriod(periodId: string | null | undefined) {
  if (!periodId) return null;
  const period = db.query("SELECT * FROM goal_periods WHERE id = ?").get(periodId) as PeriodRow | null;
  if (!period) throw invalid("That period does not exist");
  return period;
}

function checkTeam(teamId: string | null | undefined) {
  if (!teamId) return null;
  if (!db.query("SELECT 1 FROM user_groups WHERE id = ?").get(teamId)) throw invalid("That team does not exist");
  return teamId;
}

/** The parent must be a goal the actor can read, and never the goal itself or one of its descendants. */
function checkParent(parentId: string | null | undefined, userId: string, selfId?: string) {
  if (!parentId) return null;
  const parent = goalRow(parentId);
  if (!parent || parent.deleted_at !== null || goalLevel(parent.id, userId) === "none") throw invalid("Choose a goal you can open to align to");
  if (selfId) {
    let cursor: string | null = parent.id;
    for (let depth = 0; cursor && depth < 50; depth += 1) {
      if (cursor === selfId) throw invalid("A goal cannot align to itself or one of its sub-goals");
      cursor = (db.query("SELECT parent_id FROM goals WHERE id = ?").get(cursor) as { parent_id: string | null } | null)?.parent_id ?? null;
    }
  }
  return parent;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function checkDates(start: string | null | undefined, due: string | null | undefined) {
  for (const value of [start, due]) if (value && !DATE.test(value)) throw invalid("Dates are YYYY-MM-DD");
  if (start && due && due < start) throw invalid("The due date is before the start");
}

function syncFts(goalId: string) {
  db.query("DELETE FROM goals_fts WHERE goal_id = ?").run(goalId);
  const goal = db.query("SELECT title, description_md, deleted_at FROM goals WHERE id = ?").get(goalId) as { title: string; description_md: string; deleted_at: string | null } | null;
  if (!goal || goal.deleted_at !== null) return;
  const krs = (db.query("SELECT title FROM key_results WHERE goal_id = ?").all(goalId) as Array<{ title: string }>).map((row) => row.title).join("\n");
  db.query("INSERT INTO goals_fts (goal_id, title, body) VALUES (?, ?, ?)").run(goalId, goal.title, `${krs}\n${goal.description_md}`.slice(0, 40_000));
}

/**
 * A person's time zone for their goal reminders (D1055): the
 * first real zone among the one they chose for email (Settings → Notifications), the one their browser
 * reports to Standups (D946), and Time's reminder zone; UTC when none is set. A stored "UTC" counts as
 * unset, since every one of those columns defaults to it.
 */
export function ownerTimeZone(userId: string): string {
  const candidates: Array<string | null | undefined> = [];
  const read = (sql: string) => { try { return (db.query(sql).get(userId) as { tz: string | null } | null)?.tz; } catch { return null; } };
  candidates.push(read("SELECT tz FROM email_prefs WHERE user_id = ?"));
  candidates.push(read("SELECT tz FROM checkin_participants WHERE user_id = ? AND tz IS NOT NULL AND tz <> 'UTC' LIMIT 1"));
  candidates.push(read("SELECT tz FROM time_user_settings WHERE user_id = ?"));
  return candidates.find((tz): tz is string => typeof tz === "string" && tz !== "UTC" && isValidTimeZone(tz)) ?? "UTC";
}

/**
 * The check-in reminder schedule (D909 as changed in Wave 3): Mondays 09:00 in the owner's zone
 * (`ownerTimeZone`), every 1, 2, or 4 weeks; none when off or closed. Re-armed on every goal write and,
 * when the owner's zone has changed since, by the reminder itself (no boot hook needed).
 */
export function syncReminder(goal: Pick<GoalRow, "id" | "owner_id" | "checkin_cadence" | "state">) {
  if (goal.checkin_cadence === "none" || isClosed(goal.state) || goal.state === "draft") { cancelSchedules({ kind: "goal", id: goal.id }, "goals.checkin_reminder"); return; }
  const weeks = goal.checkin_cadence === "weekly" ? 1 : goal.checkin_cadence === "biweekly" ? 2 : 4;
  upsertSchedule({ kind: "goal", id: goal.id }, "goals.checkin_reminder", { cadence: { weekdays: [1], at: "09:00", ...(weeks > 1 ? { everyNWeeks: weeks } : {}) } }, {}, { userId: goal.owner_id, tz: ownerTimeZone(goal.owner_id) });
}

let sweepEnsured = false;
/** The module's sweep schedule (auto sources, D908): one row, created on first use. */
export function ensureSweep() {
  if (sweepEnsured) return;
  if (!db.query("SELECT 1 FROM schedules WHERE owner_kind = 'goals_module' AND owner_id = 'sweep' AND purpose = 'goals.sweep'").get()) {
    upsertSchedule({ kind: "goals_module", id: "sweep" }, "goals.sweep", { everyMinutes: 5 });
  }
  sweepEnsured = true;
}
export const resetSweepForTests = () => { sweepEnsured = false; };

async function insertKr(goal: GoalRow, input: KrInput, actorId: string, position: number): Promise<string> {
  const title = input.title?.trim();
  if (!title || title.length > GOAL_LIMITS.title) throw invalid("A key result needs a title (up to 200 characters)");
  const ownerId = input.ownerId ?? null;
  if (ownerId && !activePerson(ownerId)) throw invalid("The key result's owner must be a member of the workspace");
  const sourceKind = input.source?.kind ?? "manual";
  const sourceJson = await checkSource(sourceKind, input.source?.config, ownerId ?? goal.owner_id, actorId, goal);
  const metric = input.metric ?? (sourceKind === "manual" ? "number" : "number");
  const values = defaults(metric, input);
  if ((input.milestones?.length ?? 0) > GOAL_LIMITS.milestonesPerKr) throw invalid("A key result has at most 50 milestones");
  return db.transaction(() => {
    const id = Bun.randomUUIDv7();
    const timestamp = now();
    db.query(`INSERT INTO key_results (id, goal_id, title, owner_id, metric, direction, start_value, target_value, current_value, unit, currency, weight, source_kind, source_json, progress, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
      .run(id, goal.id, title, ownerId, metric, input.direction ?? "increase", values.start, values.target, values.current, input.unit?.trim().slice(0, 16) || null,
        metric === "currency" ? (input.currency ?? "USD").toUpperCase().slice(0, 3) : null, input.weight ?? 1, sourceKind, sourceJson, position, timestamp, timestamp);
    (input.milestones ?? []).forEach((milestone, index) => {
      db.query("INSERT INTO kr_milestones (id, kr_id, title, done_at, position) VALUES (?, ?, ?, ?, ?)").run(Bun.randomUUIDv7(), id, milestone.title.trim().slice(0, 200) || "Milestone", milestone.done ? timestamp : null, index);
    });
    const progress = storeKrProgress(id);
    // An automatic KR's first point is its first computed value (refreshAutoKrs), never the placeholder 0.
    if (sourceKind === "manual") recordValue(id, values.current, progress, "edit");
    return id;
  })();
}

function defaults(metric: KrMetric, input: Pick<KrInput, "startValue" | "targetValue" | "currentValue">) {
  if (metric === "boolean") return { start: 0, target: 1, current: input.currentValue ? 1 : 0 };
  if (metric === "milestones") return { start: 0, target: 0, current: 0 };
  const start = input.startValue ?? 0;
  const target = input.targetValue ?? (metric === "percent" ? 100 : 100);
  for (const value of [start, target, input.currentValue ?? start]) if (!Number.isFinite(value) || Math.abs(value) > 1e15) throw invalid("Values must be numbers");
  return { start, target, current: input.currentValue ?? start };
}

export async function createGoal(userId: string, input: GoalInput): Promise<GoalDetail> {
  requireWriter(userId);
  const title = input.title?.trim();
  if (!title || title.length > GOAL_LIMITS.title) throw invalid("A goal needs a title (up to 200 characters)");
  if ((input.description ?? "").length > GOAL_LIMITS.description) throw invalid("The description is too long");
  const ownerId = input.ownerId ?? userId;
  if (ownerId !== userId && !activePerson(ownerId)) throw invalid("The owner must be a member of the workspace");
  checkPeriod(input.periodId);
  checkTeam(input.teamId);
  checkParent(input.parentId, userId);
  checkDates(input.startOn, input.dueOn);
  if ((input.keyResults?.length ?? 0) > GOAL_LIMITS.krsPerGoal) throw invalid("A goal has at most 25 key results");
  const contributors = [...new Set(input.contributorIds ?? [])].filter((id) => id !== ownerId);
  for (const id of contributors) if (!activePerson(id)) throw invalid("Contributors must be members of the workspace");
  const id = Bun.randomUUIDv7();
  const timestamp = now();
  db.transaction(() => {
    const position = (db.query("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM goals WHERE parent_id IS ? AND period_id IS ?").get(input.parentId ?? null, input.periodId ?? null) as { next: number }).next;
    db.query(`INSERT INTO goals (id, owner_id, parent_id, period_id, title, description_md, kind, group_id, start_on, due_on, state, progress_mode, checkin_cadence, position, color, visibility, share_role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ownerId, input.parentId ?? null, input.periodId ?? null, title, input.description ?? "", input.kind ?? "objective", input.teamId ?? null, input.startOn ?? null, input.dueOn ?? null,
        input.state ?? "active", input.progressMode ?? "key_results", input.cadence ?? "weekly", position, input.color ?? null, input.visibility ?? "all_users", input.shareRole ?? "view", timestamp, timestamp);
    const add = db.query("INSERT INTO goal_contributors (goal_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)");
    for (const contributor of contributors) add.run(id, contributor, userId, timestamp);
    // The creator keeps edit on a goal they made for someone else.
    if (ownerId !== userId && (input.visibility ?? "all_users") !== "all_users") setItemMember("goal", id, userId, "edit", userId);
    recordItemActivity({ itemKind: "goal", itemId: id, actorId: userId, kind: "created", payload: { to: { label: title } } });
    // D1371: a goal made for someone else, or with contributors, tells them (not the creator).
    const created = goalRow(id)!;
    if (ownerId !== userId) goalAssigned(created, [ownerId], "owner", userId);
    goalAssigned(created, contributors, "contributor", userId);
    audit(userId, null, "goals.create", { goalId: id, parentId: input.parentId ?? null, periodId: input.periodId ?? null });
  })();
  const goal = goalRow(id)!;
  try {
    for (const [index, kr] of (input.keyResults ?? []).entries()) await insertKr(goal, kr, userId, index);
  } catch (error) {
    // Creating with key results is all or nothing.
    db.query("DELETE FROM goals WHERE id = ?").run(id);
    throw error;
  }
  db.transaction(() => {
    recomputeGoal(id);
    syncFts(id);
    syncReminder(goalRow(id)!);
  })();
  ensureSweep();
  await refreshGoalSources(id, { force: true });
  return goalDetail(goalRow(id)!, goalLevel(id, userId), userId);
}

export type GoalPatch = Partial<Omit<GoalInput, "keyResults" | "state">> & {
  state?: "draft" | "active"; health?: GoalHealth; progress?: number; expectedRevision?: number; visibility?: "private" | "all_users";
};

export function updateGoal(userId: string, ref: string, patch: GoalPatch): GoalDetail {
  const { goal, level } = requireGoal(ref, userId, "edit");
  if (patch.expectedRevision !== undefined && patch.expectedRevision !== goal.revision) throw new GoalError(409, "CONFLICT", "Someone else changed this goal. Reload and try again.");
  if (patch.title !== undefined && (!patch.title.trim() || patch.title.trim().length > GOAL_LIMITS.title)) throw invalid("A goal needs a title (up to 200 characters)");
  if (patch.description !== undefined && patch.description.length > GOAL_LIMITS.description) throw invalid("The description is too long");
  const manager = atLeast(level, "manage");
  if ((patch.ownerId !== undefined && patch.ownerId !== goal.owner_id) || patch.visibility !== undefined || patch.shareRole !== undefined) {
    if (!manager) throw new GoalError(403, "OWNER_ONLY", "Only the owner or a manager can change the owner or who can open it");
  }
  if (patch.ownerId && !activePerson(patch.ownerId)) throw invalid("The owner must be a member of the workspace");
  const period = patch.periodId !== undefined ? checkPeriod(patch.periodId) : undefined;
  if (patch.teamId !== undefined) checkTeam(patch.teamId);
  const parent = patch.parentId !== undefined ? checkParent(patch.parentId, userId, goal.id) : undefined;
  checkDates(patch.startOn !== undefined ? patch.startOn : goal.start_on, patch.dueOn !== undefined ? patch.dueOn : goal.due_on);
  if (patch.progress !== undefined && (!Number.isFinite(patch.progress) || patch.progress < 0 || patch.progress > 1)) throw invalid("Progress is between 0 and 1");
  if (patch.contributorIds) for (const id of patch.contributorIds) if (!activePerson(id)) throw invalid("Contributors must be members of the workspace");
  const contributorsBefore = new Set<string>();
  db.transaction(() => {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null) => { sets.push(`${column} = ?`); values.push(value); };
    if (patch.title !== undefined && patch.title.trim() !== goal.title) {
      set("title", patch.title.trim());
      recordItemChange({ itemKind: "goal", itemId: goal.id, actorId: userId, kind: "goal_title", from: { label: goal.title }, to: { label: patch.title.trim() } });
    }
    if (patch.description !== undefined && patch.description !== goal.description_md) { set("description_md", patch.description); recordItemActivity({ itemKind: "goal", itemId: goal.id, actorId: userId, kind: "goal_details", payload: { extra: { field: "description" } } }); }
    if (patch.kind !== undefined) set("kind", patch.kind);
    if (patch.parentId !== undefined && patch.parentId !== goal.parent_id) {
      set("parent_id", patch.parentId);
      recordItemChange({ itemKind: "goal", itemId: goal.id, actorId: userId, kind: "goal_parent", from: goal.parent_id ? { id: goal.parent_id, label: "Goal" } : null, to: parent ? { id: parent.id, label: "Goal" } : null });
    }
    if (patch.periodId !== undefined && patch.periodId !== goal.period_id) {
      set("period_id", patch.periodId);
      const before = goal.period_id ? (db.query("SELECT name FROM goal_periods WHERE id = ?").get(goal.period_id) as { name: string } | null)?.name : null;
      recordItemChange({ itemKind: "goal", itemId: goal.id, actorId: userId, kind: "goal_period", from: before ? { id: goal.period_id!, label: before } : null, to: period ? { id: period.id, label: period.name } : null });
    }
    if (patch.teamId !== undefined) set("group_id", patch.teamId);
    if (patch.ownerId !== undefined && patch.ownerId !== goal.owner_id) {
      set("owner_id", patch.ownerId);
      const names = namesOf("users", "display_name", [goal.owner_id, patch.ownerId]);
      recordItemChange({ itemKind: "goal", itemId: goal.id, actorId: userId, kind: "goal_owner", from: { id: goal.owner_id, label: names.get(goal.owner_id) ?? "Former member" }, to: { id: patch.ownerId, label: names.get(patch.ownerId) ?? "Member" } });
      db.query("DELETE FROM goal_contributors WHERE goal_id = ? AND user_id = ?").run(goal.id, patch.ownerId);
    }
    if (patch.startOn !== undefined) set("start_on", patch.startOn);
    if (patch.dueOn !== undefined) set("due_on", patch.dueOn);
    if (patch.state !== undefined && patch.state !== goal.state) {
      if (isClosed(goal.state)) throw invalid("Reopen a closed goal first");
      set("state", patch.state);
      recordItemChange({ itemKind: "goal", itemId: goal.id, actorId: userId, kind: "goal_state", from: { label: goal.state }, to: { label: patch.state } });
    }
    if (patch.health !== undefined && patch.health !== goal.health) { set("health", patch.health); healthChanged(goal, patch.health, userId); }
    if (patch.progressMode !== undefined) set("progress_mode", patch.progressMode);
    if (patch.progress !== undefined) {
      if ((patch.progressMode ?? goal.progress_mode) !== "manual") throw invalid("Set progress by hand only on a goal whose progress is manual");
      set("progress", patch.progress);
    }
    if (patch.cadence !== undefined) set("checkin_cadence", patch.cadence);
    if (patch.color !== undefined) set("color", patch.color);
    if (patch.visibility !== undefined) {
      set("visibility", patch.visibility);
      db.query("DELETE FROM item_members WHERE item_kind = 'goal' AND item_id = ?").run(goal.id);
      db.query("DELETE FROM item_group_grants WHERE item_kind = 'goal' AND item_id = ?").run(goal.id);
    }
    if (patch.shareRole !== undefined) set("share_role", patch.shareRole);
    if (patch.contributorIds) {
      const owner = patch.ownerId ?? goal.owner_id;
      for (const row of db.query("SELECT user_id FROM goal_contributors WHERE goal_id = ?").all(goal.id) as Array<{ user_id: string }>) contributorsBefore.add(row.user_id);
      db.query("DELETE FROM goal_contributors WHERE goal_id = ?").run(goal.id);
      const add = db.query("INSERT INTO goal_contributors (goal_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)");
      for (const id of new Set(patch.contributorIds)) if (id !== owner) add.run(goal.id, id, userId, now());
    }
    // D1371: a new owner and newly added contributors hear about it (never the person who changed it).
    if (patch.ownerId !== undefined && patch.ownerId !== goal.owner_id) goalAssigned(goal, [patch.ownerId], "owner", userId);
    if (patch.contributorIds) {
      const owner = patch.ownerId ?? goal.owner_id;
      goalAssigned(goal, [...new Set(patch.contributorIds)].filter((id) => id !== owner && !contributorsBefore.has(id)), "contributor", userId);
    }
    if (sets.length || patch.contributorIds) {
      set("updated_at", now());
      db.query(`UPDATE goals SET ${sets.join(", ")}, revision = revision + 1 WHERE id = ?`).run(...values, goal.id);
    }
    recomputeGoal(goal.id);
    if (goal.parent_id && patch.parentId !== undefined && patch.parentId !== goal.parent_id) recomputeGoal(goal.parent_id);
    syncFts(goal.id);
    syncReminder(goalRow(goal.id)!);
    audit(userId, null, "goals.update", { goalId: goal.id, fields: Object.keys(patch).filter((key) => key !== "expectedRevision") });
  })();
  return goalDetail(goalRow(goal.id)!, goalLevel(goal.id, userId), userId);
}

/**
 * Made a goal's owner or a contributor (D1371): a bell row and the Goals email, to people who can read
 * the goal, never the person who did it. One unread row per person and goal.
 */
function goalAssigned(goal: GoalRow, userIds: readonly string[], role: "owner" | "contributor", actorId: string) {
  const readers = userIds.filter((id) => id !== actorId && goalLevel(goal.id, id) !== "none");
  if (!readers.length) return;
  const actor = (db.query("SELECT display_name FROM users WHERE id = ?").get(actorId) as { display_name: string } | null)?.display_name ?? "Someone";
  notify({
    userIds: readers, module: "goals", topic: "goals.assigned", actor: actorId,
    title: role === "owner" ? `${actor} made you the owner of ${goal.title}` : `${actor} added you to ${goal.title}`,
    href: goalHref(goal), item: { kind: "goal", id: goal.id }, dedupeKey: `goal-assigned:${goal.id}`,
    email: { template: "goals.update", payload: { topic: "goals.assigned", kind: "goal", id: goal.id, actorId, role }, coalesceKey: `goals.assigned:${goal.id}`, windowMs: WINDOW_MS.activity }
  });
}

/** Health went to at risk or off track: the owner, contributors, and the parent's owner hear it (§D.3). */
function healthChanged(goal: GoalRow, health: GoalHealth, actorId: string) {
  recordItemChange({ itemKind: "goal", itemId: goal.id, actorId, kind: "goal_health", from: { label: goal.health }, to: { label: health } });
  if (health !== "at_risk" && health !== "off_track") return;
  const parentOwner = goal.parent_id ? (db.query("SELECT owner_id FROM goals WHERE id = ? AND deleted_at IS NULL").get(goal.parent_id) as { owner_id: string } | null)?.owner_id : null;
  const contributors = (db.query("SELECT user_id FROM goal_contributors WHERE goal_id = ?").all(goal.id) as Array<{ user_id: string }>).map((row) => row.user_id);
  const recipients = [goal.owner_id, ...contributors, ...(parentOwner ? [parentOwner] : [])].filter((id) => goalLevel(goal.id, id) !== "none");
  notify({ userIds: recipients, module: "goals", topic: "goals.health_changed", actor: actorId, title: `${goal.title} is ${health === "at_risk" ? "at risk" : "off track"}`, href: goalHref(goal), item: { kind: "goal", id: goal.id }, dedupeKey: `goal-health:${goal.id}`,
    email: { template: "goals.update", payload: { topic: "goals.health_changed", kind: "goal", id: goal.id, actorId }, coalesceKey: `goals.health:${goal.id}`, windowMs: WINDOW_MS.activity } });
}

/** To the Bin (owner or manager). Children stay aligned until it is purged (§D.3). */
export function deleteGoal(userId: string, ref: string) {
  const { goal, level } = requireGoal(ref, userId, "edit");
  if (!atLeast(level, "manage")) throw new GoalError(403, "OWNER_ONLY", "Only the owner or a manager can delete a goal");
  return db.transaction(() => {
    const deletedAt = new Date();
    db.query("UPDATE goals SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL").run(deletedAt.toISOString(), userId, purgeAfterFrom(deletedAt), now(), goal.id);
    db.query("DELETE FROM goals_fts WHERE goal_id = ?").run(goal.id);
    cancelSchedules({ kind: "goal", id: goal.id });
    recordItemActivity({ itemKind: "goal", itemId: goal.id, actorId: userId, kind: "binned" });
    if (goal.parent_id) recomputeGoal(goal.parent_id);
    audit(userId, null, "goals.delete", { goalId: goal.id });
    return { binned: true, id: goal.id };
  })();
}

// ---------------------------------------------------------------------------------------------------
// Key result writes.

function requireKr(krId: string, userId: string, needed: ItemLevel = "view") {
  const kr = db.query("SELECT * FROM key_results WHERE id = ?").get(krId.toLowerCase()) as KrRow | null;
  if (!kr) throw notFound("Key result");
  try {
    const { goal, level } = requireGoal(kr.goal_id, userId, needed);
    return { kr, goal, level };
  } catch (error) {
    if (error instanceof GoalError && error.status === 404) throw notFound("Key result");
    throw error;
  }
}

export async function addKeyResult(userId: string, goalRef: string, input: KrInput): Promise<KeyResultView> {
  const { goal } = requireGoal(goalRef, userId, "edit");
  const count = (db.query("SELECT COUNT(*) AS count, COALESCE(MAX(position), -1) + 1 AS next FROM key_results WHERE goal_id = ?").get(goal.id) as { count: number; next: number });
  if (count.count >= GOAL_LIMITS.krsPerGoal) throw invalid("A goal has at most 25 key results");
  const id = await insertKr(goal, input, userId, input.position ?? count.next);
  db.transaction(() => {
    recordItemActivity({ itemKind: "goal", itemId: goal.id, actorId: userId, kind: "kr_added", payload: { item: { id, label: input.title.trim(), kind: "key_result" } } });
    db.query("UPDATE goals SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now(), goal.id);
    recomputeGoal(goal.id);
    syncFts(goal.id);
    audit(userId, null, "goals.kr_create", { goalId: goal.id, krId: id, source: input.source?.kind ?? "manual" });
  })();
  if (input.source && input.source.kind !== "manual") { ensureSweep(); await refreshAutoKrs([db.query("SELECT * FROM key_results WHERE id = ?").get(id) as KrRow], { force: true }); }
  return krView(db.query("SELECT * FROM key_results WHERE id = ?").get(id) as KrRow, userId);
}

export type KrPatch = Partial<KrInput> & { expectedRevision?: number };

export async function updateKeyResult(userId: string, krId: string, patch: KrPatch): Promise<KeyResultView> {
  const { kr, goal } = requireKr(krId, userId, "edit");
  if (patch.expectedRevision !== undefined && patch.expectedRevision !== kr.revision) throw new GoalError(409, "CONFLICT", "Someone else changed this key result. Reload and try again.");
  if (patch.title !== undefined && (!patch.title.trim() || patch.title.trim().length > GOAL_LIMITS.title)) throw invalid("A key result needs a title (up to 200 characters)");
  if (patch.ownerId && !activePerson(patch.ownerId)) throw invalid("The key result's owner must be a member of the workspace");
  if (patch.weight !== undefined && !(patch.weight > 0 && patch.weight <= 100)) throw invalid("Weight is more than 0 and at most 100");
  for (const value of [patch.startValue, patch.targetValue, patch.currentValue]) if (value !== undefined && (!Number.isFinite(value) || Math.abs(value) > 1e15)) throw invalid("Values must be numbers");
  let sourceJson: string | undefined;
  const sourceKind = patch.source !== undefined ? (patch.source?.kind ?? "manual") : undefined;
  if (patch.source !== undefined || (patch.ownerId !== undefined && kr.source_kind !== "manual")) {
    sourceJson = await checkSource(sourceKind ?? kr.source_kind, patch.source !== undefined ? patch.source?.config : JSON.parse(kr.source_json), (patch.ownerId !== undefined ? patch.ownerId : kr.owner_id) ?? goal.owner_id, userId, goal);
  }
  db.transaction(() => {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null) => { sets.push(`${column} = ?`); values.push(value); };
    if (patch.title !== undefined) set("title", patch.title.trim());
    if (patch.ownerId !== undefined) set("owner_id", patch.ownerId);
    if (patch.metric !== undefined) set("metric", patch.metric);
    if (patch.direction !== undefined) set("direction", patch.direction);
    if (patch.startValue !== undefined) set("start_value", patch.startValue);
    if (patch.targetValue !== undefined) set("target_value", patch.targetValue);
    const manual = (sourceKind ?? kr.source_kind) === "manual";
    if (patch.currentValue !== undefined && manual) set("current_value", patch.metric === "boolean" || kr.metric === "boolean" ? (patch.currentValue ? 1 : 0) : patch.currentValue);
    if (patch.unit !== undefined) set("unit", patch.unit?.trim().slice(0, 16) || null);
    if (patch.currency !== undefined) set("currency", patch.currency ? patch.currency.toUpperCase().slice(0, 3) : null);
    if (patch.weight !== undefined) set("weight", patch.weight);
    if (patch.position !== undefined) set("position", patch.position);
    if (sourceKind !== undefined) { set("source_kind", sourceKind); set("source_error", null); set("auto_updated_at", null); }
    if (sourceJson !== undefined) set("source_json", sourceJson);
    set("updated_at", now());
    db.query(`UPDATE key_results SET ${sets.join(", ")}, revision = revision + 1 WHERE id = ?`).run(...values, kr.id);
    if ((patch.metric ?? kr.metric) === "boolean") db.query("UPDATE key_results SET start_value = 0, target_value = 1 WHERE id = ?").run(kr.id);
    if (patch.milestones) {
      if (patch.milestones.length > GOAL_LIMITS.milestonesPerKr) throw invalid("A key result has at most 50 milestones");
      const existing = new Map(milestonesOf(kr.id).map((row) => [row.id, row]));
      db.query("DELETE FROM kr_milestones WHERE kr_id = ?").run(kr.id);
      patch.milestones.forEach((milestone, index) => {
        const before = milestone.id ? existing.get(milestone.id) : undefined;
        const doneAt = milestone.done ? before?.done_at ?? now() : null;
        db.query("INSERT INTO kr_milestones (id, kr_id, title, done_at, position) VALUES (?, ?, ?, ?, ?)").run(before?.id ?? Bun.randomUUIDv7(), kr.id, milestone.title.trim().slice(0, 200) || "Milestone", doneAt, index);
      });
    }
    const progress = storeKrProgress(kr.id);
    const fresh = db.query("SELECT current_value FROM key_results WHERE id = ?").get(kr.id) as { current_value: number };
    if (fresh.current_value !== kr.current_value || Math.abs(progress - kr.progress) > 1e-9) recordValue(kr.id, fresh.current_value, progress, "edit");
    recordItemActivity({ itemKind: "goal", itemId: goal.id, actorId: userId, kind: "kr_changed", payload: { item: { id: kr.id, label: patch.title?.trim() ?? kr.title, kind: "key_result" } } });
    db.query("UPDATE goals SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now(), goal.id);
    recomputeGoal(goal.id);
    syncFts(goal.id);
    audit(userId, null, "goals.kr_update", { goalId: goal.id, krId: kr.id, fields: Object.keys(patch).filter((key) => key !== "expectedRevision") });
  })();
  if (sourceKind && sourceKind !== "manual") { ensureSweep(); await refreshAutoKrs([db.query("SELECT * FROM key_results WHERE id = ?").get(kr.id) as KrRow], { force: true }); }
  return krView(db.query("SELECT * FROM key_results WHERE id = ?").get(kr.id) as KrRow, userId);
}

/** Deletes at once with an Undo ticket (D813): the KR, its milestones, and its history. */
export function deleteKeyResult(userId: string, krId: string): { undoTicket: string } {
  const { kr, goal } = requireKr(krId, userId, "edit");
  return db.transaction(() => {
    const undoTicket = captureUndo({ actorId: userId, kind: "key_result", label: "Key result", rows: [
      { table: "key_results", where: { id: kr.id } }, { table: "kr_milestones", where: { kr_id: kr.id } }, { table: "kr_values", where: { kr_id: kr.id } }
    ] });
    db.query("DELETE FROM key_results WHERE id = ?").run(kr.id);
    recordItemActivity({ itemKind: "goal", itemId: goal.id, actorId: userId, kind: "kr_removed", payload: { item: { id: kr.id, label: kr.title, kind: "key_result" } } });
    db.query("UPDATE goals SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now(), goal.id);
    recomputeGoal(goal.id);
    syncFts(goal.id);
    audit(userId, null, "goals.kr_delete", { goalId: goal.id, krId: kr.id });
    return { undoTicket };
  })();
}

/** After an undo puts a KR back: its goal's progress and search. */
export function keyResultRestored(rows: ReadonlyArray<{ table: string; row: Record<string, unknown> }>) {
  const goalId = rows.find((entry) => entry.table === "key_results")?.row.goal_id;
  if (typeof goalId === "string") { recomputeGoal(goalId); syncFts(goalId); }
}

export function krHistory(userId: string, krId: string, range: { from?: string | null; to?: string | null } = {}) {
  const { kr } = requireKr(krId, userId, "view");
  const rows = db.query("SELECT at, value, progress, source FROM kr_values WHERE kr_id = ? AND at >= ? AND at <= ? ORDER BY at LIMIT 2000")
    .all(kr.id, range.from ?? "0000", range.to ?? "9999") as Array<{ at: string; value: number; progress: number; source: string }>;
  return { values: rows };
}

/** The progress chart (§D.3): every KR's points and the goal's progress at each check-in, with the ideal line's ends. */
export function goalHistory(userId: string, ref: string) {
  const { goal } = requireGoal(ref, userId, "view");
  const krs = krRows(goal.id);
  const values = krs.length ? db.query("SELECT kr_id, at, value, progress, source FROM kr_values WHERE kr_id IN (SELECT value FROM json_each(?)) ORDER BY at LIMIT 5000").all(JSON.stringify(krs.map((kr) => kr.id))) as Array<{ kr_id: string; at: string; value: number; progress: number; source: string }> : [];
  const checkins = db.query("SELECT created_at AS at, progress, health FROM goal_checkins WHERE goal_id = ? ORDER BY created_at LIMIT 1000").all(goal.id) as Array<{ at: string; progress: number; health: string }>;
  const period = goal.period_id ? db.query("SELECT * FROM goal_periods WHERE id = ?").get(goal.period_id) as PeriodRow | null : null;
  const dates = goalDates(goal, period);
  return {
    keyResults: krs.map((kr) => ({ id: kr.id, title: kr.title, points: values.filter((point) => point.kr_id === kr.id).map(({ kr_id: _kr, ...point }) => point) })),
    checkins, current: goal.progress, ideal: dates.start && dates.end ? { start: dates.start, end: dates.end } : null
  };
}

// ---------------------------------------------------------------------------------------------------
// Check-ins.

type CheckinRow = { id: string; goal_id: string; author_id: string | null; health: GoalHealth; confidence: number | null; note_md: string; values_json: string; progress: number; via: string; created_at: string };
export type CheckinView = { id: string; goalId: string; author: { id: string; name: string } | null; health: GoalHealth; confidence: number | null; note: string; values: Record<string, number>; progress: number; via: string; createdAt: string };

function checkinViews(rows: readonly CheckinRow[]): CheckinView[] {
  const names = namesOf("users", "display_name", rows.map((row) => row.author_id));
  return rows.map((row) => ({
    id: row.id, goalId: row.goal_id, author: row.author_id ? { id: row.author_id, name: names.get(row.author_id) ?? "Former member" } : null, health: row.health,
    confidence: row.confidence, note: row.note_md, values: JSON.parse(row.values_json) as Record<string, number>, progress: row.progress, via: row.via, createdAt: row.created_at
  }));
}

export type CheckinInput = {
  health: GoalHealth; confidence?: number | null; note?: string | null; values?: Record<string, number | boolean>; milestonesDone?: Record<string, string[]>;
  /** What wrote it (a standup answer's response id, D1059b): a second check-in with the same ref updates the first. */
  sourceRef?: string;
};

/** A check-in (§D.3, T542: edit level, which contributors hold): new values for manual KRs, health, confidence, note. */
export function checkIn(userId: string, ref: string, input: CheckinInput, nowMs = Date.now()): { checkin: CheckinView; goal: GoalDetail } {
  const { goal } = requireGoal(ref, userId, "edit");
  if (isClosed(goal.state)) throw invalid("This goal is closed; reopen it to check in");
  if (input.confidence !== undefined && input.confidence !== null && !(Number.isInteger(input.confidence) && input.confidence >= 1 && input.confidence <= 10)) throw invalid("Confidence is 1 to 10");
  if ((input.note ?? "").length > GOAL_LIMITS.note) throw invalid("The note is too long");
  const krs = new Map(krRows(goal.id).map((kr) => [kr.id, kr]));
  const typed: Record<string, number> = {};
  for (const [krId, raw] of Object.entries(input.values ?? {})) {
    const kr = krs.get(krId.toLowerCase());
    if (!kr) throw invalid("A value names a key result of another goal");
    const value = typeof raw === "boolean" ? (raw ? 1 : 0) : raw;
    if (!Number.isFinite(value) || Math.abs(value) > 1e15) throw invalid("Values must be numbers");
    if (kr.source_kind !== "manual" || kr.metric === "milestones") continue;
    typed[kr.id] = kr.metric === "boolean" ? (value ? 1 : 0) : value;
  }
  const timestamp = new Date(nowMs).toISOString();
  return db.transaction(() => {
    for (const [krId, value] of Object.entries(typed)) {
      db.query("UPDATE key_results SET current_value = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(value, timestamp, krId);
      recordValue(krId, value, storeKrProgress(krId), "checkin", nowMs);
    }
    for (const [krId, doneIds] of Object.entries(input.milestonesDone ?? {})) {
      const kr = krs.get(krId.toLowerCase());
      if (!kr || kr.metric !== "milestones") continue;
      const done = new Set(doneIds);
      for (const milestone of milestonesOf(kr.id)) {
        const shouldBe = done.has(milestone.id);
        if (shouldBe !== (milestone.done_at !== null)) db.query("UPDATE kr_milestones SET done_at = ? WHERE id = ?").run(shouldBe ? timestamp : null, milestone.id);
      }
      const progress = storeKrProgress(kr.id);
      typed[kr.id] = milestoneCounts(kr.id).done;
      recordValue(kr.id, typed[kr.id]!, progress, "checkin", nowMs);
    }
    recomputeGoal(goal.id);
    const fresh = goalRow(goal.id)!;
    // D1059b: the same source (an edited or retried standup answer) updates its check-in in place:
    // no second row, no second activity entry or notification (a real health change still says so).
    const earlier = input.sourceRef ? db.query("SELECT id FROM goal_checkins WHERE goal_id = ? AND source_ref = ?").get(goal.id, input.sourceRef) as { id: string } | null : null;
    if (earlier) {
      // @mentions in the note (docs/plan/MENTIONS.md, phase B): only the ones this edit adds.
      const before = (db.query("SELECT note_md FROM goal_checkins WHERE id = ?").get(earlier.id) as { note_md: string } | null)?.note_md ?? null;
      notifyMentions({ kind: "goal", itemId: goal.id, authorId: userId, text: (input.note ?? "").trim(), before, where: "in a goal check-in" });
      db.query("UPDATE goal_checkins SET health = ?, confidence = ?, note_md = ?, values_json = ?, progress = ? WHERE id = ?")
        .run(input.health, input.confidence ?? null, (input.note ?? "").trim(), JSON.stringify(typed), fresh.progress, earlier.id);
      if (input.health !== goal.health) healthChanged(goal, input.health, userId);
      db.query("UPDATE goals SET health = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(input.health, timestamp, goal.id);
      audit(userId, null, "goals.checkin_update", { goalId: goal.id, checkinId: earlier.id, krs: Object.keys(typed).length });
      const row = db.query("SELECT * FROM goal_checkins WHERE id = ?").get(earlier.id) as CheckinRow;
      return { checkin: checkinViews([row])[0]!, goal: goalDetail(goalRow(goal.id)!, goalLevel(goal.id, userId), userId) };
    }
    const id = Bun.randomUUIDv7();
    db.query("INSERT INTO goal_checkins (id, goal_id, author_id, health, confidence, note_md, values_json, progress, via, created_at, source_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, goal.id, userId, input.health, input.confidence ?? null, (input.note ?? "").trim(), JSON.stringify(typed), fresh.progress, viaNow(), timestamp, input.sourceRef ?? null);
    if (input.health !== goal.health) healthChanged(goal, input.health, userId);
    db.query("UPDATE goals SET health = ?, last_checkin_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(input.health, timestamp, timestamp, goal.id);
    notifyMentions({ kind: "goal", itemId: goal.id, authorId: userId, text: (input.note ?? "").trim(), where: "in a goal check-in" });
    recordItemActivity({ itemKind: "goal", itemId: goal.id, actorId: userId, kind: "checked_in", payload: { extra: { health: input.health, confidence: input.confidence ?? null, progress: Math.round(fresh.progress * 100) } } });
    audit(userId, null, "goals.checkin", { goalId: goal.id, checkinId: id, krs: Object.keys(typed).length });
    const row = db.query("SELECT * FROM goal_checkins WHERE id = ?").get(id) as CheckinRow;
    return { checkin: checkinViews([row])[0]!, goal: goalDetail(goalRow(goal.id)!, goalLevel(goal.id, userId), userId) };
  })();
}

/**
 * Goals a person can check in on from a standup's goal update question (§C5, D1043): open goals they
 * own, contribute to, or own a key result of, and can edit, with their key results (manual ones take
 * values; automatic ones are shown for context). At most 20, by last check-in.
 */
export function checkinTargets(userId: string): Array<{ id: string; title: string; href: string; health: GoalHealth; progress: number;
  keyResults: Array<{ id: string; title: string; metric: string; currentValue: number; targetValue: number; unit: string | null; manual: boolean }> }> {
  const rows = db.query(`SELECT g.* FROM goals g WHERE g.state = 'active' AND ${readableGoalSql("g")}
    AND (g.owner_id = $userId OR EXISTS (SELECT 1 FROM goal_contributors c WHERE c.goal_id = g.id AND c.user_id = $userId) OR EXISTS (SELECT 1 FROM key_results k WHERE k.goal_id = g.id AND k.owner_id = $userId))
    ORDER BY COALESCE(g.last_checkin_at, g.created_at) LIMIT 60`).all({ userId }) as GoalRow[];
  return rows.filter((row) => atLeast(goalLevel(row.id, userId), "edit")).slice(0, 20).map((row) => ({
    id: row.id, title: row.title, href: goalHref(row), health: row.health as GoalHealth, progress: row.progress,
    keyResults: krRows(row.id).map((kr) => ({ id: kr.id, title: kr.title, metric: kr.metric, currentValue: kr.current_value, targetValue: kr.target_value, unit: kr.unit, manual: kr.source_kind === "manual" && kr.metric !== "milestones" }))
  }));
}

export function listCheckins(userId: string, ref: string, page: { cursor?: string | null; limit?: number } = {}) {
  const { goal } = requireGoal(ref, userId, "view");
  const limit = Math.min(Math.max(1, page.limit ?? 20), 100);
  const cursor = decodeCursor(page.cursor);
  const rows = db.query(`SELECT * FROM goal_checkins WHERE goal_id = $goal ${cursor ? "AND (created_at, id) < ($at, $id)" : ""} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`)
    .all({ goal: goal.id, ...(cursor ? { at: cursor[0], id: cursor[1] } : {}) }) as CheckinRow[];
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return { checkins: checkinViews(pageRows), nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString("base64url") : null };
}

// ---------------------------------------------------------------------------------------------------
// Closing (D905).

export async function closeGoal(userId: string, ref: string, input: { state: "achieved" | "missed" | "dropped" | "carried_over"; carryOver?: { periodId: string } | null }, options: { refreshed?: boolean } = {}) {
  const checked = requireGoal(ref, userId, "edit");
  if (isClosed(checked.goal.state)) throw invalid("This goal is already closed");
  // The snapshot is of fresh numbers (TG6, D1146): auto key results are recomputed first, whatever the
  // debounce, so the final progress is not the value of the last page view or sweep.
  if (!options.refreshed) await refreshGoalSources(checked.goal.id, { force: true });
  const goal = goalRow(checked.goal.id)!;
  if (isClosed(goal.state)) throw invalid("This goal is already closed");
  const carry = input.state === "carried_over" || !!input.carryOver;
  const target = carry ? checkPeriod(input.carryOver?.periodId) : null;
  if (carry && !target) throw invalid("Choose the period to carry it over to");
  const result = db.transaction(() => {
    const timestamp = now();
    const state = carry ? "carried_over" : input.state;
    db.query("UPDATE goals SET state = ?, closed_at = ?, final_progress = progress, updated_at = ?, revision = revision + 1 WHERE id = ?").run(state, timestamp, timestamp, goal.id);
    recordItemChange({ itemKind: "goal", itemId: goal.id, actorId: userId, kind: "goal_closed", from: { label: goal.state }, to: { label: state } });
    cancelSchedules({ kind: "goal", id: goal.id }, "goals.checkin_reminder");
    let copyId: string | null = null;
    if (carry && target) {
      copyId = Bun.randomUUIDv7();
      db.query(`INSERT INTO goals (id, owner_id, parent_id, period_id, title, description_md, kind, group_id, start_on, due_on, state, health, progress, progress_mode, checkin_cadence, position, color, visibility, share_role, created_at, updated_at)
        SELECT ?, owner_id, parent_id, ?, title, description_md, kind, group_id, NULL, NULL, 'active', health, progress, progress_mode, checkin_cadence, position, color, visibility, share_role, ?, ? FROM goals WHERE id = ?`)
        .run(copyId, target.id, timestamp, timestamp, goal.id);
      db.query("INSERT INTO goal_contributors (goal_id, user_id, added_by, created_at) SELECT ?, user_id, ?, ? FROM goal_contributors WHERE goal_id = ?").run(copyId, userId, timestamp, goal.id);
      db.query("INSERT INTO item_members (item_kind, item_id, user_id, level, added_by, created_at) SELECT 'goal', ?, user_id, level, ?, ? FROM item_members WHERE item_kind = 'goal' AND item_id = ?").run(copyId, userId, timestamp, goal.id);
      db.query("INSERT INTO item_group_grants (item_kind, item_id, group_id, level, granted_by, created_at) SELECT 'goal', ?, group_id, level, ?, ? FROM item_group_grants WHERE item_kind = 'goal' AND item_id = ?").run(copyId, userId, timestamp, goal.id);
      for (const kr of krRows(goal.id)) {
        const krId = Bun.randomUUIDv7();
        // The carried key result starts where the old one ended (D905).
        db.query(`INSERT INTO key_results (id, goal_id, title, owner_id, metric, direction, start_value, target_value, current_value, unit, currency, weight, source_kind, source_json, progress, position, created_at, updated_at)
          SELECT ?, ?, title, owner_id, metric, direction, start_value, target_value, current_value, unit, currency, weight, source_kind, source_json, progress, position, ?, ? FROM key_results WHERE id = ?`).run(krId, copyId, timestamp, timestamp, kr.id);
        db.query("INSERT INTO kr_milestones (id, kr_id, title, done_at, position) SELECT lower(hex(randomblob(16))), ?, title, done_at, position FROM kr_milestones WHERE kr_id = ?").run(krId, kr.id);
        recordValue(krId, kr.current_value, kr.progress, "edit");
      }
      db.query("INSERT INTO work_links (id, a_kind, a_id, b_kind, b_id, relation, created_by, created_via, created_at) VALUES (?, 'goal', ?, 'goal', ?, 'source', ?, 'system', ?)").run(Bun.randomUUIDv7(), copyId, goal.id, userId, timestamp);
      recordItemActivity({ itemKind: "goal", itemId: copyId, actorId: userId, kind: "created", payload: { to: { label: goal.title } } });
      recordItemActivity({ itemKind: "goal", itemId: goal.id, actorId: userId, kind: "goal_carried", payload: { item: { id: copyId, label: target.name, kind: "goal" } } });
      syncFts(copyId);
      syncReminder(goalRow(copyId)!);
    }
    if (goal.parent_id) recomputeGoal(goal.parent_id);
    audit(userId, null, "goals.close", { goalId: goal.id, state, carriedTo: copyId });
    return { copyId };
  })();
  return { goal: goalDetail(goalRow(goal.id)!, goalLevel(goal.id, userId), userId), carriedOver: result.copyId ? summarize([goalRow(result.copyId)!], userId)[0]! : null };
}

export function reopenGoal(userId: string, ref: string) {
  const { goal } = requireGoal(ref, userId, "edit");
  if (!isClosed(goal.state)) throw invalid("This goal is open");
  db.transaction(() => {
    db.query("UPDATE goals SET state = 'active', closed_at = NULL, final_progress = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?").run(now(), goal.id);
    recordItemActivity({ itemKind: "goal", itemId: goal.id, actorId: userId, kind: "goal_reopened" });
    recomputeGoal(goal.id);
    syncReminder(goalRow(goal.id)!);
    audit(userId, null, "goals.reopen", { goalId: goal.id });
  })();
  return goalDetail(goalRow(goal.id)!, goalLevel(goal.id, userId), userId);
}

/**
 * Closing a period (D910): every open goal in it the actor can edit is closed by its score — achieved at
 * 70% or more (the OKR convention), else carried over to `carryOverTo` when given, else missed — and the
 * period is archived. Goals the actor cannot edit stay as they are and are counted.
 */
export async function closePeriod(userId: string, periodId: string, input: { carryOverTo?: string | null } = {}) {
  requireWriter(userId);
  const period = checkPeriod(periodId)!;
  if (input.carryOverTo) { if (input.carryOverTo === periodId) throw invalid("Carry over to another period"); checkPeriod(input.carryOverTo); }
  const goals = db.query(`SELECT g.* FROM goals g WHERE g.period_id = $period AND g.state IN ('draft','active') AND ${readableGoalSql("g")} ORDER BY g.created_at LIMIT 500`).all({ period: period.id, userId }) as GoalRow[];
  const counts = { achieved: 0, missed: 0, carried_over: 0, skipped: 0 };
  for (const listed of goals) {
    if (!atLeast(goalLevel(listed.id, userId), "edit")) { counts.skipped += 1; continue; }
    // Scored on fresh numbers (TG6, D1146): refresh the auto key results, then read the progress.
    await refreshGoalSources(listed.id, { force: true });
    const goal = goalRow(listed.id);
    if (!goal || isClosed(goal.state)) { counts.skipped += 1; continue; }
    const state = goal.progress >= 0.7 ? "achieved" : input.carryOverTo ? "carried_over" : "missed";
    await closeGoal(userId, goal.id, { state, carryOver: state === "carried_over" ? { periodId: input.carryOverTo! } : null }, { refreshed: true });
    counts[state] += 1;
  }
  db.transaction(() => {
    db.query("UPDATE goal_periods SET archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?").run(now(), now(), period.id);
    cancelSchedules({ kind: "goal_period", id: period.id });
    audit(userId, null, "goals.period_close", { periodId: period.id, ...counts });
  })();
  return counts;
}

// ---------------------------------------------------------------------------------------------------
// Periods (D904: workspace-wide; members and admins create; the creator or an admin changes them).

export type PeriodView = { id: string; name: string; startsOn: string; endsOn: string; archived: boolean; current: boolean; goalCount: number; canEdit: boolean };

export function listPeriods(userId: string, options: { includeArchived?: boolean; nowMs?: number } = {}): PeriodView[] {
  const day = today(options.nowMs);
  const rows = db.query(`SELECT p.*, (SELECT COUNT(*) FROM goals g WHERE g.period_id = p.id AND ${readableGoalSql("g")}) AS goal_count FROM goal_periods p
    ${options.includeArchived ? "" : "WHERE p.archived_at IS NULL"} ORDER BY p.starts_on DESC, p.name LIMIT 200`).all({ userId }) as Array<PeriodRow & { goal_count: number }>;
  const admin = userRole(userId) === "admin";
  return rows.map((row) => ({ id: row.id, name: row.name, startsOn: row.starts_on, endsOn: row.ends_on, archived: row.archived_at !== null, current: row.starts_on <= day && day <= row.ends_on, goalCount: row.goal_count, canEdit: canWriteContent(userId) && (admin || row.created_by === userId) }));
}

/** The open period containing today (the latest-starting one when periods overlap), for new goals (D1148). */
export function currentPeriodId(nowMs?: number): string | null {
  const day = today(nowMs);
  const row = db.query("SELECT id FROM goal_periods WHERE archived_at IS NULL AND starts_on <= ? AND ends_on >= ? ORDER BY starts_on DESC, ends_on, name LIMIT 1").get(day, day) as { id: string } | null;
  return row?.id ?? null;
}

function checkPeriodInput(input: { name?: string; startsOn?: string; endsOn?: string }) {
  if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > GOAL_LIMITS.periodName)) throw invalid("A period needs a name (up to 60 characters)");
  for (const value of [input.startsOn, input.endsOn]) if (value !== undefined && !DATE.test(value)) throw invalid("Dates are YYYY-MM-DD");
}

/** D1264: period names are unique (case aside), so a second "Add period" never makes a twin. */
function requireUniquePeriodName(name: string, exceptId: string | null = null) {
  const taken = db.query("SELECT 1 FROM goal_periods WHERE lower(name) = lower(?) AND id IS NOT ? LIMIT 1").get(name.trim(), exceptId);
  if (taken) throw new GoalError(409, "DUPLICATE_PERIOD", `There is already a period named “${name.trim()}”. Choose another name.`);
}

function schedulePeriodEnd(period: PeriodRow) {
  const at = Date.parse(`${period.ends_on}T09:00:00Z`) - 7 * 86_400_000;
  if (period.archived_at || at <= Date.now()) { cancelSchedules({ kind: "goal_period", id: period.id }); return; }
  upsertSchedule({ kind: "goal_period", id: period.id }, "goals.period_end", { once: new Date(at).toISOString() });
}

export function createPeriod(userId: string, input: { name: string; startsOn: string; endsOn: string }): PeriodView {
  requireWriter(userId);
  checkPeriodInput(input);
  if (input.endsOn <= input.startsOn) throw invalid("A period ends after it starts");
  const id = Bun.randomUUIDv7();
  db.transaction(() => {
    requireUniquePeriodName(input.name);
    db.query("INSERT INTO goal_periods (id, name, starts_on, ends_on, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.name.trim(), input.startsOn, input.endsOn, userId, now(), now());
    schedulePeriodEnd(db.query("SELECT * FROM goal_periods WHERE id = ?").get(id) as PeriodRow);
    audit(userId, null, "goals.period_create", { periodId: id });
  })();
  return listPeriods(userId, { includeArchived: true }).find((period) => period.id === id)!;
}

function requirePeriodEditor(userId: string, periodId: string) {
  requireWriter(userId);
  const period = checkPeriod(periodId);
  if (!period) throw notFound("Period");
  if (period.created_by !== userId && userRole(userId) !== "admin") throw new GoalError(403, "OWNER_ONLY", "Only whoever made the period or an admin can change it");
  return period;
}

export function updatePeriod(userId: string, periodId: string, input: { name?: string; startsOn?: string; endsOn?: string; archived?: boolean }): PeriodView {
  const period = requirePeriodEditor(userId, periodId);
  checkPeriodInput(input);
  const starts = input.startsOn ?? period.starts_on;
  const ends = input.endsOn ?? period.ends_on;
  if (ends <= starts) throw invalid("A period ends after it starts");
  db.transaction(() => {
    if (input.name !== undefined) requireUniquePeriodName(input.name, period.id);
    db.query("UPDATE goal_periods SET name = ?, starts_on = ?, ends_on = ?, archived_at = ?, updated_at = ? WHERE id = ?")
      .run(input.name?.trim() ?? period.name, starts, ends, input.archived === undefined ? period.archived_at : input.archived ? period.archived_at ?? now() : null, now(), period.id);
    schedulePeriodEnd(db.query("SELECT * FROM goal_periods WHERE id = ?").get(period.id) as PeriodRow);
    audit(userId, null, "goals.period_update", { periodId: period.id });
  })();
  return listPeriods(userId, { includeArchived: true }).find((entry) => entry.id === period.id)!;
}

/** Deletes a period; its goals keep their own dates and lose the period (no goal is deleted). */
export function deletePeriod(userId: string, periodId: string) {
  const period = requirePeriodEditor(userId, periodId);
  db.transaction(() => {
    db.query("DELETE FROM goal_periods WHERE id = ?").run(period.id);
    cancelSchedules({ kind: "goal_period", id: period.id });
    audit(userId, null, "goals.period_delete", { periodId: period.id });
  })();
}

// ---------------------------------------------------------------------------------------------------
// Linked work.

/** Links work to a goal (`work contributes goal`, §B.4): edit on the work, read on the goal. */
export function linkWork(userId: string, goalRef: string, work: { kind: string; id: string }) {
  const { goal } = requireGoal(goalRef, userId, "view");
  return createLink({ a: work as never, b: { kind: "goal", id: goal.id }, relation: "contributes", actorId: userId });
}

/** Goals a card (or any item) contributes to, readable by the viewer: the card slot's chips. */
export function goalsOfItem(userId: string, kind: string, id: string): GoalSummary[] {
  const rows = db.query(`SELECT g.* FROM work_links l JOIN goals g ON g.id = l.b_id WHERE l.a_kind = $kind AND l.a_id = $id AND l.b_kind = 'goal' AND l.relation = 'contributes'
    AND ${readableGoalSql("g")} ORDER BY l.created_at LIMIT 20`).all({ kind, id, userId }) as GoalRow[];
  return summarize(rows, userId);
}

// ---------------------------------------------------------------------------------------------------
// Bin (§B.13): the owner restores and purges; purge detaches children (parent SET NULL).

export function goalsInBin(userId: string) {
  return db.query("SELECT id, title, deleted_at, purge_after, purge_started_at FROM goals WHERE owner_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500").all(userId) as Array<{ id: string; title: string; deleted_at: string; purge_after: string; purge_started_at: string | null }>;
}

export function restoreGoal(userId: string, id: string) {
  return db.transaction(() => {
    const row = db.query("SELECT * FROM goals WHERE id = ? AND owner_id = ?").get(id, userId) as GoalRow | null;
    if (!row) return "not_found" as const;
    if (row.purge_started_at) return "purging" as const;
    if (row.deleted_at === null) return "already" as const;
    db.query("UPDATE goals SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?").run(now(), id);
    recordItemActivity({ itemKind: "goal", itemId: id, actorId: userId, kind: "restored" });
    syncFts(id);
    syncReminder(row);
    if (row.parent_id) recomputeGoal(row.parent_id);
    audit(userId, null, "goals.restore", { goalId: id });
    return { visibility: row.visibility };
  })();
}

export function purgeGoal(id: string, actorId: string | null, reason: string) {
  return db.transaction(() => {
    const row = db.query("SELECT parent_id, deleted_at FROM goals WHERE id = ?").get(id) as { parent_id: string | null; deleted_at: string | null } | null;
    if (!row || row.deleted_at === null) return false;
    db.query("UPDATE goals SET purge_started_at = COALESCE(purge_started_at, ?) WHERE id = ?").run(now(), id);
    db.query("DELETE FROM goals WHERE id = ?").run(id);
    audit(actorId, null, "goals.purge", { goalId: id, reason });
    return true;
  })();
}
