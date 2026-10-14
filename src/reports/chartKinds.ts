import { isNumericType, isTimeType, ordinalX, type AutoFix, type ChartBlock, type ChartKind, type ValueFormat } from "../../shared/reports";
import {
  BULLET_BANDS, chartHeight, CHART_HEIGHTS, HEATMAP_MIN_CELL, inkOn, MARKS, MAX_FACETS, MAX_SCATTER_SERIES, MAX_SERIES, METER, ordinalRamp, sequentialRamp, divergingRamp,
  STATUS, TYPE, waterfallColors
} from "../../shared/reportTheme";
import { boxStats, findCycle, histogramBins } from "../../shared/reportStats";
import {
  cellLabel, compactValue, escapeHtml, formatValue, MAX_CHART_POINTS, named, TEXTURE_DECALS, toNumber,
  type ChartBuild, type ChartData, type ChartSize, type ChartTheme
} from "./chartOption";

/**
 * Chart kinds, round 2 (docs/plan/REPORT_THEME.md § Chart kinds, round 2; D462–D468): heatmap,
 * calendar, funnel, gauge (an HTML meter), treemap, sankey, boxplot, histogram, waterfall, combo,
 * bullet, and small multiples (`facet`, and the auto-fix for too many line or scatter series).
 *
 * The same contract as chartOption.ts: every option is built here from the validated block and the
 * result rows; every colour is a token of shared/reportTheme.ts; the only formatters are the named
 * functions below (`ƒ name` in the Mapping tab), chosen by the block's format enum; every text that
 * reaches tooltip HTML is escaped. Text uses ink tokens, never a series colour, except labels set
 * inside a coloured fill, which take dark ink or white by the fill's contrast (`inkOn`).
 *
 * Pure: no DOM. Functions only are imported from chartOption.ts (the two modules import each other).
 */

export const ROUND_TWO_KINDS: ReadonlySet<ChartKind> = new Set<ChartKind>(["heatmap", "calendar", "funnel", "gauge", "treemap", "sankey", "boxplot", "histogram", "waterfall", "combo", "bullet"]);

/** Heatmap and calendar colour steps (a stepped scale reads more exactly than a gradient). */
const SCALE_STEPS = 7;
/** Labels on heatmap cells only up to this many columns, and when a cell is at least this wide. */
const CELL_LABEL_COLUMNS = 16;
const CELL_LABEL_WIDTH = 34;

/** The meter the gauge kind draws (HTML, ReportView's MeterView); the Mapping tab shows it as the option. */
export type MeterModel = {
  type: "meter";
  name: string;
  value: number;
  valueText: string;
  /** The scale's end, and the fill's share of it (0–1). */
  scaleMax: number;
  ratio: number;
  target: number | null;
  targetText: string | null;
  /** The target's place on the scale (0–1). */
  targetRatio: number | null;
  /** "62% of target" or "62% of max". */
  caption: string;
  fill: string;
  track: string;
  /** Present only with a target: a tone, its icon, and its label (status colour never stands alone). */
  status: { tone: "good" | "warning" | "critical"; icon: "check" | "alert" | "cross"; label: string; color: string } | null;
};

const columnOf = (data: ChartData, name: string | undefined) => name === undefined ? -1 : data.columns.findIndex((column) => column.name === name);
const typeOf = (data: ChartData, name: string | undefined) => data.columns[columnOf(data, name)]?.type ?? "";
/** Distinct labels in order of first appearance (numbers and dates ascending when the column is one). */
function distinctLabels(data: ChartData, index: number): string[] {
  const seen: string[] = [];
  const set = new Set<string>();
  for (const row of data.rows) {
    const label = cellLabel(row[index]);
    if (!set.has(label)) { set.add(label); seen.push(label); }
  }
  const type = data.columns[index]?.type ?? "";
  if (isNumericType(type)) return seen.sort((left, right) => Number(left) - Number(right));
  if (isTimeType(type)) return seen.sort();
  return seen;
}
const swatch = (color: string, theme: ChartTheme) => `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${/^#[0-9a-f]{6}$/i.test(color) ? color : theme.ink.muted}"></span>`;
const head = (text: string, theme: ChartTheme) => `<div style="color:${theme.ink.muted};margin-bottom:4px">${escapeHtml(text)}</div>`;
const line = (label: string, value: string) => `<div>${escapeHtml(label)}: <b>${escapeHtml(value)}</b></div>`;
const share = (part: number, whole: number) => whole ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format((part / whole) * 100)}%` : "—";
/** A hex colour at an opacity (box fills). */
const withAlpha = (hex: string, alpha: number) => /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${Math.round(alpha * 255).toString(16).padStart(2, "0")}` : hex;
/** A round number at or above `value` for shared axes (1, 2, 2.5, 5 × 10^n). */
export function niceCeil(value: number): number {
  if (value <= 0) return 0;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * power >= value - 1e-9) ?? 10;
  return step * power;
}

/** The option every kind starts from: transparent, theme text, a tooltip that a tap opens, forced-colors textures. */
function baseOption(theme: ChartTheme, formatter: (params: unknown) => string, trigger: "item" | "axis" = "item"): Record<string, unknown> {
  const ink = theme.ink;
  return {
    backgroundColor: "transparent",
    animation: false,
    textStyle: { color: ink.ink, fontFamily: TYPE.font, fontSize: TYPE.body.size },
    tooltip: {
      trigger, triggerOn: "mousemove|click", confine: true,
      backgroundColor: ink.tooltip, borderColor: ink.border, borderWidth: 1, textStyle: { color: ink.ink, fontSize: 12 },
      ...(trigger === "axis" ? { axisPointer: { type: "line", lineStyle: { color: ink.axis, width: 1 } } } : {}),
      formatter
    },
    ...(theme.forcedColors ? { aria: { enabled: true, decal: { show: true, decals: TEXTURE_DECALS } } } : {})
  };
}
const legendOption = (theme: ChartTheme) => ({ show: true, top: 0, left: 0, type: "scroll", icon: "roundRect", itemWidth: 10, itemHeight: 10, itemGap: 16, textStyle: { color: theme.ink.inkSecondary, fontSize: TYPE.axis.size }, pageTextStyle: { color: theme.ink.muted } });
const axisText = (theme: ChartTheme) => ({ color: theme.ink.muted, fontSize: TYPE.axis.size });
function valueAxis(theme: ChartTheme, format: ValueFormat | undefined, options: { grid?: boolean; name?: string } = {}) {
  return {
    type: "value",
    axisLabel: { ...axisText(theme), formatter: named(`axis:${format ?? "number"}`, (value: number) => compactValue(value, format)) },
    splitLine: { show: options.grid !== false, lineStyle: { color: theme.ink.grid, width: MARKS.grid.width, type: "solid" } },
    axisLine: { show: false }, axisTick: { show: false }
  };
}
const categoryAxis = (theme: ChartTheme, data: string[], extra: Record<string, unknown> = {}) => ({
  type: "category", data, axisLabel: { ...axisText(theme), hideOverlap: true }, axisLine: { lineStyle: { color: theme.ink.axis } }, axisTick: { show: false }, splitLine: { show: false }, ...extra
});
const labelStyle = (theme: ChartTheme) => ({ color: theme.ink.inkSecondary, fontSize: TYPE.label.size });

