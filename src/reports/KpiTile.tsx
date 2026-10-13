import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { KpiBlock, ReportResult } from "../../shared/reports";
import { compactValue, formatValue, toNumber } from "./chartOption";

type Rows = Pick<ReportResult, "columns" | "rows">;
/** Other queries' results by key (a comparison or sparkline may read another query). */
export type ResultLookup = (queryKey: string) => Rows | null;

const columnOf = (result: Rows, name: string) => result.columns.findIndex((column) => column.name === name);

/** The comparison column a KPI names: v2's `compareTo`, else v1's `compareColumn`. */
export const kpiCompare = (block: KpiBlock) => block.compareTo ?? (block.compareColumn ? { column: block.compareColumn } : null);

export type KpiChange = { ratio: number; text: string; direction: "up" | "down" | "flat"; tone: "good" | "bad" | "neutral"; against: string };

/**
 * What a KPI tile shows: the first row's `column` (compacted: 1,284 / 12.9K / $4.2M, the full value
 * in its title), and its change against `compareTo` (a column of the same row, or the first row of
 * another query). A rise is good unless `upIsGood` is false; the tone colours the delta.
 */
export function kpiValue(block: KpiBlock, result: Rows, lookup: ResultLookup = () => null) {
  const index = columnOf(result, block.column);
  if (index < 0) return { problem: `The result has no column "${block.column}"`, text: "—", full: "—", change: null as KpiChange | null };
  const row = result.rows[0];
  if (!row) return { problem: "The query returned no rows", text: "—", full: "—", change: null as KpiChange | null };
  const value = row[index];
  let change: KpiChange | null = null;
  const compare = kpiCompare(block);
  if (compare) {
    const source = compare.queryKey ? lookup(compare.queryKey) : result;
    const compareIndex = source ? columnOf(source, compare.column) : -1;
    const current = toNumber(value);
    const previous = source && compareIndex >= 0 ? toNumber(source.rows[0]?.[compareIndex]) : null;
    if (current !== null && previous !== null && previous !== 0) {
      const ratio = (current - previous) / Math.abs(previous);
      const direction = Math.abs(ratio) < 0.0005 ? "flat" : ratio > 0 ? "up" : "down";
      const upIsGood = block.upIsGood !== false;
      const tone = direction === "flat" ? "neutral" : (direction === "up") === upIsGood ? "good" : "bad";
      change = { ratio, direction, tone, against: compare.column, text: `${ratio > 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%` };
    }
  }
  const number = toNumber(value);
  const full = formatValue(value, block.format, block.unit);
  // The unit is shown beside the figure (smaller), so the tile keeps one line; the full value (with its unit) is the title.
  const text = number !== null && block.format !== "date" && block.format !== "datetime" && block.format !== "text" ? compactValue(number, block.format) : formatValue(value, block.format);
  return { problem: null, text, full, change };
}

/** A sparkline's points (x order as the rows come), scaled into a 100 × 24 box; null with fewer than two numbers. */
export function sparklinePath(block: KpiBlock, lookup: ResultLookup): string | null {
  if (!block.sparkline) return null;
  const source = lookup(block.sparkline.queryKey);
  if (!source) return null;
  const yi = columnOf(source, block.sparkline.y);
  if (yi < 0) return null;
  const values = source.rows.slice(0, 500).map((row) => toNumber(row[yi])).filter((value): value is number => value !== null);
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values.map((value, at) => `${at === 0 ? "M" : "L"}${((at / (values.length - 1)) * 100).toFixed(2)} ${(22 - ((value - min) / span) * 20).toFixed(2)}`).join(" ");
}

/** A single headline number: label, value in the block's format, the delta against the comparison, and an optional sparkline. */
export function KpiTile({ block, result, lookup = () => null }: { block: KpiBlock; result: Rows; lookup?: ResultLookup }) {
  const { problem, text, full, change } = kpiValue(block, result, lookup);
  const Icon = change?.direction === "up" ? ArrowUpRight : change?.direction === "down" ? ArrowDownRight : Minus;
  const path = sparklinePath(block, lookup);
  return <div className={`report-kpi${block.hero ? " report-kpi-hero" : ""}`}>
    {/* The card's title names the tile; a label shows only when it says something else. */}
    {block.label && block.label !== block.title && <span className="report-kpi-label">{block.label}</span>}
    <strong className="report-kpi-value" title={full !== text ? full : undefined}>{text}{block.unit && block.format !== "percent" ? <span className="report-kpi-unit">{block.unit}</span> : null}</strong>
    {change && <span className={`report-kpi-change report-kpi-${change.direction} report-kpi-${change.tone}`}>
      <Icon aria-hidden="true" /><span className="report-kpi-delta">{change.text}</span>
      <span className="report-kpi-vs"> vs {change.against}</span>
      <span className="sr-only">{change.tone === "good" ? " (better)" : change.tone === "bad" ? " (worse)" : ""}</span>
    </span>}
    {path && <svg className="report-kpi-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><path d={path} /></svg>}
    {problem && <span className="report-block-problem">{problem}</span>}
  </div>;
}
