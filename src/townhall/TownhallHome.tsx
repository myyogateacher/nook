import { useEffect, useState } from "react";
import { ChevronRight, MessageCircleQuestion, Plus, Presentation } from "lucide-react";
import { ModuleHome } from "../ui/ModuleHome";
import { EmptyState } from "../ui/EmptyState";
import { InsightChart, KpiRow, KpiTile } from "../ui/insights/Insights";
import { errorText, notify } from "../ui/notify";
import type { WorkspaceAppProps } from "../workspaceModules/types";
import type { TownhallSessionSummary, TownhallState } from "../../shared/townhall";
import * as townhall from "./api";
import { SessionSheet } from "./Sheets";
import { formatWhen, StateChip } from "./common";

type Filter = TownhallState | "all";

/** Townhall's home: sessions (live first) and Insights (§D.7 Townhall, §E.2). */
export function TownhallHome(props: WorkspaceAppProps & { tab: "sessions" | "insights" }) {
  const { navigate, role } = props;
  const canCreate = role === "admin" || role === "member";
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<TownhallSessionSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(() => canCreate && new URLSearchParams(props.route.search).has("new"));
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      townhall.listSessions(filter, query.trim()).then((body) => { if (live) { setItems(body.items); setCursor(body.nextCursor); } }, (reason) => { if (live) { setItems([]); notify.error(errorText(reason, "Could not load townhalls")); } });
    }, query ? 200 : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [filter, query]);
  const open = (href: string) => navigate({ app: "townhall", path: [href.split("/").pop()!], search: "" } as never);
  const more = async () => {
    if (!cursor) return;
    const body = await townhall.listSessions(filter, query.trim(), cursor);
    setItems([...(items ?? []), ...body.items]);
    setCursor(body.nextCursor);
  };

  return <ModuleHome icon={Presentation} title="Townhall" displayName={props.displayName} onHome={props.onHome} onSettings={props.onSettings} onSignOut={props.onSignOut}
    className="th-home"
    primary={canCreate ? { label: "New townhall", icon: Plus, onClick: () => setCreating(true) } : undefined}
    sections={{ module: "townhall", role: props.role, active: props.tab, onSelect: (id) => navigate({ app: "townhall", path: id === "insights" ? ["insights"] : [], search: "" } as never) }}
    filters={props.tab === "sessions" ? <div className="th-chips" role="group" aria-label="Show sessions">
      {(["all", "live", "upcoming", "ended"] as const).map((value) => <button key={value} type="button" className="ui-filter-chip" aria-pressed={filter === value} onClick={() => setFilter(value)}>{{ all: "All", live: "Live", upcoming: "Upcoming", ended: "Past" }[value]}</button>)}
    </div> : undefined}
    search={props.tab === "sessions" ? { value: query, onChange: setQuery, placeholder: "Find a townhall", label: "Find a townhall" } : undefined}>
    {props.tab === "insights" ? <Insights /> : items === null
      ? <p className="ui-panel-loading" role="status">Loading townhalls…</p>
      : items.length === 0
        ? <EmptyState icon={Presentation} title={query || filter !== "all" ? "No townhalls match" : "No townhalls yet"} action={canCreate && !query && filter === "all" ? { label: "New townhall", icon: Plus, onClick: () => setCreating(true) } : undefined}>
          {query || filter !== "all" ? "Try another filter." : "Run an all-hands or AMA: people ask and upvote before and during it, and you run live polls."}
        </EmptyState>
        : <>
          <ul className="th-list" aria-label="Townhalls">
            {items.map((item) => <li key={item.id}>
              <button type="button" className="th-row" onClick={() => open(item.href)}>
                <span className="th-row-main">
                  <strong>{item.title}</strong>
                  <small>{[item.startsAt ? formatWhen(item.startsAt) : "No date", `Hosted by ${item.ownerName}`].join(" · ")}</small>
                </span>
                <StateChip state={item.state} />
                <span className="th-row-count" aria-label={`${item.questionCount} questions`}><MessageCircleQuestion aria-hidden="true" /><span className="ui-tabular">{item.questionCount}</span></span>
                <ChevronRight className="th-row-chevron" aria-hidden="true" />
              </button>
            </li>)}
          </ul>
          {cursor && <button type="button" className="secondary-button th-more" onClick={() => { void more(); }}>Show more</button>}
        </>}
    {creating && <SessionSheet onClose={() => setCreating(false)} onSaved={(session) => open(session.href)} />}
  </ModuleHome>;
}

/** Insights (§B.10): preset dataset queries over the sessions the viewer can open. */
function Insights() {
  const [data, setData] = useState<{ total: number; answered: number; anonymous: number; attendance: number; weeks: Array<[string, number]>; sessions: Array<[string, number]> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const count = (filters: Array<Record<string, unknown>> = []) => townhall.queryDataset({ dataset: "townhall.questions", measures: [{ fn: "count" }], filters, timeRange: { from: since } }).then((body) => Number(body.rows[0]?.[0] ?? 0));
    Promise.all([
      count(), count([{ column: "status", op: "eq", value: "answered" }]), count([{ column: "anonymous", op: "eq", value: true }]),
      townhall.queryDataset({ dataset: "townhall.attendance", measures: [{ fn: "count" }], timeRange: { from: since } }).then((body) => Number(body.rows[0]?.[0] ?? 0)),
      townhall.queryDataset({ dataset: "townhall.questions", measures: [{ fn: "count" }], timeRange: { from: since }, timeBucket: "week", tz, sort: [{ column: "bucket", dir: "asc" }] }),
      townhall.queryDataset({ dataset: "townhall.questions", measures: [{ fn: "count", as: "questions" }], dimensions: ["session"], timeRange: { from: since }, sort: [{ column: "questions", dir: "desc" }], limit: 8 })
    ]).then(([total, answered, anonymous, attendance, weeks, sessions]) => setData({
      total, answered, anonymous, attendance,
      weeks: weeks.rows.map((row) => [String(row[0]).slice(0, 10), Number(row[1])]),
      sessions: sessions.rows.map((row) => [String(row[0]), Number(row[1])])
    }), (reason) => setError(errorText(reason, "Could not load Insights")));
  }, []);
  if (error) return <EmptyState icon={Presentation} title="Insights are not available">{error}</EmptyState>;
  if (!data) return <p className="ui-panel-loading" role="status">Loading Insights…</p>;
  if (!data.total && !data.attendance) return <EmptyState icon={Presentation} title="Nothing to show yet">Insights appear once people ask questions in your townhalls.</EmptyState>;
  return <div className="ui-insights th-insights">
    <p className="th-hint">The last 90 days, in sessions you can open.</p>
    <KpiRow>
      <KpiTile label="Questions" value={data.total} />
      <KpiTile label="Answered" value={data.total ? data.answered / data.total : null} unit="percent" hint={`${data.answered} of ${data.total}`} />
      <KpiTile label="Asked anonymously" value={data.total ? data.anonymous / data.total : null} unit="percent" />
      <KpiTile label="People who joined" value={data.attendance} />
    </KpiRow>
    {data.weeks.length > 0 && <InsightChart title="Questions per week" kind="bar" categories={data.weeks.map(([week]) => week)} series={[{ name: "Questions", values: data.weeks.map(([, value]) => value) }]} />}
    {data.sessions.length > 0 && <InsightChart title="Questions by session" kind="bar" categories={data.sessions.map(([name]) => name)} series={[{ name: "Questions", values: data.sessions.map(([, value]) => value) }]} />}
  </div>;
}
