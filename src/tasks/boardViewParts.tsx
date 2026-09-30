import { useSyncExternalStore, type ReactNode } from "react";
import { CalendarDays } from "lucide-react";
import { avatarTone, FACE_PEOPLE, FACE_TAGS, initials } from "./CardFace";
import { cardTags, FLAG_LABELS, visibleItems } from "./cardTags";
import { FlagIcon } from "./TagPicker";
import { Avatar } from "../ui/Avatar";
import type { BoardCard, BoardData } from "./boardQuery";
import { dueStatus } from "./taskActions";
import type { CardAssignee, CardFlag } from "./tasksApi";

// Small read-only pieces the table, list, and calendar views share, drawn like the lane card face
// (CardFace.tsx, §4.4): the same flag icons, tag chips, due chip, and assignee avatars. Every label
// is React text (T98).

/** The card's flags as icons, each named for screen readers. */
export function FlagIcons({ flags }: { flags: readonly string[] }) {
  const known = flags.filter((flag): flag is CardFlag => flag in FLAG_LABELS);
  if (!known.length) return null;
  return <span className="task-flags">
    {known.map((flag) => <span key={flag} className="task-flag" role="img" aria-label={FLAG_LABELS[flag]} title={FLAG_LABELS[flag]}><FlagIcon flag={flag} /></span>)}
  </span>;
}

/** Up to `max` tag chips in the board's colours, then "+N"; named as one group. */
export function TagChips({ tagIds, board, max = FACE_TAGS }: { tagIds: readonly string[]; board: BoardData; max?: number }) {
  const tags = cardTags(tagIds, board.tags as Parameters<typeof cardTags>[1]);
  if (!tags.length) return null;
  const { shown, more } = visibleItems(tags, max);
  return <span className="task-tags" aria-label={`Tags ${tags.map((tag) => tag.name).join(", ")}`} role="group">
    {shown.map((tag) => <span key={tag.id} className={`task-tag color-${tag.color}`} aria-hidden="true">{tag.name}</span>)}
    {more > 0 && <span className="task-tag more" aria-hidden="true">+{more}</span>}
  </span>;
}

export function DueChip({ card, today, done }: { card: BoardCard; today: string; done: boolean }) {
  const due = dueStatus(card.due_on, today, done, { dueAt: card.due_at });
  if (!due) return null;
  return <span className={`task-due-chip ${due.tone}`} title={due.description}><CalendarDays aria-hidden="true" /><span aria-hidden="true">{due.label}</span><span className="sr-only">{due.description}</span></span>;
}

export function assigneeNames(card: BoardCard) {
  return card.assignees.map((person) => person.can_read === 1 ? person.display_name : `${person.display_name} (no access)`);
}

/** Up to three assignee avatars (initials in a stable tone), then "+N", as on the lane card. */
export function Avatars({ card }: { card: BoardCard }) {
  if (!card.assignees.length) return null;
  const { shown, more } = visibleItems<CardAssignee>(card.assignees, FACE_PEOPLE);
  return <span className="task-card-people" aria-hidden="true">
    {shown.map((person) => <Avatar key={person.id} className={`task-avatar tone-${avatarTone(person.id)}${person.can_read === 0 ? " former" : ""}`} name={person.display_name} url={person.avatar_url} fallback={initials(person.display_name)} integration={person.is_integration} />)}
    {more > 0 && <span className="task-avatar task-avatar-more">+{more}</span>}
  </span>;
}

export function shortTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const finePointerQuery = "(any-pointer: fine)";
function subscribeFinePointer(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const list = window.matchMedia(finePointerQuery);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}
const finePointerSnapshot = () => typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia(finePointerQuery).matches;

/** True unless every pointer is coarse (a phone or tablet without a mouse or trackpad). */
export function useFinePointer() {
  return useSyncExternalStore(subscribeFinePointer, finePointerSnapshot, () => true);
}

/**
 * The screen-reader hint for Alt+Arrow moves (cards reference it by id with aria-describedby). On a
 * touch-only device there is no Alt key, so it stays empty and describes nothing.
 */
export function KeyboardMoveHint({ id, children }: { id: string; children: ReactNode }) {
  const fine = useFinePointer();
  return <p id={id} className="sr-only">{fine ? children : null}</p>;
}
