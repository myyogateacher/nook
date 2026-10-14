import { unplanned, type Script, type ScriptContext } from "../../scripts/fakeReportProvider";
import type { EvalSpec } from "./types";

/**
 * The scripted provider's run for a case (the deterministic CI subset and `--provider scripted`):
 * plan one todo per data block, run each query with its key, mark the todos done, and submit the spec
 * (the golden one or the trap). A refused submit is resubmitted unchanged, so a refusal shows up as
 * retries and a failed run rather than being fixed by the script.
 */

const calledTools = (context: ScriptContext) => (context.body.messages ?? []).flatMap((turn) => turn.role === "assistant" ? (turn.tool_calls ?? []).map((call) => call.function?.name ?? "") : []);

export function todosOf(spec: EvalSpec) {
  return spec.blocks.filter((block) => block.type !== "markdown").map((block) => ({
    id: String(block.id), title: String(block.title ?? block.id), kind: String(block.type), metric: String(block.title ?? block.id),
    ...(typeof block.intent === "string" ? { intent: block.intent } : {}), ...(typeof block.section === "string" ? { section: block.section } : {})
  }));
}

export function specScript(spec: EvalSpec, catalog: Array<Record<string, unknown>> = []): Script {
  const todos = todosOf(spec);
  const submit = { name: "submit_report", arguments: { title: spec.title, ...(spec.sections ? { sections: spec.sections } : {}), queries: spec.queries, blocks: spec.blocks } };
  const script: Script = unplanned((context) => {
    if (context.tools.includes("nook_probe")) return { toolCalls: [{ name: "nook_probe", arguments: { ok: true } }] };
    const called = calledTools(context);
    if (context.forced === "submit_report") return { toolCalls: [submit] };
    if (!called.includes("plan_report")) {
      return { toolCalls: [{ name: "plan_report", arguments: { goal: `Answer the document: ${spec.title}`, ...(spec.sections ? { sections: spec.sections } : {}), todos } }] };
    }
    const ran = called.filter((name) => name === "run_sql").length;
    const query = spec.queries[ran];
    if (query) return { toolCalls: [{ name: "run_sql", arguments: { sql: query.sql, key: query.key, purpose: query.purpose } }] };
    const updated = called.filter((name) => name === "update_todo").length;
    if (updated < todos.length) {
      return {
        toolCalls: todos.slice(updated, updated + 6).map((todo) => {
          const block = spec.blocks.find((item) => item.id === todo.id)!;
          return { name: "update_todo", arguments: { id: todo.id, status: "done", queryKey: block.queryKey, blockId: todo.id } };
        })
      };
    }
    return { toolCalls: [submit] };
  });
  // The metric extraction (E4) records the case's catalog.
  return Object.assign(script, { metrics: catalog });
}