/** The columns a round-2 block maps, by role (the Data tab highlights them; the Mapping tab names the roles). */
export function roundTwoMapping(block: ChartBlock): Record<string, string> {
  const mapped: Record<string, string> = {};
  const put = (name: string | undefined, role: string) => { if (name !== undefined && !(name in mapped)) mapped[name] = role; };
  switch (block.kind) {
    case "heatmap": put(block.x, "columns"); put(block.x2, block.cohort ? "cohort" : "rows"); put(block.y[0], "value"); break;
    case "calendar": put(block.x, "date"); put(block.y[0], "value"); break;
    case "funnel": put(block.x, "stage"); put(block.y[0], "value"); break;
    case "gauge": put(block.y[0], "value"); put(block.target, "target"); break;
    case "treemap": put(block.x, "group"); put(block.x2, "subgroup"); put(block.y[0], "value"); break;
    case "sankey": put(block.x, "source"); put(block.x2, "target"); put(block.y[0], "flow"); break;
    case "boxplot": put(block.x, "category"); if (block.y.length === 5) ["min", "q1", "median", "q3", "max"].forEach((role, at) => put(block.y[at], role)); else put(block.y[0], "values"); break;
    case "histogram": put(block.y[0], "values"); break;
    case "waterfall": put(block.x, "step"); put(block.y[0], "delta"); break;
    case "combo": put(block.x, "x"); put(block.y[0], "bar"); put(block.y[1], "line"); break;
    case "bullet": put(block.x, "category"); put(block.y[0], "actual"); put(block.target, "target"); (block.ranges ?? []).forEach((name, at) => put(name, `range ${at + 1}`)); break;
    default: break;
  }
  return mapped;
}

/** The round-2 kinds: checks the mapped columns, then hands the rows to the kind's builder. */
export function buildRoundTwo(block: ChartBlock, data: ChartData, theme: ChartTheme, size: ChartSize): ChartBuild {
  const mapped = roundTwoMapping(block);
  const problems: string[] = [];
  for (const [name, role] of Object.entries(mapped)) if (columnOf(data, name) < 0) problems.push(`The result has no column "${name}" for ${role}`);
  const done = (partial: Partial<ChartBuild> & { option: Record<string, unknown> | null; height: number }): ChartBuild => ({ problems, mapped, cutRows: 0, foldedSeries: 0, foldedCategories: 0, autoFixes: [], ...partial });
  if (problems.length) return done({ option: null, height: chartHeight(block.kind) });
  if (!data.rows.length) { problems.push("The query returned no rows"); return done({ option: null, height: chartHeight(block.kind) }); }
  const builder = BUILDERS[block.kind];
  const built = builder ? builder(block, data, theme, size.width ?? 640) : null;
  if (!built) return done({ option: null, height: chartHeight(block.kind) });
  if (built.problem) { problems.push(built.problem); return done({ option: null, height: chartHeight(block.kind) }); }
  return done(built);
}

type Built = Partial<ChartBuild> & { option: Record<string, unknown> | null; height: number; problem?: string };
type Builder = (block: ChartBlock, data: ChartData, theme: ChartTheme, width: number) => Built;

// ---------------------------------------------------------------------------- value-coloured grids

/** Stepped colours for a value range: sequential, or diverging around `midpoint` when values fall on both sides. */
export function valueScale(values: number[], theme: ChartTheme, format: ValueFormat | undefined, midpoint?: number) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const diverging = midpoint !== undefined && min < midpoint && max > midpoint;
  const colors = diverging ? divergingRamp(theme.mode) : sequentialRamp(theme.mode, SCALE_STEPS);
  const steps = colors.length;
  let low = min;
  let width = (max - min) / steps || 1;
  if (diverging) {
    const reach = Math.max(max - midpoint!, midpoint! - min);
    width = (2 * reach) / steps;
    low = midpoint! - reach;
  }
  const bucket = (value: number) => Math.min(steps - 1, Math.max(0, Math.floor((value - low) / width)));
  const legend = colors.map((color, at) => ({ color, label: `${compactValue(low + at * width, format)}–${compactValue(low + (at + 1) * width, format)}`, from: compactValue(low + at * width, format), to: compactValue(at === steps - 1 && !diverging ? max : low + (at + 1) * width, format) }));
  return { bucket, colors, legend, diverging };
}
/** The visualMap ECharts needs to colour a heatmap: hidden, one exact piece per step (the 4th data value). */
const visualMapOf = (colors: string[]) => ({ type: "piecewise", show: false, dimension: 3, seriesIndex: 0, pieces: colors.map((color, value) => ({ value, color })) });

const heatmap: Builder = (block, data, theme, width) => {
  const xi = columnOf(data, block.x);
  const ri = columnOf(data, block.x2);
  const vi = columnOf(data, block.y[0]);
  const columns = distinctLabels(data, xi);
  // Cohorts keep their order; a plain matrix orders numbers and dates.
  const rows = block.cohort ? [...new Set(data.rows.map((row) => cellLabel(row[ri])))] : distinctLabels(data, ri);
  const cells = new Map<string, number>();
  for (const row of data.rows) {
    const value = toNumber(row[vi]);
    if (value === null) continue;
    const key = `${columns.indexOf(cellLabel(row[xi]))}:${rows.indexOf(cellLabel(row[ri]))}`;
    cells.set(key, (cells.get(key) ?? 0) + value);
  }
  if (!cells.size) return { option: null, height: chartHeight("heatmap"), problem: "The value column holds no numbers" };
  const format = block.format;
  // Cohorts: the first period is everyone (100 %), so it would squeeze every later period into the
  // low steps; the scale is made from the later periods and the first column takes the top step.
  const scaled = block.cohort && columns.length > 2 ? [...cells.entries()].filter(([key]) => !key.startsWith("0:")).map(([, value]) => value) : [...cells.values()];
  const scale = valueScale(scaled, theme, format, block.midpoint);
  const labelWidth = Math.min(120, 12 + Math.max(...rows.map((name) => name.length)) * 6.5);
  const minWidth = Math.ceil(labelWidth + columns.length * HEATMAP_MIN_CELL + 16);
  const cellWidth = (Math.max(width, minWidth) - labelWidth - 16) / Math.max(1, columns.length);
  const labels = columns.length <= CELL_LABEL_COLUMNS && cellWidth >= CELL_LABEL_WIDTH;
  const cellText = named(`cell:${format ?? "number"}`, (params: { value?: unknown[] }) => {
    const value = toNumber(Array.isArray(params.value) ? params.value[2] : null);
    return value === null ? "" : compactValue(value, format);
  });
  const points = [...cells.entries()].map(([key, value]) => {
    const [x, y] = key.split(":").map(Number) as [number, number];
    const step = scale.bucket(value);
    return { value: [x, y, value, step], label: { color: inkOn(scale.colors[step]!) } };
  });
  return {
    option: {
      ...baseOption(theme, named(`tooltip:heatmap:${format ?? "number"}`, (params: unknown) => {
        const value = (params as { value?: unknown[] }).value ?? [];
        return head(`${rows[Number(value[1])] ?? ""} · ${columns[Number(value[0])] ?? ""}`, theme) + line(block.y[0]!, formatValue(value[2], format, block.unit));
      })),
      grid: { left: 8, right: 8, top: 28, bottom: 8, containLabel: true },
      xAxis: categoryAxis(theme, columns, { position: "top", axisLine: { show: false }, splitArea: { show: false } }),
      yAxis: categoryAxis(theme, rows, { inverse: true, axisLine: { show: false }, axisLabel: { ...axisText(theme), width: labelWidth - 12, overflow: "truncate" } }),
      visualMap: visualMapOf(scale.colors),
      series: [{
        type: "heatmap", name: block.y[0], data: points,
        itemStyle: { borderColor: theme.ink.surface, borderWidth: MARKS.bar.gap, borderRadius: 2 },
        label: { show: labels, fontSize: TYPE.label.size, formatter: cellText },
        emphasis: { itemStyle: { borderColor: theme.ink.ink, borderWidth: 1 } }
      }]
    },
    height: chartHeight("heatmap", rows.length),
    minWidth: minWidth > width ? minWidth : undefined,
    scale: scale.legend
  };
};

