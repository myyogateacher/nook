import type { EvalCase } from "../../types";

export default {
  id: "top_routes",
  title: "Top route without health checks and errors",
  traps: ["health checks are the largest raw route", "an outage of 5xx requests inflates search"],
  ci: true,
  facts: [
    { id: "top_route", label: "Top route by served traffic", kind: "top", value: "digest" },
    { id: "digest_served", label: "Served requests on digest", kind: "number", value: 3904, tolerance: 0, row: "digest" },
    { id: "error_rate", label: "Server error rate", kind: "number", value: 0.14993, percent: true }
  ],
  golden: {
    title: "API traffic, September 2026",
    queries: [
      { key: "routes", sql: "SELECT route, countIf(status < 500) AS served\nFROM eval_top_routes.requests\nWHERE route NOT IN ('healthz', 'readyz')\nGROUP BY route\nORDER BY served DESC", purpose: "Served requests by route" },
      { key: "errors", sql: "SELECT countIf(status >= 500) / count() AS error_rate\nFROM eval_top_routes.requests\nWHERE route NOT IN ('healthz', 'readyz')", purpose: "Server error rate" }
    ],
    blocks: [
      { id: "errors", type: "kpi", title: "Server error rate", intent: "headline", queryKey: "errors", column: "error_rate", format: "percent", upIsGood: false },
      { id: "routes", type: "chart", title: "Served requests by route", intent: "rank", queryKey: "routes", kind: "horizontal_bar", x: "route", y: ["served"], format: "number", unit: "requests" }
    ]
  },
  trap: {
    fails: ["top_route", "digest_served"],
    spec: {
      title: "API traffic, September 2026",
      queries: [
        { key: "routes", sql: "SELECT route, count() AS served\nFROM eval_top_routes.requests\nWHERE route NOT IN ('healthz', 'readyz')\nGROUP BY route\nORDER BY served DESC", purpose: "Requests by route" },
        { key: "errors", sql: "SELECT countIf(status >= 500) / count() AS error_rate\nFROM eval_top_routes.requests\nWHERE route NOT IN ('healthz', 'readyz')", purpose: "Server error rate" }
      ],
      blocks: [
        { id: "errors", type: "kpi", title: "Server error rate", intent: "headline", queryKey: "errors", column: "error_rate", format: "percent", upIsGood: false },
        { id: "routes", type: "chart", title: "Requests by route", intent: "rank", queryKey: "routes", kind: "horizontal_bar", x: "route", y: ["served"], format: "number", unit: "requests" }
      ]
    }
  }
} satisfies EvalCase;
