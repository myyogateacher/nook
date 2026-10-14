import { AGENT_BOUNDS, CHAT_IMAGE_BOUNDS, MODEL_TIMEOUTS, type ProviderCompat, type ReasoningEffort, type TokenUsage } from "../../shared/agents";
import { EgressError, egressFetch, readEgressText, type EgressResponse } from "./egress";
import { logger } from "../log";

const modelLog = logger("agents");

/**
 * The model adapter and the agent loop (plan §2.1, D341, D342): OpenAI-compatible Chat Completions
 * over plain `fetch` through the egress guard, streamed, with `stream_options.include_usage`. No
 * SDK. AC-A ships the loop without tools, so a run is one model call; the step loop keeps its
 * shape (the last step goes out without tools; `max_steps` bounds the calls) for AC-B, which adds
 * tool calls, confirmations, and result caps.
 *
 * Errors never carry the provider's response body beyond a bounded, letter-only excerpt of its
 * `error.message` (a key never appears there), and never the API key (T309).
 */

export type ProviderConnection = { id: string; baseUrl: string; apiKey: string | null; model: string; compat: ProviderCompat };
/** A tool call as the model emitted it (plan §2.1): `arguments` is the raw JSON text. */
export type ModelToolCall = { id: string; name: string; arguments: string; /** Set by the loop when it took the call from a text answer (a run's final tool, `finalTool`). */ recovered?: "text" };
/** The wire turns (OpenAI Chat Completions): an assistant turn may carry `tool_calls`; a `tool` turn answers one. */
/**
 * A part of a user turn with images (U5): OpenAI-compatible `text` and `image_url` parts, the image a
 * base64 data URL. Only chat runs with images on a vision-capable model send parts; every other turn is a string.
 */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatTurn =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };
/** A tool as offered to the model (`tools: [{type: "function", function}]`). */
export type ModelTool = { name: string; description: string; parameters: Record<string, unknown> };
/**
 * Which tool the model must call (Wave 46): `auto` (the default; it may answer in text), `required`
 * (some tool), or `{ name }` (that tool). A provider without named choice (`compat.namedToolChoice`
 * false) gets `required` with only the named tool offered, which asks for the same call.
 */
export type ToolChoice = "auto" | "required" | { name: string };
export type CompletionRequest = {
  messages: ChatTurn[]; model?: string; temperature?: number | null; maxOutputTokens?: number; tools?: ModelTool[]; toolChoice?: ToolChoice;
  /** Wave 48b's tool-calling probe: send the choice as asked (ignore the compat flags) and never retry a 400 with `auto`. */
  probeChoice?: boolean;
  /** 2026-10-14: the probe's `reasoning_effort` for this request (overrides the provider's compat; `omit` sends none). */
  reasoningEffort?: ReasoningEffort;
};

/** Whether a provider's 400 says the model refuses function tools at its (default) reasoning effort (OpenAI's newer models in Chat Completions). */
export const refusesToolsAtReasoning = (text: string) => /reasoning[_ ]?effort/i.test(text) || (/reasoning/i.test(text) && /tool/i.test(text));

/**
 * Where a learned compat flag is saved (providers.ts registers it): a live request that had to retry
 * with `reasoning_effort: "none"` records it on the provider, so later requests send it at once.
 */
let compatLearner: ((providerId: string, patch: { reasoningEffort: ReasoningEffort }) => void) | null = null;
export const setCompatLearner = (learner: typeof compatLearner) => { compatLearner = learner; };
export type CompletionResult = { content: string; finishReason: string | null; usage: TokenUsage; model: string | null; toolCalls: ModelToolCall[] };
/**
 * What a streaming call has produced so far (Wave 42 QA M2): whether the provider answered (a 2xx
 * and its stream began), the text kept, and the usage it reported, if any. A call that ends early
 * (Stop, the wall clock, a lost right, a failure mid-stream) is charged from this.
 */
export type StreamProgress = { started: boolean; content: string; usage: TokenUsage | null; model: string | null; promptChars: number };
/**
 * A turn's size in characters for the estimates (÷ 4 = tokens): its text, plus
 * `CHAT_IMAGE_BOUNDS.tokensEach` tokens (× 4 characters) per image part, never the data URL's length.
 */
