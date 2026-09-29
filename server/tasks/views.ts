import { audit, db, now } from "../db";
import { withResourceLock } from "../storage";
import { format, parse } from "../../shared/taskQuery";
import type { BoardVisibility } from "./access";
import { planInsert } from "./boardOrder";
import { filterError, QUERY_GROUPS, QUERY_SORTS, runQuery, type QueryGroup, type QueryResult, type QuerySort } from "./query";
import { applyRenumber, limitReached, TaskError } from "./service";
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
export const VIEW_LAYOUTS = ["list", "table", "board"] as const;
/** Group-by options. `board`, `state`, and `due` group on the server; `assignee` and `tag` group on the client (multi-valued). */
export const VIEW_GROUPS = [...QUERY_GROUPS, "assignee", "tag"] as const;
export const VIEW_FIELDS = ["board", "column", "state", "assignees", "due", "tags", "flags", "updated"] as const;

export type ViewDisplay = {
  layout: typeof VIEW_LAYOUTS[number];
  group: typeof VIEW_GROUPS[number];
  sort: QuerySort;
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
};

const viewSelect = `SELECT v.id, v.owner_id, u.display_name AS owner_name, v.name, v.query, v.display_json, v.visibility,
    v.position, v.revision, v.created_at, v.updated_at
  FROM task_views v JOIN users u ON u.id = v.owner_id`;

/**
 * Whether `$userId` may read view `v` (owner `u`): the owner, or, while the
 * owner is enabled, everyone for `all_users` and members for `selected`.
 */
export const readableViewPredicate = `(v.owner_id = $userId OR (u.disabled_at IS NULL AND ((v.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS})
  OR (v.visibility = 'selected' AND (EXISTS (SELECT 1 FROM task_view_members m WHERE m.view_id = v.id AND m.user_id = $userId)
    OR ${groupGrantExists("task_view", "v.id")})))))`;

function toView(row: ViewRow, userId: string): TaskView {
  const { display_json, ...rest } = row;
  let display: ViewDisplay = DEFAULT_VIEW_DISPLAY;
  try {
    display = { ...DEFAULT_VIEW_DISPLAY, ...(JSON.parse(display_json) as Partial<ViewDisplay>) };
  } catch {
    // The CHECK keeps it valid JSON; fall back to defaults if a newer build wrote something unreadable.
  }
  return { ...rest, is_owner: row.owner_id === userId ? 1 : 0, display };
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
    mine: mine.map((row) => toView(row, userId)),
    shared: shared.slice(0, VIEW_LIMITS.listed).map((row) => toView(row, userId)),
    everyone: everyone.slice(0, VIEW_LIMITS.listed).map((row) => toView(row, userId)),
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
export function viewCards(userId: string, viewId: string, input: { cursor?: string; limit?: number; tz: string; now?: Date }): QueryResult & { view: TaskView } {
  const view = toView(requireReadableView(viewId, userId), userId);
  const parsed = parse(view.query);
  if (!parsed.ok) throw filterError(parsed.error);
  const group: QueryGroup = (QUERY_GROUPS as readonly string[]).includes(view.display.group) ? view.display.group as QueryGroup : "none";
  const sort: QuerySort = (QUERY_SORTS as readonly string[]).includes(view.display.sort) ? view.display.sort : "due";
  return { view, ...runQuery(userId, parsed.query, { ...input, sort, group }) };
}
