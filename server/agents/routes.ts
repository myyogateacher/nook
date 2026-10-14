import type { Context, Hono, Next } from "hono";
import { streamSSE } from "hono/streaming";
import { keepRequestOpen, SSE_TIMING } from "../longRequests";
import { z, ZodError } from "zod";
import type { AppEnv } from "../auth";
import { db } from "../db";
import { ensureInternalAgentKey } from "../apiKeys";
import { parseJson, uuid } from "../validation";
import { AGENT_BOUNDS, AGENT_ROLE_OPTIONS, REASONING_EFFORTS, CHAT_IMAGE_BOUNDS, DEFAULT_MODEL, EMBEDDING_MODEL_ID, KNOWLEDGE_POLICY_BOUNDS, SERVER_AUTH_KINDS, SERVER_AVAILABILITIES, TOOL_POLICIES, VISION_POLICY_BOUNDS, type ChatUpdateEvent } from "../../shared/agents";
import { createAgent, deleteAgent, agentDetail, listUsableAgents, manageableAgent, updateAgent, usableAgent } from "./agentsService";
import { chatDetail, createChat, deleteChat, forkChat, listChats, listSharedChats, messageOf, pathTo, readableChat, updateChat, withAttachments } from "./chats";
import { chatAttachmentsFor } from "./chatImages";
import { publicLinkFor, publicLinksOn, publicLinkState, revokePublicLink, roleMayPublish, upsertPublicLink } from "./publicShares";
import { readShareAccess, shareLevel, writeShareAccess, type ShareKind } from "./sharing";
import { subscribeChatUpdates } from "./chatUpdates";
import { createProvider, deleteProvider, listProviders, probeToolCalling, providerChoices, providerModels, providerRow, providerSummary, testProvider, updateProvider } from "./providers";
import { activeRunForChat, cancelChatRuns, cancelRun, confirmRun, dailyUsage, pendingConfirmationFor, runReadableBy, runSnapshot, startChatRun } from "./runs";
import { readAgentSettings, roleMayChat, roleMayCreate, writeAgentSettings } from "./settings";
import { AgentError, adminRecoveryAllowed, agentsStatus, recheckAgentsStatus, requireAgentsEnabled } from "./status";
import { declaredStdioServers, stdioEnabled } from "./stdio";
import { channelOf, sseFrame, type SequencedEvent } from "./stream";
import { catalogFor, currentLink, linkableKeys, setLink } from "./tools";
import { createServerAndSync, deleteServer, ensureServersSynced, listServers, serverRow, serverSummary, serversAvailableTo, setPolicies, syncServer, updateServerAndSync } from "./toolServers";
import { ProviderError } from "./loop";
import { agentApiUsage, auditFacets, auditRunDetail, auditVisibleTo, exportAuditRuns, listAuditRuns } from "./audit";
import { proxyImage, toolImageResponse } from "./images";
import "./bin";

/**
 * The agent chat session API (plan §12, docs/plan/API_CONTRACTS.md § Agent chat): `/api/agents/*`,
 * `/api/chats/*`, and `/api/runs/*`. Every route needs a session; mutations need CSRF and pass the
 * role write gate (viewers chat through its allowlist). Guests get 404 everywhere (AC-O2). With the
 * module off every route but `/api/agents/status` answers 503 `AGENTS_DISABLED`. Admin routes live
 * under `/api/agents/admin/*`. Responses are `no-store` (all of /api); no error echoes input.
 */

