import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "../db";
import { dateInZone } from "../today/registry";
import { addQueryDays, dueWindow, parse, format, SPRINT_VALUES, type FilterTerm, type TaskQuery } from "../../shared/taskQuery";
import { EFFECTIVE_SPRINT_SQL } from "./sprintData";
import { boardLevel, readableBoard, readableBoardPredicate } from "./access";
import type { ItemLevel } from "../access/levels";
import { assigneesForCards, type CardAssignee } from "./assignees";
import { dueAt } from "./dueTime";
import { TaskError } from "./service";
import { AUDIENCE_ALL_USERS, audienceAllUsersFor, can } from "../team/roles";
import { userRole } from "../team/userRole";
import { groupGrantExists } from "../access/groups";

/**
 * The cross-board card query (research 2026-09-26 §10.3–§10.4, D140, D144,
 * T115–T117). `compileTaskQuery` turns a parsed `shared/taskQuery.ts` query
 * into a WHERE fragment; `queryCards` runs it with keyset pagination.
 *
 * - Every value is a named parameter (`$f0`, `$f1`, …). The only SQL text that
 *   varies is picked from fixed fragments here, per key and value kind.
 * - The fragment is always ANDed with live cards on live boards the **caller**
 *   can read (`readableBoardPredicate`). A saved view runs through here as
 *   the viewer, so sharing a view never widens access (T115).
 * - Ids the caller cannot read simply match nothing; no error tells them apart
 *   from ids that do not exist (T116).
 * - Relation filters (`has:`) follow the per-viewer relation rules of WAVE_13
 *   D105, exactly as `relationCountsForBoard` (server/tasks/cardRelations.ts)
 *   counts them: `has:relation` is `relation_count > 0` (a relation to a card
 *   outside the caller's audience counts, shown as restricted; one to a card
 *   in their audience that is binned, or on a binned board, does not), and
 *   `has:blocked` is `open_blockers > 0` (live `depends_on` cards in the
 *   audience, outside a done column). A parity test checks both.
 */

export type Binding = string | number;
export type CompiledFilter = { where: string; params: Record<string, Binding> };
export type CompileContext = { userId: string; today: string; nowTime: string };

/** The normalized column state (migration 020, D141), kept equal to `is_done` by the service. */
export const COLUMN_STATE = "col.state";

/** `readableBoardPredicate` for another card's board (alias `ob`), derived so the two never drift apart. */
export const readableOtherBoardPredicate = readableBoardPredicate.replace(/\bb\./g, "ob.");

/** Whether the caller is in the audience of another card's board `ob`, binned or not (D105: binning is never disclosed). */
export const otherBoardAudience = `(ob.owner_id = $userId OR (ob.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS})
  OR (ob.visibility = 'selected' AND (EXISTS (SELECT 1 FROM board_members om WHERE om.board_id = ob.id AND om.user_id = $userId)
    OR ${groupGrantExists("board", "ob.id")})))`;

/** A relation from card `k` to another card `o` is visible unless the caller is in `o`'s audience and `o` or its board is binned. */
const visibleOther = `(NOT ${otherBoardAudience} OR (o.deleted_at IS NULL AND ob.deleted_at IS NULL))`;
const hasRelation = `(EXISTS (SELECT 1 FROM card_relations r JOIN cards o ON o.id = r.target_card_id JOIN boards ob ON ob.id = o.board_id
    WHERE r.source_card_id = k.id AND ${visibleOther})
  OR EXISTS (SELECT 1 FROM card_relations r JOIN cards o ON o.id = r.source_card_id JOIN boards ob ON ob.id = o.board_id
    WHERE r.target_card_id = k.id AND ${visibleOther}))`;
/** An open blocker: a readable, live `depends_on` card (stored as `o blocks k`) outside a done column. */
const hasOpenBlocker = `EXISTS (SELECT 1 FROM card_relations r JOIN cards o ON o.id = r.source_card_id JOIN boards ob ON ob.id = o.board_id
    JOIN board_columns oc ON oc.id = o.column_id
  WHERE r.target_card_id = k.id AND r.kind = 'blocks' AND o.deleted_at IS NULL AND oc.is_done = 0 AND ${readableOtherBoardPredicate})`;

