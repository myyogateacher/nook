import { audit, db, now } from "../db";
import { withResourceLock } from "../storage";
import { format, parse, scopedBoardId } from "../../shared/taskQuery";
import { LANE_MODES, laneModeOfKey, normalizeCollapsedLanes, NONE_LANE, type LaneMode } from "../../shared/taskLanes";
import { isSwimlaneMode, normalizeCollapsedRows, type SwimlaneMode } from "../../shared/swimlanes";
import { boardLevel, readableBoardPredicate, type BoardVisibility } from "./access";
import { planInsert } from "./boardOrder";
import { filterError, laneKeysOf, QUERY_GROUPS, QUERY_SORTS, runQuery, type QueryGroup, type QueryResult, type QuerySort } from "./query";
import { applyRenumber, limitReached, requireReadableBoard, TaskError } from "./service";
import { boardColumnIds, boardRowKeys, parsedList } from "./archive";
import { AUDIENCE_ALL_USERS } from "../team/roles";
import { canWriteContent } from "../team/userRole";
import { mailShared, shareMembers } from "../mail/triggers";
import { groupGrantExists } from "../access/groups";
import { GUEST_SHARE_DISABLED, legacyGuestShareBlocked } from "../access/shares";

/**
 * Saved cross-board task views (research 2026-09-26 §10.2, D140, Q12, Q13;
 * migration 020).
 *
 * A view stores a question, not an answer: a canonical filter
 * (`shared/taskQuery.ts`) plus display options. Running a view always runs
 * the stored filter **as the viewer**, through the same `runQuery` as
 * `POST /api/tasks/query`, so a recipient never sees cards from boards they
 * cannot read, whoever shared the view (T115).
 *
 * Visibility follows boards: `private`, `selected` (members), or
 * `all_users`. Only the owner edits, renames, reorders, shares, or deletes a
 * view (403 `OWNER_ONLY` for other readers); readers may duplicate it into a
 * private copy. Anyone else gets 404, the same as a missing view (T116). A
 * disabled owner's views vanish for everyone else.
 *
 * An owner whose role cannot write content (a viewer, or a member demoted
 * after sharing) keeps only private views: they may rename, change, or
 * delete a view while it is `private`, and may withdraw a share by setting
 * it back to `private`, but a shared view is otherwise read-only for them
 * (403 `VIEW_SHARED_READ_ONLY`).
 */

export const VIEW_LIMITS = { perOwner: 50, members: 100, listed: 200 } as const;
/** `timeline` (D760) is a board layout: a view on one board opens in it; the cross-board page shows it as the list. */
export const VIEW_LAYOUTS = ["list", "table", "board", "timeline"] as const;
/** Group-by options. `board`, `state`, and `due` group on the server; `assignee` and `tag` group on the client (multi-valued). */
export const VIEW_GROUPS = [...QUERY_GROUPS, "assignee", "tag"] as const;
export const VIEW_FIELDS = ["board", "column", "state", "assignees", "due", "tags", "flags", "priority", "updated"] as const;

export type ViewDisplay = {
  layout: typeof VIEW_LAYOUTS[number];
  group: typeof VIEW_GROUPS[number];
  sort: QuerySort;
  /** The board layout's lanes for a multi-board view (lane VIEWS, D640): merged columns (default) or states. */
  lanes?: LaneMode;
  /** A board view's swimlanes (lane VIEWS2, D655): rows by assignee or by parent. */
  swimlanes?: SwimlaneMode | null;
  fields?: Array<typeof VIEW_FIELDS[number]>;
};
export const DEFAULT_VIEW_DISPLAY: ViewDisplay = { layout: "list", group: "none", sort: "due" };

type ViewRow = {
  id: string; owner_id: string; owner_name: string; name: string; query: string; display_json: string;
  visibility: BoardVisibility; position: number; revision: number; created_at: string; updated_at: string;
};

export type TaskView = {
  id: string; name: string; owner_id: string; owner_name: string; is_owner: 0 | 1; visibility: BoardVisibility;
  query: string; display: ViewDisplay; position: number; revision: number; created_at: string; updated_at: string;
  /**
   * Lane VIEWS (D635): the one board this view is on (exactly one positive `board:` term with one
   * value) when the viewer can read it, else null. The app opens such a view as that board.
   */
  board_id: string | null;
};

