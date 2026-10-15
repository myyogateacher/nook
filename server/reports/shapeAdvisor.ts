import { isNumericType, isTimeType, type BlockIntent, type ChartKind, type ResultColumn } from "../../shared/reports";
import { MAX_HEATMAP_SIDE, MAX_SERIES } from "../../shared/reportTheme";

/**
 * The data-shape advisor and the kind check (D488, docs/plan/REPORT_THEME.md § Picking the kind).
 *
 * `adviseShape` reads a run_sql result (column types, row count, ordered dimensions, stage-like
 * values, a target column, ratios, from/to pairs, raw samples, signed deltas, many series over time)
 * and returns the chart kinds the data fits as one short line the report agents read with every
 * result: `shape: 5 stages, decreasing → funnel fits; also bar`. It is deterministic and pure.
 *
 * `kindHints` is the soft design check a submit gets once (never a try): a planned todo's intent its
 * block's kind does not serve, and, when most charts are bar or line, the bar and line blocks whose
 * data fits another kind. It only names kinds the advisor saw the data fit; it never forces one.
 */

export type Shape = {
  /** What the model reads (at most 300 characters). */
  line: string;
  /** The kinds the data fits, the best first. */
  fits: ChartKind[];
  /** Why each specific kind fits, in a few words (the hint quotes them). */
  why: Partial<Record<ChartKind, string>>;
  /** Many series over time: a line with facet (small multiples). */
  facet: boolean;
};

const LINE_MAX = 300;
/** Kinds the diversity check never suggests (the generic ones). */
const PLAIN_KINDS: ReadonlySet<string> = new Set(["bar", "line", "area", "horizontal_bar"]);
/** Kinds specific enough to suggest instead of a bar or line. */
const SPECIFIC_KINDS: ReadonlySet<ChartKind> = new Set(["funnel", "heatmap", "gauge", "bullet", "sankey", "histogram", "boxplot", "waterfall", "calendar"]);

const TARGET = /(^|_)(target|goal|quota|budget|plan|planned|objective|sla|expected)(_|$)/i;
const MAX_LIKE = /(^|_)(max|capacity|limit|ceiling)(_|$)/i;
const BAND = /(^|_)(band|range|poor|ok|good|low|mid|high)\d*(_|$)/i;
const STAGE = /(^|_)(stage|step|funnel|phase)s?(_|$)/i;
const STAGE_LABEL = /^\s*(?:\d{1,2}[.):\s-]|step\s*\d|stage\s*\d)/i;
const FROM = /(^|_)(from|source|src|origin|prev|previous|start|before)(_|$)/i;
const TO = /(^|_)(to|target|dst|dest|destination|next|end|after)(_|$)/i;
const OFFSET = /(^|_)(period|week|month|day|hour|age|offset|index|bucket|weekday|dow|lag|tenure|n)(_?(number|no|num|index|offset))?s?$/i;
const COHORT = /cohort/i;
const DELTA = /(^|_)(delta|change|diff|net|contribution|impact|variance)(_|$)/i;
const RATE = /(pct|percent|rate|ratio|share|conversion|retention)/i;
const QUANTILES = ["min", "q1", "median", "q3", "max"];
const PERIOD_LABEL = /^(?:\d{4}-(?:0[1-9]|1[0-2])(?:-\d{2})?(?:[ T]\d{2}:\d{2}(?::\d{2})?)?|\d{4}-?W\d{2}|(?:\d{4}[- ]?)?Q[1-4](?:[- ]?\d{4})?|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?|(?:week|month|day|m|w|d)\s?\d{1,3})$/i;

const numberOf = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value.trim())) return Number(value);
  return null;
};

type Profile = {
  name: string; index: number; role: "time" | "number" | "text";
  /** Ordered labels or a date: a heatmap axis. */
  ordered: boolean; distinct: number; numbers: number[]; texts: string[];
  integer: boolean; min: number; max: number;
};

