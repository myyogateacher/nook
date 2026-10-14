import { audit, db, now } from "../db";
import { purgeAfterFrom } from "../bin";
import { AGENT_BOUNDS, type AgentDetail, type AgentSummary, type AgentToolRef } from "../../shared/agents";
import { readAgentSettings, roleMayCreate } from "./settings";
import { shareLevel, shareReadableSql, type ShareLevel } from "./sharing";
import { AgentError } from "./status";
import { agentToolRefs, linkStateOf, nookAutoOn, refKeyOf, setAgentTools, trifectaOf } from "./tools";
import { manageableKbIds } from "../knowledge/service";
import { serversAvailableTo } from "./toolServers";
import { agentChangeMask, notifyAccess } from "../access/notices";
import { effectiveModelOf, providerNameOf, visionFor } from "./providers";

/**
 * Agents (plan §5.1, D355, D356). Create needs the `create_roles` policy. Wave 43 (AC-D) shares
 * them through `agent_access` (server/agents/sharing.ts): viewers chat with an agent and see its
 * name, description, model, and starters, never its system prompt or its tools configuration;
 * managers edit it (CAS on `revision`); only the owner moves it to the Bin. Anyone who may chat
 * lists the agents they can use: their own and those shared with them.
 */

export type AgentRow = {
  id: string; owner_id: string; name: string; description: string; icon: string | null; color: string | null; system_prompt: string; starters_json: string;
  provider_id: string | null; model: string | null; max_steps: number; temperature: number | null; max_output_tokens: number | null; nook_direct_writes: number;
  /** C2: give this agent Nook's tools automatically (057). */
  nook_auto: number;
  visibility: string; all_users_level: string; revision: number; created_at: string; updated_at: string;
  deleted_at: string | null; deleted_by: string | null; purge_after: string | null; purge_started_at: string | null;
};

const starters = (json: string): string[] => {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, AGENT_BOUNDS.starters) : [];
  } catch {
    return [];
  }
};

const ownerNameQuery = db.query("SELECT display_name FROM users WHERE id = ?");

const roleQuery = db.query("SELECT role FROM users WHERE id = ?");

/**
 * Review L2: the picks a manager may see. Picks from servers outside `serversAvailableTo(manager's
 * role)` (an admins-only or disabled server) are withheld, and counted; `setAgentTools` keeps them on save.
 */
export function toolsVisibleTo(tools: AgentToolRef[], role: string, userId?: string): { shown: AgentToolRef[]; hidden: AgentToolRef[] } {
  const usable = new Set(serversAvailableTo(role).map((server) => server.id));
  // AC-E: a manager is not shown a knowledge base they cannot manage either (its name stays private, and
  // they could not attach it: M4); like a server they cannot use, it stays on save.
  const kbs = userId ? manageableKbIds(userId, tools.flatMap((tool) => tool.source === "knowledge" ? [tool.kbId] : [])) : null;
  const shown: AgentToolRef[] = [];
  const hidden: AgentToolRef[] = [];
  for (const tool of tools) ((tool.source === "server" && !usable.has(tool.serverId)) || (tool.source === "knowledge" && kbs !== null && !kbs.has(tool.kbId)) ? hidden : shown).push(tool);
  return { shown, hidden };
}

export const agentSummary = (row: AgentRow, userId: string, level: ShareLevel = shareLevel("agent", row, userId)): AgentSummary => {
  const tools = agentToolRefs(row.id);
  const link = linkStateOf(row.id, userId).state;
  // C2: with no Nook picks, the automatic Nook tools count as Nook's tools (trifecta, "uses Nook").
  const autoNook = !tools.some((tool) => tool.source === "nook") && nookAutoOn(row);
  // D356: below manage, no tools configuration leaves the server; the trifecta warning and "uses Nook" do.
  const configVisible = level === "owner" || level === "manage";
  const managerView = level === "manage" ? toolsVisibleTo(tools, (roleQuery.get(userId) as { role: string } | null)?.role ?? "viewer", userId) : null;
  return {
    id: row.id, ownerId: row.owner_id, name: row.name, description: row.description, icon: row.icon, color: row.color,
    providerId: row.provider_id, model: row.model, maxSteps: row.max_steps, temperature: row.temperature, maxOutputTokens: row.max_output_tokens,
    starters: starters(row.starters_json), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, isOwner: row.owner_id === userId,
    tools: managerView ? managerView.shown : configVisible ? tools : [], hiddenTools: managerView?.hidden.length ?? 0, nookDirectWrites: configVisible && row.nook_direct_writes === 1, linked: link === "live", linkState: link, trifecta: trifectaOf(tools, autoNook), nookAuto: row.nook_auto === 1,
    yourLevel: level === "owner" ? "owner" : level === "manage" ? "manage" : "view",
    ownerName: (ownerNameQuery.get(row.owner_id) as { display_name: string } | null)?.display_name ?? "Former member",
    usesNook: autoNook || tools.some((tool) => tool.source === "nook"),
    providerName: providerNameOf(row.provider_id),
    effectiveModel: effectiveModelOf(row.provider_id, row.model),
    vision: visionFor(row.provider_id, row.model)
  };
};
export const agentDetail = (row: AgentRow, userId: string): AgentDetail => {
  const level = shareLevel("agent", row, userId);
  return { ...agentSummary(row, userId, level), systemPrompt: level === "owner" || level === "manage" ? row.system_prompt : null };
};

