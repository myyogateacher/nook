import { audit, db, now } from "../db";
import { readableContainerSql } from "../access/workspaceItems";
import { recordCardActivity } from "../tasks/activity";
import { readableCard } from "../tasks/access";
import { captureUndo } from "../undo";
import { refFrom, resolveRefs, workKindAdapter } from "../links/service";
import { readUnitPreferences, readWorkspaceSettings } from "../workspaceSettings";
import { cancelSchedules, upsertSchedule } from "../schedules/service";
import { notify } from "../notify";
import { canWriteContent } from "../team/userRole";
import { formatDuration, parseDuration } from "../../shared/duration";
import { addDays, isValidTimeZone, zonedToUtc } from "../../shared/calendarRecurrence";
import { workRefKey, type WorkRef, type WorkSummary } from "../../shared/workRefs";
import {
  DESCRIPTION_MAX, isTimeTargetKind, localDate, MAX_ENTRY_SECONDS, MAX_TAGS, PROJECT_COLORS, TAG_MAX, weekStartOf,
  type ProjectColor, type TimeEntry, type TimeSource
} from "../../shared/time";
import { atLeast, canLogOn, hiddenProjectSql, HIDDEN_PROJECT_LABEL, moneyVisibleSql, PROJECT_JOIN, projectLevel, projectRow, projectSettings, roleOf, visibleEntrySql, type ProjectRow } from "./access";

/**
 * Time entries and the timer (lane TIME, docs/plan/WORKSPACE_MODULES.md §D.2). Every write goes
 * through here, inside one transaction with its audit row (and the card's activity when it tracks a
 * card), so the web app, MCP, REST v1, chat agents, and approved proposals behave the same.
 *
 * - One running timer per person (D870): starting stops the running one at the same instant; the
 *   partial unique index refuses a second even under a race (T534).
 * - A stored entry is at most 24 hours (D871); stopping a longer timer splits it into consecutive
 *   entries of at most 24 hours each, so no time is lost.
 * - The rate and currency are copied onto billable entries when written (D882): the person's rate on
 *   the project, else the project's rate.
 * - Locked entries (an approved week, D874) are read-only to their author; the project's managers
 *   may still change them, and every check is here, so MCP and bulk writes cannot bypass it (T533).
 */

export class TimeError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export const notFound = (what = "Time entry") => new TimeError(404, "NOT_FOUND", `${what} not found`);
const invalid = (message: string, code = "INVALID") => new TimeError(400, code, message);

/** A work item as callers name it: a key or URL, `{ kind, id }`, or `{ ref }`. */
export type TargetInput = string | { kind: string; id: string } | { ref: string } | null | undefined;

export type Actor = { userId: string; via?: TimeSource };

export type EntryRow = {
  id: string; user_id: string; project_id: string | null; description: string; started_at: string; ended_at: string | null; duration_s: number | null; tz: string;
  billable: number; rate_minor: number | null; currency: string | null; tags_json: string; target_kind: string | null; target_id: string | null; source: TimeSource;
  locked_at: string | null; locked_by: string | null; revision: number; created_at: string; updated_at: string;
};

type EntryViewRow = EntryRow & {
  user_name: string | null; project_name: string | null; project_color: string | null; client_name: string | null; money_ok: number; manager: number; project_deleted: string | null;
  project_hidden: number;
};

// The project's name, color, and client only for viewers who can open it (TG4, D1143); a hidden project
// reads as HIDDEN_PROJECT_LABEL in the sheet, the card's Time section, summaries, and the CSV.
export const entrySelect = () => `SELECT e.*, u.display_name AS user_name,
    CASE WHEN ${hiddenProjectSql()} THEN 1 ELSE 0 END AS project_hidden,
    CASE WHEN ${hiddenProjectSql()} THEN '${HIDDEN_PROJECT_LABEL.replace("'", "''")}' ELSE p.name END AS project_name,
    CASE WHEN ${hiddenProjectSql()} THEN 'slate' ELSE p.color END AS project_color, p.deleted_at AS project_deleted,
    CASE WHEN ${hiddenProjectSql()} THEN NULL ELSE co.name END AS client_name,
    CASE WHEN ${moneyVisibleSql()} THEN 1 ELSE 0 END AS money_ok,
    CASE WHEN p.id IS NOT NULL AND ${readableContainerSql("time_project", "p", { minLevel: "manage" })} THEN 1 ELSE 0 END AS manager
  FROM ${PROJECT_JOIN} LEFT JOIN users u ON u.id = e.user_id LEFT JOIN companies co ON co.id = p.company_id`;

const nowMs = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const runningSeconds = (row: Pick<EntryRow, "started_at">, at = nowMs()) => Math.max(0, Math.floor((at - Date.parse(row.started_at)) / 1000));
export const entrySeconds = (row: Pick<EntryRow, "started_at" | "duration_s">, at = nowMs()) => row.duration_s ?? runningSeconds(row, at);

const parseTags = (json: string): string[] => { try { const value = JSON.parse(json); return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : []; } catch { return []; } };
const colorOf = (value: string | null): ProjectColor => (PROJECT_COLORS as readonly string[]).includes(value ?? "") ? value as ProjectColor : "amber";

