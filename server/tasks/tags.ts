import { audit, db, now } from "../db";
import { OPTION_COLORS, type OptionColor } from "../collections/schema";
import { TASK_FLAGS, type TaskFlag } from "../../shared/taskQuery";
import { readableBoardPredicate } from "./access";
import { limitReached, ownerOnly, requireBoardAt, requireReadableBoard, TaskError, withBoardLock } from "./service";

/**
 * Board tags and card flags (WAVE_13_TASK_CARD_UX.md D109, D110, T101;
 * migration 015).
 *
 * Tags belong to one board: at most 100, names of 1–40 characters that are
 * unique case-insensitively, coloured from the Collections option palette (a
 * tag created without a colour takes the next unused one, `nextTagColor`).
 * Any reader creates a tag (while tagging a card); only the owner renames,
 * recolours, or deletes one. Deleting unlinks it from every card through the
 * `card_tags` cascade, with no Bin, and changes no card's `revision` (the tag
 * is board vocabulary, not a card field).
 *
 * A card carries at most 10 tags of its own board and any of the four fixed
 * flags. Both are card fields (D107): they change through `PATCH /cards/:k`
 * with the revision compare-and-swap, in `service.ts`, which calls the
 * helpers below inside its transaction.
 */

export const MAX_TAGS_PER_BOARD = 100;
export const MAX_TAGS_PER_CARD = 10;
export const TAG_NAME_MAX = 40;
export const TAG_COLORS = OPTION_COLORS;
/** The fixed flag set, in display order (D110), shared with the client. The `card_flags` CHECK lists the same values. */
export const CARD_FLAGS = TASK_FLAGS;
export type CardFlag = TaskFlag;

/** The colours a new tag gets when none is chosen, in order: the palette without grey. */
export const TAG_AUTO_COLORS = OPTION_COLORS.filter((color) => color !== "gray");

/**
 * The colour of a board's next tag when the caller picks none: the first colour of TAG_AUTO_COLORS
 * no tag of the board has yet, looking from the slot the board's tag count points at (so a board
 * cycles through the palette), else that slot's colour once every colour is taken. Deterministic.
 */
export function nextTagColor(existing: readonly OptionColor[]): OptionColor {
  const used = new Set(existing);
  const start = existing.length % TAG_AUTO_COLORS.length;
  for (let offset = 0; offset < TAG_AUTO_COLORS.length; offset += 1) {
    const color = TAG_AUTO_COLORS[(start + offset) % TAG_AUTO_COLORS.length]!;
    if (!used.has(color)) return color;
  }
  return TAG_AUTO_COLORS[start]!;
}

export type BoardTag = { id: string; board_id: string; name: string; color: OptionColor; card_count: number };

const tagNotFound = () => new TaskError(404, "Tag not found");

/** Case-insensitive comparison key. Stricter than the NOCASE index (ASCII only), so the index never fires first. */
const nameKey = (name: string) => name.toLowerCase();

/** Every tag of a board by name, with the number of live cards carrying it. */
export function listBoardTags(boardId: string) {
  return db.query(`SELECT t.id, t.board_id, t.name, t.color, COUNT(k.id) AS card_count
    FROM board_tags t
    LEFT JOIN card_tags ct ON ct.tag_id = t.id
    LEFT JOIN cards k ON k.id = ct.card_id AND k.deleted_at IS NULL
    WHERE t.board_id = ?
    GROUP BY t.id
    ORDER BY t.name COLLATE NOCASE, t.id`).all(boardId) as BoardTag[];
}

const boardTag = (boardId: string, tagId: string) => listBoardTags(boardId).find((tag) => tag.id === tagId)!;

/** The tag's board id if the caller can read that board, else 404 (a foreign tag looks missing, T101). */
function readableTagBoard(tagId: string, userId: string) {
  const row = db.query(`SELECT t.board_id FROM board_tags t JOIN boards b ON b.id = t.board_id WHERE t.id = $tagId AND ${readableBoardPredicate}`)
    .get({ tagId, userId }) as { board_id: string } | null;
  if (!row) throw tagNotFound();
  return row.board_id;
}

