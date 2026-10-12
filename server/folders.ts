import { audit, db, now } from "./db";
import { isSystemFolder, SYSTEM_FOLDER_MESSAGE } from "./attachments/service";

/**
 * Folder creation shared by POST /api/folders and the MCP create_folder tool (Wave 19). A new folder
 * is always private: sharing never cascades from its parent (D3), so creating one never widens who
 * can see anything.
 */
export class FolderError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string, readonly code?: "NAME_TAKEN" | "SYSTEM_FOLDER") {
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
