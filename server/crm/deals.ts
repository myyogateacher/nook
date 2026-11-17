import { audit, db, now } from "../db";
import { recordItemActivity, recordItemChange } from "../activity/service";
import { NO_FILTER } from "../keyResources";
import { newShortId } from "../../shared/friendlyUrls";
import { isCurrency } from "../../shared/money";
import { crmDealPath, isRotting, weightedValue, type CrmBoard, type CrmDeal, type CrmDealDetail, type CrmPipeline, type CrmStage, type StageKind } from "../../shared/crm";
import {
  bookCurrency, bookFields, bookSettings, cleanDate, cleanRef, cleanTags, cleanText, cleanUserId, createPipelineRows, CrmError, decodeCursor, encodeCursor, ensureRottingSchedule, invalid,
  notFound, notifyReaders, parseTags, readableBooksSql, readCustom, refColumn, requireBook, userRef, writeCustom, type BookRow
} from "./core";
import { afterCursor, compileFilters, sortSql } from "./query";
import type { ListInput } from "./records";

/** The Contacts email for a deal event (D1370): ids only, read again as the recipient when sent. */
const dealMail = (event: string, dealId: string, actorId: string) => ({ template: "crm.update", payload: { topic: event, kind: "deal", id: dealId, actorId } });

/**
 * Pipelines, stages, and deals (§D.5, D962, D964): a deal's status follows its stage's kind (won and
 * lost stamp `closed_at`); every stage change is a `deal_stage_changes` row (velocity and funnel) and
 * an activity entry; a deal rots when its last interaction or stage change is older than its stage's
 * rot days (the book's default otherwise). Board order is a REAL position per stage.
 */

type StageRow = { id: string; pipeline_id: string; name: string; kind: StageKind; probability: number; rot_days: number | null; color: string | null; position: number };
const toStage = (row: StageRow): CrmStage => ({ id: row.id, name: row.name, kind: row.kind, probability: row.probability, rotDays: row.rot_days, color: row.color, position: row.position });

type PipelineRow = { id: string; book_id: string; name: string; currency: string | null; position: number };
const stagesOf = (pipelineId: string) => (db.query("SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY position, id").all(pipelineId) as StageRow[]).map(toStage);
const toPipeline = (row: PipelineRow): CrmPipeline => ({ id: row.id, bookId: row.book_id, name: row.name, currency: row.currency, position: row.position, stages: stagesOf(row.id) });

export function listPipelines(bookRef: string, userId: string): CrmPipeline[] {
  const book = requireBook(bookRef, userId);
  return (db.query("SELECT id, book_id, name, currency, position FROM pipelines WHERE book_id = ? AND deleted_at IS NULL ORDER BY position, id").all(book.id) as PipelineRow[]).map(toPipeline);
}

/** A live pipeline the user reads, with its book's level. */
export function readPipeline(ref: string, userId: string) {
  if (!cleanRef(ref)) throw notFound("Pipeline not found");
  const row = db.query("SELECT id, book_id, name, currency, position FROM pipelines WHERE id = ? AND deleted_at IS NULL").get(ref.toLowerCase()) as PipelineRow | null;
  if (!row) throw notFound("Pipeline not found");
  const book = requireBook(row.book_id, userId);
  return { pipeline: toPipeline(row), book };
}

type StageInput = { id?: string; name: string; kind?: StageKind; probability?: number; rotDays?: number | null; color?: string | null };

function cleanStages(stages: unknown): Array<StageInput & { kind: StageKind; probability: number }> {
  if (!Array.isArray(stages) || stages.length < 2 || stages.length > 20) throw invalid("A pipeline has 2 to 20 stages");
  const result = (stages as StageInput[]).map((stage) => {
    const name = cleanText(stage?.name, 60, "A stage name");
    if (!name) throw invalid("Name every stage");
    const kind = stage.kind ?? "open";
    if (!["open", "won", "lost"].includes(kind)) throw invalid("A stage is open, won, or lost");
    const probability = stage.probability ?? (kind === "won" ? 100 : kind === "lost" ? 0 : 50);
    if (!Number.isInteger(probability) || probability < 0 || probability > 100) throw invalid("A probability is 0 to 100");
    if (stage.rotDays !== undefined && stage.rotDays !== null && (!Number.isInteger(stage.rotDays) || stage.rotDays < 1 || stage.rotDays > 365)) throw invalid("Rot days are 1 to 365");
    return { ...stage, name, kind, probability, rotDays: stage.rotDays ?? null, color: cleanText(stage.color, 24, "A color") };
  });
  if (!result.some((stage) => stage.kind === "open")) throw invalid("A pipeline needs at least one open stage");
  return result;
}

export function createPipeline(userId: string, input: { bookId?: string; name?: unknown; currency?: unknown; stages?: unknown }): CrmPipeline {
  return db.transaction(() => {
    const book = requireBook(input.bookId ?? "", userId, "manage");
    const name = cleanText(input.name, 80, "The name");
    if (!name) throw invalid("Name the pipeline");
    if (input.currency !== undefined && input.currency !== null && !isCurrency(input.currency)) throw invalid("Choose a currency code");
    const stages = input.stages === undefined ? cleanStages([{ name: "Lead", probability: 10 }, { name: "Qualified", probability: 30 }, { name: "Proposal", probability: 60 }, { name: "Won", kind: "won" }, { name: "Lost", kind: "lost" }]) : cleanStages(input.stages);
    if ((db.query("SELECT COUNT(*) AS n FROM pipelines WHERE book_id = ? AND deleted_at IS NULL").get(book.id) as { n: number }).n >= 20) throw new CrmError(400, "LIMIT_REACHED", "A book can have up to 20 pipelines");
    const id = createPipelineRows(book.id, name, (input.currency as string | null | undefined) ?? null, stages);
    audit(userId, null, "crm.pipeline_create", { bookId: book.id, pipelineId: id });
    return readPipeline(id, userId).pipeline;
  })();
}