const viewSelect = `SELECT v.id, v.owner_id, u.display_name AS owner_name, v.name, v.query, v.display_json, v.visibility,
    v.position, v.revision, v.created_at, v.updated_at
  FROM task_views v JOIN users u ON u.id = v.owner_id`;

/**
 * Lane VIEWS2 (D658, T448): a view its owner pinned on a board, as that board's owner or manager, is
 * read by everyone who can open the board. The view still runs as the viewer (T115), so the pin
 * shares only its name, filter, and layout. Pins exist only while the view is on that one board.
 */
const pinnedOnReadableBoard = `EXISTS (SELECT 1 FROM task_view_pins pv JOIN boards b ON b.id = pv.board_id WHERE pv.view_id = v.id AND ${readableBoardPredicate})`;

/**
 * Whether `$userId` may read view `v` (owner `u`): the owner, or, while the
 * owner is enabled, everyone for `all_users`, members for `selected`, and
 * the readers of a board the view is pinned on (D658).
 */
export const readableViewPredicate = `(v.owner_id = $userId OR (u.disabled_at IS NULL AND ((v.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS})
  OR (v.visibility = 'selected' AND (EXISTS (SELECT 1 FROM task_view_members m WHERE m.view_id = v.id AND m.user_id = $userId)
    OR ${groupGrantExists("task_view", "v.id")}))
  OR ${pinnedOnReadableBoard})))`;

/** The single board a stored filter is on (D635), or null. */
export function viewBoardId(query: string) {
  const parsed = parse(query);
  return parsed.ok ? scopedBoardId(parsed.query) : null;
}

/** Which of these boards the viewer can read (one query for a whole list). */
function readableBoardIds(userId: string, boardIds: readonly string[]) {
  if (!boardIds.length) return new Set<string>();
  return new Set((db.query(`SELECT b.id FROM boards b WHERE b.id IN (SELECT value FROM json_each($ids)) AND ${readableBoardPredicate}`)
    .all({ ids: JSON.stringify([...new Set(boardIds)]), userId }) as Array<{ id: string }>).map((row) => row.id));
}

function toView(row: ViewRow, userId: string, readable?: ReadonlySet<string>): TaskView {
  const { display_json, ...rest } = row;
  let display: ViewDisplay = DEFAULT_VIEW_DISPLAY;
  try {
    display = { ...DEFAULT_VIEW_DISPLAY, ...(JSON.parse(display_json) as Partial<ViewDisplay>) };
  } catch {
    // The CHECK keeps it valid JSON; fall back to defaults if a newer build wrote something unreadable.
  }
  if (display.lanes !== undefined && !(LANE_MODES as readonly string[]).includes(display.lanes)) delete display.lanes;
  if (display.swimlanes !== undefined && !isSwimlaneMode(display.swimlanes)) delete display.swimlanes;
  const boardId = viewBoardId(row.query);
  const onBoard = boardId && (readable ?? readableBoardIds(userId, [boardId])).has(boardId) ? boardId : null;
  return { ...rest, is_owner: row.owner_id === userId ? 1 : 0, display, board_id: onBoard };
}

/** Views of one list, with `board_id` resolved in one query. */
function toViews(rows: ViewRow[], userId: string) {
  const readable = readableBoardIds(userId, rows.map((row) => viewBoardId(row.query)).filter((id): id is string => id !== null));
  return rows.map((row) => toView(row, userId, readable));
}

const viewNotFound = () => new TaskError(404, "View not found");
const viewOwnerOnly = () => new TaskError(403, "Only the view's owner can do this", "OWNER_ONLY");

function readableViewRow(viewId: string, userId: string) {
  return db.query(`${viewSelect} WHERE v.id = $viewId AND ${readableViewPredicate}`).get({ viewId, userId }) as ViewRow | null;
}

export function requireReadableView(viewId: string, userId: string) {
  const row = readableViewRow(viewId, userId);
  if (!row) throw viewNotFound();
  return row;
}

function requireOwnedView(viewId: string, userId: string) {
  const row = requireReadableView(viewId, userId);
  if (row.owner_id !== userId) throw viewOwnerOnly();
  return row;
}

const viewSharedReadOnly = (message: string) => new TaskError(403, message, "VIEW_SHARED_READ_ONLY");

/** An owned view the caller may change: read-only roles only while it is private. */
function requireEditableOwnedView(viewId: string, userId: string) {
  const row = requireOwnedView(viewId, userId);
  if (row.visibility !== "private" && !canWriteContent(userId)) {
    throw viewSharedReadOnly("Your team role is read-only: make this view private before changing it");
  }
  return row;
}

