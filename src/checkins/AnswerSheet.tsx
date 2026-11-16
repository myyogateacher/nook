import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronLeft, ChevronRight, History, Lightbulb, Lock, OctagonX, Undo2 } from "lucide-react";
import { QuestionInput } from "../ui/questions/QuestionInput";
import { WorkRefChip } from "../ui/links/WorkLinks";
import { evaluateLogic, validateAnswers, type Answers, type AnswerValue, type Question, type QuestionSet } from "../../shared/questions";
import type { AnswerPrefill, CheckinDetail, RoundView } from "../../shared/checkins";
import type { WorkSummary } from "../../shared/workRefs";
import type { WorkspaceAppProps } from "../workspaceModules/types";
import { answerRound, errorText, fieldErrors, roundByDate, roundPrefill, skipRound, unblock } from "./api";
import { dateText, timeText } from "./parts";
import { GoalUpdates, goalUpdatesOf, useGoalTargets, type GoalValues } from "./GoalUpdates";

/**
 * The answer sheet (§D.4 UI): a page on desktop, one question per step with progress dots on phones.
 * Roles get smart help (D936): "done" offers the cards you finished and last time's plan, "plan" your
 * cards in progress or due, "blockers" a one-tap "No blockers", your planned cards, and "Unblock" for
 * cards still flagged from last time, "goal_update" your goals' key results (values become goal
 * check-ins, C5). Every text question can take "Same as last time". Nothing is posted until you press
 * Submit (⌘/Ctrl+Enter).
 */

