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
 * Wave 48b: `showcaseScript` builds a report that exercises the theme (a KPI strip with deltas, a hero
 * with a sparkline, a two-series trend, a sorted bar of 24 categories that Nook folds, a share pie,
 * emphasis, sections with half and third widths), its first submit refused by a design rule. Tool-choice
 * modes reject `tool_choice: "required"` or a named choice with a 400, like providers that lack them
 * (`rejectRequired`, `rejectNamed`; env FAKE_PROVIDER_TOOL_CHOICE=no-required|no-named|none).
 *
 * Run: `bun --no-env-file scripts/fakeReportProvider.ts` (env FAKE_PROVIDER_PORT, default 22153;
 * FAKE_PROVIDER_DELAY_MS pauses before each reply; FAKE_PROVIDER_SCRIPT=showcase for the showcase).
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
    specVersion: 2,
    queries: [
      { key: "revenue_daily", sql: QA_QUERIES.revenue_daily, purpose: "Net revenue per day (refunds excluded)" },
      { key: "by_country", sql: QA_QUERIES.by_country, purpose: "Orders per country" },
      { key: "totals", sql: QA_QUERIES.totals, purpose: "Total net revenue and orders" }
    ],
    blocks: [
      { id: "intro", type: "markdown", markdown: "## Revenue review\nNet revenue excludes refunds (amount ≤ 0), as the doc defines it." },
      { id: "total", type: "kpi", title: "Total revenue", intent: "headline", queryKey: "totals", column: "total_revenue", format: "currency:USD" },
      { id: "daily", type: "chart", title: "Revenue per day", intent: "trend", width: "full", queryKey: "revenue_daily", kind: "line", x: "day", y: ["revenue"], format: "currency:USD" },
      { id: "countries", type: "chart", title: "Orders by country", intent: "compare", width: "half", queryKey: "by_country", kind: "bar", x: "country", y: [options.badChart ? "country" : "orders"], format: "number", unit: "orders" },
      { id: "country_table", type: "table", title: "Countries", intent: "detail", width: "half", queryKey: "by_country", columns: ["country", "orders"] }
    ]
  };
}

/** Wave 48b showcase queries (the QA instance's fake ClickHouse answers each by its marker column). */
export const SHOWCASE_QUERIES = {
  kpis: "SELECT sum(amount) AS revenue, sumIf(amount, order_date < today() - 14) AS revenue_prev, count() AS orders, countIf(order_date < today() - 14) AS orders_prev,\n  avg(amount < 0) AS refund_rate, avgIf(amount < 0, order_date < today() - 14) AS refund_rate_prev\nFROM analytics.orders",
  revenue_trend: "SELECT order_date AS day, sumIf(amount, channel = 'web') AS web, sumIf(amount, channel = 'app') AS app\nFROM analytics.orders\nWHERE amount > 0\nGROUP BY day\nORDER BY day",
  orders_by_country: "SELECT country, count() AS country_orders\nFROM analytics.orders\nWHERE amount > 0\nGROUP BY country",
  plan_mix: "SELECT plan, count() AS accounts\nFROM analytics.signups\nGROUP BY plan",
  channel_orders: "SELECT channel, count() AS channel_orders\nFROM analytics.orders\nGROUP BY channel",
  aov_daily: "SELECT order_date AS day, avg(amount) AS aov\nFROM analytics.orders\nWHERE amount > 0\nGROUP BY day\nORDER BY day",
  refunds_daily: "SELECT order_date AS day, -sum(amount) AS refunds\nFROM analytics.orders\nWHERE amount < 0\nGROUP BY day\nORDER BY day",
  recent: "SELECT order_id, order_date, country, channel, amount AS recent_amount\nFROM analytics.orders\nORDER BY order_date DESC, order_id DESC\nLIMIT 50"
};