/** A live direct child (17A); children are on the same board, so readability is the card's own. */
const hasSubtasks = "EXISTS (SELECT 1 FROM cards ch WHERE ch.parent_card_id = k.id AND ch.deleted_at IS NULL)";

class Compiler {
  readonly params: Record<string, Binding> = {};
  private next = 0;
  constructor(readonly context: CompileContext) {
    this.params.userId = context.userId;
  }
  bind(value: Binding) {
    const name = `f${this.next++}`;
    this.params[name] = value;
    return `$${name}`;
  }
  list(values: readonly Binding[]) {
    return values.map((value) => this.bind(value)).join(", ");
  }
  user(value: string) {
    return value === "me" ? this.context.userId : value;
  }
}

/** The SQL for one term's values, ORed. Values are canonical (validated by the parser). */
function termSql(term: FilterTerm, compiler: Compiler): string {
  const values = term.values;
  const parts: string[] = [];
  const ids = (keywords: readonly string[]) => values.filter((value) => !keywords.includes(value));
  switch (term.key) {
    case "board":
      parts.push(`k.board_id IN (${compiler.list(values)})`);
      break;
    case "column":
      parts.push(`k.column_id IN (${compiler.list(values)})`);
      break;
    case "state":
      parts.push(`${COLUMN_STATE} IN (${compiler.list(values)})`);
      break;
    case "creator":
      parts.push(`k.created_by IN (${compiler.list(values.map((value) => compiler.user(value)))})`);
      break;
    // Positive set filters are `k.id IN (…)` over the join table's (value, card_id) index, so a selective
    // filter (My work's assignee:me) drives the scan instead of being checked on every readable card.
    case "assignee": {
      const users = ids(["none"]).map((value) => compiler.user(value));
      if (users.length) parts.push(`k.id IN (SELECT ca.card_id FROM card_assignees ca WHERE ca.user_id IN (${compiler.list(users)}))`);
      if (values.includes("none")) parts.push("NOT EXISTS (SELECT 1 FROM card_assignees ca WHERE ca.card_id = k.id)");
      break;
    }
    case "tag": {
      const named = ids(["none"]);
      const tagIds = named.filter((value) => /^[0-9a-f-]{36}$/.test(value));
      const names = named.filter((value) => !tagIds.includes(value));
      const match: string[] = [];
      if (tagIds.length) match.push(`t.id IN (${compiler.list(tagIds)})`);
      if (names.length) match.push(`t.name COLLATE NOCASE IN (${compiler.list(names)})`);
      if (match.length) parts.push(`k.id IN (SELECT ct.card_id FROM card_tags ct JOIN board_tags t ON t.id = ct.tag_id WHERE ${match.join(" OR ")})`);
      if (values.includes("none")) parts.push("NOT EXISTS (SELECT 1 FROM card_tags ct WHERE ct.card_id = k.id)");
      break;
    }
    case "flag": {
      const flags = ids(["none"]);
      if (flags.length) parts.push(`k.id IN (SELECT fl.card_id FROM card_flags fl WHERE fl.flag IN (${compiler.list(flags)}))`);
      if (values.includes("none")) parts.push("NOT EXISTS (SELECT 1 FROM card_flags fl WHERE fl.card_id = k.id)");
      break;
    }
    case "due":
      for (const value of values) {
        const window = dueWindow(value, compiler.context.today);
        switch (window.kind) {
          case "none":
            parts.push("k.due_on IS NULL");
            break;
          case "overdue": {
            const today = compiler.bind(window.before);
            // A timed card due today is overdue once its wall time passed, compared in the caller's zone (approximate across zones, §5.1).
            parts.push(`(k.due_on < ${today} OR (k.due_on = ${today} AND k.due_time IS NOT NULL AND k.due_time < ${compiler.bind(compiler.context.nowTime)}))`);
            break;
          }
          case "range":
            parts.push(window.from === window.to ? `k.due_on = ${compiler.bind(window.from)}` : `k.due_on BETWEEN ${compiler.bind(window.from)} AND ${compiler.bind(window.to)}`);
            break;
          case "before":
            parts.push(`k.due_on < ${compiler.bind(window.date)}`);
            break;
          case "after":
            parts.push(`k.due_on > ${compiler.bind(window.date)}`);
            break;
        }
      }
      break;
    case "parent": {
      // Parents are on the card's own board (D133), so another board's card id simply matches nothing.
      const ids = values.filter((value) => value !== "none");
      if (ids.length) parts.push(`k.parent_card_id IN (${compiler.list(ids)})`);
      if (values.includes("none")) parts.push("k.parent_card_id IS NULL");
      break;
    }
    case "sprint": {
      // The effective sprint (17B, D124): stored on the work level, the parent's below it. `current`
      // and `next` resolve per card to its own board's active and first planned sprint.
      const ids = values.filter((value) => !(SPRINT_VALUES as readonly string[]).includes(value));
      if (ids.length) parts.push(`${EFFECTIVE_SPRINT_SQL} IN (${compiler.list(ids)})`);
      if (values.includes("none")) parts.push(`${EFFECTIVE_SPRINT_SQL} IS NULL`);
      if (values.includes("current")) parts.push(`${EFFECTIVE_SPRINT_SQL} = (SELECT cs.id FROM board_sprints cs WHERE cs.board_id = k.board_id AND cs.state = 'active')`);
      if (values.includes("next")) {
        parts.push(`${EFFECTIVE_SPRINT_SQL} = (SELECT ns.id FROM board_sprints ns WHERE ns.board_id = k.board_id AND ns.state = 'planned' ORDER BY ns.position, ns.id LIMIT 1)`);
      }
      break;
    }
    case "level": {
      const levels = values.filter((value) => value !== "work").map(Number);
      if (levels.length) parts.push(`k.level IN (${compiler.list(levels)})`);
      // `work` is each board's own work level (D122).
      if (values.includes("work")) parts.push("k.level = COALESCE(json_extract(b.structure_json, '$.workLevel'), 0)");
      break;
    }
    case "has":
      for (const value of values) parts.push(value === "blocked" ? hasOpenBlocker : value === "subtasks" ? hasSubtasks : hasRelation);
      break;
    case "text": {
      const text = compiler.bind(values[0]!);
      parts.push(`(instr(lower(k.title), lower(${text})) > 0 OR instr(lower(k.description_excerpt), lower(${text})) > 0)`);
      break;
    }
  }
  return parts.length === 1 ? parts[0]! : `(${parts.join(" OR ")})`;
}

