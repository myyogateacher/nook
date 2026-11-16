import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { CalendarRange, ChevronRight, Download, Eye, EyeOff, Plus, Target } from "lucide-react";
import { ModuleHome } from "../ui/ModuleHome";
import { EmptyState } from "../ui/EmptyState";
import { GoalHealthChip, ProgressBar } from "../ui/progress/Progress";
import { Select } from "../ui/Select";
import { useModuleShortcuts } from "../ui/moduleKeys";
import { errorText } from "../ui/notify";
import { relativeTime } from "../files/format";
import { goalsExportUrl, listGoals, listPeriods, type GoalDetail, type GoalSummary, type Period } from "./goalsApi";
import { GoalEditor, PeriodsSheet } from "./sheets";
import { HEALTH_TONE } from "../ui/tone";
import type { WorkspaceAppProps } from "../workspaceModules/types";
import type { Route } from "../router";
import { GOALS_SECTIONS, goalsViewOf, type GoalsView } from "./sections";
import "../ui/workspace.css";
import "./goals.css";

const GoalPage = lazy(() => import("./GoalPage"));
const GoalInsights = lazy(() => import("./GoalInsights"));

/**
 * Goals (lane GOALS, §D.3, §E): the module's app. `/goals` is the home (views Tree, List, Timeline,
 * Mine, Insights, chosen with `?view=`; the period with `?period=`), `/goals/<slug>-<shortid>` a goal.
 */

/** The home's views are the module's sections (D1280), one list with the sidebar's. */
export const VIEWS = GOALS_SECTIONS;
export type { GoalsView };

export const goalsRoute = (path: string[], search = ""): Route => ({ app: "goals", path, search }) as Route;

export default function GoalsApp(props: WorkspaceAppProps) {
  const { route } = props;
  if (route.path[0]) return <Suspense fallback={<main className="app-page" aria-busy="true" />}><GoalPage key={route.path[0]} segment={route.path[0]} {...props} /></Suspense>;
  return <GoalsHome {...props} />;
}

const params = (search: string) => new URLSearchParams(search);

function isCurrent(period: Period) {
  const today = new Date().toISOString().slice(0, 10);
  return period.startsOn <= today && today <= period.endsOn;
}

