import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { createMcpApiKey } = await import("../server/mcp");
const { mcpToolSpecs } = await import("../server/mcpTools");
const { consumeMcpLimits, MCP_LIMITS, MCP_USER_LIMITS, resetMcpLimits } = await import("../server/mcpRateLimit");
const { PENDING_CEILING } = await import("../server/inbox/service");
type McpScope = import("../server/mcpScopes").McpScope;

/**
 * MCP side of the agent inbox (docs/plan/research/2026-09-28-agent-inbox-routines.md §7, D151,
 * D152, T125, T131, T132): scopes, the role filter, per-item results, limits, and the absence of
 * any approve-like tool.
 */

beforeEach(() => resetMcpLimits());

type Key = { id: string; token: string };
const makeKey = (session: Session, scopes: McpScope[], name = "agent"): Key => {
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
  return JSON.parse(json) as { result?: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> }; error?: { message: string } };
}
const toolNames = async (key: Key) => ((await rpc(key, "tools/list")).result!.tools!).map((tool) => tool.name).sort();
async function callTool(key: Key, name: string, args: Record<string, unknown>) {
  const body = await rpc(key, "tools/call", { name, arguments: args });
  if (body.error) return { isError: true, value: { error: body.error.message } as Record<string, any> };
  const text = body.result!.content![0]!.text;
  let value: Record<string, any>;
  try { value = JSON.parse(text); } catch { value = { error: text }; }
  return { isError: body.result!.isError === true, value };
}

async function board(owner: Session) {
  const response = await request("/tasks/boards", { method: "POST", body: JSON.stringify({ name: "Agent board" }) }, owner);
  const body = await response.json() as { board: { id: string }; columns: Array<{ id: string }> };
  return { boardId: body.board.id, columnId: body.columns[0]!.id };
}

const cardProposal = (target: { boardId: string; columnId: string }, title = "Buy filters") => ({ kind: "card_create", title, payload: { ...target, title } });

