import { registerWorkspaceModule } from "../workspaceModules";
import { timeMailTemplates } from "./mail";
import type { RegisteredMailTemplate } from "../mail/registry";
import { registerTimeRoutes, GUEST_TIME_WRITES } from "./routes";
import { timeTools, TIME_AGENT_ALLOWED, TIME_AGENT_NEVER } from "./mcpTools";
import { progressSource, projectBin, scheduleHandlers, searchScope, timeDataset, timeEntryAnchors, timeLogProposal, todayProvider, workKinds } from "./registrations";

/**
 * Time: the module entry (lane TIME, docs/plan/WORKSPACE_MODULES.md §D.2). Everything else lives in
 * server/time/: access.ts (who sees and changes what, D872–D874), service.ts (timer and entries),
 * projects.ts (projects, clients, rates, approvals), reports.ts (timesheet, summaries, CSV, per-item
 * totals, suggestions), routes.ts (HTTP), mcpTools.ts (MCP), registrations.ts (work kinds, Bin,
 * Today, search, dataset, schedules, the Goals progress source, the `time_log` proposal kind).
 * Migrations 093–094 (server/migrations/workspace/time.ts), decisions D870–D899, threats T530–T539.
 */
registerWorkspaceModule({
  id: "time",
  routes: registerTimeRoutes,
  mcpTools: timeTools,
  agentTools: { allowed: TIME_AGENT_ALLOWED, never: TIME_AGENT_NEVER },
  accessContainer: { kind: "time_project", table: "time_projects", nameColumn: "name" },
  itemKinds: [{ kind: "time_entry", anchors: timeEntryAnchors }],
  workKinds,
  binProviders: [{ type: "time_project", provider: projectBin }],
  todayProviders: [{ name: "timeToday", provider: todayProvider }],
  searchScopes: [searchScope],
  datasets: [timeDataset],
  scheduleHandlers,
  mailTemplates: timeMailTemplates as unknown as Record<string, RegisteredMailTemplate<never>>,
  progressSources: [{ kind: "time", source: progressSource as never }],
  proposalKinds: [{ kind: "time_log", def: timeLogProposal }],
  readOnlyWrites: GUEST_TIME_WRITES.map((entry) => ({ ...entry, roles: ["guest"] as const, why: "guests log their own time on projects they belong to (§G.1 Q8); the service checks membership" }))
});
