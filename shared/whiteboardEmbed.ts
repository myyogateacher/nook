/**
 * The Markdown of a whiteboard card in a note (Wave 24, D208): a titled link alone on its line,
 * `[Whiteboard](/whiteboards/<uuid> "whiteboard")`. The link text is always the neutral word
 * "Whiteboard", never the board's name: a note's readers (its Markdown, Version history, MCP
 * `read_note`, search) may not be able to open the board, and its name must not reach them (QA H1).
 * The card fetches the name from the access-checked summary instead.
 */

export const WHITEBOARD_EMBED_TITLE = "whiteboard";
export const WHITEBOARD_EMBED_TEXT = "Whiteboard";

const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
/** One embed line, whole (leading indentation of up to 3 spaces and trailing blanks allowed). */
const embedLineRe = new RegExp(`^( {0,3})\\[(?:[^\\]\\\\\\n]|\\\\.)*\\]\\((/whiteboards/${uuid}) "${WHITEBOARD_EMBED_TITLE}"\\)([ \\t]*)$`);

export const neutralEmbedMarkdown = (id: string) => `[${WHITEBOARD_EMBED_TEXT}](/whiteboards/${id} "${WHITEBOARD_EMBED_TITLE}")`;

/**
 * The same Markdown with every embed line's link text replaced by "Whiteboard". Lines inside
 * fenced code blocks are left alone. Pure and idempotent; returns the input itself when nothing
 * changes, so callers can compare by identity.
 */
export function neutralizeWhiteboardEmbeds(markdown: string): string {
  if (!markdown.includes(`"${WHITEBOARD_EMBED_TITLE}")`)) return markdown;
  const lines = markdown.split("\n");
  let fence: string | null = null;
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(bare);
    if (fence) {
      if (opener && opener[1]![0] === fence[0] && opener[1]!.length >= fence.length && bare.trim() === opener[1]) fence = null;
      continue;
    }
    if (opener) {
      fence = opener[1]!;
      continue;
    }
    const match = embedLineRe.exec(bare);
    if (!match) continue;
    const next = `${match[1]}[${WHITEBOARD_EMBED_TEXT}](${match[2]} "${WHITEBOARD_EMBED_TITLE}")${match[3]}${bare === line ? "" : "\r"}`;
    if (next !== line) {
      lines[index] = next;
      changed = true;
    }
  }
  return changed ? lines.join("\n") : markdown;
}
