import { useMemo } from "react";
import { ChartColumn, Gauge, Table2 } from "lucide-react";
import { Markdown, type RenderContext } from "../chat/markdown/render";
import type { ReportBlock, ReportResult, ReportSpec, ValueFormat } from "../../shared/reports";
import { cellText, countLabel } from "./reportsApi";

/**
 * A plain preview of a generated spec (Wave 46) until wave 47's viewer (ReportView, charts) replaces
 * it: markdown blocks as markdown, a KPI as its number, and chart and table blocks as the table of
 * their query's latest stored result. Kept in its own file so the swap is one import.
 */

const PREVIEW_ROWS = 50;

/** A KPI value in its format (a light version of what wave 47's viewer does). */
export function formatValue(value: unknown, format: ValueFormat | undefined): string {
  if (value === null || value === undefined) return "—";
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  if (number === null || format === "text" || format === "date" || format === "datetime") return cellText(value);
  if (format === "percent") return `${(number * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  if (format === "currency") return number.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  if (format === "integer") return Math.round(number).toLocaleString();
  if (format === "bytes") return number >= 1e9 ? `${(number / 1e9).toFixed(1)} GB` : number >= 1e6 ? `${(number / 1e6).toFixed(1)} MB` : number >= 1e3 ? `${(number / 1e3).toFixed(1)} KB` : `${number} B`;
  if (format === "duration_s") return number >= 3600 ? `${(number / 3600).toFixed(1)} h` : number >= 60 ? `${(number / 60).toFixed(1)} min` : `${number} s`;
  return number.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function ResultTable({ result, columns }: { result: ReportResult; columns?: string[] }) {
  const picked = columns?.length ? columns.map((name) => result.columns.findIndex((column) => column.name === name)).filter((index) => index >= 0) : result.columns.map((_, index) => index);
  const rows = result.rows.slice(0, PREVIEW_ROWS);
  return <>
    <div className="report-table-scroll" tabIndex={0} role="region" aria-label={`Rows of ${result.queryKey}`}>
      <table className="report-table">
        <thead><tr>{picked.map((index) => <th key={index} scope="col"><span>{result.columns[index]!.name}</span><small>{result.columns[index]!.type}</small></th>)}</tr></thead>
        <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{picked.map((index) => <td key={index} className={row[index] === null ? "report-null" : undefined}>{cellText(row[index])}</td>)}</tr>)}</tbody>
      </table>
    </div>
    <p className="spec-preview-facts">{countLabel(result.rowCount)}{result.truncated ? " (cut)" : ""}{result.rowCount > PREVIEW_ROWS ? `, first ${PREVIEW_ROWS} shown` : ""}</p>
  </>;
}

function BlockView({ block, results, context }: { block: ReportBlock; results: ReadonlyMap<string, ReportResult>; context: RenderContext }) {
  if (block.type === "markdown") return <div className="spec-block spec-markdown">{block.title && <h3>{block.title}</h3>}<Markdown text={block.markdown} context={context} /></div>;
  const result = results.get(block.queryKey);
  const missing = <p className="spec-preview-facts">No stored result for {block.queryKey} yet.</p>;
  if (block.type === "kpi") {
    const at = result?.columns.findIndex((column) => column.name === block.column) ?? -1;
    const compareAt = block.compareColumn ? result?.columns.findIndex((column) => column.name === block.compareColumn) ?? -1 : -1;
    const row = result?.rows[0];
    return <div className="spec-block spec-kpi">
      <span className="spec-kind"><Gauge aria-hidden="true" />{block.label ?? block.title ?? block.column}</span>
      {result ? <strong>{row && at >= 0 ? formatValue(row[at], block.format) : "—"}</strong> : missing}
      {row && compareAt >= 0 && <span className="spec-preview-facts">Before: {formatValue(row[compareAt], block.format)}</span>}
    </div>;
  }
  if (block.type === "chart") {
    return <div className="spec-block">
      <h3>{block.title ?? block.queryKey}</h3>
      <p className="spec-kind"><ChartColumn aria-hidden="true" />{block.kind.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase())} chart of {block.y.join(", ")} by {block.x}{block.series ? `, split by ${block.series}` : ""}</p>
      {result ? <ResultTable result={result} columns={[block.x, ...(block.series ? [block.series] : []), ...block.y]} /> : missing}
    </div>;
  }
  return <div className="spec-block">
    <h3>{block.title ?? block.queryKey}</h3>
    <p className="spec-kind"><Table2 aria-hidden="true" />Table</p>
    {result ? <ResultTable result={result} columns={block.columns} /> : missing}
  </div>;
}

export function SpecPreview({ spec, results }: { spec: ReportSpec; results: ReportResult[] }) {
  const byKey = useMemo(() => new Map(results.map((result) => [result.queryKey, result])), [results]);
  // Model-written markdown: outside links open in a new tab without the opener; images are never fetched.
  const context = useMemo<RenderContext>(() => ({
    onExternalLink: (href) => { window.open(href, "_blank", "noopener,noreferrer"); },
    onNookLink: (path) => { window.location.assign(path); },
    images: { mode: "public" }
  }), []);
  return <section className="spec-preview" aria-label="Report">
    {spec.blocks.map((block) => <BlockView key={block.id} block={block} results={byKey} context={context} />)}
  </section>;
}
