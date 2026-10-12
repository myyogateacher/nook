import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { BookOpen, ChevronDown, ChevronLeft, ChevronUp, Cpu, FileText, NotebookText, Plus, RefreshCw, Search, Share2, TextQuote, Trash2, UsersRound } from "lucide-react";
import { ApiError } from "../api";
import { AccessSheet } from "../access/AccessSheet";
import { ModalDialog } from "../files/Dialog";
import { hubDocumentTitle, type Route } from "../router";
import { useConfirm } from "../ui/useConfirm";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { KNOWLEDGE_BOUNDS, KNOWLEDGE_SHARE_NOTE, type KnowledgeCandidate, type KnowledgeDetail, type KnowledgeHit, type KnowledgeSource, type KnowledgeSummary } from "../../shared/knowledge";
import { agentsStatus, messageOf, type AgentsStatus } from "./chatApi";
import { addSource, createKnowledge, deleteKnowledge, getKnowledge, hitSource, knowledgeLine, knowledgePaused, listKnowledge, pollInterval, reindexKnowledge, removeSource, searchKnowledge, sourceCandidates, sourceLabel, sourceStatusLabel, SOURCE_STATUS_LABELS, updateKnowledge } from "./knowledgeApi";
import { HUB_TITLE_ID } from "../settings/hubModel";
import { ModelSheet, SourceChunks } from "./KnowledgeModel";
import "./chat.css";
import "./knowledge.css";
import { notify } from "../ui/notify";

type Navigate = (route: Route, options?: { replace?: boolean }) => void;

/** D367's sentence, on every base's page and its Access sheet. */
export const KNOWLEDGE_WARNING = "Anyone who can use an agent with this knowledge base can read its text.";

/**
 * Settings → Knowledge (agent chat plan §9, §13.4; Wave 44 "AC-E"): a list of the bases you own and
 * those shared with you, and a page per base at /settings/knowledge/:id (a nested hub page with its
 * own back link) with its sources and their state, Add source, Re-index all, Share…, and Try it.
 * Every sheet closes on Back first (useHistoryDialogGuard).
 */
export function KnowledgeSettings({ kbId, navigate, flash }: { kbId: string | null; navigate: Navigate; flash: (message: string) => void }) {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [bases, setBases] = useState<KnowledgeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    try {
      const next = await agentsStatus();
      setStatus(next);
      if (!next.enabled || !next.canChat) { setBases([]); return; }
      setBases((await listKnowledge()).knowledgeBases);
      setError(null);
    } catch (reason) {
      setError(messageOf(reason, "Could not load knowledge bases"));
    }
  }, []);
  useEffect(() => { void load(); }, [kbId, load]);
  useEffect(() => { if (!kbId) document.title = hubDocumentTitle("Knowledge"); }, [kbId]);
  const toList = { app: "settings" as const, section: "knowledge" as const };
  if (kbId) return <KnowledgePage kbId={kbId} navigate={navigate} flash={flash} />;
  const own = bases?.filter((kb) => kb.yourLevel === "owner") ?? null;
  const shared = bases?.filter((kb) => kb.yourLevel !== "owner") ?? [];
  const row = (kb: KnowledgeSummary) => <li key={kb.id}>
    <button type="button" className="agents-row" onClick={() => navigate({ ...toList, kbId: kb.id })}>
      <span className="agents-row-icon" aria-hidden="true"><BookOpen /></span>
      <span className="agents-row-text"><strong>{kb.name}</strong><small>{kb.yourLevel !== "owner" ? `${kb.ownerName} · ${kb.yourLevel === "manage" ? "Manager" : "Can search"} · ` : ""}{knowledgeLine(kb)}</small></span>
      <StatusBadge status={kb.status === "indexing" ? (knowledgePaused(kb) ? "pending" : "indexing") : kb.counts.error > 0 || kb.status === "error" ? "error" : kb.status === "ready" ? "ready" : null} label={kb.status === "indexing" && knowledgePaused(kb) ? "Paused" : undefined} />
    </button>
  </li>;
  return <section className="settings-content agents-settings knowledge-settings" aria-labelledby={HUB_TITLE_ID}>
    <div className="settings-section-heading"><span className="settings-icon"><BookOpen /></span><div><p>A knowledge base holds notes, text files, and pasted text that your agents can search. Its text is sent to the model provider to be indexed and whenever an agent quotes it.</p></div></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {status && !status.enabled && <p className="settings-warning">Chat is not configured on this server{status.reason ? " (see Settings → AI)" : ""}.</p>}
    {status?.enabled && !status.canChat && <p className="settings-warning">Chat is off for your role.</p>}
    {own && own.length > 0 && <ul className="agents-list" aria-label="Your knowledge bases">{own.map(row)}</ul>}
    {bases && bases.length === 0 && status?.enabled && status.canChat && <p className="chat-muted">No knowledge bases yet.</p>}
    {shared.length > 0 && <><h4 className="agents-shared-heading"><UsersRound aria-hidden="true" />Shared with you</h4><ul className="agents-list" aria-label="Knowledge bases shared with you">{shared.map(row)}</ul></>}
    {status?.enabled && status.canCreate && <button type="button" className="action-button secondary agents-add" onClick={() => setCreating(true)}><Plus />New knowledge base</button>}
    {creating && <CreateSheet onClose={() => setCreating(false)} onCreated={(created) => { setCreating(false); notify.success("Knowledge base created"); navigate({ ...toList, kbId: created.id }); }} />}
  </section>;
}

