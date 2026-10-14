import { audit, db, now } from "../db";
import { ensureInternalAgentKey, internalAgentKeyRevoked, keyHoldsAgentRun, listApiKeys, ownApiKey } from "../apiKeys";
import { hasScope } from "../mcpScopes";
import { loadLiveKey, type McpKeyContext } from "../mcpTools";
import type { AgentToolPolicy, AgentToolRef, LinkableKey, LinkState, NookAutoState, NookLink, ToolCatalog, ToolPolicy } from "../../shared/agents";
import type { AgentRow } from "./agentsService";
import { missingNookScope, nookCatalogFor, nookToolSpec, nookToolsFor, offeredSpecs, type NookResolved } from "./nookBridge";
import { readAgentSettings, roleMayChat } from "./settings";
import { shareLevel } from "./sharing";
import { AgentError } from "./status";
import { defaultPolicy, parseTools, serverAvailableTo, serverPolicies, serverRowOrNull, serversAvailableTo, type ToolServerRow } from "./toolServers";
import { KNOWLEDGE_TOOL } from "../../shared/knowledge";
import { knowledgeToolDescription, knowledgeToolParameters, liveAttachedBases, type KnowledgeToolSpec } from "../knowledge/tool";
import { listKnowledge, manageableKbIds, viewableKbIds } from "../knowledge/service";

/**
 * An agent's tools (plan §5.2, §5.3, D358, D359; Wave 41 AC-B): the picks in `agent_tools`, the
 * runner's linked Nook key in `agent_user_links`, the catalog the picker shows, and the per-step
 * resolution of what the model may call right now. Rights are live (T81): a server that was
 * disabled, a policy set to `off`, or a key that was revoked drops its tools at the next step.
 *
 * Model-facing names are `<slug>__<tool>` (Nook: `nook__<tool>`), `[A-Za-z0-9_-]`, at most 64
 * characters, unique per agent; the resolved list maps them back.
 */

export type ResolvedTool = {
  modelName: string;
  /** AC-E: `knowledge` is the one `search_knowledge` tool over the agent's attached bases. */
  kind: "server" | "nook" | "knowledge";
  serverId: string | null;
  /** The slug (servers) or "nook". */
  server: string;
  serverName: string;
  toolName: string;
  description: string;
  parameters: Record<string, unknown>;
  policy: Exclude<ToolPolicy, "off">;
  openWorld: boolean;
  resultCapBytes: number;
  timeoutMs: number;
  serverRow: ToolServerRow | null;
  nook: NookResolved | null;
  knowledge: KnowledgeToolSpec | null;
};

type ToolRow = { agent_id: string; source: "server" | "nook" | "knowledge"; server_id: string | null; tool_name: string | null; kb_id: string | null; policy: AgentToolPolicy };

export function agentToolRefs(agentId: string): AgentToolRef[] {
  const rows = db.query("SELECT * FROM agent_tools WHERE agent_id = ? ORDER BY source, server_id, tool_name").all(agentId) as ToolRow[];
  const refs: AgentToolRef[] = [];
  for (const row of rows) {
    if (row.source === "server" && row.server_id && row.tool_name) refs.push({ source: "server", serverId: row.server_id, toolName: row.tool_name, policy: row.policy });
    else if (row.source === "nook" && row.tool_name) refs.push({ source: "nook", toolName: row.tool_name });
    else if (row.source === "knowledge" && row.kb_id) refs.push({ source: "knowledge", kbId: row.kb_id });
  }
  return refs;
}

export const refKeyOf = (ref: AgentToolRef) => ref.source === "server" ? `server:${ref.serverId}:${ref.toolName}` : ref.source === "nook" ? `nook:${ref.toolName}` : `knowledge:${ref.kbId}`;

/**
 * Replaces the agent's picks (PATCH `tools`): every server tool must exist in a catalog the editor may
 * see; every Nook tool must be offered; every new knowledge base pick (AC-E) must be one both the
 * editor and the agent's owner own or manage (Wave 44 fixes, M4, operator 2026-10-06: view is search
 * and Try it only). A view-only editor gets 403 `KB_MANAGE_REQUIRED`; a base they cannot open, 400.
 */
