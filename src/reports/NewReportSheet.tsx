import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { FileText, Table2 } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { REPORT_LIMITS, type DatasourceChoice } from "../../shared/reports";
import type { DocServerChoice } from "../../shared/reportsGenerate";
import { codeOf, createReport, docServers, generateReport, messageOf, regenerateReport } from "./reportsApi";
import "./generate.css";

type Mode = "doc" | "blank";
const AUTO = "__auto__";

/** A failed generate request as one line, with the "reconnect" hint for MCP_AUTH (Wave 46). */
export function generateErrorText(reason: unknown, fallback: string) {
  const { code } = codeOf(reason);
  const message = messageOf(reason, fallback);
  // MCP_AUTH is shown as "reconnect": the server's message names the server and where an admin fixes it.
  return code === "MCP_AUTH" ? `Reconnect needed. ${message}` : message;
}

/**
 * New report (Waves 45–46): from a doc (its link, the tool server to read it through, the tool and
 * argument when the auto-pick is wrong, the data source, and an optional title taken from the doc
 * otherwise), or blank (a title and a data source; the SQL console). Generate reads the doc right
 * away, so a bad link or a refused credential answers here; the report page then follows the run.
 * One sheet, one history layer: Back or Escape closes it (D18), never while a request is in flight.
 */
