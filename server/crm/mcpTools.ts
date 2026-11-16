import * as z from "zod/v4";
import { db } from "../db";
import { BIN_BUCKETS, BIN_DESCRIPTION, defineTool, McpToolError, restoreResult, type McpErrorCode, type McpKeyContext, type McpToolSpec } from "../mcpToolKit";
import { restoreItem } from "../bin";
import { keyContainerIds, keyFilter } from "../keyResources";
import { PeopleError, upsertContactByEmail } from "../people/contacts";
import { INTERACTION_KINDS, type CrmContact, type CrmDeal } from "../../shared/crm";
import { CrmError, listBooks, requireBook } from "./core";
import { binCompany, binContact, createCompany, createContact, getCompany, getContact, listCompanies, listContacts, mergeContacts, readContactRow, toContact, updateCompany, updateContact } from "./records";
import { binDeal, createDeal, getDeal, listDeals, listPipelines, pipelineSummary, updateDeal } from "./deals";
import { createFollowup, listInteractions, logInteraction } from "./interactions";
import { searchCrm } from "./integrations";

/**
 * Contacts MCP tools (§D.5, §B.15): CRUD for contacts, companies, and deals; search; moving a deal's
 * stage; logging interactions; follow-ups; pipeline summary; bulk upsert/update with `dryRun`. Reads
 * need `crm:read`, writes `crm:write`; chosen-book keys reach only their books (list SQL narrowed by
 * `keyFilter` before LIMIT; item tools anchored on the record's book). Deleting is moving to the Bin
 * (`bin_*`, which also needs `bin:write`). Agents get channels (emails, phones) only from
 * `get_contact` (T566): list results leave them out.
 */

const ref = z.string().trim().min(6).max(64);
const filters = z.array(z.object({ field: z.string().max(40), op: z.enum(["eq", "neq", "contains", "empty", "not_empty", "gt", "lt", "in"]), value: z.union([z.string().max(300), z.number(), z.boolean(), z.array(z.string().max(300)).max(100)]).optional() })).max(20).optional();
const page = { cursor: z.string().max(400).optional(), limit: z.number().int().min(1).max(100).optional() };
const custom = z.record(z.string().max(60), z.union([z.string().max(4000), z.number(), z.boolean(), z.array(z.string()).max(20), z.null()])).optional();

const CODES: Record<string, McpErrorCode> = { NOT_FOUND: "NOT_FOUND", INVALID: "INVALID", READ_ONLY: "READ_ONLY", RATE_LIMITED: "RATE_LIMITED", LIMIT_REACHED: "LIMIT_REACHED" };

/** Runs a service call and maps its errors to MCP errors (unknown CRM codes become INVALID with `reason`). */
async function run<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CrmError || error instanceof PeopleError) {
      const code = CODES[error.code] ?? (error.code === "CONFLICT" ? "CONFLICT" as McpErrorCode : "INVALID");
      throw new McpToolError(code, error.message, { ...(error instanceof CrmError ? error.details : {}), ...(CODES[error.code] ? {} : { reason: error.code }) });
    }
    throw error;
  }
}

/** A contact as list tools return it: no emails or phones (T566). */
const slimContact = (contact: CrmContact) => ({ id: contact.id, shortId: contact.shortId, bookId: contact.bookId, name: contact.displayName, jobTitle: contact.jobTitle, company: contact.companyName, companyId: contact.companyId,
  owner: contact.owner?.name ?? null, lifecycle: contact.lifecycle, tags: contact.tags, lastInteractionAt: contact.lastInteractionAt, href: contact.href });
const slimDeal = (deal: CrmDeal) => ({ id: deal.id, shortId: deal.shortId, bookId: deal.bookId, title: deal.title, pipelineId: deal.pipelineId, stage: deal.stageName, stageId: deal.stageId, status: deal.status,
  value: deal.value, probability: deal.probability, expectedCloseOn: deal.expectedCloseOn, owner: deal.owner?.name ?? null, company: deal.companyName, contacts: deal.contacts.map((c) => c.name),
  nextStep: deal.nextStep, nextStepOn: deal.nextStepOn, rotting: deal.rotting, lostReason: deal.lostReason, href: deal.href });

