import { inviteTemplate, passwordResetTemplate, testTemplate, verifyTemplate } from "./templates/account";
import { assignedTemplate, commentTemplate, proposalsTemplate, sharedTemplate } from "./templates/activity";
import { eventChangedTemplate, reminderTemplate } from "./templates/calendar";
import { binExpiringTemplate, sprintTemplate } from "./templates/later";
import { digestTemplate } from "./templates/digest";
import { accountEventTemplate, apiKeyCreatedTemplate, passwordChangedTemplate, roleChangedTemplate, twoFactorTemplate } from "./templates/security";
import type { TemplateDef } from "./templates/types";

/**
 * Every mail Nook sends in Wave 28 (§A.2 v1 set). The outbox stores the name; the dispatcher looks
 * the definition up here (class, category, renderer); the dev preview and golden tests render each
 * fixture. Extra variants (the security templates' other events) are preview-only fixtures.
 */
export const TEMPLATES = {
  "team.invite": inviteTemplate,
  "account.verify": verifyTemplate,
  "account.test": testTemplate,
  "tasks.assigned": assignedTemplate,
  "tasks.comment": commentTemplate,
  "sharing.shared": sharedTemplate,
  "inbox.proposals": proposalsTemplate,
  "security.api_key_created": apiKeyCreatedTemplate,
  "security.role_changed": roleChangedTemplate,
  "security.two_factor": twoFactorTemplate,
  "security.account": accountEventTemplate,
  // Wave 29 (E2).
  "calendar.reminder": reminderTemplate,
  "calendar.event_changed": eventChangedTemplate,
  "tasks.sprint": sprintTemplate,
  "bin.expiring": binExpiringTemplate,
  "digest.summary": digestTemplate,
  // Wave 30 (E3).
  "account.password_reset": passwordResetTemplate,
  "security.password_changed": passwordChangedTemplate
} as const;

export type TemplateName = keyof typeof TEMPLATES;
export type TemplateData<N extends TemplateName> = ReturnType<typeof TEMPLATES[N]["fixture"]>;

export const isTemplateName = (value: string): value is TemplateName => Object.hasOwn(TEMPLATES, value);

/** Preview and golden fixtures: one per template plus the variants worth seeing. */
export function previewFixtures(): Array<{ id: string; template: TemplateName; data: unknown }> {
  const base = (Object.keys(TEMPLATES) as TemplateName[]).map((template) => ({ id: template, template, data: TEMPLATES[template].fixture() as unknown }));
  const assigned = assignedTemplate.fixture();
  return [
    ...base,
    { id: "tasks.assigned.many", template: "tasks.assigned", data: { actors: ["Priya Shah", "Sam Lee"], cards: Array.from({ length: 7 }, (_, index) => ({ ...assigned.cards[0]!, cardId: `6a1d6b7f-2c3e-4d4f-9a5b-${String(index).padStart(12, "0")}`, title: `Card ${index + 1}`, dueOn: index % 2 ? null : "2026-10-02" })) } },
    { id: "sharing.shared.one", template: "sharing.shared", data: { actors: ["Priya Shah"], items: [sharedTemplate.fixture().items[0]] } },
    { id: "security.two_factor.enabled", template: "security.two_factor", data: { event: "enabled", at: "2026-09-28T09:00:00.000Z", remaining: null } },
    { id: "security.two_factor.recovery_regenerated", template: "security.two_factor", data: { event: "recovery_regenerated", at: "2026-09-28T09:00:00.000Z", remaining: 10 } },
    { id: "security.account.unblocked", template: "security.account", data: { event: "unblocked", actorName: "Priya Admin", at: "2026-09-28T09:00:00.000Z" } },
    { id: "calendar.reminder.standalone", template: "calendar.reminder", data: { kind: "standalone", title: "Call the bank", eventId: null, time: { allDay: false, start: "2026-10-01T07:00:00.000Z" }, location: null, calendarName: null, tz: "Europe/Berlin", late: true } },
    { id: "calendar.reminder.all_day", template: "calendar.reminder", data: { ...reminderTemplate.fixture(), time: { allDay: true, start: "2026-10-02" }, location: null } },
    { id: "calendar.event_changed.cancelled", template: "calendar.event_changed", data: { ...eventChangedTemplate.fixture(), change: "cancelled", after: null } },
    { id: "tasks.sprint.completed", template: "tasks.sprint", data: { ...sprintTemplate.fixture(), event: "completed", total: 14, done: 11, carried: 3, yours: { total: 3, done: 2, carried: 1 } } },
    { id: "digest.summary.weekly", template: "digest.summary", data: { ...digestTemplate.fixture(), period: "weekly", date: "2026-09-28", proposals: null,
      cards: Array.from({ length: 7 }, (_, index) => ({ ...digestTemplate.fixture().cards[1]!, cardId: `6a1d6b7f-2c3e-4d4f-9a5b-${String(index).padStart(12, "0")}`, title: `Card ${index + 1}`, dueAt: null, dueOn: "2026-10-01" })), cardsTotal: 9,
      shared: [], sharedTotal: 0 } },
    { id: "security.password_changed.reset", template: "security.password_changed", data: { event: "reset", at: "2026-09-28T09:00:00.000Z" } },
    { id: "security.password_changed.google_linked", template: "security.password_changed", data: { event: "google_linked", at: "2026-09-28T09:00:00.000Z" } },
    { id: "security.account.google_reset", template: "security.account", data: { event: "google_reset", actorName: "Priya Admin", at: "2026-09-28T09:00:00.000Z", counts: { sessions: 2, keys: 1, feeds: 0, items: 3, shares: 4, groupGrants: 1, invites: 0, routines: 1, password: 1, twoFactor: 1 } } },
    { id: "security.account.sessions_revoked", template: "security.account", data: { event: "sessions_revoked", actorName: "Priya Admin", at: "2026-09-28T09:00:00.000Z" } }
  ];
}

/** Renders any template by name (data is trusted to match: it comes from a resolver or a fixture). */
export function renderTemplate(name: TemplateName, data: unknown, context: Parameters<TemplateDef<unknown>["render"]>[1]) {
  return (TEMPLATES[name] as TemplateDef<unknown>).render(data, context);
}
