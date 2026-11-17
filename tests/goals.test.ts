import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { krProgress, weightedProgress, suggestedHealth, elapsedFraction, checkinDue, formatKrValue } = await import("../shared/goals");
const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { refreshGoalSources, sweepAutoKrs, resetSweepForTests } = await import("../server/goals/service");
const { runScheduleTick } = await import("../server/schedules/dispatcher");
const { registerProgressSource } = await import("../server/goalsProgress");
const { purgeOwnedItem } = await import("../server/bin");
const { resetSearchRateLimit } = await import("../server/searchRoutes");
const { z } = await import("zod");

/**
 * Goals (lane GOALS, docs/plan/WORKSPACE_MODULES.md §D.3): progress math, the goal tree and roll-up,
 * the tasks source as the KR's owner (T540), check-ins and their access (T542), closing with carry-over,
 * the Bin and purge, search, datasets, Today, MCP tools, and a missing source.
 */

let owner: Session;
let member: Session;
let outsider: Session;
let viewer: Session;

const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, session);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json as any };
};

async function board(session: Session, name: string) {
  const created = await api(session, "POST", "/tasks/boards", { name });
  const columns = created.body.columns as Array<{ id: string; is_done: number; name: string }>;
  return { id: created.body.board.id as string, todo: columns[0]!.id, done: columns.find((column) => column.is_done === 1)!.id };
}
const card = async (session: Session, boardId: string, columnId: string, title: string) => (await api(session, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title })).body.card.id as string;

beforeAll(async () => {
  owner = await createUser("Goals owner");
  member = await createUser("Goals member");
  outsider = await createUser("Goals outsider");
  viewer = await createUser("Goals viewer");
  db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
});

describe("progress math (D901, D902)", () => {
  test("every metric and direction", () => {
    const base = { start_value: 0, target_value: 100, current_value: 25 };
    expect(krProgress({ ...base, metric: "number", direction: "increase" })).toBe(0.25);
    expect(krProgress({ metric: "number", direction: "decrease", start_value: 100, target_value: 20, current_value: 60 })).toBe(0.5);
    expect(krProgress({ metric: "number", direction: "decrease", start_value: 20, target_value: 100, current_value: 10 })).toBeCloseTo(0.125);
    expect(krProgress({ metric: "number", direction: "increase", start_value: 0, target_value: 10, current_value: 50 })).toBe(1);
    expect(krProgress({ metric: "number", direction: "increase", start_value: 10, target_value: 20, current_value: 0 })).toBe(0);
    expect(krProgress({ ...base, metric: "percent", direction: "stay_above", target_value: 20 })).toBe(1);
    expect(krProgress({ ...base, metric: "percent", direction: "stay_below", target_value: 20 })).toBe(0);
    expect(krProgress({ ...base, metric: "boolean", direction: "increase", current_value: 1 })).toBe(1);
    expect(krProgress({ ...base, metric: "milestones", direction: "increase", milestones: { done: 1, total: 4 } })).toBe(0.25);
    expect(krProgress({ ...base, metric: "milestones", direction: "increase", milestones: { done: 0, total: 0 } })).toBe(0);
    expect(krProgress({ metric: "currency", direction: "increase", start_value: 5, target_value: 5, current_value: 5 })).toBe(1);
    expect(weightedProgress([{ progress: 1, weight: 3 }, { progress: 0, weight: 1 }])).toBe(0.75);
    expect(weightedProgress([])).toBe(0);
  });

  test("suggested health against time, and check-ins due", () => {
    expect(elapsedFraction("2027-01-01", "2027-01-10", "2027-01-05")).toBeCloseTo(0.45, 1);
    expect(suggestedHealth(0.5, 0.55)).toBe("on_track");
    expect(suggestedHealth(0.3, 0.5)).toBe("at_risk");
    expect(suggestedHealth(0.1, 0.8)).toBe("off_track");
    expect(suggestedHealth(0, 0.01)).toBe("none");
    const created = "2027-01-01T00:00:00.000Z";
    expect(checkinDue("weekly", null, created, Date.parse("2027-01-09T00:00:00Z"))).toBe(true);
    expect(checkinDue("weekly", "2027-01-08T00:00:00.000Z", created, Date.parse("2027-01-09T00:00:00Z"))).toBe(false);
    expect(checkinDue("none", null, created, Date.parse("2028-01-01T00:00:00Z"))).toBe(false);
    expect(formatKrValue(1200, { metric: "currency", currency: "USD" })).toBe("$1,200");
    expect(formatKrValue(62, { metric: "percent" })).toBe("62%");
  });
});

