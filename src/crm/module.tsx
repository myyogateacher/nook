import { lazy } from "react";
import { CRM_SECTIONS, crmSectionOf } from "./sections";
import { Building2, Contact, Handshake, PhoneCall, UserPlus } from "lucide-react";
import { WORKSPACE_MODULE_LABELS } from "../../shared/workspaceModules";
import type { WorkspaceClientModule } from "../workspaceModules/types";
import { CRM_ACTIVITY_RENDERERS } from "./activityText";
import type { Route } from "../router";
import { shortDate } from "./format";

/**
 * Contacts (lane CRM, docs/plan/WORKSPACE_MODULES.md §D.5, D832): the client module. User-facing it is
 * "Contacts" at /contacts (§G.1 Q7); the id stays `crm`. Paths: `/contacts` (people), `/contacts/companies`,
 * `/contacts/deals`, `/contacts/lists`, `/contacts/insights`, `/contacts/followups`, `/contacts/settings`;
 * records at `/contacts/<name>-<shortid>`, `/contacts/companies/<name>-<shortid>`, `/contacts/deals/<title>-<shortid>`.
 * The query keeps the chosen book (`?book=`) and the deals view (`?pipeline=`, `?layout=`).
 */
const app = lazy(() => import("./CrmApp"));

export const module: WorkspaceClientModule = {
  id: "crm",
  segment: WORKSPACE_MODULE_LABELS.crm.path.slice(1),
  label: WORKSPACE_MODULE_LABELS.crm.label,
  icon: Contact,
  description: WORKSPACE_MODULE_LABELS.crm.description,
  ready: true,
  app,
  launcher: true,
  sections: CRM_SECTIONS,
  sectionOf: crmSectionOf,
  parseRoute: (segments, search) => ({ path: segments.filter(Boolean).slice(0, 3), search: search && search !== "?" ? search : "" }),
  todaySections: {
    crmFollowups: {
      title: "Follow-ups", group: "today", empty: "no follow-ups due", app: "Contacts",
      row: (item) => ({ key: String(item.id), label: String(item.title), meta: [item.detail, item.due ? `Due ${shortDate(String(item.due))}` : null].filter(Boolean).join(" · "), route: { app: "crm", path: String(item.href).split("?")[0]!.split("/").filter(Boolean).slice(1), search: "" } as Route,
        ...(item.due && String(item.due).slice(0, 10) < new Date().toISOString().slice(0, 10) ? { tone: "overdue" as const } : { tone: "today" as const }) })
    }
  },
  quickActions: [
    { id: "crm.new_contact", label: "New contact", icon: UserPlus, href: "/contacts?new=contact", hiddenFor: ["guest", "viewer"] },
    { id: "crm.log_call", label: "Log a call", icon: PhoneCall, href: "/contacts?log=call", hiddenFor: ["guest", "viewer"] }
  ],
  notificationTopics: [
    { id: "crm.followup_due", label: "Follow-ups due", description: "A reminder you set on a contact, company, or deal." },
    { id: "crm.deal_assigned", label: "Deals you own", description: "Someone made you a deal's owner." },
    { id: "crm.deal_won", label: "Deals won", description: "A deal you own was won." },
    { id: "crm.deal_lost", label: "Deals lost", description: "A deal you own was lost." },
    { id: "crm.deal_rotting", label: "Quiet deals", description: "A deal you own has had no activity for its stage's rotting days." }
  ],
  workKindRenderers: {
    contact: { icon: Contact, label: "Contact" },
    company: { icon: Building2, label: "Company" },
    deal: { icon: Handshake, label: "Deal" }
  },
  activityRenderers: CRM_ACTIVITY_RENDERERS,
  searchRenderer: {
    scope: "contacts", label: "Contacts", icon: Contact,
    row: (result) => ({ key: `${result.kind}:${result.id}`, title: String(result.title), meta: [result.kind === "company" ? "Company" : result.kind === "deal" ? "Deal" : "Contact", result.snippet].filter(Boolean).join(" · "), href: String(result.href) })
  },
  shortcuts: [
    { keys: "n", label: "New contact, company, deal, or list (by tab)" },
    { keys: "/", label: "Search this tab" },
    { keys: "j / k", label: "Move through the list" },
    { keys: "Enter", label: "Open the selected record" },
    { keys: "l", label: "Log an interaction on the open record" }
  ]
};
