import { useCallback, useEffect, useState } from "react";
import { AlertOctagon, BellRing, ChevronLeft, ChevronRight, Lock, Play, Square, Sunrise, PenLine } from "lucide-react";
import { ModuleHome } from "../ui/ModuleHome";
import { formatWorkspaceRoute } from "../workspaceModules/registry";
import { EmptyState } from "../ui/EmptyState";
import { ProgressBar } from "../ui/progress/Progress";
import { KpiRow, KpiTile, InsightChart } from "../ui/insights/Insights";
import { WorkRefChip } from "../ui/links/WorkLinks";
import { useModuleShortcuts } from "../ui/moduleKeys";
import type { MoreMenuItem } from "../ui/MoreMenu";
import type { CheckinDetail, CheckinStats, RoundView } from "../../shared/checkins";
import type { WorkspaceAppProps } from "../workspaceModules/types";
import { closeRound, errorCode, errorText, getStandup, listRounds, nudgeRound, roundByDate, skipRound, standupStats, startRound } from "./api";
import { AnswerCard, answerValue, cadenceText, dateText, Faces, PersonFace, relativeDeadline, StateBadge, timeText } from "./parts";
import { AnswerSheet } from "./AnswerSheet";
import { StandupSettings } from "./StandupSettings";

type PageProps = WorkspaceAppProps & { segment: string; sub: string | null; third: string | null; go: (path: string[], options?: { replace?: boolean }) => void };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One standup: its rounds (latest by default), Insights, and Settings; the answer sheet at `<date>/answer`. */
export function StandupPage(props: PageProps) {
  const { segment, sub, third, go, flash } = props;
  const [detail, setDetail] = useState<CheckinDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [reload, setReload] = useState(0);
  const [round, setRound] = useState<RoundView | null>(null);
  const [roundState, setRoundState] = useState<"loading" | "none" | "ready" | "missing">("loading");
  const [view, setView] = useState<"person" | "question">("person");
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    getStandup(segment).then(({ checkin }) => {
      if (!live) return;
      setDetail(checkin);
      // A stale slug or a bare id: correct the URL in place (friendly URLs, D773).
      const canonical = checkin.href.split("/")[2]!;
      if (canonical !== segment) go([canonical, ...(sub ? [sub] : []), ...(third ? [third] : [])], { replace: true });
    }).catch(() => { if (live) setMissing(true); });
    return () => { live = false; };
  }, [segment, reload]);

  const date = sub && DATE.test(sub) ? sub : null;
  const tab = sub === "insights" ? "insights" : sub === "settings" ? "settings" : "round";
  useEffect(() => {
    if (!detail || tab !== "round") return;
    let live = true;
    setRoundState("loading");
    const load = date ? roundByDate(detail.id, date) : listRounds(detail.id).then((page) => page.items[0] ? roundByDate(detail.id, page.items[0].date) : null);
    load.then((next) => { if (!live) return; setRound(next); setRoundState(next ? "ready" : "none"); }).catch(() => { if (live) setRoundState("missing"); });
    return () => { live = false; };
  }, [detail?.id, date, tab, reload]);

  const segmentNow = detail?.href.split("/")[2] ?? segment;
  const canEdit = detail ? ["owner", "manage", "edit"].includes(detail.level) && (props.role === "admin" || props.role === "member") : false;
  const due = round?.you && round.you.status === "pending" && round.you.canAnswer;
  const openAnswer = () => round && go([segmentNow, round.round.date, "answer"]);

  const start = async () => {
    if (!detail) return;
    try {
      const created = await startRound(detail.id);
      flash("Round started; participants were notified");
      go([segmentNow, created.round.round.date]);
      refresh();
    } catch (reason) {
      if (errorCode(reason) === "ROUND_EXISTS") flash("Today's round has already started");
      else flash(errorText(reason, "The round could not be started"));
    }
  };
  useModuleShortcuts({ a: due ? () => { openAnswer(); } : undefined, "[": round?.prev ? () => go([segmentNow, round.prev!]) : undefined, "]": round?.next ? () => go([segmentNow, round.next!]) : undefined }, tab === "round" && third !== "answer");

  if (missing) return <ModuleHome icon={Sunrise} title="Standups" heading="Standup not found" displayName={props.displayName} onHome={props.onHome} onSettings={props.onSettings} onSignOut={props.onSignOut}>
    <EmptyState icon={Sunrise} title="This standup isn't available" action={{ label: "All standups", onClick: () => go([]) }}>It may have been moved to the Bin, or you no longer have access.</EmptyState>
  </ModuleHome>;
  if (!detail) return <main className="app-page" aria-busy="true"><p className="sr-only" role="status">Loading the standup…</p></main>;

  if (third === "answer" && date) return <AnswerSheet {...props} detail={detail} date={date} onDone={(message) => { flash(message); go([segmentNow, date]); refresh(); }} onCancel={() => go([segmentNow, date])} />;

  const menu: MoreMenuItem[] = [
    ...(canEdit ? [{ id: "start", label: "Start a round now", icon: Play, onSelect: () => void start() }] : []),
    ...(canEdit && round?.round.status === "open" ? [
      { id: "nudge", label: "Nudge people who haven't answered", icon: BellRing, onSelect: () => { nudgeRound(round.round.id).then((result) => flash(result.nudged ? `Nudged ${result.nudged} ${result.nudged === 1 ? "person" : "people"}` : "Everyone has answered or was nudged in the last hour")).catch((reason) => flash(errorText(reason, "Could not nudge"))); } },
      { id: "close", label: "Close this round", icon: Square, onSelect: () => { closeRound(round.round.id).then(() => { flash("Round closed; the summary went out"); refresh(); }).catch((reason) => flash(errorText(reason, "Could not close the round"))); } }
    ] : [])
  ];

  return <ModuleHome icon={Sunrise} title="Standups" heading={detail.name} displayName={props.displayName} onHome={props.onHome} onSettings={props.onSettings} onSignOut={props.onSignOut}
    primary={due ? { label: "Answer", icon: PenLine, onClick: openAnswer, shortcut: false } : canEdit && tab === "round" && roundState === "none" ? { label: "Start a round", icon: Play, onClick: () => void start(), shortcut: false } : undefined}
    menu={menu}
    tabs={[{ id: "round", label: "Rounds" }, { id: "insights", label: "Insights" }, { id: "settings", label: "Settings" }]} activeTab={tab}
    tabsInSidebar={{ label: detail.name, hrefFor: (id) => formatWorkspaceRoute({ app: "checkins", path: id === "round" ? [segmentNow] : [segmentNow, id], search: "" }) }}
    onTab={(id) => go(id === "round" ? [segmentNow] : [segmentNow, id])}
    filters={<p className="standup-subline"><button type="button" className="ui-text-button" onClick={() => go([])}><ChevronLeft aria-hidden="true" />All standups</button><span className="standup-muted">{cadenceText(detail.schedule)}{detail.status === "paused" ? " · Paused" : ""}</span>{detail.anonymous && <span className="standup-state tone-info"><Lock aria-hidden="true" />Anonymous</span>}</p>}>
    {tab === "round" && <RoundTab {...props} detail={detail} round={round} state={roundState} view={view} setView={setView} segmentNow={segmentNow} canEdit={canEdit} onStart={() => void start()} onSkipped={refresh} />}
    {tab === "insights" && <Insights detail={detail} />}
    {tab === "settings" && <StandupSettings {...props} detail={detail} canEdit={canEdit} onChanged={(next) => { if (next) setDetail(next); else refresh(); }} onDeleted={() => go([])} />}
  </ModuleHome>;
}

