import { db } from "../db";
import { workKindAdapter } from "../links/adapters";
import { appLink } from "./links";
import { context, layout } from "./layout";
import { activityFooter, itemTitle, personName } from "./templates/common";
import { defineTemplate } from "./templates/types";
import type { RegisteredMailTemplate } from "./registry";
import type { Recipient, Resolution } from "./resolve";
import { isWorkKind, WORK_KIND_LABELS, type WorkKind, type WorkSummary } from "../../shared/workRefs";
import type { WorkspaceModuleId } from "../../shared/workspaceModules";

/**
 * One "something happened to an item of yours" email per workspace module that had none (D1370):
 * Time (`time.update`), Goals (`goals.update`), Contacts (`crm.update`). The module passes it through
 * notify()'s `email`, so the person's category switch (Settings → Notifications → Email → the module),
 * quiet hours, blocked and unverified accounts, and suppression are the dispatcher's as for every
 * activity mail.
 *
 * The payload holds ids and enums only: `{ topic, kind, id, actorId?, …extra }`. At send time the item
 * is read again AS THE RECIPIENT through its work kind adapter (the no-leak re-check of the mentions
 * mail, T662): an item they can no longer open skips the mail (`access_lost`), and its title, kind
 * word, and link are only ever the recipient's own view of it. The module's `describe` turns the topic
 * into words from that view; returning null skips the mail (`empty`, e.g. the moment has passed).
 */

export type ModuleItemPayload = { topic: string; kind: WorkKind; id: string; actorId?: string | null } & Record<string, unknown>;

export type ModuleItemMailData = {
  title: string;
  lead: string;
  item: string;
  meta: string;
  href: string;
  action: string;
};

export type DescribeInput = { payload: ModuleItemPayload; summary: WorkSummary; actor: string | null; recipient: Recipient; kindLabel: string };
export type Described = { title: string; lead: string; meta?: string; action?: string; /** A relative in-app path built from ids (default: the item's own). */ path?: string };

export function moduleItemMail(options: {
  name: string;
  category: WorkspaceModuleId;
  eyebrow: string;
  reason: string;
  describe: (input: DescribeInput) => Described | null;
  fixture: () => ModuleItemMailData;
}): RegisteredMailTemplate<ModuleItemMailData> {
  const template = defineTemplate<ModuleItemMailData>({
    name: options.name,
    class: "activity",
    category: options.category,
    render(data, ctx) {
      return layout({
        instanceName: ctx.instanceName,
        subject: data.title,
        preheader: `${itemTitle(data.item)} · ${data.meta}`,
        eyebrow: options.eyebrow,
        title: data.title,
        lead: data.lead,
        blocks: [context([{ title: itemTitle(data.item), meta: data.meta, href: data.href }])],
        action: { label: data.action, href: data.href },
        footer: activityFooter(options.category, options.reason, ctx)
      });
    },
    fixture: options.fixture
  });
  return {
    ...template,
    resolve: (raw, recipient): Resolution => {
      const payload = raw as ModuleItemPayload;
      if (typeof payload.topic !== "string" || !isWorkKind(payload.kind) || typeof payload.id !== "string") return { skip: "empty" };
      const adapter = workKindAdapter(payload.kind);
      if (!adapter || adapter.level(payload.id, { userId: recipient.id }) === "none") return { skip: "access_lost" };
      const summary = adapter.resolve([payload.id], { userId: recipient.id }).get(payload.id);
      if (!summary) return { skip: "access_lost" };
      const actor = typeof payload.actorId === "string"
        ? (db.query("SELECT display_name FROM users WHERE id = ?").get(payload.actorId) as { display_name: string } | null)?.display_name ?? null
        : null;
      const kindLabel = WORK_KIND_LABELS[payload.kind];
      const described = options.describe({ payload, summary, actor: actor ? personName(actor) : null, recipient, kindLabel });
      if (!described) return { skip: "empty" };
      const path = described.path && described.path.startsWith("/") && !described.path.startsWith("//") ? described.path : summary.href;
      return {
        data: {
          title: described.title, lead: described.lead, item: summary.title, meta: described.meta ?? kindLabel, href: appLink(path),
          action: described.action ?? `Open the ${kindLabel.toLowerCase()}`
        } satisfies ModuleItemMailData
      };
    }
  } as RegisteredMailTemplate<ModuleItemMailData>;
}
