import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import { AriaComponent, DatasetComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { ECHARTS_THEME_NAME, reportEchartsTheme, type ThemeMode } from "../../shared/reportTheme";

/**
 * The ECharts canvas for report charts (plan wave 47), loaded lazily (`React.lazy(() => import("./charts"))`)
 * so the Reports list and every other app never download it. Tree-shaken: echarts/core with the line,
 * bar, pie, and scatter charts, the grid, tooltip, legend, dataset, and aria (forced-colors textures)
 * components, and the SVG renderer (crisp at any zoom, no canvas). ECharts runs no eval, so it works
 * under `script-src 'self'`.
 *
 * Wave 48b: one registered theme, "nook-ledger", built from shared/reportTheme.ts for the page's mode
 * (re-registered and the chart re-made when the mode changes). It only draws the option chartOption.ts
 * built; it never sees the spec.
 */
echarts.use([LineChart, BarChart, PieChart, ScatterChart, GridComponent, TooltipComponent, LegendComponent, DatasetComponent, AriaComponent, SVGRenderer]);

let registered: ThemeMode | null = null;
function themeFor(mode: ThemeMode) {
  if (registered !== mode) {
    echarts.registerTheme(ECHARTS_THEME_NAME, reportEchartsTheme(mode));
    registered = mode;
  }
  return ECHARTS_THEME_NAME;
}

export default function EChart({ option, label, mode = "dark", height }: { option: Record<string, unknown>; label: string; mode?: ThemeMode; height?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const latest = useRef(option);
  latest.current = option;

  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    const instance = echarts.init(element, themeFor(mode), { renderer: "svg" });
    chart.current = instance;
    instance.setOption(latest.current, { notMerge: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => instance.resize());
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, [mode]);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  useEffect(() => { chart.current?.resize(); }, [height]);

  return <div ref={host} className="report-chart-canvas" role="img" aria-label={label} style={height ? { height } : undefined} />;
}