export function setAgentTools(agentId: string, role: string, submitted: AgentToolRef[], options: { keepHidden?: boolean; userId?: string } = {}) {
  const visible = new Map(serversAvailableTo(role).map((row) => [row.id, new Set(parseTools(row.tools_json).map((tool) => tool.name))]));
  const nook = new Set(nookCatalogFor(null).map((tool) => tool.name));
  // Wave 43 (AC-D): a manager may not see every server the owner picked from; picks already on the
  // agent stay valid as they are (only new picks must come from the editor's own catalog).
  const all = agentToolRefs(agentId);
  const current = all.filter((ref): ref is Extract<AgentToolRef, { source: "server" }> => ref.source === "server");
  const currentKbs = all.filter((ref): ref is Extract<AgentToolRef, { source: "knowledge" }> => ref.source === "knowledge");
  const kept = new Set([...current, ...currentKbs].map(refKeyOf));
  // AC-E: the bases named; new picks need the editor and the owner to own or manage them (M4); a manager's hidden ones stay.
  const ownerId = (db.query("SELECT owner_id FROM agents WHERE id = ?").get(agentId) as { owner_id: string } | null)?.owner_id ?? null;
  const named = [...new Set([...submitted, ...currentKbs].flatMap((ref) => ref.source === "knowledge" ? [ref.kbId] : []))];
  const editorViews = options.userId ? viewableKbIds(options.userId, named) : new Set(named);
  const editorKbs = options.userId ? manageableKbIds(options.userId, named) : new Set(named);
  const ownerKbs = ownerId ? manageableKbIds(ownerId, named) : new Set<string>();
  // Review L2: a manager's view withholds picks from servers they cannot use, so their save re-merges them (AC-E: and bases they cannot open).
  const submittedKeys = new Set(submitted.map(refKeyOf));
  const hidden = options.keepHidden ? [
    ...current.filter((ref) => !visible.has(ref.serverId) && !submittedKeys.has(refKeyOf(ref))),
    ...currentKbs.filter((ref) => !editorKbs.has(ref.kbId) && !submittedKeys.has(refKeyOf(ref)))
  ] : [];
  const refs = [...submitted, ...hidden];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = refKeyOf(ref);
    if (seen.has(key)) throw new AgentError(400, "INVALID", "A tool is listed twice", { field: "tools" });
    seen.add(key);
    if (ref.source === "server" && !kept.has(key) && !visible.get(ref.serverId)?.has(ref.toolName)) throw new AgentError(400, "INVALID", "A picked tool is not in a server you can use", { field: "tools" });
    if (ref.source === "nook" && !nook.has(ref.toolName)) throw new AgentError(400, "INVALID", "A picked Nook tool is not offered to agents", { field: "tools" });
    if (ref.source === "knowledge" && !kept.has(key)) {
      if (!editorViews.has(ref.kbId)) throw new AgentError(400, "INVALID", "A picked knowledge base is not one you can open", { field: "tools" });
      if (!editorKbs.has(ref.kbId)) throw new AgentError(403, "KB_MANAGE_REQUIRED", "You can search this knowledge base, but attaching it to an agent needs Manage", { field: "tools" });
      if (!ownerKbs.has(ref.kbId)) throw new AgentError(403, "KB_MANAGE_REQUIRED", "The agent's owner must own or manage a knowledge base to attach it; ask its owner to make them a manager", { field: "tools" });
    }
  }
  db.query("DELETE FROM agent_tools WHERE agent_id = ?").run(agentId);
  const insert = db.query("INSERT INTO agent_tools (agent_id, source, server_id, tool_name, kb_id, policy) VALUES (?, ?, ?, ?, ?, ?)");
  for (const ref of refs) {
    if (ref.source === "server") insert.run(agentId, "server", ref.serverId, ref.toolName, null, ref.policy);
    else if (ref.source === "nook") insert.run(agentId, "nook", null, ref.toolName, null, null);
    else insert.run(agentId, "knowledge", null, null, ref.kbId, null);
  }
}

// --- Links (plan §5.3, D359): a pointer to one of the runner's own keys, never a token ---------------

type LinkRow = { agent_id: string; user_id: string; nook_key_id: string | null; pinned: number };

export function linkRow(agentId: string, userId: string): LinkRow | null {
  return db.query("SELECT * FROM agent_user_links WHERE agent_id = ? AND user_id = ?").get(agentId, userId) as LinkRow | null;
}

