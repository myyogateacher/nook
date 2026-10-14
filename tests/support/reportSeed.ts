import type { ReportSpec } from "../../shared/reports";
import type { FakeAnswer } from "./fakeClickhouse";

/**
 * A hand-written report spec (Wave 47: generation is wave 46's), used by the refresh, scheduler, and
 * viewer tests and by the QA seed: a markdown intro, a KPI, a line chart, a bar chart, and a table
 * over four saved queries. `sampleAnswer` is a fake ClickHouse that answers those queries.
 */
export function sampleSpec(): ReportSpec {
  return {
    version: 1,
    queries: [
      { key: "totals", sql: "SELECT sum(revenue) AS revenue, sum(revenue_prev) AS revenue_prev, count() AS orders FROM analytics.orders", purpose: "Revenue this period and the period before", createdBy: "user" },
      { key: "daily", sql: "SELECT day, sum(revenue) AS revenue, sum(refunds) AS refunds FROM analytics.orders GROUP BY day ORDER BY day", purpose: "Revenue and refunds per day", createdBy: "user" },
      { key: "by_country", sql: "SELECT country, sum(revenue) AS revenue FROM analytics.orders GROUP BY country ORDER BY revenue DESC LIMIT 8", purpose: "Top countries by revenue", createdBy: "user" },
      { key: "recent", sql: "SELECT order_id, country, revenue, created_at FROM analytics.orders ORDER BY created_at DESC LIMIT 50", purpose: "The latest orders", createdBy: "user" }
    ],
    blocks: [
      { id: "intro", type: "markdown", markdown: "## Weekly revenue\n\nRevenue is **net of refunds**, per the metrics doc. Data: `analytics.orders`.", provenance: { runId: null, version: 1 } },
      { id: "kpi-revenue", type: "kpi", title: "Revenue", queryKey: "totals", column: "revenue", compareColumn: "revenue_prev", format: "currency", provenance: { runId: null, version: 1 } },
      { id: "kpi-orders", type: "kpi", title: "Orders", queryKey: "totals", column: "orders", format: "integer", provenance: { runId: null, version: 1 } },
      { id: "daily-line", type: "chart", title: "Revenue and refunds per day", queryKey: "daily", kind: "line", x: "day", y: ["revenue", "refunds"], format: "currency", provenance: { runId: null, version: 1 } },
      { id: "country-bar", type: "chart", title: "Top countries", queryKey: "by_country", kind: "bar", x: "country", y: ["revenue"], format: "currency", provenance: { runId: null, version: 1 } },
      { id: "recent-table", type: "table", title: "Latest orders", queryKey: "recent", formats: { revenue: "currency", created_at: "datetime" }, provenance: { runId: null, version: 1 } }
    ]
  };
}

const COUNTRIES = ["US", "DE", "IN", "GB", "FR", "BR", "JP", "CA"];

/** Answers the sample queries the way ClickHouse would (UInt64 and Decimal as strings, like JSONCompact). */
export function sampleAnswer(sql: string): FakeAnswer {
  if (sql.includes("sum(revenue_prev)")) {
    return { meta: [{ name: "revenue", type: "Decimal(18, 2)" }, { name: "revenue_prev", type: "Decimal(18, 2)" }, { name: "orders", type: "UInt64" }], data: [["48210.50", "44120.00", "1312"]], rowsRead: 120_000 };
  }
  if (sql.includes("GROUP BY day")) {
    const data = Array.from({ length: 14 }, (_, index) => {
      const day = new Date(Date.UTC(2026, 9, 1 + index)).toISOString().slice(0, 10);
      return [day, (3000 + Math.round(900 * Math.sin(index / 2)) + index * 40).toFixed(2), (120 + (index % 4) * 35).toFixed(2)];
    });
    return { meta: [{ name: "day", type: "Date" }, { name: "revenue", type: "Decimal(18, 2)" }, { name: "refunds", type: "Decimal(18, 2)" }], data, rowsRead: 120_000 };
  }
  if (sql.includes("GROUP BY country")) {
    return { meta: [{ name: "country", type: "LowCardinality(String)" }, { name: "revenue", type: "Decimal(18, 2)" }], data: COUNTRIES.map((country, index) => [country, (14000 / (index + 1)).toFixed(2)]), rowsRead: 120_000 };
  }
  if (sql.includes("ORDER BY created_at DESC")) {
    const data = Array.from({ length: 50 }, (_, index) => [String(900_000 + index), COUNTRIES[index % COUNTRIES.length], (20 + index * 3.5).toFixed(2), `2026-10-13 ${String(23 - (index % 24)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00`]);
    return { meta: [{ name: "order_id", type: "UInt64" }, { name: "country", type: "String" }, { name: "revenue", type: "Decimal(18, 2)" }, { name: "created_at", type: "DateTime" }], data, rowsRead: 120_000 };
  }
  return { meta: [{ name: "n", type: "UInt64" }], data: [["1"]] };
}