/** Entries as the viewer sees them (targets resolved for the viewer: unreadable ones are hidden, T501). */
export function toEntries(rows: readonly EntryViewRow[], viewerId: string, at = nowMs()): TimeEntry[] {
  const refs = rows.filter((row) => row.target_kind && row.target_id).map((row) => ({ kind: row.target_kind, id: row.target_id }) as WorkRef);
  const summaries = refs.length ? resolveRefs(refs, { userId: viewerId }) : new Map<string, WorkSummary | null>();
  return rows.map((row) => {
    const seconds = entrySeconds(row, at);
    const moneyOk = row.money_ok === 1;
    const ref = row.target_kind && row.target_id ? { kind: row.target_kind, id: row.target_id } as WorkRef : null;
    const summary = ref ? summaries.get(workRefKey(ref)) ?? null : null;
    const own = row.user_id === viewerId;
    const locked = row.locked_at !== null;
    return {
      id: row.id,
      user: { id: row.user_id, name: row.user_name ?? "Former member" },
      project: row.project_id && row.project_name && !row.project_deleted ? { id: row.project_id, name: row.project_name, color: colorOf(row.project_color), client: row.client_name } : null,
      description: row.description,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationS: seconds,
      running: row.ended_at === null,
      tz: row.tz,
      billable: row.billable === 1,
      rateMinor: moneyOk ? row.rate_minor : null,
      amountMinor: moneyOk && row.billable === 1 && row.rate_minor !== null ? Math.round((row.rate_minor * seconds) / 3600) : null,
      currency: moneyOk ? row.currency : null,
      tags: parseTags(row.tags_json),
      target: ref ? summary ?? { kind: ref.kind, hidden: true } : null,
      source: row.source,
      locked,
      canEdit: (own && !locked) || row.manager === 1,
      revision: row.revision
    };
  });
}

export function entryView(id: string, viewerId: string): TimeEntry | null {
  const row = db.query(`${entrySelect()} WHERE e.id = $id AND ${visibleEntrySql()}`).get({ id, userId: viewerId }) as EntryViewRow | null;
  return row ? toEntries([row], viewerId)[0]! : null;
}

const entryRow = (id: string) => db.query("SELECT * FROM time_entries WHERE id = ?").get(id.toLowerCase()) as EntryRow | null;

// ---------------------------------------------------------------------------
// Validation helpers

function cleanTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Map<string, string>();
  for (const raw of tags) {
    const tag = raw.trim().replace(/\s+/g, " ");
    if (!tag) continue;
    if (tag.length > TAG_MAX) throw invalid(`A tag is at most ${TAG_MAX} characters`);
    if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
  }
  if (seen.size > MAX_TAGS) throw invalid(`An entry has at most ${MAX_TAGS} tags`);
  return [...seen.values()];
}

function rememberTags(tags: readonly string[], userId: string) {
  const insert = db.query("INSERT OR IGNORE INTO time_tags (name, created_by, created_at) VALUES (?, ?, ?)");
  for (const tag of tags) insert.run(tag, userId, now());
}

function cleanDescription(text: string | undefined | null) {
  const value = (text ?? "").replace(/[\r\n]+/g, " ").trim();
  if (value.length > DESCRIPTION_MAX) throw invalid(`A description is at most ${DESCRIPTION_MAX} characters`);
  return value;
}

function cleanTz(tz: string | undefined | null, userId: string): string {
  if (tz && isValidTimeZone(tz)) return tz;
  const stored = db.query("SELECT tz FROM time_user_settings WHERE user_id = ?").get(userId) as { tz: string } | null;
  return stored?.tz ?? "UTC";
}

/** A project the actor may log on, or null for none. Guests must name one (§G.1 Q8). */
function loggableProject(projectRef: string | null | undefined, userId: string): ProjectRow | null {
  if (!projectRef) {
    if (roleOf(userId) === "guest") throw invalid("Choose a project: guests log time on projects they belong to", "PROJECT_REQUIRED");
    return null;
  }
  const row = projectRow(projectRef);
  if (!row || row.deleted_at !== null || projectLevel(row.id, userId) === "none") throw notFound("Project");
  if (!canLogOn(row.id, userId)) throw new TimeError(403, "READ_ONLY", "You can see this project but not log time on it");
  if (row.archived_at) throw new TimeError(409, "PROJECT_ARCHIVED", "This project is archived; unarchive it to log time");
  return row;
}

/** A work item the actor can read, as a ref (keys, URLs, and `kind:id` accepted). */
export function resolveTarget(input: TargetInput, userId: string): WorkRef | null {
  if (input === null || input === undefined || input === "") return null;
  const ref = refFrom(typeof input === "string" ? { ref: input } : input as Record<string, unknown>, { userId });
  if (!isTimeTargetKind(ref.kind)) throw invalid("Time can track a card, goal, key result, contact, company, deal, booking, or event");
  const level = workKindAdapter(ref.kind)?.level(ref.id, { userId }) ?? "none";
  if (level === "none") throw notFound("Work item");
  return ref;
}

/** The project linked to a card's board, when the person may log on it (D876). */
export function defaultProjectFor(target: WorkRef | null, userId: string): ProjectRow | null {
  if (target && (target.kind === "company" || target.kind === "contact" || target.kind === "deal" || target.kind === "booking")) return clientProjectFor(target, userId);
  if (!target || target.kind !== "card") return null;
  const card = readableCard(target.id, userId);
  if (!card) return null;
  const row = db.query("SELECT * FROM time_projects WHERE board_id = ? AND deleted_at IS NULL AND archived_at IS NULL").get(card.board.id) as ProjectRow | null;
  return row && canLogOn(row.id, userId) ? row : null;
}

