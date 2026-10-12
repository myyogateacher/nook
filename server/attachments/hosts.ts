import { db } from "../db";
import { readableNotePredicate } from "../access";
import { atLeast } from "../access/levels";
import { calendarLevel, editableCalendarPredicate, readableCalendarPredicate, type CalendarRow } from "../calendar/access";
import { readableBoardPredicate } from "../tasks/access";
import { readableCollectionPredicate } from "../collections/access";
import { shareReadableSql } from "../agents/sharing";
import { canWriteContent } from "../team/userRole";
import type { McpScope } from "../mcpScopes";
import type { ItemKind } from "../keyResources";

/**
 * The attachment host registry (uploads everywhere plan D393, D394; the reactions D182 pattern).
 *
 * A host is anything a file can be attached to: a calendar event, a published note, a chat message, a
 * whiteboard, a task card, or a collection row. Each kind says, in one place:
 *
 * - `readableSql`: who may open the host right now, as SQL over `$userId`. It must require a live host
 *   (not binned, not purged) and must never be wider than the host module's own read rule. The OR of
 *   these (the `attachment_links` hosts only) is the ONE branch server/documentAccess.ts adds to
 *   `readableSinglePredicate` (T340). It is used for single reads only, never for lists (T40, T58), so
 *   attachments never widen Files lists, search, or Today.
 * - `linking`: how links are made. `declared` hosts link through POST /api/attachments (service.ts);
 *   `derived` hosts (notes D408, whiteboards Q4/U4b) compute their links on publish or save and call
 *   `syncDerivedLinks`; `module` hosts (cards, rows) keep their own tables and routes (D43, D58).
 * - `canLink` / `canUnlink`: the live write checks for declared hosts. Linking is always also limited
 *   to documents the caller OWNS (T341, D396), which service.ts enforces for every kind.
 * - `caps`: per host, and per part (comment, field) where the host has parts (D400).
 * - `readScope` and `itemKind`: the MCP scope and key-grant anchor of the host module (D402, T345).
 *
 * Adding a host kind is a reviewed change to this file only (the shape checks in 046 need no rebuild).
 */

export const HOST_KINDS = ["event", "note", "chat_message", "whiteboard", "card", "row"] as const;
export type HostKind = typeof HOST_KINDS[number];
export const isHostKind = (value: unknown): value is HostKind => typeof value === "string" && (HOST_KINDS as readonly string[]).includes(value);

export type LinkStore = "attachment_links" | "card_attachments" | "collection_row_attachments";

/** Helpers the registry needs from server/documentAccess.ts, passed in to keep the import graph acyclic. */
export type HostSqlContext = {
  /** "The document aliased `alias` is readable by $userId through its own Files sharing" (no attachment branch). */
  documentReadable: (alias: string) => string;
};

export type LinkRow = { host_kind: string; host_id: string; document_id: string; part_id: string | null; position: number; linked_by: string | null; created_at: string };

/** Why a link was refused, as service.ts answers it (404 for anything the caller may not see, T340). */
export type LinkRefusal = { status: 400 | 403 | 404 | 409; code: string; message: string };

export type HostSpec = {
  kind: HostKind;
  /** A word for messages ("event", "note"). */
  noun: string;
  store: LinkStore;
  linking: "declared" | "derived" | "module";
  readScope: McpScope;
  /** The key-grant anchor of the host (keyResources.ts); null means only a whole-module grant reaches it. */
  itemKind: ItemKind | null;
  caps: { perHost: number; perPart?: number };
  /** Whether `partId` names something inside the host (a comment, a field); hosts without parts refuse one. */
  hasParts: boolean;
  /** SQL that is true when the live host whose id is the SQL expression `hostId` is readable by `$userId`. */
  readableSql: (hostId: string, ctx: HostSqlContext) => string;
  /** The live host's owner (the person whose item it is), or null when missing or binned. */
  ownerOf: (hostId: string) => string | null;
  /** A short title for the owner's "where is this used" list (D409); null when the caller may not see it. */
  title: (hostId: string) => string | null;
  /** May `userId` add a link on this host now? Null means yes. Declared hosts only. */
  canLink?: (userId: string, hostId: string, partId: string | null) => LinkRefusal | null;
  /** May `userId` remove this link now? Declared hosts only. */
  canUnlink?: (userId: string, hostId: string, link: LinkRow, documentOwnerId: string) => boolean;
};

const notFound = (noun: string): LinkRefusal => ({ status: 404, code: "NOT_FOUND", message: `${noun[0]!.toUpperCase()}${noun.slice(1)} not found` });
const readOnly: LinkRefusal = { status: 403, code: "READ_ONLY", message: "You can open this, but not attach files to it" };

