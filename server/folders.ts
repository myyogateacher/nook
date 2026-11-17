import { audit, db, now } from "./db";
import { isSystemFolder, SYSTEM_FOLDER_MESSAGE } from "./attachments/service";

/**
 * Folder creation shared by POST /api/folders and the MCP create_folder tool (Wave 19). A new folder
 * is always private: sharing never cascades from its parent (D3), so creating one never widens who
 * can see anything.
 */
export class FolderError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string, readonly code?: "NAME_TAKEN" | "SYSTEM_FOLDER" | "DEFAULT_FOLDER") {
    super(message);
    this.name = "FolderError";
  }
}

export function createFolder(userId: string, name: string, parentId: string | null) {
  if (name.toLowerCase() === "default") throw new FolderError(409, "The Default folder already exists", "NAME_TAKEN");
  if (parentId && !db.query("SELECT id FROM folders WHERE id = ? AND owner_id = ?").get(parentId, userId)) {
    throw new FolderError(404, "Parent folder not found");
  }
  // T342, D392: a system folder (Attachments) holds no subfolders.
  if (isSystemFolder(parentId)) throw new FolderError(400, SYSTEM_FOLDER_MESSAGE, "SYSTEM_FOLDER");
  const id = crypto.randomUUID();
  const timestamp = now();
  db.transaction(() => {
    db.query("INSERT INTO folders (id, owner_id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, userId, parentId, name, timestamp, timestamp);
    audit(userId, null, "folder.create", { folderId: id, ...(parentId ? { parentId } : {}) });
  })();
  return { id, parent_id: parentId, name, created_at: timestamp, updated_at: timestamp };
}

type FolderRow = { id: string; parent_id: string | null; name: string; is_default: number; created_at: string; updated_at: string };

/**
 * Renames and moves a folder (D1300), shared by PATCH /api/folders/:id and the MCP rename_folder tool.
 * Same rules as creating one: only its owner changes it (a share, even an edit share, never does:
 * folder structure is the owner's, like create and move), the name is the trimmed 1-120 characters
 * the caller validated, and "Default" is taken (NAME_TAKEN). The Default folder and system folders
 * (Attachments) keep their names and places. Sibling names may repeat, as on create. A real rename is
 * audited `folder.rename { folderId }` and a real move `folder.move { folderId, parentId }` (ids only).
 */
export function updateFolder(userId: string, id: string, patch: { name?: string; parentId?: string | null }) {
  const folder = db.query("SELECT id, parent_id, name, is_default, created_at, updated_at FROM folders WHERE id = ? AND owner_id = ?").get(id, userId) as FolderRow | null;
  if (!folder) throw new FolderError(404, "Folder not found");
  if (folder.is_default) throw new FolderError(409, "The Default folder cannot be changed", "DEFAULT_FOLDER");
  // T342, D392: a system folder is never renamed or moved, and never takes a subfolder.
  if (isSystemFolder(id) || isSystemFolder(patch.parentId)) throw new FolderError(400, SYSTEM_FOLDER_MESSAGE, "SYSTEM_FOLDER");
  const moving = Object.hasOwn(patch, "parentId");
  if (moving && patch.parentId === id) throw new FolderError(400, "A folder cannot contain itself");
  if (moving && patch.parentId && !db.query("SELECT id FROM folders WHERE id = ? AND owner_id = ?").get(patch.parentId, userId)) {
    throw new FolderError(404, "Parent folder not found");
  }
  if (patch.name !== undefined && patch.name.toLowerCase() === "default") throw new FolderError(409, "The Default folder already exists", "NAME_TAKEN");
  const name = patch.name ?? folder.name;
  const parentId = moving ? patch.parentId ?? null : folder.parent_id;
  const timestamp = now();
  db.transaction(() => {
    db.query("UPDATE folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?").run(name, parentId, timestamp, id);
    if (name !== folder.name) audit(userId, null, "folder.rename", { folderId: id });
    if (parentId !== folder.parent_id) audit(userId, null, "folder.move", { folderId: id, parentId });
  })();
  return { id, parent_id: parentId, name, created_at: folder.created_at, updated_at: timestamp };
}
