import type { CaseResult, EvalReport, Fact, FactResult } from "./types";

/**
 * Scoring a generated report against a case's expected facts (pure). The persisted results of the
 * run are searched, not the model's words: a fact passes when a value in some result matches it.
 *
 * - A number matches within its relative tolerance (default 0.5 %). With `row`, the matching cell's
 *   row must also hold that text (a category, a step, a date prefix).
 * - A percent fact (a ratio) matches as the ratio when the block that shows the column formats it as
 *   `percent`, or as ×100 when it does not (unit %, number, or no block); a ratio shown with the wrong
 *   format fails, which is how "percent stored as 0–1" is scored.
 * - A top fact passes when, in some result a block draws, the row with the largest value of a
 *   measure the block shows (a unique maximum) holds the text.
 */

export type ScoredResult = { queryKey: string; columns: Array<{ name: string; type: string }>; rows: unknown[][] };
type Block = Record<string, unknown> & { type?: string; queryKey?: string };

export const DEFAULT_TOLERANCE = 0.005;

export const numberOf = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value.trim())) return Number(value);
  return null;
};

const textOf = (value: unknown) => value === null || value === undefined ? "" : String(value);
const near = (cell: number, want: number, tolerance: number) => Math.abs(cell - want) <= Math.max(tolerance * Math.abs(want), 1e-9 * Math.max(1, Math.abs(want)));
const rowHas = (row: unknown[], text: string) => row.some((cell) => {
  const value = textOf(cell).toLowerCase();
  const wanted = text.toLowerCase();
  return value === wanted || (/^\d{4}-\d{2}-\d{2}/.test(wanted) && value.startsWith(wanted));
});

/** How a block shows a column of a query: its format and unit (null when no block shows it). */
export function displayOf(blocks: readonly Block[], queryKey: string, column: string): { format: string | null; unit: string | null } | null {
  for (const block of blocks) {
    if (block.queryKey !== queryKey) continue;
    const format = typeof block.format === "string" ? block.format : null;
    const unit = typeof block.unit === "string" ? block.unit : null;
    if (block.type === "kpi" && block.column === column) return { format, unit };
    if (block.type === "chart" && Array.isArray(block.y) && (block.y as string[]).includes(column)) return { format, unit };
    if (block.type === "table") {
      const formats = (block.formats ?? {}) as Record<string, string>;
      const columns = block.columns as string[] | undefined;
      if (!columns || columns.includes(column)) return { format: formats[column] ?? null, unit: null };
    }
  }
  return null;
}

/** The measures blocks draw from a query (KPI columns, chart y columns). */
function measuresOf(blocks: readonly Block[], queryKey: string): Set<string> {
  const out = new Set<string>();
  for (const block of blocks) {
    if (block.queryKey !== queryKey) continue;
    if (block.type === "kpi" && typeof block.column === "string") out.add(block.column);
    if (block.type === "chart" && Array.isArray(block.y)) for (const name of block.y as string[]) out.add(name);
    if (block.type === "table") for (const name of (block.columns as string[] | undefined) ?? []) out.add(name);
  }
  return out;
}

const show = (value: number) => Number.isInteger(value) ? String(value) : String(Math.round(value * 10_000) / 10_000);

