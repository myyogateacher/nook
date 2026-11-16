import { auditVia, db, now } from "../db";
import { readableBoard, readableCard } from "./access";
import { boardStructure } from "./hierarchy";
import { reportCardChange } from "./cardEvents";
import { estimateBadge, type EstimateKind } from "../../shared/estimates";
import {
  ACTIVITY_COALESCE_MS,
  ACTIVITY_LABEL_MAX,
  CARD_ACTIVITY_KINDS,
  isCardActivityKind,
  sameActivityValue,
  type ActivityValue,
  type ActivityVia,
  type CardActivityEntry,
  type CardActivityKind,
  type CardActivityPayload
} from "../../shared/cardActivity";

/**
 * Card activity history (lane ACTIVITY, D740–D746; migration 081). The kinds, payload shapes, and the
 * steps to add a kind are in shared/cardActivity.ts.
 *
 * Recording: the service that changes a card calls `recordCardActivity` (or the `recordCardChange` /
 * `recordCardItems` shorthands) inside the same transaction as the change, so a refused or failed
 * change records nothing (D742). Routes, MCP tools, the REST API, and agents all reach the same service
 * functions, so every surface is recorded; `via` is read from the audit context they already set.
 *
 * Coalescing (D743): a kind marked `coalesce` folds into the card's latest entry when that entry is the
 * same kind, by the same person through the same surface, less than two minutes old. The entry keeps
 * its first `from`, takes the new `to` and time, and is dropped when the two meet again (a card dragged
 * To do → Doing → To do leaves nothing).
 *
 * Reading: anyone who can read the card (the caller checks), newest or oldest first, by keyset pages on
 * `(created_at, id)`. A related card the reader cannot open is shown without its title (T90).
 */

const PRIORITY_WORDS: Record<string, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };
const VIAS: readonly ActivityVia[] =["mcp", "rest", "agent", "proposal", "system"];
const clip = (value: string) => value.length > ACTIVITY_LABEL_MAX ? `${value.slice(0, ACTIVITY_LABEL_MAX - 1)}…` : value;

export type RecordActivityInput = {
  cardId: string;
  boardId: string;
  /** null for Nook itself (with `via: "system"`). */
  actorId: string | null;
  kind: CardActivityKind;
  payload?: CardActivityPayload;
  /** Defaults to the audit context's surface (mcp, rest, agent, proposal), else null (the web app). */
  via?: ActivityVia | null;
  at?: string;
};

type StoredRow = { id: string; actor_id: string | null; via: string | null; kind: string; payload: string; created_at: string };

function currentVia(): ActivityVia | null {
  const via = auditVia();
  return via && (VIAS as readonly string[]).includes(via) ? via as ActivityVia : null;
}

function cleanValue(value: ActivityValue | null | undefined): ActivityValue | null {
  if (!value) return null;
  return { ...(value.id !== undefined ? { id: value.id } : {}), label: clip(value.label), ...(value.detail ? { detail: clip(value.detail) } : {}) };
}

function cleanPayload(payload: CardActivityPayload): CardActivityPayload {
  return {
    ...(payload.from !== undefined ? { from: cleanValue(payload.from) } : {}),
    ...(payload.to !== undefined ? { to: cleanValue(payload.to) } : {}),
    ...(payload.item ? { item: cleanValue(payload.item)! } : {}),
    ...(payload.count !== undefined ? { count: payload.count } : {})
  };
}