function StatusBadge({ status, label }: { status: KnowledgeSource["status"] | null; label?: string }) {
  if (!status) return null;
  const tone = status === "ready" ? " ai-badge-ok" : status === "error" || status === "unavailable" ? " ai-badge-warn" : "";
  return <span className={`ai-badge${tone} knowledge-status`} data-status={status}>{label ?? SOURCE_STATUS_LABELS[status]}</span>;
}

/** New knowledge base: a name and a description. */
function CreateSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (kb: KnowledgeDetail) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), description: useId() };
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    setBusy(true);
    setError(null);
    try {
      onCreated((await createKnowledge({ name: name.trim(), description: description.trim() })).knowledgeBase);
    } catch (reason) {
      setError(messageOf(reason, "Could not create the knowledge base"));
      setBusy(false);
    }
  }
  return <ModalDialog title="New knowledge base" onClose={onClose} busy={busy} variant="sheet" className="chat-dialog knowledge-sheet">
    <form className="file-dialog-form" onSubmit={submit}>
      {error && <p className="form-error" role="alert">{error}</p>}
      <label htmlFor={ids.name}>Name</label>
      <input id={ids.name} value={name} maxLength={KNOWLEDGE_BOUNDS.name} autoComplete="off" autoFocus onChange={(event) => setName(event.target.value)} />
      <label htmlFor={ids.description}>Description</label>
      <input id={ids.description} value={description} maxLength={KNOWLEDGE_BOUNDS.description} autoComplete="off" placeholder="What it answers (agents see this)" onChange={(event) => setDescription(event.target.value)} />
      <p className="file-dialog-hint">It uses the default model provider's embedding model. Its owner can change the model later; every source is then embedded again.</p>
      <footer className="file-dialog-actions">
        <button type="button" className="action-button secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="action-button" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
      </footer>
    </form>
  </ModalDialog>;
}

