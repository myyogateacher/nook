import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BarChart3, CalendarClock, ClipboardList, Copy, Eye, FilePlus2, Pencil, Share2, Trash2, Vote } from "lucide-react";
import { ApiError } from "../api";
import { ModuleHome, type ModulePrimaryAction } from "../ui/ModuleHome";
import { formatWorkspaceRoute } from "../workspaceModules/registry";
import { FORMS_SECTIONS, type FormsSection } from "./sections";
import { EmptyState } from "../ui/EmptyState";
import { useModuleShortcuts } from "../ui/moduleKeys";
import { notify } from "../ui/notify";
import { useConfirm } from "../ui/useConfirm";
import { relativeTime } from "../files/format";
import type { Route } from "../router";
import type { WorkspaceAppProps } from "../workspaceModules/types";
import { shortIdOfSegment } from "../../shared/friendlyUrls";
import type { FormDetail, FormKind, FormListItem } from "../../shared/forms";
import { binForm, duplicateForm, formCounts, getForm, listForms, type FormsTab } from "./formsApi";
import { KindIcon, NewFormSheet, NewPollSheet, NewTimePollSheet } from "./NewSheets";
import "./forms.css";

const FormEditor = lazy(() => import("./FormEditor"));
const FormResults = lazy(() => import("./FormResults"));
const FormRespond = lazy(() => import("./FormRespond"));
const FormActivity = lazy(() => import("./FormActivity"));
const FormsInsights = lazy(() => import("./FormsInsights"));

/**
 * The Forms app (§D.1 UI): the home (My forms, Shared with me, To answer, Insights) and one page per
 * form: respond (or vote), edit, results. Each page is a route (`/forms/<slug>-<shortid>[/edit|/results]`),
 * so Back works and links share; a stale slug is corrected in place (D773).
 */

export type FormsNav = {
  go: (path: string[], search?: string, replace?: boolean) => void;
  props: WorkspaceAppProps;
};

// The home's tabs are the module's sections (D1280), one list with the sidebar's.
const TAB_IDS: readonly string[] = FORMS_SECTIONS.map((section) => section.id);
type HomeTab = FormsSection;
const segmentOf = (href: string) => href.split("/")[2] ?? "";

export default function FormsApp(props: WorkspaceAppProps) {
  const { route, navigate } = props;
  const go = useCallback((path: string[], search = "", replace = false) => navigate({ app: "forms", path, search } as Route, { replace }), [navigate]);
  const nav = useMemo(() => ({ go, props }), [go, props]);
  const [first, second] = route.path;
  const fallback = <div className="forms-loading" role="status">Loading…</div>;
  if (!first || (TAB_IDS as readonly string[]).includes(first)) return <FormsHome nav={nav} tab={(first as HomeTab | undefined) ?? "mine"} search={route.search} />;
  return <Suspense fallback={fallback}>
    {second === "edit" ? <FormEditor nav={nav} formRef={first} /> : second === "activity" ? <FormActivity nav={nav} formRef={first} /> : second === "results" ? <FormResults nav={nav} formRef={first} search={route.search} /> : <FormRespond nav={nav} formRef={first} />}
  </Suspense>;
}

// ---------------------------------------------------------------- the frame of a form's pages

export type FrameView = "respond" | "edit" | "results" | "activity";