/** Serializes one owner's view list: the cap and positions. */
const withViewsLock = <T>(ownerId: string, operation: () => T | Promise<T>) => withResourceLock(`task-views:${ownerId}`, async () => operation());

/** The canonical stored form of a filter, or 400 `FILTER_*` with `position`. */
function canonicalFilter(query: string) {
  const parsed = parse(query);
  if (!parsed.ok) throw filterError(parsed.error);
  return format(parsed.query);
}

const ownedViews = (ownerId: string) =>
  db.query("SELECT id, position FROM task_views WHERE owner_id = ? ORDER BY position, id").all(ownerId) as Array<{ id: string; position: number }>;

export function listViews(userId: string) {
  const mine = db.query(`${viewSelect} WHERE v.owner_id = $userId ORDER BY v.position, v.id`).all({ userId }) as ViewRow[];
  const shared = db.query(`${viewSelect} WHERE v.owner_id <> $userId AND v.visibility = 'selected' AND ${readableViewPredicate}
    ORDER BY v.name COLLATE NOCASE, v.id LIMIT $limit`).all({ userId, limit: VIEW_LIMITS.listed + 1 }) as ViewRow[];
  const everyone = db.query(`${viewSelect} WHERE v.owner_id <> $userId AND (v.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS}) AND ${readableViewPredicate}
    ORDER BY v.name COLLATE NOCASE, v.id LIMIT $limit`).all({ userId, limit: VIEW_LIMITS.listed + 1 }) as ViewRow[];
  return {
    mine: toViews(mine, userId),
    shared: toViews(shared.slice(0, VIEW_LIMITS.listed), userId),
    everyone: toViews(everyone.slice(0, VIEW_LIMITS.listed), userId),
    truncated: shared.length > VIEW_LIMITS.listed || everyone.length > VIEW_LIMITS.listed
  };
}

export function getView(userId: string, viewId: string) {
  return { view: toView(requireReadableView(viewId, userId), userId) };
}

export type ViewCreateInput = { name: string; query: string; display?: Partial<ViewDisplay> };

