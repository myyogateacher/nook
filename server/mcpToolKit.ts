import * as z from "zod/v4";
import type { McpLimitBucket } from "./mcpRateLimit";
import type { McpScope } from "./mcpScopes";

/**
 * Building blocks shared by every module's MCP tools (server/mcpTools.ts and
 * server/tasks/mcpTools.ts): the key context, the tool spec, and the
 * `{error, code}` error shape. No imports of services, so modules can depend
 * on it without import cycles.
 */

export type McpKeyContext = { keyId: string; userId: string; name: string; scopes: McpScope[] };

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
  inputSchema: Schema;
  handler: (args: z.infer<Schema>, key: McpKeyContext) => Promise<unknown> | unknown;
};

/** Keeps each spec's handler typed against its own schema. */
export const defineTool = <Schema extends z.ZodObject>(spec: McpToolSpec<Schema>) => spec as unknown as McpToolSpec;