/** 409 TAG_EXISTS with the existing tag when another tag of the board has the same name, ignoring case. */
function requireFreeName(tags: BoardTag[], name: string, exceptId?: string) {
  const clash = tags.find((tag) => tag.id !== exceptId && nameKey(tag.name) === nameKey(name));
  if (clash) throw new TaskError(409, "A tag with this name already exists", "TAG_EXISTS", { tag: clash });
}

/** Anyone who edits cards (D272). A name that exists (in any case) returns 409 TAG_EXISTS with that tag, so a picker can use it. */
export function createTag(userId: string, boardId: string, input: { name: string; color?: OptionColor }) {
  return withBoardLock(boardId, () => {
    requireBoardAt(boardId, userId, "edit");
    const tags = listBoardTags(boardId);
    requireFreeName(tags, input.name);
    if (tags.length >= MAX_TAGS_PER_BOARD) throw limitReached(`A board can have up to ${MAX_TAGS_PER_BOARD} tags`);
    const id = crypto.randomUUID();
    db.transaction(() => {
      const timestamp = now();
      db.query("INSERT INTO board_tags (id, board_id, name, color, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, boardId, input.name, input.color ?? nextTagColor(tags.map((tag) => tag.color)), userId, timestamp, timestamp);
      db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(timestamp, boardId);
      audit(userId, null, "task.tag_create", { boardId, tagId: id });
    })();
    return { tag: boardTag(boardId, id) };
  });
}

/** Owner only: rename and/or recolour. Readers get 403 OWNER_ONLY, non-readers 404. */
export async function updateTag(userId: string, tagId: string, input: { name?: string; color?: OptionColor }) {
  const boardId = readableTagBoard(tagId, userId);
  return withBoardLock(boardId, () => {
    readableTagBoard(tagId, userId);
    const board = requireReadableBoard(boardId, userId);
    if (board.owner_id !== userId) throw ownerOnly();
    if (input.name !== undefined) requireFreeName(listBoardTags(boardId), input.name, tagId);
    db.transaction(() => {
      const timestamp = now();
      db.query("UPDATE board_tags SET name = COALESCE(?, name), color = COALESCE(?, color), updated_at = ? WHERE id = ?")
        .run(input.name ?? null, input.color ?? null, timestamp, tagId);
      db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(timestamp, boardId);
      audit(userId, null, "task.tag_update", { boardId, tagId, ...(input.name !== undefined ? { renamed: true } : {}), ...(input.color ? { color: input.color } : {}) });
    })();
    return { tag: boardTag(boardId, tagId) };
  });
}

/** Owner only: deletes the tag and unlinks it from every card, binned ones included (no Bin). */
export async function deleteTag(userId: string, tagId: string) {
  const boardId = readableTagBoard(tagId, userId);
  return withBoardLock(boardId, () => {
    readableTagBoard(tagId, userId);
    const board = requireReadableBoard(boardId, userId);
    if (board.owner_id !== userId) throw ownerOnly();
    const removedFrom = (db.query("SELECT COUNT(*) AS count FROM card_tags WHERE tag_id = ?").get(tagId) as { count: number }).count;
    db.transaction(() => {
      db.query("DELETE FROM board_tags WHERE id = ?").run(tagId);
      db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(now(), boardId);
      audit(userId, null, "task.tag_delete", { boardId, tagId, removedFrom });
    })();
    return { ok: true as const, removedFrom };
  });
}

// ---------------------------------------------------------------------------
// Card tag sets and flags. Called by service.ts inside the card's transaction.

function groupBy<T>(rows: Array<{ card_id: string; value: T }>) {
  const byCard = new Map<string, T[]>();
  for (const row of rows) {
    const list = byCard.get(row.card_id) ?? [];
    list.push(row.value);
    byCard.set(row.card_id, list);
  }
  return byCard;
}

const flagOrder = (flags: CardFlag[]) => [...flags].sort((a, b) => CARD_FLAGS.indexOf(a) - CARD_FLAGS.indexOf(b));

/** Tag ids of every live card on a board, in tagging order, in one grouped query (§3.1). */
export function tagIdsForBoard(boardId: string) {
  return groupBy(db.query(`SELECT ct.card_id, ct.tag_id AS value FROM card_tags ct JOIN cards k ON k.id = ct.card_id
    WHERE k.board_id = ? AND k.deleted_at IS NULL ORDER BY ct.card_id, ct.created_at, ct.rowid`).all(boardId) as Array<{ card_id: string; value: string }>);
}

export function tagIdsForCard(cardId: string) {
  return (db.query("SELECT tag_id FROM card_tags WHERE card_id = ? ORDER BY created_at, rowid").all(cardId) as Array<{ tag_id: string }>).map((row) => row.tag_id);
}

/** Flags of every live card on a board, each list in the fixed order, in one grouped query. */
export function flagsForBoard(boardId: string) {
  const byCard = groupBy(db.query(`SELECT cf.card_id, cf.flag AS value FROM card_flags cf JOIN cards k ON k.id = cf.card_id
    WHERE k.board_id = ? AND k.deleted_at IS NULL`).all(boardId) as Array<{ card_id: string; value: CardFlag }>);
  for (const [cardId, flags] of byCard) byCard.set(cardId, flagOrder(flags));
  return byCard;
}

export function flagsForCard(cardId: string) {
  return flagOrder((db.query("SELECT flag FROM card_flags WHERE card_id = ?").all(cardId) as Array<{ flag: CardFlag }>).map((row) => row.flag));
}

/**
 * The requested tag set, deduplicated in the order given: 400 above 10, and
 * 404 when any id is not a tag of this board, including a tag of another
 * board the caller can read (T39, T101).
 */
export function requireCardTags(boardId: string, ids: readonly string[]) {
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (unique.length > MAX_TAGS_PER_CARD) throw new TaskError(400, `A card can have up to ${MAX_TAGS_PER_CARD} tags`);
  if (unique.length) {
    const found = db.query(`SELECT COUNT(*) AS count FROM board_tags WHERE board_id = ? AND id IN (${unique.map(() => "?").join(",")})`)
      .get(boardId, ...unique) as { count: number };
    if (found.count !== unique.length) throw tagNotFound();
  }
  return unique;
}

/** Replaces a card's tags, keeping the rows of tags that stay so their order holds. */
export function replaceCardTags(cardId: string, tagIds: readonly string[], timestamp: string) {
  const current = tagIdsForCard(cardId);
  const removed = current.filter((id) => !tagIds.includes(id));
  const added = tagIds.filter((id) => !current.includes(id));
  const remove = db.query("DELETE FROM card_tags WHERE card_id = ? AND tag_id = ?");
  for (const id of removed) remove.run(cardId, id);
  const insert = db.query("INSERT INTO card_tags (card_id, tag_id, created_at) VALUES (?, ?, ?)");
  for (const id of added) insert.run(cardId, id, timestamp);
  return { added, removed };
}

/** Replaces a card's flags (already validated and unique). */
export function replaceCardFlags(cardId: string, flags: readonly CardFlag[], timestamp: string) {
  const current = flagsForCard(cardId);
  const removed = current.filter((flag) => !flags.includes(flag));
  const added = flags.filter((flag) => !current.includes(flag));
  const remove = db.query("DELETE FROM card_flags WHERE card_id = ? AND flag = ?");
  for (const flag of removed) remove.run(cardId, flag);
  const insert = db.query("INSERT INTO card_flags (card_id, flag, created_at) VALUES (?, ?, ?)");
  for (const flag of added) insert.run(cardId, flag, timestamp);
  return { added, removed };
}
