import { useCallback, useEffect, useMemo, useState } from "react";
import { BellRing, BookUser, Building2, Contact, Download, FileUp, Handshake, ListChecks, Loader2, Plus, Settings2, Trash2, Users } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { ModuleHome, type ModulePrimaryAction } from "../ui/ModuleHome";
import { EmptyState } from "../ui/EmptyState";
import { Select } from "../ui/Select";
import { notify } from "../ui/notify";
import { useConfirm } from "../ui/useConfirm";
import { canWriteContent } from "../team/teamRoles";
import type { WorkspaceAppProps } from "../workspaceModules/types";
import type { Route } from "../router";
import { shortIdOfSegment } from "../../shared/friendlyUrls";
import type { CrmBook, CrmDeal, CrmEntity, CrmFollowup, CrmList } from "../../shared/crm";
import {
  contactDuplicates, createBook, deleteList, errorMessage, exportUrl, listBooks, listDeals, listFollowups, listLists, mergeContact, getList, renameList, updateFollowup
} from "./crmApi";
import { RecordsView } from "./Records";
import { DealsView, DealCard } from "./DealsView";
import { RecordPage } from "./RecordPage";
import { InsightsView } from "./InsightsView";
import { SettingsView } from "./SettingsView";
import { ImportSheet } from "./ImportSheet";
import { LogInteractionSheet, NewDealSheet, NewListSheet, NewRecordSheet } from "./Sheets";
import { dateTime, isPast, relative } from "./format";
import { CRM_SECTIONS, crmSectionOf, type CrmSection } from "./sections";
import "./crm.css";
import "./crmPanels.css";

/**
 * Contacts (module `crm`, §D.5 "CRM home"): one app for people, companies, deals, lists, Insights,
 * follow-ups, and the book's settings, on the shared ModuleHome scaffold (§E.2). The book switcher
 * picks the contact book (people and companies may show every book); records open as pages.
 */

