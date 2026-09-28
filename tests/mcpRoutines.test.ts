import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { createMcpApiKey } = await import("../server/mcp");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { LEASE_MS, sweepRuns } = await import("../server/inbox/routines");
const { runSweep } = await import("../server/sweeper");
type McpScope = import("../server/mcpScopes").McpScope;

/**
 * Routine runs over MCP (docs/plan/research/2026-09-28-agent-inbox-routines.md §5.2, §7.2, §13
 * Wave B, D154, D155, D159, D160, T128, T131, T134): due lists, leases, kinds, pins, caps, the
 * finish, the abandon sweep, the server-side tool-call count, and routines as prompts.
 */

beforeEach(() => resetMcpLimits());

type Key = { id: string; token: string };
const makeKey = (session: Session, scopes: McpScope[], name = "cron-box"): Key => {
  const key = createMcpApiKey(session.userId, name, scopes);
  return { id: key.id, token: key.token };
};

let rpcId = 0;
async function rpc(key: Key, method: string, params: unknown = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return JSON.parse(json) as { result?: Record<string, any>; error?: { message: string } };
}
async function call(key: Key, name: string, args: Record<string, unknown> = {}) {
  const body = await rpc(key, "tools/call", { name, arguments: args });
  if (body.error) return { isError: true, value: { error: body.error.message } as Record<string, any> };
  return { isError: body.result!.isError === true, value: JSON.parse(body.result!.content[0].text) as Record<string, any> };
}

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

async function board(owner: Session, name = "Agent board") {
  const response = await request("/tasks/boards", { method: "POST", body: JSON.stringify({ name }) }, owner);
  const body = await response.json() as { board: { id: string }; columns: Array<{ id: string }> };
  return { boardId: body.board.id, columnId: body.columns[0]!.id };
}

async function createRoutine(owner: Session, overrides: Record<string, unknown> = {}) {
  const result = await api(owner, "POST", "/inbox/routines", {
    name: `Routine ${crypto.randomUUID().slice(0, 6)}`, instructions: "Suggest a card for anything overdue.", outputKinds: ["card_create"],
    cadence: "daily", atTime: "08:00", tz: "UTC", ...overrides
  });
  expect(result.status).toBe(200);
  return result.body.routine as Record<string, any>;
}

const card = (target: { boardId: string; columnId: string }, title = "Buy filters") => ({ kind: "card_create", title, payload: { ...target, title } });