/** A base's page: its sources and their state, actions for managers, and Try it. */
function KnowledgePage({ kbId, navigate, flash }: { kbId: string; navigate: Navigate; flash: (message: string) => void }) {
  const [kb, setKb] = useState<KnowledgeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"add" | "share" | "rename" | "model" | null>(null);
  // 2026-10-08: the sources whose chunk previews are open.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (sourceId: string) => setExpanded((current) => { const next = new Set(current); if (next.has(sourceId)) next.delete(sourceId); else next.add(sourceId); return next; });
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const toList = { app: "settings" as const, section: "knowledge" as const };
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const flashRef = useRef(flash);
  flashRef.current = flash;
  const load = useCallback(async () => {
    try {
      setKb((await getKnowledge(kbId)).knowledgeBase);
      setError(null);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) { flashRef.current("Knowledge base not found"); navigateRef.current(toList, { replace: true }); return; }
      setError(messageOf(reason, "Could not load the knowledge base"));
    }
    // toList is a constant object; kbId decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kbId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { document.title = hubDocumentTitle(kb?.name ?? "Knowledge base"); }, [kb?.name]);
  // While a source waits or is being indexed, the page checks again every 1.5 s; every 60 s while all
  // that waits is paused on the daily budget (QA LOW-3).
  const every = kb ? pollInterval(kb.sources) : null;
  useEffect(() => {
    if (every === null) return;
    const timer = window.setInterval(() => { void load(); }, every);
    return () => window.clearInterval(timer);
  }, [every, load]);

  const manager = kb?.yourLevel === "owner" || kb?.yourLevel === "manage";
  async function reindex() {
    if (!kb) return;
    setBusy(true);
    try {
      const result = await reindexKnowledge(kb.id);
      notify.success(`Re-indexing ${result.sources} ${result.sources === 1 ? "source" : "sources"}`);
      await load();
    } catch (reason) {
      notify.error(messageOf(reason, "Could not re-index"));
    } finally {
      setBusy(false);
    }
  }
  async function remove(source: KnowledgeSource) {
    if (!kb) return;
    const label = sourceLabel(source);
    if (!await confirm.ask({ title: `Remove ${label.title}?`, message: "Its passages leave the knowledge base at once. The note or file itself is not changed.", confirmLabel: "Remove", danger: true })) return;
    try {
      await removeSource(kb.id, source.id);
      notify.success("Source removed");
      await load();
    } catch (reason) {
      notify.error(messageOf(reason, "Could not remove the source"));
    }
  }
  async function moveToBin() {
    if (!kb) return;
    if (!await confirm.ask({ title: `Move ${kb.name} to the Bin?`, message: "Agents that use it stop finding it at once. Deleted forever after 30 days.", confirmLabel: "Move to Bin", danger: true })) return;
    try {
      await deleteKnowledge(kb.id);
      notify.success("Moved to the Bin");
      navigate(toList, { replace: true });
    } catch (reason) {
      notify.error(messageOf(reason, "Could not delete the knowledge base"));
    }
  }

  return <div className="settings-content settings-team-content knowledge-page">
    <button type="button" className="team-back team-back-visible" onClick={() => navigate(toList)}><ChevronLeft />Knowledge</button>
    <div className="settings-section-heading"><span className="settings-icon"><BookOpen /></span><div><h3>{kb?.name ?? "Knowledge base"}</h3><p>{kb ? `${kb.description ? `${kb.description} · ` : ""}${kb.yourLevel === "owner" ? "Yours" : `${kb.ownerName}'s · ${kb.yourLevel === "manage" ? "you manage it" : "you can search it"}`}` : "Loading…"}</p></div></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {kb && <>
      <p className="settings-warning knowledge-warning" role="note">{KNOWLEDGE_WARNING}</p>
      {kb.notice && <p className="settings-warning knowledge-notice" role="status">{kb.notice}</p>}
      <p className="chat-muted">{knowledgeLine(kb)} · {kb.providerName ? `${kb.providerName} · ` : ""}{kb.embeddingModel}, {kb.dims} dimensions</p>
      {manager && <div className="agents-actions knowledge-actions">
        <button type="button" className="action-button" onClick={() => setSheet("add")}><Plus />Add source</button>
        <button type="button" className="action-button secondary" onClick={() => { void reindex(); }} disabled={busy || kb.sourceCount === 0}><RefreshCw />Re-index all</button>
        <button type="button" className="action-button secondary" onClick={() => setSheet("share")}><Share2 />Share…</button>
        <button type="button" className="action-button secondary" onClick={() => setSheet("rename")}>Rename</button>
        {kb.yourLevel === "owner" && <button type="button" className="action-button secondary" onClick={() => setSheet("model")}><Cpu />Change embedding model</button>}
        {kb.yourLevel === "owner" && <button type="button" className="action-button secondary" onClick={() => { void moveToBin(); }}><Trash2 />Move to Bin</button>}
      </div>}
      <h4 className="knowledge-subheading">Sources</h4>
      {kb.sources.length === 0 ? <p className="chat-muted">{manager ? "No sources yet. Add a note, a text, Markdown, or CSV file, or paste text." : "No sources yet."}</p>
        : <ul className="knowledge-sources" aria-label="Sources">
          {kb.sources.map((source) => {
            const label = sourceLabel(source);
            const Icon = source.kind === "note" ? NotebookText : source.kind === "document" ? FileText : TextQuote;
            const open = expanded.has(source.id);
            return <li key={source.id} className="knowledge-source">
              <Icon aria-hidden="true" />
              <div className="knowledge-source-text">
                <strong className={source.titleHidden ? "knowledge-hidden" : undefined}>{label.title}</strong>
                <small>{label.kind}{source.status === "ready" ? ` · ${source.chunkCount} ${source.chunkCount === 1 ? "chunk" : "chunks"}` : ""}{source.indexedAt ? ` · indexed ${new Date(source.indexedAt).toLocaleString()}` : ""}</small>
                {source.error && <small className="knowledge-source-error">{source.error}</small>}
                {source.status === "unavailable" && <small className="knowledge-source-error">The owner can no longer read it, so its passages were removed.</small>}
              </div>
              <StatusBadge status={source.status} label={sourceStatusLabel(source)} />
              {source.previewable && source.chunkCount > 0 && <button type="button" className="icon-button" aria-expanded={open} onClick={() => toggle(source.id)} aria-label={`${open ? "Hide" : "Show"} passages of ${label.title}`}>{open ? <ChevronUp /> : <ChevronDown />}</button>}
              {manager && <button type="button" className="icon-button" onClick={() => { void remove(source); }} aria-label={`Remove ${label.title}`}><Trash2 /></button>}
              {open && source.previewable && <SourceChunks kbId={kb.id} sourceId={source.id} label={label.title} />}
            </li>;
          })}
        </ul>}
      <TryIt kb={kb} />
    </>}
    {sheet === "add" && kb && <AddSourceSheet kb={kb} onClose={() => setSheet(null)} onAdded={() => { notify.success("Source added; indexing"); void load(); }} />}
    {sheet === "model" && kb && <ModelSheet kb={kb} onClose={() => setSheet(null)} onChanged={(next, sources) => { setSheet(null); setKb(next); setExpanded(new Set()); notify.success(`Embedding ${sources} ${sources === 1 ? "source" : "sources"} again with ${next.embeddingModel}`); }} />}
    {sheet === "rename" && kb && <RenameSheet kb={kb} onClose={() => setSheet(null)} onSaved={(next) => { setSheet(null); setKb(next); notify.success("Saved"); }} />}
    {sheet === "share" && kb && <AccessSheet kind="knowledge_base" id={kb.id} title={kb.name} guardHistory note={KNOWLEDGE_SHARE_NOTE} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); notify.success("Access updated"); void load(); }} />}
    {confirm.confirmElement}
  </div>;
}