const bookFilter = (key: McpKeyContext, scope: "crm:read" | "crm:write", column: string) => keyFilter(key, scope, { contact_book: column });

const contactFields = {
  name: z.string().max(160).optional(), firstName: z.string().max(80).nullable().optional(), lastName: z.string().max(80).nullable().optional(), email: z.string().max(254).nullable().optional(),
  phone: z.string().max(60).nullable().optional(), jobTitle: z.string().max(120).nullable().optional(), companyName: z.string().max(200).nullable().optional(),
  lifecycle: z.string().max(40).nullable().optional(), location: z.string().max(200).nullable().optional(), tags: z.array(z.string().max(40)).max(30).optional(), custom
};

const dealFields = {
  title: z.string().max(200).optional(), stage: z.string().max(64).optional().describe("Stage name or id"), value: z.number().int().min(0).nullable().optional().describe("Minor units (cents)"),
  currency: z.string().length(3).optional(), expectedCloseOn: z.string().max(10).nullable().optional(), nextStep: z.string().max(200).nullable().optional(), nextStepOn: z.string().max(10).nullable().optional(),
  lostReason: z.string().max(200).nullable().optional(), tags: z.array(z.string().max(40)).max(30).optional(), custom
};
const stageInput = (stage: string | undefined) => stage === undefined ? {} : /^[0-9a-f-]{36}$/i.test(stage) ? { stageId: stage } : { stageName: stage };

