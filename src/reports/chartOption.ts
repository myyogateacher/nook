import type { ChartBlock, ChartKind, ResultColumn, ValueFormat } from "../../shared/reports";

/**
 * ECharts options for report charts (plan wave 47, T366 "chart option injection"). Nook builds every
 * option here from the validated block spec (kind, x, y[], series, format) and the stored result rows,
 * nothing else: no option, style, or formatter string ever comes from the spec or the model. The only
 * formatters are this file's functions, picked by the `ValueFormat` enum; every text that reaches the
 * tooltip's HTML is escaped here. The inspect panel's Mapping tab shows the same option (optionJson).
 *
 * Colors: the reference categorical palette of the data-viz method, eight hues in a fixed order, the
 * dark and light steps each validated for their surface; text wears text tokens, never series colors.
 * A ninth series and beyond folds into "Other". Pure: no DOM, so tests run it directly.
 */

export type ChartPalette = {
  mode: "dark" | "light";
  surface: string;
  text: string;
  muted: string;
  grid: string;
  axis: string;
  tooltipBg: string;
  tooltipBorder: string;
  series: readonly string[];
};

export const CHART_PALETTES: Record<"dark" | "light", ChartPalette> = {
  dark: {
    mode: "dark", surface: "#131316", text: "#ededee", muted: "#9a9aa1", grid: "#26262b", axis: "#3a3a40", tooltipBg: "#1b1b1f", tooltipBorder: "#34343a",
    series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"]
  },
  light: {
    mode: "light", surface: "#fcfcfb", text: "#0b0b0b", muted: "#52514e", grid: "#e6e5e1", axis: "#c9c8c3", tooltipBg: "#ffffff", tooltipBorder: "#d9d8d3",
    series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
  }
};

/** Points a chart draws at most (the stored result may hold 10,000 rows). */
export const MAX_CHART_POINTS = 2_000;
/** Series a chart colors; the rest fold into "Other". */
export const MAX_CHART_SERIES = 8;

// --------------------------------------------------------------------------------------- values

