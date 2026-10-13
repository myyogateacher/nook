import { createHash, randomBytes } from "node:crypto";
import { addressPrefix, isKeyDenial, resolveKeyActor, type KeyActor } from "../apiKeys";
import { config } from "../config";
import { audit, db } from "../db";
import { keyReach, reachCovers } from "../keyResources";
import { hasScope } from "../mcpScopes";
import { AGENT_BOUNDS, EXTERNAL_BOUNDS, PREAMBLE_VERSION, preambleFor, toolResultEnd, toolResultMarker, type AuditVia, type ExternalRunResult, type RunStatus, type TokenUsage } from "../../shared/agents";
import type { AgentRow } from "./agentsService";
import { finishAuditRun, insertAuditRun, insertAuditStep, markAuditFirstToken, markAuditStarted } from "./audit";
import { withinAgentRun } from "./depth";
import { chargeKeyRun } from "./limits";
import { McpClientError } from "./mcpClient";
import { runNookTool } from "./nookBridge";
import { ProviderError, runLoop, type ChatTurn, type ModelToolCall, type ToolExecution } from "./loop";
import { connectionFor } from "./providers";
import { activeRun, assertBudget, assertKeySlots, capResultText, chargeUsage, dayOf, registerActiveRun, releaseActiveRun, secondsToMidnight, withTimeout, type ActiveRun } from "./runs";
import { readAgentSettings, roleMayChat } from "./settings";
import { AgentError, agentsStatus } from "./status";
import { identityOf, liveToolFailure, liveToolFor, resolveTools, type ExternalToolOptions, type ResolvedTool } from "./tools";
import { sessionFor } from "./toolServers";
import { shareLevel, shareReadableSql } from "./sharing";
import { runKnowledgeTool } from "../knowledge/tool";

/**
 * API and MCP runs (Wave 42 "AC-C", plan §7.1, §7.2, D364, D365): the agent loop for a general
 * Nook key, never a chat. `POST /api/v1/agents/:id/runs` (server/agents/api.ts) and the MCP tool
 * `run_agent` (server/agents/mcpTools.ts) both start here.
 *
 * The effective right (§7.1) is the key live (not revoked, expired, past its grace, or blocked by
 * policy, on the surface it came in on) ∧ the `agents:run` grant covering the agent (all agents or
 * this one) ∧ the owner's role allowed to chat ∧ the owner able to view the agent now. It is
 * recomputed at the start, before every model call, and before every tool call; when it fails
 * mid-run the run ends `error` with `KEY_INACTIVE` at that point (T319).
 *
 * Before the provider is ever called, the run must fit: the key's 2 concurrent runs, the owner's 2,
 * the instance's slots, the key's, owner's, and instance's token budgets, and the key's 20 runs a
 * minute and 500 a day (server/agents/limits.ts). Anything refused costs nothing.
 *
 * Tools: only those that run on their own (`auto`): a `confirm` tool is never offered, direct Nook
 * writes never are, and Nook writes in proposal mode stay proposals (server/agents/tools.ts). The
 * calling key is the Nook key (D359). Everything runs inside the depth guard's frame (T318).
 *
 * Every step goes to the Audit log (server/agents/audit.ts) as it happens. The `audit_log` rows
 * (`agents.run.start`, `agents.run.finish`, `agents.tool.call`) carry ids, names, and counts only.
 */

export type ExternalCaller = { keyId: string; surface: "mcp" | "rest"; via: Exclude<AuditVia, "reports">; clientIp: string | null };
export type ExternalMessage = { role: "user" | "assistant"; content: string };
export type ExternalRequest = { agentId: string; input?: string; messages?: ExternalMessage[]; label?: string | null };

/** Stream events of an API run (plan §2.3 minus the confirmations). */
export type ExternalEvent =
  | { type: "run"; data: { runId: string; agentId: string } }
  | { type: "delta"; data: { text: string } }
  | { type: "tool_call"; data: { callId: string; tool: string; server: string; argsPreview: string } }
  | { type: "tool_result"; data: { callId: string; ok: boolean; truncated: boolean; durationMs: number; resultPreview: string } }
  | { type: "usage"; data: { usage: TokenUsage } }
  | { type: "error"; data: { code: string; message: string } }
  | { type: "done"; data: ExternalRunResult };

