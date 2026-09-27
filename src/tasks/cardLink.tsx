import { Link as LinkIcon } from "lucide-react";
import { formatRoute } from "../router";
import type { TaskNotify } from "./taskActions";

/**
 * A card's permalink: `/tasks/<board>/card/<card>` on this origin, without the board's view or
 * filter query (that is presentation state, not the card). The card route already deep-links.
 */
export function cardPermalink(boardId: string, cardId: string, origin = window.location.origin) {
  return `${origin}${formatRoute({ app: "tasks", boardId, cardId })}`;
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

/** Copies a card's permalink and says so; on failure the toast shows the link to select by hand. */
export async function copyCardLink(boardId: string, cardId: string, notify: TaskNotify, copy: (text: string) => Promise<boolean> = copyText) {
  const url = cardPermalink(boardId, cardId);
  if (await copy(url)) notify("Link copied");
  else notify(`Could not copy — here is the link: ${url}`, undefined, { selectable: true });
}

/** The card header's "Copy link" (the dialog and the full-page card). */
export function CopyCardLinkButton({ boardId, cardId, notify }: { boardId: string; cardId: string; notify: TaskNotify }) {
  return <button type="button" className="icon-button task-card-copy-link" onClick={() => { void copyCardLink(boardId, cardId, notify); }}
    aria-label="Copy link to this card" title="Copy link"><LinkIcon aria-hidden="true" /></button>;
}
