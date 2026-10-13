import { audit, db, now } from "../db";
import { AGENT_BOUNDS, DEFAULT_BASE_URL, DEFAULT_COMPAT, DEFAULT_EMBEDDING_DIMS, DEFAULT_EMBEDDING_MODEL, DEFAULT_KNOWLEDGE_POLICY, DEFAULT_MODEL, DEFAULT_VISION_POLICY, EMBEDDING_MODEL_ID, KNOWLEDGE_POLICY_BOUNDS, policyAllowsModel, policyMaxDims, VISION_POLICY_BOUNDS, visionAllowsModel, type AgentProviderChoice, type ProviderCompat, type ProviderKnowledgePolicy, type ProviderSummary, type ProviderVisionPolicy } from "../../shared/agents";
import type { KnowledgeEmbeddingChoice } from "../../shared/knowledge";
import type { ToolCallingProbe } from "../../shared/reportsModel";
import { checkSavedEndpoint, EgressError } from "./egress";
import { completeStreaming, listModels, ProviderError, type ProviderConnection } from "./loop";
import { openSecret, sealSecret, secretHint, shownHint } from "./secrets";
import { readAgentSettings } from "./settings";
import { AgentError } from "./status";
import { knowledgeProviderHook } from "../knowledge/hooks";

/**
 * Providers (plan §4.1): at most five OpenAI-compatible endpoints, one of them the default. The API
 * key is write-only (D354): `PUT`/`PATCH` take `apiKey`, reads return `hasSecret` and `hint`, and
 * the plaintext is opened only inside `connectionFor` for the duration of one request.
 */

export type ProviderRow = {
  id: string; name: string; base_url: string; api_key_ct: string | null; api_key_hint: string | null; default_model: string;
  embedding_model: string | null; embedding_dims: number | null; compat_json: string; prices_json: string | null; is_default: number;
  revision: number; created_at: string; updated_at: string;
};

export function parseCompat(json: string | null): ProviderCompat {
  let value: Partial<ProviderCompat> = {};
  try { value = json ? JSON.parse(json) as Partial<ProviderCompat> : {}; } catch { value = {}; }
  return {
    tokenParam: value.tokenParam === "max_tokens" ? "max_tokens" : DEFAULT_COMPAT.tokenParam,
    streamUsage: value.streamUsage !== false,
    supportsTools: value.supportsTools !== false,
    ...(value.namedToolChoice === false ? { namedToolChoice: false } : {}),
    ...(value.requiredToolChoice === false ? { requiredToolChoice: false } : {}),
    contextTokens: typeof value.contextTokens === "number" && value.contextTokens >= 1024 && value.contextTokens <= 10_000_000 ? Math.floor(value.contextTokens) : DEFAULT_COMPAT.contextTokens
  };
}

/**
 * The knowledge base policy (2026-10-08) kept on the same JSON column as `compat`, under `knowledge`
 * (no migration). Anything malformed reads as the default (any model, up to 3,072, allowed).
 */
export function parseKnowledgePolicy(json: string | null): ProviderKnowledgePolicy {
  let value: { knowledge?: Partial<ProviderKnowledgePolicy> } | null = {};
  try { value = json ? JSON.parse(json) as typeof value : {}; } catch { value = {}; }
  const policy: Partial<ProviderKnowledgePolicy> = value && typeof value.knowledge === "object" && value.knowledge !== null ? value.knowledge : {};
  const models = Array.isArray(policy.models)
    ? [...new Set(policy.models.filter((model): model is string => typeof model === "string" && model.length <= KNOWLEDGE_POLICY_BOUNDS.modelName && EMBEDDING_MODEL_ID.test(model)))].slice(0, KNOWLEDGE_POLICY_BOUNDS.models)
    : null;
  const maxDims = typeof policy.maxDims === "number" && Number.isInteger(policy.maxDims) && policy.maxDims >= KNOWLEDGE_POLICY_BOUNDS.minDims && policy.maxDims <= KNOWLEDGE_POLICY_BOUNDS.maxDims ? policy.maxDims : null;
  return { enabled: policy.enabled !== false, models: models && models.length ? models : null, maxDims };
}