const eventHost: HostSpec = {
  kind: "event",
  noun: "event",
  store: "attachment_links",
  linking: "declared",
  readScope: "calendar:read",
  itemKind: "event",
  caps: { perHost: 20 },
  hasParts: false,
  // A live event on a live calendar the caller can read (T61): the same join every calendar read uses.
  readableSql: (hostId) => `EXISTS (SELECT 1 FROM events he JOIN calendars k ON k.id = he.calendar_id WHERE he.id = ${hostId} AND he.deleted_at IS NULL AND ${readableCalendarPredicate})`,
  ownerOf: (hostId) => (db.query("SELECT k.owner_id FROM events e JOIN calendars k ON k.id = e.calendar_id WHERE e.id = ? AND e.deleted_at IS NULL AND k.deleted_at IS NULL").get(hostId) as { owner_id: string } | null)?.owner_id ?? null,
  title: (hostId) => (db.query("SELECT title FROM events WHERE id = ?").get(hostId) as { title: string } | null)?.title ?? null,
  // Editors of the calendar link (U1); a reader who cannot write gets READ_ONLY, a stranger the 404.
  canLink: (userId, hostId) => {
    const readable = db.query(`SELECT 1 FROM events he JOIN calendars k ON k.id = he.calendar_id WHERE he.id = $hostId AND he.deleted_at IS NULL AND ${readableCalendarPredicate}`).get({ hostId, userId });
    if (!readable) return notFound("event");
    const editable = db.query(`SELECT 1 FROM events he JOIN calendars k ON k.id = he.calendar_id WHERE he.id = $hostId AND he.deleted_at IS NULL AND ${editableCalendarPredicate}`).get({ hostId, userId });
    return editable && canWriteContent(userId) ? null : readOnly;
  },
  // The linker, the file's owner, or a calendar owner or manager, while they can still edit it.
  canUnlink: (userId, hostId, link, documentOwnerId) => {
    if (eventHost.canLink!(userId, hostId, null)) return false;
    if (link.linked_by === userId || documentOwnerId === userId) return true;
    const calendar = db.query("SELECT k.id, k.owner_id, k.share_role, k.visibility, k.deleted_at FROM events e JOIN calendars k ON k.id = e.calendar_id WHERE e.id = ?").get(hostId) as Pick<CalendarRow, "id" | "owner_id" | "share_role" | "visibility" | "deleted_at"> | null;
    return calendar !== null && atLeast(calendarLevel(calendar, userId), "manage");
  },
};

const noteHost: HostSpec = {
  kind: "note",
  noun: "note",
  store: "attachment_links",
  // D408: links come from the published Markdown (server/attachments/noteLinks.ts), never from a request.
  linking: "derived",
  readScope: "notes:read",
  itemKind: "note",
  caps: { perHost: 100 },
  hasParts: false,
  // A live, published note the caller can read (owner, its own shares, or its folder's): drafts grant nothing.
  readableSql: (hostId) => `EXISTS (SELECT 1 FROM notes n WHERE n.id = ${hostId} AND n.deleted_at IS NULL AND n.current_version >= 1 AND ${readableNotePredicate})`,
  ownerOf: (hostId) => (db.query("SELECT owner_id FROM notes WHERE id = ? AND deleted_at IS NULL").get(hostId) as { owner_id: string } | null)?.owner_id ?? null,
  title: (hostId) => (db.query("SELECT title FROM notes WHERE id = ?").get(hostId) as { title: string } | null)?.title ?? null,
};

/**
 * A chat message (U5): the chat's owner, or someone the chat is shared with now (D361; never through a
 * public link, never a guest). Someone it is shared with sees only the branch on screen (review L5), so
 * for them the message must be on the path from the chat's active leaf (a bounded recursive walk).
 */
const chatMessageHost: HostSpec = {
  kind: "chat_message",
  noun: "message",
  store: "attachment_links",
  linking: "declared",
  readScope: "agents:read",
  // Chat tools are whole-module (`global`): a key over chosen agents or bases never reaches chats.
  itemKind: null,
  caps: { perHost: 5 },
  hasParts: false,
  readableSql: (hostId) => `EXISTS (SELECT 1 FROM chat_messages hm JOIN chats hc ON hc.id = hm.chat_id WHERE hm.id = ${hostId} AND ${shareReadableSql("chat", "hc")}
    AND (hc.owner_id = $userId OR EXISTS (
      WITH RECURSIVE branch(id, depth) AS (
        SELECT hc.active_leaf_id, 0
        UNION ALL SELECT bm.parent_id, branch.depth + 1 FROM chat_messages bm JOIN branch ON bm.id = branch.id WHERE bm.chat_id = hc.id AND branch.depth < 5000
      ) SELECT 1 FROM branch WHERE branch.id = hm.id)))`,
  ownerOf: (hostId) => (db.query("SELECT c.owner_id FROM chat_messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ? AND c.deleted_at IS NULL").get(hostId) as { owner_id: string } | null)?.owner_id ?? null,
  title: (hostId) => (db.query("SELECT c.title FROM chat_messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ?").get(hostId) as { title: string } | null)?.title ?? null,
  // Only the chat's owner, on their own user message (chats are written by their owner only).
  canLink: (userId, hostId) => {
    const row = db.query("SELECT m.role, m.author_id, c.owner_id FROM chat_messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ? AND c.deleted_at IS NULL").get(hostId) as { role: string; author_id: string | null; owner_id: string } | null;
    if (!row || row.owner_id !== userId) return notFound("message");
    if (row.role !== "user" || (row.author_id !== null && row.author_id !== userId)) return { status: 400, code: "INVALID", message: "Files can be attached to your own messages only" };
    return null;
  },
  canUnlink: (userId, hostId) => chatMessageHost.canLink!(userId, hostId, null) === null,
};

