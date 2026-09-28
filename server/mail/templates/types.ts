import type { RenderedMail } from "../layout";

export type MailClass = "security" | "account" | "activity" | "reminders" | "digest";
/** Activity categories (§A.1, D231); `reminders` is the Wave 29 reminders-by-email switch. */
export const MAIL_CATEGORIES = ["assignments", "comments", "sharing", "proposals", "sprints", "bin", "reminders"] as const;
export type MailCategory = typeof MAIL_CATEGORIES[number];

export const CATEGORY_LABELS: Record<MailCategory, string> = {
  assignments: "Assigned to you",
  comments: "Comments on your cards",
  sharing: "Shared with you",
  proposals: "Proposals awaiting you",
  sprints: "Sprints",
  bin: "Bin clean-up",
  reminders: "Reminders by email"
};

/** What every render gets besides its data. */
export type RenderContext = {
  instanceName: string;
  /** The recipient's stored zone (email_prefs.tz), for times. */
  tz: string;
  /** Activity mail only: the signed one-click link that turns this category off (B.2). */
  unsubscribeHref?: string;
};

export type TemplateDef<D> = {
  name: string;
  class: MailClass;
  category?: MailCategory;
  render: (data: D, context: RenderContext) => RenderedMail;
  /** Fixture data for the dev preview and the golden files (placeholders only). */
  fixture: () => D;
};

export const defineTemplate = <D>(definition: TemplateDef<D>) => definition;
