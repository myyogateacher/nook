import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, BarChart3, CalendarDays, CirclePlay, CircleStop, Download, FileText, Globe, ListChecks, MessageCircleQuestion, Pencil, Plus, Presentation, RotateCcw,
  Settings2, Share2, SquareCheckBig, Trash2, Users, Eye, EyeOff, MonitorPlay, Square
} from "lucide-react";
import { ModuleHome } from "../ui/ModuleHome";
import { EmptyState } from "../ui/EmptyState";
import { MoreMenu, type MoreMenuItem } from "../ui/MoreMenu";
import { QaList, type QaModeration, type QaQuestion } from "../ui/live/QaList";
import { KpiRow, KpiTile } from "../ui/insights/Insights";
import { ResultBars } from "../ui/questions/QuestionSummary";
import { useModuleShortcuts } from "../ui/moduleKeys";
import { useConfirm } from "../ui/useConfirm";
import { errorText, notify } from "../ui/notify";
import { ApiError } from "../api";
import type { WorkspaceAppProps } from "../workspaceModules/types";
import { authorLabel, POLL_KIND_LABELS, type TownhallLiveState, type TownhallQuestionView, type TownhallRecap } from "../../shared/townhall";
import * as townhall from "./api";
import { useLiveState } from "./useLiveState";
import { PollView } from "./PollView";
import { Presenter } from "./Presenter";
import { CardsSheet, CommentsSheet, MergeSheet, PollSheet, SessionSheet, ShareSheet } from "./Sheets";
import { formatWhen, StateChip } from "./common";
import { ItemTimeline } from "../ui/activity/ItemTimeline";
import { canCommentAtLevel } from "../ui/activity/activityAccess";
import { module as townhallModule } from "./module";

const AccessSheet = lazy(() => import("../access/AccessSheet").then((module) => ({ default: module.AccessSheet })));

type Tab = "qa" | "polls" | "recap" | "activity";
type Filter = "all" | "review" | "answered" | "starred" | "mine" | "hidden";
type Sheet = { kind: "edit" } | { kind: "poll" } | { kind: "comments"; questionId: string } | { kind: "merge"; questionId: string } | { kind: "cards"; questionIds: string[] } | { kind: "share" } | { kind: "access" } | null;

const toQa = (question: TownhallQuestionView): QaQuestion => ({
  id: question.id, text: question.text, author: authorLabel(question), votes: question.votes, voted: question.voted, status: question.status, pinned: question.pinned,
  createdAt: question.createdAt, mine: question.mine, starred: question.starred, commentCount: question.commentCount, mergedCount: question.mergedCount
});