const line = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must be one line of text");
const revision = z.number().int().min(1);
const roles = z.array(z.enum(AGENT_ROLE_OPTIONS)).max(3).refine((list) => new Set(list).size === list.length, "must not repeat");
const compat = z.object({
  tokenParam: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
  streamUsage: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  namedToolChoice: z.boolean().optional(),
  requiredToolChoice: z.boolean().optional(),
  contextTokens: z.number().int().min(1024).max(10_000_000).optional(),
  // 2026-10-14: sent as reasoning_effort on every request to this provider; omit sends none.
  reasoningEffort: z.enum(REASONING_EFFORTS).optional()
}).strict();
// 2026-10-08: the knowledge base policy. `models: null` is "Any"; a list has 1 to 20 model ids; `maxDims: null` is 3,072.
const embeddingModelId = z.string().trim().min(1).max(KNOWLEDGE_POLICY_BOUNDS.modelName).regex(EMBEDDING_MODEL_ID, "must be a model id");
const knowledgePolicy = z.object({
  enabled: z.boolean().optional(),
  models: z.array(embeddingModelId).min(1).max(KNOWLEDGE_POLICY_BOUNDS.models).refine((list) => new Set(list).size === list.length, "must not repeat").nullable().optional(),
  maxDims: z.number().int().min(KNOWLEDGE_POLICY_BOUNDS.minDims).max(KNOWLEDGE_POLICY_BOUNDS.maxDims).nullable().optional()
}).strict();
// U5 (Q10): which models may be sent images. `models: null` is "every model"; a list has 1 to 20 model ids.
const visionModelId = z.string().trim().min(1).max(VISION_POLICY_BOUNDS.modelName).regex(EMBEDDING_MODEL_ID, "must be a model id");
const visionPolicy = z.object({
  enabled: z.boolean().optional(),
  models: z.array(visionModelId).min(1).max(VISION_POLICY_BOUNDS.models).refine((list) => new Set(list).size === list.length, "must not repeat").nullable().optional()
}).strict();
const providerCreateSchema = z.object({
  name: line(AGENT_BOUNDS.providerName),
  baseUrl: z.string().trim().min(8).max(AGENT_BOUNDS.baseUrl).optional(),
  apiKey: z.string().trim().max(1024).nullish(),
  defaultModel: line(AGENT_BOUNDS.model).optional(),
  embeddingModel: line(AGENT_BOUNDS.model).nullish(),
  embeddingDims: z.number().int().min(64).max(3072).nullish(),
  compat: compat.optional(),
  knowledge: knowledgePolicy.optional(),
  vision: visionPolicy.optional(),
  isDefault: z.boolean().optional()
}).strict();
const providerPatchSchema = providerCreateSchema.partial().extend({ expectedRevision: revision, removeSecret: z.boolean().optional() }).strict();
const settingsSchema = z.object({
  createRoles: roles.optional(),
  chatRoles: roles.optional(),
  dailyTokensUser: z.number().int().min(0).max(1_000_000_000).optional(),
  dailyTokensKey: z.number().int().min(0).max(1_000_000_000).optional(),
  dailyTokensInstance: z.number().int().min(0).max(10_000_000_000).optional(),
  publicChatLinks: z.boolean().optional(),
  auditRetentionDays: z.number().int().min(7).max(365).optional(),
  agentsPerUser: z.number().int().min(1).max(500).optional(),
  kbsPerUser: z.number().int().min(1).max(100).optional(),
  defaultProviderId: uuid.nullable().optional(),
  // Wave 48b: the report generation model (null: chat's default).
  reportProviderId: uuid.nullable().optional(),
  reportModel: line(AGENT_BOUNDS.model).nullable().optional(),
  reportModelFreeText: z.boolean().optional(),
  // Lane E (E5): the fallback model for reports (null: off).
  reportFallbackProviderId: uuid.nullable().optional(),
  reportFallbackModel: line(AGENT_BOUNDS.model).nullable().optional(),
  // C2: agents get Nook's tools automatically (each runner's internal key).
  nookAutoTools: z.boolean().optional(),
  expectedRevision: z.number().int().min(0)
}).strict();
const starters = z.array(z.string().trim().min(1).max(AGENT_BOUNDS.starterLength)).max(AGENT_BOUNDS.starters);
// AC-B: tool servers (admin), the agent's picks, the link, and confirmations.
const toolName = z.string().min(1).max(128);
const serverCreateSchema = z.object({
  name: line(AGENT_BOUNDS.serverName),
  slug: z.string().trim().min(1).max(AGENT_BOUNDS.serverSlug).optional(),
  url: z.string().trim().min(8).max(AGENT_BOUNDS.serverUrl).nullish(),
  stdioId: z.string().trim().min(1).max(24).nullish(),
  authKind: z.enum(SERVER_AUTH_KINDS).optional(),
  authHeader: z.string().trim().min(1).max(64).nullish(),
  secret: z.string().trim().max(4096).nullish(),
  timeoutMs: z.number().int().min(AGENT_BOUNDS.toolTimeoutMs.min).max(AGENT_BOUNDS.toolTimeoutMs.max).optional(),
  resultCapBytes: z.number().int().min(AGENT_BOUNDS.resultCapBytes.min).max(AGENT_BOUNDS.resultCapBytes.max).optional(),
  availability: z.enum(SERVER_AVAILABILITIES).optional(),
  enabled: z.boolean().optional()
}).strict();
const serverPatchSchema = serverCreateSchema.partial().extend({ expectedRevision: revision, removeSecret: z.boolean().optional() }).strict();
const policiesSchema = z.object({ policies: z.record(toolName, z.enum(TOOL_POLICIES)).refine((value) => Object.keys(value).length <= 500, "too many tools") }).strict();
const toolRefSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("server"), serverId: uuid, toolName, policy: z.enum(["confirm", "off"]).nullable() }).strict(),
  z.object({ source: z.literal("nook"), toolName }).strict(),
  // AC-E: a knowledge base (all of an agent's bases become one search_knowledge tool).
  z.object({ source: z.literal("knowledge"), kbId: uuid }).strict()
]);
const linkSchema = z.object({ nookKeyId: uuid.nullable() }).strict();
// Review M1: the card is named by the server's nonce and the arguments' hash, never the model's call id.
const confirmSchema = z.object({ confirmationId: z.string().regex(/^[0-9a-f]{32}$/), argsHash: z.string().regex(/^[0-9a-f]{64}$/), decision: z.enum(["once", "deny"]) }).strict();
const agentCreateSchema = z.object({
  name: line(AGENT_BOUNDS.agentName),
  description: z.string().trim().max(AGENT_BOUNDS.description).optional(),
  icon: z.string().trim().max(16).nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  systemPrompt: z.string().max(AGENT_BOUNDS.systemPrompt).refine((value) => !value.includes("\u0000"), "must not contain NUL characters").optional(),
  providerId: uuid.nullish(),
  model: z.string().trim().max(AGENT_BOUNDS.model).nullish(),
  maxSteps: z.number().int().min(AGENT_BOUNDS.maxSteps.min).max(AGENT_BOUNDS.maxSteps.max).optional(),
  temperature: z.number().min(0).max(2).nullish(),
  maxOutputTokens: z.number().int().min(1).max(AGENT_BOUNDS.maxOutputTokens.max).nullish(),
  starters: starters.optional(),
  tools: z.array(toolRefSchema).max(200).optional(),
  nookDirectWrites: z.boolean().optional(),
  nookAuto: z.boolean().optional()
}).strict();
const agentPatchSchema = agentCreateSchema.partial().extend({ expectedRevision: revision }).strict();
const chatCreateSchema = z.object({ agentId: uuid }).strict();
const chatPatchSchema = z.object({ title: line(AGENT_BOUNDS.chatTitle).optional(), pinned: z.boolean().optional(), activeLeafId: uuid.nullable().optional(), expectedRevision: revision }).strict();
// U5: up to 5 images (`attachments`, checked in chatImages.ts); with images the text may be empty.
const attachmentInput = z.object({ documentId: uuid, confirmed: z.boolean().optional() }).strict();
const messageSchema = z.object({
  content: z.string().max(AGENT_BOUNDS.userMessageBytes).refine((value) => !value.includes("\u0000"), "must not contain NUL characters").default(""),
  parentId: uuid.nullable().optional(),
  attachments: z.array(attachmentInput).max(CHAT_IMAGE_BOUNDS.perMessage * 4).optional()
}).strict().refine((value) => value.content.trim().length > 0 || (value.attachments?.length ?? 0) > 0, { message: "must not be blank", path: ["content"] });
const emptySchema = z.object({}).strict();
// Wave 43 (AC-D): the Access sheet's body (src/access/accessApi.ts), Continue as a copy, and the public link.
const sharePrincipal = z.object({ id: uuid, level: z.enum(["view", "manage", "comment", "edit"]) }).strict();
const shareAccessSchema = z.object({
  audience: z.enum(["private", "selected", "all_users", "inherit"]),
  audienceLevel: z.enum(["view", "comment", "edit", "manage"]).optional(),
  people: z.array(sharePrincipal).max(100).default([]),
  groups: z.array(sharePrincipal).max(20).default([])
}).strict();
const forkSchema = z.object({ messageId: uuid }).strict();
const publicLinkSchema = z.object({ includeToolResults: z.boolean().default(false), newLink: z.boolean().optional() }).strict();