const calendar: Builder = (block, data, theme, width) => {
  const xi = columnOf(data, block.x);
  const vi = columnOf(data, block.y[0]);
  const days = new Map<string, number>();
  for (const row of data.rows) {
    const day = String(row[xi] ?? "").slice(0, 10);
    const value = toNumber(row[vi]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || value === null) continue;
    days.set(day, (days.get(day) ?? 0) + value);
  }
  if (!days.size) return { option: null, height: chartHeight("calendar"), problem: "The date column holds no dates with values" };
  const sorted = [...days.keys()].sort();
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const span = (Date.parse(last) - Date.parse(first)) / 86_400_000;
  // Up to ~7 months: one calendar over the range; longer: one per year.
  const ranges = span <= 214 ? [[first, last]] : [...new Set(sorted.map((day) => day.slice(0, 4)))].map((year) => [year > first.slice(0, 4) ? `${year}-01-01` : first, year < last.slice(0, 4) ? `${year}-12-31` : last]);
  const weeks = Math.max(...ranges.map(([from, to]) => Math.ceil(((Date.parse(to!) - Date.parse(from!)) / 86_400_000 + 7) / 7)));
  const minWidth = 48 + weeks * 13;
  const format = block.format;
  const scale = valueScale([...days.values()], theme, format);
  const ink = theme.ink;
  const calendars = ranges.map(([from, to], at) => ({
    range: [from, to], top: 28 + at * CHART_HEIGHTS.calendarYear, left: 40, right: 8, cellSize: ["auto", 14], orient: "horizontal",
    splitLine: { show: false }, itemStyle: { color: ink.grid, borderColor: ink.surface, borderWidth: MARKS.bar.gap },
    dayLabel: { firstDay: 1, nameMap: ["S", "M", "T", "W", "T", "F", "S"], ...axisText(theme), fontSize: TYPE.label.size },
    monthLabel: { ...axisText(theme) }, yearLabel: { show: ranges.length > 1, ...axisText(theme), position: "left", margin: 28 }
  }));
  const series = ranges.map(([from, to], at) => ({
    type: "heatmap", coordinateSystem: "calendar", calendarIndex: at, name: block.y[0],
    data: sorted.filter((day) => day >= from! && day <= to!).map((day) => [day, days.get(day)!, 0, scale.bucket(days.get(day)!)]),
    itemStyle: { borderColor: ink.surface, borderWidth: MARKS.bar.gap, borderRadius: 2 }
  }));
  return {
    option: {
      ...baseOption(theme, named(`tooltip:calendar:${format ?? "number"}`, (params: unknown) => {
        const value = (params as { value?: unknown[] }).value ?? [];
        return head(String(value[0] ?? ""), theme) + line(block.y[0]!, formatValue(value[1], format, block.unit));
      })),
      calendar: calendars,
      visualMap: { ...visualMapOf(scale.colors), seriesIndex: series.map((_, at) => at) },
      series
    },
    height: chartHeight("calendar", ranges.length),
    minWidth: minWidth > width ? minWidth : undefined,
    scale: scale.legend
  };
};

// ------------------------------------------------------------------------------------ ordered flows

const funnel: Builder = (block, data, theme, width) => {
  const xi = columnOf(data, block.x);
  const vi = columnOf(data, block.y[0]);
  // Stage order is the rows' order, never re-sorted (D465).
  const stages = data.rows.map((row) => ({ name: cellLabel(row[xi]), value: toNumber(row[vi]) ?? 0 }));
  const colors = ordinalRamp(theme.mode, stages.length);
  const format = block.format;
  const top = stages[0]?.value ?? 0;
  const conversion = stages.map((stage, at) => ({ previous: at ? share(stage.value, stages[at - 1]!.value) : null, overall: share(stage.value, top) }));
  const stageLabel = named(`label:funnel:${format ?? "number"}`, (params: { dataIndex?: number; name?: string; value?: unknown }) => {
    const at = params.dataIndex ?? 0;
    const value = toNumber(params.value);
    return `{name|${String(params.name ?? "").slice(0, 28)}}\n{value|${value === null ? "" : compactValue(value, format, block.unit)}${at ? ` · ${conversion[at]!.previous}` : ""}}`;
  });
  return {
    option: {
      ...baseOption(theme, named(`tooltip:funnel:${format ?? "number"}`, (params: unknown) => {
        const entry = params as { dataIndex?: number; name?: string; value?: unknown };
        const at = entry.dataIndex ?? 0;
        return head(String(entry.name ?? ""), theme) + line(block.y[0]!, formatValue(entry.value, format, block.unit))
          + (at ? line("From the previous stage", conversion[at]!.previous!) : "") + line("Of the first stage", conversion[at]!.overall);
      })),
      color: colors,
      series: [{
        type: "funnel", name: block.y[0], sort: "none", orient: "vertical", funnelAlign: "left",
        left: 4, top: 6, bottom: 6, width: "46%", min: 0, max: top || 1, minSize: "2%", maxSize: "100%", gap: MARKS.bar.gap,
        itemStyle: { borderColor: theme.ink.surface, borderWidth: 0, borderRadius: 2 },
        label: {
          show: true, position: "right", formatter: stageLabel,
          rich: { name: { color: theme.ink.ink, fontSize: TYPE.axis.size, fontWeight: 600, lineHeight: 14 }, value: { color: theme.ink.inkSecondary, fontSize: TYPE.label.size, lineHeight: 13 } }
        },
        // Every label in one column right of the widest stage, joined to its stage by a hairline.
        labelLayout: { x: Math.round(width * 0.46) + 16, align: "left", moveOverlap: "shiftY" },
        labelLine: { show: true, length: 8, lineStyle: { color: theme.ink.axis, width: 1 } },
        emphasis: { label: { show: true } },
        data: stages.map((stage, at) => ({ ...stage, itemStyle: { color: colors[at] } }))
      }]
    },
    height: Math.max(CHART_HEIGHTS.funnel, stages.length * 36 + 12)
  };
};

