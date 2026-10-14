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
 * Chart kinds round 2: `showcase2Script` builds one report with every new kind (heatmap, calendar,
 * small multiples, funnel, gauge, bullet, treemap, a 100 % stacked bar, sankey, boxplot, histogram,
 * waterfall, a percent-stacked area, combo); its first submit is refused by rules 11 and 21.
 * `showcase2Answer(sql)` is what a fake ClickHouse answers to its queries.
 *
 * Run: `bun --no-env-file scripts/fakeReportProvider.ts` (env FAKE_PROVIDER_PORT, default 22153;
 * FAKE_PROVIDER_DELAY_MS pauses before each reply; FAKE_PROVIDER_SCRIPT=showcase or showcase-2).
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

/**
 * Chart kinds round 2 (D462–D468): the showcase-2 queries, one report that uses every new kind. The QA
 * instance's fake ClickHouse answers each by its marker column (`showcase2Answer`).
 */
export const SHOWCASE2_QUERIES = {
  retention: "SELECT toStartOfMonth(first_order) AS cohort_month, dateDiff('month', first_order, order_date) AS months_since,\n  uniq(customer_id) / any(cohort_size) AS retention\nFROM analytics.cohorts\nGROUP BY cohort_month, months_since\nORDER BY cohort_month, months_since",
  country_daily: "SELECT order_date AS facet_day, country AS facet_country, count() AS facet_orders\nFROM analytics.orders\nWHERE order_date >= today() - 180\nGROUP BY facet_day, facet_country\nORDER BY facet_day",
  signup_funnel: "SELECT stage AS funnel_stage, uniq(visitor_id) AS funnel_users\nFROM analytics.funnel_events\nGROUP BY stage, stage_order\nORDER BY stage_order",
  quota: "SELECT sum(amount) AS quota_attained, any(quarter_target) AS quota_target\nFROM analytics.orders\nWHERE order_date >= toStartOfQuarter(today())",
  revenue_mix: "SELECT region AS mix_region, product AS mix_product, sum(amount) AS mix_revenue\nFROM analytics.orders\nGROUP BY mix_region, mix_product",
  page_flow: "SELECT from_page AS flow_from, to_page AS flow_to, count() AS flow_visits\nFROM analytics.page_transitions\nGROUP BY flow_from, flow_to",
  latency: "SELECT plan AS latency_plan, duration_ms AS latency_ms\nFROM analytics.requests\nWHERE event_date = yesterday()\nLIMIT 600",
  order_values: "SELECT amount AS order_value\nFROM analytics.orders\nWHERE amount > 0 AND order_date >= today() - 30\nLIMIT 2000",
  revenue_bridge: "SELECT step AS bridge_step, delta AS bridge_delta\nFROM analytics.revenue_bridge\nORDER BY step_order",
  channel_daily: "SELECT order_date AS share_day, channel AS share_channel, count() AS share_orders\nFROM analytics.orders\nWHERE order_date >= today() - 56\nGROUP BY share_day, share_channel\nORDER BY share_day",
  revenue_cost: "SELECT toStartOfMonth(order_date) AS combo_month, sum(amount) AS combo_revenue, sum(cost) AS combo_cost\nFROM analytics.orders\nGROUP BY combo_month\nORDER BY combo_month",
  team_targets: "SELECT team AS bullet_team, sum(amount) AS bullet_actual, any(target) AS bullet_target, any(floor_poor) AS bullet_poor, any(floor_fair) AS bullet_fair, any(floor_good) AS bullet_good\nFROM analytics.team_sales\nGROUP BY team"
};

const SHOWCASE2_PURPOSES: Record<keyof typeof SHOWCASE2_QUERIES, string> = {
  retention: "Monthly cohort retention", country_daily: "Orders per day and country, last 180 days", signup_funnel: "Visitors at each signup step", quota: "Quarter revenue against its target",
  revenue_mix: "Revenue by region and product", page_flow: "Page-to-page transitions", latency: "Request durations by plan", order_values: "Order values, last 30 days",
  revenue_bridge: "From last quarter's revenue to this quarter's", channel_daily: "Orders per day and channel, last 8 weeks", revenue_cost: "Revenue and cost per month", team_targets: "Team sales against target and bands"
};