/**
 * A CRM record's client project (C15, D1057): the company it is (or belongs to: a contact's company,
 * a deal's company, a booking's contact's company), then the first live project of that client the
 * person may log on. The target was already checked readable; the project goes through canLogOn.
 */
function clientProjectFor(target: WorkRef, userId: string): ProjectRow | null {
  const companySql: Record<string, string> = {
    company: "SELECT id AS company_id FROM companies WHERE id = ?",
    contact: "SELECT company_id FROM contacts WHERE id = ?",
    deal: "SELECT company_id FROM deals WHERE id = ?",
    booking: "SELECT c.company_id FROM bookings b JOIN contacts c ON c.id = b.contact_id WHERE b.id = ?"
  };
  const company = (db.query(companySql[target.kind]!).get(target.id) as { company_id: string | null } | null)?.company_id;
  if (!company) return null;
  const rows = db.query("SELECT * FROM time_projects WHERE company_id = ? AND deleted_at IS NULL AND archived_at IS NULL ORDER BY name COLLATE NOCASE LIMIT 20").all(company) as ProjectRow[];
  return rows.find((row) => canLogOn(row.id, userId)) ?? null;
}

/** The rate on billable entries (D882): the person's rate on the project, else the project's. */
function rateFor(project: ProjectRow | null, userId: string, billable: boolean): { rate: number | null; currency: string | null } {
  if (!project || !billable) return { rate: null, currency: project?.currency ?? null };
  const member = db.query("SELECT rate_minor FROM time_member_rates WHERE project_id = ? AND user_id = ?").get(project.id, userId) as { rate_minor: number } | null;
  return { rate: member?.rate_minor ?? project.rate_minor, currency: project.currency };
}

/** An approved week is locked for its author (D874): new entries in it are refused too. */
function weekLocked(projectId: string | null, userId: string, startedAt: string, tz: string): boolean {
  if (!projectId) return false;
  const weekStart = weekStartOf(localDate(startedAt, tz), readUnitPreferences(userId).weekStart);
  return db.query("SELECT 1 FROM time_approvals WHERE project_id = ? AND user_id = ? AND week_start = ? AND status = 'approved'").get(projectId, userId, weekStart) !== null;
}

function requireWriter(userId: string) {
  // Guests write here only through the module's own allowlist (readOnlyWrites); viewers never do.
  const role = roleOf(userId);
  if (!role) throw notFound("Person");
  if (role === "viewer" || (role !== "guest" && !canWriteContent(userId))) throw new TimeError(403, "READ_ONLY", "Your team role is read-only");
}

function cardActivity(entry: Pick<EntryRow, "id" | "target_kind" | "target_id" | "duration_s">, actorId: string) {
  if (entry.target_kind !== "card" || !entry.target_id || entry.duration_s === null) return;
  const card = db.query("SELECT board_id FROM cards WHERE id = ?").get(entry.target_id) as { board_id: string } | null;
  if (card) recordCardActivity({ cardId: entry.target_id, boardId: card.board_id, actorId, kind: "time_logged", payload: { item: { id: entry.id, label: formatDuration(entry.duration_s) } } });
}

// ---------------------------------------------------------------------------
// Budgets (80% and 100% alerts to the project's managers)

