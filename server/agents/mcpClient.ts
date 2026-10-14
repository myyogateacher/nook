import { CallToolResultSchema, InitializeResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/core";
import { config } from "../config";
import { AGENT_RUN_HEADER, currentAgentRun } from "./depth";
import { EgressError, egressFetch, type EgressResponse } from "./egress";
import { sniff, SNIFF_BYTES } from "../mimeSniff";
import { TOOL_IMAGE_BOUNDS, type ToolImageRef } from "../../shared/agents";
import { logger } from "../log";

const slog = logger("agents");

/**
 * The in-house MCP client (plan §3.1, D346; Wave 41 AC-B): Streamable HTTP, spec 2025-11-25, over
 * `egressFetch` (so every byte passes the egress guard, D347), with no SDK client package. It does
 * `initialize` + `notifications/initialized`, keeps the `Mcp-Session-Id` the server hands out and
 * sends it with `MCP-Protocol-Version` on every later request, reads JSON or SSE response bodies
 * until the message with the matching id arrives, answers server-to-client requests with -32601
 * (Nook offers no sampling, roots, or elicitation), re-initializes once on a 404 that carried a
 * session, marks 401/403 as `MCP_AUTH`, sends `notifications/cancelled` when a call is aborted, and
 * DELETEs the session on close (best effort). No GET listening stream, no resumability: Nook opens
 * no long-lived connection to a tool server.
 *
 * Results are validated with the zod schemas of `@modelcontextprotocol/core` (already installed by
 * the server SDK). Errors never carry the server's URL, headers, or body beyond a bounded,
 * letter-only excerpt of a JSON-RPC error message.
 */

export const MCP_PROTOCOL_VERSION = "2025-11-25";
/** One MCP response body (plan §3.2 item 5). */
export const MCP_RESPONSE_MAX_BYTES = 1024 * 1024;
const MAX_TOOL_PAGES = 10;
const MAX_TOOLS = 500;
/** Server-to-client requests answered (-32601) per SSE response; the rest are ignored (review L1). */
export const SERVER_REQUEST_REPLIES_MAX = 3;

export type McpClientCode = "MCP_PROTOCOL" | "MCP_AUTH" | "MCP_HTTP" | "MCP_TIMEOUT" | "EGRESS_REFUSED" | "TOO_LARGE" | "NETWORK" | "CANCELLED";

export class McpClientError extends Error {
  constructor(readonly code: McpClientCode, message: string, readonly status: number | null = null) {
    super(message);
    this.name = "McpClientError";
  }
}

export type McpToolInfo = {
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean | null; destructiveHint: boolean | null; openWorldHint: boolean | null };
};

/** A tool's result as text only (D350): text parts joined; other parts become placeholders. */
/** A tool's image, checked by its bytes (PNG, JPEG, GIF, or WebP; never SVG) and within `TOOL_IMAGE_BOUNDS`. */
export type McpImage = { mimeType: ToolImageRef["mimeType"]; bytes: Uint8Array };
/** `images` only when the result carried at least one usable image (callers and tests compare the rest as before). */
export type McpCallOutcome = { text: string; isError: boolean; images?: McpImage[] };

const TOOL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * An MCP image part as Nook keeps it, or null: base64 that decodes, at most `TOOL_IMAGE_BOUNDS.bytes`,
 * and bytes that are PNG, JPEG, GIF, or WebP whatever `mimeType` claims (the sniffed type wins).
 */
export function toolImageOf(data: unknown): McpImage | null {
  if (typeof data !== "string" || data.length === 0 || data.length > Math.ceil(TOOL_IMAGE_BOUNDS.bytes / 3) * 4 + 4096) return null;
  const clean = data.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 !== 0) return null;
  const bytes = new Uint8Array(Buffer.from(clean, "base64"));
  if (bytes.byteLength === 0 || bytes.byteLength > TOOL_IMAGE_BOUNDS.bytes) return null;
  const sniffed = sniff(bytes.subarray(0, SNIFF_BYTES), "", bytes.byteLength).mimeType;
  return TOOL_IMAGE_TYPES.has(sniffed) ? { mimeType: sniffed as McpImage["mimeType"], bytes } : null;
}

/** The transport under a session: HTTP here, stdio in server/agents/stdio.ts. */
export interface McpTransport {
  /** Sends a request and returns its `result`; a JSON-RPC error becomes `MCP_PROTOCOL`. */
  request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  /**
   * Which peer the transport talks to (stdio: one number per child process; an exited child counts
   * as the next one). A session re-initializes when it changes (review L3). HTTP has none.
   */
  generation?(): number;
}