// The tabs are the module's sections (D1280), one list with the sidebar's.
type Tab = CrmSection | "duplicates";
const TAB_IDS = new Set<string>([...CRM_SECTIONS.map((tab) => tab.id), "duplicates"]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refOf = (segment: string) => UUID.exec(segment)?.[0]?.toLowerCase() ?? shortIdOfSegment(segment) ?? segment;

type View = { tab: Tab; record?: { kind: CrmEntity; ref: string }; list?: string };
function viewOf(path: readonly string[]): View {
  const [first, second] = path;
  if (!first) return { tab: "contacts" };
  if (first === "companies" && second) return { tab: "companies", record: { kind: "company", ref: refOf(second) } };
  if (first === "deals" && second) return { tab: "deals", record: { kind: "deal", ref: refOf(second) } };
  if (first === "lists" && second) return { tab: "lists", list: refOf(second) };
  if (first === "contacts") return { tab: "contacts" };
  if (TAB_IDS.has(first)) return { tab: first as Tab };
  return { tab: "contacts", record: { kind: "contact", ref: refOf(first) } };
}

const LAST_BOOK = "nook.crm.book";

export default function CrmApp({ route, navigate, onOpenPath, role, displayName, onHome, onSettings, onSignOut, userId }: WorkspaceAppProps) {
  const view = viewOf(route.path);
  const params = useMemo(() => new URLSearchParams(route.search), [route.search]);
  const [books, setBooks] = useState<CrmBook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sheet, setSheet] = useState<null | "contact" | "company" | "deal" | "list" | "book" | "log" | "import-contact" | "import-company">(null);
  const [refresh, setRefresh] = useState(0);
  const writer = canWriteContent(role);

  const loadBooks = useCallback(async () => {
    try { setBooks((await listBooks()).books); setError(null); } catch (reason) { setError(errorMessage(reason, "Could not load your contact books")); setBooks([]); }
  }, []);
  useEffect(() => { void loadBooks(); }, [loadBooks]);
  useEffect(() => { setQ(""); }, [view.tab, view.list]);

  const requested = params.get("book");
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(LAST_BOOK) : null;
  const allBooks = requested === "all" && (view.tab === "contacts" || view.tab === "companies");
  const book = books?.find((item) => item.id === requested || item.shortId === requested) ?? books?.find((item) => item.id === stored) ?? books?.[0] ?? null;
  const bookWritable = Boolean(book && writer && ["edit", "manage", "owner"].includes(book.level));

  const go = (path: string[], next: Record<string, string | null> = {}, replace = false) => {
    const query = new URLSearchParams();
    const keep = { book: requested, ...next };
    for (const [key, value] of Object.entries(keep)) if (value) query.set(key, value);
    const search = query.toString();
    navigate({ app: "crm", path, search: search ? `?${search}` : "" } as Route, { replace });
  };
  const pickBook = (id: string) => {
    if (id !== "all") localStorage.setItem(LAST_BOOK, id);
    go(view.tab === "contacts" ? [] : [view.tab], { book: id, pipeline: null });
  };
  // Quick actions from Today (?new=contact, ?log=call).
  useEffect(() => {
    if (!books) return;
    if (params.get("new") === "contact" && book) { setSheet("contact"); go(route.path, { new: null }, true); }
    if (params.get("log") === "call") { setSheet("log"); go(route.path, { log: null }, true); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [books, params]);

  const tabRoute = (tab: string) => go(tab === "contacts" ? [] : [tab], { book: requested });
  // In-module paths go through the host's navigate (its route state follows only its own moves and Back/Forward); others open as app paths.
  const openHref = (href: string) => {
    if (!href.startsWith("/contacts")) { onOpenPath(href); return; }
    const [path, query = ""] = href.split("?");
    const search = new URLSearchParams(query);
    if (requested && !search.has("book")) search.set("book", requested);
    const text = search.toString();
    navigate({ app: "crm", path: path!.split("/").filter(Boolean).slice(1), search: text ? `?${text}` : "" } as Route);
  };
  const created = (entity: string) => (item: { href: string; name: string }) => { setSheet(null); setRefresh((value) => value + 1); notify.success(`Added ${item.name}`); if (entity !== "deal") openHref(item.href); };

  const primary: ModulePrimaryAction | undefined = !bookWritable ? undefined
    : view.tab === "companies" ? { label: "New company", icon: Plus, onClick: () => setSheet("company") }
    : view.tab === "deals" ? { label: "New deal", icon: Plus, onClick: () => setSheet("deal") }
    : view.tab === "lists" ? { label: "New list", icon: Plus, onClick: () => setSheet("list") }
    : view.tab === "contacts" || view.tab === "duplicates" || view.tab === "followups" ? { label: "New contact", icon: Plus, onClick: () => setSheet("contact") } : undefined;
  const menu = [
    ...(bookWritable ? [{ id: "import-contacts", label: "Import contacts (CSV)", icon: FileUp, onSelect: () => setSheet("import-contact") }, { id: "import-companies", label: "Import companies (CSV)", icon: FileUp, onSelect: () => setSheet("import-company") }] : []),
    ...(book ? [{ id: "export", label: `Export ${view.tab === "companies" ? "companies" : view.tab === "deals" ? "deals" : "people"} (CSV)`, icon: Download, onSelect: () => { window.location.href = exportUrl(book.id, view.tab === "companies" ? "company" : view.tab === "deals" ? "deal" : "contact", { q }); } }] : []),
    ...(book ? [{ id: "duplicates", label: "Find duplicates", icon: Users, onSelect: () => go(["duplicates"]) }] : []),
    ...(writer ? [{ id: "new-book", label: "New contact book", icon: BookUser, onSelect: () => setSheet("book") }] : []),
    ...(book ? [{ id: "settings", label: "Book settings", icon: Settings2, onSelect: () => go(["settings"]) }] : [])
  ];
  const bookOptions = [...(view.tab === "contacts" || view.tab === "companies" ? [{ value: "all", label: "All books" }] : []), ...(books ?? []).map((item) => ({ value: item.id, label: item.name }))];
  const searchable = ["contacts", "companies", "deals", "lists"].includes(view.tab) && !view.record;
  const filters = books && books.length > 0 ? <Select variant="chip" label="Contact book" value={allBooks ? "all" : book?.id ?? null} options={bookOptions} onChange={pickBook} /> : null;

  let content;
  if (!books) content = <p className="ui-panel-loading" role="status"><Loader2 className="spin" aria-hidden="true" /> Loading…</p>;
  else if (!book) content = <EmptyState icon={Contact} title="No contact books yet" action={writer ? { label: "New contact book", onClick: () => setSheet("book"), icon: Plus } : undefined}>
    {error ?? "A contact book holds people, companies, and deals you share with your team (Sales, Hiring, Partners)."}
  </EmptyState>;
  else if (view.record) content = <RecordPage key={`${view.record.kind}:${view.record.ref}`} kind={view.record.kind} refId={view.record.ref} books={books} canWriteRole={writer} onOpen={openHref}
    onBack={() => tabRoute(view.record!.kind === "contact" ? "contacts" : view.record!.kind === "company" ? "companies" : "deals")}
    onGone={() => { setRefresh((value) => value + 1); tabRoute(view.record!.kind === "contact" ? "contacts" : view.record!.kind === "company" ? "companies" : "deals"); }}
    onReplacePath={(href) => { const path = href.split("/").filter(Boolean).slice(1); navigate({ app: "crm", path, search: route.search } as Route, { replace: true }); }} />;
  else if (view.tab === "contacts" || view.tab === "companies") content = <RecordsView entity={view.tab === "contacts" ? "contact" : "company"} book={allBooks ? null : book} books={books} q={q} userId={userId} canWrite={bookWritable && !allBooks}
    onOpen={openHref} refreshKey={refresh} emptyAction={bookWritable ? { label: view.tab === "contacts" ? "New contact" : "New company", onClick: () => setSheet(view.tab === "contacts" ? "contact" : "company") } : undefined} />;
  else if (view.tab === "deals") content = <DealsView book={book} q={q} pipelineId={params.get("pipeline")} layout={params.get("layout") === "table" ? "table" : "board"} canWrite={bookWritable} refreshKey={refresh}
    onPipeline={(id) => go(["deals"], { pipeline: id, layout: params.get("layout") })} onLayout={(layout) => go(["deals"], { pipeline: params.get("pipeline"), layout: layout === "table" ? "table" : null }, true)} onOpen={openHref} onNew={() => setSheet("deal")} />;
  else if (view.tab === "lists") content = view.list ? <ListPage listRef={view.list} book={book} books={books} q={q} userId={userId} canWrite={bookWritable} onOpen={openHref} onBack={() => go(["lists"])} refreshKey={refresh} />
    : <ListsIndex book={book} q={q} canWrite={bookWritable} onOpen={(list) => go(["lists", list.shortId])} onNew={() => setSheet("list")} refreshKey={refresh} />;
  else if (view.tab === "followups") content = <FollowupsView onOpen={openHref} />;
  else if (view.tab === "insights") content = <InsightsView book={book} books={books} />;
  else if (view.tab === "settings") content = <SettingsView key={book.id} book={book} flash={(message) => notify.success(message)} onBookChanged={(next) => setBooks((current) => current?.map((item) => item.id === next.id ? next : item) ?? null)}
    onBinned={() => { localStorage.removeItem(LAST_BOOK); void loadBooks(); go([], { book: null }); }} />;
  else content = <DuplicatesView book={book} onOpen={openHref} />;

  return <ModuleHome icon={Contact} title="Contacts" heading={view.record ? undefined : undefined} displayName={displayName} onHome={onHome} onSettings={onSettings} onSignOut={onSignOut}
    primary={primary} menu={menu} sections={{ module: "crm", role, active: crmSectionOf(route), onSelect: tabRoute }} filters={filters}
    search={searchable ? { value: q, onChange: setQ, placeholder: view.tab === "deals" ? "Search deals" : view.tab === "companies" ? "Search companies" : view.tab === "lists" ? "Search lists" : "Search people, emails, companies", label: "Search" } : undefined}
    className="crm-home">
    {content}
    {sheet === "contact" && book && <NewRecordSheet entity="contact" book={book} onClose={() => setSheet(null)} onCreated={created("contact")} onOpenExisting={(id) => { setSheet(null); openHref(`/contacts/${id}`); }} />}
    {sheet === "company" && book && <NewRecordSheet entity="company" book={book} onClose={() => setSheet(null)} onCreated={created("company")} onOpenExisting={(id) => { setSheet(null); openHref(`/contacts/companies/${id}`); }} />}
    {sheet === "deal" && book && <NewDealSheet book={book} pipelineId={params.get("pipeline")} onClose={() => setSheet(null)} onCreated={created("deal")} />}
    {sheet === "list" && book && <NewListSheet book={book} entity="contact" onClose={() => setSheet(null)} onCreated={(list) => { setSheet(null); setRefresh((value) => value + 1); go(["lists", list.shortId]); }} />}
    {sheet === "log" && <LogInteractionSheet book={book} onClose={() => setSheet(null)} onLogged={() => { setSheet(null); notify.success("Logged"); setRefresh((value) => value + 1); }} />}
    {(sheet === "import-contact" || sheet === "import-company") && book && <ImportSheet book={book} entity={sheet === "import-contact" ? "contact" : "company"} flash={(message) => notify.success(message)}
      onClose={() => setSheet(null)} onDone={() => { setSheet(null); setRefresh((value) => value + 1); void loadBooks(); }} />}
    {sheet === "book" && <NewBookSheet onClose={() => setSheet(null)} onCreated={(created) => { setSheet(null); setBooks((current) => [...(current ?? []), created]); localStorage.setItem(LAST_BOOK, created.id); go([], { book: created.id }); }} />}
  </ModuleHome>;
}

function NewBookSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (book: CrmBook) => void }) {
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    try { onCreated((await createBook({ name, visibility: shared ? "all_users" : "private" })).book); } catch (reason) { setError(errorMessage(reason, "Could not create the book")); setBusy(false); }
  };
  return <ModalDialog title="New contact book" onClose={onClose} variant="sheet" busy={busy} className="crm-sheet">
    <form className="crm-sheet-form" noValidate onSubmit={(event) => { event.preventDefault(); if (name.trim()) void save(); }}>
      <div className="crm-sheet-body">
        <div className="ui-field"><label htmlFor="crm-book-name">Name</label><input id="crm-book-name" autoFocus maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="Sales" /></div>
        <div className="ui-field"><span>Who can see it</span><div className="ui-segmented" role="group" aria-label="Who can see it">
          <button type="button" aria-pressed={!shared} onClick={() => setShared(false)}>Only me</button>
          <button type="button" aria-pressed={shared} onClick={() => setShared(true)}>Everyone in the workspace</button>
        </div><small className="ui-field-hint">Add people one by one later in Settings. A new book starts with a five-stage sales pipeline.</small></div>
      </div>
      {error && <p className="file-dialog-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary-button" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create book"}</button></footer>
    </form>
  </ModalDialog>;
}

