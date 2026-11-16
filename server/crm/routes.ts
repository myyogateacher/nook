import type { Context } from "hono";
import type { AppEnv } from "../auth";
import type { ModuleRouter } from "../workspaceRegistry";
import { readBoundedBody } from "../validation";
import { LinkError } from "../links/service";
import { isCrmEntity, type CrmEntity, type CrmFilter, type CrmSort, type InteractionKind, type StageKind } from "../../shared/crm";
import { binBook, bookRow, CrmError, createBook, listBooks, requireBook, setBookFields, toBook, updateBook } from "./core";
import { binCompany, binContact, contactDuplicates, createCompany, createContact, getCompany, getContact, listCompanies, listContacts, mergeCompanies, mergeContacts, updateCompany, updateContact } from "./records";
import { binDeal, createDeal, createPipeline, deletePipeline, getDeal, listDeals, listPipelines, pipelineBoard, updateDeal, updatePipeline } from "./deals";
import { createFollowup, createTask, deleteInteraction, listFollowups, listInteractions, logInteraction, recordTimeline, updateFollowup, updateInteraction } from "./interactions";
import { changeListMembers, createList, createView, deleteList, deleteView, listLists, listViews, readList, updateList, updateView } from "./lists";
import { commitImport, contactVcard, exportCsv, previewImport, remapImport, undoImport } from "./importExport";

/**
 * Contacts HTTP (§D.5, all under `/api/crm`): JSON in and out, `{ error, code }` errors, NOT_FOUND for
 * anything unreadable (never 403 for existence), `:id` accepting a UUID or a short id.
 */

type Handler = (c: Context<AppEnv>) => unknown | Promise<unknown>;

async function body(c: Context<AppEnv>, limit = 200_000): Promise<Record<string, unknown>> {
  const bytes = await readBoundedBody(c.req.raw, limit);
  if (!bytes.length) return {};
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new CrmError(400, "INVALID", "Send a JSON object");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CrmError) throw error;
    throw new CrmError(400, "INVALID", "Send valid JSON");
  }
}

const wrap = (handler: Handler, status = 200) => async (c: Context<AppEnv>) => {
  // Guests have no Contacts (§G.1 Q8, D1192), as they have no Bookings: every route answers them 404.
  if (c.get("user").role === "guest") return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
  try {
    const result = await handler(c);
    if (result instanceof Response) return result;
    return c.json(result as Record<string, unknown>, status as 200);
  } catch (error) {
    if (error instanceof CrmError) return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
    if (error instanceof LinkError) return c.json({ error: error.message, code: error.code }, error.status);
    if (error && typeof error === "object" && "status" in error && "code" in error && typeof (error as { status: unknown }).status === "number" && (error as { status: number }).status < 500) {
      const typed = error as unknown as { status: 400; code: string; message: string };
      return c.json({ error: typed.message, code: typed.code }, typed.status);
    }
    throw error;
  }
};

const uid = (c: Context<AppEnv>) => c.get("user").id;
const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? "";
const query = (c: Context<AppEnv>, name: string) => c.req.query(name) || undefined;
const books = (c: Context<AppEnv>) => { const book = query(c, "book"); if (!book) return null; return [requireBook(book, uid(c)).id]; };
function jsonQuery<T>(c: Context<AppEnv>, name: string): T | undefined {
  const raw = query(c, name);
  if (!raw) return undefined;
  if (raw.length > 4000) throw new CrmError(400, "INVALID", `${name} is too long`);
  try { return JSON.parse(raw) as T; } catch { throw new CrmError(400, "INVALID", `${name} must be JSON`); }
}
const listQuery = (c: Context<AppEnv>) => ({
  bookIds: books(c), q: query(c, "q"), listId: query(c, "list") ?? null, filters: jsonQuery<CrmFilter[]>(c, "filter"), sort: jsonQuery<CrmSort>(c, "sort"),
  cursor: query(c, "cursor") ?? null, limit: query(c, "limit") ? Number(query(c, "limit")) : undefined
});
const subjectOf = (value: string | undefined): { kind: CrmEntity; id: string } | null => {
  if (!value) return null;
  const [kind, id] = value.split(":");
  if (!isCrmEntity(kind) || !id) throw new CrmError(400, "INVALID", "subject is kind:id");
  return { kind, id };
};