function RoundTab({ detail, round, state, view, setView, segmentNow, canEdit, go, onOpenPath, onStart, onSkipped, flash, role }: PageProps & {
  detail: CheckinDetail; round: RoundView | null; state: string; view: "person" | "question"; setView: (view: "person" | "question") => void; segmentNow: string; canEdit: boolean; onStart: () => void; onSkipped: () => void;
}) {
  if (state === "loading") return <p className="standup-muted" role="status">Loading the round…</p>;
  if (state === "missing") return <EmptyState icon={Sunrise} title="No round on that date" action={{ label: "Latest round", onClick: () => go([segmentNow]) }} compact />;
  if (!round) return <EmptyState icon={Sunrise} title="No rounds yet" action={canEdit ? { label: "Start a round now", icon: Play, onClick: onStart } : undefined}>
    {detail.nextOpensAt ? `The first round opens ${new Date(detail.nextOpensAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} your time.` : "Rounds open on the schedule in Settings."}
  </EmptyState>;
  const closed = round.round.status === "closed";
  const latest = round.sets[String(Math.max(...Object.keys(round.sets).map(Number)))];
  const canComment = ["owner", "manage", "edit", "comment"].includes(round.checkin.level) && (role === "admin" || role === "member");
  const counted = round.participants.filter((entry) => entry.status !== "out");
  const answered = counted.filter((entry) => entry.status === "answered" || entry.status === "late").length;
  return <div className="standup-round">
    <nav className="standup-dates" aria-label="Rounds">
      <button type="button" className="standup-icon-button" disabled={!round.prev} onClick={() => round.prev && go([segmentNow, round.prev])} aria-label={round.prev ? `Previous round, ${dateText(round.prev)}` : "No earlier round"} aria-keyshortcuts="["><ChevronLeft /></button>
      <h2 className="standup-date-title">{dateText(round.round.date, true)}<span className={`standup-state tone-${closed ? "neutral" : "info"}`}>{closed ? "Closed" : "Open"}</span></h2>
      <button type="button" className="standup-icon-button" disabled={!round.next} onClick={() => round.next && go([segmentNow, round.next])} aria-label={round.next ? `Next round, ${dateText(round.next)}` : "No later round"} aria-keyshortcuts="]"><ChevronRight /></button>
    </nav>

    {round.you && <YouCallout round={round} onAnswer={() => go([segmentNow, round.round.date, "answer"])} onSkip={() => { skipRound(round.round.id).then(() => { flash("Skipped this round"); onSkipped(); }).catch((reason) => flash(errorText(reason, "Could not skip"))); }} />}

    <section className="standup-panel" aria-labelledby="standup-participation">
      <div className="standup-panel-head"><h3 id="standup-participation">Participation</h3><span className="standup-muted ui-tabular">{answered} of {counted.length} answered</span></div>
      <ProgressBar value={counted.length ? answered / counted.length : 0} label="Answered" valueText={`${counted.length ? Math.round((answered / counted.length) * 100) : 0}%`} thin tone={answered === counted.length ? "success" : "accent"} />
      <ul className="standup-people">
        {round.participants.map((entry) => <li key={entry.person.id}>
          <PersonFace person={entry.person} size="small" /><span className="standup-person-name">{entry.person.name}</span><StateBadge state={entry.status} closed={closed} />
          {entry.answeredAt && <span className="standup-muted ui-tabular">{timeText(entry.answeredAt)}</span>}
        </li>)}
      </ul>
    </section>

    {round.blockers.length > 0 && <section className="standup-panel standup-blockers" aria-labelledby="standup-blockers">
      <div className="standup-panel-head"><h3 id="standup-blockers"><AlertOctagon aria-hidden="true" />Blockers</h3><span className="standup-muted">{round.blockers.length}</span></div>
      <ul>
        {round.blockers.map((blocker, index) => <li key={"id" in blocker.card ? blocker.card.id : index}>
          <WorkRefChip summary={blocker.card} onOpen={onOpenPath} />
          <Faces people={blocker.people} label={`Named by ${blocker.people.map((person) => person.name).join(", ")}`} max={3} />
          {blocker.flagged && <span className="standup-state tone-danger">Flagged</span>}
        </li>)}
      </ul>
    </section>}

    {round.mood && round.mood.average !== null && <section className="standup-panel standup-mood-panel" aria-labelledby="standup-mood">
      <div className="standup-panel-head"><h3 id="standup-mood">Mood</h3><span className="ui-tabular">{round.mood.average.toFixed(1)} / 5 · {round.mood.count} answer{round.mood.count === 1 ? "" : "s"}</span></div>
      <ol className="standup-mood-bars" aria-label="Mood answers">
        {[1, 2, 3, 4, 5].map((value) => { const count = round.mood!.distribution.find((entry) => entry.value === value)?.count ?? 0; return <li key={value}>
          <span aria-hidden="true">{["😞", "🙁", "😐", "🙂", "😄"][value - 1]}</span>
          <span className="standup-mood-track"><span style={{ width: `${round.mood!.count ? (count / round.mood!.count) * 100 : 0}%` }} /></span>
          <span className="ui-tabular">{count}</span><span className="ui-visually-hidden"> answered {value}</span>
        </li>; })}
      </ol>
    </section>}

    <section aria-labelledby="standup-answers" className="standup-answers">
      <div className="standup-panel-head">
        <h3 id="standup-answers">Answers</h3>
        {round.answers.length > 0 && <div className="ui-segmented" role="group" aria-label="Group answers">
          <button type="button" aria-pressed={view === "person"} onClick={() => setView("person")}>By person</button>
          <button type="button" aria-pressed={view === "question"} onClick={() => setView("question")}>By question</button>
        </div>}
      </div>
      {round.hiddenUntil !== null ? <p className="standup-notice"><Lock aria-hidden="true" />Answers are anonymous and show once {round.hiddenUntil} people have answered ({round.round.answered} so far).</p>
        : !round.answers.length ? <EmptyState icon={Sunrise} title="No answers yet" compact>{closed ? "Nobody answered this round." : "Answers show here as people check in."}</EmptyState>
          : view === "person" ? <ol className="standup-answer-list">{round.answers.map((answer, index) => <li key={answer.id ?? index}><AnswerCard answer={answer} set={round.sets[String(answer.setVersion)] ?? latest} onOpen={onOpenPath} canComment={canComment} /></li>)}</ol>
            : <div className="standup-by-question">{(latest?.questions ?? []).filter((question) => question.type !== "statement").map((question) => <section key={question.id} className="standup-panel">
              <h4>{question.title}</h4>
              <ul>{round.answers.filter((answer) => answer.answers[question.id] !== undefined).map((answer, index) => <li key={answer.id ?? index}>
                {answer.person && <span className="standup-qa-person"><PersonFace person={answer.person} size="small" />{answer.person.name}</span>}
                <span>{answerValue(question, answer.answers[question.id]!, answer.refs, onOpenPath)}</span>
              </li>)}</ul>
            </section>)}</div>}
    </section>
  </div>;
}