function scoreOne(fact: Fact, blocks: readonly Block[], results: readonly ScoredResult[]): FactResult {
  if (fact.kind === "top") {
    for (const result of results) {
      if (result.rows.length < 2) continue;
      const measures = measuresOf(blocks, result.queryKey);
      for (let index = 0; index < result.columns.length; index += 1) {
        if (!measures.has(result.columns[index]!.name)) continue;
        const values = result.rows.map((row) => numberOf(row[index]));
        if (values.some((value) => value === null)) continue;
        const max = Math.max(...(values as number[]));
        const at = values.flatMap((value, row) => value === max ? [row] : []);
        if (at.length !== 1) continue;
        const row = result.rows[at[0]!]!;
        const label = row.filter((cell, column) => column !== index && numberOf(cell) === null).map(textOf).join(" / ");
        if (rowHas(row, fact.value)) return { id: fact.id, label: fact.label, expected: fact.value, pass: true, found: `${result.queryKey}.${result.columns[index]!.name}: ${label}` };
      }
    }
    // Report what topped the first ranked result instead.
    const first = results.find((result) => result.rows.length >= 2);
    return { id: fact.id, label: fact.label, expected: fact.value, pass: false, found: first ? `${first.queryKey}: ${first.rows[0]!.map(textOf).join(" / ").slice(0, 80)}` : null };
  }
  const tolerance = fact.tolerance ?? DEFAULT_TOLERANCE;
  let nearest: { value: number; where: string } | null = null;
  let wrongFormat: string | null = null;
  for (const result of results) {
    result.columns.forEach((column, index) => {
      for (const row of result.rows) {
        const cell = numberOf(row[index]);
        if (cell === null) continue;
        if (fact.row && !rowHas(row, fact.row)) continue;
        const where = `${result.queryKey}.${column.name}`;
        const display = displayOf(blocks, result.queryKey, column.name);
        if (fact.percent) {
          const asRatio = near(cell, fact.value, tolerance);
          const asPercent = near(cell, fact.value * 100, tolerance);
          if (!asRatio && !asPercent) continue;
          const percentFormat = display?.format === "percent";
          if (!display || (asRatio && percentFormat) || (asPercent && !percentFormat)) { nearest = { value: cell, where }; return; }
          wrongFormat = `${where} = ${show(cell)} shown with ${display.format ? `format ${display.format}` : display.unit ? `unit ${display.unit}` : "no format"}`;
          continue;
        }
        if (near(cell, fact.value, tolerance)) { nearest = { value: cell, where }; return; }
      }
    });
    if (nearest) break;
  }
  if (nearest) {
    const found = nearest as { value: number; where: string };
    return { id: fact.id, label: fact.label, expected: show(fact.value), pass: true, found: `${found.where} = ${show(found.value)}` };
  }
  return { id: fact.id, label: fact.label, expected: `${show(fact.value)}${fact.percent ? " (ratio)" : ""}${fact.row ? ` in row ${fact.row}` : ""}`, pass: false, found: wrongFormat ?? closest(fact.value, results, fact.row) };
}

/** The closest number the results hold (what the report said instead), for the failure line. */
function closest(want: number, results: readonly ScoredResult[], row?: string): string | null {
  let best: { distance: number; text: string } | null = null;
  for (const result of results) {
    result.columns.forEach((column, index) => {
      for (const line of result.rows) {
        if (row && !rowHas(line, row)) continue;
        const cell = numberOf(line[index]);
        if (cell === null || /(^|_)(id|year|month|day|n)$/.test(column.name)) continue;
        const distance = Math.abs(Math.log(Math.abs(cell) + 1e-9) - Math.log(Math.abs(want) + 1e-9));
        if (!best || distance < best.distance) best = { distance, text: `${result.queryKey}.${column.name} = ${show(cell)}` };
      }
    });
  }
  return (best as { text: string } | null)?.text ?? null;
}

export function scoreFacts(facts: readonly Fact[], blocks: readonly Block[], results: readonly ScoredResult[]): FactResult[] {
  return facts.map((fact) => scoreOne(fact, blocks, results));
}

// ------------------------------------------------------------------------------------- the report

const pad = (text: string, width: number) => text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
const yesNo = (value: boolean | null) => value === null ? "–" : value ? "yes" : "no";