/** The showcase-2 spec: every round-2 kind once. `bad` breaks rules 11 (a funnel as a compare) and 21 (a combo of two units). */
export function showcase2Spec(options: { bad?: boolean } = {}) {
  return {
    version: 1,
    specVersion: 2,
    sections: [
      { id: "retention", title: "Retention and activity", summary: "Each cohort keeps about 40% of its customers by month six; weekday activity is steady." },
      { id: "conversion", title: "Conversion and targets" },
      { id: "mix", title: "Mix and flow" },
      { id: "spread", title: "Distributions" },
      { id: "change", title: "Change and composition" }
    ],
    queries: Object.entries(SHOWCASE2_QUERIES).map(([key, sql]) => ({ key, sql, purpose: SHOWCASE2_PURPOSES[key as keyof typeof SHOWCASE2_QUERIES] })),
    blocks: [
      { id: "intro", type: "markdown", markdown: "Every chart kind of round 2 in one report: cohorts, a calendar, a funnel, a meter, a treemap, a sankey, a box plot, a histogram, a waterfall, stacked shares, small multiples, a combo, and bullets." },
      { id: "retention", type: "chart", title: "Cohort retention", intent: "matrix", width: "full", section: "retention", queryKey: "retention", kind: "heatmap", x: "months_since", x2: "cohort_month", y: ["retention"], cohort: true, format: "percent" },
      { id: "activity", type: "chart", title: "Orders per day", intent: "trend", width: "full", section: "retention", queryKey: "country_daily", kind: "calendar", x: "facet_day", y: ["facet_orders"], unit: "orders" },
      { id: "countries", type: "chart", title: "Orders per day by country", intent: "trend", width: "full", section: "retention", queryKey: "country_daily", kind: "line", x: "facet_day", y: ["facet_orders"], facet: "facet_country", unit: "orders" },
      { id: "funnel", type: "chart", title: "Signup funnel", intent: options.bad ? "compare" : "conversion", width: "half", section: "conversion", queryKey: "signup_funnel", kind: "funnel", x: "funnel_stage", y: ["funnel_users"], unit: "visitors" },
      { id: "quota", type: "chart", title: "Quarter revenue vs target", intent: "attainment", width: "half", section: "conversion", queryKey: "quota", kind: "gauge", y: ["quota_attained"], target: "quota_target", format: "currency:USD" },
      { id: "teams", type: "chart", title: "Team sales vs target", intent: "attainment", width: "full", section: "conversion", queryKey: "team_targets", kind: "bullet", x: "bullet_team", y: ["bullet_actual"], target: "bullet_target", ranges: ["bullet_poor", "bullet_fair", "bullet_good"], format: "currency:USD" },
      { id: "mix_tree", type: "chart", title: "Revenue by region and product", intent: "share", width: "half", section: "mix", queryKey: "revenue_mix", kind: "treemap", x: "mix_region", x2: "mix_product", y: ["mix_revenue"], format: "currency:USD" },
      { id: "mix_share", type: "chart", title: "Product share by region", intent: "share", width: "half", section: "mix", queryKey: "revenue_mix", kind: "bar", x: "mix_region", y: ["mix_revenue"], series: "mix_product", stack: "percent", format: "currency:USD" },
      { id: "flow", type: "chart", title: "How visitors move through the site", intent: "flow", width: "full", section: "mix", queryKey: "page_flow", kind: "sankey", x: "flow_from", x2: "flow_to", y: ["flow_visits"], unit: "visits" },
      { id: "latency", type: "chart", title: "Request time by plan", intent: "distribution", width: "half", section: "spread", queryKey: "latency", kind: "boxplot", x: "latency_plan", y: ["latency_ms"], unit: "ms" },
      { id: "values", type: "chart", title: "Order values", intent: "distribution", width: "half", section: "spread", queryKey: "order_values", kind: "histogram", y: ["order_value"], format: "currency:USD" },
      { id: "bridge", type: "chart", title: "Revenue bridge, last quarter to this", intent: "delta", width: "half", section: "change", queryKey: "revenue_bridge", kind: "waterfall", x: "bridge_step", y: ["bridge_delta"], start: true, total: true, format: "currency:USD" },
      { id: "channels", type: "chart", title: "Channel share of orders", intent: "share", width: "half", section: "change", queryKey: "channel_daily", kind: "area", x: "share_day", y: ["share_orders"], series: "share_channel", stack: "percent", unit: "orders" },
      { id: "margin", type: "chart", title: "Revenue and cost per month", intent: "trend", width: "full", section: "change", queryKey: "revenue_cost", kind: "combo", x: "combo_month", y: ["combo_revenue", "combo_cost"], yUnits: options.bad ? ["USD", "orders"] : ["USD", "USD"], format: "currency:USD" }
    ]
  };
}

const iso = (time: number) => new Date(time).toISOString().slice(0, 10);
const DAY = 86_400_000;

