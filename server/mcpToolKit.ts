import * as z from "zod/v4";
import type { McpLimitBucket } from "./mcpRateLimit";
import type { McpScope } from "./mcpScopes";
import type { RestoreOutcome } from "./bin";
import type { Grant, ResourceKind } from "./keyGrants";
import type { ItemKind } from "./keyResources";

/**
 * Building blocks shared by every module's MCP tools (server/mcpTools.ts and
 * server/tasks/mcpTools.ts): the key context, the tool spec, and the
 * `{error, code}` error shape. No imports of services, so modules can depend
 * on it without import cycles.
 */

/**
 * The key a tool runs for. `scopes` are the effective scopes (the compatibility view of the key's
 * grants, access plan D262). `grants` are the effective grants, when the caller loaded them (every
 * MCP call does); a context without them is treated as holding its scopes over "all".
 */
export type McpKeyContext = {
  keyId: string; userId: string; name: string; scopes: McpScope[]; grants?: Grant[];
  /**
   * Set only when a signed-in person runs a tool's handler as themselves (approving an inbox
   * proposal): what the key may see about foreign items (server/keyReach.ts) does not limit them.
   */
  person?: true;
};

/**
 * One argument that names an item (access plan D281, T203): its kind decides where it is anchored
 * (server/keyResources.ts). An array argument names several items, each checked. `ifAbsent:
 * "allow"` is for optional arguments that only narrow a result (a list's folder, a query's view);
 * any other optional argument must be given by a key limited to chosen items, since leaving it out
 * would act somewhere the key was not given (a new note in the Default folder).
 */
export type ToolItem = { arg: string; kind: ItemKind; ifAbsent?: "allow" };

/**
 * What a tool reads and writes, declared on every tool (Wave 34; tests/toolResourcePolicy.test.ts
 * fails for a tool without one). Chosen-item keys are enforced from this, in runTool:
 *
 * - `items`: the tool acts on the items its `items` arguments name. Each must lie inside the
 *   key's chosen items (for the tool's scopes, and for each `alsoRequires` scope); otherwise
 *   NOT_FOUND, the same as missing (T205).
 * - `list`: the tool lists items of the kinds in `lists`; its handler narrows its SQL with the
 *   key's reach (keyFilter / keyContainerIds) before any LIMIT, so counts and pages hold only
 *   granted items. Optional `items` (a folder to list) are checked as above.
 * - `derived`: the tool gathers items of several modules (Today, proposals); each part is
 *   filtered by that module's own reach inside the handler.
 * - `own`: the tool touches only what this key itself made (its uploads, its proposals).
 * - `global`: not about chosen items (team directory, a new top-level container). Hidden from a
 *   key unless its grant covers the whole module.
 *
 * `related` lists the other id arguments and why they need no check of their own: the service
 * ties them to a declared item (a column of the same board, a comment on the same card) or they
 * name people, not content. The policy test fails for an id argument that is in neither list.
 */
export type ToolAccess = {
  mode: "items" | "list" | "derived" | "own" | "global";
  items?: readonly ToolItem[];
  lists?: readonly ResourceKind[];
  related?: readonly string[];
};

export type McpErrorCode =
  | "NOT_FOUND"
  | "INVALID"
  | "SCOPE_REQUIRED"
  | "RATE_LIMITED"
  | "DRAFT_CHANGED"
  | "NOT_TEXT"
  | "TOO_LARGE"
  | "STALE_POSITION"
  | "LIMIT_REACHED"
  | "CARD_CHANGED"
  | "OWNER_ONLY"
  | "COLUMN_FULL"
  | "RELATION_EXISTS"
  | "READ_ONLY"
  | "EVENT_CHANGED"
  | "REMINDER_EXISTS"
  | "ROW_CHANGED"
  | "SCHEMA_CHANGED"
  // Wave 19 (D181): the same vocabulary as the HTTP codes.
  | "NO_DRAFT"
  | "NO_CHANGES"
  | "DRAFT_NOT_SEEN"
  | "PURGING"
  | "PARENT_IN_BIN"
  | "AUDIENCE_CHANGE"
  | "NAME_TAKEN"
  | "SPRINT_ACTIVE"
  | "UPLOAD_PENDING"
  | "UPLOAD_EXPIRED"
  | "HASH_MISMATCH"
  | "QUOTA_EXCEEDED"
  // Routines (agent inbox Wave 22, §7.2): a kind or target outside the routine, or a run already open.
  | "KIND_NOT_ALLOWED"
  | "TARGET_NOT_ALLOWED"
  | "RUN_ACTIVE"
  // Nook keys (Wave 31, D263): team policy blocks this key (not revoked; policy can allow it again).
  | "KEY_POLICY"
  | "INTERNAL";