function ListsIndex({ book, q, canWrite: writable, onOpen, onNew, refreshKey }: { book: CrmBook; q: string; canWrite: boolean; onOpen: (list: CrmList) => void; onNew: () => void; refreshKey: number }) {
  const [lists, setLists] = useState<CrmList[] | null>(null);
  const { ask, confirmElement } = useConfirm();
  const load = useCallback(() => { listLists(book.id).then(({ lists: found }) => setLists(found), () => setLists([])); }, [book.id]);
  useEffect(load, [load, refreshKey]);
  const shown = (lists ?? []).filter((list) => !q.trim() || list.name.toLowerCase().includes(q.trim().toLowerCase()));
  if (!lists) return <p className="ui-panel-loading" role="status">Loading lists…</p>;
  if (!lists.length) return <EmptyState icon={ListChecks} title="No lists yet" action={writable ? { label: "New list", onClick: onNew } : undefined}>A list is a hand-picked set of people, companies, or deals: “Conference leads”, “Renewals in Q3”.</EmptyState>;
  return <>
    <ul className="crm-lists">{shown.map((list) => <li key={list.id}>
      <button type="button" className="crm-list-row" onClick={() => onOpen(list)}>
        <span className="crm-avatar square" aria-hidden="true">{list.entity === "company" ? <Building2 /> : list.entity === "deal" ? <Handshake /> : <Users />}</span>
        <span className="crm-list-text"><strong>{list.name}</strong><small>{list.entity === "company" ? "Companies" : list.entity === "deal" ? "Deals" : "People"} · {list.count}</small></span>
      </button>
      {writable && <button type="button" className="icon-button" aria-label={`Delete list ${list.name}`} title="Delete list" onClick={() => void ask({ title: `Delete “${list.name}”?`, message: "The list goes; the people, companies, and deals in it stay.", confirmLabel: "Delete list", danger: true }).then((yes) => { if (yes) void deleteList(list.id).then(load); })}><Trash2 /></button>}
    </li>)}</ul>
    {confirmElement}
  </>;
}