export function turnChars(turn: ChatTurn): number {
  const content = turn.content as string | ContentPart[] | null | undefined;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : CHAT_IMAGE_BOUNDS.tokensEach * 4), 0);
}
export const newProgress = (messages: readonly ChatTurn[]): StreamProgress => ({ started: false, content: "", usage: null, model: null, promptChars: messages.reduce((sum, turn) => sum + turnChars(turn), 0) });

/** The usage of a call that ended early: the provider's when it reported one, else prompt and kept text ÷ 4. */
export const partialUsage = (progress: StreamProgress): TokenUsage => progress.usage ? cutUsage(progress.usage, progress.content) : { promptTokens: Math.ceil(progress.promptChars / 4), completionTokens: estimateTokens(progress.content), estimated: true };

/**
 * A reply cut at the stored bound (`AGENT_BOUNDS.assistantMessageChars`; the message ends with the
 * truncation marker) is charged for what was kept, as a stopped reply is: the prompt as the provider
 * reported it, and the kept text ÷ 4 for the output, marked estimated. The text past the cut was
 * dropped, never shown or stored, so it is not charged. Usage of a reply within the bound is unchanged.
 */
export function cutUsage(usage: TokenUsage, content: string): TokenUsage {
  return keptUsage(usage, content, AGENT_BOUNDS.assistantMessageChars);
}

/**
 * A model call's usage when only its first `room` characters are kept: unchanged when the whole text
 * fits, else the kept text ÷ 4 as output (never more than reported), marked estimated.
 */
export function keptUsage(usage: TokenUsage, content: string, room: number): TokenUsage {
  if (content.length <= room) return usage;
  return { ...usage, completionTokens: Math.min(usage.completionTokens, estimateTokens(content.slice(0, Math.max(0, room)))), estimated: true };
}

/**
 * Cut-reply charging across steps (TODO "Cut-reply charging"). The run does not stop at the stored
 * bound: a step that asks for tools sends its text back to the model as context, so that text was
 * used and is charged in full (only the part past the per-call bound, which never went back, is
 * not). The step that ends the run (or a call that ends early) sends nothing back: its text is only
 * the stored reply's, so it is charged for the part that still fits in the stored message after the
 * earlier steps' text (`room`), like a single cut reply.
 */
const storedRoom = (streamed: number) => Math.max(0, AGENT_BOUNDS.assistantMessageChars - streamed);

export class ProviderError extends Error {
  /** The fuller excerpt for admin surfaces (Test, the models list); `message` is what a chat's owner sees (review L3). */
  readonly adminMessage: string;
  constructor(readonly code: "PROVIDER_ERROR" | "MODEL_TIMEOUT" | "EGRESS_REFUSED" | "TOO_LARGE", message: string, readonly status: number | null = null, adminMessage?: string) {
    super(message);
    this.name = "ProviderError";
    this.adminMessage = adminMessage ?? message;
  }
}

/** The model-call timeouts (plan §2.2), on an object so tests can shorten them. */
export const modelTimeouts = { ...MODEL_TIMEOUTS };

/**
 * The byte cap on a model stream (plan §3.2 item 5) and on the models list. Memory worst case: a
 * stream is parsed chunk by chunk and its text is kept only up to the stored bound (256 KiB plus one
 * character), so a provider that sends the full 8 MiB costs at most one SSE event's buffer plus
 * 256 KiB of text per run, times the instance's run slots (`AGENT_MAX_CONCURRENT_RUNS`, 4 by
 * default): about 1 MiB, bounded and transient (review L5, L11; QA Q4). The live stream to browsers
 * stops at the same bound.
 */
export const MODEL_STREAM_MAX_BYTES = 8 * 1024 * 1024;
export const MODELS_LIST_MAX_BYTES = 1024 * 1024;
const ERROR_BODY_MAX_BYTES = 64 * 1024;

const headersFor = (connection: ProviderConnection, accept: string) => ({
  Accept: accept,
  "Content-Type": "application/json",
  ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {})
});

