import { db, now } from "../db";
import { nextFireIso, nextFires, scheduleRuleProblem, type ScheduleRule } from "../../shared/schedules";
import { isValidTimeZone } from "../../shared/calendarRecurrence";

export { nextFires } from "../../shared/schedules";

/**
 * Schedules (docs/plan/WORKSPACE_MODULES.md §B.6, D808, T504): everything the workspace modules fire
 * on a clock goes through one table and one dispatcher (server/schedules/dispatcher.ts). Modules never
 * add their own timers.
 *
 * A schedule belongs to an owner (`{ kind, id }`, the item it is about) and a purpose (namespaced,
 * `checkins.open`); there is at most one schedule per owner and purpose (`upsertSchedule` replaces
 * it). Its rule is a shared/schedules.ts rule in its zone; `next_fire_at` is the next instant.
 * Handlers are registered per purpose and run once per occurrence at most (`schedule_fires`).
 */

export type ScheduleRow = {
  id: string; purpose: string; owner_kind: string; owner_id: string; user_id: string | null; rule_json: string; tz: string;
  next_fire_at: string | null; claimed_at: string | null; last_fired_at: string | null; payload_json: string; enabled: number; created_at: string; updated_at: string;
};

export type Schedule = {
  id: string; purpose: string; owner: { kind: string; id: string }; userId: string | null; rule: ScheduleRule; tz: string;
  nextFireAt: string | null; lastFiredAt: string | null; payload: Record<string, unknown>; enabled: boolean;
};

export type ScheduleHandler = {
  /** Runs one occurrence. A synchronous handler runs inside its own transaction; an async one should open its own. */
  run: (schedule: Schedule, fireAt: string) => void | Promise<void>;
  /** Occurrences later than this when the dispatcher reaches them are skipped (recorded `skipped_late`). Default: never skipped. */
  skipIfLateMs?: number;
};

const handlers = new Map<string, ScheduleHandler>();
export const PURPOSE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export function registerScheduleHandler(purpose: string, handler: ScheduleHandler) {
  if (!PURPOSE_PATTERN.test(purpose) || purpose.length > 64) throw new Error(`Invalid schedule purpose ${purpose}`);
  if (handlers.has(purpose)) throw new Error(`Schedule handler ${purpose} is already registered`);
  handlers.set(purpose, handler);
  return () => { if (handlers.get(purpose) === handler) handlers.delete(purpose); };
}

export const scheduleHandler = (purpose: string) => handlers.get(purpose) ?? null;

export class ScheduleError extends Error {}

export function toSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id, purpose: row.purpose, owner: { kind: row.owner_kind, id: row.owner_id }, userId: row.user_id, rule: JSON.parse(row.rule_json) as ScheduleRule,
    tz: row.tz, nextFireAt: row.next_fire_at, lastFiredAt: row.last_fired_at, payload: JSON.parse(row.payload_json) as Record<string, unknown>, enabled: row.enabled === 1
  };
}

/**
 * Creates or replaces the owner's schedule for a purpose and computes its next fire after `fromMs`
 * (default now). Call inside the owning write's transaction. Returns the schedule.
 */
export function upsertSchedule(owner: { kind: string; id: string }, purpose: string, rule: ScheduleRule,
  payload: Record<string, unknown> = {}, options: { tz?: string; userId?: string | null; enabled?: boolean; fromMs?: number } = {}): Schedule {
  if (!PURPOSE_PATTERN.test(purpose)) throw new ScheduleError(`Invalid schedule purpose ${purpose}`);
  if (!/^[a-z_]{1,32}$/.test(owner.kind) || !owner.id || owner.id.length > 64) throw new ScheduleError("Invalid schedule owner");
  const tz = options.tz ?? "UTC";
  if (!isValidTimeZone(tz)) throw new ScheduleError("Invalid time zone");
  const problem = scheduleRuleProblem(rule, tz);
  if (problem) throw new ScheduleError(problem);
  const ruleJson = JSON.stringify(rule);
  const payloadJson = JSON.stringify(payload);
  if (ruleJson.length > 4096 || payloadJson.length > 8192) throw new ScheduleError("The schedule is too large");
  const fromMs = options.fromMs ?? Date.now();
  const next = nextFireIso(rule, tz, fromMs);
  const timestamp = now();
  const enabled = options.enabled === false ? 0 : 1;
  const existing = db.query("SELECT id FROM schedules WHERE owner_kind = ? AND owner_id = ? AND purpose = ?").get(owner.kind, owner.id, purpose) as { id: string } | null;
  if (existing) {
    db.query("UPDATE schedules SET rule_json = ?, tz = ?, next_fire_at = ?, payload_json = ?, enabled = ?, user_id = COALESCE(?, user_id), updated_at = ? WHERE id = ?")
      .run(ruleJson, tz, next, payloadJson, enabled, options.userId ?? null, timestamp, existing.id);
    return getSchedule(existing.id)!;
  }
  const id = Bun.randomUUIDv7();
  db.query(`INSERT INTO schedules (id, purpose, owner_kind, owner_id, user_id, rule_json, tz, next_fire_at, payload_json, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, purpose, owner.kind, owner.id, options.userId ?? null, ruleJson, tz, next, payloadJson, enabled, timestamp, timestamp);
  return getSchedule(id)!;
}

export function getSchedule(id: string): Schedule | null {
  const row = db.query("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | null;
  return row ? toSchedule(row) : null;
}

export function schedulesOf(owner: { kind: string; id: string }): Schedule[] {
  return (db.query("SELECT * FROM schedules WHERE owner_kind = ? AND owner_id = ? ORDER BY purpose").all(owner.kind, owner.id) as ScheduleRow[]).map(toSchedule);
}

/**
 * Removes the owner's schedules (one purpose, or all). Their fire history goes with them. Returns how many
 * schedules went. Counted with RETURNING: bun:sqlite's `.changes` also counts the cascaded schedule_fires rows.
 */
export function cancelSchedules(owner: { kind: string; id: string }, purpose?: string): number {
  return purpose
    ? db.query("DELETE FROM schedules WHERE owner_kind = ? AND owner_id = ? AND purpose = ? RETURNING id").all(owner.kind, owner.id, purpose).length
    : db.query("DELETE FROM schedules WHERE owner_kind = ? AND owner_id = ? RETURNING id").all(owner.kind, owner.id).length;
}

/** Pauses or resumes a schedule; resuming computes the next fire from now (missed occurrences are not replayed). */
export function setScheduleEnabled(owner: { kind: string; id: string }, purpose: string, enabled: boolean, nowMs = Date.now()) {
  const row = db.query("SELECT * FROM schedules WHERE owner_kind = ? AND owner_id = ? AND purpose = ?").get(owner.kind, owner.id, purpose) as ScheduleRow | null;
  if (!row) return false;
  const next = enabled ? nextFireIso(JSON.parse(row.rule_json) as ScheduleRule, row.tz, nowMs) : row.next_fire_at;
  db.query("UPDATE schedules SET enabled = ?, next_fire_at = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, next, now(), row.id);
  return true;
}

/** The next `count` fire instants as ISO strings (the UI's "Next: Mon 09:00, Tue 09:00"). */
export const nextFireTimes = (rule: ScheduleRule, tz: string, fromMs = Date.now(), count = 3) => nextFires(rule, tz, fromMs, count).map((ms) => new Date(ms).toISOString());
