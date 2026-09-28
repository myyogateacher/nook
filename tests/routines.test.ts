import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { cadenceText, dueAfterRun, initialDueAt, latestSlotAtOrBefore, nextSlotAfter, resumedDueAt, scheduleProblem, type RoutineSchedule } from "../shared/routineSchedule";

const { createMcpApiKey } = await import("../server/mcp");
const { setRole } = await import("../server/team/service");
const { ROUTINE_LIMIT, setRoutineEnabled } = await import("../server/inbox/routines");

/**
 * Routines (docs/plan/research/2026-09-28-agent-inbox-routines.md §5.1, §8, §13 Wave B, D152,
 * D153): the schedule arithmetic, and CRUD over /api/inbox/routines.
 */

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => ms === null ? null : new Date(ms).toISOString();

describe("routine schedules (D153)", () => {
  test("daily, weekdays, and weekly slots in a zone", () => {
    const daily: RoutineSchedule = { cadence: "daily", atTime: "08:00", weekday: null, tz: "Europe/London" };
    // 2026-09-28 is a Monday; London is on BST (UTC+1).
    expect(iso(nextSlotAfter(daily, at("2026-09-28T06:00:00Z")))).toBe("2026-09-28T07:00:00.000Z");
    expect(iso(nextSlotAfter(daily, at("2026-09-28T07:00:00Z")))).toBe("2026-09-29T07:00:00.000Z");
    expect(iso(latestSlotAtOrBefore(daily, at("2026-09-28T06:00:00Z")))).toBe("2026-09-27T07:00:00.000Z");
    const weekdays: RoutineSchedule = { cadence: "weekdays", atTime: "09:30", weekday: null, tz: "America/New_York" };
    // Friday 2 Oct 2026 after the slot: next is Monday 5 Oct, 09:30 EDT (13:30Z).
    expect(iso(nextSlotAfter(weekdays, at("2026-10-02T15:00:00Z")))).toBe("2026-10-05T13:30:00.000Z");
    const weekly: RoutineSchedule = { cadence: "weekly", atTime: "08:00", weekday: 1, tz: "UTC" };
    expect(iso(nextSlotAfter(weekly, at("2026-09-29T00:00:00Z")))).toBe("2026-10-05T08:00:00.000Z");
    expect(iso(latestSlotAtOrBefore(weekly, at("2026-09-29T00:00:00Z")))).toBe("2026-09-28T08:00:00.000Z");
  });

  test("DST: London and New York keep the wall time across the change", () => {
    const london: RoutineSchedule = { cadence: "daily", atTime: "08:00", weekday: null, tz: "Europe/London" };
    // BST ends on Sunday 25 Oct 2026.
    expect(iso(nextSlotAfter(london, at("2026-10-24T08:00:00Z")))).toBe("2026-10-25T08:00:00.000Z");
    expect(iso(nextSlotAfter(london, at("2026-10-24T06:00:00Z")))).toBe("2026-10-24T07:00:00.000Z");
    const newYork: RoutineSchedule = { cadence: "daily", atTime: "02:30", weekday: null, tz: "America/New_York" };
    // 8 Mar 2026: 02:30 does not exist in New York; it moves forward by the gap to 03:30 EDT (07:30Z).
    expect(iso(nextSlotAfter(newYork, at("2026-03-08T00:00:00Z")))).toBe("2026-03-08T07:30:00.000Z");
  });

  test("UTC+14 and UTC-12, and hourly slots in a half-hour zone", () => {
    const kiritimati: RoutineSchedule = { cadence: "daily", atTime: "00:00", weekday: null, tz: "Pacific/Kiritimati" };
    expect(iso(nextSlotAfter(kiritimati, at("2026-09-28T09:00:00Z")))).toBe("2026-09-28T10:00:00.000Z");
    const minus12: RoutineSchedule = { cadence: "daily", atTime: "23:00", weekday: null, tz: "Etc/GMT+12" };
    expect(iso(nextSlotAfter(minus12, at("2026-09-28T09:00:00Z")))).toBe("2026-09-28T11:00:00.000Z");
    const hourly: RoutineSchedule = { cadence: "hourly", atTime: "00:15", weekday: null, tz: "Asia/Kolkata" };
    // Kolkata is UTC+5:30, so :15 local is :45 UTC.
    expect(iso(nextSlotAfter(hourly, at("2026-09-28T09:50:00Z")))).toBe("2026-09-28T10:45:00.000Z");
  });

  test("manual is never due; a missed slot does not pile up; a late run does not drift", () => {
    expect(initialDueAt({ cadence: "manual", atTime: null, weekday: null, tz: "UTC" }, Date.now())).toBeNull();
    const daily: RoutineSchedule = { cadence: "daily", atTime: "08:00", weekday: null, tz: "UTC" };
    // Created at 10:00: due since today's 08:00, not yesterday's.
    expect(initialDueAt(daily, at("2026-09-28T10:00:00Z"))).toBe("2026-09-28T08:00:00.000Z");
    // A run for Monday's slot that finishes on Thursday leaves the routine due once, on Friday 08:00.
    expect(dueAfterRun(daily, at("2026-09-28T08:00:00Z"), at("2026-10-01T09:00:00Z"))).toBe("2026-10-02T08:00:00.000Z");
    // A run for the 08:00 slot finishing at 08:40 advances to tomorrow 08:00, not 08:40.
    expect(dueAfterRun(daily, at("2026-09-28T08:00:00Z"), at("2026-09-28T08:40:00Z"))).toBe("2026-09-29T08:00:00.000Z");
  });

  test("resuming never makes a slot that already ran due again (Friction 5)", () => {
    const daily: RoutineSchedule = { cadence: "daily", atTime: "08:00", weekday: null, tz: "UTC" };
    const now = at("2026-09-28T15:00:00Z");
    // Today's 08:00 ran: the next slot is tomorrow's.
    expect(resumedDueAt(daily, now, at("2026-09-28T08:00:00Z"))).toBe("2026-09-29T08:00:00.000Z");
    // The last run was yesterday's slot (or none): today's slot is due now, as for a new routine.
    expect(resumedDueAt(daily, now, at("2026-09-27T08:00:00Z"))).toBe("2026-09-28T08:00:00.000Z");
    expect(resumedDueAt(daily, now, null)).toBe(initialDueAt(daily, now));
    expect(resumedDueAt({ ...daily, cadence: "manual", atTime: null }, now, at("2026-09-28T08:00:00Z"))).toBeNull();
  });

  test("validation and copy", () => {
    expect(scheduleProblem({ cadence: "daily", atTime: "25:00", weekday: null, tz: "UTC" })).toBeTruthy();
    expect(scheduleProblem({ cadence: "weekly", atTime: "08:00", weekday: null, tz: "UTC" })).toBeTruthy();
    expect(scheduleProblem({ cadence: "weekly", atTime: "08:00", weekday: 1, tz: "UTC" })).toBeNull();
    expect(cadenceText({ cadence: "weekly", atTime: "08:00", weekday: 1 })).toBe("Mondays at 08:00");
    expect(cadenceText({ cadence: "hourly", atTime: "00:15", weekday: null })).toBe("Hourly at :15");
    expect(cadenceText({ cadence: "manual", atTime: null, weekday: null })).toBe("Manual only");
  });
});

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