/** Ids in the path: anything that is not a UUID is the same 404 as a missing item. */
function id(c: Context<AppEnv>, name: string) {
  const parsed = uuid.safeParse(c.req.param(name)?.toLowerCase());
  if (!parsed.success) throw new AgentError(404, "NOT_FOUND", "Not found");
  return parsed.data;
}

function fail(c: Context<AppEnv>, error: unknown) {
  if (error instanceof AgentError) {
    // Retry-After on every refusal that clears with time: 429 limits and budgets, and the 503 for a
    // full instance (AGENT_BUSY). A module that is off (503 AGENTS_DISABLED) carries no hint: it does not clear by waiting.
    if ((error.status === 429 || error.status === 503) && typeof error.details.retryAfterSeconds === "number") c.header("Retry-After", String(error.details.retryAfterSeconds));
    return c.json({ error: error.message, code: error.code, ...error.details }, error.status as 400);
  }
  if (error instanceof ZodError) return c.json({ error: "Invalid request", code: "INVALID", details: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`) }, 400);
  if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON", code: "INVALID" }, 400);
  if (error instanceof Error && error.name === "AgentSecretError") return c.json({ error: "A stored agent secret failed its integrity check", code: "AGENT_SECRET_INTEGRITY" }, 500);
  throw error;
}

type Handler = (c: Context<AppEnv>) => unknown | Promise<unknown>;
const handle = (handler: Handler) => async (c: Context<AppEnv>) => {
  try {
    requireAgentsEnabled();
    const result = await handler(c);
    return result instanceof Response ? result : c.json(result as object);
  } catch (error) {
    return fail(c, error);
  }
};
/**
 * Admin provider routes that must work while the module is off by `key_mismatch` (review M3): the
 * list, one provider, PATCH (remove or re-enter the key), and DELETE. After a write the status is
 * decided again, so the module comes back once every stored secret opens.
 */
const handleRecovery = (handler: Handler) => async (c: Context<AppEnv>) => {
  try {
    if (!adminRecoveryAllowed()) requireAgentsEnabled();
    const result = await handler(c);
    if (c.req.method !== "GET") recheckAgentsStatus();
    return result instanceof Response ? result : c.json(result as object);
  } catch (error) {
    return fail(c, error);
  }
};
const adminOnly = (handler: Handler): Handler => (c) => {
  if (c.get("user").role !== "admin") throw new AgentError(404, "NOT_FOUND", "Not found");
  return handler(c);
};

/** Open SSE streams per run and per person (review L6): a browser needs one; a tab storm gets 429. */
export const STREAM_CAPS = { perRun: 4, perUser: 12 } as const;
const streamsPerRun = new Map<string, number>();
const streamsPerUser = new Map<string, number>();
const bump = (map: Map<string, number>, key: string, by: 1 | -1) => {
  const next = (map.get(key) ?? 0) + by;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
};
/** Chat update streams per person per chat (QA M1); they also count in `streamsPerUser`. */
const updatesPerChat = new Map<string, number>();
const chatUpdateFrame = (event: ChatUpdateEvent) => `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
/** Stream events only the run's owner receives (review M1): the confirmation card and its outcome. */
const OWNER_ONLY_EVENTS: ReadonlySet<string> = new Set(["confirmation_required", "confirmation_resolved"]);
export const openStreamCounts = (runId: string, userId: string) => ({ run: streamsPerRun.get(runId) ?? 0, user: streamsPerUser.get(userId) ?? 0 });
const chatter = (handler: Handler): Handler => (c) => {
  if (!roleMayChat(c.get("user").role)) throw new AgentError(403, "ROLE_REFUSED", "Your role cannot chat with agents");
  return handler(c);
};
const actorOf = (c: Context<AppEnv>) => ({ userId: c.get("user").id, role: c.get("user").role, displayName: c.get("user").display_name });

/** Guests never reach the module (AC-O2): every path is 404 for them, as if it did not exist. */
async function agentGate(c: Context<AppEnv>, next: Next) {
  if (c.get("user")?.role === "guest") return c.json({ error: "Not found" }, 404);
  await next();
}

export function registerAgentRoutes(app: Hono<AppEnv>) {
  for (const prefix of ["/api/agents", "/api/chats", "/api/runs"]) {
    app.use(prefix, agentGate);
    app.use(`${prefix}/*`, agentGate);
  }

  // Whether the module is on. Why it is off is for admins only.
  app.get("/api/agents/status", (c) => {
    const status = agentsStatus();
    const role = c.get("user").role;
    return c.json({
      enabled: status.enabled, reason: role === "admin" ? status.reason : null, canChat: status.enabled && roleMayChat(role), canCreate: status.enabled && roleMayCreate(role), defaultModel: DEFAULT_MODEL,
      // AC-C: whether the Audit log link shows (admins, and people with `agents:run` keys or runs).
      auditVisible: status.enabled && auditVisibleTo({ userId: c.get("user").id, role }),
      // AC-D (AC-O1): whether this person may create public chat links now (the policy on, member and above).
      publicChatLinks: status.enabled && roleMayPublish(role) && publicLinksOn(),
      // Admins only: whether a model provider exists, for the empty Chat list's "add one" line.
      ...(role === "admin" ? { hasProvider: db.query("SELECT 1 FROM agent_providers LIMIT 1").get() !== null } : {})
    });
  });

  // --- Images in chats (D370 as amended, T304; server/agents/images.ts) ---
  // An outside image the person chose to load: session only, the egress guard, image bytes only.
  app.get("/api/agents/image-proxy", handle((c) => proxyImage(c)));
  // A picture an MCP tool returned, to whoever can read the chat: the owner, and the people it is shared
  // with for the messages of the active branch only, as they see the chat (security review L3).
  app.get("/api/chats/:chatId/tool-images/:imageId", handle((c) => {
    const chatId = id(c, "chatId");
    const imageId = id(c, "imageId");
    const chat = readableChat(chatId, c.get("user").id);
    const visible = chat.owner_id === c.get("user").id ? null : new Set(pathTo(chatId, chat.active_leaf_id).map((row) => row.id));
    return toolImageResponse(chatId, imageId, visible);
  }));

  // --- Admin: providers and policy (plan §4.1) ---
  app.get("/api/agents/admin/settings", handle(adminOnly(() => ({ settings: readAgentSettings() }))));
  app.put("/api/agents/admin/settings", handle(adminOnly(async (c) => {
    const { expectedRevision, ...patch } = await parseJson(c.req.raw, settingsSchema);
    if (patch.defaultProviderId) providerRow(patch.defaultProviderId);
    if (patch.reportProviderId) providerRow(patch.reportProviderId);
    if (patch.reportFallbackProviderId) providerRow(patch.reportFallbackProviderId);
    return { settings: writeAgentSettings(c.get("user").id, patch, expectedRevision) };
  })));
  app.get("/api/agents/admin/providers", handleRecovery(adminOnly(() => ({ providers: listProviders() }))));
  app.post("/api/agents/admin/providers", handle(adminOnly(async (c) => c.json({ provider: createProvider(c.get("user").id, await parseJson(c.req.raw, providerCreateSchema)) }, 201))));
  app.get("/api/agents/admin/providers/:providerId", handleRecovery(adminOnly((c) => ({ provider: providerSummary(providerRow(id(c, "providerId"))) }))));
  app.patch("/api/agents/admin/providers/:providerId", handleRecovery(adminOnly(async (c) => ({ provider: updateProvider(c.get("user").id, id(c, "providerId"), await parseJson(c.req.raw, providerPatchSchema)) }))));
  app.delete("/api/agents/admin/providers/:providerId", handleRecovery(adminOnly((c) => { deleteProvider(c.get("user").id, id(c, "providerId")); return { ok: true }; })));
  app.post("/api/agents/admin/providers/:providerId/test", handle(adminOnly(async (c) => {
    const providerId = id(c, "providerId");
    await parseJson(c.req.raw, emptySchema);
    return { test: await testProvider(providerId) };
  })));
  // Wave 48b (D436): "Test tool calling", stored in the provider's compat flags.
  app.post("/api/agents/admin/providers/:providerId/test-tools", handle(adminOnly(async (c) => {
    const providerId = id(c, "providerId");
    await parseJson(c.req.raw, emptySchema);
    return { probe: await probeToolCalling(c.get("user").id, providerId), provider: providerSummary(providerRow(providerId)) };
  })));
  app.get("/api/agents/admin/providers/:providerId/models", handle(adminOnly(async (c) => {
    const providerId = id(c, "providerId");
    try {
      return await providerModels(providerId, { fresh: c.req.query("fresh") === "1" });
    } catch (error) {
      if (error instanceof AgentError) throw error;
      // Admins get the fuller excerpt (review L3); chat runs get the redacted one.
      throw new AgentError(502, "PROVIDER_ERROR", error instanceof ProviderError ? error.adminMessage : error instanceof Error && "code" in error ? error.message : "The provider could not be reached");
    }
  })));
  // --- Admin: tool servers (plan §4.1, AC-B) ---
  app.get("/api/agents/admin/servers", handle(adminOnly(() => {
    const servers = listServers();
    const adopted = new Set(servers.map((server) => server.stdioId).filter((id): id is string => id !== null));
    const declared = stdioEnabled() ? declaredStdioServers() : [];
    return { servers, stdio: { enabled: stdioEnabled(), declared: declared.map((entry) => ({ id: entry.id, name: entry.name, command: entry.command, args: entry.args, envNames: Object.keys(entry.env), adopted: adopted.has(entry.id) })) } };
  })));
  app.post("/api/agents/admin/servers", handle(adminOnly(async (c) => c.json(await createServerAndSync(c.get("user").id, await parseJson(c.req.raw, serverCreateSchema)), 201))));
  app.get("/api/agents/admin/servers/:serverId", handle(adminOnly((c) => ({ server: serverSummary(serverRow(id(c, "serverId"))) }))));
  app.patch("/api/agents/admin/servers/:serverId", handle(adminOnly(async (c) => updateServerAndSync(c.get("user").id, id(c, "serverId"), await parseJson(c.req.raw, serverPatchSchema)))));
  app.delete("/api/agents/admin/servers/:serverId", handle(adminOnly((c) => { deleteServer(c.get("user").id, id(c, "serverId")); return { ok: true }; })));
  app.post("/api/agents/admin/servers/:serverId/sync", handle(adminOnly(async (c) => {
    const serverId = id(c, "serverId");
    await parseJson(c.req.raw, emptySchema);
    return { server: await syncServer(c.get("user").id, serverId) };
  })));
  app.put("/api/agents/admin/servers/:serverId/policies", handle(adminOnly(async (c) => ({ server: setPolicies(c.get("user").id, id(c, "serverId"), (await parseJson(c.req.raw, policiesSchema)).policies) }))));

  // Usage (counts only, D73): tokens and runs per day per person or agent.
  app.get("/api/agents/admin/usage", handle(adminOnly((c) => {
    const group = c.req.query("group") === "agent" ? "agent" : "user";
    const from = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("from") ?? "") ? c.req.query("from")! : new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("to") ?? "") ? c.req.query("to")! : new Date().toISOString().slice(0, 10);
    const rows = group === "user"
      ? db.query(`SELECT u.day, u.user_id AS id, p.display_name AS name, SUM(u.runs) AS runs, SUM(u.prompt_tokens) AS prompt_tokens, SUM(u.completion_tokens) AS completion_tokens
          FROM agent_usage_daily u LEFT JOIN users p ON p.id = u.user_id WHERE u.day BETWEEN ? AND ? GROUP BY u.day, u.user_id ORDER BY u.day DESC, name LIMIT 2000`).all(from, to)
      // AC-E: embedding tokens are charged under `kb:<id>`; they show as "Knowledge · <name>".
      : db.query(`SELECT u.day, u.agent_id AS id, COALESCE(a.name, (SELECT 'Knowledge · ' || k.name FROM knowledge_bases k WHERE 'kb:' || k.id = u.agent_id)) AS name, SUM(u.runs) AS runs, SUM(u.prompt_tokens) AS prompt_tokens, SUM(u.completion_tokens) AS completion_tokens
          FROM agent_usage_daily u LEFT JOIN agents a ON a.id = u.agent_id WHERE u.day BETWEEN ? AND ? GROUP BY u.day, u.agent_id ORDER BY u.day DESC, name LIMIT 2000`).all(from, to);
    return { from, to, group, rows: (rows as Array<{ day: string; id: string; name: string | null; runs: number; prompt_tokens: number; completion_tokens: number }>).map((row) => ({ day: row.day, id: row.id, name: row.name ?? "(removed)", runs: row.runs, promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens })) };
  })));

  // The caller's own usage today, for the budget indicator (before the :agentId routes).
  app.get("/api/agents/usage", handle(chatter((c) => ({ usage: dailyUsage(c.get("user").id) }))));
  // The agent editor's provider picker: names and known models only, for anyone who may create (and so edit) agents.
  app.get("/api/agents/providers", handle(chatter((c) => {
    if (!roleMayCreate(c.get("user").role)) throw new AgentError(403, "ROLE_REFUSED", "Your role cannot create agents");
    return { providers: providerChoices() };
  })));
  // The tool picker's catalog (plan §12): servers the caller may use, and Nook's tools (bounded by the linked key when `agentId` is given).
  app.get("/api/agents/catalog", handle(chatter(async (c) => {
    const raw = c.req.query("agentId");
    const agentId = raw ? uuid.safeParse(raw.toLowerCase()) : null;
    if (agentId && !agentId.success) throw new AgentError(404, "NOT_FOUND", "Not found");
    if (agentId) usableAgent(agentId.data, c.get("user").id);
    // C1 lazy sync: an enabled server never synced lists its tools once (bounded, once a minute per server).
    await ensureServersSynced(serversAvailableTo(c.get("user").role).filter((row) => row.enabled === 1 && row.tools_synced_at === null).map((row) => row.id));
    return { catalog: catalogFor(c.get("user").role, agentId ? agentId.data : null, c.get("user").id) };
  })));
  // C2: turn the automatic Nook tools back on after the caller (or an admin) revoked their internal key: a new one.
  app.post("/api/agents/nook-key/restore", handle(chatter(async (c) => {
    await parseJson(c.req.raw, emptySchema);
    const user = c.get("user");
    if (user.role === "guest") throw new AgentError(403, "ROLE_REFUSED", "Guests do not get Nook's tools in agents");
    if (!readAgentSettings().nookAutoTools) throw new AgentError(409, "NOOK_AUTO_OFF", "An admin turned off Nook's automatic tools for agents");
    const keyId = ensureInternalAgentKey(user.id, { restore: true });
    if (!keyId) throw new AgentError(409, "NOOK_AUTO_UNAVAILABLE", "Nook's tools cannot be turned on for this account");
    return { ok: true };
  })));
  // --- The Audit log (AC-C, plan §7.3, D366): the key's owner in full, admins metadata only ---
  const auditFilter = (c: Context<AppEnv>) => {
    const optionalId = (name: string) => {
      const raw = c.req.query(name);
      if (!raw) return null;
      const parsed = uuid.safeParse(raw.toLowerCase());
      if (!parsed.success) throw new AgentError(400, "INVALID", `${name} must be an id`, { field: name });
      return parsed.data;
    };
    return { keyId: optionalId("key"), agentId: optionalId("agent"), ownerId: optionalId("owner"), status: c.req.query("status")?.slice(0, 20) || null, from: c.req.query("from") || null, to: c.req.query("to") || null, cursor: c.req.query("cursor")?.slice(0, 120) || null };
  };
  const viewerOf = (c: Context<AppEnv>) => ({ userId: c.get("user").id, role: c.get("user").role });
  app.get("/api/agents/audit", handle((c) => listAuditRuns(viewerOf(c), auditFilter(c))));
  // The filter sheet's choices (QA M3): own keys and agents; admins also the names on every run they can see.
  app.get("/api/agents/audit/facets", handle((c) => ({ facets: auditFacets(viewerOf(c)) })));
  app.get("/api/agents/audit/export", handle((c) => {
    const raw = c.req.query("runId");
    const runId = raw ? uuid.safeParse(raw.toLowerCase()) : null;
    if (runId && !runId.success) throw new AgentError(404, "NOT_FOUND", "Not found");
    const exported = exportAuditRuns(viewerOf(c), { ...auditFilter(c), runId: runId ? runId.data : null });
    const name = runId ? `nook-agent-run-${runId.data}.json` : `nook-agent-audit-${new Date().toISOString().slice(0, 10)}.json`;
    return new Response(JSON.stringify(exported, null, 2), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }));
  app.get("/api/agents/audit/:runId", handle((c) => ({ run: auditRunDetail(viewerOf(c), id(c, "runId")) })));
  // An agent's API and MCP runs per day, for the people who manage it (counts only, D366).
  app.get("/api/agents/:agentId/api-usage", handle(chatter((c) => {
    const agentId = id(c, "agentId");
    manageableAgent(agentId, c.get("user").id);
    return { usage: agentApiUsage(agentId) };
  })));
  // Link Nook key (plan §5.3, D359): the caller's own live general key with the MCP surface, a pointer never a token.
  app.get("/api/agents/:agentId/link", handle(chatter((c) => {
    const agentId = id(c, "agentId");
    usableAgent(agentId, c.get("user").id);
    return { link: currentLink(agentId, c.get("user").id), keys: linkableKeys(c.get("user").id) };
  })));
  app.put("/api/agents/:agentId/link", handle(chatter(async (c) => {
    const agentId = id(c, "agentId");
    usableAgent(agentId, c.get("user").id);
    const body = await parseJson(c.req.raw, linkSchema);
    return { link: setLink(c.get("user").id, agentId, body.nookKeyId) };
  })));
  // --- Agents (plan §5.1): own agents in this slice ---
  app.get("/api/agents", handle(chatter((c) => ({ agents: listUsableAgents(c.get("user").id) }))));
  app.post("/api/agents", handle(async (c) => c.json({ agent: createAgent(actorOf(c), await parseJson(c.req.raw, agentCreateSchema)) }, 201)));
  app.get("/api/agents/:agentId", handle(chatter((c) => ({ agent: agentDetail(usableAgent(id(c, "agentId"), c.get("user").id), c.get("user").id) }))));
  app.patch("/api/agents/:agentId", handle(async (c) => ({ agent: updateAgent(actorOf(c), id(c, "agentId"), await parseJson(c.req.raw, agentPatchSchema)) })));
  app.delete("/api/agents/:agentId", handle((c) => deleteAgent(actorOf(c), id(c, "agentId"))));

  // --- Sharing (AC-D, plan §6.2, D356, D361): the Access sheet for agents (owner and managers) and chats (owner) ---
  const shareRoutes = (kind: ShareKind, path: string, param: string) => {
    app.get(path, handle(chatter((c) => {
      const access = readShareAccess(kind, id(c, param), c.get("user").id);
      c.header("ETag", access.etag);
      return access;
    })));
    app.put(path, handle(chatter(async (c) => {
      const itemId = id(c, param);
      const body = await parseJson(c.req.raw, shareAccessSchema);
      const access = writeShareAccess(kind, itemId, { userId: c.get("user").id }, body, c.req.header("If-Match"));
      c.header("ETag", access.etag);
      return access;
    })));
  };
  shareRoutes("agent", "/api/agents/:agentId/access", "agentId");
  shareRoutes("chat", "/api/chats/:chatId/access", "chatId");

  // --- Chats (plan §6.1) ---
  app.get("/api/chats", handle(chatter((c) => {
    const q = c.req.query("q")?.slice(0, 200);
    // AC-D: `?shared=1` lists the chats others shared with the caller ("Shared with me").
    return c.req.query("shared") === "1" ? { chats: listSharedChats(c.get("user").id, { q }) } : { chats: listChats(c.get("user").id, { q }) };
  })));
  app.post("/api/chats", handle(chatter(async (c) => c.json({ chat: createChat(c.get("user").id, (await parseJson(c.req.raw, chatCreateSchema)).agentId) }, 201))));
  app.get("/api/chats/:chatId", handle(chatter((c) => {
    const detail = chatDetail(id(c, "chatId"), c.get("user").id);
    const owner = detail.chat.yourLevel === "owner";
    // Recipients read the transcript (tool calls and results included); the confirmation card and the public link are the owner's.
    return { ...detail, pendingConfirmation: owner ? pendingConfirmationFor(detail.activeRunId) : null, ...(owner ? { publicLink: publicLinkState(detail.chat.id) } : {}) };
  })));
  // Continue as a copy (D361): the caller's own chat holding the branch up to `messageId`.
  app.post("/api/chats/:chatId/fork", handle(chatter(async (c) => {
    const chatId = id(c, "chatId");
    const body = await parseJson(c.req.raw, forkSchema);
    return c.json({ chat: forkChat(c.get("user").id, chatId, body.messageId.toLowerCase()) }, 201);
  })));
  // Public link (AC-O1, D362): owner only, behind `public_chat_links`; every route 404 with the policy off.
  app.get("/api/chats/:chatId/public", handle(chatter((c) => publicLinkFor(actorOf(c), id(c, "chatId")))));
  app.put("/api/chats/:chatId/public", handle(chatter(async (c) => {
    const chatId = id(c, "chatId");
    if (!publicLinksOn()) throw new AgentError(404, "NOT_FOUND", "Not found");
    const body = await parseJson(c.req.raw, publicLinkSchema);
    return upsertPublicLink(actorOf(c), chatId, body);
  })));
  app.delete("/api/chats/:chatId/public", handle(chatter((c) => revokePublicLink(actorOf(c), id(c, "chatId")))));
  app.patch("/api/chats/:chatId", handle(chatter(async (c) => ({ chat: updateChat(c.get("user").id, id(c, "chatId"), await parseJson(c.req.raw, chatPatchSchema)) }))));
  app.delete("/api/chats/:chatId", handle(chatter((c) => {
    const chatId = id(c, "chatId");
    const result = deleteChat(c.get("user").id, chatId);
    cancelChatRuns(chatId);
    return result;
  })));
  // Send (plan §12): inserts the user turn and starts the run; the client follows it on /api/runs/:id/events.
  app.post("/api/chats/:chatId/messages", handle(chatter(async (c) => {
    const chatId = id(c, "chatId");
    const body = await parseJson(c.req.raw, messageSchema);
    const started = startChatRun(actorOf(c), chatId, { kind: "send", content: body.content, parentId: body.parentId, attachments: body.attachments });
    // The contract's camelCase message shape (QA Q12), the same as `messages[]` in GET /api/chats/:id.
    const userMessage = started.userMessage ? withAttachments(messageOf(started.userMessage), chatAttachmentsFor([started.userMessage.id])) : null;
    return c.json({ runId: started.runId, userMessage, assistantMessage: messageOf(started.assistantMessage) }, 201);
  })));
  app.post("/api/chats/:chatId/messages/:messageId/regenerate", handle(chatter(async (c) => {
    const chatId = id(c, "chatId");
    const messageId = id(c, "messageId");
    await parseJson(c.req.raw, emptySchema);
    const started = startChatRun(actorOf(c), chatId, { kind: "regenerate", messageId });
    return c.json({ runId: started.runId, userMessage: null, assistantMessage: messageOf(started.assistantMessage) }, 201);
  })));
  app.get("/api/chats/:chatId/run", handle(chatter((c) => {
    const chatId = id(c, "chatId");
    readableChat(chatId, c.get("user").id);
    const live = activeRunForChat(chatId);
    return { run: live ? { id: live.runId, messageId: live.messageId } : null };
  })));

  /**
   * Chat updates (Wave 43 fixes, QA M1): an SSE stream for someone reading a chat (the owner's other
   * tabs too) that says when a message was added, a run started (`run_started {runId}`, which the
   * client follows on /api/runs/:id/events), the chat changed, or it can no longer be read (`gone`).
   * `since` is the chat revision the client has: when the chat moved on, a catch-up event goes first.
   * Access is re-checked on every event and every 15 s. The streams count against the per-person cap
   * of run streams, and at most `STREAM_CAPS.perRun` per person per chat.
   */
  app.get("/api/chats/:chatId/updates", (c) => {
    try {
      requireAgentsEnabled();
      if (!roleMayChat(c.get("user").role)) throw new AgentError(403, "ROLE_REFUSED", "Your role cannot chat with agents");
      const chatId = id(c, "chatId");
      const userId = c.get("user").id;
      const chat = readableChat(chatId, userId);
      const sinceRaw = c.req.query("since") ?? "0";
      const since = /^\d{1,9}$/.test(sinceRaw) ? Number(sinceRaw) : 0;
      const slot = `${chatId}:${userId}`;
      if ((updatesPerChat.get(slot) ?? 0) >= STREAM_CAPS.perRun || (streamsPerUser.get(userId) ?? 0) >= STREAM_CAPS.perUser) throw new AgentError(429, "TOO_MANY_STREAMS", "Too many open streams; close another tab with this chat", { retryAfterSeconds: 2 });
      bump(updatesPerChat, slot, 1);
      bump(streamsPerUser, userId, 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        bump(updatesPerChat, slot, -1);
        bump(streamsPerUser, userId, -1);
      };
      c.header("X-Accel-Buffering", "no");
      keepRequestOpen(c.req.raw);
      const stillReadable = () => {
        const row = db.query("SELECT id, owner_id, visibility, deleted_at FROM chats WHERE id = ?").get(chatId) as { id: string; owner_id: string; visibility: string; deleted_at: string | null } | null;
        return row !== null && shareLevel("chat", row, userId) !== "none";
      };
      const response = streamSSE(c, async (stream) => {
        const queue: ChatUpdateEvent[] = [];
        let wake: (() => void) | null = null;
        const unsubscribe = subscribeChatUpdates(chatId, (event) => { queue.push(event); wake?.(); });
        // A tick wakes the idle loop: a keep-alive every SSE_TIMING.pingMs, an access re-check every accessCheckMs (QA D1).
        const { pingMs, accessCheckMs } = SSE_TIMING;
        const keepAlive = setInterval(() => { wake?.(); }, Math.min(pingMs, accessCheckMs));
        stream.onAbort(() => { wake?.(); });
        let lastCheck = Date.now();
        let lastPing = Date.now();
        try {
          // Headers go out with the first bytes: a comment, so the client knows it is subscribed.
          await stream.write(": open\n\n");
          if (chat.revision > since) {
            const live = activeRunForChat(chatId);
            await stream.write(chatUpdateFrame(live ? { type: "run_started", data: { runId: live.runId, messageId: live.messageId, revision: chat.revision } } : { type: "chat_changed", data: { revision: chat.revision } }));
          }
          for (;;) {
            if (stream.aborted) break;
            if (queue.length === 0) {
              if (Date.now() - lastCheck >= accessCheckMs) {
                lastCheck = Date.now();
                if (!stillReadable()) { await stream.write(chatUpdateFrame({ type: "gone", data: {} })); break; }
              }
              if (Date.now() - lastPing >= pingMs) {
                lastPing = Date.now();
                await stream.write(": ping\n\n");
              }
              await new Promise<void>((resolve) => { wake = resolve; });
              wake = null;
              continue;
            }
            const event = queue.shift()!;
            // Live per event (T325): someone taken off the chat, or a chat deleted, ends here.
            if (event.type === "gone" || !stillReadable()) { await stream.write(chatUpdateFrame({ type: "gone", data: {} })); break; }
            await stream.write(chatUpdateFrame(event));
          }
        } finally {
          clearInterval(keepAlive);
          unsubscribe();
          release();
        }
      }, async () => { release(); });
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      return fail(c, error);
    }
  });

  // --- Runs (plan §2.3): resume, cancel, and confirm (plan §5.4) ---
  app.post("/api/runs/:runId/cancel", handle(chatter(async (c) => {
    const runId = id(c, "runId");
    await parseJson(c.req.raw, emptySchema);
    return cancelRun(runId, c.get("user").id);
  })));
  app.post("/api/runs/:runId/confirm", handle(chatter(async (c) => {
    const runId = id(c, "runId");
    const body = await parseJson(c.req.raw, confirmSchema);
    return confirmRun(runId, c.get("user").id, { confirmationId: body.confirmationId, argsHash: body.argsHash }, body.decision);
  })));
  app.get("/api/runs/:runId/events", (c) => {
    try {
      requireAgentsEnabled();
      if (!roleMayChat(c.get("user").role)) throw new AgentError(403, "ROLE_REFUSED", "Your role cannot chat with agents");
      const runId = id(c, "runId");
      // AC-D: the chat's owner, or someone it is shared with (read-only, re-checked per request, T325).
      const run = runReadableBy(runId, c.get("user").id);
      const afterRaw = c.req.query("after") ?? "0";
      const after = /^\d{1,9}$/.test(afterRaw) ? Number(afterRaw) : 0;
      const channel = channelOf(runId);
      const userId = c.get("user").id;
      const counts = openStreamCounts(runId, userId);
      if (counts.run >= STREAM_CAPS.perRun || counts.user >= STREAM_CAPS.perUser) throw new AgentError(429, "TOO_MANY_STREAMS", "Too many open streams; close another tab following this answer", { retryAfterSeconds: 2 });
      bump(streamsPerRun, runId, 1);
      bump(streamsPerUser, userId, 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        bump(streamsPerRun, runId, -1);
        bump(streamsPerUser, userId, -1);
      };
      c.header("X-Accel-Buffering", "no");
      keepRequestOpen(c.req.raw);
      // streamSSE sets no-cache; SSE replies carry chat text, so they are no-store like the rest of /api (T325).
      // Review M1: the confirmation card (its nonce, the arguments' hash, the full arguments) is the
      // owner's alone; recipients following the run never get it, neither from the ring nor live.
      const ownerOnly = !run.owner;
      const follow = async (stream: Parameters<Parameters<typeof streamSSE>[1]>[0]) => {
        const send = async (event: SequencedEvent) => {
          if (ownerOnly && OWNER_ONLY_EVENTS.has(event.type)) return;
          await stream.write(sseFrame(event));
        };
        // A snapshot replaces what the ring no longer holds; an ended run's snapshot is followed by its
        // `done`, so every stream ends the same way (TODO "`?after` overflow"): `snapshot`, then `done`.
        const snapshot = async () => {
          const fresh = runReadableBy(runId, userId);
          const data = runSnapshot(fresh, { owner: fresh.owner });
          await stream.write(`id: 0\nevent: snapshot\ndata: ${JSON.stringify(data)}\n\n`);
          return data;
        };
        const snapshotThenDone = async () => {
          const data = await snapshot();
          await stream.write(sseFrame({ seq: channel?.lastSeq ?? 0, type: "done", data: { status: data.status, messageId: data.messageId } }));
        };
        if (!channel || channel.closed && channel.replay(after) === "overflow") {
          await snapshotThenDone();
          return;
        }
        // `after` past the ring (or past everything the run emitted) is an overflow too (review L7): a
        // snapshot, then the live events after it. The queue is filled before anything is written, so an
        // event emitted while the replay or the snapshot is written is never lost.
        const replay = channel.replay(after);
        const queue: SequencedEvent[] = replay === "overflow" ? [] : [...replay];
        let seen = replay === "overflow" ? channel.lastSeq : Math.max(after, replay.at(-1)?.seq ?? after);
        let wake: (() => void) | null = null;
        let ended = false;
        const unsubscribe = channel.subscribe((event) => {
          if (event === null) ended = true;
          else if (event.seq > seen) { queue.push(event); seen = event.seq; }
          wake?.();
        });
        const { pingMs } = SSE_TIMING;
        const keepAlive = setInterval(() => { wake?.(); }, pingMs);
        stream.onAbort(() => { wake?.(); });
        let lastPing = Date.now();
        try {
          if (replay === "overflow") await snapshot();
          while (!ended || queue.length > 0) {
            if (queue.length === 0) {
              if (Date.now() - lastPing >= pingMs) {
                await stream.write(": ping\n\n");
                lastPing = Date.now();
              }
              if (stream.aborted) break;
              await new Promise<void>((resolve) => { wake = resolve; });
              wake = null;
              continue;
            }
            await send(queue.shift()!);
          }
        } finally {
          clearInterval(keepAlive);
          unsubscribe();
        }
      };
      const response = streamSSE(c, async (stream) => {
        try {
          await follow(stream);
        } finally {
          release();
        }
      }, async () => { release(); });
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      return fail(c, error);
    }
  });
}
