import type { EvalCase } from "../../types";

export default {
  id: "discount_rates",
  title: "Percent stored as 0–1",
  traps: ["discount_rate is a fraction: shown as a percent it must not be multiplied twice", "the average is over discounted orders only"],
  ci: true,
  facts: [
    { id: "avg_discount", label: "Average discount (discounted orders)", kind: "number", value: 0.16, percent: true },
    { id: "share", label: "Discounted share", kind: "number", value: 0.25, percent: true },
    { id: "cost", label: "Discount cost", kind: "number", value: 14747.5 },
    { id: "top_coupon", label: "Coupon with the largest discount cost", kind: "top", value: "VIP" }
  ],
  golden: {
    title: "Discounts, September 2026",
    queries: [
      { key: "totals", sql: "SELECT avgIf(discount_rate, discount_rate > 0) AS avg_discount, countIf(discount_rate > 0) / count() AS discounted_share,\n  round(sum(toFloat64(list_price) * discount_rate), 2) AS discount_cost\nFROM eval_discount_rates.orders", purpose: "Average discount, discounted share, and cost" },
      { key: "by_coupon", sql: "SELECT coupon, round(sum(toFloat64(list_price) * discount_rate), 2) AS cost\nFROM eval_discount_rates.orders\nWHERE discount_rate > 0\nGROUP BY coupon\nORDER BY cost DESC", purpose: "Discount cost by coupon" }
    ],
    blocks: [
      { id: "avg", type: "kpi", title: "Average discount", intent: "headline", queryKey: "totals", column: "avg_discount", format: "percent" },
      { id: "share", type: "kpi", title: "Discounted orders", intent: "headline", queryKey: "totals", column: "discounted_share", format: "percent" },
      { id: "cost", type: "kpi", title: "Discount cost", intent: "headline", queryKey: "totals", column: "discount_cost", format: "currency:USD" },
      { id: "coupons", type: "chart", title: "Discount cost by coupon", intent: "rank", queryKey: "by_coupon", kind: "horizontal_bar", x: "coupon", y: ["cost"], format: "currency:USD" }
    ]
  },
  trap: {
    fails: ["avg_discount", "share"],
    sanity: ["units"],
    spec: {
      title: "Discounts, September 2026",
      queries: [
        { key: "totals", sql: "SELECT avg(discount_rate) * 100 AS avg_discount, countIf(discount_rate > 0) / count() * 100 AS discounted_share,\n  round(sum(toFloat64(list_price) * discount_rate), 2) AS discount_cost\nFROM eval_discount_rates.orders", purpose: "Average discount, discounted share, and cost" },
        { key: "by_coupon", sql: "SELECT coupon, round(sum(toFloat64(list_price) * discount_rate), 2) AS cost\nFROM eval_discount_rates.orders\nWHERE discount_rate > 0\nGROUP BY coupon\nORDER BY cost DESC", purpose: "Discount cost by coupon" }
      ],
      blocks: [
        { id: "avg", type: "kpi", title: "Average discount", intent: "headline", queryKey: "totals", column: "avg_discount", format: "percent" },
        { id: "share", type: "kpi", title: "Discounted orders", intent: "headline", queryKey: "totals", column: "discounted_share", format: "percent" },
        { id: "cost", type: "kpi", title: "Discount cost", intent: "headline", queryKey: "totals", column: "discount_cost", format: "currency:USD" },
        { id: "coupons", type: "chart", title: "Discount cost by coupon", intent: "rank", queryKey: "by_coupon", kind: "horizontal_bar", x: "coupon", y: ["cost"], format: "currency:USD" }
      ]
    }
  }
} satisfies EvalCase;