/**
 * The WHERE fragment for a parsed query, over `cards k`, `boards b`, and
 * `board_columns col`. Negated terms are `NOT COALESCE(…, 0)`, so a card with
 * no due date matches `-due:overdue`. An empty query matches every card.
 */
export function compileTaskQuery(query: TaskQuery, context: CompileContext): CompiledFilter {
  const compiler = new Compiler(context);
  const clauses = query.terms.map((term) => {
    const sql = termSql(term, compiler);
    return term.negate ? `NOT COALESCE(${sql}, 0)` : sql;
  });
  return { where: clauses.length ? clauses.join(" AND ") : "1", params: compiler.params };
}

// ---------------------------------------------------------------------------
// Running a query.

export const QUERY_SORTS = ["due", "updated", "created", "title", "board"] as const;
export type QuerySort = typeof QUERY_SORTS[number];
/** Server-side groups: single-valued dimensions only, so a group is one contiguous run across pages. Multi-valued ones (assignee, tag) group on the client. */
export const QUERY_GROUPS = ["none", "board", "state", "due"] as const;
export type QueryGroup = typeof QUERY_GROUPS[number];
export const QUERY_PAGE = { default: 50, max: 100 } as const;
/** `total` is reported only up to this many matches. */
export const QUERY_TOTAL_CAP = 1000;

type KeyPart = { sql: string; desc: boolean };

