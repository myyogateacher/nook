/**
 * A key result's progress over time as a small line (D1386), from the goal's history (GET
 * /api/goals/:id/history, which the goal page already loads, so a goal with many key results costs no
 * request per row). Nothing for fewer than two points. The numbers are in its accessible name.
 */

export const SPARK_WIDTH = 72;
export const SPARK_HEIGHT = 20;

/** The polyline's points for progress values (0–1, clamped), oldest first, inside a 1px margin. */
export function sparkPoints(values: readonly number[], width = SPARK_WIDTH, height = SPARK_HEIGHT) {
  if (values.length < 2) return "";
  const step = (width - 2) / (values.length - 1);
  return values.map((value, index) => {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
    return `${(1 + index * step).toFixed(1)},${(1 + (1 - clamped) * (height - 2)).toFixed(1)}`;
  }).join(" ");
}

const pct = (value: number) => `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;

/** "Progress over time: 10% to 45%, 5 updates". */
export function sparkLabel(values: readonly number[]) {
  return `Progress over time: ${pct(values[0]!)} to ${pct(values[values.length - 1]!)}, ${values.length} updates`;
}

export function KrSparkline({ points }: { points: ReadonlyArray<{ at: string; progress: number }> | undefined }) {
  // The last 30 updates, oldest first: enough to read a trend at this size.
  const values = (points ?? []).slice().sort((a, b) => a.at.localeCompare(b.at)).slice(-30).map((point) => point.progress);
  if (values.length < 2) return null;
  const line = sparkPoints(values);
  const last = line.split(" ").pop()!.split(",");
  return <svg className="goals-kr-spark" width={SPARK_WIDTH} height={SPARK_HEIGHT} viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} role="img" aria-label={sparkLabel(values)}>
    <title>{sparkLabel(values)}</title>
    <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    <circle cx={last[0]} cy={last[1]} r="2" fill="currentColor" />
  </svg>;
}