/**
 * Renames a pipeline and replaces its stages: stages with an id are kept (renamed, re-kinded,
 * reordered), new ones are added, and a removed stage must be empty unless `moveDealsTo` names a
 * remaining stage for its deals.
 */
export function updatePipeline(ref: string, userId: string, input: { name?: unknown; currency?: unknown; stages?: unknown; moveDealsTo?: string | null }): CrmPipeline {
  return db.transaction(() => {
    const { pipeline, book } = readPipeline(ref, userId);
    requireBook(book.id, userId, "manage");
    const name = input.name === undefined ? pipeline.name : cleanText(input.name, 80, "The name");
    if (!name) throw invalid("Name the pipeline");
    if (input.currency !== undefined && input.currency !== null && !isCurrency(input.currency)) throw invalid("Choose a currency code");
    db.query("UPDATE pipelines SET name = ?, currency = ?, updated_at = ? WHERE id = ?").run(name, input.currency === undefined ? pipeline.currency : input.currency as string | null, now(), pipeline.id);
    if (input.stages !== undefined) {
      const stages = cleanStages(input.stages);
      const existing = new Set(pipeline.stages.map((stage) => stage.id));
      const kept = new Set(stages.filter((stage) => stage.id && existing.has(stage.id)).map((stage) => stage.id!));
      for (const stage of stages) if (stage.id && !existing.has(stage.id)) throw invalid("Unknown stage");
      const ids: string[] = [];
      stages.forEach((stage, index) => {
        if (stage.id) {
          db.query("UPDATE pipeline_stages SET name = ?, kind = ?, probability = ?, rot_days = ?, color = ?, position = ? WHERE id = ?").run(stage.name, stage.kind, stage.probability, stage.rotDays ?? null, stage.color ?? null, index + 1, stage.id);
          ids.push(stage.id);
        } else {
          const id = crypto.randomUUID();
          db.query("INSERT INTO pipeline_stages (id, pipeline_id, name, kind, probability, rot_days, color, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, pipeline.id, stage.name, stage.kind, stage.probability, stage.rotDays ?? null, stage.color ?? null, index + 1);
          ids.push(id);
        }
      });
      const removed = pipeline.stages.filter((stage) => !kept.has(stage.id));
      for (const stage of removed) {
        const used = (db.query("SELECT COUNT(*) AS n FROM deals WHERE stage_id = ?").get(stage.id) as { n: number }).n;
        if (used) {
          const to = input.moveDealsTo && ids.includes(input.moveDealsTo) ? input.moveDealsTo : null;
          if (!to) throw new CrmError(409, "STAGE_IN_USE", `“${stage.name}” has ${used} ${used === 1 ? "deal" : "deals"}; choose where they go`, { stageId: stage.id, deals: used });
          const target = stages[ids.indexOf(to)]!;
          // Each deal moves as a stage change would move it (D1163): status and closed stamp, lost
          // reason, the stage history row (velocity, funnel), and the deal's timeline.
          const timestamp = now();
          const deals = db.query("SELECT id, value_minor, deleted_at FROM deals WHERE stage_id = ? ORDER BY position, id").all(stage.id) as Array<{ id: string; value_minor: number | null; deleted_at: string | null }>;
          for (const deal of deals) {
            // A closed deal that stays closed the same way keeps its close date (a won deal's revenue month).
            db.query(`UPDATE deals SET closed_at = CASE WHEN $kind = 'open' THEN NULL WHEN status = $kind THEN COALESCE(closed_at, $ts) ELSE $ts END,
                lost_reason = CASE WHEN $kind = 'lost' THEN lost_reason ELSE NULL END, stage_id = $to, status = $kind, stage_entered_at = $ts, last_activity_at = $ts,
                rot_notified_at = NULL, position = $position, updated_at = $ts, revision = revision + 1 WHERE id = $id`)
              .run({ kind: target.kind, ts: timestamp, to, position: positionAtEnd(to), id: deal.id });
            if (deal.deleted_at) continue;
            db.query("INSERT INTO deal_stage_changes (id, deal_id, from_stage_id, to_stage_id, value_minor, actor_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(Bun.randomUUIDv7(), deal.id, stage.id, to, deal.value_minor, userId, timestamp);
            recordItemChange({ itemKind: "deal", itemId: deal.id, container: { kind: "contact_book", id: book.id }, actorId: userId, kind: "crm_stage", from: { id: stage.id, label: stage.name }, to: { id: to, label: target.name } });
          }
        }
        db.query("DELETE FROM pipeline_stages WHERE id = ?").run(stage.id);
      }
      // A stage whose kind changed changes its deals' status.
      for (const stage of stages) if (stage.id) db.query("UPDATE deals SET status = ?, closed_at = CASE WHEN ? = 'open' THEN NULL ELSE COALESCE(closed_at, ?) END WHERE stage_id = ? AND status <> ?").run(stage.kind, stage.kind, now(), stage.id, stage.kind);
    }
    audit(userId, null, "crm.pipeline_update", { bookId: book.id, pipelineId: pipeline.id });
    return readPipeline(pipeline.id, userId).pipeline;
  })();
}

export function deletePipeline(ref: string, userId: string) {
  return db.transaction(() => {
    const { pipeline, book } = readPipeline(ref, userId);
    requireBook(book.id, userId, "manage");
    if (db.query("SELECT 1 FROM deals WHERE pipeline_id = ? AND deleted_at IS NULL").get(pipeline.id)) throw new CrmError(409, "PIPELINE_IN_USE", "Move or remove this pipeline's deals first");
    if ((db.query("SELECT COUNT(*) AS n FROM pipelines WHERE book_id = ? AND deleted_at IS NULL").get(book.id) as { n: number }).n <= 1) throw new CrmError(409, "LAST_PIPELINE", "A book keeps at least one pipeline");
    db.query("UPDATE pipelines SET deleted_at = ? WHERE id = ?").run(now(), pipeline.id);
    audit(userId, null, "crm.pipeline_delete", { bookId: book.id, pipelineId: pipeline.id });
    return { deleted: true };
  })();
}

// ----------------------------------------------------------------------------- deals

type DealRow = {
  id: string; short_id: string; book_id: string; pipeline_id: string; stage_id: string; stage_name: string; stage_kind: StageKind; probability: number; rot_days: number | null; book_settings: string;
  title: string; value_minor: number | null; currency: string; expected_close_on: string | null; owner_id: string | null; owner_name: string | null; company_id: string | null; company_name: string | null;
  next_step: string | null; next_step_on: string | null; status: StageKind; closed_at: string | null; lost_reason: string | null; stage_entered_at: string; last_activity_at: string;
  position: number; tags_json: string; custom_json: string; fields_json: string; created_at: string; updated_at: string; revision: number; sort_value?: string | number | null;
};
const DEAL_SELECT = `SELECT d.id, d.short_id, d.book_id, d.pipeline_id, d.stage_id, s.name AS stage_name, s.kind AS stage_kind, s.probability, s.rot_days, b.settings_json AS book_settings, b.fields_json,
  d.title, d.value_minor, d.currency, d.expected_close_on, d.owner_id, u.display_name AS owner_name, d.company_id, co.name AS company_name, d.next_step, d.next_step_on, d.status, d.closed_at,
  d.lost_reason, d.stage_entered_at, d.last_activity_at, d.position, d.tags_json, d.custom_json, d.created_at, d.updated_at, d.revision`;
const DEAL_FROM = `FROM deals d JOIN contact_books b ON b.id = d.book_id JOIN pipeline_stages s ON s.id = d.stage_id
  LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN companies co ON co.id = d.company_id AND co.deleted_at IS NULL`;

function dealContacts(ids: readonly string[]) {
  const map = new Map<string, CrmDeal["contacts"]>();
  if (!ids.length) return map;
  const rows = db.query(`SELECT dc.deal_id, c.id, c.display_name, dc.role FROM deal_contacts dc JOIN contacts c ON c.id = dc.contact_id AND c.deleted_at IS NULL
    WHERE dc.deal_id IN (SELECT value FROM json_each(?)) ORDER BY c.display_name`).all(JSON.stringify(ids)) as Array<{ deal_id: string; id: string; display_name: string; role: string | null }>;
  for (const row of rows) map.set(row.deal_id, [...(map.get(row.deal_id) ?? []), { id: row.id, name: row.display_name, role: row.role }]);
  return map;
}

function toDeals(rows: DealRow[], nowMs = Date.now()): CrmDeal[] {
  const contacts = dealContacts(rows.map((row) => row.id));
  return rows.map((row) => ({
    id: row.id, shortId: row.short_id, bookId: row.book_id, pipelineId: row.pipeline_id, stageId: row.stage_id, stageName: row.stage_name, stageKind: row.stage_kind, probability: row.probability,
    title: row.title, value: row.value_minor === null ? null : { amount: row.value_minor, currency: row.currency }, currency: row.currency, expectedCloseOn: row.expected_close_on,
    owner: userRef(row.owner_id, row.owner_name), companyId: row.company_id, companyName: row.company_name, contacts: contacts.get(row.id) ?? [], nextStep: row.next_step, nextStepOn: row.next_step_on,
    status: row.status, closedAt: row.closed_at, lostReason: row.lost_reason, stageEnteredAt: row.stage_entered_at, lastActivityAt: row.last_activity_at,
    rotting: isRotting({ status: row.status, lastActivityAt: row.last_activity_at }, row.rot_days ?? bookSettings({ settings_json: row.book_settings }).rottingDays, nowMs),
    position: row.position, tags: parseTags(row.tags_json), custom: readCustom(bookFieldsOf(row).deal, row.custom_json), createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision,
    href: crmDealPath(row.title, row.short_id)
  }));
}
const bookFieldsOf = (row: DealRow) => bookFields({ fields_json: row.fields_json });

export function readDealRow(ref: string, userId: string): DealRow {
  const clean = cleanRef(ref);
  if (!clean) throw notFound("Deal not found");
  const row = db.query(`${DEAL_SELECT} ${DEAL_FROM} WHERE ${refColumn(clean, "d")} = $ref AND d.deleted_at IS NULL AND ${readableBooksSql("b")}`).get({ ref: clean, userId }) as DealRow | null;
  if (!row) throw notFound("Deal not found");
  return row;
}

export function getDeal(ref: string, userId: string): CrmDealDetail {
  const row = readDealRow(ref, userId);
  const book = requireBook(row.book_id, userId);
  const lists = db.query("SELECT l.id, l.name FROM crm_list_members m JOIN crm_lists l ON l.id = m.list_id WHERE m.item_id = ? AND l.deleted_at IS NULL").all(row.id) as Array<{ id: string; name: string }>;
  return { ...toDeals([row])[0]!, pipeline: readPipeline(row.pipeline_id, userId).pipeline, canEdit: ["edit", "manage", "owner"].includes(book.level), lists };
}

/** Deals of a contact or company (for record pages), open first. */
export function dealsFor(kind: "contact" | "company", id: string, userId: string): CrmDeal[] {
  const condition = kind === "contact" ? "d.id IN (SELECT deal_id FROM deal_contacts WHERE contact_id = $id)" : "d.company_id = $id";
  return toDeals(db.query(`${DEAL_SELECT} ${DEAL_FROM} WHERE ${condition} AND d.deleted_at IS NULL AND ${readableBooksSql("b")} ORDER BY d.status = 'open' DESC, d.updated_at DESC LIMIT 100`).all({ id, userId }) as DealRow[]);
}

export type DealListInput = ListInput & { pipelineId?: string | null; stageId?: string | null; ownerId?: string | null; status?: StageKind | null };

export function listDeals(userId: string, input: DealListInput): { items: CrmDeal[]; nextCursor: string | null } {
  const where = [readableBooksSql("b"), "d.deleted_at IS NULL"];
  const params: Record<string, string | number> = { userId };
  if (input.bookIds) { where.push("d.book_id IN (SELECT value FROM json_each($bookIds))"); params.bookIds = JSON.stringify(input.bookIds); }
  const key = input.keyFilter ?? NO_FILTER;
  where.push(key.sql);
  Object.assign(params, key.params);
  if (input.pipelineId) { where.push("d.pipeline_id = $pipelineId"); params.pipelineId = input.pipelineId; }
  if (input.stageId) { where.push("d.stage_id = $stageId"); params.stageId = input.stageId; }
  if (input.ownerId) { where.push("d.owner_id = $ownerId"); params.ownerId = input.ownerId === "me" ? userId : input.ownerId; }
  if (input.status) { where.push("d.status = $status"); params.status = input.status; }
  if (input.companyId) { where.push("d.company_id = $companyId"); params.companyId = input.companyId; }
  if (input.listId) {
    const list = cleanRef(input.listId);
    if (!list) throw invalid("Unknown list");
    where.push(`d.id IN (SELECT m.item_id FROM crm_list_members m JOIN crm_lists l ON l.id = m.list_id WHERE l.${refColumn(list)} = $listId)`);
    params.listId = list;
  }
  const q = input.q?.trim().toLowerCase().slice(0, 100);
  if (q) { where.push("(instr(lower(d.title), $q) > 0 OR instr(lower(COALESCE(co.name, '')), $q) > 0)"); params.q = q; }
  const custom = input.bookIds?.length === 1 ? bookFields(db.query("SELECT fields_json FROM contact_books WHERE id = ?").get(input.bookIds[0]!) as { fields_json: string } ?? { fields_json: "{}" }).deal : [];
  const filters = compileFilters("deal", input.filters, custom, userId);
  where.push(...filters.where);
  Object.assign(params, filters.params);
  const sort = input.sort ? sortSql("deal", input.sort, custom, "d.updated_at") : { expr: "d.updated_at", dir: "DESC" as const, numeric: false };
  const after = afterCursor(sort.expr, sort.dir, "d.id", decodeCursor(input.cursor), params);
  if (after) where.push(after);
  const limit = Math.min(Math.max(1, input.limit ?? 50), 200);
  params.limit = limit + 1;
  const rows = db.query(`${DEAL_SELECT}, ${sort.expr} AS sort_value ${DEAL_FROM} WHERE ${where.join(" AND ")} ORDER BY ${sort.expr} ${sort.dir}, d.id ${sort.dir} LIMIT $limit`).all(params) as DealRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: toDeals(page), nextCursor: rows.length > limit && last ? encodeCursor(last.sort_value ?? null, last.id) : null };
}

/** The deal board (§D.5 GET /pipelines/:id/board): every stage with its deals (≤ 200 each) and totals (all deals, value and weighted). */
export function pipelineBoard(ref: string, userId: string, options: { ownerId?: string | null; q?: string; keyFilter?: { sql: string; params: Record<string, string> } } = {}): CrmBoard {
  const { pipeline, book } = readPipeline(ref, userId);
  ensureRottingSchedule(book.id, null);
  const currency = pipeline.currency ?? bookCurrency(book);
  const where = ["d.pipeline_id = $pipeline", "d.deleted_at IS NULL", readableBooksSql("b")];
  const params: Record<string, string | number> = { pipeline: pipeline.id, userId };
  if (options.ownerId) { where.push("d.owner_id = $owner"); params.owner = options.ownerId === "me" ? userId : options.ownerId; }
  const q = options.q?.trim().toLowerCase().slice(0, 100);
  if (q) { where.push("(instr(lower(d.title), $q) > 0 OR instr(lower(COALESCE(co.name, '')), $q) > 0)"); params.q = q; }
  if (options.keyFilter) { where.push(options.keyFilter.sql); Object.assign(params, options.keyFilter.params); }
  const totals = new Map((db.query(`SELECT d.stage_id, COUNT(*) AS count, SUM(CASE WHEN d.currency = $currency THEN COALESCE(d.value_minor, 0) ELSE 0 END) AS sum FROM deals d JOIN contact_books b ON b.id = d.book_id
      LEFT JOIN companies co ON co.id = d.company_id WHERE ${where.join(" AND ")} GROUP BY d.stage_id`).all({ ...params, currency }) as Array<{ stage_id: string; count: number; sum: number | null }>)
    .map((row) => [row.stage_id, row]));
  const rows = db.query(`SELECT * FROM (${DEAL_SELECT}, ROW_NUMBER() OVER (PARTITION BY d.stage_id ORDER BY d.position, d.id) AS rn ${DEAL_FROM} WHERE ${where.join(" AND ")}) WHERE rn <= 200 ORDER BY position, id`).all(params) as DealRow[];
  const deals = toDeals(rows);
  const columns = pipeline.stages.map((stage) => {
    const total = totals.get(stage.id);
    const sum = total?.sum ?? 0;
    return { stage, count: total?.count ?? 0, sum, weighted: weightedValue(sum, stage.probability), deals: deals.filter((deal) => deal.stageId === stage.id) };
  });
  const open = columns.filter((column) => column.stage.kind === "open");
  return { pipeline, currency, columns, totals: { count: open.reduce((n, c) => n + c.count, 0), sum: open.reduce((n, c) => n + c.sum, 0), weighted: open.reduce((n, c) => n + c.weighted, 0) } };
}

export type DealInput = {
  bookId?: string; pipelineId?: string | null; stageId?: string | null; stageName?: string | null; title?: string | null; value?: number | null; currency?: string | null;
  expectedCloseOn?: string | null; ownerId?: string | null; companyId?: string | null; contactIds?: string[]; nextStep?: string | null; nextStepOn?: string | null;
  tags?: string[]; custom?: Record<string, unknown>; lostReason?: string | null;
};

function stageFor(pipelineId: string, input: { stageId?: string | null; stageName?: string | null }): StageRow | null {
  if (input.stageId) {
    const stage = db.query("SELECT * FROM pipeline_stages WHERE id = ? AND pipeline_id = ?").get(String(input.stageId).toLowerCase(), pipelineId) as StageRow | null;
    if (!stage) throw invalid("Choose a stage of this pipeline");
    return stage;
  }
  if (input.stageName) {
    const stage = db.query("SELECT * FROM pipeline_stages WHERE pipeline_id = ? AND name = ? COLLATE NOCASE").get(pipelineId, String(input.stageName).trim()) as StageRow | null;
    if (!stage) throw invalid(`No stage named “${String(input.stageName).slice(0, 60)}” in this pipeline`);
    return stage;
  }
  return null;
}

function cleanValue(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 9_000_000_000_000_000) throw invalid("A value is a whole number of minor units (cents) of at least 0");
  return value;
}