function ListPage({ listRef, book, books, q, userId, canWrite: writable, onOpen, onBack, refreshKey }: { listRef: string; book: CrmBook; books: readonly CrmBook[]; q: string; userId: string; canWrite: boolean; onOpen: (href: string) => void; onBack: () => void; refreshKey: number }) {
  const [list, setList] = useState<CrmList | null>(null);
  const [deals, setDeals] = useState<CrmDeal[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getList(listRef).then(({ list: found }) => found).then(setList, (reason) => setError(errorMessage(reason, "List not found"))); }, [listRef, refreshKey]);
  useEffect(() => { if (list?.entity === "deal") void listDeals({ book: list.bookId, list: list.id, q, limit: 200 }).then((page) => setDeals(page.items)); }, [list, q]);
  if (error) return <EmptyState icon={ListChecks} title="List not found" action={{ label: "All lists", onClick: onBack }}>{error}</EmptyState>;
  if (!list) return <p className="ui-panel-loading" role="status">Loading the list…</p>;
  const listBook = books.find((item) => item.id === list.bookId) ?? book;
  return <div className="crm-listpage">
    <div className="crm-listpage-head">
      <button type="button" className="ui-text-button" onClick={onBack}>All lists</button>
      <h2>{list.name}</h2>
      {writable && (renaming === null
        ? <button type="button" className="ui-text-button" onClick={() => setRenaming(list.name)}>Rename</button>
        : <form className="crm-inline-name" noValidate onSubmit={(event) => { event.preventDefault(); const name = renaming.trim(); setRenaming(null); if (name && name !== list.name) void renameList(list.id, name).then(({ list: renamed }) => setList(renamed)); }}>
          <label className="ui-visually-hidden" htmlFor="crm-list-name">List name</label>
          <input id="crm-list-name" autoFocus maxLength={80} value={renaming} onChange={(event) => setRenaming(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setRenaming(null); } }} />
          <button type="submit" className="ui-small-button secondary-button" disabled={!renaming.trim()}>Save</button>
        </form>)}
    </div>
    {list.entity === "deal" ? (!deals ? <p className="ui-panel-loading">Loading deals…</p> : deals.length === 0 ? <EmptyState icon={Handshake} title="This list is empty">Open a deal and use ⋯ → Add to list.</EmptyState>
      : <ul className="crm-mini-cards">{deals.map((deal) => <li key={deal.id}><button type="button" className="crm-mini-card" onClick={() => onOpen(deal.href)}><DealCard deal={deal} /><span className="crm-mini-stage">{deal.stageName}</span></button></li>)}</ul>)
      : <RecordsView entity={list.entity} book={listBook} books={books} q={q} userId={userId} canWrite={writable} listRef={list.id} onOpen={onOpen} refreshKey={refreshKey} />}
  </div>;
}