export function NewReportSheet({ sources, onCancel, onCreated, reportId = null, initialSource = null }: { sources: DatasourceChoice[]; onCancel: () => void; onCreated: (id: string) => void; /** Generate into this (empty) report instead of a new one: doc mode only, no title. */ reportId?: string | null; initialSource?: string | null }) {
  const [servers, setServers] = useState<DocServerChoice[] | null>(null);
  const [mode, setMode] = useState<Mode>("doc");
  const [docRef, setDocRef] = useState("");
  const [serverId, setServerId] = useState<string | null>(null);
  const [tool, setTool] = useState<string>(AUTO);
  const [arg, setArg] = useState("");
  const [title, setTitle] = useState("");
  const [source, setSource] = useState<string | null>(initialSource ?? sources[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { mode: useId(), doc: useId(), server: useId(), tool: useId(), arg: useId(), title: useId(), source: useId() };
  useHistoryDialogGuard(true, onCancel, { blocked: busy });

  useEffect(() => {
    let live = true;
    docServers().then(({ servers: list }) => {
      if (!live) return;
      setServers(list);
      setServerId((current) => current ?? list.find((item) => item.pick)?.id ?? list[0]?.id ?? null);
      if (list.length === 0 && !reportId) setMode("blank");
    }).catch(() => { if (live) { setServers([]); if (!reportId) setMode("blank"); } });
    return () => { live = false; };
  }, []);

  const server = useMemo(() => servers?.find((item) => item.id === serverId) ?? null, [servers, serverId]);
  const chosenTool = tool === AUTO ? null : server?.tools.find((item) => item.name === tool) ?? null;
  const autoLabel = server?.pick ? `Auto: ${server.pick.tool} (${server.pick.arg})` : "Auto: none found";
  const argPlaceholder = chosenTool ? chosenTool.args.find((name) => name === "id" || name === "url") ?? chosenTool.args[0] ?? "id" : server?.pick?.arg ?? "id";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!source) return setError("Choose a data source.");
    if (mode === "blank") {
      if (!title.trim()) return setError("Enter a title.");
      setBusy(true);
      setError(null);
      try {
        onCreated((await createReport(title.trim(), source)).report.id);
      } catch (reason) {
        setError(messageOf(reason, "Could not create the report"));
        setBusy(false);
      }
      return;
    }
    if (!docRef.trim()) return setError("Paste the doc's link.");
    if (!serverId) return setError("Choose the tool server that reads the doc.");
    if (tool === AUTO && !server?.pick) return setError("Nook found no fetch tool on that server; choose the tool to use.");
    setBusy(true);
    setError(null);
    try {
      const input = { docRef: docRef.trim(), serverId, datasourceId: source, tool: tool === AUTO ? null : tool, arg: arg.trim() || null };
      const started = reportId ? await regenerateReport(reportId, input) : await generateReport({ ...input, title: title.trim() || null });
      onCreated(started.report.id);
    } catch (reason) {
      setError(generateErrorText(reason, "Could not start generating the report"));
      setBusy(false);
    }
  }

  const noServers = servers !== null && servers.length === 0;
  return <ModalDialog title={reportId ? "Generate from a doc" : "New report"} eyebrow="Reports" onClose={onCancel} busy={busy} variant="sheet" className="reports-dialog new-report-sheet">
    <form className="file-dialog-form" onSubmit={submit} noValidate>
      {!reportId && <div className="new-report-modes" role="radiogroup" aria-labelledby={ids.mode}>
        <span id={ids.mode} className="sr-only">Start from</span>
        <button type="button" role="radio" aria-checked={mode === "doc"} className={mode === "doc" ? "is-active" : undefined} onClick={() => setMode("doc")} disabled={busy || noServers}><FileText aria-hidden="true" />From a doc</button>
        <button type="button" role="radio" aria-checked={mode === "blank"} className={mode === "blank" ? "is-active" : undefined} onClick={() => setMode("blank")} disabled={busy}><Table2 aria-hidden="true" />Blank</button>
      </div>}
      {mode === "doc" && <>
        <label htmlFor={ids.doc}>Doc link</label>
        <input id={ids.doc} value={docRef} maxLength={2048} autoFocus autoComplete="off" inputMode="url" placeholder="https://docs.example.com/doc/revenue-metrics-AbC123" onChange={(event) => setDocRef(event.target.value)} />
        <span className="reports-label" id={ids.server}>Read it through</span>
        {servers === null
          ? <p className="file-dialog-hint" role="status">Loading tool servers…</p>
          : <Select labelledBy={ids.server} label="Tool server" value={serverId} onChange={(value) => { setServerId(value); setTool(AUTO); setArg(""); }}
            options={servers.map((item) => ({ value: item.id, label: item.name, description: item.pick ? `Uses ${item.pick.tool}` : "No fetch tool found; choose one below" }))} />}
        {server && <details className="new-report-advanced" open={!server.pick}>
          <summary>Tool and argument</summary>
          <span className="reports-label" id={ids.tool}>Tool</span>
          <Select labelledBy={ids.tool} label="Tool" value={tool} onChange={(value) => { setTool(value); setArg(""); }}
            options={[{ value: AUTO, label: autoLabel }, ...server.tools.map((item) => ({ value: item.name, label: item.name, description: item.args.length ? `Takes ${item.args.join(", ")}` : undefined }))]} />
          <label htmlFor={ids.arg}>Argument for the link</label>
          <input id={ids.arg} value={arg} maxLength={64} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder={argPlaceholder} onChange={(event) => setArg(event.target.value)} />
          <p className="file-dialog-hint">Nook calls the tool with the link in this argument (Outline's <code>fetch</code> also gets <code>resource: "document"</code>). The doc is read once, before the AI starts.</p>
        </details>}
      </>}
      <span className="reports-label" id={ids.source}>Data source</span>
      <Select labelledBy={ids.source} label="Data source" value={source} onChange={setSource} options={sources.map((item) => ({ value: item.id, label: item.name, description: `Default database ${item.database}` }))} />
      {!reportId && <>
        <label htmlFor={ids.title}>Title{mode === "doc" ? " (optional)" : ""}</label>
        <input id={ids.title} value={title} maxLength={REPORT_LIMITS.title} autoFocus={mode === "blank"} autoComplete="off" placeholder={mode === "doc" ? "From the doc" : "Weekly revenue"} onChange={(event) => setTitle(event.target.value)} />
      </>}
      <p className="file-dialog-hint">{mode === "doc"
        ? "The AI reads the doc, writes read-only SQL against the tables an admin allowed, checks it, and builds the report. It uses your AI budget."
        : "The report starts as a draft with a SQL console. Queries run on that data source, read-only, on the tables an admin allowed."}</p>
      {noServers && <p className="file-dialog-hint">To build a report from a doc, an admin adds the doc system's MCP server in Settings → AI → Tool servers.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? (mode === "doc" ? "Reading the doc…" : "Creating…") : mode === "doc" ? "Generate report" : "Create report"}</button>
      </footer>
    </form>
  </ModalDialog>;
}
