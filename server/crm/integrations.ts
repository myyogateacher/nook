import * as z from "zod/v4";
import { audit, db, now } from "../db";
import { SWEEP_BATCH_SIZE, type BinItem, type BinProvider, type BinSweepCounts, type PurgeOutcome, type RestoreOutcome } from "../bin";
import { withResourceLock } from "../storage";
import { anchorBySql } from "../keyResources";
import { each, type WorkKindAdapter } from "../links/adapters";
import { readableContainerSql } from "../access/workspaceItems";
import { page as todayPage, sectionScope, type TodayProvider } from "../today/registry";
import type { SearchScopeDef } from "../searchRegistry";
import type { DatasetDef } from "../datasets/registry";
import type { ProgressSource } from "../goalsProgress";
import type { DigestSection } from "../mail/digest";
import { WORK_KIND_ICONS } from "../../shared/workRefs";
import { crmCompanyPath, crmContactPath, crmDealPath } from "../../shared/crm";
import { bookCurrency, levelOnBook, readableBooksSql } from "./core";
import { readDealRow } from "./deals";

/**
 * What Contacts registers with the foundation (§D.5): the `deal` work kind and the `deal` /
 * `interaction` key-grant anchors (contacts and companies are foundation), Bin providers for books,
 * contacts, companies, and deals, the Today section, the search scope, datasets, goal progress
 * sources, and the digest section.
 */

// ----------------------------------------------------------------------------- work kind and anchors

export const dealAnchor = anchorBySql("contact_book", "SELECT book_id AS anchor FROM deals WHERE id = ? OR short_id = ?1");
export const interactionAnchor = anchorBySql("contact_book", "SELECT book_id AS anchor FROM interactions WHERE id = ?");

export const dealWorkKind: WorkKindAdapter = {
  kind: "deal", itemKind: "deal", scopes: { read: "crm:read", write: "crm:write" },
  lookup: (ref) => ref.by === "id" ? ref.ref : ref.by === "short_id" ? (db.query("SELECT id FROM deals WHERE short_id = ?").get(ref.ref) as { id: string } | null)?.id ?? null : null,
  level: (id, viewer) => {
    const row = db.query("SELECT book_id FROM deals WHERE (id = ? OR short_id = ?1) AND deleted_at IS NULL").get(id) as { book_id: string } | null;
    return row ? levelOnBook(row.book_id, viewer.userId) : "none";
  },
  resolve: each((id, viewer) => {
    try {
      const row = readDealRow(id, viewer.userId);
      return {
        kind: "deal", id: row.id, shortId: row.short_id, title: row.title, subtitle: [row.stage_name, row.company_name].filter(Boolean).join(" · "), href: crmDealPath(row.title, row.short_id), icon: WORK_KIND_ICONS.deal,
        status: { label: row.stage_name, tone: row.status === "won" ? "success" : row.status === "lost" ? "danger" : "info" }, ...(row.expected_close_on ? { due: row.expected_close_on } : {})
      };
    } catch { return null; }
  })
};

// ----------------------------------------------------------------------------- Bin

const DAY = 86_400_000;
const providedDefaults = { board_id: null, board_name: null, attachment: false, attachment_of: null, attachment_kind: null } as const;
type Binned = Pick<BinItem, "type" | "id" | "title" | "folder_id" | "folder_name" | "size_bytes" | "deleted_at" | "purge_after"> & { purging: number; can_purge: number; short_id?: string };