/** A form's page frame: the module home scaffold with the form's title and its views as tabs (Activity for anyone with a level, D1375). */
export function FormFrame({ nav, form, view, primary, menuExtra = [], children, detail, title }: {
  nav: FormsNav;
  form: Pick<FormDetail, "id" | "title" | "kind" | "href" | "level"> | null;
  view: FrameView;
  primary?: ModulePrimaryAction;
  menuExtra?: Array<{ id: string; label: string; icon?: typeof Share2; onSelect: () => void; danger?: boolean }>;
  children: ReactNode;
  detail?: ReactNode;
  title?: string;
}) {
  const { props, go } = nav;
  const { ask, confirmElement } = useConfirm();
  const segment = form ? segmentOf(form.href) : "";
  const reader = form?.level !== null && form?.level !== undefined;
  const editor = form?.level === "owner" || form?.level === "manage" || form?.level === "edit";
  const tabs = form && reader ? [
    { id: "respond", label: form.kind === "form" ? "Respond" : "Vote" },
    ...(editor ? [{ id: "edit", label: "Edit" }] : []),
    { id: "results", label: "Results" },
    { id: "activity", label: "Activity" }
  ] : undefined;
  const menu = form ? [
    { id: "all", label: "All forms", icon: ClipboardList, onSelect: () => go([]) },
    ...menuExtra,
    ...(editor ? [{ id: "duplicate", label: "Duplicate", icon: Copy, onSelect: () => { void duplicateForm(form.id).then(({ form: copy }) => { notify.success("Copied"); go([segmentOf(copy.href), "edit"]); }).catch((error) => notify.error(error instanceof ApiError ? error.message : "Could not duplicate")); } }] : []),
    ...(form.level === "owner" || form.level === "manage" ? [{ id: "delete", label: "Move to Bin", icon: Trash2, danger: true, onSelect: () => {
      void ask({ title: `Move “${form.title}” to the Bin?`, message: "Its responses go with it. You can restore it from the Bin for 30 days.", confirmLabel: "Move to Bin", danger: true }).then(async (ok) => {
        if (!ok) return;
        try { await binForm(form.id); notify.success("Moved to the Bin"); go([]); } catch (error) { notify.error(error instanceof ApiError ? error.message : "Could not delete"); }
      });
    } }] : [])
  ] : [{ id: "all", label: "All forms", icon: ClipboardList, onSelect: () => go([]) }];
  return <ModuleHome icon={form?.kind === "poll" ? Vote : form?.kind === "time_poll" ? CalendarClock : ClipboardList} title="Forms" heading={title ?? form?.title ?? "Form"}
    displayName={props.displayName} onHome={props.onHome} onSettings={props.onSettings} onSignOut={props.onSignOut}
    primary={primary} menu={menu} tabs={tabs} activeTab={view} onTab={(id) => go(id === "respond" ? [segment] : [segment, id])} detail={detail} className="forms-page"
    parent={{ label: "Forms", href: formatWorkspaceRoute({ app: "forms", path: [], search: "" }), onClick: () => go([]) }}>
    {children}
    {confirmElement}
  </ModuleHome>;
}

/** Loads a form's detail for readers; respondents (no level) get null and use the respond view. */
export function useFormDetail(ref: string, nav: FormsNav, view: FrameView) {
  const [form, setForm] = useState<FormDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const reload = useCallback(async () => {
    try {
      const { form: loaded } = await getForm(ref);
      setForm(loaded);
      setState("ready");
      // A stale or missing slug is corrected in place (D773).
      const segment = segmentOf(loaded.href);
      if (segment !== ref) nav.go(view === "respond" ? [segment] : [segment, view], nav.props.route.search, true);
    } catch (error) {
      setState(error instanceof ApiError && error.status === 404 ? "missing" : "ready");
    }
  }, [ref]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [reload]);
  return { form, setForm, state, reload };
}

export function MissingForm({ nav }: { nav: FormsNav }) {
  return <FormFrame nav={nav} form={null} view="respond" title="Form not found">
    <EmptyState icon={ClipboardList} title="This form is not available" action={{ label: "All forms", onClick: () => nav.go([]) }}>It may have been deleted, or it is not shared with you.</EmptyState>
  </FormFrame>;
}

// ---------------------------------------------------------------- home

const KIND_FILTERS: Array<{ id: FormKind | null; label: string }> = [{ id: null, label: "All" }, { id: "form", label: "Forms" }, { id: "poll", label: "Polls" }, { id: "time_poll", label: "Find a time" }];

function Spark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  return <span className="forms-spark" role="img" aria-label={`${total} in the last 14 days`}>{values.map((value, index) => <span key={index} style={{ height: `${Math.max(2, (value / max) * 18)}px` }} className={value ? "on" : ""} />)}</span>;
}

