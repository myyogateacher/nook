import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import { DatasetComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";

/**
 * The ECharts canvas for report charts (plan wave 47), loaded lazily (`React.lazy(() => import("./charts"))`)
 * so the Reports list and every other app never download it. Tree-shaken: echarts/core with the line,
 * bar, pie, and scatter charts, the grid, tooltip, legend, and dataset components, and the SVG renderer
 * (crisp at any zoom, no canvas). ECharts runs no eval, so it works under `script-src 'self'`.
 *
 * It only draws the option chartOption.ts built; it never sees the spec.
 */
echarts.use([LineChart, BarChart, PieChart, ScatterChart, GridComponent, TooltipComponent, LegendComponent, DatasetComponent, SVGRenderer]);

export default function EChart({ option, label }: { option: Record<string, unknown>; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    const instance = echarts.init(element, null, { renderer: "svg" });
    chart.current = instance;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => instance.resize());
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={host} className="report-chart-canvas" role="img" aria-label={label} />;
}