/** A Bin provider for one of the book's record tables: listed for the book's owner and whoever binned it while they can still edit; the owner purges. */
function recordBin(type: "contact" | "company" | "deal", table: string, titleColumn: string): BinProvider {
  const lock = (id: string) => `crm:${type}:${id}`;
  const purgeNow = (id: string, reason: string, actorId: string | null, dueBy?: string): PurgeOutcome => db.transaction((): PurgeOutcome => {
    const row = db.query(`SELECT book_id FROM ${table} WHERE id = ? AND deleted_at IS NOT NULL${dueBy ? " AND purge_after <= ?" : ""}`).get(...(dueBy ? [id, dueBy] : [id])) as { book_id: string } | null;
    if (!row) return "not_found";
    db.query(`DELETE FROM ${table} WHERE id = ?`).run(id);
    audit(actorId, null, `crm.${type}_purge`, { bookId: row.book_id, id, reason });
    return "purged";
  })();
  return {
    list(userId) {
      const rows = db.query(`SELECT '${type}' AS type, r.id, r.${titleColumn} AS title, r.short_id, b.id AS folder_id, b.name AS folder_name, NULL AS size_bytes, r.deleted_at, r.purge_after,
          r.purge_started_at IS NOT NULL AS purging, b.owner_id = $userId AS can_purge
        FROM ${table} r JOIN contact_books b ON b.id = r.book_id
        WHERE r.deleted_at IS NOT NULL AND b.deleted_at IS NULL AND (b.owner_id = $userId OR (r.deleted_by = $userId AND ${readableContainerSql("contact_book", "b", { minLevel: "edit" })}))
        ORDER BY r.deleted_at DESC LIMIT 500`).all({ userId }) as Binned[];
      const path = type === "contact" ? crmContactPath : type === "company" ? crmCompanyPath : crmDealPath;
      return rows.map(({ short_id, ...row }): BinItem => ({ ...row, purging: row.purging === 1, can_purge: row.can_purge === 1, ...providedDefaults, ...(short_id ? { href: path(row.title, short_id) } : {}) }));
    },
    restore(id, userId) {
      return withResourceLock(lock(id), async (): Promise<RestoreOutcome> => {
        const row = db.query(`SELECT r.id, r.deleted_at, r.deleted_by, b.id AS book_id, b.name AS book_name, b.owner_id, b.deleted_at AS book_deleted FROM ${table} r JOIN contact_books b ON b.id = r.book_id WHERE r.id = ?`)
          .get(id) as { id: string; deleted_at: string | null; deleted_by: string | null; book_id: string; book_name: string; owner_id: string; book_deleted: string | null } | null;
        if (!row || (row.owner_id !== userId && !(row.deleted_by === userId && ["edit", "manage", "owner"].includes(levelOnBook(row.book_id, userId))))) return { status: "not_found" };
        if (row.book_deleted) return { status: "parent_in_bin", message: "Restore its contact book first" };
        if (row.deleted_at === null) return { status: "already_restored", folderId: row.book_id, folderName: row.book_name };
        // A live company may have taken the binned one's domain meanwhile (one per book, D1165).
        if (type === "company") {
          const taken = db.query(`SELECT live.name, binned.domain FROM companies binned JOIN companies live ON live.book_id = binned.book_id AND live.domain = binned.domain AND live.deleted_at IS NULL AND live.id <> binned.id
            WHERE binned.id = ? AND binned.domain IS NOT NULL`).get(id) as { name: string; domain: string } | null;
          if (taken) return { status: "name_taken", message: `${taken.name} in ${row.book_name} already has the domain ${taken.domain}. Change its domain, then restore this company.` };
        }
        db.transaction(() => {
          db.query(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
          audit(userId, null, `crm.${type}_restore`, { bookId: row.book_id, id });
        })();
        return { status: "restored", folderId: row.book_id, folderName: row.book_name, visibility: "private" };
      });
    },
    purge(id, userId) {
      return withResourceLock(lock(id), async () => {
        const row = db.query(`SELECT r.deleted_at, b.owner_id FROM ${table} r JOIN contact_books b ON b.id = r.book_id WHERE r.id = ?`).get(id) as { deleted_at: string | null; owner_id: string } | null;
        if (!row || row.owner_id !== userId) return "not_found";
        if (row.deleted_at === null) return "live";
        return purgeNow(id, "user", userId);
      });
    },
    async sweep(cutoff) {
      const counts: BinSweepCounts = { purged: 0, pending: 0 };
      const due = db.query(`SELECT id FROM ${table} WHERE deleted_at IS NOT NULL AND purge_after <= ? ORDER BY purge_after LIMIT ?`).all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string }>;
      for (const { id } of due) if (await withResourceLock(lock(id), async () => purgeNow(id, "retention", null, cutoff)) === "purged") counts.purged += 1;
      return counts;
    },
    async empty(userId) {
      const counts: BinSweepCounts = { purged: 0, pending: 0 };
      const ids = db.query(`SELECT r.id FROM ${table} r JOIN contact_books b ON b.id = r.book_id WHERE b.owner_id = ? AND r.deleted_at IS NOT NULL`).all(userId) as Array<{ id: string }>;
      for (const { id } of ids) if (await withResourceLock(lock(id), async () => purgeNow(id, "user", userId)) === "purged") counts.purged += 1;
      return counts;
    }
  };
}