/** A session: Q&A, polls, and the recap, live for everyone in it (§D.7 Townhall). */
export function SessionPage(props: WorkspaceAppProps & { segment: string; present: boolean }) {
  const { segment, present, navigate, flash } = props;
  const search = new URLSearchParams(props.route.search);
  const tab: Tab = (["qa", "polls", "recap", "activity"] as const).find((value) => value === search.get("tab")) ?? "qa";
  const [filter, setFilter] = useState<Filter>(search.get("filter") === "review" ? "review" : "all");
  const [sort, setSort] = useState<"top" | "recent">("top");
  const [query, setQuery] = useState("");
  const [sheet, setSheet] = useState<Sheet>(null);
  const { ask: askConfirm, confirmElement } = useConfirm();
  const live = useLiveState<TownhallLiveState>({ load: () => townhall.getState(segment), streamUrl: `/api/townhall/sessions/${encodeURIComponent(segment)}/live` });
  const state = live.state;
  const session = state?.session ?? null;
  const you = state?.you ?? null;
  const host = Boolean(you?.canModerate);
  // Someone with a level on the session (not an audience-link participant) sees its Activity (D1375).
  const member = Boolean(you && you.level !== "public" && you.level !== "none");

  const go = useCallback((next: { tab?: Tab; present?: boolean; replace?: boolean }) => {
    const params = new URLSearchParams();
    const nextTab = next.tab ?? tab;
    if (nextTab !== "qa") params.set("tab", nextTab);
    const path = [session ? session.href.split("/").pop()! : segment, ...(next.present ?? present ? ["present"] : [])];
    navigate({ app: "townhall", path, search: params.size ? `?${params}` : "" } as never, { replace: next.replace });
  }, [navigate, present, segment, session, tab]);

  // The canonical URL (slug + short id) once the session is known (friendly URLs, D772).
  useEffect(() => {
    if (session && session.href.split("/").pop() !== segment) go({ replace: true });
  }, [session, segment, go]);
  // Open a question's replies from a link (`?q=<id>`, notifications and work refs).
  useEffect(() => {
    const id = search.get("q");
    if (id && state?.questions.some((question) => question.id === id)) setSheet({ kind: "comments", questionId: id });
  }, [state === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(async (work: () => Promise<unknown>, failure: string, success?: string) => {
    try {
      await work();
      if (success) notify.success(success);
      await live.refresh();
    } catch (reason) {
      notify.error(errorText(reason, failure));
    }
  }, [live]);

  useModuleShortcuts({
    p: session ? () => go({ present: true }) : undefined,
    a: tab === "qa" && you?.canAsk ? () => document.querySelector<HTMLTextAreaElement>(".ui-qa-ask textarea")?.focus() : undefined
  });

  const counts = useMemo(() => {
    const list = state?.questions ?? [];
    return {
      review: list.filter((question) => question.status === "pending").length,
      answered: list.filter((question) => question.status === "answered").length,
      starred: list.filter((question) => question.starred).length,
      mine: list.filter((question) => question.mine).length,
      hidden: list.filter((question) => question.status === "hidden").length
    };
  }, [state]);

  if (live.gone || (live.error instanceof ApiError && live.error.status === 404)) {
    return <main className="app-page th-missing"><EmptyState icon={MessageCircleQuestion} title="This townhall is not available" action={{ label: "All townhalls", onClick: props.onHome === undefined ? () => undefined : () => navigate({ app: "townhall", path: [], search: "" } as never) }}>It may have been deleted, or you no longer have access.</EmptyState></main>;
  }
  if (!state || !session || !you) return <main className="app-page th-loading" aria-busy="true"><p className="ui-panel-loading" role="status">Loading the session…</p></main>;

  const memberUrl = `${window.location.origin}${session.href}`;
  const publicUrl = state.publicUrl ? `${window.location.origin}${state.publicUrl}` : null;
  if (present) {
    return <Presenter state={state} joinUrl={publicUrl ?? memberUrl} onExit={() => go({ present: false })}
      onShow={host ? (pollId) => { void run(() => townhall.showOnScreen(session.id, pollId), "Could not change the screen"); } : undefined} />;
  }

  const shown = state.questions.filter((question) => {
    if (query.trim() && !question.text.toLowerCase().includes(query.trim().toLowerCase())) return false;
    switch (filter) {
      case "review": return question.status === "pending";
      case "answered": return question.status === "answered";
      case "starred": return question.starred;
      case "mine": return question.mine;
      case "hidden": return question.status === "hidden";
      default: return question.status !== "hidden" || !host ? true : false;
    }
  });
  const onModerate = (id: string, action: QaModeration) => {
    if (action === "merge") { setSheet({ kind: "merge", questionId: id }); return; }
    void run(() => townhall.moderate(id, action), "Could not update the question");
  };
  const stateAction = session.state === "upcoming" ? { label: "Go live", icon: CirclePlay, next: "live" as const }
    : session.state === "live" ? { label: "End session", icon: CircleStop, next: "ended" as const }
      : { label: "Reopen", icon: RotateCcw, next: "live" as const };
  const changeState = async () => {
    if (stateAction.next === "ended" && !await askConfirm({ title: "End this session?", message: "Questions and polls close. You can reopen it later.", confirmLabel: "End session" })) return;
    await run(() => townhall.setState(session.id, stateAction.next), "Could not change the session", stateAction.next === "live" ? "The session is live" : "The session has ended");
  };
  const menu: MoreMenuItem[] = [
    { id: "present", label: "Present (P)", icon: Presentation, onSelect: () => go({ present: true }) },
    { id: "share", label: "Invite people", icon: Share2, onSelect: () => setSheet({ kind: "share" }) },
    ...(host ? [{ id: "edit", label: "Session settings", icon: Settings2, onSelect: () => setSheet({ kind: "edit" }) }] : []),
    ...(you.canManage ? [{ id: "access", label: "Who has access", icon: Users, onSelect: () => setSheet({ kind: "access" }) }] : []),
    { id: "csv", label: "Download questions (CSV)", icon: Download, onSelect: () => { window.location.href = townhall.recapDownloadUrl(session.id, "csv"); } },
    ...(you.canManage ? [{ id: "delete", label: "Delete session", icon: Trash2, danger: true, onSelect: async () => {
      if (!await askConfirm({ title: "Delete this session?", message: "It moves to the Bin for 30 days; its audience link stops working.", confirmLabel: "Delete", danger: true })) return;
      try { await townhall.binSession(session.id); flash("Moved to the Bin"); navigate({ app: "townhall", path: [], search: "" } as never); } catch (reason) { notify.error(errorText(reason, "Could not delete the session")); }
    } }] : [])
  ];
  const filters = tab === "qa" ? <>
    <div className="th-chips" role="group" aria-label="Show questions">
      {([["all", "All", null], ...(host ? [["review", "Review", counts.review]] : []), ["answered", "Answered", counts.answered], ...(host ? [["starred", "Starred", counts.starred]] : []), ["mine", "Mine", counts.mine], ...(host ? [["hidden", "Hidden", counts.hidden]] : [])] as Array<[Filter, string, number | null]>)
        .map(([value, label, count]) => <button key={value} type="button" className="ui-filter-chip" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}{count ? <span className="ui-tabular th-chip-count">{count}</span> : null}</button>)}
    </div>
  </> : undefined;

  const activePoll = state.polls.find((poll) => poll.id === session.activePollId && poll.status !== "draft") ?? state.polls.find((poll) => poll.status === "live") ?? [...state.polls].reverse().find((poll) => poll.status === "closed") ?? null;
  const vote = (pollId: string) => async (answer: townhall.PollAnswer) => {
    try { await townhall.votePoll(session.id, pollId, answer); await live.refresh(); } catch (reason) { notify.error(errorText(reason, "Could not send your vote")); throw reason; }
  };
  const selectedQuestion = sheet && (sheet.kind === "comments" || sheet.kind === "merge") ? state.questions.find((question) => question.id === sheet.questionId) ?? null : null;

  return <ModuleHome icon={Presentation} title="Townhall" heading={session.title} displayName={props.displayName} onHome={props.onHome} onSettings={props.onSettings} onSignOut={props.onSignOut}
    className="th-session"
    primary={host ? { label: stateAction.label, icon: stateAction.icon, onClick: () => { void changeState(); }, shortcut: false } : { label: "Present", icon: Presentation, onClick: () => go({ present: true }), shortcut: false }}
    menu={menu}
    tabs={[{ id: "qa", label: "Q&A", count: state.stats.questions }, { id: "polls", label: "Polls", count: state.polls.length }, { id: "recap", label: "Recap" }, ...(member ? [{ id: "activity", label: "Activity" }] : [])]}
    activeTab={tab} onTab={(id) => go({ tab: id as Tab })}
    filters={filters}
    search={tab === "qa" ? { value: query, onChange: setQuery, placeholder: "Find a question", label: "Find a question" } : undefined}>
    <div className="th-session-strip">
      <button type="button" className="ui-text-button th-back" onClick={() => navigate({ app: "townhall", path: [], search: "" } as never)}><ArrowLeft aria-hidden="true" />All townhalls</button>
      <StateChip state={session.state} />
      {session.startsAt && <span className="th-strip-item"><CalendarDays aria-hidden="true" />{formatWhen(session.startsAt)}</span>}
      {session.event && <button type="button" className="ui-text-button th-strip-item" onClick={() => props.onOpenPath(session.event!.href)}>{session.event.title}</button>}
      <span className="th-strip-item"><Users aria-hidden="true" /><span className="ui-tabular">{state.stats.participants}</span> joined</span>
      {session.moderation === "review" && <span className="th-strip-item"><Eye aria-hidden="true" />Questions reviewed</span>}
      {!session.questionsOpen && session.state !== "ended" && <span className="th-strip-item"><EyeOff aria-hidden="true" />Questions closed</span>}
      <button type="button" className="secondary-button th-strip-share" onClick={() => setSheet({ kind: "share" })}><Share2 aria-hidden="true" />Invite</button>
    </div>

    {tab === "qa" && <div className="th-qa-layout">
      <div className="th-qa-main">
        {session.description && <p className="th-description">{session.description}</p>}
        <QaList questions={shown.map(toQa)} sort={sort} onSort={setSort} moderator={host} onModerate={host ? onModerate : undefined}
          onUpvote={session.state !== "ended" ? (id, voted) => { void run(() => townhall.vote(id, voted), "Could not save your upvote"); } : undefined}
          onAsk={you.canAsk ? async (text, anonymous) => { await townhall.ask(session.id, text, anonymous); await live.refresh(); if (session.moderation === "review" && !host) notify.info("Sent. A host reviews it before others see it."); } : undefined}
          anonymousAllowed={session.allowAnonymous} closed={session.state === "ended"} maxLength={500}
          askNote={session.allowAnonymous ? "Your name shows unless you ask anonymously." : "Your name shows with your question."}
          onOpen={session.allowComments ? (id) => setSheet({ kind: "comments", questionId: id }) : undefined}
          onWithdraw={(id) => { void (async () => { if (await askConfirm({ title: "Withdraw your question?", message: "It is removed from the session.", confirmLabel: "Withdraw", danger: true })) await run(() => townhall.withdraw(id), "Could not withdraw it"); })(); }}
          emptyText={filter !== "all" || query ? "No questions match." : undefined} />
        {host && filter === "all" && counts.review > 0 && <p className="th-hint"><button type="button" className="ui-text-button" onClick={() => setFilter("review")}>{counts.review} {counts.review === 1 ? "question waits" : "questions wait"} for review</button></p>}
      </div>
      <aside className="th-qa-side" aria-label="Now">
        {activePoll
          ? <PollView poll={activePoll} onVote={vote(activePoll.id)} />
          : <section className="th-side-card"><h2><BarChart3 aria-hidden="true" />Polls</h2><p className="th-hint">{host ? "Launch a poll and it shows here and on the presenter screen." : "When a host launches a poll it shows here."}</p>
            {host && <button type="button" className="secondary-button" onClick={() => setSheet({ kind: "poll" })}><Plus aria-hidden="true" />New poll</button>}</section>}
        <section className="th-side-card">
          <h2><MonitorPlay aria-hidden="true" />Presenter view</h2>
          <p className="th-hint">Large and high contrast for a projector or screen share. It updates by itself.</p>
          <button type="button" className="secondary-button" onClick={() => go({ present: true })}><Presentation aria-hidden="true" />Present</button>
        </section>
      </aside>
    </div>}

    {tab === "polls" && <div className="th-polls">
      {host && <div className="th-polls-head"><button type="button" className="action-button" onClick={() => setSheet({ kind: "poll" })}><Plus aria-hidden="true" />New poll</button></div>}
      {state.polls.length === 0
        ? <EmptyState icon={BarChart3} title="No polls yet" action={host ? { label: "New poll", icon: Plus, onClick: () => setSheet({ kind: "poll" }) } : undefined}>{host ? "Prepare polls before the session, then launch them live." : "Polls the hosts launch show here."}</EmptyState>
        : <ol className="th-poll-list">{state.polls.map((poll) => <li key={poll.id} className="th-poll-item">
          {poll.status === "draft"
            ? <section className="ui-live th-draft"><header className="ui-live-head"><span className="ui-live-kind">{POLL_KIND_LABELS[poll.kind]}</span><span className="ui-live-state closed">Not launched</span></header><h3 className="ui-live-question">{poll.title}</h3>
              {poll.options.length > 0 && <ul className="th-draft-options">{poll.options.map((option) => <li key={option.id}>{option.label}</li>)}</ul>}</section>
            : <PollView poll={poll} onVote={host ? undefined : vote(poll.id)} />}
          {host && <div className="th-poll-tools">
            {poll.status !== "live" && session.state !== "ended" && <button type="button" className="secondary-button" onClick={() => { void run(() => townhall.launchPoll(session.id, poll.id), "Could not launch the poll", "Poll launched"); }}><CirclePlay aria-hidden="true" />{poll.status === "closed" ? "Reopen" : "Launch"}</button>}
            {poll.status === "live" && <button type="button" className="secondary-button" onClick={() => { void run(() => townhall.closePoll(session.id, poll.id), "Could not close the poll"); }}><Square aria-hidden="true" />Close</button>}
            {poll.status !== "draft" && <button type="button" className="secondary-button" aria-pressed={session.activePollId === poll.id} onClick={() => { void run(() => townhall.showOnScreen(session.id, session.activePollId === poll.id ? null : poll.id), "Could not change the screen"); }}><MonitorPlay aria-hidden="true" />{session.activePollId === poll.id ? "On screen" : "Show on screen"}</button>}
            <MoreMenu label={`More for ${poll.title}`} items={[
              { id: "results", label: poll.resultsHidden ? "Show results while live" : "Hide results until it closes", icon: poll.resultsHidden ? Eye : EyeOff, onSelect: () => { void run(() => townhall.updatePoll(session.id, poll.id, { resultsHidden: !poll.resultsHidden }), "Could not change the poll"); } },
              { id: "delete", label: "Delete poll", icon: Trash2, danger: true, onSelect: async () => { if (await askConfirm({ title: "Delete this poll?", message: "Its answers are deleted too.", confirmLabel: "Delete", danger: true })) await run(() => townhall.deletePoll(session.id, poll.id), "Could not delete the poll"); } }
            ]} />
          </div>}
        </li>)}</ol>}
    </div>}

    {tab === "recap" && <RecapTab sessionId={session.id} host={host} revision={`${session.revision}:${state.stats.questions}:${state.stats.answered}:${state.polls.length}`}
      onCards={(ids) => setSheet({ kind: "cards", questionIds: ids })} onOpenPath={props.onOpenPath} recapNote={session.recapNote} />}

    {/* The session's history and comments (D1375): members with a level only, never the audience link. */}
    {tab === "activity" && member && <div className="th-activity"><ItemTimeline kind="townhall_session" id={session.id} canComment={canCommentAtLevel(you.level)} title="Activity"
      renderers={townhallModule.activityRenderers} refreshKey={`${session.revision}:${state.stats.questions}:${state.polls.length}`} /></div>}

    {sheet?.kind === "edit" && <SessionSheet session={session} onClose={() => setSheet(null)} onSaved={() => { void live.refresh(); flash("Session saved"); }} />}
    {sheet?.kind === "poll" && <PollSheet sessionId={session.id} live={session.state === "live"} onClose={() => { setSheet(null); void live.refresh(); }} />}
    {sheet?.kind === "comments" && selectedQuestion && <CommentsSheet question={selectedQuestion} canComment={you.canComment} onClose={() => { setSheet(null); void live.refresh(); }} />}
    {sheet?.kind === "merge" && selectedQuestion && <MergeSheet source={selectedQuestion} questions={state.questions} onClose={() => setSheet(null)} onPick={async (targetId) => { await townhall.moderate(selectedQuestion.id, "merge", targetId); notify.success("Merged"); await live.refresh(); }} />}
    {sheet?.kind === "cards" && <CardsSheet sessionId={session.id} questions={sheet.questionIds.map((id) => ({ id, text: state.questions.find((question) => question.id === id)?.text ?? "" }))} onClose={() => setSheet(null)}
      onDone={(count, href) => { notify.success(count === 1 ? "Card created" : `${count} cards created`, href ? { action: { label: "Open", onClick: () => props.onOpenPath(href) } } : undefined); void live.refresh(); }} />}
    {sheet?.kind === "share" && <ShareSheet session={session} memberUrl={memberUrl} publicUrl={publicUrl} publicAllowed={Boolean(state.publicAllowed)} canManage={you.canManage}
      onAccess={() => setSheet({ kind: "access" })} onClose={() => setSheet(null)}
      onPublic={async (enabled) => { try { await townhall.setPublicLink(session.id, enabled); await live.refresh(); } catch (reason) { notify.error(errorText(reason, "Could not change the audience link")); } }} />}
    {sheet?.kind === "access" && <Suspense fallback={null}><AccessSheet kind="townhall_session" id={session.id} title={session.title} guardHistory onClose={() => setSheet(null)} onSaved={() => { flash("Access saved"); void live.refresh(); }} /></Suspense>}
    {confirmElement}
  </ModuleHome>;
}

function RecapTab({ sessionId, host, revision, onCards, onOpenPath, recapNote }: { sessionId: string; host: boolean; revision: string; onCards: (ids: string[]) => void; onOpenPath: (path: string) => void; recapNote: { href: string } | null }) {
  const [recap, setRecap] = useState<TownhallRecap | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [posting, setPosting] = useState(false);
  useEffect(() => { townhall.getRecap(sessionId).then((body) => setRecap(body.recap), (reason) => notify.error(errorText(reason, "Could not load the recap"))); }, [sessionId, revision]);
  if (!recap) return <p className="ui-panel-loading" role="status">Loading the recap…</p>;
  const open = recap.unanswered;
  const allPicked = open.length > 0 && open.every((question) => picked.has(question.id));
  const toggle = (id: string) => setPicked((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const post = async () => {
    setPosting(true);
    try { const note = await townhall.postRecapNote(sessionId); notify.success("Recap posted as a note", { action: { label: "Open", onClick: () => onOpenPath(note.href) } }); }
    catch (reason) { notify.error(errorText(reason, "Could not post the recap")); }
    finally { setPosting(false); }
  };
  return <div className="th-recap">
    <KpiRow>
      <KpiTile label="Participants" value={recap.totals.participants} hint={`${recap.totals.members} members · ${recap.totals.publicParticipants} by audience link`} />
      <KpiTile label="Questions" value={recap.totals.questions} hint={`${recap.totals.votes} upvotes`} />
      <KpiTile label="Answered" value={recap.totals.answered} />
      <KpiTile label="Still open" value={recap.totals.unanswered} />
    </KpiRow>
    <div className="th-recap-actions">
      <a className="secondary-button" href={townhall.recapDownloadUrl(sessionId, "markdown")} download><FileText aria-hidden="true" />Download recap</a>
      <a className="secondary-button" href={townhall.recapDownloadUrl(sessionId, "csv")} download><Download aria-hidden="true" />Questions CSV</a>
      {host && (recapNote
        ? <button type="button" className="secondary-button" onClick={() => onOpenPath(recapNote.href)}><FileText aria-hidden="true" />Open recap note</button>
        : <button type="button" className="secondary-button" disabled={posting} onClick={() => { void post(); }}><Pencil aria-hidden="true" />{posting ? "Posting…" : "Post as a note"}</button>)}
    </div>
    <section className="th-recap-section" aria-labelledby="th-open-title">
      <header className="ui-panel-header"><h3 id="th-open-title"><ListChecks aria-hidden="true" />Still open<span className="ui-panel-count ui-tabular"> · {open.length}</span></h3>
        {host && open.length > 0 && <div className="th-recap-tools">
          <button type="button" className="ui-text-button" onClick={() => setPicked(allPicked ? new Set() : new Set(open.map((question) => question.id)))}>{allPicked ? "Clear" : "Select all"}</button>
          <button type="button" className="secondary-button" disabled={!picked.size} onClick={() => onCards([...picked])}><SquareCheckBig aria-hidden="true" />{picked.size > 1 ? `Make ${picked.size} cards` : "Make a card"}</button>
        </div>}
      </header>
      {open.length === 0 ? <EmptyState compact as="h4" icon={ListChecks} title="Nothing open">Every question was answered.</EmptyState>
        : <ol className="th-recap-list">{open.map((question) => <li key={question.id}>
          {host && <input type="checkbox" aria-label={`Select: ${question.text}`} checked={picked.has(question.id)} onChange={() => toggle(question.id)} />}
          <span className="th-recap-votes ui-tabular">{question.votes} ▲</span>
          <span className="th-recap-text">{question.text}<small>{authorLabel(question) ?? "Anonymous"}</small></span>
          {question.card && <button type="button" className="ui-text-button" onClick={() => onOpenPath(question.card!.href)}>Card</button>}
        </li>)}</ol>}
    </section>
    <section className="th-recap-section" aria-labelledby="th-answered-title">
      <header className="ui-panel-header"><h3 id="th-answered-title"><MessageCircleQuestion aria-hidden="true" />Answered<span className="ui-panel-count ui-tabular"> · {recap.answered.length}</span></h3></header>
      {recap.answered.length === 0 ? <EmptyState compact as="h4" icon={MessageCircleQuestion} title="None answered yet">Hosts mark questions answered during the session.</EmptyState>
        : <ol className="th-recap-list">{recap.answered.map((question) => <li key={question.id}><span className="th-recap-votes ui-tabular">{question.votes} ▲</span><span className="th-recap-text">{question.text}<small>{authorLabel(question) ?? "Anonymous"}</small></span></li>)}</ol>}
    </section>
    {recap.polls.length > 0 && <section className="th-recap-section" aria-labelledby="th-polls-title">
      <header className="ui-panel-header"><h3 id="th-polls-title"><BarChart3 aria-hidden="true" />Polls<span className="ui-panel-count ui-tabular"> · {recap.polls.length}</span></h3></header>
      <div className="th-recap-polls">{recap.polls.map((poll) => <article key={poll.id} className="th-side-card">
        <h4>{poll.title}</h4>
        <p className="th-hint">{POLL_KIND_LABELS[poll.kind]} · {poll.total} {poll.total === 1 ? "answer" : "answers"}{poll.average !== null ? ` · average ${poll.average} of 5` : ""}</p>
        {poll.kind === "open_text"
          ? <ul className="th-open-list">{poll.results.map((result, index) => <li key={index}>{result.label}</li>)}</ul>
          : <ResultBars rows={poll.results.map((result, index) => ({ id: String(index), label: result.label, count: result.count }))} total={poll.results.reduce((sum, result) => sum + result.count, 0)} label={`Results of ${poll.title}`} />}
      </article>)}</div>
    </section>}
  </div>;
}
