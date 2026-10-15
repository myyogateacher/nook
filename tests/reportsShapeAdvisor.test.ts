import { describe, expect, test } from "bun:test";
import { adviseShape, kindHints, type Shape } from "../server/reports/shapeAdvisor";

const col = (name: string, type: string) => ({ name, type });
const days = (count: number) => Array.from({ length: count }, (_, index) => new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10));

describe("adviseShape", () => {
  test("funnel: stages in order, decreasing", () => {
    const shape = adviseShape([col("step", "String"), col("users", "UInt64")], [["Pricing", "2000"], ["Signup started", "1200"], ["Email verified", "800"], ["First project", "500"], ["Paid", "120"]]);
    expect(shape.fits[0]).toBe("funnel");
    expect(shape.line).toContain("stages=5 decreasing → funnel fits; also");
    expect(shape.line.length).toBeLessThanOrEqual(300);
  });

  test("a ranked list is not a funnel", () => {
    const shape = adviseShape([col("route", "String"), col("hits", "UInt64")], [["/a", 90], ["/b", 50], ["/c", 10]]);
    expect(shape.fits).not.toContain("funnel");
    expect(shape.fits).toContain("bar");
  });

  test("funnel in one row of columns", () => {
    const shape = adviseShape([col("visited", "UInt64"), col("signed_up", "UInt64"), col("paid", "UInt64")], [[1000, 300, 40]]);
    expect(shape.fits).toEqual(["funnel"]);
    expect(shape.line).toContain("unpivot");
  });

  test("cohort heatmap: a cohort date, a period offset, and a rate", () => {
    const rows: unknown[][] = [];
    for (const cohort of ["2026-01-01", "2026-02-01", "2026-03-01"]) for (let month = 0; month < 4; month += 1) rows.push([cohort, month, 1 - month * 0.2]);
    const shape = adviseShape([col("cohort", "Date"), col("month_number", "UInt8"), col("retention", "Float64")], rows);
    expect(shape.fits[0]).toBe("heatmap");
    expect(shape.line).toContain("cohort matrix 3×4");
    expect(shape.line).toContain("retention in 0–1 → format percent");
  });

  test("heatmap: weekday × hour", () => {
    const rows: unknown[][] = [];
    for (const day of ["Mon", "Tue", "Wed"]) for (let hour = 0; hour < 3; hour += 1) rows.push([day, hour, 10 + hour]);
    const shape = adviseShape([col("weekday", "String"), col("hour", "UInt8"), col("orders", "UInt64")], rows);
    expect(shape.fits).toContain("heatmap");
  });

  test("gauge: one value against a target", () => {
    const shape = adviseShape([col("revenue", "Float64"), col("target", "Float64")], [[820000.5, 1000000]]);
    expect(shape.fits).toEqual(["gauge"]);
    expect(shape.line).toContain("revenue vs target");
  });

  test("single value: a KPI", () => {
    const shape = adviseShape([col("orders", "UInt64")], [[42]]);
    expect(shape.fits).toEqual([]);
    expect(shape.line).toContain("single value");
    expect(shape.line).toContain("kpi fits");
  });

  test("bullet: actual against a target per category", () => {
    const shape = adviseShape([col("region", "String"), col("revenue", "Float64"), col("quota", "Float64")], [["EU", 90, 100], ["US", 120, 110], ["APAC", 40, 80]]);
    expect(shape.fits[0]).toBe("bullet");
  });

  test("sankey: from/to pairs", () => {
    const shape = adviseShape([col("from_plan", "String"), col("to_plan", "String"), col("users", "UInt64")], [["free", "pro", 40], ["pro", "team", 10], ["free", "team", 5]]);
    expect(shape.fits[0]).toBe("sankey");
    expect(shape.line).toContain("from/to pair");
  });

  test("histogram: raw numeric samples", () => {
    const rows = Array.from({ length: 200 }, (_, index) => [`o${index}`, (index * 37) % 113]);
    const shape = adviseShape([col("order_id", "String"), col("amount", "Float64")], rows);
    expect(shape.fits[0]).toBe("histogram");
    expect(shape.fits).toContain("boxplot");
  });

  test("boxplot: many samples per category, or quantile columns", () => {
    const rows = Array.from({ length: 60 }, (_, index) => [["web", "ios", "android"][index % 3], index * 1.5]);
    expect(adviseShape([col("platform", "String"), col("latency_ms", "Float64")], rows).fits[0]).toBe("boxplot");
    const quantiles = adviseShape(["route", "min", "q1", "median", "q3", "max"].map((name, index) => col(name, index ? "Float64" : "String")), [["/a", 1, 2, 3, 4, 5], ["/b", 2, 3, 4, 5, 6]]);
    expect(quantiles.fits[0]).toBe("boxplot");
  });

  test("waterfall: signed deltas", () => {
    const shape = adviseShape([col("driver", "String"), col("delta", "Float64")], [["New", 120], ["Expansion", 40], ["Churn", -60], ["Contraction", -15]]);
    expect(shape.fits[0]).toBe("waterfall");
  });

  test("signed values without a change name are not a waterfall", () => {
    expect(adviseShape([col("region", "String"), col("profit", "Float64")], [["EU", 10], ["US", -5]]).fits).not.toContain("waterfall");
  });

  test("trend, calendar, and facet", () => {
    const daily = days(90).map((day, index) => [day, index % 7]);
    const calendar = adviseShape([col("day", "Date"), col("signups", "UInt64")], daily);
    expect(calendar.fits).toContain("calendar");
    expect(calendar.fits).toContain("line");
    const short = adviseShape([col("day", "Date"), col("signups", "UInt64")], daily.slice(0, 10));
    expect(short.fits).toEqual(["line", "area"]);
    const rows: unknown[][] = [];
    for (const day of days(5)) for (let route = 0; route < 12; route += 1) rows.push([day, `/r${route}`, route]);
    const facet = adviseShape([col("day", "Date"), col("route", "String"), col("hits", "UInt64")], rows);
    expect(facet.facet).toBe(true);
    expect(facet.line).toContain("12 series over time → line with facet fits");
  });

  test("percent 0–100 is pointed out", () => {
    const shape = adviseShape([col("plan", "String"), col("churn_pct", "Float64")], [["free", 12.5], ["pro", 3.2]]);
    expect(shape.line).toContain("divide by 100");
  });

  test("scatter: two measures per row", () => {
    const rows = Array.from({ length: 30 }, (_, index) => [index, index * 2.5]);
    expect(adviseShape([col("sessions", "UInt64"), col("revenue", "Float64")], rows).fits).toEqual(["scatter"]);
  });

  test("the line stays under 300 characters", () => {
    const columns = Array.from({ length: 40 }, (_, index) => col(`very_long_conversion_rate_column_${index}`, "Float64"));
    expect(adviseShape(columns, [columns.map(() => 0.5)]).line.length).toBeLessThanOrEqual(300);
  });
});

