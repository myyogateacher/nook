import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, Download, Filter, KeyRound, ScrollText, Wrench, Cpu } from "lucide-react";
import { ApiError } from "../api";
import { ModalDialog } from "../files/Dialog";
import { Select, type Option } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { auditRoute, chatRoute, type ChatRoute } from "../chatRoute";
import type { AuditFacets, AuditRunDetail, AuditRunSummary, AuditStepView, RunStatus } from "../../shared/agents";
import { auditExportUrl, auditFacets, getAuditRun, listAudit, messageOf, type AuditFilter } from "./chatApi";
import { Markdown, type RenderContext } from "./markdown/render";
import { FormError } from "../ui/FormError";

/**
 * The Audit log (Wave 42 "AC-C", agent chat plan §7.3, §13.3, D366): every API and MCP run of the
 * reader's keys, and for admins every key's runs as metadata. A list of cards (agent, key, status,
 * steps, tokens, duration, time) with filters in a sheet; a card pushes /chat/audit/:runId, a
 * timeline of the run's steps with the input on top and the output at the bottom. On phones the
 * list and the run are two screens with Back parity; the filter sheet closes on Back first. The
 * run's content (input, output, arguments, results, label) shows only to the key's owner; an
 * admin reading someone else's run sees what the server sends: metadata and tool names.
 * Export downloads JSON of the reader's own runs (one, or up to 1,000 matching the filters).
 */

export const STATUS_FILTERS: Option<string>[] = [
  { value: "", label: "Any status" },
  { value: "ok", label: "Finished" },
  { value: "failed", label: "Failed", description: "Errors, timeouts, budgets, and restarts" },
  { value: "cancelled", label: "Cancelled" },
  { value: "step_limit", label: "Step limit" },
  { value: "running", label: "Running" }
];

const STATUS_TEXT: Record<RunStatus, string> = {
  queued: "Queued", running: "Running", awaiting_confirmation: "Waiting", ok: "Finished", error: "Failed", cancelled: "Cancelled",
  interrupted: "Interrupted", timeout: "Timed out", step_limit: "Step limit", budget: "Budget used up"
};

/** The status chip's text and tone. */
export function auditStatus(run: Pick<AuditRunSummary, "status" | "errorCode">): { label: string; tone: "ok" | "warn" | "danger" | "muted" } {
  const label = run.errorCode === "KEY_INACTIVE" ? "Key no longer valid" : STATUS_TEXT[run.status] ?? run.status;
  const tone = run.status === "ok" ? "ok" : run.status === "running" || run.status === "queued" ? "muted" : run.status === "cancelled" || run.status === "step_limit" ? "warn" : "danger";
  return { label, tone };
}

