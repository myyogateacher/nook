import { useEffect, useState, type FormEvent } from "react";
import { ModalDialog } from "../files/Dialog";
import { notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { DocServerChoice, DocState } from "../../shared/reportsGenerate";
import { BrowseToolsPicker } from "./BrowseToolsPicker";
import { docServers, getDocState, messageOf, saveBrowseTools } from "./reportsApi";
import "./generate.css";

/**
 * ⋯ → Doc settings (B3): the report's doc (where it is read from) and the tools the AI may use to read
 * more docs on its next generation or edit. The owner's only; a sheet that Back closes.
 */
export function DocSettingsSheet({ reportId, onClose, onSaved, reopen }: { reportId: string; onClose: () => void; onSaved?: (doc: DocState) => void; reopen?: () => void }) {
  useHistoryDialogGuard(true, onClose, { reopen });
  const [state, setState] = useState<DocState | null>(null);
  const [server, setServer] = useState<DocServerChoice | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([getDocState(reportId), docServers()]).then(([{ doc }, { servers }]) => {
      if (!live) return;
      setState(doc);
      setTicked(doc.doc?.browseTools ?? []);
      setServer(servers.find((item) => item.id === doc.doc?.serverId) ?? null);
    }).catch((reason: unknown) => { if (live) setError(messageOf(reason, "Could not load the doc settings")); });
    return () => { live = false; };
  }, [reportId]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { doc } = await saveBrowseTools(reportId, ticked);
      notify.success(doc.doc?.browseTools.length ? "The AI may read linked docs with the tools you ticked" : "The AI reads only the doc");
      onSaved?.(doc);
      onClose();
    } catch (reason) {
      setError(messageOf(reason, "Could not save the doc settings"));
      setBusy(false);
    }
  }

  const doc = state?.doc ?? null;
  return <ModalDialog title="Doc settings" eyebrow="Report" onClose={onClose} busy={busy} variant="sheet" className="reports-dialog new-report-sheet report-doc-settings">
    <form className="file-dialog-form" onSubmit={(event) => { void save(event); }} noValidate>
      {!state && !error && <p className="file-dialog-hint" role="status">Loading…</p>}
      {doc && <dl className="report-doc-settings-facts">
        <div><dt>Doc</dt><dd>{doc.ref ? <code>{doc.ref}</code> : "—"}</dd></div>
        <div><dt>Read through</dt><dd>{doc.serverName ?? "A removed tool server"}{doc.tool ? <> with <code>{doc.tool}</code></> : null}</dd></div>
      </dl>}
      {state && !server && <p className="file-dialog-hint">The doc's tool server is not available to you any more, so its tools cannot be changed here.</p>}
      {server && <BrowseToolsPicker server={server} value={ticked} onChange={setTicked} disabled={busy} />}
      {state && <p className="file-dialog-hint">The next Regenerate and every edit use these. Check doc also reads the linked pages the last generation read.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || !server}>{busy ? "Saving…" : "Save"}</button>
      </footer>
    </form>
  </ModalDialog>;
}
