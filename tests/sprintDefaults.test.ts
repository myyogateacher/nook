import { describe, expect, test } from "bun:test";
import { createUser, request, type Session } from "./support/harness";
import { MAX_LEVELS, LEVEL_NAME_MAX, TEMPLATES, validateStructure } from "../shared/boardStructure";
import { carryOverPlan, newSprintPlan, onOrAfterWeekday, sprintEndFor, sprintNameFromPattern, SPRINT_PATTERN_MAX } from "../shared/sprintPlan";

/** Board sprint defaults (operator 2026-09-27): stored in structure_json, bounded, and what a new sprint starts with. */

const BASE = { levels: [{ name: "Task", plural: "Tasks" }], workLevel: 0, sprints: true };
const plan = (name: string, state: "planned" | "active" | "completed", start_on: string | null, end_on: string | null, created_at = "2026-09-01") =>
  ({ name, state, start_on, end_on, position: 1024, created_at });

describe("validation", () => {
  test("sprint defaults are optional and bounded: days 1–60, a start rule, a pattern with one {n}", () => {
    expect(validateStructure(BASE)).toEqual({ ok: true, structure: BASE });
    expect(validateStructure({ ...BASE, sprintDefaults: null })).toEqual({ ok: true, structure: BASE });
    const ok = (sprintDefaults: unknown) => validateStructure({ ...BASE, sprintDefaults }).ok;
    expect(ok({ days: 1, start: "next" })).toBe(true);
    expect(ok({ days: 60, start: "mon", name: "Sprint {n}" })).toBe(true);
    expect(ok({ days: 14, start: "today", name: "  Iteration {n}  " })).toBe(true);
    expect(validateStructure({ ...BASE, sprintDefaults: { days: 14, start: "next", name: " Sprint {n} " } })).toMatchObject({ structure: { sprintDefaults: { name: "Sprint {n}" } } });
    for (const bad of [
      { days: 0, start: "next" }, { days: 61, start: "next" }, { days: 1.5, start: "next" }, { days: "14", start: "next" },
      { days: 14, start: "someday" }, { days: 14 }, { days: 14, start: "next", name: "Sprint" }, { days: 14, start: "next", name: "{n} and {n}" },
      { days: 14, start: "next", name: `${"x".repeat(SPRINT_PATTERN_MAX)}{n}` }, { days: 14, start: "next", name: "Sprint {n}‮" },
      { days: 14, start: "next", extra: true }, [14], "two weeks"
    ]) expect(ok(bad)).toBe(false);
  });

  test("the largest structure with defaults fits the 1024-character structure_json CHECK", () => {
    const name = "x".repeat(LEVEL_NAME_MAX);
    const largest = { levels: Array.from({ length: MAX_LEVELS }, () => ({ name, plural: name })), workLevel: 2, sprints: true,
      sprintDefaults: { days: 60, start: "next", name: `${"é".repeat(SPRINT_PATTERN_MAX - 3)}{n}` } };
    const checked = validateStructure(largest);
    expect(checked.ok).toBe(true);
    expect(JSON.stringify(checked.ok && checked.structure).length).toBeLessThan(1024);
  });

  test("the Scrum template sets two weeks, the day after the previous sprint, and Sprint {n}", () => {
    expect(TEMPLATES.scrum.structure.sprintDefaults).toEqual({ days: 14, start: "next", name: "Sprint {n}" });
    expect(validateStructure(TEMPLATES.scrum.structure).ok).toBe(true);
  });
});