/** "1.2 s", "340 ms", "2 min 5 s". */
export function formatDuration(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** The card's second line: key, steps, tokens, duration. */
export function auditCardMeta(run: AuditRunSummary) {
  const tokens = run.promptTokens + run.completionTokens;
  return [
    run.via === "reports" ? "Report generation" : run.key ? `${run.key.name} (${run.key.prefix}…)` : "Key removed",
    run.via === "reports" ? null : run.via === "mcp" ? "MCP" : "API",
    `${run.steps} ${run.steps === 1 ? "step" : "steps"}`,
    run.toolCalls ? `${run.toolCalls} ${run.toolCalls === 1 ? "tool call" : "tool calls"}` : null,
    `${tokens.toLocaleString()} tokens${run.estimated ? " (est.)" : ""}`,
    formatDuration(run.durationMs)
  ].filter(Boolean).join(" · ");
}

/** One date format for the cards and the run (QA L5): "6 Oct 2026, 11:41" in the reader's locale. */
export const formatWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
export const formatDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * The filter sheet's options (QA M3): the reader's keys and agents from the server's facets, so a
 * key or agent with no run on the loaded page can be chosen; the loaded runs fill in while the
 * facets load; the current choice is always kept.
 */
export function filterChoices(facets: AuditFacets | null, runs: readonly AuditRunSummary[], filter: AuditFilter) {
  const keys = new Map<string, string>();
  const agents = new Map<string, string>();
  for (const key of facets?.keys ?? []) keys.set(key.id, `${key.name} (${key.prefix}…)${key.own || !key.ownerName ? "" : ` · ${key.ownerName}`}`);
  for (const agent of facets?.agents ?? []) agents.set(agent.id, agent.name ?? "(removed agent)");
  for (const run of runs) {
    if (run.key && !keys.has(run.key.id)) keys.set(run.key.id, `${run.key.name} (${run.key.prefix}…)`);
    if (!agents.has(run.agentId)) agents.set(run.agentId, run.agentName ?? "(removed agent)");
  }
  if (filter.key && !keys.has(filter.key)) keys.set(filter.key, "The chosen key");
  if (filter.agent && !agents.has(filter.agent)) agents.set(filter.agent, "The chosen agent");
  return {
    keys: [{ value: "", label: "Any key" }, ...[...keys].map(([value, label]) => ({ value, label }))] as Option<string>[],
    agents: [{ value: "", label: "Any agent" }, ...[...agents].map(([value, label]) => ({ value, label }))] as Option<string>[]
  };
}

export const activeFilterCount = (filter: AuditFilter) => [filter.key, filter.agent, filter.status, filter.from, filter.to].filter(Boolean).length;

type AuditLogProps = {
  route: ChatRoute;
  role: string;
  phone: boolean;
  go: (route: ChatRoute, replace?: boolean) => void;
  back: () => void;
  context: RenderContext;
};

export function AuditLog({ route, role, phone, go, back, context }: AuditLogProps) {
  // The filters live in the URL (QA L4): applying them pushes an entry, so Back restores the previous ones.
  const filterKey = JSON.stringify(route.auditFilter ?? {});
  const filter = useMemo<AuditFilter>(() => ({ ...(route.auditFilter ?? {}) }), [filterKey]);
  const [facets, setFacets] = useState<AuditFacets | null>(null);
  const [runs, setRuns] = useState<AuditRunSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [detail, setDetail] = useState<AuditRunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const runId = route.runId ?? null;

  const load = useCallback(async (next: AuditFilter) => {
    setListError(null);
    try {
      const page = await listAudit(next);
      setRuns(page.runs);
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setListError(messageOf(reason, "Could not load the Audit log"));
    }
  }, []);
  useEffect(() => { setRuns(null); void load(filter); }, [filter, load]);
  useEffect(() => {
    let cancelled = false;
    auditFacets().then((result) => { if (!cancelled) setFacets(result.facets); }, () => undefined);
    return () => { cancelled = true; };
  }, []);

  const more = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listAudit(filter, nextCursor);
      setRuns((current) => [...(current ?? []), ...page.runs]);
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setListError(messageOf(reason, "Could not load more runs"));
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (!runId) { setDetail(null); setDetailError(null); return; }
    let cancelled = false;
    setDetail((current) => current?.id === runId ? current : null);
    setDetailError(null);
    getAuditRun(runId).then((result) => { if (!cancelled) setDetail(result.run); }, (reason) => {
      if (cancelled) return;
      setDetailError(reason instanceof ApiError && reason.status === 404 ? "This run is not in your Audit log (it may have passed its retention)." : messageOf(reason, "Could not open this run"));
    });
    return () => { cancelled = true; };
  }, [runId]);

  const choices = useMemo(() => filterChoices(facets, runs ?? [], filter), [facets, filter, runs]);
  const count = activeFilterCount(filter);
  const admin = role === "admin";

  const list = <section className="chat-list-pane split-pane audit-list-pane" aria-label="Audit log">
    <div className="audit-top">
      {/* On the list alone this is the in-app Back (history parity); beside an open run it goes to the chats. */}
      <button type="button" className="chat-link audit-back-link" onClick={() => { if (runId) go(chatRoute()); else back(); }}><ChevronLeft aria-hidden="true" />Chats</button>
      <h2 className="audit-title"><ScrollText aria-hidden="true" />Audit log</h2>
      <p className="chat-muted">Runs of your agents through API keys and MCP, kept for a limited time. They never appear as chats.{admin ? " As an admin you see every key's runs as metadata; their content only for your own keys." : ""}</p>
      <div className="audit-actions">
        <button type="button" className="secondary-button" onClick={() => setFiltering(true)} aria-haspopup="dialog"><Filter aria-hidden="true" />Filters{count ? ` (${count})` : ""}</button>
        <a className="secondary-button" href={auditExportUrl(filter)} download title="Your own runs that match the filters, up to 1,000, as JSON"><Download aria-hidden="true" />Export</a>
      </div>
    </div>
    <FormError message={listError} />
    {runs === null ? <p className="chat-muted" role="status">Loading…</p>
      : runs.length === 0 ? <p className="chat-muted">{count ? "No runs match these filters." : "No runs yet. Runs appear here when a key with “Run agents” calls one of your agents."}</p>
      : <ul className="audit-cards">{runs.map((run) => {
        const status = auditStatus(run);
        return <li key={run.id}><button type="button" className={`audit-card${runId === run.id ? " active" : ""}`} aria-current={runId === run.id ? "page" : undefined} onClick={() => go(auditRoute(run.id, filter))}>
          <span className="audit-card-head"><span className="audit-card-agent">{run.agentName ?? "(removed agent)"}</span><span className={`audit-chip audit-chip-${status.tone}`}>{status.label}</span></span>
          <span className="audit-card-meta">{auditCardMeta(run)}</span>
          <span className="audit-card-meta">{formatWhen(run.queuedAt)}{!run.full && run.owner.displayName ? ` · ${run.owner.displayName}` : ""}{run.full && run.label ? ` · ${run.label}` : ""}</span>
        </button></li>;
      })}</ul>}
    {nextCursor && <button type="button" className="secondary-button audit-more" onClick={() => { void more(); }} disabled={loadingMore}>{loadingMore ? "Loading…" : "Show older runs"}</button>}
  </section>;

  const pane = <section className="chat-pane split-pane audit-pane" aria-label="Run">
    {!runId ? <div className="chat-placeholder"><ScrollText /><p>Pick a run to see its steps.</p></div>
      : detailError ? <div className="chat-state chat-error" role="alert"><p>{detailError}</p><button type="button" className="secondary-button" onClick={() => go(auditRoute(null, filter), true)}>Back to the Audit log</button></div>
      : !detail ? <p className="chat-muted chat-loading" role="status">Loading…</p>
      : <AuditRunView run={detail} phone={phone} onBack={back} context={context} />}
  </section>;

  return <>
    <div className="chat-layout split-layout audit-layout">{list}{pane}</div>
    {filtering && <AuditFilterSheet filter={filter} choices={choices} onClose={() => setFiltering(false)} onApply={(next) => { setFiltering(false); go(auditRoute(runId, next)); }} />}
  </>;
}