/** Characters ÷ 4, the estimate used when a server sends no usage chunk (plan §2.1). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * What a provider's error body may carry into Nook's error text (T309, review L3). Admins get the
 * fuller excerpt: letters, digits, spaces, and plain punctuation, with tokens of 24+ characters
 * elided. Everyone else (a chat's owner, through the run's error event) gets it with every `sk-…`
 * token and every token of 12+ characters elided too, so a key fragment the provider echoes never
 * reaches a non-admin.
 */
export function excerpt(body: string): { admin: string; redacted: string } | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string };
    const message = typeof parsed.error === "string" ? parsed.error : typeof parsed.error?.message === "string" ? parsed.error.message : null;
    if (!message) return null;
    const admin = message.replace(/[^A-Za-z0-9 .,:;()'-]/g, "").replace(/\b[A-Za-z0-9-]{24,}\b/g, "…").slice(0, 160);
    if (!admin) return null;
    return { admin, redacted: redactTokens(admin) };
  } catch {
    return null;
  }
}

/** `sk-…` tokens and any run of 12+ word characters become `…`; repeated ellipses collapse. */
export const redactTokens = (text: string) => text.replace(/\bsk-[A-Za-z0-9_-]+/g, "…").replace(/[A-Za-z0-9_-]{12,}/g, "…").replace(/…(\s*…)+/g, "…");

function rethrow(error: unknown): never {
  if (error instanceof ProviderError) throw error;
  if (error instanceof EgressError) {
    if (error.code === "TIMEOUT") throw new ProviderError("MODEL_TIMEOUT", error.message);
    if (error.code === "TOO_LARGE") throw new ProviderError("TOO_LARGE", error.message);
    if (error.code === "NETWORK") throw new ProviderError("PROVIDER_ERROR", error.message);
    throw new ProviderError("EGRESS_REFUSED", error.message);
  }
  throw error;
}

async function failedResponse(response: EgressResponse, readBody?: string): Promise<never> {
  let detail: ReturnType<typeof excerpt> = null;
  try {
    detail = excerpt(readBody ?? await readEgressText(response, ERROR_BODY_MAX_BYTES));
  } catch {
    detail = null;
  }
  const status = response.status;
  modelLog.warn("Provider error", { status, code: "PROVIDER_ERROR" });
  const base = status === 401 || status === 403 ? "The provider refused the API key" : status === 404 ? "The provider has no such model or endpoint" : status === 429 ? "The provider is rate limiting this key" : status >= 500 ? "The provider is unavailable" : "The provider refused the request";
  throw new ProviderError("PROVIDER_ERROR", `${base} (HTTP ${status})${detail ? `: ${detail.redacted}` : ""}`, status, `${base} (HTTP ${status})${detail ? `: ${detail.admin}` : ""}`);
}

/** `GET {baseUrl}/models` → model ids (at most 500, sorted). */
export async function listModels(connection: ProviderConnection): Promise<string[]> {
  let response: Awaited<ReturnType<typeof egressFetch>>;
  try {
    response = await egressFetch(`${connection.baseUrl}/models`, { method: "GET", headers: headersFor(connection, "application/json") }, { maxBytes: MODELS_LIST_MAX_BYTES, firstByteMs: modelTimeouts.firstByteMs, idleMs: modelTimeouts.idleMs, totalMs: modelTimeouts.totalMs });
  } catch (error) {
    rethrow(error);
  }
  if (response.status < 200 || response.status >= 300) await failedResponse(response);
  let text: string;
  try {
    text = await readEgressText(response, MODELS_LIST_MAX_BYTES);
  } catch (error) {
    rethrow(error);
  }
  let parsed: { data?: Array<{ id?: unknown }> };
  try { parsed = JSON.parse(text) as { data?: Array<{ id?: unknown }> }; } catch { throw new ProviderError("PROVIDER_ERROR", "The provider's model list was not JSON"); }
  const ids = (Array.isArray(parsed.data) ? parsed.data : []).map((item) => typeof item?.id === "string" ? item.id : null).filter((id): id is string => id !== null && id.length <= 128);
  return [...new Set(ids)].sort().slice(0, 500);
}

type StreamChunk = {
  model?: string;
  choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
};

/**
 * One streamed Chat Completions call. `onDelta` receives content as it arrives. Tool calls are
 * accumulated by index (for AC-B) and returned; the request itself sends no `tools` in AC-A.
 */
