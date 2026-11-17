import { auditVia, db, now } from "../db";
import {
  ACTIVITY_COALESCE_MS, ACTIVITY_LABEL_MAX, ACTIVITY_PAGE_DEFAULT, ACTIVITY_PAGE_MAX, activityKindDef, sameActivityValue,
  type ActivityValue, type ItemActivityEntry, type ItemActivityPayload
} from "../../shared/itemActivity";
import type { WorkKind, WorkRef } from "../../shared/workRefs";
import type { Viewer } from "../links/adapters";
import { linkedActivityRef, linkedActivityResolver } from "../links/resolve";

export { registerActivityKinds } from "../../shared/itemActivity";

/**
 * Item activity for the workspace modules (docs/plan/WORKSPACE_MODULES.md §B.5, D805), the card
 * activity pattern (D740–D746) for any item kind: recorded inside the write's transaction (a refused
 * write records nothing), `via` from the audit context (MCP, REST, agent, proposal), coalesced when the
 * same person changes the same field within two minutes, read in keyset pages. Payloads hold ids and
 * snapshot labels only, never answer text or contact details (T505); the caller checks the reader may
 * read the item before listing.
 */

const VIAS = ["mcp", "rest", "agent", "proposal", "system", "public"] as const;
type Via = typeof VIAS[number];
const clip = (value: string) => value.length > ACTIVITY_LABEL_MAX ? `${value.slice(0, ACTIVITY_LABEL_MAX - 1)}…` : value;

function currentVia(): Via | null {
  const via = auditVia();
  return via && (VIAS as readonly string[]).includes(via) ? via as Via : null;
}

const cleanValue = (value: ActivityValue | null | undefined): ActivityValue | null => value
  ? { ...(value.id !== undefined ? { id: value.id } : {}), label: clip(value.label), ...(value.detail ? { detail: clip(value.detail) } : {}) }
  : null;

function cleanPayload(payload: ItemActivityPayload): ItemActivityPayload {
  const extra = payload.extra && JSON.stringify(payload.extra).length <= 2048 ? payload.extra : undefined;
  return {
    ...(payload.from !== undefined ? { from: cleanValue(payload.from) } : {}),
    ...(payload.to !== undefined ? { to: cleanValue(payload.to) } : {}),
    ...(payload.item ? { item: { ...cleanValue(payload.item)!, ...(payload.item.kind ? { kind: payload.item.kind } : {}) } } : {}),
    ...(payload.count !== undefined ? { count: payload.count } : {}),
    ...(extra ? { extra } : {})
  };
}

export type RecordItemActivityInput = {
  itemKind: WorkKind;
  itemId: string;
  /** The sharing container (a contact's book), for container-wide feeds. */
  container?: { kind: string; id: string } | null;
  actorId: string | null;
  kind: string;
  payload?: ItemActivityPayload;
  via?: Via | null;
  at?: string;
};