/** Records one entry, or folds it into the card's latest one (see above). Call inside the change's transaction. */
export function recordCardActivity(input: RecordActivityInput) {
  const at = input.at ?? now();
  const via = input.via === undefined ? currentVia() : input.via;
  const payload = cleanPayload(input.payload ?? {});
  const spec = CARD_ACTIVITY_KINDS[input.kind];
  if (spec.coalesce && input.actorId) {
    const latest = db.query("SELECT id, actor_id, via, kind, payload, created_at FROM card_activity WHERE card_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(input.cardId) as StoredRow | null;
    if (latest && latest.kind === input.kind && latest.actor_id === input.actorId && latest.via === via
      && Date.parse(at) - Date.parse(latest.created_at) < ACTIVITY_COALESCE_MS) {
      const previous = JSON.parse(latest.payload) as CardActivityPayload;
      const merged: CardActivityPayload = spec.shape === "change" ? { ...payload, from: previous.from ?? null } : payload;
      if (spec.shape === "change" && sameActivityValue(merged.from, merged.to)) {
        db.query("DELETE FROM card_activity WHERE id = ?").run(latest.id);
        // A change that undid itself: the earlier entry was reported when it was written.
        return latest.id;
      }
      // The folded entry takes a fresh id (D1059c), so the change reports a token only this
      // transaction can create: a rolled-back fold leaves no row with it, and listeners hear nothing.
      const folded = Bun.randomUUIDv7();
      db.query(`INSERT INTO card_activity (id, card_id, board_id, actor_id, actor_label, via, kind, payload, created_at)
        SELECT ?, card_id, board_id, actor_id, actor_label, via, kind, ?, ? FROM card_activity WHERE id = ?`).run(folded, JSON.stringify(merged), at, latest.id);
      db.query("DELETE FROM card_activity WHERE id = ?").run(latest.id);
      reportCardChange({ activityId: folded, cardId: input.cardId, boardId: input.boardId, actorId: input.actorId, kind: input.kind, at });
      return folded;
    }
  }
  const label = input.actorId
    ? (db.query("SELECT display_name FROM users WHERE id = ?").get(input.actorId) as { display_name: string } | null)?.display_name ?? ""
    : "";
  // Time-ordered ids keep the entries of one transaction (same millisecond) in the order they were written.
  const id = Bun.randomUUIDv7();
  db.query("INSERT INTO card_activity (id, card_id, board_id, actor_id, actor_label, via, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.cardId, input.boardId, input.actorId, clip(label), via, input.kind, JSON.stringify(payload), at);
  // Other modules hear about it after the transaction (D1040); Tasks' own behaviour is unchanged.
  reportCardChange({ activityId: id, cardId: input.cardId, boardId: input.boardId, actorId: input.actorId, kind: input.kind, at });
  return id;
}

/** A `change` entry, unless `from` and `to` name the same thing. */
export function recordCardChange(cardId: string, boardId: string, actorId: string | null, kind: CardActivityKind, from: ActivityValue | null, to: ActivityValue | null, at?: string) {
  if (sameActivityValue(from, to)) return null;
  return recordCardActivity({ cardId, boardId, actorId, kind, payload: { from, to }, at });
}

/** One `item` entry per id added and per id removed (`replaceAssignees`, `replaceCardTags`, `replaceCardFlags` return these). */
export function recordCardItems(cardId: string, boardId: string, actorId: string | null, kinds: { added: CardActivityKind; removed: CardActivityKind },
  change: { added: readonly string[]; removed: readonly string[] }, value: (id: string) => ActivityValue, at?: string) {
  for (const id of change.removed) recordCardActivity({ cardId, boardId, actorId, kind: kinds.removed, payload: { item: value(id) }, at });
  for (const id of change.added) recordCardActivity({ cardId, boardId, actorId, kind: kinds.added, payload: { item: value(id) }, at });
}

/** A file's owner withdrew it from a card through DELETE /api/attachments/card/… (server/attachments/service.ts). */
export function recordCardFileWithdrawn(userId: string, cardId: string, documentId: string) {
  const boardId = (db.query("SELECT board_id FROM cards WHERE id = ?").get(cardId) as { board_id: string } | null)?.board_id;
  if (boardId) recordCardActivity({ cardId, boardId, actorId: userId, kind: "attachment_removed", payload: { item: activityValue.document(documentId) } });
}

// ---------------------------------------------------------------------------
// Display snapshots: the id and what it was called when the event happened.

const named = (sql: string, id: string | null | undefined, fallback: string): ActivityValue | null => {
  if (!id) return null;
  const row = db.query(sql).get(id) as { label: string } | null;
  return { id, label: row?.label ?? fallback };
};

export const activityValue = {
  user: (id: string) => named("SELECT display_name AS label FROM users WHERE id = ?", id, "Former member")!,
  tag: (id: string) => named("SELECT name AS label FROM board_tags WHERE id = ?", id, "Deleted tag")!,
  flag: (flag: string): ActivityValue => ({ id: flag, label: flag }),
  /** A priority (D1314): `id` urgent, high, medium, or low, `label` its word; null without one. */
  priority: (priority: string | null): ActivityValue | null => priority ? { id: priority, label: PRIORITY_WORDS[priority] ?? priority } : null,
  column: (id: string | null | undefined) => named("SELECT name AS label FROM board_columns WHERE id = ?", id, "Deleted column"),
  sprint: (id: string | null | undefined) => named("SELECT name AS label FROM board_sprints WHERE id = ?", id, "Deleted sprint"),
  card: (id: string | null | undefined) => named("SELECT title AS label FROM cards WHERE id = ?", id, "Deleted card"),
  document: (id: string) => named("SELECT name AS label FROM documents WHERE id = ?", id, "Deleted file")!,
  level: (boardId: string, level: number): ActivityValue => ({ id: String(level), label: boardStructure(boardId).levels[level]?.name ?? `Level ${level + 1}` }),
  /** `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` with the zone as `detail`; null when there is no due date. */
  due: (due: { due_on: string | null; due_time: string | null; due_tz: string | null }): ActivityValue | null => {
    if (!due.due_on) return null;
    const id = due.due_time ? `${due.due_on}T${due.due_time}` : due.due_on;
    return { id, label: due.due_time ? `${due.due_on} ${due.due_time}` : due.due_on, ...(due.due_time && due.due_tz ? { detail: due.due_tz } : {}) };
  },
  /** The start date (D720), as `due` words it. */
  start: (start: { start_on: string | null; start_time: string | null; start_tz: string | null }) =>
    activityValue.due({ due_on: start.start_on, due_time: start.start_time, due_tz: start.start_tz }),
  /** An estimate (D750) with the board's unit then ("5 pts", "3h"); null when there is none. */
  estimate: (kind: EstimateKind, value: number | null): ActivityValue | null =>
    value === null ? null : { id: String(value), label: estimateBadge(kind, value) || String(value), detail: kind },
  /** A board (D716) with the card's key on it, as "My tasks" and "MYT-2". */
  board: (boardId: string, key: string | null): ActivityValue => ({
    ...named("SELECT name AS label FROM boards WHERE id = ?", boardId, "Deleted board")!, ...(key ? { detail: key } : {})
  })
};

/** The fields of a card the history compares before and after a change. */
export function cardActivitySnapshot(cardId: string) {
  return db.query(`SELECT k.board_id, k.column_id, k.title, k.due_on, k.due_time, k.due_tz, k.start_on, k.start_time, k.start_tz,
      k.parent_card_id, k.level, k.sprint_id, k.estimate, b.estimate_kind, k.priority
    FROM cards k JOIN boards b ON b.id = k.board_id WHERE k.id = ?`).get(cardId) as {
    board_id: string; column_id: string | null; title: string; due_on: string | null; due_time: string | null; due_tz: string | null;
    start_on: string | null; start_time: string | null; start_tz: string | null;
    parent_card_id: string | null; level: number; sprint_id: string | null; estimate: number | null; estimate_kind: EstimateKind; priority: string | null;
  } | null;
}

/** Records every scalar field that differs between two snapshots of a card (one patch, one transaction). */
export function recordSnapshotChanges(cardId: string, actorId: string, before: NonNullable<ReturnType<typeof cardActivitySnapshot>>, after: NonNullable<ReturnType<typeof cardActivitySnapshot>>, at?: string) {
  const boardId = after.board_id;
  if (before.title !== after.title) recordCardChange(cardId, boardId, actorId, "title", { label: before.title }, { label: after.title }, at);
  if (before.column_id !== after.column_id) recordCardChange(cardId, boardId, actorId, "column", activityValue.column(before.column_id), activityValue.column(after.column_id), at);
  recordCardChange(cardId, boardId, actorId, "due", activityValue.due(before), activityValue.due(after), at);
  recordCardChange(cardId, boardId, actorId, "start", activityValue.start(before), activityValue.start(after), at);
  if (before.estimate !== after.estimate) {
    recordCardChange(cardId, boardId, actorId, "estimate", activityValue.estimate(before.estimate_kind, before.estimate), activityValue.estimate(after.estimate_kind, after.estimate), at);
  }
  if (before.priority !== after.priority) recordCardChange(cardId, boardId, actorId, "priority", activityValue.priority(before.priority), activityValue.priority(after.priority), at);
  if (before.level !== after.level) recordCardChange(cardId, boardId, actorId, "level", activityValue.level(boardId, before.level), activityValue.level(boardId, after.level), at);
  if (before.parent_card_id !== after.parent_card_id) recordCardChange(cardId, boardId, actorId, "parent", activityValue.card(before.parent_card_id), activityValue.card(after.parent_card_id), at);
  if (before.sprint_id !== after.sprint_id) recordCardChange(cardId, boardId, actorId, "sprint", activityValue.sprint(before.sprint_id), activityValue.sprint(after.sprint_id), at);
}

// ---------------------------------------------------------------------------
// Reading

export type ActivityOrder = "asc" | "desc";
type ActivityCursor = { at: string; id: string };

export function encodeActivityCursor(cursor: ActivityCursor) {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), "utf8").toString("base64url");
}

