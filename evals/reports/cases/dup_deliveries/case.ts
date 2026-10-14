import type { EvalCase } from "../../types";

const DEDUP = "(\n  SELECT event_id, any(purchased_at) AS purchased_at, any(amount) AS amount, any(product) AS product\n  FROM eval_dup_deliveries.purchase_events\n  GROUP BY event_id\n)";

export default {
  id: "dup_deliveries",
  title: "At-least-once deliveries",
  traps: ["count() and sum() over raw deliveries count repeated events"],
  facts: [
    { id: "purchases", label: "Purchases", kind: "number", value: 2600, tolerance: 0 },
    { id: "revenue", label: "Revenue", kind: "number", value: 141760 },
    { id: "ebook_revenue", label: "Revenue of ebook", kind: "number", value: 35020, row: "ebook" }
  ],
  golden: {
    title: "Purchases, September 2026",
    queries: [
      { key: "totals", sql: `SELECT count() AS purchases, sum(amount) AS revenue\nFROM ${DEDUP}`, purpose: "Distinct purchases and revenue" },
      { key: "by_product", sql: `SELECT product, sum(amount) AS revenue\nFROM ${DEDUP}\nGROUP BY product\nORDER BY revenue DESC`, purpose: "Revenue by product" },
      { key: "daily", sql: `SELECT toDate(purchased_at) AS day, count() AS purchases\nFROM ${DEDUP}\nGROUP BY day\nORDER BY day`, purpose: "Purchases per day" }
    ],
    blocks: [
      { id: "purchases", type: "kpi", title: "Purchases", intent: "headline", queryKey: "totals", column: "purchases", format: "number", unit: "purchases" },
      { id: "revenue", type: "kpi", title: "Revenue", intent: "headline", queryKey: "totals", column: "revenue", format: "currency:USD" },
      { id: "products", type: "chart", title: "Revenue by product", intent: "compare", queryKey: "by_product", kind: "bar", x: "product", y: ["revenue"], format: "currency:USD" },
      { id: "daily", type: "chart", title: "Purchases per day", intent: "trend", queryKey: "daily", kind: "line", x: "day", y: ["purchases"], format: "number", unit: "purchases" }
    ]
  },
  trap: {
    fails: ["purchases", "revenue", "ebook_revenue"],
    spec: {
      title: "Purchases, September 2026",
      queries: [
        { key: "totals", sql: "SELECT count() AS purchases, sum(amount) AS revenue\nFROM eval_dup_deliveries.purchase_events", purpose: "Purchases and revenue" },
        { key: "by_product", sql: "SELECT product, sum(amount) AS revenue\nFROM eval_dup_deliveries.purchase_events\nGROUP BY product\nORDER BY revenue DESC", purpose: "Revenue by product" },
        { key: "daily", sql: "SELECT toDate(purchased_at) AS day, count() AS purchases\nFROM eval_dup_deliveries.purchase_events\nGROUP BY day\nORDER BY day", purpose: "Purchases per day" }
      ],
      blocks: [
        { id: "purchases", type: "kpi", title: "Purchases", intent: "headline", queryKey: "totals", column: "purchases", format: "number", unit: "purchases" },
        { id: "revenue", type: "kpi", title: "Revenue", intent: "headline", queryKey: "totals", column: "revenue", format: "currency:USD" },
        { id: "products", type: "chart", title: "Revenue by product", intent: "compare", queryKey: "by_product", kind: "bar", x: "product", y: ["revenue"], format: "currency:USD" },
        { id: "daily", type: "chart", title: "Purchases per day", intent: "trend", queryKey: "daily", kind: "line", x: "day", y: ["purchases"], format: "number", unit: "purchases" }
      ]
    }
  }
} satisfies EvalCase;
