/**
 * The report theme "Ledger" (wave 48b, docs/plan/REPORT_THEME.md, D430). Every visual decision a
 * report makes lives here: surfaces and ink for both schemes, the eight categorical hues in their
 * fixed amber-first order, the sequential and diverging ramps, the reserved status colours, the
 * emphasis greys, the type scale, the layout grid, the mark specs, and the chart heights. The model
 * that writes a report never chooses any of it: a spec carries intents and layout slots only.
 *
 * Two things are generated from these tokens and nothing else: the CSS variables the report view
 * sets on its root (`reportCssVariables`) and the one ECharts theme the charts register
 * (`reportEchartsTheme`). Pure: no DOM, no imports, so the server, the client, and the tests share it.
 */

export type ThemeMode = "dark" | "light";

export type InkTokens = {
  /** The page plane behind the cards. */
  page: string;
  /** Card and chart surface. */
  surface: string;
  /** The card's hairline border. */
  border: string;
  ink: string;
  inkSecondary: string;
  /** Axis labels, captions. */
  muted: string;
  /** 1 px horizontal gridlines. */
  grid: string;
  /** The baseline and axis line. */
  axis: string;
  /** Brand accent: UI chrome only, never data. */
  accent: string;
  /** The tooltip panel (a step above the surface). */
  tooltip: string;
};

