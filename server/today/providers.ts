import { readableNotePredicate } from "../access";
import { listUpcoming } from "../calendar/service";
import { listRecentRows } from "../collections/service";
import { BIN_LIST_LIMIT, listBinPurgingSoon } from "../bin";
import { db } from "../db";
import { recentListableDocuments } from "../documentAccess";
import { storageUsage } from "../documents";
import { hasScope, type McpScope } from "../mcpScopes";
import { checksum } from "../storage";
import { readableBoardPredicate } from "../tasks/access";
import { dueAt as dueAtOf } from "../tasks/dueTime";
import { addDays, page, registerTodayProvider, TODAY_FETCH } from "./registry";
import { recentWhiteboards } from "../whiteboards/service";
import { whiteboardDisplayName } from "../../shared/whiteboardScene";

/**
 * The built-in Today sections (docs/plan/WAVES_10-12.md §2.2). Each one reads
 * through the owning module's predicate or list function:
 *
 * - tasks: `readableBoardPredicate` (the Tasks board list), live cards, columns not marked done;
 *   My tasks leaves out cards due within seven days, which Due soon already lists
 * - notes: `readableNotePredicate` (the Notes list and search)
 * - files: `recentListableDocuments` (the Files list predicate, `purpose = 'file'`)
 * - Bin: `listBin`; storage: `storageUsage` (the upload quota's own sum)
 * - collectionsRecent: `listRecentRows` (readable collections, live rows, titles only)
 * - upcoming: `listUpcoming` (Calendar's occurrence service, readable calendars only)
 * - whiteboardsRecent: `recentWhiteboards` (the Files read predicate joined to whiteboards, names only)
 */

export const TASKS_DUE_DAYS = 7;
export const BIN_SOON_MS = 3 * 86_400_000;
/** Recent whiteboards on Today (whiteboard plan §10.7). */
export const WHITEBOARDS_RECENT = 5;

type TaskRow = {
  cardId: string; boardId: string; boardName: string; title: string;
  dueOn: string | null; dueTime: string | null; dueTz: string | null; assigned: 0 | 1;
  /** The parent's title on the same board (task hierarchy D138), or null. */
  parentTitle: string | null;
};

/** Whether `$userId` is one of the card's assignees (card_assignees, migration 015). */
const assignedToCaller = "EXISTS (SELECT 1 FROM card_assignees ca WHERE ca.card_id = k.id AND ca.user_id = $userId)";

const taskSelect = `
  SELECT k.id AS cardId, b.id AS boardId, b.name AS boardName, k.title, k.due_on AS dueOn, k.due_time AS dueTime, k.due_tz AS dueTz,
         ${assignedToCaller} AS assigned,
         (SELECT p.title FROM cards p WHERE p.id = k.parent_card_id AND p.board_id = k.board_id AND p.deleted_at IS NULL) AS parentTitle
  FROM cards k JOIN boards b ON b.id = k.board_id JOIN board_columns col ON col.id = k.column_id
  WHERE k.deleted_at IS NULL AND col.is_done = 0 AND ${readableBoardPredicate}`;

/**
 * A card as a Today item. A timed card (WAVE_13 §5.1) is overdue once its exact
 * instant has passed; a date-only card once its date is before the caller's today.
 */
const taskItem = (row: TaskRow, today: string, now: Date) => {
  const dueAt = dueAtOf({ due_on: row.dueOn, due_time: row.dueTime, due_tz: row.dueTz });
  return {
    cardId: row.cardId, boardId: row.boardId, boardName: row.boardName, title: row.title, parentTitle: row.parentTitle,
    dueOn: row.dueOn, dueTime: row.dueTime, dueTz: row.dueTz, dueAt,
    overdue: dueAt !== null ? now.getTime() > Date.parse(dueAt) : row.dueOn !== null && row.dueOn < today
  };
};

/** Within a day, cards with a time come first, by wall time, then date-only ones; approximate across zones, which is accepted (§5.1). */
const dueOrder = "k.due_on, k.due_time IS NULL, k.due_time";

/**
 * Due soon ranks the viewer's own cards (assigned to or created by them) first, then by due date
 * (QA 0.9.2): others' overdue cards on a shared board never push the viewer's card due today out
 * of the ten.
 */