const routine = (overrides: Record<string, unknown> = {}) => ({
  name: "Weekly review", instructions: "Look at my boards and suggest cleanups.", outputKinds: ["card_create", "card_update"],
  cadence: "daily", atTime: "08:00", tz: "Europe/London", ...overrides
});

describe("/api/inbox/routines", () => {
  test("create, read, update with revision CAS, pause, resume, delete", async () => {
    const owner = await createUser("Routine owner");
    const created = await api(owner, "POST", "/inbox/routines", routine({ scheduleNote: "after stand-up" }));
    expect(created.status).toBe(200);
    const view = created.body.routine;
    expect(view).toMatchObject({ name: "Weekly review", outputKinds: ["card_create", "card_update"], cadence: "daily", atTime: "08:00", weekday: null, enabled: true, revision: 1, maxProposals: 25, expireDays: 14, scheduleText: "Daily at 08:00", due: true, running: null });
    expect(view.nextDueAt).not.toBeNull();

    expect((await api(owner, "GET", "/inbox/routines")).body.routines.map((item: { id: string }) => item.id)).toEqual([view.id]);
    const stale = await api(owner, "PATCH", `/inbox/routines/${view.id}`, { revision: 7, name: "Other" });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("ROUTINE_CHANGED");
    const updated = await api(owner, "PATCH", `/inbox/routines/${view.id}`, { revision: 1, cadence: "weekly", weekday: 1, maxProposals: 5 });
    expect(updated.status).toBe(200);
    expect(updated.body.routine).toMatchObject({ cadence: "weekly", weekday: 1, maxProposals: 5, revision: 2, scheduleText: "Mondays at 08:00", name: "Weekly review" });

    const paused = await api(owner, "POST", `/inbox/routines/${view.id}/pause`);
    expect(paused.body.routine).toMatchObject({ enabled: false, due: false, revision: 3 });
    const resumed = await api(owner, "POST", `/inbox/routines/${view.id}/resume`);
    expect(resumed.body.routine).toMatchObject({ enabled: true, revision: 4 });

    expect((await api(owner, "GET", `/inbox/routines/${view.id}/runs`)).body.runs).toEqual([]);
    expect((await api(owner, "DELETE", `/inbox/routines/${view.id}`)).body).toEqual({ deleted: true });
    expect((await api(owner, "GET", `/inbox/routines/${view.id}`)).status).toBe(404);
  });

  test("pause, then resume after today's run: the routine is not due again until the next slot (Friction 5)", async () => {
    const owner = await createUser("Routine resume");
    const created = await api(owner, "POST", "/inbox/routines", routine({ name: "Resume check", cadence: "daily", atTime: "08:00", tz: "UTC" }));
    const id = created.body.routine.id as string;
    const now = at("2026-09-28T15:00:00Z");
    db.query(`INSERT INTO routine_runs (id, routine_id, owner_id, status, slot_at, started_at, lease_expires_at, finished_at)
      VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?)`).run(crypto.randomUUID(), id, owner.userId, "2026-09-28T08:00:00.000Z", "2026-09-28T08:05:00.000Z", "2026-09-28T10:05:00.000Z", "2026-09-28T08:10:00.000Z");
    expect(setRoutineEnabled(owner.userId, id, false, now).routine.enabled).toBe(false);
    const resumed = setRoutineEnabled(owner.userId, id, true, now).routine;
    expect(resumed).toMatchObject({ enabled: true, due: false, nextDueAt: "2026-09-29T08:00:00.000Z" });
    // An abandoned run leaves its slot due (D154).
    db.query("UPDATE routine_runs SET status = 'abandoned' WHERE routine_id = ?").run(id);
    setRoutineEnabled(owner.userId, id, false, now);
    expect(setRoutineEnabled(owner.userId, id, true, now).routine).toMatchObject({ due: true, nextDueAt: "2026-09-28T08:00:00.000Z" });
  });

  test("names are unique per owner, case-folded; other owners get 404", async () => {
    const owner = await createUser("Routine names");
    const other = await createUser("Routine stranger");
    const first = (await api(owner, "POST", "/inbox/routines", routine({ name: "Inbox zero" }))).body.routine;
    const clash = await api(owner, "POST", "/inbox/routines", routine({ name: "INBOX ZERO" }));
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("NAME_TAKEN");
    expect((await api(other, "POST", "/inbox/routines", routine({ name: "Inbox zero" }))).status).toBe(200);
    for (const [method, path] of [["GET", `/inbox/routines/${first.id}`], ["PATCH", `/inbox/routines/${first.id}`], ["DELETE", `/inbox/routines/${first.id}`], ["POST", `/inbox/routines/${first.id}/pause`], ["GET", `/inbox/routines/${first.id}/runs`]] as const) {
      expect({ method, path, status: (await api(other, method, path, method === "PATCH" ? { revision: 1 } : undefined)).status }).toEqual({ method, path, status: 404 });
    }
  });

  test("validation: schedule, zone, kinds, lengths, and an own live key", async () => {
    const owner = await createUser("Routine validation");
    const other = await createUser("Routine key stranger");
    expect((await api(owner, "POST", "/inbox/routines", routine({ cadence: "weekly" }))).body.code).toBe("INVALID_SCHEDULE");
    expect((await api(owner, "POST", "/inbox/routines", routine({ atTime: "8am" }))).body.code).toBe("INVALID_SCHEDULE");
    expect((await api(owner, "POST", "/inbox/routines", routine({ tz: "Mars/Olympus" }))).body.code).toBe("INVALID_TIME_ZONE");
    expect((await api(owner, "POST", "/inbox/routines", routine({ outputKinds: [] }))).status).toBe(400);
    expect((await api(owner, "POST", "/inbox/routines", routine({ outputKinds: ["card_delete"] }))).status).toBe(400);
    expect((await api(owner, "POST", "/inbox/routines", routine({ name: "  " }))).status).toBe(400);
    expect((await api(owner, "POST", "/inbox/routines", routine({ maxProposals: 101 }))).status).toBe(400);
    expect((await api(owner, "POST", "/inbox/routines", routine({ instructions: "x".repeat(16_385) }))).status).toBe(400);
    const strangerKey = createMcpApiKey(other.userId, "theirs", ["inbox:write"]);
    expect((await api(owner, "POST", "/inbox/routines", routine({ keyId: strangerKey.id }))).body.code).toBe("KEY_NOT_FOUND");
    const ownKey = createMcpApiKey(owner.userId, "cron-box", ["inbox:write"]);
    const bound = await api(owner, "POST", "/inbox/routines", routine({ keyId: ownKey.id, cadence: "manual" }));
    expect(bound.body.routine).toMatchObject({ keyId: ownKey.id, keyName: "cron-box", keyRevoked: false, cadence: "manual", atTime: null, nextDueAt: null, due: false });
  });

  test("target pins must be readable by the owner (404 per id)", async () => {
    const owner = await createUser("Routine pins");
    const other = await createUser("Routine pins stranger");
    const own = (await (await request("/tasks/boards", { method: "POST", body: JSON.stringify({ name: "Mine" }) }, owner)).json() as { board: { id: string } }).board.id;
    const theirs = (await (await request("/tasks/boards", { method: "POST", body: JSON.stringify({ name: "Theirs" }) }, other)).json() as { board: { id: string } }).board.id;
    const refused = await api(owner, "POST", "/inbox/routines", routine({ targets: { boardIds: [own, theirs] } }));
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({ code: "NOT_FOUND", id: theirs });
    const saved = await api(owner, "POST", "/inbox/routines", routine({ targets: { boardIds: [own, own.toUpperCase()], calendarIds: [] } }));
    expect(saved.body.routine.targets).toEqual({ boardIds: [own] });
  });

  test("at most 50 routines per user", async () => {
    const owner = await createUser("Routine cap");
    for (let index = 0; index < ROUTINE_LIMIT; index += 1) {
      expect((await api(owner, "POST", "/inbox/routines", routine({ name: `Routine ${index}`, cadence: "manual" }))).status).toBe(200);
    }
    const over = await api(owner, "POST", "/inbox/routines", routine({ name: "One too many" }));
    expect(over.status).toBe(400);
    expect(over.body.code).toBe("LIMIT_REACHED");
  });

  test("read-only roles cannot create routines; a demotion pauses them (D152); guests get 404", async () => {
    const owner = await createUser("Routine demoted");
    const id = (await api(owner, "POST", "/inbox/routines", routine())).body.routine.id;
    setRole(null, owner.userId, { role: "viewer", expectedRole: "member" }, { via: "cli" });
    expect((db.query("SELECT enabled FROM routines WHERE id = ?").get(id) as { enabled: number }).enabled).toBe(0);
    const refused = await api(owner, "POST", "/inbox/routines", routine({ name: "Viewer routine" }));
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("ROLE_READ_ONLY");
    expect((await api(owner, "GET", "/inbox/routines")).status).toBe(200);
    setRole(null, owner.userId, { role: "guest", expectedRole: "viewer" }, { via: "cli" });
    expect((await api(owner, "GET", "/inbox/routines")).status).toBe(404);
  });
});
