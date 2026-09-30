/** `role` is the platform role (Team, migration 017); older servers leave it out. */
export type User = { id: string; email?: string; displayName: string; role?: "admin" | "member" | "viewer" | "guest"; /** Wave 35: the same-origin picture, or null. */ avatarUrl?: string | null };
export type Folder = {
  id: string;
  owner_id: string;
  owner_name: string;
  parent_id: string | null;
  name: string;
  is_default: number;
  is_owner: number;
  visibility: "private" | "selected" | "all_users";
  created_at: string;
  updated_at: string;
};
export type NoteSummary = {
  id: string;
  owner_id: string;
  folder_id: string | null;
  title: string;
  visibility: "private" | "selected" | "all_users";
  current_version: number;
  draft_revision: number | null;
  created_at: string;
  updated_at: string;
  owner_name: string;
  is_owner: number;
  /** Owner only: the MCP key that wrote the current draft, until it is published or discarded. */
  draft_mcp_key_name?: string | null;
};
export type NoteDetail = NoteSummary & {
  draftMcpKeyName: string | null;
  isOwner: boolean;
  /** Wave 32 (D274): the caller's level, and whether they write the draft and publish (owner or editor). Older servers omit both. */
  level?: "view" | "edit" | "owner";
  canEdit?: boolean;
  hasDraft: boolean;
  hasDelta: boolean;
  markdown: string;
};
export type Version = {
  id: string;
  version_number: number;
  title: string;
  checksum: string;
  created_at: string;
  author_name: string;
  /** Wave 36 (D287): 1 when an integration published this version through its key. */
  author_is_integration?: 0 | 1;
};
export type Visibility = "private" | "selected" | "all_users";
export type PreviewKind = "image" | "pdf" | "text" | "audio" | "video" | "none";
export type DocumentSummary = {
  id: string;
  owner_id: string;
  owner_name: string;
  is_owner: 0 | 1;
  folder_id: string | null;
  name: string;
  mime_type: string;
  preview_kind: PreviewKind;
  size_bytes: number;
  visibility: Visibility;
  sharing_override: 0 | 1;
  /** A whiteboard (Wave 23) is a Files document with a board row; older servers omit it. */
  kind?: "file" | "whiteboard";
  created_at: string;
  updated_at: string;
};
export type BinItem = {
  type: "note" | "document" | "card" | "board" | "collection" | "collection_row" | "calendar" | "event" | "vault" | "vault_environment" | "vault_secret";
  id: string;
  title: string;
  folder_id: string | null;
  folder_name: string | null;
  size_bytes: number | null;
  deleted_at: string;
  purge_after: string;
  purging: boolean;
  /** Cards: their board; boards: themselves (Wave 9). Older servers omit these fields. */
  board_id?: string | null;
  board_name?: string | null;
  /** A document that was a card attachment. */
  attachment?: boolean;
  /** The live card (or row primary field) it is still attached to, when there is one. */
  attachment_of?: string | null;
  /** What still links the attachment: a card, a collection row, or nothing (null). Older servers omit it. */
  attachment_kind?: "card" | "row" | null;
  /** False for a card, row, or event the caller deleted on someone else's board, collection, or calendar: they may only restore it. */
  can_purge?: boolean;
  /** A card's descendants binned with it; they come back and are deleted with it (task hierarchy D129). */
  descendant_count?: number;
  /** Documents: a whiteboard (Wave 23) or any other file. */
  kind?: "file" | "whiteboard";
};
export type BinRestoreResult = {
  ok: true;
  folderId?: string | null;
  folderName?: string | null;
  visibility?: Visibility;
  alreadyRestored?: true;
  /** Cards and boards. */
  boardId?: string;
  boardName?: string;
  columnId?: string | null;
  columnName?: string | null;
  /** Cards: descendants restored with it, and whether it came back without its parent (D129, D130). */
  descendantCount?: number;
  detached?: true;
  /** Calendars and events. */
  calendarId?: string;
  calendarName?: string;
};