/** Whether a key may be linked: the caller's own live general key with the MCP surface. */
function linkableKey(userId: string, keyId: string) {
  const key = ownApiKey(userId, keyId);
  if (!key || key.internal || key.kind !== "general" || key.surfaces === "rest" || (key.state !== "active" && key.state !== "grace")) return null;
  return key;
}

/** A key that can run agents is never an agent's Nook key (Wave 42 review M1, T318): its tools could start runs. */
const runsAgents = (key: { id: string; grants: ReadonlyArray<{ module: string; permission: string }> }) => key.grants.some((grant) => grant.module === "agents" && grant.permission === "run");

const linkable = (key: ReturnType<typeof listApiKeys>["keys"][number]): LinkableKey => ({
  id: key.id, name: key.name, prefix: key.prefix, state: key.state, expiresAt: key.expiresAt,
  grants: key.grants.map((grant) => ({ module: grant.module, permission: grant.permission, resource: grant.resource ? { kind: grant.resource.kind, name: grant.resource.name } : null, active: grant.active }))
});

/** The keys the Link Nook key sheet lists: the caller's own live general keys with the MCP surface. */
export function linkableKeys(userId: string): LinkableKey[] {
  return listApiKeys(userId).keys.filter((key) => !key.internal && key.kind === "general" && key.surfaces !== "rest" && (key.state === "active" || key.state === "grace") && !runsAgents(key)).map(linkable);
}

export function currentLink(agentId: string, userId: string): NookLink {
  const row = linkRow(agentId, userId);
  if (!row?.nook_key_id) return null;
  const key = ownApiKey(userId, row.nook_key_id);
  if (!key) return null;
  return { keyId: key.id, name: key.name, prefix: key.prefix, state: key.state };
}

/** Sets or clears the caller's link on an agent they may use. A key that is not theirs or not live is the same 404. */
export function setLink(userId: string, agentId: string, keyId: string | null): NookLink {
  if (keyId !== null && !linkableKey(userId, keyId)) throw new AgentError(404, "NOT_FOUND", "Not found");
  if (keyId !== null && keyHoldsAgentRun(keyId)) throw new AgentError(409, "KEY_RUNS_AGENTS", "This key can run agents (“Run agents”), so it cannot be an agent's Nook key: the agent's tools could start other runs. Link a key without it.");
  db.query(`INSERT INTO agent_user_links (agent_id, user_id, nook_key_id) VALUES (?, ?, ?)
    ON CONFLICT(agent_id, user_id) DO UPDATE SET nook_key_id = excluded.nook_key_id`).run(agentId, userId, keyId);
  audit(userId, null, keyId ? "agents.link.set" : "agents.link.clear", { agentId, keyId });
  return currentLink(agentId, userId);
}

/**
 * The runner's linked key as it stands now (plan §5.3): theirs, live, general, with the MCP
 * surface; null when any of that fails (the Nook tools then vanish at this step, T311, T319).
 */
export function liveLinkedKey(agentId: string, userId: string): McpKeyContext | null {
  const row = linkRow(agentId, userId);
  if (!row?.nook_key_id) return null;
  const key = loadLiveKey(row.nook_key_id, "mcp");
  if (!key || key.userId !== userId || key.kind !== "general") return null;
  // Never a key that can run agents (review M1), whatever was linked before the rule.
  if (hasScope(key.scopes, "agents:run")) return null;
  return key;
}

/**
 * The caller's link as the editor and the chat show it (Wave 41 QA Q4): none, live, or a key that is
 * no longer live (revoked, expired, or otherwise inactive), named so the person can link another.
 */
export function linkStateOf(agentId: string, userId: string): { state: LinkState; keyName: string | null } {
  const row = linkRow(agentId, userId);
  if (!row?.nook_key_id) return { state: "none", keyName: null };
  if (liveLinkedKey(agentId, userId)) return { state: "live", keyName: ownApiKey(userId, row.nook_key_id)?.name ?? null };
  const key = ownApiKey(userId, row.nook_key_id);
  if (!key) return { state: "inactive", keyName: null };
  return { state: key.state === "revoked" ? "revoked" : key.state === "expired" ? "expired" : "inactive", keyName: key.name };
}