/** The fake ClickHouse's answers to the showcase-2 queries (deterministic; numbers as JSONCompact sends them). Null for any other statement. */
export function showcase2Answer(sql: string, today = Date.UTC(2026, 9, 14)): { meta: Array<{ name: string; type: string }>; data: unknown[][]; rowsRead: number } | null {
  const answer = (meta: Array<[string, string]>, data: unknown[][]) => ({ meta: meta.map(([name, type]) => ({ name, type })), data, rowsRead: 250_000 });
  if (sql.includes("months_since")) {
    const cohorts = Array.from({ length: 10 }, (_, at) => `2026-${String(at + 1).padStart(2, "0")}-01`);
    return answer([["cohort_month", "Date"], ["months_since", "Int64"], ["retention", "Float64"]], cohorts.flatMap((cohort, c) => Array.from({ length: 10 - c }, (_, month) => [cohort, String(month), month === 0 ? 1 : Math.round((0.58 * Math.exp(-month / 7) + 0.02 * ((c * 3 + month) % 4) / 4 + 0.01 * c) * 1000) / 1000])));
  }
  if (sql.includes("facet_country")) {
    const countries = ["US", "DE", "IN", "GB", "BR", "JP"];
    return answer([["facet_day", "Date"], ["facet_country", "LowCardinality(String)"], ["facet_orders", "UInt64"]], Array.from({ length: 180 }, (_, at) => iso(today - (180 - at) * DAY)).flatMap((day, at) => countries.map((country, c) => [day, country, String(Math.round((60 - c * 8) * (1 + 0.25 * Math.sin(at / 9 + c)) * ([0, 6].includes(new Date(day).getUTCDay()) ? 0.7 : 1) + at * (0.08 + c * 0.03)))])));
  }
  if (sql.includes("funnel_stage")) return answer([["funnel_stage", "String"], ["funnel_users", "UInt64"]], [["Visited pricing", "18400"], ["Started signup", "7350"], ["Verified email", "5120"], ["Created a project", "3010"], ["Invited a teammate", "1240"], ["Paid", "610"]]);
  if (sql.includes("quota_attained")) return answer([["quota_attained", "Decimal(18, 2)"], ["quota_target", "Decimal(18, 2)"]], [["842500.00", "1000000.00"]]);
  if (sql.includes("mix_region")) {
    const regions = ["North America", "Europe", "India", "Brazil", "Japan", "Australia", "Mexico", "Nordics", "Korea", "South Africa"];
    return answer([["mix_region", "LowCardinality(String)"], ["mix_product", "LowCardinality(String)"], ["mix_revenue", "Decimal(18, 2)"]], regions.flatMap((region, r) => ["Notes", "Boards", "Reports"].map((product, p) => [region, product, (Math.round(420_000 / (r + 1.4) * [0.5, 0.3, 0.2][p]! * (1 + 0.15 * ((r + p) % 3))) ).toFixed(2)])));
  }
  if (sql.includes("flow_from")) {
    const links: Array<[string, string, number]> = [["Home", "Pricing", 5200], ["Home", "Docs", 3100], ["Home", "Blog", 1800], ["Blog", "Pricing", 700], ["Blog", "Exit", 1100], ["Docs", "Signup", 900], ["Docs", "Exit", 2200], ["Pricing", "Signup", 2600], ["Pricing", "Exit", 3300], ["Signup", "Onboarding", 3100], ["Signup", "Abandoned", 400]];
    return answer([["flow_from", "String"], ["flow_to", "String"], ["flow_visits", "UInt64"]], links.map(([from, to, n]) => [from, to, String(n)]));
  }
  if (sql.includes("latency_ms")) return answer([["latency_plan", "LowCardinality(String)"], ["latency_ms", "Float64"]], ["Free", "Pro", "Team", "Enterprise"].flatMap((plan, p) => Array.from({ length: 150 }, (_, at) => [plan, Math.round((180 - p * 30 + ((at * 7919) % 160) - 60 + (at % 37 === 0 ? 700 - p * 100 : 0)) * 10) / 10])));
  if (sql.includes("order_value")) return answer([["order_value", "Decimal(18, 2)"]], Array.from({ length: 1200 }, (_, at) => [(18 + 60 * (((at * 7919) % 1000) / 1000) ** 2 + (at % 11 === 0 ? 140 : 0) + (at % 3) * 7).toFixed(2)]));
  if (sql.includes("bridge_step")) return answer([["bridge_step", "String"], ["bridge_delta", "Decimal(18, 2)"]], [["Q2 revenue", "1240000.00"], ["New customers", "286000.00"], ["Expansion", "142000.00"], ["Price change", "38000.00"], ["Contraction", "-74000.00"], ["Churn", "-161000.00"]]);
  if (sql.includes("share_channel")) return answer([["share_day", "Date"], ["share_channel", "LowCardinality(String)"], ["share_orders", "UInt64"]], Array.from({ length: 56 }, (_, at) => iso(today - (56 - at) * DAY)).flatMap((day, at) => [["Web", 520 - at * 3], ["App", 260 + at * 4], ["Partner", 110 + (at % 7) * 6]].map(([channel, n]) => [day, channel, String(n)])));
  if (sql.includes("combo_month")) return answer([["combo_month", "Date"], ["combo_revenue", "Decimal(18, 2)"], ["combo_cost", "Decimal(18, 2)"]], Array.from({ length: 10 }, (_, at) => [`2026-${String(at + 1).padStart(2, "0")}-01`, (310_000 + at * 21_000 + (at % 3) * 9_000).toFixed(2), (228_000 + at * 9_500).toFixed(2)]));
  if (sql.includes("bullet_team")) return answer([["bullet_team", "String"], ["bullet_actual", "Decimal(18, 2)"], ["bullet_target", "Decimal(18, 2)"], ["bullet_poor", "Decimal(18, 2)"], ["bullet_fair", "Decimal(18, 2)"], ["bullet_good", "Decimal(18, 2)"]],
    [["Enterprise", 412_000, 450_000], ["Mid-market", 298_000, 260_000], ["SMB", 154_000, 210_000], ["Partners", 96_000, 120_000], ["Self-serve", 188_000, 170_000]].map(([team, actual, target]) => [team, Number(actual).toFixed(2), Number(target).toFixed(2), (Number(target) * 0.6).toFixed(2), (Number(target) * 0.85).toFixed(2), (Number(target) * 1.15).toFixed(2)]));
  return null;
}