registerTodayProvider("tasksDue", {
  mcpScope: "tasks:read",
  href: "/tasks",
  load: ({ userId, today, now }) => page((db.query(`${taskSelect} AND k.due_on IS NOT NULL AND k.due_on <= $horizon
      ORDER BY (${assignedToCaller} OR k.created_by = $userId) DESC, ${dueOrder}, k.updated_at DESC, k.id LIMIT $limit`)
    .all({ userId, horizon: addDays(today, TASKS_DUE_DAYS), limit: TODAY_FETCH }) as TaskRow[]).map((row) => taskItem(row, today, now)))
});

registerTodayProvider("tasksMine", {
  mcpScope: "tasks:read",
  href: "/tasks",
  load: ({ userId, today, now }) => page((db.query(`${taskSelect} AND (${assignedToCaller} OR k.created_by = $userId)
      AND (k.due_on IS NULL OR k.due_on > $horizon)
      ORDER BY k.due_on IS NULL, ${dueOrder}, k.updated_at DESC, k.id LIMIT $limit`)
    .all({ userId, horizon: addDays(today, TASKS_DUE_DAYS), limit: TODAY_FETCH }) as TaskRow[])
    .map((row) => ({ ...taskItem(row, today, now), reason: row.assigned ? "assigned" as const : "created" as const })))
});

const EMPTY_CHECKSUM = checksum("");

/** A never-published note the drafts section lists: a saved, non-blank draft of the owner's own (not an agent's). */
const listedAsUnpublishedDraft = "(n.draft_revision IS NOT NULL AND n.draft_mcp_key_id IS NULL AND n.draft_checksum <> $empty)";

/**
 * Recently changed notes the caller can read. Recipients see a note only once
 * it is published (GET /api/notes/:id refuses them before that), with its
 * published title and time, so the owner's draft activity stays private.
 * The owner's never-published notes that Unpublished drafts lists (the same
 * rule as the drafts section below) are left out here, so they appear once.
 */
registerTodayProvider("notesRecent", {
  mcpScope: "notes:read",
  href: "/notes",
  load: ({ userId }) => page((db.query(`
      SELECT n.id, CASE WHEN n.owner_id = $userId THEN n.title ELSE v.title END AS title, u.display_name AS owner_name,
             CASE WHEN n.owner_id = $userId THEN 1 ELSE 0 END AS is_owner,
             CASE WHEN n.owner_id = $userId THEN n.updated_at ELSE v.created_at END AS updated_at
      FROM notes n JOIN users u ON u.id = n.owner_id
      LEFT JOIN note_versions v ON v.note_id = n.id AND v.version_number = n.current_version
      WHERE n.deleted_at IS NULL AND ${readableNotePredicate} AND (n.owner_id = $userId OR v.id IS NOT NULL)
        AND NOT (n.owner_id = $userId AND n.current_version = 0 AND ${listedAsUnpublishedDraft})
      ORDER BY 5 DESC, n.id LIMIT $limit`).all({ userId, empty: EMPTY_CHECKSUM, limit: TODAY_FETCH }) as Array<{ id: string; title: string; owner_name: string; is_owner: 0 | 1; updated_at: string }>))
});

/** The caller's own drafts that differ from what is published (blank never-published drafts are not drafts). */
registerTodayProvider("drafts", {
  mcpScope: "notes:read",
  href: "/notes",
  load: ({ userId }) => page((db.query(`
      SELECT n.id, n.title, n.updated_at, n.current_version = 0 AS neverPublished
      FROM notes n
      WHERE n.owner_id = $userId AND n.deleted_at IS NULL AND n.draft_revision IS NOT NULL AND n.draft_mcp_key_id IS NULL
        AND ((n.current_version = 0 AND ${listedAsUnpublishedDraft}) OR EXISTS (
          SELECT 1 FROM note_versions v WHERE v.note_id = n.id AND v.version_number = n.current_version AND v.checksum <> n.draft_checksum))
      ORDER BY n.updated_at DESC, n.id LIMIT $limit`).all({ userId, empty: EMPTY_CHECKSUM, limit: TODAY_FETCH }) as Array<{ id: string; title: string; updated_at: string; neverPublished: number }>)
    .map((row) => ({ ...row, neverPublished: row.neverPublished === 1 })))
});

/**
 * Whether migration 010 (MCP key scopes, W8) is present: without it there are no agent drafts, and the section is absent.
 * Retired once the agent inbox (migration 021) exists: MCP drafts are note_draft proposals in "Proposals awaiting you" (D158).
 */
