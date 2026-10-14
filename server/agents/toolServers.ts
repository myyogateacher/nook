import { createHash } from "node:crypto";
import { audit, db, now } from "../db";
import { AGENT_BOUNDS, type CatalogTool, type ServerAuthKind, type ServerAvailability, type ServerStatus, type ToolPolicy, type ToolServerSummary } from "../../shared/agents";
import { checkSavedEndpoint, EgressError } from "./egress";
import { describeMcpError, McpHttpTransport, McpSession, type McpToolInfo } from "./mcpClient";
import { openSecret, sealSecret, secretHint, shownHint } from "./secrets";
import { AgentError } from "./status";
import { declaredStdioServer, McpStdioTransport, stdioEnabled } from "./stdio";
import { logger } from "../log";

const slog = logger("agents");

/**
 * Tool servers (plan §4.1, D349; Wave 41 AC-B): admin-configured MCP servers over Streamable HTTP
 * (or a host-declared stdio server, server/agents/stdio.ts). The credential (bearer token or a
 * custom header's value) is write-only (D354): reads return `hasSecret` and `hint`, and the
 * plaintext is opened only to build one request's headers. **Sync** lists the server's tools into
 * `tools_json` and seeds `agent_tool_policies` for new tools: `auto` only when the server says
 * `readOnlyHint: true`, `confirm` otherwise; annotations never loosen a policy an admin set.
 * Deleting a server removes its policies and the agents' picks by cascade (no Bin, as for providers).
 */

export type ToolServerRow = {
  id: string; slug: string; name: string; transport: "http" | "stdio"; url: string | null; stdio_id: string | null; auth_kind: ServerAuthKind; auth_header: string | null;
  secret_ct: string | null; secret_hint: string | null; timeout_ms: number; result_cap_bytes: number; visibility: "private" | "selected" | "all_users"; enabled: number;
  status: string; last_error: string | null; tools_json: string; tools_synced_at: string | null; revision: number; created_at: string; updated_at: string;
};

export type StoredTool = Omit<CatalogTool, "policy">;

/** A tool name Nook keeps from a server (review L7). */
export const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

export function parseTools(json: string): StoredTool[] {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is StoredTool => !!item && typeof item === "object" && typeof (item as StoredTool).name === "string" && TOOL_NAME.test((item as StoredTool).name)).map((item) => ({
      name: item.name, title: typeof item.title === "string" ? item.title : null, description: typeof item.description === "string" ? item.description : "",
      inputSchema: item.inputSchema && typeof item.inputSchema === "object" ? item.inputSchema : { type: "object" },
      readOnly: item.readOnly === true, openWorld: item.openWorld !== false, destructive: item.destructive === true
    }));
  } catch {
    return [];
  }
}

const availabilityOf = (visibility: ToolServerRow["visibility"]): ServerAvailability => visibility === "all_users" ? "all" : "admins";
const visibilityOf = (availability: ServerAvailability): ToolServerRow["visibility"] => availability === "all" ? "all_users" : "private";
const statusOf = (value: string): ServerStatus => (["unknown", "ok", "auth_failed", "unreachable", "error"] as const).find((item) => item === value) ?? "unknown";

/** The admin policy of every tool of a server (seeded by Sync). */
export function serverPolicies(serverId: string): Map<string, ToolPolicy> {
  const rows = db.query("SELECT tool_name, policy FROM agent_tool_policies WHERE server_id = ?").all(serverId) as Array<{ tool_name: string; policy: ToolPolicy }>;
  return new Map(rows.map((row) => [row.tool_name, row.policy]));
}

/** The default policy of a tool the admin has not decided on (D349): auto only for a declared read-only tool. */
export const defaultPolicy = (tool: Pick<StoredTool, "readOnly">): ToolPolicy => tool.readOnly ? "auto" : "confirm";

export function toolsWithPolicies(row: ToolServerRow): CatalogTool[] {
  const policies = serverPolicies(row.id);
  return parseTools(row.tools_json).map((tool) => ({ ...tool, policy: policies.get(tool.name) ?? defaultPolicy(tool) }));
}