describe("kindHints", () => {
  const funnel = adviseShape([col("step", "String"), col("users", "UInt64")], [["1. Visit", 100], ["2. Signup", 40], ["3. Paid", 9]]);
  const trend = adviseShape([col("day", "Date"), col("users", "UInt64")], days(5).map((day) => [day, 3]));
  const shapes = new Map<string, Shape>([["funnel", funnel], ["daily", trend], ["daily2", trend]]);
  const done = (id: string, intent: string | null, queryKey: string) => ({ id, kind: "chart", intent, status: "done", queryKey, blockId: id });

  test("a todo's intent its block does not serve", () => {
    const hints = kindHints({ blocks: [{ id: "f", type: "chart", kind: "bar", queryKey: "funnel" }], shapes, todos: [done("f", "conversion", "funnel")], diversity: false });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("intent conversion, which is drawn as a funnel");
    expect(hints[0]).toContain("its data fits funnel");
    expect(kindHints({ blocks: [{ id: "f", type: "chart", kind: "funnel", queryKey: "funnel" }], shapes, todos: [done("f", "conversion", "funnel")] })).toEqual([]);
  });

  test("mostly bar and line, where the data fits more", () => {
    const blocks = [{ id: "f", type: "chart", kind: "bar", queryKey: "funnel" }, { id: "d", type: "chart", kind: "line", queryKey: "daily" }, { id: "k", type: "kpi", queryKey: "daily" }];
    const hints = kindHints({ blocks, shapes, todos: [] });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("2 of 2 charts are bar or line");
    expect(hints[0]).toContain("f → funnel (3 stages, decreasing)");
    expect(hints[0]).not.toContain("d →");
  });

  test("silent when the data fits nothing else or the mix is varied", () => {
    expect(kindHints({ blocks: [{ id: "d", type: "chart", kind: "line", queryKey: "daily" }, { id: "e", type: "chart", kind: "line", queryKey: "daily2" }], shapes, todos: [] })).toEqual([]);
    const varied = [{ id: "f", type: "chart", kind: "bar", queryKey: "funnel" }, { id: "h", type: "chart", kind: "heatmap", queryKey: "x" }, { id: "g", type: "chart", kind: "gauge", queryKey: "y" }];
    expect(kindHints({ blocks: varied, shapes, todos: [] })).toEqual([]);
  });
});
