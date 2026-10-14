import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { FileText, Search, Table2 } from "lucide-react";
import { appName } from "../appName";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import { useConfirm } from "../ui/useConfirm";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { setServerPolicies } from "../chat/chatApi";
import { REPORT_LIMITS, type DatasourceChoice } from "../../shared/reports";
import { defaultBrowseTools, isReadLikeTool, isWriteLikeName, type DocServerChoice } from "../../shared/reportsGenerate";
import { linkHost, parseNookRef } from "../../shared/nookDocRef";
import { BrowseToolsPicker } from "./BrowseToolsPicker";
import { NookDocPicker, nookLinkOf } from "./NookDocPicker";
import { codeOf, createReport, docServers, fileReport, generateReport, messageOf, regenerateReport } from "./reportsApi";
import { notify } from "../ui/notify";
import "./generate.css";

type Mode = "doc" | "blank";
const AUTO = "__auto__";
const UNFILED = "__unfiled__";

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
  // B4: only Nook itself (or nothing) is listed: say how other doc systems get in, while Nook's docs work.
  if (servers.every((item) => item.builtin)) return server && !server.builtin ? { kind: "ready", issue: null } : { kind: "none" };
  if (server && !server.synced) return { kind: "ready", issue: { kind: "unsynced", serverId: server.id, serverName: server.name } };
  if (server && !server.pick) {
    // "Allow … automatically" is only ever offered for a read-like tool.
    const candidate = server.candidates?.find((item) => isReadLikeTool(item));
    return { kind: "ready", issue: candidate
      ? { kind: "needs-auto", serverId: server.id, serverName: server.name, tool: candidate.name, policy: candidate.policy }
      : { kind: "no-tool", serverId: server.id, serverName: server.name, tools: (server.toolNames ?? []).filter((name) => !isWriteLikeName(name)) } };
  }
  return { kind: "ready", issue: null };
}

/** B4: "From a doc" is always on (Nook itself is a doc source); this stays for the callers that ask. */
export const docModeDisabled = (_state: DocSourceState) => false;

/** The built-in source when the list could not be loaded (B4): Nook is always there. */
export const NOOK_FALLBACK = (): DocServerChoice => ({
  id: "nook", name: `${appName()} (this workspace)`, status: "ok", synced: true, builtin: true, origins: typeof window === "undefined" ? [] : [window.location.origin], host: null,
  tools: [{ name: "read_note", title: null, args: ["noteId"] }, { name: "read_document_text", title: null, args: ["documentId"] }, { name: "search_notes", title: null, args: ["query"] }],
  pick: { tool: "read", arg: "id", outline: false }, candidates: [], toolNames: ["read_note", "read_document_text", "search_notes"]
});

/**
 * B4: the source a pasted link selects: Nook for a link on one of this instance's origins (or a bare
 * id), else the tool server whose host the link is on (or a subdomain of it, either way); null keeps
 * the current choice.
 */
export function sourceForLink(ref: string, servers: readonly DocServerChoice[]): string | null {
  const nook = servers.find((item) => item.builtin);
  if (nook && parseNookRef(ref, nook.origins?.length ? nook.origins : typeof window === "undefined" ? [] : [window.location.origin])) return nook.id;
  const host = linkHost(ref);
  if (!host) return null;
  const match = servers.find((item) => item.host && (host === item.host || host.endsWith(`.${item.host}`) || item.host.endsWith(`.${host}`)));
  return match?.id ?? null;
}

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
    return <div className="new-report-notice"><p>Docs in {appName()} work now. For docs in another system (Outline, Notion, …), {admin ? <>add its MCP server in {settings}.</> : <>an admin adds its MCP server in {settings}.</>}</p></div>;
  }
  if (state.kind !== "ready" || !state.issue) return null;
  const issue = state.issue;
  if (issue.kind === "unsynced") {
    return <div className="new-report-notice" role="status"><p>{issue.serverName} hasn't been synced yet, so Nook doesn't know its tools. {admin ? <>Sync it in {settings}.</> : <>Ask an admin to sync it in {settings}.</>}</p></div>;
  }
  if (issue.kind === "needs-auto") {
    return <div className="new-report-notice" role="status">
      <p>{issue.serverName}'s <code>{issue.tool}</code> needs to be allowed to run automatically before Nook can read a doc with it (it is set to {issue.policy === "off" ? "Off" : "Ask first"}). {admin ? <>Change it in {settings}, or here.</> : <>Ask an admin to allow it in {settings}.</>}</p>
      {admin && onAllow && !isWriteLikeName(issue.tool) && <button type="button" className="secondary-button" disabled={allowing} onClick={() => onAllow(issue.serverId, issue.tool)}>{allowing ? "Allowing…" : `Allow ${issue.tool} automatically`}</button>}
    </div>;
  }
  return <div className="new-report-notice" role="status"><p>{issue.serverName} has no tool that returns a document (<code>fetch</code>, <code>get_document</code> or <code>read_document</code> with an <code>id</code> or <code>url</code> input).{issue.tools.length ? <> Its tools: {issue.tools.slice(0, 30).map((name, index) => <span key={name}>{index ? ", " : ""}<code>{name}</code></span>)}{issue.tools.length > 30 ? ", …" : ""}.</> : null} Pick a read-only one under "How Nook reads the doc", or {admin ? <>allow one to run automatically in {settings}.</> : <>ask an admin to allow one in {settings}.</>}</p></div>;
}