export const serverSummary = (row: ToolServerRow): ToolServerSummary => ({
  id: row.id, slug: row.slug, name: row.name, transport: row.transport, url: row.url, stdioId: row.stdio_id, authKind: row.auth_kind, authHeader: row.auth_header,
  hasSecret: row.secret_ct !== null, hint: shownHint(row.secret_ct, row.secret_hint), timeoutMs: row.timeout_ms, resultCapBytes: row.result_cap_bytes,
  availability: availabilityOf(row.visibility), enabled: row.enabled === 1, status: statusOf(row.status), lastError: row.last_error, tools: toolsWithPolicies(row),
  toolsSyncedAt: row.tools_synced_at, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at
});

export function listServers(): ToolServerSummary[] {
  return (db.query("SELECT * FROM agent_tool_servers ORDER BY created_at").all() as ToolServerRow[]).map(serverSummary);
}

export function serverRow(id: string): ToolServerRow {
  const row = db.query("SELECT * FROM agent_tool_servers WHERE id = ?").get(id) as ToolServerRow | null;
  if (!row) throw new AgentError(404, "NOT_FOUND", "Not found");
  return row;
}

export const serverRowOrNull = (id: string) => db.query("SELECT * FROM agent_tool_servers WHERE id = ?").get(id) as ToolServerRow | null;

/** The servers whose tools a person may attach and run (plan §4.1 availability): admins see all; others the enabled ones open to everyone. */
export function serversAvailableTo(role: string): ToolServerRow[] {
  const rows = db.query("SELECT * FROM agent_tool_servers ORDER BY created_at").all() as ToolServerRow[];
  return role === "admin" ? rows : rows.filter((row) => row.enabled === 1 && row.visibility === "all_users");
}

export const serverAvailableTo = (row: ToolServerRow, role: string) => role === "admin" || (row.enabled === 1 && row.visibility === "all_users");

export type ToolServerInput = {
  name: string; slug?: string; url?: string | null; stdioId?: string | null; authKind?: ServerAuthKind; authHeader?: string | null; secret?: string | null;
  timeoutMs?: number; resultCapBytes?: number; availability?: ServerAvailability; enabled?: boolean;
};

const SLUG = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const RESERVED_SLUGS = new Set(["nook", "mynotes", "system", "user", "assistant", "tool", "tools", "function", "functions", "admin", "mcp", "agent", "agents"]);
/**
 * Custom credential header names are an allowlist (review L6): `X-…` names or `Authorization`.
 * Hop-by-hop, proxy, and identity headers are refused even when they would match.
 */
const HEADER_NAME = /^X-[A-Za-z0-9-]{1,60}$/i;
const REFUSED_HEADER = /^(x-forwarded-.*|x-real-ip|proxy-authorization|origin|host|cookie)$/i;
export const headerNameAllowed = (name: string) => (name.toLowerCase() === "authorization" || HEADER_NAME.test(name)) && !REFUSED_HEADER.test(name);

function slugFrom(name: string, explicit?: string) {
  const candidate = (explicit ?? name).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, AGENT_BOUNDS.serverSlug);
  if (!SLUG.test(candidate)) throw new AgentError(400, "INVALID", "The slug must be 1-24 characters of a-z, 0-9, hyphens, and underscores", { field: "slug" });
  // `nook` names Nook's own tools to the model (`nook__…`); the others are roles or machinery (Wave 41 QA L6).
  if (RESERVED_SLUGS.has(candidate)) {
    if (explicit !== undefined) throw new AgentError(400, "INVALID", `The slug "${candidate}" is reserved; pick another`, { field: "slug" });
    return `${candidate}-srv`;
  }
  return candidate;
}

