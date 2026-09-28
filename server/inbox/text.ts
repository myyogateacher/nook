/**
 * Agent-written text in the inbox (T127): titles, rationales, and reject reasons are stored as
 * plain text and rendered only as text nodes. C0/C1 controls (except newline and tab in longer
 * text), bidi embeddings, overrides, isolates, marks, and zero-width characters are stripped, as
 * for file names (T15), so a title cannot hide or reorder what the reviewer reads.
 */

const invisible = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F؜​-‏‪-‮⁦-⁩﻿]/g;

/** One line: every whitespace run (newlines included) becomes one space. */
export function cleanLine(value: string) {
  return value.replace(/\p{Cs}/gu, "").normalize("NFC").replace(invisible, "").replace(/\s+/g, " ").trim();
}

/** Several lines: keeps newlines, collapses runs of blank lines to one. */
export function cleanText(value: string) {
  return value.replace(/\p{Cs}/gu, "").normalize("NFC").replace(/\r\n?/g, "\n").replace(invisible, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Appends as a new paragraph block (the same rule as update_note_draft's append mode). */
export function appendMarkdownBlock(base: string, addition: string) {
  if (base.trim() === "") return addition;
  return `${base.replace(/\s+$/, "")}\n\n${addition}`;
}
