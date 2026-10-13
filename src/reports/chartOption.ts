import { ordinalX, type AutoFix, type ChartBlock, type ChartKind, type ResultColumn, type ValueFormat } from "../../shared/reports";
import { chartHeight, EMPHASIS_MUTED, MARKS, MAX_SERIES, REPORT_INK, REPORT_SERIES, TYPE, type InkTokens, type ThemeMode } from "../../shared/reportTheme";

/**
 * ECharts options for report charts (plan wave 47, T367 "chart option injection"; theme wave 48b,
 * docs/plan/REPORT_THEME.md). Nook builds every option here from the validated block spec (kind, x,
 * y[], series, intent, format, unit, emphasis, compareTo) and the stored result rows, nothing else: no
 * option, colour, size, style, or formatter string ever comes from the spec or the model. Every colour
 * and mark is a token of shared/reportTheme.ts; the only formatters are this file's named functions,
 * picked by the format enum; every text that reaches the tooltip's HTML is escaped here. The inspect
 * panel's Mapping tab shows the same option (optionJson) and the auto-fixes applied.
 *
 * Pure: no DOM, so tests run it directly.
 */

/** The theme a chart is drawn in: the mode's tokens (one theme source: the root's colour-scheme). */
export type ChartTheme = { mode: ThemeMode; ink: InkTokens; series: readonly string[]; emphasisMuted: string; forcedColors: boolean };
/** Wave 47's name for the chart theme. */
export type ChartPalette = ChartTheme;

export function chartTheme(mode: ThemeMode, options: { forcedColors?: boolean } = {}): ChartTheme {
  return { mode, ink: REPORT_INK[mode], series: REPORT_SERIES[mode], emphasisMuted: EMPHASIS_MUTED[mode], forcedColors: options.forcedColors === true };
}

/** The mode for the page's colour-scheme (the app is dark today; a light scheme gets the light tokens). */
export const modeFor = (scheme: string | null | undefined): ThemeMode => /\blight\b/.test(scheme ?? "") && !/\bdark\b/.test(scheme ?? "") ? "light" : "dark";
/** The chart theme for a colour-scheme value. */
export const paletteFor = (scheme: string | null | undefined, options: { forcedColors?: boolean } = {}): ChartTheme => chartTheme(modeFor(scheme), options);

/** Points a chart draws at most (the stored result may hold 10,000 rows). */
export const MAX_CHART_POINTS = 2_000;
/** Series a chart colours; the rest fold into "Other" (top 7 + Other). */
export const MAX_CHART_SERIES = MAX_SERIES;
/** Bar categories before the fold (design rule 5): more than 20 keep the top 15 plus "Other". */
export const MAX_BAR_CATEGORIES = 20;
export const KEPT_BAR_CATEGORIES = 15;
export { ordinalX };
/** Bars that get a label at their tip (one series); more label only the largest. */
const TIP_LABELS = 12;

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
const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

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

/** The ISO 4217 code of a `currency:<ISO>` format, or null. */
export const currencyOf = (format: ValueFormat | undefined) => typeof format === "string" && /^currency:[A-Z]{3}$/.test(format) ? format.slice(9) : null;

const currencyFormats = new Map<string, { full: Intl.NumberFormat; whole: Intl.NumberFormat; compact: Intl.NumberFormat } | null>();
function currencyFormat(code: string) {
  if (!currencyFormats.has(code)) {
    try {
      currencyFormats.set(code, {
        full: new Intl.NumberFormat("en-US", { style: "currency", currency: code, maximumFractionDigits: 2 }),
        whole: new Intl.NumberFormat("en-US", { style: "currency", currency: code, maximumFractionDigits: 0 }),
        compact: new Intl.NumberFormat("en-US", { style: "currency", currency: code, notation: "compact", maximumFractionDigits: 1 })
      });
    } catch {
      currencyFormats.set(code, null);
    }
  }
  return currencyFormats.get(code) ?? null;
}