export function decodeActivityCursor(value: string): ActivityCursor | null {
  if (value.length > 200) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return null;
    if (Number.isNaN(Date.parse(parsed[0])) || !/^[0-9a-f-]{36}$/i.test(parsed[1])) return null;
    return { at: parsed[0], id: parsed[1].toLowerCase() };
  } catch {
    return null;
  }
}

type ListedRow = StoredRow & { card_id: string; actor_label: string; current_name: string | null; actor_kind: string | null };

/**
 * One page of a card's history. The caller has checked that `userId` can read the card. `mayRead`
 * narrows which related cards show their title (an MCP key limited to chosen boards, T203).
 */
export function listCardActivity(userId: string, cardId: string, options: {
  order?: ActivityOrder; limit: number; cursor?: ActivityCursor | null; mayRead?: (cardId: string) => boolean; mayReadBoard?: (boardId: string) => boolean;
}) {
  const order = options.order ?? "desc";
  const keyset = options.cursor
    ? order === "desc" ? "AND (a.created_at < $at OR (a.created_at = $at AND a.id < $id))" : "AND (a.created_at > $at OR (a.created_at = $at AND a.id > $id))"
    : "";
  const direction = order === "desc" ? "DESC" : "ASC";
  const rows = db.query(`SELECT a.id, a.card_id, a.actor_id, a.actor_label, a.via, a.kind, a.payload, a.created_at, u.display_name AS current_name, u.kind AS actor_kind
    FROM card_activity a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.card_id = $cardId ${keyset}
    ORDER BY a.created_at ${direction}, a.id ${direction} LIMIT $limit`)
    .all({ cardId, limit: options.limit + 1, ...(options.cursor ? { at: options.cursor.at, id: options.cursor.id } : {}) }) as ListedRow[];
  const page = rows.slice(0, options.limit);
  const readable = new Map<string, boolean>();
  const canOpen = (otherId: string) => {
    if (!readable.has(otherId)) readable.set(otherId, readableCard(otherId, userId) !== null && (options.mayRead?.(otherId) ?? true));
    return readable.get(otherId)!;
  };
  const boardReadable = new Map<string, boolean>();
  const canOpenBoard = (boardId: string) => {
    if (!boardReadable.has(boardId)) boardReadable.set(boardId, readableBoard(boardId, userId) !== null && (options.mayReadBoard?.(boardId) ?? true));
    return boardReadable.get(boardId)!;
  };
  // A board the card moved from (or to) that the reader cannot open shows neither its name nor the key there.
  const boardSide = (value: ActivityValue | null | undefined) => value?.id && !canOpenBoard(value.id) ? { label: "a board you can't open" } : value ?? null;
  const activity: CardActivityEntry[] = page.filter((row) => isCardActivityKind(row.kind)).map((row) => {
    let payload = JSON.parse(row.payload) as CardActivityPayload;
    // A related card the reader cannot open shows only that it exists (T90).
    if ((row.kind === "relation_added" || row.kind === "relation_removed") && payload.item?.id && !canOpen(payload.item.id)) {
      payload = { ...payload, item: { label: "a card you can't open", ...(payload.item.detail ? { detail: payload.item.detail } : {}) } };
    }
    if (row.kind === "board_move") payload = { ...payload, from: boardSide(payload.from), to: boardSide(payload.to) };
    return {
      id: row.id,
      card_id: row.card_id,
      kind: row.kind as CardActivityKind,
      actor_id: row.actor_id,
      actor_name: row.current_name ?? (row.actor_label || (row.via === "system" ? "" : "Former member")),
      ...(row.actor_kind === "service" ? { actor_is_integration: 1 as const } : {}),
      via: row.via as ActivityVia | null,
      payload,
      created_at: row.created_at
    };
  });
  const last = page[page.length - 1];
  return { activity, next: rows.length > options.limit && last ? encodeActivityCursor({ at: last.created_at, id: last.id }) : null };
}