const liveAgent = (id: string) => db.query("SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL").get(id) as AgentRow | null;

/** A live agent the person may chat with (their own, or shared with them at view or above), or the 404. */
export function usableAgent(id: string, userId: string): AgentRow {
  const row = liveAgent(id);
  if (!row || shareLevel("agent", row, userId) === "none") throw new AgentError(404, "NOT_FOUND", "Not found");
  return row;
}

/** A live agent the person may edit (the owner or a manager); a viewer gets 403, everyone else the 404. */
export function manageableAgent(id: string, userId: string): AgentRow {
  const row = liveAgent(id);
  const level = row ? shareLevel("agent", row, userId) : "none";
  if (!row || level === "none") throw new AgentError(404, "NOT_FOUND", "Not found");
  if (level === "view") throw new AgentError(403, "READ_ONLY", "You can chat with this agent; only its owner and managers edit it");
  return row;
}

/** A live agent the person owns (delete, D356: managers never delete); others who can see it get 403. */
export function ownedAgent(id: string, userId: string): AgentRow {
  const row = liveAgent(id);
  const level = row ? shareLevel("agent", row, userId) : "none";
  if (!row || level === "none") throw new AgentError(404, "NOT_FOUND", "Not found");
  if (level !== "owner") throw new AgentError(403, "OWNER_ONLY", "Only the agent's owner can move it to the Bin");
  return row;
}

/** The agents the person can chat with: their own first, then those shared with them, newest first. */
export function listUsableAgents(userId: string): AgentSummary[] {
  return (db.query(`SELECT a.* FROM agents a WHERE ${shareReadableSql("agent", "a")} ORDER BY (a.owner_id = $userId) DESC, a.updated_at DESC LIMIT 500`).all({ userId }) as AgentRow[]).map((row) => agentSummary(row, userId));
}

export type AgentInput = {
  name: string; description?: string; icon?: string | null; color?: string | null; systemPrompt?: string; providerId?: string | null; model?: string | null;
  maxSteps?: number; temperature?: number | null; maxOutputTokens?: number | null; starters?: string[];
  /** AC-B: the picked tools (replaces the list) and the direct-writes flag (AC-O11). */
  tools?: AgentToolRef[]; nookDirectWrites?: boolean;
  /** C2: Nook's tools automatically (the runner's internal key when no key is linked). */
  nookAuto?: boolean;
};

function providerExists(id: string | null | undefined) {
  if (!id) return null;
  if (!db.query("SELECT 1 FROM agent_providers WHERE id = ?").get(id)) throw new AgentError(400, "INVALID", "That provider does not exist", { field: "providerId" });
  return id;
}

