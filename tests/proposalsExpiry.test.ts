import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { failureText } from "../src/inbox/inboxFormat";

const { createMcpApiKey } = await import("../server/mcp");
const { resetMcpLimits } = await import("../server/mcpRateLimit");

/** Review L1: approve honours expires_at even before the hourly sweep marks the proposal expired. */

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

describe("approve and expiry (L1)", () => {
  test("a proposal past expires_at is refused with 409 EXPIRED, marked expired, and nothing is applied", async () => {
    const owner = await createUser("Expiry owner");
    const board = await api(owner, "POST", "/tasks/boards", { name: "Home" });
    const key = createMcpApiKey(owner.userId, "laptop", ["inbox:write", "tasks:read"]);
    const payload = { boardId: board.body.board.id, columnId: board.body.columns[0].id, title: "Pay rent" };
    const [late, onTime] = await submit(key.token, [{ kind: "card_create", title: "Late", payload }, { kind: "card_create", title: "On time", payload }]);
    db.query("UPDATE proposals SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), late!.proposalId);

    const refused = await api(owner, "POST", `/inbox/proposals/${late!.proposalId}/approve`, {});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "EXPIRED", status: "expired" });
    expect(db.query("SELECT status, resolved_at IS NOT NULL AS resolved FROM proposals WHERE id = ?").get(late!.proposalId)).toEqual({ status: "expired", resolved: 1 });
    expect((db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ?").get(board.body.board.id) as { count: number }).count).toBe(0);
    // A second approve sees the terminal status.
    expect((await api(owner, "POST", `/inbox/proposals/${late!.proposalId}/approve`, {})).body.code).toBe("NOT_PENDING");

    expect((await api(owner, "POST", `/inbox/proposals/${onTime!.proposalId}/approve`, {})).body.status).toBe("applied");
    expect(failureText("EXPIRED")).toBe("This proposal expired (EXPIRED). Nothing was applied.");
  });
});
