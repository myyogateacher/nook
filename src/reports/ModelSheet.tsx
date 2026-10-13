import { useEffect, useId, useState, type FormEvent } from "react";
import { api } from "../api";
import { ModalDialog } from "../files/Dialog";
import { notify } from "../ui/notify";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { ReportModelChoice, ReportModelView } from "../../shared/reportsModel";
import { messageOf } from "./reportsApi";

export const getReportModel = (id: string) => api<{ model: ReportModelView }>(`/reports/${id}/model`);
export const saveReportModel = (id: string, override: ReportModelChoice | null) => api<{ model: ReportModelView }>(`/reports/${id}/model`, { method: "PUT", body: JSON.stringify({ override }) });

const SOURCE_TEXT: Record<ReportModelView["effective"]["source"], string> = { report: "this report's choice", setting: "the admin's report model", default: "chat's default provider" };

/** "glm-5.3 on Z.ai (the admin's report model)". */
export function effectiveModelText(view: Pick<ReportModelView, "effective">): string {
  const { effective } = view;
  if (!effective.providerId) return "No model provider is set up yet";
  return `${effective.model ?? "the default model"} on ${effective.providerName ?? "a provider"} (${SOURCE_TEXT[effective.source]})`;
}

/**
 * The report's generation model (wave 48b, D435): the owner may pick another provider and model for
 * this one report; empty keeps the admin's "Report generation model" (or chat's default). A sheet:
 * Back closes it (useHistoryDialogGuard), 44 px controls.
 */
export function ModelSheet({ reportId, onClose }: { reportId: string; onClose: () => void }) {
  useHistoryDialogGuard(true, onClose);
  const [view, setView] = useState<ReportModelView | null>(null);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const modelId = useId();
  const providerLabel = useId();

  useEffect(() => {
    let live = true;
    getReportModel(reportId).then(({ model: next }) => {
      if (!live) return;
      setView(next);
      setProviderId(next.override?.providerId ?? "");
      setModel(next.override?.model ?? "");
    }).catch((reason: unknown) => { if (live) setError(messageOf(reason, "Could not load the model")); });
    return () => { live = false; };
  }, [reportId]);

  async function save(event: FormEvent, clear = false) {
    event.preventDefault();
    setBusy(true);
    try {
      const override = clear || (!providerId && !model.trim()) ? null : { providerId: providerId || null, model: model.trim() || null };
      const { model: next } = await saveReportModel(reportId, override);
      setView(next);
      notify.success(override ? "This report has its own model" : "This report uses the report model again");
      onClose();
    } catch (reason) {
      setError(messageOf(reason, "Could not save the model"));
    } finally {
      setBusy(false);
    }
  }

  const chosen = view?.providers.find((provider) => provider.id === providerId);
  return <ModalDialog title="Generation model" eyebrow="Report" onClose={onClose} busy={busy} variant="sheet" className="reports-dialog report-model-sheet">
    <form className="file-dialog-form" onSubmit={(event) => { void save(event); }} noValidate>
      {!view && !error && <p className="file-dialog-hint" role="status">Loading…</p>}
      {view && <>
        <p className="file-dialog-hint">Generating this report uses <strong>{effectiveModelText(view)}</strong>. Chat is not affected.</p>
        <div className="report-field"><span id={providerLabel}>Provider</span>
          <Select<string> labelledBy={providerLabel} label="Provider" value={providerId} disabled={!view.canEdit}
            onChange={(value) => setProviderId(value)}
            options={[{ value: "", label: "The report model (admin's choice)" }, ...view.providers.map((provider) => ({ value: provider.id, label: provider.name, description: provider.defaultModel }))]} />
        </div>
        <label className="report-field" htmlFor={modelId}>Model
          <input id={modelId} value={model} maxLength={200} autoComplete="off" disabled={!view.canEdit} list={`${modelId}-models`}
            placeholder={chosen ? chosen.defaultModel : "The provider's default model"} onChange={(event) => setModel(event.target.value)} />
          {chosen?.models && <datalist id={`${modelId}-models`}>{chosen.models.slice(0, 100).map((item) => <option key={item} value={item} />)}</datalist>}
        </label>
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
        {view?.canEdit && view.override && <button type="button" className="secondary-button" disabled={busy} onClick={(event) => { void save(event, true); }}>Use the report model</button>}
        {view?.canEdit && <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save"}</button>}
      </footer>
    </form>
  </ModalDialog>;
}