/** The tool-result text for a Nook call through a link whose key is gone (QA Q4): names the key, says what to do. */
export function inactiveLinkMessage(agentId: string, userId: string): string | null {
  const link = linkStateOf(agentId, userId);
  if (link.state === "none" || link.state === "live") return null;
  const name = link.keyName ? `"${link.keyName}"` : "";
  const why = link.state === "revoked" ? "was revoked" : link.state === "expired" ? "has expired" : "is no longer active";
  return `The linked Nook key ${name}${name ? " " : ""}${why}, so Nook's tools are off for this agent. The person can link another key in the agent's settings.`;
}

// --- Nook's tools without a linked key (C2) ---------------------------------------------------------

const roleOf = (userId: string) => (db.query("SELECT role FROM users WHERE id = ? AND disabled_at IS NULL").get(userId) as { role: string } | null)?.role ?? null;

/** Whether the agent gets Nook's tools automatically: the admin setting and the agent's own toggle (both default on). */
export const nookAutoOn = (agent: Pick<AgentRow, "nook_auto">, settings = readAgentSettings()) => settings.nookAutoTools && agent.nook_auto === 1;

/**
 * The key a chat's Nook tools run with for this runner (C2): a linked key is preferred (and a link
 * whose key died keeps the tools off, as before: the person chose that key); with no link and the
 * automatic tools on, the runner's internal key (reads, and writes as Inbox proposals only),
 * created on first need. Never for a guest or a blocked account, and never after it was revoked.
 */
export function chatNookKey(agent: Pick<AgentRow, "id" | "nook_auto">, userId: string): { key: McpKeyContext; internal: boolean } | null {
  const row = linkRow(agent.id, userId);
  if (row?.nook_key_id) {
    const key = liveLinkedKey(agent.id, userId);
    return key ? { key, internal: false } : null;
  }
  if (!nookAutoOn(agent)) return null;
  const role = roleOf(userId);
  if (!role || role === "guest") return null;
  const keyId = ensureInternalAgentKey(userId);
  if (!keyId) return null;
  const key = loadLiveKey(keyId, "mcp");
  if (!key || key.userId !== userId || key.kind !== "general" || hasScope(key.scopes, "agents:run")) return null;
  return { key, internal: true };
}

/** The automatic tools' state as the editor shows it (C2). */
export function nookAutoState(agent: Pick<AgentRow, "nook_auto"> | null, userId: string): NookAutoState {
  const settings = readAgentSettings();
  if (!settings.nookAutoTools) return "off_admin";
  if (agent && agent.nook_auto !== 1) return "off_agent";
  const role = roleOf(userId);
  if (!role || role === "guest") return "unavailable";
  return internalAgentKeyRevoked(userId) ? "revoked" : "on";
}

const agentRowOf = (agentId: string) => db.query("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | null;

// --- The catalog (plan §12 `GET /api/agents/catalog`) -----------------------------------------------

export function catalogFor(role: string, agentId: string | null, userId: string): ToolCatalog {
  const servers = serversAvailableTo(role).map((row) => {
    const policies = serverPolicies(row.id);
    return {
      id: row.id, slug: row.slug, name: row.name, enabled: row.enabled === 1, status: row.status as ToolCatalog["servers"][number]["status"], availability: row.visibility === "all_users" ? "all" as const : "admins" as const,
      tools: parseTools(row.tools_json).map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, readOnly: tool.readOnly, openWorld: tool.openWorld, policy: policies.get(tool.name) ?? defaultPolicy(tool) }))
    };
  });
  const agent = agentId ? agentRowOf(agentId) : null;
  // C2: the linked key, else the runner's internal key while the automatic tools are on (for a new agent: the defaults).
  const nookKey = agent ? chatNookKey(agent, userId) : nookAutoState(null, userId) === "on" ? chatNookKey({ id: "", nook_auto: 1 }, userId) : null;
  const key = nookKey?.key ?? null;
  // AC-E: the knowledge bases the editor can open; only those they own or manage can be attached (M4: `manageable`).
  const knowledge = listKnowledge(userId).map((kb) => ({ id: kb.id, name: kb.name, description: kb.description, ownerName: kb.ownerName, yours: kb.yourLevel === "owner", manageable: kb.yourLevel !== "view", status: kb.status, chunkCount: kb.chunkCount }));
  // Without a live key the picker lists none of Nook's tools (QA Q4): what runs is bounded by the key.
  return { servers, nook: { linked: key !== null && !nookKey?.internal, linkState: agentId ? linkStateOf(agentId, userId).state : "none", tools: key ? nookCatalogFor(key) : [], auto: nookAutoState(agent, userId) }, knowledge };
}