describe("inbox MCP tools", () => {
  test("no tool approves, applies, or publishes (T125)", () => {
    const inbox = mcpToolSpecs.filter((spec) => spec.scopes.some((scope) => scope.startsWith("inbox:")));
    expect(inbox.map((spec) => spec.name).sort()).toEqual(["list_my_proposals", "submit_proposals", "withdraw_proposal"]);
    // Wave 19 adds exactly one publishing tool, publish_note_draft, under its own opt-in notes:publish
    // scope (D170, T143); no inbox scope reaches it, and nothing approves or applies proposals.
    for (const spec of mcpToolSpecs) {
      const approveLike = /approve|apply/i.test(spec.name) || (/publish/i.test(spec.name) && !(spec.name === "publish_note_draft" && spec.scopes.join() === "notes:publish"));
      expect({ name: spec.name, approveLike }).toEqual({ name: spec.name, approveLike: false });
    }
  });

  test("inbox tools follow the scopes: inbox:write implies inbox:read", async () => {
    const user = await createUser("Inbox scopes");
    expect(await toolNames(makeKey(user, ["inbox:read"]))).toEqual(["list_my_proposals"]);
    expect(await toolNames(makeKey(user, ["inbox:write"]))).toEqual(["list_my_proposals", "submit_proposals", "withdraw_proposal"]);
  });

  test("a kind needs its module read scope, never the write scope; results are per item", async () => {
    const owner = await createUser("Inbox kinds");
    const target = await board(owner);
    const suggestOnly = makeKey(owner, ["inbox:write", "tasks:read"]);
    const noModule = makeKey(owner, ["inbox:write"]);
    const writer = makeKey(owner, ["inbox:write", "tasks:write"]);
    const mixed = await callTool(suggestOnly, "submit_proposals", { proposals: [cardProposal(target), { kind: "event_create", title: "Needs calendar", payload: {} }, cardProposal(target, "Second")] });
    expect(mixed.isError).toBe(false);
    expect(mixed.value.submitted).toBe(2);
    expect(mixed.value.results.map((result: Record<string, string>) => result.status ?? result.code)).toEqual(["pending", "SCOPE_REQUIRED", "pending"]);
    expect((await callTool(noModule, "submit_proposals", { proposals: [cardProposal(target)] })).value.results[0].code).toBe("SCOPE_REQUIRED");
    // tasks:write implies tasks:read, so a writer key may also suggest.
    expect((await callTool(writer, "submit_proposals", { proposals: [cardProposal(target)] })).value.results[0].status).toBe("pending");
    // A read-only key with inbox:write changes nothing by itself.
    expect((db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ?").get(target.boardId) as { count: number }).count).toBe(0);
    // More than 20 items is refused as a whole.
    const many = await callTool(suggestOnly, "submit_proposals", { proposals: Array.from({ length: 21 }, () => cardProposal(target)) });
    expect(many.isError).toBe(true);
    expect((db.query("SELECT COUNT(*) AS count FROM proposals WHERE owner_id = ?").get(owner.userId) as { count: number }).count).toBe(3);
  });

  test("viewers and guests get no inbox scopes, so a viewer key cannot submit (D152, T132)", async () => {
    const owner = await createUser("Inbox demoted");
    const target = await board(owner);
    const key = makeKey(owner, ["inbox:write", "tasks:read"]);
    const submitted = (await callTool(key, "submit_proposals", { proposals: [cardProposal(target)] })).value.results[0];
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(owner.userId);
    expect(await toolNames(key)).not.toContain("submit_proposals");
    const refused = await callTool(key, "submit_proposals", { proposals: [cardProposal(target)] });
    expect(refused.isError).toBe(true);
    expect(refused.value.code ?? refused.value.error).toBeTruthy();
    expect((db.query("SELECT COUNT(*) AS count FROM proposals WHERE owner_id = ?").get(owner.userId) as { count: number }).count).toBe(1);
    // The demoted owner may still reject what is pending, but not approve it.
    const approve = await request(`/inbox/proposals/${submitted.proposalId}/approve`, { method: "POST", body: "{}" }, owner);
    expect(approve.status).toBe(403);
    expect(((await approve.json()) as { code: string }).code).toBe("ROLE_READ_ONLY");
    const bulk = await request("/inbox/proposals/bulk", { method: "POST", body: JSON.stringify({ action: "approve", ids: [submitted.proposalId] }) }, owner);
    expect(bulk.status).toBe(403);
    const reject = await request(`/inbox/proposals/${submitted.proposalId}/reject`, { method: "POST", body: "{}" }, owner);
    expect(reject.status).toBe(200);
    // A viewer cannot create a key with inbox scopes.
    const created = await request("/mcp/keys", { method: "POST", body: JSON.stringify({ name: "v", scopes: ["inbox:read"], password: owner.password }) }, owner);
    expect(created.status).toBe(403);
    // Guests see no inbox at all.
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(owner.userId);
    expect((await request("/inbox/proposals", {}, owner)).status).toBe(404);
    expect((await request("/inbox/count", {}, owner)).status).toBe(404);
    expect((await request(`/inbox/proposals/${submitted.proposalId}/reject`, { method: "POST", body: "{}" }, owner)).status).toBe(403);
  });

  test("proposal_write is limited per key and per user; 500 pending gives LIMIT_REACHED", async () => {
    expect(MCP_LIMITS.proposal_write.limit).toBe(200);
    expect(MCP_USER_LIMITS.proposal_write!.limit).toBe(400);
    const owner = await createUser("Inbox limits");
    const target = await board(owner);
    const key = makeKey(owner, ["inbox:write", "tasks:read"]);
    for (let index = 0; index < 199; index += 1) consumeMcpLimits({ keyId: key.id, userId: owner.userId }, ["proposal_write"]);
    const results = (await callTool(key, "submit_proposals", { proposals: [cardProposal(target), cardProposal(target)] })).value.results;
    expect(results.map((result: Record<string, string>) => result.status ?? result.code)).toEqual(["pending", "RATE_LIMITED"]);
    // Per user, across keys.
    const second = makeKey(owner, ["inbox:write", "tasks:read"], "second");
    for (let index = 0; index < 200; index += 1) consumeMcpLimits({ keyId: crypto.randomUUID(), userId: owner.userId }, ["proposal_write"]);
    expect((await callTool(second, "submit_proposals", { proposals: [cardProposal(target)] })).value.results[0].code).toBe("RATE_LIMITED");

    resetMcpLimits();
    const insert = db.query(`INSERT INTO proposals (id, owner_id, key_id, key_name, kind, target_type, target_id, title, payload, created_at, expires_at)
      VALUES (?, ?, ?, 'agent', 'card_create', 'board', ?, 'Filler', '{}', ?, ?)`);
    const timestamp = new Date().toISOString();
    const later = new Date(Date.now() + 86_400_000).toISOString();
    db.transaction(() => { for (let index = 0; index < PENDING_CEILING; index += 1) insert.run(crypto.randomUUID(), owner.userId, key.id, target.boardId, timestamp, later); })();
    expect((await callTool(key, "submit_proposals", { proposals: [cardProposal(target)] })).value.results[0].code).toBe("LIMIT_REACHED");
    db.query("DELETE FROM proposals WHERE owner_id = ? AND title = 'Filler'").run(owner.userId);
  });

  test("list_my_proposals shows only the calling key's proposals (T131)", async () => {
    const owner = await createUser("Inbox own list");
    const target = await board(owner);
    const first = makeKey(owner, ["inbox:write", "tasks:read"], "first");
    const second = makeKey(owner, ["inbox:write", "tasks:read"], "second");
    await callTool(first, "submit_proposals", { proposals: [cardProposal(target, "From first")] });
    await callTool(second, "submit_proposals", { proposals: [cardProposal(target, "From second")] });
    const listed = await callTool(second, "list_my_proposals", {});
    expect(listed.value.proposals.map((item: { title: string }) => item.title)).toEqual(["From second"]);
    expect(Object.keys(listed.value.proposals[0]).sort()).toEqual(["createdAt", "expiresAt", "id", "kind", "rejectReason", "resolvedAt", "resultCode", "status", "title"]);
  });
});