export const crmMcpTools: McpToolSpec[] = [
  defineTool({
    name: "list_contact_books", title: "List contact books", description: "The contact books you can read, with their custom fields per kind and counts.",
    scopes: ["crm:read"], access: { mode: "list", lists: ["contact_book"] }, write: false, annotations: { readOnlyHint: true },
    inputSchema: z.object({}).strict(),
    handler: (_args, key) => ({ books: listBooks(key.userId, keyContainerIds(key, "crm:read", "contact_book")).map((book) => ({ id: book.id, name: book.name, level: book.level, counts: book.counts, settings: book.settings,
      fields: Object.fromEntries(Object.entries(book.fields).map(([entity, list]) => [entity, list.map((field) => ({ id: field.id, name: field.name, type: field.type, options: field.options?.map((option) => option.label) }))])) })) })
  }),
  defineTool({
    name: "search_crm", title: "Search contacts, companies, deals, and notes", description: "Full-text search over contacts (names, emails, phones, company), companies (name, domain), deals (title), and logged interactions, in books you can read.",
    scopes: ["crm:read"], access: { mode: "list", lists: ["contact_book"] }, write: false, annotations: { readOnlyHint: true },
    inputSchema: z.object({ q: z.string().trim().min(1).max(200), entity: z.enum(["contact", "company", "deal", "interaction"]).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
    handler: ({ q, entity, limit }, key) => ({ results: searchCrm(key.userId, q, entity ?? null, limit ?? 20, keyContainerIds(key, "crm:read", "contact_book")) })
  }),
  defineTool({
    name: "list_contacts", title: "List contacts", description: "Contacts in books you can read (one book with bookId), filtered (fields: name, email, company, owner, lifecycle, tag, source, last_interaction, created, or a custom field's id or name) and keyset paged. Emails and phones come from get_contact.",
    scopes: ["crm:read"], access: { mode: "list", lists: ["contact_book"], items: [{ arg: "bookId", kind: "contact_book", ifAbsent: "allow" }], related: ["listId"] }, write: false, annotations: { readOnlyHint: true },
    inputSchema: z.object({ bookId: ref.optional(), q: z.string().max(100).optional(), listId: ref.optional().describe("Only members of this list (a list in a book you can read)"), filters, sort: z.object({ field: z.string().max(40), dir: z.enum(["asc", "desc"]) }).optional(), ...page }).strict(),
    handler: (args, key) => run(() => {
      const result = listContacts(key.userId, { bookIds: args.bookId ? [requireBook(args.bookId, key.userId).id] : null, q: args.q, listId: args.listId, filters: args.filters as never, sort: args.sort, cursor: args.cursor, limit: args.limit, keyFilter: bookFilter(key, "crm:read", "c.book_id") });
      return { items: result.items.map(slimContact), nextCursor: result.nextCursor };
    })
  }),
  defineTool({
    name: "get_contact", title: "Get a contact", description: "One contact with emails, phones, company, deals, lists, and possible duplicates. contactId is its id or short id.",
    scopes: ["crm:read"], access: { mode: "items", items: [{ arg: "contactId", kind: "contact" }] }, write: false, annotations: { readOnlyHint: true },
    inputSchema: z.object({ contactId: ref }).strict(),
    handler: ({ contactId }, key) => run(() => { const contact = getContact(contactId, key.userId); return { ...contact, deals: contact.deals.map(slimDeal) }; })
  }),
  defineTool({
    name: "create_contact", title: "Create a contact", description: "Adds a contact to a book you can edit. An email another contact of the book has is refused (reason EXISTS, contactId given); use upsert_contact to update by email.",
    scopes: ["crm:write"], access: { mode: "items", items: [{ arg: "bookId", kind: "contact_book" }], related: ["companyId", "ownerId"] }, write: true,
    inputSchema: z.object({ bookId: ref, ...contactFields, companyId: ref.nullable().optional().describe("A company of the same book"), ownerId: z.string().uuid().nullable().optional().describe("A team member (a person, not content)") }).strict(),
    handler: (args, key) => run(() => ({ contact: createContact(key.userId, args as never, "mcp") }))
  }),
  defineTool({
    name: "update_contact", title: "Update a contact", description: "Changes a contact's fields (only those given). expectedRevision makes a stale write fail with CONFLICT.",
    scopes: ["crm:write"], access: { mode: "items", items: [{ arg: "contactId", kind: "contact" }], related: ["companyId", "ownerId"] }, write: true, annotations: { idempotentHint: true },
    inputSchema: z.object({ contactId: ref, ...contactFields, companyId: ref.nullable().optional().describe("A company of the same book"), ownerId: z.string().uuid().nullable().optional().describe("A team member"), expectedRevision: z.number().int().optional() }).strict(),
    handler: ({ contactId, ...patch }, key) => run(() => ({ contact: updateContact(contactId, key.userId, patch as never) }))
  }),
  defineTool({
    name: "upsert_contact", title: "Add or update a contact by email", description: "Finds the contact with this email in the book, else creates one. Fills only empty fields and never overwrites what a person edited by hand; links the company by email domain when the book does.",
    scopes: ["crm:write"], access: { mode: "items", items: [{ arg: "bookId", kind: "contact_book" }] }, write: true, annotations: { idempotentHint: true },
    inputSchema: z.object({ bookId: ref, email: z.string().max(254), name: z.string().max(160).optional(), phone: z.string().max(60).optional(), company: z.string().max(200).optional() }).strict(),
    handler: (args, key) => run(() => db.transaction(() => {
      const book = requireBook(args.bookId, key.userId, "edit");
      const result = upsertContactByEmail(book.id, { email: args.email, name: args.name ?? null, phone: args.phone ?? null, company: args.company ?? null }, { source: "mcp", actor: key.userId });
      return { created: result.created, filled: result.filled, contact: toContact(readContactRow(result.contactId, key.userId)) };
    })())
  }),
  defineTool({
    name: "merge_contacts", title: "Merge two contacts", description: "Merges contactId into intoContactId (same book): the kept contact takes missing fields, emails, phones, tags, deals, interactions, lists, and links; the other is removed.",
    scopes: ["crm:write"], access: { mode: "items", items: [{ arg: "contactId", kind: "contact" }, { arg: "intoContactId", kind: "contact" }] }, write: true, annotations: { destructiveHint: true },
    inputSchema: z.object({ contactId: ref, intoContactId: ref }).strict(),
    handler: ({ contactId, intoContactId }, key) => run(() => ({ contact: mergeContacts(contactId, intoContactId, key.userId) }))
  }),
  defineTool({
    name: "bulk_upsert_contacts", title: "Add or update many contacts", description: "Up to 100 contacts by email in one book, all or nothing. dryRun returns what would be created and updated without writing.",
    scopes: ["crm:write"], access: { mode: "items", items: [{ arg: "bookId", kind: "contact_book" }] }, write: true,
    inputSchema: z.object({ bookId: ref, contacts: z.array(z.object({ email: z.string().max(254), name: z.string().max(160).optional(), phone: z.string().max(60).optional(), company: z.string().max(200).optional() }).strict()).min(1).max(100), dryRun: z.boolean().optional() }).strict(),
    handler: (args, key) => run(() => {
      const book = requireBook(args.bookId, key.userId, "edit");
      const plan = args.contacts.map((contact) => {
        const existing = db.query("SELECT contact_id FROM contact_channels WHERE book_id = ? AND kind = 'email' AND value_norm = ?").get(book.id, contact.email.trim().toLowerCase()) as { contact_id: string } | null;
        return { email: contact.email.trim().toLowerCase(), action: existing ? "update" as const : "create" as const, contactId: existing?.contact_id ?? null };
      });
      if (args.dryRun) return { dryRun: true, plan, creates: plan.filter((item) => item.action === "create").length, updates: plan.filter((item) => item.action === "update").length };
      const results = db.transaction(() => args.contacts.map((contact) => upsertContactByEmail(book.id, { email: contact.email, name: contact.name ?? null, phone: contact.phone ?? null, company: contact.company ?? null }, { source: "mcp", actor: key.userId })))();
      return { dryRun: false, results: results.map((result) => ({ contactId: result.contactId, created: result.created, filled: result.filled })) };
    })
  }),
  defineTool({
    name: "bin_contact", title: "Move a contact to the Bin", description: `Moves a contact to the Bin. ${BIN_DESCRIPTION}`,
    scopes: ["crm:write"], alsoRequires: ["bin:write"], buckets: BIN_BUCKETS, access: { mode: "items", items: [{ arg: "contactId", kind: "contact" }] }, write: true, annotations: { destructiveHint: true },
    inputSchema: z.object({ contactId: ref }).strict(),
    handler: ({ contactId }, key) => run(() => binContact(contactId, key.userId))
  }),
  defineTool({
    name: "list_companies", title: "List companies", description: "Companies in books you can read, filtered (name, domain, owner, tag, source, last_interaction, created, or a custom field) and keyset paged.",
    scopes: ["crm:read"], access: { mode: "list", lists: ["contact_book"], items: [{ arg: "bookId", kind: "contact_book", ifAbsent: "allow" }], related: ["listId"] }, write: false, annotations: { readOnlyHint: true },
    inputSchema: z.object({ bookId: ref.optional(), q: z.string().max(100).optional(), listId: ref.optional().describe("Only members of this list"), filters, ...page }).strict(),
    handler: (args, key) => run(() => listCompanies(key.userId, { bookIds: args.bookId ? [requireBook(args.bookId, key.userId).id] : null, q: args.q, listId: args.listId, filters: args.filters as never, cursor: args.cursor, limit: args.limit, keyFilter: bookFilter(key, "crm:read", "co.book_id") }))
  }),
  defineTool({
    name: "get_company", title: "Get a company", description: "One company with its contacts (without channels) and deals.",
    scopes: ["crm:read"], access: { mode: "items", items: [{ arg: "companyId", kind: "company" }] }, write: false, annotations: { readOnlyHint: true },
    inputSchema: z.object({ companyId: ref }).strict(),
    handler: ({ companyId }, key) => run(() => { const company = getCompany(companyId, key.userId); return { ...company, contacts: company.contacts.map(slimContact), deals: company.deals.map(slimDeal) }; })
  }),
  defineTool({
    name: "create_company", title: "Create a company", description: "Adds a company to a book you can edit. A domain another company of the book has is refused (reason EXISTS).",
    scopes: ["crm:write"], access: { mode: "items", items: [{ arg: "bookId", kind: "contact_book" }], related: ["ownerId"] }, write: true,
    inputSchema: z.object({ bookId: ref, name: z.string().max(200), domain: z.string().max(253).nullable().optional(), website: z.string().max(2048).nullable().optional(), description: z.string().max(20000).nullable().optional(), ownerId: z.string().uuid().nullable().optional().describe("A team member"), tags: z.array(z.string().max(40)).max(30).optional(), custom }).strict(),
    handler: (args, key) => run(() => ({ company: createCompany(key.userId, args as never, "mcp") }))
  }),
  defineTool({
    name: "update_company", title: "Update a company", description: "Changes a company's fields (only those given).",
    scopes: ["crm:write"], access: { mode: "items", items: [{ arg: "companyId", kind: "company" }], related: ["ownerId"] }, write: true, annotations: { idempotentHint: true },
    inputSchema: z.object({ companyId: ref, name: z.string().max(200).optional(), domain: z.string().max(253).nullable().optional(), website: z.string().max(2048).nullable().optional(), description: z.string().max(20000).nullable().optional(), ownerId: z.string().uuid().nullable().optional().describe("A team member"), tags: z.array(z.string().max(40)).max(30).optional(), custom, expectedRevision: z.number().int().optional() }).strict(),
    handler: ({ companyId, ...patch }, key) => run(() => ({ company: updateCompany(companyId, key.userId, patch as never) }))
  }),
  defineTool({
    name: "bin_company", title: "Move a company to the Bin", description: `Moves a company to the Bin; its contacts and deals stay. ${BIN_DESCRIPTION}`,
    scopes: ["crm:write"], alsoRequires: ["bin:write"], buckets: BIN_BUCKETS, access: { mode: "items", items: [{ arg: "companyId", kind: "company" }] }, write: true, annotations: { destructiveHint: true },
    inputSchema: z.object({ companyId: ref }).strict(),
    handler: ({ companyId }, key) => run(() => binCompany(companyId, key.userId))
  }),
  defineTool({
    name: "list_pipelines", title: "List pipelines", description: "A book's pipelines with their stages (kind open, won, or lost, and probability).",
    scopes: ["crm:read"], access: { mode: "items", items: [{ arg: "bookId", kind: "contact_book" }] }, write: false, annotations: { readOnlyHint: true },
    inputSchema: z.object({ bookId: ref }).strict(),
    handler: ({ bookId }, key) => run(() => ({ pipelines: listPipelines(bookId, key.userId) }))
  }),
  defineTool({
    name: "list_deals", title: "List deals", description: "Deals in books you can read: by pipeline, stage, owner (\"me\" for you), status (open, won, lost), or filters (title, stage, status, owner, company, value, expected_close, tag, last_activity, created, or a custom field).",
    scopes: ["crm:read"], access: { mode: "list", lists: ["contact_book"], items: [{ arg: "bookId", kind: "contact_book", ifAbsent: "allow" }], related: ["pipelineId", "stageId", "ownerId"] }, write: false, annotations: { readOnlyHint: true },
    inputSchema: z.object({ bookId: ref.optional(), pipelineId: z.string().uuid().optional().describe("Narrows to one pipeline"), stageId: z.string().uuid().optional().describe("Narrows to one stage"), ownerId: z.string().max(36).optional().describe("A team member or \"me\""),
      status: z.enum(["open", "won", "lost"]).optional(), q: z.string().max(100).optional(), filters, ...page }).strict(),
    handler: (args, key) => run(() => {
      const result = listDeals(key.userId, { bookIds: args.bookId ? [requireBook(args.bookId, key.userId).id] : null, pipelineId: args.pipelineId, stageId: args.stageId, ownerId: args.ownerId, status: args.status, q: args.q, filters: args.filters as never, cursor: args.cursor, limit: args.limit, keyFilter: bookFilter(key, "crm:read", "d.book_id") });
      return { items: result.items.map(slimDeal), nextCursor: result.nextCursor };
    })
  }),
  defineTool({
    name: "get_deal", title: "Get a deal", description: "One deal with its pipeline's stages, contacts, company, and value.",
    scopes: ["crm:read"], access: { mode: "items", items: [{ arg: "dealId", kind: "deal" }] }, write: false, annotations: { readOnlyHint: true },
    inputSchema: z.object({ dealId: ref }).strict(),
    handler: ({ dealId }, key) => run(() => ({ deal: getDeal(dealId, key.userId) }))
  }),
  defineTool({
    name: "create_deal", title: "Create a deal", description: "Adds a deal to a book you can edit, in a pipeline (default: the book's first) and stage (name or id; default: the first open stage). value is in minor units (cents); currency defaults to the pipeline's, the book's, then the workspace's.",
    scopes: ["crm:write"], access: { mode: "items", items: [{ arg: "bookId", kind: "contact_book" }], related: ["pipelineId", "companyId", "contactIds", "ownerId"] }, write: true,
    inputSchema: z.object({ bookId: ref, pipelineId: z.string().uuid().optional().describe("A pipeline of the same book"), ...dealFields, title: z.string().min(1).max(200), companyId: ref.nullable().optional().describe("A company of the same book"),
      contactIds: z.array(ref).max(50).optional().describe("Contacts of the same book"), ownerId: z.string().uuid().nullable().optional().describe("A team member") }).strict(),
    handler: ({ stage, ...args }, key) => run(() => ({ deal: createDeal(key.userId, { ...args, ...stageInput(stage) } as never, "mcp") }))
  }),
  defineTool({
    name: "update_deal", title: "Update a deal", description: "Changes a deal's fields; stage by name or id (moving to a won or lost stage closes it; give lostReason for lost). expectedRevision makes a stale write fail with CONFLICT.",
    scopes: ["crm:write"], access: { mode: "items", items: [{ arg: "dealId", kind: "deal" }], related: ["companyId", "contactIds", "ownerId", "pipelineId"] }, write: true, annotations: { idempotentHint: true },
    inputSchema: z.object({ dealId: ref, pipelineId: z.string().uuid().optional().describe("Another pipeline of the same book"), ...dealFields, companyId: ref.nullable().optional().describe("A company of the same book"),
      contactIds: z.array(ref).max(50).optional().describe("Contacts of the same book (replaces)"), ownerId: z.string().uuid().nullable().optional().describe("A team member"), expectedRevision: z.number().int().optional() }).strict(),
    handler: ({ dealId, stage, ...patch }, key) => run(() => ({ deal: updateDeal(dealId, key.userId, { ...patch, ...stageInput(stage) } as never) }))
  }),
  defineTool({
    name: "move_deal", title: "Move a deal to a stage", description: "Moves a deal to a stage of its pipeline (name or id), at the end of that stage.",
    scopes: ["crm:write"], access: { mode: "items", items: [{ arg: "dealId", kind: "deal" }] }, write: true, annotations: { idempotentHint: true },
    inputSchema: z.object({ dealId: ref, stage: z.string().min(1).max(64), lostReason: z.string().max(200).optional() }).strict(),
    handler: ({ dealId, stage, lostReason }, key) => run(() => ({ deal: slimDeal(updateDeal(dealId, key.userId, { ...stageInput(stage), ...(lostReason ? { lostReason } : {}) })) }))
  }),
  defineTool({
    name: "bulk_update_deals", title: "Update many deals", description: "Up to 100 deal changes (stage, owner, value, close date, next step), all or nothing. dryRun checks every change and returns the plan without writing.",
    scopes: ["crm:write"], access: { mode: "derived", related: ["deals"] }, write: true,
    inputSchema: z.object({ deals: z.array(z.object({ dealId: ref, stage: z.string().max(64).optional(), ownerId: z.string().uuid().nullable().optional(), value: z.number().int().min(0).nullable().optional(),
      expectedCloseOn: z.string().max(10).nullable().optional(), nextStep: z.string().max(200).nullable().optional(), nextStepOn: z.string().max(10).nullable().optional() }).strict()).min(1).max(100), dryRun: z.boolean().optional() }).strict(),
    handler: (args, key) => run(() => {
      const reach = keyContainerIds(key, "crm:write", "contact_book");
      const apply = () => args.deals.map(({ dealId, stage, ...patch }) => {
        const book = db.query("SELECT book_id FROM deals WHERE (id = ? OR short_id = ?) AND deleted_at IS NULL").get(dealId.toLowerCase(), dealId.toLowerCase()) as { book_id: string } | null;
        if (!book || (reach && !reach.includes(book.book_id))) throw new CrmError(404, "NOT_FOUND", "Deal not found");
        return slimDeal(updateDeal(dealId, key.userId, { ...patch, ...stageInput(stage) }));
      });
      if (!args.dryRun) return { dryRun: false, deals: db.transaction(apply)() };
      // A dry run applies inside a transaction that is rolled back.
      let plan: unknown[] = [];
      try { db.transaction(() => { plan = apply(); throw new Error("dry run"); })(); } catch (error) { if (!(error instanceof Error && error.message === "dry run")) throw error; }
      return { dryRun: true, deals: plan };
    })
  }),
  defineTool({
    name: "bin_deal", title: "Move a deal to the Bin", description: `Moves a deal to the Bin. ${BIN_DESCRIPTION}`,
    scopes: ["crm:write"], alsoRequires: ["bin:write"], buckets: BIN_BUCKETS, access: { mode: "items", items: [{ arg: "dealId", kind: "deal" }] }, write: true, annotations: { destructiveHint: true },
    inputSchema: z.object({ dealId: ref }).strict(),
    handler: ({ dealId }, key) => run(() => binDeal(dealId, key.userId))
  }),
  defineTool({
    name: "restore_contact", title: "Restore a contact from the Bin",
    description: "Restores a contact from the Bin (the book's owner, or whoever binned it while they can still edit the book). Restore its contact book first if that is in the Bin too.",
    scopes: ["crm:write"], alsoRequires: ["bin:write"], access: { mode: "items", items: [{ arg: "contactId", kind: "contact" }] }, write: true,
    inputSchema: z.object({ contactId: z.string().uuid() }).strict(),
    // D1385: the restore every bin_* tool's description promises, through the module's Bin provider.
    handler: async ({ contactId }, key) => restoreResult(await restoreItem("contact", contactId.toLowerCase(), key.userId), "Contact")
  }),
  defineTool({
    name: "restore_company", title: "Restore a company from the Bin",
    description: "Restores a company from the Bin (the book's owner, or whoever binned it while they can still edit the book). Restore its contact book first if that is in the Bin too.",
    scopes: ["crm:write"], alsoRequires: ["bin:write"], access: { mode: "items", items: [{ arg: "companyId", kind: "company" }] }, write: true,
    inputSchema: z.object({ companyId: z.string().uuid() }).strict(),
    // D1385: the restore every bin_* tool's description promises, through the module's Bin provider.
    handler: async ({ companyId }, key) => restoreResult(await restoreItem("company", companyId.toLowerCase(), key.userId), "Company")
  }),
  defineTool({
    name: "restore_deal", title: "Restore a deal from the Bin",
    description: "Restores a deal from the Bin (the book's owner, or whoever binned it while they can still edit the book). Restore its contact book first if that is in the Bin too.",
    scopes: ["crm:write"], alsoRequires: ["bin:write"], access: { mode: "items", items: [{ arg: "dealId", kind: "deal" }] }, write: true,
    inputSchema: z.object({ dealId: z.string().uuid() }).strict(),
    // D1385: the restore every bin_* tool's description promises, through the module's Bin provider.
    handler: async ({ dealId }, key) => restoreResult(await restoreItem("deal", dealId.toLowerCase(), key.userId), "Deal")
  }),
  defineTool({
    name: "pipeline_summary", title: "Pipeline summary", description: "A book's pipeline by stage: deal count, total value, and weighted value (value × probability), in minor units of the pipeline's currency; plus open totals.",
    scopes: ["crm:read"], access: { mode: "items", items: [{ arg: "bookId", kind: "contact_book" }], related: ["pipelineId"] }, write: false, annotations: { readOnlyHint: true },
    inputSchema: z.object({ bookId: ref, pipelineId: z.string().uuid().optional().describe("A pipeline of this book (default: its first)") }).strict(),
    handler: ({ bookId, pipelineId }, key) => run(() => {
      const pipelines = listPipelines(bookId, key.userId);
      const pipeline = pipelineId ? pipelines.find((item) => item.id === pipelineId.toLowerCase()) : pipelines[0];
      if (!pipeline) throw new CrmError(404, "NOT_FOUND", "Pipeline not found");
      return pipelineSummary(pipeline.id, key.userId);
    })
  }),
  defineTool({
    name: "log_interaction", title: "Log an interaction", description: `Logs a ${INTERACTION_KINDS.slice(0, 6).join(", ")}, or other on contacts, companies, and deals of one book (by id or short id). occurredAt defaults to now.`,
    scopes: ["crm:write"], access: { mode: "items", items: [{ arg: "contactIds", kind: "contact", ifAbsent: "allow" }, { arg: "companyIds", kind: "company", ifAbsent: "allow" }, { arg: "dealIds", kind: "deal", ifAbsent: "allow" }] }, write: true,
    inputSchema: z.object({ kind: z.enum(INTERACTION_KINDS), title: z.string().max(200).optional(), body: z.string().max(20000).optional(), occurredAt: z.string().max(40).optional(), durationMinutes: z.number().int().min(0).max(1440).optional(),
      direction: z.enum(["in", "out", "none"]).optional(), contactIds: z.array(ref).max(20).optional(), companyIds: z.array(ref).max(20).optional(), dealIds: z.array(ref).max(20).optional() }).strict(),
    handler: (args, key) => run(() => ({ interaction: logInteraction(key.userId, {
      kind: args.kind, title: args.title, body: args.body, occurredAt: args.occurredAt, direction: args.direction, durationS: args.durationMinutes === undefined ? null : args.durationMinutes * 60, source: "mcp",
      subjects: [...(args.contactIds ?? []).map((id) => ({ kind: "contact" as const, id })), ...(args.companyIds ?? []).map((id) => ({ kind: "company" as const, id })), ...(args.dealIds ?? []).map((id) => ({ kind: "deal" as const, id }))]
    }) }))
  }),
  defineTool({
    name: "list_interactions", title: "List interactions", description: "Interactions on one contact, company (its contacts' included), or deal, newest first; or in one book.",
    scopes: ["crm:read"], access: { mode: "list", lists: ["contact_book"], items: [{ arg: "contactId", kind: "contact", ifAbsent: "allow" }, { arg: "companyId", kind: "company", ifAbsent: "allow" }, { arg: "dealId", kind: "deal", ifAbsent: "allow" }, { arg: "bookId", kind: "contact_book", ifAbsent: "allow" }] }, write: false, annotations: { readOnlyHint: true },
    inputSchema: z.object({ contactId: ref.optional(), companyId: ref.optional(), dealId: ref.optional(), bookId: ref.optional(), kind: z.enum(INTERACTION_KINDS).optional(), ...page }).strict(),
    handler: (args, key) => run(() => listInteractions(key.userId, {
      subject: args.contactId ? { kind: "contact", id: args.contactId } : args.companyId ? { kind: "company", id: args.companyId } : args.dealId ? { kind: "deal", id: args.dealId } : null,
      bookIds: args.bookId ? [requireBook(args.bookId, key.userId).id] : null, kind: args.kind ?? null, cursor: args.cursor, limit: args.limit, keyFilter: bookFilter(key, "crm:read", "i.book_id")
    }))
  }),
  defineTool({
    name: "create_followup", title: "Set a follow-up", description: "Reminds you about a contact, company, or deal at a time (an inbox notification). Give exactly one of contactId, companyId, dealId.",
    scopes: ["crm:write"], access: { mode: "items", items: [{ arg: "contactId", kind: "contact", ifAbsent: "allow" }, { arg: "companyId", kind: "company", ifAbsent: "allow" }, { arg: "dealId", kind: "deal", ifAbsent: "allow" }] }, write: true,
    inputSchema: z.object({ contactId: ref.optional(), companyId: ref.optional(), dealId: ref.optional(), dueAt: z.string().max(40), note: z.string().max(500).optional() }).strict(),
    handler: (args, key) => run(() => {
      const subjects = [args.contactId ? { kind: "contact" as const, id: args.contactId } : null, args.companyId ? { kind: "company" as const, id: args.companyId } : null, args.dealId ? { kind: "deal" as const, id: args.dealId } : null].filter((item) => item !== null);
      if (subjects.length !== 1) throw new CrmError(400, "INVALID", "Give exactly one of contactId, companyId, dealId");
      return { followup: createFollowup(key.userId, { subject: subjects[0]!, dueAt: args.dueAt, note: args.note }) };
    })
  })
];

export const CRM_AGENT_TOOLS = {
  allowed: ["list_contact_books", "search_crm", "list_contacts", "get_contact", "list_companies", "get_company", "list_pipelines", "list_deals", "get_deal", "pipeline_summary", "list_interactions",
    // Wave 3 (D1047): proposal kinds contact_create, contact_update, deal_create, deal_update, interaction_log.
    "create_contact", "update_contact", "create_deal", "update_deal", "log_interaction"],
  never: ["upsert_contact", "merge_contacts", "bulk_upsert_contacts", "create_company", "update_company", "move_deal", "bulk_update_deals", "create_followup"]
};
