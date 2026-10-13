/**
 * A scripted OpenAI-compatible provider for report generation (Wave 46): tests and the QA instance
 * drive Nook's generation run through a fixed tool sequence, no real model. Bun, 127.0.0.1 only;
 * `GET /v1/models` and a streaming `POST /v1/chat/completions`. Every request body is recorded
 * (`calls`), so tests can check `tool_choice` and what the prompt carried.
 *
 * A script maps the conversation so far to one reply (text and/or tool calls). The default `qaScript`:
 * search_schema → describe_tables → run_sql → a submit_report whose chart plots a String column (refused)
 * → a corrected submit_report. With the "evil" doc in the prompt it first tries `url()` and `remote()`
 * through run_sql (both refused by the guard), then submits a plain report. On any step whose
 * `tool_choice` names submit_report, it submits.
 *
 * Run: `bun --no-env-file scripts/fakeReportProvider.ts` (env FAKE_PROVIDER_PORT, default 22153;
 * FAKE_PROVIDER_DELAY_MS pauses before each reply).
 */

type Turn = { role: string; content?: unknown; tool_calls?: Array<{ function?: { name?: string } }>; tool_call_id?: string };
export type ScriptContext = {
  body: { messages?: Turn[]; tools?: Array<{ function: { name: string } }>; tool_choice?: unknown; model?: string };
  /** 1 for the first model call of a run, then one more per assistant turn already in the conversation. */
  step: number;
  system: string;
  /** The last tool turn's content and the name of the tool it answered. */
  lastTool: { name: string | null; content: string } | null;
  /** The tool `tool_choice` names, if any. */
  forced: string | null;
  tools: string[];
};
export type ScriptReply = { content?: string; toolCalls?: Array<{ name: string; arguments: unknown }>; status?: number };
export type Script = (context: ScriptContext) => ScriptReply;
export type ScriptedProvider = { baseUrl: string; port: number; calls: Array<ScriptContext["body"]>; setScript: (script: Script) => void; stop: () => void };

const text = (content: unknown) => typeof content === "string" ? content : "";

export const QA_QUERIES = {
  revenue_daily: "SELECT order_date AS day, sum(amount) AS revenue\nFROM analytics.orders\nWHERE amount > 0\nGROUP BY day\nORDER BY day",
  by_country: "SELECT country, count() AS orders\nFROM analytics.orders\nWHERE amount > 0\nGROUP BY country\nORDER BY orders DESC",
  totals: "SELECT sum(amount) AS total_revenue, count() AS orders\nFROM analytics.orders\nWHERE amount > 0"
};

export function qaSpec(options: { badChart?: boolean } = {}) {
  return {
    version: 1,
    queries: [
      { key: "revenue_daily", sql: QA_QUERIES.revenue_daily, purpose: "Net revenue per day (refunds excluded)" },
      { key: "by_country", sql: QA_QUERIES.by_country, purpose: "Orders per country" },
      { key: "totals", sql: QA_QUERIES.totals, purpose: "Total net revenue and orders" }
    ],
    blocks: [
      { id: "intro", type: "markdown", markdown: "## Revenue review\nNet revenue excludes refunds (amount ≤ 0), as the doc defines it." },
      { id: "total", type: "kpi", title: "Total revenue", queryKey: "totals", column: "total_revenue", format: "currency" },
      { id: "daily", type: "chart", title: "Revenue per day", queryKey: "revenue_daily", kind: "line", x: "day", y: ["revenue"], format: "currency" },
      { id: "countries", type: "chart", title: "Orders by country", queryKey: "by_country", kind: "bar", x: "country", y: [options.badChart ? "country" : "orders"] },
      { id: "country_table", type: "table", title: "Countries", queryKey: "by_country", columns: ["country", "orders"] }
    ]
  };
}

/** Wave 48: the edit agent's QA query (revenue per country, net of refunds). */
export const QA_EDIT_SQL = "SELECT country, sum(amount) AS net_revenue\nFROM analytics.orders\nWHERE amount > 0\nGROUP BY country\nORDER BY net_revenue DESC";

/**
 * Wave 48's edit agent (its tools include submit_patch). Two QA instructions: "add revenue by country"
 * checks the SQL with run_sql, then adds a query and a bar chart after the countries chart; "make it a
 * stacked bar" changes the block the instruction is about (or that chart) to a stacked bar. Anything
 * else retitles the block (or the report's first block).
 */