function bookCompany(bookId: string, companyId: unknown): string | null {
  if (companyId === null || companyId === undefined || companyId === "") return null;
  const id = cleanRef(companyId);
  const row = id ? db.query(`SELECT id FROM companies WHERE ${refColumn(id)} = ? AND book_id = ? AND deleted_at IS NULL`).get(id, bookId) as { id: string } | null : null;
  if (!row) throw invalid("Choose a company in this book");
  return row.id;
}
function bookContacts(bookId: string, ids: unknown): string[] {
  if (!Array.isArray(ids)) throw invalid("Contacts are a list");
  if (ids.length > 50) throw invalid("Up to 50 contacts on a deal");
  return [...new Set(ids.map((value) => {
    const id = cleanRef(value);
    const row = id ? db.query(`SELECT id FROM contacts WHERE ${refColumn(id)} = ? AND book_id = ? AND deleted_at IS NULL`).get(id, bookId) as { id: string } | null : null;
    if (!row) throw invalid("Choose contacts in this book");
    return row.id;
  }))];
}

const positionAtEnd = (stageId: string) => ((db.query("SELECT MAX(position) AS p FROM deals WHERE stage_id = ? AND deleted_at IS NULL").get(stageId) as { p: number | null }).p ?? 0) + 1;

/** The position for index `toIndex` among a stage's other deals (board drag). */
function positionAt(stageId: string, dealId: string, toIndex: number) {
  const others = (db.query("SELECT position FROM deals WHERE stage_id = ? AND id <> ? AND deleted_at IS NULL ORDER BY position, id").all(stageId, dealId) as Array<{ position: number }>).map((row) => row.position);
  const index = Math.max(0, Math.min(Math.floor(toIndex), others.length));
  const before = index > 0 ? others[index - 1]! : null;
  const after = index < others.length ? others[index]! : null;
  if (before === null && after === null) return 1;
  if (before === null) return after! - 1;
  if (after === null) return before + 1;
  if (after - before < 1e-9) {
    // Renumber the stage when positions run out of room.
    const ids = (db.query("SELECT id FROM deals WHERE stage_id = ? AND id <> ? AND deleted_at IS NULL ORDER BY position, id").all(stageId, dealId) as Array<{ id: string }>).map((row) => row.id);
    ids.forEach((id, i) => db.query("UPDATE deals SET position = ? WHERE id = ?").run(i + 1, id));
    return index + 0.5;
  }
  return (before + after) / 2;
}