type Listener = (event: ExternalEvent) => void;

type LiveExternal = {
  runId: string; agentId: string; keyId: string; label: string | null; queuedAt: number; firstTokenAt: number | null;
  output: string; usage: TokenUsage; steps: number; toolCalls: ExternalRunResult["toolCalls"]; status: RunStatus;
  listeners: Set<Listener>; done: Promise<ExternalRunResult>;
};
const live = new Map<string, LiveExternal>();

/** Error texts a caller sees (never a provider's body beyond the redacted excerpt, T309). */
const ERROR_TEXT: Record<string, string> = {
  KEY_INACTIVE: "The API key, its grant on this agent, or its owner's access to the agent ended during the run",
  BUDGET_EXCEEDED: "A daily token budget is used up; it resets at midnight UTC",
  PROVIDER_ERROR: "The model provider did not answer",
  MODEL_TIMEOUT: "The model provider stopped answering",
  EGRESS_REFUSED: "The provider's address is not allowed",
  TOO_LARGE: "The reply was too large",
  INTERNAL: "Something went wrong while running the agent"
};

// ------------------------------------------------------------------------------- the right

export type ExternalRight = { key: KeyActor; agent: AgentRow; owner: { role: string; displayName: string } };

/** The effective right of a key on an agent now (plan §7.1), or null. */
export function effectiveRight(keyId: string, surface: "mcp" | "rest", agentId: string): ExternalRight | null {
  if (!agentsStatus().enabled) return null;
  const actor = resolveKeyActor(keyId, surface);
  if (isKeyDenial(actor) || actor.kind !== "general") return null;
  if (!hasScope(actor.scopes, "agents:run") || !reachCovers(keyReach(actor, "agents:run"), [{ kind: "agent", id: agentId }])) return null;
  const owner = db.query("SELECT role, display_name FROM users WHERE id = ? AND disabled_at IS NULL").get(actor.userId) as { role: string; display_name: string } | null;
  if (!owner || !roleMayChat(owner.role)) return null;
  // The key's owner can view the agent now (Wave 43, AC-D): their own, or one shared with them, live (re-checked every call and step).
  const agent = db.query("SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL").get(agentId) as AgentRow | null;
  if (!agent || shareLevel("agent", agent, actor.userId) === "none") return null;
  return { key: actor, agent, owner: { role: owner.role, displayName: owner.display_name } };
}

/** The agents a key may run now (GET /api/v1/agents): the owner's live agents its grant covers. */
export function runnableAgents(keyId: string, surface: "mcp" | "rest"): Array<{ agent: AgentRow; tools: string[] }> {
  if (!agentsStatus().enabled) return [];
  const actor = resolveKeyActor(keyId, surface);
  if (isKeyDenial(actor) || actor.kind !== "general" || !hasScope(actor.scopes, "agents:run")) return [];
  const owner = db.query("SELECT role FROM users WHERE id = ? AND disabled_at IS NULL").get(actor.userId) as { role: string } | null;
  if (!owner || !roleMayChat(owner.role)) return [];
  const reach = keyReach(actor, "agents:run");
  const agents = db.query(`SELECT a.* FROM agents a WHERE ${shareReadableSql("agent", "a")} ORDER BY a.name COLLATE NOCASE LIMIT 200`).all({ userId: actor.userId }) as AgentRow[];
  return agents.filter((agent) => reachCovers(reach, [{ kind: "agent", id: agent.id }])).map((agent) => ({
    agent, tools: resolveTools(agent, { userId: actor.userId, role: owner.role }, { nookKey: actor, surface }).map((tool) => tool.kind === "nook" ? `nook/${tool.toolName}` : `${tool.server}/${tool.toolName}`)
  }));
}

const keyTokensToday = (keyId: string) => (db.query("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens FROM agent_usage_daily WHERE day = ? AND key_id = ?").get(dayOf(), keyId) as { tokens: number }).tokens;