const samePolicy = (a: ProviderKnowledgePolicy | ProviderVisionPolicy, b: ProviderKnowledgePolicy | ProviderVisionPolicy) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The image policy (uploads everywhere U5, Q10) kept on the same JSON column, under `vision` (no
 * migration). Anything malformed reads as the default, off, so no image leaves for a model nobody marked.
 */
export function parseVisionPolicy(json: string | null): ProviderVisionPolicy {
  let value: { vision?: Partial<ProviderVisionPolicy> } | null = {};
  try { value = json ? JSON.parse(json) as typeof value : {}; } catch { value = {}; }
  const policy: Partial<ProviderVisionPolicy> = value && typeof value.vision === "object" && value.vision !== null ? value.vision : {};
  const models = Array.isArray(policy.models)
    ? [...new Set(policy.models.filter((model): model is string => typeof model === "string" && model.length >= 1 && model.length <= VISION_POLICY_BOUNDS.modelName && EMBEDDING_MODEL_ID.test(model)))].slice(0, VISION_POLICY_BOUNDS.models)
    : null;
  if (policy.enabled !== true || (models !== null && models.length === 0)) return { ...DEFAULT_VISION_POLICY };
  return { enabled: true, models };
}

/**
 * Whether a run of an agent with this provider and model may send images (U5): the row `connectionFor`
 * would use (the agent's provider, else the default) and the model it would call.
 */
export function visionFor(providerId: string | null, model: string | null): boolean {
  const row = (providerId ? db.query("SELECT compat_json, default_model FROM agent_providers WHERE id = ?").get(providerId) as { compat_json: string; default_model: string } | null : null) ?? defaultProvider();
  if (!row) return false;
  return visionAllowsModel(parseVisionPolicy(row.compat_json), model?.trim() || row.default_model);
}

/** Whether a resolved connection's model may be sent images now (read fresh: an admin may have changed it). */
export function connectionSeesImages(connection: Pick<ProviderConnection, "id" | "model">): boolean {
  const row = db.query("SELECT compat_json FROM agent_providers WHERE id = ?").get(connection.id) as { compat_json: string } | null;
  return row !== null && visionAllowsModel(parseVisionPolicy(row.compat_json), connection.model);
}

/** The knowledge base policy of a provider, or null when the provider is gone. */
export function knowledgePolicyOf(providerId: string | null): ProviderKnowledgePolicy | null {
  if (!providerId) return null;
  const row = db.query("SELECT compat_json FROM agent_providers WHERE id = ?").get(providerId) as { compat_json: string } | null;
  return row ? parseKnowledgePolicy(row.compat_json) : null;
}

export const providerSummary = (row: ProviderRow): ProviderSummary => ({
  id: row.id, name: row.name, baseUrl: row.base_url, defaultModel: row.default_model, embeddingModel: row.embedding_model, embeddingDims: row.embedding_dims,
  compat: parseCompat(row.compat_json), isDefault: row.is_default === 1, hasSecret: row.api_key_ct !== null, hint: shownHint(row.api_key_ct, row.api_key_hint),
  revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, knowledge: parseKnowledgePolicy(row.compat_json), vision: parseVisionPolicy(row.compat_json)
});

export function listProviders(): ProviderSummary[] {
  return (db.query("SELECT * FROM agent_providers ORDER BY is_default DESC, created_at").all() as ProviderRow[]).map(providerSummary);
}

export function providerRow(id: string): ProviderRow {
  const row = db.query("SELECT * FROM agent_providers WHERE id = ?").get(id) as ProviderRow | null;
  if (!row) throw new AgentError(404, "NOT_FOUND", "Not found");
  return row;
}