export function createAgent(actor: { userId: string; role: string }, input: AgentInput): AgentDetail {
  const settings = readAgentSettings();
  if (!roleMayCreate(actor.role, settings)) throw new AgentError(403, "ROLE_REFUSED", "Your role cannot create agents");
  return db.transaction(() => {
    const owned = (db.query("SELECT COUNT(*) AS count FROM agents WHERE owner_id = ? AND deleted_at IS NULL").get(actor.userId) as { count: number }).count;
    if (owned >= settings.agentsPerUser) throw new AgentError(409, "LIMIT_REACHED", `You can have up to ${settings.agentsPerUser} agents`);
    const id = crypto.randomUUID();
    const timestamp = now();
    db.query(`INSERT INTO agents (id, owner_id, name, description, icon, color, system_prompt, starters_json, provider_id, model, max_steps, temperature, max_output_tokens, nook_direct_writes, nook_auto, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, actor.userId, input.name.trim(), input.description?.trim() ?? "", input.icon ?? null, input.color ?? null, input.systemPrompt ?? "",
      JSON.stringify((input.starters ?? []).slice(0, AGENT_BOUNDS.starters)), providerExists(input.providerId), input.model?.trim() || null,
      input.maxSteps ?? AGENT_BOUNDS.maxSteps.default, input.temperature ?? null, input.maxOutputTokens ?? null, input.nookDirectWrites ? 1 : 0, input.nookAuto === false ? 0 : 1, timestamp, timestamp
    );
    if (input.tools) setAgentTools(id, actor.role, input.tools, { userId: actor.userId });
    audit(actor.userId, null, "agents.agent.create", { agentId: id, tools: input.tools?.length ?? 0 });
    return agentDetail(usableAgent(id, actor.userId), actor.userId);
  })();
}

export function updateAgent(actor: { userId: string; role: string }, id: string, input: Partial<AgentInput> & { expectedRevision: number }): AgentDetail {
  // The same policy as create (review L11): a role removed from `create_roles` keeps its agents but cannot reshape them.
  if (!roleMayCreate(actor.role)) throw new AgentError(403, "ROLE_REFUSED", "Your role cannot edit agents");
  return db.transaction(() => {
    const row = manageableAgent(id, actor.userId);
    if (row.revision !== input.expectedRevision) throw new AgentError(409, "REVISION_MISMATCH", "This agent changed elsewhere; reload and try again", { revision: row.revision });
    db.query(`UPDATE agents SET name = ?, description = ?, icon = ?, color = ?, system_prompt = ?, starters_json = ?, provider_id = ?, model = ?, max_steps = ?, temperature = ?, max_output_tokens = ?,
      nook_direct_writes = ?, nook_auto = ?, revision = revision + 1, updated_at = ? WHERE id = ?`).run(
      (input.name ?? row.name).trim(), input.description !== undefined ? input.description.trim() : row.description,
      input.icon !== undefined ? input.icon : row.icon, input.color !== undefined ? input.color : row.color,
      input.systemPrompt !== undefined ? input.systemPrompt : row.system_prompt,
      input.starters !== undefined ? JSON.stringify(input.starters.slice(0, AGENT_BOUNDS.starters)) : row.starters_json,
      input.providerId !== undefined ? providerExists(input.providerId) : row.provider_id,
      input.model !== undefined ? input.model?.trim() || null : row.model,
      input.maxSteps ?? row.max_steps, input.temperature !== undefined ? input.temperature : row.temperature,
      input.maxOutputTokens !== undefined ? input.maxOutputTokens : row.max_output_tokens,
      input.nookDirectWrites !== undefined ? (input.nookDirectWrites ? 1 : 0) : row.nook_direct_writes, input.nookAuto !== undefined ? (input.nookAuto ? 1 : 0) : row.nook_auto, now(), id
    );
    const manager = row.owner_id !== actor.userId;
    const toolsBefore = manager ? agentToolRefs(id) : [];
    if (input.tools) setAgentTools(id, actor.role, input.tools, { keepHidden: manager, userId: actor.userId });
    // Review L4: the owner hears when a manager changes what the agent is told, what it can call, or what it may write.
    if (manager) {
      const toolsAfter = agentToolRefs(id);
      const keyOf = (refs: AgentToolRef[]) => refs.map((ref) => ref.source === "server" ? `${refKeyOf(ref)}:${ref.policy ?? ""}` : refKeyOf(ref)).sort().join("\n");
      const mask = agentChangeMask({
        systemPrompt: input.systemPrompt !== undefined && input.systemPrompt !== row.system_prompt,
        tools: input.tools !== undefined && keyOf(toolsBefore) !== keyOf(toolsAfter),
        nookDirectWrites: input.nookDirectWrites !== undefined && (input.nookDirectWrites ? 1 : 0) !== row.nook_direct_writes,
        trifecta: !trifectaOf(toolsBefore) && trifectaOf(toolsAfter)
      });
      if (mask) notifyAccess({ userId: row.owner_id, kind: "agent_changed", actorId: actor.userId, resource: { kind: "agent", id }, count: mask });
    }
    audit(actor.userId, null, "agents.agent.update", { agentId: id, ...(input.tools ? { tools: input.tools.length } : {}), ...(row.owner_id !== actor.userId ? { asManager: true } : {}) });
    return agentDetail(usableAgent(id, actor.userId), actor.userId);
  })();
}

/** Moves the agent to the Bin (D363 parity). Its chats stay, readable; sending needs a live agent. */
export function deleteAgent(actor: { userId: string }, id: string) {
  ownedAgent(id, actor.userId);
  const timestamp = now();
  db.query("UPDATE agents SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(timestamp, actor.userId, purgeAfterFrom(new Date(timestamp)), timestamp, id);
  audit(actor.userId, null, "agents.agent.delete", { agentId: id });
  return { ok: true as const, purgeAfter: purgeAfterFrom(new Date(timestamp)) };
}