/** The gauge kind as a meter (choosing-a-form.md § Meter): value, scale, target, and a status with icon and label. */
export function meterModel(block: ChartBlock, data: ChartData, theme: ChartTheme): MeterModel | string {
  const row = data.rows[0] ?? [];
  const value = toNumber(row[columnOf(data, block.y[0])]);
  if (value === null) return "The value is not a number";
  const target = block.target ? toNumber(row[columnOf(data, block.target)]) : null;
  if (block.target && (target === null || target <= 0)) return "The target is not a number above 0";
  const scaleMax = block.max ?? (target !== null ? Math.max(target * 1.2, value) : Math.max(value, 1));
  const ratio = Math.min(1, Math.max(0, value / scaleMax));
  const format = block.format;
  let status: MeterModel["status"] = null;
  if (target !== null) {
    const attained = value / target;
    const up = block.upIsGood !== false;
    const tone = up ? (attained >= 1 ? "good" : attained >= 0.8 ? "warning" : "critical") : (attained <= 1 ? "good" : attained <= 1.2 ? "warning" : "critical");
    const label = up ? { good: "On target", warning: "Near target", critical: "Below target" }[tone] : { good: "Within target", warning: "Over target", critical: "Well over target" }[tone];
    status = { tone, icon: tone === "good" ? "check" : tone === "warning" ? "alert" : "cross", label, color: tone === "good" ? STATUS.good : tone === "warning" ? STATUS.warning : STATUS.critical };
  }
  const meter = METER[theme.mode];
  return {
    type: "meter", name: block.y[0]!, value, valueText: compactValue(value, format, block.unit), scaleMax, ratio,
    target, targetText: target === null ? null : compactValue(target, format, block.unit), targetRatio: target === null ? null : Math.min(1, target / scaleMax),
    caption: target !== null ? `${share(value, target)} of target ${compactValue(target, format, block.unit)}` : `${share(value, scaleMax)} of ${compactValue(scaleMax, format, block.unit)}`,
    // The fill carries the status only when the badge (icon and label) says it too.
    fill: status && status.tone !== "good" ? status.color : meter.fill, track: meter.track, status
  };
}

const gauge: Builder = (block, data, theme) => {
  const model = meterModel(block, data, theme);
  if (typeof model === "string") return { option: null, height: 120, problem: model };
  return { option: model as unknown as Record<string, unknown>, height: 120, view: "meter" };
};

const treemap: Builder = (block, data, theme) => {
  const gi = columnOf(data, block.x);
  const si = columnOf(data, block.x2);
  const vi = columnOf(data, block.y[0]);
  const groups = new Map<string, Map<string, number>>();
  for (const row of data.rows) {
    const value = toNumber(row[vi]);
    if (value === null || value <= 0) continue;
    const group = cellLabel(row[gi]);
    const children = groups.get(group) ?? new Map<string, number>();
    const child = si >= 0 ? cellLabel(row[si]) : group;
    children.set(child, (children.get(child) ?? 0) + value);
    groups.set(group, children);
  }
  if (!groups.size) return { option: null, height: chartHeight("treemap"), problem: "A treemap needs positive values" };
  const totalOf = (children: Map<string, number>) => [...children.values()].reduce((sum, value) => sum + value, 0);
  const ranked = [...groups.keys()].sort((left, right) => totalOf(groups.get(right)!) - totalOf(groups.get(left)!));
  const keep = ranked.length > MAX_SERIES ? ranked.slice(0, MAX_SERIES - 1) : ranked;
  const rest = ranked.slice(keep.length);
  const autoFixes: AutoFix[] = rest.length ? [{ rule: "fold_groups", detail: `${rest.length} of ${ranked.length} top-level groups folded into "Other" (top ${MAX_SERIES - 1} kept)` }] : [];
  // Colours follow the entity: the kept groups in their order of appearance take the categorical slots.
  const order = [...groups.keys()].filter((name) => keep.includes(name));
  const whole = ranked.reduce((sum, name) => sum + totalOf(groups.get(name)!), 0);
  const node = (name: string, children: Map<string, number>, color: string) => ({
    name, value: totalOf(children), itemStyle: { color },
    label: { color: inkOn(color) }, upperLabel: { color: theme.ink.inkSecondary },
    ...(si >= 0 ? { children: [...children.entries()].sort((left, right) => right[1] - left[1]).map(([child, value]) => ({ name: child, value, itemStyle: { color }, label: { color: inkOn(color) } })) } : {})
  });
  const nodes = order.map((name, at) => node(name, groups.get(name)!, theme.series[at]!));
  if (rest.length) nodes.push(node("Other", new Map([["Other", rest.reduce((sum, name) => sum + totalOf(groups.get(name)!), 0)]]), theme.emphasisMuted));
  const format = block.format;
  const tileLabel = named(`label:treemap:${format ?? "number"}`, (params: { name?: string; value?: unknown }) => {
    const value = toNumber(params.value);
    return `${String(params.name ?? "")}\n${value === null ? "" : compactValue(value, format, block.unit)}`;
  });
  return {
    option: {
      ...baseOption(theme, named(`tooltip:treemap:${format ?? "number"}`, (params: unknown) => {
        const entry = params as { treePathInfo?: Array<{ name?: string }>; value?: unknown };
        const path = (entry.treePathInfo ?? []).slice(1).map((step) => String(step.name ?? "")).join(" › ");
        const value = toNumber(entry.value) ?? 0;
        return head(path, theme) + line(block.y[0]!, formatValue(value, format, block.unit)) + line("Share of the whole", share(value, whole));
      })),
      series: [{
        type: "treemap", name: block.y[0], roam: false, nodeClick: false, breadcrumb: { show: false }, left: 0, right: 0, top: 0, bottom: 0, squareRatio: 1,
        label: { show: true, fontSize: TYPE.label.size, formatter: tileLabel, overflow: "truncate" },
        itemStyle: { borderColor: theme.ink.surface, borderWidth: MARKS.bar.gap, gapWidth: MARKS.bar.gap },
        // Level 0 is the root (no header); level 1 the groups (a header on the surface when they have subgroups); level 2 the subgroups.
        levels: [
          { itemStyle: { borderWidth: 0, gapWidth: MARKS.bar.gap }, upperLabel: { show: false } },
          { itemStyle: { borderColor: theme.ink.surface, borderWidth: si >= 0 ? MARKS.bar.gap : 0, gapWidth: 1 }, upperLabel: { show: si >= 0, height: 18, fontSize: TYPE.label.size, fontWeight: 600, color: theme.ink.inkSecondary } },
          { itemStyle: { borderColor: theme.ink.surface, borderWidth: 1, gapWidth: 1 } }
        ],
        data: nodes
      }]
    },
    height: chartHeight("treemap"),
    autoFixes
  };
};