/**
 * The wire `tool_choice` for a choice (Wave 46): a named choice is `{type:"function", function:{name}}`,
 * or `required` when the provider lacks named choice (`namedToolChoice: false`); `required` becomes `auto`
 * when the provider lacks it (`requiredToolChoice: false`). Under a named choice only that tool is offered.
 */
export function toolChoiceFor(compat: ProviderCompat, choice: ToolChoice): "auto" | "required" | { type: "function"; function: { name: string } } {
  const required = compat.requiredToolChoice === false ? "auto" : "required";
  if (choice === "auto") return "auto";
  if (choice === "required") return required;
  return compat.namedToolChoice === false ? required : { type: "function", function: { name: choice.name } };
}

export async function completeStreaming(connection: ProviderConnection, request: CompletionRequest, signal: AbortSignal, onDelta: (text: string) => void, progress: StreamProgress = newProgress(request.messages)): Promise<CompletionResult> {
  const body: Record<string, unknown> = {
    model: request.model ?? connection.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
    [connection.compat.tokenParam]: request.maxOutputTokens ?? 4096
  };
  if (typeof request.temperature === "number") body.temperature = request.temperature;
  const effort = request.reasoningEffort ?? connection.compat.reasoningEffort;
  if (effort && effort !== "omit") body.reasoning_effort = effort;
  if (request.tools && request.tools.length > 0) {
    const choice = request.toolChoice ?? "auto";
    const named = typeof choice === "object" ? choice.name : null;
    const offered = named !== null ? request.tools.filter((tool) => tool.name === named) : request.tools;
    body.tools = offered.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    body.tool_choice = request.probeChoice ? (typeof choice === "object" ? { type: "function", function: { name: choice.name } } : choice) : toolChoiceFor(connection.compat, choice);
  }
  const send = async () => {
    try {
      return await egressFetch(`${connection.baseUrl}/chat/completions`, { method: "POST", headers: headersFor(connection, "text/event-stream"), body: JSON.stringify(body), signal },
        { maxBytes: MODEL_STREAM_MAX_BYTES, firstByteMs: modelTimeouts.firstByteMs, idleMs: modelTimeouts.idleMs, totalMs: modelTimeouts.totalMs });
    } catch (error) {
      rethrow(error);
    }
  };
  let response = await send();
  let readBody: string | undefined;
  if (response.status === 400 && !request.probeChoice) {
    readBody = await readEgressText(response, ERROR_BODY_MAX_BYTES).catch(() => "");
    // 2026-10-14: a model that refuses tools at its default reasoning is asked once more with
    // reasoning_effort "none"; when that works the provider's compat learns it (saved and audited).
    if (body.tools && body.reasoning_effort === undefined && refusesToolsAtReasoning(readBody)) {
      body.reasoning_effort = "none";
      response = await send();
      readBody = undefined;
      modelLog.warn("Provider refused tools at its default reasoning; retrying with reasoning_effort=none", { provider: connection.id.slice(0, 8), status: response.status });
      if (response.status >= 200 && response.status < 300) {
        connection.compat = { ...connection.compat, reasoningEffort: "none" };
        try { compatLearner?.(connection.id, { reasoningEffort: "none" }); } catch { /* the request still goes on */ }
      }
    }
    // Review L2 (Wave 46): a provider that refuses `required` or a named choice with a 400 is asked once
    // more with `auto` (under a named choice only that tool is still offered, so it is the only call to make).
    if (response.status === 400 && body.tool_choice !== undefined && body.tool_choice !== "auto") {
      if (readBody === undefined) response.cancel();
      body.tool_choice = "auto";
      response = await send();
      readBody = undefined;
    }
  }
  if (response.status < 200 || response.status >= 300) await failedResponse(response, readBody);
  progress.started = true;

  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  let model: string | null = null;
  let usage: TokenUsage | null = null;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  const handleChunk = (chunk: StreamChunk) => {
    if (typeof chunk.model === "string" && !model) progress.model = model = chunk.model.slice(0, 128);
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) {
      // Kept up to the stored bound plus one character (so the caller sees the overflow); the rest is
      // read and dropped, and an estimated usage counts what was kept (QA Q4, review L5/L11).
      if (content.length <= AGENT_BOUNDS.assistantMessageChars) content += choice.delta.content.slice(0, AGENT_BOUNDS.assistantMessageChars + 1 - content.length);
      progress.content = content;
      onDelta(choice.delta.content);
    }
    for (const call of choice?.delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.arguments += call.function.arguments;
      calls.set(index, current);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage && typeof chunk.usage.prompt_tokens === "number") {
      usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens ?? 0, estimated: false, ...(typeof chunk.usage.prompt_tokens_details?.cached_tokens === "number" ? { cachedTokens: chunk.usage.prompt_tokens_details.cached_tokens } : {}) };
      progress.usage = usage;
    }
  };
  const handleEvent = (event: string) => {
    for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        handleChunk(JSON.parse(data) as StreamChunk);
      } catch {
        // A malformed chunk is skipped; the stream's end decides the outcome.
      }
    }
  };
  try {
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        handleEvent(buffer.slice(0, separator).replace(/\r/g, ""));
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleEvent(buffer.replace(/\r/g, ""));
  } catch (error) {
    rethrow(error);
  }
  if (!usage) {
    const promptChars = request.messages.reduce((sum, turn) => sum + turnChars(turn), 0);
    usage = { promptTokens: Math.ceil(promptChars / 4), completionTokens: estimateTokens(content.slice(0, AGENT_BOUNDS.assistantMessageChars)), estimated: true };
  }
  // A reply cut at the stored bound is charged for the kept text only (TODO "usage charged on cut replies").
  usage = cutUsage(usage, content);
  return { content, finishReason, usage, model, toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call) };
}