// --- Per-step resolution (plan §2.1 `toolCatalog`, D358) ---------------------------------------------

const MODEL_NAME = /[^A-Za-z0-9_-]/g;

function uniqueName(base: string, taken: Set<string>) {
  let name = base.replace(MODEL_NAME, "_").slice(0, 64);
  let suffix = 2;
  while (taken.has(name)) {
    const tail = `_${suffix++}`;
    name = `${base.replace(MODEL_NAME, "_").slice(0, 64 - tail.length)}${tail}`;
  }
  taken.add(name);
  return name;
}

/**
 * How an API or MCP run resolves tools (AC-C, plan §2, §5.4, D352): Nook's tools run with the
 * calling key (on its surface) instead of a linked key, and only tools that run on their own are
 * offered: remote tools whose policy is `auto`, Nook read tools, and Nook writes in proposal mode
 * (they file inbox proposals and change nothing). A `confirm` tool and a direct Nook write never are.
 */
export type ExternalToolOptions = { nookKey: McpKeyContext | null; surface: "mcp" | "rest" };

/** What a resolved tool was at offer time, to compare against live rows before a call runs (review M3). */
export type ToolIdentity =
  | { kind: "server"; serverId: string; toolName: string; revision: number }
  | { kind: "nook"; toolName: string; mode: NookResolved["mode"]; keyId: string }
  | { kind: "knowledge"; kbIds: string };

const kbIdsOf = (spec: KnowledgeToolSpec) => spec.kbs.map((kb) => kb.id).sort().join(",");

export const identityOf = (tool: ResolvedTool): ToolIdentity => tool.kind === "server"
  ? { kind: "server", serverId: tool.serverId!, toolName: tool.toolName, revision: tool.serverRow!.revision }
  : tool.kind === "knowledge" ? { kind: "knowledge", kbIds: kbIdsOf(tool.knowledge!) }
  : { kind: "nook", toolName: tool.toolName, mode: tool.nook!.mode, keyId: tool.nook!.keyId };

/** The agent row and the runner's role as they stand now (the agent not in the Bin, the account active, the role allowed to chat). */
export function liveRunner(agentId: string, userId: string): { agent: AgentRow; role: string } | null {
  const agent = db.query("SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL").get(agentId) as AgentRow | null;
  if (!agent) return null;
  const user = db.query("SELECT role FROM users WHERE id = ? AND disabled_at IS NULL").get(userId) as { role: string } | null;
  if (!user || !roleMayChat(user.role)) return null;
  // Wave 43 (AC-D): the runner can still open the agent (their own, or shared with them now); a share
  // withdrawn mid-run ends the run at its next step or tool call.
  if (shareLevel("agent", agent, userId) === "none") return null;
  return { agent, role: user.role };
}

/**
 * The one tool a call is about to run, re-resolved against live rows just before it runs (review
 * M3): the live agent row (its picks and `nook_direct_writes`), the runner's live role and account,
 * the live server row (enabled, available to the runner, the same revision), the live policy, and
 * the live key with the same mode (the linked key in a chat; the calling key, re-read, in an API or
 * MCP run, with the run's auto-only set). Null when anything changed: the call is refused.
 */
export function liveToolFor(agentId: string, userId: string, identity: ToolIdentity, external: ExternalToolOptions | null = null): ResolvedTool | null {
  const live = liveRunner(agentId, userId);
  if (!live) return null;
  const match = resolveTools(live.agent, { userId, role: live.role }, external, identity).find((tool) => identity.kind === "server"
    ? tool.kind === "server" && tool.serverId === identity.serverId && tool.toolName === identity.toolName && tool.serverRow!.revision === identity.revision
    : identity.kind === "knowledge" ? tool.kind === "knowledge" && kbIdsOf(tool.knowledge!) === identity.kbIds
    : tool.kind === "nook" && tool.toolName === identity.toolName && tool.nook!.mode === identity.mode && tool.nook!.keyId === identity.keyId);
  return match ?? null;
}

