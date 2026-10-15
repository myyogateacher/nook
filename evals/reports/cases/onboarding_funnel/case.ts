import type { EvalCase } from "../../types";

const FUNNEL = (count: (event: string) => string) => `SELECT step, accounts
FROM (
  SELECT 1 AS n, '1. Workspace created' AS step, ${count("workspace_created")} AS accounts FROM eval_onboarding_funnel.onboarding_events
  UNION ALL SELECT 2, '2. Teammate invited', ${count("teammate_invited")} FROM eval_onboarding_funnel.onboarding_events
  UNION ALL SELECT 3, '3. Data connected', ${count("data_connected")} FROM eval_onboarding_funnel.onboarding_events
  UNION ALL SELECT 4, '4. First report', ${count("first_report")} FROM eval_onboarding_funnel.onboarding_events
)
ORDER BY n`;

const ACTIVATION = "SELECT uniqExactIf(account_id, event = 'first_report') / uniqExactIf(account_id, event = 'workspace_created') AS activation_rate\nFROM eval_onboarding_funnel.onboarding_events";

export default {
  id: "onboarding_funnel",
  title: "Onboarding steps drawn as a funnel of accounts",
  traps: ["counting repeated events instead of accounts", "drawing ordered steps as a plain bar chart instead of a funnel"],
  ci: true,
  facts: [
    { id: "created", label: "Accounts that created a workspace", kind: "number", value: 1000, tolerance: 0, row: "1. Workspace created" },
    { id: "connected", label: "Accounts that connected data", kind: "number", value: 300, tolerance: 0, row: "3. Data connected" },
    { id: "activation", label: "Activation rate", kind: "number", value: 0.15, percent: true },
    { id: "funnel_kind", label: "The steps are drawn as a funnel", kind: "chart", value: ["funnel"] }
  ],
  golden: {
    title: "Onboarding funnel, September 2026",
    queries: [
      { key: "funnel", sql: FUNNEL((event) => `uniqExactIf(account_id, event = '${event}')`), purpose: "Accounts at each onboarding step" },
      { key: "activation", sql: ACTIVATION, purpose: "Activation rate" }
    ],
    blocks: [
      { id: "activation", type: "kpi", title: "Activation rate", intent: "headline", queryKey: "activation", column: "activation_rate", format: "percent" },
      { id: "funnel", type: "chart", title: "Onboarding funnel", intent: "conversion", queryKey: "funnel", kind: "funnel", x: "step", y: ["accounts"], format: "number", unit: "accounts" }
    ]
  },
  trap: {
    fails: ["connected", "funnel_kind"],
    spec: {
      title: "Onboarding funnel, September 2026",
      queries: [
        { key: "funnel", sql: FUNNEL((event) => `countIf(event = '${event}')`), purpose: "Events at each onboarding step" },
        { key: "activation", sql: ACTIVATION, purpose: "Activation rate" }
      ],
      blocks: [
        { id: "activation", type: "kpi", title: "Activation rate", intent: "headline", queryKey: "activation", column: "activation_rate", format: "percent" },
        { id: "funnel", type: "chart", title: "Onboarding steps", intent: "compare", queryKey: "funnel", kind: "bar", x: "step", y: ["accounts"], format: "number", unit: "accounts" }
      ]
    }
  }
} satisfies EvalCase;
