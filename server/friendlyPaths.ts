/**
 * Friendly URLs: the path builders for every link the server writes (docs/plan/FRIENDLY_URLS.md, D780):
 * mail, Inbox targets, MCP tool results. A card's short link (/tasks/MYT-12), a board's code
 * (/tasks/MYT), and `<title-slug>-<shortid>` for notes, files, whiteboards, collections, and reports.
 * Each falls back to the UUID path the app has always accepted when the row has no code or short id
 * (a mail preview's sample ids, an older row). Only the database and shared helpers are imported, so
 * any module (mail, Inbox, MCP tools) can use these without an import cycle.
 */
import { db } from "./db";
import { cardKey } from "../shared/boardKeys";
import { isShortId, itemPath, type LinkKind } from "../shared/friendlyUrls";
import { whiteboardDisplayName } from "../shared/whiteboardScene";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function uuid(value: string) {
  const lower = value.toLowerCase();
  if (!UUID.test(lower)) throw new Error("Invalid id for a link");
  return lower;
}

/** /tasks/MYT, or /tasks/<uuid> for a board without a code. */
export function boardPath(boardId: string): string {
  const id = uuid(boardId);
  const row = db.query("SELECT code FROM boards WHERE id = ?").get(id) as { code: string | null } | null;
  return `/tasks/${row?.code ?? id}`;
}

/** /tasks/MYT-12 (the card's current key, wherever it moved), or the long form for a card without one. */
export function cardPath(boardId: string, cardId: string): string {
  const card = uuid(cardId);
  const row = db.query("SELECT b.code, k.number FROM cards k JOIN boards b ON b.id = k.board_id WHERE k.id = ?").get(card) as { code: string | null; number: number | null } | null;
  const key = row ? cardKey(row.code, row.number) : null;
  return key ? `/tasks/${key}` : `/tasks/${uuid(boardId)}/card/${card}`;
}

/** /tasks/MYT/sprints. */
export const sprintsPath = (boardId: string) => `${boardPath(boardId)}/sprints`;

type Named = { short_id: string | null; title: string | null };

function named(kind: Exclude<LinkKind, "board">, sql: string, id: string, fallback: string): string {
  const row = db.query(sql).get(id) as Named | null;
  return row && isShortId(row.short_id) ? itemPath(kind, row.title, row.short_id) : fallback;
}

/**
 * /notes/<title-slug>-<shortid>. Never the folder segment: the server cannot know which folders the
 * reader sees, and a folder name is not the note's to share (D776); the app adds it when it may.
 */
export function notePath(noteId: string): string {
  const id = uuid(noteId);
  // The slug is the published title when there is one (D1343, T680): `notes.title` follows the
  // owner's draft, which no reader may see, and this path reaches readers (search, link chips, mail).
  return named("note", `SELECT n.short_id, COALESCE((SELECT v.title FROM note_versions v WHERE v.note_id = n.id AND v.version_number = n.current_version), n.title) AS title
    FROM notes n WHERE n.id = ?`, id, `/notes/${id}`);
}

/** /files/<name-slug>-<shortid>, or /whiteboards/… for a whiteboard. */
export function documentPath(documentId: string): string {
  const id = uuid(documentId);
  const row = db.query("SELECT d.short_id, d.name AS title, EXISTS (SELECT 1 FROM whiteboards w WHERE w.document_id = d.id) AS board FROM documents d WHERE d.id = ?").get(id) as (Named & { board: number }) | null;
  if (!row || !isShortId(row.short_id)) return row?.board ? `/whiteboards/${id}` : `/files/${id}`;
  return row.board ? itemPath("whiteboard", whiteboardDisplayName(row.title ?? ""), row.short_id) : itemPath("file", row.title, row.short_id);
}

/** /whiteboards/<title-slug>-<shortid>. */
export function whiteboardPath(documentId: string): string {
  const id = uuid(documentId);
  const row = db.query("SELECT short_id, name AS title FROM documents WHERE id = ?").get(id) as Named | null;
  // A board's stored name ends in .excalidraw; its URL uses the name people see (D777).
  return row && isShortId(row.short_id) ? itemPath("whiteboard", whiteboardDisplayName(row.title ?? ""), row.short_id) : `/whiteboards/${id}`;
}

/** /collections/<name-slug>-<shortid>. */
export function collectionPath(collectionId: string): string {
  const id = uuid(collectionId);
  return named("collection", "SELECT short_id, name AS title FROM collections WHERE id = ?", id, `/collections/${id}`);
}

/** /collections/<name-slug>-<shortid>/row/<rowId> (rows keep their id, D779). */
export const collectionRowPath = (collectionId: string, rowId: string) => `${collectionPath(collectionId)}/row/${uuid(rowId)}`;

/** /reports/<title-slug>-<shortid>. */
export function reportPath(reportId: string): string {
  const id = uuid(reportId);
  return named("report", "SELECT short_id, title FROM reports WHERE id = ?", id, `/reports/${id}`);
}