/** Save-time checks (Wave 41 QA Q1): the providers' rules, so plain http and private literals need AGENT_ALLOWED_PRIVATE_HOSTS. */
function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (trimmed.length > AGENT_BOUNDS.serverUrl) throw new AgentError(400, "INVALID", "The URL is too long", { field: "url" });
  try {
    checkSavedEndpoint(trimmed);
  } catch (error) {
    if (error instanceof EgressError) throw new AgentError(400, "EGRESS_REFUSED", error.message, { field: "url" });
    throw new AgentError(400, "INVALID", "The URL is not valid", { field: "url" });
  }
  return trimmed;
}

/**
 * A Nook key is never a tool server's credential (Wave 42 review M1, T318): a server holding one
 * could call Nook back and start a run from inside a run, which no in-process guard can see. Refused
 * at save and edit: any word of the value that looks like a Nook key (`mynotes_…`, `nkv_…`), or
 * whose SHA-256 is the hash of any Nook key, live or not.
 *
 * The value is looked at as written and unwrapped, so a wrapped key is caught too: split into words
 * (whitespace, `,;:=`, so `Bearer`, `bearer:`, `BEARER\t\t…` all fall away), each word
 * percent-decoded, and each word decoded as base64 or base64url when that gives printable text (so
 * `Basic base64(user:mynotes_…)` and `Basic base64(mynotes_…:x)` split again into user and key).
 * Unwrapping is bounded: a few layers, a capped number of words.
 */
const NOOK_KEY_SHAPE = /^(mynotes|nkv)_/i;
const UNWRAP_DEPTH = 3;
const UNWRAP_WORDS = 256;

function percentDecoded(word: string) {
  if (!word.includes("%")) return null;
  try {
    const decoded = decodeURIComponent(word);
    return decoded === word ? null : decoded;
  } catch {
    return null;
  }
}

/** The text a base64 or base64url word encodes, when it is printable (a credential, not bytes). */
function base64Decoded(word: string) {
  if (word.length < 8 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(word)) return null;
  const standard = word.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (standard.length % 4 === 1) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(standard, "base64"));
    return /^[\x20-\x7e]+$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Every word a credential value holds, as written and unwrapped (see above). Exported for tests. */
