import { useCallback, useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Link2, Loader2, Lock, Plus, Search, X } from "lucide-react";
import { ModalDialog } from "../../files/Dialog";
import { errorText } from "../notify";
import { Select } from "../Select";
import { EmptyState } from "../EmptyState";
import { HealthChip } from "../progress/Progress";
import { useHistoryDialogGuard } from "../useHistoryDialogGuard";
import { createLink, deleteLink, listLinks, resolveRef, searchWork } from "../workspaceApi";
import { appIcon, workIcon } from "./workIcons";
import { isWorkKind, LINK_RELATIONS, parseWorkRef, RELATION_WORDS, WORK_KIND_LABELS, type HiddenWorkSummary, type LinkRelation, type WorkLinkView, type WorkRef, type WorkSummary } from "../../../shared/workRefs";
import "../pickerSheet.css";
import "../workspace.css";

/**
 * Work references (§B.4, §E.3, D839): one chip, one panel, one picker for every link between items
 * across modules. A side the viewer cannot read is "An item you can't open" with its kind's icon
 * only (T501): no title, no link.
 */

const isHidden = (summary: WorkSummary | HiddenWorkSummary): summary is HiddenWorkSummary => "hidden" in summary && summary.hidden === true;

/** Plain click opens in the app; modified clicks keep the browser's behaviour (a real link). */
const appClick = (href: string, onOpen?: (href: string) => void) => (event: ReactMouseEvent<HTMLAnchorElement>) => {
  if (!onOpen || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onOpen(href);
};

export function WorkRefChip({ summary, onOpen, onRemove, removeLabel }: {
  summary: WorkSummary | HiddenWorkSummary;
  /** Opens the item's in-app href (a new history entry). */
  onOpen?: (href: string) => void;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  if (isHidden(summary)) {
    const Icon = workIcon(undefined, summary.kind);
    return <span className="ui-workref hidden" title={`${WORK_KIND_LABELS[summary.kind]} you can't open`}>
      <Icon aria-hidden="true" /><span className="ui-workref-title">An item you can't open</span><Lock className="ui-workref-lock" aria-hidden="true" />
      {onRemove && <button type="button" className="ui-workref-remove" onClick={onRemove} aria-label={removeLabel ?? "Remove link"} title="Remove link"><X /></button>}
    </span>;
  }
  const Icon = workIcon(summary.icon, summary.kind);
  const progress = summary.progress !== undefined && Number.isFinite(summary.progress) ? `${Math.round(summary.progress * 100)}%` : null;
  return <span className="ui-workref">
    <a className="ui-workref-link" href={summary.href} onClick={appClick(summary.href, onOpen)} title={summary.subtitle ? `${summary.title} · ${summary.subtitle}` : summary.title}>
      <Icon aria-hidden="true" />
      {summary.key && <span className="ui-workref-key">{summary.key}</span>}
      <span className="ui-workref-title">{summary.title}</span>
      <span className="ui-visually-hidden">, {WORK_KIND_LABELS[summary.kind]}</span>
    </a>
    {progress && <span className="ui-workref-meta ui-tabular">{progress}</span>}
    {summary.status && <HealthChip tone={summary.status.tone} label={summary.status.label} />}
    {onRemove && <button type="button" className="ui-workref-remove" onClick={onRemove} aria-label={removeLabel ?? `Remove link to ${summary.title}`} title="Remove link"><X /></button>}
  </span>;
}

/** "contributes to", "is blocked by": how a link reads from this item's side. */
export const relationText = (link: Pick<WorkLinkView, "relation" | "direction">) => link.direction === "out" ? RELATION_WORDS[link.relation].outgoing : RELATION_WORDS[link.relation].incoming;

/** Links grouped by how they read from this side, in relation order. */
export function groupLinks(links: readonly WorkLinkView[]) {
  const groups = new Map<string, WorkLinkView[]>();
  for (const relation of LINK_RELATIONS) for (const direction of ["out", "in"] as const) {
    const items = links.filter((link) => link.relation === relation && link.direction === direction);
    if (items.length) groups.set(relationText({ relation, direction }), items);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }));
}