/**
 * New report (Waves 45–46, B1–B4): from a doc (its link, the tool server to read it through, the tool and
 * argument when the auto-pick is wrong, the data source, and an optional title taken from the doc
 * otherwise), or blank (a title and a data source; the SQL console). Generate reads the doc right
 * away, so a bad link or a refused credential answers here; the report page then follows the run.
 * One sheet, one history layer: Back or Escape closes it (D18), never while a request is in flight.
 * "From a doc" is always on: Nook's own notes and text files are a doc source (B4), listed first, and a
 * pasted link picks its source. It says why the sources could not load (Retry) or why the chosen
 * server may not work (not synced, no read-only fetch tool), with admins' link to fix it.
 */
export function NewReportSheet({ sources, role = "member", onCancel, onCreated, onOpenToolServers, reportId = null, initialSource = null, folders, initialFolderId = null }: { sources: DatasourceChoice[]; role?: string; onCancel: () => void; onCreated: (id: string) => void; onOpenToolServers?: () => void; /** Generate into this (empty) report instead of a new one: doc mode only, no title. */ reportId?: string | null; initialSource?: string | null;
  /** Lane I: the owner's folders (a path label each); with them the sheet shows "In: <folder>" and a change control. */ folders?: ReadonlyArray<{ id: string; label: string }>; initialFolderId?: string | null }) {
  const [servers, setServers] = useState<DocServerChoice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
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
  const [picking, setPicking] = useState(false);
  // Lane I: the folder the new report goes in (null: Unfiled); "Change" shows the picker.
  const [folderId, setFolderId] = useState<string | null>(folders?.some((item) => item.id === initialFolderId) ? initialFolderId : null);
  const [changingFolder, setChangingFolder] = useState(false);
  const confirm = useConfirm();
  const [allowing, setAllowing] = useState(false);
  const ids = { mode: useId(), doc: useId(), server: useId(), tool: useId(), toolHint: useId(), arg: useId(), argHint: useId(), title: useId(), source: useId(), folder: useId() };
  useHistoryDialogGuard(true, onCancel, { blocked: busy });

  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const loadServers = useCallback(() => {
    setLoadError(null);
    setServers(null);
    docServers().then(({ servers: list }) => {
      if (!live.current) return;
      // B4: Nook itself is always listed first, even by an older server.
      const all = list.some((item) => item.builtin) ? list : [NOOK_FALLBACK(), ...list];
      setServers(all);
      // A tool server with a doc tool is the default; Nook otherwise (a pasted link picks for itself).
      setServerId((current) => current ?? all.find((item) => !item.builtin && item.pick)?.id ?? all[0]?.id ?? null);
    }).catch((reason) => {
      if (!live.current) return;
      setLoadError(messageOf(reason, "the server did not answer"));
      // From a doc still works with Nook's own docs.
      setServers([NOOK_FALLBACK()]);
      setServerId((current) => current ?? "nook");
    });
  }, []);
  useEffect(() => { loadServers(); }, [loadServers]);

  const server = useMemo(() => servers?.find((item) => item.id === serverId) ?? null, [servers, serverId]);
  useEffect(() => { setBrowse(server ? defaultBrowseTools(server.tools.map((item) => item.name)) : []); }, [server]);
  const nook = server?.builtin === true;
  // B4: a pasted link picks its source: Nook for this instance's links, a tool server for its host.
  const changeRef = (value: string) => {
    setDocRef(value);
    const picked = servers ? sourceForLink(value, servers) : null;
    if (picked && picked !== serverId) { setServerId(picked); setTool(AUTO); setArg(""); }
  };
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
        onCreated((await createReport(title.trim(), source, folderId)).report.id);
      } catch (reason) {
        setError(messageOf(reason, "Could not create the report"));
        setBusy(false);
      }
      return;
    }
    if (!docRef.trim()) return setError("Paste the doc's link.");
    if (!serverId) return setError("Choose where the doc is read from.");
    if (tool === AUTO && !server?.pick) return setError("Nook found no fetch tool on that server; choose the tool to use.");
    setBusy(true);
    setError(null);
    try {
      const input = { docRef: docRef.trim(), serverId, datasourceId: source, tool: tool === AUTO || nook ? null : tool, arg: nook ? null : arg.trim() || null, browseTools: browse };
      const started = reportId ? await regenerateReport(reportId, input) : await generateReport({ ...input, title: title.trim() || null });
      // Lane I: a generated report starts Unfiled; file it in the chosen folder (it stays Unfiled when that fails).
      if (!reportId && folderId) {
        await fileReport(started.report.id, folderId).catch((reason) => notify.warning(messageOf(reason, "The report was created, but could not be put in the folder")));
      }
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
        <button type="button" role="radio" aria-checked={mode === "blank"} className={mode === "blank" ? "is-active" : undefined} onClick={() => setMode("blank")} disabled={busy}><Table2 aria-hidden="true" />Blank</button>
      </div>}
      {mode === "doc" && <DocSourceNotice state={docSource} admin={role === "admin"} onRetry={loadServers} onOpenToolServers={onOpenToolServers} onAllow={(id, name) => { void allowAutomatically(id, name); }} allowing={allowing} />}
      {mode === "doc" && <>
        <div className="new-report-doc-label">
          <label htmlFor={ids.doc}>Doc link</label>
          <button type="button" className="secondary-button" onClick={() => setPicking((open) => !open)} aria-expanded={picking} disabled={busy}><Search aria-hidden="true" />Pick from {appName()}</button>
        </div>
        <input id={ids.doc} value={docRef} maxLength={2048} autoFocus autoComplete="off" inputMode="url" placeholder={`A link to a note or file in ${appName()}, or to a doc in your doc system`} onChange={(event) => changeRef(event.target.value)} />
        {picking && <NookDocPicker onClose={() => setPicking(false)} onPick={(pick) => { changeRef(nookLinkOf(pick)); setServerId("nook"); setPicking(false); }} />}
        <span className="reports-label" id={ids.server}>Read it through</span>
        {servers === null
          ? <p className="file-dialog-hint" role="status">Loading doc sources…</p>
          : <Select labelledBy={ids.server} label="Doc source" value={serverId} onChange={(value) => { setServerId(value); setTool(AUTO); setArg(""); }}
            options={servers.map((item) => ({ value: item.id, label: item.name, description: item.builtin ? "Notes and text files, read with your access" : !item.synced ? "Not synced yet" : item.pick ? `Uses ${item.pick.tool}` : "No fetch tool found; choose one below" }))} />}
        {server && !nook && <details className="new-report-advanced" open={!server.pick && server.synced}>
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
      {!reportId && folders && <div className="new-report-folder">
        <span id={ids.folder}>In: <strong>{folders.find((item) => item.id === folderId)?.label ?? "Unfiled"}</strong></span>
        {changingFolder
          ? <Select labelledBy={ids.folder} label="Folder" value={folderId ?? UNFILED} onChange={(value) => { setFolderId(value === UNFILED ? null : value); setChangingFolder(false); }}
            options={[{ value: UNFILED, label: "Unfiled" }, ...folders.map((item) => ({ value: item.id, label: item.label }))]} />
          : <button type="button" className="secondary-button" onClick={() => setChangingFolder(true)} disabled={busy}>Change</button>}
      </div>}
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