export class McpToolError extends Error {
  constructor(readonly code: McpErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "McpToolError";
  }
}

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function textResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(code: McpErrorCode, error: string, details?: Record<string, unknown>): ToolResult {
  return { ...textResult({ error, code, ...details }), isError: true };
}

export const notFound = (what = "Note") => new McpToolError("NOT_FOUND", `${what} not found`);

/** Buckets every bin_* tool counts against (D174, T142): 50 a day and 10 a minute per key. Restores count only against write. */
export const BIN_BUCKETS = ["bin_action", "bin_burst"] as const;

/** What every bin_* tool description says, since agents read it (§2.3a). */
export const BIN_DESCRIPTION = "Moves it to the Bin for 30 days; the person can restore it. Nothing is ever deleted forever over MCP.";

/**
 * Maps a Bin restore outcome (server/bin.ts restoreItem) to a tool result or error: missing,
 * forbidden, and never binned by someone who may restore it all look the same (T148).
 */
export function restoreResult(outcome: RestoreOutcome, what: string) {
  switch (outcome.status) {
    case "restored": return { restored: true, folderId: outcome.folderId, folderName: outcome.folderName, visibility: outcome.visibility };
    case "already_restored": return { restored: true, alreadyRestored: true };
    case "calendar_restored": return { restored: true, ...(outcome.alreadyRestored ? { alreadyRestored: true } : {}), calendarId: outcome.calendarId, calendarName: outcome.calendarName };
    case "purging": throw new McpToolError("PURGING", `This ${what.toLowerCase()} is being permanently deleted`);
    case "parent_in_bin": throw new McpToolError("PARENT_IN_BIN", outcome.message ?? "Restore its parent from the Bin first");
    case "limit_reached": throw new McpToolError("LIMIT_REACHED", outcome.message);
    default: throw notFound(what);
  }
}

export type McpToolSpec<Schema extends z.ZodObject = z.ZodObject> = {
  name: string;
  title: string;
  description: string;
  /** The key needs any one of these (write scopes imply their read scope). */
  scopes: readonly McpScope[];
  /**
   * And every one of these (D172), checked at registration and in runTool: a Bin tool needs
   * `bin:write` and the module's write scope, so a notes-only key with `bin:write` cannot bin cards.
   */
  alsoRequires?: readonly McpScope[];
  /** Writes count against the per-minute write limit. */
  write: boolean;
  /** An extra daily bucket this tool counts against. */
  dailyBucket?: Exclude<McpLimitBucket, "call" | "write">;
  /** Further buckets this tool counts against (Wave 19, for example a Bin tool's daily cap and burst). */
  buckets?: readonly Exclude<McpLimitBucket, "call" | "write">[];
  /** What the tool reads and writes (D281); see ToolAccess. Required on every tool. */
  access: ToolAccess;
  inputSchema: Schema;
  handler: (args: z.infer<Schema>, key: McpKeyContext) => Promise<unknown> | unknown;
};

/** Keeps each spec's handler typed against its own schema. */
export const defineTool = <Schema extends z.ZodObject>(spec: McpToolSpec<Schema>) => spec as unknown as McpToolSpec;
