import type { EvalCase } from "../../types";

export default {
  id: "tz_signups",
  title: "IST day boundaries",
  traps: ["toDate(created_at) groups by the UTC day; evening UTC signups belong to the next IST day"],
  ci: true,
  facts: [
    { id: "signups", label: "Signups in September (IST)", kind: "number", value: 1243, tolerance: 0.0005 },
    { id: "busiest_day", label: "Busiest IST day", kind: "top", value: "2026-09-15" },
    { id: "busiest_count", label: "Signups on 2026-09-15 (IST)", kind: "number", value: 89, tolerance: 0, row: "2026-09-15" }
  ],
  golden: {
    title: "Signups by day (IST)",
    queries: [
      { key: "total", sql: "SELECT count() AS signups\nFROM eval_tz_signups.signups\nWHERE toDate(created_at, 'Asia/Kolkata') BETWEEN '2026-09-01' AND '2026-09-30'", purpose: "Signups in September, IST" },
      { key: "daily", sql: "SELECT toDate(created_at, 'Asia/Kolkata') AS day, count() AS signups\nFROM eval_tz_signups.signups\nWHERE day BETWEEN '2026-09-01' AND '2026-09-30'\nGROUP BY day\nORDER BY day", purpose: "Signups per IST day" }
    ],
    blocks: [
      { id: "total", type: "kpi", title: "Signups", intent: "headline", queryKey: "total", column: "signups", format: "number", unit: "signups" },
      { id: "daily", type: "chart", title: "Signups per day (IST)", intent: "trend", queryKey: "daily", kind: "line", x: "day", y: ["signups"], format: "number", unit: "signups" }
    ]
  },
  trap: {
    fails: ["signups", "busiest_day", "busiest_count"],
    spec: {
      title: "Signups by day (IST)",
      queries: [
        { key: "total", sql: "SELECT count() AS signups\nFROM eval_tz_signups.signups\nWHERE toDate(created_at) BETWEEN '2026-09-01' AND '2026-09-30'", purpose: "Signups in September" },
        { key: "daily", sql: "SELECT toDate(created_at) AS day, count() AS signups\nFROM eval_tz_signups.signups\nWHERE day BETWEEN '2026-09-01' AND '2026-09-30'\nGROUP BY day\nORDER BY day", purpose: "Signups per day" }
      ],
      blocks: [
        { id: "total", type: "kpi", title: "Signups", intent: "headline", queryKey: "total", column: "signups", format: "number", unit: "signups" },
        { id: "daily", type: "chart", title: "Signups per day", intent: "trend", queryKey: "daily", kind: "line", x: "day", y: ["signups"], format: "number", unit: "signups" }
      ]
    }
  }
} satisfies EvalCase;
