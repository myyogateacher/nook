import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { addRow, fieldByName, newCollection, shareCollection } from "./support/collections";

const { createMcpApiKey } = await import("../server/mcp");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { createCalendar, resetEventCreateLimit } = await import("../server/calendar/service");
const { sweepProposals, APPLYING_TIMEOUT_MS } = await import("../server/inbox/service");
type McpScope = import("../server/mcpScopes").McpScope;

/**
 * The agent inbox proposal primitive (docs/plan/research/2026-09-28-agent-inbox-routines.md §4,
 * §13 Wave A): submit over MCP, review over /api/inbox, one kind at a time.
 */

beforeEach(() => {
  resetMcpLimits();
  resetEventCreateLimit();
});

type Key = { id: string; token: string };
const makeKey = (session: Session, scopes: McpScope[], name = "cron-box"): Key => {
  const key = createMcpApiKey(session.userId, name, scopes);
  return { id: key.id, token: key.token };
};

let rpcId = 0;
async function callTool(key: Key, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } })
  });
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  const body = JSON.parse(json) as { result?: { isError?: boolean; content?: Array<{ text: string }> }; error?: { message: string } };
  if (body.error) return { isError: true, value: { error: body.error.message } as Record<string, any> };
  return { isError: body.result!.isError === true, value: JSON.parse(body.result!.content![0]!.text) as Record<string, any> };
}

async function submit(key: Key, proposals: Array<Record<string, unknown>>) {
  const result = await callTool(key, "submit_proposals", { proposals });
  expect(result.isError).toBe(false);
  return result.value.results as Array<Record<string, any>>;
}

async function one(key: Key, proposal: Record<string, unknown>) {
  const [result] = await submit(key, [proposal]);
  return result!;
}

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

const status = (id: string) => (db.query("SELECT status, result_code FROM proposals WHERE id = ?").get(id) as { status: string; result_code: string | null } | null);
const auditMeta = (eventType: string) => (db.query("SELECT metadata_json FROM audit_log WHERE event_type = ? ORDER BY rowid DESC LIMIT 1").get(eventType) as { metadata_json: string } | null);

async function board(owner: Session, name = "Home") {
  const created = await api(owner, "POST", "/tasks/boards", { name });
  return { boardId: created.body.board.id as string, columns: created.body.columns as Array<{ id: string; name: string }> };
}

async function card(owner: Session, boardId: string, columnId: string, title = "Pay insurance") {
  return (await api(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title })).body.card as { id: string; revision: number };
}