/** The per-case table and the failing facts, as the CLI prints them. */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`Report eval: ${report.provider.kind} ${report.provider.model}, ClickHouse ${report.clickhouse}, ${report.cases.length} runs`);
  const head = ["case", "variant", "facts", "1st ok", "retries", "nudges", "hints", "tools", "tokens in/out", "wall s", "run"];
  const widths = [22, 7, 7, 6, 7, 6, 5, 5, 15, 7, 36];
  lines.push(head.map((cell, at) => pad(cell, widths[at]!)).join(" "));
  for (const item of report.cases) {
    lines.push([
      item.id, item.variant, `${item.passed}/${item.facts.length}`, yesNo(item.firstSubmitPass), String(item.retries), String(item.nudges), String(item.sanityHints), String(item.toolCalls),
      `${item.promptTokens}/${item.completionTokens}`, (item.wallMs / 1000).toFixed(1), item.runId ?? "–"
    ].map((cell, at) => pad(cell, widths[at]!)).join(" "));
  }
  const failing = report.cases.flatMap((item) => [
    ...(item.error ? [`  ${item.id} (${item.variant}): ${item.error}`] : []),
    ...item.facts.filter((fact) => !fact.pass).map((fact) => `  ${item.id} (${item.variant}) ✗ ${fact.label}: expected ${fact.expected}, found ${fact.found ?? "nothing close"}`)
  ]);
  if (failing.length) lines.push("", "Failing:", ...failing);
  const totals = report.totals;
  lines.push("", `Facts ${totals.passed}/${totals.facts}; first-submit passes ${totals.firstSubmitPasses}/${totals.cases}; tokens ${totals.promptTokens}/${totals.completionTokens}; ${(totals.wallMs / 1000).toFixed(1)} s`);
  if (report.dataDir) lines.push(`Runs: DATA_DIR=${report.dataDir} (sign-in in eval-login.txt there); open ${report.origin ?? ""}/reports/<report id> → Runs.`);
  return lines.join("\n");
}

export function totalsOf(cases: readonly CaseResult[]): EvalReport["totals"] {
  return {
    cases: cases.length,
    facts: cases.reduce((sum, item) => sum + item.facts.length, 0),
    passed: cases.reduce((sum, item) => sum + item.passed, 0),
    firstSubmitPasses: cases.filter((item) => item.firstSubmitPass).length,
    wallMs: cases.reduce((sum, item) => sum + item.wallMs, 0),
    promptTokens: cases.reduce((sum, item) => sum + item.promptTokens, 0),
    completionTokens: cases.reduce((sum, item) => sum + item.completionTokens, 0)
  };
}

/** `--compare a.json b.json`: facts that flipped and the per-case cost deltas. */
export function compareReports(a: EvalReport, b: EvalReport): string {
  const lines = [`Compare: A ${a.provider.model} (${a.startedAt}) vs B ${b.provider.model} (${b.startedAt})`];
  const key = (item: CaseResult) => `${item.id}/${item.variant}`;
  const before = new Map(a.cases.map((item) => [key(item), item]));
  const after = new Map(b.cases.map((item) => [key(item), item]));
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const x = before.get(id);
    const y = after.get(id);
    if (!x || !y) { lines.push(`  ${id}: only in ${x ? "A" : "B"}`); continue; }
    const flips = y.facts.flatMap((fact) => {
      const old = x.facts.find((item) => item.id === fact.id);
      if (!old || old.pass === fact.pass) return [];
      return [`${fact.pass ? "fixed" : "broke"} ${fact.id}`];
    });
    const delta = (name: string, from: number, to: number) => from === to ? null : `${name} ${from}→${to}`;
    const changes = [
      delta("facts", x.passed, y.passed), delta("retries", x.retries, y.retries), delta("nudges", x.nudges, y.nudges), delta("tools", x.toolCalls, y.toolCalls),
      delta("tokens", x.promptTokens + x.completionTokens, y.promptTokens + y.completionTokens), x.firstSubmitPass !== y.firstSubmitPass ? `1st ok ${yesNo(x.firstSubmitPass)}→${yesNo(y.firstSubmitPass)}` : null
    ].filter(Boolean);
    lines.push(`  ${pad(id, 30)} ${[...flips, ...changes].join("; ") || "same"}`);
  }
  lines.push(`Totals: facts ${a.totals.passed}/${a.totals.facts} → ${b.totals.passed}/${b.totals.facts}; first-submit ${a.totals.firstSubmitPasses} → ${b.totals.firstSubmitPasses}; tokens ${a.totals.promptTokens + a.totals.completionTokens} → ${b.totals.promptTokens + b.totals.completionTokens}`);
  return lines.join("\n");
}