const sankey: Builder = (block, data, theme) => {
  const si = columnOf(data, block.x);
  const ti = columnOf(data, block.x2);
  const vi = columnOf(data, block.y[0]);
  const links = new Map<string, { source: string; target: string; value: number }>();
  for (const row of data.rows) {
    const value = toNumber(row[vi]);
    if (value === null || value <= 0) continue;
    const source = cellLabel(row[si]);
    const target = cellLabel(row[ti]);
    const key = JSON.stringify([source, target]);
    const link = links.get(key) ?? { source, target, value: 0 };
    link.value += value;
    links.set(key, link);
  }
  const cycle = findCycle([...links.values()].map((link) => [link.source, link.target] as const));
  if (cycle) return { option: null, height: chartHeight("sankey"), problem: `The flows form a cycle (${cycle.join(" → ")}); a sankey cannot draw it` };
  const nodes = [...new Set([...links.values()].flatMap((link) => [link.source, link.target]))];
  const color = theme.series[1]!;
  const format = block.format;
  const longest = Math.max(...nodes.map((name) => name.length));
  return {
    option: {
      ...baseOption(theme, named(`tooltip:sankey:${format ?? "number"}`, (params: unknown) => {
        const entry = params as { dataType?: string; name?: string; data?: { source?: string; target?: string; value?: number }; value?: unknown };
        if (entry.dataType === "edge") return head(`${entry.data?.source ?? ""} → ${entry.data?.target ?? ""}`, theme) + line(block.y[0]!, formatValue(entry.data?.value, format, block.unit));
        return head(String(entry.name ?? ""), theme) + line("Flow", formatValue(entry.value, format, block.unit));
      })),
      series: [{
        type: "sankey", name: block.y[0], left: 4, top: 8, bottom: 8, right: Math.min(120, 16 + longest * 6), nodeWidth: 10, nodeGap: 10, nodeAlign: "justify", layoutIterations: 32, draggable: false,
        label: { color: theme.ink.inkSecondary, fontSize: TYPE.label.size, overflow: "truncate", width: 110 },
        itemStyle: { color, borderColor: theme.ink.surface, borderWidth: 0 },
        // Links in a neutral wash so the nodes read; hovering a node or link lifts its flows.
        lineStyle: { color: theme.ink.muted, opacity: 0.22, curveness: 0.5 },
        emphasis: { focus: "adjacency", lineStyle: { color: color, opacity: 0.45 } },
        data: nodes.map((name) => ({ name })),
        links: [...links.values()]
      }]
    },
    height: Math.max(CHART_HEIGHTS.sankey, Math.min(520, nodes.length * 18))
  };
};

// -------------------------------------------------------------------------------------- distributions

const boxplot: Builder = (block, data, theme) => {
  const xi = columnOf(data, block.x);
  const categories = [...new Set(data.rows.map((row) => cellLabel(row[xi])))];
  const format = block.format;
  const color = theme.series[0]!;
  const autoFixes: AutoFix[] = [];
  let boxes: Array<number[] | null>;
  let outliers: Array<[string, number]> = [];
  let counts: Array<number | null> = categories.map(() => null);
  if (block.y.length === 5) {
    const indexes = block.y.map((name) => columnOf(data, name));
    boxes = categories.map((category) => {
      const row = data.rows.find((item) => cellLabel(item[xi]) === category);
      const five = indexes.map((index) => toNumber(row?.[index]));
      return five.every((value) => value !== null) ? five as number[] : null;
    });
  } else {
    const vi = columnOf(data, block.y[0]);
    const groups = new Map<string, number[]>(categories.map((category) => [category, []]));
    for (const row of data.rows) {
      const value = toNumber(row[vi]);
      if (value !== null) groups.get(cellLabel(row[xi]))!.push(value);
    }
    const stats = categories.map((category) => boxStats(groups.get(category)!));
    boxes = stats.map((item) => item ? [item.low, item.q1, item.median, item.q3, item.high] : null);
    counts = stats.map((item) => item?.n ?? null);
    outliers = stats.flatMap((item, at) => (item?.outliers ?? []).slice(0, 40).map((value) => [categories[at]!, value] as [string, number]));
    autoFixes.push({ rule: "quartiles", detail: `Quartiles computed from ${counts.reduce<number>((sum, n) => sum + (n ?? 0), 0)} values (linear interpolation; whiskers at 1.5 IQR, ${outliers.length} outliers drawn as dots)` });
  }
  const names = ["Low", "Q1", "Median", "Q3", "High"];
  return {
    option: {
      ...baseOption(theme, named(`tooltip:boxplot:${format ?? "number"}`, (params: unknown) => {
        const entry = params as { seriesType?: string; name?: string; dataIndex?: number; value?: unknown[] };
        const value = entry.value ?? [];
        if (entry.seriesType === "scatter") return head(String(value[0] ?? ""), theme) + line("Outlier", formatValue(value[1], format, block.unit));
        const at = entry.dataIndex ?? 0;
        const five = value.slice(-5);
        return head(String(entry.name ?? ""), theme) + five.map((item, index) => line(block.y.length === 5 ? block.y[index]! : names[index]!, formatValue(item, format, block.unit))).join("") + (counts[at] ? line("Values", String(counts[at])) : "");
      })),
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      xAxis: categoryAxis(theme, categories, { boundaryGap: true }),
      yAxis: { ...valueAxis(theme, format), scale: true },
      series: [
        { type: "boxplot", name: block.y[0], boxWidth: [8, MARKS.bar.maxThickness], itemStyle: { color: withAlpha(color, 0.18), borderColor: color, borderWidth: 1.5 }, emphasis: { itemStyle: { borderWidth: 2 } }, data: boxes.map((box) => box ?? []) },
        ...(outliers.length ? [{ type: "scatter", name: "Outliers", symbolSize: 6, itemStyle: { color, borderColor: theme.ink.surface, borderWidth: 1 }, data: outliers }] : [])
      ]
    },
    height: chartHeight("boxplot"),
    autoFixes
  };
};

const histogram: Builder = (block, data, theme) => {
  const vi = columnOf(data, block.y[0]);
  const values = data.rows.map((row) => toNumber(row[vi])).filter((value): value is number => value !== null);
  const bins = histogramBins(values);
  if (!bins) return { option: null, height: chartHeight("histogram"), problem: "The column holds no numbers" };
  const format = block.format;
  const labels = bins.counts.map((_, at) => `${compactValue(bins.edges[at]!, format)}–${compactValue(bins.edges[at + 1]!, format)}`);
  const color = theme.series[0]!;
  return {
    option: {
      ...baseOption(theme, named("tooltip:histogram", (params: unknown) => {
        const entry = params as { dataIndex?: number; value?: unknown };
        const at = entry.dataIndex ?? 0;
        const count = toNumber(entry.value) ?? 0;
        return head(`${formatValue(bins.edges[at], format, block.unit)} to ${formatValue(bins.edges[at + 1], format, block.unit)}`, theme) + line("Count", String(count)) + line("Share", share(count, bins.n));
      })),
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      xAxis: categoryAxis(theme, labels, { boundaryGap: true }),
      yAxis: valueAxis(theme, "integer"),
      series: [{
        type: "bar", name: block.y[0], barCategoryGap: "0%",
        // Touching bars: the 2 px surface gap, 4 px rounded data end.
        itemStyle: { color, borderColor: theme.ink.surface, borderWidth: MARKS.bar.gap / 2, borderRadius: [MARKS.bar.radius, MARKS.bar.radius, 0, 0] },
        data: bins.counts
      }]
    },
    height: chartHeight("histogram"),
    autoFixes: [{ rule: "bin", detail: `${bins.counts.length} bins of ${compactValue(bins.width, format)} from ${bins.n} values (${bins.rule === "sturges" ? "Sturges; the IQR is 0" : "Freedman–Diaconis"}, 5–50 bins)` }]
  };
};

