import * as z from "zod/v4";
import { withAuditContext } from "../db";
import { KIND_TOOL, type ProposalKind } from "../inbox/kinds";
import { submitProposal, TITLE_MAX } from "../inbox/service";
import { hasScope, type McpScope } from "../mcpScopes";
import { loadLiveKey, mcpToolSpecs, runTool, toolVisible, McpToolError, type McpKeyContext, type McpToolSpec } from "../mcpTools";
import { keyReach } from "../keyResources";
import { markKeyUsed } from "../apiKeys";
import { PROPOSAL_KIND_DEFS } from "../inbox/kinds";
import type { NookCatalogTool } from "../../shared/agents";
import type { AgentRow } from "./agentsService";

/**
 * Nook's own tools for agents (plan §5.2, §5.3, §5.4, D353, D359; Wave 41 AC-B). They run in
 * process through `runTool(spec, args, keyId, "mcp")` with the runner's linked key, so grants ∩ the
 * owner's live access ∩ role ∩ policy apply per call, the key's rate limits count, and the agent
 * owner's access is never used (T311).
 *
 * What is offered: the read tools the key can see, and the write tools in one of two modes:
 * - **proposal** (the default, AC-O11): a write tool whose arguments the Inbox can carry as a
 *   proposal of an existing kind (`create_card` → `card_create`, `update_note_draft` →
 *   `note_draft`, …) is offered, asks first, and is turned into a pending proposal in the key
 *   owner's Inbox; nothing is applied. The key needs `inbox:write` plus the module's read scope,
 *   as `submit_proposals` does.
 * - **direct**: only with the agent's `nook_direct_writes` flag and the key's write grant; it still
 *   asks first in chats (D352). A write tool with no proposal kind is offered only in this mode.
 *
 * Never offered: proposal and routine machinery, uploads, Bin, key, vault, the agent module's own
 * tools (`run_agent` of AC-C included; T318), and every reports tool but the reads (C2).
 *
 * C2 (D477, T388): in a chat with no linked key, the tools run with the runner's **internal** key
 * (server/apiKeys.ts ensureInternalAgentKey): every module's read plus `inbox:write`, so writes are
 * proposals only; it works in process only. A linked key is preferred when there is one.
 */

/**
 * The allowlist (review L12): the only Nook tools agents may use. A tool added to `mcpToolSpecs`
 * later is excluded until it is classified here or in `NOOK_NEVER_TOOLS`
 * (tests/agentsToolsFixes.test.ts fails on an unclassified tool).
 */
export const NOOK_AGENT_TOOLS: ReadonlySet<string> = new Set([
  // Notes
  "list_notes", "read_note", "search_notes", "list_folders", "create_note", "get_note_draft", "update_note_draft", "publish_note_draft", "create_folder",
  // Files
  "list_documents", "get_document_metadata", "read_document_text", "create_text_file", "rename_file", "move_file",
  // Tasks
  "list_boards", "list_cards", "get_card", "list_children", "list_sprints", "search_cards", "create_card", "update_card", "move_card", "link_cards", "comment_on_card",
  "manage_tags", "set_wip_limit", "create_sprint", "start_sprint", "link_attachment", "list_views", "query_cards",
  // Calendar
  "list_calendars", "list_events", "get_event", "create_event", "update_event", "create_reminder",
  // Collections
  "list_collections", "query_rows", "get_row", "create_row", "update_row", "create_collection",
  // Today, team, whiteboards
  "get_today", "list_team_members", "get_team_member", "list_invites", "list_whiteboards", "read_whiteboard", "create_whiteboard",
  // Reports (C2): the read tools only; a report's queries, schedule, and instructions stay out of reach.
  "list_reports", "get_report", "get_report_block", "get_report_run", "get_report_instruction"
]);
/** Classified as never offered (T318): proposal and routine machinery, uploads, the agent module's own tools, Bin. */
export const NOOK_NEVER_TOOLS: ReadonlySet<string> = new Set([
  "submit_proposals", "list_my_proposals", "withdraw_proposal", "list_routines", "list_due_routines", "start_run", "finish_run",
  "begin_upload", "finish_upload", "list_agents", "list_chats", "get_chat", "run_agent",
  // AC-E: an agent searches knowledge bases through its own Knowledge picks, never through a key.
  "search_knowledge",
  // Uploads everywhere U0: the generic attachment reads span several modules' scopes; agents get them
  // once the bridge maps a tool to the module of the item it is called on (left to a later slice).
  "list_attachments", "read_attachment_text",
  // U1: attaching needs an upload made for attaching, and uploads are never offered to agents.
  "attach_file_to_event",
  // Uploads everywhere U3: attaching shares the file with the row's readers, and has no proposal kind yet.
  "attach_file_to_row",
  // Analytics reports (Wave 45, Wave 48; C2): agents read reports (NOOK_AGENT_TOOLS) but never the data
  // sources, and never change a report: its queries (`update_report_query`, an open SQL proxy, T383),
  // schedule, instructions, or proposals. A report's own edit agent works through its instructions.
  "list_report_datasources", "create_report", "refresh_report", "set_report_schedule",
  "add_report_instruction", "apply_report_proposal", "reject_report_proposal", "update_report_query"
]);
export const isBinTool = (name: string) => name.startsWith("bin_") || name.startsWith("restore_");
const agentMayUse = (name: string) => NOOK_AGENT_TOOLS.has(name) && !NOOK_NEVER_TOOLS.has(name) && !isBinTool(name);

