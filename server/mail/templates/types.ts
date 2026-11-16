import type { RenderedMail } from "../layout";
import { WORKSPACE_MAIL_CATEGORIES, WORKSPACE_MODULE_LABELS } from "../../../shared/workspaceModules";

export type MailClass = "security" | "account" | "activity" | "reminders" | "digest";
/** Activity categories (§A.1, D231); `reminders` is the Wave 29 reminders-by-email switch. */
export const MAIL_CATEGORIES = ["assignments", "comments", "sharing", "proposals", "sprints", "bin", "reminders",
  // @mentions (docs/plan/MENTIONS.md D1328): one switch for every app.
  "mentions",
  // Workspace modules (docs/plan/WORKSPACE_MODULES.md §B.7, D809): one switch per module.
  ...WORKSPACE_MAIL_CATEGORIES] as const;
export type MailCategory = typeof MAIL_CATEGORIES[number];

export const CATEGORY_LABELS: Record<MailCategory, string> = {
  assignments: "Assigned to you",
  comments: "Comments on your cards and items",
  sharing: "Shared with you",
  proposals: "Proposals awaiting you",
  sprints: "Sprints",
  bin: "Bin clean-up",
  reminders: "Reminders by email",
  mentions: "Mentions of you",
  ...Object.fromEntries(WORKSPACE_MAIL_CATEGORIES.map((id) => [id, WORKSPACE_MODULE_LABELS[id].label])) as Record<typeof WORKSPACE_MAIL_CATEGORIES[number], string>
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
