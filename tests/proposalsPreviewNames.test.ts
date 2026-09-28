import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { createMcpApiKey } = await import("../server/mcp");
const { resetMcpLimits } = await import("../server/mcpRateLimit");

/**
 * Review L4: a proposal preview names assignees only when they could be assigned on the board
 * (active and able to open it). An agent cannot use a payload to learn a stranger's or a blocked
 * account's display name; those show "Unknown person".
 */

beforeEach(() => resetMcpLimits());

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

async function submit(token: string, proposals: unknown[]) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_proposals", arguments: { proposals } } })
  });
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return JSON.parse(JSON.parse(json).result.content[0].text).results as Array<{ proposalId: string }>;
}

describe("proposal previews and people (L4)", () => {
  test("only board readers resolve to names; strangers and blocked members are Unknown person", async () => {
    const owner = await createUser("Preview Owner");
    const member = await createUser("Preview Member");
    const blocked = await createUser("Preview Blocked Member");
    const stranger = await createUser("Preview Stranger");
    const board = await api(owner, "POST", "/tasks/boards", { name: "Home" });
    const boardId = board.body.board.id as string;
    const timestamp = new Date().toISOString();
    db.query("UPDATE boards SET visibility = 'selected' WHERE id = ?").run(boardId);
    for (const person of [member, blocked]) db.query("INSERT INTO board_members (board_id, user_id, created_at) VALUES (?, ?, ?)").run(boardId, person.userId, timestamp);
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(timestamp, blocked.userId);

    const key = createMcpApiKey(owner.userId, "laptop", ["inbox:write", "tasks:read"]);
    const [item] = await submit(key.token, [{
      kind: "card_create", title: "Card",
      payload: { boardId, columnId: board.body.columns[0].id, title: "Pay rent", assigneeIds: [owner.userId, member.userId, blocked.userId, stranger.userId, crypto.randomUUID()] }
    }]);
    const preview = (await api(owner, "GET", `/inbox/proposals/${item!.proposalId}`)).body.proposal.preview as { fields: Array<{ name: string; after: string | null }> };
    const assignees = preview.fields.find((field) => field.name === "Assignees")!;
    expect(assignees.after).toBe("Preview Owner, Preview Member, Unknown person, Unknown person, Unknown person");
    const all = JSON.stringify(preview);
    for (const hidden of ["Preview Stranger", "Preview Blocked Member"]) expect(all).not.toContain(hidden);
  });
});