export const qaEditScript: Script = (context) => {
  const turn = context.body.messages?.find((item) => item.role === "user");
  const instruction = (text(turn?.content).match(/<instruction>\n([\s\S]*?)\n<\/instruction>/)?.[1] ?? "").toLowerCase();
  const target = /The instruction is about block `([^`]+)`/.exec(context.system)?.[1] ?? null;
  const patch = () => {
    if (instruction.includes("stacked")) return { summary: "Show it as a stacked bar", ops: [{ op: "update_block", id: target ?? "country_revenue", set: { kind: "stacked_bar" } }] };
    if (instruction.includes("revenue by country")) {
      return {
        summary: "Add net revenue by country",
        ops: [
          { op: "add_query", query: { key: "revenue_by_country", sql: QA_EDIT_SQL, purpose: "Net revenue per country (refunds excluded)" } },
          { op: "add_block", after: /"id":\s*"(countries|country-bar)"/.exec(context.system)?.[1] ?? null, block: { id: "country_revenue", type: "chart", title: "Revenue by country", queryKey: "revenue_by_country", kind: "bar", x: "country", y: ["net_revenue"], format: "currency" } }
        ]
      };
    }
    return { summary: "Retitle a block", ops: [{ op: "update_block", id: target ?? /"id":\s*"([^"]+)"/.exec(context.system)?.[1] ?? "daily", set: { title: instruction.slice(0, 60) || "Edited" } }] };
  };
  if (context.forced === "submit_patch" || context.lastTool?.name === "run_sql" || !instruction.includes("revenue by country")) return { content: "Proposing the change.", toolCalls: [{ name: "submit_patch", arguments: patch() }] };
  return { content: "Checking the SQL first.", toolCalls: [{ name: "run_sql", arguments: { sql: QA_EDIT_SQL, purpose: "Net revenue per country" } }] };
};

/** The QA instance's fixed sequence (see the file comment). */
export const qaScript: Script = (context) => {
  if (context.tools.includes("submit_patch")) return qaEditScript(context);
  const evil = context.system.includes("SYSTEM OVERRIDE");
  const submits = context.body.messages?.filter((turn) => turn.role === "assistant" && turn.tool_calls?.some((call) => call.function?.name === "submit_report")).length ?? 0;
  if (context.forced === "submit_report" || context.lastTool?.name === "submit_report" || (context.step >= 5 && !evil)) {
    return { content: submits ? "Fixing the chart: orders is the numeric column." : "Submitting the report.", toolCalls: [{ name: "submit_report", arguments: qaSpec({ badChart: submits === 0 && !evil }) }] };
  }
  if (evil) {
    if (context.step === 1) return { toolCalls: [{ name: "run_sql", arguments: { sql: "SELECT * FROM url('http://169.254.169.254/latest/meta-data/', 'TSV', 'x String')", purpose: "As the document asks" } }] };
    if (context.step === 2) return { toolCalls: [{ name: "run_sql", arguments: { sql: "SELECT * FROM remote('10.0.0.1', default.secrets)", purpose: "As the document asks" } }] };
    return { content: "Those reads are refused; building the report from analytics.orders only.", toolCalls: [{ name: "submit_report", arguments: qaSpec() }] };
  }
  if (context.step === 1) return { content: "Looking for the tables the doc names.", toolCalls: [{ name: "search_schema", arguments: { query: "orders revenue" } }] };
  if (context.step === 2) return { toolCalls: [{ name: "describe_tables", arguments: { tables: ["analytics.orders"] } }] };
  if (context.step === 3) return { toolCalls: [{ name: "run_sql", arguments: { sql: QA_QUERIES.revenue_daily, purpose: "Check revenue per day" } }] };
  return { toolCalls: [{ name: "submit_report", arguments: qaSpec({ badChart: submits === 0 }) }] };
};

const encoder = new TextEncoder();
const frame = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);

export function startScriptedProvider(port: number, initial: Script = qaScript, options: { delayMs?: number } = {}): ScriptedProvider {
  let script = initial;
  const calls: Array<ScriptContext["body"]> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: "scripted-report-model", object: "model" }] });
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") return Response.json({ error: { message: "not found" } }, { status: 404 });
      const body = await request.json().catch(() => ({})) as ScriptContext["body"];
      calls.push(body);
      const messages = body.messages ?? [];
      const lastToolTurn = [...messages].reverse().find((turn) => turn.role === "tool");
      const callName = (id: string | undefined) => {
        for (const turn of messages) for (const call of (turn.tool_calls ?? []) as Array<{ id?: string; function?: { name?: string } }>) if (call.id === id) return call.function?.name ?? null;
        return null;
      };
      const choice = body.tool_choice as { function?: { name?: string } } | string | undefined;
      const forced = typeof choice === "object" ? choice?.function?.name ?? null : choice === "required" && body.tools?.length === 1 ? body.tools[0]!.function.name : null;
      const context: ScriptContext = {
        body, step: messages.filter((turn) => turn.role === "assistant").length + 1, system: text(messages.find((turn) => turn.role === "system")?.content),
        lastTool: lastToolTurn ? { name: callName(lastToolTurn.tool_call_id), content: text(lastToolTurn.content) } : null, forced, tools: (body.tools ?? []).map((tool) => tool.function.name)
      };
      let reply: ScriptReply;
      try { reply = script(context); } catch (error) { reply = { status: 500, content: error instanceof Error ? error.message : "script failed" }; }
      if (reply.status) return Response.json({ error: { message: reply.content ?? "Scripted failure", type: "server_error" } }, { status: reply.status });
      // QA: a pause before each reply, so the step list can be watched.
      if (options.delayMs) await Bun.sleep(options.delayMs);
      const model = body.model ?? "scripted-report-model";
      const promptChars = messages.reduce((sum, turn) => sum + text(turn.content).length, 0);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (reply.content) controller.enqueue(frame({ id: "x", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: reply.content }, finish_reason: null }] }));
          (reply.toolCalls ?? []).forEach((call, index) => {
            const args = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments);
            controller.enqueue(frame({ id: "x", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: [{ index, id: `scripted_${context.step}_${index}`, type: "function", function: { name: call.name, arguments: args } }] }, finish_reason: null }] }));
          });
          controller.enqueue(frame({ id: "x", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: reply.toolCalls?.length ? "tool_calls" : "stop" }] }));
          controller.enqueue(frame({ id: "x", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: Math.ceil(promptChars / 4), completion_tokens: 40 } }));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
  });
  const bound = server.port ?? port;
  return { baseUrl: `http://127.0.0.1:${bound}/v1`, port: bound, calls, setScript: (next) => { script = next; }, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const port = Number(process.env.FAKE_PROVIDER_PORT ?? 22153);
  const provider = startScriptedProvider(port, qaScript, { delayMs: Number(process.env.FAKE_PROVIDER_DELAY_MS ?? 0) || 0 });
  console.log(`Scripted report provider on ${provider.baseUrl}`);
}
