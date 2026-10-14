import type { EvalCase } from "../../types";

const ACTIVE = "started_at < '2026-10-01 00:00:00' AND (canceled_at IS NULL OR canceled_at >= '2026-10-01 00:00:00')";

export default {
  id: "mrr_cents",
  title: "Money stored in cents",
  traps: ["mrr_cents shown as dollars (100× too large)", "subscriptions cancelled after the day still count"],
  facts: [
    { id: "mrr", label: "MRR on 2026-09-30 (USD)", kind: "number", value: 89158 },
    { id: "active", label: "Active subscriptions", kind: "number", value: 1202, tolerance: 0 },
    { id: "pro_mrr", label: "MRR of the pro plan (USD)", kind: "number", value: 29290, row: "pro" }
  ],
  golden: {
    title: "MRR at the end of September 2026",
    queries: [
      { key: "totals", sql: `SELECT sum(mrr_cents) / 100 AS mrr, count() AS active_subscriptions\nFROM eval_mrr_cents.subscriptions\nWHERE ${ACTIVE}`, purpose: "MRR and active subscriptions" },
      { key: "by_plan", sql: `SELECT plan, sum(mrr_cents) / 100 AS mrr\nFROM eval_mrr_cents.subscriptions\nWHERE ${ACTIVE}\nGROUP BY plan\nORDER BY mrr DESC`, purpose: "MRR by plan" }
    ],
    blocks: [
      { id: "mrr", type: "kpi", title: "MRR", intent: "headline", queryKey: "totals", column: "mrr", format: "currency:USD", hero: true },
      { id: "active", type: "kpi", title: "Active subscriptions", intent: "headline", queryKey: "totals", column: "active_subscriptions", format: "number", unit: "subscriptions" },
      { id: "plans", type: "chart", title: "MRR by plan", intent: "compare", queryKey: "by_plan", kind: "bar", x: "plan", y: ["mrr"], format: "currency:USD" }
    ]
  },
  trap: {
    fails: ["mrr", "pro_mrr"],
    sanity: ["units"],
    spec: {
      title: "MRR at the end of September 2026",
      queries: [
        { key: "totals", sql: `SELECT sum(mrr_cents) AS mrr, count() AS active_subscriptions\nFROM eval_mrr_cents.subscriptions\nWHERE ${ACTIVE}`, purpose: "MRR and active subscriptions" },
        { key: "by_plan", sql: `SELECT plan, sum(mrr_cents) AS mrr\nFROM eval_mrr_cents.subscriptions\nWHERE ${ACTIVE}\nGROUP BY plan\nORDER BY mrr DESC`, purpose: "MRR by plan" }
      ],
      blocks: [
        { id: "mrr", type: "kpi", title: "MRR", intent: "headline", queryKey: "totals", column: "mrr", format: "currency:USD", hero: true },
        { id: "active", type: "kpi", title: "Active subscriptions", intent: "headline", queryKey: "totals", column: "active_subscriptions", format: "number", unit: "subscriptions" },
        { id: "plans", type: "chart", title: "MRR by plan", intent: "compare", queryKey: "by_plan", kind: "bar", x: "plan", y: ["mrr"], format: "currency:USD" }
      ]
    }
  }
} satisfies EvalCase;