const bookBin: BinProvider = (() => {
  const lock = (id: string) => `crm:book:${id}`;
  const purgeNow = (id: string, reason: string, actorId: string | null): PurgeOutcome => db.transaction((): PurgeOutcome => {
    if (!db.query("SELECT 1 FROM contact_books WHERE id = ? AND deleted_at IS NOT NULL AND system_kind IS NULL").get(id)) return "not_found";
    db.query("DELETE FROM contact_books WHERE id = ?").run(id);
    audit(actorId, null, "crm.book_purge", { bookId: id, reason });
    return "purged";
  })();
  return {
    list(userId) {
      const rows = db.query(`SELECT 'contact_book' AS type, id, name AS title, short_id, NULL AS folder_id, 'Contacts' AS folder_name, NULL AS size_bytes, deleted_at, purge_after, purge_started_at IS NOT NULL AS purging, 1 AS can_purge
        FROM contact_books WHERE owner_id = ? AND deleted_at IS NOT NULL AND system_kind IS NULL ORDER BY deleted_at DESC LIMIT 200`).all(userId) as Binned[];
      return rows.map(({ short_id, ...row }): BinItem => ({ ...row, purging: row.purging === 1, can_purge: true, ...providedDefaults, ...(short_id ? { href: `/contacts?book=${short_id}` } : {}) }));
    },
    restore(id, userId) {
      return withResourceLock(lock(id), async (): Promise<RestoreOutcome> => {
        const row = db.query("SELECT deleted_at FROM contact_books WHERE id = ? AND owner_id = ? AND system_kind IS NULL").get(id, userId) as { deleted_at: string | null } | null;
        if (!row) return { status: "not_found" };
        if (row.deleted_at === null) return { status: "already_restored", folderId: null, folderName: "Contacts" };
        db.query("UPDATE contact_books SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ? WHERE id = ?").run(now(), id);
        audit(userId, null, "crm.book_restore", { bookId: id });
        return { status: "restored", folderId: null, folderName: "Contacts", visibility: "private" };
      });
    },
    purge(id, userId) {
      return withResourceLock(lock(id), async () => {
        const row = db.query("SELECT deleted_at FROM contact_books WHERE id = ? AND owner_id = ? AND system_kind IS NULL").get(id, userId) as { deleted_at: string | null } | null;
        if (!row) return "not_found";
        if (row.deleted_at === null) return "live";
        return purgeNow(id, "user", userId);
      });
    },
    async sweep(cutoff) {
      const counts: BinSweepCounts = { purged: 0, pending: 0 };
      for (const { id } of db.query("SELECT id FROM contact_books WHERE deleted_at IS NOT NULL AND system_kind IS NULL AND purge_after <= ? LIMIT ?").all(cutoff, SWEEP_BATCH_SIZE) as Array<{ id: string }>) {
        if (await withResourceLock(lock(id), async () => purgeNow(id, "retention", null)) === "purged") counts.purged += 1;
      }
      return counts;
    },
    async empty(userId) {
      const counts: BinSweepCounts = { purged: 0, pending: 0 };
      for (const { id } of db.query("SELECT id FROM contact_books WHERE owner_id = ? AND deleted_at IS NOT NULL AND system_kind IS NULL").all(userId) as Array<{ id: string }>) {
        if (await withResourceLock(lock(id), async () => purgeNow(id, "user", userId)) === "purged") counts.purged += 1;
      }
      return counts;
    }
  };
})();

export const crmBinProviders = [
  { type: "contact_book" as const, provider: bookBin },
  { type: "contact" as const, provider: recordBin("contact", "contacts", "display_name") },
  { type: "company" as const, provider: recordBin("company", "companies", "name") },
  { type: "deal" as const, provider: recordBin("deal", "deals", "title") }
];
void DAY;

// ----------------------------------------------------------------------------- Today