/** Records one entry, or folds it into the item's latest one (coalescing kinds). Call inside the change's transaction. */
export function recordItemActivity(input: RecordItemActivityInput): string | null {
  const def = activityKindDef(input.kind);
  if (!def) throw new Error(`Unregistered activity kind ${input.kind}`);
  const at = input.at ?? now();
  const via = input.via === undefined ? currentVia() : input.via;
  const payload = cleanPayload(input.payload ?? {});
  if (def.coalesce && input.actorId) {
    const latest = db.query("SELECT id, actor_id, via, kind, payload, created_at FROM item_activity WHERE item_kind = ? AND item_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(input.itemKind, input.itemId) as { id: string; actor_id: string | null; via: string | null; kind: string; payload: string; created_at: string } | null;
    if (latest && latest.kind === input.kind && latest.actor_id === input.actorId && latest.via === via && Date.parse(at) - Date.parse(latest.created_at) < ACTIVITY_COALESCE_MS) {
      const previous = JSON.parse(latest.payload) as ItemActivityPayload;
      const merged: ItemActivityPayload = def.shape === "change" ? { ...payload, from: previous.from ?? null } : payload;
      if (def.shape === "change" && sameActivityValue(merged.from, merged.to)) db.query("DELETE FROM item_activity WHERE id = ?").run(latest.id);
      else db.query("UPDATE item_activity SET payload = ?, created_at = ? WHERE id = ?").run(JSON.stringify(merged), at, latest.id);
      return latest.id;
    }
  }
  const label = input.actorId ? (db.query("SELECT display_name FROM users WHERE id = ?").get(input.actorId) as { display_name: string } | null)?.display_name ?? "" : "";
  const id = Bun.randomUUIDv7();
  db.query(`INSERT INTO item_activity (id, item_kind, item_id, container_kind, container_id, actor_id, actor_label, via, kind, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.itemKind, input.itemId, input.container?.kind ?? null, input.container?.id ?? null, input.actorId, clip(label).slice(0, 120), via, input.kind, JSON.stringify(payload), at);
  return id;
}

/** A `change` entry, unless `from` and `to` name the same thing. */
export function recordItemChange(input: Omit<RecordItemActivityInput, "payload"> & { from: ActivityValue | null; to: ActivityValue | null }) {
  if (sameActivityValue(input.from, input.to)) return null;
  const { from, to, ...rest } = input;
  return recordItemActivity({ ...rest, payload: { from, to } });
}

type Cursor = { at: string; id: string };
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify([cursor.at, cursor.id])).toString("base64url");
function decode(value: string | null | undefined): Cursor | null {
  if (!value || value.length > 200) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    return Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string" ? { at: parsed[0], id: parsed[1] } : null;
  } catch {
    return null;
  }
}

/** One page of an item's history. The caller has checked the reader may read the item. */
export function listItemActivity(itemKind: string, itemId: string, options: {
  /** Who reads: a linked item's title shows only to a viewer who can read it (D1390). */
  viewer: Viewer; order?: "asc" | "desc"; cursor?: string | null; limit?: number;
  /** Narrows which linked items show their title, for keys over chosen items (T203). */
  mayReadRef?: (ref: WorkRef) => boolean;
}): { entries: ItemActivityEntry[]; nextCursor: string | null } {
  const order = options.order === "asc" ? "asc" : "desc";
  const limit = Math.min(Math.max(1, options.limit ?? ACTIVITY_PAGE_DEFAULT), ACTIVITY_PAGE_MAX);
  const cursor = decode(options.cursor);
  const comparison = order === "desc" ? "<" : ">";
  const rows = db.query(`SELECT a.id, a.item_kind, a.item_id, a.kind, a.actor_id, CASE WHEN a.actor_id IS NULL AND a.actor_label = '' THEN 'Nook' ELSE COALESCE(u.display_name, NULLIF(a.actor_label, ''), 'Former member') END AS actor_name,
      CASE WHEN u.kind = 'service' THEN 1 ELSE 0 END AS integration, a.via, a.payload, a.created_at
    FROM item_activity a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.item_kind = $kind AND a.item_id = $id ${cursor ? `AND (a.created_at, a.id) ${comparison} ($at, $cursorId)` : ""}
    ORDER BY a.created_at ${order}, a.id ${order} LIMIT $limit`)
    .all({ kind: itemKind, id: itemId, limit: limit + 1, ...(cursor ? { at: cursor.at, cursorId: cursor.id } : {}) }) as Array<{
      id: string; item_kind: WorkKind; item_id: string; kind: string; actor_id: string | null; actor_name: string; integration: number; via: Via | null; payload: string; created_at: string;
    }>;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const parsed = page.map((row) => {
    const payload = JSON.parse(row.payload) as ItemActivityPayload;
    return { row, payload, linked: row.kind === "linked" || row.kind === "unlinked" ? linkedActivityRef(payload.item) : null };
  });
  // The other side of a link: its title for a viewer who can read it, else the kind word (D1390, T706).
  const resolveLinked = linkedActivityResolver(parsed.flatMap((entry) => entry.linked ? [entry.linked] : []), options.viewer, options.mayReadRef);
  return {
    entries: parsed.map(({ row, payload, linked }) => ({
      id: row.id, itemKind: row.item_kind, itemId: row.item_id, kind: row.kind, actorId: row.actor_id, actorName: row.actor_name,
      ...(row.integration ? { actorIsIntegration: true } : {}), via: row.via,
      payload: linked && payload.item ? { ...payload, item: resolveLinked(linked, payload.item) } : payload, createdAt: row.created_at
    })),
    nextCursor: rows.length > limit && last ? encode({ at: last.created_at, id: last.id }) : null
  };
}