/** The key's own daily budget (plan §2.2: 200k by default), on top of the owner's and the instance's. */
function assertKeyBudget(keyId: string) {
  const budget = readAgentSettings().dailyTokensKey;
  if (budget > 0 && keyTokensToday(keyId) >= budget) {
    throw new AgentError(429, "BUDGET_EXCEEDED", `This API key has used today's budget of ${budget.toLocaleString("en-US")} tokens; it resets at midnight UTC`, { retryAfterSeconds: secondsToMidnight() });
  }
}

// ------------------------------------------------------------------------------- starting

/** The text the Audit log keeps as the input: the message, or the stateless turns as JSON. */
const inputText = (request: ExternalRequest) => request.input ?? JSON.stringify(request.messages ?? []);

export type StartedExternal = { runId: string; done: Promise<ExternalRunResult>; subscribe: (listener: Listener) => () => void };

/**
 * Starts a run, or throws the refusal (404 without the right; 429 or 503 for slots, budgets, and
 * limits; 409 without a provider) before anything is written or sent.
 */
export function startExternalRun(caller: ExternalCaller, request: ExternalRequest): StartedExternal {
  if (!agentsStatus().enabled) throw new AgentError(503, "AGENTS_DISABLED", "Agent chat is not configured on this server");
  const right = effectiveRight(caller.keyId, caller.surface, request.agentId);
  if (!right) throw new AgentError(404, "NOT_FOUND", "No such agent for this API key");
  const { key, agent, owner } = right;
  assertKeySlots(key.userId, key.keyId);
  assertBudget(key.userId);
  assertKeyBudget(key.keyId);
  // The provider is resolved (and its secret opened) before the run is counted: a missing one is a clean 409.
  const connection = connectionFor(agent.provider_id, agent.model);
  const retryAfter = chargeKeyRun(key.keyId);
  if (retryAfter) throw new AgentError(429, "RATE_LIMITED", "This API key has started too many runs; try again later", { retryAfterSeconds: retryAfter });

  const runId = crypto.randomUUID();
  const label = request.label?.trim() || null;
  const queuedAtIso = insertAuditRun({
    runId, via: caller.via, agentId: agent.id, agentRevision: agent.revision, promptSha256: createHash("sha256").update(agent.system_prompt).digest("hex"), preambleVersion: PREAMBLE_VERSION,
    userId: key.userId, keyId: key.keyId, providerId: connection.id, model: connection.model, clientAddress: addressPrefix(caller.clientIp), label, input: inputText(request)
  });
  const controller = new AbortController();
  const active: ActiveRun = { runId, chatId: null, keyId: key.keyId, userId: key.userId, messageId: "", controller, startedAt: Date.now(), pending: null, toolCalls: [] };
  registerActiveRun(active);
  audit(key.userId, null, "agents.run.start", { runId, via: caller.via, keyId: key.keyId, agentId: agent.id });

  let resolveDone!: (result: ExternalRunResult) => void;
  const state: LiveExternal = {
    runId, agentId: agent.id, keyId: key.keyId, label, queuedAt: Date.parse(queuedAtIso), firstTokenAt: null, output: "", usage: { promptTokens: 0, completionTokens: 0, estimated: false },
    steps: 0, toolCalls: [], status: "queued", listeners: new Set(), done: new Promise((resolve) => { resolveDone = resolve; })
  };
  live.set(runId, state);
  const turns: ChatTurn[] = [
    { role: "system", content: `${preambleFor(owner.displayName)}\n\n${agent.system_prompt}`.trim() },
    ...(request.messages ?? [{ role: "user" as const, content: request.input ?? "" }]).map((turn): ChatTurn => ({ role: turn.role, content: turn.content }))
  ];
  void withinAgentRun({ runId, via: caller.via }, () => execute(state, active, caller, agent, owner.role, turns, connection).then(resolveDone));
  return {
    runId,
    done: state.done,
    subscribe: (listener) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; }
  };
}

const addUsage = (total: TokenUsage, more: TokenUsage): TokenUsage => ({ promptTokens: total.promptTokens + more.promptTokens, completionTokens: total.completionTokens + more.completionTokens, estimated: total.estimated || more.estimated });

const emit = (state: LiveExternal, event: ExternalEvent) => {
  for (const listener of [...state.listeners]) {
    try { listener(event); } catch { state.listeners.delete(listener); }
  }
};