type JsonRpcMessage = { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };

const excerpt = (text: string | undefined) => (text ?? "").replace(/[^A-Za-z0-9 .,:;()'-]/g, "").replace(/\b[A-Za-z0-9-]{24,}\b/g, "…").slice(0, 160);

/** Streamable HTTP (plan §3.1). `headers` are the server's configured credential only (T306). */
export class McpHttpTransport implements McpTransport {
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized = false;

  constructor(private readonly target: { url: string; headers: Record<string, string>; timeoutMs: number }) {}

  get session() {
    return this.sessionId;
  }

  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...this.target.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (this.initialized) headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    // Inside a run, say so (Wave 42 review M1, T318): a server that calls Nook back with it cannot start a run.
    const run = currentAgentRun();
    if (run) headers[AGENT_RUN_HEADER] = run.runId;
    return headers;
  }

  private async post(body: unknown, signal?: AbortSignal): Promise<EgressResponse> {
    try {
      return await egressFetch(this.target.url, { method: "POST", headers: this.baseHeaders(), body: JSON.stringify(body), signal },
        { maxBytes: MCP_RESPONSE_MAX_BYTES, firstByteMs: this.target.timeoutMs, idleMs: this.target.timeoutMs, totalMs: this.target.timeoutMs });
    } catch (error) {
      throw mapTransportError(error, signal);
    }
  }

  async notify(method: string, params: Record<string, unknown>) {
    const response = await this.post({ jsonrpc: "2.0", method, params });
    response.cancel();
    if (response.status === 401 || response.status === 403) throw new McpClientError("MCP_AUTH", "The tool server refused the credential", response.status);
  }

  /** Marks the session initialized (the session layer calls initialize then this). */
  markInitialized(sessionId: string | null) {
    this.initialized = true;
    if (sessionId) this.sessionId = sessionId;
  }

  reset() {
    this.sessionId = null;
    this.initialized = false;
  }

  async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
    if (response.status === 401 || response.status === 403) { response.cancel(); throw new McpClientError("MCP_AUTH", "The tool server refused the credential", response.status); }
    if (response.status === 404 && this.sessionId) { response.cancel(); throw new SessionGone(); }
    if (response.status < 200 || response.status >= 300) { response.cancel(); throw new McpClientError("MCP_HTTP", `The tool server answered HTTP ${response.status}`, response.status); }
    const session = response.headers.get("mcp-session-id");
    if (session && /^[\x21-\x7E]{1,256}$/.test(session)) this.sessionId = session;
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    let message: JsonRpcMessage;
    try {
      message = type.includes("text/event-stream") ? await this.readSse(response, id, signal) : await readJson(response, id);
    } catch (error) {
      if (error instanceof McpClientError) throw error;
      throw mapTransportError(error, signal);
    }
    if (message.error) throw new McpClientError("MCP_PROTOCOL", `The tool server returned an error${message.error.message ? `: ${excerpt(message.error.message)}` : ""}`);
    return message.result;
  }

  /** Reads SSE events until the response with `id` arrives; server requests get -32601. */
  private async readSse(response: EgressResponse, id: number, signal?: AbortSignal): Promise<JsonRpcMessage> {
    const decoder = new TextDecoder();
    let buffer = "";
    let found: JsonRpcMessage | null = null;
    // Server-to-client requests answered per response (review L1): at most 3; the rest are ignored and counted.
    const replies = { sent: 0, ignored: 0 };
    const handle = (frame: string) => {
      const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data.trim()) return;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { return; }
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) this.handleMessage(message as JsonRpcMessage, id, (match) => { found = match; }, replies);
    };
    try {
      for await (const bytes of response.body) {
        buffer += decoder.decode(bytes, { stream: true });
        let separator = buffer.indexOf("\n\n");
        while (separator >= 0) {
          handle(buffer.slice(0, separator).replace(/\r/g, ""));
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf("\n\n");
        }
        if (found) break;
      }
    } finally {
      response.cancel();
      if (replies.ignored > 0) slog.warn(`Agents: a tool server sent ${replies.ignored} more server-to-client ${replies.ignored === 1 ? "request" : "requests"} in one response than Nook answers (${SERVER_REQUEST_REPLIES_MAX}); ignored`);
    }
    if (!found) {
      if (signal?.aborted) throw new McpClientError("CANCELLED", "The call was cancelled");
      throw new McpClientError("MCP_PROTOCOL", "The tool server's stream ended without a response");
    }
    return found;
  }

  private handleMessage(message: JsonRpcMessage, id: number, onMatch: (message: JsonRpcMessage) => void, replies: { sent: number; ignored: number }) {
    if (!message || typeof message !== "object") return;
    if (message.id === id && ("result" in message || "error" in message)) { onMatch(message); return; }
    // A request from the server (sampling, elicitation, roots): Nook offers none of it (plan §3.1).
    if (typeof message.method === "string" && message.id !== undefined && message.id !== null) {
      if (replies.sent >= SERVER_REQUEST_REPLIES_MAX) { replies.ignored += 1; return; }
      replies.sent += 1;
      void this.post({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }).then((reply) => reply.cancel(), () => undefined);
    }
    // Notifications (progress, logging) are ignored (plan: progress ignored).
  }

  async close() {
    if (!this.sessionId) return;
    const session = this.sessionId;
    this.sessionId = null;
    this.initialized = false;
    try {
      const response = await egressFetch(this.target.url, { method: "DELETE", headers: { ...this.target.headers, "Mcp-Session-Id": session, "MCP-Protocol-Version": MCP_PROTOCOL_VERSION } },
        { maxBytes: 16 * 1024, firstByteMs: 5000, idleMs: 5000, totalMs: 5000 });
      response.cancel();
    } catch {
      // Best effort (plan §3.1).
    }
  }
}