/** One model call as the Audit log records it (AC-C): its own text, the calls it asked for, tokens, and time. */
export type LoopStep = { step: number; content: string; toolCalls: ModelToolCall[]; usage: TokenUsage; model: string | null; durationMs: number };
export type LoopSink = {
  delta: (text: string) => void;
  usage: (usage: TokenUsage, model: string | null) => void;
  /** AC-C: after every model call, before its tool calls run (the Audit log's model steps). */
  step?: (step: LoopStep) => void;
  /**
   * A model call that ended early, once the provider had answered (Wave 42 QA M1, M2): Stop, the
   * wall clock, a lost right, or a failure mid-stream. Its usage is the provider's when reported,
   * else estimated from the prompt and the kept text; the caller charges it and keeps the text.
   */
  interrupted?: (step: LoopStep) => void;
};
/**
 * What a tool call produced: the text the model sees (already capped and marked by the executor).
 * `stop` (Wave 46: an accepted `submit_report`) ends the run after this call; the step's later calls are not run.
 */
export type ToolExecution = { content: string; stop?: boolean };
export type LoopInput = {
  connection: ProviderConnection;
  messages: ChatTurn[];
  maxSteps: number;
  temperature: number | null;
  maxOutputTokens: number | null;
  signal: AbortSignal;
  sink: LoopSink;
  /** Charged after every step; `more` says another step follows. Throws to stop the run (budgets, revocation). */
  charge: (usage: TokenUsage, more: boolean) => void;
  /**
   * AC-B (plan §2.1): the tools the model may call at this step, re-resolved every step (rights
   * are live, D358). Not called on the last step, which goes out without tools (D342).
   */
  tools?: (step: number) => Promise<ModelTool[]> | ModelTool[];
  /** Runs one call (gate, confirmation, timeout, cap, and marker are the executor's); returns the tool turn's content. */
  execute?: (call: ModelToolCall, step: number) => Promise<ToolExecution>;
  /** AC-C (plan §7.1, T319): before every model call, the last one included; throws to end the run (a revoked key). */
  beforeStep?: (step: number) => void;
  /**
   * Re-checked while a model call streams (Wave 42 QA M1), every `runWatch.intervalMs`: throws when
   * the run's right is gone; the provider call is then aborted and the run ends with that error.
   */
  watch?: () => void;
  /** Why no tools were offered, when the run knows (a linked key that died, QA Q4); the answer then ends with it. */
  noToolsReason?: () => string | null;
  /** Calls run per step and per run (defaults: AGENT_BOUNDS); calls past either are dropped, not executed. */
  limits?: { perStep: number; perRun: number };
  /**
   * Wave 46: the tool choice of each step (default `auto`; chat runs never set it). A named choice
   * offers only that tool, also on the last step (which otherwise goes out without tools), so a run
   * can be made to end with one call (report generation forces `submit_report`).
   */
  toolChoice?: (step: number, last: boolean, state: { toolCalls: number; perRun: number; perStep: number }) => ToolChoice | undefined;
  /**
   * A run that must end with one tool (report generation's submit_report, the edit agent's
   * submit_patch; chat never sets it). A text-only answer does not end such a run: a JSON object in
   * the text that `accepts` approves is run as that tool's call (`recovered: "text"`), else the text
   * goes back with `nudge` as a user turn and the next steps offer only that tool, at most `maxNudges`
   * times. Nudged steps count toward the step limit and are charged like any other.
   */
  finalTool?: { name: string; nudge: string; maxNudges: number; accepts?: (value: Record<string, unknown>) => boolean };
};
export type LoopResult = {
  status: "stop" | "step_limit"; content: string; steps: number; usage: TokenUsage; model: string | null; toolCalls: number; droppedToolCalls: number;
  /** finalTool runs: the nudges sent, and whether the run ended on a text answer without the final tool. */
  nudges?: number; finalToolMissed?: boolean;
};