const withUnit = (text: string, unit: string | undefined) => unit && unit.trim() ? `${text} ${unit.trim()}` : text;

/** A value shown in full with a block's format and unit (tiles, tooltips, table cells). Unknown or non-numeric values show as text. */
export function formatValue(value: unknown, format: ValueFormat | undefined, unit?: string): string {
  if (value === null || value === undefined) return "—";
  if (format === "text" || format === undefined) {
    const number = toNumber(value);
    return number !== null && typeof value !== "string" ? withUnit(grouped(2).format(number), unit) : number !== null && unit ? withUnit(grouped(2).format(number), unit) : cellLabel(value);
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
  const code = currencyOf(format);
  if (code) {
    const formats = currencyFormat(code);
    return withUnit(formats ? formats.full.format(number) : `${code} ${fixed2.format(number)}`, unit);
  }
  switch (format) {
    case "integer": return withUnit(grouped(0).format(Math.round(number)), unit);
    case "percent": return `${grouped(1).format(number * 100)}%`;
    case "currency": return withUnit(fixed2.format(number), unit);
    case "bytes": return bytesText(number);
    case "duration_s": case "duration": return durationText(number);
    default: return withUnit(grouped(2).format(number), unit);
  }
}

/**
 * A compact value (axis ticks, direct labels, KPI values): 1,284 / 12.9K / $4.2M / 25% / 3h 20m.
 * Numbers below 10,000 keep their digits; larger ones compact to one decimal.
 */
export function compactValue(value: number, format: ValueFormat | undefined, unit?: string): string {
  if (format === "percent") return `${grouped(Math.abs(value) < 0.1 ? 1 : 0).format(value * 100)}%`;
  if (format === "bytes") return bytesText(value);
  if (format === "duration_s" || format === "duration") return durationText(value);
  const big = Math.abs(value) >= 10_000;
  const code = currencyOf(format);
  if (code) {
    const formats = currencyFormat(code);
    if (!formats) return withUnit(`${code} ${big ? compactNumber.format(value) : grouped(2).format(value)}`, unit);
    // Below 10,000: whole units from 100 (and for whole numbers), cents below that ($4,000, $0, $12.50).
    return withUnit(big ? formats.compact.format(value) : Math.abs(value) >= 100 || Number.isInteger(value) ? formats.whole.format(value) : formats.full.format(value), unit);
  }
  if (format === "integer") return withUnit(big ? compactNumber.format(value) : grouped(0).format(Math.round(value)), unit);
  // v1's plain "currency" (no code) kept its cents below the compaction threshold.
  if (format === "currency") return withUnit(big ? compactNumber.format(value) : fixed2.format(value), unit);
  return withUnit(big ? compactNumber.format(value) : grouped(Math.abs(value) >= 100 ? 0 : 2).format(value), unit);
}

/** Wave 47's axis label: the compact value. */
export const axisLabel = (value: number, format: ValueFormat | undefined) => compactValue(value, format);

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
  /** Bar categories folded into "Other" (rule 5). */
  foldedCategories: number;
  /** The fixes this build applied (fold, sort, compaction), as the Mapping tab lists them. */
  autoFixes: AutoFix[];
  /** The chart's fixed height, px (CHART_HEIGHTS by kind). */
  height: number;
};

/** The columns a chart block maps, by role. */
export function chartMapping(block: Pick<ChartBlock, "x" | "y" | "series" | "compareTo">): Record<string, string> {
  const mapped: Record<string, string> = { [block.x]: "x" };
  block.y.forEach((name, index) => { mapped[name] = block.y.length > 1 ? `y${index + 1}` : "y"; });
  if (block.series) mapped[block.series] = "series";
  if (block.compareTo && !block.compareTo.queryKey) mapped[block.compareTo.column] = "compare";
  return mapped;
}

type SeriesData = { name: string; values: Array<number | null> };

/** Splits long-format rows by the series column into one series of `y` per value; past MAX_CHART_SERIES the smallest fold into "Other". */
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
  // Keep the data's own order of appearance for the kept series, so colours follow the entity.
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