export function credentialWords(secret: string): string[] {
  const seen = new Set<string>();
  const visit = (text: string, depth: number) => {
    const words = [text, ...text.split(/[\s,;:=]+/)].map((word) => word.trim().replace(/^["']+|["']+$/g, "")).filter(Boolean);
    for (const word of words) {
      if (seen.size >= UNWRAP_WORDS) return;
      if (seen.has(word)) continue;
      seen.add(word);
      if (depth >= UNWRAP_DEPTH) continue;
      const percent = percentDecoded(word);
      if (percent) visit(percent, depth + 1);
      const decoded = base64Decoded(word);
      if (decoded) visit(decoded, depth + 1);
    }
  };
  visit(secret, 0);
  return [...seen];
}

export function refuseNookCredential(secret: string | null) {
  if (!secret) return;
  const words = credentialWords(secret);
  const hashes = new Set(words.map((word) => createHash("sha256").update(word).digest("hex")));
  const known = words.some((word) => NOOK_KEY_SHAPE.test(word))
    || db.query("SELECT 1 FROM mcp_api_keys WHERE token_hash IN (SELECT value FROM json_each(?)) LIMIT 1").get(JSON.stringify([...hashes])) !== null;
  if (known) throw new AgentError(400, "NOOK_KEY_REFUSED", "A Nook API key cannot be a tool server's credential: the server could use it to start agent runs from inside a run. Give the server its own credential.", { field: "secret" });
}

function checkAuth(kind: ServerAuthKind, header: string | null | undefined, hasSecret: boolean) {
  if (kind === "header") {
    if (!header || !headerNameAllowed(header)) throw new AgentError(400, "INVALID", "The custom header must be Authorization or an X- header (not X-Forwarded-* or X-Real-IP)", { field: "authHeader" });
  }
  if (kind !== "none" && !hasSecret) throw new AgentError(400, "INVALID", "This authentication kind needs a credential", { field: "secret" });
}

export function createServer(actorId: string, input: ToolServerInput): ToolServerSummary {
  return db.transaction(() => {
    const count = (db.query("SELECT COUNT(*) AS count FROM agent_tool_servers").get() as { count: number }).count;
    if (count >= AGENT_BOUNDS.toolServers) throw new AgentError(409, "LIMIT_REACHED", `At most ${AGENT_BOUNDS.toolServers} tool servers can be configured`);
    const slug = slugFrom(input.name, input.slug);
    if (db.query("SELECT 1 FROM agent_tool_servers WHERE slug = ?").get(slug)) throw new AgentError(409, "NAME_TAKEN", "A server with this slug exists", { field: "slug" });
    const stdioId = input.stdioId?.trim() || null;
    let transport: "http" | "stdio" = "http";
    let url: string | null = null;
    if (stdioId) {
      if (!stdioEnabled() || !declaredStdioServer(stdioId)) throw new AgentError(400, "INVALID", "stdio servers can only be adopted from the host's declaration file (AGENT_MCP_STDIO=on)", { field: "stdioId" });
      if (db.query("SELECT 1 FROM agent_tool_servers WHERE stdio_id = ?").get(stdioId)) throw new AgentError(409, "NAME_TAKEN", "That declared server is already adopted");
      transport = "stdio";
    } else {
      if (!input.url) throw new AgentError(400, "INVALID", "A tool server needs a URL", { field: "url" });
      url = normalizeUrl(input.url);
    }
    const authKind = transport === "stdio" ? "none" : input.authKind ?? "none";
    const secret = input.secret?.trim() || null;
    checkAuth(authKind, input.authHeader, secret !== null);
    refuseNookCredential(secret);
    const id = crypto.randomUUID();
    const timestamp = now();
    db.query(`INSERT INTO agent_tool_servers (id, slug, name, transport, url, stdio_id, auth_kind, auth_header, secret_ct, secret_hint, timeout_ms, result_cap_bytes, visibility, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, slug, input.name.trim(), transport, url, stdioId, authKind, authKind === "header" ? input.authHeader!.trim() : null,
      authKind !== "none" && secret ? sealSecret("server", id, secret) : null, authKind !== "none" && secret ? secretHint(secret) : null,
      input.timeoutMs ?? AGENT_BOUNDS.toolTimeoutMs.default, input.resultCapBytes ?? AGENT_BOUNDS.resultCapBytes.default,
      visibilityOf(input.availability ?? "admins"), input.enabled === false ? 0 : 1, timestamp, timestamp
    );
    audit(actorId, null, "agents.server.create", { serverId: id, transport, hasSecret: secret !== null });
    return serverSummary(serverRow(id));
  })();
}

export function updateServer(actorId: string, id: string, input: Partial<ToolServerInput> & { expectedRevision: number; removeSecret?: boolean }): ToolServerSummary {
  const summary = db.transaction(() => {
    const row = serverRow(id);
    if (row.revision !== input.expectedRevision) throw new AgentError(409, "REVISION_MISMATCH", "This server changed elsewhere; reload and try again", { revision: row.revision });
    const slug = input.slug !== undefined || input.name !== undefined ? slugFrom(input.name ?? row.name, input.slug ?? row.slug) : row.slug;
    if (slug !== row.slug && db.query("SELECT 1 FROM agent_tool_servers WHERE slug = ? AND id <> ?").get(slug, id)) throw new AgentError(409, "NAME_TAKEN", "A server with this slug exists", { field: "slug" });
    const url = row.transport === "http" && input.url !== undefined && input.url !== null ? normalizeUrl(input.url) : row.url;
    const authKind = row.transport === "stdio" ? "none" : input.authKind ?? row.auth_kind;
    const secret = input.secret?.trim() || null;
    const secretCt = input.removeSecret || authKind === "none" ? null : secret ? sealSecret("server", id, secret) : row.secret_ct;
    const hint = secretCt === null ? null : secret ? secretHint(secret) : row.secret_hint;
    const header = authKind === "header" ? (input.authHeader ?? row.auth_header)?.trim() ?? null : null;
    checkAuth(authKind, header, secretCt !== null);
    refuseNookCredential(secret);
    db.query(`UPDATE agent_tool_servers SET slug = ?, name = ?, url = ?, auth_kind = ?, auth_header = ?, secret_ct = ?, secret_hint = ?, timeout_ms = ?, result_cap_bytes = ?, visibility = ?, enabled = ?,
      revision = revision + 1, updated_at = ? WHERE id = ?`).run(
      slug, (input.name ?? row.name).trim(), url, authKind, header, secretCt, hint, input.timeoutMs ?? row.timeout_ms, input.resultCapBytes ?? row.result_cap_bytes,
      input.availability !== undefined ? visibilityOf(input.availability) : row.visibility, input.enabled !== undefined ? (input.enabled ? 1 : 0) : row.enabled, now(), id
    );
    audit(actorId, null, "agents.server.update", { serverId: id, secretChanged: secret !== null || input.removeSecret === true, enabled: input.enabled });
    return serverSummary(serverRow(id));
  })();
  // A changed URL or credential needs a fresh session (the old one is closed, best effort).
  void dropSession(id);
  return summary;
}

export function deleteServer(actorId: string, id: string) {
  db.transaction(() => {
    serverRow(id);
    db.query("DELETE FROM agent_tool_servers WHERE id = ?").run(id);
    audit(actorId, null, "agents.server.delete", { serverId: id });
  })();
  void dropSession(id);
}

/** Admin overrides per tool (PUT …/policies): every named tool must be in the synced catalog. */
export function setPolicies(actorId: string, id: string, policies: Record<string, ToolPolicy>): ToolServerSummary {
  return db.transaction(() => {
    const row = serverRow(id);
    const known = new Set(parseTools(row.tools_json).map((tool) => tool.name));
    const upsert = db.query("INSERT INTO agent_tool_policies (server_id, tool_name, policy) VALUES (?, ?, ?) ON CONFLICT(server_id, tool_name) DO UPDATE SET policy = excluded.policy");
    for (const [name, policy] of Object.entries(policies)) {
      if (!known.has(name)) throw new AgentError(404, "NOT_FOUND", "Not found");
      upsert.run(id, name, policy);
    }
    db.query("UPDATE agent_tool_servers SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now(), id);
    audit(actorId, null, "agents.server.policies", { serverId: id, count: Object.keys(policies).length });
    return serverSummary(serverRow(id));
  })();
}

/** The headers one request carries: the configured credential only (plan §3.2 item 6, T306). */
export function credentialHeaders(row: ToolServerRow): Record<string, string> {
  if (row.auth_kind === "none" || !row.secret_ct) return {};
  const secret = openSecret("server", row.id, row.secret_ct);
  if (row.auth_kind === "bearer") return { Authorization: `Bearer ${secret}` };
  return row.auth_header ? { [row.auth_header]: secret } : {};
}

// --- Sessions: cached per server for 10 minutes of idle time (plan §3.1) -------------------------

const SESSION_IDLE_MS = 10 * 60_000;
const sessions = new Map<string, { session: McpSession; revision: number }>();

function transportFor(row: ToolServerRow) {
  if (row.transport === "stdio") {
    const declaration = stdioEnabled() && row.stdio_id ? declaredStdioServer(row.stdio_id) : null;
    if (!declaration) throw new AgentError(409, "STDIO_UNAVAILABLE", "This stdio server is not declared by the host (AGENT_MCP_STDIO is off or the file no longer lists it)");
    return new McpStdioTransport(declaration, row.timeout_ms);
  }
  return new McpHttpTransport({ url: row.url!, headers: credentialHeaders(row), timeoutMs: row.timeout_ms });
}

/**
 * The session of a server at the row's revision, opened on demand (review M3). The row must be the
 * live one: a row whose revision is no longer current (an edit, a disable, a sync, a delete) never
 * opens or reuses a session, so a stale URL or credential is never used again. A cached session of
 * an older revision is closed.
 */
export function sessionFor(row: ToolServerRow): McpSession {
  const live = serverRowOrNull(row.id);
  if (!live || live.revision !== row.revision) throw new AgentError(409, "TOOL_UNAVAILABLE", "This tool server changed or was removed; the call was not run");
  const cached = sessions.get(row.id);
  if (cached && cached.revision === live.revision && Date.now() - cached.session.lastUsed < SESSION_IDLE_MS) return cached.session;
  if (cached) void cached.session.close().catch(() => undefined);
  const session = new McpSession(transportFor(live), live.name);
  sessions.set(row.id, { session, revision: live.revision });
  return session;
}

export async function dropSession(serverId: string) {
  const cached = sessions.get(serverId);
  sessions.delete(serverId);
  if (cached) await cached.session.close().catch(() => undefined);
}

/** Idle sessions are closed by the hourly sweep (and tests). */
export async function sweepSessions(nowMs = Date.now()) {
  for (const [id, cached] of sessions) if (nowMs - cached.session.lastUsed >= SESSION_IDLE_MS) await dropSession(id);
}

export async function resetToolServersForTests() {
  for (const id of [...sessions.keys()]) await dropSession(id);
}

const storedTool = (tool: McpToolInfo): StoredTool => ({
  name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
  // Safe defaults (D349, [13]): a tool is "not read-only" and "open world" unless the server says otherwise.
  readOnly: tool.annotations.readOnlyHint === true, openWorld: tool.annotations.openWorldHint !== false, destructive: tool.annotations.destructiveHint === true
});

/**
 * Sync (plan §4.1): lists the server's tools, stores the catalog, seeds policies for tools that
 * have none (auto only for read-only tools), and records the status. A failure keeps the previous
 * catalog and stores a URL-free message.
 */
export async function syncServer(actorId: string | null, id: string): Promise<ToolServerSummary> {
  const row = serverRow(id);
  try {
    const listed = await sessionFor(row).listTools();
    // Server-chosen names are validated (review L7): anything outside [A-Za-z0-9_.-]{1,128} is dropped and counted.
    const tools = listed.filter((tool) => TOOL_NAME.test(tool.name)).map(storedTool);
    const droppedTools = listed.length - tools.length;
    if (droppedTools > 0) slog.warn(`Agents: a tool server listed ${droppedTools} ${droppedTools === 1 ? "tool" : "tools"} with an invalid name; ${droppedTools === 1 ? "it was" : "they were"} dropped`);
    const json = JSON.stringify(tools);
    if (json.length > 1_000_000) throw new AgentError(502, "TOO_LARGE", "The tool server lists more tool schema than Nook stores (1 MB)");
    db.transaction(() => {
      const existing = serverPolicies(id);
      const insert = db.query("INSERT INTO agent_tool_policies (server_id, tool_name, policy) VALUES (?, ?, ?) ON CONFLICT(server_id, tool_name) DO NOTHING");
      for (const tool of tools) if (!existing.has(tool.name)) insert.run(id, tool.name, defaultPolicy(tool));
      // Policies of tools the server no longer lists are kept: they bind again if the tool returns.
      db.query("UPDATE agent_tool_servers SET tools_json = ?, tools_synced_at = ?, status = 'ok', last_error = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(json, now(), now(), id);
    })();
    audit(actorId, null, "agents.server.sync", { serverId: id, ok: true, toolCount: tools.length, droppedTools });
  } catch (error) {
    if (error instanceof AgentError && error.code !== "TOO_LARGE") throw error;
    const described = error instanceof AgentError ? { status: "error" as const, message: error.message } : describeMcpError(error);
    db.query("UPDATE agent_tool_servers SET status = ?, last_error = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(described.status, described.message.slice(0, 200), now(), id);
    audit(actorId, null, "agents.server.sync", { serverId: id, ok: false, status: described.status });
    void dropSession(id);
  }
  return serverSummary(serverRow(id));
}