export type ProviderInput = {
  name: string; baseUrl?: string; apiKey?: string | null; defaultModel?: string; embeddingModel?: string | null; embeddingDims?: number | null;
  compat?: Partial<ProviderCompat>; isDefault?: boolean;
  /** The knowledge base policy (2026-10-08); fields left out keep their value. */
  knowledge?: Partial<ProviderKnowledgePolicy>;
  /** U5: which models may be sent images; fields left out keep their value. */
  vision?: Partial<ProviderVisionPolicy>;
};

/**
 * The shape check at save time (QA Q7): scheme, credentials, fragment, Nook's own origin, plain http
 * only for a listed host, and a literal private or loopback address only when listed. No DNS here;
 * names are resolved and checked before every call.
 */
function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    checkSavedEndpoint(trimmed);
  } catch (error) {
    if (error instanceof EgressError) throw new AgentError(400, "EGRESS_REFUSED", error.message, { field: "baseUrl" });
    throw new AgentError(400, "INVALID", "The base URL is not valid", { field: "baseUrl" });
  }
  return trimmed;
}

/** The column's JSON: the compatibility options, and the knowledge and vision policies only when they are not the default. */
const compatJson = (current: ProviderCompat, patch: Partial<ProviderCompat> | undefined, knowledge: ProviderKnowledgePolicy, vision: ProviderVisionPolicy) =>
  JSON.stringify({ ...parseCompat(JSON.stringify({ ...current, ...(patch ?? {}) })), ...(samePolicy(knowledge, DEFAULT_KNOWLEDGE_POLICY) ? {} : { knowledge }), ...(samePolicy(vision, DEFAULT_VISION_POLICY) ? {} : { vision }) });
/** A vision patch over the current policy, normalized as it is read back. */
const mergedVision = (current: ProviderVisionPolicy, patch: Partial<ProviderVisionPolicy> | undefined) =>
  parseVisionPolicy(JSON.stringify({ vision: { ...current, ...(patch ?? {}) } }));
/** A policy patch over the current policy, normalized as it is read back. */
const mergedPolicy = (current: ProviderKnowledgePolicy, patch: Partial<ProviderKnowledgePolicy> | undefined) =>
  parseKnowledgePolicy(JSON.stringify({ knowledge: { ...current, ...(patch ?? {}) } }));
/** What the audit records of a policy (model ids are not secret; never a URL or key). */
const policyAudit = (policy: ProviderKnowledgePolicy) => ({ enabled: policy.enabled, models: policy.models, maxDims: policy.maxDims });

