/**
 * Escaping for mail HTML (docs/plan/research/2026-09-28-outbound-email.md §C.3, D252, T222, T228).
 *
 * `html` is a tagged template: the template's literal text is kept, and every interpolation is
 * escaped unless it is a `SafeHtml`. A `SafeHtml` is only ever made by `html` itself (its constructor
 * is private and refuses to run otherwise), so there is no helper that turns an arbitrary string
 * into markup: CSS blocks and MSO conditional comments are literal template text.
 */

let make!: (value: string) => SafeHtml;
let constructing = false;

/** Markup that is safe to embed. Built only by the `html` tag below. */
export class SafeHtml {
  private constructor(readonly value: string) {
    if (!constructing) throw new TypeError("SafeHtml is built only by the html tag in server/mail/html.ts");
  }

  toString() {
    return this.value;
  }

  static {
    make = (value: string) => {
      constructing = true;
      try {
        return new SafeHtml(value);
      } finally {
        constructing = false;
      }
    };
  }
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };

/** Escapes text for HTML content or a double-quoted attribute. */
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ESCAPES[char]!);

export type HtmlPart = SafeHtml | string | number | null | undefined | false | readonly HtmlPart[];

function render(part: HtmlPart): string {
  if (part === null || part === undefined || part === false) return "";
  if (part instanceof SafeHtml) return part.value;
  if (Array.isArray(part)) return part.map(render).join("");
  return escapeHtml(String(part));
}

/** Builds markup: literal template text is kept, every `${value}` is escaped unless it is SafeHtml. */
export function html(strings: TemplateStringsArray, ...values: HtmlPart[]): SafeHtml {
  // A real template call passes a frozen array with `raw`; a hand-made array is refused.
  if (!Object.isFrozen(strings) || !Array.isArray((strings as { raw?: unknown }).raw)) throw new TypeError("html must be used as a template tag");
  let out = strings[0]!;
  for (let index = 0; index < values.length; index += 1) out += render(values[index]!) + strings[index + 1]!;
  return make(out);
}

/** Joins parts that are already SafeHtml (or text, escaped). */
export const join = (parts: readonly HtmlPart[]) => make(render(parts));

// Control characters, zero-width marks, and bidi overrides or isolates (T222: an RTL override can
// disguise a title, and CR/LF could split a header, T228).
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g;

/**
 * One line of user text for a subject, header, or body: control and bidi characters become a
 * space, whitespace collapses, and the result is cut to `max` characters with an ellipsis.
 */
export function cleanLine(value: string | null | undefined, max = 120, fallback = "") {
  const line = (value ?? "").replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  if (!line) return fallback;
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}\u2026` : line;
}

/** Plain text from Markdown for a comment excerpt: syntax removed, one line, at most `max` characters. */
export function stripMarkdown(value: string, max = 280) {
  const text = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|~~)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, "$1$2")
    .replace(/^\s*[-*_]{3,}\s*$/gm, " ")
    .replace(/\[[ xX]\]\s*/g, "");
  return cleanLine(text, max);
}
