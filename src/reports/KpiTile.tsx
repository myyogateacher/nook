import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { KpiBlock, ReportResult } from "../../shared/reports";
import { formatValue, toNumber } from "./chartOption";

/** What a KPI tile shows: the first row's `column`, and its change from `compareColumn` when there is one. */
export function kpiValue(block: KpiBlock, result: Pick<ReportResult, "columns" | "rows">) {
  const index = result.columns.findIndex((column) => column.name === block.column);
  if (index < 0) return { problem: `The result has no column "${block.column}"`, text: "—", change: null };
  const row = result.rows[0];
  if (!row) return { problem: "The query returned no rows", text: "—", change: null };
  const value = row[index];
  let change: { ratio: number; text: string; direction: "up" | "down" | "flat" } | null = null;
  if (block.compareColumn) {
    const compareIndex = result.columns.findIndex((column) => column.name === block.compareColumn);
    const current = toNumber(value);
    const previous = compareIndex >= 0 ? toNumber(row[compareIndex]) : null;
    if (current !== null && previous !== null && previous !== 0) {
      const ratio = (current - previous) / Math.abs(previous);
      const direction = Math.abs(ratio) < 0.0005 ? "flat" : ratio > 0 ? "up" : "down";
      change = { ratio, direction, text: `${ratio > 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%` };
    }
  }
  return { problem: null, text: formatValue(value, block.format), change };
}

/** A single headline number (plan wave 47): label, value in the block's format, and the change against the comparison column. */
export function KpiTile({ block, result }: { block: KpiBlock; result: Pick<ReportResult, "columns" | "rows"> }) {
  const { problem, text, change } = kpiValue(block, result);
  const Icon = change?.direction === "up" ? ArrowUpRight : change?.direction === "down" ? ArrowDownRight : Minus;
  return <div className="report-kpi">
    {/* The card's title names the tile; a label shows only when it says something else. */}
    {block.label && block.label !== block.title && <span className="report-kpi-label">{block.label}</span>}
    <strong className="report-kpi-value">{text}</strong>
    {change && <span className={`report-kpi-change report-kpi-${change.direction}`}><Icon aria-hidden="true" />{change.text}<span className="report-kpi-vs"> vs {block.compareColumn}</span></span>}
    {problem && <span className="report-block-problem">{problem}</span>}
  </div>;
}