/** The proposal kind a write tool's call becomes (plan §5.4). */
const TOOL_KIND: Record<string, ProposalKind> = {
  ...Object.fromEntries(Object.entries(KIND_TOOL).map(([kind, tool]) => [tool, kind as ProposalKind])),
  update_note_draft: "note_draft",
  create_note: "note_draft"
};

export const nookToolSpec = (name: string): McpToolSpec | null => mcpToolSpecs.find((spec) => spec.name === name) ?? null;

/** Every Nook tool an agent could pick, whether or not a key is linked. */
export const offeredSpecs = (): McpToolSpec[] => mcpToolSpecs.filter((spec) => agentMayUse(spec.name));

const moduleOf = (scope: McpScope) => scope.split(":")[0]!;

/**
 * The picker's Nook group (plan §5.2): with a linked key, the tools that key can reach now; without
 * one, every offered tool (the editor sees what the agent could get; nothing runs without a key).
 */
export function nookCatalogFor(key: McpKeyContext | null): NookCatalogTool[] {
  return offeredSpecs().filter((spec) => !key || reachable(spec, key, true)).map((spec) => ({
    name: spec.name, title: spec.title, module: moduleOf(spec.scopes[0]!), write: spec.write, proposable: spec.write && spec.name in TOOL_KIND, scope: spec.scopes[0]!,
    proposalScope: spec.write && TOOL_KIND[spec.name] ? PROPOSAL_KIND_DEFS[TOOL_KIND[spec.name]!].scope : null
  }));
}

/** Whether the key could run the tool in some mode (read, proposal, or direct). */
function reachable(spec: McpToolSpec, key: McpKeyContext, anyMode: boolean) {
  if (!spec.write) return toolVisible(spec, key);
  if (toolVisible(spec, key)) return true;
  return anyMode && spec.name in TOOL_KIND && proposalReach(spec, key);
}

/** The proposal path's rights: `inbox:write` and the kind's module read scope over something. */
function proposalReach(spec: McpToolSpec, key: McpKeyContext) {
  const kind = TOOL_KIND[spec.name];
  if (!kind || !hasScope(key.scopes, "inbox:write")) return false;
  return keyReach(key, PROPOSAL_KIND_DEFS[kind].scope) !== null;
}

export type NookMode = "read" | "proposal" | "direct";
/**
 * `surface` (AC-C): the surface the key's calls are made and counted on: `mcp` for a chat's linked
 * key (it must have MCP), and the calling key's own surface for an API or MCP run.
 */
export type NookResolved = { toolName: string; description: string; parameters: Record<string, unknown>; policy: "auto" | "confirm"; mode: NookMode; keyId: string; spec?: McpToolSpec; surface?: "mcp" | "rest";
  /** C2: the runner's internal agents key (proposals only; audited as `internal: true`). */
  internal?: boolean };