// ----------------------------------------------------------------------------- steps, pairs, targets

const waterfall: Builder = (block, data, theme) => {
  const xi = columnOf(data, block.x);
  const vi = columnOf(data, block.y[0]);
  const colors = waterfallColors(theme.mode);
  const up = block.upIsGood === false ? colors.down : colors.up;
  const down = block.upIsGood === false ? colors.up : colors.down;
  type Step = { name: string; delta: number; from: number; to: number; total: boolean };
  const steps: Step[] = [];
  let running = 0;
  data.rows.forEach((row, at) => {
    const value = toNumber(row[vi]) ?? 0;
    if (at === 0 && block.start) { steps.push({ name: cellLabel(row[xi]), delta: value, from: 0, to: value, total: true }); running = value; return; }
    steps.push({ name: cellLabel(row[xi]), delta: value, from: running, to: running + value, total: false });
    running += value;
  });
  if (block.total) steps.push({ name: "Total", delta: running, from: 0, to: running, total: true });
  const format = block.format;
  const fewLabels = steps.length <= 12;
  const signed = (step: Step) => step.total ? compactValue(step.to, format, block.unit) : `${step.delta > 0 ? "+" : step.delta < 0 ? "−" : ""}${compactValue(Math.abs(step.delta), format, block.unit)}`;
  const stepLabel = named(`label:waterfall:${format ?? "number"}`, (params: { dataIndex?: number }) => signed(steps[params.dataIndex ?? 0]!));
  const legendSeries = (name: string, color: string) => ({ type: "bar", name, data: [], itemStyle: { color }, stack: "legend" });
  const radius = [MARKS.bar.radius, MARKS.bar.radius, MARKS.bar.radius, MARKS.bar.radius];
  return {
    option: {
      ...baseOption(theme, named(`tooltip:waterfall:${format ?? "number"}`, (params: unknown) => {
        const list = (Array.isArray(params) ? params : [params]) as Array<{ dataIndex?: number }>;
        const step = steps[list[0]?.dataIndex ?? 0];
        if (!step) return "";
        return head(step.name, theme) + (step.total ? line("Total", formatValue(step.to, format, block.unit)) : line("Change", signed(step)) + line("Running total", formatValue(step.to, format, block.unit)));
      }), "axis"),
      color: [up, down, colors.total],
      legend: { ...legendOption(theme), data: ["Increase", "Decrease", ...(steps.some((step) => step.total) ? ["Total"] : [])] },
      grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
      xAxis: categoryAxis(theme, steps.map((step) => step.name), { boundaryGap: true }),
      yAxis: valueAxis(theme, format),
      series: [
        // The invisible base lifts each step to where the last one ended (stacking all signs, so a base below zero works).
        { type: "bar", name: "base", stack: "waterfall", stackStrategy: "all", silent: true, itemStyle: { color: "transparent", borderColor: "transparent" }, emphasis: { disabled: true }, tooltip: { show: false }, data: steps.map((step) => Math.min(step.from, step.to)) },
        {
          type: "bar", name: block.y[0], stack: "waterfall", stackStrategy: "all", barMaxWidth: MARKS.bar.maxThickness,
          label: { show: true, position: "top", ...labelStyle(theme), formatter: stepLabel },
          data: steps.map((step, at) => ({
            value: Math.abs(step.to - step.from),
            itemStyle: { color: step.total ? colors.total : step.delta >= 0 ? up : down, borderRadius: radius, borderColor: theme.ink.surface, borderWidth: MARKS.bar.gap / 2 },
            ...(fewLabels || step.total || at === steps.length - 1 ? {} : { label: { show: false } })
          }))
        },
        legendSeries("Increase", up), legendSeries("Decrease", down), ...(steps.some((step) => step.total) ? [legendSeries("Total", colors.total)] : [])
      ]
    },
    height: chartHeight("waterfall")
  };
};

const combo: Builder = (block, data, theme) => {
  const xi = columnOf(data, block.x);
  const bi = columnOf(data, block.y[0]);
  const li = columnOf(data, block.y[1]);
  let rows = data.rows.slice(0, MAX_CHART_POINTS);
  const autoFixes: AutoFix[] = [];
  if (!ordinalX(block, data.columns, rows)) {
    const sorted = [...rows].sort((left, right) => (toNumber(right[bi]) ?? 0) - (toNumber(left[bi]) ?? 0));
    if (sorted.some((row, at) => row !== rows[at])) autoFixes.push({ rule: "sort", detail: "Bars sorted descending" });
    rows = sorted;
  }
  const categories = rows.map((row) => cellLabel(row[xi]));
  const format = block.format;
  // The format carries a currency; a unit word shows only when the block names one.
  const unit = block.unit;
  const [barColor, lineColor] = [theme.series[0]!, theme.series[1]!];
  const values = (index: number) => rows.map((row) => toNumber(row[index]));
  const endLabel = named(`label:${format ?? "number"}`, (params: { value?: unknown }) => {
    const value = toNumber(params.value);
    return value === null ? "" : compactValue(value, format, unit);
  });
  return {
    option: {
      ...baseOption(theme, named(`tooltip:combo:${format ?? "number"}`, (params: unknown) => {
        const list = (Array.isArray(params) ? params : [params]) as Array<{ name?: string; seriesName?: string; value?: unknown; color?: string }>;
        return head(String(list[0]?.name ?? ""), theme) + list.map((entry) => `<div>${swatch(String(entry.color ?? ""), theme)}${escapeHtml(String(entry.seriesName ?? ""))}: <b>${escapeHtml(formatValue(entry.value, format, unit))}</b></div>`).join("");
      }), "axis"),
      color: [barColor, lineColor],
      legend: legendOption(theme),
      grid: { left: 8, right: 56, top: 36, bottom: 8, containLabel: true },
      xAxis: categoryAxis(theme, categories, { boundaryGap: true }),
      // One value axis, shared: there is never a second one (D465 rule 21).
      yAxis: valueAxis(theme, format),
      series: [
        { type: "bar", name: block.y[0], barMaxWidth: MARKS.bar.maxThickness, itemStyle: { color: barColor, borderRadius: [MARKS.bar.radius, MARKS.bar.radius, 0, 0], borderColor: theme.ink.surface, borderWidth: MARKS.bar.gap / 2 }, data: values(bi) },
        { type: "line", name: block.y[1], symbol: "circle", symbolSize: MARKS.line.dotRadius * 2, showSymbol: categories.length <= 24, lineStyle: { width: MARKS.line.width, join: "round", cap: "round", color: lineColor }, itemStyle: { color: lineColor, borderColor: theme.ink.surface, borderWidth: MARKS.line.dotRing }, endLabel: { show: true, ...labelStyle(theme), formatter: endLabel, distance: 6 }, data: values(li) }
      ]
    },
    height: chartHeight("combo"),
    autoFixes
  };
};