function tooltipFormatter(format: ValueFormat | undefined, unit: string | undefined, theme: ChartTheme, item: boolean) {
  return named(`tooltip:${format ?? "number"}`, (params: unknown) => {
    const list = (Array.isArray(params) ? params : [params]) as Array<{ seriesName?: string; name?: string; value?: unknown; color?: string; percent?: number }>;
    if (!list.length) return "";
    const head = escapeHtml(String(list[0]!.name ?? ""));
    const lines = list.map((entry) => {
      const raw = Array.isArray(entry.value) ? entry.value[entry.value.length - 1] : entry.value;
      const label = item && entry.seriesName && entry.name && !Array.isArray(entry.value) ? entry.name : entry.seriesName ?? "";
      const swatch = `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${/^#[0-9a-f]{6}$/i.test(entry.color ?? "") ? entry.color : theme.ink.muted}"></span>`;
      const percent = typeof entry.percent === "number" ? ` (${grouped(1).format(entry.percent)}%)` : "";
      return `<div>${swatch}${escapeHtml(String(label))}: <b>${escapeHtml(formatValue(raw, format, unit))}</b>${percent}</div>`;
    });
    return `${item ? "" : `<div style="color:${theme.ink.muted};margin-bottom:4px">${head}</div>`}${lines.join("")}`;
  });
}

const BAR_KINDS: readonly ChartKind[] = ["bar", "stacked_bar", "horizontal_bar"];

/** The forced-colors texture fills (45° and 135° hatches), only under `forced-colors`. */
const TEXTURE_DECALS = MARKS.textureAngles.map((rotation) => ({ symbol: "rect", dashArrayX: [1, 0], dashArrayY: [2, 4], rotation }));

/**
 * The option for a chart block over a result. Missing or non-numeric mapped columns are problems
 * (the block shows them instead of a chart); nothing in the option comes from the spec but column
 * names and category values, which ECharts renders as text, and the enum values chosen here.
 */
