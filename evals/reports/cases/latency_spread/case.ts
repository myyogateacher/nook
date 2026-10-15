import type { EvalCase } from "../../types";

export default {
  id: "latency_spread",
  title: "Response times drawn as a distribution",
  traps: ["health checks pull the percentile down", "an average per route hides the slow tail"],
  facts: [
    { id: "p95", label: "p95 response time", kind: "number", value: 391, tolerance: 0 },
    { id: "requests", label: "Requests", kind: "number", value: 900, tolerance: 0 },
    { id: "spread_kind", label: "Durations are drawn as a histogram or box plot", kind: "chart", value: ["histogram", "boxplot"] }
  ],
  golden: {
    title: "API response times, September 2026",
    queries: [
      { key: "durations", sql: "SELECT duration_ms\nFROM eval_latency_spread.requests\nWHERE route != 'healthz'", purpose: "Every request's duration" },
      { key: "summary", sql: "SELECT quantileExact(0.95)(duration_ms) AS p95_ms, count() AS requests\nFROM eval_latency_spread.requests\nWHERE route != 'healthz'", purpose: "p95 and requests" }
    ],
    blocks: [
      { id: "p95", type: "kpi", title: "p95 response time", intent: "headline", queryKey: "summary", column: "p95_ms", unit: "ms" },
      { id: "requests", type: "kpi", title: "Requests", intent: "headline", queryKey: "summary", column: "requests", format: "number", unit: "requests" },
      { id: "spread", type: "chart", title: "How response times spread", intent: "distribution", width: "full", queryKey: "durations", kind: "histogram", y: ["duration_ms"], unit: "ms" }
    ]
  },
  trap: {
    fails: ["p95", "requests", "spread_kind"],
    spec: {
      title: "API response times, September 2026",
      queries: [
        { key: "routes", sql: "SELECT route, avg(duration_ms) AS avg_ms\nFROM eval_latency_spread.requests\nGROUP BY route\nORDER BY avg_ms DESC", purpose: "Average duration per route" },
        { key: "summary", sql: "SELECT quantileExact(0.95)(duration_ms) AS p95_ms, count() AS requests\nFROM eval_latency_spread.requests", purpose: "p95 and requests" }
      ],
      blocks: [
        { id: "p95", type: "kpi", title: "p95 response time", intent: "headline", queryKey: "summary", column: "p95_ms", unit: "ms" },
        { id: "requests", type: "kpi", title: "Requests", intent: "headline", queryKey: "summary", column: "requests", format: "number", unit: "requests" },
        { id: "spread", type: "chart", title: "Average response time by route", intent: "compare", queryKey: "routes", kind: "bar", x: "route", y: ["avg_ms"], unit: "ms" }
      ]
    }
  }
} satisfies EvalCase;