describe("routine runs over MCP", () => {
  test("the four-call loop: list_due_routines, start_run, submit_proposals, finish_run", async () => {
    const owner = await createUser("Run loop");
    const target = await board(owner);
    const key = makeKey(owner, ["inbox:write", "tasks:read"]);
    const routine = await createRoutine(owner, { name: "Daily sweep", keyId: key.id });

    const due = await call(key, "list_due_routines");
    expect(due.isError).toBe(false);
    expect(due.value.routines).toEqual([expect.objectContaining({ routineId: routine.id, name: "Daily sweep", runsAvailable: true, schedule: "Daily at 08:00" })]);

    const started = await call(key, "start_run", { routineId: routine.id, clientLabel: "cron on laptop" });
    expect(started.isError).toBe(false);
    expect(started.value.routine).toMatchObject({ routineId: routine.id, instructions: "Suggest a card for anything overdue.", outputKinds: ["card_create"], maxProposals: 25 });
    expect(started.value.protocol).toContain("start_run");
    expect(Date.parse(started.value.leaseExpiresAt) - Date.now()).toBeGreaterThan(LEASE_MS - 60_000);
    const runId = started.value.runId as string;
    expect((await call(key, "list_due_routines")).value.routines[0].runsAvailable).toBe(false);

    const submitted = await call(key, "submit_proposals", { runId, proposals: [card(target, "One"), card(target, "Two")] });
    expect(submitted.value).toMatchObject({ submitted: 2, runId });
    // In a run, the bell waits for finish_run (one entry per run, D159).
    expect((db.query("SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND kind = 'proposals'").get(owner.userId) as { count: number }).count).toBe(0);

    const finished = await call(key, "finish_run", { runId, status: "succeeded", summary: "Two overdue items found." });
    expect(finished.isError).toBe(false);
    expect(finished.value).toMatchObject({ runId, status: "succeeded", proposals: 2, capped: false });
    // Counted by Nook: list_due_routines, submit_proposals, and finish_run (start_run ran before the run existed).
    expect(finished.value.toolCalls).toBe(3);
    expect(Date.parse(finished.value.nextDueAt)).toBeGreaterThan(Date.now());
    expect((await call(key, "list_due_routines")).value.routines).toEqual([]);

    // The inbox groups the proposals under the routine and run.
    const inbox = await api(owner, "GET", "/inbox/proposals");
    const group = inbox.body.groups.find((item: Record<string, any>) => item.run?.id === runId);
    expect(group.routine).toEqual({ id: routine.id, name: "Daily sweep" });
    expect(group.run).toMatchObject({ summary: "Two overdue items found.", status: "succeeded", capped: false });
    expect(group.items.map((item: { title: string }) => item.title)).toEqual(["One", "Two"]);

    // One notification per run, titled from the routine name.
    const bell = await api(owner, "GET", "/notifications");
    expect(bell.body.items.find((item: { title: string }) => item.title === "Daily sweep suggested 2 changes")).toBeTruthy();

    // Runs over HTTP, owner only.
    const runs = await api(owner, "GET", `/inbox/routines/${routine.id}/runs`);
    expect(runs.body.runs).toEqual([expect.objectContaining({ id: runId, status: "succeeded", proposals: 2, toolCalls: 3, clientLabel: "cron on laptop", keyName: "cron-box", summary: "Two overdue items found." })]);
    const detail = await api(owner, "GET", `/inbox/runs/${runId}`);
    expect(detail.body.run.routineName).toBe("Daily sweep");
    expect(detail.body.proposals).toHaveLength(2);
    const stranger = await createUser("Run stranger");
    expect((await api(stranger, "GET", `/inbox/runs/${runId}`)).status).toBe(404);

    // Approving works as usual; bulk by run applies both.
    const bulk = await api(owner, "POST", "/inbox/proposals/bulk", { action: "approve", runId });
    expect(bulk.body.results.map((result: { status: string }) => result.status)).toEqual(["applied", "applied"]);
  });

  test("visibility: a bound routine is invisible to other keys (T131); paused ones are not due", async () => {
    const owner = await createUser("Run visibility");
    const bound = makeKey(owner, ["inbox:write"], "bound");
    const other = makeKey(owner, ["inbox:write"], "other");
    const mine = await createRoutine(owner, { keyId: bound.id });
    const any = await createRoutine(owner);
    const paused = await createRoutine(owner, { enabled: false });
    const ids = (value: Record<string, any>) => value.routines.map((item: { routineId: string }) => item.routineId).sort();
    expect(ids((await call(bound, "list_due_routines")).value)).toEqual([mine.id, any.id].sort());
    expect(ids((await call(other, "list_due_routines")).value)).toEqual([any.id]);
    expect(ids((await call(other, "list_routines")).value)).toEqual([any.id, paused.id].sort());
    expect((await call(other, "start_run", { routineId: mine.id })).value.code).toBe("NOT_FOUND");
    expect((await call(bound, "start_run", { routineId: paused.id })).value.code).toBe("NOT_FOUND");
    const readOnly = makeKey(owner, ["inbox:read"], "reader");
    // start_run is not even registered for a key without inbox:write.
    expect((await call(readOnly, "start_run", { routineId: any.id })).isError).toBe(true);
    expect(db.query("SELECT 1 FROM routine_runs WHERE routine_id = ?").get(any.id)).toBeNull();
  });

  test("one run per routine (RUN_ACTIVE); finish only by the starting key; a finished run is closed", async () => {
    const owner = await createUser("Run lease");
    const first = makeKey(owner, ["inbox:write"], "first");
    const second = makeKey(owner, ["inbox:write"], "second");
    const routine = await createRoutine(owner);
    const runId = (await call(first, "start_run", { routineId: routine.id })).value.runId;
    expect((await call(second, "start_run", { routineId: routine.id })).value.code).toBe("RUN_ACTIVE");
    expect((await call(second, "finish_run", { runId, status: "succeeded" })).value.code).toBe("NOT_FOUND");
    expect((await call(second, "submit_proposals", { runId, proposals: [{ kind: "card_create", title: "x", payload: {} }] })).value.code).toBe("NOT_FOUND");
    expect((await call(first, "finish_run", { runId, status: "failed", error: "model timeout" })).value.status).toBe("failed");
    expect((await call(first, "finish_run", { runId, status: "succeeded" })).value.code).toBe("INVALID");
    const view = (await api(owner, "GET", `/inbox/routines/${routine.id}`)).body.routine;
    expect(view).toMatchObject({ lastRunStatus: "failed", running: null });
  });

  test("kinds, pins, and the per-run cap are enforced (T128, D155)", async () => {
    const owner = await createUser("Run limits");
    const pinned = await board(owner, "Pinned");
    const elsewhere = await board(owner, "Elsewhere");
    const key = makeKey(owner, ["inbox:write", "tasks:read", "calendar:read"]);
    const routine = await createRoutine(owner, { targets: { boardIds: [pinned.boardId] }, maxProposals: 2 });
    const runId = (await call(key, "start_run", { routineId: routine.id })).value.runId;
    const result = await call(key, "submit_proposals", {
      runId,
      proposals: [
        { kind: "event_create", title: "Not allowed", payload: {} },
        card(elsewhere, "Wrong board"),
        card(pinned, "First"),
        card(pinned, "Second"),
        card(pinned, "Over the cap")
      ]
    });
    expect(result.value.results.map((item: Record<string, string>) => item.status ?? item.code)).toEqual(["KIND_NOT_ALLOWED", "TARGET_NOT_ALLOWED", "pending", "pending", "LIMIT_REACHED"]);
    expect(result.value.submitted).toBe(2);
    const finished = await call(key, "finish_run", { runId, status: "succeeded" });
    expect(finished.value).toMatchObject({ proposals: 2, capped: true });
    expect((db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id IN (?, ?)").get(pinned.boardId, elsewhere.boardId) as { count: number }).count).toBe(0);
  });

  test("a note draft pinned to a folder is checked before the draft is written", async () => {
    const owner = await createUser("Run note pins");
    const folder = (await (await request("/folders", { method: "POST", body: JSON.stringify({ name: "Agent notes", parentId: null }) }, owner)).json() as { folder: { id: string } }).folder.id;
    const key = makeKey(owner, ["inbox:write", "notes:write-draft"]);
    const routine = await createRoutine(owner, { outputKinds: ["note_draft"], targets: { folderIds: [folder] }, expireDays: 3 });
    const runId = (await call(key, "start_run", { routineId: routine.id })).value.runId;
    const before = (db.query("SELECT COUNT(*) AS count FROM notes WHERE owner_id = ?").get(owner.userId) as { count: number }).count;
    const results = (await call(key, "submit_proposals", { runId, proposals: [
      { kind: "note_draft", title: "Default folder", payload: { markdown: "# Nope", mode: "replace", baseRevision: 0 } },
      { kind: "note_draft", title: "Pinned folder", payload: { folderId: folder, markdown: "# Yes", mode: "replace", baseRevision: 0 } }
    ] })).value.results;
    expect(results[0].code).toBe("TARGET_NOT_ALLOWED");
    expect(results[1].status).toBe("pending");
    expect((db.query("SELECT COUNT(*) AS count FROM notes WHERE owner_id = ?").get(owner.userId) as { count: number }).count).toBe(before + 1);
    const row = db.query("SELECT run_id, routine_id, created_at, expires_at FROM proposals WHERE id = ?").get(results[1].proposalId) as { run_id: string; routine_id: string; created_at: string; expires_at: string };
    expect(row).toMatchObject({ run_id: runId, routine_id: routine.id });
    // The routine's own expiry (3 days) applies.
    expect(Math.round((Date.parse(row.expires_at) - Date.now()) / 86_400_000)).toBe(3);
  });

  test("the sweeper abandons a run after its lease; the routine stays due; proposals stay pending", async () => {
    const owner = await createUser("Run abandon");
    const target = await board(owner);
    const key = makeKey(owner, ["inbox:write", "tasks:read"]);
    const routine = await createRoutine(owner);
    const dueBefore = (await api(owner, "GET", `/inbox/routines/${routine.id}`)).body.routine.nextDueAt;
    const runId = (await call(key, "start_run", { routineId: routine.id })).value.runId;
    await call(key, "submit_proposals", { runId, proposals: [card(target, "Left behind")] });
    await runSweep({ nowMs: Date.now() + LEASE_MS + 1000 });
    const run = db.query("SELECT status, finished_at, lease_expires_at FROM routine_runs WHERE id = ?").get(runId) as { status: string; finished_at: string; lease_expires_at: string };
    expect(run.status).toBe("abandoned");
    expect(run.finished_at).toBe(run.lease_expires_at);
    const view = (await api(owner, "GET", `/inbox/routines/${routine.id}`)).body.routine;
    expect(view).toMatchObject({ lastRunStatus: "abandoned", nextDueAt: dueBefore, due: true, running: null });
    expect((db.query("SELECT status FROM proposals WHERE run_id = ?").get(runId) as { status: string }).status).toBe("pending");
    expect((await call(key, "finish_run", { runId, status: "succeeded" })).value.code).toBe("INVALID");
    // A new run can start.
    expect((await call(key, "start_run", { routineId: routine.id })).isError).toBe(false);
    // Old finished runs are removed after 180 days.
    expect(sweepRuns(Date.now() + 181 * 86_400_000).purged).toBeGreaterThanOrEqual(1);
  });

  test("a run's proposals queue one \"Proposals awaiting you\" mail on finish and on abandon", async () => {
    const mail = await import("../server/mail");
    mail.setMailTransportForTests(async () => ({ id: "msg_test" }));
    try {
      await runMailCases();
    } finally {
      mail.setMailTransportForTests(null);
    }
  });
  async function runMailCases() {
    const proposalMail = (userId: string) => db.query("SELECT id FROM mail_outbox WHERE user_id = ? AND template = 'inbox.proposals'").all(userId);
    const finisher = await createUser("Run mail finish");
    const target = await board(finisher);
    const key = makeKey(finisher, ["inbox:write", "tasks:read"]);
    const routine = await createRoutine(finisher);
    const runId = (await call(key, "start_run", { routineId: routine.id })).value.runId;
    await call(key, "submit_proposals", { runId, proposals: [card(target, "First"), card(target, "Second")] });
    // While the run is open nothing is queued; the finish queues exactly one.
    expect(proposalMail(finisher.userId)).toHaveLength(0);
    expect((await call(key, "finish_run", { runId, status: "succeeded" })).isError).toBe(false);
    expect(proposalMail(finisher.userId)).toHaveLength(1);

    const abandoner = await createUser("Run mail abandon");
    const abandonTarget = await board(abandoner);
    const abandonKey = makeKey(abandoner, ["inbox:write", "tasks:read"]);
    const abandonRoutine = await createRoutine(abandoner);
    const abandonRunId = (await call(abandonKey, "start_run", { routineId: abandonRoutine.id })).value.runId;
    await call(abandonKey, "submit_proposals", { runId: abandonRunId, proposals: [card(abandonTarget, "Left behind")] });
    expect(proposalMail(abandoner.userId)).toHaveLength(0);
    await runSweep({ nowMs: Date.now() + LEASE_MS + 1000 });
    expect(proposalMail(abandoner.userId)).toHaveLength(1);
  }

  test("tool calls count only for the key holding the run (T134)", async () => {
    const owner = await createUser("Run counter");
    const runner = makeKey(owner, ["inbox:write", "tasks:read"], "runner");
    const bystander = makeKey(owner, ["inbox:write", "tasks:read"], "bystander");
    const routine = await createRoutine(owner);
    const runId = (await call(runner, "start_run", { routineId: routine.id })).value.runId;
    await call(runner, "list_boards");
    await call(runner, "list_boards");
    await call(bystander, "list_boards");
    await call(bystander, "list_due_routines");
    expect((db.query("SELECT tool_calls FROM routine_runs WHERE id = ?").get(runId) as { tool_calls: number }).tool_calls).toBe(2);
  });

  test("routines are listed as MCP prompts for keys that can see them (O7)", async () => {
    const owner = await createUser("Run prompts");
    const key = makeKey(owner, ["inbox:read"], "prompter");
    const other = makeKey(owner, ["inbox:read"], "other");
    const noInbox = makeKey(owner, ["notes:read"], "notes");
    const routine = await createRoutine(owner, { name: "Weekly review", keyId: key.id, instructions: "Review the week." });
    await createRoutine(owner, { name: "Weekly review!", instructions: "Another." });
    const listed = await rpc(key, "prompts/list");
    const names = (listed.result!.prompts as Array<{ name: string; title: string }>).map((prompt) => prompt.name).sort();
    expect(names).toHaveLength(2);
    expect(names).toContain("routine.weekly-review");
    const prompt = await rpc(key, "prompts/get", { name: "routine.weekly-review" });
    const text = prompt.result!.messages[0].content.text as string;
    expect(text).toContain(`start_run({routineId: "${routine.id}"})`);
    expect(text.endsWith("Review the week.")).toBe(true);
    expect(((await rpc(other, "prompts/list")).result!.prompts as unknown[])).toHaveLength(1);
    expect((await rpc(noInbox, "prompts/list")).result?.prompts ?? []).toEqual([]);
  });
});
