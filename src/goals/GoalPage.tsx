import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { MentionText } from "../ui/mentions/Mentions";
import { ArrowLeft, CheckSquare, CircleCheck, GitBranch, Link2, ListChecks, Lock, MessageSquareText, Pencil, Plus, RotateCcw, Share2, Square, Target, Trash2, TrendingUp, Zap } from "lucide-react";
import { PageHeader } from "../shell/PageHeader";
import { ReadOnlyBanner } from "../team/roleAccess";
import { EmptyState } from "../ui/EmptyState";
import { MoreMenu } from "../ui/MoreMenu";
import { GoalHealthChip, HealthChip, ProgressBar, ProgressRing } from "../ui/progress/Progress";
import { InsightChart } from "../ui/insights/Insights";
import { ItemTimeline } from "../ui/activity/ItemTimeline";
import { ItemSectionsOutlet } from "../ui/ItemSlotOutlet";
import { LinkPicker, WorkRefChip } from "../ui/links/WorkLinks";
import { useModuleShortcuts } from "../ui/moduleKeys";
import { errorText } from "../ui/notify";
import { createLink, deleteLink } from "../ui/workspaceApi";
import { HEALTH_LABEL, HEALTH_TONE } from "../ui/tone";
import { relativeTime } from "../files/format";
import { binGoal, deleteKeyResult, getGoal, goalHistory, goalWork, listCheckins, reopenGoal, undo, type Checkin, type GoalDetail, type GoalHistory, type GoalSummary, type KeyResult } from "./goalsApi";
import { CheckInSheet, CloseSheet, GoalEditor, KrEditor } from "./sheets";
import { KrSparkline } from "./KrSparkline";
import { goalActivityRenderers } from "./activity";
import { goalsRoute } from "./GoalsApp";
import { CADENCE_LABEL, formatKrValue, GOAL_STATE_LABEL, KR_DIRECTION_LABEL } from "../../shared/goals";
import type { WorkLinkView } from "../../shared/workRefs";
import type { WorkspaceAppProps } from "../workspaceModules/types";
import "../ui/workspace.css";

const AccessSheet = lazy(() => import("../access/AccessSheet").then((module) => ({ default: module.AccessSheet })));
import "./goals.css";

/**
 * The goal page (§D.3 UI, §E.4): header (title, health, period, owner, ring, Check in), a fields column
 * and the main column (key results with their sources, progress chart, sub-goals, linked work,
 * check-ins, comments and activity). Keys: `c` check in, `e` edit, `k` add a key result, Esc back.
 */

const percent = (value: number) => `${Math.round(value * 100)}%`;

const appClick = (href: string, open: (href: string) => void) => (event: ReactMouseEvent<HTMLAnchorElement>) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  open(href);
};

