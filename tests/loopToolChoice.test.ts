import { afterAll, describe, expect, test } from "bun:test";
import "./support/harness";
import { DEFAULT_COMPAT } from "../shared/agents";
import { startScriptedProvider, type Script } from "../scripts/fakeReportProvider";

const { runLoop, toolChoiceFor } = await import("../server/agents/loop");
const { generateToolChoice, GENERATE_LIMITS } = await import("../server/reports/generate");
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

type ChoiceFn = (step: number, last: boolean, state: { toolCalls: number; perRun: number; perStep: number }) => ToolChoice | undefined;
async function run(script: Script, options: { maxSteps?: number; toolChoice?: ChoiceFn; named?: boolean; required?: boolean; stopOn?: string; limits?: { perStep: number; perRun: number } } = {}) {
  provider.setScript(script);
  provider.calls.length = 0;
  const executed: ModelToolCall[] = [];
  const result = await runLoop({
    connection: { id: "scripted", baseUrl: provider.baseUrl, apiKey: null, model: "m", compat: { ...DEFAULT_COMPAT, ...(options.named === false ? { namedToolChoice: false } : {}), ...(options.required === false ? { requiredToolChoice: false } : {}) } },
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
    ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
    ...(options.limits ? { limits: options.limits } : {})
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

  test("review M1: a chatty model that uses up the per-run cap is still made to submit (forced, and exempt from the cap)", async () => {
    // Six calls a step: after six steps 36 of 40 calls are used, fewer than a step may make, so the
    // seventh step offers and forces submit_report alone, and it runs although the cap would leave 4.
    const chatty: Script = (context) => context.forced
      ? { toolCalls: [{ name: "submit", arguments: {} }] }
      : { toolCalls: Array.from({ length: 6 }, () => ({ name: "lookup", arguments: {} })) };
    const choice = generateToolChoice(GENERATE_LIMITS.steps);
    const { result, executed, requests } = await run(chatty, {
      maxSteps: GENERATE_LIMITS.steps, stopOn: "submit", limits: { perStep: GENERATE_LIMITS.perStep, perRun: GENERATE_LIMITS.perRun },
      toolChoice: (step, last, state) => { const value = choice(step, last, state); return typeof value === "object" ? { name: "submit" } : value; }
    });
    expect(requests.length).toBe(7);
    expect(requests[6]).toEqual({ choice: { type: "function", function: { name: "submit" } }, tools: ["submit"] });
    expect(executed.at(-1)!.name).toBe("submit");
    expect(result.status).toBe("stop");

    // Even past the cap (every call used), the forced tool gets its call.
    const spent = await run(chatty, { maxSteps: 3, stopOn: "submit", limits: { perStep: 6, perRun: 6 }, toolChoice: (_step, _last, state) => state.perRun - state.toolCalls < state.perStep ? { name: "submit" } : "required" });
    expect(spent.executed.map((call) => call.name)).toEqual([...Array(6).fill("lookup"), "submit"]);
    expect(spent.result.status).toBe("stop");
  });

  test("review L2: a provider that refuses required or a named choice is asked again with auto; a compat flag skips required", async () => {
    // This provider answers 400 to any tool_choice but auto, like servers without that feature.
    const picky: Script = (context) => context.body.tool_choice !== "auto" ? { status: 400, content: "tool_choice is not supported" } : { toolCalls: [{ name: context.tools.length === 1 ? context.tools[0]! : "lookup", arguments: {} }] };
    const { result, requests, executed } = await run(picky, { maxSteps: 2, stopOn: "submit", toolChoice: (_step, last) => last ? { name: "submit" } : "required" });
    expect(requests).toEqual([
      { choice: "required", tools: ["lookup", "submit"] }, { choice: "auto", tools: ["lookup", "submit"] },
      { choice: { type: "function", function: { name: "submit" } }, tools: ["submit"] }, { choice: "auto", tools: ["submit"] }
    ]);
    expect(executed.map((call) => call.name)).toEqual(["lookup", "submit"]);
    expect(result.status).toBe("stop");

    const flagged = await run(picky, { maxSteps: 2, stopOn: "submit", required: false, named: false, toolChoice: (_step, last) => last ? { name: "submit" } : "required" });
    expect(flagged.requests).toEqual([{ choice: "auto", tools: ["lookup", "submit"] }, { choice: "auto", tools: ["submit"] }]);
    expect(toolChoiceFor({ ...DEFAULT_COMPAT, requiredToolChoice: false }, { name: "x" })).toEqual({ type: "function", function: { name: "x" } });
    expect(toolChoiceFor({ ...DEFAULT_COMPAT, namedToolChoice: false }, { name: "x" })).toBe("required");
    expect(toolChoiceFor(DEFAULT_COMPAT, "auto")).toBe("auto");
  });
});

describe("finalTool: runs that must end with one tool (2026-10-14)", () => {
  test("chat runs (no finalTool) end on a text answer exactly as before", async () => {
    const { result, requests } = await run(() => ({ content: "Just text." }));
    expect(result).toMatchObject({ status: "stop", steps: 1, content: "Just text." });
    expect(result.nudges).toBeUndefined();
    expect(requests.length).toBe(1);
  });

  test("parseToolArguments tolerates fences, trailing commas, and JSON inside a string, and names what it cannot parse", async () => {
    const { parseToolArguments, jsonObjectFromText } = await import("../server/agents/loop");
    expect(parseToolArguments("```json\n{\"a\": [1, 2,],}\n```")).toEqual({ ok: true, value: { a: [1, 2] } });
    expect(parseToolArguments(JSON.stringify("{\"a\": \"x, ]\"}"))).toEqual({ ok: true, value: { a: "x, ]" } });
    expect(parseToolArguments("")).toEqual({ ok: true, value: {} });
    const bad = parseToolArguments("{\"a\": ");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error.length > 0).toBe(true);
    expect(jsonObjectFromText("Sure:\n```json\n{\"blocks\": []}\n```\nDone")).toEqual({ blocks: [] });
    expect(jsonObjectFromText("no json here")).toBeNull();
  });
});