describe("proposals: tasks kinds", () => {
  test("card_create: validated at submit, applied as the approver with the proposal's provenance", async () => {
    const owner = await createUser("Inbox owner");
    const { boardId, columns } = await board(owner);
    const key = makeKey(owner, ["inbox:write", "tasks:read"]);

    // Schema errors and unreadable targets are refused per item; NOT_FOUND looks like missing.
    const other = await createUser("Inbox stranger");
    const foreign = await board(other, "Foreign");
    const [bad, missing, stranger] = await submit(key, [
      { kind: "card_create", title: "No column", payload: { boardId } },
      { kind: "card_create", title: "Missing board", payload: { boardId: crypto.randomUUID(), columnId: columns[0]!.id, title: "X" } },
      { kind: "card_create", title: "Foreign board", payload: { boardId: foreign.boardId, columnId: foreign.columns[0]!.id, title: "X" } }
    ]);
    expect(bad!.code).toBe("INVALID");
    expect(missing!.code).toBe("NOT_FOUND");
    expect(stranger!.code).toBe("NOT_FOUND");

    const created = await one(key, { kind: "card_create", title: "Buy filters", rationale: "The filter is\n6 months old", payload: { boardId, columnId: columns[0]!.id, title: "Buy filters", dueOn: "2026-10-03" } });
    expect(created.status).toBe("pending");
    expect(created.expiresAt).toBeTruthy();
    // Nothing applies at submit.
    expect((db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ? AND title = 'Buy filters'").get(boardId) as { count: number }).count).toBe(0);

    const detail = await api(owner, "GET", `/inbox/proposals/${created.proposalId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.proposal.kind).toBe("card_create");
    expect(detail.body.proposal.rationale).toBe("The filter is\n6 months old");
    expect(detail.body.proposal.targetLabel).toBe(`Home › ${columns[0]!.name}`);
    expect(detail.body.proposal.preview.fields).toContainEqual({ name: "Title", before: null, after: "Buy filters" });
    expect(detail.body.proposal.preview.fields).toContainEqual({ name: "Due date", before: null, after: "2026-10-03" });

    const approved = await api(owner, "POST", `/inbox/proposals/${created.proposalId}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("applied");
    expect(approved.body.ref.type).toBe("card");
    expect(approved.body.ref.href).toBe(`/tasks/${boardId}/card/${approved.body.ref.id}`);
    const row = db.query("SELECT created_by, due_on FROM cards WHERE id = ?").get(approved.body.ref.id) as { created_by: string; due_on: string };
    expect(row).toEqual({ created_by: owner.userId, due_on: "2026-10-03" });
    // The service's own event carries the proposal provenance.
    const event = JSON.parse(auditMeta("task.card_create")!.metadata_json);
    expect(event).toMatchObject({ via: "proposal", proposalId: created.proposalId, keyId: key.id });
    expect(JSON.parse(auditMeta("proposal.applied")!.metadata_json)).toEqual({ proposalId: created.proposalId, kind: "card_create", keyId: key.id });

    // A double approve is NOT_PENDING and applies nothing twice.
    const again = await api(owner, "POST", `/inbox/proposals/${created.proposalId}/approve`, {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("NOT_PENDING");
    expect((db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ? AND title = 'Buy filters'").get(boardId) as { count: number }).count).toBe(1);
  });

  test("concurrent approves of one proposal apply it once", async () => {
    const owner = await createUser("Inbox race");
    const { boardId, columns } = await board(owner);
    const key = makeKey(owner, ["inbox:write", "tasks:read"]);
    const created = await one(key, { kind: "card_create", title: "Once", payload: { boardId, columnId: columns[0]!.id, title: "Once only" } });
    const results = await Promise.all([1, 2, 3].map(() => api(owner, "POST", `/inbox/proposals/${created.proposalId}/approve`, {})));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409, 409]);
    expect((db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ? AND title = 'Once only'").get(boardId) as { count: number }).count).toBe(1);
  });

  test("card_update: a moved revision fails with CARD_CHANGED and changes nothing; the preview shows before and after", async () => {
    const owner = await createUser("Inbox updater");
    const { boardId, columns } = await board(owner);
    const target = await card(owner, boardId, columns[0]!.id);
    const key = makeKey(owner, ["inbox:write", "tasks:read"]);
    const nothing = await one(key, { kind: "card_update", title: "Nothing", payload: { cardId: target.id, baseRevision: target.revision } });
    expect(nothing.code).toBe("INVALID");
    const fresh = await one(key, { kind: "card_update", title: "Set due", payload: { cardId: target.id, baseRevision: target.revision, dueOn: "2026-10-03" } });
    const stale = await one(key, { kind: "card_update", title: "Rename", payload: { cardId: target.id, baseRevision: target.revision, title: "Renamed" } });

    const preview = (await api(owner, "GET", `/inbox/proposals/${stale.proposalId}`)).body.proposal.preview;
    expect(preview.fields).toEqual([{ name: "Title", before: "Pay insurance", after: "Renamed" }]);

    expect((await api(owner, "POST", `/inbox/proposals/${fresh.proposalId}/approve`, {})).body.status).toBe("applied");
    const failed = await api(owner, "POST", `/inbox/proposals/${stale.proposalId}/approve`, {});
    expect(failed.status).toBe(409);
    expect(failed.body).toMatchObject({ status: "failed", code: "CARD_CHANGED" });
    expect(status(stale.proposalId)).toEqual({ status: "failed", result_code: "CARD_CHANGED" });
    expect((db.query("SELECT title, due_on FROM cards WHERE id = ?").get(target.id))).toEqual({ title: "Pay insurance", due_on: "2026-10-03" });
    expect(JSON.parse(auditMeta("proposal.failed")!.metadata_json)).toMatchObject({ proposalId: stale.proposalId, code: "CARD_CHANGED" });
  });

  test("card_comment: applied as the approver; a binned target fails and nothing is written", async () => {
    const owner = await createUser("Inbox commenter");
    const { boardId, columns } = await board(owner);
    const target = await card(owner, boardId, columns[0]!.id);
    const binned = await card(owner, boardId, columns[0]!.id, "Old");
    const key = makeKey(owner, ["inbox:write", "tasks:read"]);
    const comment = await one(key, { kind: "card_comment", title: "Note the bill", payload: { cardId: target.id, body: "The bill arrives Friday." } });
    const lost = await one(key, { kind: "card_comment", title: "On old", payload: { cardId: binned.id, body: "Hello" } });
    expect((await api(owner, "DELETE", `/tasks/cards/${binned.id}`)).status).toBe(200);

    const applied = await api(owner, "POST", `/inbox/proposals/${comment.proposalId}/approve`, {});
    expect(applied.body.ref.href).toBe(`/tasks/${boardId}/card/${target.id}`);
    expect(db.query("SELECT author_id, body FROM card_comments WHERE card_id = ?").get(target.id)).toEqual({ author_id: owner.userId, body: "The bill arrives Friday." });
    // The binned card: the preview is restricted and approve fails NOT_FOUND.
    expect((await api(owner, "GET", `/inbox/proposals/${lost.proposalId}`)).body.proposal.preview).toEqual({ restricted: true });
    const failed = await api(owner, "POST", `/inbox/proposals/${lost.proposalId}/approve`, {});
    expect(failed.body).toMatchObject({ status: "failed", code: "NOT_FOUND" });
    expect((db.query("SELECT COUNT(*) AS count FROM card_comments WHERE card_id = ?").get(binned.id) as { count: number }).count).toBe(0);
  });

  test("an approver who lost access sees a restricted preview and the approve fails", async () => {
    const owner = await createUser("Inbox board owner");
    const member = await createUser("Inbox member");
    const { boardId, columns } = await board(owner, "Shared");
    expect((await api(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
    const key = makeKey(member, ["inbox:write", "tasks:read"]);
    const created = await one(key, { kind: "card_create", title: "Suggest", payload: { boardId, columnId: columns[0]!.id, title: "Suggested" } });
    expect(created.status).toBe("pending");
    // The board owner never sees the member's proposal (D147).
    expect((await api(owner, "GET", `/inbox/proposals/${created.proposalId}`)).status).toBe(404);
    expect((await api(owner, "POST", `/inbox/proposals/${created.proposalId}/approve`, {})).status).toBe(404);
    expect((await api(owner, "POST", `/inbox/proposals/${created.proposalId}/reject`, {})).status).toBe(404);
    expect((await api(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "private", userIds: [] })).status).toBe(200);
    const detail = await api(member, "GET", `/inbox/proposals/${created.proposalId}`);
    expect(detail.body.proposal.preview).toEqual({ restricted: true });
    expect(detail.body.proposal.targetLabel).toBe("restricted");
    const failed = await api(member, "POST", `/inbox/proposals/${created.proposalId}/approve`, {});
    expect(failed.body).toMatchObject({ status: "failed", code: "NOT_FOUND" });
  });
});

describe("proposals: calendar and collections kinds", () => {
  test("event_create and event_update apply through the calendar service with the key's badge", async () => {
    const owner = await createUser("Inbox calendar");
    const { calendar } = createCalendar(owner.userId, { name: "Family", color: "blue" });
    const key = makeKey(owner, ["inbox:write", "calendar:read"]);
    const create = await one(key, { kind: "event_create", title: "Dentist", payload: { calendarId: calendar.id, title: "Dentist", allDay: false, start: "2026-10-05T09:30", durationMinutes: 45, tz: "Europe/London" } });
    expect(create.status).toBe("pending");
    const applied = await api(owner, "POST", `/inbox/proposals/${create.proposalId}/approve`, {});
    expect(applied.body.status).toBe("applied");
    const eventId = applied.body.ref.id as string;
    expect(db.query("SELECT title, created_by, updated_via_key_id FROM events WHERE id = ?").get(eventId)).toEqual({ title: "Dentist", created_by: owner.userId, updated_via_key_id: key.id });
    expect(JSON.parse(auditMeta("event.create")!.metadata_json)).toMatchObject({ via: "proposal", proposalId: create.proposalId });

    const update = await one(key, { kind: "event_update", title: "Move it", payload: { eventId, baseRevision: 1, location: "High Street" } });
    const stale = await one(key, { kind: "event_update", title: "Rename", payload: { eventId, baseRevision: 1, title: "Dentist (old)" } });
    const preview = (await api(owner, "GET", `/inbox/proposals/${update.proposalId}`)).body.proposal.preview;
    expect(preview.fields).toEqual([{ name: "Location", before: null, after: "High Street" }]);
    expect((await api(owner, "POST", `/inbox/proposals/${update.proposalId}/approve`, {})).body.status).toBe("applied");
    expect((await api(owner, "POST", `/inbox/proposals/${stale.proposalId}/approve`, {})).body).toMatchObject({ status: "failed", code: "EVENT_CHANGED" });
    expect((db.query("SELECT title, location FROM events WHERE id = ?").get(eventId))).toEqual({ title: "Dentist", location: "High Street" });
  });

  test("row_create and row_update apply through the collections service; ROW_CHANGED fails", async () => {
    const owner = await createUser("Inbox rows");
    const collection = await newCollection(owner);
    const row = await addRow(owner, collection.id, { [fieldByName(collection, "Name").id]: "Netflix", [fieldByName(collection, "Qty").id]: 1 });
    const key = makeKey(owner, ["inbox:write", "collections:read"]);
    const create = await one(key, { kind: "row_create", title: "Add Spotify", payload: { collectionId: collection.id, values: { Name: "Spotify", Qty: 2 } } });
    const update = await one(key, { kind: "row_update", title: "Bump", payload: { rowId: row.id, baseRevision: row.revision, values: { Qty: 3 } } });
    const stale = await one(key, { kind: "row_update", title: "Rename", payload: { rowId: row.id, baseRevision: row.revision, values: { Name: "Netflix HD" } } });
    const preview = (await api(owner, "GET", `/inbox/proposals/${update.proposalId}`)).body.proposal.preview;
    expect(preview.fields).toEqual([{ name: "Qty", before: "1", after: "3" }]);
    const created = await api(owner, "POST", `/inbox/proposals/${create.proposalId}/approve`, {});
    expect(created.body.ref.href).toBe(`/collections/${collection.id}/row/${created.body.ref.id}`);
    expect((await api(owner, "POST", `/inbox/proposals/${update.proposalId}/approve`, {})).body.status).toBe("applied");
    expect((await api(owner, "POST", `/inbox/proposals/${stale.proposalId}/approve`, {})).body).toMatchObject({ status: "failed", code: "ROW_CHANGED" });
  });

  test("a viewer of a shared collection can suggest, but approving fails because they cannot edit", async () => {
    const owner = await createUser("Inbox collection owner");
    const member = await createUser("Inbox collection reader");
    const collection = await newCollection(owner);
    await shareCollection(owner, collection.id, "selected", [member.userId], "viewer");
    const key = makeKey(member, ["inbox:write", "collections:read"]);
    const create = await one(key, { kind: "row_create", title: "Add", payload: { collectionId: collection.id, values: { Name: "X" } } });
    expect(create.status).toBe("pending");
    expect((await api(member, "POST", `/inbox/proposals/${create.proposalId}/approve`, {})).body).toMatchObject({ status: "failed", code: "READ_ONLY" });
  });
});

describe("proposals: lifecycle", () => {
  test("reject keeps the reason for the agent; bulk approve runs per item in submission order", async () => {
    const owner = await createUser("Inbox bulk");
    const { boardId, columns } = await board(owner);
    const target = await card(owner, boardId, columns[0]!.id);
    const key = makeKey(owner, ["inbox:write", "tasks:read"]);
    const [a, b, c, d] = await submit(key, [
      { kind: "card_create", title: "First", payload: { boardId, columnId: columns[0]!.id, title: "First" } },
      { kind: "card_update", title: "Due", payload: { cardId: target.id, baseRevision: target.revision, dueOn: "2026-11-01" } },
      { kind: "card_update", title: "Stale", payload: { cardId: target.id, baseRevision: target.revision, title: "Stale" } },
      { kind: "card_create", title: "Reject me", payload: { boardId, columnId: columns[0]!.id, title: "Nope" } }
    ]);
    const rejected = await api(owner, "POST", `/inbox/proposals/${d!.proposalId}/reject`, { reason: "Not‮ this one" });
    expect(rejected.body.status).toBe("rejected");
    expect(db.query("SELECT reject_reason, reviewed_by FROM proposals WHERE id = ?").get(d!.proposalId)).toEqual({ reject_reason: "Not this one", reviewed_by: owner.userId });
    const listed = await callTool(key, "list_my_proposals", { status: "rejected" });
    expect(listed.value.proposals).toEqual([expect.objectContaining({ id: d!.proposalId, rejectReason: "Not this one", status: "rejected" })]);

    const bulk = await api(owner, "POST", "/inbox/proposals/bulk", { action: "approve", ids: [c!.proposalId, a!.proposalId, b!.proposalId, d!.proposalId, crypto.randomUUID()] });
    expect(bulk.status).toBe(200);
    const results = bulk.body.results as Array<Record<string, string>>;
    // Submission order: a, b applied; c then fails (b moved the revision); d was already rejected.
    expect(results.filter((result) => result.id !== results[0]!.id || result.status !== "not_found").map((result) => [result.id, result.status, result.code ?? null])).toEqual([
      [a!.proposalId, "applied", null], [b!.proposalId, "applied", null], [c!.proposalId, "failed", "CARD_CHANGED"], [d!.proposalId, "rejected", "NOT_PENDING"]
    ]);
    expect(results[0]).toMatchObject({ status: "not_found", code: "NOT_FOUND" });
  });

  test("the sweeper expires old pending proposals, fails stuck approvals, and removes resolved ones after 90 days", async () => {
    const owner = await createUser("Inbox sweep");
    const { boardId, columns } = await board(owner);
    const key = makeKey(owner, ["inbox:write", "tasks:read"]);
    const [old, stuck, done] = await submit(key, [
      { kind: "card_create", title: "Old", payload: { boardId, columnId: columns[0]!.id, title: "Old" } },
      { kind: "card_create", title: "Stuck", payload: { boardId, columnId: columns[0]!.id, title: "Stuck" } },
      { kind: "card_create", title: "Done", payload: { boardId, columnId: columns[0]!.id, title: "Done" } }
    ]);
    const past = new Date(Date.now() - 1000).toISOString();
    db.query("UPDATE proposals SET expires_at = ? WHERE id = ?").run(past, old!.proposalId);
    db.query("UPDATE proposals SET status = 'applying', claimed_at = ? WHERE id = ?").run(new Date(Date.now() - APPLYING_TIMEOUT_MS - 1000).toISOString(), stuck!.proposalId);
    await api(owner, "POST", `/inbox/proposals/${done!.proposalId}/reject`, {});
    const swept = sweepProposals();
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect(status(old!.proposalId)).toEqual({ status: "expired", result_code: null });
    expect(status(stuck!.proposalId)).toEqual({ status: "failed", result_code: "INTERRUPTED" });
    expect(status(done!.proposalId)!.status).toBe("rejected");
    expect(JSON.parse(auditMeta("proposal.expired")!.metadata_json)).toEqual({ count: expect.any(Number) });
    sweepProposals(Date.now() + 91 * 86_400_000);
    expect(status(done!.proposalId)).toBeNull();
    expect((db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ?").get(boardId) as { count: number }).count).toBe(0);
  });

  test("withdraw is the key's own; the list groups by key and the badge count is bounded", async () => {
    const owner = await createUser("Inbox list");
    const { boardId, columns } = await board(owner);
    const first = makeKey(owner, ["inbox:write", "tasks:read"], "laptop");
    const second = makeKey(owner, ["inbox:write", "tasks:read"], "cron-box");
    const mine = await one(first, { kind: "card_create", title: "Mine", payload: { boardId, columnId: columns[0]!.id, title: "Mine" } });
    await one(second, { kind: "card_create", title: "Theirs <img src=x onerror=alert(1)>", payload: { boardId, columnId: columns[0]!.id, title: "Theirs" } });
    expect((await callTool(second, "withdraw_proposal", { proposalId: mine.proposalId })).value.code).toBe("NOT_FOUND");
    expect((await callTool(second, "list_my_proposals", {})).value.proposals.map((item: { title: string }) => item.title)).toEqual(["Theirs <img src=x onerror=alert(1)>"]);

    const listed = await api(owner, "GET", "/inbox/proposals");
    expect(listed.body.groups.map((group: { key: { name: string }; items: unknown[] }) => [group.key.name, group.items.length])).toEqual([["cron-box", 1], ["laptop", 1]]);
    expect((await api(owner, "GET", "/inbox/count")).body).toEqual({ pending: 2 });
    expect((await callTool(first, "withdraw_proposal", { proposalId: mine.proposalId })).value.status).toBe("withdrawn");
    expect((await callTool(first, "withdraw_proposal", { proposalId: mine.proposalId })).value.code).toBe("INVALID");
    expect((await api(owner, "GET", "/inbox/count")).body).toEqual({ pending: 1 });
    const history = await api(owner, "GET", "/inbox/proposals?status=resolved&group=none");
    expect(history.body.groups[0].items.map((item: { status: string }) => item.status)).toEqual(["withdrawn"]);

    // The badge is capped at 100 (T51).
    const insert = db.query(`INSERT INTO proposals (id, owner_id, key_id, key_name, kind, target_type, target_id, title, payload, created_at, expires_at)
      VALUES (?, ?, ?, 'laptop', 'card_create', 'board', ?, 'Bulk', '{}', ?, ?)`);
    const timestamp = new Date().toISOString();
    db.transaction(() => { for (let index = 0; index < 120; index += 1) insert.run(crypto.randomUUID(), owner.userId, first.id, boardId, timestamp, new Date(Date.now() + 86_400_000).toISOString()); })();
    expect((await api(owner, "GET", "/inbox/count")).body).toEqual({ pending: 100 });
    const paged = await api(owner, "GET", "/inbox/proposals?limit=50");
    expect(paged.body.groups.reduce((sum: number, group: { items: unknown[] }) => sum + group.items.length, 0)).toBe(50);
    expect(paged.body.nextCursor).toBeTruthy();
    const next = await api(owner, "GET", `/inbox/proposals?limit=50&cursor=${encodeURIComponent(paged.body.nextCursor)}`);
    expect(next.body.groups.reduce((sum: number, group: { items: unknown[] }) => sum + group.items.length, 0)).toBe(50);
    db.query("DELETE FROM proposals WHERE owner_id = ? AND title = 'Bulk'").run(owner.userId);
  });

  test("proposal notifications coalesce per key, name only the key and count, and push only when opted in", async () => {
    const owner = await createUser("Inbox bell");
    const { boardId, columns } = await board(owner);
    const key = makeKey(owner, ["inbox:write", "tasks:read"], "laptop");
    await submit(key, [
      { kind: "card_create", title: "Evil ‮ title", payload: { boardId, columnId: columns[0]!.id, title: "A" } },
      { kind: "card_create", title: "Two", payload: { boardId, columnId: columns[0]!.id, title: "B" } }
    ]);
    await one(key, { kind: "card_create", title: "Three", payload: { boardId, columnId: columns[0]!.id, title: "C" } });
    const list = await api(owner, "GET", "/notifications");
    const proposals = list.body.items.filter((item: { href: string }) => item.href === "/inbox");
    expect(proposals).toEqual([expect.objectContaining({ title: "Key “laptop” suggested 3 changes", href: "/inbox", read: false })]);
    expect(JSON.stringify(list.body)).not.toContain("Evil");

    // Push is off by default and opt-in per user.
    expect((await api(owner, "GET", "/inbox/settings")).body).toEqual({ push: false });
    const { onNotification } = await import("../server/calendar/reminders");
    const seen: string[] = [];
    const stop = onNotification((created) => { for (const item of created) seen.push(item.userId); });
    const other = makeKey(owner, ["inbox:write", "tasks:read"], "second");
    await one(other, { kind: "card_create", title: "Quiet", payload: { boardId, columnId: columns[0]!.id, title: "Q" } });
    expect(seen).toEqual([]);
    expect((await api(owner, "PUT", "/inbox/settings", { push: true })).body).toEqual({ push: true });
    const third = makeKey(owner, ["inbox:write", "tasks:read"], "third");
    await one(third, { kind: "card_create", title: "Loud", payload: { boardId, columnId: columns[0]!.id, title: "L" } });
    stop();
    expect(seen).toEqual([owner.userId]);
  });
});
