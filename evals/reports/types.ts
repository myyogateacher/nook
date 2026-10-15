/**
 * The report eval's case format (docs/OPERATIONS.md "Report generation eval"). A case is a folder in
 * evals/reports/cases/<id>/ with:
 *
 * - `doc.md`: the document the report is generated from (metrics, rules, tables). `{{link:<name>}}`
 *   is replaced by the link of the linked page `<name>.md` (a second Nook note created next to it).
 * - `seed.sql`: drops and recreates the `eval_<id>` database with its tables and data (fixed dates,
 *   deterministic values), run against the operator's ClickHouse before each run.
 * - `case.ts`: the expected facts, the golden spec the scripted provider submits, and optionally a
 *   trap spec (the plausible wrong report) with the facts it must fail.
 * - `fixtures.json` (written by `--record`): what ClickHouse answered to every statement of the
 *   golden and trap runs, replayed by the deterministic CI subset without a ClickHouse.
 */

/** A number the report must contain somewhere in its results (relative tolerance, default 0.5 %). */
export type NumberFact = {
  id: string;
  label: string;
  kind: "number";
  value: number;
  tolerance?: number;
  /** The value is a ratio: 0.234 or 23.4 both count. */
  percent?: boolean;
  /** The number must sit in a row that also holds this text (a category, a step, a date). */
  row?: string;
};

/** A label that must top a ranked result: the row with the largest value of some numeric column. */
export type TopFact = { id: string; label: string; kind: "top"; value: string };

/** D488: the report draws some chart in one of these kinds (a funnel, a cohort heatmap, a bullet …). */
export type ChartFact = { id: string; label: string; kind: "chart"; value: string[] };

export type Fact = NumberFact | TopFact | ChartFact;

export type EvalQuery = { key: string; sql: string; purpose: string };
/** A spec as the scripted provider submits it (submit_report's arguments, title included). */
export type EvalSpec = { title: string; sections?: Array<{ id: string; title: string }>; queries: EvalQuery[]; blocks: Array<Record<string, unknown>> };

export type EvalCase = {
  id: string;
  title: string;
  /** The traps the case sets, in words (the report shows them). */
  traps: string[];
  facts: Fact[];
  /** Doc tools the run may use (the linked-page case): Nook's read_note and search_notes. */
  browseTools?: string[];
  golden: EvalSpec;
  trap?: { spec: EvalSpec; fails: string[]; /** The sanity checks (E2) that must refuse its first submit. */ sanity?: string[] };
  /** E4: what the scripted provider's metric extraction records (the real model extracts its own). */
  catalog?: Array<Record<string, unknown>>;
  /** In the deterministic CI subset (replayed from fixtures.json). */
  ci?: boolean;
};

export type LoadedCase = EvalCase & { dir: string; doc: string; linked: Record<string, string>; seed: string; fixtures: Fixtures | null };

/** Recorded ClickHouse answers: the statement text → status and body. */
export type Fixtures = { recordedAt: string; version: string; answers: Record<string, { status: number; body: string; exceptionCode?: string | null }> };

export type FactResult = { id: string; label: string; expected: string; pass: boolean; found: string | null };

export type CaseResult = {
  id: string;
  variant: "model" | "golden" | "trap";
  ok: boolean;
  error: string | null;
  reportId: string | null;
  runId: string | null;
  agentRunId: string | null;
  runStatus: string | null;
  facts: FactResult[];
  passed: number;
  /** The first submit_report passed the checks. */
  firstSubmitPass: boolean | null;
  submits: number;
  retries: number;
  nudges: number;
  /** Sanity-check hints (E2) the run's submits got back. */
  sanityHints: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  wallMs: number;
  model: string | null;
};

export type EvalReport = {
  startedAt: string;
  finishedAt: string;
  provider: { kind: "scripted" | "openai-compatible"; model: string; baseUrl: string | null };
  clickhouse: "real" | "fixtures";
  dataDir: string | null;
  origin: string | null;
  cases: CaseResult[];
  totals: { cases: number; facts: number; passed: number; firstSubmitPasses: number; wallMs: number; promptTokens: number; completionTokens: number };
};
