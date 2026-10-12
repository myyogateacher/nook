/**
 * Files-only card comments (uploads everywhere plan D397, operator decision Q12). `card_comments.body`
 * must be at least one character (migration 009), and changing that CHECK means rebuilding a parent
 * table, so a comment posted with files and no words stores a generated body instead:
 *
 * - one file: `📎 <file name>` (for example `📎 screenshot.png`);
 * - several: `📎 <N> files` (for example `📎 3 files`).
 *
 * The body reads well wherever text is all there is (mail, MCP `get_card`, search, an older client),
 * and the web app recognises it and shows the comment as its files only. The server and the client
 * share these two functions so they never disagree.
 */

export const FILES_ONLY_MARK = "📎";

/** The body stored for a comment with these files and no text. */
export function generatedCommentBody(names: readonly string[]) {
  if (names.length === 1) return `${FILES_ONLY_MARK} ${names[0]}`;
  return `${FILES_ONLY_MARK} ${names.length} files`;
}

/**
 * Whether `body` is a generated files-only body for a comment that still has files: `📎 N files`, or
 * `📎 ` and the name of one of its files. A comment whose files were all removed shows its body as text.
 */
export function isGeneratedCommentBody(body: string, files: { count: number; names: readonly string[] }) {
  if (files.count === 0 || !body.startsWith(`${FILES_ONLY_MARK} `)) return false;
  if (/^📎 \d+ files$/u.test(body)) return true;
  return files.names.some((name) => body === `${FILES_ONLY_MARK} ${name}`);
}