/**
 * The index among all of a stage's other deals for a drop between two neighbours (D1167): a board
 * filtered by owner or search shows only some deals, so the client names the card it lands after
 * (`afterId`, above it) and before (`beforeId`, below it) instead of an index among what it shows.
 * Null when neither neighbour is a deal of the stage (an empty column, or both moved meanwhile).
 */
function indexBetween(stageId: string, dealId: string, afterId: unknown, beforeId: unknown): number | null {
  const ids = (db.query("SELECT id FROM deals WHERE stage_id = ? AND id <> ? AND deleted_at IS NULL ORDER BY position, id").all(stageId, dealId) as Array<{ id: string }>).map((row) => row.id);
  const find = (value: unknown) => typeof value === "string" ? ids.indexOf(value.toLowerCase()) : -1;
  const after = find(afterId);
  if (after >= 0) return after + 1;
  const before = find(beforeId);
  return before >= 0 ? before : null;
}

/**
 * The currency a new deal in `book` gets when none is given (D986): the pipeline's (the one named, else
 * the book's first, as createDeal picks it), else the book's. Callers that turn a typed amount into
 * minor units use it, so the digits match the currency the deal is saved in.
 */
export function newDealCurrency(book: Pick<BookRow, "id" | "settings_json">, pipelineId: string | null | undefined): string {
  const pipeline = (pipelineId
    ? db.query("SELECT currency FROM pipelines WHERE id = ? AND book_id = ? AND deleted_at IS NULL").get(String(pipelineId).toLowerCase(), book.id)
    : db.query("SELECT currency FROM pipelines WHERE book_id = ? AND deleted_at IS NULL ORDER BY position, id LIMIT 1").get(book.id)) as { currency: string | null } | null;
  return pipeline?.currency ?? bookCurrency(book);
}

