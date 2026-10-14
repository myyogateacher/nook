import type { EvalCase } from "../../types";

const PEOPLE = "SELECT user_id, groupUniqArray(event_name) AS ev\n  FROM eval_signup_funnel.events\n  WHERE ts >= '2026-09-01' AND ts < '2026-10-01'\n  GROUP BY user_id";

export default {
  id: "signup_funnel",
  title: "Funnel of distinct people with earlier steps",
  traps: ["counting events instead of people", "counting a step without the earlier steps"],
  facts: [
    { id: "step1", label: "Users at step 1 (pricing)", kind: "number", value: 2000, tolerance: 0 },
    { id: "step2", label: "Users at step 2 (signup started)", kind: "number", value: 1200, tolerance: 0 },
    { id: "step2_conversion", label: "Step 2 conversion", kind: "number", value: 0.6, percent: true },
    { id: "step3_conversion", label: "Step 3 conversion", kind: "number", value: 0.6667, percent: true },
    { id: "overall", label: "Overall conversion", kind: "number", value: 0.25, percent: true }
  ],
  golden: {
    title: "Signup funnel, September 2026",
    queries: [
      {
        key: "funnel",
        sql: `WITH people AS (\n  ${PEOPLE}\n)\nSELECT step, users\nFROM (\n  SELECT 1 AS n, 'Pricing' AS step, countIf(has(ev, 'visit_pricing')) AS users FROM people\n  UNION ALL SELECT 2, 'Signup started', countIf(hasAll(ev, ['visit_pricing', 'start_signup'])) FROM people\n  UNION ALL SELECT 3, 'Email verified', countIf(hasAll(ev, ['visit_pricing', 'start_signup', 'verify_email'])) FROM people\n  UNION ALL SELECT 4, 'First project', countIf(hasAll(ev, ['visit_pricing', 'start_signup', 'verify_email', 'first_project'])) FROM people\n)\nORDER BY n`,
        purpose: "People at each funnel step"
      },
      {
        key: "rates",
        sql: `WITH people AS (\n  ${PEOPLE}\n)\nSELECT countIf(hasAll(ev, ['visit_pricing', 'start_signup'])) / countIf(has(ev, 'visit_pricing')) AS step2_conversion,\n  countIf(hasAll(ev, ['visit_pricing', 'start_signup', 'verify_email'])) / countIf(hasAll(ev, ['visit_pricing', 'start_signup'])) AS step3_conversion,\n  countIf(hasAll(ev, ['visit_pricing', 'start_signup', 'verify_email', 'first_project'])) / countIf(has(ev, 'visit_pricing')) AS overall_conversion\nFROM people`,
        purpose: "Step and overall conversion"
      }
    ],
    blocks: [
      { id: "overall", type: "kpi", title: "Overall conversion", intent: "headline", queryKey: "rates", column: "overall_conversion", format: "percent" },
      { id: "step2", type: "kpi", title: "Pricing → signup", intent: "headline", queryKey: "rates", column: "step2_conversion", format: "percent" },
      { id: "step3", type: "kpi", title: "Signup → verified", intent: "headline", queryKey: "rates", column: "step3_conversion", format: "percent" },
      { id: "funnel", type: "chart", title: "Signup funnel", intent: "conversion", queryKey: "funnel", kind: "funnel", x: "step", y: ["users"], format: "number", unit: "people" }
    ]
  },
  trap: {
    fails: ["step2", "step2_conversion", "step3_conversion"],
    spec: {
      title: "Signup funnel, September 2026",
      queries: [
        {
          key: "funnel",
          sql: "SELECT event_name AS step, uniqExact(user_id) AS users\nFROM eval_signup_funnel.events\nWHERE ts >= '2026-09-01' AND ts < '2026-10-01'\nGROUP BY step\nORDER BY users DESC",
          purpose: "People at each funnel step"
        },
        {
          key: "rates",
          sql: "SELECT uniqExactIf(user_id, event_name = 'start_signup') / uniqExactIf(user_id, event_name = 'visit_pricing') AS step2_conversion,\n  uniqExactIf(user_id, event_name = 'verify_email') / uniqExactIf(user_id, event_name = 'start_signup') AS step3_conversion,\n  uniqExactIf(user_id, event_name = 'first_project') / uniqExactIf(user_id, event_name = 'visit_pricing') AS overall_conversion\nFROM eval_signup_funnel.events\nWHERE ts >= '2026-09-01' AND ts < '2026-10-01'",
          purpose: "Step and overall conversion"
        }
      ],
      blocks: [
        { id: "overall", type: "kpi", title: "Overall conversion", intent: "headline", queryKey: "rates", column: "overall_conversion", format: "percent" },
        { id: "step2", type: "kpi", title: "Pricing → signup", intent: "headline", queryKey: "rates", column: "step2_conversion", format: "percent" },
        { id: "step3", type: "kpi", title: "Signup → verified", intent: "headline", queryKey: "rates", column: "step3_conversion", format: "percent" },
        { id: "funnel", type: "chart", title: "Signup funnel", intent: "conversion", queryKey: "funnel", kind: "funnel", x: "step", y: ["users"], format: "number", unit: "people" }
      ]
    }
  }
} satisfies EvalCase;