/** The showcase-2 sequence (FAKE_PROVIDER_SCRIPT=showcase-2): search, describe, one run_sql, a submit refused by rules 11 and 21, then the fixed spec. */
export const showcase2Script: Script = (context) => {
  if (context.tools.includes(PROBE_TOOL)) return probeReply;
  if (context.tools.includes("submit_patch")) return qaEditScript(context);
  const submits = context.body.messages?.filter((turn) => turn.role === "assistant" && turn.tool_calls?.some((call) => call.function?.name === "submit_report")).length ?? 0;
  if (context.forced === "submit_report" || context.lastTool?.name === "submit_report" || context.step >= 4) {
    return { content: submits ? "Fixing the design: the funnel's intent is conversion, and the combo's two measures share one unit." : "Submitting the report.", toolCalls: [{ name: "submit_report", arguments: showcase2Spec({ bad: submits === 0 }) }] };
  }
  if (context.step === 1) return { content: "Looking for the tables the doc names.", toolCalls: [{ name: "search_schema", arguments: { query: "orders cohorts funnel" } }] };
  if (context.step === 2) return { toolCalls: [{ name: "describe_tables", arguments: { tables: ["analytics.orders"] } }] };
  return { toolCalls: [{ name: "run_sql", arguments: { sql: SHOWCASE2_QUERIES.retention, purpose: "Check cohort retention" } }] };
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

/**
 * `toolsNeedEffort`: like some newer OpenAI models in Chat Completions, a request with tools is refused
 * (400) unless its reasoning_effort is one of these (env FAKE_PROVIDER_TOOLS_NEED_EFFORT=none,minimal).
 */
export type ToolChoiceMode = { rejectRequired?: boolean; rejectNamed?: boolean; toolsNeedEffort?: string[] };

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
      const body = await request.json().catch(() => ({})) as ScriptContext["body"] & { reasoning_effort?: string };
      calls.push(body);
      const messages = body.messages ?? [];
      const lastToolTurn = [...messages].reverse().find((turn) => turn.role === "tool");
      const callName = (id: string | undefined) => {
        for (const turn of messages) for (const call of (turn.tool_calls ?? []) as Array<{ id?: string; function?: { name?: string } }>) if (call.id === id) return call.function?.name ?? null;
        return null;
      };
      const choice = body.tool_choice as { function?: { name?: string } } | string | undefined;
      if (options.toolsNeedEffort && body.tools?.length && !options.toolsNeedEffort.includes(body.reasoning_effort ?? "")) {
        return Response.json({ error: { message: `Function tools with reasoning_effort are not supported for ${body.model ?? "this model"} in /v1/chat/completions. Please use /v1/responses instead.`, type: "invalid_request_error", param: "reasoning_effort" } }, { status: 400 });
      }
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
  const scripts: Record<string, Script> = { showcase: showcaseScript, "showcase-2": showcase2Script };
  const provider = startScriptedProvider(port, scripts[process.env.FAKE_PROVIDER_SCRIPT ?? ""] ?? qaScript, {
    delayMs: Number(process.env.FAKE_PROVIDER_DELAY_MS ?? 0) || 0,
    rejectRequired: mode === "no-required" || mode === "none", rejectNamed: mode === "no-named" || mode === "none",
    ...(process.env.FAKE_PROVIDER_TOOLS_NEED_EFFORT ? { toolsNeedEffort: process.env.FAKE_PROVIDER_TOOLS_NEED_EFFORT.split(",") } : {})
  });
  console.log(`Scripted report provider on ${provider.baseUrl}`);
}