function GoalsHome({ route, navigate, onOpenPath, userId, displayName, role, flash, onHome, onSettings, onSignOut }: WorkspaceAppProps) {
  const search = params(route.search);
  const view: GoalsView = goalsViewOf(route.search);
  const canWrite = role === "admin" || role === "member";
  const [periods, setPeriods] = useState<Period[] | null>(null);
  const [period, setPeriodState] = useState<string>(search.get("period") ?? "");
  const [health, setHealth] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [query, setQuery] = useState("");
  const [goals, setGoals] = useState<GoalSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ parentId?: string } | null>(null);
  const [periodsOpen, setPeriodsOpen] = useState(false);
  const [reload, setReload] = useState(0);

  const loadPeriods = useCallback(() => listPeriods().then((body) => {
    setPeriods(body.periods);
    if (!search.get("period")) setPeriodState((current) => current || body.periods.find(isCurrent)?.id || body.periods[0]?.id || "all");
  }, () => setPeriods([])), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadPeriods(); }, [loadPeriods]);

  const setView = (next: string) => navigate(goalsRoute([], `?view=${next}${period && period !== "all" ? `&period=${period}` : ""}`));
  const setPeriod = (next: string) => { setPeriodState(next); navigate(goalsRoute([], `?view=${view}${next && next !== "all" ? `&period=${next}` : ""}`), { replace: true }); };

  const listView = view === "list" || view === "mine";
  useEffect(() => {
    if (!period || view === "insights") return;
    const controller = new AbortController();
    setError(null);
    const timer = window.setTimeout(() => {
      listGoals({ period: period === "all" ? null : period, health: health || null, closed: showClosed, q: query, mine: view === "mine", view: listView ? "list" : "tree" }, null, controller.signal)
        .then((body) => { setGoals(body.goals); setCursor(body.nextCursor); }, (reason) => { if (!controller.signal.aborted) setError(errorText(reason, "Could not load goals")); });
    }, query ? 200 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [period, health, showClosed, query, view, listView, reload]);

  const more = async () => {
    if (!cursor) return;
    const body = await listGoals({ period: period === "all" ? null : period, health: health || null, closed: showClosed, q: query, mine: view === "mine", view: "list" }, cursor);
    setGoals((current) => [...(current ?? []), ...body.goals]);
    setCursor(body.nextCursor);
  };

  const periodName = periods?.find((item) => item.id === period)?.name;
  const open = (goal: Pick<GoalSummary, "href">) => onOpenPath(goal.href);
  const created = (goal: GoalDetail) => { setCreating(null); flash(`${goal.title} created`); onOpenPath(goal.href); };

  const filters = <>
    <Select variant="chip" label="Period" value={period || "all"} onChange={setPeriod} options={[{ value: "all", label: "All periods" }, { value: "none", label: "No period" }, ...(periods ?? []).map((item) => ({ value: item.id, label: item.name, description: `${item.startsOn} – ${item.endsOn}${isCurrent(item) ? " · current" : ""}` }))]} icon={<CalendarRange aria-hidden="true" />} />
    {view !== "insights" && <Select variant="chip" label="Health" value={health} onChange={setHealth} options={[{ value: "", label: "Any health" }, { value: "on_track", label: "On track" }, { value: "at_risk", label: "At risk" }, { value: "off_track", label: "Off track" }, { value: "none", label: "No status" }]} />}
    {view !== "insights" && <button type="button" className="ui-filter-chip" aria-pressed={showClosed} onClick={() => setShowClosed((value) => !value)}>{showClosed ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}Closed</button>}
  </>;

  return <ModuleHome icon={Target} title="Goals" displayName={displayName} onHome={onHome} onSettings={onSettings} onSignOut={onSignOut}
    primary={canWrite ? { label: "New goal", icon: Plus, onClick: () => setCreating({}) } : undefined}
    menu={[{ id: "periods", label: "Periods…", icon: CalendarRange, onSelect: () => setPeriodsOpen(true) },
      // D1387: the goals this list shows (its period, health, Closed, search, and Mine), as CSV.
      { id: "export", label: "Export goals (CSV)", icon: Download, onSelect: () => { window.location.href = goalsExportUrl({ period: period === "all" ? null : period, health: health || null, closed: showClosed, q: query, mine: view === "mine" }); } }]}
    sections={{ module: "goals", role, active: view, onSelect: setView }} filters={filters}
    search={view === "insights" ? undefined : { value: query, onChange: setQuery, placeholder: "Search goals", label: "Search goals" }}>
    {error && <p className="ui-field-error" role="alert">{error} <button type="button" className="ui-text-button" onClick={() => setReload((value) => value + 1)}>Retry</button></p>}
    {view === "insights"
      ? <Suspense fallback={<p role="status">Loading insights…</p>}><GoalInsights periodName={periodName ?? null} /></Suspense>
      : goals === null || periods === null
        ? <p className="ui-panel-loading" role="status">Loading goals…</p>
        : goals.length === 0
          ? <EmptyState icon={Target} title={query ? `No goals match “${query}”` : view === "mine" ? "You have no goals here" : periodName ? `No goals in ${periodName}` : periods.length ? "No goals yet" : "Start with a period"}
            action={query ? { label: "Clear search", onClick: () => setQuery("") } : !canWrite ? undefined : periods.length === 0 ? { label: "Add a period", icon: CalendarRange, onClick: () => setPeriodsOpen(true) } : { label: "New goal", icon: Plus, onClick: () => setCreating({}) }}>
            {query ? "Try another word, or clear the search." : periods.length === 0 ? "Goals live in periods such as Q1 2027. Add one, then set the company's goals." : "Goals have key results that show how far along they are."}
          </EmptyState>
          : view === "timeline"
            ? <GoalsTimeline goals={goals} period={periods.find((item) => item.id === period) ?? null} onOpen={open} />
            : <GoalRows goals={goals} tree={!listView} onOpen={open} onAddChild={canWrite ? (parentId) => setCreating({ parentId }) : undefined} />}
    {listView && cursor && <div className="goals-more"><button type="button" className="secondary-button" onClick={() => { void more(); }}>Load more</button></div>}
    {creating && <GoalEditor me={{ id: userId, name: displayName }} defaults={{ periodId: period === "none" ? null : period && period !== "all" ? period : undefined, parentId: creating.parentId ?? null }} onClose={() => setCreating(null)} onSaved={created} />}
    {periodsOpen && <PeriodsSheet canWrite={canWrite} onClose={() => { setPeriodsOpen(false); void loadPeriods(); setReload((value) => value + 1); }} onChanged={flash} />}
  </ModuleHome>;
}

// ------------------------------------------------------------------------------------------------
// Tree and list rows.

const appClick = (href: string, onOpen: (goal: { href: string }) => void) => (event: ReactMouseEvent<HTMLAnchorElement>) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onOpen({ href });
};