class SessionGone extends Error {
  constructor() {
    super("session gone");
    this.name = "SessionGone";
  }
}

function mapTransportError(error: unknown, signal?: AbortSignal): McpClientError {
  if (error instanceof McpClientError) return error;
  if (signal?.aborted) return new McpClientError("CANCELLED", "The call was cancelled");
  if (error instanceof EgressError) {
    if (error.code === "TIMEOUT") return new McpClientError("MCP_TIMEOUT", "The tool server did not answer in time");
    if (error.code === "TOO_LARGE") return new McpClientError("TOO_LARGE", "The tool server sent more than allowed");
    if (error.code === "NETWORK") return new McpClientError("NETWORK", "The tool server could not be reached");
    return new McpClientError("EGRESS_REFUSED", error.message);
  }
  return new McpClientError("NETWORK", "The tool server could not be reached");
}

async function readJson(response: EgressResponse, id: number): Promise<JsonRpcMessage> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MCP_RESPONSE_MAX_BYTES) throw new McpClientError("TOO_LARGE", "The tool server sent more than allowed");
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new McpClientError("MCP_PROTOCOL", "The tool server's answer was not JSON");
  }
  const message = (Array.isArray(parsed) ? parsed : [parsed]).find((item) => item && typeof item === "object" && (item as JsonRpcMessage).id === id) as JsonRpcMessage | undefined;
  if (!message) throw new McpClientError("MCP_PROTOCOL", "The tool server's answer did not match the request");
  return message;
}

const annotation = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;

/** The MCP session over a transport: initialize, list every tool, call a tool (plan §3.1). */
export class McpSession {
  private ready: Promise<void> | null = null;
  /** The transport generation the current `ready` initialized (stdio: the child it greeted). */
  private readyGeneration: number | null = null;
  lastUsed = Date.now();

  constructor(readonly transport: McpTransport, readonly label = "tool server") {}

