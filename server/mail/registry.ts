import { inviteTemplate, testTemplate, verifyTemplate } from "./templates/account";
import { assignedTemplate, commentTemplate, proposalsTemplate, sharedTemplate } from "./templates/activity";
import { accountEventTemplate, apiKeyCreatedTemplate, roleChangedTemplate, twoFactorTemplate } from "./templates/security";
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
  "security.account": accountEventTemplate
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
    { id: "security.account.sessions_revoked", template: "security.account", data: { event: "sessions_revoked", actorName: "Priya Admin", at: "2026-09-28T09:00:00.000Z" } }
  ];
}

/** Renders any template by name (data is trusted to match: it comes from a resolver or a fixture). */
export function renderTemplate(name: TemplateName, data: unknown, context: Parameters<TemplateDef<unknown>["render"]>[1]) {
  return (TEMPLATES[name] as TemplateDef<unknown>).render(data, context);
}
