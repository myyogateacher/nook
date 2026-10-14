import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { FileText, Table2 } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import { useConfirm } from "../ui/useConfirm";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { setServerPolicies } from "../chat/chatApi";
import { REPORT_LIMITS, type DatasourceChoice } from "../../shared/reports";
import { defaultBrowseTools, type DocServerChoice } from "../../shared/reportsGenerate";
import { BrowseToolsPicker } from "./BrowseToolsPicker";
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

/** Where "From a doc" stands: the doc servers are loading, failed to load, there are none, or they are listed (with the chosen one's problem, if any). */
export type DocSourceState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "none" }
  | { kind: "ready"; issue: null | DocServerIssue };

/**
 * Why the chosen server cannot read a doc on its own: never synced; a doc tool (fetch, get_document,
 * read_document) exists but its policy is not Auto (`tool`); or no doc tool at all (`tools`: its tools).
 */
export type DocServerIssue =
  | { kind: "unsynced"; serverId: string; serverName: string }
  | { kind: "needs-auto"; serverId: string; serverName: string; tool: string; policy: string }
  | { kind: "no-tool"; serverId: string; serverName: string; tools: string[] };

export function docSourceState(servers: DocServerChoice[] | null, loadError: string | null, server: DocServerChoice | null): DocSourceState {
  if (loadError !== null) return { kind: "failed", message: loadError };
  if (servers === null) return { kind: "loading" };
  if (servers.length === 0) return { kind: "none" };
  if (server && !server.synced) return { kind: "ready", issue: { kind: "unsynced", serverId: server.id, serverName: server.name } };
  if (server && !server.pick) {
    const candidate = server.candidates?.[0];
    return { kind: "ready", issue: candidate
      ? { kind: "needs-auto", serverId: server.id, serverName: server.name, tool: candidate.name, policy: candidate.policy }
      : { kind: "no-tool", serverId: server.id, serverName: server.name, tools: server.toolNames ?? [] } };
  }
  return { kind: "ready", issue: null };
}

/** "From a doc" is off only when the servers could not be loaded or there are none. */
export const docModeDisabled = (state: DocSourceState) => state.kind === "failed" || state.kind === "none";

export const TOOL_SERVERS_PATH = "/settings/ai/tools";

/** Why "From a doc" is unavailable or may not work, with Retry or (for admins) the way to Settings → AI → Tool servers and "Allow … automatically". */
export function DocSourceNotice({ state, admin, onRetry, onOpenToolServers, onAllow, allowing = false }: { state: DocSourceState; admin: boolean; onRetry: () => void; onOpenToolServers?: () => void; onAllow?: (serverId: string, tool: string) => void; allowing?: boolean }) {
  const settings: ReactNode = admin
    ? <a href={TOOL_SERVERS_PATH} onClick={(event) => { if (!onOpenToolServers) return; event.preventDefault(); onOpenToolServers(); }}>Settings → AI → Tool servers</a>
    : "Settings → AI → Tool servers";
  if (state.kind === "failed") {
    return <div className="new-report-notice is-error" role="alert">
      <p>Could not load the doc servers: {state.message}</p>
      <button type="button" className="secondary-button" onClick={onRetry}>Retry</button>
    </div>;
  }
  if (state.kind === "none") {
    return <div className="new-report-notice"><p>No doc servers yet. To build a report from a doc, {admin ? <>add the doc system's MCP server in {settings}.</> : <>an admin adds the doc system's MCP server in {settings}.</>}</p></div>;
  }
  if (state.kind !== "ready" || !state.issue) return null;
  const issue = state.issue;
  if (issue.kind === "unsynced") {
    return <div className="new-report-notice" role="status"><p>{issue.serverName} hasn't been synced yet, so Nook doesn't know its tools. {admin ? <>Sync it in {settings}.</> : <>Ask an admin to sync it in {settings}.</>}</p></div>;
  }
  if (issue.kind === "needs-auto") {
    return <div className="new-report-notice" role="status">
      <p>{issue.serverName}'s <code>{issue.tool}</code> needs to be allowed to run automatically before Nook can read a doc with it (it is set to {issue.policy === "off" ? "Off" : "Ask first"}). {admin ? <>Change it in {settings}, or here.</> : <>Ask an admin to allow it in {settings}.</>}</p>
      {admin && onAllow && <button type="button" className="secondary-button" disabled={allowing} onClick={() => onAllow(issue.serverId, issue.tool)}>{allowing ? "Allowing…" : `Allow ${issue.tool} automatically`}</button>}
    </div>;
  }
  return <div className="new-report-notice" role="status"><p>{issue.serverName} has no tool that returns a document (<code>fetch</code>, <code>get_document</code> or <code>read_document</code> with an <code>id</code> or <code>url</code> input).{issue.tools.length ? <> Its tools: {issue.tools.slice(0, 30).map((name, index) => <span key={name}>{index ? ", " : ""}<code>{name}</code></span>)}{issue.tools.length > 30 ? ", …" : ""}.</> : null} Pick a read-only one under "How Nook reads the doc", or {admin ? <>allow one to run automatically in {settings}.</> : <>ask an admin to allow one in {settings}.</>}</p></div>;
}

