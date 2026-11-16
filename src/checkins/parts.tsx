import { Fragment, useRef, useState, type ReactNode } from "react";
import { MentionText } from "../ui/mentions/Mentions";
import { Clock3, MessageSquare, SmilePlus } from "lucide-react";
import { Avatar } from "../ui/Avatar";
import { WorkRefChip } from "../ui/links/WorkLinks";
import { ItemTimeline } from "../ui/activity/ItemTimeline";
import { ReactionPicker } from "../ui/ReactionPicker";
import { REACTIONS, reactionGlyph } from "../../shared/reactions";
import { PARTICIPATION_LABELS, type AnswerView, type CheckinPerson, type CheckinSchedule, type ParticipationState } from "../../shared/checkins";
import type { AnswerValue, Question, QuestionSet } from "../../shared/questions";
import { setAnswerReaction } from "./api";

/** Shared pieces of the Standups screens: people, answer text with card chips, answers with reactions and threads. */

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Weekdays at 09:30 · your time", "Fri at 15:00 · Europe/Berlin, every 2 weeks". */
export function cadenceText(schedule: CheckinSchedule) {
  const days = [...schedule.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const set = days.join(",");
  const daysText = days.length === 7 ? "Every day" : set === "1,2,3,4,5" ? "Weekdays" : days.map((day) => DAY_SHORT[day]).join(", ");
  return `${daysText} at ${schedule.at} · ${schedule.zoneMode === "each" ? "your time" : schedule.tz.replace(/_/g, " ")}${schedule.everyNWeeks > 1 ? `, every ${schedule.everyNWeeks} weeks` : ""}`;
}

/** "Tue 14 Jan" (a round date). */
export const dateText = (date: string, long = false) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: long ? "long" : "short", day: "numeric", month: long ? "long" : "short", timeZone: "UTC" });
export const timeText = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
export function relativeDeadline(iso: string, now = Date.now()) {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (minutes <= 0) return "Past the deadline";
  if (minutes < 60) return `Due in ${minutes} min`;
  if (minutes < 60 * 12 && new Date(iso).toDateString() === new Date(now).toDateString()) return `Due by ${timeText(iso)}`;
  if (minutes < 60 * 24) return `Due in ${Math.round(minutes / 60)} h`;
  return `Due ${new Date(iso).toLocaleDateString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
}

export function PersonFace({ person, size = "normal" }: { person: CheckinPerson; size?: "normal" | "small" }) {
  return <Avatar className={`standup-avatar${size === "small" ? " small" : ""}`} name={person.name} url={person.avatarUrl} />;
}

export function Faces({ people, max = 5, label }: { people: readonly CheckinPerson[]; max?: number; label: string }) {
  const extra = people.length - max;
  return <span className="standup-faces" role="img" aria-label={label} title={people.map((person) => person.name).join(", ")}>
    {people.slice(0, max).map((person) => <PersonFace key={person.id} person={person} size="small" />)}
    {extra > 0 && <span className="standup-faces-more" aria-hidden="true">+{extra}</span>}
  </span>;
}

export const STATE_TONE: Record<ParticipationState, string> = { answered: "success", late: "warning", skipped: "neutral", out: "info", pending: "neutral" };

export function StateBadge({ state, closed = false }: { state: ParticipationState; closed?: boolean }) {
  const label = state === "pending" && closed ? "No answer" : PARTICIPATION_LABELS[state];
  return <span className={`standup-state tone-${state === "pending" && closed ? "danger" : STATE_TONE[state]}`}>{label}</span>;
}

/** Answer text with its refs (card keys, links) as chips; line breaks kept. */
export function RefText({ text, refs, onOpen }: { text: string; refs: AnswerView["refs"]; onOpen: (href: string) => void }) {
  const known = refs.filter((ref) => text.includes(ref.text)).sort((a, b) => b.text.length - a.text.length);
  // @mentions show as chips (docs/plan/MENTIONS.md, phase B).
  if (!known.length) return <span className="standup-text"><MentionText text={text} /></span>;
  const pattern = new RegExp(`(${known.map((ref) => ref.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  const parts = text.split(pattern);
  return <span className="standup-text">{parts.map((part, index) => {
    const ref = known.find((item) => item.text === part);
    return ref ? <WorkRefChip key={index} summary={ref.summary} onOpen={onOpen} /> : <Fragment key={index}><MentionText text={part} /></Fragment>;
  })}</span>;
}

const MOOD_FACES = ["😞", "🙁", "😐", "🙂", "😄"];

/** One answer value as text (choices by label, ratings as faces or n/max). */
export function answerValue(question: Question | undefined, value: AnswerValue, refs: AnswerView["refs"], onOpen: (href: string) => void): ReactNode {
  if (typeof value === "string") {
    if (question && ["single_choice", "dropdown", "yes_no"].includes(question.type)) return question.type === "yes_no" ? (value === "yes" ? "Yes" : "No") : question.options?.find((option) => option.id === value)?.label ?? "Removed option";
    return <RefText text={value} refs={refs} onOpen={onOpen} />;
  }
  if (typeof value === "number") {
    const max = question?.scale?.max ?? 5;
    const min = question?.scale?.min ?? 1;
    if (question?.scale?.icon === "emoji" || question?.role === "mood") {
      const face = MOOD_FACES[Math.round(((value - min) / Math.max(1, max - min)) * (MOOD_FACES.length - 1))];
      return <span className="standup-mood" aria-label={`${value} of ${max}`}><span aria-hidden="true">{face}</span> <span className="ui-tabular">{value}/{max}</span></span>;
    }
    if (question?.scale?.icon === "star") return <span aria-label={`${value} of ${max} stars`}>{"★".repeat(value)}<span className="standup-muted">{"★".repeat(Math.max(0, max - value))}</span></span>;
    return <span className="ui-tabular">{value}{question?.type === "rating" || question?.type === "scale" ? ` / ${max}` : ""}</span>;
  }
  if (Array.isArray(value)) {
    const cards = refs.filter((ref) => value.includes(ref.text));
    if (cards.length) return <span className="standup-chips">{cards.map((ref) => <WorkRefChip key={ref.text} summary={ref.summary} onOpen={onOpen} />)}</span>;
    return value.map((id) => question?.options?.find((option) => option.id === id)?.label ?? id).join(", ");
  }
  if (value && typeof value === "object" && "options" in value) return [...(value.options as string[]).map((id) => question?.options?.find((option) => option.id === id)?.label ?? "Removed option"), ...("other" in value && value.other ? [String(value.other)] : [])].join(", ");
  return JSON.stringify(value);
}

function AnswerReactions({ answer, readOnly }: { answer: AnswerView; readOnly: boolean }) {
  const [reactions, setReactions] = useState(answer.reactions);
  const [picking, setPicking] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  if (!answer.id || (readOnly && !reactions.length)) return null;
  const toggle = (emoji: string) => {
    const current = reactions.find((item) => item.emoji === emoji);
    const on = !current?.reacted;
    const optimistic = on
      ? current ? reactions.map((item) => item.emoji === emoji ? { ...item, count: item.count + 1, reacted: true } : item) : [...reactions, { emoji, count: 1, reacted: true, names: [] }]
      : reactions.map((item) => item.emoji === emoji ? { ...item, count: item.count - 1, reacted: false } : item).filter((item) => item.count > 0);
    const before = reactions;
    setReactions(optimistic);
    setAnswerReaction(answer.id!, emoji, on).then((result) => setReactions(result.reactions.map(({ emoji: key, count, reacted, names }) => ({ emoji: key, count, reacted, names })))).catch(() => setReactions(before));
  };
  const choices = REACTIONS.map((reaction) => ({ key: reaction.key, glyph: reaction.glyph, label: reaction.label, pressed: reactions.some((item) => item.emoji === reaction.key && item.reacted) }));
  return <div ref={rowRef} className="standup-reactions" role="group" aria-label="Reactions">
    {reactions.map((item) => <button key={item.emoji} type="button" className={`standup-reaction${item.reacted ? " reacted" : ""}`} aria-pressed={item.reacted} disabled={readOnly}
      aria-label={`${REACTIONS.find((reaction) => reaction.key === item.emoji)?.label ?? item.emoji}: ${item.count}`} title={item.names.join(", ")} onClick={() => toggle(item.emoji)}>
      <span aria-hidden="true">{reactionGlyph(item.emoji as never)}</span><span className="ui-tabular">{item.count}</span>
    </button>)}
    {!readOnly && <button ref={addRef} type="button" className="standup-icon-button" aria-label="Add reaction" title="Add reaction" aria-haspopup="dialog" aria-expanded={picking} onClick={() => setPicking((open) => !open)}><SmilePlus /></button>}
    {!readOnly && picking && <ReactionPicker choices={choices} anchorRef={addRef} containerRef={rowRef} onPick={(key) => toggle(key)} onClose={() => setPicking(false)} />}
  </div>;
}

/** One person's answer: who and when, each question's answer, reactions, and the thread. */
export function AnswerCard({ answer, set, onOpen, canComment, header }: { answer: AnswerView; set: QuestionSet | undefined; onOpen: (href: string) => void; canComment: boolean; header?: ReactNode }) {
  const [thread, setThread] = useState(false);
  const questions = set?.questions ?? [];
  const entries = questions.filter((question) => answer.answers[question.id] !== undefined && question.type !== "statement");
  return <article className="standup-answer" aria-label={answer.person ? `${answer.person.name}'s answer` : "An anonymous answer"}>
    {header}
    {answer.person && <header className="standup-answer-head">
      <PersonFace person={answer.person} />
      <strong>{answer.person.name}</strong>
      {answer.submittedAt && <span className="standup-muted"><Clock3 aria-hidden="true" />{timeText(answer.submittedAt)}</span>}
      {answer.late && <span className="standup-state tone-warning">Late</span>}
      {answer.updatedAt && answer.submittedAt && answer.updatedAt !== answer.submittedAt && <span className="standup-muted">edited</span>}
    </header>}
    <dl className="standup-answer-body">
      {entries.map((question) => <div key={question.id} className={question.role === "blockers" ? "standup-qa blockers" : "standup-qa"}>
        <dt>{question.title}</dt>
        <dd>{answerValue(question, answer.answers[question.id]!, answer.refs, onOpen)}</dd>
      </div>)}
    </dl>
    {answer.id && <footer className="standup-answer-foot">
      <AnswerReactions answer={answer} readOnly={!canComment} />
      <button type="button" className="ui-text-button standup-thread-toggle" aria-expanded={thread} onClick={() => setThread((open) => !open)}>
        <MessageSquare aria-hidden="true" />{answer.commentCount ? `${answer.commentCount} comment${answer.commentCount === 1 ? "" : "s"}` : "Comment"}
      </button>
    </footer>}
    {answer.id && thread && <div className="standup-thread"><ItemTimeline kind="checkin_round" id={answer.id} canComment={canComment} title="Thread" /></div>}
  </article>;
}