/**
 * The Linked panel of an item (goal, deal, contact, booking, form…): every link to and from it,
 * grouped by relation, with **Link work** and remove for those the viewer may change. Links kept in
 * other tables (card relations, event links, attachments) show here read-only.
 */
export function LinkedItemsPanel({ item, canEdit, onOpen, relations = ["relates"], title = "Linked", idPrefix }: {
  item: WorkRef;
  canEdit: boolean;
  onOpen?: (href: string) => void;
  /** Relations "Link work" offers, in order (the first is the default). */
  relations?: readonly LinkRelation[];
  title?: string;
  idPrefix?: string;
}) {
  const autoId = useId();
  const headingId = `${idPrefix ?? autoId}-linked`;
  const [links, setLinks] = useState<WorkLinkView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    listLinks(item).then((body) => setLinks(body.links), (reason) => setError(errorText(reason, "Could not load links")));
  }, [item.kind, item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);

  const remove = async (link: WorkLinkView) => {
    setBusy(link.id);
    try { await deleteLink(link.id); setLinks((current) => current?.filter((entry) => entry.id !== link.id) ?? null); }
    catch (reason) { setError(errorText(reason, "Could not remove the link")); }
    finally { setBusy(null); }
  };

  return <section className="ui-linked" aria-labelledby={headingId} aria-busy={links === null || undefined}>
    <header className="ui-panel-header">
      <h3 id={headingId}><Link2 aria-hidden="true" />{title}{links && links.length > 0 && <span className="ui-panel-count"> · {links.length}</span>}</h3>
      {canEdit && <button type="button" className="secondary-button ui-small-button" onClick={() => setPicking(true)} aria-haspopup="dialog"><Plus aria-hidden="true" />Link work</button>}
    </header>
    {error && <p className="ui-field-error" role="alert">{error} <button type="button" className="ui-text-button" onClick={load}>Retry</button></p>}
    {links === null && !error && <p className="ui-panel-loading" role="status">Loading links…</p>}
    {links && links.length === 0 && <EmptyState compact as="h4" icon={Link2} title="Nothing linked yet">{canEdit ? "Link cards, notes, goals, or contacts this relates to." : undefined}</EmptyState>}
    {links && links.length > 0 && groupLinks(links).map((group) => <div key={group.label} className="ui-linked-group">
      <h4 className="ui-linked-relation">{group.label[0]!.toUpperCase() + group.label.slice(1)}</h4>
      <ul className="ui-linked-list">
        {group.items.map((link) => <li key={link.id} aria-busy={busy === link.id || undefined}>
          <WorkRefChip summary={link.other} onOpen={onOpen} onRemove={canEdit && link.source === "work_links" && busy !== link.id ? () => { void remove(link); } : undefined} />
        </li>)}
      </ul>
    </div>)}
    {picking && <LinkPicker title="Link work" relations={relations} onClose={() => setPicking(false)} onPick={async (target, relation) => {
      const { link } = await createLink(item, "ref" in target ? target : { kind: target.kind, id: target.id }, relation);
      setLinks((current) => [...(current ?? []), link]);
    }} />}
  </section>;
}

type Candidate = WorkSummary;

/**
 * A search result of the All scope that names an item: a module scope's result, or a built-in hit by
 * its `ref` (notes, cards, events, files, whiteboards, collections and rows, reports; D1342). Chats
 * are not a work kind and are left out. The subtitle is the hit's own context (a board, a calendar).
 */
