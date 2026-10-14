import { useState } from "react";
import { ArrowDown, ArrowUp, Code2, LoaderCircle, Trash2 } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { notify } from "../ui/notify";
import { useConfirm } from "../ui/useConfirm";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { REPORT_LIMITS, type ReportDetail } from "../../shared/reports";
import type { PatchOp } from "../../shared/reportsEdit";
import { editSpec } from "./reportEditApi";
import { codeOf, messageOf } from "./reportsApi";

const label = (block: ReportDetail["spec"]["blocks"][number]) => block.title ?? (block.type === "kpi" ? block.label ?? block.column : block.type === "markdown" ? "Text" : block.queryKey);

/**
 * Editing by hand (plan wave 48, the owner): move blocks up and down, remove one (its query goes with
 * it when nothing else uses it), and edit a query's SQL, which Nook checks again (the guard, a run of
 * every query, the blocks' columns) before saving. Every change is a new version.
 */
export function ArrangeSheet({ report, onClose, reopen, onChanged }: { report: ReportDetail; onClose: () => void; reopen: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [sql, setSql] = useState("");
  const [sqlError, setSqlError] = useState<string[] | null>(null);
  const confirm = useConfirm();
  useHistoryDialogGuard(true, onClose, { blocked: busy, reopen, layerKey: "reports.changes-arrange" });
  const blocks = report.spec.blocks;

  async function save(ops: PatchOp[], done: string) {
    setBusy(true);
    try {
      const saved = await editSpec(report.id, ops, report.revision);
      notify.success(`${done} (version ${saved.version})`);
      onChanged();
      return true;
    } catch (reason) {
      const { code } = codeOf(reason);
      const details = reason && typeof reason === "object" && "payload" in reason ? (reason as { payload?: { details?: string[] } }).payload?.details : undefined;
      if (editing && details?.length) setSqlError(details);
      else notify.error(code === "REVISION_CONFLICT" ? "The report changed; try again." : code === "RUN_IN_PROGRESS" ? "The report is running; try when it finishes." : messageOf(reason, "Could not save the change"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, title: string) {
    if (!await confirm.ask({ title: `Remove ${title}?`, message: "It becomes a new version; restore the one before from Versions to bring it back.", confirmLabel: "Remove", danger: true })) return;
    await save([{ op: "remove_block", id }], "Removed");
  }

  return <ModalDialog title="Arrange" eyebrow={report.title} onClose={onClose} busy={busy} variant="sheet" className="reports-dialog report-edit-sheet">
    <div className="report-edit-sheet-body">
      <h3 className="report-arrange-heading">Blocks</h3>
      <ol className="report-arrange">
        {blocks.map((block, index) => <li key={block.id}>
          <span className="report-arrange-label"><strong>{label(block)}</strong><small>{block.type === "chart" ? `${block.kind.replace("_", " ")} chart` : block.type}</small></span>
          <span className="report-arrange-buttons">
            <button type="button" className="icon-button" aria-label={`Move ${label(block)} up`} disabled={busy || index === 0}
              onClick={() => { void save([{ op: "move_block", id: block.id, after: index > 1 ? blocks[index - 2]!.id : null }], "Moved"); }}><ArrowUp /></button>
            <button type="button" className="icon-button" aria-label={`Move ${label(block)} down`} disabled={busy || index === blocks.length - 1}
              onClick={() => { void save([{ op: "move_block", id: block.id, after: blocks[index + 1]!.id }], "Moved"); }}><ArrowDown /></button>
            <button type="button" className="icon-button" aria-label={`Remove ${label(block)}`} disabled={busy || blocks.length === 1} onClick={() => { void remove(block.id, label(block)); }}><Trash2 /></button>
          </span>
        </li>)}
      </ol>
      <h3 className="report-arrange-heading">Queries</h3>
      <ul className="report-arrange report-arrange-queries">
        {report.spec.queries.map((query) => <li key={query.key}>
          <span className="report-arrange-label"><strong><code>{query.key}</code></strong><small>{query.purpose || (query.createdBy === "user" ? "Edited by hand" : "Written by the AI")}</small></span>
          {editing !== query.key && <button type="button" className="secondary-button" disabled={busy} onClick={() => { setEditing(query.key); setSql(query.sql); setSqlError(null); }}><Code2 aria-hidden="true" />Edit SQL</button>}
          {editing === query.key && <form className="report-arrange-sql" noValidate onSubmit={(event) => {
            event.preventDefault();
            void save([{ op: "update_query", key: query.key, sql }], `Saved ${query.key}`).then((ok) => { if (ok) setEditing(null); });
          }}>
            <label htmlFor={`sql-${query.key}`} className="sr-only">SQL of {query.key}</label>
            <textarea id={`sql-${query.key}`} className="report-sql" value={sql} rows={8} maxLength={REPORT_LIMITS.sqlChars} spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => setSql(event.target.value)} />
            {sqlError && <ul className="form-error" role="alert">{sqlError.map((line) => <li key={line}>{line}</li>)}</ul>}
            <div className="file-dialog-actions">
              <button type="button" className="secondary-button" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
              <button type="submit" className="primary-button" disabled={busy || !sql.trim() || sql === query.sql}>{busy ? <LoaderCircle className="spin" /> : null}{busy ? "Checking…" : "Check and save"}</button>
            </div>
          </form>}
        </li>)}
      </ul>
    </div>
    {confirm.confirmElement}
  </ModalDialog>;
}
