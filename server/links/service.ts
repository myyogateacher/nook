import { audit, auditVia, db, now } from "../db";
import { config } from "../config";
import { LEVEL_RANK } from "../access/levels";
import { recordCardActivity } from "../tasks/activity";
import { recordItemActivity } from "../activity/service";
import { canWriteContent } from "../team/userRole";
import { workKindAdapter, type Viewer } from "./adapters";
import { resolveRefs } from "./resolve";
import { isLinkRelation, isWorkKind, parseWorkRef, WORK_KIND_LABELS, workRefKey, type HiddenWorkSummary, type LinkRelation, type WorkKind, type WorkLinkView, type WorkRef, type WorkSummary } from "../../shared/workRefs";

export { registerWorkKind, workKindAdapter, type WorkKindAdapter, type Viewer } from "./adapters";
export { resolveRefs } from "./resolve";
export { parseWorkRef, type WorkRef, type WorkSummary } from "../../shared/workRefs";

/**
 * Work links (docs/plan/WORKSPACE_MODULES.md §B.4, D804, T501, T90): relations between items of any
 * kinds, in `work_links`; the existing link tables stay authoritative for what they cover and are read
 * too, so an item's Linked panel lists everything.
 *
 * - Creating a link needs edit on side A and read on side B; removing needs edit on either side.
 * - A side the viewer cannot read is `{ kind, hidden: true }` ("An item you can't open"): its title,
 *   href, and id never reach them (T501). Missing, unreadable, and unknown are the same NOT_FOUND.
 * - Every change records activity on both sides (cards: their own history, `goal_linked` for goals
 *   and `relation_added` otherwise; other kinds: `linked` / `unlinked`), with the neutral kind word as
 *   the label and the other side's kind, never its title (readers of one side may not read the other).
 *   The history resolves the title per reader when it is listed (server/links/resolve.ts, D1390).
 */

export class LinkError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string) {
    super(message);
  }
}

const notFound = () => new LinkError(404, "NOT_FOUND", "Not found");

/** Resolves a text reference (key, URL, `kind:id`) to a ref the viewer can read, with its summary; null otherwise. */
export function resolveRef(text: string, viewer: Viewer): { ref: WorkRef; summary: WorkSummary } | null {
  const parsed = parseWorkRef(text, [...config.appOrigins]);
  if (!parsed) return null;
  const adapter = workKindAdapter(parsed.kind);
  if (!adapter) return null;
  const id = parsed.by === "id" ? parsed.ref : adapter.lookup?.(parsed) ?? null;
  if (!id) return null;
  const summary = adapter.resolve([id], viewer).get(id) ?? null;
  return summary ? { ref: { kind: parsed.kind, id }, summary } : null;
}

const levelOf = (ref: WorkRef, viewer: Viewer) => workKindAdapter(ref.kind)?.level(ref.id, viewer) ?? "none";

/** Validates and normalizes a ref given as `{ kind, id }` or `{ ref: text }`. */
export function refFrom(input: { kind?: unknown; id?: unknown; ref?: unknown }, viewer: Viewer): WorkRef {
  if (typeof input.ref === "string") {
    const resolved = resolveRef(input.ref, viewer);
    if (!resolved) throw notFound();
    return resolved.ref;
  }
  const adapter = typeof input.kind === "string" ? workKindAdapter(input.kind) : null;
  if (!adapter || typeof input.id !== "string" || input.id.length > 64) throw notFound();
  const id = /^[0-9a-f-]{36}$/i.test(input.id) ? input.id.toLowerCase() : adapter.lookup?.(parseWorkRef(`${adapter.kind}:${input.id}`) ?? { kind: adapter.kind, ref: input.id, by: "id" }) ?? null;
  if (!id) throw notFound();
  return { kind: adapter.kind, id };
}

type Via = "web" | "mcp" | "rest" | "agent" | "proposal" | "system" | "public";
const viaNow = (): Via => {
  const via = auditVia();
  return via === "mcp" || via === "rest" || via === "agent" || via === "proposal" ? via : "web";
};

