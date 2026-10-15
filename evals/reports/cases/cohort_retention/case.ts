import type { EvalCase } from "../../types";

const ACTIVE = "SELECT toStartOfMonth(signup_date) AS cohort, dateDiff('month', toStartOfMonth(signup_date), toStartOfMonth(active_date)) AS month_number, uniqExact(user_id) AS users\n  FROM eval_cohort_retention.activity\n  GROUP BY cohort, month_number";
const SIGNUPS = "SELECT uniqExact(user_id) AS signups\nFROM eval_cohort_retention.activity";

export default {
  id: "cohort_retention",
  title: "Cohort retention drawn as a cohort heatmap",
  traps: ["dividing by every user instead of the cohort's size", "drawing a cohort × month matrix as bars instead of a heatmap"],
  facts: [
    { id: "jul_m1", label: "July cohort, month 1 retention", kind: "number", value: 0.6, percent: true, row: "2026-07-01" },
    { id: "jun_m2", label: "June cohort, month 2 retention", kind: "number", value: 0.4, percent: true, row: "2026-06-01" },
    { id: "signups", label: "Signups", kind: "number", value: 1200, tolerance: 0 },
    { id: "heatmap_kind", label: "Retention is drawn as a heatmap", kind: "chart", value: ["heatmap"] }
  ],
  golden: {
    title: "Retention by signup cohort",
    queries: [
      {
        key: "retention",
        sql: `SELECT a.cohort AS cohort, a.month_number AS month_number, a.users / s.size AS retention\nFROM (\n  ${ACTIVE}\n) AS a\nINNER JOIN (\n  SELECT toStartOfMonth(signup_date) AS cohort, uniqExact(user_id) AS size FROM eval_cohort_retention.activity GROUP BY cohort\n) AS s ON a.cohort = s.cohort\nORDER BY cohort, month_number`,
        purpose: "Share of each cohort active in each month since signup"
      },
      { key: "signups", sql: SIGNUPS, purpose: "Signups" }
    ],
    blocks: [
      { id: "signups", type: "kpi", title: "Signups", intent: "headline", queryKey: "signups", column: "signups", format: "number", unit: "users" },
      { id: "retention", type: "chart", title: "Retention by cohort", intent: "matrix", width: "full", queryKey: "retention", kind: "heatmap", x: "month_number", x2: "cohort", y: ["retention"], cohort: true, format: "percent" }
    ]
  },
  trap: {
    fails: ["jul_m1", "jun_m2", "heatmap_kind"],
    spec: {
      title: "Retention by signup cohort",
      queries: [
        {
          key: "retention",
          sql: `SELECT toString(cohort) AS cohort_label, month_number, users / 1200 AS retention\nFROM (\n  ${ACTIVE}\n)\nORDER BY cohort, month_number`,
          purpose: "Share of users active in each month since signup"
        },
        { key: "signups", sql: SIGNUPS, purpose: "Signups" }
      ],
      blocks: [
        { id: "signups", type: "kpi", title: "Signups", intent: "headline", queryKey: "signups", column: "signups", format: "number", unit: "users" },
        { id: "retention", type: "chart", title: "Retention by cohort", intent: "compare", width: "full", queryKey: "retention", kind: "bar", x: "month_number", y: ["retention"], series: "cohort_label", format: "percent" }
      ]
    }
  }
} satisfies EvalCase;