export function budgetPeriodStart(project: Pick<ProjectRow, "budget_period">, at = nowMs()): string | null {
  if (project.budget_period !== "monthly") return null;
  const date = new Date(at);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

export function projectUsage(project: ProjectRow, at = nowMs()): { seconds: number; amountMinor: number } {
  const from = budgetPeriodStart(project, at);
  const rows = db.query(`SELECT started_at, duration_s, billable, rate_minor FROM time_entries WHERE project_id = ?${from ? " AND started_at >= ?" : ""}`)
    .all(...(from ? [project.id, from] : [project.id])) as Array<{ started_at: string; duration_s: number | null; billable: number; rate_minor: number | null }>;
  let seconds = 0;
  let amountMinor = 0;
  for (const row of rows) {
    const value = entrySeconds(row, at);
    seconds += value;
    if (row.billable === 1 && row.rate_minor !== null) amountMinor += Math.round((row.rate_minor * value) / 3600);
  }
  return { seconds, amountMinor };
}

function managersOf(project: ProjectRow): string[] {
  const ids = new Set<string>([project.owner_id]);
  for (const row of db.query("SELECT user_id FROM item_members WHERE item_kind = 'time_project' AND item_id = ? AND level = 'manage'").all(project.id) as Array<{ user_id: string }>) ids.add(row.user_id);
  for (const row of db.query(`SELECT gm.user_id FROM item_group_grants g JOIN group_members gm ON gm.group_id = g.group_id WHERE g.item_kind = 'time_project' AND g.item_id = ? AND g.level = 'manage'`).all(project.id) as Array<{ user_id: string }>) ids.add(row.user_id);
  return [...ids];
}
export { managersOf };

export const projectHref = (project: Pick<ProjectRow, "name" | "short_id">) => `/time/projects/${slugFor(project.name)}-${project.short_id}`;
const slugFor = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";

function checkBudget(projectId: string | null, actorId: string) {
  if (!projectId) return;
  const project = db.query("SELECT * FROM time_projects WHERE id = ?").get(projectId) as ProjectRow | null;
  if (!project || project.budget_kind === "none" || !project.budget_value) return;
  const usage = projectUsage(project);
  const used = project.budget_kind === "hours" ? usage.seconds / 3600 : usage.amountMinor;
  const ratio = used / project.budget_value;
  const threshold = ratio >= 1 ? 100 : ratio >= 0.8 ? 80 : 0;
  if (!threshold) return;
  const period = budgetPeriodStart(project)?.slice(0, 7) ?? "total";
  // Once per crossing (TG2, D1142): the dedupe key only folds unread repeats, so after the managers
  // read the alert every later write sent it (and a push) again. The project remembers what it sent.
  const [sentPeriod, sentThreshold] = (project.budget_alerted ?? "").split(":");
  if (sentPeriod === period && Number(sentThreshold) >= threshold) return;
  db.query("UPDATE time_projects SET budget_alerted = ? WHERE id = ?").run(`${period}:${threshold}`, project.id);
  notify({
    userIds: managersOf(project), module: "time", topic: "time.budget", includeActor: true,
    title: threshold === 100 ? `${project.name} is over its budget` : `${project.name} has used 80% of its budget`,
    body: `${Math.round(ratio * 100)}% of the ${project.budget_period === "monthly" ? "monthly " : ""}budget is used.`,
    href: projectHref(project), item: { kind: "time_project", id: project.id }, actor: actorId,
    dedupeKey: `time.budget:${project.id}:${period}:${threshold}`,
    email: { template: "time.update", payload: { topic: "time.budget", kind: "time_project", id: project.id, threshold }, coalesceKey: `time.budget:${project.id}:${period}:${threshold}` }
  });
}

// ---------------------------------------------------------------------------
// Long timer alert (schedule `time.long_timer`, per running entry)

function scheduleLongTimer(entry: Pick<EntryRow, "id" | "user_id" | "started_at">) {
  const settings = db.query("SELECT long_timer_hours FROM time_user_settings WHERE user_id = ?").get(entry.user_id) as { long_timer_hours: number } | null;
  const hours = settings?.long_timer_hours ?? 8;
  if (!hours) return;
  const at = Date.parse(entry.started_at) + hours * 3_600_000;
  if (at <= nowMs()) return;
  upsertSchedule({ kind: "time_entry", id: entry.id }, "time.long_timer", { once: iso(at) }, { hours }, { userId: entry.user_id });
}

// ---------------------------------------------------------------------------
// The timer

export function runningEntry(userId: string): EntryRow | null {
  return db.query("SELECT * FROM time_entries WHERE user_id = ? AND ended_at IS NULL").get(userId) as EntryRow | null;
}

export function runningView(userId: string): TimeEntry | null {
  const row = runningEntry(userId);
  return row ? entryView(row.id, userId) : null;
}

/** Ends a running entry at `atMs`, splitting time past 24 hours into further entries (D871). Returns its id. */
function finish(row: EntryRow, atMs: number, actorId: string): string {
  const startMs = Date.parse(row.started_at);
  const end = Math.max(startMs, atMs);
  let total = Math.floor((end - startMs) / 1000);
  const first = Math.min(total, MAX_ENTRY_SECONDS);
  const timestamp = now();
  db.query("UPDATE time_entries SET ended_at = ?, duration_s = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(iso(startMs + first * 1000), first, timestamp, row.id);
  total -= first;
  let cursor = startMs + first * 1000;
  while (total > 0) {
    const part = Math.min(total, MAX_ENTRY_SECONDS);
    db.query(`INSERT INTO time_entries (id, user_id, project_id, description, started_at, ended_at, duration_s, tz, billable, rate_minor, currency, tags_json, target_kind, target_id, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'timer', ?, ?)`).run(Bun.randomUUIDv7(), row.user_id, row.project_id, row.description, iso(cursor), iso(cursor + part * 1000), part, row.tz,
      row.billable, row.rate_minor, row.currency, row.tags_json, row.target_kind, row.target_id, timestamp, timestamp);
    cursor += part * 1000;
    total -= part;
  }
  cancelSchedules({ kind: "time_entry", id: row.id }, "time.long_timer");
  cardActivity({ ...row, duration_s: Math.floor((end - startMs) / 1000) }, actorId);
  audit(actorId, null, "time.timer_stop", { entryId: row.id, seconds: Math.floor((end - startMs) / 1000) });
  checkBudget(row.project_id, actorId);
  return row.id;
}

export type StartInput = {
  description?: string | null;
  projectId?: string | null;
  target?: TargetInput;
  billable?: boolean;
  tags?: string[];
  /** Start in the past ("I started 10 minutes ago"). */
  startedAt?: string;
  tz?: string;
};

export function startTimer(actor: Actor, input: StartInput): { entry: TimeEntry; stopped: string | null } {
  requireWriter(actor.userId);
  return db.transaction(() => {
    const target = resolveTarget(input.target, actor.userId);
    const project = input.projectId !== undefined && input.projectId !== null ? loggableProject(input.projectId, actor.userId) : defaultProjectFor(target, actor.userId) ?? loggableProject(null, actor.userId);
    const description = cleanDescription(input.description);
    if (project && projectSettings(project).requireDescription && !description && !target) throw invalid("This project needs a description or a work item", "DESCRIPTION_REQUIRED");
    const tags = cleanTags(input.tags);
    const at = nowMs();
    let startMs = at;
    if (input.startedAt) {
      startMs = Date.parse(input.startedAt);
      if (!Number.isFinite(startMs) || startMs > at + 60_000 || startMs < at - MAX_ENTRY_SECONDS * 1000) throw invalid("A timer starts within the last 24 hours");
    }
    const tz = cleanTz(input.tz, actor.userId);
    if (weekLocked(project?.id ?? null, actor.userId, iso(startMs), tz)) throw new TimeError(409, "WEEK_LOCKED", "This week is approved and locked for this project");
    const previous = runningEntry(actor.userId);
    let stopped: string | null = null;
    if (previous) stopped = finish(previous, Math.max(startMs, Date.parse(previous.started_at)), actor.userId);
    const billable = input.billable ?? (project ? project.billable_default === 1 : false);
    const { rate, currency } = rateFor(project, actor.userId, billable);
    const id = Bun.randomUUIDv7();
    const timestamp = now();
    db.query(`INSERT INTO time_entries (id, user_id, project_id, description, started_at, tz, billable, rate_minor, currency, tags_json, target_kind, target_id, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, actor.userId, project?.id ?? null, description, iso(startMs), tz, billable ? 1 : 0, rate, currency,
      JSON.stringify(tags), target?.kind ?? null, target?.id ?? null, actor.via === "mcp" || actor.via === "proposal" ? actor.via : "timer", timestamp, timestamp);
    rememberTags(tags, actor.userId);
    scheduleLongTimer({ id, user_id: actor.userId, started_at: iso(startMs) });
    audit(actor.userId, null, "time.timer_start", { entryId: id, projectId: project?.id ?? null, targetKind: target?.kind ?? null, targetId: target?.id ?? null });
    return { entry: entryView(id, actor.userId)!, stopped };
  })();
}

export function stopTimer(actor: Actor, at?: string): TimeEntry | null {
  return db.transaction(() => {
    const row = runningEntry(actor.userId);
    if (!row) return null;
    let atMs = nowMs();
    if (at) {
      const parsed = Date.parse(at);
      if (!Number.isFinite(parsed) || parsed > atMs + 60_000) throw invalid("Stop at a time that has passed");
      atMs = Math.max(parsed, Date.parse(row.started_at));
    }
    const id = finish(row, atMs, actor.userId);
    return entryView(id, actor.userId);
  })();
}

// ---------------------------------------------------------------------------
// Entries

export type EntryInput = {
  startedAt: string;
  /** Seconds, or text such as `1h30`, `90m`, `1:30`. */
  duration?: number | string | null;
  endedAt?: string | null;
  description?: string | null;
  projectId?: string | null;
  target?: TargetInput;
  billable?: boolean;
  tags?: string[];
  tz?: string;
  source?: TimeSource;
};

export function parseSeconds(value: number | string | null | undefined, userId: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;
  return parseDuration(value, { bare: readUnitPreferences(userId).bareDuration });
}

function spanOf(input: { startedAt: string; duration?: number | string | null; endedAt?: string | null }, userId: string): { startMs: number; seconds: number } {
  const startMs = Date.parse(input.startedAt);
  if (!Number.isFinite(startMs)) throw invalid("startedAt is not a time");
  let seconds: number | null;
  if (input.endedAt) {
    const endMs = Date.parse(input.endedAt);
    if (!Number.isFinite(endMs) || endMs < startMs) throw invalid("The end is before the start");
    seconds = Math.round((endMs - startMs) / 1000);
  } else {
    seconds = parseSeconds(input.duration, userId);
    if (seconds === null) throw invalid("Give a duration (1h 30m, 90m, 1:30) or an end time", "DURATION_REQUIRED");
  }
  if (seconds < 0) throw invalid("A duration cannot be negative");
  if (seconds > MAX_ENTRY_SECONDS) throw invalid("One entry is at most 24 hours; log longer stretches as one entry per day", "TOO_LONG");
  if (startMs > nowMs() + 400 * 86_400_000) throw invalid("That start is too far in the future");
  return { startMs, seconds };
}

/** Creates one finished entry. Call inside a transaction (createEntry opens one). */
function insertEntry(actor: Actor, input: EntryInput): string {
  const target = resolveTarget(input.target, actor.userId);
  const project = input.projectId !== undefined && input.projectId !== null ? loggableProject(input.projectId, actor.userId) : (input.projectId === null ? loggableProject(null, actor.userId) : defaultProjectFor(target, actor.userId) ?? loggableProject(null, actor.userId));
  const description = cleanDescription(input.description);
  if (project && projectSettings(project).requireDescription && !description && !target) throw invalid("This project needs a description or a work item", "DESCRIPTION_REQUIRED");
  const tags = cleanTags(input.tags);
  const { startMs, seconds } = spanOf(input, actor.userId);
  const tz = cleanTz(input.tz, actor.userId);
  if (weekLocked(project?.id ?? null, actor.userId, iso(startMs), tz)) throw new TimeError(409, "WEEK_LOCKED", "This week is approved and locked for this project");
  const billable = input.billable ?? (project ? project.billable_default === 1 : false);
  const { rate, currency } = rateFor(project, actor.userId, billable);
  const id = Bun.randomUUIDv7();
  const timestamp = now();
  const source = input.source ?? actor.via ?? "manual";
  db.query(`INSERT INTO time_entries (id, user_id, project_id, description, started_at, ended_at, duration_s, tz, billable, rate_minor, currency, tags_json, target_kind, target_id, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, actor.userId, project?.id ?? null, description, iso(startMs), iso(startMs + seconds * 1000), seconds, tz,
    billable ? 1 : 0, rate, currency, JSON.stringify(tags), target?.kind ?? null, target?.id ?? null, source, timestamp, timestamp);
  rememberTags(tags, actor.userId);
  cardActivity({ id, target_kind: target?.kind ?? null, target_id: target?.id ?? null, duration_s: seconds }, actor.userId);
  audit(actor.userId, null, "time.entry_create", { entryId: id, projectId: project?.id ?? null, seconds, source });
  checkBudget(project?.id ?? null, actor.userId);
  return id;
}

export function createEntry(actor: Actor, input: EntryInput): TimeEntry {
  requireWriter(actor.userId);
  return db.transaction(() => entryView(insertEntry(actor, input), actor.userId)!)();
}

export type EntryPatch = {
  description?: string;
  projectId?: string | null;
  target?: TargetInput;
  billable?: boolean;
  tags?: string[];
  startedAt?: string;
  duration?: number | string;
  endedAt?: string;
  tz?: string;
  expectedRevision?: number;
};

/** Whether the person may change this entry (T532, D874): theirs and unlocked, or as the project's manager. */
function editRight(row: EntryRow, userId: string): "author" | "manager" | null {
  const manager = row.project_id !== null && atLeast(projectLevel(row.project_id, userId), "manage");
  if (manager) return "manager";
  if (row.user_id === userId) return row.locked_at === null ? "author" : null;
  return null;
}

function editableEntry(id: string, userId: string): { row: EntryRow; right: "author" | "manager" } {
  const row = entryRow(id);
  if (!row || !entryView(row.id, userId)) throw notFound();
  const right = editRight(row, userId);
  if (!right) throw row.locked_at !== null && row.user_id === userId
    ? new TimeError(409, "LOCKED", "This entry is in an approved week; ask a project manager to unlock it")
    : new TimeError(403, "READ_ONLY", "You can see this entry but not change it");
  return { row, right };
}

function applyPatch(actor: Actor, id: string, patch: EntryPatch): string {
  const { row, right } = editableEntry(id, actor.userId);
  if (patch.expectedRevision !== undefined && patch.expectedRevision !== row.revision) throw new TimeError(409, "ENTRY_CHANGED", "This entry changed since you opened it", { entry: entryView(row.id, actor.userId) });
  const next = { ...row };
  const changed: string[] = [];
  if (patch.description !== undefined) { next.description = cleanDescription(patch.description); changed.push("description"); }
  let project: ProjectRow | null = row.project_id ? projectRow(row.project_id) : null;
  if (patch.projectId !== undefined && (patch.projectId?.toLowerCase() ?? null) !== row.project_id) {
    // A manager edits entries on their project; moving someone's entry to another project is the author's call (T532).
    if (row.user_id !== actor.userId) throw new TimeError(403, "READ_ONLY", "Only the person who logged it moves an entry to another project");
    if (row.locked_at !== null) throw new TimeError(409, "LOCKED", "This entry is in an approved week");
    project = patch.projectId ? loggableProject(patch.projectId, actor.userId) : loggableProject(null, actor.userId);
    next.project_id = project?.id ?? null;
    changed.push("project");
  }
  if (patch.target !== undefined) {
    const target = resolveTarget(patch.target, actor.userId);
    next.target_kind = target?.kind ?? null;
    next.target_id = target?.id ?? null;
    changed.push("target");
  }
  if (patch.tags !== undefined) { next.tags_json = JSON.stringify(cleanTags(patch.tags)); rememberTags(cleanTags(patch.tags), actor.userId); changed.push("tags"); }
  if (patch.tz !== undefined) next.tz = cleanTz(patch.tz, row.user_id);
  if (patch.startedAt !== undefined || patch.duration !== undefined || patch.endedAt !== undefined) {
    if (row.ended_at === null) {
      if (patch.duration !== undefined || patch.endedAt !== undefined) throw invalid("Stop the timer to set its duration");
      const startMs = Date.parse(patch.startedAt!);
      if (!Number.isFinite(startMs) || startMs > nowMs() + 60_000 || startMs < nowMs() - MAX_ENTRY_SECONDS * 1000) throw invalid("A running timer starts within the last 24 hours");
      next.started_at = iso(startMs);
    } else {
      const span = spanOf({
        startedAt: patch.startedAt ?? row.started_at,
        duration: patch.endedAt !== undefined ? undefined : patch.duration ?? row.duration_s,
        endedAt: patch.endedAt ?? null
      }, actor.userId);
      next.started_at = iso(span.startMs);
      next.duration_s = span.seconds;
      next.ended_at = iso(span.startMs + span.seconds * 1000);
    }
    changed.push("time");
  }
  if (patch.billable !== undefined) { next.billable = patch.billable ? 1 : 0; changed.push("billable"); }
  if (changed.includes("billable") || changed.includes("project")) {
    const rate = rateFor(project, row.user_id, next.billable === 1);
    next.rate_minor = rate.rate;
    next.currency = rate.currency;
  }
  if (project && projectSettings(project).requireDescription && !next.description && !next.target_id) throw invalid("This project needs a description or a work item", "DESCRIPTION_REQUIRED");
  if (right === "author" && (changed.includes("time") || changed.includes("project")) && weekLocked(next.project_id, row.user_id, next.started_at, next.tz)) {
    throw new TimeError(409, "WEEK_LOCKED", "That week is approved and locked for this project");
  }
  if (!changed.length) return row.id;
  db.query(`UPDATE time_entries SET project_id = ?, description = ?, started_at = ?, ended_at = ?, duration_s = ?, tz = ?, billable = ?, rate_minor = ?, currency = ?, tags_json = ?,
    target_kind = ?, target_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`).run(next.project_id, next.description, next.started_at, next.ended_at, next.duration_s, next.tz,
    next.billable, next.rate_minor, next.currency, next.tags_json, next.target_kind, next.target_id, now(), row.id);
  if (row.ended_at === null && changed.includes("time")) scheduleLongTimer({ id: row.id, user_id: row.user_id, started_at: next.started_at });
  if (next.target_kind === "card" && next.ended_at !== null && (changed.includes("target") || changed.includes("time")) && (row.target_id !== next.target_id || row.duration_s !== next.duration_s)) {
    cardActivity(next, actor.userId);
  }
  audit(actor.userId, null, "time.entry_update", { entryId: row.id, fields: changed, ...(right === "manager" && row.user_id !== actor.userId ? { asManager: true } : {}) });
  checkBudget(next.project_id, actor.userId);
  return row.id;
}

export function updateEntry(actor: Actor, id: string, patch: EntryPatch): TimeEntry {
  requireWriter(actor.userId);
  return db.transaction(() => entryView(applyPatch(actor, id, patch), actor.userId)!)();
}

/** Deletes at once with an undo ticket (D813). A running timer is discarded. */
export function deleteEntry(actor: Actor, id: string): { undoTicket: string } {
  requireWriter(actor.userId);
  return db.transaction(() => {
    const { row } = editableEntry(id, actor.userId);
    const undoTicket = captureUndo({ actorId: actor.userId, kind: "time_entry", label: row.description || "Time entry", rows: [{ table: "time_entries", where: { id: row.id } }] });
    db.query("DELETE FROM time_entries WHERE id = ?").run(row.id);
    audit(actor.userId, null, "time.entry_delete", { entryId: row.id, ...(row.user_id !== actor.userId ? { asManager: true } : {}) });
    return { undoTicket };
  })();
}

/** Splits a finished entry at an instant inside it into two. */
export function splitEntry(actor: Actor, id: string, at: string): TimeEntry[] {
  requireWriter(actor.userId);
  return db.transaction(() => {
    const { row } = editableEntry(id, actor.userId);
    if (row.ended_at === null || row.duration_s === null) throw invalid("Stop the timer before splitting it");
    const atMs = Date.parse(at);
    const startMs = Date.parse(row.started_at);
    const endMs = Date.parse(row.ended_at);
    if (!Number.isFinite(atMs) || atMs <= startMs || atMs >= endMs) throw invalid("Split at a time inside the entry");
    const first = Math.round((atMs - startMs) / 1000);
    const timestamp = now();
    db.query("UPDATE time_entries SET duration_s = ?, ended_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(first, iso(atMs), timestamp, row.id);
    const second = Bun.randomUUIDv7();
    db.query(`INSERT INTO time_entries (id, user_id, project_id, description, started_at, ended_at, duration_s, tz, billable, rate_minor, currency, tags_json, target_kind, target_id, source, locked_at, locked_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(second, row.user_id, row.project_id, row.description, iso(atMs), row.ended_at, row.duration_s - first, row.tz, row.billable,
      row.rate_minor, row.currency, row.tags_json, row.target_kind, row.target_id, row.source, row.locked_at, row.locked_by, timestamp, timestamp);
    audit(actor.userId, null, "time.entry_split", { entryId: row.id, newEntryId: second });
    return [entryView(row.id, actor.userId)!, entryView(second, actor.userId)!];
  })();
}

// ---------------------------------------------------------------------------
// Bulk (MCP bulk_log_time, POST /api/time/entries/bulk): all or nothing, with a dry run

export type BulkOp = { op: "create"; items: EntryInput[] } | { op: "update"; items: Array<EntryPatch & { id: string }> } | { op: "delete"; items: Array<{ id: string }> };

class DryRun extends Error {
  constructor(readonly result: unknown) { super("dry run"); }
}

export function bulkEntries(actor: Actor, input: BulkOp & { dryRun?: boolean }): { dryRun: boolean; count: number; entries: TimeEntry[]; undoTicket?: string } {
  requireWriter(actor.userId);
  if (!input.items.length || input.items.length > 100) throw invalid("Send 1 to 100 items");
  try {
    return db.transaction(() => {
      const entries: TimeEntry[] = [];
      let undoTicket: string | undefined;
      input.items.forEach((item, index) => {
        try {
          if (input.op === "create") entries.push(entryView(insertEntry(actor, item as EntryInput), actor.userId)!);
          else if (input.op === "update") { const { id, ...patch } = item as EntryPatch & { id: string }; entries.push(entryView(applyPatch(actor, id, patch), actor.userId)!); }
          else {
            const { row } = editableEntry((item as { id: string }).id, actor.userId);
            entries.push(entryView(row.id, actor.userId)!);
          }
        } catch (error) {
          if (error instanceof TimeError) throw new TimeError(error.status, error.code, `Item ${index + 1}: ${error.message}`, { index });
          throw error;
        }
      });
      if (input.op === "delete") {
        const ids = entries.map((entry) => entry.id);
        if (!input.dryRun) {
          undoTicket = captureUndo({ actorId: actor.userId, kind: "time_entry", label: `${ids.length} time entries`, rows: ids.map((id) => ({ table: "time_entries", where: { id } })) });
          for (const id of ids) db.query("DELETE FROM time_entries WHERE id = ?").run(id);
          audit(actor.userId, null, "time.entry_delete", { entryIds: ids, bulk: true });
        }
      }
      const result = { dryRun: input.dryRun === true, count: entries.length, entries, ...(undoTicket ? { undoTicket } : {}) };
      if (input.dryRun) throw new DryRun(result);
      return result;
    })();
  } catch (error) {
    if (error instanceof DryRun) return error.result as ReturnType<typeof bulkEntries>;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Lists

export type EntryFilters = {
  from?: string;
  to?: string;
  /** "me" (default), "all" (everything visible), or a user id. */
  user?: string;
  projectId?: string;
  /** `none` for entries without a project. */
  noProject?: boolean;
  target?: WorkRef | null;
  billable?: boolean;
  tag?: string;
  q?: string;
  tz?: string;
  cursor?: string | null;
  limit?: number;
  /** Extra SQL (a chosen-item key's reach), with its own named parameters. */
  extra?: { sql: string; params: Record<string, string> };
};

/** A filter's day bound as an instant: dates are local days in `tz`; instants pass through. */
export function boundOf(value: string, tz: string, end: boolean): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return iso(zonedToUtc(`${end ? addDays(value, 1) : value}T00:00`, tz));
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw invalid("A range is dates (YYYY-MM-DD) or instants");
  return iso(ms);
}

export function entryWhere(viewerId: string, filters: EntryFilters): { sql: string; params: Record<string, string | number> } {
  const where = [visibleEntrySql()];
  const params: Record<string, string | number> = { userId: viewerId };
  const tz = filters.tz && isValidTimeZone(filters.tz) ? filters.tz : "UTC";
  if (filters.from) { where.push("e.started_at >= $from"); params.from = boundOf(filters.from, tz, false); }
  if (filters.to) { where.push("e.started_at < $to"); params.to = boundOf(filters.to, tz, true); }
  const user = filters.user ?? "me";
  if (user === "me") where.push("e.user_id = $userId");
  else if (user !== "all") { where.push("e.user_id = $filterUser"); params.filterUser = user.toLowerCase(); }
  if (filters.projectId) {
    const project = projectRow(filters.projectId);
    where.push("e.project_id = $projectId");
    params.projectId = project?.id ?? "-";
  } else if (filters.noProject) where.push("e.project_id IS NULL");
  if (filters.target) { where.push("e.target_kind = $targetKind AND e.target_id = $targetId"); params.targetKind = filters.target.kind; params.targetId = filters.target.id; }
  if (filters.billable !== undefined) { where.push("e.billable = $billable"); params.billable = filters.billable ? 1 : 0; }
  if (filters.tag) { where.push("EXISTS (SELECT 1 FROM json_each(e.tags_json) t WHERE t.value = $tag COLLATE NOCASE)"); params.tag = filters.tag; }
  if (filters.q?.trim()) { where.push("instr(lower(e.description), lower($q)) > 0"); params.q = filters.q.trim().slice(0, 200); }
  if (filters.extra) { where.push(`(${filters.extra.sql})`); Object.assign(params, filters.extra.params); }
  return { sql: where.join(" AND "), params };
}

export function listEntries(viewerId: string, filters: EntryFilters): { entries: TimeEntry[]; nextCursor: string | null } {
  const { sql, params } = entryWhere(viewerId, filters);
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  let cursorSql = "";
  if (filters.cursor) {
    const [startedAt, id] = Buffer.from(filters.cursor, "base64url").toString("utf8").split("|");
    if (!startedAt || !id) throw invalid("Invalid cursor");
    cursorSql = " AND (e.started_at < $cursorAt OR (e.started_at = $cursorAt AND e.id < $cursorId))";
    params.cursorAt = startedAt;
    params.cursorId = id;
  }
  params.limit = limit + 1;
  const rows = db.query(`${entrySelect()} WHERE ${sql}${cursorSql} ORDER BY e.started_at DESC, e.id DESC LIMIT $limit`).all(params) as EntryViewRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { entries: toEntries(page, viewerId), nextCursor: rows.length > limit && last ? Buffer.from(`${last.started_at}|${last.id}`).toString("base64url") : null };
}

/** Recent distinct (description, project, target) combinations to continue from (the timer popover). */
export function recentEntries(userId: string, limit = 8): TimeEntry[] {
  const rows = db.query(`${entrySelect()} WHERE e.id IN (
      SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY description, IFNULL(project_id, ''), IFNULL(target_id, '') ORDER BY started_at DESC) AS n
        FROM time_entries WHERE user_id = $userId AND ended_at IS NOT NULL AND (description <> '' OR project_id IS NOT NULL OR target_id IS NOT NULL)
        ORDER BY started_at DESC LIMIT 200) WHERE n = 1)
    ORDER BY e.started_at DESC LIMIT $limit`).all({ userId, limit }) as EntryViewRow[];
  return toEntries(rows, userId);
}

export { entryRow };