describe("goals end to end", () => {
  let periodId: string;
  let nextPeriodId: string;
  let companyId: string;
  let teamGoalId: string;
  let boardId: string;
  let doneColumn: string;
  let todoColumn: string;
  let autoKr: string;
  let manualKr: string;

  test("periods, a company goal with a manual and a tasks KR, and a team sub-goal", async () => {
    const period = await api(owner, "POST", "/goal-periods", { name: "Q1 2027", startsOn: "2027-01-01", endsOn: "2027-03-31" });
    expect(period.status).toBe(201);
    periodId = period.body.period.id;
    nextPeriodId = (await api(owner, "POST", "/goal-periods", { name: "Q2 2027", startsOn: "2027-04-01", endsOn: "2027-06-30" })).body.period.id;
    expect((await api(owner, "POST", "/goal-periods", { name: "Bad", startsOn: "2027-04-01", endsOn: "2027-03-30" })).status).toBe(400);
    expect((await api(viewer, "POST", "/goal-periods", { name: "Viewer", startsOn: "2027-04-01", endsOn: "2027-06-30" })).status).toBe(403);

    const tasks = await board(owner, "Roadmap");
    boardId = tasks.id; doneColumn = tasks.done; todoColumn = tasks.todo;
    const cards = [await card(owner, boardId, todoColumn, "One"), await card(owner, boardId, todoColumn, "Two"), await card(owner, boardId, doneColumn, "Three"), await card(owner, boardId, todoColumn, "Four")];
    expect(cards).toHaveLength(4);

    const created = await api(owner, "POST", "/goals", {
      title: "Grow MRR 20%", periodId, keyResults: [
        { title: "MRR", metric: "currency", currency: "USD", startValue: 10000, targetValue: 12000, currentValue: 10500 },
        { title: "Ship the roadmap", source: { kind: "tasks", config: { scope: "board", id: boardId, measure: "cards" } } }
      ]
    });
    expect(created.status).toBe(201);
    const goal = created.body.goal;
    companyId = goal.id;
    expect(goal.href).toMatch(/^\/goals\/grow-mrr-20-[0-9a-z]{10}$/);
    manualKr = goal.keyResults[0].id;
    autoKr = goal.keyResults[1].id;
    expect(goal.keyResults[1].currentValue).toBe(1);
    expect(goal.keyResults[1].targetValue).toBe(4);
    expect(goal.keyResults[1].source.description).toBe("Done cards on Roadmap");
    expect(goal.progress).toBeCloseTo((0.25 + 0.25) / 2);

    const team = await api(member, "POST", "/goals", { title: "Team: close 30 deals", parentId: companyId, periodId, keyResults: [{ title: "Deals", targetValue: 30, currentValue: 15 }] });
    expect(team.status).toBe(201);
    teamGoalId = team.body.goal.id;
    // A board the KR owner cannot read is refused (T540).
    const refused = await api(member, "POST", `/goals/${teamGoalId}/key-results`, { title: "Sneaky", source: { kind: "tasks", config: { scope: "board", id: boardId } } });
    expect(refused.status).toBe(400);
    // Short id works as :id.
    const shortId = goal.shortId as string;
    expect((await api(member, "GET", `/goals/${shortId}`)).body.goal.id).toBe(companyId);
  });

  test("moving a card to done updates the tasks KR (debounced, then fresh)", async () => {
    const cards = db.query("SELECT id FROM cards WHERE board_id = ? AND title = 'One'").get(boardId) as { id: string };
    expect((await api(owner, "POST", `/tasks/cards/${cards.id}/move`, { columnId: doneColumn, afterCardId: null })).status).toBe(200);
    // Within the 60 s debounce the stored value stays; the sweep (or a stale read) updates it.
    expect((await api(owner, "GET", `/goals/${companyId}`)).body.goal.keyResults[1].currentValue).toBe(1);
    db.query("UPDATE key_results SET auto_updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(autoKr);
    const fresh = (await api(owner, "GET", `/goals/${companyId}`)).body.goal;
    expect(fresh.keyResults[1].currentValue).toBe(2);
    expect(fresh.progress).toBeCloseTo((0.25 + 0.5) / 2);
    const points = db.query("SELECT COUNT(*) AS count FROM kr_values WHERE kr_id = ? AND source = 'auto'").get(autoKr) as { count: number };
    expect(points.count).toBeGreaterThanOrEqual(1);
    // The sweep recomputes stale auto KRs too.
    db.query("UPDATE key_results SET auto_updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(autoKr);
    expect(await sweepAutoKrs()).toBe(0);
    expect((db.query("SELECT auto_updated_at FROM key_results WHERE id = ?").get(autoKr) as { auto_updated_at: string }).auto_updated_at > "2001").toBe(true);
  });

  test("the sweep schedule exists once and its handler runs", async () => {
    resetSweepForTests();
    await api(owner, "GET", "/goals");
    const rows = db.query("SELECT next_fire_at FROM schedules WHERE purpose = 'goals.sweep'").all() as Array<{ next_fire_at: string }>;
    expect(rows).toHaveLength(1);
    const counts = await runScheduleTick({ nowMs: Date.parse(rows[0]!.next_fire_at) + 1000 });
    expect(counts!.failed).toBe(0);
  });

  test("check-ins: edit needed (T542), values, health, history; contributors can check in", async () => {
    expect((await api(member, "POST", `/goals/${companyId}/checkins`, { health: "on_track" })).status).toBe(403);
    expect((await api(outsider, "POST", `/goals/${companyId}/checkins`, { health: "on_track" })).status).toBe(403);
    const checked = await api(owner, "POST", `/goals/${companyId}/checkins`, { health: "at_risk", confidence: 6, note: "Slower than hoped", values: { [manualKr]: 11000, [autoKr]: 999 } });
    expect(checked.status).toBe(201);
    expect(checked.body.goal.health).toBe("at_risk");
    expect(checked.body.goal.keyResults[0].currentValue).toBe(11000);
    // Auto KRs ignore typed values.
    expect(checked.body.goal.keyResults[1].currentValue).toBe(2);
    expect(checked.body.checkin.values).toEqual({ [manualKr]: 11000 });
    const history = await api(owner, "GET", `/goals/${companyId}/history`);
    expect(history.body.checkins).toHaveLength(1);
    expect(history.body.keyResults[0].points.length).toBeGreaterThanOrEqual(2);
    expect(history.body.ideal).toEqual({ start: "2027-01-01", end: "2027-03-31" });
    const list = await api(owner, "GET", `/goals/${companyId}/checkins`);
    expect(list.body.checkins[0].note).toBe("Slower than hoped");

    expect((await api(owner, "PATCH", `/goals/${companyId}`, { contributorIds: [member.userId] })).status).toBe(200);
    expect((await api(member, "POST", `/goals/${companyId}/checkins`, { health: "on_track", values: { [manualKr]: 11500 } })).status).toBe(201);
    // Viewers read but never write.
    expect((await api(viewer, "GET", `/goals/${companyId}`)).status).toBe(200);
    expect((await api(viewer, "POST", `/goals/${companyId}/checkins`, { health: "on_track" })).status).toBe(403);
  });

  test("tree and roll-up: hidden children are counted, not shown (§G.1 Q4)", async () => {
    const hidden = await api(outsider, "POST", "/goals", { title: "Secret sub-goal", parentId: companyId, periodId, visibility: "private", progressMode: "manual" });
    expect(hidden.status).toBe(201);
    const tree = await api(owner, "GET", `/goals?period=${periodId}`);
    const company = tree.body.goals.find((goal: { id: string }) => goal.id === companyId);
    expect(company.childCount).toBe(1);
    expect(company.hiddenChildCount).toBe(1);
    expect(tree.body.goals.some((goal: { title: string }) => goal.title === "Secret sub-goal")).toBe(false);
    const parentGoal = await api(owner, "POST", "/goals", { title: "Company umbrella", periodId, progressMode: "children" });
    await api(owner, "PATCH", `/goals/${companyId}`, { parentId: parentGoal.body.goal.id });
    const umbrella = (await api(owner, "GET", `/goals/${parentGoal.body.goal.id}`)).body.goal;
    const company2 = (await api(owner, "GET", `/goals/${companyId}`)).body.goal;
    expect(umbrella.progress).toBeCloseTo(company2.progress);
    // Cycles are refused.
    expect((await api(owner, "PATCH", `/goals/${parentGoal.body.goal.id}`, { parentId: companyId })).status).toBe(400);
    expect((await api(outsider, "GET", `/goals/${companyId}`)).status).toBe(200);
    expect((await api(owner, "GET", `/goals/${hidden.body.goal.id}`)).status).toBe(404);
  });

  test("work links: a card contributes to a goal and the card slot lists it", async () => {
    const cardId = (db.query("SELECT id FROM cards WHERE board_id = ? AND title = 'Two'").get(boardId) as { id: string }).id;
    const linked = await api(owner, "POST", "/links", { a: { kind: "card", id: cardId }, b: { kind: "goal", id: companyId }, relation: "contributes" });
    expect(linked.status).toBe(201);
    const slot = await api(owner, "GET", `/goals/for-item?kind=card&id=${cardId}`);
    expect(slot.body.goals.map((goal: { id: string }) => goal.id)).toEqual([companyId]);
    const work = await api(owner, "GET", `/goals/${companyId}/work`);
    expect(work.body.links[0].other.kind).toBe("card");
  });

  test("search, datasets, and Today", async () => {
    resetSearchRateLimit();
    const search = await api(owner, "GET", "/search?scope=goals&q=mrr");
    expect(search.body.results?.[0]?.title ?? search.body.sections?.[0]?.results?.[0]?.title).toBe("Grow MRR 20%");
    const outsiderSearch = await api(outsider, "GET", "/search?scope=goals&q=secret");
    expect(JSON.stringify(outsiderSearch.body)).toContain("Secret sub-goal");
    resetSearchRateLimit();
    expect(JSON.stringify((await api(owner, "GET", "/search?scope=goals&q=secret")).body)).not.toContain("Secret");
    const query = await api(owner, "POST", "/datasets/query", { dataset: "goals.key_results", measures: [{ fn: "avg", column: "progress" }], dimensions: ["goal"] });
    expect(query.status).toBe(200);
    expect(query.body.rows.some((row: unknown[]) => row[0] === "Secret sub-goal")).toBe(false);
    expect(query.body.rows.some((row: unknown[]) => row[0] === "Grow MRR 20%")).toBe(true);
    // This file's goal only: the suite shares one database, and other files' workspace goals are readable too.
    const checkins = await api(owner, "POST", "/datasets/query", { dataset: "goals.checkins", measures: [{ fn: "count" }], filters: [{ column: "goal_id", op: "eq", value: companyId }] });
    expect(checkins.body.rows[0][0]).toBe(2);
  });

  test("close with carry-over, reopen, and close a period", async () => {
    const closed = await api(member, "POST", `/goals/${teamGoalId}/close`, { state: "carried_over", carryOver: { periodId: nextPeriodId } });
    expect(closed.status).toBe(200);
    expect(closed.body.goal.state).toBe("carried_over");
    expect(closed.body.goal.finalProgress).toBe(0.5);
    const copy = closed.body.carriedOver;
    expect(copy.period.id).toBe(nextPeriodId);
    const copyDetail = (await api(member, "GET", `/goals/${copy.id}`)).body.goal;
    expect(copyDetail.keyResults[0].currentValue).toBe(15);
    expect((await api(member, "POST", `/goals/${teamGoalId}/checkins`, { health: "on_track" })).status).toBe(400);
    expect((await api(member, "POST", `/goals/${teamGoalId}/reopen`)).body.goal.state).toBe("active");
    const periodClose = await api(owner, "POST", `/goal-periods/${periodId}/close`, { carryOverTo: nextPeriodId });
    expect(periodClose.status).toBe(200);
    expect(periodClose.body.closed.skipped).toBeGreaterThanOrEqual(1);
  });

  test("KR delete has an undo ticket", async () => {
    const kr = await api(owner, "POST", `/goals/${companyId}/key-results`, { title: "Temp", metric: "boolean" });
    expect(kr.status).toBe(201);
    const removed = await api(owner, "DELETE", `/key-results/${kr.body.keyResult.id}`);
    expect(typeof removed.body.undoTicket).toBe("string");
    expect((await api(owner, "POST", `/undo/${removed.body.undoTicket}`)).status).toBe(200);
    expect(db.query("SELECT 1 FROM key_results WHERE id = ?").get(kr.body.keyResult.id)).not.toBeNull();
  });

  test("a source whose module is gone keeps its value and says so", async () => {
    const off = registerProgressSource("test_widgets", { label: "Widgets", module: "forms", configSchema: z.object({}), describe: () => "Widgets", compute: () => ({ value: 7, target: 10 }) });
    const goal = await api(owner, "POST", "/goals", { title: "Widget goal", keyResults: [{ title: "Widgets", source: { kind: "test_widgets", config: {} } }] });
    expect(goal.body.goal.keyResults[0].currentValue).toBe(7);
    off();
    db.query("UPDATE key_results SET auto_updated_at = '2000-01-01T00:00:00.000Z' WHERE goal_id = ?").run(goal.body.goal.id);
    await refreshGoalSources(goal.body.goal.id);
    const after = (await api(owner, "GET", `/goals/${goal.body.goal.id}`)).body.goal;
    expect(after.keyResults[0].currentValue).toBe(7);
    expect(after.keyResults[0].source.available).toBe(false);
    expect(after.keyResults[0].source.error).toMatch(/not available/);
    const notice = db.query("SELECT title FROM notifications WHERE user_id = ? AND topic = 'goals.source_failing'").get(owner.userId) as { title: string } | null;
    expect(notice?.title).toContain("Widget goal");
  });

  test("Bin and purge leave no orphans", async () => {
    const goal = await api(owner, "POST", "/goals", { title: "Doomed", keyResults: [{ title: "KR" }] });
    const id = goal.body.goal.id as string;
    await api(owner, "POST", `/goals/${id}/checkins`, { health: "on_track" });
    await api(owner, "POST", `/items/goal/${id}/comments`, { body: "Bye" });
    expect((await api(member, "DELETE", `/goals/${id}`)).status).toBe(403);
    expect((await api(outsider, "DELETE", `/goals/${id}`)).status).toBe(403);
    expect((await api(owner, "DELETE", `/goals/${id}`)).status).toBe(200);
    expect((await api(owner, "GET", `/goals/${id}`)).status).toBe(404);
    const bin = await api(owner, "GET", "/bin");
    expect(JSON.stringify(bin.body)).toContain("Doomed");
    expect(await purgeOwnedItem("goal", id, owner.userId)).toBe("purged");
    for (const [table, column] of [["key_results", "goal_id"], ["goal_checkins", "goal_id"], ["goals_fts", "goal_id"]] as const) {
      expect(db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(id)).toEqual({ count: 0 });
    }
    for (const table of ["item_activity", "item_comments"]) expect(db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE item_kind = 'goal' AND item_id = ?`).get(id)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM schedules WHERE owner_kind = 'goal' AND owner_id = ?").get(id)).toEqual({ count: 0 });
  });

  test("MCP: create with KRs, link a card, card done, get_goal, check in; scopes and chosen goals", async () => {
    const key = createApiKey(owner.userId, { name: "Goals key", surfaces: "both", grants: [{ module: "goals", permission: "write", resourceKind: null, resourceId: null }, { module: "tasks", permission: "write", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const call = async (name: string, args: Record<string, unknown>, keyId = key.id) => {
      const result = await invokeMcpToolForTests(name, args, keyId);
      return { error: result.isError === true, body: JSON.parse(result.content[0]!.text) };
    };
    const created = await call("create_goal", { title: "Agent goal", keyResults: [{ title: "Roadmap", source: { kind: "tasks", config: { scope: "board", id: boardId } } }] });
    expect(created.error).toBe(false);
    const id = created.body.id as string;
    const cardId = (db.query("SELECT id FROM cards WHERE board_id = ? AND title = 'Four'").get(boardId) as { id: string }).id;
    expect((await call("link_items", { a: { kind: "card", id: cardId }, b: { kind: "goal", id }, relation: "contributes" })).error).toBe(false);
    const before = (await call("get_goal", { goalId: id })).body;
    expect(before.linkedWork[0].item.kind).toBe("card");
    await api(owner, "POST", `/tasks/cards/${cardId}/move`, { columnId: doneColumn, afterCardId: null });
    db.query("UPDATE key_results SET auto_updated_at = '2000-01-01T00:00:00.000Z' WHERE goal_id = ?").run(id);
    const after = (await call("get_goal", { goalId: id })).body.goal;
    expect(after.keyResults[0].currentValue).toBe(before.goal.keyResults[0].currentValue + 1);
    const checked = await call("check_in_goal", { goalId: id, health: "on_track", confidence: 8, note: "Agent" });
    expect(checked.error).toBe(false);
    expect((await call("get_goal_tree", { periodId })).error).toBe(false);
    expect((await call("list_goal_sources", {})).body.sources.map((source: { kind: string }) => source.kind)).toContain("tasks");

    const readOnly = createApiKey(owner.userId, { name: "Goals read", surfaces: "both", grants: [{ module: "goals", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    expect((await call("check_in_goal", { goalId: id, health: "on_track" }, readOnly.id)).body.code).toBe("SCOPE_REQUIRED");
    const chosen = createApiKey(owner.userId, { name: "One goal", surfaces: "both", grants: [{ module: "goals", permission: "read", resourceKind: "goal", resourceId: id }], expiresInDays: 30 });
    expect((await call("get_goal", { goalId: id }, chosen.id)).error).toBe(false);
    expect((await call("get_goal", { goalId: companyId }, chosen.id)).body.code).toBe("NOT_FOUND");
    expect((await call("list_goals", {}, chosen.id)).body.items ?? (await call("list_goals", {}, chosen.id)).body.goals).toHaveLength(1);
    // Another person's private goal is NOT_FOUND through their own key too.
    const outsiderKey = createApiKey(outsider.userId, { name: "Outsider", surfaces: "both", grants: [{ module: "goals", permission: "write", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const privateGoal = await api(owner, "POST", "/goals", { title: "Mine only", visibility: "private" });
    expect((await call("get_goal", { goalId: privateGoal.body.goal.id }, outsiderKey.id)).body.code).toBe("NOT_FOUND");
  });
});