const preview = (value: string) => value.length > AGENT_BOUNDS.toolPreviewChars ? `${value.slice(0, AGENT_BOUNDS.toolPreviewChars - 1)}…` : value;
const toolError = (code: string, message: string) => JSON.stringify({ error: message, code });
const keyInactive = () => new AgentError(401, "KEY_INACTIVE", ERROR_TEXT.KEY_INACTIVE!);

type CancelReason = "stop" | "timeout";

/** Why an API or MCP run had no tool to run (only tools that run on their own are offered there). */
const NO_TOOLS_REASON = "Over the API and MCP an agent gets only the tools that run on their own; tools that ask a person first are not offered.";

async function execute(state: LiveExternal, active: ActiveRun, caller: ExternalCaller, agent: AgentRow, ownerRole: string, turns: ChatTurn[], connection: ReturnType<typeof connectionFor>): Promise<ExternalRunResult> {
  const runId = state.runId;
  const timeoutS = Math.min(config.agents.runTimeoutS || EXTERNAL_BOUNDS.runTimeoutS, EXTERNAL_BOUNDS.runTimeoutS);
  const wallClock = setTimeout(() => active.controller.abort("timeout" satisfies CancelReason), timeoutS * 1000);
  let seq = 0;
  let resolved: ResolvedTool[] = [];
  let pendingDelta = "";
  let deltaTimer: ReturnType<typeof setTimeout> | null = null;
  const flushDelta = () => {
    if (deltaTimer) clearTimeout(deltaTimer);
    deltaTimer = null;
    if (!pendingDelta) return;
    emit(state, { type: "delta", data: { text: pendingDelta } });
    pendingDelta = "";
  };
  /** The right again (T319); without it the run ends here. Returns the key for the Nook tools. */
  const externalOptions = (right: ExternalRight): ExternalToolOptions => ({ nookKey: right.key, surface: caller.surface });
  const recheck = () => {
    const right = effectiveRight(caller.keyId, caller.surface, agent.id);
    if (!right) throw keyInactive();
    return right;
  };
  const runOne = async (call: ModelToolCall): Promise<ToolExecution> => {
    const started = Date.now();
    const right = recheck();
    const tool = resolved.find((item) => item.modelName === call.name) ?? null;
    const view = { name: tool?.toolName ?? call.name, server: tool?.server ?? "?", ok: null as boolean | null, durationMs: null as number | null };
    state.toolCalls.push(view);
    flushDelta();
    emit(state, { type: "tool_call", data: { callId: call.id, tool: view.name, server: view.server, argsPreview: preview(call.arguments) } });
    const record = (ok: boolean, text: string, truncated: boolean) => {
      view.ok = ok;
      view.durationMs = Date.now() - started;
      seq += 1;
      insertAuditStep(runId, seq, { kind: "tool", serverId: tool?.serverId ?? null, tool: view.name, args: call.arguments, result: text, ok, durationMs: view.durationMs });
      emit(state, { type: "tool_result", data: { callId: call.id, ok, truncated, durationMs: view.durationMs, resultPreview: preview(text) } });
      audit(active.userId, null, "agents.tool.call", { runId, via: caller.via, agentId: agent.id, serverId: tool?.serverId ?? null, server: view.server, tool: view.name, ok, truncated, durationMs: view.durationMs });
    };
    const fail = (code: string, message: string) => {
      const text = toolError(code, message);
      record(false, text, false);
      return { content: text };
    };
    if (state.toolCalls.length > AGENT_BOUNDS.toolCallsPerRun) return fail("TOOL_LIMIT", `This run has used its ${AGENT_BOUNDS.toolCallsPerRun} tool calls; answer with what you have`);
    if (!tool) return fail("UNKNOWN_TOOL", "unknown tool");
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = call.arguments.trim() ? JSON.parse(call.arguments) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      args = parsed as Record<string, unknown>;
    } catch {
      return fail("INVALID_ARGUMENTS", "arguments were not valid JSON");
    }
    // Rights are live per call (AC-B review M3): the tool is re-resolved against the live agent row, the
    // owner's role, the server row (same revision), the policy, and the calling key (re-read just above).
    const identity = identityOf(tool);
    const live = liveToolFor(agent.id, active.userId, identity, externalOptions(right));
    if (!live) {
      const why = liveToolFailure(agent.id, active.userId, identity, externalOptions(right));
      return fail(why.code, why.message);
    }
    // Belt and braces (D352): nothing that asks first is ever offered over the API, so nothing can run here unasked.
    if (live.policy !== "auto") return fail("DENIED", "This tool needs a person's confirmation and cannot run over the API");
    let text: string;
    let ok: boolean;
    try {
      if (live.nook) {
        // The same per-call timeout as a server's (AC-B review L9); the result of a late call is discarded.
        const outcome = await withTimeout(runNookTool(live.nook, args, { runId, agentId: agent.id, agentName: agent.name, via: caller.via }), live.timeoutMs, active.controller.signal);
        text = outcome.text;
        ok = outcome.ok;
      } else if (live.knowledge) {
        // AC-E: read-only, so it runs over the API too; source ids only for what the key's owner can open (T320).
        const outcome = await withTimeout(runKnowledgeTool(live.knowledge, args, { agent: right.agent, runner: { userId: active.userId, keyId: caller.keyId }, runId, signal: active.controller.signal }), live.timeoutMs, active.controller.signal);
        text = outcome.text;
        ok = outcome.ok;
      } else {
        const outcome = await withTimeout(sessionFor(live.serverRow!).callTool(live.toolName, args, active.controller.signal), live.timeoutMs, active.controller.signal);
        text = outcome.text;
        ok = !outcome.isError;
      }
    } catch (error) {
      if (active.controller.signal.aborted) throw error;
      if (error instanceof McpClientError) return fail(error.code === "MCP_TIMEOUT" ? "TOOL_TIMEOUT" : error.code, error.message);
      if (error instanceof AgentError) return fail(error.code, error.message);
      console.error("Agent tool call failed", error instanceof Error ? error.name : "Unknown error");
      return fail("INTERNAL", "The tool could not be run");
    }
    const capped = capResultText(text, live.resultCapBytes);
    record(ok, capped.text, capped.truncated);
    // The fence's nonce is made after the result exists, so the result cannot close the fence (AC-B review L7).
    const nonce = randomBytes(6).toString("hex");
    return { content: `${toolResultMarker(live.server, live.toolName, nonce)}\n${capped.text}${capped.truncated ? `\n[truncated: the result was ${capped.bytes} bytes; the first ${live.resultCapBytes} are shown]` : ""}\n${toolResultEnd(nonce)}` };
  };

  let status: RunStatus = "running";
  let droppedToolCalls = 0;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  try {
    markAuditStarted(runId);
    state.status = "running";
    emit(state, { type: "run", data: { runId, agentId: agent.id } });
    const result = await runLoop({
      connection,
      messages: turns,
      maxSteps: Math.min(agent.max_steps, AGENT_BOUNDS.maxSteps.max),
      temperature: agent.temperature,
      maxOutputTokens: agent.max_output_tokens,
      signal: active.controller.signal,
      beforeStep: () => { recheck(); },
      // While a model call streams too (QA M1): a key revoked mid-answer stops the provider call within 2 s.
      watch: () => { recheck(); },
      sink: {
        delta: (chunk) => {
          if (state.firstTokenAt === null) {
            state.firstTokenAt = Date.now();
            markAuditFirstToken(runId);
          }
          const room = AGENT_BOUNDS.assistantMessageChars - state.output.length;
          if (room <= 0) return;
          const kept = chunk.length > room ? chunk.slice(0, room) : chunk;
          state.output += kept;
          pendingDelta += kept;
          deltaTimer ??= setTimeout(flushDelta, 50);
        },
        usage: (usage) => {
          state.usage = addUsage(state.usage, usage);
          // The step's text goes out before its usage (QA L6): run, delta…, usage, done.
          flushDelta();
          emit(state, { type: "usage", data: { usage } });
        },
        // A model call that ended early (Stop, the wall clock, a lost right; QA M1, M2): its text is kept,
        // its usage (the provider's, or estimated from the prompt and the text) is charged and recorded.
        interrupted: (step) => {
          state.usage = addUsage(state.usage, step.usage);
          state.steps += 1;
          seq += 1;
          try {
            chargeUsage(active.userId, agent.id, step.usage, 0, caller.keyId);
            insertAuditStep(runId, seq, { kind: "model", text: step.content, toolCalls: [], usage: step.usage, durationMs: step.durationMs });
          } catch (error) {
            console.error("Agent API run could not charge a stopped step", error instanceof Error ? error.name : "Unknown error");
          }
          flushDelta();
          emit(state, { type: "usage", data: { usage: step.usage } });
        },
        step: (step) => {
          state.steps += 1;
          seq += 1;
          insertAuditStep(runId, seq, { kind: "model", text: step.content, toolCalls: step.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })), usage: step.usage, durationMs: step.durationMs });
        }
      },
      charge: (usage, more) => {
        chargeUsage(active.userId, agent.id, usage, 0, caller.keyId);
        if (more) {
          assertBudget(active.userId);
          assertKeyBudget(caller.keyId);
        }
      },
      tools: () => {
        resolved = [];
        if (state.toolCalls.length >= AGENT_BOUNDS.toolCallsPerRun) return [];
        // The right, the agent row, and the owner's role as they stand now (AC-B review M3), never the run's start.
        const right = recheck();
        resolved = resolveTools(right.agent, { userId: active.userId, role: right.owner.role }, externalOptions(right));
        return resolved.map((tool) => ({ name: tool.modelName, description: tool.description, parameters: tool.parameters }));
      },
      execute: runOne,
      // A tool call nothing could run ends the answer with the reason (AC-B QA L9); the output, and so the Audit log, keeps it.
      noToolsReason: () => state.toolCalls.length >= AGENT_BOUNDS.toolCallsPerRun ? `This run has used its ${AGENT_BOUNDS.toolCallsPerRun} tool calls.` : NO_TOOLS_REASON
    });
    droppedToolCalls = result.droppedToolCalls;
    status = result.status === "step_limit" ? "step_limit" : "ok";
  } catch (error) {
    const reason = active.controller.signal.aborted ? (active.controller.signal.reason as CancelReason | undefined) ?? "stop" : null;
    if (reason === "timeout") status = "timeout";
    else if (reason) status = "cancelled";
    else if (error instanceof ProviderError) { status = "error"; errorCode = error.code; errorMessage = error.message; }
    else if (error instanceof AgentError && error.code === "BUDGET_EXCEEDED") { status = "budget"; errorCode = "BUDGET_EXCEEDED"; errorMessage = error.message; }
    else if (error instanceof AgentError && error.code === "KEY_INACTIVE") { status = "error"; errorCode = "KEY_INACTIVE"; errorMessage = error.message; }
    else {
      status = "error";
      errorCode = "INTERNAL";
      errorMessage = ERROR_TEXT.INTERNAL!;
      console.error("Agent API run failed", error instanceof Error ? error.name : "Unknown error");
    }
  } finally {
    clearTimeout(wallClock);
    flushDelta();
    releaseActiveRun(runId);
  }
  for (const call of state.toolCalls) if (call.ok === null) call.ok = false;
  state.status = status;
  let finishedAt: string | null = null;
  try {
    finishedAt = finishAuditRun(runId, { status, errorCode, steps: state.steps, toolCalls: state.toolCalls.length, usage: state.usage, output: state.output });
    chargeUsage(active.userId, agent.id, { promptTokens: 0, completionTokens: 0, estimated: false }, 1, caller.keyId);
  } catch (error) {
    console.error("Agent API run could not be recorded", error instanceof Error ? error.name : "Unknown error");
  }
  audit(active.userId, null, "agents.run.finish", { runId, via: caller.via, keyId: caller.keyId, agentId: agent.id, status, errorCode, steps: state.steps, toolCalls: state.toolCalls.length, droppedToolCalls, promptTokens: state.usage.promptTokens, completionTokens: state.usage.completionTokens });
  const result: ExternalRunResult = {
    runId, agentId: agent.id, status, output: state.output, steps: state.steps, toolCalls: state.toolCalls.map((call) => ({ ...call })),
    usage: { ...state.usage },
    timings: { queuedMs: Math.max(0, active.startedAt - state.queuedAt), firstTokenMs: state.firstTokenAt ? state.firstTokenAt - state.queuedAt : null, totalMs: finishedAt ? Date.parse(finishedAt) - state.queuedAt : Date.now() - state.queuedAt },
    error: errorCode ? { code: errorCode, message: errorMessage ?? ERROR_TEXT[errorCode] ?? "The run did not finish" } : null,
    label: state.label
  };
  if (errorCode) emit(state, { type: "error", data: result.error! });
  emit(state, { type: "done", data: result });
  state.listeners.clear();
  live.delete(runId);
  return result;
}

