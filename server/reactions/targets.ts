import { db } from "../db";
import { readableBoardPredicate } from "../tasks/access";
import { canWriteContent } from "../team/userRole";

/**
 * The reaction target registry (WAVES_18-20_SMALL.md D182). A kind is a code-level registration;
 * the `reactions` table only checks its shape. v1 registers `card_comment`. A later module (Messages)
 * calls `registerReactionTarget({ kind: "message", … })` from its own file and adds its cleanup
 * trigger in its migration, with no change here or to the table.
 */
export type ReactionTarget = {
  kind: string;
  /**
   * The target as `userId` may see it, or null when it is missing, unreadable, or binned (all look
   * the same to the caller, T151). `lockKey` is the resource lock the write re-checks under.
   */
  readable: (targetId: string, userId: string) => { lockKey: string | null } | null;
  /** Whether `userId` may react to a target it can read (D185: whoever may comment). */
  writable: (targetId: string, userId: string) => boolean;
};

const targets = new Map<string, ReactionTarget>();

export const TARGET_KIND_PATTERN = /^[a-z_]{1,32}$/;

export function registerReactionTarget(target: ReactionTarget) {
  if (!TARGET_KIND_PATTERN.test(target.kind)) throw new Error(`Invalid reaction target kind: ${target.kind}`);
  if (targets.has(target.kind)) throw new Error(`Reaction target kind already registered: ${target.kind}`);
  targets.set(target.kind, target);
}

export function reactionTarget(kind: string) {
  return targets.get(kind) ?? null;
}

export function reactionTargetKinds() {
  return [...targets.keys()];
}

/** A comment on a live card of a board the caller can read (the same rule as reading the comment). */
registerReactionTarget({
  kind: "card_comment",
  readable(targetId, userId) {
    const row = db.query(`SELECT k.board_id FROM card_comments m
        JOIN cards k ON k.id = m.card_id AND k.deleted_at IS NULL JOIN boards b ON b.id = k.board_id
      WHERE m.id = $targetId AND ${readableBoardPredicate}`).get({ targetId, userId }) as { board_id: string } | null;
    return row ? { lockKey: `board:${row.board_id}` } : null;
  },
  // Any reader of the card who may write content may comment, so may react. Viewers and guests are
  // refused by the HTTP write gate first; this is the defence in depth behind it.
  writable: (_targetId, userId) => canWriteContent(userId)
});
