import type { EvalCase } from "../../types";

const WHERE = "_peerdb_is_deleted = 0 AND status IN ('paid', 'shipped') AND created_at >= '2026-09-01' AND created_at < '2026-10-01'";

export default {
  id: "peerdb_orders",
  title: "PeerDB orders: FINAL and soft deletes",
  traps: ["ReplacingMergeTree read without FINAL counts every version", "soft-deleted rows (_peerdb_is_deleted = 1) still in the table"],
  ci: true,
  facts: [
    { id: "net_revenue", label: "Net revenue, September 2026", kind: "number", value: 162695.81 },
    { id: "orders", label: "Revenue orders", kind: "number", value: 1419 },
    { id: "aov", label: "Average order value", kind: "number", value: 114.655 },
    { id: "paid_revenue", label: "Revenue of paid orders", kind: "number", value: 140917.68, row: "paid" }
  ],
  golden: {
    title: "September 2026 order revenue",
    queries: [
      { key: "totals", sql: `SELECT sum(amount) AS net_revenue, count() AS orders, round(sum(amount) / count(), 2) AS aov\nFROM eval_peerdb_orders.orders FINAL\nWHERE ${WHERE}`, purpose: "Net revenue, orders, and AOV" },
      { key: "by_status", sql: `SELECT status, sum(amount) AS revenue\nFROM eval_peerdb_orders.orders FINAL\nWHERE ${WHERE}\nGROUP BY status\nORDER BY revenue DESC`, purpose: "Net revenue by status" }
    ],
    blocks: [
      { id: "revenue", type: "kpi", title: "Net revenue", intent: "headline", queryKey: "totals", column: "net_revenue", format: "currency:USD" },
      { id: "orders", type: "kpi", title: "Revenue orders", intent: "headline", queryKey: "totals", column: "orders", format: "number", unit: "orders" },
      { id: "aov", type: "kpi", title: "Average order value", intent: "headline", queryKey: "totals", column: "aov", format: "currency:USD" },
      { id: "status", type: "chart", title: "Revenue by status", intent: "compare", queryKey: "by_status", kind: "bar", x: "status", y: ["revenue"], format: "currency:USD" }
    ]
  },
  trap: {
    fails: ["net_revenue", "orders", "paid_revenue"],
    spec: {
      title: "September 2026 order revenue",
      queries: [
        { key: "totals", sql: "SELECT sum(amount) AS net_revenue, count() AS orders, round(sum(amount) / count(), 2) AS aov\nFROM eval_peerdb_orders.orders\nWHERE status IN ('paid', 'shipped') AND created_at >= '2026-09-01' AND created_at < '2026-10-01'", purpose: "Net revenue, orders, and AOV" },
        { key: "by_status", sql: "SELECT status, sum(amount) AS revenue\nFROM eval_peerdb_orders.orders\nWHERE status IN ('paid', 'shipped') AND created_at >= '2026-09-01' AND created_at < '2026-10-01'\nGROUP BY status\nORDER BY revenue DESC", purpose: "Net revenue by status" }
      ],
      blocks: [
        { id: "revenue", type: "kpi", title: "Net revenue", intent: "headline", queryKey: "totals", column: "net_revenue", format: "currency:USD" },
        { id: "orders", type: "kpi", title: "Revenue orders", intent: "headline", queryKey: "totals", column: "orders", format: "number", unit: "orders" },
        { id: "aov", type: "kpi", title: "Average order value", intent: "headline", queryKey: "totals", column: "aov", format: "currency:USD" },
        { id: "status", type: "chart", title: "Revenue by status", intent: "compare", queryKey: "by_status", kind: "bar", x: "status", y: ["revenue"], format: "currency:USD" }
      ]
    }
  }
} satisfies EvalCase;