export default function GoalPage({ segment, navigate, onOpenPath, userId, displayName, flash, onSettings, onSignOut }: WorkspaceAppProps & { segment: string }) {
  const [goal, setGoal] = useState<GoalDetail | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [history, setHistory] = useState<GoalHistory | null>(null);
  const [checkins, setCheckins] = useState<Checkin[] | null>(null);
  const [work, setWork] = useState<WorkLinkView[] | null>(null);
  const [sheet, setSheet] = useState<null | { kind: "checkin" } | { kind: "edit" } | { kind: "kr"; kr?: KeyResult } | { kind: "close" } | { kind: "link" } | { kind: "child" } | { kind: "access" }>(null);
  const [refresh, setRefresh] = useState(0);
  const shortId = segment.split("-").pop() ?? segment;

  const load = useCallback(() => {
    getGoal(shortId).then((body) => {
      setGoal(body.goal);
      // A stale or missing slug is corrected in place (friendly URLs, D773).
      const path = body.goal.href;
      if (window.location.pathname !== path) window.history.replaceState(window.history.state, "", `${path}${window.location.search}`);
      goalHistory(body.goal.id).then(setHistory, () => setHistory(null));
      listCheckins(body.goal.id).then((list) => setCheckins(list.checkins), () => setCheckins([]));
      goalWork(body.goal.id).then((list) => setWork(list.links.filter((link) => link.relation !== "mentions")), () => setWork([]));
    }, (reason) => setMissing(errorText(reason, "Goal not found")));
  }, [shortId]);
  useEffect(load, [load, refresh]);
  const reload = () => setRefresh((value) => value + 1);

  const back = () => navigate(goalsRoute([], goal?.period ? `?period=${goal.period.id}` : ""));
  useModuleShortcuts({
    c: goal?.canEdit && !closed(goal) ? () => setSheet({ kind: "checkin" }) : undefined,
    e: goal?.canEdit ? () => setSheet({ kind: "edit" }) : undefined,
    k: goal?.canEdit ? () => setSheet({ kind: "kr" }) : undefined,
    Escape: () => back()
  }, sheet === null);

  const removeKr = async (kr: KeyResult) => {
    try {
      const { undoTicket } = await deleteKeyResult(kr.id);
      reload();
      // The undo is offered in place for 10 seconds (D813).
      setUndoTicket({ ticket: undoTicket, label: kr.title });
    } catch (reason) { flash(errorText(reason, "Could not remove the key result")); }
  };
  const [undoTicket, setUndoTicket] = useState<{ ticket: string; label: string } | null>(null);
  useEffect(() => { if (!undoTicket) return; const timer = window.setTimeout(() => setUndoTicket(null), 10_000); return () => window.clearTimeout(timer); }, [undoTicket]);

  if (missing) return <main className="app-page"><div className="goals-page">
    <button type="button" className="secondary-button goals-back" onClick={back}><ArrowLeft aria-hidden="true" />Goals</button>
    <EmptyState icon={Target} title="This goal isn't available" action={{ label: "Back to goals", onClick: back }}>It may have been moved to the Bin, or you may not have access to it.</EmptyState>
  </div></main>;
  if (!goal) return <main className="app-page" aria-busy="true"><p className="ui-visually-hidden" role="status">Loading goal…</p></main>;

  const isClosed = closed(goal);
  const tone = goal.health !== "none" ? HEALTH_TONE[goal.health] : "accent";
  const menu = [
    ...(goal.canEdit ? [{ id: "edit", label: "Edit goal", icon: Pencil, onSelect: () => setSheet({ kind: "edit" }) }] : []),
    ...(goal.canEdit && !isClosed ? [{ id: "close", label: "Close goal…", icon: CircleCheck, onSelect: () => setSheet({ kind: "close" }) }] : []),
    ...(goal.canEdit && isClosed ? [{ id: "reopen", label: "Reopen", icon: RotateCcw, onSelect: () => { reopenGoal(goal.id).then((body) => { setGoal(body.goal); flash("Goal reopened"); }, (reason) => flash(errorText(reason, "Could not reopen"))); } }] : []),
    ...(goal.canEdit ? [{ id: "child", label: "Add a sub-goal", icon: GitBranch, onSelect: () => setSheet({ kind: "child" }) }] : []),
    // Sharing is the shared Access sheet over /api/access/goal/:id (D1050; it replaced the editor's presets, D917).
    ...(goal.canManage ? [{ id: "access", label: "Who has access…", icon: Share2, onSelect: () => setSheet({ kind: "access" }) }] : []),
    ...(goal.canManage ? [{ id: "bin", label: "Move to Bin", icon: Trash2, danger: true, onSelect: () => { binGoal(goal.id).then(() => { flash(`${goal.title} moved to the Bin`); back(); }, (reason) => flash(errorText(reason, "Could not move it to the Bin"))); } }] : [])
  ];

  return <main className="app-page">
    {/* D1283: the goal's title is its page's h1 beside its ring; the header holds Back alone. */}
    <PageHeader back={{ label: "Goals", onClick: back }} />
    <ReadOnlyBanner />
    <div className="goals-page">
      <div className="goals-head">
        <ProgressRing value={goal.progress} label={`${goal.title} progress`} size={64} stroke={6} tone={tone} large />
        <div>
          <h1 tabIndex={-1}>{goal.title}</h1>
          <div className="goals-head-meta">
            <GoalHealthChip health={goal.health} />
            {isClosed && <HealthChip tone={goal.state === "achieved" ? "success" : goal.state === "carried_over" ? "info" : "neutral"} label={GOAL_STATE_LABEL[goal.state]} />}
            {goal.state === "draft" && <HealthChip tone="neutral" label="Draft" />}
            {goal.kind === "kpi" && <span className="goals-kind">KPI</span>}
            <span>{goal.period ? goal.period.name : "No period"}{goal.dueOn ? ` · due ${goal.dueOn}` : ""}</span>
            <span>Owner <strong style={{ color: "#dedee1" }}>{goal.owner.name}</strong></span>
            {goal.visibility !== "all_users" && <span><Lock aria-hidden="true" style={{ width: 12, height: 12, verticalAlign: -1 }} /> Private</span>}
          </div>
        </div>
        <div className="goals-head-actions">
          {goal.canEdit && !isClosed && <button type="button" className="action-button" onClick={() => setSheet({ kind: "checkin" })} aria-keyshortcuts="c"><TrendingUp aria-hidden="true" />Check in</button>}
          {menu.length > 0 && <MoreMenu label="More goal actions" items={menu} />}
        </div>
      </div>
      {goal.includesHidden && <p className="goals-note" data-tone="warning" style={{ marginTop: 10 }}>Progress includes {goal.hiddenChildCount} aligned goal{goal.hiddenChildCount === 1 ? "" : "s"} you can't open.</p>}
      {undoTicket && <p className="goals-note" role="status" style={{ marginTop: 10 }}>Removed {undoTicket.label}. <button type="button" className="ui-text-button" onClick={() => { undo(undoTicket.ticket).then(() => { setUndoTicket(null); reload(); flash("Key result restored"); }, (reason) => flash(errorText(reason, "Could not undo"))); }}>Undo</button></p>}
      <div className="goals-layout">
        <dl className="goals-side" aria-label="Details">
          <Field label="Progress">{percent(goal.progress)}{goal.expected !== null ? ` · ${percent(goal.expected)} of time gone` : ""}</Field>
          <Field label="Suggested">{goal.suggestedHealth === "none" ? "—" : HEALTH_LABEL[goal.suggestedHealth]}</Field>
          <Field label="Team">{goal.team?.name ?? "—"}</Field>
          <Field label="Contributors">{goal.contributors.length ? goal.contributors.map((person) => person.name).join(", ") : "—"}</Field>
          <Field label="Dates">{goal.startOn ?? goal.period?.startsOn ?? "—"} → {goal.dueOn ?? goal.period?.endsOn ?? "—"}</Field>
          <Field label="Aligned to">{goal.parent ? <a href={goal.parent.href} onClick={appClick(goal.parent.href, onOpenPath)}>{goal.parent.title}</a> : goal.alignedToHidden ? "A goal you can't open" : "Top level"}</Field>
          <Field label="Progress from">{goal.progressMode === "key_results" ? "Key results" : goal.progressMode === "children" ? "Sub-goals" : "Set by hand"}</Field>
          <Field label="Check-ins">{CADENCE_LABEL[goal.cadence]}{goal.lastCheckinAt ? ` · last ${relativeTime(goal.lastCheckinAt)}` : ""}{goal.checkinDue ? " · due" : ""}</Field>
          {goal.lastCheckin?.confidence && <Field label="Confidence">{goal.lastCheckin.confidence}/10</Field>}
        </dl>
        <div className="goals-main">
          {goal.description && <section className="goals-panel" aria-label="Description"><p className="goals-description">{goal.description}</p></section>}
          <section className="goals-panel" aria-labelledby="goal-krs">
            <header><h2 id="goal-krs"><ListChecks aria-hidden="true" />Key results</h2>{goal.canEdit && <button type="button" className="secondary-button ui-small-button" onClick={() => setSheet({ kind: "kr" })} aria-keyshortcuts="k"><Plus aria-hidden="true" />Add key result</button>}</header>
            {goal.keyResults.length === 0
              ? <EmptyState compact as="h3" icon={ListChecks} title="No key results yet" action={goal.canEdit ? { label: "Add key result", icon: Plus, onClick: () => setSheet({ kind: "kr" }) } : undefined}>Key results say how you'll know it's done; they can update themselves from Tasks.</EmptyState>
              : <ul className="goals-kr-list">{goal.keyResults.map((kr) => <KrRow key={kr.id} kr={kr} points={history?.keyResults.find((item) => item.id === kr.id)?.points} canEdit={goal.canEdit} onEdit={() => setSheet({ kind: "kr", kr })} onRemove={() => { void removeKr(kr); }} />)}</ul>}
          </section>
          {history && <ProgressChart goal={goal} history={history} />}
          <section className="goals-panel" aria-labelledby="goal-children">
            <header><h2 id="goal-children"><GitBranch aria-hidden="true" />Aligned goals</h2>{goal.canEdit && <button type="button" className="secondary-button ui-small-button" onClick={() => setSheet({ kind: "child" })}><Plus aria-hidden="true" />Add sub-goal</button>}</header>
            {goal.children.length === 0 && goal.hiddenChildCount === 0 ? <p className="goals-note">No goals are aligned to this one yet.</p> : <ul className="goals-list">
              {goal.children.map((child) => <li key={child.id}><ChildRow goal={child} onOpen={onOpenPath} /></li>)}
              {goal.hiddenChildCount > 0 && <li><p className="goals-hidden-note">+ {goal.hiddenChildCount} goal{goal.hiddenChildCount === 1 ? "" : "s"} you can't open</p></li>}
            </ul>}
          </section>
          <section className="goals-panel" aria-labelledby="goal-work">
            <header><h2 id="goal-work"><Link2 aria-hidden="true" />Linked work</h2>{goal.canComment && <button type="button" className="secondary-button ui-small-button" onClick={() => setSheet({ kind: "link" })} aria-haspopup="dialog"><Plus aria-hidden="true" />Link work</button>}</header>
            {work === null ? <p className="ui-panel-loading" role="status">Loading…</p> : work.length === 0 ? <p className="goals-note">Link cards, boards, notes, or deals that move this goal.</p> :
              <ul className="goals-work">{work.map((link) => <li key={link.id}><WorkRefChip summary={link.other} onOpen={onOpenPath} onRemove={goal.canEdit && link.source === "work_links" ? () => { deleteLink(link.id).then(reload, (reason) => flash(errorText(reason, "Could not remove the link"))); } : undefined} /></li>)}</ul>}
          </section>
          <ItemSectionsOutlet kind="goal" id={goal.id} readOnly={false} onOpen={onOpenPath} frameClassName="goals-panel" />
          <section className="goals-panel" aria-labelledby="goal-checkins">
            <header><h2 id="goal-checkins"><MessageSquareText aria-hidden="true" />Check-ins</h2></header>
            {checkins === null ? <p className="ui-panel-loading" role="status">Loading…</p> : checkins.length === 0
              ? <EmptyState compact as="h3" icon={TrendingUp} title="No check-ins yet" action={goal.canEdit && !isClosed ? { label: "Check in", onClick: () => setSheet({ kind: "checkin" }) } : undefined}>A check-in records progress, health, and a note.</EmptyState>
              : <ol className="goals-checkins">{checkins.map((checkin) => <li key={checkin.id} className="goals-checkin">
                <header><GoalHealthChip health={checkin.health} /><strong>{checkin.author?.name ?? "Someone"}</strong><span>{relativeTime(checkin.createdAt)}</span><span>· {percent(checkin.progress)}</span>{checkin.confidence && <span>· confidence {checkin.confidence}/10</span>}{checkin.via !== "web" && <span>· via {checkin.via.toUpperCase()}</span>}</header>
                {checkin.note && <p><MentionText text={checkin.note} /></p>}
              </li>)}</ol>}
          </section>
          <ItemTimeline kind="goal" id={goal.id} canComment={goal.canComment} renderers={goalActivityRenderers} refreshKey={`${goal.revision}`} />
        </div>
      </div>
    </div>
    {sheet?.kind === "checkin" && <CheckInSheet goal={goal} onClose={() => setSheet(null)} onSaved={(next) => { setSheet(null); setGoal(next); reload(); flash("Checked in"); }} />}
    {sheet?.kind === "edit" && <GoalEditor goal={goal} me={{ id: userId, name: displayName }} onClose={() => setSheet(null)} onSaved={(next) => { setSheet(null); setGoal(next); reload(); flash("Goal saved"); }} />}
    {sheet?.kind === "child" && <GoalEditor me={{ id: userId, name: displayName }} defaults={{ parentId: goal.id, periodId: goal.period?.id }} onClose={() => setSheet(null)} onSaved={(next) => { setSheet(null); flash(`${next.title} created`); onOpenPath(next.href); }} />}
    {sheet?.kind === "kr" && <KrEditor goal={goal} kr={sheet.kr} onClose={() => setSheet(null)} onSaved={(message) => { setSheet(null); reload(); flash(message); }} />}
    {sheet?.kind === "close" && <CloseSheet goal={goal} onClose={() => setSheet(null)} onSaved={(message, next) => { setSheet(null); setGoal(next); reload(); flash(message); }} />}
    {sheet?.kind === "access" && <Suspense fallback={null}><AccessSheet kind="goal" id={goal.id} title={goal.title} guardHistory note="Contributors can always open the goal and check in on it." onClose={() => setSheet(null)}
      onSaved={() => { setSheet(null); reload(); flash("Access saved"); }} /></Suspense>}
    {sheet?.kind === "link" && <LinkPicker title="Link work to this goal" relations={["contributes"]} onClose={() => setSheet(null)} onPick={async (target) => {
      // The work is side A: "MYT-12 contributes to Grow MRR" (§B.4.1).
      await createLink("ref" in target ? target as never : { kind: target.kind, id: target.id }, { kind: "goal", id: goal.id }, "contributes");
      reload();
      flash("Linked");
    }} />}
  </main>;
}

const closed = (goal: GoalSummary) => !["draft", "active"].includes(goal.state);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="goals-field"><dt>{label}</dt><dd>{children}</dd></div>;
}

function ChildRow({ goal, onOpen }: { goal: GoalSummary; onOpen: (href: string) => void }) {
  return <div className="goals-row">
    <div className="goals-row-main"><GoalHealthChip health={goal.health} /><a href={goal.href} onClick={appClick(goal.href, onOpen)}>{goal.title}</a></div>
    <div className="goals-row-meta goals-row-owner"><strong>{goal.owner.name}</strong>{goal.team ? ` · ${goal.team.name}` : ""}</div>
    <div className="goals-row-progress"><ProgressBar thin value={goal.progress} label={`${goal.title} progress`} /><span className="goals-pct">{percent(goal.progress)}</span></div>
    <div className="goals-age goals-row-age">{goal.lastCheckinAt ? relativeTime(goal.lastCheckinAt) : "—"}</div>
  </div>;
}

function KrRow({ kr, points, canEdit, onEdit, onRemove }: { kr: KeyResult; points?: GoalHistory["keyResults"][number]["points"]; canEdit: boolean; onEdit: () => void; onRemove: () => void }) {
  const auto = kr.source.kind !== "manual";
  const values = kr.metric === "milestones"
    ? <><strong>{kr.milestones.filter((item) => item.done).length}</strong> of {kr.milestones.length} milestones</>
    : kr.metric === "boolean" ? <strong>{kr.currentValue >= 1 ? "Done" : "Not done"}</strong>
      : <>{formatKrValue(kr.startValue, kr)} → <strong>{formatKrValue(kr.currentValue, kr)}</strong> → {formatKrValue(kr.targetValue, kr)}</>;
  return <li className="goals-kr">
    <span className="goals-kr-title">{kr.title}</span>
    <span className="goals-kr-values">{values}</span>
    <ProgressBar thin value={kr.progress} label={`${kr.title} progress`} valueText={percent(kr.progress)} />
    {kr.metric === "milestones" && kr.milestones.length > 0 && <ul className="goals-milestones">{kr.milestones.map((milestone) => <li key={milestone.id} data-done={milestone.done}>{milestone.done ? <CheckSquare aria-hidden="true" /> : <Square aria-hidden="true" />}<span>{milestone.title}{milestone.done ? <span className="ui-visually-hidden"> (done)</span> : null}</span></li>)}</ul>}
    <div className="goals-kr-foot">
      <span className="goals-pct" style={{ textAlign: "left" }}>{percent(kr.progress)}</span>
      <KrSparkline points={points} />
      <span className="goals-source" data-error={kr.source.error ? true : undefined} title={kr.source.error ?? kr.source.description}>{auto ? <Zap aria-hidden="true" /> : <TrendingUp aria-hidden="true" />}{auto ? `Auto · ${kr.source.label}: ${kr.source.description}` : "Manual"}</span>
      {kr.source.error && <span className="ui-field-error">{kr.source.error}</span>}
      {kr.metric !== "boolean" && kr.metric !== "milestones" && kr.direction !== "increase" && <span>{KR_DIRECTION_LABEL[kr.direction]}</span>}
      {kr.weight !== 1 && <span>weight {kr.weight}</span>}
      {kr.owner && <span>· {kr.owner.name}</span>}
      {canEdit && <span style={{ marginLeft: "auto", display: "inline-flex", gap: 4 }}>
        <button type="button" className="icon-button" onClick={onEdit} aria-label={`Edit ${kr.title}`} title="Edit"><Pencil /></button>
        <button type="button" className="icon-button" onClick={onRemove} aria-label={`Remove ${kr.title}`} title="Remove"><Trash2 /></button>
      </span>}
    </div>
  </li>;
}

/** Progress over time (§D.3): each KR's progress, the goal's at each check-in, and the ideal line. */
function ProgressChart({ goal, history }: { goal: GoalDetail; history: GoalHistory }) {
  const chart = useMemo(() => {
    const day = (iso: string) => iso.slice(0, 10);
    const dates = new Set<string>();
    for (const kr of history.keyResults) for (const point of kr.points) dates.add(day(point.at));
    for (const checkin of history.checkins) dates.add(day(checkin.at));
    dates.add(new Date().toISOString().slice(0, 10));
    if (history.ideal) { dates.add(history.ideal.start); }
    const categories = [...dates].sort();
    const carry = (points: Array<{ at: string; value: number }>) => {
      let last: number | null = null;
      let index = 0;
      const sorted = [...points].sort((a, b) => a.at.localeCompare(b.at));
      return categories.map((date) => {
        while (index < sorted.length && day(sorted[index]!.at) <= date) { last = sorted[index]!.value; index += 1; }
        return last;
      });
    };
    const series = history.keyResults.slice(0, 6).map((kr) => ({ name: kr.title.length > 28 ? `${kr.title.slice(0, 27)}…` : kr.title, values: carry(kr.points.map((point) => ({ at: point.at, value: Math.round(point.progress * 100) }))) }));
    if (history.checkins.length) series.push({ name: "Goal (check-ins)", values: carry(history.checkins.map((point) => ({ at: point.at, value: Math.round(point.progress * 100) }))) });
    if (history.ideal) {
      const start = Date.parse(`${history.ideal.start}T00:00:00Z`);
      const end = Date.parse(`${history.ideal.end}T00:00:00Z`) + 86_400_000;
      series.push({ name: "Ideal", values: categories.map((date) => Math.round(Math.min(1, Math.max(0, (Date.parse(`${date}T12:00:00Z`) - start) / (end - start))) * 100)) });
    }
    const dataDays = new Set([...history.keyResults.flatMap((kr) => kr.points.map((point) => day(point.at))), ...history.checkins.map((point) => day(point.at))]);
    // Phones get the goal and the ideal line only (the legend of six lines would cover the chart).
    const narrow = typeof window !== "undefined" && window.matchMedia?.("(max-width: 760px)").matches;
    return { categories, series: narrow ? series.filter((entry) => entry.name === "Ideal" || entry.name === "Goal (check-ins)") : series, dataDays: dataDays.size };
  }, [history]);
  // A line needs two days of points: until then, say when it starts rather than draw dots.
  if (chart.dataDays < 2) return <section className="goals-panel" aria-labelledby="goal-chart">
    <header><h2 id="goal-chart"><TrendingUp aria-hidden="true" />Progress over time</h2></header>
    <p className="goals-note">The chart fills in from the second day of check-ins and automatic updates. Today: {percent(goal.progress)}{goal.expected !== null ? `, with ${percent(goal.expected)} of the time gone` : ""}.</p>
  </section>;
  return <section className="goals-panel" aria-label="Progress over time">
    <InsightChart title={`Progress over time (%) · now ${percent(goal.progress)}`} kind="line" categories={chart.categories} series={chart.series} height={220} />
  </section>;
}
