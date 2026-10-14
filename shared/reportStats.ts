/**
 * Deterministic statistics for report charts (chart kinds round 2, D464): quartiles for box plots,
 * Freedman–Diaconis bins for histograms, and the cycle check for sankey flows. Pure, no imports, so
 * the server's design check, the client's option builder, and the tests compute the same numbers.
 */

/** The p-quantile (0–1) of sorted values by linear interpolation between closest ranks (numpy's default, R type 7). */
export function quantileSorted(sorted: readonly number[], p: number): number {
  if (!sorted.length) return Number.NaN;
  const at = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return low === high ? sorted[low]! : sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

export type BoxStats = { min: number; q1: number; median: number; q3: number; max: number; /** Whisker ends (Tukey: the furthest values within 1.5 IQR). */ low: number; high: number; outliers: number[]; n: number };

/** Five-number summary with Tukey whiskers; values outside 1.5 IQR are outliers (ascending). Null for no values. */
export function boxStats(values: readonly number[]): BoxStats | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const q1 = quantileSorted(sorted, 0.25);
  const median = quantileSorted(sorted, 0.5);
  const q3 = quantileSorted(sorted, 0.75);
  const fence = 1.5 * (q3 - q1);
  const inside = sorted.filter((value) => value >= q1 - fence && value <= q3 + fence);
  return {
    min: sorted[0]!, q1, median, q3, max: sorted[sorted.length - 1]!,
    low: inside[0] ?? q1, high: inside[inside.length - 1] ?? q3,
    outliers: sorted.filter((value) => value < q1 - fence || value > q3 + fence), n: sorted.length
  };
}

/** Histogram bins: at least 5, at most 50 (D464). */
export const HISTOGRAM_BINS = { min: 5, max: 50 } as const;

export type Histogram = { edges: number[]; counts: number[]; width: number; n: number; /** Freedman–Diaconis, or Sturges when the IQR is 0. */ rule: "freedman-diaconis" | "sturges" };

/**
 * Bins finite values deterministically: the Freedman–Diaconis width 2·IQR·n^(-1/3) (Sturges'
 * ⌈log2 n⌉ + 1 bins when the IQR is 0), the count clamped to 5–50, equal widths from the minimum to
 * the maximum; each bin holds [lo, hi) and the last one also its upper edge. Null for no values.
 */
export function histogramBins(values: readonly number[]): Histogram | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  const n = sorted.length;
  if (!n) return null;
  const min = sorted[0]!;
  const max = sorted[n - 1]!;
  const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25);
  const span = max - min;
  let count: number;
  let rule: Histogram["rule"] = "freedman-diaconis";
  if (iqr > 0 && span > 0) count = Math.ceil(span / (2 * iqr * Math.cbrt(1 / n)));
  else { count = Math.ceil(Math.log2(n)) + 1; rule = "sturges"; }
  count = Math.min(HISTOGRAM_BINS.max, Math.max(HISTOGRAM_BINS.min, count));
  // All values equal: one unit-wide range around the value, still 5 bins (the value lands in the middle one).
  const lo = span > 0 ? min : min - 2.5;
  const width = span > 0 ? span / count : 1;
  const edges = Array.from({ length: count + 1 }, (_, index) => index === count && span > 0 ? max : lo + index * width);
  const counts = new Array<number>(count).fill(0);
  for (const value of sorted) {
    const bin = Math.min(count - 1, Math.max(0, Math.floor((value - lo) / width)));
    counts[bin]! += 1;
  }
  return { edges, counts, width, n, rule };
}

/** Whether directed links form a cycle (a sankey cannot draw one); returns one cycle's nodes, or null. */
export function findCycle(links: ReadonlyArray<readonly [string, string]>): string[] | null {
  const next = new Map<string, string[]>();
  for (const [source, target] of links) next.set(source, [...(next.get(source) ?? []), target]);
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (node: string): string[] | null => {
    state.set(node, 1);
    path.push(node);
    for (const target of next.get(node) ?? []) {
      if (state.get(target) === 1) return [...path.slice(path.indexOf(target)), target];
      if (!state.has(target)) {
        const found = visit(target);
        if (found) return found;
      }
    }
    path.pop();
    state.set(node, 2);
    return null;
  };
  for (const node of [...next.keys()].sort()) {
    if (state.has(node)) continue;
    const found = visit(node);
    if (found) return found;
  }
  return null;
}