export function createDeal(userId: string, input: DealInput, source: "manual" | "import" | "booking" | "form" | "mcp" = "manual"): CrmDeal {
  return db.transaction(() => {
    let bookId = input.bookId;
    let pipelineId = input.pipelineId ? String(input.pipelineId).toLowerCase() : null;
    if (pipelineId) {
      const pipeline = db.query("SELECT book_id FROM pipelines WHERE id = ? AND deleted_at IS NULL").get(pipelineId) as { book_id: string } | null;
      if (!pipeline || (bookId && pipeline.book_id !== bookOfRef(bookId))) throw notFound("Pipeline not found");
      bookId = pipeline.book_id;
    }
    const book = requireBook(bookId ?? "", userId, "edit");
    pipelineId ??= (db.query("SELECT id FROM pipelines WHERE book_id = ? AND deleted_at IS NULL ORDER BY position, id LIMIT 1").get(book.id) as { id: string } | null)?.id
      ?? createPipelineRows(book.id, "Sales pipeline", null, [{ name: "Lead", kind: "open", probability: 10 }, { name: "Won", kind: "won", probability: 100 }, { name: "Lost", kind: "lost", probability: 0 }]);
    const stage = stageFor(pipelineId, input) ?? db.query("SELECT * FROM pipeline_stages WHERE pipeline_id = ? AND kind = 'open' ORDER BY position LIMIT 1").get(pipelineId) as StageRow;
    const title = cleanText(input.title, 200, "The title");
    if (!title) throw invalid("Name the deal");
    const pipelineCurrency = (db.query("SELECT currency FROM pipelines WHERE id = ?").get(pipelineId) as { currency: string | null }).currency;
    const currency = input.currency ?? pipelineCurrency ?? bookCurrency(book);
    if (!isCurrency(currency)) throw invalid("Choose a currency code");
    const id = crypto.randomUUID();
    const timestamp = now();
    const ownerId = cleanUserId(input.ownerId) ?? (input.ownerId === undefined ? userId : null);
    db.query(`INSERT INTO deals (id, short_id, book_id, pipeline_id, stage_id, title, value_minor, currency, expected_close_on, owner_id, company_id, next_step, next_step_on, status, closed_at,
        lost_reason, stage_entered_at, last_activity_at, position, custom_json, tags_json, source, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, newShortId(), book.id, pipelineId, stage.id, title, cleanValue(input.value), currency, cleanDate(input.expectedCloseOn, "The close date"), ownerId, bookCompany(book.id, input.companyId),
        cleanText(input.nextStep, 200, "The next step"), cleanDate(input.nextStepOn, "The next step date"), stage.kind, stage.kind === "open" ? null : timestamp,
        stage.kind === "lost" ? cleanText(input.lostReason, 200, "The reason") : null, timestamp, timestamp, positionAtEnd(stage.id),
        writeCustom(bookFields(book).deal, "{}", input.custom ?? {}, book.id, userId, "create"), cleanTags(input.tags), source, userId, timestamp, timestamp);
    const insertContact = db.query("INSERT OR IGNORE INTO deal_contacts (deal_id, contact_id) VALUES (?, ?)");
    for (const contactId of bookContacts(book.id, input.contactIds ?? [])) insertContact.run(id, contactId);
    db.query("INSERT INTO deal_stage_changes (id, deal_id, from_stage_id, to_stage_id, value_minor, actor_id, at) VALUES (?, ?, NULL, ?, ?, ?, ?)").run(Bun.randomUUIDv7(), id, stage.id, cleanValue(input.value), userId, timestamp);
    recordItemActivity({ itemKind: "deal", itemId: id, container: { kind: "contact_book", id: book.id }, actorId: userId, kind: "created", payload: { to: { label: title } } });
    if (ownerId && ownerId !== userId) notifyReaders(book.id, { userIds: [ownerId], module: "crm", topic: "crm.deal_assigned", title: `You own the deal “${title.slice(0, 120)}”`, href: crmDealPath(title, readDealRow(id, userId).short_id), item: { kind: "deal", id }, actor: userId, email: dealMail("crm.deal_assigned", id, userId) });
    audit(userId, null, "crm.deal_create", { bookId: book.id, dealId: id, source });
    return toDeals([readDealRow(id, userId)])[0]!;
  })();
}

const bookOfRef = (ref: string) => {
  const clean = cleanRef(ref);
  return clean ? (db.query(`SELECT id FROM contact_books WHERE ${refColumn(clean)} = ?`).get(clean) as { id: string } | null)?.id ?? null : null;
};

/** Updates a deal (edit on its book). A stage change (by id or name) records the move; `position` is the index in the stage (the board). */
export function updateDeal(ref: string, userId: string, patch: DealInput & { position?: number; afterId?: string | null; beforeId?: string | null; expectedRevision?: number }): CrmDeal {
  return db.transaction(() => {
    const row = readDealRow(ref, userId);
    const book = requireBook(row.book_id, userId, "edit");
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== row.revision) throw new CrmError(409, "CONFLICT", "Someone else changed this deal. Reload and try again.", { revision: row.revision });
    const timestamp = now();
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const changed: string[] = [];
    const set = (column: string, value: string | number | null, label?: string) => { sets.push(`${column} = ?`); values.push(value); if (label && !changed.includes(label)) changed.push(label); };
    let pipelineId = row.pipeline_id;
    if (patch.pipelineId && patch.pipelineId.toLowerCase() !== row.pipeline_id) {
      const pipeline = db.query("SELECT id FROM pipelines WHERE id = ? AND book_id = ? AND deleted_at IS NULL").get(patch.pipelineId.toLowerCase(), book.id) as { id: string } | null;
      if (!pipeline) throw invalid("Choose a pipeline of this book");
      pipelineId = pipeline.id;
      set("pipeline_id", pipelineId, "Pipeline");
    }
    let stage = stageFor(pipelineId, patch);
    if (!stage && pipelineId !== row.pipeline_id) stage = db.query("SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY position LIMIT 1").get(pipelineId) as StageRow;
    let moved: StageRow | null = null;
    if (stage && stage.id !== row.stage_id) {
      moved = stage;
      set("stage_id", stage.id);
      set("status", stage.kind);
      set("closed_at", stage.kind === "open" ? null : timestamp);
      set("stage_entered_at", timestamp);
      set("last_activity_at", timestamp);
      set("rot_notified_at", null);
      if (stage.kind !== "lost") set("lost_reason", null);
    }
    const targetStage = moved?.id ?? row.stage_id;
    const neighbourIndex = patch.afterId !== undefined || patch.beforeId !== undefined ? indexBetween(targetStage, row.id, patch.afterId, patch.beforeId) : undefined;
    if (neighbourIndex !== undefined) {
      if (neighbourIndex !== null) set("position", positionAt(targetStage, row.id, neighbourIndex));
      else if (moved) set("position", positionAtEnd(targetStage));
    } else if (patch.position !== undefined) {
      if (typeof patch.position !== "number" || !Number.isFinite(patch.position) || patch.position < 0) throw invalid("A position is an index of at least 0");
      set("position", positionAt(targetStage, row.id, patch.position));
    } else if (moved) set("position", positionAtEnd(targetStage));
    if (patch.title !== undefined) { const title = cleanText(patch.title, 200, "The title"); if (!title) throw invalid("Name the deal"); set("title", title, "Title"); }
    if (patch.value !== undefined) set("value_minor", cleanValue(patch.value), "Value");
    if (patch.currency !== undefined && patch.currency !== null) { if (!isCurrency(patch.currency)) throw invalid("Choose a currency code"); set("currency", patch.currency, "Currency"); }
    if (patch.expectedCloseOn !== undefined) set("expected_close_on", cleanDate(patch.expectedCloseOn, "The close date"), "Expected close");
    let newOwner: string | null = null;
    if (patch.ownerId !== undefined) { newOwner = cleanUserId(patch.ownerId); set("owner_id", newOwner, "Owner"); }
    if (patch.companyId !== undefined) set("company_id", bookCompany(book.id, patch.companyId), "Company");
    if (patch.nextStep !== undefined) set("next_step", cleanText(patch.nextStep, 200, "The next step"), "Next step");
    if (patch.nextStepOn !== undefined) set("next_step_on", cleanDate(patch.nextStepOn, "The next step date"), "Next step");
    if (patch.lostReason !== undefined) set("lost_reason", cleanText(patch.lostReason, 200, "The reason"), "Lost reason");
    if (patch.tags !== undefined) set("tags_json", cleanTags(patch.tags), "Tags");
    if (patch.custom !== undefined) set("custom_json", writeCustom(bookFields(book).deal, row.custom_json, patch.custom, book.id, userId, "update"), "Custom fields");
    if (patch.contactIds !== undefined) {
      const ids = bookContacts(book.id, patch.contactIds);
      db.query("DELETE FROM deal_contacts WHERE deal_id = ? AND contact_id NOT IN (SELECT value FROM json_each(?))").run(row.id, JSON.stringify(ids));
      for (const contactId of ids) db.query("INSERT OR IGNORE INTO deal_contacts (deal_id, contact_id) VALUES (?, ?)").run(row.id, contactId);
      changed.push("Contacts");
    }
    if (!sets.length && !changed.length) return toDeals([row])[0]!;
    db.query(`UPDATE deals SET ${[...sets, "updated_at = ?", "revision = revision + 1"].join(", ")} WHERE id = ?`).run(...values, timestamp, row.id);
    const title = (db.query("SELECT title, short_id FROM deals WHERE id = ?").get(row.id) as { title: string; short_id: string });
    const href = crmDealPath(title.title, title.short_id);
    if (moved) {
      db.query("INSERT INTO deal_stage_changes (id, deal_id, from_stage_id, to_stage_id, value_minor, actor_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(Bun.randomUUIDv7(), row.id, row.stage_id, moved.id, patch.value !== undefined ? cleanValue(patch.value) : row.value_minor, userId, timestamp);
      recordItemChange({ itemKind: "deal", itemId: row.id, container: { kind: "contact_book", id: book.id }, actorId: userId, kind: "crm_stage", from: { id: row.stage_id, label: row.stage_name }, to: { id: moved.id, label: moved.name } });
      audit(userId, null, "crm.deal_stage", { bookId: book.id, dealId: row.id, fromStageId: row.stage_id, toStageId: moved.id });
      const owner = (db.query("SELECT owner_id FROM deals WHERE id = ?").get(row.id) as { owner_id: string | null }).owner_id;
      if (moved.kind !== "open" && owner && owner !== userId) {
        notifyReaders(book.id, { userIds: [owner], module: "crm", topic: moved.kind === "won" ? "crm.deal_won" : "crm.deal_lost", title: `“${title.title.slice(0, 120)}” was ${moved.kind}`, href, item: { kind: "deal", id: row.id }, actor: userId, email: dealMail(moved.kind === "won" ? "crm.deal_won" : "crm.deal_lost", row.id, userId) });
      }
    }
    if (changed.length) recordItemActivity({ itemKind: "deal", itemId: row.id, container: { kind: "contact_book", id: book.id }, actorId: userId, kind: "crm_updated", payload: { extra: { fields: changed.join(", ") } } });
    if (newOwner && newOwner !== row.owner_id && newOwner !== userId) notifyReaders(book.id, { userIds: [newOwner], module: "crm", topic: "crm.deal_assigned", title: `You own the deal “${title.title.slice(0, 120)}”`, href, item: { kind: "deal", id: row.id }, actor: userId, email: dealMail("crm.deal_assigned", row.id, userId) });
    if (changed.length) audit(userId, null, "crm.deal_update", { bookId: book.id, dealId: row.id, fields: changed });
    return toDeals([readDealRow(row.id, userId)])[0]!;
  })();
}

export function binDeal(ref: string, userId: string) {
  return db.transaction(() => {
    const row = readDealRow(ref, userId);
    requireBook(row.book_id, userId, "edit");
    const timestamp = now();
    db.query("UPDATE deals SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ? WHERE id = ?").run(timestamp, userId, new Date(Date.now() + 30 * 86_400_000).toISOString(), timestamp, row.id);
    recordItemActivity({ itemKind: "deal", itemId: row.id, container: { kind: "contact_book", id: row.book_id }, actorId: userId, kind: "binned" });
    audit(userId, null, "crm.deal_delete", { bookId: row.book_id, dealId: row.id });
    return { binned: true, id: row.id };
  })();
}

/** Pipeline summary by stage (MCP `pipeline_summary`): count, sum, weighted. */
export function pipelineSummary(ref: string, userId: string) {
  const board = pipelineBoard(ref, userId);
  return {
    pipeline: { id: board.pipeline.id, name: board.pipeline.name }, currency: board.currency,
    stages: board.columns.map((column) => ({ id: column.stage.id, name: column.stage.name, kind: column.stage.kind, probability: column.stage.probability, count: column.count, sum: column.sum, weighted: column.weighted })),
    openTotals: board.totals
  };
}

/** Newly rotting open deals of a book (the `crm.rotting` schedule): their owners hear once per stay in a stage. */
export function notifyRotting(bookId: string, nowMs = Date.now()) {
  const book = db.query("SELECT settings_json, deleted_at FROM contact_books WHERE id = ?").get(bookId) as { settings_json: string; deleted_at: string | null } | null;
  if (!book || book.deleted_at) return 0;
  const fallback = bookSettings(book).rottingDays;
  const rows = db.query(`SELECT d.id, d.short_id, d.title, d.owner_id, d.last_activity_at, s.rot_days FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id
    WHERE d.book_id = ? AND d.status = 'open' AND d.deleted_at IS NULL AND d.rot_notified_at IS NULL AND d.owner_id IS NOT NULL`).all(bookId) as Array<{ id: string; short_id: string; title: string; owner_id: string; last_activity_at: string; rot_days: number | null }>;
  let count = 0;
  for (const row of rows) {
    if (!isRotting({ status: "open", lastActivityAt: row.last_activity_at }, row.rot_days ?? fallback, nowMs)) continue;
    notifyReaders(bookId, { userIds: [row.owner_id], module: "crm", topic: "crm.deal_rotting", title: `“${row.title.slice(0, 120)}” has had no activity for a while`, body: "Log an interaction or move it on.", href: crmDealPath(row.title, row.short_id), item: { kind: "deal", id: row.id }, dedupeKey: `rotting:${row.id}`, nowMs });
    db.query("UPDATE deals SET rot_notified_at = ? WHERE id = ?").run(new Date(nowMs).toISOString(), row.id);
    count += 1;
  }
  return count;
}

export { stagesOf, toDeals };
