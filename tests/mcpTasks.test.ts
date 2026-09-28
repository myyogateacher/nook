import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { createMcpApiKey } = await import("../server/mcp");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { taskErrorToMcp } = await import("../server/tasks/mcpTools");
const { TaskError } = await import("../server/tasks/service");
const { consumeMcpLimits, MCP_LIMITS, resetMcpLimits } = await import("../server/mcpRateLimit");
type McpScope = import("../server/mcpScopes").McpScope;

beforeEach(() => resetMcpLimits());

type Key = { id: string; token: string; userId: string };

function makeKey(session: Session, scopes: McpScope[]): Key {
  const key = createMcpApiKey(session.userId, "Task agent", scopes);
  return { id: key.id, token: key.token, userId: session.userId };
}

let rpcId = 0;
async function rpc(key: Key, method: string, params: unknown = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return JSON.parse(json) as { result?: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> }; error?: { message: string } };
}

const toolNames = async (key: Key) => ((await rpc(key, "tools/list")).result!.tools!).map((tool) => tool.name).sort();

type Outcome = { isError: boolean; value: Record<string, any> };
async function callTool(key: Key, name: string, args: Record<string, unknown> = {}): Promise<Outcome> {
  const body = await rpc(key, "tools/call", { name, arguments: args });
  if (body.error) return { isError: true, value: { error: body.error.message } };
  const text = body.result!.content![0]!.text;
  let value: Record<string, any>;
  try { value = JSON.parse(text); } catch { value = { error: text }; }
  return { isError: body.result!.isError === true, value };
}

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const stranger = await createUser(`${label} stranger`);
  const created = await api(owner, "POST", "/boards", { name: `${label} board` });
  const boardId = created.body.board.id as string;
  const [todo, doing] = created.body.columns as Array<{ id: string }>;
  expect((await api(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  const card = (await api(owner, "POST", `/boards/${boardId}/cards`, { columnId: todo!.id, title: "Owner card", description: "Read **the** [spec](https://example.test/spec)" })).body.card as { id: string };
  // A private board the member is not on.
  const privateBoard = await api(owner, "POST", "/boards", { name: `${label} private` });
  const privateCard = (await api(owner, "POST", `/boards/${privateBoard.body.board.id}/cards`, { columnId: privateBoard.body.columns[0].id, title: "Secret" })).body.card as { id: string };
  return {
    owner, member, stranger, boardId, todo: todo!.id, doing: doing!.id, cardId: card.id,
    privateBoardId: privateBoard.body.board.id as string, privateColumnId: privateBoard.body.columns[0].id as string, privateCardId: privateCard.id
  };
}

const auditRows = (actorId: string, eventType: string) => (db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = ? ORDER BY created_at").all(actorId, eventType) as Array<{ metadata_json: string }>)
  .map((row) => JSON.parse(row.metadata_json) as Record<string, unknown>);

const TASK_READ_TOOLS = ["get_card", "list_boards", "list_cards", "list_children", "list_sprints", "list_views", "query_cards", "search_cards"];
const TASK_WRITE_TOOLS = ["comment_on_card", "create_card", "create_sprint", "link_attachment", "link_cards", "manage_tags", "move_card", "set_wip_limit", "start_sprint", "update_card"];

describe("MCP task tools", () => {
  test("task tools appear only for task scopes, write implies read, and there is nothing that deletes", async () => {
    const user = await createUser("Task scopes");
    expect(await toolNames(makeKey(user, ["tasks:read"]))).toEqual(TASK_READ_TOOLS);
    const writer = await toolNames(makeKey(user, ["tasks:write"]));
    expect(writer).toEqual([...TASK_READ_TOOLS, ...TASK_WRITE_TOOLS].sort());
    expect(writer.some((name) => /delete|remove|purge|share|column|rename|unlink/.test(name))).toBe(false);
    const notesOnly = makeKey(user, ["notes:read", "notes:write-draft", "files:read"]);
    const notesTools = await toolNames(notesOnly);
    for (const name of [...TASK_READ_TOOLS, ...TASK_WRITE_TOOLS]) expect(notesTools).not.toContain(name);
    expect((await callTool(notesOnly, "list_boards")).isError).toBe(true);

    const reader = makeKey(user, ["tasks:read"]);
    const direct = await invokeMcpToolForTests("create_card", { boardId: crypto.randomUUID(), columnId: crypto.randomUUID(), title: "x" }, reader.id);
    expect(JSON.parse(direct.content[0]!.text)).toMatchObject({ code: "SCOPE_REQUIRED" });
    const directRead = await invokeMcpToolForTests("list_boards", {}, notesOnly.id);
    expect(JSON.parse(directRead.content[0]!.text)).toMatchObject({ code: "SCOPE_REQUIRED" });
  });

  test("role matrix: strangers and non-members get NOT_FOUND like a missing id; members create, move, and comment", async () => {
    const s = await setup("MCP roles");
    const strangerKey = makeKey(s.stranger, ["tasks:write"]);
    const memberKey = makeKey(s.member, ["tasks:write"]);
    const missing = crypto.randomUUID();

    // The stranger sees nothing, and every answer looks like a missing id.
    // (all_users boards from other tests are readable by everyone, so check ids, not emptiness.)
    const strangerBoards = ((await callTool(strangerKey, "list_boards")).value.boards as Array<{ id: string }>).map((board) => board.id);
    expect(strangerBoards).not.toContain(s.boardId);
    expect(strangerBoards).not.toContain(s.privateBoardId);
    const strangerCalls: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["list_cards", { boardId: s.boardId }, { boardId: missing }],
      ["get_card", { cardId: s.cardId }, { cardId: missing }],
      ["create_card", { boardId: s.boardId, columnId: s.todo, title: "Intruder" }, { boardId: missing, columnId: s.todo, title: "Intruder" }],
      ["move_card", { cardId: s.cardId, columnId: s.doing }, { cardId: missing, columnId: s.doing }],
      ["comment_on_card", { cardId: s.cardId, body: "hi" }, { cardId: missing, body: "hi" }]
    ];
    for (const [name, real, fake] of strangerCalls) {
      const hidden = await callTool(strangerKey, name, real);
      expect(hidden.value).toMatchObject({ code: "NOT_FOUND" });
      expect(hidden.value).toEqual((await callTool(strangerKey, name, fake)).value);
    }

    // A member of one board cannot see the owner's private board.
    const boards = (await callTool(memberKey, "list_boards")).value.boards as Array<{ id: string }>;
    expect(boards.map((board) => board.id)).toContain(s.boardId);
    expect(boards.map((board) => board.id)).not.toContain(s.privateBoardId);
    expect((await callTool(memberKey, "list_cards", { boardId: s.privateBoardId })).value).toMatchObject({ code: "NOT_FOUND" });
    expect((await callTool(memberKey, "get_card", { cardId: s.privateCardId })).value).toMatchObject({ code: "NOT_FOUND" });
    expect((await callTool(memberKey, "create_card", { boardId: s.privateBoardId, columnId: s.privateColumnId, title: "x" })).value).toMatchObject({ code: "NOT_FOUND" });
    // IDOR: the private board's column cannot be used through the shared board.
    expect((await callTool(memberKey, "create_card", { boardId: s.boardId, columnId: s.privateColumnId, title: "x" })).value).toMatchObject({ code: "NOT_FOUND" });
    expect((await callTool(memberKey, "move_card", { cardId: s.cardId, columnId: s.privateColumnId })).value).toMatchObject({ code: "NOT_FOUND" });

    // The member works with cards.
    const created = await callTool(memberKey, "create_card", { boardId: s.boardId, columnId: s.todo, title: "Agent card", description: "From the agent", afterCardId: null });
    expect(created.isError).toBe(false);
    const agentCardId = created.value.card.id as string;
    const moved = await callTool(memberKey, "move_card", { cardId: agentCardId, columnId: s.doing });
    expect(moved.value.card).toMatchObject({ id: agentCardId, column_id: s.doing });
    const commented = await callTool(memberKey, "comment_on_card", { cardId: s.cardId, body: "Looks good" });
    expect(commented.isError).toBe(false);

    const board = await api(s.owner, "GET", `/boards/${s.boardId}`);
    const cards = board.body.cards as Array<{ id: string; column_id: string; created_by: string }>;
    expect(cards.find((card) => card.id === agentCardId)).toMatchObject({ column_id: s.doing, created_by: s.member.userId });
    const card = await api(s.owner, "GET", `/cards/${s.cardId}`);
    expect(card.body.comments).toEqual([expect.objectContaining({ body: "Looks good", author_id: s.member.userId })]);

    // Every write is audited through the usual task events, marked as MCP.
    expect(auditRows(s.member.userId, "task.card_create")).toEqual([{ boardId: s.boardId, cardId: agentCardId, via: "mcp", keyId: memberKey.id }]);
    expect(auditRows(s.member.userId, "task.card_move")).toEqual([{ boardId: s.boardId, cardId: agentCardId, columnId: s.doing, via: "mcp", keyId: memberKey.id }]);
    expect(auditRows(s.member.userId, "task.comment_create")).toEqual([expect.objectContaining({ boardId: s.boardId, cardId: s.cardId, via: "mcp", keyId: memberKey.id })]);
    // HTTP writes are not marked.
    expect(auditRows(s.owner.userId, "task.card_create")[0]).not.toHaveProperty("via");

    // Nothing was deleted or binned.
    expect((db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ? AND deleted_at IS NOT NULL").get(s.boardId) as { count: number }).count).toBe(0);

    // Removing the member takes effect at once.
    expect((await api(s.owner, "PUT", `/boards/${s.boardId}/sharing`, { visibility: "private", userIds: [] })).status).toBe(200);
    expect((await callTool(memberKey, "get_card", { cardId: s.cardId })).value).toMatchObject({ code: "NOT_FOUND" });
  });

  test("reads return plain-text descriptions, attachment names only, and column filters", async () => {
    const s = await setup("MCP reads");
    const form = new FormData();
    form.append("file", new Blob(["notes"]), "plan.txt");
    const uploaded = await request("/files?purpose=task_attachment", { method: "POST", body: form }, s.owner);
    expect(uploaded.status).toBe(201);
    const documentId = ((await uploaded.json()) as { document: { id: string } }).document.id;
    expect((await api(s.owner, "POST", `/cards/${s.cardId}/attachments`, { documentId })).status).toBe(201);
    await api(s.owner, "POST", `/boards/${s.boardId}/cards`, { columnId: s.doing, title: "Doing card" });

    const key = makeKey(s.member, ["tasks:read"]);
    const listed = await callTool(key, "list_cards", { boardId: s.boardId });
    expect(listed.value.columns.map((column: { name: string }) => column.name)).toEqual(["To do", "Doing", "Done"]);
    const ownerCard = listed.value.cards.find((card: { id: string }) => card.id === s.cardId);
    expect(ownerCard).toMatchObject({ title: "Owner card", column_name: "To do", description_preview: "Read the spec", attachments: ["plan.txt"] });
    const filtered = await callTool(key, "list_cards", { boardId: s.boardId, columnId: s.doing });
    expect(filtered.value.cards.map((card: { title: string }) => card.title)).toEqual(["Doing card"]);
    expect((await callTool(key, "list_cards", { boardId: s.boardId, columnId: s.privateColumnId })).value).toMatchObject({ code: "NOT_FOUND" });

    const card = await callTool(key, "get_card", { cardId: s.cardId });
    expect(card.value.card).toMatchObject({ title: "Owner card", description: "Read the spec", column_name: "To do", board_id: s.boardId });
    expect(card.value.attachments).toEqual(["plan.txt"]);
    const text = JSON.stringify(card.value);
    for (const leaked of ["https://example.test", "**", documentId, "sha256"]) expect(text).not.toContain(leaked);
  });

  test("stale anchors map to STALE_POSITION with the current order, and route validation applies", async () => {
    const s = await setup("MCP order");
    const key = makeKey(s.member, ["tasks:write"]);
    const other = (await api(s.owner, "POST", `/boards/${s.boardId}/cards`, { columnId: s.doing, title: "In doing" })).body.card as { id: string };
    // The anchor is not in the target column.
    const stale = await callTool(key, "move_card", { cardId: s.cardId, columnId: s.doing, afterCardId: s.cardId });
    expect(stale.value).toMatchObject({ code: "STALE_POSITION", columnId: s.doing, order: [other.id] });
    const staleCreate = await callTool(key, "create_card", { boardId: s.boardId, columnId: s.todo, title: "x", afterCardId: other.id });
    expect(staleCreate.value).toMatchObject({ code: "STALE_POSITION", columnId: s.todo, order: [s.cardId] });
    const top = await callTool(key, "move_card", { cardId: s.cardId, columnId: s.doing, afterCardId: null });
    expect(top.isError).toBe(false);
    expect((await api(s.owner, "GET", `/boards/${s.boardId}`)).body.cards.filter((card: { column_id: string }) => card.column_id === s.doing).map((card: { id: string }) => card.id)).toEqual([s.cardId, other.id]);

    // create_card takes an optional due date, validated like the route.
    const dated = await callTool(key, "create_card", { boardId: s.boardId, columnId: s.todo, title: "Dated", dueOn: "2026-10-05" });
    expect(dated.value.card).toMatchObject({ title: "Dated", due_on: "2026-10-05" });
    expect((await callTool(key, "get_card", { cardId: dated.value.card.id })).value.card).toMatchObject({ due_on: "2026-10-05", assignee_name: null });
    expect((await callTool(key, "create_card", { boardId: s.boardId, columnId: s.todo, title: "Bad date", dueOn: "2026-02-30" })).value).toMatchObject({ code: "INVALID" });

    // The HTTP route's rules: control characters in a title, blank comments.
    expect((await callTool(key, "create_card", { boardId: s.boardId, columnId: s.todo, title: "bad‮title" })).value).toMatchObject({ code: "INVALID" });
    expect((await callTool(key, "comment_on_card", { cardId: s.cardId, body: "   " })).value).toMatchObject({ code: "INVALID" });

    // CARD_CHANGED carries the current revision, never the stored card (its description is Markdown).
    const changed = taskErrorToMcp(new TaskError(409, "changed", "CARD_CHANGED", { card: { id: "k", revision: 4, description: "**x**" } }));
    expect(changed).toMatchObject({ code: "CARD_CHANGED", details: { currentRevision: 4 } });
    expect(changed.details).not.toHaveProperty("card");
    expect(taskErrorToMcp(new TaskError(409, "full", "COLUMN_FULL", { columnId: "c", wipLimit: 2, cardCount: 2 }))).toMatchObject({ code: "COLUMN_FULL", details: { wipLimit: 2, cardCount: 2 } });
    expect(taskErrorToMcp(new TaskError(400, "not a member", "ASSIGNEE_NOT_MEMBER"))).toMatchObject({ code: "INVALID", details: { reason: "ASSIGNEE_NOT_MEMBER" } });
    expect(taskErrorToMcp(new TaskError(403, "owner", "OWNER_ONLY")).code).toBe("OWNER_ONLY");
    expect(taskErrorToMcp(new TaskError(409, "cap", "LIMIT_REACHED")).code).toBe("LIMIT_REACHED");
    expect(taskErrorToMcp(new TaskError(400, "bad")).code).toBe("INVALID");
    expect(taskErrorToMcp(new TaskError(404, "gone")).code).toBe("NOT_FOUND");
  });

  test("due time and assignees: create_card, update_card with a revision CAS, and the read fields (WAVE_13 §5.5, T99)", async () => {
    const s = await setup("MCP fields");
    const key = makeKey(s.member, ["tasks:write"]);
    const created = await callTool(key, "create_card", {
      boardId: s.boardId, columnId: s.todo, title: "Call", dueOn: "2026-10-01", dueTime: "17:30", dueTz: "Europe/Berlin", assigneeIds: [s.owner.userId, s.member.userId]
    });
    expect(created.isError).toBe(false);
    expect(created.value.card).toMatchObject({
      title: "Call", revision: 1, due_on: "2026-10-01", due_time: "17:30", due_tz: "Europe/Berlin", due_at: "2026-10-01T15:30:00.000Z",
      assignees: ["MCP fields owner", "MCP fields member"], assignee_name: "MCP fields owner"
    });
    const cardId = created.value.card.id as string;
    expect((await callTool(key, "create_card", { boardId: s.boardId, columnId: s.todo, title: "x", dueOn: "2026-10-01", dueTime: "17:30" })).value).toMatchObject({ code: "INVALID" });
    expect((await callTool(key, "create_card", { boardId: s.boardId, columnId: s.todo, title: "x", assigneeIds: [s.stranger.userId] })).value)
      .toMatchObject({ code: "INVALID", reason: "ASSIGNEE_NOT_MEMBER" });

    // update_card changes fields with the revision compare-and-swap.
    const updated = await callTool(key, "update_card", { cardId, baseRevision: 1, title: "Call back", dueTime: "09:00", dueTz: "UTC", assigneeIds: [s.member.userId] });
    expect(updated.isError).toBe(false);
    expect(updated.value.card).toMatchObject({ title: "Call back", revision: 2, due_time: "09:00", due_tz: "UTC", due_at: "2026-10-01T09:00:00.000Z", assignees: ["MCP fields member"] });
    const stale = await callTool(key, "update_card", { cardId, baseRevision: 1, title: "Lost" });
    expect(stale.value).toMatchObject({ code: "CARD_CHANGED", currentRevision: 2 });
    expect(JSON.stringify(stale.value)).not.toContain("description");
    // It never changes the description.
    const withDescription = await callTool(key, "update_card", { cardId, baseRevision: 2, description: "Overwritten" });
    expect(withDescription.isError).toBe(true);
    const direct = await invokeMcpToolForTests("update_card", { cardId, baseRevision: 2, description: "Overwritten" }, key.id);
    expect(JSON.parse(direct.content[0]!.text)).toMatchObject({ code: "INVALID" });
    expect((await api(s.owner, "GET", `/cards/${cardId}`)).body.card).toMatchObject({ description: "", revision: 2, title: "Call back" });
    expect((await callTool(key, "update_card", { cardId, baseRevision: 2 })).value).toMatchObject({ code: "INVALID" });
    expect((await callTool(key, "update_card", { cardId, baseRevision: 2, dueTime: "25:00", dueTz: "UTC" })).value).toMatchObject({ code: "INVALID" });
    // Clearing the date clears the time; [] clears assignees.
    const cleared = await callTool(key, "update_card", { cardId, baseRevision: 2, dueOn: null, assigneeIds: [] });
    expect(cleared.value.card).toMatchObject({ revision: 3, due_on: null, due_time: null, due_tz: null, due_at: null, assignees: [], assignee_name: null });
    // Strangers and private cards look missing.
    const strangerKey = makeKey(s.stranger, ["tasks:write"]);
    expect((await callTool(strangerKey, "update_card", { cardId, baseRevision: 3, title: "x" })).value).toEqual(
      (await callTool(strangerKey, "update_card", { cardId: crypto.randomUUID(), baseRevision: 3, title: "x" })).value);
    expect((await callTool(key, "update_card", { cardId: s.privateCardId, baseRevision: 1, title: "x" })).value).toMatchObject({ code: "NOT_FOUND" });

    // Reads carry the same fields, and columns their WIP limit.
    await api(s.owner, "PATCH", `/cards/${cardId}`, { dueOn: "2026-10-02", dueTime: "08:15", dueTz: "America/New_York", assigneeIds: [s.owner.userId], revision: 3 });
    expect((await api(s.owner, "PATCH", `/columns/${s.doing}`, { wipLimit: 1 })).status).toBe(200);
    const listed = await callTool(key, "list_cards", { boardId: s.boardId });
    expect(listed.value.columns.map((column: { wip_limit: number | null }) => column.wip_limit)).toEqual([null, 1, null]);
    expect(listed.value.cards.find((card: { id: string }) => card.id === cardId)).toMatchObject({
      due_on: "2026-10-02", due_time: "08:15", due_tz: "America/New_York", due_at: "2026-10-02T12:15:00.000Z", assignees: ["MCP fields owner"], assignee_name: "MCP fields owner"
    });
    expect((await callTool(key, "get_card", { cardId })).value.card).toMatchObject({ due_time: "08:15", assignees: ["MCP fields owner"], revision: 4 });

    // Audit: marked as MCP, with counts only.
    expect(auditRows(s.member.userId, "task.card_update").at(-1)).toMatchObject({ boardId: s.boardId, cardId, via: "mcp", keyId: key.id, assigneesRemoved: 1, dueTime: "cleared" });
  });

  test("create_card and move_card return COLUMN_FULL with the counts", async () => {
    const s = await setup("MCP full");
    const key = makeKey(s.member, ["tasks:write"]);
    expect((await api(s.owner, "PATCH", `/columns/${s.todo}`, { wipLimit: 1 })).status).toBe(200);
    expect((await callTool(key, "create_card", { boardId: s.boardId, columnId: s.todo, title: "One too many" })).value)
      .toMatchObject({ code: "COLUMN_FULL", columnId: s.todo, wipLimit: 1, cardCount: 1 });
    const other = (await callTool(key, "create_card", { boardId: s.boardId, columnId: s.doing, title: "Elsewhere" })).value.card as { id: string };
    expect((await callTool(key, "move_card", { cardId: other.id, columnId: s.todo })).value).toMatchObject({ code: "COLUMN_FULL", cardCount: 1 });
    // Within the full column is fine.
    expect((await callTool(key, "move_card", { cardId: s.cardId, columnId: s.todo, afterCardId: null })).isError).toBe(false);
  });

  test("task writes count against the daily task_write bucket; reads do not", async () => {
    const s = await setup("MCP daily");
    const key = makeKey(s.member, ["tasks:write"]);
    expect((await callTool(key, "comment_on_card", { cardId: s.cardId, body: "one" })).isError).toBe(false);
    // Use up the rest of today's task writes for this key.
    for (let index = 1; index < MCP_LIMITS.task_write.limit; index += 1) {
      expect(consumeMcpLimits({ keyId: key.id }, ["task_write"])).toBe(0);
    }
    const limited = await callTool(key, "create_card", { boardId: s.boardId, columnId: s.todo, title: "Too many" });
    expect(limited.value).toMatchObject({ code: "RATE_LIMITED" });
    expect(limited.value.retryAfterSeconds).toBeGreaterThan(3600);
    expect((await callTool(key, "move_card", { cardId: s.cardId, columnId: s.doing })).value).toMatchObject({ code: "RATE_LIMITED" });
    expect((await callTool(key, "get_card", { cardId: s.cardId })).isError).toBe(false);
    // A refused write changed nothing.
    expect((await api(s.owner, "GET", `/boards/${s.boardId}`)).body.cards.map((card: { title: string }) => card.title)).toEqual(["Owner card"]);
  });
});

describe("MCP card relations and search (WAVE_13 §5.5, T90, T91, T95, T99)", () => {
  test("link_cards creates a relation seen from cardId, never bumps revisions, and is audited as MCP", async () => {
    const s = await setup("MCP link");
    const key = makeKey(s.member, ["tasks:write"]);
    const second = (await api(s.member, "POST", `/boards/${s.boardId}/cards`, { columnId: s.doing, title: "Second" })).body.card as { id: string };
    const linked = await callTool(key, "link_cards", { cardId: s.cardId, targetCardId: second.id, type: "depends_on" });
    expect(linked.isError).toBe(false);
    expect(linked.value).toEqual({ relation: { type: "depends_on", cardId: second.id, title: "Second", boardName: "MCP link board", columnName: "Doing", isDone: false } });
    // The REST view from the other side is the inverse; revisions are unchanged (D107).
    const other = (await api(s.member, "GET", `/cards/${second.id}`)).body;
    expect(other.relations).toEqual([expect.objectContaining({ type: "needed_by", card: expect.objectContaining({ id: s.cardId }) })]);
    expect(other.card.revision).toBe(1);
    expect((await api(s.member, "GET", `/cards/${s.cardId}`)).body.card.revision).toBe(1);
    // RELATION_EXISTS in either direction, with the existing relation.
    const again = await callTool(key, "link_cards", { cardId: second.id, targetCardId: s.cardId, type: "relates_to" });
    expect(again.isError).toBe(true);
    expect(again.value).toMatchObject({ code: "RELATION_EXISTS", relation: { type: "needed_by", cardId: s.cardId } });
    // get_card and list_cards carry the relation and the counts.
    expect((await callTool(key, "get_card", { cardId: s.cardId })).value.relations).toEqual([linked.value.relation]);
    const listed = (await callTool(key, "list_cards", { boardId: s.boardId })).value.cards as Array<Record<string, unknown>>;
    expect(listed.find((card) => card.id === s.cardId)).toMatchObject({ relation_count: 1, open_blockers: 1 });
    expect(listed.find((card) => card.id === second.id)).toMatchObject({ relation_count: 1, open_blockers: 0 });
    // Audit with ids only, marked as MCP.
    expect(auditRows(s.member.userId, "task.relation_create").at(-1)).toEqual({ boardId: s.boardId, cardId: s.cardId, relationId: expect.any(String), kind: "blocks", via: "mcp", keyId: key.id });
    // Bad arguments.
    expect((await callTool(key, "link_cards", { cardId: s.cardId, targetCardId: s.cardId, type: "relates_to" })).value).toMatchObject({ code: "INVALID" });
    expect((await callTool(key, "link_cards", { cardId: s.cardId, targetCardId: second.id, type: "blocks" })).isError).toBe(true);
  });

  test("NOT_FOUND for unreadable, missing, or binned cards alike; restricted relations carry no data", async () => {
    const s = await setup("MCP link access");
    const memberKey = makeKey(s.member, ["tasks:write"]);
    const ownerKey = makeKey(s.owner, ["tasks:write"]);
    const missing = await callTool(memberKey, "link_cards", { cardId: s.cardId, targetCardId: crypto.randomUUID(), type: "relates_to" });
    expect(missing.value).toMatchObject({ code: "NOT_FOUND" });
    expect((await callTool(memberKey, "link_cards", { cardId: s.cardId, targetCardId: s.privateCardId, type: "relates_to" })).value).toEqual(missing.value);
    expect((await callTool(memberKey, "link_cards", { cardId: s.privateCardId, targetCardId: s.cardId, type: "relates_to" })).value).toEqual(missing.value);
    const strangerKey = makeKey(s.stranger, ["tasks:write"]);
    expect((await callTool(strangerKey, "link_cards", { cardId: s.cardId, targetCardId: s.privateCardId, type: "relates_to" })).value).toEqual(missing.value);

    // The owner links the shared card to their private card; the member's agent sees only a restricted row.
    const linked = await callTool(ownerKey, "link_cards", { cardId: s.cardId, targetCardId: s.privateCardId, type: "duplicates" });
    expect(linked.value.relation).toMatchObject({ type: "duplicates", cardId: s.privateCardId, title: "Secret" });
    const seen = await callTool(memberKey, "get_card", { cardId: s.cardId });
    expect(seen.value.relations).toEqual([{ type: "duplicates", restricted: true }]);
    const raw = JSON.stringify(seen.value);
    expect(raw).not.toContain(s.privateCardId);
    expect(raw).not.toContain("Secret");
    expect(raw).not.toContain("MCP link access private");
    expect((await callTool(memberKey, "list_cards", { boardId: s.boardId })).value.cards[0]).toMatchObject({ relation_count: 1, open_blockers: 0 });

    // A binned target is NOT_FOUND like a missing one, and hidden from its readers.
    await api(s.owner, "DELETE", `/cards/${s.privateCardId}`);
    expect((await callTool(ownerKey, "get_card", { cardId: s.cardId })).value.relations).toEqual([]);
    const third = (await api(s.owner, "POST", `/boards/${s.boardId}/cards`, { columnId: s.todo, title: "Third" })).body.card as { id: string };
    await api(s.owner, "DELETE", `/cards/${third.id}`);
    expect((await callTool(ownerKey, "link_cards", { cardId: s.cardId, targetCardId: third.id, type: "relates_to" })).value).toEqual(missing.value);
  });

  test("search_cards returns readable live cards by title, bounded, and needs tasks:read", async () => {
    const s = await setup("MCP find");
    const key = makeKey(s.member, ["tasks:read"]);
    const found = await callTool(key, "search_cards", { query: "owner CARD" });
    expect(found.isError).toBe(false);
    expect(found.value.results).toContainEqual({ id: s.cardId, board_id: s.boardId, board_name: "MCP find board", title: "Owner card", column_name: "To do", is_done: 0 });
    expect(found.value.truncated).toBe(false);
    // Private cards never appear; the owner's own key finds them.
    expect(((await callTool(key, "search_cards", { query: "Secret" })).value.results as Array<{ id: string }>).map((hit) => hit.id)).not.toContain(s.privateCardId);
    expect(((await callTool(makeKey(s.owner, ["tasks:read"]), "search_cards", { query: "Secret", boardId: s.privateBoardId })).value.results as Array<{ id: string }>)[0]!.id).toBe(s.privateCardId);
    // Bounds.
    expect((await callTool(key, "search_cards", { query: "" })).isError).toBe(true);
    expect((await callTool(key, "search_cards", { query: "   " })).value).toMatchObject({ code: "INVALID" });
    expect((await callTool(key, "search_cards", { query: "x", limit: 21 })).isError).toBe(true);
    const direct = await invokeMcpToolForTests("search_cards", { query: "x", limit: 50 }, key.id);
    expect(direct.isError).toBe(true);
    // Hidden from keys without a tasks scope, and re-checked in the handler.
    const notesOnly = makeKey(s.member, ["notes:read"]);
    expect(await toolNames(notesOnly)).not.toContain("search_cards");
    expect(JSON.parse((await invokeMcpToolForTests("search_cards", { query: "x" }, notesOnly.id)).content[0]!.text)).toMatchObject({ code: "SCOPE_REQUIRED" });
    expect(JSON.parse((await invokeMcpToolForTests("link_cards", { cardId: s.cardId, targetCardId: s.privateCardId, type: "relates_to" }, key.id)).content[0]!.text))
      .toMatchObject({ code: "SCOPE_REQUIRED" });
  });

  test("link_cards counts against the task_write bucket; taskErrorToMcp maps RELATION_EXISTS", async () => {
    const s = await setup("MCP link daily");
    const key = makeKey(s.member, ["tasks:write"]);
    const second = (await api(s.member, "POST", `/boards/${s.boardId}/cards`, { columnId: s.doing, title: "Second" })).body.card as { id: string };
    for (let index = 0; index < MCP_LIMITS.task_write.limit; index += 1) expect(consumeMcpLimits({ keyId: key.id }, ["task_write"])).toBe(0);
    expect((await callTool(key, "link_cards", { cardId: s.cardId, targetCardId: second.id, type: "relates_to" })).value).toMatchObject({ code: "RATE_LIMITED" });
    expect((await api(s.member, "GET", `/cards/${s.cardId}`)).body.relations).toEqual([]);
    // search_cards is a read and still works.
    expect((await callTool(key, "search_cards", { query: "Second" })).isError).toBe(false);

    const mapped = taskErrorToMcp(new TaskError(409, "These cards are already related", "RELATION_EXISTS", {
      relation: { id: crypto.randomUUID(), type: "relates_to", restricted: true, created_at: new Date().toISOString() }
    }));
    expect(mapped.code).toBe("RELATION_EXISTS");
    expect(mapped.details).toEqual({ relation: { type: "relates_to", restricted: true } });
  });
});

describe("MCP tags, flags, excerpts, and list_cards filters (Wave 13C, D113, §5.5)", () => {
  test("reads carry tags, flags, and the excerpt; list_cards returns the board's tags", async () => {
    const s = await setup("MCP tags read");
    const key = makeKey(s.member, ["tasks:read"]);
    const backend = (await api(s.owner, "POST", `/boards/${s.boardId}/tags`, { name: "Backend", color: "blue" })).body.tag as { id: string };
    expect((await api(s.owner, "PATCH", `/cards/${s.cardId}`, { tagIds: [backend.id], flags: ["blocked", "urgent"], revision: 1 })).status).toBe(200);
    const listed = await callTool(key, "list_cards", { boardId: s.boardId });
    expect(listed.value.tags).toEqual([{ id: backend.id, name: "Backend", color: "blue" }]);
    expect(listed.value.cards[0]).toMatchObject({ tags: ["Backend"], flags: ["urgent", "blocked"], description_excerpt: "Read the spec" });
    expect((await callTool(key, "get_card", { cardId: s.cardId })).value.card).toMatchObject({ tags: ["Backend"], flags: ["urgent", "blocked"], description_excerpt: "Read the spec" });
  });

  test("create_card and update_card take tags by name or id and flags; unknown tags are INVALID and write nothing", async () => {
    const s = await setup("MCP tags write");
    const key = makeKey(s.member, ["tasks:write"]);
    const ui = (await api(s.owner, "POST", `/boards/${s.boardId}/tags`, { name: "UI" })).body.tag as { id: string };
    await api(s.owner, "POST", `/boards/${s.boardId}/tags`, { name: "Backend" });
    const foreign = (await api(s.owner, "POST", `/boards/${s.privateBoardId}/tags`, { name: "Secret tag" })).body.tag as { id: string };

    const created = await callTool(key, "create_card", { boardId: s.boardId, columnId: s.todo, title: "Tagged", tags: ["backend", ui.id], flags: ["needs_review"] });
    expect(created.isError).toBe(false);
    expect(created.value.card).toMatchObject({ tags: ["Backend", "UI"], flags: ["needs_review"], revision: 1 });
    const cardCount = () => (db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ?").get(s.boardId) as { count: number }).count;
    const before = cardCount();
    const unknown = await callTool(key, "create_card", { boardId: s.boardId, columnId: s.todo, title: "No", tags: ["Backend", "Nope"] });
    expect(unknown.value).toMatchObject({ code: "INVALID", reason: "UNKNOWN_TAG", tags: ["Nope"] });
    // A tag of another board, even one the owner can read, is unknown here.
    const ownerKey = makeKey(s.owner, ["tasks:write"]);
    expect((await callTool(ownerKey, "create_card", { boardId: s.boardId, columnId: s.todo, title: "No", tags: [foreign.id] })).value).toMatchObject({ code: "INVALID", reason: "UNKNOWN_TAG" });
    // An unknown flag fails the tool's input schema.
    expect((await callTool(key, "create_card", { boardId: s.boardId, columnId: s.todo, title: "No", flags: ["important"] })).isError).toBe(true);
    expect(cardCount()).toBe(before);

    const cardId = created.value.card.id as string;
    const updated = await callTool(key, "update_card", { cardId, baseRevision: 1, tags: ["UI"], flags: ["on_hold", "urgent"] });
    expect(updated.value.card).toMatchObject({ tags: ["UI"], flags: ["urgent", "on_hold"], revision: 2 });
    expect(auditRows(s.member.userId, "task.card_update").at(-1)).toMatchObject({ cardId, via: "mcp", keyId: key.id, tagsAdded: 0, tagsRemoved: 1, flags: ["on_hold", "urgent"] });
    expect((await callTool(key, "update_card", { cardId, baseRevision: 2, tags: ["Backend", "Gone"] })).value).toMatchObject({ code: "INVALID", reason: "UNKNOWN_TAG" });
    expect((await callTool(key, "update_card", { cardId, baseRevision: 1, tags: [] })).value).toMatchObject({ code: "CARD_CHANGED", currentRevision: 2 });
    const cleared = await callTool(key, "update_card", { cardId, baseRevision: 2, tags: [], flags: [] });
    expect(cleared.value.card).toMatchObject({ tags: [], flags: [], revision: 3 });
    expect((await api(s.owner, "GET", `/cards/${cardId}`)).body.card).toMatchObject({ tag_ids: [], flags: [], revision: 3 });
    // A stranger's tag update looks like a missing card.
    const strangerKey = makeKey(s.stranger, ["tasks:write"]);
    expect((await callTool(strangerKey, "update_card", { cardId, baseRevision: 3, tags: ["UI"] })).value).toEqual(
      (await callTool(strangerKey, "update_card", { cardId: crypto.randomUUID(), baseRevision: 3, tags: ["UI"] })).value);
  });

  test("list_cards filters on the server: each filter, me and none, and validation", async () => {
    const s = await setup("MCP filters");
    const key = makeKey(s.member, ["tasks:read"]);
    const tag = (await api(s.owner, "POST", `/boards/${s.boardId}/tags`, { name: "Café" })).body.tag as { id: string };
    const mine = (await api(s.owner, "POST", `/boards/${s.boardId}/cards`, {
      columnId: s.doing, title: "Mine", description: "Résumé draft", assigneeIds: [s.member.userId], tagIds: [tag.id], flags: ["urgent"], dueOn: "2026-10-05"
    })).body.card.id as string;
    const ids = async (args: Record<string, unknown>) => {
      const result = await callTool(key, "list_cards", { boardId: s.boardId, ...args });
      expect(result.isError).toBe(false);
      return (result.value.cards as Array<{ id: string }>).map((card) => card.id).sort();
    };
    expect(await ids({})).toEqual([s.cardId, mine].sort());
    expect(await ids({ assigneeIds: ["me"] })).toEqual([mine]);
    expect(await ids({ assigneeIds: ["none"] })).toEqual([s.cardId]);
    expect(await ids({ tags: ["CAFÉ"] })).toEqual([mine]);
    expect(await ids({ tags: ["none"] })).toEqual([s.cardId]);
    expect(await ids({ flags: ["urgent", "blocked"] })).toEqual([mine]);
    expect(await ids({ flags: ["none"] })).toEqual([s.cardId]);
    expect(await ids({ dueBefore: "2026-10-05" })).toEqual([]);
    expect(await ids({ dueBefore: "2026-10-06", dueAfter: "2026-10-04" })).toEqual([mine]);
    expect(await ids({ dueNone: true })).toEqual([s.cardId]);
    expect(await ids({ dueAfter: "2026-10-01", dueNone: true })).toEqual([s.cardId, mine].sort());
    expect(await ids({ text: "resume" })).toEqual([mine]);
    expect(await ids({ text: "SPEC" })).toEqual([s.cardId]);
    expect(await ids({ columnId: s.doing, flags: ["urgent"], assigneeIds: ["me"] })).toEqual([mine]);
    expect(await ids({ columnId: s.todo, flags: ["urgent"] })).toEqual([]);

    expect((await callTool(key, "list_cards", { boardId: s.boardId, tags: ["Unknown"] })).value).toMatchObject({ code: "INVALID", reason: "UNKNOWN_TAG", known: ["Café"] });
    for (const args of [{ dueBefore: "2026-02-30" }, { text: "" }, { text: "x".repeat(101) }, { flags: ["soon"] }, { assigneeIds: ["someone"] }]) {
      const refused = await callTool(key, "list_cards", { boardId: s.boardId, ...args });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.value)).toMatch(/INVALID|Invalid arguments/);
    }
    // Filters never widen access: the member cannot list the private board at all.
    expect((await callTool(key, "list_cards", { boardId: s.privateBoardId, assigneeIds: ["none"] })).value).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("MCP task tools: hierarchy (17A, D139, T119)", () => {
  test("create_card and update_card take parentId and level; list_cards, get_card, and list_children show the tree", async () => {
    const owner = await createUser("MCP tree owner");
    const stranger = await createUser("MCP tree stranger");
    const created = await api(owner, "POST", "/boards", { name: "MCP tree", template: "epics" });
    const boardId = created.body.board.id as string;
    const [todo, , done] = created.body.columns as Array<{ id: string }>;
    const key = makeKey(owner, ["tasks:read", "tasks:write"]);
    const epic = (await callTool(key, "create_card", { boardId, columnId: todo!.id, title: "Checkout", level: 0 })).value.card;
    expect(epic).toMatchObject({ level: 0, level_name: "Epic", parent_id: null, child_count: 0 });
    const story = (await callTool(key, "create_card", { boardId, columnId: todo!.id, title: "Refunds", parentId: epic.id })).value.card;
    expect(story).toMatchObject({ level: 1, level_name: "Story", parent_id: epic.id });
    const sub = (await callTool(key, "create_card", { boardId, columnId: done!.id, title: "Form", parentId: story.id })).value.card;
    expect(sub.level).toBe(2);
    expect(JSON.parse((db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'task.card_create' ORDER BY rowid DESC LIMIT 1").get() as { metadata_json: string }).metadata_json))
      .toMatchObject({ via: "mcp", parentId: story.id, level: 2 });
    // Invalid parents are INVALID with the service reason; a level change with children is refused.
    expect((await callTool(key, "create_card", { boardId, columnId: todo!.id, title: "Bad", parentId: sub.id })).value).toMatchObject({ code: "INVALID", reason: "PARENT_INVALID" });
    expect((await callTool(key, "update_card", { cardId: story.id, baseRevision: story.revision, level: 2 })).value).toMatchObject({ code: "INVALID", reason: "HAS_CHILDREN", childCount: 1 });
    const listed = (await callTool(key, "list_cards", { boardId })).value;
    expect(listed.board).toMatchObject({ levels: ["Epic", "Story", "Subtask"], work_level: 1 });
    expect(listed.cards.find((card: { id: string }) => card.id === story.id)).toMatchObject({ parent_id: epic.id, level: 1, level_name: "Story", child_count: 1, done_child_count: 1 });
    const detail = (await callTool(key, "get_card", { cardId: story.id })).value;
    expect(detail.card).toMatchObject({ parent_id: epic.id, parent_title: "Checkout", child_count: 1 });
    expect(detail.children).toEqual([expect.objectContaining({ id: sub.id, title: "Form", level_name: "Subtask", is_done: true })]);
    expect((await callTool(key, "list_children", { cardId: epic.id })).value.children.map((child: { id: string }) => child.id)).toEqual([story.id]);
    // Detach under the revision CAS; a stale revision is CARD_CHANGED.
    const detached = (await callTool(key, "update_card", { cardId: story.id, baseRevision: story.revision, parentId: null })).value.card;
    expect(detached).toMatchObject({ parent_id: null, level: 1 });
    expect((await callTool(key, "update_card", { cardId: story.id, baseRevision: story.revision, parentId: epic.id })).value).toMatchObject({ code: "CARD_CHANGED" });
    // query_cards names the parent; a stranger's key cannot list the children.
    const queried = (await callTool(key, "query_cards", { filter: `board:${boardId} level:2` })).value;
    expect(queried.cards).toEqual([expect.objectContaining({ id: sub.id, parent_id: story.id, parent_title: "Refunds", level: 2 })]);
    expect((await callTool(makeKey(stranger, ["tasks:read"]), "list_children", { cardId: epic.id })).value).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("MCP task tools: sprints (17B, D139, T119)", () => {
  test("list_sprints, sprintId on create_card and update_card, sprint fields on reads, and sprint filters", async () => {
    const owner = await createUser("MCP sprint owner");
    const stranger = await createUser("MCP sprint stranger");
    const created = await api(owner, "POST", "/boards", { name: "MCP sprints", template: "scrum" });
    const boardId = created.body.board.id as string;
    const [backlogColumn, todo, , , done] = created.body.columns as Array<{ id: string }>;
    const first = (await api(owner, "GET", `/boards/${boardId}`)).body.sprints[0].id as string;
    expect((await api(owner, "PATCH", `/sprints/${first}`, { state: "active" })).status).toBe(200);
    const next = (await api(owner, "POST", `/boards/${boardId}/sprints`, { name: "Sprint 2" })).body.sprint.id as string;
    const key = makeKey(owner, ["tasks:read", "tasks:write"]);

    const listed = (await callTool(key, "list_sprints", { boardId })).value;
    expect(listed.sprints.map((sprint: { name: string; state: string }) => [sprint.name, sprint.state])).toEqual([["Sprint 1", "active"], ["Sprint 2", "planned"]]);
    expect(listed.nextCursor).toBeNull();
    expect((await callTool(key, "list_sprints", { boardId, state: "planned" })).value.sprints.map((sprint: { id: string }) => sprint.id)).toEqual([next]);
    expect((await callTool(makeKey(stranger, ["tasks:read"]), "list_sprints", { boardId })).value).toMatchObject({ code: "NOT_FOUND" });

    const task = (await callTool(key, "create_card", { boardId, columnId: todo!.id, title: "Checkout", sprintId: first })).value.card;
    expect(task).toMatchObject({ sprint_id: first, sprint_name: "Sprint 1" });
    expect(JSON.parse((db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'task.card_create' ORDER BY rowid DESC LIMIT 1").get() as { metadata_json: string }).metadata_json))
      .toMatchObject({ via: "mcp", sprintId: first });
    const subtask = (await callTool(key, "create_card", { boardId, columnId: todo!.id, title: "Form", parentId: task.id })).value.card;
    expect(subtask).toMatchObject({ sprint_id: first, sprint_name: "Sprint 1" });
    // A subtask stores no sprint: INVALID with the reason; an unknown sprint is NOT_FOUND.
    expect((await callTool(key, "update_card", { cardId: subtask.id, baseRevision: subtask.revision, sprintId: next })).value).toMatchObject({ code: "INVALID", reason: "SPRINT_LEVEL" });
    expect((await callTool(key, "create_card", { boardId, columnId: todo!.id, title: "Nope", sprintId: crypto.randomUUID() })).value).toMatchObject({ code: "NOT_FOUND" });
    await callTool(key, "create_card", { boardId, columnId: backlogColumn!.id, title: "Idea", sprintId: null });
    // Friction 3: no sprintId at the work level joins the active sprint; null above stays in the backlog.
    const routine = (await callTool(key, "create_card", { boardId, columnId: todo!.id, title: "From a routine" })).value.card;
    expect(routine).toMatchObject({ sprint_id: first, sprint_name: "Sprint 1" });
    await callTool(key, "create_card", { boardId, columnId: done!.id, title: "Shipped", sprintId: first });

    const moved = (await callTool(key, "update_card", { cardId: task.id, baseRevision: task.revision, sprintId: next })).value.card;
    expect(moved).toMatchObject({ sprint_id: next, sprint_name: "Sprint 2", revision: task.revision + 1 });
    const detail = (await callTool(key, "get_card", { cardId: subtask.id })).value.card;
    expect(detail).toMatchObject({ sprint_id: next, sprint_name: "Sprint 2" });

    const titles = async (sprint: string) => ((await callTool(key, "list_cards", { boardId, sprint })).value.cards as Array<{ title: string }>).map((card) => card.title).sort();
    expect(await titles("current")).toEqual(["From a routine", "Shipped"]);
    expect(await titles("next")).toEqual(["Checkout", "Form"]);
    expect(await titles(next)).toEqual(["Checkout", "Form"]);
    expect(await titles("none")).toEqual(["Idea"]);
    expect((await callTool(key, "list_cards", { boardId })).value.board).toMatchObject({ sprints_enabled: true, sprint_defaults: { days: 14, start: "next", name_pattern: "Sprint {n}" } });
    expect((await callTool(key, "list_cards", { boardId, sprint: "later" })).isError).toBe(true);

    const queried = (await callTool(key, "query_cards", { filter: `board:${boardId} sprint:next` })).value;
    expect(queried.cards.map((card: { title: string }) => card.title).sort()).toEqual(["Checkout", "Form"]);
    expect(queried.cards.find((card: { title: string }) => card.title === "Form")).toMatchObject({ sprint_id: next, sprint_name: "Sprint 2" });
    // Wave 19 adds create_sprint and start_sprint (owner only); completing a sprint stays in the app (D178 dropped).
    expect((await toolNames(key)).filter((name) => /sprint/.test(name))).toEqual(["create_sprint", "list_sprints", "start_sprint"]);
  });

  test("get_card comments carry reactions with glyphs and without names; no reaction tool exists (Wave 20, D189)", async () => {
    const s = await setup("MCP reactions");
    const comment = (await api(s.owner, "POST", `/cards/${s.cardId}/comments`, { body: "Looks good" })).body.comment as { id: string };
    for (const [session, emoji] of [[s.owner, "thumbs_up"], [s.member, "thumbs_up"], [s.member, "eyes"]] as const) {
      expect((await request(`/tasks/comments/${comment.id}/reactions/${emoji}`, { method: "PUT", body: "" }, session)).status).toBe(200);
    }
    const key = makeKey(s.member, ["tasks:read", "tasks:write"]);
    const detail = (await callTool(key, "get_card", { cardId: s.cardId })).value;
    const reactions = detail.comments.find((item: { id: string }) => item.id === comment.id).reactions as Array<Record<string, unknown>>;
    expect(reactions.map((item) => item.emoji).sort()).toEqual(["eyes", "thumbs_up"]);
    expect(reactions.find((item) => item.emoji === "thumbs_up")).toEqual({ emoji: "thumbs_up", glyph: "👍", count: 2, reacted: true });
    expect(JSON.stringify(reactions)).not.toContain("MCP reactions owner");
    for (const item of reactions) expect(Object.keys(item).sort()).toEqual(["count", "emoji", "glyph", "reacted"]);
    expect((await toolNames(key)).filter((name) => /react|emoji/.test(name))).toEqual([]);
  });
});
