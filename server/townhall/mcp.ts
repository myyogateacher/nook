import * as z from "zod/v4";
import { config } from "../config";
import { BIN_BUCKETS, BIN_DESCRIPTION, defineTool, McpToolError, restoreResult, type McpKeyContext, type McpToolSpec } from "../mcpToolKit";
import { restoreItem } from "../bin";
import { keyContainerIds } from "../keyResources";
import { MODERATION_ACTIONS, POLL_KINDS, TOWNHALL_LIMITS, TOWNHALL_STATES } from "../../shared/townhall";
import {
  askQuestion, binSession, closePoll, createPoll, createSession, launchPoll, listSessions, moderateQuestion, readQuestion, readSession, recap, recapCsv, recapMarkdown,
  stateFor, TownhallError, voteQuestion
} from "./service";

/**
 * Townhall's MCP tools (docs/plan/WORKSPACE_MODULES.md §B.15, §D.7 Townhall, D1082): list and get
 * sessions, ask, upvote, moderate, launch and close polls, export the recap, create a session.
 * `townhall:read` reads; `townhall:write` asks, upvotes, and votes in any session the person can open,
 * and moderates or runs polls only where the person is a host (edit and up). Keys limited to chosen
 * sessions reach only those (items anchored on `townhall_session`, T203); a session the key or the
 * person cannot reach is NOT_FOUND, never named (T205). REST v1 exposes the same tools.
 */

function mapError(error: unknown): never {
  if (error instanceof TownhallError) {
    const code = error.status === 404 ? "NOT_FOUND" : error.status === 403 ? (error.code === "OWNER_ONLY" ? "OWNER_ONLY" : "READ_ONLY") : error.status === 429 ? "RATE_LIMITED" : error.code === "LIMIT_REACHED" ? "LIMIT_REACHED" : "INVALID";
    throw new McpToolError(code, error.message, error.details);
  }
  throw error;
}
const run = <T>(fn: () => T): T => { try { return fn(); } catch (error) { return mapError(error); } };
const url = (href: string) => `${config.appOrigin}${href}`;
const sessionId = z.string().min(6).max(80).describe("The session's id, short id, or URL segment (all-hands-k7f3q2ab01)");

const SESSION_OUT = z.object({ id: z.string(), shortId: z.string(), title: z.string(), state: z.string(), startsAt: z.string().nullable(), url: z.string() }).passthrough();

