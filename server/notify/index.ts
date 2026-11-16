import { db } from "../db";
import { emitNotifications, type NotificationCreated } from "../calendar/reminders";
import { enqueueMail } from "../mail/outbox";
import { registeredMailTemplate } from "../mail/registry";
import { isSafeAppHref, NOTIFY_BODY_MAX, NOTIFY_TITLE_MAX, NOTIFY_TOPIC_PATTERN } from "../../shared/notify";
import { isWorkspaceModuleId, type WorkspaceModuleId } from "../../shared/workspaceModules";
import type { WorkKind } from "../../shared/workRefs";

export { enqueueExternalMail, applyExternalStop, externalStopToken, EXTERNAL_CAPS } from "./external";
export { registerDigestSection, type DigestSection, type DigestSectionRow } from "../mail/digest";

/**
 * Module notifications (docs/plan/WORKSPACE_MODULES.md §B.7, D809, T509): one `notifications` row of
 * kind `module` per user, the bell and Notifications page show it with the module's icon, Web Push
 * wakes the person's devices (payload-less, as every Nook push), and an email is queued when asked and
 * the person's preferences allow the module's category (checked again at send time).
 *
 * - `title` and `body` are written by the module from kinds and names the recipient may see; never
 *   answer text or contact details they could not read (T505).
 * - `href` must be a relative in-app path (T509); anything else throws before anything is written.
 * - `dedupeKey`: one unread row per user and key; a repeat updates it (title, body, time) instead of
 *   adding another ("3 new responses" rather than three rows).
 * - Integrations, blocked users, and the actor themselves are skipped.
 *
 * Call inside the action's transaction; push delivery runs after commit (queueMicrotask).
 */
/** Core apps that notify through here too (docs/plan/MENTIONS.md D1325): a mention on a card or a note. */
export const CORE_NOTIFY_MODULES = ["tasks", "notes"] as const;
export type NotifyModule = WorkspaceModuleId | typeof CORE_NOTIFY_MODULES[number];
const isNotifyModule = (value: unknown): value is NotifyModule => isWorkspaceModuleId(value) || (CORE_NOTIFY_MODULES as readonly unknown[]).includes(value);

export type NotifyInput = {
  userIds: readonly string[];
  module: NotifyModule;
  topic: string;
  title: string;
  body?: string | null;
  href: string;
  item?: { kind: WorkKind; id: string } | null;
  actor?: string | null;
  dedupeKey?: string | null;
  push?: boolean;
  /** A registered template (server/mail/registry.ts) with a `resolve` for team users; its payload holds ids only. */
  email?: { template: string; payload: Record<string, unknown>; coalesceKey?: string; windowMs?: number };
  /** Also notify the actor (default false). */
  includeActor?: boolean;
  nowMs?: number;
};

export class NotifyError extends Error {}

export function notify(input: NotifyInput): { notified: string[] } {
  if (!isNotifyModule(input.module)) throw new NotifyError(`Unknown module ${input.module}`);
  if (!NOTIFY_TOPIC_PATTERN.test(input.topic)) throw new NotifyError(`Invalid topic ${input.topic}`);
  if (!isSafeAppHref(input.href)) throw new NotifyError("A notification href must be a relative in-app path");
  const title = input.title.trim().slice(0, NOTIFY_TITLE_MAX);
  if (!title) throw new NotifyError("A notification needs a title");
  const body = input.body ? input.body.slice(0, NOTIFY_BODY_MAX) : null;
  if (input.dedupeKey && input.dedupeKey.length > 120) throw new NotifyError("dedupeKey is at most 120 characters");
  const template = input.email ? registeredMailTemplate(input.email.template) : null;
  if (input.email && !template?.resolve) throw new NotifyError(`Mail template ${input.email.template} is not registered for team users`);
  const createdAt = new Date(input.nowMs ?? Date.now()).toISOString();
  const recipients = [...new Set(input.userIds)].filter((userId) => input.includeActor || userId !== input.actor);
  const live = recipients.length
    ? (db.query(`SELECT id FROM users WHERE kind = 'person' AND disabled_at IS NULL AND id IN (${recipients.map(() => "?").join(",")})`).all(...recipients) as Array<{ id: string }>).map((row) => row.id)
    : [];
  const created: NotificationCreated[] = [];
  const insert = db.query(`INSERT INTO notifications (id, user_id, kind, created_at, module, topic, title, body, href, item_kind, item_id, actor_id, dedupe_key)
    VALUES (?, ?, 'module', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, dedupe_key) WHERE read_at IS NULL AND dedupe_key IS NOT NULL
    DO UPDATE SET title = excluded.title, body = excluded.body, href = excluded.href, created_at = excluded.created_at, actor_id = excluded.actor_id`);
  for (const userId of live) {
    const id = crypto.randomUUID();
    insert.run(id, userId, createdAt, input.module, input.topic, title, body, input.href, input.item?.kind ?? null, input.item?.id ?? null, input.actor ?? null, input.dedupeKey ?? null);
    created.push({ id, userId, push: input.push !== false });
    if (input.email && template) {
      enqueueMail({
        userId, template: input.email.template as never, payload: input.email.payload,
        coalesceKey: input.email.coalesceKey ? `${input.email.coalesceKey}:${userId}`.slice(0, 120) : undefined, windowMs: input.email.windowMs, nowMs: input.nowMs
      });
    }
  }
  // Push after the transaction commits (a rolled-back action wakes nobody).
  if (created.length) queueMicrotask(() => emitNotifications(created));
  return { notified: live };
}