export const REPORT_INK: Record<ThemeMode, InkTokens> = {
  dark: { page: "#09090a", surface: "#111113", border: "#29292d", ink: "#ededef", inkSecondary: "#b4b4ba", muted: "#929299", grid: "#1f1f23", axis: "#3a3a40", accent: "#f6c453", tooltip: "#18181b" },
  light: { page: "#f9f9f7", surface: "#fcfcfb", border: "rgba(11,11,11,.10)", ink: "#0b0b0b", inkSecondary: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7", accent: "#b07800", tooltip: "#ffffff" }
};

/**
 * The categorical series, in a fixed order (never cycled): amber, blue, aqua, orange, violet,
 * magenta, green, red. Validated (validate_palette.js; tests/reportTheme.test.ts re-runs the checks)
 * against the dark surface #111113 and the light surface #fcfcfb.
 */
export const SERIES_HUES = ["amber", "blue", "aqua", "orange", "violet", "magenta", "green", "red"] as const;
export const REPORT_SERIES: Record<ThemeMode, readonly string[]> = {
  dark: ["#c98500", "#3987e5", "#199e70", "#d95926", "#9085e9", "#d55181", "#008300", "#e66767"],
  light: ["#eda100", "#2a78d6", "#1baf7a", "#eb6834", "#4a3aa7", "#e87ba4", "#008300", "#e34948"]
};
/** Series a chart colours; more fold into "Other" (top 7 + Other). */
export const MAX_SERIES = 8;
/** Scatter, bubble, and small multiples: only the first three slots pass every pair in both modes. */
export const MAX_SCATTER_SERIES = 3;

/** The sequential (magnitude) blue ramp, steps 100 → 700. On dark an ordinal ramp stops at step 600. */
export const SEQUENTIAL_BLUE = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"] as const;
/** The index of step 600 in SEQUENTIAL_BLUE (the darkest step an ordinal ramp may use on dark). */
export const SEQUENTIAL_DARK_LIMIT = 10;

/** Diverging: blue ↔ red with a grey midpoint, equal steps each side. */
export const DIVERGING: Record<ThemeMode, { low: readonly string[]; mid: string; high: readonly string[] }> = {
  dark: { low: ["#104281", "#2a78d6", "#86b6ef"], mid: "#383835", high: ["#f0a3a3", "#e66767", "#a83232"] },
  light: { low: ["#104281", "#2a78d6", "#86b6ef"], mid: "#f0efec", high: ["#f0a3a3", "#e34948", "#a83232"] }
};

/** Status colours: reserved, never a series, always with an icon and a label. */
export const STATUS = { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" } as const;
/**
 * KPI delta text. Up-and-good is the spec's (#0ca30c dark, #006300 light); down-and-bad is not in the
 * spec, so these are the critical hue moved to ≥ 4.5:1 on each surface (tests check the contrast).
 */
export const DELTA_TEXT: Record<ThemeMode, { good: string; bad: string }> = {
  dark: { good: "#0ca30c", bad: "#f08080" },
  light: { good: "#006300", bad: "#b42318" }
};

/** Emphasis mode: the chosen series in slot 1 (amber), every other in this grey. */
export const EMPHASIS_MUTED: Record<ThemeMode, string> = { dark: "#4a4a50", light: "#c3c2b7" };

/** Type: sizes in px and weights. Tabular figures only in table columns and on axis ticks. */
export const TYPE = {
  font: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
  title: { size: 20, weight: 600 },
  blockTitle: { size: 14, weight: 600 },
  body: { size: 13, weight: 400 },
  axis: { size: 11, weight: 400 },
  label: { size: 10, weight: 500 },
  kpi: { size: 26, weight: 600 },
  hero: { size: 48, weight: 600 }
} as const;

/** The layout grid: 12 columns from 1024 px, 6 from 768 px, 1 below. */
export const LAYOUT = {
  breakpoints: { wide: 1024, medium: 768 },
  columns: { wide: 12, medium: 6, narrow: 1 },
  gutter: 10,
  cardPadding: 14,
  cardPaddingNarrow: 12,
  radius: 10,
  kpiMinWidth: 150
} as const;

export const BLOCK_WIDTH_SPANS = { full: 12, half: 6, third: 4 } as const;

/** Marks: fixed, never from a spec. */
export const MARKS = {
  bar: { maxThickness: 24, radius: 4, gap: 2 },
  line: { width: 2, dotRadius: 4, dotRing: 2 },
  areaOpacity: 0.1,
  grid: { width: 1 },
  /** Texture fills (forced-colors and print only): 45° and 135°. */
  textureAngles: [Math.PI / 4, (3 * Math.PI) / 4]
} as const;

/** Chart heights by kind, px; bars grow per category. */
export const CHART_HEIGHTS = { line: 220, area: 220, pie: 220, scatter: 260, bar: 220, barPerCategory: 28, barMin: 160 } as const;

// ------------------------------------------------------------------------------------ the layout

export type LayoutColumns = 1 | 6 | 12;

/** The grid's column count at a viewport width (≥1024: 12, 768–1023: 6, <768: 1). */
export function layoutColumns(width: number): LayoutColumns {
  if (width >= LAYOUT.breakpoints.wide) return 12;
  if (width >= LAYOUT.breakpoints.medium) return 6;
  return 1;
}

/**
 * The columns a block spans: full is every column; half is half; a third is 4 of 12 and, at 6
 * columns (too narrow for three across), half; one column is always full width.
 */
export function blockSpan(width: keyof typeof BLOCK_WIDTH_SPANS, columns: LayoutColumns): number {
  if (columns === 1) return 1;
  if (columns === 12) return BLOCK_WIDTH_SPANS[width];
  return width === "full" ? 6 : 3;
}

/** A chart's fixed height for its kind (horizontal bars: 28 px per category, at least 160). */
export function chartHeight(kind: string, categories = 0): number {
  if (kind === "horizontal_bar") return Math.max(CHART_HEIGHTS.barMin, categories * CHART_HEIGHTS.barPerCategory + 24);
  if (kind === "bar" || kind === "stacked_bar") return CHART_HEIGHTS.bar;
  if (kind === "scatter") return CHART_HEIGHTS.scatter;
  if (kind === "pie") return CHART_HEIGHTS.pie;
  return CHART_HEIGHTS.line;
}

// ------------------------------------------------------------------------------ generated outputs

/** The theme as CSS custom properties (the report view sets them on its root through the CSSOM). */
export function reportCssVariables(mode: ThemeMode): Record<string, string> {
  const ink = REPORT_INK[mode];
  const vars: Record<string, string> = {
    "--rt-page": ink.page, "--rt-surface": ink.surface, "--rt-border": ink.border, "--rt-ink": ink.ink, "--rt-ink-2": ink.inkSecondary,
    "--rt-muted": ink.muted, "--rt-grid": ink.grid, "--rt-axis": ink.axis, "--rt-accent": ink.accent, "--rt-tooltip": ink.tooltip,
    "--rt-good": STATUS.good, "--rt-warning": STATUS.warning, "--rt-serious": STATUS.serious, "--rt-critical": STATUS.critical,
    "--rt-delta-good": DELTA_TEXT[mode].good, "--rt-delta-bad": DELTA_TEXT[mode].bad, "--rt-emphasis-muted": EMPHASIS_MUTED[mode],
    "--rt-gutter": `${LAYOUT.gutter}px`, "--rt-pad": `${LAYOUT.cardPadding}px`, "--rt-pad-narrow": `${LAYOUT.cardPaddingNarrow}px`, "--rt-radius": `${LAYOUT.radius}px`,
    "--rt-kpi-min": `${LAYOUT.kpiMinWidth}px`, "--rt-font": TYPE.font,
    "--rt-title-size": `${TYPE.title.size}px`, "--rt-block-title-size": `${TYPE.blockTitle.size}px`, "--rt-body-size": `${TYPE.body.size}px`,
    "--rt-axis-size": `${TYPE.axis.size}px`, "--rt-label-size": `${TYPE.label.size}px`, "--rt-kpi-size": `${TYPE.kpi.size}px`, "--rt-hero-size": `${TYPE.hero.size}px`
  };
  REPORT_SERIES[mode].forEach((color, index) => { vars[`--rt-series-${index + 1}`] = color; });
  return vars;
}

export const ECHARTS_THEME_NAME = "nook-ledger";

/** The one ECharts theme, built from the tokens of a mode (charts.tsx registers it under ECHARTS_THEME_NAME). */
export function reportEchartsTheme(mode: ThemeMode): Record<string, unknown> {
  const ink = REPORT_INK[mode];
  const axisCommon = {
    axisLine: { show: true, lineStyle: { color: ink.axis, width: 1 } },
    axisTick: { show: false },
    axisLabel: { color: ink.muted, fontSize: TYPE.axis.size },
    splitLine: { show: false, lineStyle: { color: ink.grid, width: MARKS.grid.width, type: "solid" } },
    nameTextStyle: { color: ink.muted, fontSize: TYPE.axis.size }
  };
  return {
    color: [...REPORT_SERIES[mode]],
    backgroundColor: "transparent",
    textStyle: { color: ink.ink, fontFamily: TYPE.font, fontSize: TYPE.body.size },
    title: { textStyle: { color: ink.ink, fontSize: TYPE.blockTitle.size, fontWeight: TYPE.blockTitle.weight } },
    legend: { textStyle: { color: ink.inkSecondary, fontSize: TYPE.axis.size }, pageTextStyle: { color: ink.muted }, pageIconColor: ink.inkSecondary, pageIconInactiveColor: ink.axis },
    tooltip: { backgroundColor: ink.tooltip, borderColor: ink.border, borderWidth: 1, textStyle: { color: ink.ink, fontSize: 12 }, axisPointer: { lineStyle: { color: ink.axis }, crossStyle: { color: ink.axis } } },
    categoryAxis: axisCommon,
    valueAxis: { ...axisCommon, axisLine: { show: false }, splitLine: { show: true, lineStyle: { color: ink.grid, width: MARKS.grid.width, type: "solid" } } },
    timeAxis: axisCommon,
    line: { lineStyle: { width: MARKS.line.width, join: "round", cap: "round" }, symbol: "none", smooth: false },
    bar: { barMaxWidth: MARKS.bar.maxThickness, itemStyle: { borderColor: ink.surface, borderWidth: MARKS.bar.gap / 2 } },
    pie: { itemStyle: { borderColor: ink.surface, borderWidth: MARKS.bar.gap } },
    scatter: { symbolSize: 8, itemStyle: { borderColor: ink.surface, borderWidth: 1 } }
  };
}
