import { AlignLeft, CalendarDays, Link2, ListChecks, MessageSquare, OctagonAlert, Paperclip } from "lucide-react";
import { cardTags, FLAG_LABELS, visibleItems } from "./cardTags";
import { FlagIcon } from "./TagPicker";
import { Avatar } from "../ui/Avatar";
import { assigneeSentence, attachmentCountLabel, cardAssignees, commentCountLabel, dueStatus } from "./taskActions";
import type { BoardTag, CardSummary } from "./tasksApi";

/** At most this many tag chips and avatars on a lane card, then "+N" (§4.4). */
export const FACE_TAGS = 3;
export const FACE_PEOPLE = 3;

/**
 * The footer's width on a 280 px desktop lane card (the phone card is wider). The footer stays on
 * one line, so tags are budgeted against it: whole chips while they fit, then "+N" (QA 0.9.2).
 */
export const FACE_FOOTER_PX = 238;
/** Kept free on the line, so a slightly wider font never wraps it. */
const SLACK = 4;
const GAP = 5;
const TAG_GAP = 4;
/** Text widths at the tag chips' size (.68rem Inter 600), measured in Chrome and rounded up. */
const textPx = (text: string) => Array.from(text).reduce((sum, char) =>
  sum + (/[ilj.,:;'|!\- ]/.test(char) ? 3.8 : /[frt]/.test(char) ? 4.2 : /[mwMW@%]/.test(char) ? 8 : /[A-Z0-9#&]/.test(char) ? 6.8 : 6.2), 0);
/** Padding, border, and the colour dot. */
const tagPx = (name: string) => 24 + textPx(name);
const morePx = (count: number) => 12 + textPx(`+${count}`);
/** The due chip and the counts use .72rem: a little wider per character. */
const duePx = (label: string) => 30 + textPx(label) * 1.08;
const countPx = (text: string) => 16 + textPx(text) * 1.08;

/**
 * How many of the card's tags fit on the footer line beside the due chip, the counts, and the
 * avatars: whole chips only, at most `FACE_TAGS`, leaving room for "+N" when some are left over.
 * None may fit, and then only "+N" shows; a tag alone on the line always shows (and only then
 * may a name longer than the card ellipsise).
 */
export function faceTagCount(names: readonly string[], others: { due?: string | null; counts?: readonly string[]; people?: number }, width = FACE_FOOTER_PX) {
  if (names.length === 0) return 0;
  const items = [...(others.due ? [duePx(others.due)] : []), ...(others.counts ?? []).map(countPx)];
  const used = items.reduce((sum, px) => sum + px, 0) + GAP * Math.max(0, items.length - 1);
  const people = Math.min(others.people ?? 0, FACE_PEOPLE + 1);
  const room = width - SLACK - (people > 0 ? 6 + 26 + (people - 1) * 20 : 0);
  const cluster = (shown: number) => {
    const chips = names.slice(0, shown).map(tagPx);
    const left = names.length - shown;
    const parts = [...chips, ...(left > 0 ? [morePx(left)] : [])];
    return parts.reduce((sum, px) => sum + px, 0) + TAG_GAP * (parts.length - 1);
  };
  for (let shown = Math.min(names.length, FACE_TAGS); shown > 0; shown -= 1) {
    if (used + (items.length ? GAP : 0) + cluster(shown) <= room) return shown;
  }
  return items.length === 0 && people === 0 ? 1 : 0;
}

type FaceInput = {
  card: CardSummary; tags: readonly BoardTag[]; done: boolean; today: string;
  /** Hierarchy (17A, §7.3): the parent's title (its chip is a button next to the face), and the children's roll-up. */
  parentTitle?: string | null;
  rollup?: { done: number; total: number } | null;
  /** What the children are called, lower case ("subtasks"). */
  childLabel?: string;
};

/** "Asha", "Asha and Ben", "Asha, Ben, and Chen": every name, for screen readers. */
function listSentence(names: readonly string[]) {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

const lowerFirst = (text: string) => text ? text[0]!.toLowerCase() + text.slice(1) : text;
const relatedLabel = (count: number) => count === 1 ? "1 related card" : `${count} related cards`;
const blockerLabel = (count: number) => count === 1 ? "blocked by 1 open card" : `blocked by ${count} open cards`;

/** Initials for an avatar: the first letters of the first and last words ("Asha Rao" → "AR"). */
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = Array.from(words[0] ?? "?")[0] ?? "?";
  const last = words.length > 1 ? Array.from(words[words.length - 1]!)[0] ?? "" : "";
  return (first + last).toUpperCase();
}

/** One of six avatar tones, stable per person. */
export function avatarTone(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 6;
}

/**
 * The lane card's accessible name, everything in the face's order: "Fix login, urgent, due
 * tomorrow at 17:00, tags Backend, assigned to Asha and Ben, 2 comments". The excerpt is its
 * description instead.
 */
export function cardFaceLabel({ card, tags, done, today, parentTitle, rollup, childLabel = "subtasks" }: FaceInput) {
  const parts = [card.title];
  if (parentTitle) parts.push(`in ${parentTitle}`);
  if (rollup?.total) parts.push(`${rollup.done} of ${rollup.total} ${childLabel} done`);
  for (const flag of card.flags ?? []) parts.push(FLAG_LABELS[flag].toLowerCase());
  const due = dueStatus(card.due_on, today, done, { dueAt: card.due_at });
  if (due) parts.push(lowerFirst(due.description));
  const names = cardTags(card.tag_ids, tags).map((tag) => tag.name);
  if (names.length) parts.push(`${names.length === 1 ? "tag" : "tags"} ${listSentence(names)}`);
  const people = cardAssignees(card).map((person) => person.display_name);
  if (people.length) parts.push(`assigned to ${listSentence(people)}`);
  if (card.comment_count > 0) parts.push(commentCountLabel(card.comment_count));
  if (card.attachment_count > 0) parts.push(attachmentCountLabel(card.attachment_count));
  if (card.relation_count) parts.push(relatedLabel(card.relation_count));
  if (card.open_blockers) parts.push(blockerLabel(card.open_blockers));
  return parts.join(", ");
}

/**
 * What a lane card shows (WAVE_13_TASK_CARD_UX.md §4.4; operator QA 0.9.1), in three rows: the
 * title (2 lines) with the flag icons inline before it, the description excerpt (2 lines, 1 on
 * phones), and one footer line: on the left the due chip, as many whole tags as fit (at most 3,
 * then "+N"; `faceTagCount`), the counts, and the subtask roll-up; on the right up to 3 assignee
 * avatars on the same line (it wraps only when the due chip, counts, and avatars alone overflow).
 * Empty rows are left out. The card's `aria-label` reads it all
 * (`cardFaceLabel`), so the face itself is hidden from screen readers; `excerptId` lets the card
 * point its description at the excerpt.
 */
export function CardFace({ card, tags, done, today, excerptId, rollup, childLabel = "subtasks" }: FaceInput & { excerptId: string }) {
  const flags = card.flags ?? [];
  const excerpt = card.description_excerpt?.trim() ?? "";
  const due = dueStatus(card.due_on, today, done, { dueAt: card.due_at });
  const allTags = cardTags(card.tag_ids, tags);
  const people = cardAssignees(card);
  const children = rollup && rollup.total > 0 ? rollup : null;
  const countTexts = [
    ...(card.has_description === 1 && !excerpt ? [""] : []),
    ...(card.comment_count > 0 ? [String(card.comment_count)] : []),
    ...(card.attachment_count > 0 ? [String(card.attachment_count)] : []),
    ...(card.relation_count ? [String(card.relation_count)] : []),
    ...(card.open_blockers ? [String(card.open_blockers)] : []),
    ...(children ? [`${children.done}/${children.total}`] : [])
  ];
  const tagList = visibleItems(allTags, faceTagCount(allTags.map((tag) => tag.name), { due: due?.label, counts: countTexts, people: people.length }));
  const shownPeople = visibleItems(people, FACE_PEOPLE);
  const assigned = people.length ? `Assigned to ${assigneeSentence(people.map((person) => person.display_name))}` : "";
  const counts = (card.has_description === 1 && !excerpt) || card.comment_count > 0 || card.attachment_count > 0 || Boolean(card.relation_count) || Boolean(card.open_blockers);
  const meta = due || allTags.length > 0 || counts || people.length > 0 || children;
  const subtasks = children && <span className={`task-subtask-chip${children.done === children.total ? " complete" : ""}`} title={`${children.done} of ${children.total} ${childLabel} done`}><ListChecks />{children.done}/{children.total}</span>;
  const main = due || allTags.length > 0 || counts || children;

  return <div className="task-card-face" aria-hidden="true">
    <span className="task-card-title">
      {flags.length > 0 && <span className="task-card-flags">
        {flags.map((flag) => <span key={flag} className="task-card-flag" title={FLAG_LABELS[flag]}><FlagIcon flag={flag} /></span>)}
      </span>}
      {card.title}
    </span>
    {excerpt && <span id={excerptId} className="task-card-excerpt">{excerpt}</span>}
    {meta && <span className="task-card-meta">
      {main && <span className="task-card-meta-main">
        {due && <span className={`task-due-chip ${due.tone}`} title={due.description}><CalendarDays />{due.label}</span>}
        {allTags.length > 0 && <span className="task-card-tags">
          {tagList.shown.map((tag) => <span key={tag.id} className={`task-tag color-${tag.color}`} title={tag.name}>{tag.name}</span>)}
          {tagList.more > 0 && <span className="task-card-more-tags" title={allTags.slice(tagList.shown.length).map((tag) => tag.name).join(", ")}>+{tagList.more}</span>}
        </span>}
        {card.has_description === 1 && !excerpt && <span className="task-card-count" title="Has a description"><AlignLeft /></span>}
        {card.comment_count > 0 && <span className="task-card-count" title={commentCountLabel(card.comment_count)}><MessageSquare />{card.comment_count}</span>}
        {card.attachment_count > 0 && <span className="task-card-count" title={attachmentCountLabel(card.attachment_count)}><Paperclip />{card.attachment_count}</span>}
        {Boolean(card.relation_count) && <span className="task-card-count" title={relatedLabel(card.relation_count!)}><Link2 />{card.relation_count}</span>}
        {Boolean(card.open_blockers) && <span className="task-card-count task-card-blockers" title={`B${blockerLabel(card.open_blockers!).slice(1)}`}><OctagonAlert />{card.open_blockers}</span>}
        {subtasks}
      </span>}
      {people.length > 0 && <span className="task-card-people" title={assigned}>
        {shownPeople.shown.map((person) => <Avatar key={person.id} className={`task-avatar tone-${avatarTone(person.id)}${person.can_read === 0 ? " former" : ""}`} name={person.display_name} url={person.avatar_url} fallback={initials(person.display_name)} />)}
        {shownPeople.more > 0 && <span className="task-avatar task-avatar-more">+{shownPeople.more}</span>}
      </span>}
    </span>}
  </div>;
}