function RenameSheet({ kb, onClose, onSaved }: { kb: KnowledgeDetail; onClose: () => void; onSaved: (kb: KnowledgeDetail) => void }) {
  const [name, setName] = useState(kb.name);
  const [description, setDescription] = useState(kb.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), description: useId() };
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    setBusy(true);
    try {
      onSaved((await updateKnowledge(kb.id, { name: name.trim(), description: description.trim() })).knowledgeBase);
    } catch (reason) {
      setError(messageOf(reason, "Could not save"));
      setBusy(false);
    }
  }
  return <ModalDialog title="Rename" eyebrow={kb.name} onClose={onClose} busy={busy} variant="sheet" className="chat-dialog knowledge-sheet">
    <form className="file-dialog-form" onSubmit={submit}>
      {error && <p className="form-error" role="alert">{error}</p>}
      <label htmlFor={ids.name}>Name</label>
      <input id={ids.name} value={name} maxLength={KNOWLEDGE_BOUNDS.name} autoComplete="off" onChange={(event) => setName(event.target.value)} />
      <label htmlFor={ids.description}>Description</label>
      <input id={ids.description} value={description} maxLength={KNOWLEDGE_BOUNDS.description} autoComplete="off" onChange={(event) => setDescription(event.target.value)} />
      <footer className="file-dialog-actions">
        <button type="button" className="action-button secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="action-button" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </footer>
    </form>
  </ModalDialog>;
}

