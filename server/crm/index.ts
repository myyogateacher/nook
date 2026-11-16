import { registerWorkspaceModule } from "../workspaceModules";
import { registerCrmRoutes } from "./routes";
import { crmMailTemplates } from "./mail";
import type { RegisteredMailTemplate } from "../mail/registry";
import { crmMcpTools, CRM_AGENT_TOOLS } from "./mcpTools";
import { crmBinProviders, crmDatasets, crmDigestSection, crmProgressSources, crmSearchScope, crmTodayProvider, dealAnchor, dealWorkKind, interactionAnchor } from "./integrations";
import { fireFollowup } from "./interactions";
import { notifyRotting } from "./deals";
import { db } from "../db";
import "../../shared/crm";

/**
 * Contacts (module id `crm`, docs/plan/WORKSPACE_MODULES.md §D.5, D960–D999, T560–T574): the module
 * entry. Books, contacts, companies, deals, pipelines, interactions, lists, views, follow-ups, import
 * and export live in server/crm/*; this file hands them to the foundation registries. Contact books
 * (the access container), the contact and company work kinds, and their key-grant anchors are the
 * foundation's (server/access/workspaceItems.ts, server/people/routes.ts).
 */
registerWorkspaceModule({
  id: "crm",
  routes: registerCrmRoutes,
  mailTemplates: crmMailTemplates as unknown as Record<string, RegisteredMailTemplate<never>>,
  mcpTools: crmMcpTools,
  agentTools: CRM_AGENT_TOOLS,
  itemKinds: [{ kind: "deal", anchors: dealAnchor }, { kind: "interaction", anchors: interactionAnchor }],
  workKinds: [dealWorkKind],
  binProviders: crmBinProviders,
  todayProviders: [{ name: "crmFollowups", provider: crmTodayProvider }],
  searchScopes: [crmSearchScope],
  datasets: crmDatasets,
  scheduleHandlers: {
    "crm.followup": { run: (schedule, fireAt) => { if (typeof schedule.payload.followupId === "string") fireFollowup(schedule.payload.followupId, Date.parse(fireAt)); } },
    "crm.rotting": { run: (schedule) => { notifyRotting(schedule.owner.id); }, skipIfLateMs: 6 * 3_600_000 }
  },
  progressSources: crmProgressSources as never,
  digestSections: [crmDigestSection],
  undoKinds: {
    crm_interaction: {
      restored: (rows) => {
        // Restored subjects get their activity back on the timeline only through the interaction itself; nothing derived to redo.
        void rows; void db;
      }
    }
  }
});