function recordLinkActivity(side: WorkRef, other: WorkRef, relation: LinkRelation, actorId: string, added: boolean) {
  const label = WORK_KIND_LABELS[other.kind];
  if (side.kind === "card") {
    const boardId = (db.query("SELECT board_id FROM cards WHERE id = ?").get(side.id) as { board_id: string } | null)?.board_id;
    if (!boardId) return;
    const kind = other.kind === "goal" ? (added ? "goal_linked" : "goal_unlinked") : added ? "relation_added" : "relation_removed";
    recordCardActivity({ cardId: side.id, boardId, actorId, kind, payload: { item: { id: other.id, label, kind: other.kind } } });
    return;
  }
  // The older modules' items keep their own histories (or none); every workspace kind records item activity.
  if (!workKindAdapter(side.kind) || BUILTIN_KINDS.has(side.kind)) return;
  recordItemActivity({ itemKind: side.kind, itemId: side.id, actorId, kind: added ? "linked" : "unlinked", payload: { item: { id: other.id, label, kind: other.kind }, extra: { relation } } });
}

const BUILTIN_KINDS: ReadonlySet<string> = new Set(["board", "sprint", "note", "document", "whiteboard", "event", "calendar", "collection", "row", "report"]);

export type WorkLinkRow = { id: string; a_kind: WorkKind; a_id: string; b_kind: WorkKind; b_id: string; relation: LinkRelation; created_by: string | null; created_via: string; created_at: string };

