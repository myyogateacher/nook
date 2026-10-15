import type { EvalCase } from "../../types";

const Q3 = "closed_at >= '2026-07-01' AND closed_at < '2026-10-01'";
const REGIONS = (revenue: string) => `SELECT d.region AS region, d.won AS won, q.quota AS quota, toFloat64(d.won) / toFloat64(q.quota) AS attainment
FROM (
  SELECT region, ${revenue} AS won FROM eval_quota_attainment.deals WHERE ${Q3} GROUP BY region
) AS d
INNER JOIN (
  SELECT region, quota FROM eval_quota_attainment.quotas WHERE quarter = '2026-Q3'
) AS q ON d.region = q.region
ORDER BY region`;
const COMPANY = (revenue: string) => `SELECT toFloat64(d.won) / toFloat64(q.quota) AS attainment
FROM (SELECT 1 AS k, ${revenue} AS won FROM eval_quota_attainment.deals WHERE ${Q3}) AS d
INNER JOIN (SELECT 1 AS k, sum(quota) AS quota FROM eval_quota_attainment.quotas WHERE quarter = '2026-Q3') AS q ON d.k = q.k`;

export default {
  id: "quota_attainment",
  title: "Revenue against quota drawn as a bullet chart",
  traps: ["counting lost and open deals as revenue", "drawing revenue against a target as a plain bar chart"],
  facts: [
    { id: "emea_won", label: "EMEA won revenue", kind: "number", value: 174040, tolerance: 0, row: "EMEA" },
    { id: "latam_attainment", label: "LATAM attainment", kind: "number", value: 1.4445, percent: true, row: "LATAM" },
    { id: "company_attainment", label: "Company attainment", kind: "number", value: 0.81642, percent: true },
    { id: "target_kind", label: "Revenue is drawn against its quota (bullet or gauge)", kind: "chart", value: ["bullet", "gauge"] }
  ],
  golden: {
    title: "Quota attainment, Q3 2026",
    queries: [
      { key: "regions", sql: REGIONS("sumIf(amount, stage = 'won')"), purpose: "Won revenue, quota, and attainment per region" },
      { key: "company", sql: COMPANY("sumIf(amount, stage = 'won')"), purpose: "Company attainment" }
    ],
    blocks: [
      { id: "company", type: "kpi", title: "Company attainment", intent: "headline", queryKey: "company", column: "attainment", format: "percent" },
      { id: "regions", type: "chart", title: "Won revenue against quota", intent: "attainment", queryKey: "regions", kind: "bullet", x: "region", y: ["won"], target: "quota", format: "currency:USD" },
      { id: "regions_table", type: "table", title: "Attainment by region", intent: "detail", queryKey: "regions", columns: ["region", "won", "quota", "attainment"], formats: { won: "currency:USD", quota: "currency:USD", attainment: "percent" } }
    ]
  },
  trap: {
    fails: ["emea_won", "latam_attainment", "company_attainment", "target_kind"],
    spec: {
      title: "Quota attainment, Q3 2026",
      queries: [
        { key: "regions", sql: REGIONS("sum(amount)"), purpose: "Revenue, quota, and attainment per region" },
        { key: "company", sql: COMPANY("sum(amount)"), purpose: "Company attainment" }
      ],
      blocks: [
        { id: "company", type: "kpi", title: "Company attainment", intent: "headline", queryKey: "company", column: "attainment", format: "percent" },
        { id: "regions", type: "chart", title: "Revenue by region", intent: "compare", queryKey: "regions", kind: "bar", x: "region", y: ["won"], format: "currency:USD" },
        { id: "regions_table", type: "table", title: "Attainment by region", intent: "detail", queryKey: "regions", columns: ["region", "won", "quota", "attainment"], formats: { won: "currency:USD", quota: "currency:USD", attainment: "percent" } }
      ]
    }
  }
} satisfies EvalCase;
