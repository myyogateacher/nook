/**
 * Small MCP client helpers for the Wave 19 write-coverage tests: keys with exact scopes, tools/list
 * over Streamable HTTP, and tool calls through the handler (runTool, so scope, role, and rate
 * checks all apply).
 */
import { expect } from "bun:test";
import { db, origin, request, type Session } from "./harness";

const { createMcpApiKey } = await import("../../server/mcp");
const { invokeMcpToolForTests } = await import("../../server/mcpTools");
type McpScope = import("../../server/mcpScopes").McpScope;

export type Key = { id: string; token: string; userId: string };

/** A key storing exactly `scopes` (implied reads are added when the key is read, as for real keys). */
export function makeKey(session: Session, scopes: McpScope[], name = "Agent"): Key {
  const key = createMcpApiKey(session.userId, name);
  db.query("UPDATE mcp_api_keys SET scopes = ? WHERE id = ?").run(JSON.stringify(scopes), key.id);
  return { id: key.id, token: key.token, userId: session.userId };
}

let rpcId = 0;
export async function rpc(key: Key, method: string, params: unknown = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  return JSON.parse(json) as { result?: { tools?: Array<{ name: string; description: string }> } };
}

/** The key's listed tools. A key with no tools at all (for example `bin:write` alone) has no tools capability. */
export const toolNames = async (key: Key) => ((await rpc(key, "tools/list")).result?.tools ?? []).map((tool) => tool.name).sort();

export type Outcome = { isError: boolean; value: Record<string, any> };

/** Calls a tool through runTool, as tools/call does. */
export async function call(key: Key, name: string, args: Record<string, unknown> = {}): Promise<Outcome> {
  const result = await invokeMcpToolForTests(name, args, key.id);
  return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

/** Calls a tool and expects success. */
export async function ok(key: Key, name: string, args: Record<string, unknown> = {}) {
  const outcome = await call(key, name, args);
  if (outcome.isError) throw new Error(`${name} failed: ${JSON.stringify(outcome.value)}`);
  return outcome.value;
}

/** Calls a tool and returns its error code. */
export async function errorCode(key: Key, name: string, args: Record<string, unknown> = {}) {
  const outcome = await call(key, name, args);
  expect(outcome.isError).toBe(true);
  return outcome.value.code as string;
}

export async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

export const auditRows = (actorId: string, eventType: string) =>
  (db.query("SELECT note_id, metadata_json FROM audit_log WHERE actor_id = ? AND event_type = ? ORDER BY created_at").all(actorId, eventType) as Array<{ note_id: string | null; metadata_json: string | null }>)
    .map((row) => ({ noteId: row.note_id, ...(row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : {}) }));