function profile(column: ResultColumn, index: number, rows: readonly (readonly unknown[])[]): Profile {
  const cells = rows.map((row) => row[index]).filter((cell) => cell !== null && cell !== undefined);
  const time = isTimeType(column.type);
  const numeric = !time && isNumericType(column.type);
  const numbers = numeric ? cells.map(numberOf).filter((value): value is number => value !== null) : [];
  const texts = numeric ? [] : cells.map((cell) => typeof cell === "string" ? cell : JSON.stringify(cell));
  const ordered = time || (!numeric && texts.length > 0 && texts.every((text) => PERIOD_LABEL.test(text.trim())));
  return {
    name: column.name, index, role: time ? "time" : numeric ? "number" : "text", ordered,
    distinct: new Set<unknown>(numeric ? numbers : texts).size, numbers, texts,
    integer: numbers.every((value) => Number.isInteger(value)),
    min: numbers.length ? Math.min(...numbers) : 0, max: numbers.length ? Math.max(...numbers) : 0
  };
}

const nonIncreasing = (values: readonly number[]) => values.every((value, index) => index === 0 || value <= values[index - 1]!);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The advisor: what a result's data looks like, and the kinds it fits. */
export function adviseShape(columns: readonly ResultColumn[], rows: readonly (readonly unknown[])[]): Shape {
  const signals: string[] = [];
  const fits: ChartKind[] = [];
  const why: Partial<Record<ChartKind, string>> = {};
  const notes: string[] = [];
  let facet = false;
  const fit = (kind: ChartKind, reason?: string) => {
    if (!fits.includes(kind)) fits.push(kind);
    if (reason && !why[kind]) why[kind] = reason;
  };
  const n = rows.length;
  const all = columns.map((column, index) => profile(column, index, rows));
  // A text column with a distinct value on every row of a bigger result is an id, not a dimension.
  const ids = all.filter((item) => item.role === "text" && n >= 20 && item.distinct === n);
  const cols = all.filter((item) => !ids.includes(item));
  let measures = cols.filter((item) => item.role === "number");
  const times = cols.filter((item) => item.role === "time");
  const texts = cols.filter((item) => item.role === "text");
  // Small integer columns named like a period offset (week 0..12) are dimensions when another number is the measure.
  const offsets = measures.filter((item) => item.integer && OFFSET.test(item.name) && item.distinct <= MAX_HEATMAP_SIDE && measures.length > 1);
  measures = measures.filter((item) => !offsets.includes(item));
  const target = measures.find((item) => TARGET.test(item.name)) ?? null;
  const maxLike = measures.find((item) => MAX_LIKE.test(item.name) && item !== target) ?? null;
  const bands = measures.filter((item) => BAND.test(item.name) && item !== target);
  const actuals = measures.filter((item) => item !== target && item !== maxLike && !bands.includes(item));
  const dims = [...times, ...texts, ...offsets];

  // Ratios: values in 0–1 read as a percent; 0–100 with a rate name want dividing by 100.
  for (const item of actuals) {
    if (!item.numbers.length) continue;
    if (item.min >= 0 && item.max <= 1 && !item.integer) notes.push(`${item.name} in 0–1 → format percent`);
    else if (item.min >= 0 && item.max <= 100 && RATE.test(item.name) && item.max > 1) notes.push(`${item.name} looks like 0–100: divide by 100 for format percent`);
  }

  if (n === 0) return finish(["empty result"], [], {}, [], false);

  // One row: a KPI, a gauge with a target, or a funnel laid out in columns.
  if (n === 1 && !dims.length) {
    const counts = actuals.filter((item) => item.integer);
    const values = counts.map((item) => item.numbers[0] ?? 0);
    if (target || maxLike) {
      signals.push(`1 row, ${actuals[0]?.name ?? "value"} vs ${(target ?? maxLike)!.name}`);
      fit("gauge", `one value against ${(target ?? maxLike)!.name}`);
    } else if (counts.length >= 3 && counts.length === actuals.length && nonIncreasing(values) && values[0]! > values[values.length - 1]!) {
      signals.push(`1 row of ${counts.length} decreasing counts`);
      notes.push("unpivot to one row per stage (arrayJoin) for a funnel");
      fit("funnel", `${counts.length} decreasing step counts`);
    } else {
      signals.push(actuals.length === 1 ? "single value" : `1 row, ${actuals.length} values`);
    }
    return finish(signals, fits, why, [...notes, "kpi fits"], false);
  }

  // Five quantile columns per category: a box plot of summaries.
  const names = new Set(cols.map((item) => item.name.toLowerCase()));
  if (QUANTILES.every((name) => names.has(name)) && texts.length >= 1) {
    signals.push(`min/q1/median/q3/max per ${texts[0]!.name}`);
    fit("boxplot", "quantiles per category");
  }

  const text = texts.length === 1 ? texts[0]! : null;
  // Bullet: per category, an actual against a target.
  if (target && actuals.length >= 1 && texts.length === 1 && n <= 15) {
    signals.push(`${actuals[0]!.name} vs ${target.name} per ${text!.name}`);
    fit("bullet", `actual against ${target.name} per ${text!.name}`);
  }
  // Gauge: one row with a category label and a target still reads as one value.
  if ((target || maxLike) && n === 1 && actuals.length >= 1) fit("gauge", `one value against ${(target ?? maxLike)!.name}`);

  // Sankey: a from/to pair of text columns and a flow.
  if (texts.length === 2 && actuals.length >= 1) {
    const [a, b] = texts as [Profile, Profile];
    const named = (FROM.test(a.name) && TO.test(b.name)) || (FROM.test(b.name) && TO.test(a.name));
    const shared = a.texts.some((value) => b.texts.includes(value));
    const nodes = new Set([...a.texts, ...b.texts]).size;
    if ((named || shared) && nodes <= 30) {
      signals.push(`from/to pair ${a.name}→${b.name}, ${plural(nodes, "node")}`);
      fit("sankey", `${a.name}→${b.name} flows`);
    }
  }

  // Heatmap: two ordered dimensions and one value (a cohort matrix when one is a cohort date and the other an offset).
  const ordered = [...times, ...texts.filter((item) => item.ordered), ...offsets];
  if (ordered.length === 2 && dims.length === 2 && actuals.length >= 1 && n >= 4) {
    const [a, b] = ordered as [Profile, Profile];
    if (a.distinct >= 2 && b.distinct >= 2 && a.distinct <= MAX_HEATMAP_SIDE && b.distinct <= MAX_HEATMAP_SIDE) {
      const cohort = COHORT.test(a.name) || COHORT.test(b.name) || (times.length === 1 && offsets.length === 1);
      signals.push(`${cohort ? "cohort matrix" : "two ordered dims"} ${a.distinct}×${b.distinct}`);
      fit("heatmap", cohort ? "a cohort × period matrix (cohort true)" : `${a.name} × ${b.name} grid`);
    }
  }

  // Funnel: stage-like labels in order with values that never rise.
  const label = text ?? (times.length === 0 && offsets.length === 1 ? offsets[0]! : null);
  if (label && dims.length === 1 && actuals.length === 1 && n >= 2 && n <= 8) {
    const values = actuals[0]!.numbers;
    const stageLike = STAGE.test(label.name) || (label.texts.length > 0 && label.texts.every((value) => STAGE_LABEL.test(value)));
    if (stageLike && values.length === n && nonIncreasing(values) && values[0]! > values[n - 1]!) {
      signals.push(`stages=${n} decreasing`);
      fit("funnel", `${n} stages, decreasing`);
    }
  }

  // Waterfall: signed changes per step.
  if (label && dims.length === 1 && actuals.length === 1 && n >= 2 && n <= 25) {
    const values = actuals[0]!.numbers;
    const stepped = DELTA.test(actuals[0]!.name) || label.texts.some((value) => /^(start|starting|opening|open|total|end|ending|closing|previous|prior)\b/i.test(value.trim()));
    if (stepped && values.some((value) => value < 0) && values.some((value) => value > 0)) {
      signals.push(`signed ${DELTA.test(actuals[0]!.name) ? "deltas" : "values"} per ${label.name}`);
      fit("waterfall", "signed changes per step");
    }
  }

  // Distribution: raw samples (no dimension) or many samples per category.
  if (!dims.length && actuals.length === 1 && n >= 20) {
    const item = actuals[0]!;
    if (item.distinct >= 10) {
      signals.push(`${n} raw ${item.name} values`);
      fit("histogram", `${n} raw values`);
      fit("boxplot");
    }
  } else if (!dims.length && actuals.length >= 2 && n >= 10) {
    signals.push(`${n} rows of ${actuals.length} measures`);
    fit("scatter", "two measures per row");
  }
  if (text && dims.length === 1 && actuals.length === 1 && n >= 20 && text.distinct <= 20 && n / text.distinct >= 5 && !fits.includes("boxplot")) {
    signals.push(`~${Math.round(n / text.distinct)} samples per ${text.name}`);
    fit("boxplot", `raw values per ${text.name}`);
  }

  // Over time: a trend, small multiples for many series, a calendar for long daily data.
  if (times.length === 1 && actuals.length >= 1) {
    const time = times[0]!;
    const series = texts.length === 1 ? texts[0]! : null;
    if (series && dims.length === 2 && series.distinct > MAX_SERIES) {
      signals.push(`${series.distinct} series over time`);
      facet = true;
      fit("line", `${series.distinct} series → facet by ${series.name}`);
    } else if (dims.length === 1) {
      signals.push(`${plural(time.distinct, "date")}${actuals.length > 1 ? `, ${actuals.length} measures` : ""}`);
      fit("line");
      fit("area");
      if (/^(Nullable\()?Date(32)?\)?$/.test(columns[time.index]!.type) && time.distinct >= 60 && actuals.length === 1) fit("calendar", `${time.distinct} days of daily values`);
    } else if (series) {
      signals.push(`${series.distinct} series over time`);
      fit("line");
      fit("area");
      fit("stacked_bar");
    }
  }

  // Categories: a bar, or a ranking; a small whole can be a pie or a treemap.
  if (text && dims.length === 1 && actuals.length >= 1 && !fits.includes("funnel") && !fits.includes("boxplot") && !fits.includes("bullet")) {
    if (!signals.length) signals.push(`${plural(text.distinct, "category")}`);
    if (!text.ordered) fit("bar");
    fit("horizontal_bar");
    if (actuals.length === 1 && actuals[0]!.min >= 0) notes.push(text.distinct <= 5 ? "pie/treemap if parts of a whole" : "treemap if parts of a whole");
  }
  if (!signals.length) signals.push(`${plural(n, "row")}, ${plural(dims.length, "dim")}, ${plural(actuals.length, "measure")}`);
  if (fits.some((kind) => SPECIFIC_KINDS.has(kind)) && !fits.includes("bar") && dims.length && !times.length) fit("bar");
  return finish(signals, fits, why, notes, facet);
}