/**
 * New report (Waves 45–46): from a doc (its link, the tool server to read it through, the tool and
 * argument when the auto-pick is wrong, the data source, and an optional title taken from the doc
 * otherwise), or blank (a title and a data source; the SQL console). Generate reads the doc right
 * away, so a bad link or a refused credential answers here; the report page then follows the run.
 * One sheet, one history layer: Back or Escape closes it (D18), never while a request is in flight.
 * "From a doc" says why it is unavailable (the servers failed to load: Retry; none yet) or why the
 * chosen server may not work (not synced, no read-only fetch tool), with admins' link to fix it.
 */
export function NewReportSheet({ sources, role = "member", onCancel, onCreated, onOpenToolServers, reportId = null, initialSource = null }: { sources: DatasourceChoice[]; role?: string; onCancel: () => void; onCreated: (id: string) => void; onOpenToolServers?: () => void; /** Generate into this (empty) report instead of a new one: doc mode only, no title. */ reportId?: string | null; initialSource?: string | null }) {
  const [servers, setServers] = useState<DocServerChoice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const forcedBlank = useRef(false);
  const [mode, setMode] = useState<Mode>("doc");
  const [docRef, setDocRef] = useState("");
  const [serverId, setServerId] = useState<string | null>(null);
  const [tool, setTool] = useState<string>(AUTO);
  const [arg, setArg] = useState("");
  // B3: the read-only tools the AI may use to read more docs (fetch, list, and search ones ticked by default).
  const [browse, setBrowse] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [source, setSource] = useState<string | null>(initialSource ?? sources[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const [allowing, setAllowing] = useState(false);
  const ids = { mode: useId(), doc: useId(), server: useId(), tool: useId(), toolHint: useId(), arg: useId(), argHint: useId(), title: useId(), source: useId() };
  useHistoryDialogGuard(true, onCancel, { blocked: busy });

  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const loadServers = useCallback(() => {
    setLoadError(null);
    setServers(null);
    docServers().then(({ servers: list }) => {
      if (!live.current) return;
      setServers(list);
      setServerId((current) => current ?? list.find((item) => item.pick)?.id ?? list[0]?.id ?? null);
      // No servers: Blank is the only way in. After a failed load, a Retry that finds some goes back to the doc.
      if (list.length === 0) { if (!reportId) { forcedBlank.current = true; setMode("blank"); } } else if (forcedBlank.current) { forcedBlank.current = false; setMode("doc"); }
    }).catch((reason) => {
      if (!live.current) return;
      setLoadError(messageOf(reason, "the server did not answer"));
      if (reportId) return;
      forcedBlank.current = true;
      setMode("blank");
    });
  }, [reportId]);
  useEffect(() => { loadServers(); }, [loadServers]);

  const server = useMemo(() => servers?.find((item) => item.id === serverId) ?? null, [servers, serverId]);
  useEffect(() => { setBrowse(server ? defaultBrowseTools(server.tools.map((item) => item.name)) : []); }, [server]);
  const chosenTool = tool === AUTO ? null : server?.tools.find((item) => item.name === tool) ?? null;
  const autoLabel = server?.pick ? `Auto: ${server.pick.tool} (${server.pick.arg})` : "Auto: none found";
  const argPlaceholder = chosenTool ? chosenTool.args.find((name) => name === "id" || name === "url") ?? chosenTool.args[0] ?? "id" : server?.pick?.arg ?? "id";

  // Admins: "Allow fetch automatically" sets that tool's policy to Auto (the tool-policy API, audited), after a confirm.
  async function allowAutomatically(id: string, toolName: string) {
    const name = servers?.find((item) => item.id === id)?.name ?? "the tool server";
    if (!await confirm.ask({ title: `Allow ${toolName} automatically?`, message: `Nook and every agent that uses ${name} may then call ${toolName} without asking. Only do this for a tool that only reads. You can change it back in Settings → AI → Tool servers.`, confirmLabel: "Allow automatically" })) return;
    setAllowing(true);
    setError(null);
    try {
      await setServerPolicies(id, { [toolName]: "auto" });
      loadServers();
    } catch (reason) {
      setError(messageOf(reason, `Could not allow ${toolName}`));
    } finally {
      if (live.current) setAllowing(false);
    }
  }

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
      const input = { docRef: docRef.trim(), serverId, datasourceId: source, tool: tool === AUTO ? null : tool, arg: arg.trim() || null, browseTools: browse };
      const started = reportId ? await regenerateReport(reportId, input) : await generateReport({ ...input, title: title.trim() || null });
      onCreated(started.report.id);
    } catch (reason) {
      setError(generateErrorText(reason, "Could not start generating the report"));
      setBusy(false);
    }
  }

  const docSource = docSourceState(servers, loadError, server);
  const docDisabled = docModeDisabled(docSource);
  return <ModalDialog title={reportId ? "Generate from a doc" : "New report"} eyebrow="Reports" onClose={onCancel} busy={busy} variant="sheet" className="reports-dialog new-report-sheet">
    <form className="file-dialog-form" onSubmit={submit} noValidate>
      {!reportId && <div className="new-report-modes" role="radiogroup" aria-labelledby={ids.mode}>
        <span id={ids.mode} className="sr-only">Start from</span>
        <button type="button" role="radio" aria-checked={mode === "doc"} className={mode === "doc" ? "is-active" : undefined} onClick={() => setMode("doc")} disabled={busy || docDisabled}><FileText aria-hidden="true" />From a doc</button>
        <button type="button" role="radio" aria-checked={mode === "blank"} className={mode === "blank" ? "is-active" : undefined} onClick={() => { forcedBlank.current = false; setMode("blank"); }} disabled={busy}><Table2 aria-hidden="true" />Blank</button>
      </div>}
      {(docDisabled || mode === "doc") && <DocSourceNotice state={docSource} admin={role === "admin"} onRetry={loadServers} onOpenToolServers={onOpenToolServers} onAllow={(id, name) => { void allowAutomatically(id, name); }} allowing={allowing} />}
      {mode === "doc" && <>
        <label htmlFor={ids.doc}>Doc link</label>
        <input id={ids.doc} value={docRef} maxLength={2048} autoFocus autoComplete="off" inputMode="url" placeholder="https://docs.example.com/doc/revenue-metrics-AbC123" onChange={(event) => setDocRef(event.target.value)} />
        <span className="reports-label" id={ids.server}>Read it through</span>
        {servers === null
          ? <p className="file-dialog-hint" role="status">Loading tool servers…</p>
          : <Select labelledBy={ids.server} label="Tool server" value={serverId} onChange={(value) => { setServerId(value); setTool(AUTO); setArg(""); }}
            options={servers.map((item) => ({ value: item.id, label: item.name, description: !item.synced ? "Not synced yet" : item.pick ? `Uses ${item.pick.tool}` : "No fetch tool found; choose one below" }))} />}
        {server && <details className="new-report-advanced" open={!server.pick && server.synced}>
          <summary>How Nook reads the doc</summary>
          <div className="new-report-advanced-body">
            <div className="new-report-field">
              <span className="reports-label" id={ids.tool}>Tool</span>
              <Select labelledBy={ids.tool} label="Tool" value={tool} onChange={(value) => { setTool(value); setArg(""); }}
                options={[{ value: AUTO, label: autoLabel }, ...server.tools.map((item) => ({ value: item.name, label: item.name, description: item.args.length ? `Takes ${item.args.join(", ")}` : undefined }))]} />
              <p className="file-dialog-hint" id={ids.toolHint}>The doc server's tool that returns a document, e.g. Outline's <code>fetch</code>.</p>
            </div>
            <div className="new-report-field">
              <label htmlFor={ids.arg}>Link goes into</label>
              <input id={ids.arg} value={arg} maxLength={64} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder={argPlaceholder} aria-describedby={ids.argHint} onChange={(event) => setArg(event.target.value)} />
              <p className="file-dialog-hint" id={ids.argHint}>That tool's input for the link, e.g. <code>id</code>. Outline's <code>fetch</code> also gets <code>resource: "document"</code>. The doc is read once, before the AI starts.</p>
            </div>
          </div>
        </details>}
        {server?.synced && <BrowseToolsPicker server={server} value={browse} onChange={setBrowse} disabled={busy} />}
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
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? (mode === "doc" ? "Reading the doc…" : "Creating…") : mode === "doc" ? "Generate report" : "Create report"}</button>
      </footer>
    </form>
    {confirm.confirmElement}
  </ModalDialog>;
}