const phoneQuery = "(max-width: 760px)";
const usePhone = () => {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia?.(phoneQuery).matches);
  useEffect(() => {
    const media = window.matchMedia?.(phoneQuery);
    if (!media) return;
    const change = () => setPhone(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return phone;
};

/** A card as answer text: its key (the answer shows it as a chip with the title), else its title. */
const cardLine = (card: WorkSummary) => card.key ?? card.title;
const appendLine = (value: AnswerValue | undefined, line: string) => {
  const text = typeof value === "string" ? value.trimEnd() : "";
  if (text.split("\n").some((existing) => existing.trim() === line.trim())) return text;
  return text ? `${text}\n${line}` : line;
};

export function AnswerSheet({ detail, date, onDone, onCancel, onOpenPath }: WorkspaceAppProps & { detail: CheckinDetail; date: string; onDone: (message: string) => void; onCancel: () => void }) {
  const [round, setRound] = useState<RoundView | null>(null);
  const [prefill, setPrefill] = useState<AnswerPrefill | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [unblocked, setUnblocked] = useState<string[]>([]);
  const [goalValues, setGoalValues] = useState<GoalValues>({});
  const phone = usePhone();
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let live = true;
    roundByDate(detail.id, date).then(async (view) => {
      const fill = await roundPrefill(view.round.id);
      if (!live) return;
      setRound(view);
      setPrefill(fill);
      if (fill.current) setAnswers(fill.current.answers);
    }).catch((reason) => { if (live) setFailure(errorText(reason, "This round could not be opened")); });
    return () => { live = false; };
  }, [detail.id, date]);

  const set: QuestionSet | null = round ? round.sets[String(Math.max(...Object.keys(round.sets).map(Number)))] ?? null : null;
  const goalTargets = useGoalTargets(Boolean(set?.questions.some((question) => question.role === "goal_update")) && !detail.anonymous);
  const visible = useMemo(() => set ? evaluateLogic(set, answers).visible.map((id) => set.questions.find((question) => question.id === id)!).filter(Boolean) : [], [set, answers]);

  const submit = async () => {
    if (!set || !round) return;
    const check = validateAnswers(set, answers, { audience: "member" });
    if (!check.ok) {
      setErrors(check.errors);
      const firstBad = visible.findIndex((question) => check.errors[question.id]);
      if (phone && firstBad >= 0) setStep(firstBad);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const goalUpdates = goalUpdatesOf(goalValues);
      const result = await answerRound(round.round.id, answers, prefill?.current?.revision, goalUpdates);
      const goals = goalUpdates.length ? `; ${goalUpdates.length} goal${goalUpdates.length === 1 ? "" : "s"} checked in` : "";
      onDone(result.edited ? `Your answer is updated${goals}` : result.blockers ? `Answer posted; ${result.blockers} blocker${result.blockers === 1 ? "" : "s"} linked${goals}` : `Answer posted${goals}`);
    } catch (reason) {
      setErrors(fieldErrors(reason));
      setFailure(errorText(reason, "Your answer could not be posted"));
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
      if (event.key === "Escape" && !event.defaultPrevented && !busy) { event.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (failure && !round) return <main className="app-page standup-sheet"><p className="standup-error" role="alert">{failure}</p><button type="button" className="action-button secondary" onClick={onCancel}>Back</button></main>;
  if (!round || !set || !prefill) return <main className="app-page standup-sheet" aria-busy="true"><p className="sr-only" role="status">Loading your answer…</p></main>;

  const update = (question: Question, value: AnswerValue | undefined | ((current: AnswerValue | undefined) => AnswerValue | undefined)) => {
    setAnswers((current) => {
      const next = { ...current };
      const resolved = typeof value === "function" ? value(current[question.id]) : value;
      if (resolved === undefined) delete next[question.id]; else next[question.id] = resolved;
      return next;
    });
    setErrors((current) => { const next = { ...current }; delete next[question.id]; return next; });
  };
  const closedFor = !round.you?.canAnswer;
  const editing = Boolean(prefill.current);

  const helpers = (question: Question) => {
    const value = answers[question.id];
    const isText = question.type === "long_text" || question.type === "short_text";
    const last = prefill.lastAnswers?.[question.id];
    const chips: Array<{ card: WorkSummary }> = [];
    if (isText && (question.role === "done" || question.prefill === "suggest_cards_done")) chips.push(...prefill.doneCards.map((card) => ({ card })));
    if (isText && (question.role === "plan" || question.prefill === "suggest_cards_planned" || question.role === "blockers")) chips.push(...prefill.plannedCards.map((card) => ({ card })));
    const unique = chips.filter((chip, index) => chips.findIndex((other) => other.card.id === chip.card.id) === index).slice(0, 8);
    return <div className="standup-helpers">
      {question.role === "goal_update" && goalTargets && <GoalUpdates targets={goalTargets} values={goalValues} onChange={setGoalValues} onOpenPath={onOpenPath} />}
      {question.role === "blockers" && isText && <button type="button" className="ui-filter-chip" aria-pressed={value === "None"} onClick={() => update(question, "None")}><Check aria-hidden="true" />No blockers</button>}
      {question.role === "done" && isText && prefill.lastPlan && <button type="button" className="ui-filter-chip" onClick={() => update(question, (current) => appendLine(current, prefill.lastPlan!))}><History aria-hidden="true" />Last time's plan</button>}
      {isText && typeof last === "string" && last && <button type="button" className="ui-filter-chip" onClick={() => update(question, last)}><Undo2 aria-hidden="true" />Same as last time</button>}
      {unique.length > 0 && <div className="standup-suggestions" role="group" aria-label={question.role === "done" ? "Cards you finished" : "Your cards"}>
        <span className="standup-muted"><Lightbulb aria-hidden="true" />{question.role === "done" ? "You finished" : question.role === "blockers" ? "Blocked on one of these?" : "Your cards"}</span>
        {unique.map(({ card }) => <button key={card.id} type="button" className="standup-suggestion" onClick={() => update(question, (current) => appendLine(current, cardLine(card)))} title={`Add ${cardLine(card)}`}>
          {card.key && <span className="standup-key">{card.key}</span>}<span>{card.title}</span>
        </button>)}
      </div>}
      {question.role === "blockers" && prefill.openBlockers.filter((card) => !unblocked.includes(card.id)).length > 0 && <div className="standup-suggestions" role="group" aria-label="Still blocked from last time">
        <span className="standup-muted"><OctagonX aria-hidden="true" />Still flagged from last time</span>
        {prefill.openBlockers.filter((card) => !unblocked.includes(card.id)).map((card) => <span key={card.id} className="standup-unblock">
          <WorkRefChip summary={card} onOpen={onOpenPath} />
          <button type="button" className="ui-text-button" onClick={() => { unblock(detail.id, card.id).then(() => setUnblocked((ids) => [...ids, card.id])).catch(() => undefined); }}>Unblock</button>
        </span>)}
      </div>}
    </div>;
  };

  const field = (question: Question, index: number) => {
    const labelId = `standup-q-${question.id}`;
    return <div key={question.id} className={`standup-field${errors[question.id] ? " invalid" : ""}`}>
      <label id={labelId} className="standup-field-title">
        {phone && <span className="standup-muted">{index + 1} of {visible.length}</span>}
        <span><strong>{question.title}</strong>{question.required && <span className="standup-required" aria-label="required">*</span>}</span>
      </label>
      {question.help && <p className="standup-muted" id={`${labelId}-help`}>{question.help}</p>}
      <QuestionInput question={question} value={answers[question.id]} onChange={(value) => update(question, value)} labelId={labelId} describedBy={question.help ? `${labelId}-help` : undefined} invalid={Boolean(errors[question.id])}
        mentionTarget={!detail.anonymous && round ? { kind: "checkin_round", id: round.round.id } : null} mentionNoun="standup" />
      {errors[question.id] && <p className="ui-field-error" role="alert">{errors[question.id]}</p>}
      {helpers(question)}
    </div>;
  };

  const current = visible[Math.min(step, visible.length - 1)];
  return <main className="app-page standup-sheet">
    <header className="standup-sheet-head">
      <button type="button" className="standup-icon-button" onClick={onCancel} aria-label="Back to the round"><ArrowLeft /></button>
      <div>
        <h1>{detail.name}</h1>
        <p className="standup-muted">{dateText(date, true)}{round.you ? ` · ${Date.parse(round.you.deadlineAt) > Date.now() ? `due by ${timeText(round.you.deadlineAt)}` : "late answers still count"}` : ""}</p>
      </div>
    </header>
    {detail.anonymous && <p className="standup-notice"><Lock aria-hidden="true" />Anonymous: your answer is never shown with your name, and results show from 3 answers on.</p>}
    {!round.you && <p className="standup-error" role="alert">You're not taking part in this round.</p>}
    {closedFor && round.you && <p className="standup-error" role="alert">This round no longer takes answers.</p>}
    <form noValidate ref={formRef} className="standup-form" onSubmit={(event) => { event.preventDefault(); if (phone && step < visible.length - 1) setStep(step + 1); else void submit(); }} aria-label={`Answer ${detail.name}`}>
      {phone ? <>
        <ol className="standup-dots" aria-label={`Question ${Math.min(step, visible.length - 1) + 1} of ${visible.length}`}>
          {visible.map((question, index) => <li key={question.id} className={index === step ? "current" : answers[question.id] !== undefined ? "done" : ""} />)}
        </ol>
        {current && field(current, Math.min(step, visible.length - 1))}
      </> : visible.map((question, index) => field(question, index))}
      {failure && <p className="standup-error" role="alert">{failure}</p>}
      <footer className="standup-sheet-actions">
        {phone && step > 0 && <button type="button" className="action-button secondary" onClick={() => setStep(step - 1)}><ChevronLeft aria-hidden="true" />Back</button>}
        {!editing && round.you?.status === "pending" && !phone && <button type="button" className="action-button secondary" disabled={busy || closedFor}
          onClick={() => { skipRound(round.round.id).then(() => onDone("Skipped this round")).catch((reason) => setFailure(errorText(reason, "Could not skip"))); }}>Skip this round</button>}
        <span className="standup-spacer" />
        {phone && step < visible.length - 1
          ? <button type="submit" className="action-button">Next<ChevronRight aria-hidden="true" /></button>
          : <button type="submit" className="action-button" disabled={busy || closedFor || !round.you} aria-keyshortcuts="Control+Enter Meta+Enter">{busy ? "Posting…" : editing ? "Update answer" : "Post answer"}</button>}
      </footer>
    </form>
  </main>;
}
