import * as z from "zod/v4";
import { defineTool, McpToolError, notFound, type McpKeyContext, type McpToolSpec } from "./mcpToolKit";
import { hasScope, type McpScope } from "./mcpScopes";
import { anchorsOf, keyReach, reachCovers } from "./keyResources";
import { workKindAdapter } from "./links/adapters";
import { createLink, deleteLink, LinkError, linksOf, refFrom, resolveRef } from "./links/service";
import { listItemActivity } from "./activity/service";
import { addComment, CommentError, listComments } from "./activity/comments";
import { datasetAllowed, datasetDef, DatasetError, listDatasets, runDatasetQuery } from "./datasets/registry";
import { structuredQuerySchema } from "./datasets/routes";
import { registeredSearchScopes, scopeAllowed } from "./searchRegistry";
import { searchPublishedNotes } from "./searchRoutes";
import { searchDocumentsForKey } from "./documentSearch";
const NOTE_COLUMNS = { note: "n.id", folder: "n.folder_id" } as const;
const DOCUMENT_COLUMNS = { document: "d.id", folder: "d.folder_id" } as const;
import { keyFilter } from "./keyResources";
import { userRole } from "./team/userRole";
import { registerMcpResource, registerMcpTools } from "./mcpRegistry";
import { registerAgentTools } from "./agents/nookBridge";
import { readableCard } from "./tasks/access";
import { cardIdForKey } from "./tasks/keys";
import { CARD_KEY_PATTERN } from "../shared/boardKeys";
import { ITEM_COMMENT_MAX, MENTIONABLE_LIMIT_MAX, MENTION_QUERY_MAX, mentionMarkdown } from "../shared/itemActivity";
import { mentionCandidates } from "./people/mentions";
import { LINK_RELATIONS, WORK_KINDS, type WorkKind, type WorkRef } from "../shared/workRefs";
import { WORKSPACE_SCOPES } from "../shared/workspaceModules";

/**
 * Cross-module MCP tools (docs/plan/WORKSPACE_MODULES.md §B.15, D814, T501, T502, T203): resolve a
 * reference, link and unlink items, list links, search the workspace, list and query datasets, read an
 * item's activity, and comment on an item.
 *
 * A tool that names items by `{kind, id}` (or a text ref) checks, per item, the read (or write) scope of
 * the module that owns the item and the key's chosen items (anchors), then the person's own access
 * through the kind's adapter; anything that fails is NOT_FOUND, never naming the item (T205). Search
 * and datasets cover whole modules, so they are hidden from keys limited to chosen items (`global`).
 */

/**
 * The tools are offered to keys holding a workspace module scope (D814 as built): a key of the older
 * modules only keeps exactly the tools it had. Each call still checks the named item's own module scope
 * (a card needs tasks:read too), so a forms key cannot read a card through resolve_ref.
 */
const WRITE_SCOPES: readonly McpScope[] = WORKSPACE_SCOPES.filter((scope) => scope.endsWith(":write"));
const READ_SCOPES: readonly McpScope[] = WORKSPACE_SCOPES.filter((scope) => scope.endsWith(":read"));

/** The item if the key may `need` it (its module's scope over the item's anchors) and the person can read it; else NOT_FOUND. */
function keyItem(key: McpKeyContext, ref: WorkRef, need: "read" | "write") {
  const adapter = workKindAdapter(ref.kind);
  if (!adapter) throw notFound("Item");
  const scope = need === "read" ? adapter.scopes.read : adapter.scopes.write;
  const reach = keyReach(key, scope);
  const anchors = adapter.itemKind ? anchorsOf(adapter.itemKind, ref.id) : reach === "all" ? [] : null;
  if (!reachCovers(reach, anchors)) throw notFound("Item");
  if (adapter.level(ref.id, { userId: key.userId }) === "none") throw notFound("Item");
  return adapter;
}

const refSchema = z.union([
  z.object({ kind: z.enum(WORK_KINDS as unknown as [WorkKind, ...WorkKind[]]), id: z.string().min(1).max(64).describe("The item's id, short id, or (cards) key such as MYT-12") }).strict(),
  z.object({ ref: z.string().min(1).max(2048).describe("A card key (MYT-12), an in-app URL, or kind:id") }).strict()
]);