function YouCallout({ round, onAnswer, onSkip }: { round: RoundView; onAnswer: () => void; onSkip: () => void }) {
  const you = round.you!;
  if (you.answered) return <div className="standup-callout done"><span>You answered{you.status === "late" ? " (late)" : ""}.</span>{you.canAnswer && <button type="button" className="ui-text-button" onClick={onAnswer}>Edit your answer</button>}</div>;
  if (you.status === "skipped") return <div className="standup-callout"><span>You skipped this round.</span>{you.canAnswer && <button type="button" className="ui-text-button" onClick={onAnswer}>Answer anyway</button>}</div>;
  if (you.status === "out") return <div className="standup-callout"><span>You're out for this round.</span></div>;
  if (!you.canAnswer) return null;
  const late = Date.parse(you.deadlineAt) < Date.now();
  return <div className="standup-callout due">
    <span>{late ? "Your answer is late, but it still counts." : `Your answer is ${relativeDeadline(you.deadlineAt).replace(/^Due/, "due")}.`}</span>
    <span className="standup-callout-actions">
      <button type="button" className="action-button secondary ui-small-action" onClick={onSkip}>Skip</button>
      <button type="button" className="action-button ui-small-action" onClick={onAnswer} aria-keyshortcuts="a">Answer</button>
    </span>
  </div>;
}

