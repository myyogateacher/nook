import type { EvalCase } from "../../types";

const Q3 = "changed_at >= '2026-07-01' AND changed_at < '2026-10-01'";

export default {
  id: "plan_flow",
  title: "Plan changes drawn as a flow between plans",
  traps: ["counting retried changes twice", "drawing from → to movement as stacked bars instead of a sankey"],
  ci: true,
  facts: [
    { id: "free_starter", label: "Accounts that moved free → starter", kind: "number", value: 180, tolerance: 0, row: "starter" },
    { id: "upgrades", label: "Accounts with a plan change", kind: "number", value: 600, tolerance: 0 },
    { id: "flow_kind", label: "The movement is drawn as a sankey", kind: "chart", value: ["sankey"] }
  ],
  golden: {
    title: "Plan upgrades, Q3 2026",
    queries: [
      { key: "flow", sql: `SELECT from_plan, to_plan, uniqExact(account_id) AS accounts\nFROM eval_plan_flow.plan_changes\nWHERE ${Q3}\nGROUP BY from_plan, to_plan\nORDER BY accounts DESC`, purpose: "Accounts per plan change" },
      { key: "upgrades", sql: `SELECT uniqExact(account_id) AS accounts\nFROM eval_plan_flow.plan_changes\nWHERE ${Q3}`, purpose: "Accounts with a plan change" }
    ],
    blocks: [
      { id: "upgrades", type: "kpi", title: "Accounts that changed plan", intent: "headline", queryKey: "upgrades", column: "accounts", format: "number", unit: "accounts" },
      { id: "flow", type: "chart", title: "Plan flow", intent: "flow", width: "full", queryKey: "flow", kind: "sankey", x: "from_plan", x2: "to_plan", y: ["accounts"], format: "number", unit: "accounts" }
    ]
  },
  trap: {
    fails: ["free_starter", "upgrades", "flow_kind"],
    spec: {
      title: "Plan upgrades, Q3 2026",
      queries: [
        { key: "flow", sql: `SELECT from_plan, to_plan, count() AS accounts\nFROM eval_plan_flow.plan_changes\nWHERE ${Q3}\nGROUP BY from_plan, to_plan\nORDER BY accounts DESC`, purpose: "Plan changes per pair" },
        { key: "upgrades", sql: `SELECT count() AS accounts\nFROM eval_plan_flow.plan_changes\nWHERE ${Q3}`, purpose: "Plan changes" }
      ],
      blocks: [
        { id: "upgrades", type: "kpi", title: "Plan changes", intent: "headline", queryKey: "upgrades", column: "accounts", format: "number", unit: "changes" },
        { id: "flow", type: "chart", title: "Plan changes", intent: "share", width: "full", queryKey: "flow", kind: "stacked_bar", x: "from_plan", y: ["accounts"], series: "to_plan", format: "number", unit: "changes" }
      ]
    }
  }
} satisfies EvalCase;