const hasAgentDrafts = () => (db.query("PRAGMA table_info(notes)").all() as Array<{ name: string }>).some((column) => column.name === "draft_mcp_key_id")
  && !db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'proposals'").get();

registerTodayProvider("agentDrafts", {
  mcpScope: "notes:read",
  href: "/notes",
  available: hasAgentDrafts,
  load: ({ userId }) => page(db.query(`
      SELECT n.id, n.title, k.name AS keyName, n.updated_at
      FROM notes n JOIN mcp_api_keys k ON k.id = n.draft_mcp_key_id
      WHERE n.owner_id = $userId AND n.deleted_at IS NULL AND n.draft_revision IS NOT NULL
      ORDER BY n.updated_at DESC, n.id LIMIT $limit`).all({ userId, limit: TODAY_FETCH }) as Array<{ id: string; title: string; keyName: string; updated_at: string }>)
});

registerTodayProvider("files", {
  mcpScope: "files:read",
  href: "/files",
  load: ({ userId }) => page(recentListableDocuments(userId, TODAY_FETCH).map((document) => ({
    id: document.id, name: document.name, mime_type: document.mime_type, preview_kind: document.preview_kind, size_bytes: document.size_bytes,
    owner_name: document.owner_name, is_owner: document.is_owner, updated_at: document.updated_at
  })))
});

/**
 * The module read scope an MCP key needs to see a Bin item of each type in get_today (T74).
 * Types without an entry are left out for MCP callers. A signed-in session sees every type, as
 * in the Bin itself.
 */
export const BIN_TYPE_MCP_SCOPE: Partial<Record<string, McpScope>> = {
  note: "notes:read", document: "files:read", card: "tasks:read", board: "tasks:read",
  collection: "collections:read", collection_row: "collections:read", calendar: "calendar:read", event: "calendar:read"
};

export function binItemVisible(type: string, scopes: readonly McpScope[] | undefined) {
  if (!scopes) return true;
  const needed = BIN_TYPE_MCP_SCOPE[type];
  return needed !== undefined && hasScope(scopes, needed);
}

/** Recently edited rows in collections the caller can read (Collections, W11); titles only. */
registerTodayProvider("collectionsRecent", {
  mcpScope: "collections:read",
  href: "/collections",
  load: ({ userId }) => page(listRecentRows(userId, TODAY_FETCH))
});

/** Recently edited whiteboards the caller can read (Wave 23, D206): names and times only. */
registerTodayProvider("whiteboardsRecent", {
  mcpScope: "whiteboards:read",
  href: "/whiteboards",
  load: ({ userId }) => {
    const boards = recentWhiteboards(userId, WHITEBOARDS_RECENT + 1);
    return {
      items: boards.slice(0, WHITEBOARDS_RECENT).map((board) => ({ id: board.id, name: whiteboardDisplayName(board.name), is_owner: board.is_owner, owner_name: board.owner_name, updated_at: board.updated_at })),
      more: boards.length > WHITEBOARDS_RECENT
    };
  }
});

/** Items in the caller's Bin that are purged within three days, soonest first. */
registerTodayProvider("binSoon", {
  href: "/bin",
  load: ({ userId, now, scopes }) => {
    const cutoff = new Date(now.getTime() + BIN_SOON_MS).toISOString();
    // Sessions read 11 rows. For an MCP key, types it may not see are dropped before the limit,
    // so a wider (still bounded) read keeps them from crowding out the visible ones.
    return page(listBinPurgingSoon(userId, cutoff, scopes ? BIN_LIST_LIMIT : TODAY_FETCH)
      .filter((item) => binItemVisible(item.type, scopes))
      .slice(0, TODAY_FETCH));
  }
});

export const UPCOMING_DAYS = 7;

/**
 * The caller's next event occurrences over seven local days (Calendar, W12). get_today includes
 * it only for keys that also hold calendar:read (T74).
 */
registerTodayProvider("upcoming", {
  href: "/calendar",
  available: () => true,
  mcpScope: "calendar:read",
  load: ({ userId, tz, now }) => {
    const { items, more } = listUpcoming(userId, tz, UPCOMING_DAYS, now.getTime());
    return {
      items: items.map((item) => ({ eventId: item.eventId, calendarId: item.calendarId, title: item.title, start: item.start, end: item.end, allDay: item.allDay, date: item.date })),
      more
    };
  }
});

registerTodayProvider("storage", {
  href: "/files",
  load: ({ userId }) => ({ items: [storageUsage(userId)], more: false })
});