export function candidateOf(result: unknown): Candidate | null {
  if (!result || typeof result !== "object") return null;
  const value = result as Record<string, unknown>;
  const ref = value.ref && typeof value.ref === "object" ? value.ref as Record<string, unknown> : null;
  const named = ref ?? value;
  if (!isWorkKind(named.kind) || typeof named.id !== "string" || typeof named.title !== "string" || typeof named.href !== "string") return null;
  const subtitle = typeof value.snippet === "string" ? value.snippet
    : typeof value.board_name === "string" ? value.board_name
      : typeof value.calendarName === "string" ? value.calendarName
        : typeof value.collectionName === "string" ? value.collectionName : undefined;
  return { kind: named.kind, id: named.id, title: named.title, href: named.href, icon: typeof value.icon === "string" ? value.icon : "", ...(subtitle ? { subtitle } : {}), ...(typeof value.key === "string" ? { key: value.key } : {}) };
}

/**
 * Pick an item to link (a sheet on phones): paste a key (`MYT-12`), an in-app URL, or `kind:id`, or
 * search across modules; choose how it relates; Link. `onPick` makes the link; its error shows here.
 */
export function LinkPicker({ title, relations, onPick, onClose }: {
  title: string;
  relations: readonly LinkRelation[];
  onPick: (target: WorkSummary | { ref: string }, relation: LinkRelation) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [relation, setRelation] = useState<LinkRelation>(relations[0] ?? "relates");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useHistoryDialogGuard(true, onClose, { blocked: busy });

  useEffect(() => {
    const text = query.trim();
    if (!text) { setResults(null); setSearching(false); return; }
    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      const origin = typeof window !== "undefined" ? [window.location.origin] : [];
      const ref = parseWorkRef(text, origin);
      const request = ref
        ? resolveRef(text, controller.signal).then((body) => [body.summary], () => [])
        : searchWork(text, controller.signal).then((body) => body.sections.flatMap((section) => section.results.map(candidateOf).filter((item): item is Candidate => item !== null)).slice(0, 30));
      request.then((items) => { if (!controller.signal.aborted) { setResults(items); setSearching(false); } }, (reason) => {
        if (controller.signal.aborted) return;
        setResults([]);
        setSearching(false);
        setError(errorText(reason, "Search failed"));
      });
    }, 200);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query]);

  const pick = async (target: Candidate) => {
    setBusy(true);
    setError(null);
    try { await onPick(target, relation); onClose(); }
    catch (reason) { setError(errorText(reason, "Could not link it")); }
    finally { setBusy(false); }
  };

  return <ModalDialog title={title} onClose={onClose} variant="sheet" busy={busy} className="nook-picker">
    <label className="nook-picker-search">
      <Search aria-hidden="true" />
      <span className="ui-visually-hidden">Search work, or paste a key or link</span>
      <input ref={inputRef} type="search" autoFocus value={query} maxLength={200} placeholder="Search, or paste MYT-12 or a link" onChange={(event) => { setQuery(event.target.value); setError(null); }} />
      {searching && <Loader2 className="spin" aria-hidden="true" />}
    </label>
    {relations.length > 1 && <div className="nook-picker-actions">
      <Select label="How it relates" value={relation} onChange={setRelation} options={relations.map((value) => ({ value, label: `This ${RELATION_WORDS[value].outgoing} …` }))} />
    </div>}
    {error && <p className="nook-picker-hint ui-field-error" role="alert" style={{ margin: "0 16px 8px 20px" }}>{error}</p>}
    <div className="nook-picker-body">
      {results === null
        ? <p className="nook-picker-empty">Type to search cards, notes, goals, contacts, and more.</p>
        : results.length === 0 && !searching
          ? <p className="nook-picker-empty">Nothing found you can open.</p>
          : <ul className="nook-picker-list" aria-label="Results">
            {results.map((item) => {
              const Icon = appIcon(item.kind);
              return <li key={`${item.kind}:${item.id}`}><button type="button" disabled={busy} onClick={() => { void pick(item); }}>
                <Icon aria-hidden="true" />
                <span><strong>{item.key ? `${item.key} · ` : ""}{item.title}</strong><small>{[WORK_KIND_LABELS[item.kind], item.subtitle].filter(Boolean).join(" · ")}</small></span>
              </button></li>;
            })}
          </ul>}
    </div>
  </ModalDialog>;
}
