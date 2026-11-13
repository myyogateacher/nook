import { Link as LinkIcon } from "lucide-react";
import { formatRoute } from "../router";
import { parseCardKey } from "../../shared/boardKeys";
import type { TaskNotify } from "./taskActions";

/**
 * A card's permalink: `/tasks/<board>/card/<card>` on this origin, without the board's view or
 * filter query (that is presentation state, not the card). The card route already deep-links.
 */
export function cardPermalink(boardId: string, cardId: string, origin = window.location.origin) {
  return `${origin}${formatRoute({ app: "tasks", boardId, cardId })}`;
}

/**
 * A card's short link (lane KEYS, D713): `/tasks/MYT-12` on this origin. It keeps opening the card
 * after its board's code changes (D714) or it moves to another board (D715). Null without a
 * well-formed key (an older server sends none), so callers fall back to the permalink.
 */
export function cardShortLink(key: string | null | undefined, origin = window.location.origin) {
  const parsed = key ? parseCardKey(key) : null;
  return parsed ? `${origin}/tasks/${parsed.code}-${parsed.number}` : null;
}

type ClipboardDeps = {
  clipboard?: Pick<Clipboard, "writeText"> | undefined;
  document?: Pick<Document, "createElement" | "execCommand" | "body" | "activeElement"> | undefined;
};

/**
 * Copies text: the async Clipboard API first, then a temporary textarea and `execCommand("copy")`
 * (older browsers, or a page without clipboard permission). True when either one succeeded.
 */
export async function copyText(text: string, deps: ClipboardDeps = {
  clipboard: typeof navigator === "undefined" ? undefined : navigator.clipboard,
  document: typeof document === "undefined" ? undefined : document
}) {
  try {
    if (deps.clipboard) {
      await deps.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea.
  }
  const doc = deps.document;
  if (!doc?.body) return false;
  const focused = doc.activeElement as HTMLElement | null;
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  doc.body.appendChild(area);
  try {
    area.select();
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    focused?.focus?.();
  }
}

/**
 * Copies a card's link and says so: the short link when the card's key is known (D713), else the
 * permalink. On failure the toast shows the link to select by hand.
 */
export async function copyCardLink(boardId: string, cardId: string, notify: TaskNotify, copy: (text: string) => Promise<boolean> = copyText, key?: string | null) {
  const url = cardShortLink(key) ?? cardPermalink(boardId, cardId);
  if (await copy(url)) notify.success("Link copied");
  else notify.warning(`Could not copy — here is the link: ${url}`, { selectable: true });
}

/**
 * The key chip's copy (D713): the card's short link (`https://…/tasks/MYT-12`), so a pasted key
 * opens the card. Falls back to the bare key only when it is not well formed.
 */
export async function copyCardKey(key: string, notify: TaskNotify, copy: (text: string) => Promise<boolean> = copyText) {
  const url = cardShortLink(key) ?? key;
  if (await copy(url)) notify.success(`Copied link to ${key}`);
  else notify.warning(`Could not copy — here is the link: ${url}`, { selectable: true });
}

/** The card header's "Copy link" (the dialog and the full-page card): the short link when `cardKey` is known. */
export function CopyCardLinkButton({ boardId, cardId, cardKey, notify }: { boardId: string; cardId: string; cardKey?: string | null; notify: TaskNotify }) {
  return <button type="button" className="icon-button task-card-copy-link" onClick={() => { void copyCardLink(boardId, cardId, notify, copyText, cardKey); }}
    aria-label="Copy link to this card" title="Copy link"><LinkIcon aria-hidden="true" /></button>;
}

/**
 * A card's key as a small button that copies it (D713): in the card header's eyebrow, and quietly on
 * card faces, list rows, and table rows. `onClick` stops there, so a key on a card face never opens the card.
 */
export function CardKeyButton({ cardKey, notify, className = "" }: { cardKey: string; notify: TaskNotify; className?: string }) {
  return <button type="button" className={`task-card-key${className ? ` ${className}` : ""}`}
    onClick={(event) => { event.stopPropagation(); event.preventDefault(); void copyCardKey(cardKey, notify); }}
    onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }}
    draggable={false} aria-label={`${cardKey}: copy a link to this card`} title="Copy link to this card">{cardKey}</button>;
}
