import type { EvalCase } from "../../types";

const PERIOD = (column: string) => `${column} >= '2026-09-01 00:00:00' AND ${column} < '2026-10-01 00:00:00'`;

export default {
  id: "refund_dates",
  title: "Refunds on the refund date",
  traps: ["refunds joined to orders and filtered by the order date instead of the refund date"],
  facts: [
    { id: "gross", label: "Gross sales", kind: "number", value: 131114.5 },
    { id: "refunds", label: "Refunds issued", kind: "number", value: 8351 },
    { id: "net", label: "Net revenue", kind: "number", value: 122763.5, tolerance: 0.001 },
    { id: "refund_count", label: "Refund count", kind: "number", value: 88 }
  ],
  golden: {
    title: "Net revenue, September 2026",
    queries: [
      {
        key: "totals",
        sql: `SELECT gross, refunds, gross - refunds AS net_revenue, refund_count\nFROM (SELECT sum(amount) AS gross FROM eval_refund_dates.orders WHERE ${PERIOD("ordered_at")}) AS g\nCROSS JOIN (SELECT sum(refund_amount) AS refunds, count() AS refund_count FROM eval_refund_dates.refunds WHERE ${PERIOD("refunded_at")}) AS r`,
        purpose: "Gross sales, refunds issued, and net revenue"
      }
    ],
    blocks: [
      { id: "net", type: "kpi", title: "Net revenue", intent: "headline", queryKey: "totals", column: "net_revenue", format: "currency:USD", hero: true },
      { id: "gross", type: "kpi", title: "Gross sales", intent: "headline", queryKey: "totals", column: "gross", format: "currency:USD" },
      { id: "refunds", type: "kpi", title: "Refunds issued", intent: "headline", queryKey: "totals", column: "refunds", format: "currency:USD" },
      { id: "refund_count", type: "kpi", title: "Refunds", intent: "headline", queryKey: "totals", column: "refund_count", format: "number", unit: "refunds" }
    ]
  },
  trap: {
    fails: ["refunds", "net"],
    spec: {
      title: "Net revenue, September 2026",
      queries: [
        {
          key: "totals",
          sql: `SELECT sum(o.amount) AS gross, sum(r.refund_amount) AS refunds, gross - refunds AS net_revenue, countIf(r.refund_id != 0) AS refund_count\nFROM eval_refund_dates.orders AS o\nLEFT JOIN eval_refund_dates.refunds AS r ON r.order_id = o.order_id\nWHERE ${PERIOD("o.ordered_at")}`,
          purpose: "Gross sales, refunds, and net revenue"
        }
      ],
      blocks: [
        { id: "net", type: "kpi", title: "Net revenue", intent: "headline", queryKey: "totals", column: "net_revenue", format: "currency:USD", hero: true },
        { id: "gross", type: "kpi", title: "Gross sales", intent: "headline", queryKey: "totals", column: "gross", format: "currency:USD" },
        { id: "refunds", type: "kpi", title: "Refunds issued", intent: "headline", queryKey: "totals", column: "refunds", format: "currency:USD" },
        { id: "refund_count", type: "kpi", title: "Refunds", intent: "headline", queryKey: "totals", column: "refund_count", format: "number", unit: "refunds" }
      ]
    }
  }
} satisfies EvalCase;