/** Follow-ups due by the end of today, then your open deals whose next step is due. */
export const crmTodayProvider: TodayProvider = {
  href: "/contacts/followups",
  mcpScope: "crm:read",
  load: (context) => {
    const key = sectionScope(context, "crm:read", { contact_book: "f.book_id" });
    const endOfDay = new Date(Date.parse(`${context.today}T23:59:59Z`) + 14 * 3_600_000).toISOString();
    const followups = db.query(`SELECT f.id, f.subject_kind, f.subject_id, f.due_at, f.note,
        CASE f.subject_kind WHEN 'contact' THEN (SELECT display_name || '|' || short_id FROM contacts WHERE id = f.subject_id AND deleted_at IS NULL)
          WHEN 'company' THEN (SELECT name || '|' || short_id FROM companies WHERE id = f.subject_id AND deleted_at IS NULL) ELSE (SELECT title || '|' || short_id FROM deals WHERE id = f.subject_id AND deleted_at IS NULL) END AS subject
      FROM crm_followups f JOIN contact_books b ON b.id = f.book_id
      WHERE f.user_id = $userId AND f.done_at IS NULL AND f.due_at <= $end AND ${readableBooksSql("b")} AND ${key.sql} ORDER BY f.due_at LIMIT 11`)
      .all({ userId: context.userId, end: endOfDay, ...key.params }) as Array<{ id: string; subject_kind: "contact" | "company" | "deal"; subject_id: string; due_at: string; note: string; subject: string | null }>;
    const dealKey = sectionScope(context, "crm:read", { contact_book: "d.book_id" });
    const deals = db.query(`SELECT d.id, d.short_id, d.title, d.next_step, d.next_step_on FROM deals d JOIN contact_books b ON b.id = d.book_id
      WHERE d.owner_id = $userId AND d.status = 'open' AND d.deleted_at IS NULL AND d.next_step_on IS NOT NULL AND d.next_step_on <= $today AND ${readableBooksSql("b")} AND ${dealKey.sql}
      ORDER BY d.next_step_on LIMIT 11`).all({ userId: context.userId, today: context.today, ...dealKey.params }) as Array<{ id: string; short_id: string; title: string; next_step: string | null; next_step_on: string }>;
    const items = [
      ...followups.filter((row) => row.subject).map((row) => {
        const [title, shortId] = row.subject!.split("|") as [string, string];
        const href = row.subject_kind === "contact" ? crmContactPath(title, shortId) : row.subject_kind === "company" ? crmCompanyPath(title, shortId) : crmDealPath(title, shortId);
        return { id: row.id, kind: "followup", title: `Follow up: ${title}`, detail: row.note || null, due: row.due_at, href };
      }),
      ...deals.map((row) => ({ id: row.id, kind: "next_step", title: row.title, detail: row.next_step ? `Next step: ${row.next_step}` : "Next step due", due: row.next_step_on, href: crmDealPath(row.title, row.short_id) }))
    ];
    return todayPage(items);
  }
};

// ----------------------------------------------------------------------------- search