export function buildChartOption(block: ChartBlock, data: ChartData, theme: ChartTheme): ChartBuild {
  const mapped = chartMapping(block);
  const problems: string[] = [];
  const index = (name: string) => data.columns.findIndex((column) => column.name === name);
  const xi = index(block.x);
  const yis = block.y.map(index);
  const si = block.series ? index(block.series) : -1;
  const ci = block.compareTo && !block.compareTo.queryKey ? index(block.compareTo.column) : -1;
  if (xi < 0) problems.push(`The result has no column "${block.x}" for x`);
  block.y.forEach((name, at) => { if (yis[at]! < 0) problems.push(`The result has no column "${name}" for y`); });
  if (block.series && si < 0) problems.push(`The result has no column "${block.series}" for the series`);
  if (!block.y.length) problems.push("The chart maps no y column");
  const empty = { mapped, cutRows: 0, foldedSeries: 0, foldedCategories: 0, autoFixes: [], height: chartHeight(block.kind) };
  if (problems.length) return { option: null, problems, ...empty };

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
  let compare: SeriesData | null = ci >= 0 && si < 0 ? { name: block.compareTo!.column, values: rows.map((row) => toNumber(row[ci])) } : null;
  if (series.every((item) => item.values.every((value) => value === null))) problems.push("The y columns hold no numbers");
  const autoFixes: AutoFix[] = [];
  if (folded > 0) autoFixes.push({ rule: "fold_series", detail: `${folded + (si >= 0 ? 1 : 0)} series folded into "Other" (top ${MAX_CHART_SERIES - 1} kept)` });

  const kind = block.kind;
  const bars = BAR_KINDS.includes(kind);
  // Bars: sorted descending by their total unless x is ordinal or time; past 20 categories the top 15 and "Other".
  let foldedCategories = 0;
  if (bars && !ordinalX(block, data.columns) && categories.length > 1) {
    const totals = categories.map((_, at) => series.reduce((sum, item) => sum + (item.values[at] ?? 0), 0));
    const order = categories.map((_, at) => at).sort((left, right) => totals[right]! - totals[left]!);
    if (order.some((at, position) => at !== position)) autoFixes.push({ rule: "sort", detail: "Bars sorted descending" });
    const reorder = (values: Array<number | null>) => order.map((at) => values[at] ?? null);
    categories = order.map((at) => categories[at]!);
    series = series.map((item) => ({ ...item, values: reorder(item.values) }));
    if (compare) compare = { ...compare, values: reorder(compare.values) };
    if (categories.length > MAX_BAR_CATEGORIES) {
      foldedCategories = categories.length - KEPT_BAR_CATEGORIES;
      const fold = (values: Array<number | null>) => [...values.slice(0, KEPT_BAR_CATEGORIES), values.slice(KEPT_BAR_CATEGORIES).reduce<number | null>((sum, value) => value === null ? sum : (sum ?? 0) + value, null)];
      categories = [...categories.slice(0, KEPT_BAR_CATEGORIES), "Other"];
      series = series.map((item) => ({ ...item, values: fold(item.values) }));
      if (compare) compare = { ...compare, values: fold(compare.values) };
      autoFixes.push({ rule: "fold_categories", detail: `${foldedCategories} categories folded into "Other" (top ${KEPT_BAR_CATEGORIES} kept)` });
    }
  }
  const magnitude = Math.max(0, ...series.flatMap((item) => item.values.map((value) => Math.abs(value ?? 0))));
  if (magnitude >= 10_000) autoFixes.push({ rule: "compact", detail: `Numbers compacted (${compactValue(magnitude, block.format, block.unit)})` });

  const format = block.format;
  const unit = block.unit;
  const ink = theme.ink;
  // Emphasis mode: a series by name, or (one series) a category, in slot 1; everything else grey.
  const emphasisSeries = block.emphasis !== undefined && series.some((item) => item.name === block.emphasis) ? block.emphasis : null;
  const emphasisCategory = block.emphasis !== undefined && emphasisSeries === null && series.length === 1 && (bars || kind === "pie") && categories.includes(block.emphasis) ? block.emphasis : null;
  const colorOf = (at: number, name: string) => emphasisSeries !== null ? (name === emphasisSeries ? theme.series[0]! : theme.emphasisMuted) : emphasisCategory !== null ? theme.emphasisMuted : theme.series[at % theme.series.length]!;
  const legend = series.length >= 2 || (kind === "pie" && categories.length >= 2);
  const lineLike = kind === "line" || kind === "area";
  const itemTooltip = !lineLike;
  const compactLabel = named(`label:${format ?? "number"}`, (params: { value?: unknown }) => {
    const raw = Array.isArray(params.value) ? params.value[params.value.length - 1] : params.value;
    const number = toNumber(raw);
    return number === null ? "" : compactValue(number, format, unit);
  });
  const base: Record<string, unknown> = {
    backgroundColor: "transparent",
    color: series.map((item, at) => colorOf(at, item.name)),
    animation: rows.length <= 500,
    textStyle: { color: ink.ink, fontFamily: TYPE.font, fontSize: TYPE.body.size },
    tooltip: {
      trigger: itemTooltip ? "item" : "axis",
      // Tap shows the tooltip on touch screens.
      triggerOn: "mousemove|click",
      backgroundColor: ink.tooltip, borderColor: ink.border, borderWidth: 1, textStyle: { color: ink.ink, fontSize: 12 },
      ...(lineLike ? { axisPointer: { type: "line", lineStyle: { color: ink.axis, width: 1 } } } : {}),
      confine: true,
      formatter: tooltipFormatter(format, unit, theme, itemTooltip)
    },
    legend: legend ? { show: true, top: 0, left: 0, type: "scroll", icon: "roundRect", itemWidth: 10, itemHeight: 10, itemGap: 16, textStyle: { color: ink.inkSecondary, fontSize: TYPE.axis.size }, pageTextStyle: { color: ink.muted } } : { show: false },
    ...(theme.forcedColors ? { aria: { enabled: true, decal: { show: true, decals: TEXTURE_DECALS } } } : {})
  };
  const result = (option: Record<string, unknown>, categoriesShown: number): ChartBuild => ({ option, problems, mapped, cutRows, foldedSeries: folded, foldedCategories, autoFixes, height: chartHeight(kind, categoriesShown) });

  if (kind === "pie") {
    const first = series[0]!;
    const slices = categories.map((name, at) => ({ name, value: first.values[at] ?? 0 })).filter((item) => item.value > 0);
    return result({
      ...base,
      color: slices.map((slice, at) => emphasisCategory !== null ? (slice.name === emphasisCategory ? theme.series[0]! : theme.emphasisMuted) : theme.series[at % theme.series.length]!),
      series: [{
        type: "pie", name: first.name, radius: ["45%", "72%"], center: ["50%", legend ? "56%" : "50%"], avoidLabelOverlap: true,
        itemStyle: { borderColor: ink.surface, borderWidth: MARKS.bar.gap, borderRadius: MARKS.bar.radius },
        label: { show: false }, labelLine: { show: false },
        data: slices
      }]
    }, slices.length);
  }

  const horizontal = kind === "horizontal_bar";
  const valueAxis = {
    type: "value",
    axisLabel: { color: ink.muted, fontSize: TYPE.axis.size, formatter: named(`axis:${format ?? "number"}`, (value: number) => compactValue(value, format)) },
    // Gridlines are horizontal only: a horizontal bar chart's value axis runs across, so it has none.
    splitLine: { show: !horizontal, lineStyle: { color: ink.grid, width: MARKS.grid.width, type: "solid" } },
    axisLine: { show: false }, axisTick: { show: false }
  };
  const numericX = kind === "scatter" && rows.every((row) => toNumber(row[xi]) !== null);
  const categoryAxis = numericX
    ? { type: "value", axisLabel: { color: ink.muted, fontSize: TYPE.axis.size }, splitLine: { show: false }, axisLine: { lineStyle: { color: ink.axis } } }
    : { type: "category", data: categories, boundaryGap: bars, axisLabel: { color: ink.muted, fontSize: TYPE.axis.size, hideOverlap: true }, axisLine: { lineStyle: { color: ink.axis } }, axisTick: { show: false }, splitLine: { show: false } };

  const lastIndex = (values: Array<number | null>) => { for (let at = values.length - 1; at >= 0; at -= 1) if (values[at] !== null) return at; return -1; };
  const maxIndex = (values: Array<number | null>) => values.reduce<number>((best, value, at) => value !== null && (best < 0 || value > (values[best] ?? -Infinity)) ? at : best, -1);
  const labelStyle = { color: ink.inkSecondary, fontSize: TYPE.label.size, formatter: compactLabel };
  const stackedLast = series.length - 1;
  const echartsSeries: Array<Record<string, unknown>> = series.map((item, at) => {
    const color = colorOf(at, item.name);
    if (kind === "scatter") {
      return { type: "scatter", name: item.name, symbolSize: 8, itemStyle: { color, borderColor: ink.surface, borderWidth: 1 }, data: numericX ? rows.map((row, position) => [toNumber(row[xi]), item.values[position]]) : item.values };
    }
    if (bars) {
      const rounded = kind !== "stacked_bar" || at === stackedLast;
      const radius = !rounded ? 0 : horizontal ? [0, MARKS.bar.radius, MARKS.bar.radius, 0] : [MARKS.bar.radius, MARKS.bar.radius, 0, 0];
      const top = maxIndex(item.values);
      const tips = series.length === 1 && kind !== "stacked_bar";
      return {
        type: "bar", name: item.name, barMaxWidth: MARKS.bar.maxThickness, ...(kind === "stacked_bar" ? { stack: "total" } : {}),
        // A 2 px gap in the surface colour between touching bars and stack segments (1 px border each side).
        itemStyle: { color, borderRadius: radius, borderColor: ink.surface, borderWidth: MARKS.bar.gap / 2 },
        emphasis: { focus: "series" },
        label: { show: tips && categories.length <= TIP_LABELS, position: horizontal ? "right" : "top", ...labelStyle },
        data: item.values.map((value, position) => {
          const highlight = emphasisCategory !== null && categories[position] === emphasisCategory;
          const extreme = tips && categories.length > TIP_LABELS && position === top;
          if (!highlight && !extreme) return value;
          return { value, ...(highlight ? { itemStyle: { color: theme.series[0] } } : {}), ...(extreme ? { label: { show: true, position: horizontal ? "right" : "top", ...labelStyle } } : {}) };
        })
      };
    }
    const end = lastIndex(item.values);
    const top = series.length === 1 ? maxIndex(item.values) : -1;
    return {
      type: "line", name: item.name, symbol: "none", showSymbol: true, connectNulls: false,
      lineStyle: { width: MARKS.line.width, join: "round", cap: "round", color }, itemStyle: { color },
      ...(kind === "area" ? { areaStyle: { color, opacity: MARKS.areaOpacity } } : {}),
      emphasis: { focus: "series" },
      // Direct labels on the line's end and (one series) its maximum; the end dot wears a ring in the surface colour.
      endLabel: { show: emphasisSeries === null || item.name === emphasisSeries, ...labelStyle, distance: 6 },
      data: item.values.map((value, position) => {
        if (position === end) return { value, symbol: "circle", symbolSize: MARKS.line.dotRadius * 2, itemStyle: { color, borderColor: ink.surface, borderWidth: MARKS.line.dotRing } };
        if (position === top && top !== end) return { value, symbol: "circle", symbolSize: 6, itemStyle: { color, borderColor: ink.surface, borderWidth: MARKS.line.dotRing }, label: { show: true, position: "top", ...labelStyle } };
        return value;
      })
    };
  });
  if (compare) {
    echartsSeries.push(bars
      ? { type: "bar", name: compare.name, barMaxWidth: MARKS.bar.maxThickness, itemStyle: { color: theme.emphasisMuted, borderRadius: horizontal ? [0, MARKS.bar.radius, MARKS.bar.radius, 0] : [MARKS.bar.radius, MARKS.bar.radius, 0, 0], borderColor: ink.surface, borderWidth: MARKS.bar.gap / 2 }, data: compare.values }
      : { type: "line", name: compare.name, symbol: "none", lineStyle: { width: MARKS.line.width, type: "dashed", color: theme.emphasisMuted }, itemStyle: { color: theme.emphasisMuted }, data: compare.values });
    (base.color as string[]).push(theme.emphasisMuted);
  }
  const withLegend = legend || compare !== null;
  return result({
    ...base,
    ...(compare && !legend ? { legend: { ...(base.legend as object), show: true, top: 0, left: 0, type: "scroll", icon: "roundRect", itemWidth: 10, itemHeight: 10, itemGap: 16, textStyle: { color: ink.inkSecondary, fontSize: TYPE.axis.size } } } : {}),
    grid: { left: 8, right: lineLike ? 56 : horizontal ? 84 : 16, top: withLegend ? 36 : 18, bottom: 8, containLabel: true },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
    series: echartsSeries
  }, categories.length);
}

/** The option as the Mapping tab shows it: formatters by name (`ƒ axis:currency`), not code. */
export function optionJson(option: unknown): string {
  return JSON.stringify(option, (_key, value: unknown) => typeof value === "function" ? `ƒ ${(value as { formatterName?: string }).formatterName ?? "formatter"}` : value, 2);
}

/** Human text for an auto-fix rule (the Mapping tab). */
export const AUTO_FIX_TEXT: Record<AutoFix["rule"], string> = { fold_series: "Series folded", fold_categories: "Categories folded", sort: "Sorted", compact: "Compacted" };