/** A cell as a number: ClickHouse's JSONCompact sends 64-bit integers and decimals as strings. */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "" && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A cell as a label (categories, table cells without a format). */
export function cellLabel(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

const grouped = (digits: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const fixed2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

function bytesText(value: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let size = Math.abs(value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${value < 0 ? "-" : ""}${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
}

function durationText(seconds: number) {
  const sign = seconds < 0 ? "-" : "";
  let rest = Math.abs(seconds);
  if (rest < 60) return `${sign}${grouped(1).format(rest)} s`;
  const days = Math.floor(rest / 86_400); rest -= days * 86_400;
  const hours = Math.floor(rest / 3_600); rest -= hours * 3_600;
  const minutes = Math.floor(rest / 60);
  return sign + [days ? `${days}d` : "", hours ? `${hours}h` : "", minutes ? `${minutes}m` : ""].filter(Boolean).join(" ");
}

/** A value shown with a block's format (tiles, tooltips, table cells). Unknown or non-numeric values show as text. */
export function formatValue(value: unknown, format: ValueFormat | undefined): string {
  if (value === null || value === undefined) return "—";
  if (format === "text" || format === undefined) {
    const number = toNumber(value);
    return number !== null && typeof value !== "string" ? grouped(2).format(number) : cellLabel(value);
  }
  if (format === "date" || format === "datetime") {
    if (typeof value === "string") return format === "date" ? value.slice(0, 10) : value.replace("T", " ").replace(/\.\d+Z?$|Z$/, "");
    const number = toNumber(value);
    if (number === null) return cellLabel(value);
    const iso = new Date(number < 1e11 ? number * 1000 : number).toISOString();
    return format === "date" ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
  }
  const number = toNumber(value);
  if (number === null) return cellLabel(value);
  switch (format) {
    case "integer": return grouped(0).format(Math.round(number));
    case "percent": return `${grouped(1).format(number * 100)}%`;
    case "currency": return fixed2.format(number);
    case "bytes": return bytesText(number);
    case "duration_s": return durationText(number);
    default: return grouped(2).format(number);
  }
}

/** A compact axis label: 12.3K, 4.5M, 25%, 1.2 GiB. */
export function axisLabel(value: number, format: ValueFormat | undefined): string {
  if (format === "percent") return `${grouped(0).format(value * 100)}%`;
  if (format === "bytes") return bytesText(value);
  if (format === "duration_s") return durationText(value);
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${grouped(1).format(value / 1e9)}B`;
  if (abs >= 1e6) return `${grouped(1).format(value / 1e6)}M`;
  if (abs >= 1e4) return `${grouped(1).format(value / 1e3)}K`;
  return grouped(2).format(value);
}

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);

/** A named formatter: the Mapping tab shows its name instead of its code. */
type Named<F> = F & { formatterName: string };
const named = <F extends (...args: never[]) => unknown>(name: string, fn: F): Named<F> => Object.assign(fn, { formatterName: name });

// ----------------------------------------------------------------------------------------- option

export type ChartData = { columns: readonly ResultColumn[]; rows: readonly (readonly unknown[])[] };

export type ChartBuild = {
  /** The ECharts option, or null when the result cannot draw this block (the reasons are in `problems`). */
  option: Record<string, unknown> | null;
  problems: string[];
  /** Columns the block maps, by role (highlighted in the Data tab). */
  mapped: Record<string, string>;
  /** Rows left out past MAX_CHART_POINTS; series folded into "Other". */
  cutRows: number;
  foldedSeries: number;
};

/** The columns a chart block maps, by role. */
export function chartMapping(block: Pick<ChartBlock, "x" | "y" | "series">): Record<string, string> {
  const mapped: Record<string, string> = { [block.x]: "x" };
  block.y.forEach((name, index) => { mapped[name] = block.y.length > 1 ? `y${index + 1}` : "y"; });
  if (block.series) mapped[block.series] = "series";
  return mapped;
}

type SeriesData = { name: string; values: Array<number | null> };

/** Splits long-format rows by the series column into one series of `y` per value; the smallest past MAX_CHART_SERIES fold into "Other". */
function pivot(rows: readonly (readonly unknown[])[], xi: number, yi: number, si: number): { categories: string[]; series: SeriesData[]; folded: number } {
  const categories: string[] = [];
  const categoryIndex = new Map<string, number>();
  const sums = new Map<string, Map<number, number>>();
  const totals = new Map<string, number>();
  for (const row of rows) {
    const category = cellLabel(row[xi]);
    if (!categoryIndex.has(category)) { categoryIndex.set(category, categories.length); categories.push(category); }
    const name = cellLabel(row[si]);
    const value = toNumber(row[yi]);
    if (value === null) continue;
    const at = categoryIndex.get(category)!;
    const byCategory = sums.get(name) ?? new Map<number, number>();
    byCategory.set(at, (byCategory.get(at) ?? 0) + value);
    sums.set(name, byCategory);
    totals.set(name, (totals.get(name) ?? 0) + Math.abs(value));
  }
  const names = [...sums.keys()].sort((left, right) => (totals.get(right) ?? 0) - (totals.get(left) ?? 0));
  const keep = names.length > MAX_CHART_SERIES ? names.slice(0, MAX_CHART_SERIES - 1) : names;
  const rest = names.slice(keep.length);
  // Keep the data's own order of appearance for the kept series, so colors follow the entity.
  const order = [...sums.keys()].filter((name) => keep.includes(name));
  const series: SeriesData[] = order.map((name) => ({ name, values: categories.map((_, index) => sums.get(name)!.get(index) ?? null) }));
  if (rest.length) {
    series.push({ name: "Other", values: categories.map((_, index) => {
      let total: number | null = null;
      for (const name of rest) {
        const value = sums.get(name)!.get(index);
        if (value !== undefined) total = (total ?? 0) + value;
      }
      return total;
    }) });
  }
  return { categories, series, folded: rest.length };
}

function tooltipFormatter(format: ValueFormat | undefined, palette: ChartPalette, item: boolean) {
  return named(`tooltip:${format ?? "number"}`, (params: unknown) => {
    const list = (Array.isArray(params) ? params : [params]) as Array<{ seriesName?: string; name?: string; value?: unknown; color?: string; percent?: number }>;
    if (!list.length) return "";
    const head = escapeHtml(String(list[0]!.name ?? ""));
    const lines = list.map((entry) => {
      const raw = Array.isArray(entry.value) ? entry.value[entry.value.length - 1] : entry.value;
      const label = item && entry.seriesName && entry.name && !Array.isArray(entry.value) ? entry.name : entry.seriesName ?? "";
      const swatch = `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${/^#[0-9a-f]{6}$/i.test(entry.color ?? "") ? entry.color : palette.muted}"></span>`;
      const percent = typeof entry.percent === "number" ? ` (${grouped(1).format(entry.percent)}%)` : "";
      return `<div>${swatch}${escapeHtml(String(label))}: <b>${escapeHtml(formatValue(raw, format))}</b>${percent}</div>`;
    });
    return `${item ? "" : `<div style="color:${palette.muted};margin-bottom:4px">${head}</div>`}${lines.join("")}`;
  });
}

const BAR_KINDS: readonly ChartKind[] = ["bar", "stacked_bar", "horizontal_bar"];

/**
 * The option for a chart block over a result. Missing or non-numeric mapped columns are problems
 * (the block shows them instead of a chart); nothing in the option comes from the spec but column
 * names, which ECharts renders as text, and the enum values chosen here.
 */
export function buildChartOption(block: ChartBlock, data: ChartData, palette: ChartPalette): ChartBuild {
  const mapped = chartMapping(block);
  const problems: string[] = [];
  const index = (name: string) => data.columns.findIndex((column) => column.name === name);
  const xi = index(block.x);
  const yis = block.y.map(index);
  const si = block.series ? index(block.series) : -1;
  if (xi < 0) problems.push(`The result has no column "${block.x}" for x`);
  block.y.forEach((name, at) => { if (yis[at]! < 0) problems.push(`The result has no column "${name}" for y`); });
  if (block.series && si < 0) problems.push(`The result has no column "${block.series}" for the series`);
  if (!block.y.length) problems.push("The chart maps no y column");
  if (problems.length) return { option: null, problems, mapped, cutRows: 0, foldedSeries: 0 };

  const rows = data.rows.slice(0, MAX_CHART_POINTS);
  const cutRows = data.rows.length - rows.length;
  let categories: string[] = rows.map((row) => cellLabel(row[xi]));
  let series: SeriesData[];
  let folded = 0;
  if (si >= 0) {
    const split = pivot(rows, xi, yis[0]!, si);
    categories = split.categories;
    series = split.series;
    folded = split.folded;
  } else {
    const shown = yis.slice(0, MAX_CHART_SERIES);
    folded = yis.length - shown.length;
    series = shown.map((yi, at) => ({ name: block.y[at]!, values: rows.map((row) => toNumber(row[yi])) }));
  }
  if (series.every((item) => item.values.every((value) => value === null))) problems.push("The y columns hold no numbers");

  const format = block.format;
  const kind = block.kind;
  const legend = series.length >= 2 || kind === "pie";
  const base: Record<string, unknown> = {
    backgroundColor: "transparent",
    color: [...palette.series],
    animation: rows.length <= 500,
    textStyle: { color: palette.text, fontFamily: "inherit" },
    tooltip: {
      trigger: kind === "pie" || kind === "scatter" ? "item" : "axis",
      backgroundColor: palette.tooltipBg, borderColor: palette.tooltipBorder, borderWidth: 1, textStyle: { color: palette.text, fontSize: 12 },
      axisPointer: { type: BAR_KINDS.includes(kind) ? "shadow" : "line", lineStyle: { color: palette.axis }, shadowStyle: { color: palette.mode === "dark" ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)" } },
      confine: true,
      formatter: tooltipFormatter(format, palette, kind === "pie" || kind === "scatter")
    },
    legend: legend ? { show: true, top: 0, left: 0, type: "scroll", icon: "roundRect", itemWidth: 10, itemHeight: 10, itemGap: 16, textStyle: { color: palette.muted, fontSize: 12 }, pageTextStyle: { color: palette.muted } } : { show: false }
  };

  if (kind === "pie") {
    const first = series[0]!;
    return {
      option: {
        ...base,
        series: [{
          type: "pie", name: first.name, radius: ["45%", "70%"], center: ["50%", "56%"], avoidLabelOverlap: true,
          itemStyle: { borderColor: palette.surface, borderWidth: 2, borderRadius: 4 },
          label: { color: palette.muted, fontSize: 12 }, labelLine: { lineStyle: { color: palette.axis } },
          data: categories.map((name, at) => ({ name, value: first.values[at] ?? 0 })).filter((item) => item.value > 0)
        }]
      },
      problems, mapped, cutRows, foldedSeries: folded
    };
  }

  const valueAxis = {
    type: "value",
    axisLabel: { color: palette.muted, fontSize: 11, formatter: named(`axis:${format ?? "number"}`, (value: number) => axisLabel(value, format)) },
    splitLine: { lineStyle: { color: palette.grid } },
    axisLine: { show: false }, axisTick: { show: false }
  };
  const numericX = kind === "scatter" && rows.every((row) => toNumber(row[xi]) !== null);
  const categoryAxis = numericX
    ? { type: "value", axisLabel: { color: palette.muted, fontSize: 11 }, splitLine: { lineStyle: { color: palette.grid } }, axisLine: { lineStyle: { color: palette.axis } } }
    : { type: "category", data: categories, boundaryGap: BAR_KINDS.includes(kind), axisLabel: { color: palette.muted, fontSize: 11, hideOverlap: true }, axisLine: { lineStyle: { color: palette.axis } }, axisTick: { show: false } };
  const horizontal = kind === "horizontal_bar";
  const symbols = rows.length <= 60;
  const echartsSeries = series.map((item) => {
    if (kind === "scatter") {
      return { type: "scatter", name: item.name, symbolSize: 8, itemStyle: { borderColor: palette.surface, borderWidth: 1 }, data: numericX ? rows.map((row, at) => [toNumber(row[xi]), item.values[at]]) : item.values };
    }
    if (BAR_KINDS.includes(kind)) {
      return {
        type: "bar", name: item.name, barMaxWidth: 28, barGap: "10%", ...(kind === "stacked_bar" ? { stack: "total" } : {}),
        itemStyle: { borderRadius: horizontal ? [0, 4, 4, 0] : kind === "stacked_bar" ? 0 : [4, 4, 0, 0], borderColor: palette.surface, borderWidth: kind === "stacked_bar" ? 1 : 0 },
        emphasis: { focus: "series" }, data: item.values
      };
    }
    return {
      type: "line", name: item.name, showSymbol: symbols, symbol: "circle", symbolSize: 8, lineStyle: { width: 2 }, connectNulls: false,
      ...(kind === "area" ? { areaStyle: { opacity: 0.15 } } : {}),
      emphasis: { focus: "series" }, data: item.values
    };
  });
  return {
    option: {
      ...base,
      grid: { left: 8, right: 16, top: legend ? 36 : 14, bottom: 8, containLabel: true },
      xAxis: horizontal ? valueAxis : categoryAxis,
      yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
      series: echartsSeries
    },
    problems, mapped, cutRows, foldedSeries: folded
  };
}

/** The option as the Mapping tab shows it: formatters by name (`ƒ axis:currency`), not code. */
export function optionJson(option: unknown): string {
  return JSON.stringify(option, (_key, value: unknown) => typeof value === "function" ? `ƒ ${(value as { formatterName?: string }).formatterName ?? "formatter"}` : value, 2);
}

/** The palette for the page's color scheme (the app is dark today; a light scheme gets the light steps). */
export function paletteFor(scheme: string | null | undefined): ChartPalette {
  return /\blight\b/.test(scheme ?? "") && !/\bdark\b/.test(scheme ?? "") ? CHART_PALETTES.light : CHART_PALETTES.dark;
}

/** The surface and text colors the page's CSS resolved (reportView.css tokens); empty values keep the palette's own. */
export type ThemeTokens = Partial<Record<"surface" | "text" | "muted" | "grid" | "axis" | "tooltipBg" | "tooltipBorder", string>>;

const usableColor = (value: string | undefined) => Boolean(value && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\))$/i.test(value.trim()));

/**
 * One theme source (review L4): the series hues come from the scheme's validated steps, and the
 * surface, text, grid, and tooltip colors from the same CSS tokens the page itself uses. Only plain
 * color values are taken (ECharts cannot read `var()` or `color-mix()`).
 */
export function themedPalette(scheme: string | null | undefined, tokens: ThemeTokens = {}): ChartPalette {
  const base = paletteFor(scheme);
  const picked = Object.fromEntries(Object.entries(tokens).filter(([, value]) => usableColor(value)).map(([key, value]) => [key, value!.trim()]));
  return { ...base, ...picked };
}
