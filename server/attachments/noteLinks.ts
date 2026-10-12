/**
 * Note links are derived, not declared (uploads everywhere plan D408, T350). U0 leaves this file for
 * slice U4, which wires it into the publish path (server/noteDrafts.ts `publishDraft`, used by the
 * route and MCP `publish_note_draft`) as:
 *
 *   syncDerivedLinks("note", noteId, publisherId, referencedDocumentIds(publishedMarkdown))
 *
 * `syncDerivedLinks` (server/attachments/service.ts) keeps only documents the publisher owns (or that
 * were already linked) and caps the set at 100. Drafts never derive links.
 */

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
/** `/api/files/<uuid>/content` (an image) and `/files/<uuid>` (a file chip), as link targets only. */
const REFERENCE = new RegExp(`\\]\\(\\s*<?(?:/api/files/(${UUID})/content(?:\\?[^)\\s>]*)?|/files/(${UUID}))>?(?:\\s+"[^"]*")?\\s*\\)`, "g");

/** The documents a note's Markdown references, in order of first use, lower-cased, without repeats. */
export function referencedDocumentIds(markdown: string): string[] {
  const seen = new Set<string>();
  for (const match of markdown.matchAll(REFERENCE)) {
    const id = (match[1] ?? match[2])!.toLowerCase();
    seen.add(id);
  }
  return [...seen];
}
