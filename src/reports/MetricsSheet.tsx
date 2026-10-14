import { useEffect, useId, useState, type FormEvent } from "react";
import { CircleAlert, CircleCheck, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../api";
import { ModalDialog } from "../files/Dialog";
import { notify } from "../ui/notify";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { METRIC_ID, METRIC_LIMITS, type CatalogMetric, type CatalogMetricInput, type MetricCatalogView } from "../../shared/reportsMetrics";
import { timeAgo } from "./reportViewApi";
import { messageOf } from "./reportsApi";
import "./reportEdit.css";
import "./metrics.css";

export const getMetricCatalog = (id: string, version?: number | null) => api<{ catalog: MetricCatalogView | null }>(`/reports/${id}/metrics${version ? `?version=${version}` : ""}`);
export const saveMetricCatalog = (id: string, expectedVersion: number | null, metrics: CatalogMetricInput[]) =>
  api<{ catalog: MetricCatalogView }>(`/reports/${id}/metrics`, { method: "PUT", body: JSON.stringify({ expectedVersion, metrics }) });

type Draft = { id: string; name: string; definition: string; expression: string; table: string; filters: string; final: boolean; grain: string; unit: string; timeColumn: string };
const draftOf = (metric: CatalogMetric | null): Draft => ({
  id: metric?.id ?? "", name: metric?.name ?? "", definition: metric?.definition ?? "", expression: metric?.expression ?? "", table: metric?.table ?? "",
  filters: (metric?.filters ?? []).join("\n"), final: metric?.final ?? false, grain: metric?.grain ?? "", unit: metric?.unit ?? "", timeColumn: metric?.timeColumn ?? ""
});
const inputOf = (metric: CatalogMetric): CatalogMetricInput => ({ id: metric.id, name: metric.name, definition: metric.definition, expression: metric.expression, table: metric.table, filters: metric.filters, final: metric.final, grain: metric.grain, unit: metric.unit, timeColumn: metric.timeColumn, excerpt: metric.excerpt });
const fromDraft = (draft: Draft): CatalogMetricInput => ({
  id: draft.id.trim(), name: draft.name.trim(), definition: draft.definition.trim(), expression: draft.expression.trim(), table: draft.table.trim(),
  filters: draft.filters.split("\n").map((line) => line.trim()).filter(Boolean), final: draft.final, grain: draft.grain.trim() || null, unit: draft.unit.trim() || null, timeColumn: draft.timeColumn.trim() || null
});

/** What is wrong with a draft before it is sent (the server checks again, and runs the expression). */
export function draftProblems(draft: Draft, others: readonly string[]): string[] {
  const problems: string[] = [];
  if (!METRIC_ID.test(draft.id.trim())) problems.push("The id is lower case letters, digits, and _ (starting with a letter)");
  else if (others.includes(draft.id.trim())) problems.push(`The id ${draft.id.trim()} is used by another metric`);
  if (!draft.name.trim()) problems.push("Give the metric a name");
  if (!draft.expression.trim()) problems.push("Give the SQL expression, for example sum(amount)");
  if (!draft.table.trim()) problems.push("Give the table as db.table");
  if (draft.filters.split("\n").filter((line) => line.trim()).length > METRIC_LIMITS.filters) problems.push(`At most ${METRIC_LIMITS.filters} filters`);
  return problems;
}

function MetricForm({ initial, others, busy, onSave, onCancel, onRemove }: { initial: CatalogMetric | null; others: string[]; busy: boolean; onSave: (metric: CatalogMetricInput) => void; onCancel: () => void; onRemove?: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [shown, setShown] = useState<string[]>([]);
  const base = useId();
  const set = (key: keyof Draft) => (event: { target: { value: string } }) => {
    const value = event.target.value;
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problems = draftProblems(draft, others);
    setShown(problems);
    if (!problems.length) onSave(fromDraft(draft));
  };
  return <form className="report-metric-form" onSubmit={submit} noValidate aria-label={initial ? `Edit ${initial.name}` : "New metric"}>
    <div className="report-metric-form-grid">
      <label className="report-field" htmlFor={`${base}-name`}>Name<input id={`${base}-name`} value={draft.name} maxLength={METRIC_LIMITS.name} onChange={set("name")} /></label>
      <label className="report-field" htmlFor={`${base}-id`}>Id<input id={`${base}-id`} value={draft.id} maxLength={METRIC_LIMITS.id} autoComplete="off" spellCheck={false} onChange={set("id")} /></label>
      <label className="report-field report-metric-wide" htmlFor={`${base}-expr`}>SQL expression<textarea id={`${base}-expr`} value={draft.expression} maxLength={METRIC_LIMITS.expression} rows={2} spellCheck={false} onChange={set("expression")} /></label>
      <label className="report-field" htmlFor={`${base}-table`}>Table (db.table)<input id={`${base}-table`} value={draft.table} maxLength={METRIC_LIMITS.table} spellCheck={false} onChange={set("table")} /></label>
      <label className="report-field" htmlFor={`${base}-time`}>Time column<input id={`${base}-time`} value={draft.timeColumn} maxLength={METRIC_LIMITS.column} spellCheck={false} onChange={set("timeColumn")} /></label>
      <label className="report-field report-metric-wide" htmlFor={`${base}-filters`}>Required filters (one per line)<textarea id={`${base}-filters`} value={draft.filters} rows={2} spellCheck={false} onChange={set("filters")} /></label>
      <label className="report-field" htmlFor={`${base}-unit`}>Unit or format<input id={`${base}-unit`} value={draft.unit} maxLength={METRIC_LIMITS.unit} placeholder="currency:USD, percent, users" onChange={set("unit")} /></label>
      <label className="report-field" htmlFor={`${base}-grain`}>Grain<input id={`${base}-grain`} value={draft.grain} maxLength={METRIC_LIMITS.grain} placeholder="day, month, total" onChange={set("grain")} /></label>
      <label className="report-metric-check"><input type="checkbox" checked={draft.final} onChange={(event) => { const checked = event.target.checked; setDraft((current) => ({ ...current, final: checked })); }} />Read the table with FINAL</label>
      <label className="report-field report-metric-wide" htmlFor={`${base}-def`}>Definition<textarea id={`${base}-def`} value={draft.definition} maxLength={METRIC_LIMITS.definition} rows={3} onChange={set("definition")} /></label>
    </div>
    {shown.length > 0 && <ul className="form-error report-metric-problems" role="alert">{shown.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
    <div className="report-metric-form-actions">
      {onRemove && <button type="button" className="secondary-button report-metric-remove" disabled={busy} onClick={onRemove}><Trash2 aria-hidden="true" />Remove</button>}
      <span className="report-metric-spacer" />
      <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
    </div>
  </form>;
}

function MetricRow({ metric, canEdit, onEdit }: { metric: CatalogMetric; canEdit: boolean; onEdit: () => void }) {
  const ok = metric.problems.length === 0;
  return <li className="report-metric">
    <div className="report-metric-head">
      <span className={`report-metric-state ${ok ? "is-ok" : "is-warn"}`} title={ok ? "Checked: the table exists and the expression runs" : metric.problems.join("; ")}>{ok ? <CircleCheck aria-label="Checked" /> : <CircleAlert aria-label="Not checked" />}</span>
      <span className="report-metric-name"><strong>{metric.name}</strong><code>{metric.id}</code></span>
      {canEdit && <button type="button" className="secondary-button report-metric-edit" onClick={onEdit} aria-label={`Edit ${metric.name}`}><Pencil aria-hidden="true" />Edit</button>}
    </div>
    <dl className="report-metric-facts">
      <div><dt>Expression</dt><dd><code>{metric.expression}</code></dd></div>
      <div><dt>Table</dt><dd><code>{metric.table}{metric.final ? " FINAL" : ""}</code></dd></div>
      {metric.filters.length > 0 && <div><dt>Filters</dt><dd>{metric.filters.map((filter) => <code key={filter}>{filter}</code>)}</dd></div>}
      {(metric.unit || metric.grain || metric.timeColumn) && <div><dt>Shape</dt><dd>{[metric.unit, metric.grain, metric.timeColumn && `time ${metric.timeColumn}`].filter(Boolean).join(" · ")}</dd></div>}
    </dl>
    {metric.definition && <p className="report-metric-definition">{metric.definition}</p>}
    {!ok && <p className="report-metric-problem" role="note">{metric.problems.join(" ")}</p>}
  </li>;
}

/**
 * The Metrics view (lane E, E4; the owner's): the metric catalog Nook extracted from the doc and
 * checked, as a list of metrics the owner can edit. Every save is a new version; generation and edits
 * use the newest. A wide panel at the right on a desktop, full screen on a phone; Back or Escape
 * closes it and Forward reopens it (D18).
 */
export function MetricsSheet({ reportId, title, canEdit, onClose, reopen }: { reportId: string; title: string; canEdit: boolean; onClose: () => void; reopen: () => void }) {
  useHistoryDialogGuard(true, onClose, { reopen, layerKey: "reports.metrics" });
  const [catalog, setCatalog] = useState<MetricCatalogView | null | undefined>(undefined);
  const [latest, setLatest] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const versionId = useId();
  const load = (version?: number | null) => {
    getMetricCatalog(reportId, version).then(({ catalog: next }) => {
      setCatalog(next);
      if (!version) setLatest(next?.version ?? null);
      setError(null);
    }).catch((reason) => setError(messageOf(reason, "Could not load the metrics")));
  };
  useEffect(() => { load(); }, [reportId]); // eslint-disable-line react-hooks/exhaustive-deps

  const viewingOld = Boolean(catalog && latest !== null && catalog.version !== latest);
  const editable = canEdit && !viewingOld;
  const save = async (metrics: CatalogMetricInput[], message: string) => {
    setBusy(true);
    try {
      const { catalog: next } = await saveMetricCatalog(reportId, latest ?? 0, metrics);
      setCatalog(next);
      setLatest(next.version);
      setEditing(null);
      const unchecked = next.metrics.filter((metric) => metric.problems.length).length;
      if (unchecked) notify.warning(`${message}; ${unchecked} ${unchecked === 1 ? "metric does" : "metrics do"} not pass Nook's checks`);
      else notify.success(message);
    } catch (reason) {
      setError(messageOf(reason, "Could not save the metrics"));
    } finally {
      setBusy(false);
    }
  };
  const list = catalog?.metrics ?? [];
  const saveOne = (original: string | null, metric: CatalogMetricInput) => {
    const next = original ? list.map((item) => item.id === original ? metric : inputOf(item)) : [...list.map(inputOf), metric];
    void save(next, `Saved ${metric.name} (version ${(latest ?? 0) + 1})`);
  };
  const remove = (id: string) => void save(list.filter((item) => item.id !== id).map(inputOf), `Removed the metric (version ${(latest ?? 0) + 1})`);

  return <ModalDialog title="Metrics" eyebrow={title} onClose={onClose} busy={busy} variant="sheet" className="reports-dialog report-changes report-metrics-panel">
    <div className="report-changes-body report-metrics-body">
      {error && <p className="form-error" role="alert">{error}</p>}
      {catalog === undefined && !error && <p className="reports-loading" role="status">Loading metrics…</p>}
      {catalog === null && <p className="report-changes-empty">No metric catalog yet. Nook extracts one from the doc the next time this report is generated, and checks each metric against the data source.</p>}
      {catalog && <>
        <div className="report-metrics-meta">
          <p className="file-dialog-hint">
            {catalog.source === "extract" ? "Extracted from the doc" : `Edited${catalog.createdBy ? ` by ${catalog.createdBy.name}` : ""}`} {timeAgo(catalog.createdAt)} · {list.length} {list.length === 1 ? "metric" : "metrics"}. Generation and edits use the newest version: todos name these metrics, and their SQL must use the expression and filters.
          </p>
          {catalog.versions.length > 1 && <div className="report-metrics-version"><span id={versionId}>Version</span>
            <Select<string> labelledBy={versionId} label="Catalog version" value={String(catalog.version)} onChange={(value) => { setEditing(null); load(Number(value) === latest ? null : Number(value)); }}
              options={catalog.versions.map((item) => ({ value: String(item.version), label: `${item.version}${item.version === latest ? " (current)" : ""} · ${item.source === "extract" ? "from the doc" : "edited"}` }))} />
          </div>}
        </div>
        {viewingOld && <p className="report-changes-readonly" role="note">An older version, read-only. {canEdit && <button type="button" className="secondary-button report-metrics-restore" disabled={busy} onClick={() => void save(list.map(inputOf), `Restored version ${catalog.version} as version ${(latest ?? 0) + 1}`)}>Restore it</button>}</p>}
        <ol className="report-metrics-list">
          {list.map((metric) => editing === metric.id
            ? <li key={metric.id} className="report-metric is-editing"><MetricForm initial={metric} others={list.filter((item) => item.id !== metric.id).map((item) => item.id)} busy={busy} onSave={(next) => saveOne(metric.id, next)} onCancel={() => setEditing(null)} onRemove={() => remove(metric.id)} /></li>
            : <MetricRow key={metric.id} metric={metric} canEdit={editable && editing === null} onEdit={() => setEditing(metric.id)} />)}
        </ol>
      </>}
      {editing === "new" && <div className="report-metric is-editing"><MetricForm initial={null} others={list.map((item) => item.id)} busy={busy} onSave={(next) => saveOne(null, next)} onCancel={() => setEditing(null)} /></div>}
      {editable && catalog !== undefined && editing === null && list.length < METRIC_LIMITS.metrics && (catalog !== null) && <div className="report-changes-tools">
        <button type="button" className="secondary-button" onClick={() => setEditing("new")}><Plus aria-hidden="true" />Add metric</button>
      </div>}
    </div>
  </ModalDialog>;
}