const SORT_PARTS: Record<QuerySort, KeyPart[]> = {
  // Dates are 1900–2999 and times ≤ 23:59, so the sentinels put undated cards and date-only cards last.
  due: [{ sql: "COALESCE(k.due_on, '9999-12-31')", desc: false }, { sql: "COALESCE(k.due_time, '99:99')", desc: false }],
  updated: [{ sql: "k.updated_at", desc: true }],
  created: [{ sql: "k.created_at", desc: true }],
  title: [{ sql: "lower(k.title)", desc: false }],
  board: [{ sql: "lower(b.name)", desc: false }, { sql: "b.id", desc: false }, { sql: "col.position", desc: false }, { sql: "k.position", desc: false }]
};

const GROUP_PARTS: Record<QueryGroup, KeyPart[]> = {
  none: [],
  board: [{ sql: "lower(b.name)", desc: false }, { sql: "b.id", desc: false }],
  state: [{ sql: `CASE ${COLUMN_STATE} WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END`, desc: false }],
  // Buckets: overdue, today, this week, later, no date (the §10.2 due-bucket grouping).
  due: [{ sql: "CASE WHEN k.due_on IS NULL THEN 4 WHEN k.due_on < $today THEN 0 WHEN k.due_on = $today THEN 1 WHEN k.due_on <= $weekEnd THEN 2 ELSE 3 END", desc: false }]
};

export type QueriedCard = {
  id: string;
  board_id: string;
  board_name: string;
  column_id: string;
  column_name: string;
  column_state: "todo" | "doing" | "done";
  is_done: 0 | 1;
  position: number;
  title: string;
  description_excerpt: string;
  revision: number;
  created_by: string | null;
  creator_name: string | null;
  due_on: string | null;
  due_time: string | null;
  due_tz: string | null;
  due_at: string | null;
  assignees: CardAssignee[];
  tags: Array<{ id: string; name: string; color: string }>;
  flags: string[];
  created_at: string;
  updated_at: string;
  /** Hierarchy (17A): the parent on the same board and its title (null when it has none or it is binned, D138). */
  parent_card_id: string | null;
  level: number;
  parent_title: string | null;
  /** The card's sprint (17B): stored on the work level, the parent's below it; and its name. */
  sprint_id: string | null;
  sprint_name: string | null;
};

/** What a query's ids mean to this caller (T116): names only for what they can read. */
export type QueryRefs = {
  boards: Array<{ id: string; name: string } | { id: string; restricted: true }>;
  columns: Array<{ id: string; name: string; board_id: string } | { id: string; restricted: true }>;
  tags: Array<{ id: string; name: string; color: string; board_id: string } | { id: string; restricted: true }>;
  users: Array<{ id: string; display_name: string } | { id: string; unknown: true }>;
};

export type QueryInput = {
  q: string;
  sort?: QuerySort;
  group?: QueryGroup;
  cursor?: string;
  limit?: number;
  /** IANA zone for today, week, and overdue; validated by the caller. */
  tz: string;
  now?: Date;
};

export type QueryResult = { query: string; cards: QueriedCard[]; nextCursor: string | null; total?: number; refs?: QueryRefs };

const FLAG_ORDER = ["urgent", "blocked", "needs_review", "on_hold"];