/** Creates `a <relation> b` as `actorId` (edit on A, read on B). 409 EXISTS when it is there already. */
export function createLink(input: { a: WorkRef; b: WorkRef; relation: LinkRelation; actorId: string; via?: Via }): WorkLinkRow {
  if (!isLinkRelation(input.relation)) throw new LinkError(400, "INVALID", "Unknown relation");
  const viewer = { userId: input.actorId };
  const levelA = levelOf(input.a, viewer);
  const levelB = levelOf(input.b, viewer);
  if (levelA === "none" || levelB === "none") throw notFound();
  if (LEVEL_RANK[levelA] < LEVEL_RANK.edit || !canWriteContent(input.actorId)) throw new LinkError(403, "READ_ONLY", "You can read this but not change it");
  if (input.a.kind === input.b.kind && input.a.id === input.b.id) throw new LinkError(400, "INVALID", "An item cannot be linked to itself");
  return db.transaction(() => {
    const id = Bun.randomUUIDv7();
    const timestamp = now();
    const inserted = db.query(`INSERT OR IGNORE INTO work_links (id, a_kind, a_id, b_kind, b_id, relation, created_by, created_via, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.a.kind, input.a.id, input.b.kind, input.b.id, input.relation, input.actorId, input.via ?? viaNow(), timestamp).changes;
    if (inserted !== 1) throw new LinkError(409, "EXISTS", "These items are already linked that way");
    recordLinkActivity(input.a, input.b, input.relation, input.actorId, true);
    recordLinkActivity(input.b, input.a, input.relation, input.actorId, true);
    audit(input.actorId, null, "link.created", { linkId: id, aKind: input.a.kind, aId: input.a.id, bKind: input.b.kind, bId: input.b.id, relation: input.relation });
    return db.query("SELECT * FROM work_links WHERE id = ?").get(id) as WorkLinkRow;
  })();
}

/** Removes a link as `actorId` (edit on either side). A link the actor cannot see either side of is NOT_FOUND. */
export function deleteLink(linkId: string, actorId: string) {
  return db.transaction(() => {
    const row = db.query("SELECT * FROM work_links WHERE id = ?").get(linkId) as WorkLinkRow | null;
    if (!row) throw notFound();
    const viewer = { userId: actorId };
    const a = { kind: row.a_kind, id: row.a_id };
    const b = { kind: row.b_kind, id: row.b_id };
    const levelA = levelOf(a, viewer);
    const levelB = levelOf(b, viewer);
    if (levelA === "none" && levelB === "none") throw notFound();
    if ((LEVEL_RANK[levelA] < LEVEL_RANK.edit && LEVEL_RANK[levelB] < LEVEL_RANK.edit) || !canWriteContent(actorId)) throw new LinkError(403, "READ_ONLY", "You can read this but not change it");
    db.query("DELETE FROM work_links WHERE id = ?").run(row.id);
    recordLinkActivity(a, b, row.relation, actorId, false);
    recordLinkActivity(b, a, row.relation, actorId, false);
    audit(actorId, null, "link.deleted", { linkId: row.id, aKind: row.a_kind, aId: row.a_id, bKind: row.b_kind, bId: row.b_id, relation: row.relation });
    return true;
  })();
}

const hidden = (kind: WorkKind): HiddenWorkSummary => ({ kind, hidden: true });

/**
 * Every link of an item the viewer can read: `work_links` both ways, and the existing tables (card
 * relations and hierarchy, event links, attached files). The other side is a summary or hidden.
 * `keyFilter` (chosen-item keys, T203) drops links whose other side the key cannot reach.
 */
export function linksOf(ref: WorkRef, viewer: Viewer, options: { keyAllows?: (other: WorkRef) => boolean } = {}): WorkLinkView[] {
  if (levelOf(ref, viewer) === "none") throw notFound();
  type Raw = { id: string; relation: LinkRelation; direction: "out" | "in"; other: WorkRef; source: WorkLinkView["source"]; createdAt: string | null };
  const raws: Raw[] = [];
  for (const row of db.query("SELECT * FROM work_links WHERE a_kind = ? AND a_id = ? ORDER BY created_at LIMIT 500").all(ref.kind, ref.id) as WorkLinkRow[]) {
    raws.push({ id: row.id, relation: row.relation, direction: "out", other: { kind: row.b_kind, id: row.b_id }, source: "work_links", createdAt: row.created_at });
  }
  for (const row of db.query("SELECT * FROM work_links WHERE b_kind = ? AND b_id = ? ORDER BY created_at LIMIT 500").all(ref.kind, ref.id) as WorkLinkRow[]) {
    raws.push({ id: row.id, relation: row.relation, direction: "in", other: { kind: row.a_kind, id: row.a_id }, source: "work_links", createdAt: row.created_at });
  }
  if (ref.kind === "card") {
    for (const row of db.query("SELECT id, source_card_id, target_card_id, kind, created_at FROM card_relations WHERE source_card_id = ? OR target_card_id = ?").all(ref.id, ref.id) as Array<{ id: string; source_card_id: string; target_card_id: string; kind: string; created_at: string }>) {
      const out = row.source_card_id === ref.id;
      raws.push({ id: `card_relation:${row.id}`, relation: row.kind === "blocks" ? "blocks" : "relates", direction: out ? "out" : "in", other: { kind: "card", id: out ? row.target_card_id : row.source_card_id }, source: "card_relations", createdAt: row.created_at });
    }
    const parent = db.query("SELECT parent_card_id FROM cards WHERE id = ?").get(ref.id) as { parent_card_id: string | null } | null;
    if (parent?.parent_card_id) raws.push({ id: `parent:${ref.id}`, relation: "relates", direction: "out", other: { kind: "card", id: parent.parent_card_id }, source: "card_hierarchy", createdAt: null });
    for (const row of db.query("SELECT id FROM cards WHERE parent_card_id = ? AND deleted_at IS NULL LIMIT 200").all(ref.id) as Array<{ id: string }>) {
      raws.push({ id: `parent:${row.id}`, relation: "relates", direction: "in", other: { kind: "card", id: row.id }, source: "card_hierarchy", createdAt: null });
    }
  }
  const eventTarget: Partial<Record<WorkKind, string>> = { card: "card", note: "note", row: "collection_row" };
  if (ref.kind === "event") {
    for (const row of db.query("SELECT target_type, target_id, created_at FROM event_links WHERE event_id = ?").all(ref.id) as Array<{ target_type: string; target_id: string; created_at: string }>) {
      const kind: WorkKind = row.target_type === "collection_row" ? "row" : row.target_type as WorkKind;
      raws.push({ id: `event_link:${ref.id}:${row.target_type}:${row.target_id}`, relation: "relates", direction: "out", other: { kind, id: row.target_id }, source: "event_links", createdAt: row.created_at });
    }
  } else if (eventTarget[ref.kind]) {
    for (const row of db.query("SELECT event_id, created_at FROM event_links WHERE target_type = ? AND target_id = ?").all(eventTarget[ref.kind]!, ref.id) as Array<{ event_id: string; created_at: string }>) {
      raws.push({ id: `event_link:${row.event_id}:${eventTarget[ref.kind]}:${ref.id}`, relation: "relates", direction: "in", other: { kind: "event", id: row.event_id }, source: "event_links", createdAt: row.created_at });
    }
  }
  const hostKinds: Partial<Record<WorkKind, string>> = { card: "card", note: "note", event: "event", row: "collection_row", whiteboard: "whiteboard" };
  if (hostKinds[ref.kind]) {
    for (const row of db.query("SELECT document_id, created_at FROM attachment_links WHERE host_kind = ? AND host_id = ? LIMIT 200").all(hostKinds[ref.kind]!, ref.id) as Array<{ document_id: string; created_at: string }>) {
      raws.push({ id: `attachment:${hostKinds[ref.kind]}:${ref.id}:${row.document_id}`, relation: "relates", direction: "out", other: { kind: "document", id: row.document_id }, source: "attachment_links", createdAt: row.created_at });
    }
  }
  const visible = options.keyAllows ? raws.filter((raw) => options.keyAllows!(raw.other)) : raws;
  const summaries = resolveRefs(visible.map((raw) => raw.other), viewer);
  return visible.map((raw) => ({ id: raw.id, relation: raw.relation, direction: raw.direction, other: summaries.get(workRefKey(raw.other)) ?? hidden(raw.other.kind), source: raw.source, createdAt: raw.createdAt }));
}

/**
 * Replaces the `mentions` links an item's text makes (§B.4.4): refs found in `text` the author can
 * read become `a mentions b` links (system-created), and mentions no longer in the text go. Call on
 * publish or save, inside its transaction.
 */
export function syncMentions(source: WorkRef, text: string, authorId: string) {
  const found = new Map<string, WorkRef>();
  const candidates = text.match(/(?:https?:\/\/[^\s)>\]]+|\/(?:tasks|notes|files|whiteboards|collections|reports|forms|goals|standups|contacts|bookings|time|townhall)\/[^\s)>\]]+|\b[A-Za-z][A-Za-z0-9]{1,9}-[1-9][0-9]{0,8}\b|\b[a-z_]{2,20}:[0-9a-z-]{10,36}\b)/g) ?? [];
  for (const candidate of candidates.slice(0, 200)) {
    const resolved = resolveRef(candidate, { userId: authorId });
    if (resolved && !(resolved.ref.kind === source.kind && resolved.ref.id === source.id)) found.set(workRefKey(resolved.ref), resolved.ref);
  }
  const existing = db.query("SELECT id, b_kind, b_id FROM work_links WHERE a_kind = ? AND a_id = ? AND relation = 'mentions'").all(source.kind, source.id) as Array<{ id: string; b_kind: WorkKind; b_id: string }>;
  for (const row of existing) if (!found.delete(workRefKey({ kind: row.b_kind, id: row.b_id }))) db.query("DELETE FROM work_links WHERE id = ?").run(row.id);
  const timestamp = now();
  for (const ref of found.values()) {
    db.query("INSERT OR IGNORE INTO work_links (id, a_kind, a_id, b_kind, b_id, relation, created_by, created_via, created_at) VALUES (?, ?, ?, ?, ?, 'mentions', ?, 'system', ?)")
      .run(Bun.randomUUIDv7(), source.kind, source.id, ref.kind, ref.id, authorId, timestamp);
  }
}