/** The showcase spec (wave 48b); `bad` breaks design rules 2 and 8 (a 24-slice pie, a chart without a title). */
export function showcaseSpec(options: { bad?: boolean } = {}) {
  const queries = Object.entries(SHOWCASE_QUERIES).map(([key, sql]) => ({ key, sql, purpose: {
    kpis: "Revenue, orders, and refund rate, now and two weeks ago", revenue_trend: "Net revenue per day by channel", orders_by_country: "Orders per country",
    plan_mix: "Signups per plan", channel_orders: "Orders per channel", aov_daily: "Average order value per day", refunds_daily: "Refunds per day", recent: "The latest orders"
  }[key]! }));
  return {
    version: 1,
    specVersion: 2,
    sections: [
      { id: "trend", title: "Revenue over time", summary: "Web and app revenue per day; the app has grown faster since the redesign." },
      { id: "mix", title: "Where orders come from" },
      { id: "detail", title: "Order detail" }
    ],
    queries,
    blocks: [
      { id: "intro", type: "markdown", markdown: "Net revenue excludes refunds, as the metrics doc defines it. Figures compare the last two weeks with the two before." },
      { id: "revenue", type: "kpi", title: "Net revenue", intent: "headline", queryKey: "kpis", column: "revenue", format: "currency:USD", compareTo: { column: "revenue_prev" }, compareLabel: "vs prior 2 weeks", hero: true, sparkline: { queryKey: "revenue_trend", x: "day", y: "web" } },
      { id: "orders", type: "kpi", title: "Orders", intent: "delta", queryKey: "kpis", column: "orders", format: "number", unit: "orders", compareTo: { column: "orders_prev" }, compareLabel: "vs prior 2 weeks" },
      { id: "refund_rate", type: "kpi", title: "Refund rate", intent: "delta", queryKey: "kpis", column: "refund_rate", format: "percent", compareTo: { column: "refund_rate_prev" }, compareLabel: "vs prior 2 weeks", upIsGood: false },
      { id: "trend", type: "chart", title: "Revenue per day by channel", intent: "trend", width: "full", section: "trend", queryKey: "revenue_trend", kind: "line", x: "day", y: ["web", "app"], format: "currency:USD" },
      options.bad
        ? { id: "countries", type: "chart", intent: "share", width: "half", section: "mix", queryKey: "orders_by_country", kind: "pie", x: "country", y: ["country_orders"], format: "number" }
        : { id: "countries", type: "chart", title: "Orders by country", intent: "rank", width: "half", section: "mix", queryKey: "orders_by_country", kind: "horizontal_bar", x: "country", y: ["country_orders"], format: "number", unit: "orders" },
      { id: "plans", type: "chart", title: "Signups by plan", intent: "share", width: "half", section: "mix", queryKey: "plan_mix", kind: "pie", x: "plan", y: ["accounts"], format: "number", unit: "accounts" },
      { id: "channels", type: "chart", title: "Orders by channel", intent: "compare", width: "third", section: "detail", queryKey: "channel_orders", kind: "bar", x: "channel", y: ["channel_orders"], format: "number", unit: "orders", emphasis: "app" },
      { id: "aov", type: "chart", title: "Average order value", intent: "trend", width: "third", section: "detail", queryKey: "aov_daily", kind: "line", x: "day", y: ["aov"], format: "currency:USD" },
      { id: "refunds", type: "chart", title: "Refunds per day", intent: "trend", width: "third", section: "detail", queryKey: "refunds_daily", kind: "area", x: "day", y: ["refunds"], format: "currency:USD" },
      { id: "recent", type: "table", title: "Latest orders", intent: "detail", width: "full", section: "detail", queryKey: "recent", formats: { recent_amount: "currency:USD" } }
    ]
  };
}

/** Settings → AI "Test tool calling" (wave 48b): the scripts answer its probe with a call to the probe tool. */
const PROBE_TOOL = "nook_probe";
const probeReply: ScriptReply = { toolCalls: [{ name: PROBE_TOOL, arguments: { ok: true } }] };

/** The showcase sequence: search, describe, one run_sql, a submit refused by design rules 2 and 8, then the fixed spec. */
export const showcaseScript: Script = (context) => {
  if (context.tools.includes(PROBE_TOOL)) return probeReply;
  if (context.tools.includes("submit_patch")) return qaEditScript(context);
  const submits = context.body.messages?.filter((turn) => turn.role === "assistant" && turn.tool_calls?.some((call) => call.function?.name === "submit_report")).length ?? 0;
  if (context.forced === "submit_report" || context.lastTool?.name === "submit_report" || context.step >= 4) {
    return { content: submits ? "Fixing the design: a ranked bar for 24 countries, and a title." : "Submitting the report.", toolCalls: [{ name: "submit_report", arguments: showcaseSpec({ bad: submits === 0 }) }] };
  }
  if (context.step === 1) return { content: "Looking for the tables the doc names.", toolCalls: [{ name: "search_schema", arguments: { query: "orders revenue channel" } }] };
  if (context.step === 2) return { toolCalls: [{ name: "describe_tables", arguments: { tables: ["analytics.orders", "analytics.signups"] } }] };
  return { toolCalls: [{ name: "run_sql", arguments: { sql: SHOWCASE_QUERIES.revenue_trend, purpose: "Check revenue per day by channel" } }] };
};

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
          { op: "add_block", after: /"id":\s*"(countries|country-bar)"/.exec(context.system)?.[1] ?? null, block: { id: "country_revenue", type: "chart", title: "Revenue by country", queryKey: "revenue_by_country", kind: "bar", x: "country", y: ["net_revenue"], format: "currency:USD" } }
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
  if (context.tools.includes(PROBE_TOOL)) return probeReply;
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

export type ToolChoiceMode = { rejectRequired?: boolean; rejectNamed?: boolean };

export function startScriptedProvider(port: number, initial: Script = qaScript, options: { delayMs?: number } & ToolChoiceMode = {}): ScriptedProvider {
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
      // Wave 48b: providers that lack `required` or a named choice answer 400, as some do.
      if (options.rejectRequired && choice === "required") return Response.json({ error: { message: "tool_choice 'required' is not supported", type: "invalid_request_error" } }, { status: 400 });
      if (options.rejectNamed && typeof choice === "object" && choice !== null) return Response.json({ error: { message: "tool_choice must be 'auto' or 'none'", type: "invalid_request_error" } }, { status: 400 });
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
  const mode = process.env.FAKE_PROVIDER_TOOL_CHOICE ?? "";
  const provider = startScriptedProvider(port, process.env.FAKE_PROVIDER_SCRIPT === "showcase" ? showcaseScript : qaScript, {
    delayMs: Number(process.env.FAKE_PROVIDER_DELAY_MS ?? 0) || 0,
    rejectRequired: mode === "no-required" || mode === "none", rejectNamed: mode === "no-named" || mode === "none"
  });
  console.log(`Scripted report provider on ${provider.baseUrl}`);
}