function StatusChip({ item }: { item: FormListItem }) {
  const tone = item.status === "draft" ? "warning" : item.accepting ? "success" : "neutral";
  const label = item.status === "draft" ? "Draft" : item.accepting ? "Open" : "Closed";
  return <span className="ui-health ui-tone" data-tone={tone}><span className="forms-dot" aria-hidden="true" />{label}</span>;
}

function FormRow({ item, active, onOpen, tab }: { item: FormListItem; active: boolean; onOpen: () => void; tab: HomeTab }) {
  const kindLabel = item.kind === "poll" ? "Poll" : item.kind === "time_poll" ? "Find a time" : "Form";
  return <li className={`forms-row${active ? " active" : ""}`}>
    <button type="button" className="forms-row-main" onClick={onOpen} aria-current={active ? "true" : undefined}>
      <span className={`forms-kind ${item.kind}`} title={kindLabel}><KindIcon kind={item.kind} /></span>
      <span className="forms-row-title"><strong>{item.title}</strong>
        <small>{kindLabel}{tab !== "mine" ? ` · ${item.owner.name}` : ""}{tab === "answer" && item.closesAt ? ` · closes ${relativeTime(item.closesAt)}` : ""}{item.responded ? " · you responded" : ""}</small>
      </span>
      <StatusChip item={item} />
      {item.spark ? <span className="forms-row-count"><span className="ui-tabular">{item.responseCount}</span><small>{item.kind === "form" ? (item.responseCount === 1 ? "response" : "responses") : item.responseCount === 1 ? "vote" : "votes"}</small></span> : <span className="forms-row-count" />}
      {item.spark ? <Spark values={item.spark} /> : <span className="forms-spark-gap" />}
      <span className="forms-row-when">{item.lastResponseAt ? relativeTime(item.lastResponseAt) : item.status === "draft" ? `edited ${relativeTime(item.updatedAt)}` : "—"}</span>
    </button>
  </li>;
}