/**
 * Why a call's live re-check found no tool (AC-B verification M2), so the card says why: the
 * key is no longer live (`KEY_INACTIVE`), it lost a scope the tool needs in its mode
 * (`SCOPE_REQUIRED`, naming the scope), or anything else changed (`TOOL_UNAVAILABLE`: the server
 * was disabled, removed, or edited, a policy or the agent's picks changed, another key was linked).
 */
export function liveToolFailure(agentId: string, userId: string, identity: ToolIdentity, external: ExternalToolOptions | null = null): { code: "KEY_INACTIVE" | "SCOPE_REQUIRED" | "TOOL_UNAVAILABLE"; message: string; scope?: string } {
  const unavailable = { code: "TOOL_UNAVAILABLE" as const, message: "This tool is no longer available to this agent (it was disabled, removed, changed, or the rights changed); the call was not run" };
  if (identity.kind !== "nook") return unavailable;
  const agent = external ? null : agentRowOf(agentId);
  const key = external ? external.nookKey : agent ? chatNookKey(agent, userId)?.key ?? null : null;
  if (!key) {
    const dead = external ? null : inactiveLinkMessage(agentId, userId);
    return { code: "KEY_INACTIVE", message: dead ?? "The Nook key this tool runs with is no longer active; the call was not run" };
  }
  if (key.keyId !== identity.keyId) return unavailable;
  const scope = missingNookScope(key, identity.toolName, identity.mode);
  if (scope) return { code: "SCOPE_REQUIRED", scope, message: `The ${external ? "calling" : linkRow(agentId, userId)?.nook_key_id ? "linked" : "internal"} Nook key no longer has the ${scope} permission this tool needs${identity.mode === "proposal" ? " to file a proposal" : ""}; the call was not run` };
  return unavailable;
}