function Insights({ detail }: { detail: CheckinDetail }) {
  const [stats, setStats] = useState<CheckinStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { standupStats(detail.id).then(setStats).catch((reason) => setError(errorText(reason, "Insights could not be loaded"))); }, [detail.id]);
  if (error) return <p className="standup-error" role="alert">{error}</p>;
  if (!stats) return <p className="standup-muted" role="status">Loading insights…</p>;
  if (!stats.rounds.length) return <EmptyState icon={Sunrise} title="No rounds yet" compact>Participation and mood show here after the first round.</EmptyState>;
  const categories = stats.rounds.map((round) => dateText(round.date));
  const you = detail.streak;
  const hasMood = stats.rounds.some((round) => round.mood !== null);
  return <div className="ui-insights standup-insights">
    <KpiRow>
      <KpiTile label="Participation" value={stats.participationRate} unit="percent" />
      <KpiTile label="Average mood" value={stats.averageMood === null ? null : Math.round(stats.averageMood * 10) / 10} hint={hasMood ? "out of 5" : "No mood question answered"} />
      <KpiTile label="Rounds" value={stats.rounds.length} />
      {you !== null && <KpiTile label="Your streak" value={you} hint="rounds in a row" />}
    </KpiRow>
    <InsightChart title="Participation per round" kind="stacked" categories={categories} series={[
      { name: "Answered", values: stats.rounds.map((round) => round.answered) },
      { name: "Late", values: stats.rounds.map((round) => round.late) },
      { name: "Skipped", values: stats.rounds.map((round) => round.skipped) },
      { name: "No answer", values: stats.rounds.map((round) => round.status === "closed" ? round.pending : 0) }
    ]} />
    {hasMood && <InsightChart title={detail.anonymous ? "Mood (rounds with 3 answers or more)" : "Mood trend"} kind={stats.rounds.length < 3 ? "bar" : "line"} categories={categories} series={[{ name: "Mood", values: stats.rounds.map((round) => round.mood === null ? null : Math.round(round.mood * 10) / 10) }]} />}
    {!detail.anonymous && <table className="standup-table">
      <caption>People</caption>
      <thead><tr><th scope="col">Person</th><th scope="col">Answered</th><th scope="col">Late</th><th scope="col">Skipped</th><th scope="col">Missed</th><th scope="col">Streak</th></tr></thead>
      <tbody>{stats.people.map((entry) => <tr key={entry.person.id}>
        <th scope="row"><span className="standup-qa-person"><PersonFace person={entry.person} size="small" />{entry.person.name}</span></th>
        <td className="ui-tabular">{entry.answered}</td><td className="ui-tabular">{entry.late}</td><td className="ui-tabular">{entry.skipped}</td><td className="ui-tabular">{entry.missed}</td><td className="ui-tabular">{entry.streak}</td>
      </tr>)}</tbody>
    </table>}
  </div>;
}