// ------------------------------------------------------------------------------- reading, cancelling

type StoredRun = { id: string; agent_id: string; key_id: string | null; status: RunStatus; error_code: string | null; steps: number; prompt_tokens: number; completion_tokens: number; tokens_estimated: number; label: string | null; queued_at: string; started_at: string | null; first_token_at: string | null; finished_at: string | null };

/** A run the calling key started (any other key, or another agent in the path, is the 404). */
function storedRun(runId: string, agentId: string, keyId: string): StoredRun {
  const row = db.query("SELECT id, agent_id, key_id, status, error_code, steps, prompt_tokens, completion_tokens, tokens_estimated, label, queued_at, started_at, first_token_at, finished_at FROM agent_runs WHERE id = ? AND via <> 'chat'").get(runId) as StoredRun | null;
  if (!row || row.key_id !== keyId || row.agent_id !== agentId) throw new AgentError(404, "NOT_FOUND", "Not found");
  return row;
}

/** GET …/runs/:runId: the same shape as the run's answer, live or from the Audit log; the starting key only. */
export function externalRunResult(runId: string, agentId: string, keyId: string): ExternalRunResult {
  const row = storedRun(runId, agentId, keyId);
  const state = live.get(runId);
  const at = (value: string | null) => value ? Date.parse(value) : null;
  const queued = Date.parse(row.queued_at);
  if (state) {
    return {
      runId, agentId, status: state.status, output: state.output, steps: state.steps, toolCalls: state.toolCalls.map((call) => ({ ...call })), usage: { ...state.usage },
      timings: { queuedMs: row.started_at ? at(row.started_at)! - queued : null, firstTokenMs: state.firstTokenAt ? state.firstTokenAt - queued : null, totalMs: null }, error: null, label: state.label
    };
  }
  const entry = db.query("SELECT output_text FROM agent_audit_entries WHERE run_id = ?").get(runId) as { output_text: string | null } | null;
  const steps = db.query("SELECT s.tool_name, s.ok, s.duration_ms, s.server_id, t.slug FROM agent_audit_steps s LEFT JOIN agent_tool_servers t ON t.id = s.server_id WHERE s.run_id = ? AND s.kind = 'tool' ORDER BY s.seq").all(runId) as Array<{ tool_name: string | null; ok: number | null; duration_ms: number; server_id: string | null; slug: string | null }>;
  return {
    runId, agentId, status: row.status, output: entry?.output_text ?? "", steps: row.steps,
    toolCalls: steps.map((step) => ({ name: step.tool_name ?? "?", server: step.slug ?? (step.server_id ? "?" : step.tool_name === "search_knowledge" ? "knowledge" : "nook"), ok: step.ok === null ? null : step.ok === 1, durationMs: step.duration_ms })),
    usage: { promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens, estimated: row.tokens_estimated === 1 },
    timings: { queuedMs: row.started_at ? at(row.started_at)! - queued : null, firstTokenMs: row.first_token_at ? at(row.first_token_at)! - queued : null, totalMs: row.finished_at ? at(row.finished_at)! - queued : null },
    error: row.error_code ? { code: row.error_code, message: ERROR_TEXT[row.error_code] ?? "The run did not finish" } : row.status === "interrupted" ? { code: "INTERRUPTED", message: "The server restarted during the run" } : null,
    label: row.label
  };
}

/** POST …/cancel: the starting key only; a run that already ended answers its status. */
export function cancelExternalRun(runId: string, agentId: string, keyId: string): { status: RunStatus } {
  const row = storedRun(runId, agentId, keyId);
  if (!live.has(runId)) return { status: row.status };
  activeRun(runId)?.controller.abort("stop" satisfies CancelReason);
  return { status: "cancelled" };
}

/** Test hook: the live API and MCP runs. */
export const liveExternalRuns = () => [...live.keys()];
