import { AsyncLocalStorage } from "node:async_hooks";
import { currentLogContext, shortId, withLogContext } from "../log";

/**
 * The agent-run depth guard (Wave 42 "AC-C", plan §7.2, T318): every run (a chat's, an API call's,
 * or `run_agent`'s) executes inside this store, which follows its async work: model calls, tool
 * calls, and Nook tools run in process through `runTool`. `run_agent` refuses to start while a run
 * is in the store, so an agent can never start another run, whatever key its Nook tools use (the
 * tool is also left out of the Nook tools agents are offered).
 */

export type AgentRunFrame = { runId: string; via: "chat" | "api" | "mcp" };

const frames = new AsyncLocalStorage<AgentRunFrame>();

/** The run this code is executing inside, or null outside every run. */
export const currentAgentRun = (): AgentRunFrame | null => frames.getStore() ?? null;

/** Runs `operation` (and everything it awaits or schedules) inside the run's frame. */
export const withinAgentRun = <T>(frame: AgentRunFrame, operation: () => T): T =>
  frames.run(frame, () => withLogContext({ ...currentLogContext(), run: shortId(frame.runId) }, operation));

/**
 * Across an HTTP hop (Wave 42 review M1, T318) the frame above cannot follow: Nook sends
 * `Nook-Agent-Run: <runId>` on every outbound MCP request made inside a run
 * (server/agents/mcpClient.ts), and refuses to start a run (`POST /api/v1/agents/:id/runs`,
 * `/api/v1/tools/run_agent`, MCP `run_agent`) for a request that carries it: 409 `AGENT_RECURSION`.
 * A tool server that drops the header is bounded by the owner's and the instance's run slots, and
 * by the save-time refusal of Nook keys as tool-server credentials (server/agents/toolServers.ts).
 */
export const AGENT_RUN_HEADER = "Nook-Agent-Run";

/** Whether an inbound request says it comes from inside an agent run. */
export const fromAgentRun = (request: Request) => request.headers.has(AGENT_RUN_HEADER);

export const RECURSION_MESSAGE = "An agent run cannot start another run: this request came from inside one (Nook-Agent-Run)";