/** The wall time `HH:MM` in `tz` at `now`. */
function timeInZone(now: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part("hour")}:${part("minute")}`;
}

export function filterError(error: { code: string; message: string; position: number }) {
  return new TaskError(400, error.message, error.code, { position: error.position });
}

/** Parses `q` strictly for a request; 400 `FILTER_INVALID`/`FILTER_UNSUPPORTED`/`FILTER_SCOPE` with `position`. */
export function parseFilter(q: string) {
  const parsed = parse(q);
  if (!parsed.ok) throw filterError(parsed.error);
  return parsed.query;
}

// Cursor: `<payload>.<mac>`. The payload is [1, key, ...sort values, id] as base64url JSON. The key binds it to the
// canonical query, sort, group, and, for date-relative queries, the caller's zone and date, so a cursor never
// continues a different question. The MAC (HMAC-SHA256 over the user id and the payload, keyed by a per-process
// secret) binds it to the caller and makes the sort values tamper-proof. A new process refuses older cursors, which
// CURSOR_INVALID already covers: start again from the first page.
const cursorKey = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 16);
const cursorSecret = randomBytes(32);
const cursorMac = (userId: string, payload: string) => createHmac("sha256", cursorSecret).update(`${userId}\n${payload}`).digest();

function encodeCursor(userId: string, key: string, values: Binding[]) {
  const payload = Buffer.from(JSON.stringify([1, key, ...values])).toString("base64url");
  return `${payload}.${cursorMac(userId, payload).toString("base64url")}`;
}

const cursorInvalid = () => new TaskError(400, "The page cursor does not match this query. Start again from the first page.", "CURSOR_INVALID");

function decodeCursor(value: string, userId: string, key: string, width: number): Binding[] {
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw cursorInvalid();
  const [payload, mac] = value.split(".") as [string, string];
  const supplied = Buffer.from(mac, "base64url");
  const expected = cursorMac(userId, payload);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw cursorInvalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw cursorInvalid();
  }
  if (!Array.isArray(parsed) || parsed[0] !== 1 || parsed[1] !== key || parsed.length !== width + 2) throw cursorInvalid();
  const values = parsed.slice(2);
  if (!values.every((item) => (typeof item === "string" && item.length <= 512) || (typeof item === "number" && Number.isFinite(item)))) throw cursorInvalid();
  return values as Binding[];
}

/** `(a, b, id) after (x, y, z)` with a direction per part, expanded so mixed directions work. */
function keysetAfter(parts: KeyPart[], names: string[]) {
  const alternatives = parts.map((part, index) => {
    const equal = parts.slice(0, index).map((earlier, at) => `${earlier.sql} = $${names[at]}`);
    return `(${[...equal, `${part.sql} ${part.desc ? "<" : ">"} $${names[index]}`].join(" AND ")})`;
  });
  return `(${alternatives.join(" OR ")})`;
}

const dependsOnToday = (query: TaskQuery, group: QueryGroup) =>
  group === "due" || query.terms.some((term) => term.key === "due" && term.values.some((value) => ["overdue", "today", "week", "next-week"].includes(value)));

/**
 * Runs a query as `userId` over live cards on boards they can read. Keyset
 * pagination on the group, the sort, then the card id; at most 100 per page.
 */
export function queryCards(userId: string, input: QueryInput): QueryResult {
  const query = parseFilter(input.q);
  return runQuery(userId, query, input);
}

export function runQuery(userId: string, query: TaskQuery, input: Omit<QueryInput, "q">): QueryResult {
  const sort = input.sort ?? "due";
  const group = input.group ?? "none";
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? QUERY_PAGE.default), 1), QUERY_PAGE.max);
  const now = input.now ?? new Date();
  const today = dateInZone(now, input.tz);
  const canonical = format(query);
  const compiled = compileTaskQuery(query, { userId, today, nowTime: timeInZone(now, input.tz) });

  const sortParts = SORT_PARTS[sort];
  const parts: KeyPart[] = [...GROUP_PARTS[group], ...sortParts, { sql: "k.id", desc: sortParts[sortParts.length - 1]!.desc }];
  const key = cursorKey([canonical, sort, group, ...(dependsOnToday(query, group) ? [input.tz, today] : [])]);
  const params: Record<string, Binding> = { ...compiled.params, today, weekEnd: addQueryDays(today, 6) };
  let after = "1";
  if (input.cursor) {
    const values = decodeCursor(input.cursor, userId, key, parts.length);
    const names = values.map((value, index) => {
      params[`c${index}`] = value;
      return `c${index}`;
    });
    after = keysetAfter(parts, names);
  }
  const from = `FROM cards k JOIN boards b ON b.id = k.board_id JOIN board_columns col ON col.id = k.column_id
    WHERE k.deleted_at IS NULL AND ${readableBoardPredicate} AND (${compiled.where})`;
  const rows = db.query(`SELECT k.id, k.board_id, b.name AS board_name, k.column_id, col.name AS column_name, ${COLUMN_STATE} AS column_state, col.is_done,
      k.position, k.title, k.description_excerpt, k.revision, k.created_by, cu.display_name AS creator_name,
      k.due_on, k.due_time, k.due_tz, k.created_at, k.updated_at, k.parent_card_id, k.level,
      (SELECT p.title FROM cards p WHERE p.id = k.parent_card_id AND p.board_id = k.board_id AND p.deleted_at IS NULL) AS parent_title,
      ${EFFECTIVE_SPRINT_SQL} AS sprint_id,
      (SELECT s.name FROM board_sprints s WHERE s.board_id = k.board_id AND s.id = ${EFFECTIVE_SPRINT_SQL}) AS sprint_name,
      ${parts.map((part, index) => `${part.sql} AS sk${index}`).join(", ")}
    FROM cards k JOIN boards b ON b.id = k.board_id JOIN board_columns col ON col.id = k.column_id LEFT JOIN users cu ON cu.id = k.created_by
    WHERE k.deleted_at IS NULL AND ${readableBoardPredicate} AND (${compiled.where}) AND ${after}
    ORDER BY ${parts.map((part) => `${part.sql} ${part.desc ? "DESC" : "ASC"}`).join(", ")}
    LIMIT $pageLimit`).all({ ...params, pageLimit: limit + 1 }) as Array<Record<string, unknown>>;

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(userId, key, parts.map((_, index) => last[`sk${index}`] as Binding)) : null;
  const result: QueryResult = { query: canonical, cards: withCardDetails(page), nextCursor };
  if (!input.cursor) {
    const counted = (db.query(`SELECT COUNT(*) AS count FROM (SELECT 1 ${from} LIMIT $cap)`).get({ ...compiled.params, cap: QUERY_TOTAL_CAP + 1 }) as { count: number }).count;
    if (counted <= QUERY_TOTAL_CAP) result.total = counted;
    result.refs = resolveRefs(userId, query, result.cards);
  }
  return result;
}

/**
 * The web client's card actions: each card with the caller's level on its board (Wave 32, §D.3),
 * so a card on a board they only view or comment on offers no Move, edit, or delete. Resolved once
 * per board on the page. The web routes add it; MCP results keep their shape.
 */
export function withBoardLevels<T extends { cards: QueriedCard[] }>(userId: string, result: T): T & { cards: Array<QueriedCard & { board_level: ItemLevel }> } {
  const levels = new Map<string, ItemLevel>();
  const levelOf = (boardId: string) => {
    let level = levels.get(boardId);
    if (level === undefined) {
      const board = readableBoard(boardId, userId);
      level = board ? boardLevel(board, userId) : "none";
      levels.set(boardId, level);
    }
    return level;
  };
  return { ...result, cards: result.cards.map((card) => ({ ...card, board_level: levelOf(card.board_id) })) };
}

/** Adds assignees, tags, and flags to a page with one grouped query each (no per-card subqueries). */
function withCardDetails(rows: Array<Record<string, unknown>>): QueriedCard[] {
  const ids = rows.map((row) => row.id as string);
  const assignees = assigneesForCards(ids);
  const json = JSON.stringify(ids);
  const tags = new Map<string, QueriedCard["tags"]>();
  for (const row of db.query(`SELECT ct.card_id, t.id, t.name, t.color FROM card_tags ct JOIN board_tags t ON t.id = ct.tag_id
      WHERE ct.card_id IN (SELECT value FROM json_each(?)) ORDER BY ct.card_id, t.name COLLATE NOCASE, t.id`).all(json) as Array<{ card_id: string; id: string; name: string; color: string }>) {
    const list = tags.get(row.card_id) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    tags.set(row.card_id, list);
  }
  const flags = new Map<string, string[]>();
  for (const row of db.query("SELECT card_id, flag FROM card_flags WHERE card_id IN (SELECT value FROM json_each(?))").all(json) as Array<{ card_id: string; flag: string }>) {
    const list = flags.get(row.card_id) ?? [];
    list.push(row.flag);
    flags.set(row.card_id, list);
  }
  return rows.map((row) => {
    const card = Object.fromEntries(Object.entries(row).filter(([name]) => !/^sk\d+$/.test(name))) as Omit<QueriedCard, "due_at" | "assignees" | "tags" | "flags">;
    return {
      ...card,
      due_at: dueAt(card),
      assignees: assignees.get(card.id) ?? [],
      tags: tags.get(card.id) ?? [],
      flags: (flags.get(card.id) ?? []).sort((a, b) => FLAG_ORDER.indexOf(a) - FLAG_ORDER.indexOf(b))
    };
  });
}

/**
 * Names for the ids a query mentions, per caller: boards, columns, and tags
 * only when their board is readable (otherwise `restricted`, with no name);
 * users by display name, as `GET /api/users` already shows them.
 *
 * Roles that may not use `GET /api/users` (viewers and guests: no `sharing.write`) get a name only
 * for themselves, a creator or assignee of a card on this page, or a reader of a board they can
 * read; any other user id is `unknown`, so `creator:<uuid>` is no directory lookup.
 */
export function resolveRefs(userId: string, query: TaskQuery, pageCards: readonly Pick<QueriedCard, "created_by" | "assignees">[] = []): QueryRefs {
  const valuesOf = (...keys: FilterTerm["key"][]) => [...new Set(query.terms.filter((term) => keys.includes(term.key)).flatMap((term) => term.values))];
  const uuids = (values: string[]) => values.filter((value) => /^[0-9a-f-]{36}$/.test(value));
  const boardIds = uuids(valuesOf("board"));
  const columnIds = uuids(valuesOf("column"));
  const tagIds = uuids(valuesOf("tag"));
  const userIds = uuids(valuesOf("assignee", "creator"));
  const readableBoards = new Map((db.query(`SELECT b.id, b.name FROM boards b WHERE b.id IN (SELECT value FROM json_each($ids)) AND ${readableBoardPredicate}`)
    .all({ ids: JSON.stringify(boardIds), userId }) as Array<{ id: string; name: string }>).map((row) => [row.id, row]));
  const readableColumns = new Map((db.query(`SELECT col.id, col.name, col.board_id FROM board_columns col JOIN boards b ON b.id = col.board_id
      WHERE col.id IN (SELECT value FROM json_each($ids)) AND ${readableBoardPredicate}`)
    .all({ ids: JSON.stringify(columnIds), userId }) as Array<{ id: string; name: string; board_id: string }>).map((row) => [row.id, row]));
  const readableTags = new Map((db.query(`SELECT t.id, t.name, t.color, t.board_id FROM board_tags t JOIN boards b ON b.id = t.board_id
      WHERE t.id IN (SELECT value FROM json_each($ids)) AND ${readableBoardPredicate}`)
    .all({ ids: JSON.stringify(tagIds), userId }) as Array<{ id: string; name: string; color: string; board_id: string }>).map((row) => [row.id, row]));
  const role = userRole(userId);
  const directory = role !== null && can(role, "sharing.write");
  const onPage = [...new Set(pageCards.flatMap((card) => [card.created_by, ...card.assignees.map((assignee) => assignee.id)]).filter((id): id is string => Boolean(id)))];
  const users = new Map((db.query(`SELECT u.id, u.display_name FROM users u WHERE u.id IN (SELECT value FROM json_each($ids)) AND u.disabled_at IS NULL
      AND ($directory = 1 OR u.id = $userId OR u.id IN (SELECT value FROM json_each($onPage))
        OR EXISTS (SELECT 1 FROM boards b WHERE ${readableBoardPredicate} AND (b.owner_id = u.id
          OR (b.visibility = 'all_users' AND ${audienceAllUsersFor("u.id")})
          OR (b.visibility = 'selected' AND (EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = u.id)
            OR ${groupGrantExists("board", "b.id", "u.id")})))))`)
    .all({ ids: JSON.stringify(userIds), userId, directory: directory ? 1 : 0, onPage: JSON.stringify(onPage) }) as Array<{ id: string; display_name: string }>).map((row) => [row.id, row]));
  return {
    boards: boardIds.map((id) => readableBoards.get(id) ?? { id, restricted: true as const }),
    columns: columnIds.map((id) => readableColumns.get(id) ?? { id, restricted: true as const }),
    tags: tagIds.map((id) => readableTags.get(id) ?? { id, restricted: true as const }),
    users: userIds.map((id) => users.get(id) ?? { id, unknown: true as const })
  };
}