function finish(signals: string[], fits: ChartKind[], why: Partial<Record<ChartKind, string>>, notes: string[], facet: boolean): Shape {
  // The specific kinds first: they are the advice; bar and line are the fallback.
  const sorted = [...fits].sort((a, b) => Number(!SPECIFIC_KINDS.has(a)) - Number(!SPECIFIC_KINDS.has(b)));
  const [first, ...rest] = sorted;
  const verdict = first ? `${first}${facet && first === "line" ? " with facet" : ""} fits${rest.length ? `; also ${rest.join(", ")}` : ""}` : "table or kpi";
  let line = `shape: ${signals.join(", ")} → ${verdict}${notes.length ? `; ${notes.join("; ")}` : ""}`;
  if (line.length > LINE_MAX) line = `${line.slice(0, LINE_MAX - 1)}…`;
  return { line, fits: sorted, why, facet };
}

// ---------------------------------------------------------------------------------- the kind check

/** The block kinds each intent is drawn with (the prompt's routing; kpi and table blocks by type). */
export const INTENT_DRAWN_AS: Record<BlockIntent, readonly string[]> = {
  trend: ["line", "area", "calendar", "combo"],
  compare: ["bar", "horizontal_bar", "stacked_bar", "combo"],
  rank: ["horizontal_bar", "bar", "table"],
  share: ["stacked_bar", "pie", "treemap", "bar", "area"],
  distribution: ["histogram", "boxplot"],
  relationship: ["scatter"],
  matrix: ["heatmap"],
  conversion: ["funnel"],
  attainment: ["gauge", "bullet"],
  flow: ["sankey"],
  headline: ["kpi", "gauge"],
  delta: ["kpi", "waterfall"],
  detail: ["table"]
};

