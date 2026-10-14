import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { notify } from "../ui/notify";
import { useConfirm } from "../ui/useConfirm";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { ReportDetail } from "../../shared/reports";
import { VERSION_SOURCE_TEXT, type ReportVersion } from "../../shared/reportsEdit";
import { listVersions, restoreVersion } from "./reportEditApi";
import { timeAgo } from "./reportViewApi";
import { codeOf, messageOf } from "./reportsApi";

/**
 * A report's versions (plan wave 48), newest first: where each came from (generated, an agent edit,
 * restored, edited by hand), who and when, and its size. The owner restores any older one, which makes
 * a new version (nothing is rewritten), and its queries refresh if their results are of other SQL.
 */
export function VersionsSheet({ report, canRestore, onClose, reopen, onRestored }: { report: ReportDetail; canRestore: boolean; onClose: () => void; reopen: () => void; onRestored: () => void }) {
  const [versions, setVersions] = useState<ReportVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const confirm = useConfirm();
  useHistoryDialogGuard(true, onClose, { blocked: busy !== null, reopen });
  useEffect(() => {
    let alive = true;
    listVersions(report.id).then(({ versions: next }) => { if (alive) setVersions(next); }).catch((reason) => { if (alive) setError(messageOf(reason, "Could not load the versions")); });
    return () => { alive = false; };
  }, [report.id, report.revision]);

  async function restore(version: ReportVersion) {
    if (!await confirm.ask({ title: `Restore version ${version.version}?`, message: "Its blocks and queries become a new version of the report; the current one stays in the list.", confirmLabel: "Restore" })) return;
    setBusy(version.version);
    try {
      const restored = await restoreVersion(report.id, version.version);
      notify.success(`Restored as version ${restored.version}${restored.refreshRunId ? "; refreshing its queries" : ""}`);
      onRestored();
    } catch (reason) {
      notify.error(codeOf(reason).code === "RUN_IN_PROGRESS" ? "The report is running; restore when it finishes." : messageOf(reason, "Could not restore"));
      setBusy(null);
    }
  }

  return <ModalDialog title="Versions" eyebrow={report.title} onClose={onClose} busy={busy !== null} variant="sheet" className="reports-dialog report-edit-sheet">
    <div className="report-edit-sheet-body">
      {error && <p className="form-error" role="alert">{error}</p>}
      {!versions && !error && <p className="reports-loading" role="status">Loading versions…</p>}
      {versions && !versions.length && <p className="report-changes-empty">No versions yet: the report has no blocks.</p>}
      <ol className="report-versions">
        {versions?.map((version) => <li key={version.version} className="report-version">
          <div>
            <strong>Version {version.version}</strong>
            {version.current && <span className="reports-status reports-status-ready">Current</span>}
            <p>{VERSION_SOURCE_TEXT[version.source]}{version.restoredFrom ? ` (from version ${version.restoredFrom})` : ""} · {version.createdByName ?? "Someone"} · {timeAgo(version.createdAt)}</p>
            {version.note && <p className="report-version-note">{version.note}</p>}
            <p className="report-version-size">{version.blocks} {version.blocks === 1 ? "block" : "blocks"}, {version.queries} {version.queries === 1 ? "query" : "queries"}</p>
          </div>
          {canRestore && !version.current && <button type="button" className="secondary-button" onClick={() => { void restore(version); }} disabled={busy !== null}><RotateCcw aria-hidden="true" />{busy === version.version ? "Restoring…" : "Restore"}</button>}
        </li>)}
      </ol>
    </div>
    {confirm.confirmElement}
  </ModalDialog>;
}