function toRef(input: z.infer<typeof refSchema>, key: McpKeyContext): WorkRef {
  try {
    if ("kind" in input && input.kind === "card" && CARD_KEY_PATTERN.test(input.id)) {
      const id = cardIdForKey(input.id);
      if (!id || !readableCard(id, key.userId)) throw notFound("Item");
      return { kind: "card", id };
    }
    return refFrom(input, { userId: key.userId });
  } catch (error) {
    if (error instanceof LinkError) throw notFound("Item");
    throw error;
  }
}

const mapLinkError = (error: unknown): never => {
  if (error instanceof LinkError) throw new McpToolError(error.code === "EXISTS" ? "RELATION_EXISTS" : error.status === 404 ? "NOT_FOUND" : error.status === 403 ? "READ_ONLY" : "INVALID", error.message);
  if (error instanceof CommentError) throw new McpToolError(error.status === 404 ? "NOT_FOUND" : error.status === 403 ? "READ_ONLY" : "INVALID", error.message);
  throw error;
};

export const workTools: McpToolSpec[] = [
  defineTool({
    name: "resolve_ref",
    title: "Resolve a reference",
    description: "What a reference points to: a card key (MYT-12), an in-app URL (friendly or UUID), or kind:id. Returns the item's kind, id, title, and in-app path when you can read it; NOT_FOUND otherwise.",
    scopes: READ_SCOPES,
    access: { mode: "derived" },
    write: false,
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: z.object({ ref: z.string().min(1).max(2048) }),
    outputSchema: z.object({ summary: z.object({ kind: z.string(), id: z.string(), title: z.string(), href: z.string() }).passthrough() }),
    handler: ({ ref }, key) => {
      const resolved = resolveRef(ref, { userId: key.userId });
      if (!resolved) throw notFound("Item");
      keyItem(key, resolved.ref, "read");
      return { summary: resolved.summary };
    }
  }),
  defineTool({
    name: "list_links",
    title: "List an item's links",
    description: "Every link of an item you can read, in both directions (work links, card relations, event links, attached files). The other side is a summary, or {kind, hidden: true} when you cannot open it.",
    scopes: READ_SCOPES,
    access: { mode: "derived", related: ["item"] },
    write: false,
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: z.object({ item: refSchema }),
    handler: ({ item }, key) => {
      const ref = toRef(item, key);
      keyItem(key, ref, "read");
      // A key over chosen items sees only links whose other side it reaches too (T203).
      const keyAllows = (other: WorkRef) => {
        const adapter = workKindAdapter(other.kind);
        if (!adapter) return false;
        const reach = keyReach(key, adapter.scopes.read);
        return reachCovers(reach, adapter.itemKind ? anchorsOf(adapter.itemKind, other.id) : reach === "all" ? [] : null);
      };
      try {
        return { links: linksOf(ref, { userId: key.userId }, { keyAllows }) };
      } catch (error) {
        return mapLinkError(error);
      }
    }
  }),
  defineTool({
    name: "link_items",
    title: "Link two items",
    description: `Link item a to item b with a relation (${LINK_RELATIONS.join(", ")}): "a contributes to b". Needs edit on a and read on b, and this key's write scope for a's module and read scope for b's. RELATION_EXISTS when they are already linked that way.`,
    scopes: WRITE_SCOPES,
    access: { mode: "derived", related: ["a", "b"] },
    write: true,
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
    inputSchema: z.object({ a: refSchema, b: refSchema, relation: z.enum(LINK_RELATIONS).default("relates") }),
    handler: ({ a, b, relation }, key) => {
      const refA = toRef(a, key);
      const refB = toRef(b, key);
      keyItem(key, refA, "write");
      keyItem(key, refB, "read");
      try {
        const link = createLink({ a: refA, b: refB, relation, actorId: key.userId, via: key.surface === "rest" ? "rest" : "mcp" });
        return { link: { id: link.id, a: refA, b: refB, relation: link.relation, createdAt: link.created_at } };
      } catch (error) {
        return mapLinkError(error);
      }
    }
  }),
  defineTool({
    name: "unlink_items",
    title: "Remove a link",
    description: "Remove a work link by its id (from list_links). Needs edit on either side and this key's write scope for that side's module.",
    scopes: WRITE_SCOPES,
    access: { mode: "derived", related: ["linkId"] },
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    inputSchema: z.object({ linkId: z.string().uuid() }),
    handler: async ({ linkId }, key) => {
      const { db } = await import("./db");
      const row = db.query("SELECT a_kind, a_id, b_kind, b_id FROM work_links WHERE id = ?").get(linkId.toLowerCase()) as { a_kind: WorkKind; a_id: string; b_kind: WorkKind; b_id: string } | null;
      if (!row) throw notFound("Link");
      const sides = [{ kind: row.a_kind, id: row.a_id }, { kind: row.b_kind, id: row.b_id }];
      if (!sides.some((side) => { try { keyItem(key, side, "write"); return true; } catch { return false; } })) throw notFound("Link");
      try {
        deleteLink(linkId.toLowerCase(), key.userId);
        return { removed: true };
      } catch (error) {
        return mapLinkError(error);
      }
    }
  }),
  defineTool({
    name: "get_item_activity",
    title: "Read an item's activity",
    description: "The history of a workspace item (a form, goal, contact, …) you can read, newest first, 50 at a time; pass nextCursor for more. Cards have their own get_card_activity.",
    scopes: READ_SCOPES,
    access: { mode: "derived", related: ["item"] },
    write: false,
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: z.object({ item: refSchema, cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional() }),
    handler: ({ item, cursor, limit }, key) => {
      const ref = toRef(item, key);
      keyItem(key, ref, "read");
      return listItemActivity(ref.kind, ref.id, { cursor: cursor ?? null, limit: limit ?? 50 });
    }
  }),
  defineTool({
    name: "list_item_comments",
    title: "List an item's comments",
    description: "Comments on a workspace item you can read, oldest first, replies after their comment.",
    scopes: READ_SCOPES,
    access: { mode: "derived", related: ["item"] },
    write: false,
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: z.object({ item: refSchema }),
    handler: ({ item }, key) => {
      const ref = toRef(item, key);
      keyItem(key, ref, "read");
      try {
        return { comments: listComments(ref.kind, ref.id, key.userId) };
      } catch (error) {
        return mapLinkError(error);
      }
    }
  }),
  defineTool({
    name: "comment_on_item",
    title: "Comment on an item",
    description: "Add a Markdown comment (or a reply, with parentId) to a workspace item where you can comment. Mention a person as @[Name](user:<id>) (find_people_to_mention gives the text); they are notified if they can read the item.",
    scopes: WRITE_SCOPES,
    access: { mode: "derived", related: ["item", "parentId"] },
    write: true,
    annotations: { readOnlyHint: false, idempotentHint: false },
    inputSchema: z.object({ item: refSchema, body: z.string().min(1).max(ITEM_COMMENT_MAX), parentId: z.string().uuid().optional() }),
    handler: ({ item, body, parentId }, key) => {
      const ref = toRef(item, key);
      keyItem(key, ref, "write");
      try {
        return { comment: addComment({ kind: ref.kind, itemId: ref.id, authorId: key.userId, body, parentId: parentId?.toLowerCase() ?? null }) };
      } catch (error) {
        return mapLinkError(error);
      }
    }
  }),
  defineTool({
    name: "find_people_to_mention",
    title: "Find people to mention",
    description: "People you can @mention on an item you can read (a card, a note, a goal, a contact, …), matched by name: their id, name, whether they can read the item, and the ready-made mention text to put in a comment or a card description, e.g. @[Ana Silva](user:<id>). Only people who can read the item are notified; a mention never shares the item.",
    scopes: [...READ_SCOPES, "tasks:read", "notes:read"],
    access: { mode: "derived", related: ["item"] },
    write: false,
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: z.object({ item: refSchema, query: z.string().max(MENTION_QUERY_MAX).optional(), limit: z.number().int().min(1).max(MENTIONABLE_LIMIT_MAX).optional() }),
    handler: ({ item, query, limit }, key) => {
      const ref = toRef(item, key);
      keyItem(key, ref, "read");
      const role = userRole(key.userId);
      const people = role ? mentionCandidates({ id: key.userId, role }, ref.kind, ref.id, { q: query, limit: limit ?? MENTIONABLE_LIMIT_MAX }) : null;
      if (!people) throw notFound("Item");
      return { people: people.map((person) => ({ id: person.id, name: person.displayName, canRead: person.canRead, mention: mentionMarkdown(person.displayName, person.id) })) };
    }
  }),
  defineTool({
    name: "search_workspace",
    title: "Search the workspace",
    description: "Search across modules at once: published notes, files, and every workspace module this key can read (forms, goals, contacts, …). The top results per module, titles and plain snippets only.",
    scopes: READ_SCOPES,
    access: { mode: "global" },
    write: false,
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(10).optional() }),
    handler: async ({ query, limit }, key) => {
      const per = limit ?? 5;
      const role = userRole(key.userId) ?? "guest";
      const sections: Array<{ scope: string; results: unknown[]; truncated: boolean }> = [];
      if (hasScope(key.scopes, "notes:read")) sections.push({ scope: "notes", ...searchPublishedNotes(key.userId, query, { folderId: null, limit: per, keyScope: keyFilter(key, "notes:read", NOTE_COLUMNS) }) });
      if (hasScope(key.scopes, "files:read")) sections.push({ scope: "files", ...searchDocumentsForKey(key.userId, query, { folderId: null, limit: per, keyScope: keyFilter(key, "files:read", DOCUMENT_COLUMNS) }) });
      for (const def of registeredSearchScopes()) {
        if (!scopeAllowed(def, role) || !hasScope(key.scopes, `${def.module}:read` as McpScope)) continue;
        const found = await def.search({ userId: key.userId, role, q: query, limit: per });
        sections.push({ scope: def.scope, results: found.results.slice(0, per), truncated: found.truncated });
      }
      return { sections };
    }
  }),
  defineTool({
    name: "list_datasets",
    title: "List datasets",
    description: "The workspace datasets this key can query with query_dataset: their columns (what can be grouped by, and which measures each allows) and time column.",
    scopes: READ_SCOPES,
    access: { mode: "global" },
    write: false,
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: z.object({}),
    handler: (_args, key) => {
      const role = userRole(key.userId) ?? "guest";
      return { datasets: listDatasets(role).filter((info) => hasScope(key.scopes, datasetDef(info.id)!.readScope)) };
    }
  }),
  defineTool({
    name: "query_dataset",
    title: "Query a dataset",
    description: "Run a structured query (never SQL) on a dataset from list_datasets: measures (count, sum, avg, min, max, count_distinct), dimensions to group by, filters, a time range and bucket (day, week, month, quarter), sort, and a limit (at most 1000 rows). Only rows you can read are counted.",
    scopes: READ_SCOPES,
    access: { mode: "global" },
    write: false,
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: structuredQuerySchema as unknown as z.ZodObject,
    handler: (query, key) => {
      const parsed = structuredQuerySchema.safeParse(query);
      if (!parsed.success) throw new McpToolError("INVALID", "Invalid query");
      const def = datasetDef(parsed.data.dataset);
      const role = userRole(key.userId) ?? "guest";
      if (!def || !datasetAllowed(def, role) || !hasScope(key.scopes, def.readScope)) throw notFound("Dataset");
      try {
        return runDatasetQuery(parsed.data, { userId: key.userId, role });
      } catch (error) {
        if (error instanceof DatasetError) throw new McpToolError("INVALID", error.message);
        throw error;
      }
    }
  })
];