type LooseBlock = Record<string, unknown> & { id?: unknown; type?: unknown; kind?: unknown; queryKey?: unknown };
type LooseTodo = { id: string; kind: string; intent: string | null; status: string; queryKey: string | null; blockId: string | null };

const drawnAs = (block: LooseBlock) => block.type === "chart" ? String(block.kind ?? "") : String(block.type ?? "");
const article = (word: string) => /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
/** At most this share of charts may be bar or line before the diversity check speaks. */
export const PLAIN_SHARE = 0.7;

/**
 * The soft kind check (pure): hints for the blocks whose kind does not serve their todo's intent, and,
 * when more than 70 % of the charts are bar or line, the bar and line blocks whose data fits a more
 * specific kind. `diversity: false` leaves the second part out.
 */
export function kindHints(input: { blocks: readonly LooseBlock[]; shapes: ReadonlyMap<string, Shape>; todos: readonly LooseTodo[]; diversity?: boolean }): string[] {
  const hints: string[] = [];
  const blocks = input.blocks.filter((block) => block.type === "chart" || block.type === "kpi" || block.type === "table");
  for (const todo of input.todos) {
    if (todo.status !== "done" || !todo.intent || !(todo.intent in INTENT_DRAWN_AS)) continue;
    const own = blocks.filter((block) => (todo.blockId && block.id === todo.blockId) || (todo.queryKey && block.queryKey === todo.queryKey));
    if (!own.length) continue;
    const kinds = INTENT_DRAWN_AS[todo.intent as BlockIntent];
    if (own.some((block) => kinds.includes(drawnAs(block)) || (todo.intent === "share" && block.type === "chart" && block.stack))) continue;
    const block = own[0]!;
    const shape = typeof block.queryKey === "string" ? input.shapes.get(block.queryKey) : undefined;
    const fitting = kinds.filter((kind) => shape?.fits.includes(kind as ChartKind));
    hints.push(`block ${String(block.id)}: its todo ${todo.id} was planned with intent ${todo.intent}, which is drawn as ${kinds.map(article).join(" or ")}, but the block is ${article(drawnAs(block))}${fitting.length ? ` (its data fits ${fitting.join(", ")})` : ""}; draw it as its intent says, or revise the plan if the intent was wrong`);
  }
  if (input.diversity === false) return hints;
  const charts = blocks.filter((block) => block.type === "chart");
  const plain = charts.filter((block) => PLAIN_KINDS.has(drawnAs(block)));
  if (!charts.length || plain.length / charts.length <= PLAIN_SHARE) return hints;
  const ideas: string[] = [];
  for (const block of plain) {
    const shape = typeof block.queryKey === "string" ? input.shapes.get(block.queryKey) : undefined;
    if (!shape) continue;
    const better = shape.fits.filter((kind) => SPECIFIC_KINDS.has(kind) && kind !== block.kind);
    if (shape.facet && block.kind === "line" && !block.facet) ideas.push(`${String(block.id)} → line with facet (${shape.why.line ?? "many series"})`);
    else if (better.length) ideas.push(`${String(block.id)} → ${better.slice(0, 2).map((kind) => `${kind}${shape.why[kind] ? ` (${shape.why[kind]})` : ""}`).join(" or ")}`);
  }
  if (ideas.length) hints.push(`design: ${plain.length} of ${charts.length} charts are bar or line, but the data fits other kinds: ${ideas.slice(0, 6).join("; ")}. Switch a block (and its intent) where that kind answers its question better; keep bar or line where it is the better answer`);
  return hints;
}
