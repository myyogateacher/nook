import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, RotateCcw } from "lucide-react";
import { api } from "../api";
import { Select } from "../ui/Select";
import { InsightChart, KpiRow, KpiTile } from "../ui/insights/Insights";
import { messageOf } from "./chatApi";
import { AI_USAGE_RANGES, AI_USAGE_ROW_LIMIT, usageDailySeries, usageQuery, usageRange, usageSummary, usageTotals, type AiUsageGroup, type AiUsageRange, type AiUsageResponse } from "./aiUsageModel";

/**
 * Settings → AI → Usage (D1381; admins, as the whole page is): tokens and runs per day per person or
 * per agent, from GET /api/agents/admin/usage. Counts only (D73): admins never read chats here, and
 * Nook records no model or cost per run, so neither is shown. KPI tiles, a stacked chart of tokens
 * per day (the module Insights look, with its "Show as a table"), and a table of totals.
 */
export function AiUsage() {
  const [group, setGroup] = useState<AiUsageGroup>("user");
  const [range, setRange] = useState<AiUsageRange>(14);
  const [data, setData] = useState<AiUsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setError(null);
    const { from, to } = usageRange(range);
    try {
      const next = await api<AiUsageResponse>(`/agents/admin/usage?${usageQuery(group, from, to)}`);
      if (mine === generation.current) setData(next);
    } catch (reason) {
      if (mine === generation.current) setError(messageOf(reason, "Could not load usage"));
    }
  }, [group, range]);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const totals = useMemo(() => usageTotals(rows), [rows]);
  const summary = useMemo(() => usageSummary(rows), [rows]);
  const daily = useMemo(() => data ? usageDailySeries(rows, data.from, data.to) : null, [data, rows]);
  const who = group === "user" ? "Person" : "Agent";

  return <div className="ai-usage">
    <div className="settings-section-heading"><span className="settings-icon"><BarChart3 /></span><div><h3 id="ai-usage-heading">Usage</h3><p>Runs and tokens per day, per person or per agent. Counts only: no chat is read here, and Nook does not record a cost. Days are UTC, as the budgets are.</p></div></div>
    <div className="ai-usage-controls" role="group" aria-labelledby="ai-usage-heading">
      <Select<AiUsageGroup> label="Group by" value={group} onChange={setGroup} options={[{ value: "user", label: "By person" }, { value: "agent", label: "By agent" }]} />
      <Select<string> label="Date range" value={String(range)} onChange={(value) => setRange(Number(value) as AiUsageRange)} options={AI_USAGE_RANGES.map((days) => ({ value: String(days), label: `Last ${days} days` }))} />
      {data && <span className="chat-muted ai-usage-span">{data.from} to {data.to}</span>}
    </div>
    {error && <div className="ai-usage-error"><p className="form-error" role="alert">{error}</p><button type="button" className="secondary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button></div>}
    {!error && !data && <p className="chat-muted" role="status">Loading usage…</p>}
    {!error && data && <>
      <KpiRow>
        <KpiTile label="Runs" value={summary.runs} />
        <KpiTile label="Prompt tokens" value={summary.promptTokens} />
        <KpiTile label="Completion tokens" value={summary.completionTokens} />
        <KpiTile label="Total tokens" value={summary.promptTokens + summary.completionTokens} />
      </KpiRow>
      {rows.length >= AI_USAGE_ROW_LIMIT && <p className="settings-warning" role="note">This range has more rows than one page holds ({AI_USAGE_ROW_LIMIT.toLocaleString()}); the oldest days are left out. Pick a shorter range.</p>}
      {rows.length === 0
        ? <p className="chat-muted ai-usage-empty">No runs in this range.</p>
        : <>
          {daily && <InsightChart title="Tokens per day" kind="stacked" categories={daily.categories} series={daily.series} height={220} />}
          <div className="ai-usage-table-wrap">
            <table className="ui-chart-table ai-usage-table">
              <caption className="sr-only">Usage by {who.toLowerCase()}, {data.from} to {data.to}</caption>
              <thead><tr><th scope="col">{who}</th><th scope="col" className="number">Runs</th><th scope="col" className="number">Prompt</th><th scope="col" className="number">Completion</th><th scope="col" className="number">Total tokens</th></tr></thead>
              <tbody>{totals.map((row) => <tr key={row.id}>
                <th scope="row">{row.name}</th>
                <td className="number">{row.runs.toLocaleString()}</td>
                <td className="number">{row.promptTokens.toLocaleString()}</td>
                <td className="number">{row.completionTokens.toLocaleString()}</td>
                <td className="number">{row.totalTokens.toLocaleString()}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </>}
    </>}
  </div>;
}