function FollowupsView({ onOpen }: { onOpen: (href: string) => void }) {
  const [items, setItems] = useState<CrmFollowup[] | null>(null);
  const load = useCallback(() => { listFollowups().then(({ followups }) => setItems(followups), () => setItems([])); }, []);
  useEffect(load, [load]);
  if (!items) return <p className="ui-panel-loading" role="status">Loading follow-ups…</p>;
  if (!items.length) return <EmptyState icon={BellRing} title="No follow-ups">Open a person, company, or deal and choose Remind me.</EmptyState>;
  return <ul className="crm-followup-list">{items.map((item) => <li key={item.id} className={isPast(item.dueAt.slice(0, 10)) ? "overdue" : undefined}>
    <button type="button" className="crm-list-row" onClick={() => onOpen(item.subject.href)}>
      <span className="crm-avatar square" aria-hidden="true">{item.subject.kind === "company" ? <Building2 /> : item.subject.kind === "deal" ? <Handshake /> : <Contact />}</span>
      <span className="crm-list-text"><strong>{item.subject.title}</strong><small>{item.note || "Follow up"}</small></span>
      <span className="crm-list-metric"><time dateTime={item.dueAt}>{dateTime(item.dueAt)}</time><small>{relative(item.dueAt)}</small></span>
    </button>
    <button type="button" className="ui-small-button secondary-button" onClick={() => void updateFollowup(item.id, { done: true }).then(load)}>Done</button>
  </li>)}</ul>;
}