const bullet: Builder = (block, data, theme) => {
  const xi = columnOf(data, block.x);
  const ai = columnOf(data, block.y[0]);
  const ti = columnOf(data, block.target);
  const ri = (block.ranges ?? []).map((name) => columnOf(data, name));
  const rows = data.rows.slice(0, 40);
  const categories = rows.map((row) => cellLabel(row[xi]));
  const actual = rows.map((row) => toNumber(row[ai]));
  const target = rows.map((row) => toNumber(row[ti]));
  const ranges = rows.map((row) => ri.map((index) => toNumber(row[index]) ?? 0));
  const bands = BULLET_BANDS[theme.mode];
  // Without ranges one track runs to the larger of the actual and the target, plus a tenth.
  const limits = ranges.map((limit, at) => limit.length ? limit : [Math.max(actual[at] ?? 0, target[at] ?? 0) * 1.1]);
  const bandCount = Math.max(...limits.map((limit) => limit.length));
  const format = block.format;
  const unit = block.unit;
  const tip = named(`label:bullet:${format ?? "number"}`, (params: { dataIndex?: number }) => {
    const at = params.dataIndex ?? 0;
    return actual[at] === null ? "" : compactValue(actual[at]!, format, unit);
  });
  const bandSeries = Array.from({ length: bandCount }, (_, band) => ({
    type: "bar", name: block.ranges?.[band] ?? "Range", stack: "bands", barWidth: 18, silent: true, yAxisIndex: 0, z: 1,
    itemStyle: { color: bands[bandCount === 1 ? bands.length - 1 : Math.round((band * (bands.length - 1)) / Math.max(1, bandCount - 1))]!, borderRadius: 0 },
    emphasis: { disabled: true }, tooltip: { show: false },
    label: { show: band === bandCount - 1, position: "right", ...labelStyle(theme), color: theme.ink.ink, formatter: tip },
    data: limits.map((limit) => Math.max(0, (limit[band] ?? limit[limit.length - 1] ?? 0) - (band ? limit[band - 1] ?? 0 : 0)))
  }));
  return {
    option: {
      ...baseOption(theme, named(`tooltip:bullet:${format ?? "number"}`, (params: unknown) => {
        const entry = params as { dataIndex?: number };
        const at = entry.dataIndex ?? 0;
        return head(categories[at] ?? "", theme) + line(block.y[0]!, formatValue(actual[at], format, unit)) + line("Target", formatValue(target[at], format, unit))
          + (actual[at] !== null && target[at] ? line("Of target", share(actual[at]!, target[at]!)) : "") + (block.ranges ?? []).map((name, band) => line(name, formatValue(ranges[at]?.[band], format, unit))).join("");
      })),
      grid: { left: 8, right: 64, top: 8, bottom: 8, containLabel: true },
      xAxis: { ...valueAxis(theme, format, { grid: false }), axisLine: { show: true, lineStyle: { color: theme.ink.axis } } },
      // Two copies of one category axis (the second hidden) let the thin measure sit centred on its bands; there is one value axis.
      yAxis: [categoryAxis(theme, categories, { inverse: true }), { ...categoryAxis(theme, categories, { inverse: true }), show: false }],
      series: [
        ...bandSeries,
        { type: "bar", name: block.y[0], yAxisIndex: 1, barWidth: 7, z: 3, itemStyle: { color: theme.series[0], borderRadius: [0, 2, 2, 0] }, data: actual },
        { type: "scatter", name: "Target", yAxisIndex: 1, z: 4, symbol: "rect", symbolSize: [3, 20], itemStyle: { color: theme.ink.ink }, data: target.map((value, at) => [value, categories[at]]) }
      ]
    },
    height: chartHeight("bullet", categories.length)
  };
};

const BUILDERS: Partial<Record<ChartKind, Builder>> = { heatmap, calendar, funnel, gauge, treemap, sankey, boxplot, histogram, waterfall, combo, bullet };

// ------------------------------------------------------------------------------------ small multiples

export type FacetPlan = { column: number; auto: boolean; panels: string[]; folded: number };

/**
 * Whether a line, bar, or area chart draws as small multiples: an explicit `facet` column, or (the
 * auto-fix for too many series, D466) a line over 8 or a scatter over 3 series of its `series` column.
 * v1 blocks keep wave 47's fold. Past 12 panels the smallest fold into "Other" (top 11 kept).
 */
export function facetPlan(block: ChartBlock, data: ChartData): FacetPlan | null {
  const explicit = block.facet !== undefined && ["line", "bar", "area"].includes(block.kind);
  const auto = !explicit && !block.legacy && block.series !== undefined && (block.kind === "line" || block.kind === "scatter");
  if (!explicit && !auto) return null;
  const column = columnOf(data, explicit ? block.facet : block.series);
  if (column < 0) return null;
  const totals = new Map<string, number>();
  const yis = block.y.map((name) => columnOf(data, name));
  for (const row of data.rows) {
    const name = cellLabel(row[column]);
    totals.set(name, (totals.get(name) ?? 0) + yis.reduce((sum, yi) => sum + Math.abs(toNumber(row[yi]) ?? 0), 0));
  }
  const names = [...totals.keys()];
  if (auto && names.length <= (block.kind === "scatter" ? MAX_SCATTER_SERIES : MAX_SERIES)) return null;
  if (names.length < 2) return null;
  if (names.length <= MAX_FACETS) return { column, auto, panels: names, folded: 0 };
  const keep = new Set([...names].sort((left, right) => totals.get(right)! - totals.get(left)!).slice(0, MAX_FACETS - 1));
  return { column, auto, panels: [...names.filter((name) => keep.has(name)), "Other"], folded: names.length - keep.size };
}

/** Panel columns for a tile width: 2 on a phone, 3 at tablet widths, 4 from 800 px. */
export const facetColumns = (width: number, panels: number) => Math.max(1, Math.min(panels, width < 520 ? 2 : width < 800 ? 3 : 4));