  private async initialize() {
    const result = await this.transport.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "nook", title: config.appName, version: config.appVersion } });
    const parsed = InitializeResultSchema.safeParse(result);
    if (!parsed.success) throw new McpClientError("MCP_PROTOCOL", "The tool server's initialize answer did not match the MCP schema");
    if (this.transport instanceof McpHttpTransport) this.transport.markInitialized(this.transport.session);
    this.readyGeneration = this.transport.generation?.() ?? null;
    await this.transport.notify("notifications/initialized", {});
  }

  private ensure() {
    // A restarted stdio child is a new peer: greet it again before any other request (review L3).
    if (this.ready && this.readyGeneration !== null && this.transport.generation && this.transport.generation() !== this.readyGeneration) this.ready = null;
    this.ready ??= this.initialize().catch((error) => { this.ready = null; throw error; });
    return this.ready;
  }

  /** A request on an initialized session; a 404 with a session re-initializes once (plan §3.1). */
  private async call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    this.lastUsed = Date.now();
    await this.ensure();
    try {
      return await this.transport.request(method, params, signal);
    } catch (error) {
      if (!(error instanceof SessionGone) || !(this.transport instanceof McpHttpTransport)) throw error;
      this.transport.reset();
      this.ready = null;
      await this.ensure();
      try {
        return await this.transport.request(method, params, signal);
      } catch (again) {
        // A second 404 is the server's failure, never the internal marker (review L2).
        if (again instanceof SessionGone) throw new McpClientError("MCP_HTTP", "The tool server lost the session again after a fresh initialize", 404);
        throw again;
      }
    }
  }

  /** `tools/list` following `nextCursor` (at most 10 pages, 500 tools). */
  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await this.call("tools/list", cursor ? { cursor } : {}, signal);
      const parsed = ListToolsResultSchema.safeParse(result);
      if (!parsed.success) throw new McpClientError("MCP_PROTOCOL", "The tool server's tool list did not match the MCP schema");
      for (const tool of parsed.data.tools) {
        if (tools.length >= MAX_TOOLS) break;
        const raw = tool as unknown as Record<string, unknown>;
        const hints = (raw.annotations ?? {}) as Record<string, unknown>;
        tools.push({
          // Not cut: a name past 128 characters is dropped at sync (review L7), never stored shortened.
          name: tool.name,
          title: typeof raw.title === "string" ? raw.title.slice(0, 128) : null,
          description: typeof raw.description === "string" ? raw.description.slice(0, 4096) : "",
          inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
          annotations: { readOnlyHint: annotation(hints.readOnlyHint), destructiveHint: annotation(hints.destructiveHint), openWorldHint: annotation(hints.openWorldHint) }
        });
      }
      cursor = typeof parsed.data.nextCursor === "string" && parsed.data.nextCursor ? parsed.data.nextCursor : undefined;
      if (!cursor || tools.length >= MAX_TOOLS) break;
    }
    return tools;
  }

  /** `tools/call`: text parts joined, other parts replaced by placeholders, `isError` passed on (D350). */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallOutcome> {
    let result: unknown;
    try {
      result = await this.call("tools/call", { name, arguments: args }, signal);
    } catch (error) {
      if (error instanceof McpClientError && (error.code === "CANCELLED" || error.code === "MCP_TIMEOUT")) {
        // Best effort (plan §2.2): the server may stop work it has in flight.
        void this.transport.notify("notifications/cancelled", { reason: error.code === "MCP_TIMEOUT" ? "timeout" : "cancelled" }).catch(() => undefined);
      }
      throw error;
    }
    const parsed = CallToolResultSchema.safeParse(result);
    if (!parsed.success) throw new McpClientError("MCP_PROTOCOL", "The tool server's result did not match the MCP schema");
    const parts: string[] = [];
    const images: McpImage[] = [];
    for (const item of parsed.data.content ?? []) {
      if (item.type === "text") parts.push(item.text);
      else if (item.type === "image") {
        // Shown to the person in the call's details; the model gets this line instead of the picture.
        const image = images.length < TOOL_IMAGE_BOUNDS.perCall ? toolImageOf(item.data) : null;
        if (image) {
          images.push(image);
          // Whether the person sees it is decided when it is stored (server/agents/runs.ts adds a line saying so).
          parts.push(`[image: ${image.mimeType}, ${Math.max(1, Math.round(image.bytes.byteLength / 1024))} KiB]`);
        } else parts.push("[image omitted]");
      }
      else if (item.type === "audio") parts.push("[audio omitted]");
      else if (item.type === "resource_link") parts.push("[resource link omitted: Nook never fetches linked resources]");
      else if (item.type === "resource") parts.push("[embedded resource omitted]");
      else parts.push("[content omitted]");
    }
    if (parts.length === 0 && parsed.data.structuredContent !== undefined) parts.push(JSON.stringify(parsed.data.structuredContent));
    return { text: parts.join("\n"), isError: parsed.data.isError === true, ...(images.length > 0 ? { images } : {}) };
  }

  async close() {
    this.ready = null;
    await this.transport.close();
  }
}

/** The one-line, URL-free description an admin sees for a failed sync or call. */
export function describeMcpError(error: unknown): { status: "auth_failed" | "unreachable" | "error"; message: string } {
  if (error instanceof McpClientError) {
    if (error.code === "MCP_AUTH") return { status: "auth_failed", message: "The server refused the credential (HTTP 401/403)" };
    if (error.code === "EGRESS_REFUSED") return { status: "unreachable", message: error.message };
    if (error.code === "NETWORK" || error.code === "MCP_TIMEOUT") return { status: "unreachable", message: error.message };
    return { status: "error", message: error.message };
  }
  if (error instanceof EgressError) return { status: "unreachable", message: error.message };
  return { status: "error", message: "The tool server could not be used" };
}
