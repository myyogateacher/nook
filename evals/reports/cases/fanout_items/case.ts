import type { EvalCase } from "../../types";

export default {
  id: "fanout_items",
  title: "A join that fans out",
  traps: ["joining order_items to orders repeats each order_total once per line"],
  ci: true,
  facts: [
    { id: "revenue", label: "Revenue", kind: "number", value: 144675 },
    { id: "aov", label: "Average order value", kind: "number", value: 80.375 },
    { id: "units", label: "Units sold", kind: "number", value: 7650, tolerance: 0 },
    { id: "web_revenue", label: "Revenue, web channel", kind: "number", value: 68400, row: "web" }
  ],
  golden: {
    title: "Shop sales, September 2026",
    queries: [
      { key: "totals", sql: "SELECT sum(order_total) AS revenue, count() AS orders, round(revenue / orders, 2) AS aov,\n  (SELECT sum(qty) FROM eval_fanout_items.order_items) AS units\nFROM eval_fanout_items.orders", purpose: "Revenue, orders, AOV, and units" },
      { key: "by_channel", sql: "SELECT o.channel AS channel, sum(o.order_total) AS revenue, sum(u.units) AS units\nFROM eval_fanout_items.orders AS o\nINNER JOIN (SELECT order_id, sum(qty) AS units FROM eval_fanout_items.order_items GROUP BY order_id) AS u ON u.order_id = o.order_id\nGROUP BY channel\nORDER BY revenue DESC", purpose: "Revenue and units by channel" }
    ],
    blocks: [
      { id: "revenue", type: "kpi", title: "Revenue", intent: "headline", queryKey: "totals", column: "revenue", format: "currency:USD" },
      { id: "aov", type: "kpi", title: "Average order value", intent: "headline", queryKey: "totals", column: "aov", format: "currency:USD" },
      { id: "units", type: "kpi", title: "Units sold", intent: "headline", queryKey: "totals", column: "units", format: "number", unit: "units" },
      { id: "channels", type: "chart", title: "Revenue by channel", intent: "compare", queryKey: "by_channel", kind: "bar", x: "channel", y: ["revenue"], format: "currency:USD" },
      { id: "channel_table", type: "table", title: "Channels", intent: "detail", queryKey: "by_channel", columns: ["channel", "revenue", "units"], formats: { revenue: "currency:USD" } }
    ]
  },
  trap: {
    fails: ["revenue", "aov", "web_revenue"],
    spec: {
      title: "Shop sales, September 2026",
      queries: [
        { key: "totals", sql: "SELECT sum(o.order_total) AS revenue, uniqExact(o.order_id) AS orders, round(revenue / orders, 2) AS aov, sum(i.qty) AS units\nFROM eval_fanout_items.orders AS o\nINNER JOIN eval_fanout_items.order_items AS i ON i.order_id = o.order_id", purpose: "Revenue, orders, AOV, and units" },
        { key: "by_channel", sql: "SELECT o.channel AS channel, sum(o.order_total) AS revenue, sum(i.qty) AS units\nFROM eval_fanout_items.orders AS o\nINNER JOIN eval_fanout_items.order_items AS i ON i.order_id = o.order_id\nGROUP BY channel\nORDER BY revenue DESC", purpose: "Revenue and units by channel" }
      ],
      blocks: [
        { id: "revenue", type: "kpi", title: "Revenue", intent: "headline", queryKey: "totals", column: "revenue", format: "currency:USD" },
        { id: "aov", type: "kpi", title: "Average order value", intent: "headline", queryKey: "totals", column: "aov", format: "currency:USD" },
        { id: "units", type: "kpi", title: "Units sold", intent: "headline", queryKey: "totals", column: "units", format: "number", unit: "units" },
        { id: "channels", type: "chart", title: "Revenue by channel", intent: "compare", queryKey: "by_channel", kind: "bar", x: "channel", y: ["revenue"], format: "currency:USD" },
        { id: "channel_table", type: "table", title: "Channels", intent: "detail", queryKey: "by_channel", columns: ["channel", "revenue", "units"], formats: { revenue: "currency:USD" } }
      ]
    }
  }
} satisfies EvalCase;