/**
 * A whiteboard (U4b, operator decision Q4 changing T165): pictures the board's owner owns follow the
 * board's own Files sharing. The board is a Files document, so "can read the board" is its document
 * predicate. Links are derived on save from the scene's `nookDocumentId`s the owner owns.
 */
const whiteboardHost: HostSpec = {
  kind: "whiteboard",
  noun: "whiteboard",
  store: "attachment_links",
  linking: "derived",
  readScope: "whiteboards:read",
  itemKind: "whiteboard",
  caps: { perHost: 100 },
  hasParts: false,
  readableSql: (hostId, ctx) => `EXISTS (SELECT 1 FROM whiteboards hw JOIN documents wd ON wd.id = hw.document_id WHERE hw.document_id = ${hostId} AND ${ctx.documentReadable("wd")})`,
  ownerOf: (hostId) => (db.query("SELECT d.owner_id FROM whiteboards w JOIN documents d ON d.id = w.document_id WHERE w.document_id = ? AND d.deleted_at IS NULL").get(hostId) as { owner_id: string } | null)?.owner_id ?? null,
  title: (hostId) => (db.query("SELECT d.name FROM whiteboards w JOIN documents d ON d.id = w.document_id WHERE w.document_id = ?").get(hostId) as { name: string } | null)?.name ?? null,
};

/** Task cards (D43): links stay in `card_attachments`; the Tasks routes add and remove them (U2). */
const cardHost: HostSpec = {
  kind: "card",
  noun: "card",
  store: "card_attachments",
  linking: "module",
  readScope: "tasks:read",
  itemKind: "card",
  caps: { perHost: 50, perPart: 10 },
  hasParts: true,
  readableSql: (hostId) => `EXISTS (SELECT 1 FROM cards hcd JOIN boards b ON b.id = hcd.board_id WHERE hcd.id = ${hostId} AND hcd.deleted_at IS NULL AND ${readableBoardPredicate})`,
  ownerOf: (hostId) => (db.query("SELECT b.owner_id FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = ? AND c.deleted_at IS NULL AND b.deleted_at IS NULL").get(hostId) as { owner_id: string } | null)?.owner_id ?? null,
  title: (hostId) => (db.query("SELECT title FROM cards WHERE id = ?").get(hostId) as { title: string } | null)?.title ?? null,
};

/** Collection rows (D58): links stay in `collection_row_attachments`; the Collections routes add and remove them (U3). */
const rowHost: HostSpec = {
  kind: "row",
  noun: "row",
  store: "collection_row_attachments",
  linking: "module",
  readScope: "collections:read",
  itemKind: "row",
  caps: { perHost: 20 },
  hasParts: true,
  readableSql: (hostId) => `EXISTS (SELECT 1 FROM collection_rows hr JOIN collections c ON c.id = hr.collection_id WHERE hr.id = ${hostId} AND hr.deleted_at IS NULL AND ${readableCollectionPredicate})`,
  ownerOf: (hostId) => (db.query("SELECT c.owner_id FROM collection_rows r JOIN collections c ON c.id = r.collection_id WHERE r.id = ? AND r.deleted_at IS NULL AND c.deleted_at IS NULL").get(hostId) as { owner_id: string } | null)?.owner_id ?? null,
  title: (hostId) => (db.query("SELECT c.name FROM collection_rows r JOIN collections c ON c.id = r.collection_id WHERE r.id = ?").get(hostId) as { name: string } | null)?.name ?? null,
};

export const HOSTS: Readonly<Record<HostKind, HostSpec>> = {
  event: eventHost,
  note: noteHost,
  chat_message: chatMessageHost,
  whiteboard: whiteboardHost,
  card: cardHost,
  row: rowHost
};

/** The hosts whose links live in `attachment_links`. */
export const LINK_TABLE_HOSTS: readonly HostSpec[] = HOST_KINDS.map((kind) => HOSTS[kind]).filter((spec) => spec.store === "attachment_links");

/**
 * The generated branch of `readableSinglePredicate` (D394, T340): a live document with a live link from
 * a live host of a registered kind that `$userId` can read. Links of unknown kinds grant nothing.
 */
export function attachmentLinkReadBranch(ctx: HostSqlContext) {
  const hosts = LINK_TABLE_HOSTS.map((spec) => `(al.host_kind = '${spec.kind}' AND ${spec.readableSql("al.host_id", ctx)})`).join("\n      OR ");
  return `(d.deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM attachment_links al WHERE al.document_id = d.id AND (
      ${hosts}
    )
  ))`;
}
