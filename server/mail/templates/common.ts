import { cleanLine } from "../html";
import type { Footer } from "../layout";
import { appLink, paths } from "../links";
import { CATEGORY_LABELS, type MailCategory, type RenderContext } from "./types";

/** A display name for mail: one line, 80 characters (T228). */
export const personName = (value: string | null | undefined, fallback = "Someone") => cleanLine(value, 80, fallback);
/** An item title for mail: one line, 120 characters. */
export const itemTitle = (value: string | null | undefined, fallback = "Untitled") => cleanLine(value, 120, fallback);

const settingsHref = () => appLink(paths.settings("notifications"));

/** The activity footer: why, a one-click switch for this category only, and Email settings. */
export function activityFooter(category: MailCategory, reason: string, context: RenderContext): Footer {
  return {
    reason,
    unsubscribe: context.unsubscribeHref ? { href: context.unsubscribeHref, label: `Turn off “${CATEGORY_LABELS[category]}” emails` } : undefined,
    settingsHref: settingsHref()
  };
}

/** Security mail cannot be switched off, so it has no unsubscribe link (B.2). */
export function securityFooter(reason = "You got this because it is about your own Nook account."): Footer {
  return { reason, settingsHref: settingsHref(), security: true };
}

/** Account mail (verify, test, invite): the person asked for it, so there is nothing to turn off. */
export function accountFooter(reason: string, withSettings = true): Footer {
  return { reason, settingsHref: withSettings ? settingsHref() : undefined };
}

/** "Priya", "Priya and Sam", "Priya and 2 others". */
export function actorsPhrase(names: readonly string[]) {
  const unique = [...new Set(names.map((name) => personName(name)))];
  if (unique.length === 0) return "Someone";
  if (unique.length === 1) return unique[0]!;
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique[0]} and ${unique.length - 1} others`;
}

/** Lists show at most this many rows, then "and N more" (C.2). */
export const LIST_MAX = 5;