function ftsQuery(q: string) {
  const tokens = q.toLowerCase().replace(/["*^:()]/g, " ").split(/\s+/).filter(Boolean).slice(0, 8);
  return tokens.length ? tokens.map((token) => `"${token}"*`).join(" ") : null;
}

export const crmSearchScope: SearchScopeDef = {
  scope: "contacts", label: "Contacts", module: "crm",
  search: ({ userId, q, limit }) => {
    const match = ftsQuery(q);
    if (!match) return { results: [], truncated: false };
    const rows = db.query(`SELECT s.kind, s.item_id, s.title, snippet(crm_fts, 1, '', '', '…', 12) AS snippet,
        COALESCE(c.short_id, co.short_id, d.short_id) AS short_id, COALESCE(c.updated_at, co.updated_at, d.updated_at, i.updated_at) AS updated_at,
        (SELECT json_object('kind', x.subject_kind, 'id', x.subject_id) FROM interaction_subjects x WHERE x.interaction_id = i.id LIMIT 1) AS subject
      FROM crm_fts JOIN crm_search s ON s.id = crm_fts.rowid JOIN contact_books b ON b.id = s.book_id
      LEFT JOIN contacts c ON s.kind = 'contact' AND c.id = s.item_id AND c.deleted_at IS NULL
      LEFT JOIN companies co ON s.kind = 'company' AND co.id = s.item_id AND co.deleted_at IS NULL
      LEFT JOIN deals d ON s.kind = 'deal' AND d.id = s.item_id AND d.deleted_at IS NULL
      LEFT JOIN interactions i ON s.kind = 'interaction' AND i.id = s.item_id
      WHERE crm_fts MATCH $match AND ${readableBooksSql("b")} AND (c.id IS NOT NULL OR co.id IS NOT NULL OR d.id IS NOT NULL OR i.id IS NOT NULL)
      ORDER BY CASE s.kind WHEN 'contact' THEN 0 WHEN 'company' THEN 1 WHEN 'deal' THEN 2 ELSE 3 END, bm25(crm_fts) LIMIT $limit`)
      .all({ match, userId, limit: limit + 1 }) as Array<{ kind: "contact" | "company" | "deal" | "interaction"; item_id: string; title: string; snippet: string; short_id: string | null; updated_at: string | null; subject: string | null }>;
    const results = rows.slice(0, limit).flatMap((row) => {
      if (row.kind === "interaction") {
        const subject = row.subject ? JSON.parse(row.subject) as { kind: "contact" | "company" | "deal"; id: string } : null;
        const target = subject ? db.query(`SELECT short_id, ${subject.kind === "contact" ? "display_name" : subject.kind === "company" ? "name" : "title"} AS title FROM ${subject.kind === "contact" ? "contacts" : subject.kind === "company" ? "companies" : "deals"} WHERE id = ?`).get(subject.id) as { short_id: string; title: string } | null : null;
        if (!subject || !target) return [];
        const href = subject.kind === "contact" ? crmContactPath(target.title, target.short_id) : subject.kind === "company" ? crmCompanyPath(target.title, target.short_id) : crmDealPath(target.title, target.short_id);
        return [{ kind: subject.kind, id: subject.id, title: row.title || `Note on ${target.title}`, snippet: row.snippet, href, ...(row.updated_at ? { updatedAt: row.updated_at } : {}) }];
      }
      const href = row.kind === "contact" ? crmContactPath(row.title, row.short_id!) : row.kind === "company" ? crmCompanyPath(row.title, row.short_id!) : crmDealPath(row.title, row.short_id!);
      return [{ kind: row.kind, id: row.item_id, title: row.title, ...(row.snippet ? { snippet: row.snippet } : {}), href, ...(row.updated_at ? { updatedAt: row.updated_at } : {}) }];
    });
    return { results, truncated: rows.length > limit };
  }
};

/** The same search as a list of typed hits (MCP `search_crm`). */
export function searchCrm(userId: string, q: string, entity: "contact" | "company" | "deal" | "interaction" | null, limit = 20, keyBooks: string[] | null = null) {
  const match = ftsQuery(q);
  if (!match) return [];
  return (db.query(`SELECT s.kind, s.item_id AS id, s.book_id AS bookId, s.title, snippet(crm_fts, 1, '', '', '…', 12) AS snippet FROM crm_fts JOIN crm_search s ON s.id = crm_fts.rowid JOIN contact_books b ON b.id = s.book_id
      WHERE crm_fts MATCH $match AND ${readableBooksSql("b")} ${entity ? "AND s.kind = $entity" : ""} ${keyBooks ? "AND s.book_id IN (SELECT value FROM json_each($books))" : ""}
        AND NOT EXISTS (SELECT 1 FROM contacts x WHERE s.kind = 'contact' AND x.id = s.item_id AND x.deleted_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM companies x WHERE s.kind = 'company' AND x.id = s.item_id AND x.deleted_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM deals x WHERE s.kind = 'deal' AND x.id = s.item_id AND x.deleted_at IS NOT NULL)
      ORDER BY bm25(crm_fts) LIMIT $limit`)
    .all({ match, userId, limit: Math.min(limit, 50), ...(entity ? { entity } : {}), ...(keyBooks ? { books: JSON.stringify(keyBooks) } : {}) }) as Array<{ kind: string; id: string; bookId: string; title: string; snippet: string }>);
}

// ----------------------------------------------------------------------------- datasets (§B.10)

const bookScope = () => ({ sql: readableBooksSql("b") });
export const crmDatasets: DatasetDef[] = [
  {
    id: "crm.contacts", module: "crm", label: "Contacts", description: "Contacts in books you can read: book, lifecycle, owner, source, created, last interaction.", readScope: "crm:read",
    from: "contacts c JOIN contact_books b ON b.id = c.book_id LEFT JOIN users u ON u.id = c.owner_id", scope: () => ({ sql: `c.deleted_at IS NULL AND ${readableBooksSql("b")}` }), timeColumn: "created",
    columns: [
      { name: "book", sql: "b.name", type: "string", label: "Book", dimension: true },
      { name: "lifecycle", sql: "COALESCE(c.lifecycle, 'None')", type: "string", label: "Lifecycle", dimension: true },
      { name: "owner", sql: "COALESCE(u.display_name, 'No owner')", type: "string", label: "Owner", dimension: true },
      { name: "source", sql: "c.source", type: "string", label: "Source", dimension: true },
      { name: "created", sql: "c.created_at", type: "datetime", label: "Created", dimension: true, measures: ["min", "max"] },
      { name: "last_interaction", sql: "c.last_interaction_at", type: "datetime", label: "Last interaction", dimension: true, measures: ["min", "max"] },
      { name: "contact_id", sql: "c.id", type: "string", label: "Contact", measures: ["count_distinct"] }
    ]
  },
  {
    id: "crm.deals", module: "crm", label: "Deals", description: "Deals in books you can read: pipeline, stage, status, value (minor units), owner, expected close, created, closed.", readScope: "crm:read",
    from: "deals d JOIN contact_books b ON b.id = d.book_id JOIN pipelines p ON p.id = d.pipeline_id JOIN pipeline_stages s ON s.id = d.stage_id LEFT JOIN users u ON u.id = d.owner_id",
    scope: () => ({ sql: `d.deleted_at IS NULL AND ${readableBooksSql("b")}` }), timeColumn: "created",
    columns: [
      { name: "book", sql: "b.name", type: "string", label: "Book", dimension: true },
      { name: "pipeline", sql: "p.name", type: "string", label: "Pipeline", dimension: true },
      { name: "pipeline_key", sql: "p.id", type: "string", label: "Pipeline id", dimension: true },
      { name: "stage", sql: "s.name", type: "string", label: "Stage", dimension: true },
      { name: "stage_position", sql: "s.position", type: "number", label: "Stage order", dimension: true, measures: ["min", "max"] },
      { name: "probability", sql: "s.probability", type: "number", label: "Probability", dimension: true, measures: ["avg", "min", "max"] },
      { name: "status", sql: "d.status", type: "string", label: "Status", dimension: true },
      { name: "deal_currency", sql: "d.currency", type: "string", label: "Currency", dimension: true },
      { name: "value", sql: "COALESCE(d.value_minor, 0)", type: "money", label: "Value", measures: ["sum", "avg", "min", "max"] },
      { name: "weighted", sql: "COALESCE(d.value_minor, 0) * s.probability / 100", type: "money", label: "Weighted value", measures: ["sum", "avg"] },
      { name: "owner", sql: "COALESCE(u.display_name, 'No owner')", type: "string", label: "Owner", dimension: true },
      { name: "expected_close", sql: "d.expected_close_on", type: "date", label: "Expected close", dimension: true, measures: ["min", "max"] },
      { name: "created", sql: "d.created_at", type: "datetime", label: "Created", dimension: true, measures: ["min", "max"] },
      { name: "closed", sql: "d.closed_at", type: "datetime", label: "Closed", dimension: true, measures: ["min", "max"] },
      { name: "deal_id", sql: "d.id", type: "string", label: "Deal", measures: ["count_distinct"] }
    ]
  },
  {
    id: "crm.deal_stage_changes", module: "crm", label: "Deal stage changes", description: "Every move of a deal into a stage (funnel and velocity): to and from stage, pipeline, value then, who, when.", readScope: "crm:read",
    from: `deal_stage_changes x JOIN deals d ON d.id = x.deal_id JOIN contact_books b ON b.id = d.book_id JOIN pipelines p ON p.id = d.pipeline_id
      JOIN pipeline_stages ts ON ts.id = x.to_stage_id LEFT JOIN pipeline_stages fs ON fs.id = x.from_stage_id LEFT JOIN users u ON u.id = x.actor_id`,
    scope: () => ({ sql: `d.deleted_at IS NULL AND ${readableBooksSql("b")}` }), timeColumn: "changed",
    columns: [
      { name: "pipeline", sql: "p.name", type: "string", label: "Pipeline", dimension: true },
      { name: "pipeline_key", sql: "p.id", type: "string", label: "Pipeline id", dimension: true },
      { name: "to_stage", sql: "ts.name", type: "string", label: "To stage", dimension: true },
      { name: "to_stage_position", sql: "ts.position", type: "number", label: "To stage order", dimension: true, measures: ["min", "max"] },
      { name: "to_kind", sql: "ts.kind", type: "string", label: "To stage kind", dimension: true },
      { name: "from_stage", sql: "COALESCE(fs.name, 'New')", type: "string", label: "From stage", dimension: true },
      { name: "value", sql: "COALESCE(x.value_minor, 0)", type: "money", label: "Value", measures: ["sum", "avg"] },
      { name: "actor", sql: "COALESCE(u.display_name, 'Nook')", type: "string", label: "Who", dimension: true },
      { name: "changed", sql: "x.at", type: "datetime", label: "When", dimension: true, measures: ["min", "max"] },
      { name: "deal_id", sql: "x.deal_id", type: "string", label: "Deal", measures: ["count_distinct"] }
    ]
  },
  {
    id: "crm.interactions", module: "crm", label: "Interactions", description: "Notes, calls, meetings, and emails logged in books you can read: kind, author, when, and what they were about.", readScope: "crm:read",
    from: "interactions i JOIN contact_books b ON b.id = i.book_id LEFT JOIN users u ON u.id = i.author_id", scope: bookScope, timeColumn: "occurred",
    columns: [
      { name: "book", sql: "b.name", type: "string", label: "Book", dimension: true },
      { name: "interaction_kind", sql: "i.kind", type: "string", label: "Kind", dimension: true },
      { name: "source", sql: "i.source", type: "string", label: "Source", dimension: true },
      { name: "author", sql: "COALESCE(u.display_name, 'Nook')", type: "string", label: "Author", dimension: true },
      { name: "subject_kinds", sql: "(SELECT group_concat(DISTINCT s.subject_kind) FROM interaction_subjects s WHERE s.interaction_id = i.id)", type: "string", label: "About", dimension: true },
      { name: "duration", sql: "COALESCE(i.duration_s, 0)", type: "duration", label: "Duration", measures: ["sum", "avg"] },
      { name: "occurred", sql: "i.occurred_at", type: "datetime", label: "When", dimension: true, measures: ["min", "max"] }
    ]
  }
];

// ----------------------------------------------------------------------------- goal progress sources (C9)

const progressConfig = z.object({ pipelineId: z.string().uuid().optional(), bookId: z.string().uuid().optional(), ownerId: z.string().uuid().optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional() });
type ProgressConfig = z.infer<typeof progressConfig>;

function progressSql(config: ProgressConfig, ownerId: string) {
  const where = ["d.deleted_at IS NULL", readableContainerSql("contact_book", "b"), "b.system_kind IS NULL"];
  const params: Record<string, string> = { userId: ownerId };
  if (config.pipelineId) { where.push("d.pipeline_id = $pipeline"); params.pipeline = config.pipelineId; }
  if (config.bookId) { where.push("d.book_id = $book"); params.book = config.bookId; }
  if (config.ownerId) { where.push("d.owner_id = $owner"); params.owner = config.ownerId; }
  return { where, params };
}
const describeScope = (config: ProgressConfig) => {
  const pipeline = config.pipelineId ? (db.query("SELECT name FROM pipelines WHERE id = ?").get(config.pipelineId) as { name: string } | null)?.name : null;
  return pipeline ? ` in ${pipeline}` : config.bookId ? " in a contact book" : "";
};
/**
 * The one currency a value source adds up (D1166, like the board, D972: no conversion): the config's,
 * else the pipeline's (else its book's), else the book's, else the workspace default.
 */
function progressCurrency(config: ProgressConfig): string {
  if (config.currency) return config.currency;
  if (config.pipelineId) {
    const row = db.query("SELECT p.currency, b.settings_json FROM pipelines p JOIN contact_books b ON b.id = p.book_id WHERE p.id = ?").get(config.pipelineId) as { currency: string | null; settings_json: string } | null;
    if (row) return row.currency ?? bookCurrency(row);
  }
  const book = config.bookId ? db.query("SELECT settings_json FROM contact_books WHERE id = ?").get(config.bookId) as { settings_json: string } | null : null;
  return bookCurrency(book ?? { settings_json: "{}" });
}
const periodBounds = (period: { start: string; end: string } | null) => period ? { from: `${period.start}T00:00:00.000Z`, to: new Date(Date.parse(`${period.end}T00:00:00Z`) + 86_400_000).toISOString() } : null;

export const crmProgressSources: Array<{ kind: string; source: Omit<ProgressSource<ProgressConfig>, "kind"> }> = [
  {
    kind: "crm_won_value", source: {
      label: "Won deal value", module: "crm", configSchema: progressConfig as never,
      describe: (config) => `Value of deals won${describeScope(config)}`,
      compute: (config, context) => {
        const { where, params } = progressSql(config, context.ownerId);
        const bounds = periodBounds(context.period);
        if (bounds) { where.push("d.closed_at >= $from AND d.closed_at < $to"); Object.assign(params, bounds); }
        const currency = progressCurrency(config);
        const row = db.query(`SELECT COALESCE(SUM(d.value_minor), 0) AS value FROM deals d JOIN contact_books b ON b.id = d.book_id WHERE d.status = 'won' AND d.currency = $currency AND ${where.join(" AND ")}`).get({ ...params, currency }) as { value: number };
        return { value: row.value, detail: currency };
      }
    }
  },
  {
    kind: "crm_won_count", source: {
      label: "Deals won", module: "crm", configSchema: progressConfig as never,
      describe: (config) => `Deals won${describeScope(config)}`,
      compute: (config, context) => {
        const { where, params } = progressSql(config, context.ownerId);
        const bounds = periodBounds(context.period);
        if (bounds) { where.push("d.closed_at >= $from AND d.closed_at < $to"); Object.assign(params, bounds); }
        return { value: (db.query(`SELECT COUNT(*) AS n FROM deals d JOIN contact_books b ON b.id = d.book_id WHERE d.status = 'won' AND ${where.join(" AND ")}`).get(params) as { n: number }).n };
      }
    }
  },
  {
    kind: "crm_pipeline_value", source: {
      label: "Open pipeline value", module: "crm", configSchema: progressConfig as never,
      describe: (config) => `Value of open deals${describeScope(config)}`,
      compute: (config, context) => {
        const { where, params } = progressSql(config, context.ownerId);
        const currency = progressCurrency(config);
        const row = db.query(`SELECT COALESCE(SUM(d.value_minor), 0) AS value FROM deals d JOIN contact_books b ON b.id = d.book_id WHERE d.status = 'open' AND d.currency = $currency AND ${where.join(" AND ")}`).get({ ...params, currency }) as { value: number };
        return { value: row.value, detail: currency };
      }
    }
  }
];

// ----------------------------------------------------------------------------- digest

export const crmDigestSection: DigestSection = {
  id: "crm.followups", label: "Follow-ups due", module: "crm",
  rows: (recipient) => {
    const rows = db.query(`SELECT f.id, f.subject_kind, f.subject_id, f.due_at FROM crm_followups f JOIN contact_books b ON b.id = f.book_id
      WHERE f.user_id = $userId AND f.done_at IS NULL AND f.due_at <= $soon AND ${readableBooksSql("b")} ORDER BY f.due_at LIMIT 21`)
      .all({ userId: recipient.id, soon: new Date(Date.now() + 86_400_000).toISOString() }) as Array<{ id: string; subject_kind: string; subject_id: string; due_at: string }>;
    const out = rows.flatMap((row) => {
      const table = row.subject_kind === "contact" ? "contacts" : row.subject_kind === "company" ? "companies" : "deals";
      const column = row.subject_kind === "contact" ? "display_name" : row.subject_kind === "company" ? "name" : "title";
      const record = db.query(`SELECT short_id, ${column} AS title FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(row.subject_id) as { short_id: string; title: string } | null;
      if (!record) return [];
      const href = row.subject_kind === "contact" ? crmContactPath(record.title, record.short_id) : row.subject_kind === "company" ? crmCompanyPath(record.title, record.short_id) : crmDealPath(record.title, record.short_id);
      return [{ title: `Follow up: ${record.title}`, href }];
    });
    return { rows: out, total: out.length };
  }
};

export { bookCurrency };
