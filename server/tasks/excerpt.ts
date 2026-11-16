import { db } from "../db";
import { searchText } from "../search";
import { MENTION_PATTERN } from "../../shared/itemActivity";

/**
 * Card description excerpts (WAVE_13_TASK_CARD_UX.md D111). The board payload
 * carries `description_excerpt`, at most 160 characters of plain text, and
 * never the descriptions themselves (up to 64 KiB each).
 *
 * The service writes the excerpt with every description write (create and
 * patch). Migration 015 only added the column (default ''), so cards written
 * before it are filled by `reconcileCardExcerpts()` at boot (the D34 pattern).
 */

export const EXCERPT_MAX_CHARS = 160;

/**
 * Plain text from Markdown with `searchText` (as MCP's preview does), with
 * whitespace collapsed, cut to 160 code points with an ellipsis. Code points,
 * not UTF-16 units, so a cut never splits a surrogate pair and the length
 * matches SQLite's `length()` in the 015 CHECK.
 */
export function descriptionExcerpt(markdown: string) {
  // @mentions (MENTIONS.md) read as "@Name", not "@ Name" (searchText would split the link markup).
  const text = searchText(markdown.replace(MENTION_PATTERN, (_match, name: string) => `@${name}`)).replace(/\s+/g, " ").trim();
  const points = Array.from(text);
  return points.length > EXCERPT_MAX_CHARS ? `${points.slice(0, EXCERPT_MAX_CHARS - 1).join("").trimEnd()}…` : text;
}

const RECONCILE_BATCH = 500;

/**
 * Fills the excerpt of every card (live or binned) whose description is not
 * empty but whose excerpt is. Idempotent and batched by rowid; a description
 * with no plain text (a lone URL, say) keeps '' and is simply recomputed on
 * the next boot. Returns the number of excerpts written.
 */
export function reconcileCardExcerpts() {
  const select = db.query("SELECT rowid, id, description FROM cards WHERE rowid > ? AND description <> '' AND description_excerpt = '' ORDER BY rowid LIMIT ?");
  const update = db.query("UPDATE cards SET description_excerpt = ? WHERE id = ? AND description_excerpt = ''");
  let after = 0;
  let written = 0;
  for (;;) {
    const rows = select.all(after, RECONCILE_BATCH) as Array<{ rowid: number; id: string; description: string }>;
    if (!rows.length) return written;
    db.transaction(() => {
      for (const row of rows) {
        const excerpt = descriptionExcerpt(row.description);
        if (excerpt && update.run(excerpt, row.id).changes === 1) written += 1;
      }
    })();
    after = rows[rows.length - 1]!.rowid;
  }
}