registerMcpTools(workTools);

// Resources (§B.15): nook://card/<key or id>, read through the card's own checks.
registerMcpResource({
  kind: "card", title: "Card", description: "A card by key (MYT-12) or id: its title, board, column, and in-app path.", scopes: ["tasks:read"], itemKind: "card",
  read: (id, key) => {
    const cardId = CARD_KEY_PATTERN.test(id) ? cardIdForKey(id) : id.toLowerCase();
    const summary = cardId ? workKindAdapter("card")!.resolve([cardId], { userId: key.userId }).get(cardId) : null;
    return summary ?? null;
  }
});
registerMcpResource({
  kind: "note", title: "Note", description: "A note by id or short id: its title and in-app path (read_note returns the text).", scopes: ["notes:read"], itemKind: "note",
  read: (id, key) => {
    const adapter = workKindAdapter("note")!;
    const noteId = /^[0-9][0-9a-z]{9}$/.test(id) ? adapter.lookup?.({ kind: "note", ref: id, by: "short_id" }) ?? null : id.toLowerCase();
    return noteId ? adapter.resolve([noteId], { userId: key.userId }).get(noteId) ?? null : null;
  }
});

// Chat agents (§B.15): every cross-module tool is offered; writes (links, comments) have no proposal
// kind, so they run only where the agent's mode allows direct writes (D353/D359).
registerAgentTools({ allowed: workTools.map((spec) => spec.name) });