/** The agent's remote and Nook tools the runner may call at this step; disabled, `off`, and unreachable rights drop silently. */
export function resolveTools(agent: AgentRow, runner: { userId: string; role: string }, external: ExternalToolOptions | null = null, only?: ToolIdentity): ResolvedTool[] {
  const all = agentToolRefs(agent.id);
  const refs = all.filter((ref) => !only || (only.kind === "server" ? ref.source === "server" && ref.serverId === only.serverId && ref.toolName === only.toolName
    : only.kind === "knowledge" ? ref.source === "knowledge" : ref.source === "nook" && ref.toolName === only.toolName));
  // C2: in a chat, an agent with no Nook picks gets every offered Nook tool while its automatic tools are on.
  const nookPicks = all.flatMap((ref) => ref.source === "nook" ? [ref.toolName] : []);
  const autoNook = !external && nookPicks.length === 0 && nookAutoOn(agent);
  const nookNames = (autoNook ? offeredSpecs().map((spec) => spec.name) : nookPicks).filter((name) => !only || (only.kind === "nook" && only.toolName === name));
  // The trifecta (plan §5.2 [14], review L10): with Nook tools (AC-E: or knowledge bases; C2: or the automatic ones) an open-world remote tool asks first.
  const chatKey = !external && (nookPicks.length > 0 || autoNook) ? chatNookKey(agent, runner.userId) : null;
  const hasNook = all.some((ref) => ref.source === "nook" || ref.source === "knowledge") || (autoNook && chatKey !== null);
  const taken = new Set<string>();
  const resolved: ResolvedTool[] = [];
  const servers = new Map<string, { row: ToolServerRow; tools: Map<string, ReturnType<typeof parseTools>[number]>; policies: Map<string, ToolPolicy> } | null>();
  for (const ref of refs) {
    if (ref.source !== "server") continue;
    if (!servers.has(ref.serverId)) {
      const row = serverRowOrNull(ref.serverId);
      servers.set(ref.serverId, row && row.enabled === 1 && serverAvailableTo(row, runner.role) ? { row, tools: new Map(parseTools(row.tools_json).map((tool) => [tool.name, tool])), policies: serverPolicies(row.id) } : null);
    }
    const server = servers.get(ref.serverId);
    const tool = server?.tools.get(ref.toolName);
    if (!server || !tool) continue;
    const admin = server.policies.get(tool.name) ?? defaultPolicy(tool);
    // The agent can only be stricter (D358): off wins, then confirm, then the admin's policy.
    let policy: ToolPolicy = admin === "off" || ref.policy === "off" ? "off" : ref.policy === "confirm" ? "confirm" : admin;
    if (policy === "off") continue;
    if (policy === "auto" && hasNook && tool.openWorld) policy = "confirm";
    // An API or MCP run never waits on a person (D352): only what runs on its own is offered.
    if (external && policy !== "auto") continue;
    resolved.push({
      modelName: uniqueName(`${server.row.slug}__${tool.name}`, taken), kind: "server", serverId: server.row.id, server: server.row.slug, serverName: server.row.name, toolName: tool.name,
      description: tool.description, parameters: tool.inputSchema, policy, openWorld: tool.openWorld, resultCapBytes: server.row.result_cap_bytes, timeoutMs: server.row.timeout_ms, serverRow: server.row, nook: null, knowledge: null
    });
  }
  if (nookNames.length > 0) {
    const key = external ? external.nookKey : chatKey?.key ?? null;
    // The internal key never writes directly (C2): proposals only, whatever the agent's direct-writes flag says.
    const internal = !external && chatKey?.internal === true;
    if (key) {
      for (const item of nookToolsFor(key, internal ? { nook_direct_writes: 0 } : agent, nookNames)) {
        if (external && item.mode === "direct") continue;
        const spec = nookToolSpec(item.toolName)!;
        // Over the API a proposal runs on its own: it changes nothing until the key's owner approves it in the Inbox.
        const policy = external ? "auto" as const : item.policy;
        resolved.push({
          modelName: uniqueName(`nook__${item.toolName}`, taken), kind: "nook", serverId: null, server: "nook", serverName: "Nook", toolName: item.toolName,
          description: item.description, parameters: item.parameters, policy, openWorld: false, resultCapBytes: 16_384, timeoutMs: 30_000, serverRow: null,
          nook: { ...item, policy, spec, surface: external?.surface ?? "mcp", ...(internal ? { internal: true } : {}) }, knowledge: null
        });
      }
    }
  }
  // AC-E (plan §5.2, §9): one read-only tool over the attached bases that are live and still open to
  // the agent's owner; `auto` in chats, offered over the API and MCP too.
  if (refs.some((ref) => ref.source === "knowledge")) {
    const picked = new Set(refs.flatMap((ref) => ref.source === "knowledge" ? [ref.kbId] : []));
    const bases = liveAttachedBases(agent).filter((kb) => picked.has(kb.id));
    if (bases.length > 0) {
      const spec: KnowledgeToolSpec = { kbs: bases.map((kb) => ({ id: kb.id, name: kb.name, description: kb.description })) };
      resolved.push({
        modelName: uniqueName(KNOWLEDGE_TOOL.modelName, taken), kind: "knowledge", serverId: null, server: KNOWLEDGE_TOOL.server, serverName: "Knowledge", toolName: KNOWLEDGE_TOOL.tool,
        description: knowledgeToolDescription(spec), parameters: knowledgeToolParameters(spec), policy: "auto", openWorld: false, resultCapBytes: 16_384, timeoutMs: 30_000, serverRow: null, nook: null, knowledge: spec
      });
    }
  }
  return resolved;
}

/** The trifecta (plan §5.2 [14]): private data (Nook tools) plus an open-world remote tool. */
export function trifectaOf(refs: AgentToolRef[], autoNook = false): boolean {
  // AC-E: an attached knowledge base is private data too; C2: so are the automatic Nook tools.
  const hasNook = autoNook || refs.some((ref) => ref.source === "nook" || ref.source === "knowledge");
  if (!hasNook) return false;
  const servers = new Map<string, Map<string, boolean>>();
  for (const ref of refs) {
    if (ref.source !== "server") continue;
    if (!servers.has(ref.serverId)) {
      const row = serverRowOrNull(ref.serverId);
      servers.set(ref.serverId, new Map(row ? parseTools(row.tools_json).map((tool) => [tool.name, tool.openWorld]) : []));
    }
    if (servers.get(ref.serverId)!.get(ref.toolName) !== false && servers.get(ref.serverId)!.has(ref.toolName)) return true;
  }
  return false;
}

/** Test and purge hook: the link rows of an agent (purging an agent cascades them). */
export const clearLinksForTests = (agentId: string) => { db.query("DELETE FROM agent_user_links WHERE agent_id = ?").run(agentId); };

export const linkTimestamp = now;