describe("pre-fill", () => {
  test("a name pattern counts up from the board's highest number and skips taken names", () => {
    expect(sprintNameFromPattern("Sprint {n}")).toBe("Sprint 1");
    expect(sprintNameFromPattern("Sprint {n}", ["Sprint 1", "sprint 3", "Other 9"])).toBe("Sprint 4");
    expect(sprintNameFromPattern("{n}. Iteration", ["1. Iteration"])).toBe("2. Iteration");
    expect(sprintNameFromPattern("S{n} (web)", ["S2 (web)", "S3 (app)"])).toBe("S3 (web)");
  });

  test("duration → end date: start and end included", () => {
    expect(sprintEndFor("2026-09-28", 14)).toBe("2026-10-11");
    expect(sprintEndFor("2026-09-28", 7)).toBe("2026-10-04");
    expect(sprintEndFor("2026-09-28", 1)).toBe("2026-09-28");
    expect(onOrAfterWeekday("2026-09-27", "mon")).toBe("2026-09-28");
    expect(onOrAfterWeekday("2026-09-28", "mon")).toBe("2026-09-28");
    expect(onOrAfterWeekday("2026-09-27", "next")).toBe("2026-09-27");
  });

  test("New sprint follows the board's defaults: length, start rule, and name", () => {
    const defaults = { days: 21, start: "next" as const, name: "Sprint {n}" };
    const today = "2026-09-27";
    // No open sprint: from today.
    expect(newSprintPlan([], today, defaults)).toEqual({ name: "Sprint 1", startOn: today, endOn: "2026-10-17", days: 21 });
    // After the open one: the day after it ends.
    const open = [plan("Sprint 1", "active", "2026-09-21", "2026-10-04")];
    expect(newSprintPlan(open, today, defaults)).toEqual({ name: "Sprint 2", startOn: "2026-10-05", endOn: "2026-10-25", days: 21 });
    expect(newSprintPlan(open, today, { ...defaults, start: "today" })).toMatchObject({ startOn: today });
    expect(newSprintPlan(open, today, { ...defaults, start: "wed" })).toMatchObject({ startOn: "2026-10-07", endOn: "2026-10-27" });
    // Without defaults: the older rule (as long as the latest, named after it).
    expect(newSprintPlan(open, today, null)).toEqual({ name: "Sprint 2", startOn: "2026-10-05", endOn: "2026-10-18", days: 14 });
  });

  test("the close dialog's new sprint uses the default length and pattern", () => {
    const sprint = { name: "Iteration 4", start_on: "2026-09-21", end_on: "2026-09-27" };
    expect(carryOverPlan(sprint, "2026-09-25", ["Iteration 4"], null)).toEqual({ name: "Iteration 5", startOn: "2026-09-25", endOn: "2026-10-01" });
    expect(carryOverPlan(sprint, "2026-09-25", ["Iteration 4", "Sprint 2"], { days: 14, start: "next", name: "Sprint {n}" }))
      .toEqual({ name: "Sprint 3", startOn: "2026-09-25", endOn: "2026-10-08" });
    expect(carryOverPlan(sprint, "2026-09-27", [], { days: 7, start: "mon" })).toEqual({ name: "Iteration 5", startOn: "2026-09-28", endOn: "2026-10-04" });
  });
});

async function call(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

describe("the API", () => {
  test("PATCH /boards/:b stores sprint defaults, keeps them when a structure omits them, clears them with null, and refuses bad ones", async () => {
    const owner = await createUser("Sprint defaults owner");
    const created = await call(owner, "POST", "/boards", { name: "Defaults", template: "scrum" });
    const boardId = created.body.board.id as string;
    expect(created.body.board.structure.sprintDefaults).toEqual({ days: 14, start: "next", name: "Sprint {n}" });
    const set = await call(owner, "PATCH", `/boards/${boardId}`, { structure: { ...TEMPLATES.scrum.structure, sprintDefaults: { days: 21, start: "mon", name: "Iteration {n}" } } });
    expect(set.status).toBe(200);
    expect(set.body.board.structure.sprintDefaults).toEqual({ days: 21, start: "mon", name: "Iteration {n}" });
    // A structure save without the key (Board settings → Save structure) leaves them.
    const { sprintDefaults: _omit, ...levels } = TEMPLATES.scrum.structure;
    const kept = await call(owner, "PATCH", `/boards/${boardId}`, { structure: levels });
    expect(kept.body.board.structure.sprintDefaults).toEqual({ days: 21, start: "mon", name: "Iteration {n}" });
    expect((await call(owner, "PATCH", `/boards/${boardId}`, { structure: { ...levels, sprintDefaults: { days: 90, start: "next" } } })).status).toBe(400);
    const cleared = await call(owner, "PATCH", `/boards/${boardId}`, { structure: { ...levels, sprintDefaults: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.board.structure.sprintDefaults).toBeUndefined();

    // Completing into a new sprint without a name or dates follows the defaults.
    expect((await call(owner, "PATCH", `/boards/${boardId}`, { structure: { ...levels, sprintDefaults: { days: 7, start: "next", name: "Week {n}" } } })).status).toBe(200);
    const sprints = (await call(owner, "GET", `/boards/${boardId}`)).body.sprints as Array<{ id: string }>;
    expect((await call(owner, "PATCH", `/sprints/${sprints[0]!.id}`, { state: "active" })).status).toBe(200);
    const done = await call(owner, "POST", `/sprints/${sprints[0]!.id}/complete`, { carryTo: "new" });
    expect(done.status).toBe(200);
    // Sprint 1 (two weeks from today) completes early, so Week 1 starts today and lasts 7 days.
    const today = new Date().toISOString().slice(0, 10);
    expect(done.body.target).toMatchObject({ name: "Week 1", start_on: today, end_on: sprintEndFor(today, 7) });
  });
});