const FENCE = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;

/**
 * Tool arguments as JSON, tolerating what cheaper models send: a ```json fence around it, trailing
 * commas, and a JSON string that holds the JSON. Anything still unparseable is an error that names
 * the problem, so the model can fix it (never a silently dropped call).
 */
export function parseToolArguments(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let text = (raw ?? "").trim();
  if (!text) return { ok: true, value: {} };
  let lastError = "";
  for (let depth = 0; depth < 3; depth += 1) {
    const fenced = /^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/.exec(text);
    if (fenced) text = fenced[1]!.trim();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      lastError = error instanceof Error ? error.message : "not JSON";
      try {
        value = JSON.parse(withoutTrailingCommas(text));
      } catch {
        return { ok: false, error: lastError.slice(0, 200) };
      }
    }
    if (typeof value === "string" && /^\s*(?:[{[]|```)/.test(value)) { text = value.trim(); continue; }
    return { ok: true, value };
  }
  return { ok: false, error: lastError.slice(0, 200) || "nested too deep" };
}

/** Removes commas before a closing brace or bracket, outside strings. */
function withoutTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      out += char;
      if (char === "\\") { out += text[index + 1] ?? ""; index += 1; } else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; out += char; continue; }
    if (char === ",") {
      const rest = /^\s*([}\]])/.exec(text.slice(index + 1));
      if (rest) continue;
    }
    out += char;
  }
  return out;
}

/** The JSON object a text answer carries (a ```json fence first, else its outermost braces), or null. */
export function jsonObjectFromText(text: string): Record<string, unknown> | null {
  const candidates = [...text.matchAll(FENCE)].map((match) => match[1]!);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    const parsed = parseToolArguments(candidate);
    if (parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) return parsed.value as Record<string, unknown>;
  }
  return null;
}

/** The one line an old tool result becomes once it falls out of the run's window (review L4). */
export const OMITTED_TOOL_RESULT = "[An earlier tool result was omitted to keep the conversation short; call the tool again if you need it.]";

/**
 * Keeps the last `keep` tool results of the run whole and replaces older ones with a one-line
 * placeholder (the `tool` turns stay, so every call still has its answer on the wire).
 */
export function windowToolResults(messages: ChatTurn[], keep: number) {
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const turn = messages[index]!;
    if (turn.role !== "tool") continue;
    seen += 1;
    if (seen > keep && turn.content !== OMITTED_TOOL_RESULT) turn.content = OMITTED_TOOL_RESULT;
  }
}

/** How often a streaming model call re-checks the run's right (Wave 42 QA M1), on an object so tests can shorten it. */
export const runWatch = { intervalMs: 2000 };

/**
 * One model call of the loop: aborted when the run's signal is, or when `watch` throws while it
 * streams (the error is then the run's). A call that ends early after the provider answered is
 * reported to `sink.interrupted` with what it streamed and its usage (Wave 42 QA M1, M2).
 */
async function watchedCall(input: LoopInput, step: number, stepStarted: number, tools: ModelTool[], delta: (text: string) => void, textRoom: number, toolChoice?: ToolChoice): Promise<CompletionResult> {
  const progress = newProgress(input.messages);
  const controller = new AbortController();
  const forward = () => controller.abort(input.signal.reason);
  if (input.signal.aborted) forward();
  else input.signal.addEventListener("abort", forward, { once: true });
  let lost: { error: unknown } | null = null;
  const watcher = input.watch ? setInterval(() => {
    if (lost) return;
    try {
      input.watch!();
    } catch (error) {
      lost = { error };
      controller.abort("lost");
    }
  }, runWatch.intervalMs) : null;
  try {
    return await completeStreaming(input.connection, { messages: input.messages, temperature: input.temperature, maxOutputTokens: input.maxOutputTokens ?? undefined, tools, ...(toolChoice !== undefined ? { toolChoice } : {}) }, controller.signal, delta, progress);
  } catch (error) {
    if (progress.started) input.sink.interrupted?.({ step, content: progress.content, toolCalls: [], usage: keptUsage(partialUsage(progress), progress.content, textRoom), model: progress.model, durationMs: Date.now() - stepStarted });
    throw lost ? (lost as { error: unknown }).error : error;
  } finally {
    if (watcher) clearInterval(watcher);
    input.signal.removeEventListener("abort", forward);
  }
}

/**
 * The loop (plan §2.1, D342, D343). Each step is one model call. Tool calls run one at a time in
 * the model's order; their results go back as `tool` turns and the loop continues. The last step
 * goes out without tools and ends `step_limit` when the model still wanted one. Without tools
 * offered, a call the model invents anyway ends the run as a plain answer.
 */
export async function runLoop(input: LoopInput): Promise<LoopResult> {
  const total: TokenUsage = { promptTokens: 0, completionTokens: 0, estimated: false };
  let content = "";
  let model: string | null = null;
  let toolCalls = 0;
  let droppedToolCalls = 0;
  let offeredAny = false;
  // finalTool runs: nudges sent, and whether the next steps offer only the final tool.
  let nudges = 0;
  let forceFinal = false;
  const perStep = input.limits?.perStep ?? AGENT_BOUNDS.toolCallsPerStep;
  const perRun = input.limits?.perRun ?? AGENT_BOUNDS.toolCallsPerRun;
  // Characters streamed to the caller so far: the stored reply keeps at most the bound of them.
  let streamed = 0;
  const delta = (text: string) => {
    streamed += text.length;
    input.sink.delta(text);
  };
  for (let step = 1; step <= input.maxSteps; step += 1) {
    const last = step === input.maxSteps;
    input.beforeStep?.(step);
    const choice = forceFinal && input.finalTool ? { name: input.finalTool.name } : input.toolChoice?.(step, last, { toolCalls, perRun, perStep });
    const named = typeof choice === "object" ? choice.name : null;
    const offer = !!input.tools && input.connection.compat.supportsTools && (named !== null || (!last && toolCalls < perRun));
    const offeredTools = offer ? await input.tools!(step) : [];
    const tools = named !== null ? offeredTools.filter((tool) => tool.name === named) : offeredTools;
    offeredAny ||= tools.length > 0;
    windowToolResults(input.messages, AGENT_BOUNDS.toolResultsWindow);
    const stepStarted = Date.now();
    const textRoom = storedRoom(streamed);
    const reply = await watchedCall(input, step, stepStarted, tools, delta, textRoom, tools.length > 0 ? choice : undefined);
    const execute = input.execute;
    // Under a named choice only that tool was offered: a call to any other is not run (Wave 46).
    const wantedCalls = tools.length > 0 && execute ? reply.toolCalls.filter((call) => call.name && (named === null || call.name === named)) : [];
    // Per step and per run (review L4): calls past either cap are dropped here, never executed, with
    // no event or audit row each; the run's finish row counts them, and the model is told once.
    // Review M1 (Wave 46): a named, forced tool is exempt from the per-run cap, so it always gets its call.
    const room = named !== null ? perStep : Math.max(0, Math.min(perStep, perRun - toolCalls));
    // Call ids are Nook's, never the model's (review M1): `call_<step>_<index>`, unique in the run.
    let calls: ModelToolCall[] = wantedCalls.slice(0, room).map((call, index) => ({ ...call, id: `call_${step}_${index}` }));
    const dropped = wantedCalls.length - calls.length;
    droppedToolCalls += dropped;
    // A run with a final tool that got a text answer: take a JSON object in the text as the call, or nudge.
    const final = execute ? input.finalTool : undefined;
    const textOnly = !reply.toolCalls.some((call) => call.name);
    if (final && calls.length === 0 && textOnly) {
      const value = jsonObjectFromText(reply.content);
      if (value && (!final.accepts || final.accepts(value))) calls = [{ id: `call_${step}_0`, name: final.name, arguments: JSON.stringify(value), recovered: "text" }];
    }
    const nudging = !!final && calls.length === 0 && textOnly && nudges < final.maxNudges && !last;
    const ending = (calls.length === 0 || !execute) && !nudging;
    // The ending step's text never goes back to the model: it is charged only for what the stored reply keeps.
    const usage = ending ? keptUsage(reply.usage, reply.content, textRoom) : reply.usage;
    input.sink.step?.({ step, content: reply.content, toolCalls: reply.toolCalls, usage, model: reply.model, durationMs: Date.now() - stepStarted });
    modelLog.info("Model step", {
      step, ms: Date.now() - stepStarted, tools: calls.map((call) => call.name).join(",") || undefined, dropped: dropped || undefined,
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, estimated: usage.estimated || undefined, model: reply.model ?? undefined
    });
    total.promptTokens += usage.promptTokens;
    total.completionTokens += usage.completionTokens;
    total.estimated = total.estimated || usage.estimated;
    model = reply.model ?? model;
    if (reply.content) content += (content && reply.toolCalls.length === 0 && !content.endsWith("\n") ? "\n\n" : "") + reply.content;
    // On the last step the model got no tools (D342); still wanting one after earlier steps had them is the step limit.
    const wanted = ending && last && offeredAny && reply.toolCalls.length > 0;
    // A tool call nothing could run (none offered at this step) ends the answer with a reason, never an empty reply (Wave 41 QA L9).
    // The note is streamed before the step's usage, so a stream reads run, delta…, usage, done (Wave 42 QA L6).
    if (ending && reply.toolCalls.some((call) => call.name)) {
      const reason = wanted ? null : input.noToolsReason?.() ?? null;
      const note = wanted
        ? "[The answer reached its step limit while the model still wanted to use a tool.]"
        : `[The model tried to use a tool, but no tools were available to it here, so the answer stops.${reason ? ` ${reason}` : ""}]`;
      const lead = content ? "\n\n" : "";
      content += lead + note;
      delta(lead + note);
    }
    input.sink.usage(usage, reply.model);
    // Charged after every step; with more steps ahead a used-up budget ends the run here (plan §2.2).
    input.charge(usage, calls.length > 0 || nudging);
    if (nudging) {
      nudges += 1;
      forceFinal = true;
      input.messages.push({ role: "assistant", content: reply.content }, { role: "user", content: final!.nudge });
      continue;
    }
    if (ending) {
      input.messages.push({ role: "assistant", content: reply.content });
      return { status: wanted ? "step_limit" : "stop", content, steps: step, usage: total, model, toolCalls, droppedToolCalls, ...(final ? { nudges, finalToolMissed: textOnly } : {}) };
    }
    input.messages.push({ role: "assistant", content: reply.content, tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) });
    for (const [index, call] of calls.entries()) {
      toolCalls += 1;
      const outcome = await execute!(call, step);
      const note = dropped > 0 && index === calls.length - 1 ? `\n[${dropped} more tool ${dropped === 1 ? "call" : "calls"} in this step ${dropped === 1 ? "was" : "were"} dropped: at most ${perStep} calls run per step and ${perRun} per answer.]` : "";
      input.messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content + note });
      if (outcome.stop) return { status: "stop", content, steps: step, usage: total, model, toolCalls, droppedToolCalls, ...(input.finalTool ? { nudges } : {}) };
    }
  }
  return { status: "step_limit", content, steps: input.maxSteps, usage: total, model, toolCalls, droppedToolCalls, ...(input.finalTool ? { nudges } : {}) };
}