function DuplicatesView({ book, onOpen }: { book: CrmBook; onOpen: (href: string) => void }) {
  const [pairs, setPairs] = useState<Awaited<ReturnType<typeof contactDuplicates>>["pairs"] | null>(null);
  const { ask, confirmElement } = useConfirm();
  const load = useCallback(() => { contactDuplicates(book.id).then(({ pairs: found }) => setPairs(found), () => setPairs([])); }, [book.id]);
  useEffect(load, [load]);
  const merge = async (from: { id: string; displayName: string }, into: { id: string; displayName: string }) => {
    if (!(await ask({ title: `Merge into ${into.displayName}?`, message: `${from.displayName}'s emails, phones, deals, notes, and lists move to ${into.displayName}, and ${from.displayName} is removed. This can't be undone.`, confirmLabel: "Merge" }))) return;
    try { await mergeContact(from.id, into.id); notify.success("Merged"); load(); } catch (reason) { notify.error(errorMessage(reason, "Could not merge")); }
  };
  if (!pairs) return <p className="ui-panel-loading" role="status">Looking for duplicates…</p>;
  return <section className="crm-duplicates" aria-label="Possible duplicates">
    <h2>Possible duplicates in {book.name}</h2>
    {pairs.length === 0 ? <EmptyState icon={Users} title="No duplicates found">People with the same name or phone show here. Emails are already unique in a book.</EmptyState>
      : <ul>{pairs.map((pair) => <li key={`${pair.a.id}-${pair.b.id}`} className="crm-dupe">
        <span className="crm-dupe-reason">{pair.reason}</span>
        {[pair.a, pair.b].map((contact, index) => <div key={contact.id} className="crm-dupe-side">
          <button type="button" className="ui-text-button" onClick={() => onOpen(contact.href)}>{contact.displayName}</button>
          <small>{[contact.email, contact.companyName, `added ${relative(contact.createdAt)}`].filter(Boolean).join(" · ")}</small>
          <button type="button" className="ui-small-button secondary-button" onClick={() => void merge(index === 0 ? pair.b : pair.a, contact)}>Keep this one</button>
        </div>)}
      </li>)}</ul>}
    {confirmElement}
  </section>;
}