/** Small multiples: one panel per facet value in a grid, every panel on the same y scale (and the same x categories). */
export function buildFacets(block: ChartBlock, data: ChartData, theme: ChartTheme, size: ChartSize, plan: FacetPlan): ChartBuild {
  const width = size.width ?? 640;
  const xi = columnOf(data, block.x);
  const yis = block.y.map((name) => columnOf(data, name));
  const mapped: Record<string, string> = { [block.x]: "x", [cellLabel(data.columns[plan.column]?.name)]: plan.auto ? "series → panels" : "facet" };
  block.y.forEach((name, at) => { mapped[name] = block.y.length > 1 ? `y${at + 1}` : "y"; });
  const problems: string[] = [];
  if (xi < 0) problems.push(`The result has no column "${block.x}" for x`);
  block.y.forEach((name, at) => { if (yis[at]! < 0) problems.push(`The result has no column "${name}" for y`); });
  const rows = data.rows.slice(0, MAX_CHART_POINTS);
  const scatter = block.kind === "scatter";
  const numericX = scatter && rows.every((row) => toNumber(row[xi]) !== null);
  const categories = numericX ? [] : [...new Set(rows.map((row) => cellLabel(row[xi])))];
  const kept = new Set(plan.panels);
  const panelOf = (row: readonly unknown[]) => { const name = cellLabel(row[plan.column]); return kept.has(name) ? name : "Other"; };
  // One value per panel, measure, and category (summed: "Other" adds its folded panels).
  const values = new Map<string, Array<Array<number | null>>>(plan.panels.map((panel) => [panel, block.y.map(() => categories.map(() => null as number | null))]));
  const points = new Map<string, Array<Array<[number, number]>>>(plan.panels.map((panel) => [panel, block.y.map(() => [])]));
  for (const row of rows) {
    const panel = panelOf(row);
    yis.forEach((yi, measure) => {
      const value = toNumber(row[yi]);
      if (value === null) return;
      if (numericX) { points.get(panel)![measure]!.push([toNumber(row[xi])!, value]); return; }
      const at = categories.indexOf(cellLabel(row[xi]));
      const list = values.get(panel)![measure]!;
      list[at] = (list[at] ?? 0) + value;
    });
  }
  const all = numericX ? [...points.values()].flat(2).map((point) => point[1]) : [...values.values()].flat(2).filter((value): value is number => value !== null);
  if (!all.length) problems.push("The y columns hold no numbers");
  const autoFixes: AutoFix[] = [];
  if (plan.auto) autoFixes.push({ rule: "facet", detail: `${plan.panels.length + (plan.folded ? plan.folded - 1 : 0)} series drawn as small multiples (one panel each, shared y scale)` });
  if (plan.folded) autoFixes.push({ rule: "fold_panels", detail: `${plan.folded} panels folded into "Other" (top ${MAX_FACETS - 1} kept)` });
  const columns = facetColumns(width, plan.panels.length);
  const panelRows = Math.ceil(plan.panels.length / columns);
  const legend = block.y.length > 1;
  const top = legend ? 28 : 4;
  const height = top + panelRows * CHART_HEIGHTS.facetPanel;
  if (problems.length || !all.length) return { option: null, problems, mapped, cutRows: 0, foldedSeries: 0, foldedCategories: 0, autoFixes, height };
  const low = Math.min(0, ...all);
  const high = Math.max(0, ...all);
  const yMax = niceCeil(high);
  const yMin = low < 0 ? -niceCeil(-low) : 0;
  const format = block.format;
  const unit = block.unit;
  const ink = theme.ink;
  const colorOf = (measure: number) => theme.series[measure % theme.series.length]!;
  const cellWidth = 100 / columns;
  const grids: Array<Record<string, unknown>> = [];
  const xAxes: Array<Record<string, unknown>> = [];
  const yAxes: Array<Record<string, unknown>> = [];
  const titles: Array<Record<string, unknown>> = [];
  const series: Array<Record<string, unknown>> = [];
  plan.panels.forEach((panel, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const panelTop = top + row * CHART_HEIGHTS.facetPanel;
    grids.push({ left: `${column * cellWidth + 1}%`, width: `${cellWidth - 3}%`, top: panelTop + 20, height: CHART_HEIGHTS.facetPanel - 46, containLabel: true });
    titles.push({ text: panel, left: `${column * cellWidth + 1}%`, top: panelTop + 2, textStyle: { color: ink.inkSecondary, fontSize: TYPE.axis.size, fontWeight: 600, width: (width * cellWidth) / 100 - 8, overflow: "truncate" } });
    xAxes.push(numericX
      ? { type: "value", gridIndex: index, axisLabel: { ...axisText(theme), fontSize: TYPE.label.size }, splitLine: { show: false }, axisLine: { lineStyle: { color: ink.axis } } }
      : { ...categoryAxis(theme, categories, { boundaryGap: block.kind === "bar" }), gridIndex: index, axisLabel: { ...axisText(theme), fontSize: TYPE.label.size, hideOverlap: true } });
    yAxes.push({ ...valueAxis(theme, format), gridIndex: index, min: yMin, max: yMax, splitNumber: 2, axisLabel: { ...(valueAxis(theme, format).axisLabel), fontSize: TYPE.label.size, show: column === 0 } });
    block.y.forEach((name, measure) => {
      const color = colorOf(measure);
      const common = { name, xAxisIndex: index, yAxisIndex: index };
      if (scatter) { series.push({ ...common, type: "scatter", symbolSize: 6, itemStyle: { color, borderColor: ink.surface, borderWidth: 1 }, data: numericX ? points.get(panel)![measure] : values.get(panel)![measure] }); return; }
      if (block.kind === "bar") { series.push({ ...common, type: "bar", barMaxWidth: MARKS.bar.maxThickness, itemStyle: { color, borderRadius: [MARKS.bar.radius, MARKS.bar.radius, 0, 0], borderColor: ink.surface, borderWidth: MARKS.bar.gap / 2 }, data: values.get(panel)![measure] }); return; }
      series.push({ ...common, type: "line", symbol: "none", connectNulls: false, lineStyle: { width: MARKS.line.width, join: "round", cap: "round", color }, itemStyle: { color }, ...(block.kind === "area" ? { areaStyle: { color, opacity: MARKS.areaOpacity } } : {}), data: values.get(panel)![measure] });
    });
  });
  const lineLike = block.kind === "line" || block.kind === "area";
  const option = {
    ...baseOption(theme, named(`tooltip:facet:${format ?? "number"}`, (params: unknown) => {
      const list = (Array.isArray(params) ? params : [params]) as Array<{ name?: string; seriesName?: string; value?: unknown; color?: string; axisIndex?: number; seriesIndex?: number }>;
      if (!list.length) return "";
      const panel = plan.panels[Math.floor((list[0]!.seriesIndex ?? 0) / block.y.length)] ?? "";
      return head(`${panel}${list[0]!.name ? ` · ${list[0]!.name}` : ""}`, theme) + list.map((entry) => {
        const raw = Array.isArray(entry.value) ? entry.value[entry.value.length - 1] : entry.value;
        return `<div>${swatch(String(entry.color ?? ""), theme)}${escapeHtml(String(entry.seriesName ?? ""))}: <b>${escapeHtml(formatValue(raw, format, unit))}</b></div>`;
      }).join("");
    }), lineLike ? "axis" : "item"),
    color: block.y.map((_, measure) => colorOf(measure)),
    legend: legend ? { ...legendOption(theme), data: block.y } : { show: false },
    title: titles, grid: grids, xAxis: xAxes, yAxis: yAxes, series
  };
  return { option, problems, mapped, cutRows: data.rows.length - rows.length, foldedSeries: 0, foldedCategories: 0, autoFixes, height };
}
