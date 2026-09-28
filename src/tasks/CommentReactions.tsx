import { useRef, useState } from "react";
import { SmilePlus } from "lucide-react";
import { REACTIONS, reactionGlyph, type ReactionAggregate, type ReactionKey } from "../../shared/reactions";
import { ReactionPicker } from "../ui/ReactionPicker";
import { reactionChipLabel, reactionPeople, replaceAggregate, toggleAggregate } from "./reactionsModel";
import { setCommentReaction, taskErrorCode, taskErrorMessage } from "./tasksApi";
import type { TaskNotify } from "./taskActions";

type CommentReactionsProps = {
  commentId: string;
  reactions: readonly ReactionAggregate[];
  /** Viewers and guests: static chips, no picker (the write gate refuses reactions, D185). */
  readOnly: boolean;
  /** Applies a change to this comment's reactions from their latest state. */
  onUpdate: (commentId: string, update: (current: ReactionAggregate[]) => ReactionAggregate[]) => void;
  notify: TaskNotify;
};

/** A second tap on the same emoji this soon after the first is the same gesture (a double tap). */
export const REACTION_TAP_GAP_MS = 500;

/**
 * The reaction chips under a comment (WAVES_18-20_SMALL.md §3.5). A tap toggles optimistically and
 * sends PUT or DELETE for the state it asked for (D184), so a retry never flips twice; while an emoji's
 * request is in flight, or within REACTION_TAP_GAP_MS of the last change, more taps on it are
 * ignored, so a double tap is one change even when the request is already back. On an error the
 * emoji's previous state comes back and a toast says why.
 */
export function CommentReactions({ commentId, reactions, readOnly, onUpdate, notify }: CommentReactionsProps) {
  const [picking, setPicking] = useState(false);
  const pending = useRef(new Set<ReactionKey>());
  const lastTap = useRef(new Map<ReactionKey, number>());
  const rowRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const latest = useRef(reactions);
  latest.current = reactions;

  if (readOnly && !reactions.length) return null;

  function toggle(emoji: ReactionKey) {
    const time = Date.now();
    if (pending.current.has(emoji) || time - (lastTap.current.get(emoji) ?? -Infinity) < REACTION_TAP_GAP_MS) return;
    lastTap.current.set(emoji, time);
    const before = latest.current;
    const previous = before.find((item) => item.emoji === emoji);
    const previousIndex = before.findIndex((item) => item.emoji === emoji);
    const { next, on } = toggleAggregate(before, emoji);
    pending.current.add(emoji);
    onUpdate(commentId, (current) => replaceAggregate(current, emoji, next.find((item) => item.emoji === emoji), previousIndex));
    setCommentReaction(commentId, emoji, on)
      .then(({ reactions: fresh }) => onUpdate(commentId, (current) => replaceAggregate(current, emoji, fresh.find((item) => item.emoji === emoji), fresh.findIndex((item) => item.emoji === emoji))))
      .catch((reason: unknown) => {
        onUpdate(commentId, (current) => replaceAggregate(current, emoji, previous, previousIndex));
        notify(taskErrorCode(reason) === "RATE_LIMITED" ? "Slow down a little." : taskErrorMessage(reason, "Could not update the reaction"));
      })
      .finally(() => { pending.current.delete(emoji); });
  }

  const choices = REACTIONS.map((reaction) => ({
    key: reaction.key, glyph: reaction.glyph, label: reaction.label,
    pressed: reactions.some((item) => item.emoji === reaction.key && item.reacted)
  }));

  return <div ref={rowRef} className={`task-reactions${reactions.length ? "" : " empty"}`} role="group" aria-label="Reactions">
    {reactions.map((item) => readOnly
      ? <span key={item.emoji} className="task-reaction-chip static" role="img" aria-label={reactionChipLabel(item, true)} title={reactionPeople(item)}>
        <span className="task-reaction-glyph" aria-hidden="true">{reactionGlyph(item.emoji)}</span><span aria-hidden="true">{item.count}</span>
      </span>
      : <button key={item.emoji} type="button" className={`task-reaction-chip${item.reacted ? " reacted" : ""}`} aria-pressed={item.reacted}
        aria-label={reactionChipLabel(item, false)} title={reactionPeople(item)} onClick={() => toggle(item.emoji)}>
        <span className="task-reaction-glyph" aria-hidden="true">{reactionGlyph(item.emoji)}</span><span aria-hidden="true">{item.count}</span>
      </button>)}
    {!readOnly && <button ref={addRef} type="button" className="icon-button task-reaction-add" aria-label="Add reaction" title="Add reaction"
      aria-haspopup="dialog" aria-expanded={picking} onClick={() => setPicking((open) => !open)}><SmilePlus /></button>}
    {!readOnly && picking && <ReactionPicker choices={choices} anchorRef={addRef} containerRef={rowRef}
      onPick={(key) => toggle(key as ReactionKey)} onClose={() => setPicking(false)}
      sheetSummary={reactions.length ? <ul className="task-reaction-summary" aria-label="Current reactions">
        {reactions.map((item) => <li key={item.emoji}><span aria-hidden="true">{reactionGlyph(item.emoji)}</span><span>{item.count}</span><span className="task-reaction-names">{reactionPeople(item)}</span></li>)}
      </ul> : undefined} />}
  </div>;
}