function AuditRunView({ run, phone, onBack, context }: { run: AuditRunDetail; phone: boolean; onBack: () => void; context: RenderContext }) {
  const status = auditStatus(run);
  return <article className="audit-run">
    <header className="chat-thread-header audit-run-header">
      {phone && <button type="button" className="icon-button chat-back" onClick={onBack} aria-label="Back to the Audit log"><ChevronLeft /></button>}
      <span className="chat-agent-chip audit-agent">{run.agentName ?? "(removed agent)"}</span>
      <span className={`audit-chip audit-chip-${status.tone}`}>{status.label}</span>
      {run.full && <a className="secondary-button audit-export-one" href={auditExportUrl({}, run.id)} download><Download aria-hidden="true" />Export</a>}
    </header>
    <dl className="audit-facts">
      {run.via === "reports" ? <div><dt>Source</dt><dd>Report generation (no key)</dd></div> : <div><dt>Key</dt><dd><KeyRound aria-hidden="true" />{run.key ? `${run.key.name} (${run.key.prefix}…)` : "Key removed"} · {run.via === "mcp" ? "MCP" : "REST API"}</dd></div>}
      {!run.full && <div><dt>Owner</dt><dd>{run.owner.displayName ?? "Removed account"}</dd></div>}
      <div><dt>Started</dt><dd>{formatWhen(run.queuedAt)}</dd></div>
      <div><dt>Model</dt><dd><code>{run.model}</code></dd></div>
      <div><dt>Tokens</dt><dd>{run.promptTokens.toLocaleString()} in · {run.completionTokens.toLocaleString()} out{run.estimated ? " (estimated)" : ""}</dd></div>
      <div><dt>Time</dt><dd>{formatDuration(run.durationMs)}{run.firstTokenAt ? ` · first token after ${formatDuration(Date.parse(run.firstTokenAt) - Date.parse(run.queuedAt))}` : ""}</dd></div>
      {run.errorCode && <div><dt>Error</dt><dd><code>{run.errorCode}</code></dd></div>}
      {run.full && run.label && <div><dt>Label</dt><dd>{run.label}</dd></div>}
      {run.full && run.clientAddress && <div><dt>From</dt><dd>{run.clientAddress}</dd></div>}
      {run.purgeAfter && <div><dt>Kept until</dt><dd>{formatDay(run.purgeAfter)}</dd></div>}
    </dl>
    {!run.full && <p className="audit-notice" role="note">Metadata only: the input, output, arguments, and results belong to the key's owner. Tools used: {run.toolNames.length ? run.toolNames.join(", ") : "none"}.</p>}
    {run.full && <section className="audit-block"><h3>Input</h3><pre className="audit-pre">{run.input ?? ""}</pre></section>}
    <ol className="audit-timeline" aria-label="Steps">
      {run.timeline.map((step) => <AuditStep key={step.seq} step={step} full={run.full} />)}
    </ol>
    {run.full && <section className="audit-block"><h3>Output</h3>{run.output ? <Markdown text={run.output} context={context} /> : <p className="chat-muted">No output.</p>}</section>}
  </article>;
}

function AuditStep({ step, full }: { step: AuditStepView; full: boolean }) {
  if (step.kind === "model") {
    const tokens = (step.promptTokens ?? 0) + (step.completionTokens ?? 0);
    return <li className="audit-step audit-step-model">
      <span className="audit-step-icon"><Cpu aria-hidden="true" /></span>
      <div className="audit-step-body">
        <p className="audit-step-title">Model call <span className="chat-muted">· {tokens.toLocaleString()} tokens · {formatDuration(step.durationMs)}</span></p>
        {full && step.text ? <pre className="audit-pre audit-pre-text">{step.text}</pre> : null}
        {full && step.args ? <details className="audit-details"><summary>Tool calls it asked for</summary><pre className="audit-pre">{step.args}</pre></details> : null}
        {step.truncated && <p className="chat-muted">Cut to 16 KiB in the log.</p>}
      </div>
    </li>;
  }
  return <li className="audit-step audit-step-tool">
    <span className="audit-step-icon"><Wrench aria-hidden="true" /></span>
    <div className="audit-step-body">
      <p className="audit-step-title"><code>{step.server ? `${step.server}/` : ""}{step.tool}</code> <span className={`audit-chip audit-chip-${step.ok ? "ok" : "danger"}`}>{step.ok ? "OK" : "Failed"}</span> <span className="chat-muted">{formatDuration(step.durationMs)}</span></p>
      {full && <details className="audit-details"><summary>Arguments and result</summary>
        <h4>Arguments</h4><pre className="audit-pre">{step.args ?? ""}</pre>
        <h4>Result</h4><pre className="audit-pre">{step.result ?? ""}</pre>
        {step.truncated && <p className="chat-muted">Cut to 16 KiB in the log.</p>}
      </details>}
    </div>
  </li>;
}

function AuditFilterSheet({ filter, choices, onClose, onApply }: { filter: AuditFilter; choices: ReturnType<typeof filterChoices>; onClose: () => void; onApply: (filter: AuditFilter) => void }) {
  useHistoryDialogGuard(true, onClose);
  const [draft, setDraft] = useState<AuditFilter>(filter);
  const set = (patch: Partial<AuditFilter>) => setDraft((current) => ({ ...current, ...patch }));
  return <ModalDialog title="Filter runs" onClose={onClose} className="chat-dialog audit-filter-sheet">
    <div className="audit-filter-fields">
      <div className="audit-field"><span>Key</span><Select<string> label="Key" value={draft.key ?? ""} options={choices.keys} onChange={(value) => set({ key: value || null })} /></div>
      <div className="audit-field"><span>Agent</span><Select<string> label="Agent" value={draft.agent ?? ""} options={choices.agents} onChange={(value) => set({ agent: value || null })} /></div>
      <div className="audit-field"><span>Status</span><Select<string> label="Status" value={draft.status ?? ""} options={STATUS_FILTERS} onChange={(value) => set({ status: value || null })} /></div>
      <label className="audit-field"><span>From</span><input type="date" value={draft.from ?? ""} onChange={(event) => set({ from: event.target.value || null })} /></label>
      <label className="audit-field"><span>To</span><input type="date" value={draft.to ?? ""} onChange={(event) => set({ to: event.target.value || null })} /></label>
    </div>
    <footer className="file-dialog-actions">
      <button type="button" className="secondary-button" onClick={() => onApply({})}>Clear</button>
      <button type="button" className="primary-button" onClick={() => onApply(draft)}>Apply</button>
    </footer>
  </ModalDialog>;
}
