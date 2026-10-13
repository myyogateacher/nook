import { afterAll, describe, expect, test } from "bun:test";
import "./support/harness";
import { DEFAULT_COMPAT } from "../shared/agents";
import { startScriptedProvider, type Script } from "../scripts/fakeReportProvider";

const { runLoop } = await import("../server/agents/loop");
type ModelToolCall = import("../server/agents/loop").ModelToolCall;
type ToolChoice = import("../server/agents/loop").ToolChoice;

/**
 * loop.ts `toolChoice` (Wave 46, D426): chat runs keep `auto` and a tool-less last step; a named choice
 * offers only that tool (also on the last step) as `{type: "function", function: {name}}`, or as
 * `required` with only that tool for a provider without named choice; a tool result with `stop` ends
 * the run, and the step's later calls are not run.
 */

const provider = startScriptedProvider(0);
afterAll(() => provider.stop());

const TOOLS = [
  { name: "lookup", description: "Looks up", parameters: { type: "object", properties: {} } },
  { name: "submit", description: "Submits", parameters: { type: "object", properties: {} } }
];

async function run(script: Script, options: { maxSteps?: number; toolChoice?: (step: number, last: boolean) => ToolChoice | undefined; named?: boolean; stopOn?: string } = {}) {
  provider.setScript(script);
  provider.calls.length = 0;
  const executed: ModelToolCall[] = [];
  const result = await runLoop({
    connection: { id: "scripted", baseUrl: provider.baseUrl, apiKey: null, model: "m", compat: { ...DEFAULT_COMPAT, ...(options.named === false ? { namedToolChoice: false } : {}) } },
    messages: [{ role: "user", content: "go" }],
    maxSteps: options.maxSteps ?? 3,
    temperature: null,
    maxOutputTokens: null,
    signal: new AbortController().signal,
    sink: { delta: () => undefined, usage: () => undefined },
    charge: () => undefined,
    tools: () => TOOLS,
    execute: async (call) => {
      executed.push(call);
      return { content: "ok", ...(call.name === options.stopOn ? { stop: true } : {}) };
    },
    ...(options.toolChoice ? { toolChoice: options.toolChoice } : {})
  });
  const requests = provider.calls.map((body) => ({ choice: body.tool_choice ?? null, tools: (body.tools ?? []).map((tool) => tool.function.name) }));
  return { result, executed, requests };
}

const alwaysLookup: Script = () => ({ toolCalls: [{ name: "lookup", arguments: {} }] });

describe("toolChoice in the loop", () => {
  test("without it (chat runs): auto on every step with tools, and the last step goes out without tools", async () => {
    const { result, requests } = await run(alwaysLookup);
    expect(result.status).toBe("step_limit");
    expect(requests).toEqual([
      { choice: "auto", tools: ["lookup", "submit"] },
      { choice: "auto", tools: ["lookup", "submit"] },
      { choice: null, tools: [] }
    ]);
  });

  test("a named choice on the last step offers only that tool and forces it; a stop result ends the run", async () => {
    const script: Script = (context) => ({ toolCalls: [{ name: context.forced ?? "lookup", arguments: {} }] });
    const { result, executed, requests } = await run(script, { toolChoice: (_step, last) => last ? { name: "submit" } : "required", stopOn: "submit" });
    expect(requests).toEqual([
      { choice: "required", tools: ["lookup", "submit"] },
      { choice: "required", tools: ["lookup", "submit"] },
      { choice: { type: "function", function: { name: "submit" } }, tools: ["submit"] }
    ]);
    expect(executed.map((call) => call.name)).toEqual(["lookup", "lookup", "submit"]);
    expect(result).toMatchObject({ status: "stop", steps: 3, toolCalls: 3 });
  });

  test("a provider without named choice gets required with only the named tool", async () => {
    const script: Script = (context) => ({ toolCalls: [{ name: context.forced ?? "lookup", arguments: {} }] });
    const { requests, result } = await run(script, { maxSteps: 2, named: false, toolChoice: (_step, last) => last ? { name: "submit" } : undefined, stopOn: "submit" });
    expect(requests).toEqual([
      { choice: "auto", tools: ["lookup", "submit"] },
      { choice: "required", tools: ["submit"] }
    ]);
    expect(result.status).toBe("stop");
  });

  test("a stop result skips the step's later calls; a model ignoring a forced tool still ends at the step limit", async () => {
    const both: Script = () => ({ toolCalls: [{ name: "submit", arguments: {} }, { name: "lookup", arguments: {} }] });
    const stopped = await run(both, { stopOn: "submit" });
    expect(stopped.executed.map((call) => call.name)).toEqual(["submit"]);
    expect(stopped.result).toMatchObject({ status: "stop", steps: 1 });

    // Forced to `submit` on the last step, a model that calls `lookup` anyway runs nothing there (only `submit` was offered).
    const stubborn = await run(alwaysLookup, { maxSteps: 2, toolChoice: (_step, last) => last ? { name: "submit" } : undefined });
    expect(stubborn.executed.map((call) => call.name)).toEqual(["lookup"]);
    expect(stubborn.result.status).toBe("step_limit");
    expect(stubborn.result.content).toContain("step limit");
  });
});