export function createProvider(actorId: string, input: ProviderInput): ProviderSummary {
  return db.transaction(() => {
    const count = (db.query("SELECT COUNT(*) AS count FROM agent_providers").get() as { count: number }).count;
    if (count >= AGENT_BOUNDS.providers) throw new AgentError(409, "LIMIT_REACHED", `At most ${AGENT_BOUNDS.providers} providers can be configured`);
    const id = crypto.randomUUID();
    const timestamp = now();
    const makeDefault = input.isDefault === true || count === 0;
    if (makeDefault) db.query("UPDATE agent_providers SET is_default = 0 WHERE is_default = 1").run();
    const apiKey = input.apiKey?.trim() || null;
    const policy = mergedPolicy(DEFAULT_KNOWLEDGE_POLICY, input.knowledge);
    const vision = mergedVision(DEFAULT_VISION_POLICY, input.vision);
    db.query(`INSERT INTO agent_providers (id, name, base_url, api_key_ct, api_key_hint, default_model, embedding_model, embedding_dims, compat_json, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.name.trim(), normalizeBaseUrl(input.baseUrl ?? DEFAULT_BASE_URL), apiKey ? sealSecret("provider", id, apiKey) : null, apiKey ? secretHint(apiKey) : null,
      (input.defaultModel ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL, input.embeddingModel?.trim() || null, input.embeddingDims ?? null,
      compatJson(DEFAULT_COMPAT, input.compat, policy, vision), makeDefault ? 1 : 0, timestamp, timestamp
    );
    audit(actorId, null, "agents.provider.create", { providerId: id, hasSecret: apiKey !== null, ...(samePolicy(policy, DEFAULT_KNOWLEDGE_POLICY) ? {} : { knowledgePolicy: policyAudit(policy) }), ...(samePolicy(vision, DEFAULT_VISION_POLICY) ? {} : { visionPolicy: vision }) });
    return providerSummary(providerRow(id));
  })();
}

export function updateProvider(actorId: string, id: string, input: Partial<ProviderInput> & { expectedRevision: number; removeSecret?: boolean }): ProviderSummary {
  const beforeUrl = providerRow(id).base_url;
  const updated = db.transaction(() => {
    const row = providerRow(id);
    if (row.revision !== input.expectedRevision) throw new AgentError(409, "REVISION_MISMATCH", "This provider changed elsewhere; reload and try again", { revision: row.revision });
    const apiKey = input.apiKey?.trim() || null;
    const apiKeyCt = input.removeSecret ? null : apiKey ? sealSecret("provider", id, apiKey) : row.api_key_ct;
    const hint = input.removeSecret ? null : apiKey ? secretHint(apiKey) : row.api_key_hint;
    if (input.isDefault === true) db.query("UPDATE agent_providers SET is_default = 0 WHERE is_default = 1 AND id <> ?").run(id);
    if (input.isDefault === false && row.is_default === 1) throw new AgentError(409, "DEFAULT_REQUIRED", "Make another provider the default first");
    const policyBefore = parseKnowledgePolicy(row.compat_json);
    const policy = mergedPolicy(policyBefore, input.knowledge);
    const visionBefore = parseVisionPolicy(row.compat_json);
    const vision = mergedVision(visionBefore, input.vision);
    db.query(`UPDATE agent_providers SET name = ?, base_url = ?, api_key_ct = ?, api_key_hint = ?, default_model = ?, embedding_model = ?, embedding_dims = ?, compat_json = ?,
      is_default = ?, revision = revision + 1, updated_at = ? WHERE id = ?`).run(
      (input.name ?? row.name).trim(), input.baseUrl !== undefined ? normalizeBaseUrl(input.baseUrl) : row.base_url, apiKeyCt, hint,
      (input.defaultModel ?? row.default_model).trim() || DEFAULT_MODEL, input.embeddingModel !== undefined ? input.embeddingModel?.trim() || null : row.embedding_model,
      input.embeddingDims !== undefined ? input.embeddingDims : row.embedding_dims, compatJson(parseCompat(row.compat_json), input.compat, policy, vision),
      input.isDefault === true ? 1 : row.is_default, now(), id
    );
    // 2026-10-08: a changed knowledge policy is recorded with its new value (bases over it are grandfathered, never re-embedded).
    audit(actorId, null, "agents.provider.update", { providerId: id, secretChanged: apiKey !== null || input.removeSecret === true, ...(samePolicy(policy, policyBefore) ? {} : { knowledgePolicy: policyAudit(policy) }), ...(samePolicy(vision, visionBefore) ? {} : { visionPolicy: vision }) });
    return providerSummary(providerRow(id));
  })();
  // Wave 44 fixes (M3): a provider pointed at another address re-embeds the knowledge bases made with it.
  if (updated.baseUrl !== beforeUrl) knowledgeProviderHook({ kind: "changed", providerId: id });
  return updated;
}

export function deleteProvider(actorId: string, id: string) {
  db.transaction(() => {
    const row = providerRow(id);
    db.query("DELETE FROM agent_providers WHERE id = ?").run(id);
    if (row.is_default === 1) {
      const next = db.query("SELECT id FROM agent_providers ORDER BY created_at LIMIT 1").get() as { id: string } | null;
      if (next) db.query("UPDATE agent_providers SET is_default = 1 WHERE id = ?").run(next.id);
    }
    audit(actorId, null, "agents.provider.delete", { providerId: id });
  })();
  modelCache.delete(id);
  // Wave 44 fixes (M3): its knowledge bases fail closed (never the new default).
  knowledgeProviderHook({ kind: "removed", providerId: id });
}

/** The default provider row, or null when none is configured. */
export function defaultProvider(): ProviderRow | null {
  const settings = readAgentSettings();
  if (settings.defaultProviderId) {
    const chosen = db.query("SELECT * FROM agent_providers WHERE id = ?").get(settings.defaultProviderId) as ProviderRow | null;
    if (chosen) return chosen;
  }
  return (db.query("SELECT * FROM agent_providers WHERE is_default = 1").get() as ProviderRow | null)
    ?? (db.query("SELECT * FROM agent_providers ORDER BY created_at LIMIT 1").get() as ProviderRow | null);
}

/**
 * The connection a run uses: the agent's provider when set and still present, else the default.
 * The API key is opened here and lives on the returned object for one request only.
 */
export function connectionFor(providerId: string | null, model: string | null): ProviderConnection {
  const row = (providerId ? db.query("SELECT * FROM agent_providers WHERE id = ?").get(providerId) as ProviderRow | null : null) ?? defaultProvider();
  if (!row) throw new AgentError(409, "NO_PROVIDER", "No model provider is configured; an admin sets one in Settings → AI");
  return {
    id: row.id,
    baseUrl: row.base_url,
    apiKey: row.api_key_ct ? openSecret("provider", row.id, row.api_key_ct) : null,
    model: model?.trim() || row.default_model,
    compat: parseCompat(row.compat_json)
  };
}

const modelCache = new Map<string, { at: number; models: string[] }>();
const MODEL_CACHE_MS = 10 * 60_000;

/** Model ids that are not chat models (an embedding model in the same list), left out of the editor's suggestions. */
const NOT_CHAT = /embed/i;

/**
 * The agent editor's provider list (`GET /api/agents/providers`): names, the default, and the models
 * an admin's Test or model list last saw (kept in memory, so none after a restart). Never a base URL,
 * a key, or a hint: anyone who may create agents calls it.
 */
export function providerChoices(): AgentProviderChoice[] {
  const fallback = defaultProvider()?.id ?? null;
  return (db.query("SELECT id, name, default_model FROM agent_providers ORDER BY is_default DESC, name COLLATE NOCASE, created_at").all() as Array<{ id: string; name: string; default_model: string }>).map((row) => {
    const cached = modelCache.get(row.id)?.models.filter((model) => !NOT_CHAT.test(model)) ?? null;
    return { id: row.id, name: row.name, isDefault: row.id === fallback, defaultModel: row.default_model, models: cached && cached.length ? cached.slice(0, 200) : null };
  });
}

/**
 * Change embedding model's provider list (2026-10-08, a knowledge base's owner): names, each
 * provider's embedding defaults, and the embedding models an admin's Test or model list last saw (in
 * memory). Never a base URL, a key, or a hint. Only providers the admin's knowledge policy allows;
 * with a model list, `models` is that list (no free text) and the defaults are moved inside the policy.
 */
export function providerEmbeddingChoices(): KnowledgeEmbeddingChoice[] {
  const fallback = defaultProvider()?.id ?? null;
  return (db.query("SELECT id, name, embedding_model, embedding_dims, compat_json FROM agent_providers ORDER BY is_default DESC, name COLLATE NOCASE, created_at").all() as Array<{ id: string; name: string; embedding_model: string | null; embedding_dims: number | null; compat_json: string }>).flatMap((row) => {
    const policy = parseKnowledgePolicy(row.compat_json);
    if (!policy.enabled) return [];
    const defaults = embeddingDefaults(row, policy);
    const cached = modelCache.get(row.id)?.models.filter((model) => NOT_CHAT.test(model)) ?? null;
    return [{
      id: row.id, name: row.name, isDefault: row.id === fallback, embeddingModel: defaults.model, embeddingDims: defaults.dims,
      models: policy.models ? [...policy.models] : cached && cached.length ? cached.slice(0, 50) : null,
      anyModel: policy.models === null, maxDims: policyMaxDims(policy)
    }];
  });
}

/**
 * A provider's embedding model and size for a new base (and Change embedding model's defaults),
 * inside its knowledge policy: the provider's own defaults, else the first allowed model and at most
 * the largest allowed size (2026-10-08: adjusted to the policy the admin set, never refused for it).
 */
export function embeddingDefaults(row: { embedding_model: string | null; embedding_dims: number | null }, policy: ProviderKnowledgePolicy): { model: string; dims: number } {
  const own = row.embedding_model?.trim() || DEFAULT_EMBEDDING_MODEL;
  const model = policyAllowsModel(policy, own) || !policy.models ? own : policy.models[0]!;
  const dims = row.embedding_dims && row.embedding_dims >= 64 && row.embedding_dims <= 3072 ? row.embedding_dims : DEFAULT_EMBEDDING_DIMS;
  return { model, dims: Math.min(dims, policyMaxDims(policy)) };
}

const providerNameQuery = db.query("SELECT name, default_model FROM agent_providers WHERE id = ?");
/** The name of an agent's own provider, or null (none set, or it was deleted). */
export const providerNameOf = (id: string | null) => id ? (providerNameQuery.get(id) as { name: string } | null)?.name ?? null : null;
/** The model a run of an agent uses now (as `connectionFor` picks it), for display; null with no provider. */
export function effectiveModelOf(providerId: string | null, model: string | null): string | null {
  if (model?.trim()) return model.trim();
  const own = providerId ? providerNameQuery.get(providerId) as { default_model: string } | null : null;
  return own?.default_model ?? defaultProvider()?.default_model ?? null;
}

/** `GET /models` of a provider, cached for ten minutes (plan §4.1). */
export async function providerModels(id: string, options: { fresh?: boolean } = {}): Promise<{ models: string[]; cachedAt: string }> {
  const cached = modelCache.get(id);
  if (cached && !options.fresh && Date.now() - cached.at < MODEL_CACHE_MS) return { models: cached.models, cachedAt: new Date(cached.at).toISOString() };
  const connection = connectionFor(id, null);
  const models = await listModels(connection);
  modelCache.set(id, { at: Date.now(), models });
  return { models, cachedAt: new Date().toISOString() };
}

export type ProviderTest = {
  ok: boolean;
  models: { ok: boolean; count: number | null; latencyMs: number | null; error: string | null };
  completion: { ok: boolean; model: string | null; latencyMs: number | null; error: string | null };
};

/** Admin-only surfaces (Settings → AI → Test), so the fuller excerpt (review L3). */
const describe = (error: unknown) => error instanceof ProviderError ? `${error.code}: ${error.adminMessage}` : error instanceof EgressError || error instanceof AgentError ? `${error.code}: ${error.message}` : "Failed";

/** Test (plan §4.1): the model list and a one-token completion, reported as latency and counts only. */
export async function testProvider(id: string): Promise<ProviderTest> {
  const connection = connectionFor(id, null);
  const result: ProviderTest = { ok: false, models: { ok: false, count: null, latencyMs: null, error: null }, completion: { ok: false, model: null, latencyMs: null, error: null } };
  const started = Date.now();
  try {
    const models = await listModels(connection);
    modelCache.set(id, { at: Date.now(), models });
    result.models = { ok: true, count: models.length, latencyMs: Date.now() - started, error: null };
  } catch (error) {
    result.models.error = describe(error);
  }
  const again = Date.now();
  try {
    const reply = await completeStreaming(connection, { messages: [{ role: "user", content: "Reply with the single word: ok" }], maxOutputTokens: 1 }, new AbortController().signal, () => undefined);
    result.completion = { ok: true, model: reply.model ?? connection.model, latencyMs: Date.now() - again, error: null };
  } catch (error) {
    result.completion.error = describe(error);
  }
  result.ok = result.completion.ok;
  return result;
}

const PROBE_TOOL = { name: "nook_probe", description: "Answers the probe. Call it with ok set to true.", parameters: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } };
const DECOY_TOOL = { name: "nook_other", description: "Do not call this tool.", parameters: { type: "object", properties: {} } };

/** What a provider error says, without the key or the URL (admins only). */
const probeError = (error: unknown) => error instanceof ProviderError ? { status: error.status ?? null, error: describe(error).slice(0, 300) } : { status: null, error: describe(error).slice(0, 300) };

/**
 * "Test tool calling" (wave 48b, D436): two tiny requests to a provider, one with `tool_choice:
 * "required"` and one naming a tool (`{type:"function", function:{name}}`, with a decoy tool offered
 * too), sent exactly as asked (no compat flags, no `auto` retry). A choice is supported when the
 * provider answers 2xx with a call to the probe tool. The results are stored in the provider's compat
 * flags (`requiredToolChoice`, `namedToolChoice`, wave 46's), so the loop sends what the provider
 * takes; without a probe, wave 46's 400-then-`auto` retry still works.
 */
export async function probeToolCalling(actorId: string, id: string): Promise<ToolCallingProbe> {
  // Review M2: an unknown id is a 404, never the default provider (connectionFor falls back).
  providerRow(id);
  const connection = connectionFor(id, null);
  const started = Date.now();
  const ask = async (choice: "required" | { name: string }): Promise<ToolCallingProbe["required"]> => {
    try {
      const reply = await completeStreaming(connection, {
        messages: [{ role: "user", content: "This is a connection test. Call the nook_probe tool with ok set to true." }],
        tools: [PROBE_TOOL, DECOY_TOOL], toolChoice: choice, maxOutputTokens: 64, probeChoice: true
      }, AbortSignal.timeout(60_000), () => undefined);
      const called = reply.toolCalls.some((call) => call.name === PROBE_TOOL.name);
      return called ? { ok: true, outcome: "supported", status: 200, error: null } : { ok: false, outcome: "unsupported", status: 200, error: "The provider answered without calling the tool" };
    } catch (error) {
      const failed = probeError(error);
      // Only a 400 says the choice itself is refused; a timeout, a network error, 429, 5xx, or an auth
      // error says nothing about tool choice, so the stored flag stays as it was.
      return { ok: false, outcome: failed.status === 400 ? "unsupported" : "inconclusive", ...failed };
    }
  };
  const required = await ask("required");
  const named = await ask({ name: PROBE_TOOL.name });
  const flag = (result: ToolCallingProbe["required"]) => result.outcome === "inconclusive" ? undefined : result.ok;
  const compat = db.transaction(() => {
    const row = providerRow(id);
    const current = parseCompat(row.compat_json);
    const stored = JSON.parse(row.compat_json || "{}") as Record<string, unknown>;
    const next = { ...stored };
    for (const [key, value] of [["requiredToolChoice", flag(required)], ["namedToolChoice", flag(named)]] as const) {
      // parseCompat keeps only a `false` flag: a supported choice drops it, an inconclusive one leaves it.
      if (value === true) delete next[key];
      else if (value === false) next[key] = false;
    }
    db.query("UPDATE agent_providers SET compat_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(next), now(), id);
    const saved = parseCompat(JSON.stringify(next));
    audit(actorId, null, "agents.provider.probe_tools", { providerId: id, required: required.outcome, named: named.outcome, requiredToolChoice: saved.requiredToolChoice !== false, namedToolChoice: saved.namedToolChoice !== false, before: { requiredToolChoice: current.requiredToolChoice !== false, namedToolChoice: current.namedToolChoice !== false } });
    return { requiredToolChoice: saved.requiredToolChoice !== false, namedToolChoice: saved.namedToolChoice !== false };
  })();
  return { required, named, compat, inconclusive: required.outcome === "inconclusive" || named.outcome === "inconclusive", model: connection.model, ms: Date.now() - started };
}