function FormsHome({ nav, tab, search }: { nav: FormsNav; tab: HomeTab; search: string }) {
  const { props, go } = nav;
  const readOnly = props.role === "guest" || props.role === "viewer";
  const params = new URLSearchParams(search);
  const [sheet, setSheet] = useState<"form" | "poll" | "time_poll" | null>(() => { const value = params.get("new"); return !readOnly && (value === "form" || value === "poll" || value === "time_poll") ? value : null; });
  const [kind, setKind] = useState<FormKind | null>(null);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<FormListItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [counts, setCounts] = useState<{ mine: number; answer: number } | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLOListElement>(null);
  const apiTab: FormsTab = tab === "insights" ? "mine" : tab;

  useEffect(() => { if (params.get("new")) go(tab === "mine" ? [] : [tab], "", true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { formCounts().then(setCounts).catch(() => undefined); }, [tab]);
  useEffect(() => {
    if (tab === "insights") return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      listForms({ tab: apiTab, kind, q }, controller.signal).then((page) => { setItems(page.items); setCursor(page.nextCursor); setActive(0); }).catch((error) => { if (!controller.signal.aborted) { setItems([]); notify.error(error instanceof ApiError ? error.message : "Could not load forms"); } });
    }, q ? 180 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [apiTab, kind, q, tab]);

  const open = (item: FormListItem) => {
    const segment = segmentOf(item.href);
    if (item.level && item.kind === "form" && item.status !== "draft" && tab !== "answer") go([segment, "results"]);
    else if (item.level && item.status === "draft" && ["owner", "manage", "edit"].includes(item.level)) go([segment, "edit"]);
    else go([segment]);
  };
  useModuleShortcuts({
    j: () => { if (items?.length) { setActive((value) => Math.min(items.length - 1, value + 1)); } },
    k: () => { if (items?.length) setActive((value) => Math.max(0, value - 1)); },
    Enter: () => { const item = items?.[active]; if (item) open(item); }
  }, tab !== "insights" && sheet === null);
  useEffect(() => { listRef.current?.querySelectorAll<HTMLElement>(".forms-row")[active]?.scrollIntoView({ block: "nearest" }); }, [active]);

  const created = (form: FormDetail) => {
    setSheet(null);
    const segment = segmentOf(form.href);
    go(form.kind === "form" ? [segment, "edit"] : [segment]);
  };
  const primary: ModulePrimaryAction | undefined = readOnly ? undefined : { label: "New form", icon: FilePlus2, onClick: () => setSheet("form") };
  const empty = (() => {
    if (q || kind) return <EmptyState icon={ClipboardList} title="Nothing matches" action={{ label: "Clear filters", onClick: () => { setQ(""); setKind(null); } }}>Try another word or kind.</EmptyState>;
    if (tab === "shared") return <EmptyState icon={Share2} title="Nothing shared with you yet">Forms whose results others share with you show here.</EmptyState>;
    if (tab === "answer") return <EmptyState icon={Vote} title="You are all caught up">Polls and forms waiting for your answer show here.</EmptyState>;
    return <EmptyState icon={ClipboardList} title="No forms yet" action={readOnly ? undefined : { label: "New form", icon: FilePlus2, onClick: () => setSheet("form") }}>Collect answers with a form, a quick poll, or find a time that works for everyone.</EmptyState>;
  })();
  return <ModuleHome icon={ClipboardList} title="Forms" displayName={props.displayName} onHome={props.onHome} onSettings={props.onSettings} onSignOut={props.onSignOut}
    primary={primary}
    menu={readOnly ? [] : [
      { id: "poll", label: "New poll", icon: Vote, onSelect: () => setSheet("poll") },
      { id: "time", label: "Find a time", icon: CalendarClock, onSelect: () => setSheet("time_poll") },
      { id: "template", label: "From a template", icon: Copy, onSelect: () => setSheet("form") }
    ]}
    sections={{ module: "forms", role: props.role, active: tab, onSelect: (id) => go(id === "mine" ? [] : [id]), counts: { ...(counts ? { mine: counts.mine } : {}), ...(counts?.answer ? { answer: counts.answer } : {}) } }}
    filters={tab === "insights" ? undefined : <div className="forms-filter-chips" role="group" aria-label="Kind">{KIND_FILTERS.map((filter) => <button key={filter.label} type="button" className="ui-filter-chip" aria-pressed={kind === filter.id} onClick={() => setKind(filter.id)}>{filter.label}</button>)}</div>}
    search={tab === "insights" ? undefined : { value: q, onChange: setQ, placeholder: "Search forms", label: "Search forms" }}>
    {tab === "insights" ? <Suspense fallback={<p className="ui-panel-loading">Loading…</p>}><FormsInsights nav={nav} /></Suspense>
      : items === null ? <p className="ui-panel-loading" role="status">Loading…</p>
        : items.length === 0 ? empty
          : <>
            <div className="forms-list-head" aria-hidden="true"><span>Name</span><span>Status</span><span>Responses</span><span>Last 14 days</span><span>Last</span></div>
            <ol ref={listRef} className="forms-list" aria-label={tab === "answer" ? "Forms to answer" : "Forms"}>
              {items.map((item, index) => <FormRow key={item.id} item={item} tab={tab} active={index === active} onOpen={() => open(item)} />)}
            </ol>
            {cursor && <button type="button" className="secondary-button forms-more" disabled={loadingMore} onClick={() => {
              setLoadingMore(true);
              listForms({ tab: apiTab, kind, q, cursor }).then((page) => { setItems([...items, ...page.items]); setCursor(page.nextCursor); }).finally(() => setLoadingMore(false));
            }}>{loadingMore ? "Loading…" : "Show more"}</button>}
          </>}
    {sheet === "form" && <NewFormSheet onClose={() => setSheet(null)} onCreated={created} />}
    {sheet === "poll" && <NewPollSheet onClose={() => setSheet(null)} onCreated={created} />}
    {sheet === "time_poll" && <NewTimePollSheet onClose={() => setSheet(null)} onCreated={created} />}
  </ModuleHome>;
}

export const formIcons = { BarChart3, Eye, Pencil };
export const shortRef = (ref: string) => shortIdOfSegment(ref) ?? ref;