/** The agent's picked Nook tools this key may run now, each in the mode the rights allow (D353, D359). */
export function nookToolsFor(key: McpKeyContext, agent: Pick<AgentRow, "nook_direct_writes">, picked: readonly string[]): Omit<NookResolved, "spec">[] {
  const out: Omit<NookResolved, "spec">[] = [];
  for (const name of picked) {
    const spec = nookToolSpec(name);
    if (!spec || !agentMayUse(name)) continue;
    let mode: NookMode | null = null;
    if (!spec.write) mode = toolVisible(spec, key) ? "read" : null;
    else if (agent.nook_direct_writes === 1 && toolVisible(spec, key)) mode = "direct";
    else if (spec.name in TOOL_KIND && proposalReach(spec, key)) mode = "proposal";
    if (!mode) continue;
    const schema = z.toJSONSchema(spec.inputSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete schema.$schema;
    const description = mode === "proposal"
      ? TOOL_KIND[name] === "note_draft"
        ? `${spec.description} In this chat the draft is saved for review and the published note is NOT changed: the person reviews it in their Nook Inbox, and the result carries the proposal id.`
        : `${spec.description} In this chat the change is NOT applied: it becomes a proposal the person reviews in their Nook Inbox, and the result carries the proposal id.`
      : spec.description;
    out.push({ toolName: name, description: description.slice(0, 4096), parameters: schema, policy: spec.write ? "confirm" : "auto", mode, keyId: key.keyId });
  }
  return out;
}

/**
 * The scope a live key now lacks to run a Nook tool in the mode it was offered in (AC-B
 * verification M2), or null when it has them: a read or direct tool needs the tool's own scope;
 * a proposal needs `inbox:write` and the kind's module scope.
 */
export function missingNookScope(key: McpKeyContext, toolName: string, mode: NookMode): McpScope | null {
  const spec = nookToolSpec(toolName);
  if (!spec) return null;
  if (mode === "proposal") {
    if (!hasScope(key.scopes, "inbox:write")) return "inbox:write";
    const kind = TOOL_KIND[spec.name];
    return kind && keyReach(key, PROPOSAL_KIND_DEFS[kind].scope) === null ? PROPOSAL_KIND_DEFS[kind].scope : null;
  }
  return toolVisible(spec, key) ? null : spec.scopes[0] ?? null;
}

export type NookOutcome = { text: string; ok: boolean; proposalId: string | null };

const titleOf = (spec: McpToolSpec, args: Record<string, unknown>) => {
  const hint = typeof args.title === "string" ? args.title : typeof args.name === "string" ? args.name : typeof args.markdown === "string" ? args.markdown.split("\n")[0]!.replace(/^#+\s*/, "") : "";
  return `${spec.title}${hint ? `: ${hint}` : ""}`.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
};

function proposalPayload(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === "create_note") return { ...(typeof args.folderId === "string" ? { folderId: args.folderId } : {}), markdown: args.markdown, mode: "replace" };
  return args;
}

/**
 * Runs one Nook tool for the runner's key inside the run's audit context. A proposal-mode call
 * files an inbox proposal instead of writing (the result says so and names the proposal).
 */
export async function runNookTool(resolved: NookResolved, args: Record<string, unknown>, context: { runId: string; agentId: string; agentName: string; via?: "chat" | "api" | "mcp" }): Promise<NookOutcome> {
  const spec = resolved.spec ?? nookToolSpec(resolved.toolName);
  if (!spec || !agentMayUse(spec.name)) return { text: JSON.stringify({ error: "Unknown tool", code: "NOT_FOUND" }), ok: false, proposalId: null };
  const surface = resolved.surface ?? "mcp";
  // An agent's call is a use of the key on its surface (Wave 41 QA L4): Settings → API keys shows it as last used.
  markKeyUsed(resolved.keyId, surface);
  // C2: the internal key never writes directly, whatever was resolved.
  if (resolved.internal && resolved.mode === "direct") return { text: JSON.stringify({ error: "Nook's automatic tools only propose changes; link a key with direct writes for this", code: "DIRECT_WRITE_REFUSED" }), ok: false, proposalId: null };
  return withAuditContext({ via: "agent", runId: context.runId, agentId: context.agentId, ...(resolved.internal ? { internal: true } : {}) }, async () => {
    if (resolved.mode === "proposal") {
      const kind = TOOL_KIND[spec.name];
      if (!kind) return { text: JSON.stringify({ error: "This change cannot be proposed through the Inbox, and the agent may not make it directly", code: "KIND_NOT_ALLOWED" }), ok: false, proposalId: null };
      const key = loadLiveKey(resolved.keyId, surface);
      if (!key) return { text: JSON.stringify({ error: "The linked Nook key is no longer active", code: "KEY_INACTIVE" }), ok: false, proposalId: null };
      // The key's rights as they stand now (review M2): `inbox:write` and the kind's module reach, as `submit_proposals` checks.
      if (!proposalReach(spec, key)) return { text: JSON.stringify({ error: "The linked Nook key can no longer file this proposal (it needs inbox:write and the module's scope)", code: "SCOPE_REQUIRED" }), ok: false, proposalId: null };
      try {
        const parsed = spec.inputSchema.safeParse(args);
        if (!parsed.success) return { text: JSON.stringify({ error: "Invalid arguments", code: "INVALID", details: parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`) }), ok: false, proposalId: null };
        const result = await submitProposal(key, { kind, title: titleOf(spec, args), rationale: `Suggested by the agent ${context.agentName} ${context.via === "api" ? "in an API run" : context.via === "mcp" ? "in an MCP run" : "in a chat"}.`, payload: proposalPayload(spec.name, parsed.data as Record<string, unknown>) });
        // A note_draft proposal writes the draft at once (D149); only the published note waits on review (review L11).
        const note = kind === "note_draft"
          ? "The draft was saved for review. The published note is unchanged until the person approves this proposal in their Nook Inbox."
          : "Nothing was changed. The person reviews this proposal in their Nook Inbox.";
        return { text: JSON.stringify({ proposed: true, proposalId: result.proposalId, status: result.status, expiresAt: result.expiresAt, note }), ok: true, proposalId: result.proposalId };
      } catch (error) {
        if (error instanceof McpToolError) return { text: JSON.stringify({ error: error.message, code: error.code, ...(error.details ?? {}) }), ok: false, proposalId: null };
        throw error;
      }
    }
    const result = await runTool(spec, args, resolved.keyId, surface);
    return { text: result.content.map((part) => part.text).join("\n"), ok: result.isError !== true, proposalId: null };
  });
}