export function registerCrmRoutes(router: ModuleRouter) {
  // Books
  router.get("/api/crm/books", wrap((c) => ({ books: listBooks(uid(c)) })));
  router.post("/api/crm/books", wrap(async (c) => ({ book: createBook(uid(c), await body(c)) }), 201));
  router.get("/api/crm/books/:id", wrap((c) => ({ book: toBook(requireBook(param(c, "id"), uid(c)), uid(c)) })));
  router.patch("/api/crm/books/:id", wrap(async (c) => ({ book: updateBook(param(c, "id"), uid(c), await body(c) as never) })));
  router.delete("/api/crm/books/:id", wrap((c) => binBook(param(c, "id"), uid(c))));
  router.put("/api/crm/books/:id/fields/:entity", wrap(async (c) => {
    const entity = param(c, "entity");
    if (!isCrmEntity(entity)) throw new CrmError(400, "INVALID", "Fields are for contact, company, or deal");
    return { book: setBookFields(param(c, "id"), uid(c), entity, (await body(c)).fields) };
  }));

  // Contacts
  router.get("/api/crm/contacts", wrap((c) => listContacts(uid(c), listQuery(c))));
  router.post("/api/crm/contacts", wrap(async (c) => ({ contact: createContact(uid(c), await body(c) as never) }), 201));
  router.get("/api/crm/contacts/duplicates", wrap((c) => ({ pairs: contactDuplicates(query(c, "book") ?? "", uid(c)) })));
  router.get("/api/crm/contacts/:id", wrap((c) => ({ contact: getContact(param(c, "id"), uid(c)) })));
  router.patch("/api/crm/contacts/:id", wrap(async (c) => ({ contact: updateContact(param(c, "id"), uid(c), await body(c) as never) })));
  router.delete("/api/crm/contacts/:id", wrap((c) => binContact(param(c, "id"), uid(c))));
  router.post("/api/crm/contacts/:id/merge", wrap(async (c) => ({ contact: mergeContacts(param(c, "id"), String((await body(c)).intoId ?? ""), uid(c)) })));
  router.get("/api/crm/contacts/:id/vcard", wrap((c) => {
    const card = contactVcard(param(c, "id"), uid(c));
    return new Response(card.vcard, { headers: { "Content-Type": "text/vcard; charset=utf-8", "Content-Disposition": `attachment; filename="${card.filename}"`, "Cache-Control": "no-store" } });
  }));

  // Companies
  router.get("/api/crm/companies", wrap((c) => listCompanies(uid(c), listQuery(c))));
  router.post("/api/crm/companies", wrap(async (c) => ({ company: createCompany(uid(c), await body(c) as never) }), 201));
  router.get("/api/crm/companies/:id", wrap((c) => ({ company: getCompany(param(c, "id"), uid(c)) })));
  router.patch("/api/crm/companies/:id", wrap(async (c) => ({ company: updateCompany(param(c, "id"), uid(c), await body(c) as never) })));
  router.delete("/api/crm/companies/:id", wrap((c) => binCompany(param(c, "id"), uid(c))));
  router.post("/api/crm/companies/:id/merge", wrap(async (c) => ({ company: mergeCompanies(param(c, "id"), String((await body(c)).intoId ?? ""), uid(c)) })));

  // Pipelines and deals
  router.get("/api/crm/pipelines", wrap((c) => ({ pipelines: listPipelines(query(c, "book") ?? "", uid(c)) })));
  router.post("/api/crm/pipelines", wrap(async (c) => ({ pipeline: createPipeline(uid(c), await body(c) as never) }), 201));
  router.patch("/api/crm/pipelines/:id", wrap(async (c) => ({ pipeline: updatePipeline(param(c, "id"), uid(c), await body(c) as never) })));
  router.delete("/api/crm/pipelines/:id", wrap((c) => deletePipeline(param(c, "id"), uid(c))));
  router.get("/api/crm/pipelines/:id/board", wrap((c) => ({ board: pipelineBoard(param(c, "id"), uid(c), { ownerId: query(c, "owner") ?? null, q: query(c, "q") }) })));
  router.get("/api/crm/deals", wrap((c) => listDeals(uid(c), {
    ...listQuery(c), pipelineId: query(c, "pipeline") ?? null, stageId: query(c, "stage") ?? null, ownerId: query(c, "owner") ?? null, status: (query(c, "status") as StageKind | undefined) ?? null, companyId: query(c, "company") ?? null
  })));
  router.post("/api/crm/deals", wrap(async (c) => ({ deal: createDeal(uid(c), await body(c) as never) }), 201));
  router.get("/api/crm/deals/:id", wrap((c) => ({ deal: getDeal(param(c, "id"), uid(c)) })));
  router.patch("/api/crm/deals/:id", wrap(async (c) => ({ deal: updateDeal(param(c, "id"), uid(c), await body(c) as never) })));
  router.delete("/api/crm/deals/:id", wrap((c) => binDeal(param(c, "id"), uid(c))));

  // Interactions, follow-ups, tasks, timeline
  router.get("/api/crm/interactions", wrap((c) => listInteractions(uid(c), { subject: subjectOf(query(c, "subject")), bookIds: books(c), kind: (query(c, "kind") as InteractionKind | undefined) ?? null, cursor: query(c, "cursor") ?? null })));
  router.post("/api/crm/interactions", wrap(async (c) => ({ interaction: logInteraction(uid(c), await body(c) as never) }), 201));
  router.patch("/api/crm/interactions/:id", wrap(async (c) => ({ interaction: updateInteraction(param(c, "id"), uid(c), await body(c) as never) })));
  router.delete("/api/crm/interactions/:id", wrap((c) => deleteInteraction(param(c, "id"), uid(c))));
  router.get("/api/crm/followups", wrap((c) => ({ followups: listFollowups(uid(c), { subject: subjectOf(query(c, "subject")) ?? undefined, includeDone: query(c, "done") === "1" }) })));
  router.post("/api/crm/followups", wrap(async (c) => ({ followup: createFollowup(uid(c), await body(c) as never) }), 201));
  router.patch("/api/crm/followups/:id", wrap(async (c) => ({ followup: updateFollowup(param(c, "id"), uid(c), await body(c) as never) })));
  router.post("/api/crm/tasks", wrap(async (c) => createTask(uid(c), await body(c) as never), 201));
  router.get("/api/crm/records/:kind/:id/timeline", wrap((c) => {
    const kind = param(c, "kind");
    if (!isCrmEntity(kind)) throw new CrmError(404, "NOT_FOUND", "Not found");
    return recordTimeline(kind, param(c, "id"), uid(c), query(c, "cursor") ?? null);
  }));

  // Lists and views
  router.get("/api/crm/lists", wrap((c) => ({ lists: listLists(uid(c), { bookIds: books(c), entity: isCrmEntity(query(c, "entity")) ? query(c, "entity") as CrmEntity : null }) })));
  router.post("/api/crm/lists", wrap(async (c) => ({ list: createList(uid(c), await body(c) as never) }), 201));
  router.get("/api/crm/lists/:id", wrap((c) => ({ list: readList(param(c, "id"), uid(c)) })));
  router.patch("/api/crm/lists/:id", wrap(async (c) => ({ list: updateList(param(c, "id"), uid(c), await body(c)) })));
  router.delete("/api/crm/lists/:id", wrap((c) => deleteList(param(c, "id"), uid(c))));
  router.post("/api/crm/lists/:id/members", wrap(async (c) => ({ list: changeListMembers(param(c, "id"), uid(c), await body(c)) })));
  router.get("/api/crm/views", wrap((c) => ({ views: listViews(uid(c), { bookId: query(c, "book") ?? "", entity: isCrmEntity(query(c, "entity")) ? query(c, "entity") as CrmEntity : null }) })));
  router.post("/api/crm/views", wrap(async (c) => ({ view: createView(uid(c), await body(c) as never) }), 201));
  router.patch("/api/crm/views/:id", wrap(async (c) => ({ view: updateView(param(c, "id"), uid(c), await body(c)) })));
  router.delete("/api/crm/views/:id", wrap((c) => deleteView(param(c, "id"), uid(c))));

  // Import and export
  router.post("/api/crm/import", wrap(async (c) => ({ preview: previewImport(uid(c), await body(c, 5_400_000) as never) }), 201));
  router.post("/api/crm/import/:jobId/preview", wrap(async (c) => ({ preview: remapImport(param(c, "jobId"), uid(c), (await body(c)).mapping) })));
  router.post("/api/crm/import/:jobId/commit", wrap(async (c) => ({ result: commitImport(param(c, "jobId"), uid(c), await body(c) as never) })));
  router.post("/api/crm/import/:jobId/undo", wrap((c) => undoImport(param(c, "jobId"), uid(c))));
  router.get("/api/crm/export.csv", wrap((c) => {
    const entity = query(c, "entity");
    if (!isCrmEntity(entity)) throw new CrmError(400, "INVALID", "Export contacts, companies, or deals");
    const book = bookRow(query(c, "book") ?? "");
    if (!book) throw new CrmError(404, "NOT_FOUND", "Contact book not found");
    const file = exportCsv(uid(c), { bookId: book.id, entity, q: query(c, "q"), listId: query(c, "list") ?? null, filters: jsonQuery<CrmFilter[]>(c, "filter") });
    return new Response(file.csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${file.filename}"`, "Cache-Control": "no-store" } });
  }));
}
