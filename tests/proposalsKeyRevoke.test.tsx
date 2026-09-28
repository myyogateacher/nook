import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { ProposalCard } from "../src/inbox/InboxApp";
import { failureText, statusLabel } from "../src/inbox/inboxFormat";
import type { ProposalSummary } from "../src/inbox/inboxApi";

const { createMcpApiKey } = await import("../server/mcp");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
type McpScope = import("../server/mcpScopes").McpScope;

/**
 * Review M1: revoking an MCP key supersedes its pending proposals (KEY_REVOKED), a note draft it
 * wrote stays in the note, and approve refuses any pending remnant of a revoked key with 409.
 */

beforeEach(() => resetMcpLimits());

type Key = { id: string; token: string };
const makeKey = (session: Session, scopes: McpScope[], name = "laptop"): Key => {
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
  const body = JSON.parse(json) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
  return { isError: body.result!.isError === true, value: JSON.parse(body.result!.content![0]!.text) as Record<string, any> };
}

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

const status = (id: string) => db.query("SELECT status, result_code FROM proposals WHERE id = ?").get(id) as { status: string; result_code: string | null };

describe("revoking a key resolves its proposals (M1)", () => {
  test("pending proposals become superseded KEY_REVOKED; the note draft stays; another key's are untouched", async () => {
    const owner = await createUser("Revoke owner");
    const created = await api(owner, "POST", "/notes", {});
    const noteId = created.body.note.id as string;
    const saved = await api(owner, "PUT", `/notes/${noteId}/draft`, { markdown: "Base", revision: created.body.note.draft_revision });
    await api(owner, "POST", `/notes/${noteId}/publish`, { revision: saved.body.revision });
    const board = await api(owner, "POST", "/tasks/boards", { name: "Home" });
    const key = makeKey(owner, ["inbox:write", "tasks:read", "notes:write-draft"]);
    const other = makeKey(owner, ["inbox:write", "tasks:read"], "other");
    const payload = { boardId: board.body.board.id, columnId: board.body.columns[0].id, title: "Pay rent" };
    const [card] = (await callTool(key, "submit_proposals", { proposals: [{ kind: "card_create", title: "Card", payload }] })).value.results;
    const [draft] = (await callTool(key, "submit_proposals", { proposals: [{ kind: "note_draft", title: "Draft", payload: { noteId, markdown: "Agent text", baseRevision: null } }] })).value.results;
    const [kept] = (await callTool(other, "submit_proposals", { proposals: [{ kind: "card_create", title: "Other", payload }] })).value.results;

    expect((await api(owner, "DELETE", `/mcp/keys/${key.id}`)).status).toBe(200);
    expect(status(card.proposalId)).toEqual({ status: "superseded", result_code: "KEY_REVOKED" });
    expect(status(draft.proposalId)).toEqual({ status: "superseded", result_code: "KEY_REVOKED" });
    expect(status(kept.proposalId)).toEqual({ status: "pending", result_code: null });
    expect((await api(owner, "GET", `/notes/${noteId}`)).body.note.markdown).toBe("Agent text");
    const approve = await api(owner, "POST", `/inbox/proposals/${card.proposalId}/approve`, {});
    expect(approve.status).toBe(409);
    expect(approve.body.code).toBe("NOT_PENDING");
    const revokeAudit = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'mcp.key_revoked' ORDER BY rowid DESC LIMIT 1").get() as { metadata_json: string };
    expect(JSON.parse(revokeAudit.metadata_json)).toEqual({ keyId: key.id, proposalsSuperseded: 2 });
  });

  test("approve refuses a pending remnant of a revoked key with 409 KEY_REVOKED, alone or in bulk", async () => {
    const owner = await createUser("Revoke remnant");
    const board = await api(owner, "POST", "/tasks/boards", { name: "Home" });
    const key = makeKey(owner, ["inbox:write", "tasks:read"]);
    const payload = { boardId: board.body.board.id, columnId: board.body.columns[0].id, title: "Pay rent" };
    const [one, two] = (await callTool(key, "submit_proposals", { proposals: [{ kind: "card_create", title: "A", payload }, { kind: "card_create", title: "B", payload }] })).value.results;
    // A revoke from before this fix left its proposals pending.
    db.query("UPDATE mcp_api_keys SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), key.id);
    const approve = await api(owner, "POST", `/inbox/proposals/${one.proposalId}/approve`, {});
    expect(approve.status).toBe(409);
    expect(approve.body).toMatchObject({ code: "KEY_REVOKED", status: "superseded" });
    expect(status(one.proposalId)).toEqual({ status: "superseded", result_code: "KEY_REVOKED" });
    const bulk = await api(owner, "POST", "/inbox/proposals/bulk", { action: "approve", ids: [two.proposalId] });
    expect(bulk.body.results).toEqual([{ id: two.proposalId, status: "superseded", code: "KEY_REVOKED", error: "The key that suggested this change was revoked" }]);
    expect((db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ?").get(board.body.board.id) as { count: number }).count).toBe(0);
  });

  test("the Inbox labels such cards Key revoked", () => {
    expect(statusLabel("superseded", "KEY_REVOKED")).toBe("Key revoked");
    expect(statusLabel("superseded", "NEWER_DRAFT")).toBe("Replaced by a newer draft");
    expect(failureText("KEY_REVOKED")).toBe("The key that suggested this was revoked (KEY_REVOKED). Nothing was applied.");
    const item: ProposalSummary = {
      id: crypto.randomUUID(), kind: "card_create", kindLabel: "Create card", title: "Pay rent", rationale: null, status: "superseded", targetLabel: "Home", restricted: false,
      targetHref: null, digest: "New card", keyName: "laptop", createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), resolvedAt: new Date().toISOString(),
      resultCode: "KEY_REVOKED", rejectReason: null, ref: null
    };
    const noop = () => undefined;
    expect(renderToStaticMarkup(<ProposalCard item={item} selected={false} busy={false} canApprove onOpen={noop} onApprove={noop} onReject={noop} />)).toContain(">Key revoked</span>");
  });
});