function insertView(ownerId: string, input: { name: string; query: string; display: ViewDisplay }, event: Record<string, unknown> = {}) {
  return withViewsLock(ownerId, () => {
    const owned = ownedViews(ownerId);
    if (owned.length >= VIEW_LIMITS.perOwner) throw limitReached(`You can have up to ${VIEW_LIMITS.perOwner} views`);
    const plan = planInsert(owned, undefined)!;
    const id = crypto.randomUUID();
    db.transaction(() => {
      applyRenumber("task_views", plan.renumbered);
      const timestamp = now();
      db.query(`INSERT INTO task_views (id, owner_id, name, query, display_json, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, ownerId, input.name, input.query, JSON.stringify(input.display), plan.position, timestamp, timestamp);
      audit(ownerId, null, "task.view_create", { viewId: id, ...event });
    })();
    return { view: toView(requireReadableView(id, ownerId), ownerId) };
  });
}

export function createView(userId: string, input: ViewCreateInput) {
  const query = canonicalFilter(input.query);
  return insertView(userId, { name: input.name, query, display: { ...DEFAULT_VIEW_DISPLAY, ...input.display } });
}

/** A private copy owned by the caller, for any reader of the view (Q13: recipients duplicate rather than edit). */
export function duplicateView(userId: string, viewId: string) {
  const source = toView(requireReadableView(viewId, userId), userId);
  const suffix = " (copy)";
  const name = `${source.name.slice(0, 80 - suffix.length)}${suffix}`;
  return insertView(userId, { name, query: source.query, display: source.display }, { sourceViewId: viewId });
}

export type ViewPatchInput = { name?: string; query?: string; display?: Partial<ViewDisplay>; afterViewId?: string | null; revision: number };

/** Owner only, with a revision compare-and-swap (409 `VIEW_CHANGED` carries the current view). */
export function patchView(userId: string, viewId: string, input: ViewPatchInput) {
  requireEditableOwnedView(viewId, userId);
  const query = input.query === undefined ? undefined : canonicalFilter(input.query);
  return withViewsLock(userId, () => {
    const current = toView(requireEditableOwnedView(viewId, userId), userId);
    if (current.revision !== input.revision) throw new TaskError(409, "This view changed since you opened it", "VIEW_CHANGED", { view: current });
    let plan = null as ReturnType<typeof planInsert>;
    if (input.afterViewId !== undefined) {
      if (input.afterViewId === viewId) throw new TaskError(400, "A view cannot be placed after itself");
      plan = planInsert(ownedViews(userId).filter((view) => view.id !== viewId), input.afterViewId);
      if (!plan) throw viewNotFound();
    }
    const display = input.display === undefined ? undefined : { ...current.display, ...input.display };
    db.transaction(() => {
      const timestamp = now();
      applyRenumber("task_views", plan?.renumbered ?? null);
      const updated = db.query(`UPDATE task_views SET name = COALESCE($name, name), query = COALESCE($query, query),
          display_json = COALESCE($display, display_json), position = COALESCE($position, position),
          revision = revision + 1, updated_at = $timestamp
        WHERE id = $viewId AND revision = $revision`).run({
        name: input.name ?? null,
        query: query ?? null,
        display: display ? JSON.stringify(display) : null,
        position: plan?.position ?? null,
        timestamp, viewId, revision: input.revision
      });
      if (updated.changes !== 1) throw new Error("Concurrent view update detected");
      // A pin lasts only while the view is on that board (D658): a filter edited onto other boards drops it.
      if (query !== undefined) {
        const onBoard = viewBoardId(query);
        db.query("DELETE FROM task_view_pins WHERE view_id = ? AND board_id IS NOT ?").run(viewId, onBoard);
      }
      audit(userId, null, "task.view_update", {
        viewId,
        ...(input.name !== undefined ? { renamed: true } : {}),
        ...(query !== undefined ? { query: true } : {}),
        ...(display ? { display: true } : {}),
        ...(plan ? { moved: true } : {})
      });
    })();
    return { view: toView(requireReadableView(viewId, userId), userId) };
  });
}

export function deleteView(userId: string, viewId: string) {
  requireEditableOwnedView(viewId, userId);
  return withViewsLock(userId, () => {
    requireEditableOwnedView(viewId, userId);
    db.transaction(() => {
      db.query("DELETE FROM task_views WHERE id = ?").run(viewId);
      // Everyone's collapsed lanes go with it (D644), and its pins (D658).
      db.query("DELETE FROM task_view_prefs WHERE view_key = ?").run(viewId);
      db.query("DELETE FROM task_view_pins WHERE view_id = ?").run(viewId);
      audit(userId, null, "task.view_delete", { viewId });
    })();
    return { ok: true as const };
  });
}

export function getViewSharing(userId: string, viewId: string) {
  const view = requireOwnedView(viewId, userId);
  const users = db.query("SELECT u.id, u.display_name FROM task_view_members m JOIN users u ON u.id = m.user_id WHERE m.view_id = ? ORDER BY u.display_name, u.id")
    .all(viewId) as Array<{ id: string; display_name: string }>;
  return { visibility: view.visibility, users };
}

/**
 * Replaces the audience, as board sharing does: members are kept only for `selected`.
 * Read-only roles may only withdraw a share (set it to `private`).
 */
export function putViewSharing(userId: string, viewId: string, visibility: BoardVisibility, userIds: string[]) {
  requireOwnedView(viewId, userId);
  if (visibility !== "private" && !canWriteContent(userId)) throw viewSharedReadOnly("Your team role is read-only: you can only make this view private");
  const uniqueIds = [...new Set(userIds.map((id) => id.toLowerCase()))];
  if (uniqueIds.includes(userId)) throw new TaskError(400, "The owner cannot be added as a recipient");
  if (uniqueIds.length > VIEW_LIMITS.members) throw new TaskError(400, `Share with at most ${VIEW_LIMITS.members} people`);
  if (visibility === "selected" && uniqueIds.length === 0) throw new TaskError(400, "Select at least one user");
  if (uniqueIds.length) {
    const found = db.query("SELECT id FROM users WHERE disabled_at IS NULL AND id IN (SELECT value FROM json_each(?))").all(JSON.stringify(uniqueIds));
    if (found.length !== uniqueIds.length) throw new TaskError(400, "One or more users were not found");
  }
  if (visibility === "selected" && legacyGuestShareBlocked("task_view", viewId, uniqueIds.map((recipientId) => ({ userId: recipientId, level: "view" as const })))) throw new TaskError(400, GUEST_SHARE_DISABLED.error, GUEST_SHARE_DISABLED.code);
  return withViewsLock(userId, () => {
    requireOwnedView(viewId, userId);
    db.transaction(() => {
      const before = shareMembers("task_view_members", "view_id", viewId);
      db.query("DELETE FROM task_view_members WHERE view_id = ?").run(viewId);
      if (visibility === "selected") {
        const insert = db.query("INSERT INTO task_view_members (view_id, user_id, created_at) VALUES (?, ?, ?)");
        for (const recipientId of uniqueIds) insert.run(viewId, recipientId, now());
        // "Shared with you" mail (outbound email #25).
        mailShared(userId, "view", viewId, before, uniqueIds);
      }
      // Sharing is part of the view: bump the revision so an editor holding the old one gets 409 VIEW_CHANGED.
      db.query("UPDATE task_views SET visibility = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(visibility, now(), viewId);
      audit(userId, null, "task.view_sharing_changed", { viewId, visibility, recipientCount: visibility === "selected" ? uniqueIds.length : 0 });
    })();
    return { ok: true as const };
  });
}

/**
 * Runs a view's stored filter **as the viewer** (T115): the same query path
 * as `POST /api/tasks/query`, with the view's sort and (server-side) group.
 */
export function viewCards(userId: string, viewId: string, input: { cursor?: string; limit?: number; tz: string; now?: Date; lanes?: LaneMode }): QueryResult & { view: TaskView } {
  const view = toView(requireReadableView(viewId, userId), userId);
  const parsed = parse(view.query);
  if (!parsed.ok) throw filterError(parsed.error);
  const group: QueryGroup = (QUERY_GROUPS as readonly string[]).includes(view.display.group) ? view.display.group as QueryGroup : "none";
  const sort: QuerySort = (QUERY_SORTS as readonly string[]).includes(view.display.sort) ? view.display.sort : "due";
  return { view, ...runQuery(userId, parsed.query, { ...input, sort, group }) };
}

// ---------------------------------------------------------------------------
// One person's collapsed lanes (lane VIEWS, D644, migration 077), and a board view's own collapse
// (lane VIEWS2, D657, migration 078).

export type ViewLanePrefs = {
  collapsedLanes: string[];
  /** A board view keeps its own collapsed columns and rows instead of the board's (D657); off by default. */
  ownCollapse: boolean;
  /** The view's own collapsed columns (board views, while `ownCollapse` is on): ids of its board's columns. */
  collapsedColumnIds: string[];
  /** The view's own collapsed swimlanes (D656, while `ownCollapse` is on). */
  collapsedRows: string[];
};

export type ViewLanePrefsInput = { collapsedLanes?: readonly string[]; ownCollapse?: boolean; collapsedColumnIds?: readonly string[]; collapsedRows?: readonly string[]; q?: string };

/** A view the caller reads (404 otherwise), or `my` (My work, anyone). */
function requirePrefsTarget(userId: string, viewKey: string) {
  return viewKey === "my" ? null : toView(requireReadableView(viewKey, userId), userId);
}

type PrefsRow = { collapsed_lanes: string; own_collapse: number; collapsed_columns: string; collapsed_rows: string };

function storedPrefs(userId: string, viewKey: string): ViewLanePrefs {
  const row = db.query("SELECT collapsed_lanes, own_collapse, collapsed_columns, collapsed_rows FROM task_view_prefs WHERE user_id = ? AND view_key = ?").get(userId, viewKey) as PrefsRow | null;
  return {
    collapsedLanes: row ? normalizeCollapsedLanes(parsedList(row.collapsed_lanes)) : [],
    ownCollapse: row?.own_collapse === 1,
    collapsedColumnIds: row ? parsedList(row.collapsed_columns).filter((id): id is string => typeof id === "string") : [],
    collapsedRows: row ? normalizeCollapsedRows(parsedList(row.collapsed_rows)) : []
  };
}

export function readViewLanePrefs(userId: string, viewKey: string): ViewLanePrefs {
  const view = requirePrefsTarget(userId, viewKey);
  const stored = storedPrefs(userId, viewKey);
  // A board view's own columns are its board's (a column deleted since is left out).
  return { ...stored, collapsedColumnIds: view?.board_id ? boardColumnIds(view.board_id, stored.collapsedColumnIds) : [] };
}

/** My work always carries a positive `assignee:me` (Q11); only such a filter is run to trim its lanes (D653). */
function myWorkFilter(q: string | undefined) {
  if (q === undefined) return null;
  const parsed = parse(q);
  if (!parsed.ok) return null;
  return parsed.query.terms.some((term) => term.key === "assignee" && !term.negate && term.values.length === 1 && term.values[0] === "me") ? parsed.query : null;
}

/**
 * Lane keys that are no longer lanes of these results (D644, D653): for each grouped kind present
 * (merged columns, people, tags, sprints, boards), the query's lanes in that mode are run once and
 * keys outside them are dropped. State and due lanes, and the "none" lanes, always exist.
 */
function trimToLanes(userId: string, query: ReturnType<typeof myWorkFilter>, keys: string[]) {
  if (!query) return keys;
  const modes = new Set(keys.filter((key) => !key.startsWith("none:")).map(laneModeOfKey).filter((mode): mode is LaneMode => mode !== null && mode !== "state" && mode !== "due"));
  const known = new Map<LaneMode, Set<string> | null>();
  for (const mode of modes) known.set(mode, laneKeysOf(userId, query, mode));
  return keys.filter((key) => {
    if (Object.values(NONE_LANE).includes(key as typeof NONE_LANE[keyof typeof NONE_LANE])) return true;
    const mode = laneModeOfKey(key);
    if (!mode || !known.has(mode)) return true;
    const lanes = known.get(mode);
    // A mode that fell back (too many lanes) shows none of its own: its keys are kept for when it fits again.
    return lanes === null || lanes!.has(key);
  });
}

/**
 * `PUT /views/:v/prefs` (a reader of the view; `my` for anyone): replaces the fields sent. Lanes:
 * malformed keys are dropped, at most 40 are kept within 1 KiB, and grouped lanes stay only while
 * they are lanes of the results (a saved view's own filter; for My work, the `q` it sends, when that
 * is a filter with `assignee:me`). A board view's own collapse (D657): `ownCollapse` turns it on or
 * off, and its columns and rows are trimmed to its board as the board's are. Not audited: it is one
 * person's view, like a sort.
 */
export function writeViewLanePrefs(userId: string, viewKey: string, input: ViewLanePrefsInput): ViewLanePrefs {
  const view = requirePrefsTarget(userId, viewKey);
  const current = readViewLanePrefs(userId, viewKey);
  let collapsedLanes = input.collapsedLanes === undefined ? current.collapsedLanes : normalizeCollapsedLanes(input.collapsedLanes);
  if (input.collapsedLanes !== undefined && collapsedLanes.length) {
    const parsed = view ? parse(view.query) : null;
    collapsedLanes = trimToLanes(userId, view ? (parsed?.ok ? parsed.query : null) : myWorkFilter(input.q), collapsedLanes);
  }
  const boardId = view?.board_id ?? null;
  if (!boardId && (input.ownCollapse || input.collapsedColumnIds?.length)) {
    throw new TaskError(400, "Only a view on one board keeps its own collapsed columns", "NOT_A_BOARD_VIEW");
  }
  // Rows: a board view's are trimmed to its board; a cross-board view's or My work's swimlanes (person
  // or board rows, lane VIEWS2, D669) are kept well formed and bounded.
  const rows = input.collapsedRows === undefined ? current.collapsedRows : boardId ? boardRowKeys(boardId, input.collapsedRows) : normalizeCollapsedRows(input.collapsedRows);
  const next: ViewLanePrefs = {
    collapsedLanes,
    ownCollapse: input.ownCollapse ?? current.ownCollapse,
    collapsedColumnIds: input.collapsedColumnIds === undefined || !boardId ? current.collapsedColumnIds : boardColumnIds(boardId, input.collapsedColumnIds),
    collapsedRows: rows
  };
  db.query(`INSERT INTO task_view_prefs (user_id, view_key, collapsed_lanes, own_collapse, collapsed_columns, collapsed_rows, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, view_key) DO UPDATE SET collapsed_lanes = excluded.collapsed_lanes, own_collapse = excluded.own_collapse,
      collapsed_columns = excluded.collapsed_columns, collapsed_rows = excluded.collapsed_rows, updated_at = excluded.updated_at`)
    .run(userId, viewKey, JSON.stringify(next.collapsedLanes), next.ownCollapse ? 1 : 0, JSON.stringify(next.collapsedColumnIds), JSON.stringify(next.collapsedRows), now());
  return next;
}

// ---------------------------------------------------------------------------
// Views pinned on a board for everyone who can open it (lane VIEWS2, D658, T448, migration 078).

export const MAX_PINNED_VIEWS = 20;

const pinNotOnBoard = () => new TaskError(400, "Only a view on this one board can be pinned on it", "VIEW_NOT_ON_BOARD");

/** The board's owner or a manager, with a Team role that writes (403 MANAGER_REQUIRED otherwise). */
function requireBoardManager(boardId: string, userId: string) {
  const board = requireReadableBoard(boardId, userId);
  const level = boardLevel(board, userId);
  if ((level !== "owner" && level !== "manage") || !canWriteContent(userId)) throw new TaskError(403, "Only the board owner or a manager can pin views for everyone", "MANAGER_REQUIRED");
  return { board, level };
}

/**
 * `GET /api/tasks/boards/:b/views` (any reader of the board): the views pinned on it, in pin order,
 * then the caller's other readable views on this board (their own, shared with them, shared with
 * everyone), and whether the caller may pin (`canPin`: the board's owner or a manager).
 */
export function listBoardViews(userId: string, boardId: string) {
  const board = requireReadableBoard(boardId, userId);
  const level = boardLevel(board, userId);
  const pinnedRows = db.query(`${viewSelect} JOIN task_view_pins p ON p.view_id = v.id
    WHERE p.board_id = $boardId AND ${readableViewPredicate} ORDER BY p.position, v.id`).all({ boardId, userId }) as ViewRow[];
  const pinned = toViews(pinnedRows, userId).filter((view) => view.board_id === boardId);
  const pinnedIds = new Set(pinned.map((view) => view.id));
  const lists = listViews(userId);
  const views = [...lists.mine, ...lists.shared, ...lists.everyone].filter((view) => view.board_id === boardId && !pinnedIds.has(view.id));
  return { pinned, views, canPin: (level === "owner" || level === "manage") && canWriteContent(userId) };
}

/**
 * `PUT /api/tasks/boards/:b/pins/:v`: pins a view the caller owns on its board, for everyone who can
 * open the board (D658). The caller is the board's owner or a manager; the view's filter is on
 * exactly this board. At most 20 per board; pinning a pinned view changes nothing. Audited.
 */
export function pinView(userId: string, boardId: string, viewId: string) {
  requireBoardManager(boardId, userId);
  const view = toView(requireOwnedView(viewId, userId), userId);
  if (viewBoardId(view.query) !== boardId) throw pinNotOnBoard();
  return withResourceLock(`task-view-pins:${boardId}`, async () => {
    const pinned = db.query("SELECT view_id, position FROM task_view_pins WHERE board_id = ? ORDER BY position").all(boardId) as Array<{ view_id: string; position: number }>;
    if (!pinned.some((row) => row.view_id === viewId)) {
      if (pinned.length >= MAX_PINNED_VIEWS) throw limitReached(`A board can have up to ${MAX_PINNED_VIEWS} pinned views`);
      db.transaction(() => {
        db.query("INSERT INTO task_view_pins (board_id, view_id, pinned_by, position, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(boardId, viewId, userId, (pinned[pinned.length - 1]?.position ?? 0) + 1, now());
        audit(userId, null, "task.view_pin", { boardId, viewId });
      })();
    }
    return listBoardViews(userId, boardId);
  });
}

/**
 * `DELETE /api/tasks/boards/:b/pins/:v`: unpins, by the board's owner or a manager, or by the view's
 * owner. A view that is not pinned there is 404 for anyone who could not read it. Audited.
 */
export function unpinView(userId: string, boardId: string, viewId: string) {
  const board = requireReadableBoard(boardId, userId);
  const level = boardLevel(board, userId);
  const row = db.query("SELECT v.owner_id FROM task_view_pins p JOIN task_views v ON v.id = p.view_id WHERE p.board_id = ? AND p.view_id = ?").get(boardId, viewId) as { owner_id: string } | null;
  if (!row) {
    requireReadableView(viewId, userId);
    return listBoardViews(userId, boardId);
  }
  if (row.owner_id !== userId && !((level === "owner" || level === "manage") && canWriteContent(userId))) {
    throw new TaskError(403, "Only the board owner, a manager, or the view's owner can unpin it", "MANAGER_REQUIRED");
  }
  db.transaction(() => {
    db.query("DELETE FROM task_view_pins WHERE board_id = ? AND view_id = ?").run(boardId, viewId);
    audit(userId, null, "task.view_unpin", { boardId, viewId });
  })();
  return listBoardViews(userId, boardId);
}

/**
 * `PATCH /api/tasks/boards/:b/pins/:v { afterViewId }` (lane VIEWS2, D667): the board's owner or a
 * manager reorders the pinned views; `null` puts the view first. Positions are renumbered 1…n under
 * the board's pin lock. Audited.
 */
export function movePinnedView(userId: string, boardId: string, viewId: string, afterViewId: string | null) {
  requireBoardManager(boardId, userId);
  return withResourceLock(`task-view-pins:${boardId}`, async () => {
    const order = (db.query("SELECT view_id FROM task_view_pins WHERE board_id = ? ORDER BY position, view_id").all(boardId) as Array<{ view_id: string }>).map((row) => row.view_id);
    if (!order.includes(viewId) || (afterViewId !== null && (afterViewId === viewId || !order.includes(afterViewId)))) throw new TaskError(404, "Pinned view not found");
    const rest = order.filter((id) => id !== viewId);
    rest.splice(afterViewId === null ? 0 : rest.indexOf(afterViewId) + 1, 0, viewId);
    db.transaction(() => {
      const update = db.query("UPDATE task_view_pins SET position = ? WHERE board_id = ? AND view_id = ?");
      rest.forEach((id, index) => update.run(index + 1, boardId, id));
      audit(userId, null, "task.view_pin_move", { boardId, viewId });
    })();
    return listBoardViews(userId, boardId);
  });
}

/**
 * Views pinned on boards the caller can read, with the boards they are pinned on (MCP `list_views`,
 * lane VIEWS2, D663). Only views the caller can read, which a pin on a readable board already makes.
 */
export function pinnedViewsFor(userId: string) {
  const rows = db.query(`SELECT DISTINCT p.board_id, p.view_id FROM task_view_pins p JOIN boards b ON b.id = p.board_id WHERE ${readableBoardPredicate}`)
    .all({ userId }) as Array<{ board_id: string; view_id: string }>;
  const boardsOf = new Map<string, string[]>();
  for (const row of rows) boardsOf.set(row.view_id, [...(boardsOf.get(row.view_id) ?? []), row.board_id]);
  const ids = [...boardsOf.keys()];
  const views = ids.length ? toViews(db.query(`${viewSelect} WHERE v.id IN (SELECT value FROM json_each($ids)) AND ${readableViewPredicate} ORDER BY v.name COLLATE NOCASE, v.id`)
    .all({ ids: JSON.stringify(ids), userId }) as ViewRow[], userId) : [];
  return { views, boardsOf };
}

// ---------------------------------------------------------------------------
// MCP save_view (lane VIEWS2, D660, T449).

export type SaveViewInput = { viewId?: string; name?: string; filter?: string; display?: Partial<ViewDisplay>; baseRevision?: number };

/**
 * Creates a private view (no `viewId`: `name` and `filter` required) or changes one the key's owner
 * owns (`viewId` with `baseRevision`: a revision compare-and-swap, 409 VIEW_CHANGED with the current
 * view). The same services and rules as the app: the filter is checked and stored canonical, the
 * 50-view cap holds, and only the owner changes a view. Sharing and pins stay app-only (D180).
 */
export async function saveView(userId: string, input: SaveViewInput) {
  if (input.viewId === undefined) {
    if (input.name === undefined || input.filter === undefined) throw new TaskError(400, "A new view needs a name and a filter");
    if (input.baseRevision !== undefined) throw new TaskError(400, "baseRevision goes with viewId");
    return { created: true, ...(await createView(userId, { name: input.name, query: input.filter, ...(input.display ? { display: input.display } : {}) })) };
  }
  if (input.baseRevision === undefined) throw new TaskError(400, "Changing a view needs its baseRevision (from list_views)");
  if (input.name === undefined && input.filter === undefined && input.display === undefined) throw new TaskError(400, "Provide a name, a filter, or display options");
  return { created: false, ...(await patchView(userId, input.viewId, { revision: input.baseRevision, ...(input.name !== undefined ? { name: input.name } : {}), ...(input.filter !== undefined ? { query: input.filter } : {}), ...(input.display ? { display: input.display } : {}) })) };
}