export const townhallMcpTools: McpToolSpec[] = [
  defineTool({
    name: "list_townhall_sessions",
    title: "List townhall sessions",
    description: "Townhall sessions you can open, live ones first, then by start time (newest first). Filter by state; page with cursor.",
    scopes: ["townhall:read"],
    access: { mode: "list", lists: ["townhall_session"] },
    write: false,
    inputSchema: z.object({
      state: z.enum([...TOWNHALL_STATES, "all"]).optional().describe("upcoming, live, ended, or all (default)"),
      query: z.string().max(200).optional().describe("Words in the title"),
      cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional()
    }),
    outputSchema: z.object({ items: z.array(SESSION_OUT), nextCursor: z.string().nullable() }),
    handler: (args, key: McpKeyContext) => {
      const ids = keyContainerIds(key, "townhall:read", "townhall_session");
      const page = listSessions(key.userId, { state: args.state ?? "all", q: args.query, cursor: args.cursor ?? null, limit: args.limit ?? 50, ids });
      return { items: page.items.map((item) => ({ ...item, url: url(item.href) })), nextCursor: page.nextCursor };
    }
  }),
  defineTool({
    name: "get_townhall_session",
    title: "Get a townhall session",
    description: "A session with its questions (sorted by upvotes; pending and hidden ones only for hosts), polls with results as you may see them, and counts.",
    scopes: ["townhall:read"],
    access: { mode: "items", items: [{ arg: "sessionId", kind: "townhall_session" }] },
    write: false,
    inputSchema: z.object({ sessionId }),
    handler: ({ sessionId: ref }, key) => run(() => {
      const state = stateFor(ref, key.userId);
      const questions = [...state.questions].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.votes - a.votes || (a.createdAt < b.createdAt ? 1 : -1));
      return { ...state, questions, url: url(state.session.href) };
    })
  }),
  defineTool({
    name: "create_townhall_session",
    title: "Create a townhall session",
    description: "Creates a session you host (open to everyone signed in by default). Optionally a start time (ISO) and settings.",
    scopes: ["townhall:write"],
    access: { mode: "global" },
    write: true,
    annotations: { idempotentHint: false },
    inputSchema: z.object({
      title: z.string().min(1).max(TOWNHALL_LIMITS.title), description: z.string().max(TOWNHALL_LIMITS.description).optional(),
      startsAt: z.string().max(40).optional().describe("ISO date and time"), allowAnonymous: z.boolean().optional(), moderation: z.enum(["off", "review"]).optional().describe("review: questions wait for a host's approval")
    }),
    handler: (args, key) => run(() => {
      const session = createSession(key.userId, { title: args.title, description: args.description, startsAt: args.startsAt ?? null, allowAnonymous: args.allowAnonymous, moderation: args.moderation });
      return { session: { ...session, url: url(session.href) } };
    })
  }),
  defineTool({
    name: "bin_townhall_session", title: "Move a townhall session to the Bin",
    description: `Moves a session you own or manage to the Bin, with its questions, polls, and recap; its audience link stops working. ${BIN_DESCRIPTION} Restore it with restore_townhall_session.`,
    scopes: ["townhall:write"], alsoRequires: ["bin:write"], buckets: BIN_BUCKETS, access: { mode: "items", items: [{ arg: "sessionId", kind: "townhall_session" }] }, write: true, annotations: { destructiveHint: true },
    inputSchema: z.object({ sessionId }).strict(),
    // D1385: the REST DELETE /api/townhall/sessions/:id, over MCP.
    handler: ({ sessionId: ref }, key) => run(() => binSession(ref, key.userId))
  }),
  defineTool({
    name: "restore_townhall_session", title: "Restore a townhall session from the Bin",
    description: "Restores a session you own from the Bin, with its questions, polls, and recap.",
    scopes: ["townhall:write"], alsoRequires: ["bin:write"], access: { mode: "items", items: [{ arg: "sessionId", kind: "townhall_session" }] }, write: true,
    inputSchema: z.object({ sessionId: z.string().uuid().describe("The session's id") }).strict(),
    // D1385: the restore every bin_* tool's description promises, through the module's Bin provider.
    handler: async ({ sessionId }, key) => restoreResult(await restoreItem("townhall_session", sessionId.toLowerCase(), key.userId), "Session")
  }),
  defineTool({
    name: "ask_townhall_question",
    title: "Ask a townhall question",
    description: "Asks a question in a session as you (or anonymously when the session allows it). In sessions with review on, it waits for a host.",
    scopes: ["townhall:write"],
    access: { mode: "items", items: [{ arg: "sessionId", kind: "townhall_session" }] },
    write: true,
    annotations: { idempotentHint: false },
    inputSchema: z.object({ sessionId, text: z.string().min(1).max(TOWNHALL_LIMITS.question), anonymous: z.boolean().optional() }),
    handler: ({ sessionId: ref, text, anonymous }, key) => run(() => ({ question: askQuestion(ref, { kind: "user", userId: key.userId }, { text, anonymous, via: key.surface === "rest" ? "rest" : "mcp" }) }))
  }),
  defineTool({
    name: "upvote_townhall_question",
    title: "Upvote a townhall question",
    description: "Adds (upvote: true) or removes (false) your upvote on a question. Idempotent.",
    scopes: ["townhall:write"],
    access: { mode: "items", items: [{ arg: "questionId", kind: "townhall_question" }] },
    write: true,
    annotations: { idempotentHint: true },
    inputSchema: z.object({ questionId: z.string().uuid(), upvote: z.boolean().default(true) }),
    handler: ({ questionId, upvote }, key) => run(() => voteQuestion(questionId, { kind: "user", userId: key.userId }, upvote))
  }),
  defineTool({
    name: "moderate_townhall_question",
    title: "Moderate a townhall question",
    description: "Hosts only: approve, hide, unhide, answered, reopen, pin (show as the current question), unpin, star, unstar, or merge into targetId (a duplicate's votes move to the target).",
    scopes: ["townhall:write"],
    access: { mode: "items", items: [{ arg: "questionId", kind: "townhall_question" }], related: ["targetId"] },
    write: true,
    inputSchema: z.object({ questionId: z.string().uuid(), action: z.enum(MODERATION_ACTIONS), targetId: z.string().uuid().optional().describe("merge: the question of the same session to merge into") }),
    handler: ({ questionId, action, targetId }, key) => run(() => {
      readQuestion(questionId, key.userId);
      return { question: moderateQuestion(questionId, key.userId, action, { targetId }) };
    })
  }),
  defineTool({
    name: "launch_townhall_poll",
    title: "Launch a townhall poll",
    description: "Hosts only: launches a poll during the session (closing the one that was live). Give pollId to launch a prepared poll, or kind + title (+ options for choice polls) to create and launch one.",
    scopes: ["townhall:write"],
    access: { mode: "items", items: [{ arg: "sessionId", kind: "townhall_session" }], related: ["pollId"] },
    write: true,
    annotations: { idempotentHint: false },
    inputSchema: z.object({
      sessionId, pollId: z.string().uuid().optional(),
      kind: z.enum(POLL_KINDS).optional(), title: z.string().max(TOWNHALL_LIMITS.pollTitle).optional(), options: z.array(z.string().max(TOWNHALL_LIMITS.optionLabel)).max(TOWNHALL_LIMITS.pollOptions).optional(),
      resultsHidden: z.boolean().optional()
    }),
    handler: (args, key) => run(() => {
      if (args.pollId) return launchPoll(args.sessionId, args.pollId, key.userId);
      if (!args.kind || !args.title) throw new McpToolError("INVALID", "Give pollId, or kind and title");
      const created = createPoll(args.sessionId, key.userId, { kind: args.kind, title: args.title, options: args.options, resultsHidden: args.resultsHidden, launch: true });
      return { pollId: created.pollId, status: "live" };
    })
  }),
  defineTool({
    name: "close_townhall_poll",
    title: "Close a townhall poll",
    description: "Hosts only: closes a live poll; its results stay visible.",
    scopes: ["townhall:write"],
    access: { mode: "items", items: [{ arg: "sessionId", kind: "townhall_session" }], related: ["pollId"] },
    write: true,
    annotations: { idempotentHint: true },
    inputSchema: z.object({ sessionId, pollId: z.string().uuid() }),
    handler: ({ sessionId: ref, pollId }, key) => run(() => closePoll(ref, pollId, key.userId))
  }),
  defineTool({
    name: "export_townhall_recap",
    title: "Export a townhall recap",
    description: "The session's recap: totals, answered and open questions, poll results. format: json (default), markdown, or csv (questions).",
    scopes: ["townhall:read"],
    access: { mode: "items", items: [{ arg: "sessionId", kind: "townhall_session" }] },
    write: false,
    inputSchema: z.object({ sessionId, format: z.enum(["json", "markdown", "csv"]).optional() }),
    handler: ({ sessionId: ref, format }, key) => run(() => {
      readSession(ref, key.userId);
      if (format === "csv") return { format, csv: recapCsv(ref, key.userId) };
      const data = recap(ref, key.userId);
      return format === "markdown" ? { format, markdown: recapMarkdown(data) } : { format: "json", recap: { ...data, url: url(data.session.href) } };
    })
  })
];

export const TOWNHALL_AGENT_TOOLS = {
  // ask_townhall_question is offered as the townhall_question proposal kind (Wave 3, D1047).
  allowed: ["list_townhall_sessions", "get_townhall_session", "export_townhall_recap", "ask_townhall_question"],
  never: ["create_townhall_session", "upvote_townhall_question", "moderate_townhall_question", "launch_townhall_poll", "close_townhall_poll"]
} as const;