const percent = (value: number) => `${Math.round(value * 100)}%`;
const progressTone = (goal: GoalSummary) => goal.health !== "none" ? HEALTH_TONE[goal.health] : goal.suggestedHealth !== "none" ? HEALTH_TONE[goal.suggestedHealth] : "accent";

export function GoalRow({ goal, depth, expanded, onToggle, active, onOpen }: {
  goal: GoalSummary; depth: number; expanded?: boolean; onToggle?: () => void; active: boolean; onOpen: (goal: { href: string }) => void;
}) {
  const closed = !["draft", "active"].includes(goal.state);
  return <div className="goals-row" data-active={active || undefined} data-goal-id={goal.id}>
    <div className="goals-row-main" style={{ paddingLeft: depth * 20 }}>
      {onToggle ? <button type="button" className="goals-toggle" aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${goal.title}`} onClick={onToggle}><ChevronRight /></button> : <span className="goals-toggle-spacer" />}
      {goal.health !== "none" && <GoalHealthChip health={goal.health} />}
      {goal.kind === "kpi" && <span className="goals-kind" title="KPI: keep a number healthy">KPI</span>}
      <a href={goal.href} onClick={appClick(goal.href, onOpen)} title={goal.title}>{goal.title}</a>
    </div>
    <div className="goals-row-meta goals-row-owner"><strong>{goal.owner.name}</strong>{goal.team ? ` · ${goal.team.name}` : ""}</div>
    <div className="goals-row-progress">
      <ProgressBar thin value={goal.progress} label={`${goal.title} progress`} tone={progressTone(goal)} target={goal.expected ?? undefined} />
      <span className="goals-pct">{percent(goal.progress)}</span>
    </div>
    <div className="goals-age goals-row-age" data-due={goal.checkinDue || undefined}>
      {closed ? goal.state.replace("_", " ") : goal.lastCheckinAt ? relativeTime(goal.lastCheckinAt) : goal.checkinDue ? "Check-in due" : `${goal.krCount} KR${goal.krCount === 1 ? "" : "s"}`}
    </div>
  </div>;
}

function GoalRows({ goals, tree, onOpen, onAddChild }: { goals: GoalSummary[]; tree: boolean; onOpen: (goal: { href: string }) => void; onAddChild?: (parentId: string) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(0);
  const byParent = useMemo(() => {
    const ids = new Set(goals.map((goal) => goal.id));
    const map = new Map<string | null, GoalSummary[]>();
    for (const goal of goals) {
      const key = tree && goal.parentId && ids.has(goal.parentId) ? goal.parentId : null;
      map.set(key, [...(map.get(key) ?? []), goal]);
    }
    return map;
  }, [goals, tree]);
  // The visible rows in order, for j/k (§E.1.4).
  const visible = useMemo(() => {
    const rows: Array<{ goal: GoalSummary; depth: number }> = [];
    const walk = (parent: string | null, depth: number) => {
      for (const goal of byParent.get(parent) ?? []) {
        rows.push({ goal, depth });
        if (tree && !collapsed.has(goal.id)) walk(goal.id, depth + 1);
      }
    };
    walk(null, 0);
    return rows;
  }, [byParent, collapsed, tree]);
  const listRef = useRef<HTMLUListElement>(null);
  useModuleShortcuts({
    j: () => setActive((index) => Math.min(visible.length - 1, index + 1)),
    k: () => setActive((index) => Math.max(0, index - 1)),
    Enter: () => { const row = visible[active]; if (row) onOpen(row.goal); else return false; },
    ArrowRight: () => { const row = visible[active]; if (!row || !tree) return false; setCollapsed((set) => { const next = new Set(set); next.delete(row.goal.id); return next; }); },
    ArrowLeft: () => { const row = visible[active]; if (!row || !tree) return false; setCollapsed((set) => new Set(set).add(row.goal.id)); }
  });
  useEffect(() => { listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" }); }, [active]);
  const activeId = visible[active]?.goal.id;

  const render = (parent: string | null, depth: number) => (byParent.get(parent) ?? []).map((goal) => {
    const children = tree ? byParent.get(goal.id) ?? [] : [];
    const open = !collapsed.has(goal.id);
    return <li key={goal.id}>
      <GoalRow goal={goal} depth={depth} active={goal.id === activeId} onOpen={onOpen}
        expanded={children.length ? open : undefined} onToggle={children.length ? () => setCollapsed((set) => { const next = new Set(set); if (next.has(goal.id)) next.delete(goal.id); else next.add(goal.id); return next; }) : undefined} />
      {tree && goal.hiddenChildCount > 0 && open && <p className="goals-hidden-note" style={{ paddingLeft: 12 + (depth + 1) * 20 }}>+ {goal.hiddenChildCount} aligned goal{goal.hiddenChildCount === 1 ? "" : "s"} you can't open</p>}
      {children.length > 0 && open && <ul className="goals-children">{render(goal.id, depth + 1)}</ul>}
    </li>;
  });
  return <>
    <ul ref={listRef} className="goals-list" aria-label={tree ? "Goal alignment tree" : "Goals"}>{render(null, 0)}</ul>
    {onAddChild && tree && activeId && <p className="goals-note goals-keys-hint" style={{ marginTop: 8 }}>
      <kbd>j</kbd>/<kbd>k</kbd> move, <kbd>Enter</kbd> opens, <kbd>←</kbd>/<kbd>→</kbd> fold. <button type="button" className="ui-text-button" onClick={() => onAddChild(activeId)}>Add a sub-goal to the selected goal</button>
    </p>}
  </>;
}

// ------------------------------------------------------------------------------------------------
// Timeline: bars by period (§D.3), on the period's range or the goals' own.

function GoalsTimeline({ goals, period, onOpen }: { goals: GoalSummary[]; period: Period | null; onOpen: (goal: { href: string }) => void }) {
  const ranged = goals.map((goal) => ({ goal, start: goal.startOn ?? goal.period?.startsOn ?? null, end: goal.dueOn ?? goal.period?.endsOn ?? null }));
  const starts = ranged.map((item) => item.start).filter((value): value is string => !!value);
  const ends = ranged.map((item) => item.end).filter((value): value is string => !!value);
  const min = period?.startsOn ?? starts.sort()[0];
  const max = period?.endsOn ?? ends.sort().at(-1);
  if (!min || !max) return <EmptyState icon={CalendarRange} title="No dates to draw">Goals in a period, or with start and due dates, show here as bars.</EmptyState>;
  const from = Date.parse(`${min}T00:00:00Z`);
  const to = Date.parse(`${max}T00:00:00Z`) + 86_400_000;
  const at = (date: string) => Math.min(100, Math.max(0, ((Date.parse(`${date}T00:00:00Z`) - from) / (to - from)) * 100));
  const today = at(new Date().toISOString().slice(0, 10));
  return <div className="goals-timeline" role="list" aria-label="Goals on a timeline">
    <div className="goals-timeline-scale" aria-hidden="true"><span>{min}</span><span>{max}</span></div>
    {ranged.map(({ goal, start, end }) => {
      const left = start ? at(start) : 0;
      const right = end ? at(end) : 100;
      return <div key={goal.id} className="goals-timeline-row" role="listitem">
        <a href={goal.href} onClick={appClick(goal.href, onOpen)}>{goal.title}</a>
        <div className="goals-timeline-track">
          <div className="goals-timeline-bar" data-tone={progressTone(goal)} style={{ left: `${left}%`, width: `${Math.max(2, right - left)}%` }} title={`${start ?? "?"} – ${end ?? "?"} · ${percent(goal.progress)}`}>
            <span className="goals-timeline-fill" style={{ width: percent(Math.min(1, goal.progress)) }} />
          </div>
          {today > 0 && today < 100 && <span className="goals-timeline-today" style={{ left: `${today}%` }} aria-hidden="true" />}
          <span className="ui-visually-hidden">{`${percent(goal.progress)}, ${start ?? "no start"} to ${end ?? "no end"}`}</span>
        </div>
      </div>;
    })}
  </div>;
}
