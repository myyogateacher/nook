import { db } from "../db";
import { matchesText, normalizeFilter, type CardFilter, type QueryContext } from "../../shared/taskQuery";
import { readableBoardPredicate } from "./access";

/**
 * Server-side card filters for MCP `list_cards` (WAVE_13_TASK_CARD_UX.md
 * D113, §5.5). The semantics are those of `shared/taskQuery.ts`, which the
 * client uses over the board JSON; `tests/taskQuery.test.ts` checks that both
 * give the same card ids on one fixture.
 *
 * Every value is bound as a parameter: clauses are fixed SQL fragments and
 * only the placeholder names (`$a0`, `$a1`, …) are generated. The board is
 * joined through the readable predicate, so an unreadable board returns
 * nothing even if a caller skipped the service's own check.
 *
 * The text filter folds accents, which SQLite's ASCII `lower()` cannot, so it
 * runs over the SQL result (title and excerpt only) with the shared matcher.
 */

type Params = Record<string, string | number>;

/** `$prefix0, $prefix1, …` bound to `values`. */
function placeholders(prefix: string, values: readonly string[], params: Params) {
  return values.map((value, index) => {
    params[`${prefix}${index}`] = value;
    return `$${prefix}${index}`;
  }).join(", ");
}

/** "Any of these values, or none at all" over a card's rows in a join table. */
function setClause(table: "card_assignees" | "card_tags" | "card_flags", column: "user_id" | "tag_id" | "flag", prefix: string, set: { ids: string[]; none: boolean }, params: Params) {
  const parts: string[] = [];
  if (set.ids.length) parts.push(`EXISTS (SELECT 1 FROM ${table} j WHERE j.card_id = k.id AND j.${column} IN (${placeholders(prefix, set.ids, params)}))`);
  if (set.none) parts.push(`NOT EXISTS (SELECT 1 FROM ${table} j WHERE j.card_id = k.id)`);
  return `(${parts.join(" OR ")})`;
}

/**
 * Ids of the live cards on `boardId` that match `filter` for `context.userId`,
 * in board order (column position, card position, id), as `list_cards` lists them.
 */
export function filterBoardCardIds(boardId: string, filter: CardFilter, context: QueryContext) {
  const normalized = normalizeFilter(filter, context);
  const params: Params = { boardId, userId: context.userId };
  const where = ["k.board_id = $boardId", "k.deleted_at IS NULL", readableBoardPredicate];
  if (normalized.columns) where.push(`k.column_id IN (${placeholders("c", normalized.columns, params)})`);
  if (normalized.assignees) where.push(setClause("card_assignees", "user_id", "a", normalized.assignees, params));
  if (normalized.tags) where.push(setClause("card_tags", "tag_id", "t", normalized.tags, params));
  if (normalized.flags) {
    const flags = normalized.flags;
    // The legacy Urgent flag is the Urgent priority (D1313), OR-ed with the other values.
    const clause = flags.values.length || flags.none ? setClause("card_flags", "flag", "f", { ids: flags.values, none: flags.none }, params) : null;
    where.push(flags.urgent ? `(${clause ? `${clause} OR ` : ""}k.priority = 'urgent')` : clause ?? "0");
  }
  if (normalized.priorities) {
    const { values, none } = normalized.priorities;
    const parts = [...(values.length ? [`k.priority IN (${placeholders("p", values, params)})`] : []), ...(none ? ["k.priority IS NULL"] : [])];
    where.push(`(${parts.join(" OR ")})`);
  }
  if (normalized.due) {
    const { before, after, none } = normalized.due;
    const parts: string[] = [];
    if (before !== null || after !== null) {
      const range = ["k.due_on IS NOT NULL"];
      if (before !== null) { params.dueBefore = before; range.push("k.due_on < $dueBefore"); }
      if (after !== null) { params.dueAfter = after; range.push("k.due_on > $dueAfter"); }
      parts.push(`(${range.join(" AND ")})`);
    }
    if (none) parts.push("k.due_on IS NULL");
    where.push(`(${parts.join(" OR ")})`);
  }
  const rows = db.query(`SELECT k.id, k.title, k.description_excerpt
    FROM cards k JOIN boards b ON b.id = k.board_id JOIN board_columns c ON c.id = k.column_id
    WHERE ${where.join(" AND ")}
    ORDER BY c.position, k.position, k.id`).all(params) as Array<{ id: string; title: string; description_excerpt: string }>;
  const text = normalized.text;
  return (text === null ? rows : rows.filter((row) => matchesText(row, text))).map((row) => row.id);
}