type AddMode = "note" | "document" | "text";
const MODES: Array<{ value: AddMode; label: string }> = [{ value: "note", label: "Note" }, { value: "document", label: "File" }, { value: "text", label: "Paste text" }];

/**
 * Add source (plan §13.4): a published note or a text, Markdown, or CSV file from Files that both
 * you and the base's owner can read (the pickers offer only those), or pasted text.
 */
export function AddSourceSheet({ kb, onClose, onAdded }: { kb: KnowledgeDetail; onClose: () => void; onAdded: () => void }) {
  const [mode, setMode] = useState<AddMode>("note");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<KnowledgeCandidate[] | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const ids = { query: useId(), title: useId(), text: useId() };
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  useEffect(() => {
    if (mode === "text") return;
    let cancelled = false;
    setCandidates(null);
    const timer = window.setTimeout(() => {
      sourceCandidates(kb.id, mode, query).then((result) => { if (!cancelled) setCandidates(result.candidates); }, (reason) => { if (!cancelled) setError(messageOf(reason, "Could not load the list")); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [kb.id, mode, query]);
  async function add(input: Parameters<typeof addSource>[1], key: string) {
    setBusy(true);
    setError(null);
    try {
      await addSource(kb.id, input);
      setAdded((current) => new Set([...current, key]));
      onAdded();
      if (input.kind === "text") onClose();
    } catch (reason) {
      setError(messageOf(reason, "Could not add the source"));
    } finally {
      setBusy(false);
    }
  }
  const bytes = new TextEncoder().encode(text).byteLength;
  // v0.30 L1: the owner reads as themselves; a manager sees only what both they and the owner can read.
  const readers = kb.yourLevel === "owner" ? "Only what you can read is listed." : `Only what both you and ${kb.ownerName} can read is listed; it is read as ${kb.ownerName} when indexed.`;
  // v0.30 H: the sheet follows the shared dialog contract (files.css): its one child is the
  // .file-dialog-form, the single scroller under the fixed header, whose footer stays in view at its
  // end (sticky). It is one form in every mode (the mode buttons keep focus); only Paste text submits.
  const submitText = (event: FormEvent) => { event.preventDefault(); if (mode !== "text") return; if (!title.trim() || !text.trim()) { setError("Enter a title and some text."); return; } void add({ kind: "text", title: title.trim(), text }, "text"); };
  return <ModalDialog title="Add source" eyebrow={kb.name} onClose={onClose} busy={busy} variant="sheet" className="chat-dialog knowledge-sheet knowledge-add">
    <form className="file-dialog-form knowledge-add-body" onSubmit={submitText}>
      <div className="knowledge-modes" role="group" aria-label="Source type">
        {MODES.map((option) => <button key={option.value} type="button" className={`knowledge-mode${mode === option.value ? " active" : ""}`} aria-pressed={mode === option.value} onClick={() => { setMode(option.value); setError(null); }}>{option.label}</button>)}
      </div>
      <p className="file-dialog-hint">{KNOWLEDGE_WARNING}{mode === "text" ? "" : ` ${readers}`}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {mode !== "text" ? <>
        <label className="sr-only" htmlFor={ids.query}>Search {mode === "note" ? "notes" : "files"}</label>
        <div className="knowledge-search-field"><Search aria-hidden="true" /><input id={ids.query} type="search" value={query} autoComplete="off" placeholder={mode === "note" ? "Search published notes" : "Search .txt, .md, and .csv files"} onChange={(event) => setQuery(event.target.value)} /></div>
        {candidates === null ? <p className="chat-muted" role="status">Loading…</p>
          : candidates.length === 0 ? <p className="chat-muted">{mode === "note" ? "No published notes match." : "No text (.txt), Markdown (.md), or CSV (.csv) files of 1 MiB or less match."}</p>
          : <ul className="knowledge-candidates" aria-label={mode === "note" ? "Notes" : "Files"}>
            {candidates.map((item) => {
              const done = item.added || added.has(item.id);
              return <li key={item.id}>
                <div className="knowledge-source-text"><strong>{item.title}</strong><small>{item.detail}</small></div>
                {done ? <span className="ai-badge ai-badge-ok">Added</span> : <button type="button" className="action-button secondary" disabled={busy} onClick={() => { void add(mode === "note" ? { kind: "note", noteId: item.id } : { kind: "document", documentId: item.id }, item.id); }}>Add</button>}
              </li>;
            })}
          </ul>}
      </> : <>
        <label htmlFor={ids.title}>Title</label>
        <input id={ids.title} value={title} maxLength={KNOWLEDGE_BOUNDS.textTitle} autoComplete="off" placeholder="Billing FAQ" onChange={(event) => setTitle(event.target.value)} />
        <label htmlFor={ids.text}>Text <small>{Math.ceil(bytes / 1024).toLocaleString()} / {KNOWLEDGE_BOUNDS.textBytes / 1024} KiB</small></label>
        <textarea id={ids.text} className="knowledge-paste" value={text} rows={10} spellCheck={false} placeholder={"# Billing\n\n## How do refunds work?\nRefunds are pro rata.\n\nQ: Can I pause?\nA: Yes, for up to three months."} onChange={(event) => setText(event.target.value)} />
        <p className="file-dialog-hint">Markdown headings become the passages' heading paths; a heading that asks a question, or a Q: / A: pair, stays one passage.</p>
      </>}
      <footer className="file-dialog-actions">
        {mode === "text" ? <>
          <button type="button" className="action-button secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="action-button" disabled={busy || bytes > KNOWLEDGE_BOUNDS.textBytes}>{busy ? "Adding…" : "Add text"}</button>
        </> : <button type="button" className="action-button secondary" onClick={onClose} disabled={busy}>Done</button>}
      </footer>
    </form>
  </ModalDialog>;
}

/** Try it (plan §13.4, Dify's hit testing): the ranked passages for a question, with heading paths and scores. */
function TryIt({ kb }: { kb: KnowledgeDetail }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [mode, setMode] = useState<"hybrid" | "keyword">("hybrid");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  async function run(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await searchKnowledge(kb.id, query.trim());
      setHits(result.hits);
      setMode(result.mode);
      setNotice(result.notice ?? null);
    } catch (reason) {
      setError(messageOf(reason, "Could not search"));
    } finally {
      setBusy(false);
    }
  }
  return <section className="knowledge-try" aria-labelledby={`${id}-heading`}>
    <h4 id={`${id}-heading`} className="knowledge-subheading">Try it</h4>
    <form className="knowledge-try-form" onSubmit={run} role="search">
      <label className="sr-only" htmlFor={id}>Ask the knowledge base</label>
      <input id={id} type="search" value={query} maxLength={KNOWLEDGE_BOUNDS.queryChars} autoComplete="off" placeholder="Ask what an agent would ask" onChange={(event) => setQuery(event.target.value)} />
      <button type="submit" className="action-button secondary" disabled={busy || !query.trim()}><Search />{busy ? "Searching…" : "Search"}</button>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}
    {hits && <div aria-live="polite">
      {mode === "keyword" && <p className="chat-muted">{notice ? `Matched by keywords only. ${notice}` : "Matched by keywords only: the embedding model was not available."}</p>}
      {hits.length === 0 ? <p className="chat-muted">No passages match.</p> : <ol className="knowledge-hits" aria-label="Top passages">
        {hits.map((hit, index) => <li key={`${hit.kb.id}-${index}`} className="knowledge-hit">
          <div className="knowledge-hit-head"><strong>{hit.heading ?? "(no heading)"}</strong><span className="ai-badge">{hit.score.toFixed(4)}</span></div>
          <small>{hitSource(hit)} · vector #{hit.ranks.vector ?? "–"} · keyword #{hit.ranks.keyword ?? "–"}</small>
          <p className="knowledge-hit-text">{hit.text}</p>
        </li>)}
      </ol>}
    </div>}
  </section>;
}
